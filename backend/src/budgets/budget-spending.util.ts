import type { ReportingBasis } from "../accruals/reporting-basis";
import { reportingRawMany } from "../accruals/reporting-query";
import { ObjectLiteral, Repository, SelectQueryBuilder } from "typeorm";
import { Transaction } from "../transactions/entities/transaction.entity";
import { TransactionSplit } from "../transactions/entities/transaction-split.entity";
import { BudgetCategory } from "./entities/budget-category.entity";
import { FxAggregate } from "../common/fx-aggregate";
import {
  buildRateIndex,
  convertAtDate,
} from "../common/time-series/rate-index.util";

/**
 * A transfer a budget (or a transfer analysis) counts arrives in one of two
 * shapes, and every surface must read both:
 *
 * - a whole-row transfer: the parent carries `is_transfer = true` and the
 *   destination hangs off the linked counterpart leg;
 * - one component of a split: the parent is a split transaction rather than a
 *   transfer row, and the split line carries `transfer_account_id` directly.
 *
 * A query keyed off `t.is_transfer` alone never sees the second shape, so a
 * savings or debt-payment budget under-reported its progress by the whole
 * transfer whenever the user recorded it alongside a category on one line
 * (audit P5-007) -- and the same omission then survived on four more read
 * surfaces (review #1131). These two builders are the one place the pair of
 * predicates is written; callers add their own SELECT and GROUP BY on top,
 * reading the amount and destination through the exported expressions.
 *
 * Filtering on the split's own target cannot double-count, because a
 * counterpart row is not itself a split. Both builders keep outflows only
 * (`amount < 0`): a transfer INTO the budgeted account is progress, one out of
 * it is not.
 */
export interface OutgoingTransferWindow {
  userId: string;
  periodStart: string;
  periodEnd: string;
  /** Restrict to these destination accounts; omit to sweep every destination. */
  transferAccountIds?: string[];
  /**
   * Source accounts the budget leaves out (`budgetExcludedAccountIds`); a
   * transfer out of an excluded account is not the budget's progress.
   */
  excludedAccountIds?: readonly string[];
}

/**
 * The accounts a budget leaves out of its actuals, as chosen in the budget
 * wizard and stored in `budgets.config` (audit A26-M31). `config` is a JSONB
 * column the client writes, so anything but an array of strings reads as
 * "nothing excluded".
 */
export function budgetExcludedAccountIds(config: unknown): string[] {
  if (config === null || typeof config !== "object") return [];
  const ids = (config as { excludedAccountIds?: unknown }).excludedAccountIds;
  if (!Array.isArray(ids)) return [];
  return ids.filter((id): id is string => typeof id === "string");
}

/**
 * Leaves the budget's excluded accounts out of an actuals query whose
 * transaction alias is `t`. The one place the predicate is written: every
 * budget actuals query (live page, alerts, period close, income) calls it.
 * Call it after the builder's `.where(...)`, which replaces earlier clauses.
 */
export function excludeBudgetAccounts<T extends ObjectLiteral>(
  qb: SelectQueryBuilder<T>,
  excludedAccountIds: readonly string[],
): SelectQueryBuilder<T> {
  if (excludedAccountIds.length === 0) return qb;
  return qb.andWhere("t.account_id NOT IN (:...excludedAccountIds)", {
    excludedAccountIds,
  });
}

/** Destination account of a whole-row transfer (parent builder alias). */
export const PARENT_TRANSFER_DESTINATION = "lt.account_id";
/** Destination account of a split-line transfer (split builder alias). */
export const SPLIT_TRANSFER_DESTINATION = "s.transfer_account_id";
/** Amount moved by a whole-row transfer (parent builder alias). */
export const PARENT_TRANSFER_AMOUNT = "t.amount";
/** Amount moved by a split-line transfer (split builder alias). */
export const SPLIT_TRANSFER_AMOUNT = "s.amount";

export function outgoingParentTransfers(
  repository: Repository<Transaction>,
  window: OutgoingTransferWindow,
): SelectQueryBuilder<Transaction> {
  const qb = repository
    .createQueryBuilder("t")
    .innerJoin("t.linkedTransaction", "lt")
    .where("t.user_id = :userId", { userId: window.userId })
    .andWhere("t.is_transfer = true")
    .andWhere("t.amount < 0")
    .andWhere("t.transaction_date >= :periodStart", {
      periodStart: window.periodStart,
    })
    .andWhere("t.transaction_date <= :periodEnd", {
      periodEnd: window.periodEnd,
    })
    .andWhere("t.status != :void", { void: "VOID" });
  if (window.transferAccountIds) {
    qb.andWhere("lt.account_id IN (:...transferAccountIds)", {
      transferAccountIds: window.transferAccountIds,
    });
  }
  return excludeBudgetAccounts(qb, window.excludedAccountIds ?? []);
}

export function outgoingSplitTransfers(
  repository: Repository<TransactionSplit>,
  window: OutgoingTransferWindow,
): SelectQueryBuilder<TransactionSplit> {
  const qb = repository
    .createQueryBuilder("s")
    .innerJoin("s.transaction", "t")
    .where("t.user_id = :userId", { userId: window.userId })
    .andWhere("s.amount < 0")
    .andWhere("t.transaction_date >= :periodStart", {
      periodStart: window.periodStart,
    })
    .andWhere("t.transaction_date <= :periodEnd", {
      periodEnd: window.periodEnd,
    })
    .andWhere("t.status != :void", { void: "VOID" });
  if (window.transferAccountIds) {
    qb.andWhere("s.transfer_account_id IN (:...transferAccountIds)", {
      transferAccountIds: window.transferAccountIds,
    });
  } else {
    qb.andWhere("s.transfer_account_id IS NOT NULL");
  }
  return excludeBudgetAccounts(qb, window.excludedAccountIds ?? []);
}

/** What `queryCategorySpending` returns: converted sums plus what is unknown. */
export interface CategorySpending {
  /** categoryId -> signed net sum of the rows that converted, in `currency`. */
  spendingMap: Map<string, number>;
  /** destination accountId -> outgoing total of the rows that converted. */
  transferSpendingMap: Map<string, number>;
  /** The budget's currency: every figure above is in it. */
  currency: string;
  /** Categories with a row that had no rate; their map entry is a subtotal. */
  incompleteCategoryIds: ReadonlySet<string>;
  /** Transfer destinations with a row that had no rate. */
  incompleteTransferAccountIds: ReadonlySet<string>;
  /** `"JPY->CAD"` for each pair with no admissible rate, sorted. */
  missingRatePairs: string[];
}

interface SpendingRow {
  key: string;
  currencyCode: string;
  txDate: string;
  total: string | null;
}

/**
 * Queries transaction and split spending for budget categories within a period,
 * converted into the budget's currency (INV-FX-001, "convert before summing").
 * Returns maps of categoryId -> totalSpent and transferAccountId -> totalSpent.
 *
 * Each row is converted at the rate of its own transaction date (the newest
 * observation on or before that date within the age bound), so a month's figure
 * does not move when a later rate is stored. A row with no admissible rate is
 * left out of the map's subtotal and its key is reported in the incomplete sets
 * with the pair in `missingRatePairs`; it is never added at rate 1. The
 * `*OrNull` resolver turns an incomplete key into `null`. The callers
 * switching to that resolver (budget page `spent: number | null`, alerts
 * skipping an unknown line, period close) is owned by the budgets stream.
 *
 * Shared between BudgetsService and BudgetAlertService to avoid duplication.
 */
export async function queryCategorySpending(
  transactionsRepository: Repository<Transaction>,
  splitsRepository: Repository<TransactionSplit>,
  userId: string,
  budgetCategories: BudgetCategory[],
  periodStart: string,
  periodEnd: string,
  _targetCurrency?: string,
  basis?: ReportingBasis,
): Promise<CategorySpending> {
  const spendingMap = new Map<string, number>();
  const transferSpendingMap = new Map<string, number>();
  const incompleteCategoryIds = new Set<string>();
  const incompleteTransferAccountIds = new Set<string>();

  // No line, no amount to convert and no budget to name a currency from.
  if (budgetCategories.length === 0) {
    return {
      spendingMap,
      transferSpendingMap,
      currency: "",
      incompleteCategoryIds,
      incompleteTransferAccountIds,
      missingRatePairs: [],
    };
  }

  const manager = transactionsRepository.manager;
  const budgetRows: Array<{ currency_code: string; config: unknown }> =
    await manager.query(
      "SELECT currency_code, config FROM budgets WHERE id = $1",
      [budgetCategories[0].budgetId],
    );
  const currency = budgetRows[0]?.currency_code ?? "";
  // Read from the budget row itself, so no caller can forget to pass them.
  const excludedAccountIds = budgetExcludedAccountIds(budgetRows[0]?.config);

  const categoryIds = budgetCategories
    .filter((bc) => bc.categoryId !== null)
    .map((bc) => bc.categoryId as string);
  const transferBudgetCategories = budgetCategories.filter(
    (bc) => bc.isTransfer && bc.transferAccountId,
  );

  // Every query groups by currency and transaction date as well as by key, so
  // each group is one currency on one day and converts at one rate.
  const dateExpr = "TO_CHAR(t.transaction_date, 'YYYY-MM-DD')";
  const categoryRows: SpendingRow[] = [];
  const transferRows: SpendingRow[] = [];

  if (categoryIds.length > 0) {
    const directQb = transactionsRepository
      .createQueryBuilder("t")
      .select("t.category_id", "key")
      .addSelect("t.currency_code", "currencyCode")
      .addSelect(dateExpr, "txDate")
      .addSelect("COALESCE(SUM(t.amount), 0)", "total")
      .where("t.user_id = :userId", { userId })
      .andWhere("t.category_id IN (:...categoryIds)", { categoryIds })
      .andWhere("t.transaction_date >= :periodStart", { periodStart })
      .andWhere("t.transaction_date <= :periodEnd", { periodEnd })
      .andWhere("t.status != :void", { void: "VOID" })
      .andWhere("t.is_split = false");
    const directRows = await reportingRawMany(
      manager,
      userId,
      excludeBudgetAccounts(directQb, excludedAccountIds)
        .groupBy("t.category_id")
        .addGroupBy("t.currency_code")
        .addGroupBy("t.transaction_date"),
      basis,
    );
    categoryRows.push(...directRows);

    const splitQb = splitsRepository
      .createQueryBuilder("s")
      .innerJoin("s.transaction", "t")
      .select("s.category_id", "key")
      .addSelect("t.currency_code", "currencyCode")
      .addSelect(dateExpr, "txDate")
      .addSelect("COALESCE(SUM(s.amount), 0)", "total")
      .where("t.user_id = :userId", { userId })
      .andWhere("s.category_id IN (:...categoryIds)", { categoryIds })
      .andWhere("t.transaction_date >= :periodStart", { periodStart })
      .andWhere("t.transaction_date <= :periodEnd", { periodEnd })
      .andWhere("t.status != :void", { void: "VOID" });
    const splitRows = await reportingRawMany(
      manager,
      userId,
      excludeBudgetAccounts(splitQb, excludedAccountIds)
        .groupBy("s.category_id")
        .addGroupBy("t.currency_code")
        .addGroupBy("t.transaction_date"),
      basis,
    );
    categoryRows.push(...splitRows);
  }

  if (transferBudgetCategories.length > 0) {
    const window: OutgoingTransferWindow = {
      userId,
      periodStart,
      periodEnd,
      transferAccountIds: transferBudgetCategories.map(
        (bc) => bc.transferAccountId as string,
      ),
      excludedAccountIds,
    };

    transferRows.push(
      ...(await outgoingParentTransfers(transactionsRepository, window)
        .select(PARENT_TRANSFER_DESTINATION, "key")
        .addSelect("t.currency_code", "currencyCode")
        .addSelect(dateExpr, "txDate")
        .addSelect(`COALESCE(ABS(SUM(${PARENT_TRANSFER_AMOUNT})), 0)`, "total")
        .groupBy(PARENT_TRANSFER_DESTINATION)
        .addGroupBy("t.currency_code")
        .addGroupBy("t.transaction_date")
        .getRawMany()),
    );
    transferRows.push(
      ...(await outgoingSplitTransfers(splitsRepository, window)
        .select(SPLIT_TRANSFER_DESTINATION, "key")
        .addSelect("t.currency_code", "currencyCode")
        .addSelect(dateExpr, "txDate")
        .addSelect(`COALESCE(ABS(SUM(${SPLIT_TRANSFER_AMOUNT})), 0)`, "total")
        .groupBy(SPLIT_TRANSFER_DESTINATION)
        .addGroupBy("t.currency_code")
        .addGroupBy("t.transaction_date")
        .getRawMany()),
    );
  }

  const foreignCurrencies = new Set<string>();
  for (const row of [...categoryRows, ...transferRows]) {
    if (row.currencyCode !== currency) foreignCurrencies.add(row.currencyCode);
  }
  const rateIndex = await buildRateIndex(
    (sql, params) => manager.query(sql, params),
    foreignCurrencies,
    currency,
    periodStart,
    periodEnd,
  );

  const fold = (
    rows: SpendingRow[],
  ): { totals: Map<string, FxAggregate>; pairs: Set<string> } => {
    const totals = new Map<string, FxAggregate>();
    const pairs = new Set<string>();
    for (const row of rows) {
      let agg = totals.get(row.key);
      if (!agg) {
        agg = new FxAggregate();
        totals.set(row.key, agg);
      }
      const amount = parseFloat(row.total || "0");
      // Same currency needs no rate, and neither does zero: a foreign group
      // that nets to nothing moves the category by nothing.
      if (row.currencyCode === currency || amount === 0) {
        agg.addConverted(amount);
        continue;
      }
      const converted = convertAtDate(
        amount,
        row.currencyCode,
        currency,
        row.txDate,
        rateIndex,
      );
      agg.add(converted, row.currencyCode, currency);
    }
    for (const agg of totals.values()) {
      for (const pair of agg.missingPairs) pairs.add(pair);
    }
    return { totals, pairs };
  };

  const categories = fold(categoryRows);
  for (const [key, agg] of categories.totals) {
    spendingMap.set(key, agg.knownSubtotal);
    if (!agg.isComplete) incompleteCategoryIds.add(key);
  }
  const transfers = fold(transferRows);
  for (const [key, agg] of transfers.totals) {
    transferSpendingMap.set(key, agg.knownSubtotal);
    if (!agg.isComplete) incompleteTransferAccountIds.add(key);
  }

  return {
    spendingMap,
    transferSpendingMap,
    currency,
    incompleteCategoryIds,
    incompleteTransferAccountIds,
    missingRatePairs: [
      ...new Set([...categories.pairs, ...transfers.pairs]),
    ].sort(),
  };
}

/** Resolves the display name for a budget category. */
export function resolveCategoryName(bc: BudgetCategory): string {
  if (bc.isTransfer && bc.transferAccountId) {
    return bc.transferAccount?.name || "Transfer";
  }
  const cat = bc.category;
  return cat
    ? cat.parent
      ? `${cat.parent.name}: ${cat.name}`
      : cat.name
    : "Uncategorized";
}

/**
 * Resolves the actual spent/earned amount for a budget category from the
 * spending maps.  The maps now contain signed net sums (expenses negative,
 * income positive).  We convert to a non-negative "spent" / "earned" value:
 *   - Expense categories: negate the sum so spending is positive, clamp to 0
 *     when refunds exceed spending.
 *   - Income categories: keep the positive sum, clamp to 0 when deductions
 *     exceed income.
 *   - Transfers: already filtered to outgoing (amount < 0), returned as a
 *     positive value by the query.
 *
 * The figure is the KNOWN converted part: a row with no exchange rate is not in
 * it. A caller that can show "unknown" uses `resolveCategorySpentOrNull`.
 */
export function resolveCategorySpent(
  bc: BudgetCategory,
  spendingMap: Map<string, number>,
  transferSpendingMap: Map<string, number>,
): number {
  if (bc.isTransfer && bc.transferAccountId) {
    return transferSpendingMap.get(bc.transferAccountId) || 0;
  }
  const raw = bc.categoryId ? spendingMap.get(bc.categoryId) || 0 : 0;
  return bc.isIncome ? Math.max(raw, 0) : Math.max(-raw, 0);
}

/**
 * `resolveCategorySpent` for a caller that can show "unknown": `null` when a
 * row of this line had no rate to the budget currency (a partial sum is not the
 * line's spent), otherwise the same clamped value.
 */
export function resolveCategorySpentOrNull(
  bc: BudgetCategory,
  spending: CategorySpending,
): number | null {
  const incomplete =
    bc.isTransfer && bc.transferAccountId
      ? spending.incompleteTransferAccountIds.has(bc.transferAccountId)
      : bc.categoryId !== null &&
        spending.incompleteCategoryIds.has(bc.categoryId);
  if (incomplete) return null;
  return resolveCategorySpent(
    bc,
    spending.spendingMap,
    spending.transferSpendingMap,
  );
}
