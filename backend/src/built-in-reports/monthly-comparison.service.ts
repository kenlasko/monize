import { ReportingRead } from "../accruals/reporting-basis";
import { Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { SpendingReportsService } from "./spending-reports.service";
import { IncomeReportsService } from "./income-reports.service";
import { ReportCurrencyService } from "./report-currency.service";
import { roundMoney, sumMoney } from "../common/round.util";
import { UserPreference } from "../users/entities/user-preference.entity";
import {
  NumberT,
  defaultNumberT,
  numberFormatterFor,
} from "../common/number-locale.util";
import { NetWorthService } from "../net-worth/net-worth.service";
import { PortfolioService, TopMover } from "../securities/portfolio.service";
import { PortfolioPeriodResultService } from "../net-worth/portfolio-period-result.service";
import { todayYMD } from "../common/date-utils";
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
    private periodResult: PortfolioPeriodResultService,
    private dataSource: DataSource,
  ) {}

  @ReportingRead()
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
        { rollupToParent: false },
      ),
      this.spendingReports.getSpendingByCategory(
        userId,
        previousStart,
        previousEnd,
        { rollupToParent: false },
      ),
      this.netWorthService.getMonthlyNetWorth(userId, historyStart, currentEnd),
      this.portfolioService.getMonthOverMonthMovers(
        userId,
        currentEnd,
        previousEnd,
      ),
    ]);

    // Extract single-month income/expenses from the responses. The bucket key
    // for a month IS `YYYY-MM`, which is what this comparison asks for.
    const curData = currentIncExp.data.find((d) => d.period === month);
    const prevData = previousIncExp.data.find(
      (d) => d.period === previousMonthStr,
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

    // Build summary notes. The prose is English (these notes are not routed
    // through a catalogue yet), but the FIGURES in it are read by this user, so
    // they follow their configured number locale rather than the server's --
    // issue #1316, the same rule the emails and budget alerts follow.
    const prefs = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(UserPreference).findOne({ where: { userId } }),
    );
    const notes = this.buildNotes(
      incomeExpenses,
      currentMonthLabel,
      previousMonthLabel,
      defaultCurrency,
      numberFormatterFor(prefs?.numberFormat, prefs?.language),
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
      currentEnd,
      defaultCurrency,
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
    n: NumberT = defaultNumberT,
  ): MonthlyComparisonNotes {
    const fmt = (amount: number) => n.formatCurrency(amount, currency);

    const savingsDirection =
      ie.savingsChange >= 0
        ? `${n.formatPercent(Math.abs(ie.savingsChangePercent), 1)} more`
        : `${n.formatPercent(Math.abs(ie.savingsChangePercent), 1)} less`;
    const savingsNote = `In ${currentLabel}, you saved ${savingsDirection} than ${previousLabel} for a total of ${fmt(ie.currentSavings)}`;

    const incomeDirection =
      ie.incomeChange >= 0
        ? `${fmt(Math.abs(ie.incomeChange))} more`
        : `${fmt(Math.abs(ie.incomeChange))} less`;
    const incomeNote = `Your total income in ${currentLabel} was ${fmt(ie.currentIncome)} which is ${incomeDirection} than ${previousLabel}`;

    return { savingsNote, incomeNote };
  }

  private buildExpenseComparison(
    currentData: {
      categoryId: string | null;
      categoryName: string;
      color: string | null;
      total: number;
    }[],
    previousData: {
      categoryId: string | null;
      categoryName: string;
      color: string | null;
      total: number;
    }[],
  ): MonthlyComparisonExpenses {
    const currentMonth: CategorySpendingSnapshot[] = currentData.map((c) => ({
      categoryId: c.categoryId,
      categoryName: c.categoryName,
      color: c.color,
      total: c.total,
    }));
    const previousMonth: CategorySpendingSnapshot[] = previousData.map((c) => ({
      categoryId: c.categoryId,
      categoryName: c.categoryName,
      color: c.color,
      total: c.total,
    }));

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
        change: roundMoney(c.currentTotal - c.previousTotal),
        changePercent: this.percentChange(c.previousTotal, c.currentTotal),
      }))
      .sort((a, b) => b.currentTotal - a.currentTotal);

    const currentTotal = sumMoney(currentData.map((c) => c.total));
    const previousTotal = sumMoney(previousData.map((c) => c.total));

    return {
      currentMonth,
      previousMonth,
      comparison,
      currentTotal: roundMoney(currentTotal),
      previousTotal: roundMoney(previousTotal),
    };
  }

  private buildNetWorth(
    history: {
      month: string;
      assets: number;
      liabilities: number;
      netWorth: number;
      fxComplete: boolean;
      missingRatePairs: string[];
    }[],
    currentMonth: string,
    previousMonth: string,
  ): MonthlyComparisonNetWorth {
    const monthlyHistory = history.map((h) => ({
      month: h.month,
      netWorth: h.netWorth,
      fxComplete: h.fxComplete,
      missingRatePairs: h.missingRatePairs,
    }));

    const current = history.find(
      (h) => h.month.substring(0, 7) === currentMonth,
    );
    const previous = history.find(
      (h) => h.month.substring(0, 7) === previousMonth,
    );

    // A month with no snapshot row holds no balance history: a known zero, the
    // way the series treats an empty month, not an unknown one.
    const resolve = (
      month: typeof current,
    ): { known: number; complete: boolean; pairs: string[] } =>
      month
        ? {
            known: month.netWorth,
            complete: month.fxComplete,
            pairs: month.missingRatePairs,
          }
        : { known: 0, complete: true, pairs: [] };
    const cur = resolve(current);
    const prev = resolve(previous);

    // A subtotal is not a total: a month short of a rate has no net worth, and
    // a change between two months needs both.
    const currentNetWorth = cur.complete ? cur.known : null;
    const previousNetWorth = prev.complete ? prev.known : null;
    const bothComplete = cur.complete && prev.complete;

    return {
      monthlyHistory,
      currentNetWorth,
      previousNetWorth,
      knownCurrentNetWorth: cur.known,
      knownPreviousNetWorth: prev.known,
      netWorthChange: bothComplete ? cur.known - prev.known : null,
      netWorthChangePercent: bothComplete
        ? this.percentChange(prev.known, cur.known)
        : null,
      fxComplete: bothComplete,
      missingRatePairs: [...new Set([...cur.pairs, ...prev.pairs])].sort(),
    };
  }

  private async buildInvestmentPerformance(
    userId: string,
    currentEnd: string,
    currency: string,
    topMovers: TopMover[],
  ): Promise<MonthlyComparisonInvestments> {
    // Get investment accounts
    const investmentAccounts = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Account).find({
        where: { userId, accountType: AccountType.INVESTMENT, isClosed: false },
      }),
    );

    const brokerages = investmentAccounts.filter(
      (a) =>
        a.accountSubType === AccountSubType.INVESTMENT_BROKERAGE ||
        (!a.accountSubType && a.accountType === AccountType.INVESTMENT),
    );

    // The trailing year to the report month's last day, never past today: a
    // window ending in the future would value days no close exists for yet.
    const today = todayYMD();
    const endDate = currentEnd < today ? currentEnd : today;

    // Each account's figure is the invested part's time-weighted return over
    // the same `1y` window the Investments page's performance card reports,
    // from the same service (INV-PORTRESULT-001/002). The ratio of two
    // month-end balances this used to annualise counted every deposit and
    // every purchase from the linked cash account as a gain, and compounded a
    // one-month jump twelve times.
    const results = await Promise.all(
      brokerages.map(async (account) => ({
        account,
        result: await this.periodResult.getPeriodResult(userId, {
          period: "1y",
          endDate,
          accountIds: [account.id],
          displayCurrency: currency,
        }),
      })),
    );

    const accountPerformance: InvestmentAccountPerformance[] = [];
    for (const { account, result } of results) {
      // No valued day in the window, or nothing held on any of them: there is
      // no performance to report, which is not the same as a withheld one.
      if (result.investedReasons.includes("noValueSeries")) continue;
      if (
        result.investedValueStart === 0 &&
        result.investedValueEnd === 0 &&
        result.investmentPnl === 0
      ) {
        continue;
      }

      accountPerformance.push({
        accountId: account.id,
        accountName: (account.name || "").replace(" - Brokerage", ""),
        currentValue:
          result.investedValueEnd === null
            ? null
            : roundMoney(result.investedValueEnd),
        startValue:
          result.investedValueStart === null
            ? null
            : roundMoney(result.investedValueStart),
        investmentPnl:
          result.investmentPnl === null
            ? null
            : roundMoney(result.investmentPnl),
        returnPercent:
          result.investmentReturnPercent === null
            ? null
            : Math.round(result.investmentReturnPercent * 100) / 100,
        returnReasons: result.investedReasons,
        periodStart: result.startDate,
        periodEnd: result.endDate,
      });
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
      // Largest first; an account whose value is unknown sorts last rather
      // than as if it held nothing.
      accountPerformance: accountPerformance.sort(
        (a, b) =>
          (b.currentValue ?? Number.NEGATIVE_INFINITY) -
          (a.currentValue ?? Number.NEGATIVE_INFINITY),
      ),
      topMovers: mappedMovers,
    };
  }

  private percentChange(previous: number, current: number): number {
    if (previous === 0) return current === 0 ? 0 : 100;
    return (
      Math.round(((current - previous) / Math.abs(previous)) * 10000) / 100
    );
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
