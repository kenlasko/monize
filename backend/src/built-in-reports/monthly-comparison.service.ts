import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, DataSource } from "typeorm";
import { SpendingReportsService } from "./spending-reports.service";
import { IncomeReportsService } from "./income-reports.service";
import { ReportCurrencyService } from "./report-currency.service";
import { NetWorthService } from "../net-worth/net-worth.service";
import { PortfolioService, TopMover } from "../securities/portfolio.service";
import {
  Account,
  AccountType,
  AccountSubType,
} from "../accounts/entities/account.entity";
import {
  MonthlyComparisonResponse,
  MonthlyComparisonIncomeExpenses,
  MonthlyComparisonNotes,
  MonthlyComparisonExpenses,
  CategorySpendingSnapshot,
  CategorySpendingComparisonItem,
  TopCategoriesComparison,
  MonthlyComparisonNetWorth,
  MonthlyComparisonInvestments,
  InvestmentAccountPerformance,
  InvestmentTopMover,
} from "./dto";

@Injectable()
export class MonthlyComparisonService {
  constructor(
    private spendingReports: SpendingReportsService,
    private incomeReports: IncomeReportsService,
    private currencyService: ReportCurrencyService,
    private netWorthService: NetWorthService,
    private portfolioService: PortfolioService,
    @InjectRepository(Account)
    private accountsRepository: Repository<Account>,
    private dataSource: DataSource,
  ) {}

  async getMonthlyComparison(
    userId: string,
    month: string,
  ): Promise<MonthlyComparisonResponse> {
    // Parse month into date ranges
    const [year, monthNum] = month.split("-").map(Number);
    const currentStart = `${month}-01`;
    const currentEnd = this.lastDayOfMonth(year, monthNum);

    const prevDate = new Date(year, monthNum - 2, 1);
    const prevYear = prevDate.getFullYear();
    const prevMonth = prevDate.getMonth() + 1;
    const previousMonthStr = `${prevYear}-${String(prevMonth).padStart(2, "0")}`;
    const previousStart = `${previousMonthStr}-01`;
    const previousEnd = this.lastDayOfMonth(prevYear, prevMonth);

    // 12 months back for net worth history
    const historyDate = new Date(year, monthNum - 13, 1);
    const historyStart = `${historyDate.getFullYear()}-${String(historyDate.getMonth() + 1).padStart(2, "0")}-01`;

    const defaultCurrency =
      await this.currencyService.getDefaultCurrency(userId);

    // Fetch all data in parallel
    const [
      currentIncExp,
      previousIncExp,
      currentSpending,
      previousSpending,
      netWorthHistory,
      topMovers,
    ] = await Promise.all([
      this.incomeReports.getIncomeVsExpenses(userId, currentStart, currentEnd),
      this.incomeReports.getIncomeVsExpenses(
        userId,
        previousStart,
        previousEnd,
      ),
      this.spendingReports.getSpendingByCategory(
        userId,
        currentStart,
        currentEnd,
        false,
      ),
      this.spendingReports.getSpendingByCategory(
        userId,
        previousStart,
        previousEnd,
        false,
      ),
      this.netWorthService.getMonthlyNetWorth(userId, historyStart, currentEnd),
      this.portfolioService.getMonthOverMonthMovers(userId, currentEnd, previousEnd),
    ]);

    // Extract single-month income/expenses from the responses
    const curData = currentIncExp.data.find((d) => d.month === month);
    const prevData = previousIncExp.data.find(
      (d) => d.month === previousMonthStr,
    );

    const currentIncome = curData?.income ?? 0;
    const previousIncome = prevData?.income ?? 0;
    const currentExpenses = curData?.expenses ?? 0;
    const previousExpenses = prevData?.expenses ?? 0;
    const currentSavings = currentIncome - currentExpenses;
    const previousSavings = previousIncome - previousExpenses;

    // Build income/expenses section
    const incomeExpenses: MonthlyComparisonIncomeExpenses = {
      currentMonth: month,
      previousMonth: previousMonthStr,
      currentIncome,
      previousIncome,
      incomeChange: currentIncome - previousIncome,
      incomeChangePercent: this.percentChange(previousIncome, currentIncome),
      currentExpenses,
      previousExpenses,
      expensesChange: currentExpenses - previousExpenses,
      expensesChangePercent: this.percentChange(
        previousExpenses,
        currentExpenses,
      ),
      currentSavings,
      previousSavings,
      savingsChange: currentSavings - previousSavings,
      savingsChangePercent: this.percentChange(previousSavings, currentSavings),
    };

    // Build month labels
    const currentMonthLabel = this.formatMonthLabel(year, monthNum);
    const previousMonthLabel = this.formatMonthLabel(prevYear, prevMonth);

    // Build summary notes
    const notes = this.buildNotes(
      incomeExpenses,
      currentMonthLabel,
      previousMonthLabel,
      defaultCurrency,
    );

    // Build expense comparison
    const expenses = this.buildExpenseComparison(
      currentSpending.data,
      previousSpending.data,
    );

    // Build top 5 categories
    const topCategories: TopCategoriesComparison = {
      currentMonth: currentSpending.data.slice(0, 5).map((c) => ({
        categoryId: c.categoryId,
        categoryName: c.categoryName,
        color: c.color,
        total: c.total,
      })),
      previousMonth: previousSpending.data.slice(0, 5).map((c) => ({
        categoryId: c.categoryId,
        categoryName: c.categoryName,
        color: c.color,
        total: c.total,
      })),
    };

    // Build net worth section
    const netWorth = this.buildNetWorth(
      netWorthHistory,
      month,
      previousMonthStr,
    );

    // Build investment performance
    const investments = await this.buildInvestmentPerformance(
      userId,
      month,
      historyStart,
      currentEnd,
      topMovers,
    );

    return {
      currentMonth: month,
      previousMonth: previousMonthStr,
      currentMonthLabel,
      previousMonthLabel,
      currency: defaultCurrency,
      incomeExpenses,
      notes,
      expenses,
      topCategories,
      netWorth,
      investments,
    };
  }

  private buildNotes(
    ie: MonthlyComparisonIncomeExpenses,
    currentLabel: string,
    previousLabel: string,
    currency: string,
  ): MonthlyComparisonNotes {
    const fmt = (amount: number) => this.formatCurrencyWithSymbol(amount, currency);

    const savingsDirection =
      ie.savingsChange >= 0
        ? `${Math.abs(ie.savingsChangePercent).toFixed(1)}% more`
        : `${Math.abs(ie.savingsChangePercent).toFixed(1)}% less`;
    const savingsNote = `In ${currentLabel}, you saved ${savingsDirection} than ${previousLabel} for a total of ${fmt(ie.currentSavings)}`;

    const incomeDirection =
      ie.incomeChange >= 0
        ? `${fmt(Math.abs(ie.incomeChange))} more`
        : `${fmt(Math.abs(ie.incomeChange))} less`;
    const incomeNote = `Your total income in ${currentLabel} was ${fmt(ie.currentIncome)} which is ${incomeDirection} than ${previousLabel}`;

    return { savingsNote, incomeNote };
  }

  private buildExpenseComparison(
    currentData: { categoryId: string | null; categoryName: string; color: string | null; total: number }[],
    previousData: { categoryId: string | null; categoryName: string; color: string | null; total: number }[],
  ): MonthlyComparisonExpenses {
    const currentMonth: CategorySpendingSnapshot[] = currentData.map((c) => ({
      categoryId: c.categoryId,
      categoryName: c.categoryName,
      color: c.color,
      total: c.total,
    }));
    const previousMonth: CategorySpendingSnapshot[] = previousData.map(
      (c) => ({
        categoryId: c.categoryId,
        categoryName: c.categoryName,
        color: c.color,
        total: c.total,
      }),
    );

    // Merge into comparison table
    const allCategories = new Map<
      string,
      {
        categoryId: string | null;
        categoryName: string;
        color: string | null;
        currentTotal: number;
        previousTotal: number;
      }
    >();

    for (const c of currentData) {
      const key = c.categoryId || c.categoryName;
      allCategories.set(key, {
        categoryId: c.categoryId,
        categoryName: c.categoryName,
        color: c.color,
        currentTotal: c.total,
        previousTotal: 0,
      });
    }
    for (const c of previousData) {
      const key = c.categoryId || c.categoryName;
      const existing = allCategories.get(key);
      if (existing) {
        existing.previousTotal = c.total;
      } else {
        allCategories.set(key, {
          categoryId: c.categoryId,
          categoryName: c.categoryName,
          color: c.color,
          currentTotal: 0,
          previousTotal: c.total,
        });
      }
    }

    const comparison: CategorySpendingComparisonItem[] = Array.from(
      allCategories.values(),
    )
      .map((c) => ({
        categoryId: c.categoryId,
        categoryName: c.categoryName,
        color: c.color,
        currentTotal: c.currentTotal,
        previousTotal: c.previousTotal,
        change: Math.round((c.currentTotal - c.previousTotal) * 100) / 100,
        changePercent: this.percentChange(c.previousTotal, c.currentTotal),
      }))
      .sort((a, b) => b.currentTotal - a.currentTotal);

    const currentTotal = currentData.reduce((sum, c) => sum + c.total, 0);
    const previousTotal = previousData.reduce((sum, c) => sum + c.total, 0);

    return {
      currentMonth,
      previousMonth,
      comparison,
      currentTotal: Math.round(currentTotal * 100) / 100,
      previousTotal: Math.round(previousTotal * 100) / 100,
    };
  }

  private buildNetWorth(
    history: { month: string; assets: number; liabilities: number; netWorth: number }[],
    currentMonth: string,
    previousMonth: string,
  ): MonthlyComparisonNetWorth {
    const monthlyHistory = history.map((h) => ({
      month: h.month,
      netWorth: h.netWorth,
    }));

    const current = history.find(
      (h) => h.month.substring(0, 7) === currentMonth,
    );
    const previous = history.find(
      (h) => h.month.substring(0, 7) === previousMonth,
    );

    const currentNetWorth = current?.netWorth ?? 0;
    const previousNetWorth = previous?.netWorth ?? 0;

    return {
      monthlyHistory,
      currentNetWorth,
      previousNetWorth,
      netWorthChange: currentNetWorth - previousNetWorth,
      netWorthChangePercent: this.percentChange(
        previousNetWorth,
        currentNetWorth,
      ),
    };
  }

  private async buildInvestmentPerformance(
    userId: string,
    currentMonth: string,
    historyStart: string,
    currentEnd: string,
    topMovers: TopMover[],
  ): Promise<MonthlyComparisonInvestments> {
    // Get investment accounts
    const investmentAccounts = await this.accountsRepository.find({
      where: { userId, accountType: AccountType.INVESTMENT, isClosed: false },
    });

    // Get per-account monthly data from monthly_account_balances
    const brokerageIds = investmentAccounts
      .filter(
        (a) =>
          a.accountSubType === AccountSubType.INVESTMENT_BROKERAGE ||
          (!a.accountSubType && a.accountType === AccountType.INVESTMENT),
      )
      .map((a) => a.id);

    const accountPerformance: InvestmentAccountPerformance[] = [];

    if (brokerageIds.length > 0) {
      // Get monthly snapshots for investment accounts
      const snapshots: any[] = await this.dataSource.query(
        `SELECT mab.account_id, mab.month, mab.balance, mab.market_value,
                a.name, a.account_sub_type
         FROM monthly_account_balances mab
         JOIN accounts a ON a.id = mab.account_id
         WHERE mab.user_id = $1
           AND mab.account_id = ANY($2)
           AND mab.month >= DATE_TRUNC('month', $3::DATE)
           AND mab.month <= DATE_TRUNC('month', $4::DATE)
         ORDER BY mab.account_id, mab.month`,
        [userId, brokerageIds, historyStart, currentEnd],
      );

      // Group by account
      const byAccount = new Map<string, any[]>();
      for (const s of snapshots) {
        const list = byAccount.get(s.account_id) || [];
        list.push(s);
        byAccount.set(s.account_id, list);
      }

      for (const [accountId, monthlyData] of byAccount) {
        if (monthlyData.length < 2) continue;

        const first = monthlyData[0];
        const last = monthlyData[monthlyData.length - 1];

        const getValue = (s: any): number => {
          if (
            s.account_sub_type === "INVESTMENT_BROKERAGE" &&
            s.market_value != null
          ) {
            return Number(s.market_value);
          }
          if (s.market_value != null) {
            return Number(s.market_value) + Number(s.balance);
          }
          return Number(s.balance);
        };

        const startValue = getValue(first);
        const currentValue = getValue(last);

        // Annualized return: ((endValue / startValue) ^ (12/months) - 1) * 100
        const months = monthlyData.length - 1;
        let annualizedReturn = 0;
        if (startValue > 0 && months > 0) {
          annualizedReturn =
            (Math.pow(currentValue / startValue, 12 / months) - 1) * 100;
        }

        const accountName = (first.name || "").replace(" - Brokerage", "");

        accountPerformance.push({
          accountId,
          accountName,
          currentValue: Math.round(currentValue),
          startValue: Math.round(startValue),
          annualizedReturn: Math.round(annualizedReturn * 100) / 100,
        });
      }
    }

    // Map top movers to DTO
    const mappedMovers: InvestmentTopMover[] = topMovers.map((m) => ({
      securityId: m.securityId,
      symbol: m.symbol,
      name: m.name,
      currentPrice: m.currentPrice,
      previousPrice: m.previousPrice,
      change: m.dailyChange,
      changePercent: m.dailyChangePercent,
      marketValue: m.marketValue,
    }));

    return {
      accountPerformance: accountPerformance.sort(
        (a, b) => b.currentValue - a.currentValue,
      ),
      topMovers: mappedMovers,
    };
  }

  private percentChange(previous: number, current: number): number {
    if (previous === 0) return current === 0 ? 0 : 100;
    return Math.round(((current - previous) / Math.abs(previous)) * 10000) / 100;
  }

  private formatCurrencyWithSymbol(amount: number, currencyCode: string): string {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currencyCode,
      currencyDisplay: "narrowSymbol",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  }

  private formatMonthLabel(year: number, month: number): string {
    const date = new Date(year, month - 1, 1);
    return date.toLocaleDateString("en-US", { year: "numeric", month: "long" });
  }

  private lastDayOfMonth(year: number, month: number): string {
    const lastDay = new Date(year, month, 0).getDate();
    return `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  }
}
