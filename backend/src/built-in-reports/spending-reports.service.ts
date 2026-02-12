import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Transaction } from "../transactions/entities/transaction.entity";
import { Category } from "../categories/entities/category.entity";
import { Payee } from "../payees/entities/payee.entity";
import {
  ReportCurrencyService,
  RawCategoryAggregate,
  RawPayeeAggregate,
  RawMonthlyCategoryAggregate,
} from "./report-currency.service";
import {
  SpendingByCategoryResponse,
  CategorySpendingItem,
  SpendingByPayeeResponse,
  PayeeSpendingItem,
  MonthlySpendingTrendResponse,
  MonthlySpendingItem,
  MonthlyCategorySpending,
} from "./dto";

@Injectable()
export class SpendingReportsService {
  constructor(
    @InjectRepository(Transaction)
    private transactionsRepository: Repository<Transaction>,
    @InjectRepository(Category)
    private categoriesRepository: Repository<Category>,
    @InjectRepository(Payee)
    private payeesRepository: Repository<Payee>,
    private currencyService: ReportCurrencyService,
  ) {}

  async getSpendingByCategory(
    userId: string,
    startDate: string | undefined,
    endDate: string,
  ): Promise<SpendingByCategoryResponse> {
    const defaultCurrency =
      await this.currencyService.getDefaultCurrency(userId);
    const rateMap = await this.currencyService.buildRateMap(defaultCurrency);

    let query = `
      SELECT
        COALESCE(ts.category_id, t.category_id) as category_id,
        t.currency_code,
        SUM(ABS(COALESCE(ts.amount, t.amount))) as total
      FROM transactions t
      LEFT JOIN transaction_splits ts ON ts.transaction_id = t.id
      LEFT JOIN accounts a ON a.id = t.account_id
      WHERE t.user_id = $1
        AND t.transaction_date <= $2
        AND COALESCE(ts.amount, t.amount) < 0
        AND t.is_transfer = false
        AND (t.status IS NULL OR t.status != 'VOID')
        AND t.parent_transaction_id IS NULL
        AND a.account_type != 'INVESTMENT'
        AND (ts.transfer_account_id IS NULL OR ts.id IS NULL)
    `;

    const params: (string | undefined)[] = [userId, endDate];

    if (startDate) {
      query += ` AND t.transaction_date >= $3`;
      params.push(startDate);
    }

    query += ` GROUP BY COALESCE(ts.category_id, t.category_id), t.currency_code`;

    const rawResults: RawCategoryAggregate[] =
      await this.transactionsRepository.query(query, params);

    const categories = await this.categoriesRepository.find({
      where: { userId },
    });
    const categoryMap = new Map(categories.map((c) => [c.id, c]));

    const parentTotals = new Map<
      string,
      { total: number; category: Category | null }
    >();

    for (const row of rawResults) {
      const total = this.currencyService.convertAmount(
        parseFloat(row.total) || 0,
        row.currency_code,
        defaultCurrency,
        rateMap,
      );
      const categoryId = row.category_id;

      if (!categoryId) {
        const existing = parentTotals.get("uncategorized");
        if (existing) {
          existing.total += total;
        } else {
          parentTotals.set("uncategorized", { total, category: null });
        }
        continue;
      }

      const category = categoryMap.get(categoryId);
      if (!category) {
        const existing = parentTotals.get("uncategorized");
        if (existing) {
          existing.total += total;
        } else {
          parentTotals.set("uncategorized", { total, category: null });
        }
        continue;
      }

      const parentCategory = category.parentId
        ? categoryMap.get(category.parentId)
        : null;
      const displayCategory = parentCategory || category;
      const displayId = displayCategory.id;

      const existing = parentTotals.get(displayId);
      if (existing) {
        existing.total += total;
      } else {
        parentTotals.set(displayId, { total, category: displayCategory });
      }
    }

    const data: CategorySpendingItem[] = Array.from(parentTotals.entries())
      .map(([id, { total, category }]) => ({
        categoryId: id === "uncategorized" ? null : id,
        categoryName: category?.name || "Uncategorized",
        color: category?.color || null,
        total: Math.round(total * 100) / 100,
      }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 15);

    const totalSpending = data.reduce((sum, item) => sum + item.total, 0);

    return {
      data,
      totalSpending: Math.round(totalSpending * 100) / 100,
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
        SUM(ABS(t.amount)) as total
      FROM transactions t
      LEFT JOIN accounts a ON a.id = t.account_id
      WHERE t.user_id = $1
        AND t.transaction_date <= $2
        AND t.amount < 0
        AND t.is_transfer = false
        AND (t.status IS NULL OR t.status != 'VOID')
        AND t.parent_transaction_id IS NULL
        AND a.account_type != 'INVESTMENT'
      `;

    const params: (string | undefined)[] = [userId, endDate];

    if (startDate) {
      query += ` AND t.transaction_date >= $3`;
      params.push(startDate);
    }

    query += ` GROUP BY t.payee_id, t.payee_name, t.currency_code`;

    const rawResults: RawPayeeAggregate[] =
      await this.transactionsRepository.query(query, params);

    const payeeIds = rawResults
      .filter((r) => r.payee_id)
      .map((r) => r.payee_id as string);

    const payees =
      payeeIds.length > 0
        ? await this.payeesRepository.findByIds(payeeIds)
        : [];
    const payeeMap = new Map(payees.map((p) => [p.id, p]));

    const payeeTotals = new Map<
      string,
      { payeeId: string | null; payeeName: string; total: number }
    >();
    for (const row of rawResults) {
      const total = this.currencyService.convertAmount(
        parseFloat(row.total) || 0,
        row.currency_code,
        defaultCurrency,
        rateMap,
      );
      const key = row.payee_id || row.payee_name || "unknown";
      const payee = row.payee_id ? payeeMap.get(row.payee_id) : null;
      const existing = payeeTotals.get(key);
      if (existing) {
        existing.total += total;
      } else {
        payeeTotals.set(key, {
          payeeId: row.payee_id,
          payeeName: payee?.name || row.payee_name || "Unknown",
          total,
        });
      }
    }

    const data: PayeeSpendingItem[] = Array.from(payeeTotals.values())
      .map((row) => ({
        payeeId: row.payeeId,
        payeeName: row.payeeName,
        total: Math.round(row.total * 100) / 100,
      }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 20);

    const totalSpending = data.reduce((sum, item) => sum + item.total, 0);

    return {
      data,
      totalSpending: Math.round(totalSpending * 100) / 100,
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
        SUM(ABS(COALESCE(ts.amount, t.amount))) as total
      FROM transactions t
      LEFT JOIN transaction_splits ts ON ts.transaction_id = t.id
      LEFT JOIN accounts a ON a.id = t.account_id
      WHERE t.user_id = $1
        AND t.transaction_date <= $2
        AND COALESCE(ts.amount, t.amount) < 0
        AND t.is_transfer = false
        AND (t.status IS NULL OR t.status != 'VOID')
        AND t.parent_transaction_id IS NULL
        AND a.account_type != 'INVESTMENT'
        AND (ts.transfer_account_id IS NULL OR ts.id IS NULL)
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

    const rawResults: RawMonthlyCategoryAggregate[] =
      await this.transactionsRepository.query(query, params);

    const categories = await this.categoriesRepository.find({
      where: { userId },
    });
    const categoryMap = new Map(categories.map((c) => [c.id, c]));

    const monthlyData = new Map<
      string,
      Map<string, { total: number; category: Category | null }>
    >();

    for (const row of rawResults) {
      const month = row.month;
      const total = this.currencyService.convertAmount(
        parseFloat(row.total) || 0,
        row.currency_code,
        defaultCurrency,
        rateMap,
      );
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
        existing.total += total;
      } else {
        monthMap.set(displayId, { total, category: displayCategory });
      }
    }

    const allCategoryTotals = new Map<string, number>();
    for (const monthMap of monthlyData.values()) {
      for (const [catId, { total }] of monthMap) {
        allCategoryTotals.set(
          catId,
          (allCategoryTotals.get(catId) || 0) + total,
        );
      }
    }
    const topCategories = Array.from(allCategoryTotals.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([id]) => id);

    const data: MonthlySpendingItem[] = Array.from(monthlyData.entries())
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
              total: Math.round((catData?.total || 0) * 100) / 100,
            };
          },
        );

        const totalSpending = categories.reduce(
          (sum, cat) => sum + cat.total,
          0,
        );

        return {
          month,
          categories,
          totalSpending: Math.round(totalSpending * 100) / 100,
        };
      });

    return { data };
  }
}
