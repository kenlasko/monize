import {
  prepareImportAccrualSources,
  assertImportAccrualMatch,
  rememberImportedAccrualSource,
  assertImportAccrualEntry,
} from "./import-accrual-guard";
import { statusFromQifFlags } from "./qif-status.util";
import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { Account, AccountType } from "../accounts/entities/account.entity";
import {
  Transaction,
  TransactionStatus,
} from "../transactions/entities/transaction.entity";
import { TransactionSplit } from "../transactions/entities/transaction-split.entity";
import { SplitKind } from "../transactions/entities/split-kind.enum";
import { Payee } from "../payees/entities/payee.entity";
import { PayeeAlias } from "../payees/entities/payee-alias.entity";
import { TransactionTag } from "../tags/entities/transaction-tag.entity";
import { TransactionSplitTag } from "../tags/entities/transaction-split-tag.entity";
import {
  ImportContext,
  recordSkippedRow,
  updateAccountBalance,
} from "./import-context";
import { holdKey, isSameBankRow, ofxExternalId } from "./ofx-external-id";
import {
  adoptKeyOnRecordedTransfer,
  countTransferTurn,
  isDuplicateTransfer,
  isQuickenMergedSplitTransfer,
} from "./import-transfer-dedupe";
import { deletionBalanceEffect } from "../common/deletion-balance.util";
import {
  applyFxConversion,
  resolveFxRateOrNull,
} from "../common/fx-entry.util";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import { tr } from "../i18n/translate";
import { TransactionRulesApplierService } from "../transaction-rules/transaction-rules-applier.service";

/**
 * The flag on a cross-currency transfer leg whose amount is not the bank's own:
 * importing the other account's file corrects it. The pending lookups below
 * search for this text.
 */
const PENDING_IMPORT_NOTE =
  "⚠️ PENDING IMPORT: Amount may need adjustment when importing the other account.";

@Injectable()
export class ImportRegularProcessorService {
  private readonly logger = new Logger(ImportRegularProcessorService.name);

  constructor(
    private readonly rulesApplier: TransactionRulesApplierService,
    private readonly exchangeRateService: ExchangeRateService,
  ) {}

  async processTransaction(ctx: ImportContext, qifTx: any): Promise<void> {
    // A row whose bank id the account already holds, on a row of the same date
    // and amount, was imported from an earlier file. The lookup is advisory:
    // two imports racing past it both insert, the unique index on
    // (account_id, external_id) refuses the second, and the import loop counts
    // that row as skipped too (`isExternalIdConflict`).
    let externalId = ofxExternalId(qifTx.fitId);
    if (externalId) {
      const holder = ctx.heldExternalIds.get(externalId);
      if (holder && isSameBankRow(holder, qifTx)) {
        // The held row is one of the transfers the counted check sees, so
        // this line still takes its turn in the counters; otherwise a later
        // line without a bank id and of the same signature would be matched
        // against it and skipped.
        countTransferTurn(ctx, qifTx);
        recordSkippedRow(
          ctx.importResult,
          qifTx,
          "alreadyImported",
          ctx.account.currencyCode,
        );
        return;
      }
      // A different row holds the id: the bank reused it (a counter that
      // restarts each statement, say), so it does not name this row, and the
      // row imports without a key rather than being lost.
      if (holder) externalId = null;
    }

    // Check for duplicate transfers (from prior imports or earlier account blocks)
    if (await this.isRecordedTransfer(ctx, qifTx, externalId)) {
      recordSkippedRow(
        ctx.importResult,
        qifTx,
        "duplicateTransfer",
        ctx.account.currencyCode,
      );
      return;
    }

    await prepareImportAccrualSources(ctx.manager, ctx.userId);

    // Check for pending cross-currency transfers to update
    if (await this.matchPendingTransfer(ctx, qifTx, externalId)) {
      ctx.importResult.imported++;
      return;
    }

    await assertImportAccrualEntry(ctx, qifTx);

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

    // Determine status through the one shared derivation, so the regular and
    // investment import paths cannot disagree on what the same flags mean.
    const status = statusFromQifFlags(qifTx);

    // Create transaction (use canonical payee name if alias-matched)
    const isTransfer = !isSplit && (qifTx.isTransfer || isLoanPaymentTx);
    const transaction = ctx.manager.create(Transaction, {
      userId: ctx.userId,
      accountId: ctx.accountId,
      transactionDate: qifTx.date,
      amount: qifTx.amount,
      payeeName: resolvedPayee.payeeName,
      payeeId: resolvedPayee.payeeId,
      description: this.buildImportDescription(qifTx),
      referenceNumber: qifTx.number,
      categoryId: effectiveCategoryId,
      status,
      currencyCode: ctx.account.currencyCode,
      isSplit,
      isTransfer,
      externalId,
      createdAt: baseTime,
    });

    const savedTx = await ctx.manager.save(transaction);
    rememberImportedAccrualSource(ctx.manager, ctx.userId, savedTx.id);

    // Assign tags to the transaction
    await this.assignTransactionTags(ctx, savedTx.id, qifTx.tagNames);

    // Handle splits
    if (isSplit) {
      await this.processSplits(ctx, qifTx, savedTx, status, baseTime);
    }

    // Update account balance
    await updateAccountBalance(ctx.manager, ctx.accountId, qifTx.amount);

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

    // Transaction rules (design 6.3), last, so the caller's row savepoint
    // rolls the rule effects back with a row that fails. A transfer leg the
    // importer created is not evaluated here (transfers are a separate step).
    if (!isTransfer) {
      await this.applyImportRules(ctx, savedTx.id, qifTx.payee);
    }

    if (externalId) holdKey(ctx.heldExternalIds, externalId, qifTx);
    ctx.importResult.imported++;
  }

  /**
   * Run the file's preloaded import-trigger rules over one row just written on
   * the import's manager. `payeeText` is the raw text from the file, before
   * alias resolution. Counts the row when a rule changed it.
   */
  private async applyImportRules(
    ctx: ImportContext,
    transactionId: string,
    payeeText: string | null | undefined,
  ): Promise<void> {
    const rules = ctx.importRules;
    if (!rules || rules.length === 0) return;
    const applied = await this.rulesApplier.applyToNew(
      ctx.manager,
      ctx.userId,
      [transactionId],
      "import",
      {
        rules,
        payeeTextById: new Map([[transactionId, payeeText ?? null]]),
      },
    );
    // A structural action credited another account; the import's
    // post-processing recomputes its balance absolutely and then refreshes net
    // worth, after the import commits (INV-CACHE-001).
    for (const row of applied) {
      for (const accountId of row.affectedAccountIds) {
        ctx.affectedAccountIds.add(accountId);
      }
      for (const scheduleId of row.settledScheduleIds) {
        ctx.settledScheduleIds.add(scheduleId);
      }
    }
    // A traced change is a real one: the applier writes a trace row only for
    // a rule that changed the category, the payee or the tags.
    if (
      applied.some((row) =>
        row.effects.trace.some((e) => Object.keys(e.changes).length > 0),
      )
    ) {
      ctx.importResult.transactionsChangedByRules =
        (ctx.importResult.transactionsChangedByRules ?? 0) + 1;
    }
  }

  /**
   * Build the stored description for an imported transaction. When the row was
   * voided by stripping a Microsoft Money "VOID " payee prefix, append an
   * explanatory note: Money drops the original amount from the export, so the
   * transaction lands with a zero amount and the note records that it was
   * altered during the export/import process.
   */
  private buildImportDescription(qifTx: any): string {
    if (!qifTx.voidedByExport) {
      return qifTx.memo;
    }
    const note = tr(
      "common.import.voidedTransactionNote",
      "Voided in the source; the original amount was omitted from the export and imported as zero.",
    );
    return qifTx.memo ? `${qifTx.memo} ${note}` : note;
  }

  /**
   * Whether a transfer line is one the account already records. A line with a
   * bank id claims one recorded transfer of its signature that has none, so
   * its order in the file does not matter (`import-transfer-dedupe.ts`); a line
   * without one is counted against the recorded rows.
   */
  private async isRecordedTransfer(
    ctx: ImportContext,
    qifTx: any,
    externalId: string | null,
  ): Promise<boolean> {
    if (!externalId) return isDuplicateTransfer(ctx, qifTx, this.logger);
    countTransferTurn(ctx, qifTx);
    if (await adoptKeyOnRecordedTransfer(ctx, qifTx, externalId)) return true;
    return isQuickenMergedSplitTransfer(ctx, qifTx, this.logger);
  }

  private async matchPendingTransfer(
    ctx: ImportContext,
    qifTx: any,
    externalId: string | null,
  ): Promise<boolean> {
    if (!qifTx.isTransfer || !qifTx.transferAccount) return false;

    const mappedTransferAccountId = ctx.accountMap.get(qifTx.transferAccount);
    if (!mappedTransferAccountId) return false;

    const expectedSign = qifTx.amount >= 0 ? 1 : -1;
    const pendingTransfer = await ctx.manager
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

    await assertImportAccrualMatch(ctx, [
      pendingTransfer.id,
      pendingTransfer.linkedTransactionId,
    ]);
    const oldAmount = Number(pendingTransfer.amount);
    const newAmount = qifTx.amount;
    const balanceDiff = newAmount - oldAmount;

    await ctx.manager.update(Transaction, pendingTransfer.id, {
      amount: newAmount,
      description: qifTx.memo || null,
      payeeName: qifTx.payee || pendingTransfer.payeeName,
      referenceNumber: qifTx.number || pendingTransfer.referenceNumber,
      // The row now stands for this line of the file, so it takes the line's
      // bank id, and a later download of the same line is skipped; a key the
      // row already holds is kept.
      ...(externalId && !pendingTransfer.externalId ? { externalId } : {}),
    });

    if (balanceDiff !== 0) {
      await updateAccountBalance(ctx.manager, ctx.accountId, balanceDiff);
    }
    if (externalId && !pendingTransfer.externalId) {
      holdKey(ctx.heldExternalIds, externalId, qifTx);
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
    const existingPayee = await ctx.manager.findOne(Payee, {
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
    const aliases = await ctx.manager.find(PayeeAlias, {
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
    const newPayee = ctx.manager.create(Payee, {
      userId: ctx.userId,
      name: qifTx.payee,
    });
    const savedPayee = await ctx.manager.save(newPayee);
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

      const transactionSplit = ctx.manager.create(TransactionSplit, {
        transactionId: savedTx.id,
        kind: splitTransferAccountId ? SplitKind.TRANSFER : SplitKind.CATEGORY,
        categoryId: splitTransferAccountId ? null : splitCategoryId,
        transferAccountId: splitTransferAccountId,
        amount: split.amount,
        memo: split.memo,
      });

      const savedSplit = await ctx.manager.save(transactionSplit);

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
    const leg = await this.splitTransferLeg(
      ctx,
      splitTransferAccountId,
      -split.amount,
      qifTx.date,
    );
    const linkedAmount = leg.amount;

    // Check for existing linked transaction
    // Exclude transactions already linked to the current transaction (savedTx)
    // to prevent a second split transfer from matching the linked transaction
    // created by a prior split transfer in the same parent transaction.
    // Only match transactions that are either unlinked or linked to a simple
    // (non-split) placeholder in the current account. This prevents stealing
    // a linked transaction that already belongs to another split parent
    // transaction imported earlier in the same block.
    const existingLinkedTx = await ctx.manager
      .createQueryBuilder(Transaction, "t")
      .leftJoin(
        Transaction,
        "placeholder",
        "placeholder.id = t.linked_transaction_id AND placeholder.account_id = :currentAccountId AND placeholder.is_split = false",
        { currentAccountId: ctx.accountId },
      )
      .where("t.user_id = :userId", { userId: ctx.userId })
      .andWhere("t.account_id = :accountId", {
        accountId: splitTransferAccountId,
      })
      .andWhere("t.transaction_date = :date", { date: qifTx.date })
      .andWhere("t.amount = :amount", { amount: linkedAmount })
      .andWhere("t.is_transfer = true")
      .andWhere(
        "(t.linked_transaction_id IS NULL OR placeholder.id IS NOT NULL)",
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
    const pendingTransfer = await ctx.manager
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
      await assertImportAccrualMatch(ctx, [
        pendingTransfer.id,
        pendingTransfer.linkedTransactionId,
      ]);
      const oldAmount = Number(pendingTransfer.amount);
      const balanceDiff = linkedAmount - oldAmount;

      await ctx.manager.update(Transaction, pendingTransfer.id, {
        amount: linkedAmount,
        description: split.memo || qifTx.memo || null,
        linkedTransactionId: savedTx.id,
      });

      await ctx.manager.update(TransactionSplit, savedSplit.id, {
        linkedTransactionId: pendingTransfer.id,
      });

      if (balanceDiff !== 0) {
        await updateAccountBalance(
          ctx.manager,
          splitTransferAccountId,
          balanceDiff,
        );
      }
      return;
    }

    // Create new linked transaction
    const linkedSplitTx = ctx.manager.create(Transaction, {
      userId: ctx.userId,
      accountId: splitTransferAccountId,
      transactionDate: qifTx.date,
      amount: linkedAmount,
      // A plain transfer leg with no QIF payee is persisted blank (issue
      // #1214) -- the display resolves "Transfer from <account>" from the
      // linked leg at read time. The loan-payment stamp stays: "Loan Payment"
      // is information the linkage alone cannot reproduce.
      payeeName: isLoanPayment
        ? qifTx.payee || `Loan Payment from ${ctx.account.name}`
        : qifTx.payee || null,
      description: leg.crossCurrency
        ? `${split.memo || qifTx.memo || ""} ${PENDING_IMPORT_NOTE}`.trim()
        : split.memo || qifTx.memo,
      status,
      currencyCode: leg.currencyCode,
      exchangeRate: leg.exchangeRate,
      isTransfer: true,
      createdAt: new Date(baseTime.getTime() + 0.1),
    });

    const savedLinkedSplitTx = await ctx.manager.save(linkedSplitTx);
    rememberImportedAccrualSource(
      ctx.manager,
      ctx.userId,
      savedLinkedSplitTx.id,
    );

    await ctx.manager.update(TransactionSplit, savedSplit.id, {
      linkedTransactionId: savedLinkedSplitTx.id,
    });

    await ctx.manager.update(Transaction, savedLinkedSplitTx.id, {
      linkedTransactionId: savedTx.id,
    });

    await updateAccountBalance(
      ctx.manager,
      splitTransferAccountId,
      linkedAmount,
    );
  }

  /**
   * The split-transfer leg as the target account holds it (A26-M18,
   * INV-CURRENCY-001): a row's currency is its account's, so a split line
   * into an account in another currency is converted at the stored rate for
   * the row's date and carries that rate. QIF carries no rate of its own, and
   * the market rate is not the bank's, so the caller flags the row with the
   * plain transfer path's `PENDING IMPORT` note. Without a rate the row is
   * refused (its savepoint rolls back and the result names the pair): a
   * balance moved by a number in the wrong currency is worse than a row the
   * user can re-import once a rate exists.
   */
  private async splitTransferLeg(
    ctx: ImportContext,
    targetAccountId: string,
    sourceAmount: number,
    date: string | Date,
  ): Promise<{
    amount: number;
    currencyCode: string;
    exchangeRate: number;
    crossCurrency: boolean;
  }> {
    const sourceCurrency = ctx.account.currencyCode;
    const target = await ctx.manager.findOne(Account, {
      where: { id: targetAccountId },
    });
    const targetCurrency = target?.currencyCode ?? sourceCurrency;
    if (targetCurrency === sourceCurrency) {
      return {
        amount: sourceAmount,
        currencyCode: sourceCurrency,
        exchangeRate: 1,
        crossCurrency: false,
      };
    }

    const dateStr =
      typeof date === "string"
        ? date.substring(0, 10)
        : date.toISOString().substring(0, 10);
    const rate = await resolveFxRateOrNull(
      this.exchangeRateService,
      sourceCurrency,
      targetCurrency,
      dateStr,
    );
    if (rate === null) {
      const pair = `${sourceCurrency} -> ${targetCurrency}`;
      throw new BadRequestException(
        tr(
          "errors.import.noRateForSplitTransfer",
          `No exchange rate for ${pair} on ${dateStr}: a split line transfers into an account in another currency. Add an exchange rate for that pair and date, then import again.`,
          { pair, date: dateStr },
        ),
      );
    }
    return {
      amount: applyFxConversion(sourceAmount, rate).amount,
      currencyCode: targetCurrency,
      exchangeRate: rate,
      crossCurrency: true,
    };
  }

  private async linkExistingSplitTransfer(
    ctx: ImportContext,
    savedTx: Transaction,
    savedSplit: TransactionSplit,
    existingLinkedTx: Transaction,
  ): Promise<void> {
    await assertImportAccrualMatch(ctx, [
      existingLinkedTx.id,
      existingLinkedTx.linkedTransactionId,
    ]);
    await ctx.manager.update(TransactionSplit, savedSplit.id, {
      linkedTransactionId: existingLinkedTx.id,
    });

    if (!existingLinkedTx.linkedTransactionId) {
      await ctx.manager.update(Transaction, existingLinkedTx.id, {
        linkedTransactionId: savedTx.id,
      });
    }

    // Clean up placeholder transactions
    if (existingLinkedTx.linkedTransactionId) {
      const placeholderTx = await ctx.manager.findOne(Transaction, {
        where: {
          id: existingLinkedTx.linkedTransactionId,
          accountId: ctx.accountId,
        },
      });
      if (placeholderTx && placeholderTx.id !== savedTx.id) {
        // Only what the placeholder actually contributed: a VOID or future-dated
        // one contributed nothing. `needsRecalc` (the future-dated case) is
        // subsumed by the post-import absolute recompute of every account in
        // `ctx.affectedAccountIds`, so membership in that set is the
        // recalculation.
        const delta = deletionBalanceEffect(placeholderTx).delta;
        if (delta !== 0) {
          await updateAccountBalance(ctx.manager, ctx.accountId, delta);
        }
        ctx.affectedAccountIds.add(ctx.accountId);
        await ctx.manager.delete(Transaction, placeholderTx.id);
        await ctx.manager.update(Transaction, existingLinkedTx.id, {
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
        const txTag = ctx.manager.create(TransactionTag, {
          transactionId,
          tagId,
        });
        await ctx.manager.save(txTag);
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
        const splitTag = ctx.manager.create(TransactionSplitTag, {
          transactionSplitId: splitId,
          tagId,
        });
        await ctx.manager.save(splitTag);
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

    const targetAccount = await ctx.manager.findOne(Account, {
      where: { id: transferAccountId },
    });

    const isCrossCurrency =
      targetAccount && targetAccount.currencyCode !== ctx.account.currencyCode;

    // Check for existing pending transfer (cross-currency)
    let existingPendingTransfer: Transaction | null = null;
    if (isCrossCurrency) {
      const expectedSign = qifTx.amount < 0 ? 1 : -1;
      existingPendingTransfer = await ctx.manager
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
      await assertImportAccrualMatch(ctx, [
        existingPendingTransfer.id,
        existingPendingTransfer.linkedTransactionId,
      ]);
      // Same rule as the split path above: blank transfer payees stay blank
      // (issue #1214); only the loan-payment stamp survives.
      const linkedPayeeName = isLoanPaymentTx
        ? qifTx.payee || `Loan Payment from ${ctx.account.name}`
        : qifTx.payee || null;
      await ctx.manager.update(Transaction, existingPendingTransfer.id, {
        linkedTransactionId: savedTx.id,
        payeeName: linkedPayeeName,
        description: qifTx.memo || null,
      });

      await ctx.manager.update(Transaction, savedTx.id, {
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
      : qifTx.payee || null;
    const linkedTx = ctx.manager.create(Transaction, {
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

    const savedLinkedTx = await ctx.manager.save(linkedTx);
    rememberImportedAccrualSource(ctx.manager, ctx.userId, savedLinkedTx.id);

    await ctx.manager.update(Transaction, savedTx.id, {
      linkedTransactionId: savedLinkedTx.id,
    });

    await updateAccountBalance(ctx.manager, transferAccountId, linkedAmount);
  }
}
