import { statusFromQifFlags } from "./qif-status.util";
import {
  categoryIdForCategoryRow,
  categoryRowFit,
} from "../categories/category-row-gate";
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
  assertImportAmountPrecision,
  currencyMoneyDecimals,
  ImportContext,
  importMoneyDecimals,
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
  roundFxRate,
} from "../common/fx-entry.util";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import { tr } from "../i18n/translate";
import { TransactionRulesApplierService } from "../transaction-rules/transaction-rules-applier.service";

/**
 * The predicate every pending lookup matches a provisional leg with: the
 * column, never the description (design P1).
 */
const PROVISIONAL_LEG_SQL = "t.amount_is_provisional = true";

@Injectable()
export class ImportRegularProcessorService {
  private readonly logger = new Logger(ImportRegularProcessorService.name);

  constructor(
    private readonly rulesApplier: TransactionRulesApplierService,
    private readonly exchangeRateService: ExchangeRateService,
  ) {}

  async processTransaction(ctx: ImportContext, qifTx: any): Promise<void> {
    // The file's figures are refused, never rounded, when they carry more
    // places than the account's currency (INV-MONEY-001); the row's savepoint
    // rolls back and the result names it.
    assertImportAmountPrecision(ctx, qifTx.amount, "amount");
    for (const split of qifTx.splits ?? []) {
      assertImportAmountPrecision(ctx, split.amount, "split amount");
    }

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

    // Check for pending cross-currency transfers to update
    if (await this.matchPendingTransfer(ctx, qifTx, externalId)) {
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

    const isTransfer = !isSplit && (qifTx.isTransfer || isLoanPaymentTx);

    // If payee has a default category and no category was resolved from the
    // import, use the payee's default; never on a transfer, whose category is
    // the transfer's own (docs/specs/transfer-categories.md section 4.5). The
    // file's category, or the account's asset category, is a Transfer
    // category only when the person mapped one: on a category row it is
    // imported uncategorized and counted, as is a stored Transfer payee
    // default (written by a pod of the previous release), uncounted
    // (INV-CATEGORY-001).
    const effectiveCategoryId = isSplit
      ? null
      : isTransfer
        ? null
        : await this.fittingCategory(
            ctx,
            categoryId,
            resolvedPayee.defaultCategoryId,
          );

    // Generate unique createdAt timestamp
    const counter = ctx.dateCounters.get(qifTx.date) || 0;
    ctx.dateCounters.set(qifTx.date, counter + 1);
    const baseTime = new Date();
    baseTime.setMilliseconds(baseTime.getMilliseconds() + counter);

    // Determine status through the one shared derivation, so the regular and
    // investment import paths cannot disagree on what the same flags mean.
    const status = statusFromQifFlags(qifTx);

    // Create transaction (use canonical payee name if alias-matched)
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

    // Assign tags to the transaction
    await this.assignTransactionTags(ctx, savedTx.id, qifTx.tagNames);

    // Handle splits
    if (isSplit) {
      await this.processSplits(ctx, qifTx, savedTx, status, baseTime);
    }

    // Update account balance
    await updateAccountBalance(
      ctx.manager,
      ctx.accountId,
      qifTx.amount,
      importMoneyDecimals(ctx),
    );

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
      .andWhere(PROVISIONAL_LEG_SQL)
      .andWhere(expectedSign > 0 ? "t.amount > 0" : "t.amount < 0")
      .andWhere("linked.account_id = :linkedAccountId", {
        linkedAccountId: mappedTransferAccountId,
      })
      .getOne();

    if (!pendingTransfer) return false;

    const oldAmount = Number(pendingTransfer.amount);
    const newAmount = qifTx.amount;
    const balanceDiff = newAmount - oldAmount;

    // This account's own file states the amount, so the leg is confirmed:
    // the estimate, its flag and its note go in one update, and the balance
    // moves by the difference (design section 7, P6).
    const settlement = await this.confirmedSettlementRates(
      ctx,
      pendingTransfer,
      newAmount,
    );
    await ctx.manager.update(Transaction, pendingTransfer.id, {
      amount: newAmount,
      amountIsProvisional: false,
      ...(settlement ? { exchangeRate: settlement.confirmedLegRate } : {}),
      description: qifTx.memo || null,
      payeeName: qifTx.payee || pendingTransfer.payeeName,
      referenceNumber: qifTx.number || pendingTransfer.referenceNumber,
      // The row now stands for this line of the file, so it takes the line's
      // bank id, and a later download of the same line is skipped; a key the
      // row already holds is kept.
      ...(externalId && !pendingTransfer.externalId ? { externalId } : {}),
    });

    if (settlement && settlement.otherLegRate !== null) {
      await ctx.manager.update(Transaction, settlement.otherLegId, {
        exchangeRate: settlement.otherLegRate,
      });
    }

    if (balanceDiff !== 0) {
      await updateAccountBalance(
        ctx.manager,
        ctx.accountId,
        balanceDiff,
        importMoneyDecimals(ctx),
      );
    }
    if (externalId && !pendingTransfer.externalId) {
      holdKey(ctx.heldExternalIds, externalId, qifTx);
    }

    return true;
  }

  /**
   * The rates a transfer's legs hold once both amounts are stated. Until then
   * the provisional leg carries the market rate its estimate was struck at;
   * left there after confirmation it would be a plausible and wrong settlement
   * rate (a transfer edit scales a resent amount by the destination leg's
   * rate). The legs take the convention every other transfer writer follows
   * (`transfer-leg-columns.ts`): the source leg holds 1, the destination leg
   * holds destination units per source unit, here the two stated amounts'
   * ratio.
   *
   * The other side is the linked row, or, when that row is a split parent,
   * the split line that points at this leg; a split parent's own rate is not
   * a transfer rate and is left alone (`otherLegRate` null). `null` when the
   * other side is unknown or either amount is zero: no ratio exists, and the
   * stored rates stay as they are.
   */
  private async confirmedSettlementRates(
    ctx: ImportContext,
    leg: Transaction,
    confirmedAmount: number,
  ): Promise<{
    confirmedLegRate: number;
    otherLegId: string;
    otherLegRate: number | null;
  } | null> {
    const other = leg.linkedTransaction;
    if (!other) return null;
    const otherAmount = other.isSplit
      ? (
          await ctx.manager.findOne(TransactionSplit, {
            where: { transactionId: other.id, linkedTransactionId: leg.id },
          })
        )?.amount
      : other.amount;
    const otherAbs = Math.abs(Number(otherAmount));
    const confirmedAbs = Math.abs(confirmedAmount);
    if (!Number.isFinite(otherAbs) || otherAbs === 0 || confirmedAbs === 0) {
      return null;
    }
    const legIsDestination = confirmedAmount > 0;
    return {
      confirmedLegRate: legIsDestination
        ? roundFxRate(confirmedAbs / otherAbs)
        : 1,
      otherLegId: other.id,
      otherLegRate: other.isSplit
        ? null
        : legIsDestination
          ? 1
          : roundFxRate(otherAbs / confirmedAbs),
    };
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

  /**
   * The category a category row or line is written with: the file's (or the
   * account's asset category), else the payee's default, each only when it
   * fits a category row. The file's category skipped for being a Transfer
   * category is counted in `categoriesNotFitting`; a skipped payee default
   * is not, since the file named none.
   */
  private async fittingCategory(
    ctx: ImportContext,
    fileCategoryId: string | null,
    payeeDefaultCategoryId: string | null,
  ): Promise<string | null> {
    if (fileCategoryId) {
      const fitting = await categoryIdForCategoryRow(
        ctx.manager,
        ctx.userId,
        fileCategoryId,
      );
      if (fitting) return fitting;
      // Counted only for a Transfer category, which is what the notice says
      // (the same cached lookup).
      if (
        (await categoryRowFit(ctx.manager, ctx.userId, fileCategoryId)) ===
        "transfer"
      ) {
        ctx.importResult.categoriesNotFitting =
          (ctx.importResult.categoriesNotFitting ?? 0) + 1;
      }
      return null;
    }
    return categoryIdForCategoryRow(
      ctx.manager,
      ctx.userId,
      payeeDefaultCategoryId,
    );
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
          // A category line takes only Income or Expense (INV-CATEGORY-001).
          splitCategoryId = await this.fittingCategory(
            ctx,
            ctx.categoryMap.get(split.category) || null,
            null,
          );
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
    const leg = await this.transferLeg(
      ctx,
      splitTransferAccountId,
      -split.amount,
      qifTx.date,
      "split",
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

    // An orphaned provisional leg in the target account (its source gone) is
    // re-linked and re-estimated; it stays provisional, since this file is
    // the source's and still does not state the target's amount.
    const pendingTransfer = await this.findOrphanedProvisionalLeg(
      ctx,
      splitTransferAccountId,
      qifTx.date,
      linkedAmount,
    );

    if (pendingTransfer) {
      const oldAmount = Number(pendingTransfer.amount);
      const balanceDiff = linkedAmount - oldAmount;

      await ctx.manager.update(Transaction, pendingTransfer.id, {
        amount: linkedAmount,
        exchangeRate: leg.exchangeRate,
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
          leg.decimals,
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
      description: split.memo || qifTx.memo || null,
      status,
      currencyCode: leg.currencyCode,
      exchangeRate: leg.exchangeRate,
      amountIsProvisional: leg.crossCurrency,
      isTransfer: true,
      createdAt: new Date(baseTime.getTime() + 0.1),
    });

    const savedLinkedSplitTx = await ctx.manager.save(linkedSplitTx);

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
      leg.decimals,
    );
  }

  /**
   * The other account's leg of a transfer as that account holds it (A26-M18,
   * INV-CURRENCY-001): a row's currency is its account's, so a transfer into
   * an account in another currency is converted at the stored rate for the
   * row's date and carries that rate. The plain path and the split path share
   * this one computation (design docs/specs/provisional-amounts.md,
   * decision 2). The file carries no rate of its own and the market rate is
   * not the bank's, so the caller writes the leg as provisional
   * (`amountIsProvisional`); its description is the file's memo, as a
   * confirmed leg's is (design P1: nothing about the state is in the text).
   * Without a rate the row is refused (its savepoint rolls back and the
   * result names the pair and the date, decision 3): a balance moved by a
   * number in the wrong currency is worse than a row the user can re-import
   * once a rate exists.
   */
  private async transferLeg(
    ctx: ImportContext,
    targetAccountId: string,
    sourceAmount: number,
    date: string | Date,
    line: "transfer" | "split",
  ): Promise<{
    amount: number;
    currencyCode: string;
    exchangeRate: number;
    /**
     * The amount is an estimate in another currency, so the caller writes the
     * leg provisional. False for a same-currency leg and for a zero one.
     */
    crossCurrency: boolean;
    /** The money precision of the target account's currency. */
    decimals: number;
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
        decimals: importMoneyDecimals(ctx),
      };
    }
    // Zero needs no rate: nothing moves in either currency, so the leg is a
    // known zero, written confirmed without a lookup and never refused (a
    // Money "VOID" export imports as zero).
    if (sourceAmount === 0) {
      return {
        amount: 0,
        currencyCode: targetCurrency,
        exchangeRate: 1,
        crossCurrency: false,
        decimals: await currencyMoneyDecimals(ctx, targetCurrency),
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
        line === "split"
          ? tr(
              "errors.import.noRateForSplitTransfer",
              `No exchange rate for ${pair} on ${dateStr}: a split line transfers into an account in another currency. Add an exchange rate for that pair and date, then import again.`,
              { pair, date: dateStr },
            )
          : tr(
              "errors.import.noRateForTransfer",
              `No exchange rate for ${pair} on ${dateStr}: the transfer's other account is in another currency. Add an exchange rate for that pair and date, then import again.`,
              { pair, date: dateStr },
            ),
      );
    }
    // The converted line is in the target account's currency, so it rounds at
    // that currency's precision.
    const decimals = await currencyMoneyDecimals(ctx, targetCurrency);
    return {
      amount: applyFxConversion(sourceAmount, rate, null, {
        toDecimals: decimals,
      }).amount,
      currencyCode: targetCurrency,
      exchangeRate: rate,
      crossCurrency: true,
      decimals,
    };
  }

  /**
   * A provisional leg in the target account that lost its source (deleted;
   * the link is ON DELETE SET NULL), of the row's date and sign, found by the
   * column alone: a confirmed row whose description happens to hold the old
   * importer note is not one, and a provisional leg whose description was
   * edited or cleared still is (design P1).
   */
  private async findOrphanedProvisionalLeg(
    ctx: ImportContext,
    targetAccountId: string,
    date: string | Date,
    legAmount: number,
  ): Promise<Transaction | null> {
    const expectedSign = legAmount >= 0 ? 1 : -1;
    return ctx.manager
      .createQueryBuilder(Transaction, "t")
      .where("t.user_id = :userId", { userId: ctx.userId })
      .andWhere("t.account_id = :accountId", { accountId: targetAccountId })
      .andWhere("t.transaction_date = :date", { date })
      .andWhere("t.is_transfer = true")
      .andWhere("t.linked_transaction_id IS NULL")
      .andWhere(PROVISIONAL_LEG_SQL)
      .andWhere(expectedSign > 0 ? "t.amount > 0" : "t.amount < 0")
      .getOne();
  }

  private async linkExistingSplitTransfer(
    ctx: ImportContext,
    savedTx: Transaction,
    savedSplit: TransactionSplit,
    existingLinkedTx: Transaction,
  ): Promise<void> {
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
          await updateAccountBalance(
            ctx.manager,
            ctx.accountId,
            delta,
            importMoneyDecimals(ctx),
          );
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

    // The leg as the target account holds it: the file's figure in the same
    // currency, or the historical-rate estimate across currencies (refused
    // without a rate, before anything is written for the other account).
    const leg = await this.transferLeg(
      ctx,
      transferAccountId,
      -qifTx.amount,
      qifTx.date,
      "transfer",
    );

    // Same rule as the split path above: blank transfer payees stay blank
    // (issue #1214); only the loan-payment stamp survives.
    const linkedPayeeName = isLoanPaymentTx
      ? qifTx.payee || `Loan Payment from ${ctx.account.name}`
      : qifTx.payee || null;

    // An orphaned provisional leg in the target account (its source gone) is
    // re-linked and re-estimated at this row's rate; it stays provisional,
    // since this file is the source's and still does not state the target's
    // amount. Only a cross-currency leg is ever provisional.
    const existingPendingTransfer = leg.crossCurrency
      ? await this.findOrphanedProvisionalLeg(
          ctx,
          transferAccountId,
          qifTx.date,
          leg.amount,
        )
      : null;

    if (existingPendingTransfer) {
      const balanceDiff = leg.amount - Number(existingPendingTransfer.amount);
      await ctx.manager.update(Transaction, existingPendingTransfer.id, {
        amount: leg.amount,
        exchangeRate: leg.exchangeRate,
        linkedTransactionId: savedTx.id,
        payeeName: linkedPayeeName,
        description: qifTx.memo || null,
      });

      await ctx.manager.update(Transaction, savedTx.id, {
        linkedTransactionId: existingPendingTransfer.id,
      });

      if (balanceDiff !== 0) {
        await updateAccountBalance(
          ctx.manager,
          transferAccountId,
          balanceDiff,
          leg.decimals,
        );
      }
      return;
    }

    // Create new linked transaction
    const linkedTime = new Date(baseTime.getTime() + 0.5);
    const linkedTx = ctx.manager.create(Transaction, {
      userId: ctx.userId,
      accountId: transferAccountId,
      transactionDate: qifTx.date,
      amount: leg.amount,
      payeeName: linkedPayeeName,
      description: qifTx.memo || null,
      referenceNumber: qifTx.number,
      status,
      currencyCode: leg.currencyCode,
      exchangeRate: leg.exchangeRate,
      amountIsProvisional: leg.crossCurrency,
      isTransfer: true,
      linkedTransactionId: savedTx.id,
      createdAt: linkedTime,
    });

    const savedLinkedTx = await ctx.manager.save(linkedTx);

    await ctx.manager.update(Transaction, savedTx.id, {
      linkedTransactionId: savedLinkedTx.id,
    });

    await updateAccountBalance(
      ctx.manager,
      transferAccountId,
      leg.amount,
      leg.decimals,
    );
  }
}
