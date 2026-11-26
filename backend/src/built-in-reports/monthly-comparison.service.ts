import { Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { SpendingReportsService } from "./spending-reports.service";
import {
  IncomeExpensePeriodAggregates,
  IncomeReportsService,
} from "./income-reports.service";
import { ReportCurrencyService } from "./report-currency.service";
import { reportFigureOrNull } from "../common/report-figure";
import { FxAggregate } from "../common/fx-aggregate";
import { UserPreference } from "../users/entities/user-preference.entity";
import {
  NumberT,
  defaultNumberT,
  numberFormatterFor,
} from "../common/number-locale.util";
import {
  MonthlyNetWorthWithAggregate,
  NetWorthService,
} from "../net-worth/net-worth.service";
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
  CategorySpendingComparisonItem,
  TopCategoriesComparison,
  MonthlyComparisonNetWorth,
  MonthlyComparisonInvestments,
  InvestmentAccountPerformance,
  InvestmentTopMover,
  SpendingByCategoryResponse,
} from "./dto";

/** One window's Spending by Category, with each listed category's aggregate. */
interface SpendingWithAggregates {
  response: SpendingByCategoryResponse;
  categories: ReadonlyMap<string | null, FxAggregate>;
}

/** A month with no rows earned and spent nothing: a known zero. */
const emptyMonth = (): IncomeExpensePeriodAggregates => ({
  income: new FxAggregate(),
  expenses: new FxAggregate(),
});

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
    // Every figure leaves rounded once at the reporting currency's places
    // (docs/specs/report-rounding-and-aggregation.md section 6), as the
    // reports this one reads round theirs.
    const places = await this.currencyService.getReportPlaces(defaultCurrency);

    // Fetch all data in parallel
    const [
      currentIncExp,
      previousIncExp,
      currentSpending,
      previousSpending,
      netWorthHistory,
      topMovers,
    ] = await Promise.all([
      this.incomeReports.getIncomeVsExpensesWithAggregates(
        userId,
        currentStart,
        currentEnd,
      ),
      this.incomeReports.getIncomeVsExpensesWithAggregates(
        userId,
        previousStart,
        previousEnd,
      ),
      this.spendingReports.getSpendingByCategoryWithAggregates(
        userId,
        currentStart,
        currentEnd,
        { rollupToParent: false },
      ),
      this.spendingReports.getSpendingByCategoryWithAggregates(
        userId,
        previousStart,
        previousEnd,
        { rollupToParent: false },
      ),
      this.netWorthService.getMonthlyNetWorthWithAggregates(
        userId,
        historyStart,
        currentEnd,
      ),
      this.portfolioService.getMonthOverMonthMovers(
        userId,
        currentEnd,
        previousEnd,
      ),
    ]);

    // Each month's income and expenses as aggregates. The bucket key for a
    // month IS `YYYY-MM`, which is what this comparison asks for.
    const cur = currentIncExp.periods.get(month) ?? emptyMonth();
    const prev = previousIncExp.periods.get(previousMonthStr) ?? emptyMonth();
    // A month's savings is its own net, income less expenses before either is
    // rounded (docs/specs/report-rounding-and-aggregation.md rule 2).
    const currentSavings = FxAggregate.difference(cur.income, cur.expenses);
    const previousSavings = FxAggregate.difference(prev.income, prev.expenses);

    // Build income/expenses section. Each figure is its aggregate read once,
    // and each change the difference of the two months' aggregates read once:
    // the difference of the two readings could sit a unit off the exact
    // change (rule 4).
    const incomeExpenses: MonthlyComparisonIncomeExpenses = {
      currentMonth: month,
      previousMonth: previousMonthStr,
      currentIncome: cur.income.knownSubtotalAt(places),
      previousIncome: prev.income.knownSubtotalAt(places),
      incomeChange: this.change(cur.income, prev.income, places),
      incomeChangePercent: this.percentChange(prev.income, cur.income, places),
      currentExpenses: cur.expenses.knownSubtotalAt(places),
      previousExpenses: prev.expenses.knownSubtotalAt(places),
      expensesChange: this.change(cur.expenses, prev.expenses, places),
      expensesChangePercent: this.percentChange(
        prev.expenses,
        cur.expenses,
        places,
      ),
      currentSavings: currentSavings.knownSubtotalAt(places),
      previousSavings: previousSavings.knownSubtotalAt(places),
      savingsChange: this.change(currentSavings, previousSavings, places),
      savingsChangePercent: this.percentChange(
        previousSavings,
        currentSavings,
        places,
      ),
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
    // Each note's "more" or "less" reads the change's sign before it is
    // rounded (rule 5): a fall of 0.004 is less, though it reads 0.00.
    const notes = this.buildNotes(
      incomeExpenses,
      {
        savings: FxAggregate.difference(currentSavings, previousSavings).sign,
        income: FxAggregate.difference(cur.income, prev.income).sign,
      },
      currentMonthLabel,
      previousMonthLabel,
      defaultCurrency,
      numberFormatterFor(prefs?.numberFormat, prefs?.language),
    );

    // Build expense comparison
    const expenses = this.buildExpenseComparison(
      currentSpending,
      previousSpending,
      places,
    );

    // Build top 5 categories
    const topCategories: TopCategoriesComparison = {
      currentMonth: currentSpending.response.data.slice(0, 5).map((c) => ({
        categoryId: c.categoryId,
        categoryName: c.categoryName,
        color: c.color,
        total: c.total,
      })),
      previousMonth: previousSpending.response.data.slice(0, 5).map((c) => ({
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
      places,
    );

    // Build investment performance
    const investments = await this.buildInvestmentPerformance(
      userId,
      currentEnd,
      defaultCurrency,
      places,
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
    direction: { savings: number; income: number },
    currentLabel: string,
    previousLabel: string,
    currency: string,
    n: NumberT = defaultNumberT,
  ): MonthlyComparisonNotes {
    const fmt = (amount: number) => n.formatCurrency(amount, currency);

    const savingsDirection =
      direction.savings >= 0
        ? `${n.formatPercent(Math.abs(ie.savingsChangePercent), 1)} more`
        : `${n.formatPercent(Math.abs(ie.savingsChangePercent), 1)} less`;
    const savingsNote = `In ${currentLabel}, you saved ${savingsDirection} than ${previousLabel} for a total of ${fmt(ie.currentSavings)}`;

    const incomeDirection =
      direction.income >= 0
        ? `${fmt(Math.abs(ie.incomeChange))} more`
        : `${fmt(Math.abs(ie.incomeChange))} less`;
    const incomeNote = `Your total income in ${currentLabel} was ${fmt(ie.currentIncome)} which is ${incomeDirection} than ${previousLabel}`;

    return { savingsNote, incomeNote };
  }

  private buildExpenseComparison(
    current: SpendingWithAggregates,
    previous: SpendingWithAggregates,
    places: number,
  ): MonthlyComparisonExpenses {
    const currentData = current.response.data;
    const previousData = previous.response.data;
    // Merge into comparison table
    const allCategories = new Map<
      string,
      {
        categoryId: string | null;
        categoryName: string;
        color: string | null;
        current: FxAggregate;
        previous: FxAggregate;
      }
    >();

    // A category a month did not list spent nothing in it: a known zero.
    const aggregateOf = (
      window: SpendingWithAggregates,
      categoryId: string | null,
    ): FxAggregate => window.categories.get(categoryId) ?? new FxAggregate();

    for (const c of currentData) {
      const key = c.categoryId || c.categoryName;
      allCategories.set(key, {
        categoryId: c.categoryId,
        categoryName: c.categoryName,
        color: c.color,
        current: aggregateOf(current, c.categoryId),
        previous: new FxAggregate(),
      });
    }
    for (const c of previousData) {
      const key = c.categoryId || c.categoryName;
      const existing = allCategories.get(key);
      if (existing) {
        existing.previous = aggregateOf(previous, c.categoryId);
      } else {
        allCategories.set(key, {
          categoryId: c.categoryId,
          categoryName: c.categoryName,
          color: c.color,
          current: new FxAggregate(),
          previous: aggregateOf(previous, c.categoryId),
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
        currentTotal: c.current.knownSubtotalAt(places),
        previousTotal: c.previous.knownSubtotalAt(places),
        change: this.change(c.current, c.previous, places),
        // A net credit in the prior month provides no spending baseline.
        changePercent:
          c.previous.sign < 0 ||
          (c.previous.knownSubtotalAt(places) === 0 && c.current.sign < 0)
            ? null
            : this.percentChange(c.previous, c.current, places),
      }))
      .sort((a, b) => b.currentTotal - a.currentTotal);

    // Each month's total as Spending by Category rounds it, once from its
    // categories' aggregates, never re-summed from their rounded rows.
    return {
      netSpending:
        current.response.netSpending && previous.response.netSpending,
      currentMonth: currentData,
      previousMonth: previousData,
      comparison,
      currentTotal: current.response.knownSpending,
      previousTotal: previous.response.knownSpending,
    };
  }

  private buildNetWorth(
    history: Pick<
      MonthlyNetWorthWithAggregate,
      | "month"
      | "netWorth"
      | "netWorthAggregate"
      | "fxComplete"
      | "missingRatePairs"
    >[],
    currentMonth: string,
    previousMonth: string,
    places: number,
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
    ): {
      known: number;
      aggregate: FxAggregate;
      complete: boolean;
      pairs: string[];
    } =>
      month
        ? {
            known: month.netWorth,
            aggregate: month.netWorthAggregate,
            complete: month.fxComplete,
            pairs: month.missingRatePairs,
          }
        : {
            known: 0,
            aggregate: new FxAggregate(),
            complete: true,
            pairs: [],
          };
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
      // The change is the difference of the two months' aggregates, read once
      // (rule 4).
      netWorthChange: bothComplete
        ? this.change(cur.aggregate, prev.aggregate, places)
        : null,
      netWorthChangePercent: bothComplete
        ? this.percentChange(prev.aggregate, cur.aggregate, places)
        : null,
      fxComplete: bothComplete,
      missingRatePairs: [...new Set([...cur.pairs, ...prev.pairs])].sort(),
    };
  }

  private async buildInvestmentPerformance(
    userId: string,
    currentEnd: string,
    currency: string,
    places: number,
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
        currentValue: reportFigureOrNull(result.investedValueEnd, places),
        startValue: reportFigureOrNull(result.investedValueStart, places),
        investmentPnl: reportFigureOrNull(result.investmentPnl, places),
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

  /**
   * `current` less `previous`, rounded once from the two aggregates at
   * `places`: the difference of their readings can sit a unit off the exact
   * change (docs/specs/report-rounding-and-aggregation.md rule 4).
   */
  private change(
    current: FxAggregate,
    previous: FxAggregate,
    places: number,
  ): number {
    return FxAggregate.difference(current, previous).knownSubtotalAt(places);
  }

  /**
   * The change as a percentage of `previous`, worked out from the unrounded
   * values and rounded once (rule 8), over a `previous` that reads as money at
   * `places`, as `compare_periods` takes its base: 0.004 USD reads 0.00 and is
   * no base, where a cent over it read as a 2,499,900% change. Without a base
   * the change is 100, or 0 when `current` reads as nothing too.
   */
  private percentChange(
    previous: FxAggregate,
    current: FxAggregate,
    places: number,
  ): number {
    if (previous.knownSubtotalAt(places) === 0) {
      return current.knownSubtotalAt(places) === 0 ? 0 : 100;
    }
    const change = FxAggregate.difference(current, previous);
    return (
      Math.round(
        (change.unroundedSubtotal / Math.abs(previous.unroundedSubtotal)) *
          10000,
      ) / 100
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
