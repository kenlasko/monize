import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Brackets, Repository } from "typeorm";
import { Transaction } from "./entities/transaction.entity";
import { Category } from "../categories/entities/category.entity";
import { getAllCategoryIdsWithChildren } from "../common/category-tree.util";

@Injectable()
export class TransactionAnalyticsService {
  constructor(
    @InjectRepository(Transaction)
    private transactionsRepository: Repository<Transaction>,
    @InjectRepository(Category)
    private categoriesRepository: Repository<Category>,
  ) {}

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

    let splitsCategoryJoin = false;

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
          splitsCategoryJoin = true;
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
      if (!categoryIds || categoryIds.length === 0) {
        queryBuilder.leftJoin("transaction.splits", "splits");
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

    // When category filter joins splits, use the split amount for split
    // transactions so we only count the matching split, not the full parent.
    const amountExpr = splitsCategoryJoin
      ? "COALESCE(splits.amount, transaction.amount)"
      : "transaction.amount";

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
      .addSelect(
        splitsCategoryJoin ? "COUNT(DISTINCT transaction.id)" : "COUNT(*)",
        "transactionCount",
      )
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

    let splitsCategoryJoin = false;
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
          splitsCategoryJoin = true;
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
