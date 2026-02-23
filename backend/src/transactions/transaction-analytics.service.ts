import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Transaction } from "./entities/transaction.entity";
import { Category } from "../categories/entities/category.entity";

@Injectable()
export class TransactionAnalyticsService {
  constructor(
    @InjectRepository(Transaction)
    private transactionsRepository: Repository<Transaction>,
    @InjectRepository(Category)
    private categoriesRepository: Repository<Category>,
  ) {}

  private async getAllCategoryIdsWithChildren(
    userId: string,
    categoryIds: string[],
  ): Promise<string[]> {
    const categories = await this.categoriesRepository.find({
      where: { userId },
      select: ["id", "parentId"],
    });

    const result = new Set<string>();
    const addWithChildren = (parentId: string) => {
      result.add(parentId);
      for (const cat of categories) {
        if (cat.parentId === parentId && !result.has(cat.id)) {
          addWithChildren(cat.id);
        }
      }
    };

    for (const catId of categoryIds) {
      addWithChildren(catId);
    }

    return [...result];
  }

  async getSummary(
    userId: string,
    accountIds?: string[],
    startDate?: string,
    endDate?: string,
    categoryIds?: string[],
    payeeIds?: string[],
    search?: string,
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
      .select("transaction.currencyCode", "currencyCode")
      .addSelect(
        "SUM(CASE WHEN transaction.amount > 0 THEN transaction.amount ELSE 0 END)",
        "totalIncome",
      )
      .addSelect(
        "SUM(CASE WHEN transaction.amount < 0 THEN ABS(transaction.amount) ELSE 0 END)",
        "totalExpenses",
      )
      .addSelect("COUNT(*)", "transactionCount")
      .where("transaction.userId = :userId", { userId });

    // Join account for investment filtering and uncategorized conditions.
    queryBuilder.leftJoin("transaction.account", "summaryAccount");

    // Exclude transfers by default — they are not real income/expenses.
    // Only include them when the user explicitly filters for "transfer" category.
    const wantsTransfers = categoryIds && categoryIds.includes("transfer");
    if (!wantsTransfers) {
      queryBuilder.andWhere("transaction.isTransfer = false");
    }

    // Exclude investment account transactions (purchases, sales, dividends)
    // unless the user explicitly filters for specific investment accounts.
    if (!accountIds || accountIds.length === 0) {
      queryBuilder.andWhere("summaryAccount.accountType != :investmentType", {
        investmentType: "INVESTMENT",
      });
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

      const conditions: string[] = [];

      if (hasUncategorized) {
        conditions.push(
          "(transaction.categoryId IS NULL AND transaction.isSplit = false AND transaction.isTransfer = false AND summaryAccount.accountType != 'INVESTMENT')",
        );
      }

      if (hasTransfer) {
        conditions.push("transaction.isTransfer = true");
      }

      if (regularCategoryIds.length > 0) {
        const uniqueCategoryIds = await this.getAllCategoryIdsWithChildren(
          userId,
          regularCategoryIds,
        );

        if (uniqueCategoryIds.length > 0) {
          queryBuilder.leftJoin("transaction.splits", "splits");
          conditions.push(
            "(transaction.categoryId IN (:...summaryCategoryIds) OR splits.categoryId IN (:...summaryCategoryIds))",
          );
          queryBuilder.setParameter("summaryCategoryIds", uniqueCategoryIds);
        }
      }

      if (conditions.length > 0) {
        queryBuilder.andWhere(`(${conditions.join(" OR ")})`);
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

    queryBuilder.groupBy("transaction.currencyCode");

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
  ): Promise<Array<{ month: string; total: number; count: number }>> {
    const queryBuilder = this.transactionsRepository
      .createQueryBuilder("transaction")
      .select("TO_CHAR(transaction.transactionDate, 'YYYY-MM')", "month")
      .addSelect("SUM(transaction.amount)", "total")
      .addSelect("COUNT(*)", "count")
      .where("transaction.userId = :userId", { userId });

    queryBuilder.leftJoin("transaction.account", "summaryAccount");

    const wantsTransfers = categoryIds && categoryIds.includes("transfer");
    if (!wantsTransfers) {
      queryBuilder.andWhere("transaction.isTransfer = false");
    }

    if (!accountIds || accountIds.length === 0) {
      queryBuilder.andWhere("summaryAccount.accountType != :investmentType", {
        investmentType: "INVESTMENT",
      });
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

      const conditions: string[] = [];

      if (hasUncategorized) {
        conditions.push(
          "(transaction.categoryId IS NULL AND transaction.isSplit = false AND transaction.isTransfer = false AND summaryAccount.accountType != 'INVESTMENT')",
        );
      }

      if (hasTransfer) {
        conditions.push("transaction.isTransfer = true");
      }

      if (regularCategoryIds.length > 0) {
        const uniqueCategoryIds = await this.getAllCategoryIdsWithChildren(
          userId,
          regularCategoryIds,
        );

        if (uniqueCategoryIds.length > 0) {
          queryBuilder.leftJoin("transaction.splits", "splits");
          conditions.push(
            "(transaction.categoryId IN (:...monthlyCategoryIds) OR splits.categoryId IN (:...monthlyCategoryIds))",
          );
          queryBuilder.setParameter("monthlyCategoryIds", uniqueCategoryIds);
        }
      }

      if (conditions.length > 0) {
        queryBuilder.andWhere(`(${conditions.join(" OR ")})`);
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

    queryBuilder.groupBy("month").orderBy("month", "ASC");

    const rows = await queryBuilder.getRawMany();

    return rows.map((row) => ({
      month: row.month,
      total: Math.round((Number(row.total) || 0) * 100) / 100,
      count: Number(row.count) || 0,
    }));
  }
}
