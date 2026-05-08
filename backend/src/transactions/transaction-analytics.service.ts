import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Brackets, Repository } from "typeorm";
import { Transaction } from "./entities/transaction.entity";
import { Category } from "../categories/entities/category.entity";
import { getAllCategoryIdsWithChildren } from "../common/category-tree.util";
import { applyInvestmentTransactionFilters } from "../common/investment-filter.util";
import {
  joinSplitsForAnalytics,
  SPLIT_AMOUNT,
  SPLIT_CATEGORY_NAME,
} from "../common/transaction-split-query.util";

export interface TransferAccountSummary {
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

export interface LlmSpendingByCategoryResult {
  categories: Array<{
    category: string;
    amount: number;
    percentage: number;
    transactionCount: number;
  }>;
  totalSpending: number;
}

export type LlmIncomeGroupBy = "category" | "payee" | "month";

export interface LlmIncomeSummaryResult {
  items: Array<{ label: string; amount: number; count: number }>;
  totalIncome: number;
  groupedBy: LlmIncomeGroupBy;
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

function sumMoney(values: number[]): number {
  return values.reduce((sum, v) => sum + Math.round(v * 10000), 0) / 10000;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
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
  ) {}

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

    const roundMoney = (v: number): number => Math.round(v * 10000) / 10000;
    const sumMoney = (values: number[]): number =>
      values.reduce((s, v) => s + Math.round(v * 10000), 0) / 10000;

    const accounts: TransferAccountSummary[] = rows.map((r) => {
      const inbound = roundMoney(Number(r.inbound) || 0);
      const outbound = roundMoney(Number(r.outbound) || 0);
      return {
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
  ): Promise<{
    totalIncome: number;
    totalExpenses: number;
    netCashFlow: number;
    transactionCount: number;
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
      const searchPattern = `%${search.trim()}%`;
      queryBuilder.andWhere(
        "(transaction.description ILIKE :search OR transaction.payeeName ILIKE :search OR transaction.referenceNumber ILIKE :search OR splits.memo ILIKE :search)",
        { search: searchPattern },
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
      .groupBy("transaction.currencyCode");

    const rows = await queryBuilder.getRawMany();

    let totalIncome = 0;
    let totalExpenses = 0;
    let transactionCount = 0;
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
      byCurrency,
    };
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
      const searchPattern = `%${search.trim()}%`;
      if (!splitsJoined) {
        queryBuilder.leftJoin("transaction.splits", "splits");
        splitsJoined = true;
      }
      queryBuilder.andWhere(
        "(transaction.description ILIKE :search OR transaction.payeeName ILIKE :search OR transaction.referenceNumber ILIKE :search OR splits.memo ILIKE :search)",
        { search: searchPattern },
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
      total: Math.round((Number(row.total) || 0) * 100) / 100,
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
  ): Promise<{ categoryIds: string[]; unresolved: string[] }> {
    if (categoryNames.length === 0) {
      return { categoryIds: [], unresolved: [] };
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

    if (matched.length === 0) {
      return { categoryIds: [], unresolved };
    }

    const categoryIds = await getAllCategoryIdsWithChildren(
      this.categoriesRepository,
      userId,
      matched,
    );
    return { categoryIds, unresolved };
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

  private async getLlmGroupedBreakdown(
    userId: string,
    startDate: string,
    endDate: string,
    groupBy: LlmQueryGroupBy,
    direction: LlmQueryDirection | undefined,
    accountIds?: string[],
    categoryIds?: string[],
    safeSearchText?: string,
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

    if (safeSearchText) {
      qb.andWhere(
        "(t.description ILIKE :search OR t.payeeName ILIKE :search OR t.referenceNumber ILIKE :search OR ts.memo ILIKE :search)",
        { search: `%${safeSearchText}%` },
      );
    }

    switch (groupBy) {
      case "category": {
        qb.leftJoin("t.category", "cat")
          .select(SPLIT_CATEGORY_NAME, "label")
          .addSelect(`SUM(ABS(${SPLIT_AMOUNT}))`, "total")
          .addSelect("COUNT(*)", "count")
          .groupBy(SPLIT_CATEGORY_NAME);

        const rows = await qb.getRawMany();
        return rows
          .map((r) => ({
            category: r.label,
            total: roundMoney(Number(r.total)),
            count: Number(r.count),
          }))
          .sort((a, b) => b.total - a.total);
      }

      case "payee": {
        qb.select("COALESCE(t.payeeName, 'Unknown')", "label")
          .addSelect(`SUM(ABS(${SPLIT_AMOUNT}))`, "total")
          .addSelect("COUNT(*)", "count")
          .groupBy("t.payeeName");

        const rows = await qb.getRawMany();
        return enforcePayeeAggregationThreshold(
          rows.map((r) => ({
            payee: r.label,
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
   * Spending-by-category breakdown shaped for LLM tools. Shared by
   * `ToolExecutorService.getSpendingByCategory` and the MCP tool.
   *
   * Distinct from `SpendingReportsService.getSpendingByCategory`: that one
   * does currency conversion and parent rollup for the reports UI. This one
   * preserves subcategory-level detail with per-row percentage and
   * transaction counts expected by LLM callers.
   */
  async getLlmSpendingByCategory(
    userId: string,
    startDate: string,
    endDate: string,
    topN?: number,
  ): Promise<LlmSpendingByCategoryResult> {
    const qb = this.transactionsRepository
      .createQueryBuilder("t")
      .leftJoin("t.category", "cat")
      .leftJoin("t.account", "spendingAccount")
      .select(SPLIT_CATEGORY_NAME, "category")
      .addSelect(`SUM(ABS(${SPLIT_AMOUNT}))`, "total")
      .addSelect("COUNT(*)", "count")
      .where("t.userId = :userId", { userId })
      .andWhere("t.transactionDate >= :startDate", { startDate })
      .andWhere("t.transactionDate <= :endDate", { endDate })
      .andWhere(`${SPLIT_AMOUNT} < 0`)
      .andWhere("t.status != 'VOID'")
      .andWhere("t.isTransfer = false")
      .andWhere("t.parentTransactionId IS NULL")
      .groupBy(SPLIT_CATEGORY_NAME)
      .orderBy("total", "DESC");

    joinSplitsForAnalytics(qb);
    applyInvestmentTransactionFilters(qb, "spendingAccount", "t");

    const rows = await qb.getRawMany();
    const totalSpending = sumMoney(rows.map((r) => Number(r.total)));

    let categories = rows.map((r) => {
      const amount = roundMoney(Number(r.total));
      return {
        category: r.category,
        amount,
        percentage:
          totalSpending > 0
            ? Math.round((amount / totalSpending) * 10000) / 100
            : 0,
        transactionCount: Number(r.count),
      };
    });

    if (topN && topN > 0) {
      categories = categories.slice(0, topN);
    }

    return { categories, totalSpending };
  }

  /**
   * Income summary grouped by category, payee, or month. Shared by
   * `ToolExecutorService.getIncomeSummary` and the MCP tool.
   */
  async getLlmIncomeSummary(
    userId: string,
    startDate: string,
    endDate: string,
    groupBy: LlmIncomeGroupBy = "category",
  ): Promise<LlmIncomeSummaryResult> {
    const qb = this.transactionsRepository
      .createQueryBuilder("t")
      .leftJoin("t.account", "incomeAccount")
      .where("t.userId = :userId", { userId })
      .andWhere("t.transactionDate >= :startDate", { startDate })
      .andWhere("t.transactionDate <= :endDate", { endDate })
      .andWhere(`${SPLIT_AMOUNT} > 0`)
      .andWhere("t.status != 'VOID'")
      .andWhere("t.isTransfer = false")
      .andWhere("t.parentTransactionId IS NULL");

    joinSplitsForAnalytics(qb);
    applyInvestmentTransactionFilters(qb, "incomeAccount", "t");

    let items: Array<{ label: string; amount: number; count: number }>;

    switch (groupBy) {
      case "payee": {
        qb.select("COALESCE(t.payeeName, 'Unknown')", "label")
          .addSelect(`SUM(${SPLIT_AMOUNT})`, "total")
          .addSelect("COUNT(*)", "count")
          .groupBy("t.payeeName")
          .orderBy("total", "DESC");
        const rows = await qb.getRawMany();
        const payeeItems = rows.map((r) => ({
          label: r.label,
          amount: roundMoney(Number(r.total)),
          count: Number(r.count),
        }));
        items = enforceLabeledAggregationThreshold(payeeItems);
        break;
      }
      case "month": {
        qb.select("TO_CHAR(t.transactionDate, 'YYYY-MM')", "label")
          .addSelect(`SUM(${SPLIT_AMOUNT})`, "total")
          .addSelect("COUNT(*)", "count")
          .groupBy("TO_CHAR(t.transactionDate, 'YYYY-MM')")
          .orderBy("label", "ASC");
        const rows = await qb.getRawMany();
        items = rows.map((r) => ({
          label: r.label,
          amount: roundMoney(Number(r.total)),
          count: Number(r.count),
        }));
        break;
      }
      case "category":
      default: {
        qb.leftJoin("t.category", "cat")
          .select(SPLIT_CATEGORY_NAME, "label")
          .addSelect(`SUM(${SPLIT_AMOUNT})`, "total")
          .addSelect("COUNT(*)", "count")
          .groupBy(SPLIT_CATEGORY_NAME)
          .orderBy("total", "DESC");
        const rows = await qb.getRawMany();
        items = rows.map((r) => ({
          label: r.label,
          amount: roundMoney(Number(r.total)),
          count: Number(r.count),
        }));
        break;
      }
    }

    return {
      items,
      totalIncome: sumMoney(items.map((i) => i.amount)),
      groupedBy: groupBy,
    };
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
}

/**
 * LLM06-F2: Fold payee groups with fewer than MIN_AGGREGATION_COUNT
 * transactions into a single "Other (aggregated)" bucket so individual
 * transaction amounts can't leak via targeted queries.
 */
function enforcePayeeAggregationThreshold(
  rows: Array<{ payee: string; total: number; count: number }>,
): Array<{ payee: string; total: number; count: number }> {
  const above = rows.filter((r) => r.count >= MIN_AGGREGATION_COUNT);
  const below = rows.filter((r) => r.count < MIN_AGGREGATION_COUNT);

  if (below.length > 0) {
    above.push({
      payee: "Other (aggregated)",
      total: sumMoney(below.map((r) => r.total)),
      count: below.reduce((sum, r) => sum + r.count, 0),
    });
  }

  return above.sort((a, b) => b.total - a.total);
}

function enforceLabeledAggregationThreshold(
  items: Array<{ label: string; amount: number; count: number }>,
): Array<{ label: string; amount: number; count: number }> {
  const above = items.filter((i) => i.count >= MIN_AGGREGATION_COUNT);
  const below = items.filter((i) => i.count < MIN_AGGREGATION_COUNT);

  if (below.length > 0) {
    above.push({
      label: "Other (aggregated)",
      amount: sumMoney(below.map((i) => i.amount)),
      count: below.reduce((s, i) => s + i.count, 0),
    });
  }

  return above;
}
