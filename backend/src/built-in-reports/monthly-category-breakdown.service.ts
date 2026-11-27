import { Injectable } from "@nestjs/common";
import { isIncomeCategory } from "../categories/category-type.util";
import { DataSource } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { Category } from "../categories/entities/category.entity";
import {
  ConversionGaps,
  RATE_BASIS_GROUP_BY,
  RawRateBasis,
  ReportCurrencyService,
  wholeGroups,
  rateBasisColumnsSql,
} from "./report-currency.service";
import { ownTransferLegs } from "./transfer-rate-sql";
import { MONEY_SCALE, toMoneyNumber } from "../common/round.util";
import { FxAggregate } from "../common/fx-aggregate";
import {
  MonthlyCategoryBreakdownResponse,
  MonthlyBreakdownCategoryRow,
  MonthlyBreakdownTransferRow,
} from "./dto";
import { investmentExclusionSql } from "../common/investment-filter.util";
import {
  breakdownRowFigures,
  breakdownTotals,
  BreakdownTransferFlows,
  sectionKeyOf,
} from "./monthly-category-breakdown-totals";

/** The breakdown's column width: one calendar month or one calendar year. */
export type BreakdownPeriod = "month" | "year";

/**
 * Investment scope is LINKAGE, never account type (INV-REPORT-001, issue #1257):
 * the cash sleeve of an INVESTMENT account holds ordinary money, while the cash
 * leg a trade generated is not spending or income. Both halves of the predicate,
 * and why the account type cannot express either, live in
 * `common/investment-filter.util.ts`.
 */
const INVESTMENT_EXCLUSION = investmentExclusionSql({
  accountAlias: "a",
  transactionAlias: "t",
  splitAlias: "ts",
});

/**
 * Raw per-(category, month, currency) aggregate. Deposits and withdrawals are
 * summed separately so the frontend can classify a category as income vs
 * expense and render a signed net value per month.
 */
interface RawBreakdownAggregate extends RawRateBasis {
  month: string;
  category_id: string | null;
  deposits: string;
  withdrawals: string;
}

/**
 * Raw per-(account, month, currency) transfer aggregate. Outflows and inflows
 * are summed separately so each account can be split into a "from" row
 * (outflows, a source of funds) and a "to" row (inflows, a use of funds).
 */
interface RawTransferAggregate extends RawRateBasis {
  month: string;
  account_id: string;
  account_name: string;
  outflow: string;
  inflow: string;
  /** The leg's category when it is a Transfer category, else null. */
  transfer_category_id: string | null;
  /** The group's provisional legs (`amount_is_provisional`). */
  provisional_count: string;
}

/** Who a transfer row is: an account, or a Transfer category. */
type TransferRowTarget = Omit<
  MonthlyBreakdownTransferRow,
  "direction" | "valuesByMonth" | "total" | "average"
>;

/** One transfer row's flows per column, unsigned, before its direction. */
interface FlowEntry {
  target: TransferRowTarget;
  valuesByMonth: Map<string, FxAggregate>;
}

function accountTarget(
  accountId: string,
  accountName: string,
): TransferRowTarget {
  return {
    kind: "account",
    accountId,
    accountName,
    categoryId: null,
    categoryName: null,
    parentId: null,
    parentName: null,
    isSubtotal: false,
  };
}

function transferCategoryTarget(
  category: Category,
  categoryMap: ReadonlyMap<string, Category>,
  isSubtotal = false,
): TransferRowTarget {
  const parent = category.parentId
    ? (categoryMap.get(category.parentId) ?? null)
    : null;
  return {
    kind: "category",
    accountId: null,
    accountName: null,
    categoryId: category.id,
    categoryName: category.name,
    parentId: parent?.id ?? null,
    parentName: parent?.name ?? null,
    isSubtotal,
  };
}

/** The key a target accumulates under; a subtotal never meets its own row. */
function targetKey(target: TransferRowTarget): string {
  if (target.kind === "account") return `account|${target.accountId}`;
  return `${target.isSubtotal ? "subtotal" : "category"}|${target.categoryId}`;
}

function addFlow(
  store: Map<string, FlowEntry>,
  target: TransferRowTarget,
  month: string,
  amount: FxAggregate | number,
): void {
  const key = targetKey(target);
  let entry = store.get(key);
  if (!entry) {
    entry = { target, valuesByMonth: new Map() };
    store.set(key, entry);
  }
  const sum = entry.valuesByMonth.get(month) ?? new FxAggregate();
  if (typeof amount === "number") sum.addConverted(amount);
  else sum.merge(amount);
  entry.valuesByMonth.set(month, sum);
}

/**
 * Each parent Transfer category's roll-up of the category rows in `store`: the
 * parent's own legs and every descendant's, one row per ancestor of a category
 * row (a category with only its own legs needs none).
 */
function parentSubtotals(
  store: ReadonlyMap<string, FlowEntry>,
  categoryMap: ReadonlyMap<string, Category>,
): Map<string, FlowEntry> {
  const subtotals = new Map<string, FlowEntry>();
  const rows = [...store.values()].filter((e) => e.target.kind === "category");
  const ancestorsOf = (categoryId: string): Category[] => {
    const chain: Category[] = [];
    const seen = new Set<string>([categoryId]);
    let parentId = categoryMap.get(categoryId)?.parentId ?? null;
    while (parentId && !seen.has(parentId)) {
      const parent = categoryMap.get(parentId);
      if (!parent) break;
      chain.push(parent);
      seen.add(parentId);
      parentId = parent.parentId ?? null;
    }
    return chain;
  };
  const withChildren = new Set(
    rows.flatMap((e) => ancestorsOf(e.target.categoryId!).map((c) => c.id)),
  );
  for (const e of rows) {
    const id = e.target.categoryId!;
    // A parent's own legs are in its roll-up; its ancestors' roll-ups too.
    const into = [
      ...(withChildren.has(id) ? [categoryMap.get(id)!] : []),
      ...ancestorsOf(id),
    ];
    for (const ancestor of into) {
      const target = transferCategoryTarget(ancestor, categoryMap, true);
      for (const [month, sum] of e.valuesByMonth) {
        addFlow(subtotals, target, month, sum);
      }
    }
  }
  return subtotals;
}

/** Adds `amount` to `month`'s aggregate in `byMonth`. */
function addTo(
  byMonth: Map<string, FxAggregate>,
  month: string,
  amount: number,
): void {
  const sum = byMonth.get(month) ?? new FxAggregate();
  sum.addConverted(amount);
  byMonth.set(month, sum);
}

/**
 * Mutable accumulator for a single category while merging the raw rows. Money
 * is accumulated in `FxAggregate`s, never added in floats, and each figure is
 * read once when the row is built, so the response is the single rounding of
 * the converted rows (docs/specs/report-rounding-and-aggregation.md rule 2).
 */
interface CategoryAccumulator {
  categoryId: string | null;
  depositByMonth: Map<string, FxAggregate>;
  withdrawalByMonth: Map<string, FxAggregate>;
  depositTotal: FxAggregate;
  withdrawalTotal: FxAggregate;
}

@Injectable()
export class MonthlyCategoryBreakdownService {
  constructor(
    private dataSource: DataSource,
    private currencyService: ReportCurrencyService,
  ) {}

  async getMonthlyCategoryBreakdown(
    userId: string,
    startDate: string | undefined,
    endDate: string,
    options: { accountIds?: string[]; period?: BreakdownPeriod } = {},
  ): Promise<MonthlyCategoryBreakdownResponse> {
    const { accountIds, period = "month" } = options;
    // The column a `YYYY-MM` month falls in. A year folds its months'
    // aggregates before it is read, so a yearly cell is one rounding of its
    // rows, never the sum of twelve monthly readings.
    const columnOf = (month: string): string =>
      period === "year" ? month.slice(0, 4) : month;
    const defaultCurrency =
      await this.currencyService.getDefaultCurrency(userId);
    // Every figure leaves rounded once at the reporting currency's places
    // (docs/specs/report-rounding-and-aggregation.md section 6).
    const places = await this.currencyService.getReportPlaces(defaultCurrency);

    // Aggregate deposits (amount > 0) and withdrawals (amount < 0) per
    // category, month and currency. Transfers, voided rows, child rows of a
    // split, investment MOVEMENTS (the securities sleeve, a trade's generated
    // cash leg, an embedded investment split line -- never an account's type)
    // and the synthetic asset-value-change category are excluded -- mirroring
    // the other category reports.
    let query = `
      SELECT
        TO_CHAR(t.transaction_date, 'YYYY-MM') as month,
        COALESCE(ts.category_id, t.category_id) as category_id,
        t.currency_code,
        ${rateBasisColumnsSql("$3")},
        SUM(CASE WHEN COALESCE(ts.amount, t.amount) > 0
              THEN COALESCE(ts.amount, t.amount) ELSE 0 END) as deposits,
        SUM(CASE WHEN COALESCE(ts.amount, t.amount) < 0
              THEN ABS(COALESCE(ts.amount, t.amount)) ELSE 0 END) as withdrawals
      FROM transactions t
      LEFT JOIN transaction_splits ts ON ts.transaction_id = t.id
      LEFT JOIN accounts a ON a.id = t.account_id
      WHERE t.user_id = $1
        AND t.transaction_date <= $2
        -- A transfer leg is never income or expense (INV-REPORT-003), even when
        -- it carries a category: it is reported only as a named flow by the
        -- transfer rollup below.
        AND t.is_transfer = false
        AND (t.status IS NULL OR t.status != 'VOID')
        AND t.parent_transaction_id IS NULL
        AND ${INVESTMENT_EXCLUSION}
        AND (ts.transfer_account_id IS NULL OR ts.id IS NULL)
        AND NOT EXISTS (
          SELECT 1 FROM accounts ax
          WHERE ax.user_id = t.user_id
            AND ax.asset_category_id IS NOT NULL
            AND ax.asset_category_id = COALESCE(ts.category_id, t.category_id)
        )
    `;

    const params: (string | string[] | undefined)[] = [
      userId,
      endDate,
      defaultCurrency,
    ];

    if (startDate) {
      query += ` AND t.transaction_date >= $4`;
      params.push(startDate);
    }

    // An empty selection is "every account", like every other report filter.
    if (accountIds && accountIds.length > 0) {
      query += ` AND t.account_id = ANY($${params.length + 1}::uuid[])`;
      params.push(accountIds);
    }

    query += `
      GROUP BY TO_CHAR(t.transaction_date, 'YYYY-MM'),
               COALESCE(ts.category_id, t.category_id), t.currency_code,
               ${RATE_BASIS_GROUP_BY}
      ORDER BY month
    `;

    const rawResults: RawBreakdownAggregate[] = await withScopedDb(
      this.dataSource,
      (m) => m.query(query, params),
    );

    const categories = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Category).find({
        where: { userId },
      }),
    );
    const categoryMap = new Map(categories.map((c) => [c.id, c]));
    const convert = wholeGroups(
      rawResults,
      await this.currencyService.buildConverter(rawResults, defaultCurrency),
      (row) => `${row.month}|${row.category_id ?? ""}|${row.currency_code}`,
      (row) => [
        toMoneyNumber(row.deposits, MONEY_SCALE),
        toMoneyNumber(row.withdrawals, MONEY_SCALE),
      ],
    );

    const accumulators = new Map<string, CategoryAccumulator>();
    const monthSet = new Set<string>();
    // A row with no rate into the reporting currency is unknown, never its
    // unconverted figure (INV-FX-001): it is in no category value, no deposit or
    // withdrawal total, no transfer row and no month, and its currency is named.
    const gaps = new ConversionGaps();

    for (const row of rawResults) {
      const month = row.month;

      const deposits = convert(
        // An aggregate in the row's own currency, read before conversion: a coin's
        // sum keeps its stored 8 places (MONEY_SCALE, lossless; a fiat figure reads
        // the same), so a 2,500-sat total is not rounded to zero before it is
        // converted (INV-MONEY-001).
        toMoneyNumber(row.deposits, MONEY_SCALE),
        row,
      );
      const withdrawals = convert(
        toMoneyNumber(row.withdrawals, MONEY_SCALE),
        row,
      );
      if (deposits === null || withdrawals === null) {
        gaps.record(
          row.currency_code,
          `${month}|${row.category_id ?? ""}|${row.currency_code}`,
        );
        continue;
      }
      const column = columnOf(month);
      monthSet.add(column);

      // Treat an unknown category_id (e.g. the row references a category that
      // no longer exists) the same as no category at all.
      const categoryId =
        row.category_id && categoryMap.has(row.category_id)
          ? row.category_id
          : null;
      const key = categoryId ?? "uncategorized";

      let acc = accumulators.get(key);
      if (!acc) {
        acc = {
          categoryId,
          depositByMonth: new Map(),
          withdrawalByMonth: new Map(),
          depositTotal: new FxAggregate(),
          withdrawalTotal: new FxAggregate(),
        };
        accumulators.set(key, acc);
      }

      // Accumulated, never added in floats, and rounded once when the row is
      // built (docs/specs/report-rounding-and-aggregation.md rule 2).
      addTo(acc.depositByMonth, column, deposits);
      addTo(acc.withdrawalByMonth, column, withdrawals);
      acc.depositTotal.addConverted(deposits);
      acc.withdrawalTotal.addConverted(withdrawals);
    }

    const {
      rows: transferRows,
      subtotals: transferSubtotals,
      provisionalCount,
    } = await this.getTransferRows(
      userId,
      startDate,
      endDate,
      defaultCurrency,
      places,
      monthSet,
      gaps,
      columnOf,
      categoryMap,
      accountIds,
    );

    const months = Array.from(monthSet).sort();

    const built = Array.from(accumulators.values()).map((acc) =>
      this.buildRow(acc, categoryMap, places),
    );
    // Every total the page shows, from the cells' aggregates (issue #2413).
    const totals = breakdownTotals(
      built.map(({ row, netByColumn }) => ({ row, netByColumn })),
      transferRows.map(({ flows }) => flows),
      months,
      places,
    );
    const data: MonthlyBreakdownCategoryRow[] = built.map(({ row }, i) => ({
      ...row,
      sectionKey: sectionKeyOf(row),
      ...totals.rows[i],
    }));
    const transfers: MonthlyBreakdownTransferRow[] = [
      ...transferRows.map(({ row }, i) => ({ ...row, ...totals.transfers[i] })),
      // A parent's roll-up has its own total, but no part in the group's.
      ...transferSubtotals.map(({ row, flows }) => ({
        ...row,
        ...breakdownRowFigures(flows, months, places),
      })),
    ];

    return {
      period,
      months,
      data,
      transfers,
      sections: totals.sections,
      summary: totals.summary,
      currency: defaultCurrency,
      missingCurrencies: gaps.missingCurrencies,
      excludedCount: gaps.excludedCount,
      provisionalCount,
    };
  }

  /**
   * Aggregate transfers per (account, month) into signed "from"/"to" rows,
   * from whole transfer rows and a split's transfer lines (INV-REPORT-006).
   * Each transfer is stored as two linked legs (a negative leg on the source
   * account and a positive leg on the destination account); grouping every
   * leg by the account it sits on therefore counts each transfer exactly once
   * per side. Outflows become a "from" row (positive, a source of funds) and
   * inflows become a "to" row (negative, a use of funds). Months that contain
   * transfers but no categorised activity are added to the shared month set.
   *
   * A leg holding a Transfer category is counted on that category's row
   * instead of its account's, and a parent Transfer category gets a subtotal
   * row per direction (`docs/specs/transfer-categories.md` section 7). A leg
   * holding an Income or Expense category stays on its account's row, as
   * before. Every leg is on exactly one non-subtotal row, so the group total is
   * what it was.
   */
  private async getTransferRows(
    userId: string,
    startDate: string | undefined,
    endDate: string,
    defaultCurrency: string,
    places: number,
    monthSet: Set<string>,
    gaps: ConversionGaps,
    columnOf: (month: string) => string,
    categoryMap: ReadonlyMap<string, Category>,
    accountIds?: string[],
  ): Promise<{
    rows: {
      row: Omit<MonthlyBreakdownTransferRow, "total" | "average">;
      flows: BreakdownTransferFlows;
    }[];
    /** Parent roll-ups, not part of the group total. */
    subtotals: {
      row: Omit<MonthlyBreakdownTransferRow, "total" | "average">;
      flows: BreakdownTransferFlows;
    }[];
    /** Provisional legs in the groups that converted (design section 8). */
    provisionalCount: number;
  }> {
    const params: (string | string[] | undefined)[] = [
      userId,
      endDate,
      defaultCurrency,
    ];
    let scope = "";
    if (startDate) {
      scope += ` AND t.transaction_date >= $4`;
      params.push(startDate);
    }
    // The same scope as the category rows above: a transfer row is a row of
    // one account, so it is kept or dropped with that account.
    if (accountIds && accountIds.length > 0) {
      scope += ` AND t.account_id = ANY($${params.length + 1}::uuid[])`;
      params.push(accountIds);
    }

    // A whole transfer row, or a split's transfer line (counted on its
    // parent's account, at the line's own amount and rate basis). Only a whole
    // leg can be provisional (design section 6, P5), so a line counts none.
    // The leg's own category decides its row: a whole leg's `t.category_id`,
    // a line's `ts.category_id`.
    const transferCategory = `CASE WHEN tc.category_type = 'transfer' THEN tc.id END`;
    const selectList = (line: boolean) => {
      const amt = line ? "ts.amount" : "t.amount";
      return `
      SELECT
        TO_CHAR(t.transaction_date, 'YYYY-MM') as month,
        t.account_id,
        a.name as account_name,
        ${transferCategory} as transfer_category_id,
        t.currency_code,
        ${rateBasisColumnsSql("$3", "t", ownTransferLegs(userId, "$1", line ? "ts" : undefined))},
        SUM(CASE WHEN ${amt} < 0 THEN ABS(${amt}) ELSE 0 END) as outflow,
        SUM(CASE WHEN ${amt} > 0 THEN ${amt} ELSE 0 END) as inflow,
        ${line ? "0" : "COUNT(*) FILTER (WHERE t.amount_is_provisional = true)"} as provisional_count`;
    };
    const groupBy = `
      GROUP BY TO_CHAR(t.transaction_date, 'YYYY-MM'),
               t.account_id, a.name, ${transferCategory}, t.currency_code,
               ${RATE_BASIS_GROUP_BY}
    `;
    const wholeQuery = `${selectList(false)}
      FROM transactions t
      JOIN accounts a ON a.id = t.account_id
      LEFT JOIN categories tc ON tc.id = t.category_id
      WHERE t.user_id = $1
        AND t.transaction_date <= $2
        AND t.is_transfer = true
        AND (t.status IS NULL OR t.status != 'VOID')
        AND t.parent_transaction_id IS NULL
        ${scope}
      ${groupBy}`;
    const lineQuery = `${selectList(true)}
      FROM transactions t
      JOIN transaction_splits ts ON ts.transaction_id = t.id
      JOIN accounts a ON a.id = t.account_id
      LEFT JOIN categories tc ON tc.id = ts.category_id
      WHERE t.user_id = $1
        AND t.transaction_date <= $2
        AND ts.transfer_account_id IS NOT NULL
        AND (t.status IS NULL OR t.status != 'VOID')
        AND t.parent_transaction_id IS NULL
        AND ${INVESTMENT_EXCLUSION}
        ${scope}
      ${groupBy}`;

    const rawResults: RawTransferAggregate[] = await withScopedDb(
      this.dataSource,
      async (m) => [
        ...(await m.query(wholeQuery, params)),
        ...(await m.query(lineQuery, params)),
      ],
    );
    rawResults.sort((x, y) => x.month.localeCompare(y.month));
    const groupKey = (row: RawTransferAggregate) =>
      `transfer|${row.month}|${row.account_id}|${row.transfer_category_id ?? ""}|${row.currency_code}`;
    const convert = wholeGroups(
      rawResults,
      await this.currencyService.buildConverter(rawResults, defaultCurrency),
      groupKey,
      (row) => [
        toMoneyNumber(row.outflow, MONEY_SCALE),
        toMoneyNumber(row.inflow, MONEY_SCALE),
      ],
    );

    // Accumulate the flow per (row, direction) across currencies. A row is an
    // account or a Transfer category, keyed apart so the two never meet.
    const fromStore = new Map<string, FlowEntry>();
    const toStore = new Map<string, FlowEntry>();

    let provisionalCount = 0;
    for (const row of rawResults) {
      const outflow = convert(toMoneyNumber(row.outflow, MONEY_SCALE), row);
      const inflow = convert(toMoneyNumber(row.inflow, MONEY_SCALE), row);
      if (outflow === null || inflow === null) {
        gaps.record(row.currency_code, groupKey(row));
        continue;
      }
      provisionalCount += Number(row.provisional_count) || 0;
      const column = columnOf(row.month);
      monthSet.add(column);
      // A category the scope cannot see is read as no category: the leg stays
      // on its account's row.
      const category =
        row.transfer_category_id !== null
          ? (categoryMap.get(row.transfer_category_id) ?? null)
          : null;
      const target = category
        ? transferCategoryTarget(category, categoryMap)
        : accountTarget(row.account_id, row.account_name);
      if (outflow !== 0) addFlow(fromStore, target, column, outflow);
      if (inflow !== 0) addFlow(toStore, target, column, inflow);
    }

    // A parent's roll-up per direction: its own legs and its children's,
    // folded from their aggregates (never their readings).
    const fromSubtotals = parentSubtotals(fromStore, categoryMap);
    const toSubtotals = parentSubtotals(toStore, categoryMap);

    const build = (store: Map<string, FlowEntry>, direction: "from" | "to") =>
      Array.from(store.values()).map((entry) => {
        const valuesByMonth: Record<string, number> = {};
        const flows = new Map<string, FxAggregate>();
        for (const [month, amount] of entry.valuesByMonth) {
          // "from" rows are a source of funds (positive); "to" rows are a use
          // of funds (negative).
          const signed =
            direction === "from"
              ? amount
              : FxAggregate.difference(new FxAggregate(), amount);
          flows.set(month, signed);
          valuesByMonth[month] = signed.knownSubtotalAt(places);
        }
        return {
          row: { ...entry.target, direction, valuesByMonth },
          flows,
        };
      });

    const isCategory = (e: FlowEntry) => e.target.kind === "category";
    const pick = (store: Map<string, FlowEntry>, category: boolean) =>
      new Map([...store].filter(([, e]) => isCategory(e) === category));

    return {
      rows: [
        ...build(pick(fromStore, true), "from"),
        ...build(pick(toStore, true), "to"),
        ...build(pick(fromStore, false), "from"),
        ...build(pick(toStore, false), "to"),
      ],
      subtotals: [...build(fromSubtotals, "from"), ...build(toSubtotals, "to")],
      provisionalCount,
    };
  }

  /**
   * Convert one accumulator into a response row. A category is income when its
   * own isIncome flag says so (falling back to deposits-dominate only for
   * uncategorized rows that have no category record); the per-month value is
   * the signed net in that direction (positive magnitude either way) so the
   * frontend can render and sum it without re-deciding the sign.
   */
  private buildRow(
    acc: CategoryAccumulator,
    categoryMap: Map<string, Category>,
    places: number,
  ): {
    row: Omit<MonthlyBreakdownCategoryRow, "sectionKey" | "total" | "average">;
    /** Deposits less withdrawals per column, for the totals. */
    netByColumn: Map<string, FxAggregate>;
  } {
    const category = acc.categoryId
      ? (categoryMap.get(acc.categoryId) ?? null)
      : null;
    const parent = category?.parentId
      ? (categoryMap.get(category.parentId) ?? null)
      : null;

    const isIncome = category
      ? isIncomeCategory(category)
      : FxAggregate.difference(acc.depositTotal, acc.withdrawalTotal).sign > 0;

    const valuesByMonth: Record<string, number> = {};
    const allMonths = new Set<string>([
      ...acc.depositByMonth.keys(),
      ...acc.withdrawalByMonth.keys(),
    ]);
    const none = new FxAggregate();
    const netByColumn = new Map<string, FxAggregate>();
    for (const month of allMonths) {
      const deposits = acc.depositByMonth.get(month) ?? none;
      const withdrawals = acc.withdrawalByMonth.get(month) ?? none;
      netByColumn.set(month, FxAggregate.difference(deposits, withdrawals));
      valuesByMonth[month] = (
        isIncome
          ? FxAggregate.difference(deposits, withdrawals)
          : FxAggregate.difference(withdrawals, deposits)
      ).knownSubtotalAt(places);
    }

    const row = {
      categoryId: acc.categoryId,
      categoryName: category?.name ?? "Uncategorized",
      parentId: parent?.id ?? null,
      parentName: parent?.name ?? null,
      parentIsIncome: parent ? isIncomeCategory(parent) : null,
      isIncome,
      valuesByMonth,
      depositTotal: acc.depositTotal.knownSubtotalAt(places),
      withdrawalTotal: acc.withdrawalTotal.knownSubtotalAt(places),
    };
    return { row, netByColumn };
  }
}
