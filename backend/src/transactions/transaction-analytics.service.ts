import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Brackets, Repository } from "typeorm";
import { Transaction } from "./entities/transaction.entity";
import { Category } from "../categories/entities/category.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { getAllCategoryIdsWithChildren } from "../common/category-tree.util";
import { applyInvestmentTransactionFilters } from "../common/investment-filter.util";
import {
  joinSplitsForAnalytics,
  SPLIT_AMOUNT,
  SPLIT_CATEGORY_ID,
  SPLIT_CATEGORY_NAME,
} from "../common/transaction-split-query.util";
import {
  buildTransactionSearchClause,
  escapeLikePattern,
} from "./transaction-search.util";
import {
  parseSearchTerm,
  ParsedSearchTerm,
} from "./transaction-search-parse.util";
import { RecurringCharge, detectFrequency } from "./recurring-charges.util";
import { roundMoney, sumMoney } from "../common/round.util";
import { suggestClosestNames } from "../common/name-suggestions.util";

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

export interface LlmQueryTransactionsResult {
  totalIncome: number;
  totalExpenses: number;
  netCashFlow: number;
  transactionCount: number;
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

export interface LlmListTransactionsResult {
  totalIncome: number;
  totalExpenses: number;
  netCashFlow: number;
  transactionCount: number;
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
  period1Start: string;
  period1End: string;
  period2Start: string;
  period2End: string;
  groupBy?: LlmComparisonGroupBy;
  direction?: LlmComparisonDirection;
}

export interface LlmPeriodComparisonResult {
  period1: { start: string; end: string; total: number };
  period2: { start: string; end: string; total: number };
  totalChange: number;
  totalChangePercent: number;
  comparison: Array<{
    label: string;
    period1Amount: number;
    period2Amount: number;
    change: number;
    changePercent: number;
  }>;
}

function sanitizeLikePattern(input: string | undefined): string | undefined {
  if (!input) return undefined;
  return input
    .substring(0, 200)
    .replace(/\\/g, "\\\\")
    .replace(/[%_]/g, "\\$&");
}

@Injectable()
export class TransactionAnalyticsService {
  constructor(
    @InjectRepository(Transaction)
    private transactionsRepository: Repository<Transaction>,
    @InjectRepository(Category)
    private categoriesRepository: Repository<Category>,
    @InjectRepository(UserPreference)
    private userPreferenceRepository: Repository<UserPreference>,
  ) {}

  /**
   * Interprets the search term as an exact amount and/or date using the user's
   * number/date-format preferences, so locale-formatted values also match.
   */
  private async resolveSearchTerm(
    userId: string,
    term?: string,
  ): Promise<ParsedSearchTerm> {
    if (!term || !term.trim()) return { amount: null, date: null };
    const prefs = await this.userPreferenceRepository.findOne({
      where: { userId },
    });
    return parseSearchTerm(term, {
      numberFormat: prefs?.numberFormat,
      dateFormat: prefs?.dateFormat,
    });
  }

  /**
   * Per-account transfer activity between the user's own accounts for a date
   * range. Shared by the AI Assistant's tool executor and the MCP server so
   * both surfaces return the same shape. `inbound` counts positive-sign
   * transfer rows (money received), `outbound` counts the absolute value of
   * negative-sign rows (money sent). When no account filter is applied,
   * `totalInbound` equals `totalOutbound` (modulo multi-currency conversions)
   * because every transfer is stored as two linked rows, one on each side.
   */
  async getTransfersByAccount(
    userId: string,
    startDate: string,
    endDate: string,
    accountIds?: string[],
  ): Promise<TransfersByAccountResult> {
    const qb = this.transactionsRepository
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

    const rows = await qb.getRawMany();

    const accounts: TransferAccountSummary[] = rows.map((r) => {
      const inbound = roundMoney(Number(r.inbound) || 0);
      const outbound = roundMoney(Number(r.outbound) || 0);
      return {
        accountId: r.accountId ?? null,
        accountName: r.accountName,
        currency: r.currencyCode,
        inbound,
        outbound,
        net: roundMoney(inbound - outbound),
        transferCount: Number(r.count) || 0,
      };
    });

    return {
      accounts,
      totalInbound: sumMoney(accounts.map((a) => a.inbound)),
      totalOutbound: sumMoney(accounts.map((a) => a.outbound)),
      transferCount: accounts.reduce((s, a) => s + a.transferCount, 0),
    };
  }

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
  ): Promise<{
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
    const queryBuilder = await this.createFilteredAnalyticsQuery(userId, {
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

    const rows = await queryBuilder.getRawMany();

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

    for (const row of rows) {
      const income = Number(row.totalIncome) || 0;
      const expenses = Number(row.totalExpenses) || 0;
      const count = Number(row.transactionCount) || 0;
      totalIncome += income;
      totalExpenses += expenses;
      transactionCount += count;
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
        byCurrency[row.currencyCode] = {
          totalIncome: income,
          totalExpenses: expenses,
          netCashFlow: income - expenses,
          transactionCount: count,
        };
      }
    }

    return {
      totalIncome,
      totalExpenses,
      netCashFlow: totalIncome - totalExpenses,
      transactionCount,
      firstTransactionDate,
      lastTransactionDate,
      byCurrency,
    };
  }

  /**
   * Base query shared by {@link getSummary} and {@link getGroupedTotals}:
   * applies the full transaction-list filter surface (accounts incl. the
   * brokerage exclusion, dates, categories with descendant expansion and
   * the `uncategorized`/`transfer` pseudo-ids, payees, search, amount
   * range, tags) with splits always joined so split transactions count
   * per matching split via `COALESCE(splits.amount, transaction.amount)`.
   */
  private async createFilteredAnalyticsQuery(
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
    } = filters;

    const queryBuilder = this.transactionsRepository
      .createQueryBuilder("transaction")
      .where("transaction.userId = :userId", { userId });

    // Join account for filtering and uncategorized conditions.
    // Use the same exclusion logic as findAll() so the summary
    // counts/totals match the transaction list.
    queryBuilder.leftJoin("transaction.account", "summaryAccount");

    queryBuilder.andWhere(
      "(summaryAccount.accountSubType IS NULL OR summaryAccount.accountSubType != 'INVESTMENT_BROKERAGE')",
    );

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

    // Optionally exclude cash-side transactions created as a side-effect
    // of an investment BUY/SELL/DIVIDEND. Those transactions live in the
    // linked cash account (so the account-subtype filter above can't see
    // them), carry no category, and have no transfer flag -- so they
    // leak into expense/income totals as "uncategorised" spending.
    if (excludeInvestmentLinked) {
      queryBuilder.andWhere(
        "NOT EXISTS (SELECT 1 FROM investment_transactions it WHERE it.transaction_id = transaction.id)",
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
      queryBuilder.andWhere("transaction.transactionDate >= :startDate", {
        startDate,
      });
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
                this.categoriesRepository,
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
                "transaction.categoryId IS NULL AND transaction.isSplit = false AND transaction.isTransfer = false AND summaryAccount.accountType != 'INVESTMENT'",
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

    if (search && search.trim()) {
      const searchPattern = `%${escapeLikePattern(search.trim())}%`;
      const parsedSearch = await this.resolveSearchTerm(userId, search);
      queryBuilder.andWhere(
        buildTransactionSearchClause({
          transaction: "transaction",
          splits: "splits",
        }),
        {
          search: searchPattern,
          searchAmount: parsedSearch.amount,
          searchDate: parsedSearch.date,
        },
      );
    }

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
    const { groupBy, limit, ...filters } = params;

    const queryBuilder = await this.createFilteredAnalyticsQuery(
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
        .addGroupBy("COALESCE(groupSplitCat.name, groupCat.name)");
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

    const rows = await queryBuilder.getRawMany();

    return rows.map((row) => ({
      id: row.id ?? null,
      name: row.name ?? null,
      currencyCode: row.currencyCode,
      total: roundMoney(Number(row.total) || 0),
      count: Number(row.count) || 0,
    }));
  }

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
  ): Promise<Array<{ month: string; total: number; count: number }>> {
    const queryBuilder = this.transactionsRepository
      .createQueryBuilder("transaction")
      .where("transaction.userId = :userId", { userId });

    // Join account for filtering.  Use the same exclusion logic as
    // findAll() so the chart counts/totals match the transaction list.
    // getMonthlyTotals is only called when filters are active (the
    // frontend switches to daily balances otherwise).
    queryBuilder.leftJoin("transaction.account", "summaryAccount");

    queryBuilder.andWhere(
      "(summaryAccount.accountSubType IS NULL OR summaryAccount.accountSubType != 'INVESTMENT_BROKERAGE')",
    );

    if (accountIds && accountIds.length > 0) {
      queryBuilder.andWhere("transaction.accountId IN (:...accountIds)", {
        accountIds,
      });
    }

    if (startDate) {
      queryBuilder.andWhere("transaction.transactionDate >= :startDate", {
        startDate,
      });
    }

    if (endDate) {
      queryBuilder.andWhere("transaction.transactionDate <= :endDate", {
        endDate,
      });
    }

    let splitsJoined = false;

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
                this.categoriesRepository,
                userId,
                regularCategoryIds,
              )
            : [];

        if (uniqueCategoryIds.length > 0) {
          queryBuilder.leftJoin("transaction.splits", "splits");
          splitsJoined = true;
        }

        queryBuilder.andWhere(
          new Brackets((qb) => {
            if (hasUncategorized) {
              const method = hasCondition ? "orWhere" : "where";
              hasCondition = true;
              qb[method](
                "transaction.categoryId IS NULL AND transaction.isSplit = false AND transaction.isTransfer = false AND summaryAccount.accountType != 'INVESTMENT'",
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
                      "transaction.categoryId IN (:...monthlyCategoryIds)",
                      { monthlyCategoryIds: uniqueCategoryIds },
                    )
                    .orWhere("splits.categoryId IN (:...monthlyCategoryIds)", {
                      monthlyCategoryIds: uniqueCategoryIds,
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

    if (search && search.trim()) {
      const searchPattern = `%${escapeLikePattern(search.trim())}%`;
      const parsedSearch = await this.resolveSearchTerm(userId, search);
      if (!splitsJoined) {
        queryBuilder.leftJoin("transaction.splits", "splits");
        splitsJoined = true;
      }
      queryBuilder.andWhere(
        buildTransactionSearchClause({
          transaction: "transaction",
          splits: "splits",
        }),
        {
          search: searchPattern,
          searchAmount: parsedSearch.amount,
          searchDate: parsedSearch.date,
        },
      );
    }

    if (amountFrom !== undefined) {
      queryBuilder.andWhere("transaction.amount >= :amountFrom", {
        amountFrom,
      });
    }

    if (amountTo !== undefined) {
      queryBuilder.andWhere("transaction.amount <= :amountTo", { amountTo });
    }

    if (tagIds && tagIds.length > 0) {
      if (!splitsJoined) {
        queryBuilder.leftJoin("transaction.splits", "splits");
        splitsJoined = true;
      }
      queryBuilder.leftJoin("transaction.tags", "filterTags");
      queryBuilder.leftJoin("splits.tags", "filterSplitTags");
      queryBuilder.andWhere(
        new Brackets((qb) => {
          qb.where("filterTags.id IN (:...monthlyTagIds)", {
            monthlyTagIds: tagIds,
          }).orWhere("filterSplitTags.id IN (:...monthlyTagIds)", {
            monthlyTagIds: tagIds,
          });
        }),
      );
    }

    // When category or tag filter joins splits, use the split amount for split
    // transactions so we only count the matching split, not the full parent.
    const amountExpr = splitsJoined
      ? "COALESCE(splits.amount, transaction.amount)"
      : "transaction.amount";

    queryBuilder
      .select("TO_CHAR(transaction.transactionDate, 'YYYY-MM')", "month")
      .addSelect(`SUM(${amountExpr})`, "total")
      .addSelect(
        splitsJoined ? "COUNT(DISTINCT transaction.id)" : "COUNT(*)",
        "count",
      )
      .groupBy("month")
      .orderBy("month", "ASC");

    const rows = await queryBuilder.getRawMany();

    return rows.map((row) => ({
      month: row.month,
      total: roundMoney(Number(row.total) || 0),
      count: Number(row.count) || 0,
    }));
  }

  /**
   * Resolve category names plus their descendants to IDs. Shared helper for
   * tool adapters that accept names from LLM input.
   */
  /**
   * Resolve LLM-supplied category names into the IDs used by the transaction
   * filters. Handles three input shapes the model often produces:
   *   - exact name              -> "Dining Out"
   *   - parent / child notation -> "Food: Dining Out", "Food / Dining Out",
   *                                "Food > Dining Out", "Food -> Dining Out"
   *   - extra whitespace        -> "  food   :  dining out  "
   *
   * Returns the matched category IDs (expanded to include descendants so a
   * filter on "Food" naturally catches its subcategories) plus any names we
   * could not match. Callers should treat any `unresolved` entry as a hard
   * failure rather than silently dropping the filter -- otherwise a mistyped
   * category yields "all transactions" instead of an honest error.
   */
  async resolveLlmCategoryIds(
    userId: string,
    categoryNames: string[],
  ): Promise<{
    categoryIds: string[];
    unresolved: string[];
    suggestions: string[];
  }> {
    if (categoryNames.length === 0) {
      return { categoryIds: [], unresolved: [], suggestions: [] };
    }

    const allCategories = await this.categoriesRepository.find({
      where: { userId },
      select: ["id", "name", "parentId"],
    });

    const norm = (s: string) => s.toLowerCase().trim().replace(/\s+/g, " ");
    const SEPARATORS = [":", "/", ">", "->"];

    const byId = new Map(allCategories.map((c) => [c.id, c]));
    const lookup = new Map<string, string>();
    for (const cat of allCategories) {
      const childKey = norm(cat.name);
      if (!lookup.has(childKey)) lookup.set(childKey, cat.id);

      if (cat.parentId) {
        const parent = byId.get(cat.parentId);
        if (parent) {
          const parentKey = norm(parent.name);
          for (const sep of SEPARATORS) {
            lookup.set(`${parentKey}${sep}${childKey}`, cat.id);
            lookup.set(`${parentKey} ${sep} ${childKey}`, cat.id);
          }
        }
      }
    }

    const matched: string[] = [];
    const unresolved: string[] = [];
    for (const raw of categoryNames) {
      const normalized = norm(raw);
      let id = lookup.get(normalized);
      if (!id) {
        // Last-segment fallback: "Food: Dining Out" -> try just "Dining Out"
        for (const sep of SEPARATORS) {
          if (normalized.includes(sep)) {
            const lastSeg = norm(normalized.split(sep).pop() ?? "");
            const candidate = lastSeg ? lookup.get(lastSeg) : undefined;
            if (candidate) {
              id = candidate;
              break;
            }
          }
        }
      }
      if (id) matched.push(id);
      else unresolved.push(raw);
    }

    // Closest valid category names for the first unmatched input, so callers can
    // surface a "did you mean?" hint instead of just "call list_categories".
    const suggestions =
      unresolved.length > 0
        ? suggestClosestNames(
            unresolved[0],
            allCategories.map((c) => c.name),
          )
        : [];

    if (matched.length === 0) {
      return { categoryIds: [], unresolved, suggestions };
    }

    const categoryIds = await getAllCategoryIdsWithChildren(
      this.categoriesRepository,
      userId,
      matched,
    );
    return { categoryIds, unresolved, suggestions };
  }

  /**
   * Transaction summary + optional grouped breakdown shaped for LLM tools.
   * Shared by `ToolExecutorService.queryTransactions` and the MCP server's
   * `query_transactions` tool so both surfaces return the same shape.
   *
   * Callers resolve account/category names to IDs before calling.
   */
  async getLlmQueryTransactions(
    userId: string,
    input: LlmQueryTransactionsInput,
  ): Promise<LlmQueryTransactionsResult> {
    const safeSearch = sanitizeLikePattern(input.searchText);

    const summary = await this.getSummary(
      userId,
      input.accountIds,
      input.startDate,
      input.endDate,
      input.categoryIds,
      undefined,
      safeSearch,
      undefined,
      undefined,
      true,
      true,
    );

    let breakdown: unknown = undefined;
    if (input.groupBy) {
      breakdown = await this.getLlmGroupedBreakdown(
        userId,
        input.startDate,
        input.endDate,
        input.groupBy,
        input.direction,
        input.accountIds,
        input.categoryIds,
        safeSearch,
      );
    }

    const result: LlmQueryTransactionsResult = {
      totalIncome: summary.totalIncome,
      totalExpenses: summary.totalExpenses,
      netCashFlow: summary.netCashFlow,
      transactionCount: summary.transactionCount,
    };

    if (Object.keys(summary.byCurrency).length > 1) {
      result.byCurrency = summary.byCurrency;
    }

    if (breakdown !== undefined) {
      result.breakdown = breakdown;
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
   * The RAW transaction list is NOT produced here -- tool adapters fetch it
   * separately via `TransactionsService.getLlmTransactionRows` only when asked.
   *
   * Callers resolve account/category/payee names to IDs before calling. Shared
   * by the AI Assistant tool executor and the MCP server so both surfaces
   * return the same shape.
   */
  async getLlmListTransactions(
    userId: string,
    input: LlmListTransactionsInput,
  ): Promise<LlmListTransactionsResult> {
    const safeSearch = sanitizeLikePattern(input.searchText);
    const groupBy: LlmListGroupBy = input.groupBy ?? "none";

    const summary = await this.getSummary(
      userId,
      input.accountIds,
      input.startDate,
      input.endDate,
      input.categoryIds,
      input.payeeIds,
      safeSearch,
      input.minAmount,
      input.maxAmount,
      true,
      true,
    );

    const result: LlmListTransactionsResult = {
      totalIncome: summary.totalIncome,
      totalExpenses: summary.totalExpenses,
      netCashFlow: summary.netCashFlow,
      transactionCount: summary.transactionCount,
      groupedBy: groupBy,
    };

    if (Object.keys(summary.byCurrency).length > 1) {
      result.byCurrency = summary.byCurrency;
    }

    if (groupBy !== "none") {
      result.breakdown = await this.getLlmGroupedBreakdown(
        userId,
        input.startDate,
        input.endDate,
        groupBy,
        input.direction,
        input.accountIds,
        input.categoryIds,
        safeSearch,
        input.payeeIds,
        input.minAmount,
        input.maxAmount,
      );
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

  private async getLlmGroupedBreakdown(
    userId: string,
    startDate: string,
    endDate: string,
    groupBy: LlmQueryGroupBy,
    direction: LlmQueryDirection | undefined,
    accountIds?: string[],
    categoryIds?: string[],
    safeSearchText?: string,
    payeeIds?: string[],
    minAmount?: number,
    maxAmount?: number,
  ): Promise<unknown> {
    const qb = this.transactionsRepository
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

    if (safeSearchText) {
      const parsedSearch = await this.resolveSearchTerm(userId, safeSearchText);
      qb.andWhere(
        buildTransactionSearchClause({ transaction: "t", splits: "ts" }),
        {
          search: `%${safeSearchText}%`,
          searchAmount: parsedSearch.amount,
          searchDate: parsedSearch.date,
        },
      );
    }

    switch (groupBy) {
      case "category": {
        // Grouping stays on the display name so row granularity is unchanged;
        // MIN() attaches one category id per name for entity deep-links. Two
        // same-named categories under different parents share a row today, so
        // the id is an arbitrary member (link filters to a subset). The
        // "Uncategorized" bucket has no ids and yields null. uuid has no MIN
        // in PostgreSQL, hence the ::text cast.
        qb.leftJoin("t.category", "cat")
          .select(SPLIT_CATEGORY_NAME, "label")
          .addSelect(`MIN(${SPLIT_CATEGORY_ID}::text)`, "categoryId")
          .addSelect(`SUM(ABS(${SPLIT_AMOUNT}))`, "total")
          .addSelect("COUNT(*)", "count")
          .groupBy(SPLIT_CATEGORY_NAME);

        const rows = await qb.getRawMany();
        return rows
          .map((r) => ({
            category: r.label,
            categoryId: r.categoryId ?? null,
            total: roundMoney(Number(r.total)),
            count: Number(r.count),
          }))
          .sort((a, b) => b.total - a.total);
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

        const rows = await qb.getRawMany();
        return enforcePayeeAggregationThreshold(
          rows.map((r) => ({
            payee: r.label,
            payeeId: r.payeeId ?? null,
            total: roundMoney(Number(r.total)),
            count: Number(r.count),
          })),
        );
      }

      case "year": {
        qb.select("TO_CHAR(t.transactionDate, 'YYYY')", "year")
          .addSelect(`SUM(ABS(${SPLIT_AMOUNT}))`, "total")
          .addSelect("COUNT(*)", "count")
          .groupBy("TO_CHAR(t.transactionDate, 'YYYY')")
          .orderBy("year", "ASC");

        const rows = await qb.getRawMany();
        return rows.map((r) => ({
          year: r.year,
          total: roundMoney(Number(r.total)),
          count: Number(r.count),
        }));
      }

      case "month": {
        qb.select("TO_CHAR(t.transactionDate, 'YYYY-MM')", "month")
          .addSelect(`SUM(ABS(${SPLIT_AMOUNT}))`, "total")
          .addSelect("COUNT(*)", "count")
          .groupBy("TO_CHAR(t.transactionDate, 'YYYY-MM')")
          .orderBy("month", "ASC");

        const rows = await qb.getRawMany();
        return rows.map((r) => ({
          month: r.month,
          total: roundMoney(Number(r.total)),
          count: Number(r.count),
        }));
      }

      case "week": {
        qb.select(
          "TO_CHAR(DATE_TRUNC('week', t.transactionDate), 'YYYY-MM-DD')",
          "week",
        )
          .addSelect(`SUM(ABS(${SPLIT_AMOUNT}))`, "total")
          .addSelect("COUNT(*)", "count")
          .groupBy("DATE_TRUNC('week', t.transactionDate)")
          .orderBy("week", "ASC");

        const rows = await qb.getRawMany();
        return rows.map((r) => ({
          week: r.week,
          total: roundMoney(Number(r.total)),
          count: Number(r.count),
        }));
      }
    }
  }

  /**
   * Compare two date ranges side-by-side, grouped by category or payee.
   * Shared by `ToolExecutorService.comparePeriods` and the MCP tool.
   */
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
      ...period1.map((i) => i.label),
      ...period2.map((i) => i.label),
    ]);

    const p1Map = new Map(period1.map((i) => [i.label, i.total]));
    const p2Map = new Map(period2.map((i) => [i.label, i.total]));

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

    const p1Total = sumMoney(period1.map((i) => i.total));
    const p2Total = sumMoney(period2.map((i) => i.total));
    const totalChange = roundMoney(p2Total - p1Total);
    const totalChangePercent =
      p1Total !== 0 ? Math.round((totalChange / p1Total) * 10000) / 100 : 0;

    return {
      period1: {
        start: input.period1Start,
        end: input.period1End,
        total: p1Total,
      },
      period2: {
        start: input.period2Start,
        end: input.period2End,
        total: p2Total,
      },
      totalChange,
      totalChangePercent,
      comparison,
    };
  }

  private async getComparisonPeriodData(
    userId: string,
    startDate: string,
    endDate: string,
    groupBy: LlmComparisonGroupBy,
    direction: LlmComparisonDirection,
  ): Promise<{ label: string; total: number }[]> {
    const qb = this.transactionsRepository
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

    if (direction === "expenses") {
      qb.andWhere(`${SPLIT_AMOUNT} < 0`);
    } else if (direction === "income") {
      qb.andWhere(`${SPLIT_AMOUNT} > 0`);
    }

    if (groupBy === "payee") {
      qb.select("COALESCE(t.payeeName, 'Unknown')", "label")
        .addSelect(`SUM(ABS(${SPLIT_AMOUNT}))`, "total")
        .addSelect("COUNT(*)", "count")
        .groupBy("t.payeeName")
        .orderBy("total", "DESC");
    } else {
      qb.leftJoin("t.category", "cat")
        .select(SPLIT_CATEGORY_NAME, "label")
        .addSelect(`SUM(ABS(${SPLIT_AMOUNT}))`, "total")
        .addSelect("COUNT(*)", "count")
        .groupBy(SPLIT_CATEGORY_NAME)
        .orderBy("total", "DESC");
    }

    const rows = await qb.getRawMany();
    const items = rows.map((r) => ({
      label: r.label,
      total: roundMoney(Number(r.total)),
      count: Number(r.count),
    }));

    if (groupBy === "payee") {
      const above = items.filter((i) => i.count >= MIN_AGGREGATION_COUNT);
      const below = items.filter((i) => i.count < MIN_AGGREGATION_COUNT);
      if (below.length > 0) {
        above.push({
          label: "Other (aggregated)",
          total: sumMoney(below.map((i) => i.total)),
          count: below.reduce((s, i) => s + i.count, 0),
        });
      }
      return above.map((i) => ({ label: i.label, total: i.total }));
    }

    return items.map((r) => ({ label: r.label, total: r.total }));
  }

  /**
   * Detect recurring (subscription-like) charges for a user over a date range.
   * Shared by the AI insights and forecast aggregators so both compute
   * recurring charges identically. Groups debit transactions by payee/category,
   * keeps groups seen at least 3 times, and classifies their cadence. Pass
   * `uncategorizedLabel` to substitute a label for charges with no category
   * (the forecast aggregator uses "Uncategorized"; insights leaves it null).
   */
  async getRecurringCharges(
    userId: string,
    startDate: string,
    endDate: string,
    options: { uncategorizedLabel?: string; payeeIds?: string[] } = {},
  ): Promise<RecurringCharge[]> {
    const categoryNameSelect = options.uncategorizedLabel
      ? "COALESCE(cat.name, :uncategorizedLabel)"
      : "cat.name";

    // A transaction linked to a payee record carries payeeId with a NULL
    // payeeName, so resolve the display name through the payee relation and
    // fall back to the free-text name (e.g. imported rows).
    const payeeNameExpr = "COALESCE(chargePayee.name, t.payeeName)";

    const qb = this.transactionsRepository
      .createQueryBuilder("t")
      .leftJoin("t.category", "cat")
      .leftJoin("t.payee", "chargePayee")
      .select(payeeNameExpr, "payeeName")
      .addSelect("chargePayee.id", "payeeId")
      .addSelect(categoryNameSelect, "categoryName")
      .addSelect("cat.id", "categoryId")
      .addSelect(
        "ARRAY_AGG(ABS(t.amount) ORDER BY t.transactionDate ASC)",
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
      .andWhere("t.amount < 0")
      .andWhere("t.status != 'VOID'")
      .andWhere("t.isTransfer = false")
      .andWhere("t.parentTransactionId IS NULL")
      .andWhere("(t.payeeId IS NOT NULL OR t.payeeName IS NOT NULL)")
      // Exclude investment-linked cash debits so regular BUY activity
      // isn't flagged as a subscription-like "recurring charge".
      .andWhere(
        "NOT EXISTS (SELECT 1 FROM investment_transactions it WHERE it.transaction_id = t.id)",
      )
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

    const rows = await qb.getRawMany();

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
          categoryName: r.categoryName,
          categoryId: r.categoryId || null,
        };
      })
      .filter((r) => r.frequency !== "irregular");
  }
}

/**
 * LLM06-F2: Fold payee groups with fewer than MIN_AGGREGATION_COUNT
 * transactions into a single "Other (aggregated)" bucket so individual
 * transaction amounts can't leak via targeted queries.
 */
interface PayeeBreakdownRow {
  payee: string;
  payeeId: string | null;
  total: number;
  count: number;
}

function enforcePayeeAggregationThreshold(
  rows: PayeeBreakdownRow[],
): PayeeBreakdownRow[] {
  const above = rows.filter((r) => r.count >= MIN_AGGREGATION_COUNT);
  const below = rows.filter((r) => r.count < MIN_AGGREGATION_COUNT);

  if (below.length > 0) {
    // The synthetic bucket must never carry a real payee id -- it exists to
    // hide the identities of the folded groups.
    above.push({
      payee: "Other (aggregated)",
      payeeId: null,
      total: sumMoney(below.map((r) => r.total)),
      count: below.reduce((sum, r) => sum + r.count, 0),
    });
  }

  return above.sort((a, b) => b.total - a.total);
}
