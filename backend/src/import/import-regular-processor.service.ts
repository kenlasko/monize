import { Injectable, Logger } from "@nestjs/common";
import { Account, AccountType } from "../accounts/entities/account.entity";
import {
  Transaction,
  TransactionStatus,
} from "../transactions/entities/transaction.entity";
import { TransactionSplit } from "../transactions/entities/transaction-split.entity";
import { Payee } from "../payees/entities/payee.entity";
import { ImportContext, updateAccountBalance } from "./import-context";

@Injectable()
export class ImportRegularProcessorService {
  private readonly logger = new Logger(ImportRegularProcessorService.name);

  async processTransaction(ctx: ImportContext, qifTx: any): Promise<void> {
    // Check for duplicate transfers from prior imports
    if (await this.isDuplicateTransfer(ctx, qifTx)) {
      ctx.importResult.skipped++;
      return;
    }

    // Check for pending cross-currency transfers to update
    if (await this.matchPendingTransfer(ctx, qifTx)) {
      ctx.importResult.imported++;
      return;
    }

    // Get or create payee
    const payeeId = await this.resolvePayee(ctx, qifTx);

    // Check if this is a split transaction
    const isSplit = qifTx.splits && qifTx.splits.length > 0;

    // Determine category and transfer account
    const { categoryId, isLoanPaymentTx, transferAccountId } =
      this.resolveTransactionTarget(ctx, qifTx, isSplit);

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

    // Create transaction
    const isTransfer = !isSplit && (qifTx.isTransfer || isLoanPaymentTx);
    const transaction = ctx.queryRunner.manager.create(Transaction, {
      userId: ctx.userId,
      accountId: ctx.accountId,
      transactionDate: qifTx.date,
      amount: qifTx.amount,
      payeeName: qifTx.payee,
      payeeId,
      description: qifTx.memo,
      referenceNumber: qifTx.number,
      categoryId: isSplit ? null : categoryId,
      status,
      currencyCode: ctx.account.currencyCode,
      isSplit,
      isTransfer,
      createdAt: baseTime,
    });

    const savedTx = await ctx.queryRunner.manager.save(transaction);

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
    // Check for duplicate linked transfers from prior imports
    if (qifTx.isTransfer && qifTx.transferAccount) {
      const mappedTransferAccountId = ctx.accountMap.get(qifTx.transferAccount);
      if (mappedTransferAccountId) {
        const existingLinkedTransfers = await ctx.queryRunner.manager
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
          .andWhere("t.created_at < :importStartTime", {
            importStartTime: ctx.importStartTime,
          })
          .getOne();

        if (existingLinkedTransfers) {
          return true;
        }
      }
    }

    // Check for split-linked transfers from prior imports
    if (qifTx.isTransfer) {
      const existingSplitLinkedTx = await ctx.queryRunner.manager
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
        .andWhere("t.created_at < :importStartTime", {
          importStartTime: ctx.importStartTime,
        })
        .getOne();

      if (existingSplitLinkedTx) {
        return true;
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
  ): Promise<string | null> {
    if (!qifTx.payee) return null;

    const existingPayee = await ctx.queryRunner.manager.findOne(Payee, {
      where: { userId: ctx.userId, name: qifTx.payee },
    });
    if (existingPayee) {
      return existingPayee.id;
    }

    const newPayee = ctx.queryRunner.manager.create(Payee, {
      userId: ctx.userId,
      name: qifTx.payee,
    });
    const savedPayee = await ctx.queryRunner.manager.save(newPayee);
    ctx.importResult.payeesCreated++;
    return savedPayee.id;
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

    // Check for existing linked transaction from prior import
    const existingLinkedTx = await ctx.queryRunner.manager
      .createQueryBuilder(Transaction, "t")
      .where("t.user_id = :userId", { userId: ctx.userId })
      .andWhere("t.account_id = :accountId", {
        accountId: splitTransferAccountId,
      })
      .andWhere("t.transaction_date = :date", { date: qifTx.date })
      .andWhere("t.amount = :amount", { amount: linkedAmount })
      .andWhere("t.is_transfer = true")
      .andWhere("t.created_at < :importStartTime", {
        importStartTime: ctx.importStartTime,
      })
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
      if (placeholderTx) {
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
