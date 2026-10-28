import type { ExchangeRateService } from "@/currencies/exchange-rate.service";
import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
// Import order matters here and is load-bearing. `securities.module` sits in a
// require cycle with the accounts and currencies graphs, and requiring the
// module before the service it provides leaves `HoldingsService` undefined when
// Nest reads InvestmentTransactionsService's parameter metadata -- the failure
// reads as "the argument at index [3] is not available". The service comes
// first, as in `investment-transactions.integration.spec.ts`, and the report
// services (which reach `currencies/exchange-rate.service` through
// `report-currency.service`) come after both.
import { InvestmentTransactionsService } from "@/securities/investment-transactions.service";
import { SecuritiesModule } from "@/securities/securities.module";
import { SecuritiesService } from "@/securities/securities.service";
import { AnomalyReportsService } from "@/built-in-reports/anomaly-reports.service";
import { ComparisonReportsService } from "@/built-in-reports/comparison-reports.service";
import { DataQualityReportsService } from "@/built-in-reports/data-quality-reports.service";
import { IncomeReportsService } from "@/built-in-reports/income-reports.service";
import { MonthlyCategoryBreakdownService } from "@/built-in-reports/monthly-category-breakdown.service";
import { ReportCurrencyService } from "@/built-in-reports/report-currency.service";
import { SpendingReportsService } from "@/built-in-reports/spending-reports.service";
import { TaxRecurringReportsService } from "@/built-in-reports/tax-recurring-reports.service";
import {
  Account,
  AccountSubType,
  AccountType,
} from "@/accounts/entities/account.entity";
import {
  Transaction,
  TransactionStatus,
} from "@/transactions/entities/transaction.entity";
import { TransactionSplit } from "@/transactions/entities/transaction-split.entity";
import { SplitKind } from "@/transactions/entities/split-kind.enum";
import {
  InvestmentAction,
  InvestmentTransaction,
} from "@/securities/entities/investment-transaction.entity";
import { TransactionAnalyticsService } from "@/transactions/transaction-analytics.service";
import { ForecastAggregatorService } from "@/ai/forecast/forecast-aggregator.service";
import { ReportsService } from "@/reports/reports.service";
import {
  CustomReport,
  DirectionFilter,
  GroupByType,
  MetricType,
  ReportViewType,
  TimeframeType,
} from "@/reports/entities/custom-report.entity";
import { withUserContext } from "@/common/db/with-context";
import {
  createIntegrationModule,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import {
  createTestAccount,
  createTestCategory,
} from "../helpers/test-factories";

/**
 * INV-REPORT-001 against a real PostgreSQL database: a report's account scope is
 * investment LINKAGE, never account type.
 *
 * An INVESTMENT account is a pair -- an `INVESTMENT_CASH` sleeve holding real
 * money and an `INVESTMENT_BROKERAGE` sleeve holding securities -- so the old
 * `AND a.account_type != 'INVESTMENT'` deleted the cash sleeve's whole ledger
 * from fifteen report queries, salary deposits included (issue #1257). The
 * rows that must go are the cash legs a trade generates, which the account-type
 * filter never described in the first place.
 *
 * The unit specs mock `manager.query`, so they can only assert the text of the
 * SQL. This suite runs it: it reproduces the issue's scenario with the real
 * writer (`InvestmentTransactionsService.create` posts the cash leg) and checks
 * both directions -- what must now appear, and what must still not.
 */
describe("built-in reports and investment cash accounts (integration)", () => {
  let module: TestingModule;
  let spending: SpendingReportsService;
  let income: IncomeReportsService;
  let comparison: ComparisonReportsService;
  let anomalies: AnomalyReportsService;
  let taxRecurring: TaxRecurringReportsService;
  let dataQuality: DataQualityReportsService;
  let breakdown: MonthlyCategoryBreakdownService;
  let customReports: ReportsService;
  let analytics!: TransactionAnalyticsService;
  let investments: InvestmentTransactionsService;
  let dataSource: DataSource;

  let userId: string;
  let cashSleeveId: string;
  let brokerageId: string;
  let chequingId: string;
  let salaryCategoryId: string;
  let groceriesCategoryId: string;
  let securityId: string;

  const MONTH = "2026-03";
  const START = "2026-03-01";
  const END = "2026-03-31";

  beforeAll(async () => {
    module = await createIntegrationModule([SecuritiesModule]);
    investments = module.get(InvestmentTransactionsService);
    dataSource = module.get(DataSource);

    // The report services read the ledger with raw SQL and take only a
    // DataSource and a currency resolver, so they are constructed directly.
    // Reaching them through `BuiltInReportsModule` pulls the
    // accounts/transactions/currencies module cycle in behind them, which the
    // integration harness cannot build. Every fixture is USD, so no exchange
    // rate is ever looked up and an empty rate list is the honest stub.
    const currency = new ReportCurrencyService(dataSource, {
      getLatestRates: async () => [],
      getRateHistory: async () => [],
    } satisfies Pick<
      ExchangeRateService,
      "getLatestRates" | "getRateHistory"
    > as unknown as ExchangeRateService);
    spending = new SpendingReportsService(dataSource, currency);
    income = new IncomeReportsService(dataSource, currency);
    comparison = new ComparisonReportsService(dataSource, currency);
    anomalies = new AnomalyReportsService(dataSource, currency);
    taxRecurring = new TaxRecurringReportsService(dataSource, currency);
    dataQuality = new DataQualityReportsService(dataSource, currency);
    breakdown = new MonthlyCategoryBreakdownService(dataSource, currency);
    // `execute` uses neither the budgets service (only the BUDGET_VARIANCE
    // metric does) nor action history (only the writes do).
    customReports = new ReportsService(
      dataSource,
      {} as never,
      {} as never,
      currency,
    );
    analytics = new TransactionAnalyticsService(dataSource);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanTables(dataSource, [
      "action_history",
      "custom_reports",
      "holdings",
      "security_prices",
      "securities",
      "transaction_splits",
      "transactions",
      "investment_transactions",
      "monthly_account_balances",
      "accounts",
      "categories",
      "payees",
      "users",
    ]);
    await dataSource.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places) VALUES ('USD', 'US Dollar', '$', 2) ON CONFLICT DO NOTHING`,
    );

    const user = await createTestUserDirect(dataSource);
    userId = user.id;

    const cash = await createTestAccount(dataSource, userId, {
      name: "TFSA - Cash",
      openingBalance: 0,
      currentBalance: 0,
    });
    await dataSource.manager.update(Account, cash.id, {
      accountType: AccountType.INVESTMENT,
      accountSubType: AccountSubType.INVESTMENT_CASH,
    });
    cashSleeveId = cash.id;

    const brokerage = await createTestAccount(dataSource, userId, {
      name: "TFSA - Investments",
      openingBalance: 0,
      currentBalance: 0,
    });
    await dataSource.manager.update(Account, brokerage.id, {
      accountType: AccountType.INVESTMENT,
      accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
      linkedAccountId: cashSleeveId,
    });
    brokerageId = brokerage.id;

    const chequing = await createTestAccount(dataSource, userId, {
      name: "Chequing",
      openingBalance: 5000,
      currentBalance: 5000,
    });
    chequingId = chequing.id;

    salaryCategoryId = (
      await createTestCategory(dataSource, userId, {
        name: "Employment Income",
        isIncome: true,
      })
    ).id;
    groceriesCategoryId = (
      await createTestCategory(dataSource, userId, { name: "Groceries" })
    ).id;

    const security = await withUserContext(userId, () =>
      module.get(SecuritiesService).create(userId, {
        symbol: "AAPL",
        name: "Apple Inc.",
        securityType: "STOCK" as any,
        currencyCode: "USD",
      } as any),
    );
    securityId = security.id;
  });

  async function insertTransaction(
    overrides: Partial<Transaction>,
  ): Promise<Transaction> {
    const tx = dataSource.manager.create(Transaction, {
      userId,
      accountId: cashSleeveId,
      transactionDate: "2026-03-10",
      amount: -100,
      currencyCode: "USD",
      status: TransactionStatus.UNRECONCILED,
      isTransfer: false,
      isSplit: false,
      ...overrides,
    } as Partial<Transaction>);
    return dataSource.manager.save(tx);
  }

  /**
   * A split parent in the cash sleeve carrying an embedded investment line,
   * shaped as `createEmbeddedForSplit` writes it: the investment line has no
   * category, its InvestmentTransaction points at the SPLIT (`transaction_id`
   * stays null), and the parent's amount is the sum of all its children.
   *
   * `ordinaryAmount: 0` builds the pure passthrough -- a parent whose only line
   * is the investment one, which `transaction-split.service` allows.
   */
  async function createEmbeddedInvestmentParent(options: {
    date?: string;
    ordinaryAmount?: number;
    investmentAmount?: number;
    payeeName?: string;
    action?: InvestmentAction;
  }): Promise<Transaction> {
    const ordinary = options.ordinaryAmount ?? -60;
    const investment = options.investmentAmount ?? -500;
    const parent = await insertTransaction({
      transactionDate: options.date ?? "2026-03-10",
      amount: ordinary + investment,
      isSplit: true,
      categoryId: null,
      payeeName: options.payeeName ?? "Brokerage statement",
    });

    const lines: TransactionSplit[] = [];
    if (ordinary !== 0) {
      lines.push(
        dataSource.manager.create(TransactionSplit, {
          transactionId: parent.id,
          kind: SplitKind.CATEGORY,
          categoryId: groceriesCategoryId,
          amount: ordinary,
        } as Partial<TransactionSplit>),
      );
    }
    const investmentLine = dataSource.manager.create(TransactionSplit, {
      transactionId: parent.id,
      kind: SplitKind.INVESTMENT,
      categoryId: null,
      amount: investment,
    } as Partial<TransactionSplit>);
    lines.push(investmentLine);
    await dataSource.manager.save(lines);

    await dataSource.manager.save(
      dataSource.manager.create(InvestmentTransaction, {
        userId,
        accountId: brokerageId,
        transactionSplitId: investmentLine.id,
        securityId,
        action: options.action ?? InvestmentAction.BUY,
        transactionDate: options.date ?? "2026-03-10",
        quantity: 10,
        price: Math.abs(investment) / 10,
        commission: 0,
        // A MAGNITUDE, as `calculateTotalAmount` stores it; the split line's own
        // amount carries the cash direction (negative for a BUY, positive for a
        // SELL).
        totalAmount: Math.abs(investment),
        exchangeRate: 1,
        status: TransactionStatus.UNRECONCILED,
      } as Partial<InvestmentTransaction>),
    );

    return parent;
  }

  /** A date N whole months before today, for the reports that window on now(). */
  function monthsBeforeToday(months: number): string {
    const d = new Date();
    d.setMonth(d.getMonth() - months);
    return d.toISOString().slice(0, 10);
  }

  /**
   * The scenario from issue #1257: $1,000 of employment income paid straight
   * into the cash sleeve of an investment account.
   */
  async function insertSleeveSalary(): Promise<Transaction> {
    return insertTransaction({
      amount: 1000,
      categoryId: salaryCategoryId,
      payeeName: "Acme Payroll",
      description: "March salary",
    });
  }

  /**
   * A trade through the real writer. With no funding account the cash leg lands
   * in the linked sleeve; with one it lands in that account instead -- which is
   * how investment-generated cash reaches an ordinary chequing ledger, where no
   * account-type predicate could ever have recognised it.
   */
  async function createTrade(
    action: InvestmentAction,
    overrides: {
      date?: string;
      quantity?: number;
      price?: number;
      fundingAccountId?: string;
    } = {},
  ): Promise<InvestmentTransaction> {
    return withUserContext(userId, () =>
      investments.create(userId, {
        accountId: brokerageId,
        action,
        transactionDate: overrides.date ?? "2026-03-12",
        securityId,
        quantity: overrides.quantity ?? 10,
        price: overrides.price ?? 50,
        commission: 0,
        ...(overrides.fundingAccountId
          ? { fundingAccountId: overrides.fundingAccountId }
          : {}),
      } as any),
    );
  }

  async function createBuy(
    date = "2026-03-12",
    quantity = 10,
    price = 50,
  ): Promise<InvestmentTransaction> {
    return createTrade(InvestmentAction.BUY, { date, quantity, price });
  }

  /** The cash row a trade generated, asserted to be where the test expects. */
  async function generatedLeg(
    trade: InvestmentTransaction,
    expectedAccountId: string,
  ): Promise<Transaction> {
    const leg = await dataSource.manager.findOneOrFail(Transaction, {
      where: { id: trade.transactionId as string },
    });
    expect(leg.accountId).toBe(expectedAccountId);
    expect(leg.categoryId).toBeNull();
    expect(leg.isTransfer).toBe(false);
    return leg;
  }

  describe("the reported bug", () => {
    it("counts sleeve income in Cash Flow and excludes the trade's cash leg", async () => {
      await insertSleeveSalary();
      const buy = await createBuy();

      // The writer really did post a cash leg into the sleeve -- otherwise the
      // exclusion below would be proving nothing.
      const leg = await dataSource.manager.findOneOrFail(Transaction, {
        where: { id: buy.transactionId as string },
      });
      expect(leg.accountId).toBe(cashSleeveId);
      expect(Number(leg.amount)).toBe(-500);
      expect(leg.categoryId).toBeNull();

      const cashFlow = await withUserContext(userId, () =>
        income.getIncomeVsExpenses(userId, START, END),
      );

      expect(cashFlow.totals.income).toBe(1000);
      expect(cashFlow.totals.expenses).toBe(0);
      expect(cashFlow.totals.net).toBe(1000);
      expect(cashFlow.data).toEqual([
        {
          period: MONTH,
          periodStart: `${MONTH}-01`,
          periodEnd: `${MONTH}-31`,
          income: 1000,
          expenses: 0,
          net: 1000,
        },
      ]);
    });

    it("lists the sleeve's income category in Income by Source", async () => {
      await insertSleeveSalary();
      await createBuy();

      const result = await withUserContext(userId, () =>
        income.getIncomeBySource(userId, START, END),
      );

      expect(result.totalIncome).toBe(1000);
      expect(result.data).toEqual([
        expect.objectContaining({
          categoryId: salaryCategoryId,
          categoryName: "Employment Income",
          total: 1000,
        }),
      ]);
    });

    it("counts sleeve spending by category without an Uncategorized bucket for the trade", async () => {
      await insertTransaction({
        amount: -60,
        categoryId: groceriesCategoryId,
        payeeName: "Corner Store",
      });
      await createBuy();

      const result = await withUserContext(userId, () =>
        spending.getSpendingByCategory(userId, START, END),
      );

      expect(result.data).toEqual([
        expect.objectContaining({ categoryId: groceriesCategoryId, total: 60 }),
      ]);
      expect(result.totalSpending).toBe(60);
    });

    it("does not offer the generated trade payee as a merchant", async () => {
      await insertTransaction({
        amount: -60,
        categoryId: groceriesCategoryId,
        payeeName: "Corner Store",
      });
      const buy = await createBuy();

      const leg = await dataSource.manager.findOneOrFail(Transaction, {
        where: { id: buy.transactionId as string },
      });
      expect(leg.payeeName).toContain("AAPL");

      const result = await withUserContext(userId, () =>
        spending.getSpendingByPayee(userId, START, END),
      );

      const payees = result.data.map((row) => row.payeeName);
      expect(payees).toEqual(["Corner Store"]);
    });
  });

  /**
   * The Cash Flow page issues three requests -- the monthly aggregate, the
   * inflow breakdown and the outflow breakdown -- and every one of them carried
   * the account-type predicate. A per-query fix that left them disagreeing would
   * show a chart and two tables that do not add up, so the reconciliation is
   * asserted rather than assumed.
   */
  describe("the Cash Flow page's three queries", () => {
    it("reconcile with each other over the same range", async () => {
      await insertSleeveSalary();
      await insertTransaction({
        amount: -60,
        categoryId: groceriesCategoryId,
        payeeName: "Corner Store",
      });
      await insertTransaction({
        accountId: chequingId,
        amount: -40,
        categoryId: groceriesCategoryId,
        payeeName: "Bakery",
      });
      await createBuy();

      const [cashFlow, bySource, byCategory] = await withUserContext(
        userId,
        async () =>
          Promise.all([
            income.getIncomeVsExpenses(userId, START, END),
            income.getIncomeBySource(userId, START, END),
            spending.getSpendingByCategory(userId, START, END),
          ]),
      );

      expect(cashFlow.totals.income).toBe(1000);
      expect(cashFlow.totals.expenses).toBe(100);
      expect(bySource.totalIncome).toBe(cashFlow.totals.income);
      expect(byCategory.totalSpending).toBe(cashFlow.totals.expenses);
    });
  });

  /**
   * The user-defined custom report engine reads the same ledger through
   * hydrated TypeORM entities and aggregates in TypeScript, so none of the SQL
   * fragments reach it. It was the one report surface left outside
   * INV-REPORT-001 (re-audit F-CUSTOM-001): a generated BUY leg was reported as
   * `Uncategorized` spending, and an embedded investment line was counted beside
   * its ordinary sibling.
   */
  describe("custom reports", () => {
    async function runCustomReport(overrides: {
      groupBy?: GroupByType;
      metric?: MetricType;
      direction?: DirectionFilter;
      includeTransfers?: boolean;
      filters?: CustomReport["filters"];
    }) {
      const report = await dataSource.manager.save(
        dataSource.manager.create(CustomReport, {
          userId,
          name: "Spending",
          viewType: ReportViewType.TABLE,
          timeframeType: TimeframeType.CUSTOM,
          groupBy: overrides.groupBy ?? GroupByType.CATEGORY,
          filters: overrides.filters ?? {},
          config: {
            metric: overrides.metric ?? MetricType.TOTAL_AMOUNT,
            includeTransfers: overrides.includeTransfers ?? false,
            direction: overrides.direction ?? DirectionFilter.EXPENSES_ONLY,
            customStartDate: START,
            customEndDate: END,
          },
        } as Partial<CustomReport>),
      );

      return withUserContext(userId, () =>
        customReports.execute(userId, report.id),
      );
    }

    it("does not report a generated BUY leg as Uncategorized spending", async () => {
      await insertTransaction({
        amount: -60,
        categoryId: groceriesCategoryId,
        payeeName: "Corner Store",
      });
      await createBuy();

      const result = await runCustomReport({ groupBy: GroupByType.CATEGORY });

      expect(result.data).toEqual([
        expect.objectContaining({ id: groceriesCategoryId, value: 60 }),
      ]);
      expect(result.summary.total).toBe(60);
    });

    it("does not report a generated leg in an ordinary funding account either", async () => {
      await insertTransaction({
        accountId: chequingId,
        amount: -40,
        categoryId: groceriesCategoryId,
        payeeName: "Bakery",
      });
      await createTrade(InvestmentAction.BUY, {
        quantity: 10,
        price: 100,
        fundingAccountId: chequingId,
      });

      const result = await runCustomReport({ groupBy: GroupByType.CATEGORY });

      expect(result.summary.total).toBe(40);
    });

    it("counts only the ordinary line of a mixed split, grouped by category", async () => {
      await createEmbeddedInvestmentParent({
        ordinaryAmount: -60,
        investmentAmount: -500,
      });

      const result = await runCustomReport({ groupBy: GroupByType.CATEGORY });

      // Not 560, and not 0: the groceries line survives its investment sibling.
      expect(result.data).toEqual([
        expect.objectContaining({ id: groceriesCategoryId, value: 60 }),
      ]);
      expect(result.summary.total).toBe(60);
    });

    it("counts only the ordinary line when grouped by payee, month and tag", async () => {
      await createEmbeddedInvestmentParent({
        ordinaryAmount: -60,
        investmentAmount: -500,
        payeeName: "Brokerage statement",
      });

      for (const groupBy of [
        GroupByType.PAYEE,
        GroupByType.MONTH,
        GroupByType.TAG,
      ]) {
        const result = await runCustomReport({ groupBy });
        expect(result.summary.total).toBe(60);
      }
    });

    it("omits a pure embedded-investment passthrough entirely", async () => {
      await createEmbeddedInvestmentParent({
        ordinaryAmount: 0,
        investmentAmount: -500,
        payeeName: "Broker",
      });

      for (const groupBy of [
        GroupByType.CATEGORY,
        GroupByType.PAYEE,
        GroupByType.MONTH,
        GroupByType.TAG,
        GroupByType.NONE,
      ]) {
        const result = await runCustomReport({ groupBy });
        expect(result.data).toEqual([]);
      }
    });

    it("lists the ordinary lines of a mixed split without aggregating", async () => {
      await createEmbeddedInvestmentParent({
        ordinaryAmount: -60,
        investmentAmount: -500,
        payeeName: "Brokerage statement",
      });

      const result = await runCustomReport({
        groupBy: GroupByType.NONE,
        metric: MetricType.NONE,
      });

      expect(result.data).toEqual([expect.objectContaining({ value: 60 })]);
    });

    it("leaves a transfer split line out when the report excludes transfers", async () => {
      // `transaction.isTransfer` is false on a split parent carrying a transfer
      // LINE, so the parent-level filter never saw it and the -200 counted as
      // spending.
      const parent = await insertTransaction({
        amount: -260,
        isSplit: true,
        categoryId: null,
        payeeName: "Sleeve sweep",
      });
      await dataSource.manager.save([
        dataSource.manager.create(TransactionSplit, {
          transactionId: parent.id,
          kind: SplitKind.CATEGORY,
          categoryId: groceriesCategoryId,
          amount: -60,
        } as Partial<TransactionSplit>),
        dataSource.manager.create(TransactionSplit, {
          transactionId: parent.id,
          kind: SplitKind.TRANSFER,
          transferAccountId: chequingId,
          amount: -200,
        } as Partial<TransactionSplit>),
      ]);
      // The counterpart leg the transfer writer creates in the target account.
      await insertTransaction({
        accountId: chequingId,
        amount: 200,
        isTransfer: true,
        categoryId: null,
      });

      const excluded = await runCustomReport({
        groupBy: GroupByType.CATEGORY,
        includeTransfers: false,
      });
      expect(excluded.summary.total).toBe(60);

      // ...and the user can still ask for them.
      const included = await runCustomReport({
        groupBy: GroupByType.CATEGORY,
        includeTransfers: true,
      });
      expect(included.summary.total).toBe(260);
    });

    it("honours a brokerage account named inside a mixed OR group", async () => {
      // Conditions in a group are OR'd, so this filter explicitly asks for
      // brokerage rows. A whole-report boolean read it as "not an account
      // scope" and excluded the sleeve globally, making the arm unmatchable
      // (audit F-CUSTOM-OR-001).
      await insertTransaction({
        accountId: brokerageId,
        amount: -75,
        categoryId: groceriesCategoryId,
        payeeName: "Brokerage fee",
      });

      const result = await runCustomReport({
        groupBy: GroupByType.CATEGORY,
        filters: {
          filterGroups: [
            {
              conditions: [
                { field: "account", value: [brokerageId] },
                { field: "category", value: [salaryCategoryId] },
              ],
            },
          ],
        },
      });

      expect(result.summary.total).toBe(75);
    });

    it("does not admit the sleeve through an unrelated OR arm", async () => {
      // The negative control for the case above: Groceries matches, but the
      // brokerage account was never named, so its row stays out.
      await insertTransaction({
        accountId: brokerageId,
        amount: -75,
        categoryId: groceriesCategoryId,
        payeeName: "Brokerage fee",
      });
      await insertTransaction({
        accountId: chequingId,
        amount: -40,
        categoryId: groceriesCategoryId,
        payeeName: "Bakery",
      });

      const result = await runCustomReport({
        groupBy: GroupByType.CATEGORY,
        filters: {
          filterGroups: [
            {
              conditions: [
                { field: "account", value: [chequingId] },
                { field: "category", value: [groceriesCategoryId] },
              ],
            },
          ],
        },
      });

      expect(result.summary.total).toBe(40);
    });

    it("keeps an expense whose parent an embedded SELL turned positive", async () => {
      // -60 groceries beside a +500 embedded SELL is a +440 parent. Direction
      // was decided on that sum, so EXPENSES_ONLY threw the row away before
      // provenance could remove the SELL (audit F-CUSTOM-DIR-001).
      await createTrade(InvestmentAction.BUY, {
        date: "2026-03-05",
        quantity: 10,
        price: 50,
      });
      const parent = await createEmbeddedInvestmentParent({
        ordinaryAmount: -60,
        investmentAmount: 500,
        action: InvestmentAction.SELL,
      });
      expect(Number(parent.amount)).toBe(440);

      const custom = await runCustomReport({
        groupBy: GroupByType.CATEGORY,
        direction: DirectionFilter.EXPENSES_ONLY,
      });
      const builtIn = await withUserContext(userId, () =>
        spending.getSpendingByCategory(userId, START, END),
      );

      expect(custom.summary.total).toBe(60);
      // The same ledger through the other engine: same answer.
      expect(custom.summary.total).toBe(builtIn.totalSpending);
    });

    it("keeps income whose parent an embedded BUY turned negative", async () => {
      const parent = await createEmbeddedInvestmentParent({
        ordinaryAmount: 60,
        investmentAmount: -500,
        payeeName: "Brokerage statement",
      });
      expect(Number(parent.amount)).toBe(-440);

      const result = await runCustomReport({
        groupBy: GroupByType.CATEGORY,
        direction: DirectionFilter.INCOME_ONLY,
      });

      expect(result.summary.total).toBe(60);
    });

    it("still counts ordinary cash in the sleeve, and agrees with the built-in report", async () => {
      await insertTransaction({
        amount: -60,
        categoryId: groceriesCategoryId,
        payeeName: "Corner Store",
      });
      await createBuy();

      const custom = await runCustomReport({ groupBy: GroupByType.CATEGORY });
      const builtIn = await withUserContext(userId, () =>
        spending.getSpendingByCategory(userId, START, END),
      );

      // The two engines answer the same question about one ledger, so a
      // divergence here is the defect whichever side moved.
      expect(custom.summary.total).toBe(builtIn.totalSpending);
    });
  });

  /**
   * The register's own analytics read the same rows. Their grouped totals are
   * drill-downs: a bucket links to the register filtered the same way, so a
   * figure the filtered list cannot show is a dead end (found by /code-review
   * over this branch).
   */
  describe("register analytics", () => {
    it("does not file an embedded investment line under Uncategorized", async () => {
      await createEmbeddedInvestmentParent({
        ordinaryAmount: -60,
        investmentAmount: -500,
      });

      const grouped = await withUserContext(userId, () =>
        analytics.getGroupedTotals(userId, {
          groupBy: "category",
          startDate: START,
          endDate: END,
        }),
      );

      // Exactly the groceries line: the -500 investment line would otherwise
      // open an "Uncategorized" bucket whose drill-down is empty.
      expect(grouped).toEqual([
        expect.objectContaining({ id: groceriesCategoryId, total: -60 }),
      ]);
    });

    it("agrees with its own summary about what the ordinary cash was", async () => {
      await createEmbeddedInvestmentParent({
        ordinaryAmount: -60,
        investmentAmount: -500,
      });

      const summary = await withUserContext(userId, () =>
        analytics.getSummary(userId, undefined, START, END),
      );

      expect(summary.totalExpenses).toBe(60);
      expect(summary.totalIncome).toBe(0);
    });

    it("detects a recurring charge at its ordinary amount, not the parent's", async () => {
      // Three monthly mixed parents: 60 of ordinary spending each, beside a
      // -500 embedded BUY. The AI assistant and MCP read this detector, and the
      // built-in Recurring Expenses report answers 60 for the same rows.
      for (const months of [1, 2, 3]) {
        await createEmbeddedInvestmentParent({
          date: monthsBeforeToday(months),
          ordinaryAmount: -60,
          investmentAmount: -500,
          payeeName: "Brokerage statement",
        });
      }

      const charges = await withUserContext(userId, () =>
        analytics.getRecurringCharges(
          userId,
          monthsBeforeToday(6),
          monthsBeforeToday(0),
        ),
      );

      expect(charges).toEqual([
        expect.objectContaining({ payeeName: "Brokerage statement" }),
      ]);
      // Every occurrence is the ordinary 60, never the parent's 560.
      expect(charges[0].amounts).toEqual([60, 60, 60]);
      expect(charges[0].currentAmount).toBe(60);
    });

    it("leaves a pure investment passthrough out of recurring charges", async () => {
      for (const months of [1, 2, 3]) {
        await createEmbeddedInvestmentParent({
          date: monthsBeforeToday(months),
          ordinaryAmount: 0,
          investmentAmount: -500,
          payeeName: "Broker",
        });
      }

      const charges = await withUserContext(userId, () =>
        analytics.getRecurringCharges(
          userId,
          monthsBeforeToday(6),
          monthsBeforeToday(0),
        ),
      );

      expect(charges).toEqual([]);
    });
  });

  /**
   * The AI forecast trains on this baseline, and it reads one row per payment
   * with no split join -- so a split parent's own amount taught it a household
   * spend nobody made.
   */
  describe("forecast baseline", () => {
    it("learns the ordinary part of a mixed split, not the parent total", async () => {
      await createEmbeddedInvestmentParent({
        ordinaryAmount: -60,
        investmentAmount: -500,
      });
      await insertSleeveSalary();

      // `getMonthlyHistory` is private and the public entry point needs the
      // accounts and analytics services; the SQL is the subject here, and only a
      // real database can execute it.
      const forecast = new ForecastAggregatorService(
        dataSource,
        {} as never,
        {} as never,
        {} as never,
      );
      const history = await withUserContext(userId, () =>
        (
          forecast as unknown as {
            getMonthlyHistory: (
              userId: string,
              startDate: string,
              endDate: string,
            ) => Promise<
              Array<{
                month: string;
                totalIncome: number;
                totalExpenses: number;
              }>
            >;
          }
        ).getMonthlyHistory(userId, START, END),
      );

      expect(history).toEqual([
        expect.objectContaining({
          month: MONTH,
          totalIncome: 1000,
          totalExpenses: 60,
        }),
      ]);
    });
  });

  /**
   * The claim across the whole catalogue rather than report by report: adding a
   * trade to a sleeve that already holds ordinary income and ordinary spending
   * changes no report's answer. Every endpoint under `built-in-reports` that
   * reads the transaction ledger is in the list; a new one belongs here too.
   */
  describe("every report", () => {
    async function everyReport(): Promise<Record<string, unknown>> {
      return withUserContext(userId, async () => ({
        spendingByCategory: await spending.getSpendingByCategory(
          userId,
          START,
          END,
        ),
        spendingByPayee: await spending.getSpendingByPayee(userId, START, END),
        monthlySpendingTrend: await spending.getMonthlySpendingTrend(
          userId,
          START,
          END,
        ),
        incomeBySource: await income.getIncomeBySource(userId, START, END),
        incomeVsExpenses: await income.getIncomeVsExpenses(userId, START, END),
        yearOverYear: await comparison.getYearOverYear(userId, 2),
        weekendVsWeekday: await comparison.getWeekendVsWeekday(
          userId,
          START,
          END,
        ),
        spendingAnomalies: await anomalies.getSpendingAnomalies(userId, 2),
        taxSummary: await taxRecurring.getTaxSummary(userId, 2026),
        recurringExpenses: await taxRecurring.getRecurringExpenses(userId, 1),
        billPaymentHistory: await taxRecurring.getBillPaymentHistory(
          userId,
          START,
          END,
        ),
        uncategorized: await dataQuality.getUncategorizedTransactions(
          userId,
          START,
          END,
        ),
        duplicates: await dataQuality.getDuplicateTransactions(
          userId,
          START,
          END,
        ),
        monthlyCategoryBreakdown: await breakdown.getMonthlyCategoryBreakdown(
          userId,
          START,
          END,
        ),
      }));
    }

    it("answers the same with and without a trade in the sleeve", async () => {
      await insertSleeveSalary();
      await insertTransaction({
        amount: -60,
        categoryId: groceriesCategoryId,
        payeeName: "Corner Store",
      });

      const before = await everyReport();
      await createBuy();
      const after = await everyReport();

      expect(after).toEqual(before);
    });

    it("sees the sleeve's own rows in the first place", async () => {
      // Guards the test above from passing because every report is empty --
      // which is exactly what the defect produced.
      await insertSleeveSalary();
      await insertTransaction({
        amount: -60,
        categoryId: groceriesCategoryId,
        payeeName: "Corner Store",
      });
      // An ordinary account alongside, so the test also says the fix left
      // non-investment accounts alone.
      await insertTransaction({
        accountId: chequingId,
        amount: -40,
        categoryId: groceriesCategoryId,
        payeeName: "Bakery",
      });

      const snapshot = JSON.stringify(await everyReport());

      expect(snapshot).toContain("Corner Store");
      expect(snapshot).toContain("Employment Income");
      expect(snapshot).toContain("Bakery");
    });
  });

  describe("what stays excluded", () => {
    it("keeps a brokerage-sleeve row out of Cash Flow", async () => {
      await insertSleeveSalary();
      await insertTransaction({
        accountId: brokerageId,
        amount: 999,
        categoryId: salaryCategoryId,
        payeeName: "Stray brokerage row",
      });

      const cashFlow = await withUserContext(userId, () =>
        income.getIncomeVsExpenses(userId, START, END),
      );

      expect(cashFlow.totals.income).toBe(1000);
    });

    it("keeps a trade's cash leg out of Uncategorized, and keeps a real one in", async () => {
      await createBuy();
      const manual = await insertTransaction({
        amount: -25,
        categoryId: null,
        payeeName: "Unfiled sleeve fee",
      });

      const result = await withUserContext(userId, () =>
        dataQuality.getUncategorizedTransactions(userId, START, END),
      );

      expect(result.transactions.map((t) => t.id)).toEqual([manual.id]);
      // The list and the summary are two queries over one predicate; a
      // difference between them is the defect this asserts against.
      expect(result.summary.totalCount).toBe(1);
      expect(result.summary.expenseCount).toBe(1);
      expect(result.summary.expenseTotal).toBe(25);
    });

    it("does not report two identical trade legs as duplicate transactions", async () => {
      // Two partial fills at the same price on the same day: identical cash
      // legs, and neither is editable from the cash register.
      await createBuy("2026-03-12", 10, 50);
      await createBuy("2026-03-12", 10, 50);

      const result = await withUserContext(userId, () =>
        dataQuality.getDuplicateTransactions(userId, START, END),
      );

      expect(result.groups).toEqual([]);
    });

    it("keeps a trade's cash leg out of an ordinary funding account's report", async () => {
      // The inverse of issue #1257, same root: an explicit funding account puts
      // generated investment cash in a CHEQUING ledger, where the old
      // account-type predicate could not see it at all. Before the fix this
      // month reported 1000 of expenses that nobody spent.
      await insertTransaction({
        accountId: chequingId,
        amount: -60,
        categoryId: groceriesCategoryId,
        payeeName: "Corner Store",
      });
      const buy = await createTrade(InvestmentAction.BUY, {
        quantity: 10,
        price: 100,
        fundingAccountId: chequingId,
      });
      const leg = await generatedLeg(buy, chequingId);
      expect(Number(leg.amount)).toBe(-1000);

      const cashFlow = await withUserContext(userId, () =>
        income.getIncomeVsExpenses(userId, START, END),
      );

      expect(cashFlow.totals.expenses).toBe(60);
      expect(cashFlow.totals.income).toBe(0);
    });

    it("keeps a dividend paid into an ordinary account out of income", async () => {
      const dividend = await createTrade(InvestmentAction.DIVIDEND, {
        quantity: 1,
        price: 30,
        fundingAccountId: chequingId,
      });
      const leg = await generatedLeg(dividend, chequingId);
      expect(Number(leg.amount)).toBe(30);

      const cashFlow = await withUserContext(userId, () =>
        income.getIncomeVsExpenses(userId, START, END),
      );
      const bySource = await withUserContext(userId, () =>
        income.getIncomeBySource(userId, START, END),
      );

      expect(cashFlow.totals.income).toBe(0);
      expect(bySource.data).toEqual([]);
      expect(bySource.totalIncome).toBe(0);
    });

    it("keeps a SELL's cash credit out of income", async () => {
      await insertSleeveSalary();
      // Buy before selling: a SELL with no holding behind it is a state the
      // production writer would not have produced, so the fixture would not be
      // evidence about a report.
      await createTrade(InvestmentAction.BUY, {
        date: "2026-03-05",
        quantity: 10,
        price: 50,
      });
      const sell = await createTrade(InvestmentAction.SELL, {
        date: "2026-03-12",
        quantity: 4,
        price: 75,
      });
      const leg = await generatedLeg(sell, cashSleeveId);
      expect(Number(leg.amount)).toBe(300);

      const cashFlow = await withUserContext(userId, () =>
        income.getIncomeVsExpenses(userId, START, END),
      );

      expect(cashFlow.totals.income).toBe(1000);
      expect(cashFlow.totals.expenses).toBe(0);
    });

    it("counts ordinary cash on a standalone investment account", async () => {
      // account_type INVESTMENT with no sub-type: the shape the ordinary
      // account-create path produces, and which net-worth and the monthly
      // comparison already branch on. It holds both securities and its own
      // cash, so it IS the cash side and the sleeve exclusion must not reach
      // it. (A .mny import is NOT such a case -- `map-reference.ts` always
      // emits the linked CASH/BROKERAGE pair.)
      const standalone = await createTestAccount(dataSource, userId, {
        name: "Legacy Brokerage",
        openingBalance: 0,
        currentBalance: 0,
      });
      await dataSource.manager.update(Account, standalone.id, {
        accountType: AccountType.INVESTMENT,
        accountSubType: null,
      });
      await insertTransaction({
        accountId: standalone.id,
        amount: 250,
        categoryId: salaryCategoryId,
        payeeName: "Acme Payroll",
      });

      const cashFlow = await withUserContext(userId, () =>
        income.getIncomeVsExpenses(userId, START, END),
      );

      expect(cashFlow.totals.income).toBe(250);
    });

    it("still excludes a VOID row in the sleeve", async () => {
      await insertSleeveSalary();
      await insertTransaction({
        amount: 5000,
        categoryId: salaryCategoryId,
        payeeName: "Voided bonus",
        status: TransactionStatus.VOID,
      });

      const cashFlow = await withUserContext(userId, () =>
        income.getIncomeVsExpenses(userId, START, END),
      );

      expect(cashFlow.totals.income).toBe(1000);
    });

    it("still excludes a transfer split line in the sleeve", async () => {
      const parent = await insertTransaction({
        amount: -260,
        isSplit: true,
        categoryId: null,
        payeeName: "Sleeve sweep",
      });
      const groceries = dataSource.manager.create(TransactionSplit, {
        transactionId: parent.id,
        kind: SplitKind.CATEGORY,
        categoryId: groceriesCategoryId,
        amount: -60,
      } as Partial<TransactionSplit>);
      const transferOut = dataSource.manager.create(TransactionSplit, {
        transactionId: parent.id,
        kind: SplitKind.TRANSFER,
        transferAccountId: chequingId,
        amount: -200,
      } as Partial<TransactionSplit>);
      await dataSource.manager.save([groceries, transferOut]);
      // The counterpart leg the transfer writer creates in the target account.
      await insertTransaction({
        accountId: chequingId,
        amount: 200,
        isTransfer: true,
        categoryId: null,
      });

      const byCategory = await withUserContext(userId, () =>
        spending.getSpendingByCategory(userId, START, END),
      );

      expect(byCategory.totalSpending).toBe(60);
    });

    it("does not count an investment line embedded in a split", async () => {
      await createEmbeddedInvestmentParent({
        ordinaryAmount: -60,
        investmentAmount: -500,
      });

      const byCategory = await withUserContext(userId, () =>
        spending.getSpendingByCategory(userId, START, END),
      );

      expect(byCategory.data).toEqual([
        expect.objectContaining({ categoryId: groceriesCategoryId, total: 60 }),
      ]);
      expect(byCategory.totalSpending).toBe(60);

      const cashFlow = await withUserContext(userId, () =>
        income.getIncomeVsExpenses(userId, START, END),
      );
      expect(cashFlow.totals.expenses).toBe(60);
    });

    /**
     * The reports that read only the parent row. `t.amount` there is the sum of
     * ALL children and an embedded investment line's `transaction_id` is null,
     * so the transaction-level linkage cannot see it: without a derived amount
     * these reported the whole `-560` as ordinary cash (branch audit F-RPT-001).
     * Excluding the parent instead would lose the 60 the user did spend, so both
     * wrong answers are asserted against.
     */
    it("reports only the ordinary line of a mixed split by payee", async () => {
      await createEmbeddedInvestmentParent({
        ordinaryAmount: -60,
        investmentAmount: -500,
        payeeName: "Brokerage statement",
      });

      const byPayee = await withUserContext(userId, () =>
        spending.getSpendingByPayee(userId, START, END),
      );

      expect(byPayee.data).toEqual([
        expect.objectContaining({
          payeeName: "Brokerage statement",
          total: 60,
        }),
      ]);
      expect(byPayee.totalSpending).toBe(60);
    });

    it("does not call a pure embedded-investment passthrough uncategorized", async () => {
      await createEmbeddedInvestmentParent({
        ordinaryAmount: 0,
        investmentAmount: -500,
        payeeName: "Broker",
      });
      const unfiled = await insertTransaction({
        amount: -25,
        categoryId: null,
        payeeName: "Unfiled sleeve fee",
      });

      const result = await withUserContext(userId, () =>
        dataQuality.getUncategorizedTransactions(userId, START, END),
      );

      expect(result.transactions.map((t) => t.id)).toEqual([unfiled.id]);
      expect(result.summary.totalCount).toBe(1);
      expect(result.summary.expenseCount).toBe(1);
      expect(result.summary.expenseTotal).toBe(25);
    });

    it("reports the ordinary part of a mixed uncategorized split, not the parent total", async () => {
      // -60 unfiled ordinary cash beside a -500 embedded BUY: the row IS
      // uncategorized, but for 60, not 560.
      const parent = await insertTransaction({
        amount: -560,
        isSplit: true,
        categoryId: null,
        payeeName: "Brokerage statement",
      });
      const unfiledLine = dataSource.manager.create(TransactionSplit, {
        transactionId: parent.id,
        kind: SplitKind.CATEGORY,
        categoryId: null,
        amount: -60,
      } as Partial<TransactionSplit>);
      const investmentLine = dataSource.manager.create(TransactionSplit, {
        transactionId: parent.id,
        kind: SplitKind.INVESTMENT,
        categoryId: null,
        amount: -500,
      } as Partial<TransactionSplit>);
      await dataSource.manager.save([unfiledLine, investmentLine]);
      await dataSource.manager.save(
        dataSource.manager.create(InvestmentTransaction, {
          userId,
          accountId: brokerageId,
          transactionSplitId: investmentLine.id,
          securityId,
          action: InvestmentAction.BUY,
          transactionDate: "2026-03-10",
          quantity: 10,
          price: 50,
          commission: 0,
          totalAmount: -500,
          exchangeRate: 1,
          status: TransactionStatus.UNRECONCILED,
        } as Partial<InvestmentTransaction>),
      );

      const result = await withUserContext(userId, () =>
        dataQuality.getUncategorizedTransactions(userId, START, END),
      );

      expect(result.transactions).toEqual([
        expect.objectContaining({ id: parent.id, amount: -60 }),
      ]);
      expect(result.summary.expenseTotal).toBe(60);
    });

    it("does not learn recurring spending from embedded BUY cash", async () => {
      // Dates are derived from today because getRecurringExpenses windows on
      // now() -- a pinned month would fall out of range as the clock moves.
      for (const months of [1, 2, 3]) {
        await createEmbeddedInvestmentParent({
          date: monthsBeforeToday(months),
          ordinaryAmount: 0,
          investmentAmount: -500,
          payeeName: "Broker",
        });
      }

      const result = await withUserContext(userId, () =>
        taxRecurring.getRecurringExpenses(userId, 3),
      );

      expect(result.data).toEqual([]);
      expect(result.summary.totalRecurring).toBe(0);
    });

    it("counts a mixed recurring parent at its ordinary amount", async () => {
      for (const months of [1, 2, 3]) {
        await createEmbeddedInvestmentParent({
          date: monthsBeforeToday(months),
          ordinaryAmount: -60,
          investmentAmount: -500,
          payeeName: "Brokerage statement",
        });
      }

      const result = await withUserContext(userId, () =>
        taxRecurring.getRecurringExpenses(userId, 3),
      );

      expect(result.data).toEqual([
        expect.objectContaining({
          payeeName: "Brokerage statement",
          occurrences: 3,
          totalAmount: 180,
          averageAmount: 60,
        }),
      ]);
    });

    it("widens the recurring window with the range, and leaves all unbounded", async () => {
      for (const months of [8, 9, 10]) {
        await createEmbeddedInvestmentParent({
          date: monthsBeforeToday(months),
          ordinaryAmount: -60,
          investmentAmount: -500,
          payeeName: "Annual-ish",
        });
      }

      const [sixMonths, oneYear, allTime] = [
        await withUserContext(userId, () =>
          taxRecurring.getRecurringExpenses(userId, 3),
        ),
        await withUserContext(userId, () =>
          taxRecurring.getRecurringExpenses(userId, 3, "1y"),
        ),
        await withUserContext(userId, () =>
          taxRecurring.getRecurringExpenses(userId, 3, "all"),
        ),
      ];

      expect(sixMonths.data).toEqual([]);
      expect(oneYear.data).toEqual([
        expect.objectContaining({ payeeName: "Annual-ish", occurrences: 3 }),
      ]);
      expect(allTime.data).toEqual([
        expect.objectContaining({ payeeName: "Annual-ish", occurrences: 3 }),
      ]);
      // The user's spending history began ten months back, so neither the
      // year nor all time spreads the 180 over more months than that.
      expect(allTime.summary.monthCount).toBe(10);
      expect(allTime.summary.monthlyEstimate).toBe(18);
      expect(oneYear.summary.monthCount).toBe(10);
      expect(oneYear.summary.monthlyEstimate).toBe(18);
    });

    /**
     * The declared exception (branch audit DR-001): the duplicate finder's
     * subject is the stored row, so a split parent entered twice is a duplicate
     * at its stored amount -- the remedy is deleting one whole transaction, and
     * a per-child figure would name a row nobody can delete.
     */
    it("still reports a duplicated split parent at its stored amount", async () => {
      await createEmbeddedInvestmentParent({
        ordinaryAmount: -60,
        investmentAmount: -500,
        payeeName: "Brokerage statement",
      });
      await createEmbeddedInvestmentParent({
        ordinaryAmount: -60,
        investmentAmount: -500,
        payeeName: "Brokerage statement",
      });

      const result = await withUserContext(userId, () =>
        dataQuality.getDuplicateTransactions(userId, START, END),
      );

      expect(result.groups).toHaveLength(1);
      expect(result.groups[0].transactions).toHaveLength(2);
      expect(result.groups[0].transactions[0].amount).toBe(-560);
    });
  });
});
