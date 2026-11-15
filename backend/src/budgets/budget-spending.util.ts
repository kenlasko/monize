import { ObjectLiteral, Repository, SelectQueryBuilder } from "typeorm";
import { Transaction } from "../transactions/entities/transaction.entity";
import { TransactionSplit } from "../transactions/entities/transaction-split.entity";
import { BudgetCategory } from "./entities/budget-category.entity";
import { FxAggregate } from "../common/fx-aggregate";
import { roundMoney, sumMoney } from "../common/round.util";
import { buildRateIndex } from "../common/time-series/rate-index.util";
import {
  convertRateBasis,
  toOwnRate,
} from "../built-in-reports/report-currency.service";
import {
  partRateBasis,
  splitByRateBasis,
} from "../built-in-reports/rate-basis-parts";

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

/**
 * The transfers a transfer income line (or `config.transfersInAsIncome`)
 * counts, issue #2141 (`docs/specs/budget-transfer-income.md`): the legs in a
 * budget account whose counterpart is a source account, both shapes as above.
 * Unlike the outgoing builders these keep both directions, so the signed sum
 * is the net change: money in from the source is positive, money from a budget
 * account back to it negative. The source's own leg is never read, since its
 * counterpart is the budget account and not itself.
 */
export interface IncomingTransferWindow {
  userId: string;
  periodStart: string;
  periodEnd: string;
  /** Restrict to these source accounts; omit to sweep every source. */
  sourceAccountIds?: string[];
  /** The budget's excluded accounts: a leg in one is not the budget's. */
  excludedAccountIds?: readonly string[];
}

/** Source account of a whole-row transfer (incoming parent builder alias). */
export const PARENT_TRANSFER_SOURCE = "lt.account_id";
/** Source account of a split-line transfer (incoming split builder alias). */
export const SPLIT_TRANSFER_SOURCE = "s.transfer_account_id";

export function incomingParentTransfers(
  repository: Repository<Transaction>,
  window: IncomingTransferWindow,
): SelectQueryBuilder<Transaction> {
  const qb = repository
    .createQueryBuilder("t")
    .innerJoin("t.linkedTransaction", "lt")
    .where("t.user_id = :userId", { userId: window.userId })
    .andWhere("t.is_transfer = true")
    .andWhere("t.transaction_date >= :periodStart", {
      periodStart: window.periodStart,
    })
    .andWhere("t.transaction_date <= :periodEnd", {
      periodEnd: window.periodEnd,
    })
    .andWhere("t.status != :void", { void: "VOID" });
  if (window.sourceAccountIds) {
    qb.andWhere("lt.account_id IN (:...sourceAccountIds)", {
      sourceAccountIds: window.sourceAccountIds,
    });
  }
  return excludeBudgetAccounts(qb, window.excludedAccountIds ?? []);
}

export function incomingSplitTransfers(
  repository: Repository<TransactionSplit>,
  window: IncomingTransferWindow,
): SelectQueryBuilder<TransactionSplit> {
  const qb = repository
    .createQueryBuilder("s")
    .innerJoin("s.transaction", "t")
    .where("t.user_id = :userId", { userId: window.userId })
    .andWhere("t.transaction_date >= :periodStart", {
      periodStart: window.periodStart,
    })
    .andWhere("t.transaction_date <= :periodEnd", {
      periodEnd: window.periodEnd,
    })
    .andWhere("t.status != :void", { void: "VOID" });
  if (window.sourceAccountIds) {
    qb.andWhere("s.transfer_account_id IN (:...sourceAccountIds)", {
      sourceAccountIds: window.sourceAccountIds,
    });
  } else {
    qb.andWhere("s.transfer_account_id IS NOT NULL");
  }
  return excludeBudgetAccounts(qb, window.excludedAccountIds ?? []);
}

/**
 * Whether the budget counts transfers in from its excluded accounts as income
 * (`config.transfersInAsIncome`, issue #2141). `config` is a JSONB column the
 * client writes, so anything but `true` reads as off.
 */
export function budgetTransfersInAsIncome(config: unknown): boolean {
  if (config === null || typeof config !== "object") return false;
  return (
    (config as { transfersInAsIncome?: unknown }).transfersInAsIncome === true
  );
}

/** A transfer line of either direction: it names `transferAccountId`. */
function isTransferLine(bc: BudgetCategory): boolean {
  return bc.isTransfer && bc.transferAccountId !== null;
}

/** A transfer income line: money arriving from `transferAccountId`. */
export function isTransferIncomeLine(bc: BudgetCategory): boolean {
  return isTransferLine(bc) && bc.isIncome;
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
  /**
   * source accountId -> signed net of the transfers in from it, of the rows
   * that converted (transfer income lines only).
   */
  transferIncomeMap: Map<string, number>;
  /** Transfer income sources with a row that had no rate. */
  incompleteTransferIncomeAccountIds: ReadonlySet<string>;
  /**
   * Signed net of the transfers in from the excluded accounts no transfer line
   * names, when `config.transfersInAsIncome` is on; `0` when it is off.
   */
  outsideTransferIncome: number;
  /** `false` when a row of `outsideTransferIncome` had no rate. */
  outsideTransferIncomeComplete: boolean;
  /** `"JPY->CAD"` for each pair with no admissible rate, sorted. */
  missingRatePairs: string[];
}

interface SpendingRow {
  key: string;
  currencyCode: string;
  txDate: string;
  total: string | null;
  /** The row's own rate columns (`splitByRateBasis`). */
  fx_original_currency?: string | null;
  fx_exchange_rate?: string | null;
  fx_transfer_rate?: string | null;
}

/**
 * The own-rate columns of a read's `t` alias. A transfer read takes the
 * magnitude of each group's sum, which the split leaves whole: it reads only
 * outgoing legs (`amount < 0`), so every part of a group has one sign.
 */
const OWN_RATE_COLUMNS = {
  currency: "t.currency_code",
  originalCurrency: "t.original_currency_code",
  exchangeRate: "t.exchange_rate",
};

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
  budgetId?: string,
): Promise<CategorySpending> {
  const { currency, buckets } = await queryCategorySpendingBuckets(
    transactionsRepository,
    splitsRepository,
    userId,
    budgetCategories,
    periodStart,
    periodEnd,
    () => "",
    budgetId,
  );
  return buckets.get("") ?? emptyCategorySpending(currency);
}

export function emptyCategorySpending(currency: string): CategorySpending & {
  incompleteCategoryIds: Set<string>;
  incompleteTransferAccountIds: Set<string>;
  incompleteTransferIncomeAccountIds: Set<string>;
} {
  return {
    spendingMap: new Map(),
    transferSpendingMap: new Map(),
    currency,
    incompleteCategoryIds: new Set(),
    incompleteTransferAccountIds: new Set(),
    transferIncomeMap: new Map(),
    incompleteTransferIncomeAccountIds: new Set(),
    outsideTransferIncome: 0,
    outsideTransferIncomeComplete: true,
    missingRatePairs: [],
  };
}

/**
 * `queryCategorySpending` over one range, with the figures kept apart per
 * bucket: `bucketOf(txDate)` names the bucket (a day, a month) of each
 * date-grouped row. Netting, conversion at the row's own date, excluded
 * accounts and missing-rate reporting are the single-range ones, applied inside
 * each bucket. A bucket with no row is absent.
 *
 * `budgetId` names the budget when `budgetCategories` may be empty: a budget
 * with no line can still count `config.transfersInAsIncome` (issue #2141).
 * Without it, the budget is the one its first line belongs to.
 */
export async function queryCategorySpendingBuckets(
  transactionsRepository: Repository<Transaction>,
  splitsRepository: Repository<TransactionSplit>,
  userId: string,
  budgetCategories: BudgetCategory[],
  periodStart: string,
  periodEnd: string,
  bucketOf: (txDate: string) => string,
  budgetId: string | undefined = budgetCategories[0]?.budgetId,
): Promise<{ currency: string; buckets: Map<string, CategorySpending> }> {
  const buckets = new Map<string, CategorySpending>();

  // No budget, no amount to convert and no currency to name.
  if (budgetId === undefined) return { currency: "", buckets };

  const manager = transactionsRepository.manager;
  // The budget's own transfer lines come with it: a caller passing a subset
  // of lines (the savings rate leaves out the outgoing ones) must not widen
  // what `config.transfersInAsIncome` sweeps (issue #2141).
  const budgetRows: Array<{
    currency_code: string;
    config: unknown;
    transfer_account_ids?: string[] | null;
  }> = await manager.query(
    `SELECT b.currency_code, b.config,
            ARRAY(
              SELECT bc.transfer_account_id::text FROM budget_categories bc
              WHERE bc.budget_id = b.id AND bc.is_transfer = true
                AND bc.transfer_account_id IS NOT NULL
            ) AS transfer_account_ids
       FROM budgets b WHERE b.id = $1`,
    [budgetId],
  );
  const currency = budgetRows[0]?.currency_code ?? "";
  // Read from the budget row itself, so no caller can forget to pass them.
  const excludedAccountIds = budgetExcludedAccountIds(budgetRows[0]?.config);

  const categoryIds = budgetCategories
    .filter((bc) => bc.categoryId !== null)
    .map((bc) => bc.categoryId as string);
  const transferBudgetCategories = budgetCategories.filter(
    (bc) => isTransferLine(bc) && !bc.isIncome,
  );
  const transferIncomeSources = budgetCategories
    .filter(isTransferIncomeLine)
    .map((bc) => bc.transferAccountId as string);
  // The toggle counts every excluded account a transfer line does not already
  // name: that line counts it, once (spec section 2).
  const namedTransferAccounts = new Set([
    ...budgetCategories
      .filter(isTransferLine)
      .map((bc) => bc.transferAccountId as string),
    ...(budgetRows[0]?.transfer_account_ids ?? []),
  ]);
  const outsideSources = new Set(
    budgetTransfersInAsIncome(budgetRows[0]?.config)
      ? excludedAccountIds.filter((id) => !namedTransferAccounts.has(id))
      : [],
  );

  // Every query groups by currency and transaction date as well as by key, so
  // each group is one currency on one day and converts at one rate.
  const dateExpr = "TO_CHAR(t.transaction_date, 'YYYY-MM-DD')";
  const categoryRows: SpendingRow[] = [];
  const transferRows: SpendingRow[] = [];
  const incomeTransferRows: SpendingRow[] = [];

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
    excludeBudgetAccounts(directQb, excludedAccountIds)
      .groupBy("t.category_id")
      .addGroupBy("t.currency_code")
      .addGroupBy("t.transaction_date");
    splitByRateBasis(directQb, OWN_RATE_COLUMNS, currency, { byDay: false });
    const directRows = await directQb.getRawMany();
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
    excludeBudgetAccounts(splitQb, excludedAccountIds)
      .groupBy("s.category_id")
      .addGroupBy("t.currency_code")
      .addGroupBy("t.transaction_date");
    splitByRateBasis(splitQb, OWN_RATE_COLUMNS, currency, { byDay: false });
    const splitRows = await splitQb.getRawMany();
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

    const parentQb = outgoingParentTransfers(transactionsRepository, window)
      .select(PARENT_TRANSFER_DESTINATION, "key")
      .addSelect("t.currency_code", "currencyCode")
      .addSelect(dateExpr, "txDate")
      .addSelect(`COALESCE(ABS(SUM(${PARENT_TRANSFER_AMOUNT})), 0)`, "total")
      .groupBy(PARENT_TRANSFER_DESTINATION)
      .addGroupBy("t.currency_code")
      .addGroupBy("t.transaction_date");
    // A transfer leg converts at the amounts its transfer moved, as in the
    // reports (`transferRateSql`).
    splitByRateBasis(
      parentQb,
      { ...OWN_RATE_COLUMNS, transferLegs: { transactionAlias: "t" } },
      currency,
      { byDay: false },
    );
    transferRows.push(...(await parentQb.getRawMany()));
    const splitTransferQb = outgoingSplitTransfers(splitsRepository, window)
      .select(SPLIT_TRANSFER_DESTINATION, "key")
      .addSelect("t.currency_code", "currencyCode")
      .addSelect(dateExpr, "txDate")
      .addSelect(`COALESCE(ABS(SUM(${SPLIT_TRANSFER_AMOUNT})), 0)`, "total")
      .groupBy(SPLIT_TRANSFER_DESTINATION)
      .addGroupBy("t.currency_code")
      .addGroupBy("t.transaction_date");
    splitByRateBasis(
      splitTransferQb,
      {
        ...OWN_RATE_COLUMNS,
        transferLegs: { transactionAlias: "t", splitAlias: "s" },
      },
      currency,
      { byDay: false },
    );
    transferRows.push(...(await splitTransferQb.getRawMany()));
  }

  const incomeSources = [...new Set(transferIncomeSources), ...outsideSources];
  if (incomeSources.length > 0) {
    const window: IncomingTransferWindow = {
      userId,
      periodStart,
      periodEnd,
      sourceAccountIds: incomeSources,
      excludedAccountIds,
    };
    // Signed sums: the net change of each source (spec section 2).
    const parentQb = incomingParentTransfers(transactionsRepository, window)
      .select(PARENT_TRANSFER_SOURCE, "key")
      .addSelect("t.currency_code", "currencyCode")
      .addSelect(dateExpr, "txDate")
      .addSelect(`COALESCE(SUM(${PARENT_TRANSFER_AMOUNT}), 0)`, "total")
      .groupBy(PARENT_TRANSFER_SOURCE)
      .addGroupBy("t.currency_code")
      .addGroupBy("t.transaction_date");
    splitByRateBasis(
      parentQb,
      { ...OWN_RATE_COLUMNS, transferLegs: { transactionAlias: "t" } },
      currency,
      { byDay: false },
    );
    incomeTransferRows.push(...(await parentQb.getRawMany()));
    const splitQb = incomingSplitTransfers(splitsRepository, window)
      .select(SPLIT_TRANSFER_SOURCE, "key")
      .addSelect("t.currency_code", "currencyCode")
      .addSelect(dateExpr, "txDate")
      .addSelect(`COALESCE(SUM(${SPLIT_TRANSFER_AMOUNT}), 0)`, "total")
      .groupBy(SPLIT_TRANSFER_SOURCE)
      .addGroupBy("t.currency_code")
      .addGroupBy("t.transaction_date");
    splitByRateBasis(
      splitQb,
      {
        ...OWN_RATE_COLUMNS,
        transferLegs: { transactionAlias: "t", splitAlias: "s" },
      },
      currency,
      { byDay: false },
    );
    incomeTransferRows.push(...(await splitQb.getRawMany()));
  }

  // A row the market rate converts needs the history; one that settled into
  // the budget's currency at its own rate does not.
  const basisOf = (row: SpendingRow) =>
    partRateBasis(row, row.currencyCode, row.txDate, currency);
  const foreignCurrencies = new Set<string>();
  for (const row of [...categoryRows, ...transferRows, ...incomeTransferRows]) {
    if (row.currencyCode === currency) continue;
    if (toOwnRate(basisOf(row).own_rate) === null) {
      foreignCurrencies.add(row.currencyCode);
    }
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
      // Its own settled rate where it reaches the budget's currency
      // (INV-FX-002), else the market rate on its date: the reports' rule.
      const converted = convertRateBasis(
        amount,
        basisOf(row),
        currency,
        rateIndex,
      );
      agg.add(converted, row.currencyCode, currency);
    }
    for (const agg of totals.values()) {
      for (const pair of agg.missingPairs) pairs.add(pair);
    }
    return { totals, pairs };
  };

  // One pass per row set, so the work is O(rows), not O(buckets x rows).
  const groupByBucket = (rows: SpendingRow[]): Map<string, SpendingRow[]> => {
    const grouped = new Map<string, SpendingRow[]>();
    for (const row of rows) {
      const key = bucketOf(row.txDate);
      const list = grouped.get(key);
      if (list) list.push(row);
      else grouped.set(key, [row]);
    }
    return grouped;
  };
  const categoryByBucket = groupByBucket(categoryRows);
  const transferByBucket = groupByBucket(transferRows);
  // A source both a line names and the toggle sweeps cannot exist (the toggle
  // leaves out every named account), so each row is one or the other.
  const lineIncomeByBucket = groupByBucket(
    incomeTransferRows.filter((row) => !outsideSources.has(row.key)),
  );
  const outsideIncomeByBucket = groupByBucket(
    incomeTransferRows
      .filter((row) => outsideSources.has(row.key))
      .map((row) => ({ ...row, key: "" })),
  );
  const bucketKeys = new Set([
    ...categoryByBucket.keys(),
    ...transferByBucket.keys(),
    ...lineIncomeByBucket.keys(),
    ...outsideIncomeByBucket.keys(),
  ]);
  for (const bucket of bucketKeys) {
    const spending = emptyCategorySpending(currency);
    const categories = fold(categoryByBucket.get(bucket) ?? []);
    for (const [key, agg] of categories.totals) {
      spending.spendingMap.set(key, agg.knownSubtotal);
      if (!agg.isComplete) spending.incompleteCategoryIds.add(key);
    }
    const transfers = fold(transferByBucket.get(bucket) ?? []);
    for (const [key, agg] of transfers.totals) {
      spending.transferSpendingMap.set(key, agg.knownSubtotal);
      if (!agg.isComplete) spending.incompleteTransferAccountIds.add(key);
    }
    const lineIncome = fold(lineIncomeByBucket.get(bucket) ?? []);
    for (const [key, agg] of lineIncome.totals) {
      spending.transferIncomeMap.set(key, agg.knownSubtotal);
      if (!agg.isComplete) spending.incompleteTransferIncomeAccountIds.add(key);
    }
    const outsideIncome = fold(outsideIncomeByBucket.get(bucket) ?? []);
    const outsideAgg = outsideIncome.totals.get("");
    if (outsideAgg) {
      spending.outsideTransferIncome = outsideAgg.knownSubtotal;
      spending.outsideTransferIncomeComplete = outsideAgg.isComplete;
    }
    spending.missingRatePairs = [
      ...new Set([
        ...categories.pairs,
        ...transfers.pairs,
        ...lineIncome.pairs,
        ...outsideIncome.pairs,
      ]),
    ].sort();
    buckets.set(bucket, spending);
  }

  return { currency, buckets };
}

/**
 * A budget's actual income from its spending maps: the signed net of its
 * income lines, converted into the budget's currency by `queryCategorySpending`
 * and clamped at zero as a whole, so a deduction in one income category nets
 * against another's pay. Each category counts once however many lines name
 * it. The figure is the KNOWN converted part (`incompleteCategoryIds` names an
 * income line with a row that had no rate); before issue #2155 it was a sum of
 * raw amounts in whatever currency each row was in.
 *
 * Transfer income lines and `config.transfersInAsIncome` net into it the same
 * way (issue #2141).
 */
export function resolveBudgetIncome(
  budgetCategories: readonly BudgetCategory[],
  spending: Pick<
    CategorySpending,
    "spendingMap" | "transferIncomeMap" | "outsideTransferIncome"
  >,
): number {
  const incomeCategoryIds = new Set(
    budgetCategories
      .filter((bc) => bc.isIncome && !bc.isTransfer && bc.categoryId !== null)
      .map((bc) => bc.categoryId as string),
  );
  const incomeSources = new Set(
    budgetCategories
      .filter(isTransferIncomeLine)
      .map((bc) => bc.transferAccountId as string),
  );
  return Math.max(
    sumMoney([
      ...[...incomeCategoryIds].map((id) => spending.spendingMap.get(id) ?? 0),
      ...[...incomeSources].map(
        (id) => spending.transferIncomeMap.get(id) ?? 0,
      ),
      spending.outsideTransferIncome,
    ]),
    0,
  );
}

/**
 * The income `config.transfersInAsIncome` adds, as a line reads it: the net
 * change clamped at zero, like an income line's actual (issue #2141).
 */
export function resolveOutsideTransferIncome(
  spending: Pick<CategorySpending, "outsideTransferIncome">,
): number {
  return Math.max(spending.outsideTransferIncome, 0);
}

/**
 * A line's budgeted amount for a period: its own `amount`, except an expense
 * line of an income-linked budget, whose `amount` is a percentage of the
 * period's income (`resolveBudgetIncome`). The live summary
 * (`BudgetsService.getSummary`) and the period close's bucket snapshot both
 * read it here, so a bucket's `planned` is the same figure on both.
 */
export function resolveBudgetLineBudgeted(
  bc: Pick<BudgetCategory, "amount" | "isIncome">,
  incomeLinked: boolean,
  linkedIncome: number,
): number {
  const rawAmount = Number(bc.amount);
  return incomeLinked && !bc.isIncome
    ? roundMoney((linkedIncome * rawAmount) / 100)
    : rawAmount;
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
 *   - Transfer income lines: the signed net in from the source, clamped to 0
 *     when more went back to it than came out (issue #2141).
 *
 * The figure is the KNOWN converted part: a row with no exchange rate is not in
 * it. A caller that can show "unknown" uses `resolveCategorySpentOrNull`.
 */
export function resolveCategorySpent(
  bc: BudgetCategory,
  spendingMap: Map<string, number>,
  transferSpendingMap: Map<string, number>,
  transferIncomeMap: Map<string, number>,
): number {
  if (isTransferIncomeLine(bc)) {
    return Math.max(
      transferIncomeMap.get(bc.transferAccountId as string) ?? 0,
      0,
    );
  }
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
  const incomplete = isTransferIncomeLine(bc)
    ? spending.incompleteTransferIncomeAccountIds.has(
        bc.transferAccountId as string,
      )
    : bc.isTransfer && bc.transferAccountId
      ? spending.incompleteTransferAccountIds.has(bc.transferAccountId)
      : bc.categoryId !== null &&
        spending.incompleteCategoryIds.has(bc.categoryId);
  if (incomplete) return null;
  return resolveCategorySpent(
    bc,
    spending.spendingMap,
    spending.transferSpendingMap,
    spending.transferIncomeMap,
  );
}
