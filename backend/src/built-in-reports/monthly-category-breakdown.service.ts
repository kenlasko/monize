import { Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { Category } from "../categories/entities/category.entity";
import {
  ConversionGaps,
  ReportCurrencyService,
} from "./report-currency.service";
import { roundMoney, toMoneyNumber } from "../common/round.util";
import {
  MonthlyCategoryBreakdownResponse,
  MonthlyBreakdownCategoryRow,
  MonthlyBreakdownTransferRow,
} from "./dto";
import { investmentExclusionSql } from "../common/investment-filter.util";

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
interface RawBreakdownAggregate {
  month: string;
  category_id: string | null;
  currency_code: string;
  deposits: string;
  withdrawals: string;
}

/**
 * Raw per-(account, month, currency) transfer aggregate. Outflows and inflows
 * are summed separately so each account can be split into a "from" row
 * (outflows, a source of funds) and a "to" row (inflows, a use of funds).
 */
interface RawTransferAggregate {
  month: string;
  account_id: string;
  account_name: string;
  currency_code: string;
  outflow: string;
  inflow: string;
}

/**
 * Mutable accumulator for a single category while merging the raw rows. Money
 * is accumulated in floating numbers but every read-out is rounded with the
 * shared money helpers so the response never carries IEEE 754 drift.
 */
interface CategoryAccumulator {
  categoryId: string | null;
  depositByMonth: Map<string, number>;
  withdrawalByMonth: Map<string, number>;
  depositTotal: number;
  withdrawalTotal: number;
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
    options: { accountIds?: string[] } = {},
  ): Promise<MonthlyCategoryBreakdownResponse> {
    const { accountIds } = options;
    const defaultCurrency =
      await this.currencyService.getDefaultCurrency(userId);
    const rateMap = await this.currencyService.buildRateMap(defaultCurrency);

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

    const params: (string | string[] | undefined)[] = [userId, endDate];

    if (startDate) {
      query += ` AND t.transaction_date >= $3`;
      params.push(startDate);
    }

    // An empty selection is "every account", like every other report filter.
    if (accountIds && accountIds.length > 0) {
      query += ` AND t.account_id = ANY($${params.length + 1}::uuid[])`;
      params.push(accountIds);
    }

    query += `
      GROUP BY TO_CHAR(t.transaction_date, 'YYYY-MM'),
               COALESCE(ts.category_id, t.category_id), t.currency_code
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

    const accumulators = new Map<string, CategoryAccumulator>();
    const monthSet = new Set<string>();
    // A row with no rate into the reporting currency is unknown, never its
    // unconverted figure (INV-FX-001): it is in no category value, no deposit or
    // withdrawal total, no transfer row and no month, and its currency is named.
    const gaps = new ConversionGaps();

    for (const row of rawResults) {
      const month = row.month;

      const deposits = this.currencyService.tryConvertAmount(
        toMoneyNumber(row.deposits),
        row.currency_code,
        defaultCurrency,
        rateMap,
      );
      const withdrawals = this.currencyService.tryConvertAmount(
        toMoneyNumber(row.withdrawals),
        row.currency_code,
        defaultCurrency,
        rateMap,
      );
      if (deposits === null || withdrawals === null) {
        gaps.record(row.currency_code);
        continue;
      }
      monthSet.add(month);

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
          depositTotal: 0,
          withdrawalTotal: 0,
        };
        accumulators.set(key, acc);
      }

      acc.depositByMonth.set(
        month,
        (acc.depositByMonth.get(month) ?? 0) + deposits,
      );
      acc.withdrawalByMonth.set(
        month,
        (acc.withdrawalByMonth.get(month) ?? 0) + withdrawals,
      );
      acc.depositTotal += deposits;
      acc.withdrawalTotal += withdrawals;
    }

    const transfers = await this.getTransferRows(
      userId,
      startDate,
      endDate,
      defaultCurrency,
      rateMap,
      monthSet,
      gaps,
      accountIds,
    );

    const months = Array.from(monthSet).sort();

    const data: MonthlyBreakdownCategoryRow[] = Array.from(
      accumulators.values(),
    ).map((acc) => this.buildRow(acc, categoryMap));

    return {
      months,
      data,
      transfers,
      currency: defaultCurrency,
      missingCurrencies: gaps.missingCurrencies,
      excludedCount: gaps.excludedCount,
    };
  }

  /**
   * Aggregate transfers per (account, month) into signed "from"/"to" rows.
   * Each transfer is stored as two linked legs (a negative leg on the source
   * account and a positive leg on the destination account); grouping every
   * leg by the account it sits on therefore counts each transfer exactly once
   * per side. Outflows become a "from" row (positive, a source of funds) and
   * inflows become a "to" row (negative, a use of funds). Months that contain
   * transfers but no categorised activity are added to the shared month set.
   */
  private async getTransferRows(
    userId: string,
    startDate: string | undefined,
    endDate: string,
    defaultCurrency: string,
    rateMap: Map<string, number>,
    monthSet: Set<string>,
    gaps: ConversionGaps,
    accountIds?: string[],
  ): Promise<MonthlyBreakdownTransferRow[]> {
    let query = `
      SELECT
        TO_CHAR(t.transaction_date, 'YYYY-MM') as month,
        t.account_id,
        a.name as account_name,
        t.currency_code,
        SUM(CASE WHEN t.amount < 0 THEN ABS(t.amount) ELSE 0 END) as outflow,
        SUM(CASE WHEN t.amount > 0 THEN t.amount ELSE 0 END) as inflow
      FROM transactions t
      JOIN accounts a ON a.id = t.account_id
      WHERE t.user_id = $1
        AND t.transaction_date <= $2
        AND t.is_transfer = true
        AND (t.status IS NULL OR t.status != 'VOID')
        AND t.parent_transaction_id IS NULL
    `;

    const params: (string | string[] | undefined)[] = [userId, endDate];

    if (startDate) {
      query += ` AND t.transaction_date >= $3`;
      params.push(startDate);
    }

    // The same scope as the category rows above: a transfer row is a row of
    // one account, so it is kept or dropped with that account.
    if (accountIds && accountIds.length > 0) {
      query += ` AND t.account_id = ANY($${params.length + 1}::uuid[])`;
      params.push(accountIds);
    }

    query += `
      GROUP BY TO_CHAR(t.transaction_date, 'YYYY-MM'),
               t.account_id, a.name, t.currency_code
      ORDER BY month
    `;

    const rawResults: RawTransferAggregate[] = await withScopedDb(
      this.dataSource,
      (m) => m.query(query, params),
    );

    // Accumulate the signed flow per (account, direction) across currencies.
    const fromByAccount = new Map<
      string,
      { name: string; valuesByMonth: Map<string, number> }
    >();
    const toByAccount = new Map<
      string,
      { name: string; valuesByMonth: Map<string, number> }
    >();

    const addFlow = (
      store: Map<string, { name: string; valuesByMonth: Map<string, number> }>,
      accountId: string,
      accountName: string,
      month: string,
      amount: number,
    ) => {
      let entry = store.get(accountId);
      if (!entry) {
        entry = { name: accountName, valuesByMonth: new Map() };
        store.set(accountId, entry);
      }
      entry.valuesByMonth.set(
        month,
        (entry.valuesByMonth.get(month) ?? 0) + amount,
      );
    };

    for (const row of rawResults) {
      const outflow = this.currencyService.tryConvertAmount(
        toMoneyNumber(row.outflow),
        row.currency_code,
        defaultCurrency,
        rateMap,
      );
      const inflow = this.currencyService.tryConvertAmount(
        toMoneyNumber(row.inflow),
        row.currency_code,
        defaultCurrency,
        rateMap,
      );
      if (outflow === null || inflow === null) {
        gaps.record(row.currency_code);
        continue;
      }
      monthSet.add(row.month);
      if (outflow !== 0) {
        addFlow(
          fromByAccount,
          row.account_id,
          row.account_name,
          row.month,
          outflow,
        );
      }
      if (inflow !== 0) {
        addFlow(
          toByAccount,
          row.account_id,
          row.account_name,
          row.month,
          inflow,
        );
      }
    }

    const buildTransferRows = (
      store: Map<string, { name: string; valuesByMonth: Map<string, number> }>,
      direction: "from" | "to",
    ): MonthlyBreakdownTransferRow[] =>
      Array.from(store.entries()).map(([accountId, entry]) => {
        const valuesByMonth: Record<string, number> = {};
        for (const [month, amount] of entry.valuesByMonth) {
          // "from" rows are a source of funds (positive); "to" rows are a use
          // of funds (negative).
          valuesByMonth[month] = roundMoney(
            direction === "from" ? amount : -amount,
          );
        }
        return { accountId, accountName: entry.name, direction, valuesByMonth };
      });

    return [
      ...buildTransferRows(fromByAccount, "from"),
      ...buildTransferRows(toByAccount, "to"),
    ];
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
  ): MonthlyBreakdownCategoryRow {
    const category = acc.categoryId
      ? (categoryMap.get(acc.categoryId) ?? null)
      : null;
    const parent = category?.parentId
      ? (categoryMap.get(category.parentId) ?? null)
      : null;

    const isIncome = category
      ? category.isIncome
      : acc.depositTotal > acc.withdrawalTotal;

    const valuesByMonth: Record<string, number> = {};
    const allMonths = new Set<string>([
      ...acc.depositByMonth.keys(),
      ...acc.withdrawalByMonth.keys(),
    ]);
    for (const month of allMonths) {
      const deposits = acc.depositByMonth.get(month) ?? 0;
      const withdrawals = acc.withdrawalByMonth.get(month) ?? 0;
      const net = isIncome ? deposits - withdrawals : withdrawals - deposits;
      valuesByMonth[month] = roundMoney(net);
    }

    return {
      categoryId: acc.categoryId,
      categoryName: category?.name ?? "Uncategorized",
      parentId: parent?.id ?? null,
      parentName: parent?.name ?? null,
      parentIsIncome: parent?.isIncome ?? null,
      isIncome,
      valuesByMonth,
      depositTotal: roundMoney(acc.depositTotal),
      withdrawalTotal: roundMoney(acc.withdrawalTotal),
    };
  }
}
