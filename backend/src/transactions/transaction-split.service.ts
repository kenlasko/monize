import {
  resolveIncrementalAccrualEdit,
  verifyIncrementalAccrualEdit,
  recordIncrementalAccrualHistory,
} from "../accruals/accrual-incremental-split";
import { restoreAccrualSplitTags } from "../accruals/accrual-history-snapshot";
import { requireAccrualOwner } from "../accruals/accrual-source";
import type { IncrementalSplitPreviewDto } from "./dto/incremental-split.dto";
import {
  verifySourceAccrualEdit,
  removeReviewedAccruals,
  deleteReplacedSplits,
} from "../accruals/accrual-source-edit";
import { refreshSourceAccruals } from "../accruals/accrual-lifecycle";
import {
  EmbeddedSeriesCarry,
  readEmbeddedSeriesCarry,
  takeCarriedSeries,
} from "../bonds/embedded-series-carry";
import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Inject,
  forwardRef,
} from "@nestjs/common";
import { DataSource, EntityManager, In } from "typeorm";
import {
  BondWriteGuard,
  createBondWriteGuard,
} from "../bonds/bond-write-guard";
import { Transaction, TransactionStatus } from "./entities/transaction.entity";
import { TransactionSplit } from "./entities/transaction-split.entity";
import { SplitKind } from "./entities/split-kind.enum";
import { Category } from "../categories/entities/category.entity";
import { CreateTransactionSplitDto } from "./dto/create-transaction-split.dto";
import { AccountsService } from "../accounts/accounts.service";
import { AccountSubType } from "../accounts/entities/account.entity";
import { isTransactionInFuture } from "../common/date-utils";
import { InvestmentTransactionsService } from "../securities/investment-transactions.service";
import {
  computeInvestmentCashImpact,
  isInvestmentActionAllowedInSplit,
} from "../securities/cash-impact.util";
import { NetWorthService } from "../net-worth/net-worth.service";
import { roundMoney, sumMoney } from "../common/round.util";
import { resolveFxRateOrNull } from "../common/fx-entry.util";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import { validateSplitAmountSum } from "../common/split-amount.util";
import { tr } from "../i18n/translate";
import { withScopedDb } from "../common/db/scoped-db";
import {
  lockTransactionRow,
  lockTransactionRows,
  acquireAdvisoryLock,
  LockScope,
} from "../common/db/locks";
import { assertReconciledRowsMutable } from "./reconciled-lock.util";
import { removeLockedTransactionLeg } from "./remove-transaction-leg";

import { inferSplitKind } from "./split-kind.util";

@Injectable()
export class TransactionSplitService {
  constructor(
    @Inject(forwardRef(() => AccountsService))
    private accountsService: AccountsService,
    @Inject(forwardRef(() => InvestmentTransactionsService))
    private investmentTransactionsService: InvestmentTransactionsService,
    @Inject(forwardRef(() => NetWorthService))
    private netWorthService: NetWorthService,
    private dataSource: DataSource,
    private exchangeRateService: ExchangeRateService,
  ) {}

  /**
   * The counterpart amount for a transfer child, in the TARGET account's
   * currency, plus the rate used.
   *
   * A split's amounts are denominated in the parent account's currency. The
   * counterpart used to be created at exactly `-split.amount` with
   * `exchangeRate: 1` while being labelled with the target account's currency,
   * so a 40 USD transfer child into a EUR account credited 40 EUR and recorded
   * the pair as if the currencies were at par. That is the transfer-split half of
   * audit P5-002, and it is the same silent 1:1 as the rest of that finding.
   *
   * Refuses rather than posting at par when the pair has no determinable rate.
   */
  private async resolveSplitTransferAmount(
    amount: number,
    sourceCurrencyCode: string,
    targetCurrencyCode: string,
    transactionDate: string,
  ): Promise<{ amount: number; exchangeRate: number }> {
    if (sourceCurrencyCode === targetCurrencyCode) {
      return { amount: roundMoney(-amount), exchangeRate: 1 };
    }

    const rate = await resolveFxRateOrNull(
      this.exchangeRateService,
      sourceCurrencyCode,
      targetCurrencyCode,
      transactionDate || null,
    );
    if (rate === null) {
      throw new BadRequestException(
        tr(
          "errors.transactions.transferRateUnavailable",
          `Could not determine an exchange rate for ${sourceCurrencyCode} -> ${targetCurrencyCode}. Supply an exchangeRate or a destination amount so the transfer posts correctly.`,
          { from: sourceCurrencyCode, to: targetCurrencyCode },
        ),
      );
    }

    const exchangeRate = rate;
    return { amount: roundMoney(-amount * exchangeRate), exchangeRate };
  }

  /**
   * Resolve -- and thereby store -- the market rate for every cross-currency
   * transfer child BEFORE the caller opens its write transaction.
   *
   * A missing rate makes `getRateForDate` fetch a provider window over HTTP
   * and persist it. Done lazily inside `createSplits`, that happened while
   * holding the locked parent row, keeping the lock and the transaction's
   * connection open for the provider's latency and serializing every
   * concurrent writer of that split set. After this warm-up the
   * in-transaction resolution is a plain database read.
   *
   * Best-effort by design: failures are swallowed because the transactional
   * resolver remains authoritative -- it re-resolves and refuses with the
   * proper error when the pair is genuinely unresolvable.
   */
  async prewarmSplitTransferRates(
    userId: string,
    splits: Pick<CreateTransactionSplitDto, "transferAccountId">[],
    sourceAccountId: string,
    transactionDate: string | Date | null | undefined,
  ): Promise<void> {
    const transferSplits = splits.filter((s) => s.transferAccountId);
    if (transferSplits.length === 0) return;
    const dateStr = !transactionDate
      ? null
      : typeof transactionDate === "string"
        ? transactionDate.substring(0, 10)
        : transactionDate.toISOString().substring(0, 10);
    try {
      const source = await this.accountsService.findOne(
        userId,
        sourceAccountId,
      );
      for (const split of transferSplits) {
        const target = await this.accountsService.findOne(
          userId,
          split.transferAccountId!,
        );
        if (target.currencyCode === source.currencyCode) continue;
        await resolveFxRateOrNull(
          this.exchangeRateService,
          source.currencyCode,
          target.currencyCode,
          dateStr,
        );
      }
    } catch {
      // Ownership and rate errors surface from the transactional path.
    }
  }

  private async validateCategoryOwnership(
    userId: string,
    categoryId: string,
  ): Promise<void> {
    const category = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Category).findOne({
        where: { id: categoryId, userId },
      }),
    );
    if (!category) {
      throw new NotFoundException(
        tr("errors.transactions.categoryNotFound", "Category not found"),
      );
    }
  }

  validateSplits(
    splits: CreateTransactionSplitDto[],
    transactionAmount: number,
  ): void {
    validateSplitAmountSum(splits, transactionAmount, {
      allowSinglePassthrough: true,
      isPassthrough: (s) => {
        const split = s as CreateTransactionSplitDto;
        return Boolean(split.transferAccountId || split.investment);
      },
    });

    for (const split of splits) {
      const kind = inferSplitKind(split);
      if (kind !== SplitKind.INVESTMENT) continue;

      const inv = split.investment;
      if (!inv) {
        throw new BadRequestException(
          tr(
            "errors.transactions.investmentSplitRequiresPayload",
            "Investment split requires an investment payload",
          ),
        );
      }
      if (!isInvestmentActionAllowedInSplit(inv.action)) {
        throw new BadRequestException(
          tr(
            "errors.transactions.investmentActionNotAllowedInSplit",
            `Investment action ${inv.action} is not allowed inside a split transaction`,
            { action: inv.action },
          ),
        );
      }
      if (split.categoryId || split.transferAccountId) {
        throw new BadRequestException(
          tr(
            "errors.transactions.investmentSplitCannotSetCategoryOrTransfer",
            "Investment splits cannot also set categoryId or transferAccountId",
          ),
        );
      }

      const cashImpactInSecurity = computeInvestmentCashImpact(
        inv.action,
        Number(inv.quantity ?? 0),
        Number(inv.price ?? 0),
        Number(inv.commission ?? 0),
      );
      // Only an internal-consistency check on the payload, and only when the
      // payload states a rate. It used to default to 1 and demand that the
      // split's cash amount equal the UNCONVERTED cash impact -- so for a USD
      // security in a CAD account it required the wrong number and rejected the
      // right one, while `createEmbeddedForSplit` went on to store the investment
      // row at the properly resolved rate. The two halves of one split then
      // disagreed by the whole FX spread. The authoritative check lives where the
      // rate is resolved (`createEmbeddedForSplit`), against the rate actually
      // stored.
      if (inv.exchangeRate === undefined || inv.exchangeRate === null) continue;
      const exchangeRate = Number(inv.exchangeRate);
      const expectedAmount = cashImpactInSecurity * exchangeRate;

      const expectedRounded = roundMoney(expectedAmount);
      const actualRounded = roundMoney(Number(split.amount));

      if (expectedRounded !== actualRounded) {
        throw new BadRequestException(
          tr(
            "errors.transactions.investmentSplitAmountMismatch",
            `Investment split amount (${split.amount}) does not match the cash impact ` +
              `of ${inv.action} ${inv.quantity ?? 0} @ ${inv.price ?? 0} ` +
              `(expected ${expectedAmount.toFixed(4)})`,
            {
              amount: split.amount,
              action: inv.action,
              quantity: inv.quantity ?? 0,
              price: inv.price ?? 0,
              expected: expectedAmount.toFixed(4),
            },
          ),
        );
      }
    }
  }

  /**
   * Create the split rows (and their transfer counterparts / embedded
   * investment rows). Runs in its own transaction when called standalone;
   * called from inside a caller's `withScopedDb` (transaction create/update,
   * updateSplits) it joins that transaction via re-entrancy.
   */
  async createSplits(
    transactionId: string,
    splits: CreateTransactionSplitDto[],
    userId?: string,
    sourceAccountId?: string,
    transactionDate?: Date,
    parentPayeeName?: string | null,
    parentPayeeId?: string | null,
    /**
     * The parent's status. A VOID parent describes something that did not
     * happen, so its transfer counterpart must be VOID too and must move no
     * balance -- this used to be unknown here, so a void split still credited
     * the target account and left an ACTIVE counterpart leg behind it.
     */
    options?: {
      parentStatus?: TransactionStatus;
      /**
       * The embedded investment rows this parent had before an edit rebuilt
       * them (`readEmbeddedSeriesCarry`): a recreated row that names no bond
       * series keeps its predecessor's (INV-BOND-007).
       */
      carriedSeries?: readonly EmbeddedSeriesCarry[];
      /**
       * Collects the securities of the embedded investment rows this created,
       * for the caller's bond price recompute after the commit (INV-BOND-005).
       */
      touchedSecurityIds?: Set<string>;
      retainedCategoryIds?: ReadonlyMap<number, string>;
    },
    /**
     * Every account this touched besides the parent's, so the caller can
     * invalidate their balance-derived state after commit. A transfer child
     * creates a counterpart in an account the parent never named, and an
     * investment child moves the brokerage account -- both went stale in
     * net worth because only the parent account was invalidated (recheck
     * RR5-002). Populated, never triggered from in here: the recalculation must
     * wait for the caller's commit.
     */
    affectedAccountIds?: Set<string>,
  ): Promise<TransactionSplit[]> {
    return withScopedDb(this.dataSource, (m) =>
      this.createSplitsInternal(
        m,
        transactionId,
        splits,
        userId,
        sourceAccountId,
        transactionDate,
        parentPayeeName,
        parentPayeeId,
        options,
        affectedAccountIds,
      ),
    );
  }

  private async createSplitsInternal(
    m: EntityManager,
    transactionId: string,
    splits: CreateTransactionSplitDto[],
    userId?: string,
    sourceAccountId?: string,
    transactionDate?: Date,
    parentPayeeName?: string | null,
    parentPayeeId?: string | null,
    options?: {
      parentStatus?: TransactionStatus;
      carriedSeries?: readonly EmbeddedSeriesCarry[];
      touchedSecurityIds?: Set<string>;
      retainedCategoryIds?: ReadonlyMap<number, string>;
    },
    affectedAccountIds?: Set<string>,
  ): Promise<TransactionSplit[]> {
    if (userId) {
      const categoryIds = [
        ...new Set(
          splits.map((s) => s.categoryId).filter((id): id is string => !!id),
        ),
      ];
      if (categoryIds.length > 0) {
        const found = await m.find(Category, {
          where: { id: In(categoryIds), userId },
          select: ["id"],
        });
        const foundIds = new Set(found.map((c) => c.id));
        const invalid = categoryIds.filter((id) => !foundIds.has(id));
        if (invalid.length > 0) {
          throw new NotFoundException(
            tr(
              "errors.transactions.categoriesNotFound",
              `Categories not found: ${invalid.join(", ")}`,
              { ids: invalid.join(", ") },
            ),
          );
        }
      }
    }

    const hasInvestment = splits.some(
      (s) => inferSplitKind(s) === SplitKind.INVESTMENT,
    );
    let brokerageAccountId: string | null = null;
    let parentDateStr = "";

    if (hasInvestment) {
      if (!userId || !sourceAccountId) {
        throw new BadRequestException(
          tr(
            "errors.transactions.investmentSplitRequiresSourceAccount",
            "Investment splits require a known source account",
          ),
        );
      }
      const sourceAccount = await this.accountsService.findOne(
        userId,
        sourceAccountId,
      );
      if (sourceAccount.accountSubType !== AccountSubType.INVESTMENT_CASH) {
        throw new BadRequestException(
          tr(
            "errors.transactions.investmentSplitRequiresInvestmentCashAccount",
            "Investment splits require the parent transaction to be on an INVESTMENT_CASH account",
          ),
        );
      }
      if (!sourceAccount.linkedAccountId) {
        throw new BadRequestException(
          tr(
            "errors.transactions.investmentCashAccountNotLinked",
            "Source INVESTMENT_CASH account is not linked to a brokerage account",
          ),
        );
      }
      brokerageAccountId = sourceAccount.linkedAccountId;
      parentDateStr = transactionDate
        ? transactionDate.toISOString().substring(0, 10)
        : "";
    }

    // Saved rows are placed back at their original input position so callers
    // that pair splits[i] with the result (e.g. split-level tag assignment) stay
    // aligned regardless of the batched/looped save ordering below.
    const savedSplits: TransactionSplit[] = new Array(splits.length);

    // Plain category splits (and transfers without userId/sourceAccountId
    // context, e.g. import flows) are batch-saved together. Each bucket keeps
    // the split's original index.
    const regularSplits: { split: CreateTransactionSplitDto; index: number }[] =
      [];
    const transferSplits: {
      split: CreateTransactionSplitDto;
      index: number;
    }[] = [];
    const investmentSplits: {
      split: CreateTransactionSplitDto;
      index: number;
    }[] = [];
    splits.forEach((split, index) => {
      const k = inferSplitKind(split);
      if (k === SplitKind.INVESTMENT) {
        investmentSplits.push({ split, index });
      } else if (
        k === SplitKind.TRANSFER &&
        split.transferAccountId &&
        userId &&
        sourceAccountId
      ) {
        transferSplits.push({ split, index });
      } else {
        regularSplits.push({ split, index });
      }
    });

    if (regularSplits.length > 0) {
      const regularEntities = regularSplits.map(({ split, index }) => {
        const kind = split.transferAccountId
          ? SplitKind.TRANSFER
          : SplitKind.CATEGORY;
        return m.create(TransactionSplit, {
          id: options?.retainedCategoryIds?.get(index),
          transactionId,
          kind,
          categoryId: split.categoryId || null,
          transferAccountId: split.transferAccountId || null,
          amount: split.amount,
          memo: split.memo || null,
        });
      });
      const batchSaved = await m.save(regularEntities);
      batchSaved.forEach((saved, j) => {
        savedSplits[regularSplits[j].index] = saved;
      });
    }

    for (const { split, index } of transferSplits) {
      const splitEntity = m.create(TransactionSplit, {
        transactionId,
        kind: SplitKind.TRANSFER,
        categoryId: null,
        transferAccountId: split.transferAccountId,
        amount: split.amount,
        memo: split.memo || null,
      });

      const savedSplit = await m.save(splitEntity);

      const targetAccount = await this.accountsService.findOne(
        userId!,
        split.transferAccountId!,
      );
      const sourceAccount = await this.accountsService.findOne(
        userId!,
        sourceAccountId!,
      );

      // Persist the transfer counterpart's date as a plain yyyy-MM-dd string,
      // not the Date object. The Date arrives as UTC midnight
      // (new Date("2024-01-05")), so saving it directly lets node-postgres
      // serialize it in the server's local time and Postgres truncates it to
      // the previous calendar day west of UTC -- shifting every split transfer
      // (e.g. loan payments) a day earlier than its parent. The ISO date part
      // recovers the intended day and matches the parent transaction.
      const dateStr = transactionDate
        ? transactionDate.toISOString().substring(0, 10)
        : "";

      // The counterpart is denominated in the TARGET account's currency, so a
      // split amount in the parent's currency has to be converted rather than
      // copied across with `exchangeRate: 1` (audit P5-002, transfer-split half).
      const counterpart = await this.resolveSplitTransferAmount(
        split.amount,
        sourceAccount.currencyCode,
        targetAccount.currencyCode,
        dateStr,
      );

      // A VOID parent's counterpart is VOID: the two rows describe one movement
      // of money, and every balance and report predicate excludes a VOID row, so
      // an active counterpart under a void parent is money from nowhere.
      const parentIsVoid = options?.parentStatus === TransactionStatus.VOID;

      const linkedTransaction = m.create(Transaction, {
        userId,
        accountId: split.transferAccountId,
        transactionDate: (dateStr || null) as any,
        amount: counterpart.amount,
        currencyCode: targetAccount.currencyCode,
        exchangeRate: counterpart.exchangeRate,
        description: split.memo || null,
        isTransfer: true,
        status: options?.parentStatus,
        payeeId: parentPayeeId || null,
        // A blank payee is persisted blank (issue #1214): the display resolves
        // "Transfer from <source>" from the linked parent's account at read
        // time, so it follows renames and the reader's language.
        payeeName: parentPayeeName || null,
      });

      const savedLinkedTransaction = await m.save(linkedTransaction);
      affectedAccountIds?.add(split.transferAccountId!);

      await m.update(TransactionSplit, savedSplit.id, {
        linkedTransactionId: savedLinkedTransaction.id,
      });

      await m.update(Transaction, savedLinkedTransaction.id, {
        linkedTransactionId: transactionId,
      });

      if (parentIsVoid) {
        // Recorded, not applied.
      } else if (dateStr && isTransactionInFuture(dateStr)) {
        // The transfer counterpart is created under `userId` above, so its
        // account is the caller's -- scope the balance-write lock to that owner.
        await this.accountsService.recalculateCurrentBalance(
          userId!,
          split.transferAccountId!,
        );
      } else {
        await this.accountsService.updateBalance(
          split.transferAccountId!,
          counterpart.amount,
        );
      }

      savedSplit.linkedTransactionId = savedLinkedTransaction.id;
      savedSplits[index] = savedSplit;
    }

    const carriedPool = [...(options?.carriedSeries ?? [])];
    for (const { split, index } of investmentSplits) {
      const splitEntity = m.create(TransactionSplit, {
        transactionId,
        kind: SplitKind.INVESTMENT,
        categoryId: null,
        transferAccountId: null,
        amount: split.amount,
        memo: split.memo || null,
      });
      const savedSplit = await m.save(splitEntity);

      const embedded =
        await this.investmentTransactionsService.createEmbeddedForSplit(
          m,
          userId!,
          parentDateStr,
          savedSplit.id,
          brokerageAccountId!,
          sourceAccountId!,
          split.investment!,
          // Checked against the resolved rate there: this amount and the
          // investment row have to describe the same money.
          Number(split.amount),
          // A VOID parent's embedded investment row is created VOID (no
          // holdings), for the same reason its transfer counterparts are.
          options?.parentStatus,
          takeCarriedSeries(carriedPool, {
            securityId: split.investment!.securityId,
            action: split.investment!.action,
            quantity: split.investment!.quantity,
            transactionDate: parentDateStr,
          }),
        );
      if (embedded?.securityId) {
        options?.touchedSecurityIds?.add(embedded.securityId);
      }

      savedSplits[index] = savedSplit;
    }

    if (hasInvestment && userId && brokerageAccountId) {
      if (affectedAccountIds) {
        // Collected for the caller to invalidate after commit; see the param doc.
        affectedAccountIds.add(brokerageAccountId);
      } else {
        // No collector supplied (a caller that owns no post-commit hook): keep
        // the original best-effort trigger rather than dropping the invalidation.
        this.netWorthService.triggerDebouncedRecalc(brokerageAccountId, userId);
      }
    }

    return savedSplits;
  }

  /**
   * Recategorize the category-kind lines of a set of split parents in one
   * statement, returning what each changed line held before the write so the
   * caller can record an undoable snapshot.
   *
   * Invariants owned here (docs/specs/split-bulk-update.md):
   * - I2: only `kind = 'category'` rows are written; transfer and investment
   *   lines are never touched.
   * - I3: the pre-read joins back to `transactions` on `user_id`; the UPDATE
   *   then writes only ids that pre-read proved (join is defense-in-depth).
   * - I6: the parent rows are locked first (`lockTransactionRows`), the same
   *   lock `updateSplits`/`addSplit` take, so split-set writers serialize.
   *
   * `restrictToCategoryIds` is the descendant-expanded category filter set;
   * `undefined` means all category-kind lines. Joins the caller's ambient
   * transaction when called from inside one (bulk update).
   */
  async bulkRecategorizeCategorySplits(
    userId: string,
    parentIds: string[],
    newCategoryId: string | null,
    restrictToCategoryIds?: string[],
  ): Promise<
    {
      splitId: string;
      transactionId: string;
      previousCategoryId: string | null;
    }[]
  > {
    if (parentIds.length === 0) return [];
    if (
      restrictToCategoryIds !== undefined &&
      restrictToCategoryIds.length === 0
    )
      return [];

    return withScopedDb(this.dataSource, async (m) => {
      // Parents only, never the full eligible set: locking a parent together
      // with its own counterpart leg is refused by lockTransactionRows.
      await lockTransactionRows(m, parentIds, userId);

      const params: unknown[] = [userId, parentIds];
      let restrictClause = "";
      if (restrictToCategoryIds !== undefined) {
        params.push(restrictToCategoryIds);
        restrictClause = " AND s.category_id = ANY($3)";
      }

      const rows: {
        id: string;
        transaction_id: string;
        category_id: string | null;
      }[] = await m.query(
        `SELECT s.id, s.transaction_id, s.category_id
           FROM transaction_splits s
           JOIN transactions t ON t.id = s.transaction_id
          WHERE t.user_id = $1
            AND s.transaction_id = ANY($2)
            AND s.kind = 'category'${restrictClause}
          ORDER BY s.id
            FOR UPDATE OF s`,
        params,
      );

      if (rows.length === 0) return [];

      await m.query(
        `UPDATE transaction_splits SET category_id = $1 WHERE id = ANY($2)`,
        [newCategoryId, rows.map((r) => r.id)],
      );

      return rows.map((r) => ({
        splitId: r.id,
        transactionId: r.transaction_id,
        previousCategoryId: r.category_id,
      }));
    });
  }

  /**
   * Reverse a split transaction's side effects (embedded investment holdings,
   * transfer counterpart rows and their balance impact) ahead of deleting or
   * rebuilding its splits. Joins the caller's ambient transaction; every call
   * site runs inside one (transaction update/remove, updateSplits).
   */
  /**
   * Apply a split parent's inclusion status to every transfer counterpart its
   * children created, moving each counterpart's balance exactly once.
   *
   * A split parent and the counterparts created from its transfer children are
   * one economic event. `parentStatus` reaches the counterpart when children are
   * created or rebuilt, but a status-only edit does not rebuild them -- so
   * voiding a mixed category/transfer split restored the source balance and left
   * the target holding the transferred amount, with an ACTIVE counterpart row
   * under a VOID parent (review finding FR-002).
   *
   * Runs inside the caller's transaction so the parent's own status change and
   * every counterpart's move commit together.
   */
  /**
   * Take the holdings advisory lock for every brokerage account an embedded
   * investment row of these split parents sits in.
   *
   * A path that writes a split parent calls this as the first statement of its
   * transaction, before it row-locks the parent and before the parent's balance
   * write row-locks `accounts`. The embedded rows' rebuild takes the advisory
   * lock afterwards, and `InvestmentTransactionsService.update()` reaches the
   * same parent the other way round -- advisory lock first, then that parent's
   * `FOR UPDATE` -- so an advisory lock taken after either row lock is a
   * deadlock for both (`common/db/locks.ts`, 40P01).
   *
   * The read inside it is unlocked, so it may precede the advisory lock, and
   * `pg_advisory_xact_lock` is re-entrant, so a path that cannot know in advance
   * whether the row is a split parent calls this unconditionally: a row with no
   * embedded investment legs locks nothing.
   */
  lockEmbeddedInvestmentScopes(
    m: EntityManager,
    userId: string,
    parentTransactionIds: readonly string[],
  ): Promise<void> {
    return this.investmentTransactionsService.lockEmbeddedHoldingScopes(
      m,
      userId,
      parentTransactionIds,
    );
  }

  async applyParentStatusToTransferCounterparts(
    m: EntityManager,
    transactionId: string,
    userId: string,
    newStatus: TransactionStatus,
    /**
     * Collects the securities whose lots a crossing of the VOID boundary moved,
     * for the caller's bond price recompute after the commit (INV-BOND-005).
     */
    touchedSecurityIds?: Set<string>,
  ): Promise<Set<string>> {
    const splits = await m.getRepository(TransactionSplit).find({
      where: { transactionId },
      select: ["id", "transferAccountId", "linkedTransactionId"],
    });
    const counterpartIds = splits
      .filter((split) => split.transferAccountId)
      .map((split) => split.linkedTransactionId)
      .filter((id): id is string => id !== null);

    // Returned so the caller can invalidate the balance-derived state of every
    // account this touched. Returning `void` left the caller invalidating only the
    // accounts it already knew about -- the parent's -- so a target account came
    // out with a corrected live balance beside a stale net-worth snapshot, and it
    // stayed stale until something unrelated wrote to that account (recheck
    // RR4-003). The recalculation is deliberately NOT dispatched from in here: this
    // runs inside the caller's transaction, and a rollback must not leave a
    // recompute queued for state that was never committed.
    const affectedAccountIds = new Set<string>();

    // Embedded investment rows are the parent's event too: their holdings
    // effect follows the parent across the VOID boundary exactly as a transfer
    // counterpart's balance does. Same transaction, same rollback.
    const embeddedAffected =
      await this.investmentTransactionsService.applyParentStatusToEmbeddedRows(
        m,
        userId,
        transactionId,
        newStatus,
        touchedSecurityIds,
      );
    for (const accountId of embeddedAffected) {
      affectedAccountIds.add(accountId);
    }

    if (counterpartIds.length === 0) return affectedAccountIds;

    // The status the transition is decided from and the amount the balance
    // moves by are read under the row lock, like every other delta in this
    // codebase (P4-003/FV4-002): an unlocked relation read raced a concurrent
    // leg edit, so propagation subtracted an amount the edit had already
    // replaced and the stored balance drifted from the recomputable one. A
    // counterpart that does not lock is not this user's row and is skipped --
    // inclusion there is per ledger.
    const lockedCounterparts = await lockTransactionRows(
      m,
      counterpartIds,
      userId,
    );

    for (const counterpart of lockedCounterparts.values()) {
      const wasVoid = counterpart.status === TransactionStatus.VOID;
      const isVoid = newStatus === TransactionStatus.VOID;
      if (wasVoid === isVoid) continue;

      await m.update(Transaction, counterpart.id, { status: newStatus });
      affectedAccountIds.add(counterpart.accountId);

      if (isTransactionInFuture(counterpart.transactionDate)) {
        await this.accountsService.recalculateCurrentBalance(
          userId,
          counterpart.accountId,
        );
      } else {
        await this.accountsService.updateBalance(
          counterpart.accountId,
          isVoid ? -counterpart.amount : counterpart.amount,
        );
      }
    }

    return affectedAccountIds;
  }

  /**
   * Returns every account whose balance this reversed, besides the parent's, so
   * the caller can invalidate their derived state after commit -- a transfer
   * child's counterpart account and an investment child's brokerage account both
   * went stale in net worth because only the parent account was invalidated
   * (recheck RR5-002).
   */
  async deleteSplitSideEffects(
    transactionId: string,
    userId: string,
    bond?: {
      /** Collects the securities of the removed embedded rows (INV-BOND-005). */
      touchedSecurityIds?: Set<string>;
      /**
       * The caller recreates the embedded rows and verifies once at the end
       * (a split replacement): it is tracked here, before the first removal.
       */
      bondGuard?: BondWriteGuard;
    },
  ): Promise<Set<string>> {
    return withScopedDb(this.dataSource, async (m) => {
      const affectedAccountIds = new Set<string>();
      const splits = await m.getRepository(TransactionSplit).find({
        where: { transactionId },
        relations: ["linkedTransaction", "investmentTransaction"],
      });

      // One guard for every embedded row of the parent, verified after the last
      // one is gone: a parent holding both the BUY and the SELL it covers is not
      // refused because one was removed before the other (INV-BOND-007).
      const bondGuard = bond?.bondGuard ?? createBondWriteGuard(m, userId);
      await bondGuard.track(
        splits.map((s) => s.investmentTransaction?.securityId),
      );

      // Reverse investment splits' holdings effects before the split rows are
      // deleted.
      for (const s of splits) {
        if (s.kind === SplitKind.INVESTMENT && s.investmentTransaction) {
          if (s.investmentTransaction.accountId) {
            affectedAccountIds.add(s.investmentTransaction.accountId);
          }
          await this.investmentTransactionsService.reverseAndRemoveEmbedded(
            m,
            userId,
            s.investmentTransaction,
            { touchedSecurityIds: bond?.touchedSecurityIds, bondGuard },
          );
        }
      }
      if (!bond?.bondGuard) await bondGuard.verify();

      const linkedTxIds = splits
        .filter((s) => s.linkedTransactionId && s.transferAccountId)
        .map((s) => s.linkedTransactionId!);

      if (linkedTxIds.length === 0) return affectedAccountIds;

      // Locked, re-read and conditionally deleted, exactly like the single-leg
      // path. An unlocked `find` followed by `remove(entity)` reversed whatever
      // amount the snapshot happened to hold and reversed it whether or not this
      // call was the one that removed the row -- a split replacement racing a
      // counterpart edit, or racing another replacement, each moved the target
      // account's balance once for one deleted row (audit FV4-002).
      //
      // Each locked leg's account is collected so the caller can invalidate its
      // net-worth state after commit -- the counterpart lives in an account the
      // parent never named (recheck RR5-002).
      const linked = await lockTransactionRows(m, linkedTxIds, userId);
      for (const leg of linked.values()) {
        affectedAccountIds.add(leg.accountId);
        await removeLockedTransactionLeg(m, leg, userId, this.accountsService);
      }

      return affectedAccountIds;
    });
  }

  /**
   * Find the split that owns a given transfer counterpart (the leg living in the
   * target account), or null if the transaction is not a split-transfer leg.
   * Used to mirror edits made on the counterpart back onto its split.
   */
  async getTransferSplitByLinkedTransaction(
    linkedTransactionId: string,
  ): Promise<TransactionSplit | null> {
    return withScopedDb(this.dataSource, (m) =>
      m.getRepository(TransactionSplit).findOne({
        where: { linkedTransactionId },
      }),
    );
  }

  async getSplits(transactionId: string): Promise<TransactionSplit[]> {
    return withScopedDb(this.dataSource, (m) =>
      m.getRepository(TransactionSplit).find({
        where: { transactionId },
        relations: ["category", "transferAccount", "investmentTransaction"],
        order: { createdAt: "ASC" },
      }),
    );
  }

  async updateSplits(
    transaction: Transaction,
    splits: CreateTransactionSplitDto[],
    userId: string,
    accrualImpactFingerprint?: string,
  ): Promise<TransactionSplit[]> {
    // Provider rate lookups happen out here, never while holding the parent
    // lock below; see prewarmSplitTransferRates.
    await this.prewarmSplitTransferRates(
      userId,
      splits,
      transaction.accountId,
      transaction.transactionDate,
    );
    // Every transfer target and brokerage account this replace touched besides
    // the parent's, invalidated after the commit so a rollback leaves nothing
    // queued (recheck RR5-002).
    const affectedAccountIds = new Set<string>();
    // The securities of the embedded rows torn down and recreated, repriced by
    // the bond engine after the commit (INV-BOND-005, INV-CACHE-001).
    const touchedSecurityIds = new Set<string>();
    const newSplits = await withScopedDb(this.dataSource, async (m) => {
      // First statement of the transaction: advisory before row locks
      // (`common/db/locks.ts`). A replacement tears the parent's existing
      // embedded investment rows down (`deleteSplitSideEffects` ->
      // `reverseAndRemoveEmbedded` -> the rebuild) and builds the new ones
      // (`createEmbeddedForSplit`), both under the holdings advisory lock, while
      // `InvestmentTransactionsService.update()` reaches the same parent the
      // other way round -- advisory lock first, then
      // `updateEmbeddedSplitParent`'s `lockTransactionRow` on that parent.
      // Taking the advisory lock after the parent's row lock below left the two
      // paths each holding the other's next lock (40P01).
      //
      // Unconditional: a parent with no embedded investment legs locks nothing,
      // and the helper's own `SELECT` is unlocked so it may precede the advisory
      // lock. A brokerage account only the incoming splits name needs no lock
      // here -- no committed embedded row of this parent sits in it, so nothing
      // can hold it while waiting for this parent's row.
      await this.lockEmbeddedInvestmentScopes(m, userId, [transaction.id]);

      // Same parent lock as addSplit, so full replacement and incremental
      // addition serialize against each other, and validated against the
      // parent's committed amount rather than the caller's snapshot of it.
      const parent = await lockTransactionRow(m, transaction.id, userId);
      if (!parent) {
        throw new NotFoundException(
          tr(
            "errors.transactions.notFoundById",
            `Transaction with ID ${transaction.id} not found`,
            { id: transaction.id },
          ),
        );
      }
      // Strict reconciled lock: replacing a reconciled parent's split set
      // rewrites the row the statement was matched against.
      await assertReconciledRowsMutable(m, userId, [parent]);
      const accrualEdit = await verifySourceAccrualEdit(
        m,
        userId,
        transaction.id,
        { splits },
        accrualImpactFingerprint,
      );
      await removeReviewedAccruals(m, userId, accrualEdit);

      this.validateSplits(splits, parent.amount);

      // Read before the embedded rows are torn down: the recreated rows keep
      // the bond series of the rows they replace.
      const carriedSeries = await readEmbeddedSeriesCarry(
        m,
        userId,
        transaction.id,
      );

      // One guard for the whole replacement: the old embedded rows are removed
      // and their successors written before it verifies, so a replacement that
      // leaves the lots as they were is not refused half way, and one that
      // leaves a removal uncovered rolls everything back (INV-BOND-007).
      const bondGuard: BondWriteGuard = createBondWriteGuard(m, userId);
      for (const acc of await this.deleteSplitSideEffects(
        transaction.id,
        userId,
        { touchedSecurityIds, bondGuard },
      )) {
        affectedAccountIds.add(acc);
      }

      await deleteReplacedSplits(
        m,
        transaction.id,
        accrualEdit.retainedCategoryIds,
      );

      // Every field the new splits are built from comes off the locked parent,
      // not off the caller's copy of it. The counterpart rows and embedded
      // investment rows *describe* the parent -- its account, its date, its payee
      // -- so a concurrent parent edit that committed after the caller read it
      // would otherwise be written into rows claiming the old values, with no
      // error and nothing to reconcile against (audit FV4-002).
      const created = await this.createSplits(
        parent.id,
        splits,
        userId,
        parent.accountId,
        new Date(parent.transactionDate),
        parent.payeeName,
        parent.payeeId,
        // The parent's status reaches the recreated counterparts, exactly as it
        // does on the create and update paths in `TransactionsService`. This was
        // the third route into a VOID parent with ACTIVE counterparts (the
        // FR-002 family): replacing the split set of a voided transaction --
        // reachable from `PUT /transactions/:id/splits`, the AI action and the
        // MCP tool -- deleted the VOID legs and recreated them active, so the
        // target account was credited money the source still showed as not sent.
        //
        // The status is the LOCKED parent's: the caller's copy was read before
        // this transaction, and a VOID that committed in between would recreate
        // the counterparts active against a VOID parent (A26-M09).
        {
          parentStatus: parent.status as TransactionStatus,
          carriedSeries,
          touchedSecurityIds,
          ...(accrualEdit.retainedCategoryIds.size
            ? { retainedCategoryIds: accrualEdit.retainedCategoryIds }
            : {}),
        },
        affectedAccountIds,
      );

      await bondGuard.verify();

      await m.update(Transaction, transaction.id, {
        isSplit: true,
        categoryId: null,
      });

      await refreshSourceAccruals(m, userId, transaction.id);
      return created;
    });

    // After the commit, so a rollback leaves nothing queued: every transfer
    // target and brokerage account this replace touched had its net-worth state
    // invalidated (recheck RR5-002), not only the parent account the caller knows.
    this.invalidateNetWorth(affectedAccountIds, userId);
    await this.recomputeBondPricesAfterWrite(userId, touchedSecurityIds);
    return newSplits;
  }

  /**
   * Reprice the bond-linked securities among these after a split write's
   * commit: its embedded investment rows changed their lots. Never called from
   * inside a transaction (INV-CACHE-001); a failure is logged by the bond
   * price service, not thrown, so it cannot contradict the committed write.
   */
  async recomputeBondPricesAfterWrite(
    userId: string,
    securityIds: Iterable<string>,
  ): Promise<void> {
    const ids = [...securityIds];
    if (ids.length === 0) return;
    await this.investmentTransactionsService.recomputeBondPricesAfterSplitWrite(
      userId,
      ids,
    );
  }

  /**
   * Queue a net-worth recompute for each account, for use after a split
   * mutation's transaction has committed.
   */
  private invalidateNetWorth(accountIds: Set<string>, userId: string): void {
    for (const accountId of accountIds) {
      this.netWorthService.triggerDebouncedRecalc(accountId, userId);
    }
  }

  async previewIncrementalSplit(
    transaction: Transaction,
    command: IncrementalSplitPreviewDto,
    userId: string,
  ) {
    requireAccrualOwner(userId);
    if (command.operation === "add" && command.split?.categoryId) {
      await this.validateCategoryOwnership(userId, command.split.categoryId);
    }
    return withScopedDb(this.dataSource, async (m) => {
      await acquireAdvisoryLock(m, LockScope.AccrualBulkHistory, userId);
      await this.lockEmbeddedInvestmentScopes(m, userId, [transaction.id]);
      const parent = await lockTransactionRow(m, transaction.id, userId);
      if (!parent)
        throw new NotFoundException(
          tr(
            "errors.transactions.notFoundById",
            `Transaction with ID ${transaction.id} not found`,
            { id: transaction.id },
          ),
        );
      await assertReconciledRowsMutable(m, userId, [parent]);
      const edit = await resolveIncrementalAccrualEdit(
        m,
        userId,
        transaction.id,
        command,
        true,
      );
      return {
        fingerprint: edit.fingerprint,
        impacts: edit.resolution.impacts,
        collapse: edit.collapse,
        activatesSplit: edit.activatesSplit,
        removedSourceSplitIds: edit.removedSourceSplitIds,
      };
    });
  }

  async addSplit(
    transaction: Transaction,
    splitDto: CreateTransactionSplitDto,
    userId: string,
    accrualImpactFingerprint?: string,
  ): Promise<TransactionSplit> {
    if (splitDto.investment) {
      throw new BadRequestException(
        tr(
          "errors.transactions.investmentSplitNoIncremental",
          "Investment splits cannot be added incrementally; replace the full split set instead.",
        ),
      );
    }
    if (splitDto.categoryId) {
      await this.validateCategoryOwnership(userId, splitDto.categoryId);
    }

    // Provider rate lookups happen out here, never while holding the parent
    // lock below; see prewarmSplitTransferRates.
    await this.prewarmSplitTransferRates(
      userId,
      [splitDto],
      transaction.accountId,
      transaction.transactionDate,
    );

    // The target account of a transfer child added here, so its net-worth state
    // is invalidated after commit -- the counterpart lives in an account this
    // transaction's parent never named (recheck RR5-002).
    let addedTransferAccountId: string | null = null;
    const savedSplitId = await withScopedDb(this.dataSource, async (m) => {
      await acquireAdvisoryLock(m, LockScope.AccrualBulkHistory, userId);
      await this.lockEmbeddedInvestmentScopes(m, userId, [transaction.id]);
      // The aggregate check and the insert are one serialized unit.
      //
      // Reading the split set, validating in application code, and inserting in
      // a later transaction is a check-then-act with nothing under it: the schema
      // has no aggregate constraint, and two inserts against the same parent hold
      // compatible foreign-key key-share locks, so both commit. Parent -100.00
      // with -60.00 already split, two concurrent -30.00 additions each
      // validating -90.00, and the splits total -120.00 (audit P4-009).
      //
      // The parent row lock is what serializes them. Every other writer of this
      // split set -- full replacement included -- takes the same lock, so the
      // second request re-reads the set the first one committed and refuses.
      const parent = await lockTransactionRow(m, transaction.id, userId);
      if (!parent) {
        throw new NotFoundException(
          tr(
            "errors.transactions.notFoundById",
            `Transaction with ID ${transaction.id} not found`,
            { id: transaction.id },
          ),
        );
      }

      // Strict reconciled lock, before the split set is read or written.
      await assertReconciledRowsMutable(m, userId, [parent]);

      const existingSplits = await m.getRepository(TransactionSplit).find({
        where: { transactionId: transaction.id },
      });
      const existingTotal = sumMoney(
        existingSplits.map((s) => Number(s.amount)),
      );
      const newTotal = sumMoney([existingTotal, Number(splitDto.amount)]);
      const transactionAmount = roundMoney(parent.amount);

      if (Math.abs(newTotal) > Math.abs(transactionAmount)) {
        throw new BadRequestException(
          tr(
            "errors.transactions.splitExceedsTransactionAmount",
            `Adding this split would exceed the transaction amount. ` +
              `Current total: ${existingTotal}, New split: ${splitDto.amount}, ` +
              `Transaction amount: ${transactionAmount}`,
            {
              existingTotal,
              newSplit: splitDto.amount,
              transactionAmount,
            },
          ),
        );
      }

      const accrualEdit = await resolveIncrementalAccrualEdit(
        m,
        userId,
        transaction.id,
        { operation: "add", split: splitDto },
      );
      verifyIncrementalAccrualEdit(accrualEdit, accrualImpactFingerprint);
      await removeReviewedAccruals(m, userId, accrualEdit.resolution);

      const splitKind = splitDto.transferAccountId
        ? SplitKind.TRANSFER
        : SplitKind.CATEGORY;
      const split = m.create(TransactionSplit, {
        transactionId: transaction.id,
        kind: splitKind,
        categoryId: splitDto.categoryId || null,
        transferAccountId: splitDto.transferAccountId || null,
        amount: splitDto.amount,
        memo: splitDto.memo || null,
      });

      const savedSplit = await m.save(split);
      if (splitDto.tagIds?.length)
        await restoreAccrualSplitTags(
          m,
          userId,
          transaction.id,
          { splits: [{ id: savedSplit.id, tagIds: splitDto.tagIds }] },
          false,
        );

      if (splitDto.transferAccountId) {
        const targetAccount = await this.accountsService.findOne(
          userId,
          splitDto.transferAccountId,
        );
        // Built from the locked parent, not the caller's snapshot: see the note
        // in `updateSplits` (audit FV4-002).
        const sourceAccount = await this.accountsService.findOne(
          userId,
          parent.accountId,
        );

        const counterpart = await this.resolveSplitTransferAmount(
          splitDto.amount,
          sourceAccount.currencyCode,
          targetAccount.currencyCode,
          String(transaction.transactionDate),
        );

        const linkedTransaction = m.create(Transaction, {
          userId,
          accountId: splitDto.transferAccountId,
          // Date from the locked row (04-02 concurrency convention); amount is the
          // cross-currency-converted counterpart, not a raw negation (audit P5-002).
          transactionDate: parent.transactionDate,
          amount: counterpart.amount,
          currencyCode: targetAccount.currencyCode,
          exchangeRate: counterpart.exchangeRate,
          description: splitDto.memo || null,
          isTransfer: true,
          // A VOID parent's counterpart is VOID and moves no balance, exactly as
          // on the bulk creation path (FR-002 family). The status and the payee
          // come off the locked parent, not the caller's snapshot (FV4-002): a
          // VOID committed between the caller's read and this lock otherwise
          // wrote an active leg under a VOID parent (A26-M09).
          status: parent.status as TransactionStatus,
          payeeId: parent.payeeId || null,
          // Blank stays blank (issue #1214): the label resolves at read time.
          payeeName: parent.payeeName || null,
        });

        const savedLinkedTransaction = await m.save(linkedTransaction);
        addedTransferAccountId = splitDto.transferAccountId;

        await m.update(TransactionSplit, savedSplit.id, {
          linkedTransactionId: savedLinkedTransaction.id,
        });

        // Same two rules as the bulk creation path above: a VOID parent's
        // counterpart moves no balance, and the amount is the converted one.
        if (parent.status === TransactionStatus.VOID) {
          // Recorded, not applied.
        } else if (isTransactionInFuture(parent.transactionDate)) {
          await this.accountsService.recalculateCurrentBalance(
            userId,
            splitDto.transferAccountId,
          );
        } else {
          await this.accountsService.updateBalance(
            splitDto.transferAccountId,
            counterpart.amount,
          );
        }
      }

      const totalSplits = existingSplits.length + 1;
      if (totalSplits >= 2 && !parent.isSplit) {
        await m.update(Transaction, transaction.id, {
          isSplit: true,
          categoryId: null,
        });
      }

      if (accrualEdit.before) {
        await refreshSourceAccruals(m, userId, transaction.id);
        await recordIncrementalAccrualHistory(
          m,
          userId,
          transaction.id,
          accrualEdit.before,
        );
      }
      return savedSplit.id;
    });

    const splitWithRelations = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(TransactionSplit).findOne({
        where: { id: savedSplitId },
        relations: ["category", "transferAccount"],
      }),
    );

    if (!splitWithRelations) {
      throw new NotFoundException(
        tr(
          "errors.transactions.splitNotFoundById",
          `Split with ID ${savedSplitId} not found`,
          { id: savedSplitId },
        ),
      );
    }

    if (addedTransferAccountId) {
      this.invalidateNetWorth(new Set([addedTransferAccountId]), userId);
    }
    return splitWithRelations;
  }

  /**
   * Delete a split's transfer counterpart and reverse its balance, once, and
   * report the account it moved so the caller can invalidate that account's
   * net-worth state after commit (recheck RR5-002).
   *
   * The leg is locked and re-read here rather than taken from the split's
   * snapshot: the amount reversed has to be the amount the delete removes, and
   * the reversal only happens when this call is the one that removed the row.
   * Both split-removal paths below go through this, so the collapse case cannot
   * drift from the ordinary one. Returns the counterpart's account id, or null
   * when another request already removed the leg (nothing was reversed).
   */
  private async removeLinkedLeg(
    m: EntityManager,
    linkedTransactionId: string,
    userId: string,
  ): Promise<string | null> {
    const linked = await lockTransactionRow(m, linkedTransactionId, userId);
    if (!linked) return null;
    await removeLockedTransactionLeg(m, linked, userId, this.accountsService);
    return linked.accountId;
  }

  async removeSplit(
    transaction: Transaction,
    splitId: string,
    userId: string,
    accrualImpactFingerprint?: string,
  ): Promise<void> {
    // Accounts this removal moved besides the parent's, invalidated after commit
    // (recheck RR5-002).
    const affectedAccountIds = new Set<string>();
    const touchedSecurityIds = new Set<string>();
    await withScopedDb(this.dataSource, async (m) => {
      await acquireAdvisoryLock(m, LockScope.AccrualBulkHistory, userId);
      await this.lockEmbeddedInvestmentScopes(m, userId, [transaction.id]);
      // The parent first, so a concurrent split mutation on the same parent
      // serializes behind this one, and so the split below is read from a state
      // that cannot change under us. The old code read the split in its own
      // autocommit transaction before opening this one, then reversed a balance
      // from that snapshot -- two concurrent removals of the same transfer split
      // each applied the reversal while only one row went away (audit FV4-002).
      const lockedParent = await lockTransactionRow(m, transaction.id, userId);
      if (!lockedParent) {
        throw new NotFoundException(
          tr(
            "errors.transactions.notFoundById",
            `Transaction with ID ${transaction.id} not found`,
            { id: transaction.id },
          ),
        );
      }

      // Strict reconciled lock, before the split is read or removed.
      await assertReconciledRowsMutable(m, userId, [lockedParent]);

      const split = await m.getRepository(TransactionSplit).findOne({
        where: { id: splitId, transactionId: transaction.id },
        relations: ["investmentTransaction"],
      });

      if (!split) {
        // Either it never existed or another request removed it while this one
        // waited for the parent lock. Both are "not found", and neither has left
        // a balance for this call to reverse.
        throw new NotFoundException(
          tr(
            "errors.transactions.splitNotFoundById",
            `Split with ID ${splitId} not found`,
            { id: splitId },
          ),
        );
      }

      const accrualEdit = await resolveIncrementalAccrualEdit(
        m,
        userId,
        transaction.id,
        { operation: "remove", splitId },
      );
      verifyIncrementalAccrualEdit(accrualEdit, accrualImpactFingerprint);
      await removeReviewedAccruals(m, userId, accrualEdit.resolution);

      if (split.kind === SplitKind.INVESTMENT && split.investmentTransaction) {
        if (split.investmentTransaction.accountId) {
          affectedAccountIds.add(split.investmentTransaction.accountId);
        }
        await this.investmentTransactionsService.reverseAndRemoveEmbedded(
          m,
          userId,
          split.investmentTransaction,
          { touchedSecurityIds },
        );
      } else if (split.linkedTransactionId && split.transferAccountId) {
        const movedAccountId = await this.removeLinkedLeg(
          m,
          split.linkedTransactionId,
          userId,
        );
        if (movedAccountId) {
          affectedAccountIds.add(movedAccountId);
        }
      }

      await m.remove(split);

      const remainingSplits = await m.find(TransactionSplit, {
        where: { transactionId: transaction.id },
        relations: ["category", "transferAccount", "investmentTransaction"],
        order: { createdAt: "ASC" },
      });

      if (remainingSplits.length < 2) {
        if (remainingSplits.length === 1) {
          const lastSplit = remainingSplits[0];

          // Don't auto-collapse if the last remaining split is investment-kind
          // — that representation only makes sense as part of a split parent.
          if (lastSplit.kind === SplitKind.INVESTMENT) {
            return;
          }

          if (lastSplit.linkedTransactionId && lastSplit.transferAccountId) {
            const movedAccountId = await this.removeLinkedLeg(
              m,
              lastSplit.linkedTransactionId,
              userId,
            );
            if (movedAccountId) {
              affectedAccountIds.add(movedAccountId);
            }
          }

          await m.update(Transaction, transaction.id, {
            isSplit: false,
            categoryId: lastSplit.categoryId,
          });
          await m.remove(lastSplit);
        } else {
          await m.update(Transaction, transaction.id, {
            isSplit: false,
          });
        }
      }
      if (accrualEdit.before) {
        await refreshSourceAccruals(m, userId, transaction.id);
        await recordIncrementalAccrualHistory(
          m,
          userId,
          transaction.id,
          accrualEdit.before,
        );
      }
    });

    this.invalidateNetWorth(affectedAccountIds, userId);
    await this.recomputeBondPricesAfterWrite(userId, touchedSecurityIds);
  }
}
