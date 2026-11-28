import { Injectable } from "@nestjs/common";
import {
  CategoryType,
  categoryTypeIs,
  categoryTypeOfOrUndefined,
} from "../categories/category-type.util";
import { DataSource } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { Category } from "../categories/entities/category.entity";
import { Payee } from "../payees/entities/payee.entity";
import {
  ConversionGaps,
  RATE_BASIS_GROUP_BY,
  ReportCurrencyService,
  wholeGroups,
  RawCategoryAggregate,
  RawPayeeAggregate,
  RawMonthlyCategoryAggregate,
  rateBasisColumnsSql,
} from "./report-currency.service";
import { MONEY_SCALE, toMoneyNumber } from "../common/round.util";
import { FxAggregate, shareOf } from "../common/fx-aggregate";
import {
  SpendingByCategoryResponse,
  CategorySpendingItem,
  SpendingByPayeeResponse,
  PayeeSpendingItem,
  MonthlySpendingTrendResponse,
  MonthlySpendingItem,
  MonthlyCategorySpending,
} from "./dto";
import { investmentExclusionSql } from "../common/investment-filter.util";
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

// The ledger population is shared by category, payee and month. The optional
// category joins for the payee view identify the same reporting parent.
function spendingComponentsSql(parentJoin = ""): string {
  return `
      FROM transactions t
      LEFT JOIN transaction_splits ts ON ts.transaction_id = t.id
      LEFT JOIN accounts a ON a.id = t.account_id
      LEFT JOIN categories c ON c.id = COALESCE(ts.category_id, t.category_id) AND c.user_id = t.user_id
      ${parentJoin}
      WHERE t.user_id = $1
        AND t.transaction_date <= $2
        AND (c.id IS NULL OR ${categoryTypeIs("c", "expense")})
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
        )`;
}

/** Positive-net inclusion for reports and fallback buckets defined by direction. */
export function isNetSpending(total: number): boolean {
  return total > 0;
}

/**
 * A bucket whose category has a known type keeps its signed net, even after a
 * full or excess refund; an uncategorized or unclassified bucket keeps the
 * positive-net rule. The bucket's category may be the income parent of an
 * expense leaf (a legacy mixed-type tree), so the type decides only whether it
 * is known, never whether it is spending: the query already left income leaves
 * out. A Transfer category is a named flow, never spending (INV-REPORT-003).
 */
export function includesClassifiedBucket(
  total: number,
  type?: CategoryType,
): boolean {
  if (type === "transfer") return false;
  return type !== undefined || isNetSpending(total);
}

/** Classified expenses keep their signed net even after a full or excess refund. */
export function includesSpendingCategory(
  total: number,
  type?: CategoryType,
): boolean {
  // A Transfer category is a named flow, never spending (INV-REPORT-003).
  if (type === "transfer") return false;
  return type === "expense" || isNetSpending(total);
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
    const { response } = await this.getSpendingByCategoryWithAggregates(
      userId,
      startDate,
      endDate,
      options,
    );
    return response;
  }

  /**
   * `getSpendingByCategory`'s response beside each listed category's net
   * spend as an aggregate, keyed by the row's `categoryId` (`null` for
   * Uncategorized), for a caller that works out a figure from two windows
   * (the Monthly Comparison's change per category): the difference of the two
   * aggregates is rounded once, where the difference of the rows' readings can
   * sit a unit off (`docs/specs/report-rounding-and-aggregation.md` rule 4).
   */
  async getSpendingByCategoryWithAggregates(
    userId: string,
    startDate: string | undefined,
    endDate: string,
    options: {
      rollupToParent?: boolean;
      accountIds?: string[];
      tagKey?: string;
      tagValue?: string;
    } = {},
  ): Promise<{
    response: SpendingByCategoryResponse;
    categories: ReadonlyMap<string | null, FxAggregate>;
  }> {
    const { rollupToParent = true, accountIds, tagKey, tagValue } = options;
    const defaultCurrency =
      await this.currencyService.getDefaultCurrency(userId);
    // Every figure leaves rounded once at the reporting currency's places
    // (docs/specs/report-rounding-and-aggregation.md section 6).
    const places = await this.currencyService.getReportPlaces(defaultCurrency);

    let query = `
      SELECT
        COALESCE(ts.category_id, t.category_id) as category_id,
        t.currency_code,
        ${rateBasisColumnsSql("$3")},
        SUM(${NET_SPEND_AMOUNT}) as total
      ${spendingComponentsSql()}
    `;

    const params: (string | string[] | undefined)[] = [
      userId,
      endDate,
      defaultCurrency,
    ];

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

    query += ` GROUP BY COALESCE(ts.category_id, t.category_id), t.currency_code, ${RATE_BASIS_GROUP_BY}`;

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
    const convert = wholeGroups(
      rawResults,
      await this.currencyService.buildConverter(rawResults, defaultCurrency),
      (row) => `${row.category_id ?? ""}|${row.currency_code}`,
      (row) => [toMoneyNumber(row.total, MONEY_SCALE)],
    );

    const parentTotals = new Map<
      string,
      { agg: FxAggregate; category: Category | null }
    >();
    // A missing currency group may contain purchases or refunds. Keep the
    // converted subtotal, and withhold the complete total and its shares.
    const gaps = new ConversionGaps();

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
      const converted = convert(
        // An aggregate in the row's own currency, read before conversion: a coin's
        // sum keeps its stored 8 places (MONEY_SCALE, lossless; a fiat figure reads
        // the same), so a 2,500-sat total is not rounded to zero before it is
        // converted (INV-MONEY-001).
        toMoneyNumber(row.total, MONEY_SCALE),
        row,
      );
      if (converted === null) {
        gaps.record(
          row.currency_code,
          `${row.category_id ?? ""}|${row.currency_code}`,
        );
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

    // An expense category identifies spending even when its refunds equal or
    // exceed its purchases. Unclassified buckets keep their positive-net
    // inclusion rule, including Uncategorized. Zero-only postings are already
    // excluded by the query, so an expense row at zero represents activity.
    const spent = Array.from(parentTotals.entries()).filter(
      ([, { agg, category }]) =>
        includesClassifiedBucket(agg.sign, categoryTypeOfOrUndefined(category)),
    );
    const spending = FxAggregate.sum(spent.map(([, { agg }]) => agg));
    const knownSpending = spending.knownSubtotalAt(places);
    const canShowShares =
      gaps.isComplete &&
      spending.sign > 0 &&
      spent.every(([, { agg }]) => agg.sign >= 0);
    const data: CategorySpendingItem[] = spent
      .map(([id, { agg, category }]) => ({
        categoryId: id === "uncategorized" ? null : id,
        categoryName: category?.name || "Uncategorized",
        color: category?.color || null,
        total: agg.knownSubtotalAt(places),
        ...(canShowShares && { percentage: shareOf(agg, spending) }),
      }))
      .sort((a, b) => b.total - a.total);

    return {
      response: {
        netSpending: true,
        data,
        totalSpending: gaps.headline(knownSpending),
        knownSpending,
        currency: defaultCurrency,
        missingCurrencies: gaps.missingCurrencies,
        excludedCount: gaps.excludedCount,
      },
      categories: new Map(
        spent.map(([id, { agg }]) => [id === "uncategorized" ? null : id, agg]),
      ),
    };
  }

  async getSpendingByPayee(
    userId: string,
    startDate: string | undefined,
    endDate: string,
  ): Promise<SpendingByPayeeResponse> {
    const defaultCurrency =
      await this.currencyService.getDefaultCurrency(userId);
    const places = await this.currencyService.getReportPlaces(defaultCurrency);

    let query = `
      SELECT
        COALESCE(ts.category_id, t.category_id) AS category_id,
        COALESCE(parent.id, c.id) AS bucket_id,
        COALESCE(parent.category_type, c.category_type) IS NOT NULL AS classified,
        t.payee_id, t.payee_name, t.currency_code,
        ${rateBasisColumnsSql("$3")},
        SUM(${NET_SPEND_AMOUNT}) as total
      ${spendingComponentsSql(`
        LEFT JOIN categories parent ON parent.id = c.parent_id AND parent.user_id = t.user_id
      `)}
    `;

    const params: (string | undefined)[] = [userId, endDate, defaultCurrency];

    if (startDate) {
      query += ` AND t.transaction_date >= $4`;
      params.push(startDate);
    }

    query += ` GROUP BY COALESCE(ts.category_id, t.category_id), COALESCE(parent.id, c.id), COALESCE(parent.category_type, c.category_type), t.payee_id, t.payee_name, t.currency_code, ${RATE_BASIS_GROUP_BY}`;

    const rawResults: (RawPayeeAggregate & {
      category_id: string | null;
      bucket_id: string | null;
      classified: boolean;
    })[] = await withScopedDb(this.dataSource, (m) => m.query(query, params));

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
    const categoryCurrency = (row: (typeof rawResults)[number]) =>
      `${row.category_id ?? ""}|${row.currency_code}`;
    const convert = wholeGroups(
      rawResults,
      await this.currencyService.buildConverter(rawResults, defaultCurrency),
      categoryCurrency,
      (row) => [toMoneyNumber(row.total, MONEY_SCALE)],
    );
    const gaps = new ConversionGaps();
    const categories = new Map<string | null, FxAggregate>();
    const convertedRows = rawResults.flatMap((row) => {
      const total = convert(toMoneyNumber(row.total, MONEY_SCALE), row);
      if (total === null) {
        gaps.record(row.currency_code, categoryCurrency(row));
        return [];
      }
      const category = categories.get(row.bucket_id) ?? new FxAggregate();
      category.addConverted(total);
      categories.set(row.bucket_id, category);
      return [{ row, total, category }];
    });

    const payeeTotals = new Map<
      string,
      { payeeId: string | null; payeeName: string; agg: FxAggregate }
    >();
    // Decide eligibility at category level before attributing each posting
    // to its payee. A refund can come from a different payee than the purchase.
    for (const { row, total, category } of convertedRows) {
      if (!row.classified && !isNetSpending(category.sign)) continue;
      const key = JSON.stringify([
        row.payee_id,
        row.payee_id ? null : row.payee_name,
      ]);
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

    const payeeRows = Array.from(payeeTotals.values());
    const spending = FxAggregate.sum(payeeRows.map((row) => row.agg));
    const hasShares =
      spending.sign > 0 && payeeRows.every((row) => row.agg.sign >= 0);
    const data: PayeeSpendingItem[] = payeeRows
      .map((row) => ({
        payeeId: row.payeeId,
        payeeName: row.payeeName,
        total: row.agg.knownSubtotalAt(places),
        percentage: hasShares ? shareOf(row.agg, spending) : null,
      }))
      .sort((a, b) => b.total - a.total);
    const knownSpending = spending.knownSubtotalAt(places);

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
    const places = await this.currencyService.getReportPlaces(defaultCurrency);

    let query = `
      SELECT
        TO_CHAR(t.transaction_date, 'YYYY-MM') as month,
        COALESCE(ts.category_id, t.category_id) as category_id,
        t.currency_code,
        ${rateBasisColumnsSql("$3")},
        SUM(${NET_SPEND_AMOUNT}) as total
      ${spendingComponentsSql()}
    `;

    const params: (string | undefined)[] = [userId, endDate, defaultCurrency];

    if (startDate) {
      query += ` AND t.transaction_date >= $4`;
      params.push(startDate);
    }

    query += `
      GROUP BY TO_CHAR(t.transaction_date, 'YYYY-MM'), COALESCE(ts.category_id, t.category_id), t.currency_code, ${RATE_BASIS_GROUP_BY}
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
    const convert = wholeGroups(
      rawResults,
      await this.currencyService.buildConverter(rawResults, defaultCurrency),
      (row) => `${row.month}|${row.category_id ?? ""}|${row.currency_code}`,
      (row) => [toMoneyNumber(row.total, MONEY_SCALE)],
    );

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
      const total = convert(toMoneyNumber(row.total, MONEY_SCALE), row);
      if (total === null) {
        gaps.record(
          row.currency_code,
          `${month}|${row.category_id ?? ""}|${row.currency_code}`,
        );
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
        overall.merge(agg);
        allCategoryTotals.set(catId, overall);
      }
    }
    // Whether a category belongs in a spending trend is decided over the whole
    // period, not per month: one month's refund is still part of a category
    // that was spent in. Classified expenses keep credit and zero balances.
    // The fallback tests the sign before rounding (rules 2 and 5).
    const spendingCategories = new Set(
      Array.from(allCategoryTotals.entries())
        .filter(([id, overall]) =>
          includesClassifiedBucket(
            overall.sign,
            categoryTypeOfOrUndefined(categoryMap.get(id)),
          ),
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
              total: catData?.agg.knownSubtotalAt(places) ?? 0,
            };
          },
        );

        // The headline includes every eligible category, including those below the chart limit.
        const monthSpending = new FxAggregate();
        for (const [catId, catData] of catMap) {
          if (spendingCategories.has(catId)) monthSpending.merge(catData.agg);
        }

        return {
          month,
          categories,
          totalSpending: monthSpending.knownSubtotalAt(places),
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
