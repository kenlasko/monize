import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Brackets, Repository } from "typeorm";
import { Transaction } from "./entities/transaction.entity";
import { Category } from "../categories/entities/category.entity";
import { getAllCategoryIdsWithChildren } from "../common/category-tree.util";

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
        "(transaction.description ILIKE :search OR transaction.payeeName ILIKE :search OR splits.memo ILIKE :search)",
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
        "(transaction.description ILIKE :search OR transaction.payeeName ILIKE :search OR splits.memo ILIKE :search)",
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
}
