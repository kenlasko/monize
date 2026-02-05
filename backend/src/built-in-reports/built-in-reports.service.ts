import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Transaction } from '../transactions/entities/transaction.entity';
import { Category } from '../categories/entities/category.entity';
import { Payee } from '../payees/entities/payee.entity';
import {
  SpendingByCategoryResponse,
  CategorySpendingItem,
  SpendingByPayeeResponse,
  PayeeSpendingItem,
  IncomeBySourceResponse,
  IncomeSourceItem,
  MonthlySpendingTrendResponse,
  MonthlySpendingItem,
  MonthlyCategorySpending,
  IncomeVsExpensesResponse,
  MonthlyIncomeExpenseItem,
  YearOverYearResponse,
  YearData,
  WeekendVsWeekdayResponse,
  DaySpending,
  CategoryWeekendWeekday,
  SpendingAnomaliesResponse,
  SpendingAnomaly,
  AnomalySeverity,
  TaxSummaryResponse,
  RecurringExpensesResponse,
  RecurringExpenseItem,
  BillPaymentHistoryResponse,
  BillPaymentItem,
  MonthlyBillTotal,
  UncategorizedTransactionsResponse,
  UncategorizedTransactionItem,
  DuplicateTransactionsResponse,
  DuplicateGroup,
  DuplicateTransactionItem,
} from './dto';

interface RawCategoryAggregate {
  category_id: string | null;
  total: string;
}

interface RawPayeeAggregate {
  payee_id: string | null;
  payee_name: string | null;
  total: string;
}

interface RawMonthlyAggregate {
  month: string;
  income: string;
  expenses: string;
}

interface RawMonthlyCategoryAggregate {
  month: string;
  category_id: string | null;
  total: string;
}

@Injectable()
export class BuiltInReportsService {
  constructor(
    @InjectRepository(Transaction)
    private transactionsRepository: Repository<Transaction>,
    @InjectRepository(Category)
    private categoriesRepository: Repository<Category>,
    @InjectRepository(Payee)
    private payeesRepository: Repository<Payee>,
  ) {}

  /**
   * Get spending by category with parent rollup
   */
  async getSpendingByCategory(
    userId: string,
    startDate: string | undefined,
    endDate: string,
  ): Promise<SpendingByCategoryResponse> {
    // Build the base query for aggregating expenses by category
    // Uses COALESCE to handle split transactions
    let query = `
      SELECT
        COALESCE(ts.category_id, t.category_id) as category_id,
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

    query += ` GROUP BY COALESCE(ts.category_id, t.category_id)`;

    const rawResults: RawCategoryAggregate[] =
      await this.transactionsRepository.query(query, params);

    // Get all categories for the user to enable parent rollup
    const categories = await this.categoriesRepository.find({
      where: { userId },
    });
    const categoryMap = new Map(categories.map((c) => [c.id, c]));

    // Roll up to parent categories
    const parentTotals = new Map<
      string,
      { total: number; category: Category | null }
    >();

    for (const row of rawResults) {
      const total = parseFloat(row.total) || 0;
      const categoryId = row.category_id;

      if (!categoryId) {
        // Uncategorized
        const existing = parentTotals.get('uncategorized');
        if (existing) {
          existing.total += total;
        } else {
          parentTotals.set('uncategorized', { total, category: null });
        }
        continue;
      }

      const category = categoryMap.get(categoryId);
      if (!category) {
        // Category not found, treat as uncategorized
        const existing = parentTotals.get('uncategorized');
        if (existing) {
          existing.total += total;
        } else {
          parentTotals.set('uncategorized', { total, category: null });
        }
        continue;
      }

      // Determine display category (parent if exists, otherwise self)
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

    // Convert to response format, sort by total descending, limit to top 15
    const data: CategorySpendingItem[] = Array.from(parentTotals.entries())
      .map(([id, { total, category }]) => ({
        categoryId: id === 'uncategorized' ? null : id,
        categoryName: category?.name || 'Uncategorized',
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

  /**
   * Get spending by payee
   */
  async getSpendingByPayee(
    userId: string,
    startDate: string | undefined,
    endDate: string,
  ): Promise<SpendingByPayeeResponse> {
    let query = `
      SELECT
        t.payee_id,
        t.payee_name,
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

    query += ` GROUP BY t.payee_id, t.payee_name ORDER BY total DESC LIMIT 20`;

    const rawResults: RawPayeeAggregate[] =
      await this.transactionsRepository.query(query, params);

    // Get payees for names
    const payeeIds = rawResults
      .filter((r) => r.payee_id)
      .map((r) => r.payee_id as string);

    const payees =
      payeeIds.length > 0
        ? await this.payeesRepository.findByIds(payeeIds)
        : [];
    const payeeMap = new Map(payees.map((p) => [p.id, p]));

    const data: PayeeSpendingItem[] = rawResults.map((row) => {
      const payee = row.payee_id ? payeeMap.get(row.payee_id) : null;
      return {
        payeeId: row.payee_id,
        payeeName: payee?.name || row.payee_name || 'Unknown',
        total: Math.round(parseFloat(row.total) * 100) / 100,
      };
    });

    const totalSpending = data.reduce((sum, item) => sum + item.total, 0);

    return {
      data,
      totalSpending: Math.round(totalSpending * 100) / 100,
    };
  }

  /**
   * Get income by source (category) with parent rollup
   */
  async getIncomeBySource(
    userId: string,
    startDate: string | undefined,
    endDate: string,
  ): Promise<IncomeBySourceResponse> {
    let query = `
      SELECT
        COALESCE(ts.category_id, t.category_id) as category_id,
        SUM(COALESCE(ts.amount, t.amount)) as total
      FROM transactions t
      LEFT JOIN transaction_splits ts ON ts.transaction_id = t.id
      LEFT JOIN accounts a ON a.id = t.account_id
      WHERE t.user_id = $1
        AND t.transaction_date <= $2
        AND COALESCE(ts.amount, t.amount) > 0
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

    query += ` GROUP BY COALESCE(ts.category_id, t.category_id)`;

    const rawResults: RawCategoryAggregate[] =
      await this.transactionsRepository.query(query, params);

    // Get all categories for parent rollup
    const categories = await this.categoriesRepository.find({
      where: { userId },
    });
    const categoryMap = new Map(categories.map((c) => [c.id, c]));

    // Roll up to parent categories
    const parentTotals = new Map<
      string,
      { total: number; category: Category | null }
    >();

    for (const row of rawResults) {
      const total = parseFloat(row.total) || 0;
      const categoryId = row.category_id;

      if (!categoryId) {
        const existing = parentTotals.get('uncategorized');
        if (existing) {
          existing.total += total;
        } else {
          parentTotals.set('uncategorized', { total, category: null });
        }
        continue;
      }

      const category = categoryMap.get(categoryId);
      if (!category) {
        const existing = parentTotals.get('uncategorized');
        if (existing) {
          existing.total += total;
        } else {
          parentTotals.set('uncategorized', { total, category: null });
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

    const data: IncomeSourceItem[] = Array.from(parentTotals.entries())
      .map(([id, { total, category }]) => ({
        categoryId: id === 'uncategorized' ? null : id,
        categoryName: category?.name || 'Uncategorized',
        color: category?.color || null,
        total: Math.round(total * 100) / 100,
      }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 15);

    const totalIncome = data.reduce((sum, item) => sum + item.total, 0);

    return {
      data,
      totalIncome: Math.round(totalIncome * 100) / 100,
    };
  }

  /**
   * Get monthly spending trend by category
   */
  async getMonthlySpendingTrend(
    userId: string,
    startDate: string | undefined,
    endDate: string,
  ): Promise<MonthlySpendingTrendResponse> {
    let query = `
      SELECT
        TO_CHAR(t.transaction_date, 'YYYY-MM') as month,
        COALESCE(ts.category_id, t.category_id) as category_id,
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
      GROUP BY TO_CHAR(t.transaction_date, 'YYYY-MM'), COALESCE(ts.category_id, t.category_id)
      ORDER BY month
    `;

    const rawResults: RawMonthlyCategoryAggregate[] =
      await this.transactionsRepository.query(query, params);

    // Get all categories for parent rollup
    const categories = await this.categoriesRepository.find({
      where: { userId },
    });
    const categoryMap = new Map(categories.map((c) => [c.id, c]));

    // Group by month and roll up to parent categories
    const monthlyData = new Map<
      string,
      Map<string, { total: number; category: Category | null }>
    >();

    for (const row of rawResults) {
      const month = row.month;
      const total = parseFloat(row.total) || 0;
      const categoryId = row.category_id;

      if (!monthlyData.has(month)) {
        monthlyData.set(month, new Map());
      }
      const monthMap = monthlyData.get(month)!;

      let displayId = 'uncategorized';
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

    // Find top categories across all months for consistent display
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

    // Convert to response format
    const data: MonthlySpendingItem[] = Array.from(monthlyData.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([month, catMap]) => {
        const categories: MonthlyCategorySpending[] = topCategories.map(
          (catId) => {
            const catData = catMap.get(catId);
            const category =
              catId === 'uncategorized' ? null : categoryMap.get(catId);
            return {
              categoryId: catId === 'uncategorized' ? null : catId,
              categoryName: category?.name || 'Uncategorized',
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

  /**
   * Get income vs expenses by month
   */
  async getIncomeVsExpenses(
    userId: string,
    startDate: string | undefined,
    endDate: string,
  ): Promise<IncomeVsExpensesResponse> {
    let query = `
      SELECT
        TO_CHAR(t.transaction_date, 'YYYY-MM') as month,
        SUM(CASE WHEN COALESCE(ts.amount, t.amount) > 0 THEN COALESCE(ts.amount, t.amount) ELSE 0 END) as income,
        SUM(CASE WHEN COALESCE(ts.amount, t.amount) < 0 THEN ABS(COALESCE(ts.amount, t.amount)) ELSE 0 END) as expenses
      FROM transactions t
      LEFT JOIN transaction_splits ts ON ts.transaction_id = t.id
      LEFT JOIN accounts a ON a.id = t.account_id
      WHERE t.user_id = $1
        AND t.transaction_date <= $2
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
      GROUP BY TO_CHAR(t.transaction_date, 'YYYY-MM')
      ORDER BY month
    `;

    const rawResults: RawMonthlyAggregate[] =
      await this.transactionsRepository.query(query, params);

    const data: MonthlyIncomeExpenseItem[] = rawResults.map((row) => {
      const income = Math.round(parseFloat(row.income) * 100) / 100;
      const expenses = Math.round(parseFloat(row.expenses) * 100) / 100;
      return {
        month: row.month,
        income,
        expenses,
        net: Math.round((income - expenses) * 100) / 100,
      };
    });

    const totals = data.reduce(
      (acc, item) => ({
        income: acc.income + item.income,
        expenses: acc.expenses + item.expenses,
        net: acc.net + item.net,
      }),
      { income: 0, expenses: 0, net: 0 },
    );

    return {
      data,
      totals: {
        income: Math.round(totals.income * 100) / 100,
        expenses: Math.round(totals.expenses * 100) / 100,
        net: Math.round(totals.net * 100) / 100,
      },
    };
  }

  /**
   * Get year-over-year comparison data
   */
  async getYearOverYear(
    userId: string,
    yearsToCompare: number,
  ): Promise<YearOverYearResponse> {
    const currentYear = new Date().getFullYear();
    const oldestYear = currentYear - yearsToCompare + 1;

    const query = `
      SELECT
        EXTRACT(YEAR FROM t.transaction_date)::int as year,
        EXTRACT(MONTH FROM t.transaction_date)::int as month,
        SUM(CASE WHEN COALESCE(ts.amount, t.amount) > 0 THEN COALESCE(ts.amount, t.amount) ELSE 0 END) as income,
        SUM(CASE WHEN COALESCE(ts.amount, t.amount) < 0 THEN ABS(COALESCE(ts.amount, t.amount)) ELSE 0 END) as expenses
      FROM transactions t
      LEFT JOIN transaction_splits ts ON ts.transaction_id = t.id
      LEFT JOIN accounts a ON a.id = t.account_id
      WHERE t.user_id = $1
        AND EXTRACT(YEAR FROM t.transaction_date) >= $2
        AND EXTRACT(YEAR FROM t.transaction_date) <= $3
        AND t.is_transfer = false
        AND (t.status IS NULL OR t.status != 'VOID')
        AND t.parent_transaction_id IS NULL
        AND a.account_type != 'INVESTMENT'
        AND (ts.transfer_account_id IS NULL OR ts.id IS NULL)
      GROUP BY EXTRACT(YEAR FROM t.transaction_date), EXTRACT(MONTH FROM t.transaction_date)
      ORDER BY year, month
    `;

    interface RawYearMonth {
      year: number;
      month: number;
      income: string;
      expenses: string;
    }

    const rawResults: RawYearMonth[] = await this.transactionsRepository.query(
      query,
      [userId, oldestYear, currentYear],
    );

    // Group by year
    const yearMap = new Map<number, YearData>();
    for (let year = oldestYear; year <= currentYear; year++) {
      yearMap.set(year, {
        year,
        months: Array.from({ length: 12 }, (_, i) => ({
          month: i + 1,
          income: 0,
          expenses: 0,
          savings: 0,
        })),
        totals: { income: 0, expenses: 0, savings: 0 },
      });
    }

    rawResults.forEach((row) => {
      const yearData = yearMap.get(row.year);
      if (yearData) {
        const monthData = yearData.months[row.month - 1];
        const income = Math.round(parseFloat(row.income) * 100) / 100;
        const expenses = Math.round(parseFloat(row.expenses) * 100) / 100;
        monthData.income = income;
        monthData.expenses = expenses;
        monthData.savings = Math.round((income - expenses) * 100) / 100;

        yearData.totals.income += income;
        yearData.totals.expenses += expenses;
        yearData.totals.savings += income - expenses;
      }
    });

    // Round totals
    yearMap.forEach((yearData) => {
      yearData.totals.income = Math.round(yearData.totals.income * 100) / 100;
      yearData.totals.expenses =
        Math.round(yearData.totals.expenses * 100) / 100;
      yearData.totals.savings = Math.round(yearData.totals.savings * 100) / 100;
    });

    return {
      data: Array.from(yearMap.values()).sort((a, b) => a.year - b.year),
    };
  }

  /**
   * Get weekend vs weekday spending analysis
   */
  async getWeekendVsWeekday(
    userId: string,
    startDate: string | undefined,
    endDate: string,
  ): Promise<WeekendVsWeekdayResponse> {
    let query = `
      SELECT
        EXTRACT(DOW FROM t.transaction_date)::int as day_of_week,
        COALESCE(ts.category_id, t.category_id) as category_id,
        COUNT(*)::int as tx_count,
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

    query += ` GROUP BY EXTRACT(DOW FROM t.transaction_date), COALESCE(ts.category_id, t.category_id)`;

    interface RawDayCategory {
      day_of_week: number;
      category_id: string | null;
      tx_count: number;
      total: string;
    }

    const rawResults: RawDayCategory[] =
      await this.transactionsRepository.query(query, params);

    // Get categories for names
    const categories = await this.categoriesRepository.find({
      where: { userId },
    });
    const categoryMap = new Map(categories.map((c) => [c.id, c]));

    // Aggregate by day
    const dayTotals = [0, 0, 0, 0, 0, 0, 0];
    const dayCounts = [0, 0, 0, 0, 0, 0, 0];

    // Aggregate by category with parent rollup
    const weekendByCategory = new Map<
      string,
      { name: string; total: number }
    >();
    const weekdayByCategory = new Map<
      string,
      { name: string; total: number }
    >();

    rawResults.forEach((row) => {
      const total = parseFloat(row.total) || 0;
      const count = row.tx_count;
      const isWeekend = row.day_of_week === 0 || row.day_of_week === 6;

      dayTotals[row.day_of_week] += total;
      dayCounts[row.day_of_week] += count;

      // Category rollup
      let displayId = 'uncategorized';
      let displayName = 'Uncategorized';
      if (row.category_id) {
        const category = categoryMap.get(row.category_id);
        if (category) {
          const parentCategory = category.parentId
            ? categoryMap.get(category.parentId)
            : null;
          const displayCategory = parentCategory || category;
          displayId = displayCategory.id;
          displayName = displayCategory.name;
        }
      }

      const targetMap = isWeekend ? weekendByCategory : weekdayByCategory;
      const existing = targetMap.get(displayId);
      if (existing) {
        existing.total += total;
      } else {
        targetMap.set(displayId, { name: displayName, total });
      }
    });

    // Build summary
    const weekendTotal =
      Math.round((dayTotals[0] + dayTotals[6]) * 100) / 100;
    const weekdayTotal =
      Math.round(
        (dayTotals[1] +
          dayTotals[2] +
          dayTotals[3] +
          dayTotals[4] +
          dayTotals[5]) *
          100,
      ) / 100;
    const weekendCount = dayCounts[0] + dayCounts[6];
    const weekdayCount =
      dayCounts[1] + dayCounts[2] + dayCounts[3] + dayCounts[4] + dayCounts[5];

    // Build byDay array
    const byDay: DaySpending[] = dayTotals.map((total, index) => ({
      dayOfWeek: index,
      total: Math.round(total * 100) / 100,
      count: dayCounts[index],
    }));

    // Build byCategory array
    const allCategories = new Set([
      ...weekendByCategory.keys(),
      ...weekdayByCategory.keys(),
    ]);
    const byCategory: CategoryWeekendWeekday[] = Array.from(allCategories)
      .map((catId) => {
        const weekend = weekendByCategory.get(catId);
        const weekday = weekdayByCategory.get(catId);
        return {
          categoryId: catId === 'uncategorized' ? null : catId,
          categoryName: weekend?.name || weekday?.name || 'Unknown',
          weekendTotal: Math.round((weekend?.total || 0) * 100) / 100,
          weekdayTotal: Math.round((weekday?.total || 0) * 100) / 100,
        };
      })
      .sort(
        (a, b) =>
          b.weekendTotal + b.weekdayTotal - (a.weekendTotal + a.weekdayTotal),
      )
      .slice(0, 10);

    return {
      summary: {
        weekendTotal,
        weekdayTotal,
        weekendCount,
        weekdayCount,
      },
      byDay,
      byCategory,
    };
  }

  /**
   * Get spending anomalies (large transactions, category spikes, new payees)
   */
  async getSpendingAnomalies(
    userId: string,
    threshold: number = 2,
  ): Promise<SpendingAnomaliesResponse> {
    // Get last 6 months of expenses
    const now = new Date();
    const sixMonthsAgo = new Date(now);
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    const startDate = sixMonthsAgo.toISOString().split('T')[0];
    const endDate = now.toISOString().split('T')[0];

    // Query all expense transactions
    const query = `
      SELECT
        t.id,
        t.transaction_date,
        t.payee_id,
        t.payee_name,
        COALESCE(ts.category_id, t.category_id) as category_id,
        ABS(COALESCE(ts.amount, t.amount)) as amount
      FROM transactions t
      LEFT JOIN transaction_splits ts ON ts.transaction_id = t.id
      LEFT JOIN accounts a ON a.id = t.account_id
      WHERE t.user_id = $1
        AND t.transaction_date >= $2
        AND t.transaction_date <= $3
        AND COALESCE(ts.amount, t.amount) < 0
        AND t.is_transfer = false
        AND (t.status IS NULL OR t.status != 'VOID')
        AND t.parent_transaction_id IS NULL
        AND a.account_type != 'INVESTMENT'
        AND (ts.transfer_account_id IS NULL OR ts.id IS NULL)
      ORDER BY t.transaction_date
    `;

    interface RawExpense {
      id: string;
      transaction_date: Date;
      payee_id: string | null;
      payee_name: string | null;
      category_id: string | null;
      amount: string;
    }

    const rawResults: RawExpense[] = await this.transactionsRepository.query(
      query,
      [userId, startDate, endDate],
    );

    if (rawResults.length < 10) {
      return {
        statistics: { mean: 0, stdDev: 0 },
        anomalies: [],
        counts: { high: 0, medium: 0, low: 0 },
      };
    }

    // Get categories
    const categories = await this.categoriesRepository.find({
      where: { userId },
    });
    const categoryMap = new Map(categories.map((c) => [c.id, c]));

    // Calculate statistics
    const amounts = rawResults.map((r) => parseFloat(r.amount));
    const mean = amounts.reduce((sum, a) => sum + a, 0) / amounts.length;
    const variance =
      amounts.reduce((sum, a) => sum + Math.pow(a - mean, 2), 0) /
      amounts.length;
    const stdDev = Math.sqrt(variance);

    const anomalies: SpendingAnomaly[] = [];

    // 1. Large single transactions
    rawResults.forEach((row) => {
      const amount = parseFloat(row.amount);
      const zScore = (amount - mean) / stdDev;

      if (zScore > threshold) {
        const severity: AnomalySeverity =
          zScore > threshold * 2
            ? 'high'
            : zScore > threshold * 1.5
              ? 'medium'
              : 'low';
        const txDate = new Date(row.transaction_date);
        anomalies.push({
          type: 'large_transaction',
          severity,
          title: 'Unusually large transaction',
          description: `${row.payee_name || 'Unknown payee'} - ${txDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`,
          amount: Math.round(amount * 100) / 100,
          transactionId: row.id,
          transactionDate: row.transaction_date.toString().split('T')[0],
          payeeName: row.payee_name || undefined,
        });
      }
    });

    // 2. Category spending spikes (current month vs previous month)
    const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const prevMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);

    const currentMonthByCategory = new Map<string, number>();
    const previousMonthByCategory = new Map<string, number>();

    rawResults.forEach((row) => {
      const txDate = new Date(row.transaction_date);
      const amount = parseFloat(row.amount);
      const categoryId = row.category_id || 'uncategorized';

      if (txDate >= currentMonthStart) {
        currentMonthByCategory.set(
          categoryId,
          (currentMonthByCategory.get(categoryId) || 0) + amount,
        );
      } else if (txDate >= prevMonthStart && txDate <= prevMonthEnd) {
        previousMonthByCategory.set(
          categoryId,
          (previousMonthByCategory.get(categoryId) || 0) + amount,
        );
      }
    });

    currentMonthByCategory.forEach((currentAmount, categoryId) => {
      const previousAmount = previousMonthByCategory.get(categoryId) || 0;
      if (previousAmount < 50) return;

      const percentChange =
        ((currentAmount - previousAmount) / previousAmount) * 100;

      if (percentChange > 100) {
        const category =
          categoryId === 'uncategorized' ? null : categoryMap.get(categoryId);
        const severity: AnomalySeverity =
          percentChange > 300
            ? 'high'
            : percentChange > 200
              ? 'medium'
              : 'low';
        anomalies.push({
          type: 'category_spike',
          severity,
          title: `Spending spike in ${category?.name || 'Uncategorized'}`,
          description: `${Math.round(percentChange)}% increase from last month`,
          categoryId: categoryId === 'uncategorized' ? undefined : categoryId,
          categoryName: category?.name || 'Uncategorized',
          currentPeriodAmount: Math.round(currentAmount * 100) / 100,
          previousPeriodAmount: Math.round(previousAmount * 100) / 100,
          percentChange: Math.round(percentChange),
        });
      }
    });

    // 3. New payees with significant spending
    const oneMonthAgo = new Date(now);
    oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);

    const payeeFirstSeen = new Map<string, Date>();
    const payeeRecentSpending = new Map<
      string,
      { name: string; total: number; count: number; txId: string }
    >();

    rawResults.forEach((row) => {
      const payeeName = (row.payee_name || '').toLowerCase().trim();
      if (!payeeName) return;

      const txDate = new Date(row.transaction_date);

      if (!payeeFirstSeen.has(payeeName) || txDate < payeeFirstSeen.get(payeeName)!) {
        payeeFirstSeen.set(payeeName, txDate);
      }

      if (txDate >= oneMonthAgo) {
        const existing = payeeRecentSpending.get(payeeName);
        if (existing) {
          existing.total += parseFloat(row.amount);
          existing.count++;
        } else {
          payeeRecentSpending.set(payeeName, {
            name: row.payee_name || 'Unknown',
            total: parseFloat(row.amount),
            count: 1,
            txId: row.id,
          });
        }
      }
    });

    payeeFirstSeen.forEach((firstSeen, payeeName) => {
      if (firstSeen >= oneMonthAgo) {
        const recent = payeeRecentSpending.get(payeeName);
        if (recent && recent.total > 100) {
          const severity: AnomalySeverity =
            recent.total > 500 ? 'high' : recent.total > 200 ? 'medium' : 'low';
          anomalies.push({
            type: 'unusual_payee',
            severity,
            title: 'New payee detected',
            description: `${recent.name} - ${recent.count} transaction(s)`,
            amount: Math.round(recent.total * 100) / 100,
            transactionId: recent.txId,
            payeeName: recent.name,
          });
        }
      }
    });

    // Sort by severity and amount
    const severityOrder: Record<AnomalySeverity, number> = {
      high: 0,
      medium: 1,
      low: 2,
    };
    anomalies.sort((a, b) => {
      const severityDiff = severityOrder[a.severity] - severityOrder[b.severity];
      if (severityDiff !== 0) return severityDiff;
      return (b.amount || 0) - (a.amount || 0);
    });

    return {
      statistics: {
        mean: Math.round(mean * 100) / 100,
        stdDev: Math.round(stdDev * 100) / 100,
      },
      anomalies,
      counts: {
        high: anomalies.filter((a) => a.severity === 'high').length,
        medium: anomalies.filter((a) => a.severity === 'medium').length,
        low: anomalies.filter((a) => a.severity === 'low').length,
      },
    };
  }

  /**
   * Get tax summary for a given year
   */
  async getTaxSummary(userId: string, year: number): Promise<TaxSummaryResponse> {
    const startDate = `${year}-01-01`;
    const endDate = `${year}-12-31`;

    const query = `
      SELECT
        COALESCE(ts.category_id, t.category_id) as category_id,
        COALESCE(ts.amount, t.amount) as amount
      FROM transactions t
      LEFT JOIN transaction_splits ts ON ts.transaction_id = t.id
      LEFT JOIN accounts a ON a.id = t.account_id
      WHERE t.user_id = $1
        AND t.transaction_date >= $2
        AND t.transaction_date <= $3
        AND t.is_transfer = false
        AND (t.status IS NULL OR t.status != 'VOID')
        AND t.parent_transaction_id IS NULL
        AND a.account_type != 'INVESTMENT'
        AND (ts.transfer_account_id IS NULL OR ts.id IS NULL)
    `;

    interface RawTaxRow {
      category_id: string | null;
      amount: string;
    }

    const rawResults: RawTaxRow[] = await this.transactionsRepository.query(
      query,
      [userId, startDate, endDate],
    );

    // Get categories
    const categories = await this.categoriesRepository.find({
      where: { userId },
    });
    const categoryMap = new Map(categories.map((c) => [c.id, c]));

    // Tax-deductible keywords
    const taxDeductibleKeywords = [
      'medical',
      'health',
      'dental',
      'vision',
      'prescription',
      'pharmacy',
      'donation',
      'charity',
      'charitable',
      'education',
      'tuition',
      'school',
      'course',
      'training',
      'childcare',
      'daycare',
      'moving',
      'union',
      'professional dues',
      'rrsp',
      'retirement',
    ];

    const matchesKeywords = (name: string): boolean => {
      const lowerName = name.toLowerCase();
      return taxDeductibleKeywords.some((keyword) =>
        lowerName.includes(keyword),
      );
    };

    const incomeBySource = new Map<string, number>();
    const deductibleExpenses = new Map<string, number>();
    const allExpensesByCategory = new Map<string, number>();
    let totalIncome = 0;
    let totalExpenses = 0;

    rawResults.forEach((row) => {
      const amount = parseFloat(row.amount) || 0;
      const category = row.category_id ? categoryMap.get(row.category_id) : null;
      const parentCategory = category?.parentId
        ? categoryMap.get(category.parentId)
        : null;
      const catName = parentCategory?.name || category?.name || 'Uncategorized';

      if (amount > 0) {
        totalIncome += amount;
        incomeBySource.set(catName, (incomeBySource.get(catName) || 0) + amount);
      } else {
        const expenseAmt = Math.abs(amount);
        totalExpenses += expenseAmt;
        allExpensesByCategory.set(
          catName,
          (allExpensesByCategory.get(catName) || 0) + expenseAmt,
        );

        if (matchesKeywords(catName)) {
          deductibleExpenses.set(
            catName,
            (deductibleExpenses.get(catName) || 0) + expenseAmt,
          );
        }
      }
    });

    const totalDeductible = Array.from(deductibleExpenses.values()).reduce(
      (sum, v) => sum + v,
      0,
    );

    return {
      incomeBySource: Array.from(incomeBySource.entries())
        .map(([name, total]) => ({
          name,
          total: Math.round(total * 100) / 100,
        }))
        .sort((a, b) => b.total - a.total),
      deductibleExpenses: Array.from(deductibleExpenses.entries())
        .map(([name, total]) => ({
          name,
          total: Math.round(total * 100) / 100,
        }))
        .sort((a, b) => b.total - a.total),
      allExpenses: Array.from(allExpensesByCategory.entries())
        .map(([name, total]) => ({
          name,
          total: Math.round(total * 100) / 100,
        }))
        .sort((a, b) => b.total - a.total),
      totals: {
        income: Math.round(totalIncome * 100) / 100,
        expenses: Math.round(totalExpenses * 100) / 100,
        deductible: Math.round(totalDeductible * 100) / 100,
      },
    };
  }

  /**
   * Get recurring expenses analysis
   */
  async getRecurringExpenses(
    userId: string,
    minOccurrences: number = 3,
  ): Promise<RecurringExpensesResponse> {
    // Get last 6 months of expenses
    const now = new Date();
    const sixMonthsAgo = new Date(now);
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    const startDate = sixMonthsAgo.toISOString().split('T')[0];
    const endDate = now.toISOString().split('T')[0];

    const query = `
      SELECT
        t.payee_id,
        LOWER(TRIM(COALESCE(p.name, t.payee_name))) as payee_name_normalized,
        COALESCE(p.name, t.payee_name) as payee_name,
        c.name as category_name,
        COUNT(*)::int as occurrences,
        SUM(ABS(t.amount)) as total_amount,
        MAX(t.transaction_date) as last_transaction_date
      FROM transactions t
      LEFT JOIN payees p ON p.id = t.payee_id
      LEFT JOIN categories c ON c.id = t.category_id
      LEFT JOIN accounts a ON a.id = t.account_id
      WHERE t.user_id = $1
        AND t.transaction_date >= $2
        AND t.transaction_date <= $3
        AND t.amount < 0
        AND t.is_transfer = false
        AND (t.status IS NULL OR t.status != 'VOID')
        AND t.parent_transaction_id IS NULL
        AND a.account_type != 'INVESTMENT'
        AND (COALESCE(p.name, t.payee_name) IS NOT NULL AND TRIM(COALESCE(p.name, t.payee_name)) != '')
      GROUP BY t.payee_id, LOWER(TRIM(COALESCE(p.name, t.payee_name))), COALESCE(p.name, t.payee_name), c.name
      HAVING COUNT(*) >= $4
      ORDER BY SUM(ABS(t.amount)) DESC
    `;

    interface RawRecurring {
      payee_id: string | null;
      payee_name_normalized: string;
      payee_name: string;
      category_name: string | null;
      occurrences: number;
      total_amount: string;
      last_transaction_date: Date;
    }

    const rawResults: RawRecurring[] = await this.transactionsRepository.query(
      query,
      [userId, startDate, endDate, minOccurrences],
    );

    const data: RecurringExpenseItem[] = rawResults.map((row) => {
      const totalAmount = parseFloat(row.total_amount);
      const occurrences = row.occurrences;

      // Estimate frequency based on occurrences over 6 months
      let frequency = 'Irregular';
      if (occurrences >= 24) frequency = 'Weekly';
      else if (occurrences >= 12) frequency = 'Bi-weekly';
      else if (occurrences >= 5) frequency = 'Monthly';
      else if (occurrences >= 3) frequency = 'Occasional';

      return {
        payeeName: row.payee_name,
        payeeId: row.payee_id,
        occurrences,
        totalAmount: Math.round(totalAmount * 100) / 100,
        averageAmount: Math.round((totalAmount / occurrences) * 100) / 100,
        lastTransactionDate: new Date(row.last_transaction_date)
          .toISOString()
          .split('T')[0],
        frequency,
        categoryName: row.category_name || 'Uncategorized',
      };
    });

    const totalRecurring = data.reduce((sum, item) => sum + item.totalAmount, 0);

    return {
      data,
      summary: {
        totalRecurring: Math.round(totalRecurring * 100) / 100,
        monthlyEstimate: Math.round((totalRecurring / 6) * 100) / 100,
        uniquePayees: data.length,
      },
    };
  }

  /**
   * Get bill payment history
   */
  async getBillPaymentHistory(
    userId: string,
    startDate: string | undefined,
    endDate: string,
  ): Promise<BillPaymentHistoryResponse> {
    // Get scheduled transactions
    const scheduledQuery = `
      SELECT
        st.id,
        st.name,
        st.amount,
        COALESCE(p.name, st.payee_name) as payee_name
      FROM scheduled_transactions st
      LEFT JOIN payees p ON p.id = st.payee_id
      WHERE st.user_id = $1
        AND st.is_transfer = false
    `;

    interface RawScheduled {
      id: string;
      name: string;
      amount: string;
      payee_name: string | null;
    }

    const scheduledTx: RawScheduled[] = await this.transactionsRepository.query(
      scheduledQuery,
      [userId],
    );

    if (scheduledTx.length === 0) {
      return {
        billPayments: [],
        monthlyTotals: [],
        summary: {
          totalPaid: 0,
          totalPayments: 0,
          uniqueBills: 0,
          monthlyAverage: 0,
        },
      };
    }

    // Build payee name to scheduled transaction mapping
    const payeeToScheduled = new Map<
      string,
      { id: string; name: string; amount: number }
    >();
    scheduledTx.forEach((st) => {
      if (st.payee_name) {
        payeeToScheduled.set(st.payee_name.toLowerCase().trim(), {
          id: st.id,
          name: st.name,
          amount: Math.abs(parseFloat(st.amount)),
        });
      }
    });

    // Get transactions and match to scheduled
    let txQuery = `
      SELECT
        t.id,
        t.transaction_date,
        ABS(t.amount) as amount,
        LOWER(TRIM(COALESCE(p.name, t.payee_name))) as payee_name_normalized
      FROM transactions t
      LEFT JOIN payees p ON p.id = t.payee_id
      LEFT JOIN accounts a ON a.id = t.account_id
      WHERE t.user_id = $1
        AND t.transaction_date <= $2
        AND t.is_transfer = false
        AND (t.status IS NULL OR t.status != 'VOID')
        AND t.parent_transaction_id IS NULL
        AND a.account_type != 'INVESTMENT'
    `;

    const params: (string | undefined)[] = [userId, endDate];

    if (startDate) {
      txQuery += ` AND t.transaction_date >= $3`;
      params.push(startDate);
    }

    interface RawTx {
      id: string;
      transaction_date: Date;
      amount: string;
      payee_name_normalized: string | null;
    }

    const transactions: RawTx[] = await this.transactionsRepository.query(
      txQuery,
      params,
    );

    // Match transactions to scheduled bills
    const billPaymentMap = new Map<
      string,
      {
        id: string;
        name: string;
        payeeName: string;
        payments: { date: Date; amount: number }[];
      }
    >();

    transactions.forEach((tx) => {
      if (!tx.payee_name_normalized) return;
      const scheduled = payeeToScheduled.get(tx.payee_name_normalized);
      if (!scheduled) return;

      const txAmount = parseFloat(tx.amount);
      // Match within 20% tolerance
      if (
        txAmount >= scheduled.amount * 0.8 &&
        txAmount <= scheduled.amount * 1.2
      ) {
        let payment = billPaymentMap.get(scheduled.id);
        if (!payment) {
          payment = {
            id: scheduled.id,
            name: scheduled.name,
            payeeName: tx.payee_name_normalized,
            payments: [],
          };
          billPaymentMap.set(scheduled.id, payment);
        }
        payment.payments.push({
          date: new Date(tx.transaction_date),
          amount: txAmount,
        });
      }
    });

    // Calculate bill payment stats
    const billPayments: BillPaymentItem[] = Array.from(billPaymentMap.values())
      .filter((bp) => bp.payments.length > 0)
      .map((bp) => {
        const totalPaid = bp.payments.reduce((sum, p) => sum + p.amount, 0);
        const sortedPayments = [...bp.payments].sort(
          (a, b) => b.date.getTime() - a.date.getTime(),
        );
        return {
          scheduledTransactionId: bp.id,
          scheduledTransactionName: bp.name,
          payeeName: bp.payeeName,
          totalPaid: Math.round(totalPaid * 100) / 100,
          paymentCount: bp.payments.length,
          averagePayment:
            Math.round((totalPaid / bp.payments.length) * 100) / 100,
          lastPaymentDate: sortedPayments[0]?.date.toISOString().split('T')[0] || null,
        };
      })
      .sort((a, b) => b.totalPaid - a.totalPaid);

    // Calculate monthly totals
    const monthlyMap = new Map<string, { total: number; label: string }>();
    billPaymentMap.forEach((bp) => {
      bp.payments.forEach((payment) => {
        const monthKey = payment.date.toISOString().slice(0, 7);
        const existing = monthlyMap.get(monthKey);
        if (existing) {
          existing.total += payment.amount;
        } else {
          const d = new Date(payment.date);
          monthlyMap.set(monthKey, {
            total: payment.amount,
            label: d.toLocaleDateString('en-US', {
              month: 'short',
              year: '2-digit',
            }),
          });
        }
      });
    });

    const monthlyTotals: MonthlyBillTotal[] = Array.from(monthlyMap.entries())
      .map(([month, data]) => ({
        month,
        label: data.label,
        total: Math.round(data.total * 100) / 100,
      }))
      .sort((a, b) => a.month.localeCompare(b.month));

    // Calculate summary
    const totalPaid = billPayments.reduce((sum, bp) => sum + bp.totalPaid, 0);
    const totalPayments = billPayments.reduce(
      (sum, bp) => sum + bp.paymentCount,
      0,
    );
    const monthCount = monthlyTotals.length || 1;

    return {
      billPayments,
      monthlyTotals,
      summary: {
        totalPaid: Math.round(totalPaid * 100) / 100,
        totalPayments,
        uniqueBills: billPayments.length,
        monthlyAverage: Math.round((totalPaid / monthCount) * 100) / 100,
      },
    };
  }

  /**
   * Get uncategorized transactions with summary stats
   */
  async getUncategorizedTransactions(
    userId: string,
    startDate: string | undefined,
    endDate: string,
    limit: number = 500,
  ): Promise<UncategorizedTransactionsResponse> {
    // Build query for uncategorized transactions
    // A transaction is uncategorized if:
    // - Non-split: category_id is NULL
    // - Split: parent has no category AND all splits have no category
    let query = `
      SELECT
        t.id,
        t.transaction_date,
        t.amount,
        COALESCE(p.name, t.payee_name) as payee_name,
        t.description,
        a.name as account_name
      FROM transactions t
      LEFT JOIN payees p ON p.id = t.payee_id
      LEFT JOIN accounts a ON a.id = t.account_id
      WHERE t.user_id = $1
        AND t.transaction_date <= $2
        AND t.is_transfer = false
        AND (t.status IS NULL OR t.status != 'VOID')
        AND t.parent_transaction_id IS NULL
        AND a.account_type != 'INVESTMENT'
        AND t.category_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM transaction_splits ts
          WHERE ts.transaction_id = t.id
          AND ts.category_id IS NOT NULL
        )
    `;

    const params: (string | number)[] = [userId, endDate];
    let paramIndex = 3;

    if (startDate) {
      query += ` AND t.transaction_date >= $${paramIndex}`;
      params.push(startDate);
      paramIndex++;
    }

    query += ` ORDER BY t.transaction_date DESC LIMIT $${paramIndex}`;
    params.push(limit);

    interface RawUncategorizedTx {
      id: string;
      transaction_date: string;
      amount: string;
      payee_name: string | null;
      description: string | null;
      account_name: string | null;
    }

    const rows: RawUncategorizedTx[] =
      await this.transactionsRepository.query(query, params);

    const transactions: UncategorizedTransactionItem[] = rows.map((row) => ({
      id: row.id,
      transactionDate: new Date(row.transaction_date).toISOString().split('T')[0],
      amount: parseFloat(row.amount),
      payeeName: row.payee_name,
      description: row.description,
      accountName: row.account_name,
    }));

    // Get summary stats (separate query without limit)
    let summaryQuery = `
      SELECT
        COUNT(*) as total_count,
        COUNT(*) FILTER (WHERE t.amount < 0) as expense_count,
        COALESCE(SUM(ABS(t.amount)) FILTER (WHERE t.amount < 0), 0) as expense_total,
        COUNT(*) FILTER (WHERE t.amount > 0) as income_count,
        COALESCE(SUM(t.amount) FILTER (WHERE t.amount > 0), 0) as income_total
      FROM transactions t
      LEFT JOIN accounts a ON a.id = t.account_id
      WHERE t.user_id = $1
        AND t.transaction_date <= $2
        AND t.is_transfer = false
        AND (t.status IS NULL OR t.status != 'VOID')
        AND t.parent_transaction_id IS NULL
        AND a.account_type != 'INVESTMENT'
        AND t.category_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM transaction_splits ts
          WHERE ts.transaction_id = t.id
          AND ts.category_id IS NOT NULL
        )
    `;

    const summaryParams: string[] = [userId, endDate];
    if (startDate) {
      summaryQuery += ` AND t.transaction_date >= $3`;
      summaryParams.push(startDate);
    }

    interface RawSummary {
      total_count: string;
      expense_count: string;
      expense_total: string;
      income_count: string;
      income_total: string;
    }

    const [summaryRow]: RawSummary[] =
      await this.transactionsRepository.query(summaryQuery, summaryParams);

    return {
      transactions,
      summary: {
        totalCount: parseInt(summaryRow.total_count, 10),
        expenseCount: parseInt(summaryRow.expense_count, 10),
        expenseTotal: Math.round(parseFloat(summaryRow.expense_total) * 100) / 100,
        incomeCount: parseInt(summaryRow.income_count, 10),
        incomeTotal: Math.round(parseFloat(summaryRow.income_total) * 100) / 100,
      },
    };
  }

  /**
   * Find potential duplicate transactions
   */
  async getDuplicateTransactions(
    userId: string,
    startDate: string | undefined,
    endDate: string,
    sensitivity: 'high' | 'medium' | 'low' = 'medium',
  ): Promise<DuplicateTransactionsResponse> {
    // Configure sensitivity
    const maxDaysDiff = sensitivity === 'high' ? 3 : sensitivity === 'medium' ? 1 : 0;
    const checkPayee = sensitivity !== 'low';

    // Fetch transactions with relevant fields
    let query = `
      SELECT
        t.id,
        t.transaction_date,
        t.amount,
        COALESCE(p.name, t.payee_name) as payee_name,
        t.description,
        a.name as account_name
      FROM transactions t
      LEFT JOIN payees p ON p.id = t.payee_id
      LEFT JOIN accounts a ON a.id = t.account_id
      WHERE t.user_id = $1
        AND t.transaction_date <= $2
        AND t.is_transfer = false
        AND (t.status IS NULL OR t.status != 'VOID')
        AND t.parent_transaction_id IS NULL
      ORDER BY t.transaction_date ASC, t.amount ASC
    `;

    const params: string[] = [userId, endDate];
    if (startDate) {
      query = query.replace(
        'AND t.transaction_date <= $2',
        'AND t.transaction_date >= $3 AND t.transaction_date <= $2',
      );
      params.push(startDate);
    }

    interface RawTx {
      id: string;
      transaction_date: string;
      amount: string;
      payee_name: string | null;
      description: string | null;
      account_name: string | null;
    }

    const rows: RawTx[] = await this.transactionsRepository.query(query, params);

    // Process into transactions
    const transactions: DuplicateTransactionItem[] = rows.map((row) => ({
      id: row.id,
      transactionDate: new Date(row.transaction_date).toISOString().split('T')[0],
      amount: parseFloat(row.amount),
      payeeName: row.payee_name,
      description: row.description,
      accountName: row.account_name,
    }));

    // Find duplicates
    const groups: DuplicateGroup[] = [];
    const processed = new Set<string>();

    for (let i = 0; i < transactions.length; i++) {
      const tx1 = transactions[i];
      if (processed.has(tx1.id)) continue;

      const date1 = new Date(tx1.transactionDate);
      const payee1 = (tx1.payeeName || '').toLowerCase().trim();

      const matches: DuplicateTransactionItem[] = [tx1];

      for (let j = i + 1; j < transactions.length; j++) {
        const tx2 = transactions[j];
        if (processed.has(tx2.id)) continue;

        const date2 = new Date(tx2.transactionDate);
        const payee2 = (tx2.payeeName || '').toLowerCase().trim();

        // Check if dates are within range
        const daysDiff = Math.abs(
          Math.floor((date1.getTime() - date2.getTime()) / (1000 * 60 * 60 * 24)),
        );
        if (daysDiff > maxDaysDiff) {
          // Since transactions are sorted by date, break if too far apart
          if (daysDiff > 7) break;
          continue;
        }

        // Check amount match
        if (Math.abs(tx1.amount - tx2.amount) > 0.01) continue;

        // Check payee match if required
        if (checkPayee && payee1 && payee2 && payee1 !== payee2) continue;

        // Exclude if same transaction
        if (tx1.id === tx2.id) continue;

        matches.push(tx2);
      }

      if (matches.length > 1) {
        // Mark all as processed
        matches.forEach((m) => processed.add(m.id));

        // Determine confidence based on match quality
        const allSameDate = matches.every(
          (m) => m.transactionDate === matches[0].transactionDate,
        );
        const allSamePayee = matches.every(
          (m) =>
            (m.payeeName || '').toLowerCase().trim() ===
            (matches[0].payeeName || '').toLowerCase().trim(),
        );

        let confidence: 'high' | 'medium' | 'low' = 'low';
        let reason = 'Same amount';

        if (allSameDate && allSamePayee) {
          confidence = 'high';
          reason = 'Same date, amount, and payee';
        } else if (allSameDate) {
          confidence = 'medium';
          reason = 'Same date and amount';
        } else if (allSamePayee) {
          confidence = 'medium';
          reason = `Same payee and amount within ${maxDaysDiff} day(s)`;
        } else {
          reason = `Same amount within ${maxDaysDiff} day(s)`;
        }

        groups.push({
          key: `${matches[0].id}-${matches.length}`,
          transactions: matches,
          reason,
          confidence,
        });
      }
    }

    // Sort by confidence then by amount
    const confidenceOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
    groups.sort((a, b) => {
      const confDiff =
        confidenceOrder[a.confidence] - confidenceOrder[b.confidence];
      if (confDiff !== 0) return confDiff;
      return Math.abs(b.transactions[0].amount) - Math.abs(a.transactions[0].amount);
    });

    // Calculate summary
    const high = groups.filter((g) => g.confidence === 'high');
    const medium = groups.filter((g) => g.confidence === 'medium');
    const low = groups.filter((g) => g.confidence === 'low');

    const potentialSavings = groups.reduce((sum, group) => {
      const duplicateCount = group.transactions.length - 1;
      return sum + Math.abs(group.transactions[0].amount) * duplicateCount;
    }, 0);

    return {
      groups,
      summary: {
        totalGroups: groups.length,
        highCount: high.length,
        mediumCount: medium.length,
        lowCount: low.length,
        potentialSavings: Math.round(potentialSavings * 100) / 100,
      },
    };
  }
}
