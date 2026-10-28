import { reportingSummaryRows } from "../accruals/reporting-summary-money";
import { reportingMoneyMany } from "../accruals/reporting-money";
import {
  ReportingRead,
  currentReportingRead,
  type ReportingBasis,
} from "../accruals/reporting-basis";
import { reportingRawMany } from "../accruals/reporting-query";
import { Injectable, Logger } from "@nestjs/common";
import {
  Brackets,
  DataSource,
  EntityManager,
  SelectQueryBuilder,
} from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { Transaction, TransactionStatus } from "./entities/transaction.entity";
import { Category } from "../categories/entities/category.entity";
import { getAllCategoryIdsWithChildren } from "../common/category-tree.util";
import {
  applyInvestmentTransactionFilters,
  brokerageExclusionForEntity,
  investmentLinkedSplitExclusion,
  investmentLinkedTransactionExclusion,
  reportableTransactionAmountSql,
} from "../common/investment-filter.util";
import {
  joinSplitsForAnalytics,
  SPLIT_AMOUNT,
  SPLIT_CATEGORY_ID,
} from "../common/transaction-split-query.util";
import { applyTransactionSearch } from "./apply-transaction-search";
import { RecurringCharge, detectFrequency } from "./recurring-charges.util";
import {
  loadQualifiedCategoryNames,
  resolveCategoryNamePaths,
  suggestQualifiedCategoryNames,
  UNCATEGORIZED_LABEL,
  UNKNOWN_CATEGORY_LABEL,
} from "../categories/category-name.util";
import { roundMoney, sumMoney } from "../common/round.util";
import { applyFxConversion } from "../common/fx-entry.util";
import { FxAggregate } from "../common/fx-aggregate";
import { resolveUserDefaultCurrency } from "../common/default-currency.util";
import {
  buildRateIndex,
  convertAtDate,
  RateIndex,
} from "../common/time-series/rate-index.util";
import { isNetSpending } from "../built-in-reports/spending-reports.service";

/**
 * The ordinary-cash amount of one transaction, for the recurring-charge
 * detector: it reads one row per payment and joins no splits, so a split
 * parent's own amount (the sum of every line, embedded investment included) is
 * not what recurred.
 */
const RECURRING_REPORTABLE_AMOUNT = reportableTransactionAmountSql("t");

export interface FxFeeMonthlySummaryRow {
  /** Calendar month in 'YYYY-MM'. */
  month: string;
  /** The currency the transaction was paid in (originalCurrencyCode). */
  currencyCode: string;
  /** Foreign-transaction fees for the month, positive, in account currency. */
  feeTotal: number;
  /** Number of foreign-entered transactions in the month. */
  count: number;
}

/**
 * The values a register's payee and category pickers offer.
 *
 * Scoped to the accounts on screen, because a filter is a way through the rows
 * in front of you: a brokerage cash ledger has a handful of payees, and
 * offering the household's entire payee list to narrow it buries them.
 */
export interface RegisterFilterOptions {
  payees: { id: string; name: string }[];
  /**
   * Every category used by the rows, **plus the ancestors of each** -- a tree
   * picker nests a child under its parent and drops one whose parent is absent
   * (`MultiSelect` builds its top level from `parentId == null`), so a used
   * sub-category with an unused parent would simply not be offered.
   */
  categories: { id: string; name: string; parentId: string | null }[];
}

export interface TransferAccountSummary {
  accountId: string | null;
  accountName: string;
  currency: string;
  inbound: number;
  outbound: number;
  net: number;
  transferCount: number;
}

export interface TransfersByAccountResult {
  currency?: string;
  fxComplete?: boolean;
  accounts: TransferAccountSummary[];
  totalInbound: number;
  totalOutbound: number;
  transferCount: number;
}

/**
 * LLM06-F2: Minimum number of transactions required per group when
 * returning payee-level breakdowns. Groups below this threshold are
 * aggregated into an "Other (aggregated)" bucket to prevent revealing
 * individual transaction amounts through targeted queries.
 */
export const MIN_AGGREGATION_COUNT = 3;

export type LlmQueryDirection = "expenses" | "income" | "both";
export type LlmQueryGroupBy = "category" | "payee" | "year" | "month" | "week";

/**
 * Group-by options for the unified `list_transactions` tool. Adds a "none"
 * sentinel on top of {@link LlmQueryGroupBy} so a caller can ask for totals
 * without any grouped breakdown.
 */
export type LlmListGroupBy = LlmQueryGroupBy | "none";

export interface LlmQueryTransactionsInput {
  startDate: string;
  endDate: string;
  accountIds?: string[];
  categoryIds?: string[];
  searchText?: string;
  groupBy?: LlmQueryGroupBy;
  direction?: LlmQueryDirection;
}

/**
 * The income, expense and net totals an AI or MCP caller reads, in ONE currency.
 *
 * Every row is converted into `totalsCurrency` at the rate for its own
 * transaction date (INV-FX-001, historical mode) before it is added. When any
 * row has no admissible rate the three totals are `null` -- a total with an
 * unconverted component is not a total -- and the partial sums travel in the
 * `known*Subtotal` fields beside the pairs to repair (`missingRatePairs`, as
 * `from->to`). `fxComplete` is the contract a caller reads with `=== false`.
 */
export interface LlmConvertedFlowFields {
  currency?: string;
  totalIncome: number | null;
  totalExpenses: number | null;
  netCashFlow: number | null;
  knownIncomeSubtotal: number;
  knownExpensesSubtotal: number;
  totalsCurrency: string;
  fxComplete: boolean;
  missingRatePairs: string[];
}

export interface LlmQueryTransactionsResult extends LlmConvertedFlowFields {
  transactionCount: number;
  /** Per-currency and NOT converted: each entry is in its own currency. */
  byCurrency?: Record<
    string,
    {
      totalIncome: number;
      totalExpenses: number;
      netCashFlow: number;
      transactionCount: number;
    }
  >;
  breakdown?: unknown;
}

/**
 * Input for the unified `list_transactions` summary. Folds the filters of
 * `search_transactions` (search/amount/payee), the grouped breakdown of
 * `query_transactions`, and the per-account transfer rollup of `get_transfers`
 * into one shape. Callers resolve account/category/payee names to IDs first.
 */
export interface LlmListTransactionsInput {
  startDate: string;
  endDate: string;
  accountIds?: string[];
  categoryIds?: string[];
  payeeIds?: string[];
  searchText?: string;
  minAmount?: number;
  maxAmount?: number;
  direction?: LlmQueryDirection;
  groupBy?: LlmListGroupBy;
  transfersOnly?: boolean;
}

export interface LlmListTransactionsResult extends LlmConvertedFlowFields {
  transactionCount: number;
  /** Per-currency and NOT converted: each entry is in its own currency. */
  byCurrency?: Record<
    string,
    {
      totalIncome: number;
      totalExpenses: number;
      netCashFlow: number;
      transactionCount: number;
    }
  >;
  groupedBy: LlmListGroupBy;
  breakdown?: unknown;
  transfers?: TransfersByAccountResult;
}

export type LlmComparisonGroupBy = "category" | "payee";
export type LlmComparisonDirection = "expenses" | "income" | "both";

export interface LlmPeriodComparisonInput {
  basis?: ReportingBasis;
  period1Start: string;
  period1End: string;
  period2Start: string;
  period2End: string;
  groupBy?: LlmComparisonGroupBy;
  direction?: LlmComparisonDirection;
}

/**
 * One side of a period comparison, in `totalsCurrency`. `total` is `null` while
 * a row of the period has no rate; `knownSubtotal` is what did convert.
 */
export interface LlmComparisonPeriodTotal {
  start: string;
  end: string;
  total: number | null;
  knownSubtotal: number;
}

export interface LlmPeriodComparisonResult {
  currency?: string;
  basis?: ReportingBasis;
  period1: LlmComparisonPeriodTotal;
  period2: LlmComparisonPeriodTotal;
  /** `null` unless both periods converted completely. */
  totalChange: number | null;
  /** `null` unless both periods converted completely. */
  totalChangePercent: number | null;
  totalsCurrency: string;
  fxComplete: boolean;
  missingRatePairs: string[];
  /** Each row's amounts are the rows that converted (see `fxComplete`). */
  comparison: Array<{
    label: string;
    period1Amount: number;
    period2Amount: number;
    change: number;
    changePercent: number;
  }>;
}

@Injectable()
export class TransactionAnalyticsService {
  private readonly logger = new Logger(TransactionAnalyticsService.name);

  constructor(private dataSource: DataSource) {}

  /**
   * Per-account transfer activity between the user's own accounts for a date
   * range. Shared by the AI Assistant's tool executor and the MCP server so
   * both surfaces return the same shape. `inbound` counts positive-sign
   * transfer rows (money received), `outbound` counts the absolute value of
   * negative-sign rows (money sent). When no account filter is applied,
   * `totalInbound` equals `totalOutbound` (modulo multi-currency conversions)
   * because every transfer is stored as two linked rows, one on each side.
   */
  @ReportingRead("cash")
  async getTransfersByAccount(
    userId: string,
    startDate: string,
    endDate: string,
    accountIds?: string[],
  ): Promise<TransfersByAccountResult> {
    return withScopedDb(this.dataSource, async (m) => {
      const qb = m
        .getRepository(Transaction)
        .createQueryBuilder("t")
        .leftJoin("t.account", "transferAccount")
        .select("transferAccount.name", "accountName")
        .addSelect("transferAccount.id", "accountId")
        .addSelect("t.currencyCode", "currencyCode")
        .addSelect(
          "SUM(CASE WHEN t.amount > 0 THEN t.amount ELSE 0 END)",
          "inbound",
        )
        .addSelect(
          "SUM(CASE WHEN t.amount < 0 THEN ABS(t.amount) ELSE 0 END)",
          "outbound",
        )
        .addSelect("COUNT(*)", "count")
        .where("t.userId = :userId", { userId })
        .andWhere("t.isTransfer = true")
        .andWhere("t.transactionDate >= :startDate", { startDate })
        .andWhere("t.transactionDate <= :endDate", { endDate })
        .andWhere("t.status != 'VOID'")
        .groupBy("transferAccount.id")
        .addGroupBy("transferAccount.name")
        .addGroupBy("t.currencyCode")
        .orderBy("transferAccount.name", "ASC");

      if (accountIds && accountIds.length > 0) {
        qb.andWhere("t.accountId IN (:...accountIds)", { accountIds });
      }

      const rows = await reportingSummaryRows(
        m,
        userId,
        qb,
        currentReportingRead(userId)!.currency,
        "inbound",
        "outbound",
      );

      const accountRows = new Map<string, TransferAccountSummary>();
      for (const r of rows) {
        const inbound = roundMoney(Number(r.inbound) || 0);
        const outbound = roundMoney(Number(r.outbound) || 0);
        const key = JSON.stringify([r.accountId, r.currencyCode]);
        const previous = accountRows.get(key);
        accountRows.set(key, {
          accountId: r.accountId ?? null,
          accountName: r.accountName,
          currency: r.currencyCode,
          inbound: sumMoney([previous?.inbound ?? 0, inbound]),
          outbound: sumMoney([previous?.outbound ?? 0, outbound]),
          net: sumMoney([previous?.net ?? 0, inbound, -outbound]),
          transferCount:
            (previous?.transferCount ?? 0) + (Number(r.count) || 0),
        });
      }
      const accounts = [...accountRows.values()];

      return {
        accounts,
        currency: currentReportingRead(userId)!.currency,
        fxComplete: true,
        totalInbound: sumMoney(
          rows.map((r) => Number(r.convertedIncome ?? r.inbound)),
        ),
        totalOutbound: sumMoney(
          rows.map((r) => Number(r.convertedExpenses ?? r.outbound)),
        ),
        transferCount: accounts.reduce((s, a) => s + a.transferCount, 0),
      };
    });
  }

  /**
   * The payees and categories actually used by the rows in the given accounts.
   *
   * A split's category lives on the split row, not on its parent (whose
   * `categoryId` is NULL), so both are read -- the register's own category
   * filter matches split lines, and a picker that could not offer those
   * categories would be narrower than the filter it feeds.
   */
  @ReportingRead("cash")
  async getRegisterFilterOptions(
    userId: string,
    filters: { accountIds?: string[]; jointAccountIds?: string[] } = {},
  ): Promise<RegisterFilterOptions> {
    const { accountIds, jointAccountIds = [] } = filters;
    return withScopedDb(this.dataSource, async (m) => {
      const scoped = <T extends object>(
        qb: import("typeorm").SelectQueryBuilder<T>,
      ) => {
        qb.where(this.analyticsScope(userId, jointAccountIds));
        if (accountIds && accountIds.length > 0) {
          qb.andWhere("transaction.accountId IN (:...filterAccountIds)", {
            filterAccountIds: accountIds,
          });
        }
        return qb;
      };

      const payeeRows = await reportingRawMany<{ id: string; name: string }>(
        m,
        userId,
        scoped(
          m
            .getRepository(Transaction)
            .createQueryBuilder("transaction")
            .innerJoin("transaction.payee", "payee")
            .select("payee.id", "id")
            .addSelect("payee.name", "name")
            .distinct(true),
        ).orderBy("payee.name", "ASC"),
      );

      const ownCategoryRows = await reportingRawMany<{ id: string }>(
        m,
        userId,
        scoped(
          m
            .getRepository(Transaction)
            .createQueryBuilder("transaction")
            .select("transaction.categoryId", "id")
            .distinct(true),
        ).andWhere("transaction.categoryId IS NOT NULL"),
      );

      const splitCategoryRows = await reportingRawMany<{ id: string }>(
        m,
        userId,
        scoped(
          m
            .getRepository(Transaction)
            .createQueryBuilder("transaction")
            .innerJoin("transaction.splits", "split")
            .select("split.categoryId", "id")
            .distinct(true),
        ).andWhere("split.categoryId IS NOT NULL"),
      );

      const usedCategoryIds = new Set(
        [...ownCategoryRows, ...splitCategoryRows].map((r) => r.id),
      );
      if (usedCategoryIds.size === 0) {
        return { payees: payeeRows, categories: [] };
      }

      // The whole tree, so an ancestor can be resolved without a query per
      // level. A user's chart of accounts is tens to hundreds of rows.
      const allCategories = await m.getRepository(Category).find({
        where: { userId },
        select: { id: true, name: true, parentId: true },
      });
      const byId = new Map(allCategories.map((c) => [c.id, c]));

      const includedIds = new Set<string>();
      for (const usedId of usedCategoryIds) {
        // Walk up from each used category. `seen` stops a cycle -- a parent
        // chain is data, and a self-referential row would otherwise hang here.
        const seen = new Set<string>();
        let current = byId.get(usedId);
        while (current && !seen.has(current.id)) {
          seen.add(current.id);
          includedIds.add(current.id);
          current = current.parentId ? byId.get(current.parentId) : undefined;
        }
      }

      const categories = allCategories
        .filter((c) => includedIds.has(c.id))
        .map((c) => ({ id: c.id, name: c.name, parentId: c.parentId ?? null }))
        .sort((a, b) => a.name.localeCompare(b.name));

      return { payees: payeeRows, categories };
    });
  }

  @ReportingRead()
  async getSummary(
    userId: string,
    accountIds?: string[],
    startDate?: string,
    endDate?: string,
    categoryIds?: string[],
    payeeIds?: string[],
    search?: string,
    amountFrom?: number,
    amountTo?: number,
    excludeInvestmentLinked?: boolean,
    excludeTransfers?: boolean,
    tagIds?: string[],
    jointAccountIds?: string[],
    nativeCurrencyBuckets = false,
  ): Promise<{
    currency?: string;
    fxComplete?: boolean;
    totalIncome: number;
    totalExpenses: number;
    netCashFlow: number;
    transactionCount: number;
    firstTransactionDate: string | null;
    lastTransactionDate: string | null;
    byCurrency: Record<
      string,
      {
        totalIncome: number;
        totalExpenses: number;
        netCashFlow: number;
        transactionCount: number;
      }
    >;
  }> {
    return withScopedDb(this.dataSource, async (m) => {
      const queryBuilder = await this.createFilteredAnalyticsQuery(m, userId, {
        accountIds,
        startDate,
        endDate,
        categoryIds,
        payeeIds,
        search,
        amountFrom,
        amountTo,
        excludeInvestmentLinked,
        excludeTransfers,
        tagIds,
        jointAccountIds,
      });

      // Use the split amount when the row came from the splits join;
      // otherwise the transaction's own amount. A split parent's `amount`
      // equals the sum of its splits, so only one of the two contributes
      // per row.
      const amountExpr = "COALESCE(splits.amount, transaction.amount)";

      queryBuilder
        .select("transaction.currencyCode", "currencyCode")
        .addSelect(
          `SUM(CASE WHEN ${amountExpr} > 0 THEN ${amountExpr} ELSE 0 END)`,
          "totalIncome",
        )
        .addSelect(
          `SUM(CASE WHEN ${amountExpr} < 0 THEN ABS(${amountExpr}) ELSE 0 END)`,
          "totalExpenses",
        )
        .addSelect("COUNT(DISTINCT transaction.id)", "transactionCount")
        .addSelect(
          "TO_CHAR(MIN(transaction.transactionDate), 'YYYY-MM-DD')",
          "firstDate",
        )
        .addSelect(
          "TO_CHAR(MAX(transaction.transactionDate), 'YYYY-MM-DD')",
          "lastDate",
        )
        .groupBy("transaction.currencyCode");

      const rows = await reportingSummaryRows(
        m,
        userId,
        queryBuilder,
        currentReportingRead(userId)!.currency,
        "totalIncome",
        "totalExpenses",
        nativeCurrencyBuckets,
      );

      let totalIncome = 0;
      let totalExpenses = 0;
      let transactionCount = 0;
      let firstTransactionDate: string | null = null;
      let lastTransactionDate: string | null = null;
      const byCurrency: Record<
        string,
        {
          totalIncome: number;
          totalExpenses: number;
          netCashFlow: number;
          transactionCount: number;
        }
      > = {};

      const seen = new Set<string>();
      for (const [index, row] of rows.entries()) {
        const income = Number(row.totalIncome) || 0;
        const expenses = Number(row.totalExpenses) || 0;
        const count = Number(row.transactionCount) || 0;
        totalIncome = sumMoney([
          totalIncome,
          Number(row.convertedIncome ?? income),
        ]);
        totalExpenses = sumMoney([
          totalExpenses,
          Number(row.convertedExpenses ?? expenses),
        ]);
        const identity = row.__sourceId ?? String(index);
        const increment = seen.has(identity) ? 0 : count;
        seen.add(identity);
        transactionCount += increment;
        // ISO date strings compare correctly as strings, so the min/max
        // across per-currency rows reduces with a plain comparison.
        if (
          row.firstDate &&
          (!firstTransactionDate || row.firstDate < firstTransactionDate)
        ) {
          firstTransactionDate = row.firstDate;
        }
        if (
          row.lastDate &&
          (!lastTransactionDate || row.lastDate > lastTransactionDate)
        ) {
          lastTransactionDate = row.lastDate;
        }
        if (row.currencyCode) {
          const previous = byCurrency[row.currencyCode];
          const nativeIncome = sumMoney([previous?.totalIncome ?? 0, income]);
          const nativeExpenses = sumMoney([
            previous?.totalExpenses ?? 0,
            expenses,
          ]);
          byCurrency[row.currencyCode] = {
            totalIncome: nativeIncome,
            totalExpenses: nativeExpenses,
            netCashFlow: roundMoney(nativeIncome - nativeExpenses),
            transactionCount: (previous?.transactionCount ?? 0) + increment,
          };
        }
      }

      return {
        currency: currentReportingRead(userId)!.currency,
        fxComplete: true,
        totalIncome,
        totalExpenses,
        netCashFlow: roundMoney(totalIncome - totalExpenses),
        transactionCount,
        firstTransactionDate,
        lastTransactionDate,
        byCurrency,
      };
    });
  }

  /**
   * The analytics read scope, mirroring the register's (joint-accounts spec):
   * the user's own rows plus rows in accounts jointly shared to them.
   * `jointAccountIds` is the already-authorized joint set computed by the
   * controller, never raw request input. An empty joint set reproduces the old
   * owner-only predicate exactly, so non-joint traffic is untouched.
   */
  private analyticsScope(userId: string, jointAccountIds: string[]): Brackets {
    return new Brackets((qb) => {
      qb.where("transaction.userId = :analyticsScopeUserId", {
        analyticsScopeUserId: userId,
      });
      if (jointAccountIds.length > 0) {
        qb.orWhere("transaction.accountId IN (:...analyticsScopeJointIds)", {
          analyticsScopeJointIds: jointAccountIds,
        });
      }
    });
  }

  /**
   * Base query shared by {@link getSummary} and {@link getGroupedTotals}:
   * applies the full transaction-list filter surface (accounts incl. the
   * brokerage exclusion, dates, categories with descendant expansion and
   * the `uncategorized`/`transfer` pseudo-ids, payees, search, amount
   * range, tags) with splits always joined so split transactions count
   * per matching split via `COALESCE(splits.amount, transaction.amount)`.
   *
   * `jointAccountIds` widens the ownership predicate only; category
   * descendant expansion still resolves against `userId`'s own tree, so a
   * caller that both filters by category and widens by joint ids must pass
   * the owning user (which is what the single-joint-account path does).
   */
  private async createFilteredAnalyticsQuery(
    m: EntityManager,
    userId: string,
    filters: {
      accountIds?: string[];
      startDate?: string;
      endDate?: string;
      categoryIds?: string[];
      payeeIds?: string[];
      search?: string;
      amountFrom?: number;
      amountTo?: number;
      excludeInvestmentLinked?: boolean;
      excludeTransfers?: boolean;
      tagIds?: string[];
      includeUnreconciledBeforeStart?: boolean;
      jointAccountIds?: string[];
    },
  ) {
    const {
      accountIds,
      startDate,
      endDate,
      categoryIds,
      payeeIds,
      search,
      amountFrom,
      amountTo,
      excludeInvestmentLinked,
      excludeTransfers,
      tagIds,
      includeUnreconciledBeforeStart,
      jointAccountIds,
    } = filters;

    const queryBuilder = m
      .getRepository(Transaction)
      .createQueryBuilder("transaction")
      .where(this.analyticsScope(userId, jointAccountIds ?? []));

    // Join account for filtering and uncategorized conditions.
    // Use the same exclusion logic as findAll() so the summary
    // counts/totals match the transaction list.
    queryBuilder.leftJoin("transaction.account", "summaryAccount");

    queryBuilder.andWhere(brokerageExclusionForEntity("summaryAccount"));

    // Always expand split transactions so mixed-sign splits are bucketed
    // into income/expense per split. A split parent carries `amount =
    // SUM(splits)`, so summing the parent row nets opposite-sign splits
    // together and under-counts both totalIncome and totalExpenses.
    // Filter out transfer splits -- they're movements between own
    // accounts, not spending or income.
    queryBuilder.leftJoin("transaction.splits", "splits");
    queryBuilder.andWhere(
      "(splits.transferAccountId IS NULL OR splits.id IS NULL)",
    );
    // ...and an embedded investment line is the trade's own cash side, not
    // ordinary cash. Unconditional, unlike excludeInvestmentLinked below: that
    // flag is about whole rows a caller may want to see, while this line's
    // amount would otherwise land in the NULL "Uncategorized" bucket of every
    // grouped total -- whose drill-down (the register filtered to
    // uncategorized) excludes it, so the two disagreed by the trade amount.
    queryBuilder.andWhere(investmentLinkedSplitExclusion("splits"));

    // Optionally exclude cash-side transactions created as a side-effect
    // of an investment BUY/SELL/DIVIDEND. Those transactions live in the
    // linked cash account (so the account-subtype filter above can't see
    // them), carry no category, and have no transfer flag -- so they
    // leak into expense/income totals as "uncategorised" spending.
    if (excludeInvestmentLinked) {
      queryBuilder.andWhere(
        investmentLinkedTransactionExclusion("transaction"),
      );
    }

    // Optionally exclude transfers between own accounts. These net to
    // zero across both sides but inflate per-side income/expense totals,
    // so AI and analytics callers asking "how much did I spend" want
    // them out. Callers that include "transfer" as a pseudo-category
    // below must not set this flag, or the OR clause will match nothing.
    if (excludeTransfers) {
      queryBuilder.andWhere("transaction.isTransfer = false");
    }

    if (accountIds && accountIds.length > 0) {
      queryBuilder.andWhere("transaction.accountId IN (:...accountIds)", {
        accountIds,
      });
    }

    if (startDate) {
      if (includeUnreconciledBeforeStart) {
        // Credit-card "spending this cycle" widget: also count charges dated
        // before the cycle start that have not yet been reconciled onto a
        // statement. They usually posted late but still belong to what is
        // owed. Reconciled and voided prior transactions stay excluded; a NULL
        // status predates the status column and counts as unreconciled.
        queryBuilder.andWhere(
          new Brackets((qb) => {
            qb.where("transaction.transactionDate >= :startDate", {
              startDate,
            }).orWhere(
              "(transaction.status IS NULL OR transaction.status NOT IN ('RECONCILED', 'VOID'))",
            );
          }),
        );
      } else {
        queryBuilder.andWhere("transaction.transactionDate >= :startDate", {
          startDate,
        });
      }
    }

    if (endDate) {
      queryBuilder.andWhere("transaction.transactionDate <= :endDate", {
        endDate,
      });
    }

    if (categoryIds && categoryIds.length > 0) {
      const hasUncategorized = categoryIds.includes("uncategorized");
      const hasTransfer = categoryIds.includes("transfer");
      const regularCategoryIds = categoryIds.filter(
        (id) => id !== "uncategorized" && id !== "transfer",
      );

      let hasCondition = false;

      if (hasUncategorized || hasTransfer || regularCategoryIds.length > 0) {
        const uniqueCategoryIds =
          regularCategoryIds.length > 0
            ? await getAllCategoryIdsWithChildren(
                m.getRepository(Category),
                userId,
                regularCategoryIds,
              )
            : [];

        queryBuilder.andWhere(
          new Brackets((qb) => {
            if (hasUncategorized) {
              const method = hasCondition ? "orWhere" : "where";
              hasCondition = true;
              qb[method](
                new Brackets((unc) => {
                  unc
                    .where(
                      `transaction.categoryId IS NULL AND transaction.isSplit = false AND transaction.isTransfer = false AND ${investmentLinkedTransactionExclusion(
                        "transaction",
                      )}`,
                    )
                    // A split transaction counts as uncategorised when any of
                    // its non-transfer split lines has no category (transfer
                    // splits are already excluded by the base query), matching
                    // the category breakdown grouping.
                    .orWhere(
                      `transaction.isSplit = true AND transaction.isTransfer = false AND splits.categoryId IS NULL AND ${investmentLinkedSplitExclusion(
                        "splits",
                      )}`,
                    );
                }),
              );
            }
            if (hasTransfer) {
              const method = hasCondition ? "orWhere" : "where";
              hasCondition = true;
              qb[method]("transaction.isTransfer = true");
            }
            if (uniqueCategoryIds.length > 0) {
              const method = hasCondition ? "orWhere" : "where";
              hasCondition = true;
              qb[method](
                new Brackets((inner) => {
                  inner
                    .where(
                      "transaction.categoryId IN (:...summaryCategoryIds)",
                      { summaryCategoryIds: uniqueCategoryIds },
                    )
                    .orWhere("splits.categoryId IN (:...summaryCategoryIds)", {
                      summaryCategoryIds: uniqueCategoryIds,
                    });
                }),
              );
            }
          }),
        );
      }
    }

    if (payeeIds && payeeIds.length > 0) {
      queryBuilder.andWhere("transaction.payeeId IN (:...payeeIds)", {
        payeeIds,
      });
    }

    // Split grain on the joined `splits` alias: the totals count the
    // matching lines, as the register draws them.
    await applyTransactionSearch(m, queryBuilder, search, {
      userId,
      transaction: "transaction",
      splits: "splits",
      grain: "split",
      paramPrefix: "srch",
    });

    if (amountFrom !== undefined) {
      queryBuilder.andWhere("transaction.amount >= :amountFrom", {
        amountFrom,
      });
    }

    if (amountTo !== undefined) {
      queryBuilder.andWhere("transaction.amount <= :amountTo", { amountTo });
    }

    if (tagIds && tagIds.length > 0) {
      queryBuilder.leftJoin("transaction.tags", "filterTags");
      queryBuilder.leftJoin("splits.tags", "filterSplitTags");
      queryBuilder.andWhere(
        new Brackets((qb) => {
          qb.where("filterTags.id IN (:...summaryTagIds)", {
            summaryTagIds: tagIds,
          }).orWhere("filterSplitTags.id IN (:...summaryTagIds)", {
            summaryTagIds: tagIds,
          });
        }),
      );
    }

    return queryBuilder;
  }

  /**
   * Totals grouped by category or payee under the same filter semantics
   * as {@link getSummary}, so a widget's breakdown reconciles with its
   * headline summary and with the transaction list. Rows are keyed by
   * entity id (null = uncategorized / no payee) and split per currency;
   * `total` keeps its sign so income and refunds remain visible.
   *
   * Unlike the private LLM breakdown, this returns ids (rows must be
   * clickable in the UI) and applies no minimum-count aggregation.
   */
  @ReportingRead()
  async getGroupedTotals(
    userId: string,
    params: {
      groupBy: "category" | "payee";
      accountIds?: string[];
      startDate?: string;
      endDate?: string;
      categoryIds?: string[];
      payeeIds?: string[];
      tagIds?: string[];
      search?: string;
      amountFrom?: number;
      amountTo?: number;
      limit?: number;
      includeUnreconciledBeforeStart?: boolean;
      jointAccountIds?: string[];
    },
  ): Promise<
    Array<{
      id: string | null;
      name: string | null;
      currencyCode: string;
      total: number;
      count: number;
    }>
  > {
    return withScopedDb(this.dataSource, async (m) => {
      const { groupBy, limit, ...filters } = params;

      const queryBuilder = await this.createFilteredAnalyticsQuery(
        m,
        userId,
        filters,
      );

      const amountExpr = "COALESCE(splits.amount, transaction.amount)";

      if (groupBy === "category") {
        // A split row's own category wins over the parent transaction's.
        const idExpr = "COALESCE(splits.categoryId, transaction.categoryId)";
        queryBuilder
          .leftJoin("transaction.category", "groupCat")
          .leftJoin("splits.category", "groupSplitCat")
          .select(idExpr, "id")
          .addSelect("COALESCE(groupSplitCat.name, groupCat.name)", "name")
          .groupBy(idExpr)
          .addGroupBy("COALESCE(groupSplitCat.name, groupCat.name)")
          // Transfers are movements between own accounts, not spending, so a
          // transfer with no category must not swell the "Uncategorized" bucket.
          // This matches the transaction-list filter, which excludes transfers
          // from "uncategorized". A transfer carrying an optional category still
          // shows under that category.
          .andWhere(
            new Brackets((qb) => {
              qb.where(`${idExpr} IS NOT NULL`).orWhere(
                "transaction.isTransfer = false",
              );
            }),
          );
      } else {
        queryBuilder
          .leftJoin("transaction.payee", "groupPayee")
          .select("transaction.payeeId", "id")
          .addSelect("COALESCE(groupPayee.name, transaction.payeeName)", "name")
          .groupBy("transaction.payeeId")
          .addGroupBy("COALESCE(groupPayee.name, transaction.payeeName)");
      }

      queryBuilder
        .addSelect("transaction.currencyCode", "currencyCode")
        .addSelect(`SUM(${amountExpr})`, "total")
        .addSelect("COUNT(DISTINCT transaction.id)", "count")
        .addGroupBy("transaction.currencyCode")
        .orderBy(`SUM(ABS(${amountExpr}))`, "DESC")
        .limit(Math.min(Math.max(limit ?? 100, 1), 500));

      const rows = await reportingRawMany(m, userId, queryBuilder);

      return rows.map((row) => ({
        id: row.id ?? null,
        name: row.name ?? null,
        currencyCode: row.currencyCode,
        total: roundMoney(Number(row.total) || 0),
        count: Number(row.count) || 0,
      }));
    });
  }

  /**
   * Spending broken down by the VALUE of a single KEY:VALUE tag key, over the
   * standard transaction-list filter surface. Each transaction's absolute
   * amount is attributed to the value(s) of its own `<key>:*` tags (a
   * transaction tagged both `country:usa` and `country:poland` counts under
   * each, so shares can sum past 100%). Split amounts are summed via
   * `COALESCE(splits.amount, transaction.amount)`, so split transactions still
   * total correctly; transfers and brokerage side-transactions are excluded by
   * the shared base query. Attribution is transaction-level -- split-level tags
   * are not considered here. Rows are per-currency (like `getGroupedTotals`) so
   * the caller converts to a single display currency.
   */
  @ReportingRead()
  async getTransactionBreakdownByTagKey(
    userId: string,
    key: string,
    params: {
      accountIds?: string[];
      startDate?: string;
      endDate?: string;
      categoryIds?: string[];
      payeeIds?: string[];
      tagIds?: string[];
      search?: string;
      amountFrom?: number;
      amountTo?: number;
      limit?: number;
    } = {},
  ): Promise<
    Array<{
      id: string;
      name: string;
      currencyCode: string;
      total: number;
      count: number;
    }>
  > {
    return withScopedDb(this.dataSource, async (m) => {
      const { limit, ...filters } = params;
      const queryBuilder = await this.createFilteredAnalyticsQuery(
        m,
        userId,
        filters,
      );

      const amountExpr = "COALESCE(splits.amount, transaction.amount)";
      const valueExpr =
        "TRIM(SUBSTRING(brkTag.name FROM POSITION(':' IN brkTag.name) + 1))";

      queryBuilder
        .innerJoin("transaction.tags", "brkTag")
        .andWhere("POSITION(':' IN brkTag.name) > 1")
        .andWhere(
          "LOWER(TRIM(SPLIT_PART(brkTag.name, ':', 1))) = LOWER(:brkKey)",
          {
            brkKey: key.trim(),
          },
        )
        .andWhere(`${valueExpr} <> ''`)
        .select(valueExpr, "value")
        .addSelect("transaction.currencyCode", "currencyCode")
        .addSelect(`SUM(ABS(${amountExpr}))`, "total")
        .addSelect("COUNT(DISTINCT transaction.id)", "count")
        .groupBy(valueExpr)
        .addGroupBy("transaction.currencyCode")
        .orderBy(`SUM(ABS(${amountExpr}))`, "DESC")
        .limit(Math.min(Math.max(limit ?? 100, 1), 500));

      const rows = await reportingRawMany(m, userId, queryBuilder);

      return rows.map((row) => ({
        id: row.value,
        name: row.value,
        currencyCode: row.currencyCode,
        total: roundMoney(Number(row.total) || 0),
        count: Number(row.count) || 0,
      }));
    });
  }

  @ReportingRead()
  async getMonthlyTotals(
    userId: string,
    accountIds?: string[],
    startDate?: string,
    endDate?: string,
    categoryIds?: string[],
    payeeIds?: string[],
    search?: string,
    amountFrom?: number,
    amountTo?: number,
    tagIds?: string[],
    jointAccountIds?: string[],
  ): Promise<Array<{ month: string; total: number; count: number }>> {
    return withScopedDb(this.dataSource, async (m) => {
      // Reuse the same filtered query builder as getSummary so the chart's
      // per-month totals and counts reconcile exactly with the category/payee
      // info widget's headline summary -- identical brokerage exclusion, split
      // expansion, and transfer-split handling. Previously this method duplicated
      // the filter logic with slightly different semantics (no transfer-split
      // exclusion, conditional split join), which let the chart footer count and
      // the widget count diverge and read as a stale/"caching" mismatch.
      // getMonthlyTotals is only called when filters are active (the frontend
      // switches to daily balances otherwise).
      const queryBuilder = await this.createFilteredAnalyticsQuery(m, userId, {
        accountIds,
        startDate,
        endDate,
        categoryIds,
        payeeIds,
        search,
        amountFrom,
        amountTo,
        tagIds,
        jointAccountIds,
      });

      // The splits join is always present, so use the split amount for split
      // transactions (COALESCE falls back to the transaction amount for
      // non-split rows), keeping the per-month total signed for the bar chart.
      const amountExpr = "COALESCE(splits.amount, transaction.amount)";

      queryBuilder
        .select("TO_CHAR(transaction.transactionDate, 'YYYY-MM')", "month")
        .addSelect(`SUM(${amountExpr})`, "total")
        .addSelect("COUNT(DISTINCT transaction.id)", "count")
        .groupBy("month")
        .orderBy("month", "ASC");

      const rows = await reportingMoneyMany(
        m,
        userId,
        queryBuilder,
        currentReportingRead(userId)!.currency,
      );

      return rows.map((row) => ({
        month: row.month,
        total: roundMoney(Number(row.total) || 0),
        count: Number(row.count) || 0,
      }));
    });
  }

  /**
   * Per-month foreign-transaction fee totals for one account, grouped by the
   * currency the transaction was paid in. Rows cover every non-void
   * foreign-entered transaction on the account (original_currency_code set).
   *
   * The fee is recovered per transaction: the bank's fee is folded into
   * `amount` (amount = round(originalAmount x exchangeRate) + fee, with
   * fee <= 0) for both ordinary and split transactions -- a split's category
   * lines simply sum to that fee-inclusive total -- so the fee is
   * round(originalAmount x exchangeRate) - amount in every case. A month whose
   * transactions predate the account's fee percentage sums to 0 rather than
   * being dropped. Fee amounts are returned positive in the account currency.
   */
  @ReportingRead("cash")
  async getFxFeeSummary(
    userId: string,
    accountId: string,
  ): Promise<FxFeeMonthlySummaryRow[]> {
    return withScopedDb(this.dataSource, async (m) => {
      const feeExpr =
        "CASE WHEN transaction.originalAmount IS NULL THEN 0 " +
        "ELSE ROUND(transaction.originalAmount * transaction.exchangeRate, 2) - transaction.amount " +
        "END";

      const rows = await reportingRawMany(
        m,
        userId,
        m
          .getRepository(Transaction)
          .createQueryBuilder("transaction")
          .where("transaction.userId = :userId", { userId })
          .andWhere("transaction.accountId = :accountId", { accountId })
          .andWhere("transaction.originalCurrencyCode IS NOT NULL")
          .andWhere("transaction.parentTransactionId IS NULL")
          .andWhere("transaction.status != :voidStatus", {
            voidStatus: TransactionStatus.VOID,
          })
          .select("TO_CHAR(transaction.transactionDate, 'YYYY-MM')", "month")
          .addSelect("transaction.originalCurrencyCode", "currencyCode")
          .addSelect(`COALESCE(SUM(${feeExpr}), 0)`, "feeTotal")
          .addSelect("COUNT(DISTINCT transaction.id)", "count")
          .groupBy("month")
          .addGroupBy("transaction.originalCurrencyCode")
          .orderBy("month", "ASC")
          .addOrderBy("transaction.originalCurrencyCode", "ASC"),
      );

      return rows.map((row) => ({
        month: row.month,
        currencyCode: row.currencyCode,
        feeTotal: roundMoney(Number(row.feeTotal) || 0),
        count: Number(row.count) || 0,
      }));
    });
  }

  /**
   * Resolve LLM-supplied category names into the IDs used by the transaction
   * filters. The matching itself lives in `resolveCategoryNamePaths`
   * (`categories/category-name.util.ts`), which is also what qualifies the
   * names these tools *emit* -- one definition, so a name the model reads back
   * to us means the category we showed it.
   *
   * Accepts a bare name ("Dining Out"), a parent/child path in any separator
   * and spacing ("Food: Dining Out", "Food/Dining Out", "Food -> Dining Out"),
   * and forgives a wrong parent when the leaf is unique.
   *
   * Returns the matched category IDs (expanded to include descendants so a
   * filter on "Food" naturally catches its subcategories) plus any names we
   * could not match. Callers should treat any `unresolved` entry as a hard
   * failure rather than silently dropping the filter -- otherwise a mistyped
   * category yields "all transactions" instead of an honest error.
   *
   * A name matching several categories -- "Cell Phone" under both "Bills" and
   * "Business" -- is unresolved too, and `suggestions` carries the qualified
   * names it could have meant so the model can ask again precisely. Picking one
   * silently is what this replaces: the answer that comes back is about a
   * category the user never named, and nothing downstream can tell.
   */
  async resolveLlmCategoryIds(
    userId: string,
    categoryNames: string[],
  ): Promise<{
    categoryIds: string[];
    unresolved: string[];
    suggestions: string[];
  }> {
    return withScopedDb(this.dataSource, async (m) => {
      if (categoryNames.length === 0) {
        return { categoryIds: [], unresolved: [], suggestions: [] };
      }

      const allCategories = await m.getRepository(Category).find({
        where: { userId },
        select: ["id", "name", "parentId"],
      });

      const resolutions = resolveCategoryNamePaths(
        allCategories,
        categoryNames,
      );
      const matched = resolutions
        .filter((r) => r.id !== null)
        .map((r) => r.id as string);
      const failures = resolutions.filter((r) => r.id === null);
      const unresolved = failures.map((r) => r.input);

      // For the first unmatched input: the qualified names it could have meant
      // when it was ambiguous, otherwise the closest names by edit distance, so
      // callers can surface a "did you mean?" instead of just "call
      // list_categories".
      const first = failures[0];
      const suggestions = !first
        ? []
        : first.candidates.length > 0
          ? first.candidates
          : suggestQualifiedCategoryNames(allCategories, first.input);

      if (matched.length === 0) {
        return { categoryIds: [], unresolved, suggestions };
      }

      const categoryIds = await getAllCategoryIdsWithChildren(
        m.getRepository(Category),
        userId,
        matched,
      );
      return { categoryIds, unresolved, suggestions };
    });
  }

  /**
   * Transaction summary + optional grouped breakdown shaped for LLM tools.
   * Shared by `ToolExecutorService.queryTransactions` and the MCP server's
   * `query_transactions` tool so both surfaces return the same shape.
   *
   * Callers resolve account/category names to IDs before calling.
   */
  @ReportingRead()
  async getLlmQueryTransactions(
    userId: string,
    input: LlmQueryTransactionsInput,
  ): Promise<LlmQueryTransactionsResult> {
    const summary = await this.getSummary(
      userId,
      input.accountIds,
      input.startDate,
      input.endDate,
      input.categoryIds,
      undefined,
      input.searchText,
      undefined,
      undefined,
      true,
      true,
    );
    const converted = await this.getConvertedFlowTotals(userId, {
      accountIds: input.accountIds,
      startDate: input.startDate,
      endDate: input.endDate,
      categoryIds: input.categoryIds,
      search: input.searchText,
    });

    let breakdown: LlmBreakdown | undefined;
    if (input.groupBy) {
      breakdown = await this.getLlmGroupedBreakdown(
        userId,
        input.startDate,
        input.endDate,
        input.groupBy,
        input.direction,
        input.accountIds,
        input.categoryIds,
        input.searchText,
      );
    }

    const result: LlmQueryTransactionsResult = {
      ...this.convertedFlowFields(converted, breakdown?.fx),
      transactionCount: summary.transactionCount,
    };

    if (Object.keys(summary.byCurrency).length > 1) {
      result.byCurrency = summary.byCurrency;
    }

    if (breakdown !== undefined) {
      result.breakdown = breakdown.rows;
    }

    return result;
  }

  /**
   * Unified transaction summary for the `list_transactions` tool. Composes the
   * existing building blocks: the income/expense/net + per-currency totals from
   * {@link getSummary} (transfers and investment-linked rows excluded so the
   * totals answer "how much did I spend/earn"), an optional grouped breakdown
   * via {@link getLlmGroupedBreakdown} when `groupBy` is a real grouping (not
   * "none"), and an optional per-account transfer rollup via
   * {@link getTransfersByAccount} when `transfersOnly` is set.
   *
   * The headline totals are not `getSummary`'s: that sums each currency's
   * numbers as they stand, so 1,000 USD joined 4,000 PLN as 5,000. They come
   * from {@link getConvertedFlowTotals}, each row converted at the rate for its
   * own date into the user's default currency (`totalsCurrency`), and are
   * `null` while a pair has no rate. `byCurrency` stays the unconverted view.
   *
   * The RAW transaction list is NOT produced here -- tool adapters fetch it
   * separately via `TransactionsService.getLlmTransactionRows` only when asked.
   *
   * Callers resolve account/category/payee names to IDs before calling. Shared
   * by the AI Assistant tool executor and the MCP server so both surfaces
   * return the same shape.
   */
  @ReportingRead("cash")
  async getLlmListTransactions(
    userId: string,
    input: LlmListTransactionsInput,
  ): Promise<LlmListTransactionsResult> {
    const groupBy: LlmListGroupBy = input.groupBy ?? "none";

    const summary = await this.getSummary(
      userId,
      input.accountIds,
      input.startDate,
      input.endDate,
      input.categoryIds,
      input.payeeIds,
      input.searchText,
      input.minAmount,
      input.maxAmount,
      true,
      true,
      undefined,
      undefined,
      // Only counts and native buckets are consumed here. Nullable converted
      // totals are resolved independently below, including missing-rate gaps.
      true,
    );
    const converted = await this.getConvertedFlowTotals(userId, {
      accountIds: input.accountIds,
      startDate: input.startDate,
      endDate: input.endDate,
      categoryIds: input.categoryIds,
      payeeIds: input.payeeIds,
      search: input.searchText,
      amountFrom: input.minAmount,
      amountTo: input.maxAmount,
    });

    let breakdown: LlmBreakdown | undefined;
    if (groupBy !== "none") {
      breakdown = await this.getLlmGroupedBreakdown(
        userId,
        input.startDate,
        input.endDate,
        groupBy,
        input.direction,
        input.accountIds,
        input.categoryIds,
        input.searchText,
        input.payeeIds,
        input.minAmount,
        input.maxAmount,
      );
    }

    const result: LlmListTransactionsResult = {
      ...this.convertedFlowFields(converted, breakdown?.fx),
      transactionCount: summary.transactionCount,
      groupedBy: groupBy,
    };

    if (Object.keys(summary.byCurrency).length > 1) {
      result.byCurrency = summary.byCurrency;
    }

    if (breakdown !== undefined) {
      result.breakdown = breakdown.rows;
    }

    if (input.transfersOnly) {
      result.transfers = await this.getTransfersByAccount(
        userId,
        input.startDate,
        input.endDate,
        input.accountIds,
      );
    }

    return result;
  }

  /**
   * Income and expense totals over the same rows (the same filtered query, so
   * the same filters) as {@link getSummary}, each row converted into the user's
   * default currency at the rate for its own transaction date.
   *
   * Grouped by currency and day so a foreign row is priced on its date and the
   * rates load once for the window (`buildRateIndex`), inside this transaction.
   * Same currency and zero need no rate; a row whose pair has no admissible rate
   * is recorded in the aggregate, never folded in at 1:1.
   */
  private async getConvertedFlowTotals(
    userId: string,
    filters: {
      accountIds?: string[];
      startDate: string;
      endDate: string;
      categoryIds?: string[];
      payeeIds?: string[];
      search?: string;
      amountFrom?: number;
      amountTo?: number;
      /** Default true: the totals answer "how much did I spend/earn". */
      excludeTransfers?: boolean;
    },
  ): Promise<ConvertedFlowTotals> {
    const { excludeTransfers = true, ...scope } = filters;
    return withScopedDb(this.dataSource, async (m) => {
      const reporting = await resolveUserDefaultCurrency(
        this.dataSource,
        userId,
      );
      const qb = await this.createFilteredAnalyticsQuery(m, userId, {
        ...scope,
        excludeInvestmentLinked: true,
        excludeTransfers,
      });

      const amountExpr = "COALESCE(splits.amount, transaction.amount)";
      const dayExpr = "TO_CHAR(transaction.transactionDate, 'YYYY-MM-DD')";
      qb.select("transaction.currencyCode", "currencyCode")
        .addSelect(dayExpr, "txDate")
        .addSelect(
          `SUM(CASE WHEN ${amountExpr} > 0 THEN ${amountExpr} ELSE 0 END)`,
          "totalIncome",
        )
        .addSelect(
          `SUM(CASE WHEN ${amountExpr} < 0 THEN ABS(${amountExpr}) ELSE 0 END)`,
          "totalExpenses",
        )
        .groupBy("transaction.currencyCode")
        .addGroupBy(dayExpr);

      const rows = await this.llmFlowRows(m, userId, qb);
      const rates = await this.loadRateIndex(
        m,
        rows,
        reporting,
        filters.startDate,
        filters.endDate,
      );

      const income = new FxAggregate();
      const expenses = new FxAggregate();
      for (const row of rows) {
        addDatedAmount(
          income,
          Number(row.totalIncome) || 0,
          row,
          reporting,
          rates,
          this.logger,
        );
        addDatedAmount(
          expenses,
          Number(row.totalExpenses) || 0,
          row,
          reporting,
          rates,
          this.logger,
        );
      }
      return { income, expenses, totalsCurrency: reporting };
    });
  }

  /**
   * The income, expense and net totals of a window in the user's default
   * currency, for a surface that shows a month or a recent-activity summary
   * (the MCP `financial-summary` and `recent-transactions` resources). The same
   * rows and filters as {@link getSummary} with investment-linked cash excluded;
   * `excludeTransfers` follows the caller. Same fields, same withholding, as the
   * `list_transactions` totals.
   */
  @ReportingRead("cash")
  async getLlmFlowTotals(
    userId: string,
    filters: { startDate: string; endDate: string; excludeTransfers?: boolean },
  ): Promise<LlmConvertedFlowFields> {
    return this.convertedFlowFields(
      await this.getConvertedFlowTotals(userId, filters),
    );
  }

  /**
   * The totals fields of a list/query result. All three totals are withheld
   * (`null`) when any component, in the totals or in a breakdown beside them,
   * could not be converted; the known parts and the pairs to repair are always
   * there.
   */
  private convertedFlowFields(
    converted: ConvertedFlowTotals,
    breakdownFx?: FxAggregate,
  ): LlmConvertedFlowFields {
    const all = new FxAggregate();
    all.merge(converted.income);
    all.merge(converted.expenses);
    if (breakdownFx) all.merge(breakdownFx);
    const fxComplete = all.isComplete;
    const income = converted.income.knownSubtotal;
    const expenses = converted.expenses.knownSubtotal;
    return {
      totalIncome: fxComplete ? income : null,
      totalExpenses: fxComplete ? expenses : null,
      netCashFlow: fxComplete ? roundMoney(income - expenses) : null,
      knownIncomeSubtotal: income,
      knownExpensesSubtotal: expenses,
      totalsCurrency: converted.totalsCurrency,
      currency: converted.totalsCurrency,
      fxComplete,
      missingRatePairs: all.missingPairs,
    };
  }

  /** Keep entered-rate groups intact until the upstream nullable FX fold. */
  private llmFlowRows(
    m: EntityManager,
    userId: string,
    qb: SelectQueryBuilder<Transaction>,
  ) {
    const alias = qb.alias;
    return reportingRawMany(
      m,
      userId,
      qb
        .addSelect(`${alias}.originalCurrencyCode`, "originalCurrencyCode")
        .addSelect(`${alias}.exchangeRate`, "exchangeRate")
        .addGroupBy(`${alias}.originalCurrencyCode`)
        .addGroupBy(`${alias}.exchangeRate`),
    );
  }

  /** Every stored rate the rows' foreign currencies can need, loaded once. */
  private loadRateIndex(
    m: EntityManager,
    rows: Array<{ currencyCode?: string }>,
    reporting: string,
    startDate: string,
    endDate: string,
  ): Promise<RateIndex> {
    const foreign = new Set<string>();
    for (const row of rows) {
      if (row.currencyCode && row.currencyCode !== reporting) {
        foreign.add(row.currencyCode);
      }
    }
    return buildRateIndex(
      (sql, params) => m.query(sql, params),
      foreign,
      reporting,
      startDate,
      endDate,
    );
  }

  /**
   * Fold per-(group, currency, day) rows into one converted aggregate per
   * group. `keyOf` names the group; the first row seen stands for its label
   * columns.
   */
  private foldGroups(
    rows: RawGroupRow[],
    keyOf: (row: RawGroupRow) => string,
    reporting: string,
    rates: RateIndex,
  ): FoldedGroup[] {
    const groups = new Map<string, FoldedGroup>();
    for (const row of rows) {
      const key = keyOf(row);
      let group = groups.get(key);
      if (!group) {
        group = { first: row, agg: new FxAggregate(), count: 0 };
        groups.set(key, group);
      }
      group.count += Number(row.count) || 0;
      addDatedAmount(
        group.agg,
        Number(row.total) || 0,
        row,
        reporting,
        rates,
        this.logger,
      );
    }
    return [...groups.values()];
  }

  private async getLlmGroupedBreakdown(
    userId: string,
    startDate: string,
    endDate: string,
    groupBy: LlmQueryGroupBy,
    direction: LlmQueryDirection | undefined,
    accountIds?: string[],
    categoryIds?: string[],
    searchText?: string,
    payeeIds?: string[],
    minAmount?: number,
    maxAmount?: number,
  ): Promise<LlmBreakdown> {
    return withScopedDb(this.dataSource, async (m) => {
      const reporting = await resolveUserDefaultCurrency(
        this.dataSource,
        userId,
      );
      const qb = m
        .getRepository(Transaction)
        .createQueryBuilder("t")
        .leftJoin("t.account", "breakdownAccount")
        .where("t.userId = :userId", { userId })
        .andWhere("t.transactionDate >= :startDate", { startDate })
        .andWhere("t.transactionDate <= :endDate", { endDate })
        .andWhere("t.status != 'VOID'")
        .andWhere("t.isTransfer = false")
        .andWhere("t.parentTransactionId IS NULL");

      joinSplitsForAnalytics(qb);
      applyInvestmentTransactionFilters(qb, "breakdownAccount", "t");

      if (direction === "expenses") {
        qb.andWhere(`${SPLIT_AMOUNT} < 0`);
      } else if (direction === "income") {
        qb.andWhere(`${SPLIT_AMOUNT} > 0`);
      }

      if (accountIds && accountIds.length > 0) {
        qb.andWhere("t.accountId IN (:...accountIds)", { accountIds });
      }

      if (categoryIds && categoryIds.length > 0) {
        qb.andWhere(
          "COALESCE(ts.categoryId, t.categoryId) IN (:...categoryIds)",
          { categoryIds },
        );
      }

      if (payeeIds && payeeIds.length > 0) {
        qb.andWhere("t.payeeId IN (:...payeeIds)", { payeeIds });
      }

      if (minAmount !== undefined) {
        qb.andWhere(`${SPLIT_AMOUNT} >= :minAmount`, { minAmount });
      }

      if (maxAmount !== undefined) {
        qb.andWhere(`${SPLIT_AMOUNT} <= :maxAmount`, { maxAmount });
      }

      // The raw string, escaped once inside the builder, so these rows and
      // the summary above read the search identically (INV-SEARCH-005).
      await applyTransactionSearch(m, qb, searchText, {
        userId,
        transaction: "t",
        splits: "ts",
        grain: "split",
        paramPrefix: "srch",
      });

      // Every group is also split by currency and day, so each part can be
      // converted at its own date before it is added to its group.
      const byCurrencyAndDay = () =>
        qb
          .addSelect("t.currencyCode", "currencyCode")
          .addSelect(DAY_SQL, "txDate")
          .addGroupBy("t.currencyCode")
          .addGroupBy(DAY_SQL);
      const fx = new FxAggregate();
      const finish = (groups: FoldedGroup[]) => {
        for (const g of groups) fx.merge(g.agg);
      };

      switch (groupBy) {
        case "category": {
          // Grouping is on the category id, not the display name: "Cell Phone"
          // exists under both "Bills" and "Business" for plenty of users, and
          // grouping by name merged the two into one row whose id was an
          // arbitrary member -- a total the user cannot reconcile against
          // either category, deep-linking to one of them. The id is exact now,
          // and the label carries the parent so two rows named "Cell Phone" can
          // be told apart. The "Uncategorized" bucket groups on a NULL id.
          qb.select(`${SPLIT_CATEGORY_ID}::text`, "categoryId")
            .addSelect(`SUM(ABS(${SPLIT_AMOUNT}))`, "total")
            .addSelect("COUNT(*)", "count")
            .groupBy(`${SPLIT_CATEGORY_ID}::text`);
          byCurrencyAndDay();

          const rows = await this.llmFlowRows(m, userId, qb);
          const rates = await this.loadRateIndex(
            m,
            rows,
            reporting,
            startDate,
            endDate,
          );
          const names = await loadQualifiedCategoryNames(m, userId);
          const groups = this.foldGroups(
            rows,
            (r) => r.categoryId ?? "",
            reporting,
            rates,
          );
          finish(groups);
          return {
            fx,
            rows: byKnownSubtotal(
              groups.map((g) => ({
                category: g.first.categoryId
                  ? (names.get(g.first.categoryId) ?? UNKNOWN_CATEGORY_LABEL)
                  : UNCATEGORIZED_LABEL,
                categoryId: g.first.categoryId ?? null,
                ...totalFields(g.agg),
                count: g.count,
              })),
            ),
          };
        }

        case "payee": {
          // Grouping stays on the denormalized name string; MIN() attaches a
          // payee id where one exists. Free-text payees (no payee record) and
          // the "Unknown" bucket yield null, so no deep-link is offered.
          qb.select("COALESCE(t.payeeName, 'Unknown')", "label")
            .addSelect("MIN(t.payeeId::text)", "payeeId")
            .addSelect(`SUM(ABS(${SPLIT_AMOUNT}))`, "total")
            .addSelect("COUNT(*)", "count")
            .groupBy("t.payeeName");
          byCurrencyAndDay();

          const rows = await this.llmFlowRows(m, userId, qb);
          const rates = await this.loadRateIndex(
            m,
            rows,
            reporting,
            startDate,
            endDate,
          );
          // The per-day rows each carry their own MIN; the group's is the
          // least of them, as the single-row query returned before.
          const payeeIds = new Map<string, string>();
          for (const r of rows) {
            const seen = payeeIds.get(r.label);
            if (r.payeeId && (seen === undefined || r.payeeId < seen)) {
              payeeIds.set(r.label, r.payeeId);
            }
          }
          const groups = this.foldGroups(
            rows,
            (r) => r.label,
            reporting,
            rates,
          );
          finish(groups);
          return {
            fx,
            rows: enforcePayeeAggregationThreshold(
              groups.map((g) => ({
                payee: g.first.label,
                payeeId: payeeIds.get(g.first.label) ?? null,
                agg: g.agg,
                count: g.count,
              })),
            ),
          };
        }

        case "year":
        case "month":
        case "week": {
          const periodExpr =
            groupBy === "year"
              ? "TO_CHAR(t.transactionDate, 'YYYY')"
              : groupBy === "month"
                ? "TO_CHAR(t.transactionDate, 'YYYY-MM')"
                : "TO_CHAR(DATE_TRUNC('week', t.transactionDate), 'YYYY-MM-DD')";
          qb.select(periodExpr, "period")
            .addSelect(`SUM(ABS(${SPLIT_AMOUNT}))`, "total")
            .addSelect("COUNT(*)", "count")
            .groupBy(periodExpr);
          byCurrencyAndDay();

          const rows = await this.llmFlowRows(m, userId, qb);
          const rates = await this.loadRateIndex(
            m,
            rows,
            reporting,
            startDate,
            endDate,
          );
          const groups = this.foldGroups(
            rows,
            (r) => r.period,
            reporting,
            rates,
          );
          finish(groups);
          return {
            fx,
            rows: groups
              .sort((a, b) => (a.first.period < b.first.period ? -1 : 1))
              .map((g) => ({
                [groupBy]: g.first.period,
                ...totalFields(g.agg),
                count: g.count,
              })),
          };
        }
      }
    });
  }

  /**
   * Compare two date ranges side-by-side, grouped by category or payee.
   * Shared by `ToolExecutorService.comparePeriods` and the MCP tool.
   *
   * Every row is converted into the user's default currency (`totalsCurrency`)
   * at the rate for its own date before it joins its group, so the periods are
   * comparable. A period whose rows include a pair with no rate has a `null`
   * total, which makes `totalChange` and `totalChangePercent` `null` too: the
   * change between a total and a subtotal is not a change. When both periods
   * hold only same-currency rows the figures are as they always were.
   *
   * `totalChangePercent` is `0` when the first period's total is `0`, as it
   * always was; a row's own `changePercent` is `100` for a label new in the
   * second period.
   */
  @ReportingRead(undefined, false, 0)
  async getLlmPeriodComparison(
    userId: string,
    input: LlmPeriodComparisonInput,
  ): Promise<LlmPeriodComparisonResult> {
    const groupBy = input.groupBy ?? "category";
    const direction = input.direction ?? "expenses";

    const [period1, period2] = await Promise.all([
      this.getComparisonPeriodData(
        userId,
        input.period1Start,
        input.period1End,
        groupBy,
        direction,
      ),
      this.getComparisonPeriodData(
        userId,
        input.period2Start,
        input.period2End,
        groupBy,
        direction,
      ),
    ]);

    const allLabels = new Set([
      ...period1.items.map((i) => i.label),
      ...period2.items.map((i) => i.label),
    ]);

    const p1Map = new Map(
      period1.items.map((i) => [i.label, i.agg.knownSubtotal]),
    );
    const p2Map = new Map(
      period2.items.map((i) => [i.label, i.agg.knownSubtotal]),
    );

    const comparison = Array.from(allLabels).map((label) => {
      const p1Amount = roundMoney(p1Map.get(label) || 0);
      const p2Amount = roundMoney(p2Map.get(label) || 0);
      const change = roundMoney(p2Amount - p1Amount);
      const changePercent =
        p1Amount !== 0
          ? Math.round((change / p1Amount) * 10000) / 100
          : p2Amount !== 0
            ? 100
            : 0;

      return {
        label,
        period1Amount: p1Amount,
        period2Amount: p2Amount,
        change,
        changePercent,
      };
    });

    comparison.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));

    const both = new FxAggregate();
    both.merge(period1.total);
    both.merge(period2.total);
    const p1Total = period1.total.knownSubtotal;
    const p2Total = period2.total.knownSubtotal;
    const fxComplete = both.isComplete;
    const totalChange = fxComplete ? roundMoney(p2Total - p1Total) : null;
    const totalChangePercent =
      totalChange === null
        ? null
        : p1Total !== 0
          ? Math.round((totalChange / p1Total) * 10000) / 100
          : 0;

    return {
      basis: currentReportingRead(userId)?.basis,
      currency: period1.totalsCurrency,
      period1: {
        start: input.period1Start,
        end: input.period1End,
        total: period1.total.total,
        knownSubtotal: p1Total,
      },
      period2: {
        start: input.period2Start,
        end: input.period2End,
        total: period2.total.total,
        knownSubtotal: p2Total,
      },
      totalChange,
      totalChangePercent,
      totalsCurrency: period1.totalsCurrency,
      fxComplete,
      missingRatePairs: both.missingPairs,
      comparison,
    };
  }

  private async getComparisonPeriodData(
    userId: string,
    startDate: string,
    endDate: string,
    groupBy: LlmComparisonGroupBy,
    direction: LlmComparisonDirection,
  ): Promise<ComparisonPeriodData> {
    return withScopedDb(this.dataSource, async (m) => {
      const reporting = await resolveUserDefaultCurrency(
        this.dataSource,
        userId,
      );
      const qb = m
        .getRepository(Transaction)
        .createQueryBuilder("t")
        .leftJoin("t.account", "periodAccount")
        .where("t.userId = :userId", { userId })
        .andWhere("t.transactionDate >= :startDate", { startDate })
        .andWhere("t.transactionDate <= :endDate", { endDate })
        .andWhere("t.status != 'VOID'")
        .andWhere("t.isTransfer = false")
        .andWhere("t.parentTransactionId IS NULL");

      joinSplitsForAnalytics(qb);
      applyInvestmentTransactionFilters(qb, "periodAccount", "t");

      // Expenses are the signed sum over rows of both signs, negated, so a
      // refund in a category reduces what was spent there instead of being
      // dropped (a category's cost, AGENTS.md); a category whose credits meet
      // its debits is not a row (`isNetSpending`). Income keeps its positive
      // rows and "both" the magnitude of every row.
      let amountExpr: string;
      if (direction === "expenses") {
        amountExpr = `-${SPLIT_AMOUNT}`;
        qb.andWhere(`${SPLIT_AMOUNT} <> 0`);
      } else if (direction === "income") {
        amountExpr = SPLIT_AMOUNT;
        qb.andWhere(`${SPLIT_AMOUNT} > 0`);
      } else {
        amountExpr = `ABS(${SPLIT_AMOUNT})`;
      }

      if (groupBy === "payee") {
        qb.select("COALESCE(t.payeeName, 'Unknown')", "label")
          .addSelect(`SUM(${amountExpr})`, "total")
          .addSelect("COUNT(*)", "count")
          .groupBy("t.payeeName");
      } else {
        // Same rule as the grouped breakdown: identity is the category id, and
        // the label carries the parent so a comparison never puts two different
        // "Cell Phone" categories in one row.
        qb.select(`${SPLIT_CATEGORY_ID}::text`, "categoryId")
          .addSelect(`SUM(${amountExpr})`, "total")
          .addSelect("COUNT(*)", "count")
          .groupBy(`${SPLIT_CATEGORY_ID}::text`);
      }
      // Each part is converted at its own date before it joins its group.
      qb.addSelect("t.currencyCode", "currencyCode")
        .addSelect(DAY_SQL, "txDate")
        .addGroupBy("t.currencyCode")
        .addGroupBy(DAY_SQL);

      const rows = await this.llmFlowRows(m, userId, qb);
      const rates = await this.loadRateIndex(
        m,
        rows,
        reporting,
        startDate,
        endDate,
      );
      const names =
        groupBy === "payee"
          ? new Map<string, string>()
          : await loadQualifiedCategoryNames(m, userId);
      const groups = this.foldGroups(
        rows,
        (r) => (groupBy === "payee" ? r.label : (r.categoryId ?? "")),
        reporting,
        rates,
      );
      let items: ComparisonItem[] = groups.map((g) => ({
        label:
          groupBy === "payee"
            ? g.first.label
            : g.first.categoryId
              ? (names.get(g.first.categoryId) ?? UNKNOWN_CATEGORY_LABEL)
              : UNCATEGORIZED_LABEL,
        agg: g.agg,
        count: g.count,
      }));

      if (direction === "expenses") {
        // A group with a part still unconverted is kept: its net is unknown,
        // not spent-in-nothing.
        items = items.filter(
          (i) => isNetSpending(i.agg.knownSubtotal) || !i.agg.isComplete,
        );
      }

      if (groupBy === "payee") {
        const above = items.filter((i) => i.count >= MIN_AGGREGATION_COUNT);
        const below = items.filter((i) => i.count < MIN_AGGREGATION_COUNT);
        if (below.length > 0) {
          const other = new FxAggregate();
          for (const i of below) other.merge(i.agg);
          above.push({
            label: "Other (aggregated)",
            agg: other,
            count: below.reduce((s, i) => s + i.count, 0),
          });
        }
        items = above;
      }

      const total = new FxAggregate();
      for (const i of items) total.merge(i.agg);
      return { totalsCurrency: reporting, items, total };
    });
  }

  /**
   * Detect recurring (subscription-like) charges for a user over a date range.
   * Shared by the AI insights and forecast aggregators so both compute
   * recurring charges identically. Groups debit transactions by payee/category,
   * keeps groups seen at least 3 times, and classifies their cadence. Pass
   * `uncategorizedLabel` to substitute a label for charges with no category
   * (the forecast aggregator uses "Uncategorized"; insights leaves it null).
   *
   * `accountId` narrows detection to one account's own rows, which is what a
   * per-account panel is actually asking about: a charge that recurs on another
   * card is not a recurring charge on this one. It is a filter on the *rows the
   * cadence is measured from*, not a post-filter on the result, so the >= 3
   * threshold and the amounts are the account's own. The caller must authorize
   * the account first -- this method trusts the id it is handed, exactly as it
   * trusts `userId`.
   */
  @ReportingRead("cash")
  async getRecurringCharges(
    userId: string,
    startDate: string,
    endDate: string,
    options: {
      uncategorizedLabel?: string;
      payeeIds?: string[];
      accountId?: string;
    } = {},
  ): Promise<RecurringCharge[]> {
    return withScopedDb(this.dataSource, async (m) => {
      const categoryNameSelect = options.uncategorizedLabel
        ? "COALESCE(cat.name, :uncategorizedLabel)"
        : "cat.name";

      // A transaction linked to a payee record carries payeeId with a NULL
      // payeeName, so resolve the display name through the payee relation and
      // fall back to the free-text name (e.g. imported rows).
      const payeeNameExpr = "COALESCE(chargePayee.name, t.payeeName)";

      const qb = m
        .getRepository(Transaction)
        .createQueryBuilder("t")
        .leftJoin("t.category", "cat")
        .leftJoin("t.payee", "chargePayee")
        .select(payeeNameExpr, "payeeName")
        .addSelect("chargePayee.id", "payeeId")
        .addSelect(categoryNameSelect, "categoryName")
        .addSelect("cat.id", "categoryId")
        // A split parent's own amount is the sum of every line, so the charge
        // has to be the ordinary part -- otherwise this answers 560 where the
        // built-in Recurring Expenses report answers 60 for the same rows.
        .addSelect(
          `ARRAY_AGG(ABS(${RECURRING_REPORTABLE_AMOUNT}) ORDER BY t.transactionDate ASC)`,
          "amounts",
        )
        .addSelect(
          "ARRAY_AGG(TO_CHAR(t.transactionDate, 'YYYY-MM-DD') ORDER BY t.transactionDate ASC)",
          "dates",
        )
        .addSelect("COUNT(*)", "txnCount")
        .where("t.userId = :userId", { userId })
        .andWhere("t.transactionDate >= :startDate", { startDate })
        .andWhere("t.transactionDate <= :endDate", { endDate })
        .andWhere(`${RECURRING_REPORTABLE_AMOUNT} < 0`)
        .andWhere("t.status != 'VOID'")
        .andWhere("t.isTransfer = false")
        .andWhere("t.parentTransactionId IS NULL")
        .andWhere("(t.payeeId IS NOT NULL OR t.payeeName IS NOT NULL)")
        // Exclude investment-linked cash debits so regular BUY activity
        // isn't flagged as a subscription-like "recurring charge".
        .andWhere(investmentLinkedTransactionExclusion("t"))
        .setParameters(
          options.uncategorizedLabel
            ? { uncategorizedLabel: options.uncategorizedLabel }
            : {},
        )
        .groupBy(payeeNameExpr)
        .addGroupBy("chargePayee.id")
        .addGroupBy("cat.name")
        .addGroupBy("cat.id")
        .having("COUNT(*) >= 3")
        .orderBy("COUNT(*)", "DESC");

      if (options.payeeIds && options.payeeIds.length > 0) {
        qb.andWhere("t.payeeId IN (:...payeeIds)", {
          payeeIds: options.payeeIds,
        });
      }

      if (options.accountId) {
        qb.andWhere("t.accountId = :accountId", {
          accountId: options.accountId,
        });
      }

      const rows = await this.llmFlowRows(m, userId, qb);
      // Qualified so a recurring charge on "Business: Cell Phone" is not
      // reported against "Bills: Cell Phone" in an insight or a forecast.
      const names = await loadQualifiedCategoryNames(m, userId);

      return rows
        .map((r) => {
          const amounts: number[] = (r.amounts || []).map(Number);
          const dates: string[] = r.dates || [];
          const frequency = detectFrequency(dates);
          const currentAmount =
            amounts.length > 0 ? amounts[amounts.length - 1] : 0;
          const previousAmount =
            amounts.length > 1 ? amounts[amounts.length - 2] : currentAmount;

          return {
            payeeName: r.payeeName,
            payeeId: r.payeeId || null,
            amounts,
            dates,
            frequency,
            currentAmount,
            previousAmount,
            categoryName: r.categoryId
              ? (names.get(r.categoryId) ?? r.categoryName)
              : r.categoryName,
            categoryId: r.categoryId || null,
          };
        })
        .filter((r) => r.frequency !== "irregular");
    });
  }
}

/** One day's SQL, for the `t` alias: the date a row is converted at. */
const DAY_SQL = "TO_CHAR(t.transactionDate, 'YYYY-MM-DD')";

/** A grouped raw row: its label columns, its currency and its day. */
type RawGroupRow = Record<string, any>;

interface FoldedGroup {
  first: RawGroupRow;
  agg: FxAggregate;
  count: number;
}

interface ConvertedFlowTotals {
  income: FxAggregate;
  expenses: FxAggregate;
  totalsCurrency: string;
}

/** A grouped breakdown with the conversion gaps its rows carry. */
interface LlmBreakdown {
  rows: unknown;
  fx: FxAggregate;
}

interface ComparisonItem {
  label: string;
  agg: FxAggregate;
  count: number;
}

interface ComparisonPeriodData {
  totalsCurrency: string;
  items: ComparisonItem[];
  /** Everything in `items`, for the period's own total. */
  total: FxAggregate;
}

/**
 * Add one dated amount of `row.currencyCode` to `agg` in the reporting
 * currency. Zero needs no rate and the same currency needs none; anything else
 * is converted at the rate for its date or recorded as a gap.
 */
function addDatedAmount(
  agg: FxAggregate,
  amount: number,
  row: RawGroupRow,
  reporting: string,
  rates: RateIndex,
  logger: Logger,
): void {
  if (amount === 0) return;
  if (row.currencyCode === reporting) {
    agg.addConverted(amount);
    return;
  }
  const enteredRate = Number(row.exchangeRate);
  if (
    row.originalCurrencyCode === reporting &&
    Number.isFinite(enteredRate) &&
    enteredRate > 0
  ) {
    agg.addConverted(applyFxConversion(amount, 1 / enteredRate).amount);
    return;
  }
  agg.add(
    convertAtDate(
      amount,
      row.currencyCode,
      reporting,
      row.txDate,
      rates,
      logger,
    ),
    row.currencyCode,
    reporting,
  );
}

/**
 * A group's figure: `total` only when every part converted, otherwise `null`
 * with the converted part under `knownSubtotal`.
 */
function totalFields(agg: FxAggregate): {
  total: number | null;
  knownSubtotal?: number;
} {
  return agg.isComplete
    ? { total: roundMoney(agg.knownSubtotal) }
    : { total: null, knownSubtotal: roundMoney(agg.knownSubtotal) };
}

/** Largest first, by what converted (a withheld total still ranks). */
function byKnownSubtotal<
  T extends { total: number | null; knownSubtotal?: number },
>(rows: T[]): T[] {
  const figure = (r: T) => r.knownSubtotal ?? r.total ?? 0;
  return rows.sort((a, b) => figure(b) - figure(a));
}

/**
 * LLM06-F2: Fold payee groups with fewer than MIN_AGGREGATION_COUNT
 * transactions into a single "Other (aggregated)" bucket so individual
 * transaction amounts can't leak via targeted queries.
 */
interface PayeeGroup {
  payee: string;
  payeeId: string | null;
  agg: FxAggregate;
  count: number;
}

function enforcePayeeAggregationThreshold(rows: PayeeGroup[]) {
  const above = rows.filter((r) => r.count >= MIN_AGGREGATION_COUNT);
  const below = rows.filter((r) => r.count < MIN_AGGREGATION_COUNT);

  if (below.length > 0) {
    const other = new FxAggregate();
    for (const r of below) other.merge(r.agg);
    // The synthetic bucket must never carry a real payee id -- it exists to
    // hide the identities of the folded groups.
    above.push({
      payee: "Other (aggregated)",
      payeeId: null,
      agg: other,
      count: below.reduce((sum, r) => sum + r.count, 0),
    });
  }

  return byKnownSubtotal(
    above.map((r) => ({
      payee: r.payee,
      payeeId: r.payeeId,
      ...totalFields(r.agg),
      count: r.count,
    })),
  );
}
