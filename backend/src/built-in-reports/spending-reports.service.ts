import { Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { Category } from "../categories/entities/category.entity";
import { Payee } from "../payees/entities/payee.entity";
import {
  ConversionGaps,
  ReportCurrencyService,
  RawCategoryAggregate,
  RawPayeeAggregate,
  RawMonthlyCategoryAggregate,
} from "./report-currency.service";
import { roundMoney, sumMoney, toMoneyNumber } from "../common/round.util";
import { FxAggregate } from "../common/fx-aggregate";
import {
  SpendingByCategoryResponse,
  CategorySpendingItem,
  SpendingByPayeeResponse,
  PayeeSpendingItem,
  MonthlySpendingTrendResponse,
  MonthlySpendingItem,
  MonthlyCategorySpending,
} from "./dto";
import {
  investmentExclusionSql,
  reportableTransactionAmountSql,
} from "../common/investment-filter.util";
import { tagValuesArrayExpr } from "./tag-values-sql";

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
const INVESTMENT_EXCLUSION_NO_SPLITS = investmentExclusionSql({
  accountAlias: "a",
  transactionAlias: "t",
});

/**
 * The ordinary cash the parent row represents. A payee total reads only the
 * parent, so a split's embedded investment or transfer line has to come out of
 * the amount rather than out of the row (branch audit F-RPT-001).
 */
const REPORTABLE_TX_AMOUNT = reportableTransactionAmountSql("t");

/**
 * Spending in a category is the DEBITS NET OF THE CREDITS filed against it: a
 * refund, a return or a chargeback is money that came back, so it reduces what
 * was spent there rather than being dropped (issue #1125). The aggregate
 * therefore sums the negated signed amount over rows of both signs -- positive
 * result means "spent" -- instead of the absolute value of debit rows only.
 *
 * Restricting to `<> 0` (rather than dropping the amount predicate entirely)
 * keeps a zero-amount row from creating a category bucket, which is what the
 * old `< 0` predicate did.
 */
export const NET_SPEND_AMOUNT = "-COALESCE(ts.amount, t.amount)";
const NONZERO_AMOUNT = "COALESCE(ts.amount, t.amount) <> 0";

/**
 * A category whose credits meet or exceed its debits over the period was not
 * spent in, so it is not a row in a spending report. This is also what keeps
 * income categories (and uncategorized income, which the old debit-only
 * predicate excluded row by row) out of the breakdown now that credits are
 * read at all.
 */
export function isNetSpending(total: number): boolean {
  return total > 0;
}

@Injectable()
export class SpendingReportsService {
  constructor(
    private dataSource: DataSource,
    private currencyService: ReportCurrencyService,
  ) {}

  /**
   * Spending by category over a window: the one answer both the Spending by
   * Category report and the dashboard's Expenses by Category widget draw.
   *
   * The widget used to compute its own breakdown from paged transactions in the
   * browser, and disagreed with this report about the same period: it read no
   * VOID status, applied no asset-category exclusion, and decided what was an
   * investment from the account type rather than from the row (INV-REPORT-001).
   * Every filter that decides which rows count therefore lives here, in the
   * query, and both surfaces read the result.
   *
   * `options.accountIds` restricts the window to those accounts;
   * `options.rollupToParent` (default true) counts a subcategory's spend against
   * its top-level ancestor. Both exist because the widget offers them -- a
   * setting the client answers for itself is a second implementation waiting to
   * drift.
   *
   * `options.tagKey` + `options.tagValue` keep only the rows (a transaction, or
   * one split of it) whose own `tagKey:*` tags include `tagValue`, the household
   * view of `docs/specs/report-tag-key-breakdown.md` section 11.4. It is one
   * more `WHERE` clause on the query below, so the VOID, investment, transfer
   * and asset-category exclusions all still apply; with neither the SQL and its
   * parameters are exactly what they were.
   */
  async getSpendingByCategory(
    userId: string,
    startDate: string | undefined,
    endDate: string,
    options: {
      rollupToParent?: boolean;
      accountIds?: string[];
      tagKey?: string;
      tagValue?: string;
    } = {},
  ): Promise<SpendingByCategoryResponse> {
    const { rollupToParent = true, accountIds, tagKey, tagValue } = options;
    const defaultCurrency =
      await this.currencyService.getDefaultCurrency(userId);
    const rateMap = await this.currencyService.buildRateMap(defaultCurrency);

    let query = `
      SELECT
        COALESCE(ts.category_id, t.category_id) as category_id,
        t.currency_code,
        SUM(${NET_SPEND_AMOUNT}) as total
      FROM transactions t
      LEFT JOIN transaction_splits ts ON ts.transaction_id = t.id
      LEFT JOIN accounts a ON a.id = t.account_id
      WHERE t.user_id = $1
        AND t.transaction_date <= $2
        AND ${NONZERO_AMOUNT}
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
      query += ` AND t.transaction_date >= $${params.length + 1}`;
      params.push(startDate);
    }

    // An empty array would match nothing, which is not what "no filter" means,
    // so an empty selection is treated as absent the way every other report
    // filter is.
    if (accountIds && accountIds.length > 0) {
      query += ` AND t.account_id = ANY($${params.length + 1}::uuid[])`;
      params.push(accountIds);
    }

    // The tag filter needs the key AND the value; either alone filters nothing
    // (the DTO already refuses the half-specified request). The value read is
    // the row's own, transaction-level and this split's, de-duplicated, so a
    // transaction with two matching split tags is still summed once.
    if (tagKey && tagValue) {
      const keyParam = `$${params.length + 1}`;
      const valueParam = `$${params.length + 2}`;
      // Two details matter. The cast: without it PostgreSQL types the parameter
      // from the array on the right and reads the value as an array literal.
      // The COALESCE: `ANY((SELECT ...))` is read as ANY over a sub-select's
      // rows, not over the array it returns, and a row with no `K:*` tag has a
      // NULL array, which then matches nothing.
      query += ` AND ${valueParam}::text = ANY(COALESCE(${tagValuesArrayExpr("t", "ts", keyParam)}, ARRAY[]::text[]))`;
      params.push(tagKey, tagValue);
    }

    query += ` GROUP BY COALESCE(ts.category_id, t.category_id), t.currency_code`;

    const rawResults: RawCategoryAggregate[] = await withScopedDb(
      this.dataSource,
      (m) => m.query(query, params),
    );

    const categories = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Category).find({
        where: { userId },
      }),
    );
    const categoryMap = new Map(categories.map((c) => [c.id, c]));

    const parentTotals = new Map<
      string,
      { agg: FxAggregate; category: Category | null }
    >();
    /**
     * Source currencies with no rate into the reporting currency, and how many
     * aggregate rows that cost us.
     *
     * An excluded row is not a smaller number: it could have changed which
     * categories appear at all, since a category is kept or dropped on whether
     * it nets to spending. So a single exclusion anywhere withholds the report's
     * total rather than only the affected category's.
     */
    const missingCurrencies = new Set<string>();
    let excludedCount = 0;

    const bucketFor = (key: string, category: Category | null) => {
      const existing = parentTotals.get(key);
      if (existing) return existing;
      const created = { agg: new FxAggregate(), category };
      parentTotals.set(key, created);
      return created;
    };

    for (const row of rawResults) {
      // A missing rate is unknown, never the unconverted figure: adding foreign
      // units to a home-currency total is the defect INV-FX-001 forbids.
      const converted = this.currencyService.tryConvertAmount(
        toMoneyNumber(row.total),
        row.currency_code,
        defaultCurrency,
        rateMap,
      );
      if (converted === null) {
        missingCurrencies.add(row.currency_code);
        excludedCount += 1;
        continue;
      }

      const categoryId = row.category_id;
      const category = categoryId ? categoryMap.get(categoryId) : undefined;

      // No category, or one this user cannot see: uncategorized either way.
      if (!category) {
        bucketFor("uncategorized", null).agg.addConverted(converted);
        continue;
      }

      const parentCategory = category.parentId
        ? categoryMap.get(category.parentId)
        : null;

      if (rollupToParent) {
        const displayCategory = parentCategory || category;
        bucketFor(displayCategory.id, displayCategory).agg.addConverted(
          converted,
        );
        continue;
      }

      // Keep subcategory detail -- format name as "Parent: Child"
      const displayName = parentCategory
        ? `${parentCategory.name}: ${category.name}`
        : category.name;
      bucketFor(category.id, {
        ...category,
        name: displayName,
      } as Category).agg.addConverted(converted);
    }

    const data: CategorySpendingItem[] = Array.from(parentTotals.entries())
      .map(([id, { agg, category }]) => ({
        categoryId: id === "uncategorized" ? null : id,
        categoryName: category?.name || "Uncategorized",
        color: category?.color || null,
        total: roundMoney(agg.knownSubtotal),
      }))
      // Netting happens before this filter, so a category is judged on what it
      // cost after its refunds -- not on whether it happened to hold a debit.
      .filter((item) => isNetSpending(item.total))
      .sort((a, b) => b.total - a.total);

    // Every category, not a top-N: the caller decides how many to draw and can
    // still say what it merged. Truncating here made `totalSpending` the sum of
    // the largest fifteen under a name that says "total".
    const knownSpending = roundMoney(sumMoney(data.map((item) => item.total)));

    return {
      data,
      totalSpending: excludedCount === 0 ? knownSpending : null,
      knownSpending,
      currency: defaultCurrency,
      missingCurrencies: [...missingCurrencies].sort(),
      excludedCount,
    };
  }

  async getSpendingByPayee(
    userId: string,
    startDate: string | undefined,
    endDate: string,
  ): Promise<SpendingByPayeeResponse> {
    const defaultCurrency =
      await this.currencyService.getDefaultCurrency(userId);
    const rateMap = await this.currencyService.buildRateMap(defaultCurrency);

    let query = `
      SELECT
        t.payee_id,
        t.payee_name,
        t.currency_code,
        SUM(ABS(${REPORTABLE_TX_AMOUNT})) as total
      FROM transactions t
      LEFT JOIN accounts a ON a.id = t.account_id
      WHERE t.user_id = $1
        AND t.transaction_date <= $2
        AND ${REPORTABLE_TX_AMOUNT} < 0
        AND t.is_transfer = false
        AND (t.status IS NULL OR t.status != 'VOID')
        AND t.parent_transaction_id IS NULL
        AND ${INVESTMENT_EXCLUSION_NO_SPLITS}
        AND NOT EXISTS (
          SELECT 1 FROM accounts ax
          WHERE ax.user_id = t.user_id
            AND ax.asset_category_id IS NOT NULL
            AND ax.asset_category_id = t.category_id
        )
      `;

    const params: (string | undefined)[] = [userId, endDate];

    if (startDate) {
      query += ` AND t.transaction_date >= $3`;
      params.push(startDate);
    }

    query += ` GROUP BY t.payee_id, t.payee_name, t.currency_code`;

    const rawResults: RawPayeeAggregate[] = await withScopedDb(
      this.dataSource,
      (m) => m.query(query, params),
    );

    const payeeIds = rawResults
      .filter((r) => r.payee_id)
      .map((r) => r.payee_id as string);

    const payees =
      payeeIds.length > 0
        ? await withScopedDb(this.dataSource, (m) =>
            m.getRepository(Payee).findByIds(payeeIds),
          )
        : [];
    const payeeMap = new Map(payees.map((p) => [p.id, p]));

    const payeeTotals = new Map<
      string,
      { payeeId: string | null; payeeName: string; agg: FxAggregate }
    >();
    // A row with no rate is unknown, never its unconverted figure (INV-FX-001):
    // it is in no payee, no ranking and no total. Excluding it can change which
    // twenty payees make the list, so the total is withheld, not merely smaller.
    const gaps = new ConversionGaps();
    for (const row of rawResults) {
      const total = this.currencyService.tryConvertAmount(
        toMoneyNumber(row.total),
        row.currency_code,
        defaultCurrency,
        rateMap,
      );
      if (total === null) {
        gaps.record(row.currency_code);
        continue;
      }
      const key = row.payee_id || row.payee_name || "unknown";
      const payee = row.payee_id ? payeeMap.get(row.payee_id) : null;
      const existing = payeeTotals.get(key);
      if (existing) {
        existing.agg.addConverted(total);
      } else {
        const agg = new FxAggregate();
        agg.addConverted(total);
        payeeTotals.set(key, {
          payeeId: row.payee_id,
          payeeName: payee?.name || row.payee_name || "Unknown",
          agg,
        });
      }
    }

    const data: PayeeSpendingItem[] = Array.from(payeeTotals.values())
      .map((row) => ({
        payeeId: row.payeeId,
        payeeName: row.payeeName,
        total: roundMoney(row.agg.knownSubtotal),
      }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 20);

    const knownSpending = roundMoney(sumMoney(data.map((item) => item.total)));

    return {
      data,
      totalSpending: gaps.headline(knownSpending),
      knownSpending,
      currency: defaultCurrency,
      missingCurrencies: gaps.missingCurrencies,
      excludedCount: gaps.excludedCount,
    };
  }

  async getMonthlySpendingTrend(
    userId: string,
    startDate: string | undefined,
    endDate: string,
  ): Promise<MonthlySpendingTrendResponse> {
    const defaultCurrency =
      await this.currencyService.getDefaultCurrency(userId);
    const rateMap = await this.currencyService.buildRateMap(defaultCurrency);

    let query = `
      SELECT
        TO_CHAR(t.transaction_date, 'YYYY-MM') as month,
        COALESCE(ts.category_id, t.category_id) as category_id,
        t.currency_code,
        SUM(${NET_SPEND_AMOUNT}) as total
      FROM transactions t
      LEFT JOIN transaction_splits ts ON ts.transaction_id = t.id
      LEFT JOIN accounts a ON a.id = t.account_id
      WHERE t.user_id = $1
        AND t.transaction_date <= $2
        AND ${NONZERO_AMOUNT}
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

    const params: (string | undefined)[] = [userId, endDate];

    if (startDate) {
      query += ` AND t.transaction_date >= $3`;
      params.push(startDate);
    }

    query += `
      GROUP BY TO_CHAR(t.transaction_date, 'YYYY-MM'), COALESCE(ts.category_id, t.category_id), t.currency_code
      ORDER BY month
    `;

    const rawResults: RawMonthlyCategoryAggregate[] = await withScopedDb(
      this.dataSource,
      (m) => m.query(query, params),
    );

    const categories = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Category).find({
        where: { userId },
      }),
    );
    const categoryMap = new Map(categories.map((c) => [c.id, c]));

    const monthlyData = new Map<
      string,
      Map<string, { agg: FxAggregate; category: Category | null }>
    >();
    // A row with no rate is unknown, never its unconverted figure (INV-FX-001):
    // it is in no month, no category and no ranking, and does not create a month
    // that holds nothing else.
    const gaps = new ConversionGaps();

    for (const row of rawResults) {
      const month = row.month;
      const total = this.currencyService.tryConvertAmount(
        toMoneyNumber(row.total),
        row.currency_code,
        defaultCurrency,
        rateMap,
      );
      if (total === null) {
        gaps.record(row.currency_code);
        continue;
      }
      const categoryId = row.category_id;

      if (!monthlyData.has(month)) {
        monthlyData.set(month, new Map());
      }
      const monthMap = monthlyData.get(month)!;

      let displayId = "uncategorized";
      let displayCategory: Category | null = null;

      if (categoryId) {
        const category = categoryMap.get(categoryId);
        if (category) {
          const parentCategory = category.parentId
            ? categoryMap.get(category.parentId)
            : null;
          displayCategory = parentCategory || category;
          displayId = displayCategory.id;
        }
      }

      const existing = monthMap.get(displayId);
      if (existing) {
        existing.agg.addConverted(total);
      } else {
        const agg = new FxAggregate();
        agg.addConverted(total);
        monthMap.set(displayId, { agg, category: displayCategory });
      }
    }

    const allCategoryTotals = new Map<string, FxAggregate>();
    for (const monthMap of monthlyData.values()) {
      for (const [catId, { agg }] of monthMap) {
        const overall = allCategoryTotals.get(catId) ?? new FxAggregate();
        overall.addConverted(agg.knownSubtotal);
        allCategoryTotals.set(catId, overall);
      }
    }
    // Whether a category belongs in a spending trend is decided over the whole
    // period, not per month: one month's refund is still part of a category
    // that was spent in. A category that is net-credit across the range was
    // not -- and an income category, now that credits are read at all, never
    // is one.
    const spendingCategories = new Set(
      Array.from(allCategoryTotals.entries())
        .filter(([, overall]) =>
          isNetSpending(roundMoney(overall.knownSubtotal)),
        )
        .map(([id]) => id),
    );
    const topCategories = Array.from(allCategoryTotals.entries())
      .filter(([id]) => spendingCategories.has(id))
      .sort((a, b) => b[1].knownSubtotal - a[1].knownSubtotal)
      .slice(0, 10)
      .map(([id]) => id);

    const data: MonthlySpendingItem[] = Array.from(monthlyData.entries())
      // Reading credits means a month holding nothing but income now produces a
      // bucket where the debit-only predicate produced no row at all. Such a
      // month has nothing to draw, so it stays out of a spending trend. The
      // test is whether the month touched a spending category at all, not the
      // sign of its own total -- a month that is one category's refund is still
      // that category's month -- and a month whose spending fell outside the
      // top ten is kept exactly as before.
      .filter(([, catMap]) =>
        Array.from(catMap.keys()).some((catId) =>
          spendingCategories.has(catId),
        ),
      )
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([month, catMap]) => {
        const categories: MonthlyCategorySpending[] = topCategories.map(
          (catId) => {
            const catData = catMap.get(catId);
            const category =
              catId === "uncategorized" ? null : categoryMap.get(catId);
            return {
              categoryId: catId === "uncategorized" ? null : catId,
              categoryName: category?.name || "Uncategorized",
              color: category?.color || null,
              total: roundMoney(catData?.agg.knownSubtotal ?? 0),
            };
          },
        );

        const totalSpending = sumMoney(categories.map((cat) => cat.total));

        return {
          month,
          categories,
          totalSpending: roundMoney(totalSpending),
        };
      });

    return {
      data,
      currency: defaultCurrency,
      missingCurrencies: gaps.missingCurrencies,
      excludedCount: gaps.excludedCount,
    };
  }
}
