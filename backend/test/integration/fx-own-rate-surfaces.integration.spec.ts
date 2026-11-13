import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { TransactionAnalyticsService } from "@/transactions/transaction-analytics.service";
import { TransactionsModule } from "@/transactions/transactions.module";
import {
  Transaction,
  TransactionStatus,
} from "@/transactions/entities/transaction.entity";
import { ReportCurrencyService } from "@/built-in-reports/report-currency.service";
import { SpendingReportsService } from "@/built-in-reports/spending-reports.service";
import { IncomeReportsService } from "@/built-in-reports/income-reports.service";
import { ReportsService } from "@/reports/reports.service";
import {
  CustomReport,
  DirectionFilter,
  GroupByType,
  MetricType,
  ReportViewType,
  TimeframeType,
} from "@/reports/entities/custom-report.entity";
import { InsightsAggregatorService } from "@/ai/insights/insights-aggregator.service";
import { ForecastAggregatorService } from "@/ai/forecast/forecast-aggregator.service";
import { buildRateIndex } from "@/common/time-series/rate-index.util";
import { withScopedDb } from "@/common/db/scoped-db";
import { withUserContext } from "@/common/db/with-context";
import { addDaysYMD, todayYMD } from "@/common/date-utils";
import {
  cleanTables,
  createIntegrationModule,
  createTestUserDirect,
} from "../helpers/integration-setup";
import {
  createTestAccount,
  createTestCategory,
  createTestPayee,
} from "../helpers/test-factories";

/**
 * INV-FX-002 across every surface that totals transactions, against real
 * PostgreSQL: a row carrying its own rate converts at that rate, and any other
 * foreign row at the market rate on its own date (INV-FX-001), whichever reader
 * asks (discussion #2105, issue #2146).
 *
 * The reader reports in EUR. A USD card holds a hotel night entered as
 * EUR 100 and charged as USD 125 (1 EUR = 1.25 USD) on a day the market said
 * 1.175, so the market rate would read EUR 106.38, the figure `list_transactions`
 * once gave while Spending by Category gave EUR 100. Beside it: a USD row with
 * no rate of its own (USD 110 when the market said 1.10, EUR 100, though the
 * month's last rate would read EUR 93.62), EUR 50 already in the reporting
 * currency, and EUR 200 of income received as USD 250 at its own 1.25 (the
 * market's 1.10 that day would read EUR 227.27).
 *
 * Every surface reads EUR 250 of expenses and EUR 200 of income. A surface that
 * took the market rate for an own-rate row, or a month's last rate for a dated
 * one, reads a different number, and the assertion names it.
 */
describe("a row's own rate on every surface (integration)", () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let analytics: TransactionAnalyticsService;
  let spending: SpendingReportsService;
  let income: IncomeReportsService;
  let customReports: ReportsService;

  let userId: string;
  let travelId: string;
  let salaryId: string;

  // Last month, whole, so every row and rate is in the past and inside the
  // assistant's six- and twelve-month windows.
  const today = todayYMD();
  const [year, month] = today.split("-").map(Number);
  const START = new Date(Date.UTC(year, month - 2, 1))
    .toISOString()
    .slice(0, 10);
  const END = new Date(Date.UTC(year, month - 1, 0)).toISOString().slice(0, 10);
  const MONTH = START.slice(0, 7);
  const PREVIOUS = {
    start: new Date(Date.UTC(year, month - 3, 1)).toISOString().slice(0, 10),
    end: addDaysYMD(START, -1),
  };
  const day = (n: number) => addDaysYMD(START, n - 1);

  const EXPENSES = 250;
  const INCOME = 200;

  beforeAll(async () => {
    module = await createIntegrationModule([TransactionsModule]);
    dataSource = module.get(DataSource);
    analytics = module.get(TransactionAnalyticsService);
    // The report services take only a DataSource and a currency resolver, so
    // they are constructed directly; the rate history loads the way
    // `ExchangeRateService.getRateIndex` loads it.
    const currency = new ReportCurrencyService(dataSource, {
      getRateIndex: (
        currencies: ReadonlySet<string>,
        to: string,
        start: string,
        end: string,
      ) =>
        buildRateIndex(
          (sql, params) =>
            withScopedDb(dataSource, (m) => m.query(sql, params)),
          new Set(currencies),
          to,
          start,
          end,
        ),
    } as never);
    spending = new SpendingReportsService(dataSource, currency);
    income = new IncomeReportsService(dataSource, currency);
    // `execute` uses neither the budgets service (only BUDGET_VARIANCE does)
    // nor action history (only the writes do).
    customReports = new ReportsService(
      dataSource,
      {} as never,
      {} as never,
      currency,
    );
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanTables(dataSource, [
      "exchange_rates",
      "custom_reports",
      "transaction_splits",
      "transactions",
      "accounts",
      "payees",
      "categories",
      "user_preferences",
      "users",
    ]);
    await dataSource.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places) VALUES
         ('EUR', 'Euro', 'E', 2),
         ('USD', 'US Dollar', '$', 2)
       ON CONFLICT DO NOTHING`,
    );
    userId = (await createTestUserDirect(dataSource)).id;
    await dataSource.query(
      `INSERT INTO user_preferences (user_id, default_currency) VALUES ($1, 'EUR')`,
      [userId],
    );
    const usCard = await createTestAccount(dataSource, userId, {
      name: "US Card",
      currencyCode: "USD",
    });
    const euChequing = await createTestAccount(dataSource, userId, {
      name: "EU Chequing",
      currencyCode: "EUR",
    });
    travelId = (
      await createTestCategory(dataSource, userId, { name: "Travel" })
    ).id;
    salaryId = (
      await createTestCategory(dataSource, userId, {
        name: "Consulting",
        isIncome: true,
      })
    ).id;
    const hotel = await createTestPayee(dataSource, userId, { name: "Hotel" });
    const client = await createTestPayee(dataSource, userId, {
      name: "Client",
    });

    const rows: Partial<Transaction>[] = [
      // EUR 50, already in the reporting currency.
      {
        accountId: euChequing.id,
        amount: -50,
        currencyCode: "EUR",
        transactionDate: day(10),
        categoryId: travelId,
        payeeId: hotel.id,
        payeeName: hotel.name,
      },
      // USD 110 with no rate of its own: the market's 1.10 on its day.
      {
        accountId: usCard.id,
        amount: -110,
        currencyCode: "USD",
        transactionDate: day(15),
        categoryId: travelId,
        payeeId: hotel.id,
        payeeName: hotel.name,
      },
      // EUR 200 received as USD 250 at its own 1.25.
      {
        accountId: usCard.id,
        amount: 250,
        currencyCode: "USD",
        originalCurrencyCode: "EUR",
        originalAmount: 200,
        exchangeRate: 1.25,
        transactionDate: day(20),
        categoryId: salaryId,
        payeeId: client.id,
        payeeName: client.name,
      },
      // EUR 100 charged as USD 125 at its own 1.25 (the discussion's row).
      {
        accountId: usCard.id,
        amount: -125,
        currencyCode: "USD",
        originalCurrencyCode: "EUR",
        originalAmount: -100,
        exchangeRate: 1.25,
        transactionDate: day(28),
        categoryId: travelId,
        payeeId: hotel.id,
        payeeName: hotel.name,
      },
    ];
    for (const row of rows) {
      await dataSource.manager.save(
        dataSource.manager.create(Transaction, {
          userId,
          status: TransactionStatus.UNRECONCILED,
          isTransfer: false,
          isSplit: false,
          ...row,
        } as Partial<Transaction>),
      );
    }
    // EUR->USD, the canonical orientation (`EUR` sorts before `USD`).
    for (const [date, rate] of [
      [day(14), "1.1000000000"],
      [day(27), "1.1750000000"],
    ]) {
      await dataSource.query(
        `INSERT INTO exchange_rates (from_currency, to_currency, rate_date, rate, source)
         VALUES ('EUR', 'USD', $1::DATE, $2, 'test')`,
        [date, rate],
      );
    }
  });

  const asUser = <T>(fn: () => Promise<T>): Promise<T> =>
    withUserContext(userId, fn);

  const runCustomReport = async (direction: DirectionFilter) => {
    const report = await dataSource.manager.save(
      dataSource.manager.create(CustomReport, {
        userId,
        name: "Own rate",
        viewType: ReportViewType.TABLE,
        timeframeType: TimeframeType.CUSTOM,
        groupBy: GroupByType.CATEGORY,
        filters: {},
        config: {
          metric: MetricType.TOTAL_AMOUNT,
          includeTransfers: false,
          direction,
          customStartDate: START,
          customEndDate: END,
        },
      } as Partial<CustomReport>),
    );
    return asUser(() => customReports.execute(userId, report.id));
  };

  it("reads the same figures in the built-in reports", async () => {
    const byCategory = await asUser(() =>
      spending.getSpendingByCategory(userId, START, END),
    );
    const byPayee = await asUser(() =>
      spending.getSpendingByPayee(userId, START, END),
    );
    const trend = await asUser(() =>
      spending.getMonthlySpendingTrend(userId, START, END),
    );
    const flows = await asUser(() =>
      income.getIncomeVsExpenses(userId, START, END),
    );
    const bySource = await asUser(() =>
      income.getIncomeBySource(userId, START, END),
    );

    expect(byCategory.currency).toBe("EUR");
    expect(byCategory.totalSpending).toBe(EXPENSES);
    expect(byCategory.data).toEqual([
      expect.objectContaining({ categoryId: travelId, total: EXPENSES }),
    ]);
    expect(byPayee.totalSpending).toBe(EXPENSES);
    expect(trend.data).toEqual([
      expect.objectContaining({ month: MONTH, totalSpending: EXPENSES }),
    ]);
    expect(flows.totals).toMatchObject({
      income: INCOME,
      expenses: EXPENSES,
      net: INCOME - EXPENSES,
    });
    expect(flows.missingCurrencies).toEqual([]);
    expect(bySource.totalIncome).toBe(INCOME);
  });

  it("reads the same figures in a custom report", async () => {
    const expenses = await runCustomReport(DirectionFilter.EXPENSES_ONLY);
    const earned = await runCustomReport(DirectionFilter.INCOME_ONLY);

    expect(expenses.summary.total).toBe(EXPENSES);
    expect(expenses.data).toEqual([
      expect.objectContaining({ id: travelId, value: EXPENSES }),
    ]);
    expect(earned.summary.total).toBe(INCOME);
  });

  it("reads the same figures in the assistant's and the MCP tools' totals", async () => {
    // list_transactions (AI assistant and MCP server alike).
    const list = await asUser(() =>
      analytics.getLlmListTransactions(userId, {
        startDate: START,
        endDate: END,
        groupBy: "category",
        direction: "expenses",
      }),
    );
    // The MCP financial-summary and recent-transactions resources.
    const flowTotals = await asUser(() =>
      analytics.getLlmFlowTotals(userId, { startDate: START, endDate: END }),
    );
    // compare_periods, against an empty month before.
    const comparison = await asUser(() =>
      analytics.getLlmPeriodComparison(userId, {
        period1Start: PREVIOUS.start,
        period1End: PREVIOUS.end,
        period2Start: START,
        period2End: END,
      }),
    );

    expect(list).toMatchObject({
      totalsCurrency: "EUR",
      fxComplete: true,
      missingRatePairs: [],
      totalExpenses: EXPENSES,
      totalIncome: INCOME,
      netCashFlow: INCOME - EXPENSES,
    });
    expect(list.breakdown).toEqual([
      expect.objectContaining({ categoryId: travelId, total: EXPENSES }),
    ]);
    expect(flowTotals).toMatchObject({
      fxComplete: true,
      totalExpenses: EXPENSES,
      totalIncome: INCOME,
    });
    expect(comparison.fxComplete).toBe(true);
    expect(comparison.period2.total).toBe(EXPENSES);
    expect(comparison.totalChange).toBe(EXPENSES);
  });

  it("reads the same figures in the transaction summary and monthly totals", async () => {
    const summary = await asUser(() =>
      analytics.getSummary(
        userId,
        undefined,
        START,
        END,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { inReportingCurrency: true },
      ),
    );
    const monthly = await asUser(() =>
      analytics.getMonthlyTotals(userId, undefined, START, END),
    );

    expect(summary.converted).toMatchObject({
      currency: "EUR",
      totalExpenses: EXPENSES,
      totalIncome: INCOME,
      missingCurrencies: [],
    });
    // The bar chart's signed month: -50 - 100 + 200 - 100.
    expect(monthly).toEqual([
      expect.objectContaining({
        month: MONTH,
        currency: "EUR",
        total: INCOME - EXPENSES,
      }),
    ]);
  });

  it("reads the same figures in the assistant's insights and forecast", async () => {
    const insights = await asUser(() =>
      new InsightsAggregatorService(dataSource, analytics).computeAggregates(
        userId,
        "EUR",
      ),
    );
    // No accounts or schedules to describe: only the history is the subject.
    const forecast = await asUser(() =>
      new ForecastAggregatorService(
        dataSource,
        { findAll: async () => [] } as never,
        analytics,
        { expand: async () => [] } as never,
      ).computeAggregates(userId, "EUR"),
    );

    expect(insights.fxComplete).toBe(true);
    expect(insights.monthlySpending.find((m) => m.month === MONTH)?.total).toBe(
      EXPENSES,
    );

    expect(forecast.fxComplete).toBe(true);
    expect(forecast.missingRatePairs).toEqual([]);
    const history = forecast.monthlyHistory.find((m) => m.month === MONTH);
    expect(history).toMatchObject({
      totalExpenses: EXPENSES,
      totalIncome: INCOME,
      netCashFlow: INCOME - EXPENSES,
    });
    expect(history?.categoryBreakdown).toEqual(
      expect.arrayContaining([
        { categoryName: "Travel", total: EXPENSES, isIncome: false },
        { categoryName: "Consulting", total: INCOME, isIncome: true },
      ]),
    );
    expect(
      forecast.incomePatterns.monthlyIncome.find((m) => m.month === MONTH),
    ).toEqual({ month: MONTH, total: INCOME, sourceCount: 1 });
  });
});
