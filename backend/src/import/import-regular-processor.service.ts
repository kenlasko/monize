import { Injectable, Logger } from "@nestjs/common";
import { Account, AccountType } from "../accounts/entities/account.entity";
import {
  Transaction,
  TransactionStatus,
} from "../transactions/entities/transaction.entity";
import { TransactionSplit } from "../transactions/entities/transaction-split.entity";
import { Payee } from "../payees/entities/payee.entity";
import { PayeeAlias } from "../payees/entities/payee-alias.entity";
import { TransactionTag } from "../tags/entities/transaction-tag.entity";
import { TransactionSplitTag } from "../tags/entities/transaction-split-tag.entity";
import { ImportContext, updateAccountBalance } from "./import-context";

@Injectable()
export class ImportRegularProcessorService {
  private readonly logger = new Logger(ImportRegularProcessorService.name);

  async processTransaction(ctx: ImportContext, qifTx: any): Promise<void> {
    // Check for duplicate transfers (from prior imports or earlier account blocks)
    if (await this.isDuplicateTransfer(ctx, qifTx)) {
      ctx.importResult.skipped++;
      return;
    }

    // Check for pending cross-currency transfers to update
    if (await this.matchPendingTransfer(ctx, qifTx)) {
      ctx.importResult.imported++;
      return;
    }

    // Get or create payee (with alias matching)
    const resolvedPayee = await this.resolvePayee(ctx, qifTx);

    // Check if this is a split transaction
    const isSplit = qifTx.splits && qifTx.splits.length > 0;

    // Determine category and transfer account
    const { categoryId, isLoanPaymentTx, transferAccountId } =
      this.resolveTransactionTarget(ctx, qifTx, isSplit);

    // If payee has a default category and no category was resolved from the import, use the payee's default
    const effectiveCategoryId = isSplit
      ? null
      : categoryId || resolvedPayee.defaultCategoryId || null;

    // Generate unique createdAt timestamp
    const counter = ctx.dateCounters.get(qifTx.date) || 0;
    ctx.dateCounters.set(qifTx.date, counter + 1);
    const baseTime = new Date();
    baseTime.setMilliseconds(baseTime.getMilliseconds() + counter);

    // Determine status
    const status = qifTx.reconciled
      ? TransactionStatus.RECONCILED
      : qifTx.cleared
        ? TransactionStatus.CLEARED
        : TransactionStatus.UNRECONCILED;

    // Create transaction (use canonical payee name if alias-matched)
    const isTransfer = !isSplit && (qifTx.isTransfer || isLoanPaymentTx);
    const transaction = ctx.queryRunner.manager.create(Transaction, {
      userId: ctx.userId,
      accountId: ctx.accountId,
      transactionDate: qifTx.date,
      amount: qifTx.amount,
      payeeName: resolvedPayee.payeeName,
      payeeId: resolvedPayee.payeeId,
      description: qifTx.memo,
      referenceNumber: qifTx.number,
      categoryId: effectiveCategoryId,
      status,
      currencyCode: ctx.account.currencyCode,
      isSplit,
      isTransfer,
      createdAt: baseTime,
    });

    const savedTx = await ctx.queryRunner.manager.save(transaction);

    // Assign tags to the transaction
    await this.assignTransactionTags(ctx, savedTx.id, qifTx.tagNames);

    // Handle splits
    if (isSplit) {
      await this.processSplits(ctx, qifTx, savedTx, status, baseTime);
    }

    // Update account balance
    await updateAccountBalance(ctx.queryRunner, ctx.accountId, qifTx.amount);

    // Handle non-split transfers
    if (isTransfer && transferAccountId) {
      await this.processTransfer(
        ctx,
        qifTx,
        savedTx,
        transferAccountId,
        isLoanPaymentTx,
        status,
        baseTime,
      );
    }

    ctx.importResult.imported++;
  }

  private async isDuplicateTransfer(
    ctx: ImportContext,
    qifTx: any,
  ): Promise<boolean> {
    // Check for duplicate linked transfers using counting to avoid false positives.
    // Multiple genuinely different transfers can share the same date, amount, and
    // account pair (e.g. two $150 transfers to the same account on the same day
    // with different payees). We count how many matching linked transfers already
    // exist in the DB and how many same-signature QIF entries we have seen in this
    // block; only skip when the seen count does not exceed the existing count.
    if (qifTx.isTransfer && qifTx.transferAccount) {
      const mappedTransferAccountId = ctx.accountMap.get(qifTx.transferAccount);
      if (mappedTransferAccountId) {
        const existingCount = await ctx.queryRunner.manager
          .createQueryBuilder(Transaction, "t")
          .innerJoin(
            Transaction,
            "linked",
            "t.linked_transaction_id = linked.id",
          )
          .where("t.user_id = :userId", { userId: ctx.userId })
          .andWhere("t.account_id = :accountId", {
            accountId: ctx.accountId,
          })
          .andWhere("t.is_transfer = true")
          .andWhere("t.transaction_date = :date", { date: qifTx.date })
          .andWhere("t.amount = :amount", { amount: qifTx.amount })
          .andWhere("linked.account_id = :linkedAccountId", {
            linkedAccountId: mappedTransferAccountId,
          })
          .getCount();

        if (existingCount > 0) {
          const sigKey = `linked|${qifTx.date}|${qifTx.amount}|${mappedTransferAccountId}`;
          const seenSoFar = ctx.transferDupCounts.get(sigKey) || 0;
          ctx.transferDupCounts.set(sigKey, seenSoFar + 1);
          if (seenSoFar + 1 <= existingCount) {
            return true;
          }
        }
      }
    }

    // Check for split-linked transfers (same counting approach)
    if (qifTx.isTransfer) {
      const existingCount = await ctx.queryRunner.manager
        .createQueryBuilder(Transaction, "t")
        .innerJoin(
          TransactionSplit,
          "split",
          "split.linked_transaction_id = t.id",
        )
        .where("t.user_id = :userId", { userId: ctx.userId })
        .andWhere("t.account_id = :accountId", {
          accountId: ctx.accountId,
        })
        .andWhere("t.is_transfer = true")
        .andWhere("t.transaction_date = :date", { date: qifTx.date })
        .andWhere("t.amount = :amount", { amount: qifTx.amount })
        .getCount();

      if (existingCount > 0) {
        const sigKey = `split|${qifTx.date}|${qifTx.amount}`;
        const seenSoFar = ctx.transferDupCounts.get(sigKey) || 0;
        ctx.transferDupCounts.set(sigKey, seenSoFar + 1);
        if (seenSoFar + 1 <= existingCount) {
          return true;
        }
      }
    }

    return false;
  }

  private async matchPendingTransfer(
    ctx: ImportContext,
    qifTx: any,
  ): Promise<boolean> {
    if (!qifTx.isTransfer || !qifTx.transferAccount) return false;

    const mappedTransferAccountId = ctx.accountMap.get(qifTx.transferAccount);
    if (!mappedTransferAccountId) return false;

    const expectedSign = qifTx.amount >= 0 ? 1 : -1;
    const pendingTransfer = await ctx.queryRunner.manager
      .createQueryBuilder(Transaction, "t")
      .leftJoinAndSelect("t.linkedTransaction", "linked")
      .where("t.user_id = :userId", { userId: ctx.userId })
      .andWhere("t.account_id = :accountId", {
        accountId: ctx.accountId,
      })
      .andWhere("t.transaction_date = :date", { date: qifTx.date })
      .andWhere("t.is_transfer = true")
      .andWhere("t.description LIKE :note", {
        note: "%PENDING IMPORT%",
      })
      .andWhere(expectedSign > 0 ? "t.amount > 0" : "t.amount < 0")
      .andWhere("linked.account_id = :linkedAccountId", {
        linkedAccountId: mappedTransferAccountId,
      })
      .getOne();

    if (!pendingTransfer) return false;

    const oldAmount = Number(pendingTransfer.amount);
    const newAmount = qifTx.amount;
    const balanceDiff = newAmount - oldAmount;

    await ctx.queryRunner.manager.update(Transaction, pendingTransfer.id, {
      amount: newAmount,
      description: qifTx.memo || null,
      payeeName: qifTx.payee || pendingTransfer.payeeName,
      referenceNumber: qifTx.number || pendingTransfer.referenceNumber,
    });

    if (balanceDiff !== 0) {
      await updateAccountBalance(ctx.queryRunner, ctx.accountId, balanceDiff);
    }

    return true;
  }

  private async resolvePayee(
    ctx: ImportContext,
    qifTx: any,
  ): Promise<{
    payeeId: string | null;
    payeeName: string | null;
    defaultCategoryId: string | null;
  }> {
    if (!qifTx.payee)
      return { payeeId: null, payeeName: null, defaultCategoryId: null };

    // 1. Check for exact name match
    const existingPayee = await ctx.queryRunner.manager.findOne(Payee, {
      where: { userId: ctx.userId, name: qifTx.payee },
    });
    if (existingPayee) {
      return {
        payeeId: existingPayee.id,
        payeeName: existingPayee.name,
        defaultCategoryId: existingPayee.defaultCategoryId,
      };
    }

    // 2. Check for alias match (case-insensitive, supports wildcards)
    const aliases = await ctx.queryRunner.manager.find(PayeeAlias, {
      where: { userId: ctx.userId },
      relations: ["payee"],
    });

    for (const alias of aliases) {
      if (this.matchesAliasPattern(qifTx.payee, alias.alias) && alias.payee) {
        this.logger.debug(
          `Alias match: "${qifTx.payee}" matched alias "${alias.alias}" -> payee "${alias.payee.name}"`,
        );
        return {
          payeeId: alias.payee.id,
          payeeName: alias.payee.name,
          defaultCategoryId: alias.payee.defaultCategoryId,
        };
      }
    }

    // 3. No match found - create new payee
    const newPayee = ctx.queryRunner.manager.create(Payee, {
      userId: ctx.userId,
      name: qifTx.payee,
    });
    const savedPayee = await ctx.queryRunner.manager.save(newPayee);
    ctx.importResult.payeesCreated++;
    return {
      payeeId: savedPayee.id,
      payeeName: savedPayee.name,
      defaultCategoryId: null,
    };
  }

  /**
   * Check if a name matches a wildcard alias pattern (case-insensitive).
   * Uses iterative glob matching instead of regex to avoid ReDoS risks.
   */
  private matchesAliasPattern(name: string, aliasPattern: string): boolean {
    if (aliasPattern.length > 500 || name.length > 500) return false;
    const pattern = aliasPattern.replace(/\*{2,}/g, "*").toLowerCase();
    const text = name.toLowerCase();
    const parts = pattern.split("*");
    if (parts.length === 1) return text === pattern;
    if (!text.startsWith(parts[0])) return false;
    if (!text.endsWith(parts[parts.length - 1])) return false;
    let pos = parts[0].length;
    for (let i = 1; i < parts.length - 1; i++) {
      const idx = text.indexOf(parts[i], pos);
      if (idx === -1) return false;
      pos = idx + parts[i].length;
    }
    if (parts.length > 2) {
      const suffixStart = text.length - parts[parts.length - 1].length;
      if (pos > suffixStart) return false;
    }
    return true;
  }

  private resolveTransactionTarget(
    ctx: ImportContext,
    qifTx: any,
    isSplit: boolean,
  ): {
    categoryId: string | null;
    isLoanPaymentTx: boolean;
    transferAccountId: string | null;
  } {
    let categoryId: string | null = null;
    let isLoanPaymentTx = false;

    if (qifTx.isTransfer) {
      categoryId = null;
    } else if (
      ctx.account.accountType === AccountType.ASSET &&
      (ctx.account as any).assetCategoryId
    ) {
      categoryId = (ctx.account as any).assetCategoryId;
    } else if (qifTx.category) {
      if (!isSplit && ctx.loanCategoryMap.has(qifTx.category)) {
        categoryId = null;
        isLoanPaymentTx = true;
      } else {
        categoryId = ctx.categoryMap.get(qifTx.category) || null;
      }
    }

    let transferAccountId: string | null = null;
    if (!isSplit) {
      if (qifTx.isTransfer && qifTx.transferAccount) {
        transferAccountId = ctx.accountMap.get(qifTx.transferAccount) || null;
        // Case-insensitive fallback
        if (!transferAccountId) {
          const lowerName = qifTx.transferAccount.toLowerCase();
          for (const [name, id] of ctx.accountMap) {
            if (name.toLowerCase() === lowerName) {
              transferAccountId = id;
              break;
            }
          }
        }
      } else if (isLoanPaymentTx && qifTx.category) {
        transferAccountId = ctx.loanCategoryMap.get(qifTx.category) || null;
      }
    }

    return { categoryId, isLoanPaymentTx, transferAccountId };
  }

  private async processSplits(
    ctx: ImportContext,
    qifTx: any,
    savedTx: Transaction,
    status: TransactionStatus,
    baseTime: Date,
  ): Promise<void> {
    for (const split of qifTx.splits) {
      let splitCategoryId: string | null = null;
      let splitTransferAccountId: string | null = null;
      let isLoanPayment = false;

      if (split.isTransfer && split.transferAccount) {
        splitTransferAccountId =
          ctx.accountMap.get(split.transferAccount) || null;
        // If transfer account not found, try case-insensitive match
        if (!splitTransferAccountId) {
          const lowerName = split.transferAccount.toLowerCase();
          for (const [name, id] of ctx.accountMap) {
            if (name.toLowerCase() === lowerName) {
              splitTransferAccountId = id;
              break;
            }
          }
        }
      } else if (split.category) {
        if (ctx.loanCategoryMap.has(split.category)) {
          splitTransferAccountId =
            ctx.loanCategoryMap.get(split.category) || null;
          isLoanPayment = true;
        } else {
          splitCategoryId = ctx.categoryMap.get(split.category) || null;
        }
      }

      const transactionSplit = ctx.queryRunner.manager.create(
        TransactionSplit,
        {
          transactionId: savedTx.id,
          categoryId: splitCategoryId,
          transferAccountId: splitTransferAccountId,
          amount: split.amount,
          memo: split.memo,
        },
      );

      const savedSplit = await ctx.queryRunner.manager.save(transactionSplit);

      // Assign tags to the split
      await this.assignSplitTags(ctx, savedSplit.id, split.tagNames);

      if (splitTransferAccountId) {
        await this.processSplitTransfer(
          ctx,
          qifTx,
          savedTx,
          savedSplit,
          splitTransferAccountId,
          split,
          isLoanPayment,
          status,
          baseTime,
        );
      }
    }
  }

  private async processSplitTransfer(
    ctx: ImportContext,
    qifTx: any,
    savedTx: Transaction,
    savedSplit: TransactionSplit,
    splitTransferAccountId: string,
    split: any,
    isLoanPayment: boolean,
    status: TransactionStatus,
    baseTime: Date,
  ): Promise<void> {
    ctx.affectedAccountIds.add(splitTransferAccountId);
    const linkedAmount = -split.amount;

    // Check for existing linked transaction
    // Exclude transactions already linked to the current transaction (savedTx)
    // to prevent a second split transfer from matching the linked transaction
    // created by a prior split transfer in the same parent transaction.
    const existingLinkedTx = await ctx.queryRunner.manager
      .createQueryBuilder(Transaction, "t")
      .where("t.user_id = :userId", { userId: ctx.userId })
      .andWhere("t.account_id = :accountId", {
        accountId: splitTransferAccountId,
      })
      .andWhere("t.transaction_date = :date", { date: qifTx.date })
      .andWhere("t.amount = :amount", { amount: linkedAmount })
      .andWhere("t.is_transfer = true")
      .andWhere(
        "(t.linked_transaction_id IS NULL OR t.linked_transaction_id != :currentTxId)",
        { currentTxId: savedTx.id },
      )
      .getOne();

    if (existingLinkedTx) {
      await this.linkExistingSplitTransfer(
        ctx,
        savedTx,
        savedSplit,
        existingLinkedTx,
      );
      return;
    }

    // Check for pending cross-currency transfer
    const expectedSign = linkedAmount >= 0 ? 1 : -1;
    const pendingTransfer = await ctx.queryRunner.manager
      .createQueryBuilder(Transaction, "t")
      .where("t.user_id = :userId", { userId: ctx.userId })
      .andWhere("t.account_id = :accountId", {
        accountId: splitTransferAccountId,
      })
      .andWhere("t.transaction_date = :date", { date: qifTx.date })
      .andWhere("t.is_transfer = true")
      .andWhere("t.linked_transaction_id IS NULL")
      .andWhere("t.description LIKE :note", {
        note: "%PENDING IMPORT%",
      })
      .andWhere(expectedSign > 0 ? "t.amount > 0" : "t.amount < 0")
      .getOne();

    if (pendingTransfer) {
      const oldAmount = Number(pendingTransfer.amount);
      const balanceDiff = linkedAmount - oldAmount;

      await ctx.queryRunner.manager.update(Transaction, pendingTransfer.id, {
        amount: linkedAmount,
        description: split.memo || qifTx.memo || null,
        linkedTransactionId: savedTx.id,
      });

      await ctx.queryRunner.manager.update(TransactionSplit, savedSplit.id, {
        linkedTransactionId: pendingTransfer.id,
      });

      if (balanceDiff !== 0) {
        await updateAccountBalance(
          ctx.queryRunner,
          splitTransferAccountId,
          balanceDiff,
        );
      }
      return;
    }

    // Create new linked transaction
    const linkedSplitTx = ctx.queryRunner.manager.create(Transaction, {
      userId: ctx.userId,
      accountId: splitTransferAccountId,
      transactionDate: qifTx.date,
      amount: linkedAmount,
      payeeName: isLoanPayment
        ? qifTx.payee || `Loan Payment from ${ctx.account.name}`
        : qifTx.payee || `Transfer from ${ctx.account.name}`,
      description: split.memo || qifTx.memo,
      status,
      currencyCode: ctx.account.currencyCode,
      isTransfer: true,
      createdAt: new Date(baseTime.getTime() + 0.1),
    });

    const savedLinkedSplitTx =
      await ctx.queryRunner.manager.save(linkedSplitTx);

    await ctx.queryRunner.manager.update(TransactionSplit, savedSplit.id, {
      linkedTransactionId: savedLinkedSplitTx.id,
    });

    await ctx.queryRunner.manager.update(Transaction, savedLinkedSplitTx.id, {
      linkedTransactionId: savedTx.id,
    });

    await updateAccountBalance(
      ctx.queryRunner,
      splitTransferAccountId,
      linkedAmount,
    );
  }

  private async linkExistingSplitTransfer(
    ctx: ImportContext,
    savedTx: Transaction,
    savedSplit: TransactionSplit,
    existingLinkedTx: Transaction,
  ): Promise<void> {
    await ctx.queryRunner.manager.update(TransactionSplit, savedSplit.id, {
      linkedTransactionId: existingLinkedTx.id,
    });

    if (!existingLinkedTx.linkedTransactionId) {
      await ctx.queryRunner.manager.update(Transaction, existingLinkedTx.id, {
        linkedTransactionId: savedTx.id,
      });
    }

    // Clean up placeholder transactions
    if (existingLinkedTx.linkedTransactionId) {
      const placeholderTx = await ctx.queryRunner.manager.findOne(Transaction, {
        where: {
          id: existingLinkedTx.linkedTransactionId,
          accountId: ctx.accountId,
        },
      });
      if (placeholderTx && placeholderTx.id !== savedTx.id) {
        await updateAccountBalance(
          ctx.queryRunner,
          ctx.accountId,
          -Number(placeholderTx.amount),
        );
        await ctx.queryRunner.manager.delete(Transaction, placeholderTx.id);
        await ctx.queryRunner.manager.update(Transaction, existingLinkedTx.id, {
          linkedTransactionId: null,
        });
      }
    }
  }

  private async assignTransactionTags(
    ctx: ImportContext,
    transactionId: string,
    tagNames: string[],
  ): Promise<void> {
    if (!tagNames || tagNames.length === 0) return;

    for (const name of tagNames) {
      const tagId = ctx.tagMap.get(name.toLowerCase());
      if (tagId) {
        const txTag = ctx.queryRunner.manager.create(TransactionTag, {
          transactionId,
          tagId,
        });
        await ctx.queryRunner.manager.save(txTag);
      }
    }
  }

  private async assignSplitTags(
    ctx: ImportContext,
    splitId: string,
    tagNames: string[],
  ): Promise<void> {
    if (!tagNames || tagNames.length === 0) return;

    for (const name of tagNames) {
      const tagId = ctx.tagMap.get(name.toLowerCase());
      if (tagId) {
        const splitTag = ctx.queryRunner.manager.create(TransactionSplitTag, {
          transactionSplitId: splitId,
          tagId,
        });
        await ctx.queryRunner.manager.save(splitTag);
      }
    }
  }

  private async processTransfer(
    ctx: ImportContext,
    qifTx: any,
    savedTx: Transaction,
    transferAccountId: string,
    isLoanPaymentTx: boolean,
    status: TransactionStatus,
    baseTime: Date,
  ): Promise<void> {
    ctx.affectedAccountIds.add(transferAccountId);
    const PENDING_IMPORT_NOTE =
      "⚠️ PENDING IMPORT: Amount may need adjustment when importing the other account.";

    const targetAccount = await ctx.queryRunner.manager.findOne(Account, {
      where: { id: transferAccountId },
    });

    const isCrossCurrency =
      targetAccount && targetAccount.currencyCode !== ctx.account.currencyCode;

    // Check for existing pending transfer (cross-currency)
    let existingPendingTransfer: Transaction | null = null;
    if (isCrossCurrency) {
      const expectedSign = qifTx.amount < 0 ? 1 : -1;
      existingPendingTransfer = await ctx.queryRunner.manager
        .createQueryBuilder(Transaction, "t")
        .where("t.user_id = :userId", { userId: ctx.userId })
        .andWhere("t.account_id = :accountId", {
          accountId: transferAccountId,
        })
        .andWhere("t.transaction_date = :date", { date: qifTx.date })
        .andWhere("t.is_transfer = true")
        .andWhere("t.linked_transaction_id IS NULL")
        .andWhere("t.description LIKE :note", {
          note: "%PENDING IMPORT%",
        })
        .andWhere(expectedSign > 0 ? "t.amount > 0" : "t.amount < 0")
        .getOne();
    }

    if (existingPendingTransfer) {
      const linkedPayeeName = isLoanPaymentTx
        ? qifTx.payee || `Loan Payment from ${ctx.account.name}`
        : qifTx.payee || `Transfer from ${ctx.account.name}`;
      await ctx.queryRunner.manager.update(
        Transaction,
        existingPendingTransfer.id,
        {
          linkedTransactionId: savedTx.id,
          payeeName: linkedPayeeName,
          description: qifTx.memo || null,
        },
      );

      await ctx.queryRunner.manager.update(Transaction, savedTx.id, {
        linkedTransactionId: existingPendingTransfer.id,
      });
      return;
    }

    // Create new linked transaction
    const linkedTime = new Date(baseTime.getTime() + 0.5);
    const linkedAmount = -qifTx.amount;
    const linkedDescription = isCrossCurrency
      ? `${qifTx.memo || ""} ${PENDING_IMPORT_NOTE}`.trim()
      : qifTx.memo;

    const linkedPayeeName = isLoanPaymentTx
      ? qifTx.payee || `Loan Payment from ${ctx.account.name}`
      : qifTx.payee || `Transfer from ${ctx.account.name}`;
    const linkedTx = ctx.queryRunner.manager.create(Transaction, {
      userId: ctx.userId,
      accountId: transferAccountId,
      transactionDate: qifTx.date,
      amount: linkedAmount,
      payeeName: linkedPayeeName,
      description: linkedDescription,
      referenceNumber: qifTx.number,
      status,
      currencyCode: targetAccount?.currencyCode || ctx.account.currencyCode,
      isTransfer: true,
      linkedTransactionId: savedTx.id,
      createdAt: linkedTime,
    });

    const savedLinkedTx = await ctx.queryRunner.manager.save(linkedTx);

    await ctx.queryRunner.manager.update(Transaction, savedTx.id, {
      linkedTransactionId: savedLinkedTx.id,
    });

    await updateAccountBalance(
      ctx.queryRunner,
      transferAccountId,
      linkedAmount,
    );
  }
}
