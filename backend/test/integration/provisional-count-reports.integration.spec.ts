import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { ReportCurrencyService } from "@/built-in-reports/report-currency.service";
import { ReportsService } from "@/reports/reports.service";
import {
  CustomReport,
  DirectionFilter,
  GroupByType,
  MetricType,
  ReportViewType,
  TimeframeType,
} from "@/reports/entities/custom-report.entity";
import { TransactionAnalyticsService } from "@/transactions/transaction-analytics.service";
import { TransactionsModule } from "@/transactions/transactions.module";
import {
  Transaction,
  TransactionStatus,
} from "@/transactions/entities/transaction.entity";
import { buildRateIndex } from "@/common/time-series/rate-index.util";
import { withScopedDb } from "@/common/db/scoped-db";
import { withUserContext } from "@/common/db/with-context";
import {
  cleanTables,
  createIntegrationModule,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { createTestAccount, createTestPayee } from "../helpers/test-factories";

/**
 * Custom reports and the transaction-analytics reads say how many provisional
 * amounts their figures hold (`docs/future-plans/provisional-amounts.md`
 * section 6, P5; section 10 rows 2 and 3), against real PostgreSQL.
 *
 * The section 7 example: 100 USD sent from US Chequing on a day whose stored
 * rate is 0.80 EUR per USD (EUR->USD 1.25), reporting in EUR. The USD file's
 * import estimated the EUR leg at +80 and flagged it provisional.
 *
 *   USD account only: -80, count 0
 *   EUR account only: +80, count 1
 *   both:               0, count 1
 *
 * Once the EUR file confirms +90 the count is 0 everywhere.
 */
describe("provisional count on custom reports and transaction analytics (integration)", () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let reports: ReportsService;
  let analytics: TransactionAnalyticsService;
  let userId: string;
  let usdId: string;
  let eurId: string;
  let payeeId: string;
  let inId: string;

  const START = "2026-03-01";
  const END = "2026-03-31";
  const DAY = "2026-03-10";

  beforeAll(async () => {
    module = await createIntegrationModule([TransactionsModule]);
    dataSource = module.get(DataSource);
    analytics = module.get(TransactionAnalyticsService);
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
    reports = new ReportsService(
      dataSource,
      {} as never,
      {} as never,
      currency,
    );
  });

  afterAll(async () => {
    await module.close();
  });

  const insertRow = (overrides: Partial<Transaction>): Promise<Transaction> =>
    dataSource.manager.save(
      dataSource.manager.create(Transaction, {
        userId,
        transactionDate: DAY,
        status: TransactionStatus.UNRECONCILED,
        isSplit: false,
        isTransfer: true,
        exchangeRate: 1,
        payeeId,
        payeeName: "Exchange",
        ...overrides,
      } as Partial<Transaction>),
    );

  beforeEach(async () => {
    await cleanTables(dataSource, [
      "exchange_rates",
      "custom_reports",
      "transaction_tags",
      "tags",
      "transaction_splits",
      "transactions",
      "monthly_account_balances",
      "accounts",
      "payees",
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
    usdId = (
      await createTestAccount(dataSource, userId, {
        name: "US Chequing",
        accountType: "CHEQUING",
        currencyCode: "USD",
      })
    ).id;
    eurId = (
      await createTestAccount(dataSource, userId, {
        name: "Euro Savings",
        accountType: "SAVINGS",
        currencyCode: "EUR",
      })
    ).id;
    payeeId = (await createTestPayee(dataSource, userId, { name: "Exchange" }))
      .id;

    const out = await insertRow({
      accountId: usdId,
      amount: -100,
      currencyCode: "USD",
    });
    const into = await insertRow({
      accountId: eurId,
      amount: 80,
      currencyCode: "EUR",
      exchangeRate: 0.8,
      linkedTransactionId: out.id,
      amountIsProvisional: true,
    });
    await dataSource.manager.update(
      Transaction,
      { id: out.id },
      { linkedTransactionId: into.id },
    );
    inId = into.id;
    const [tag] = await dataSource.query(
      `INSERT INTO tags (user_id, name) VALUES ($1, 'trip:lisbon') RETURNING id`,
      [userId],
    );
    await dataSource.query(
      `INSERT INTO transaction_tags (transaction_id, tag_id) VALUES ($1, $2), ($3, $2)`,
      [out.id, tag.id, into.id],
    );
    // EUR->USD, the canonical orientation: 1 EUR = 1.25 USD, 0.80 EUR per USD.
    await dataSource.query(
      `INSERT INTO exchange_rates (from_currency, to_currency, rate_date, rate, source)
       VALUES ('EUR', 'USD', '2026-03-01'::DATE, 1.2500000000, 'test')`,
    );
  });

  const asUser = <T>(fn: () => Promise<T>): Promise<T> =>
    withUserContext(userId, fn);

  const confirm = (amount: number) =>
    dataSource.manager.update(
      Transaction,
      { id: inId },
      { amount, amountIsProvisional: false },
    );

  const voidTheLeg = () =>
    dataSource.manager.update(
      Transaction,
      { id: inId },
      { status: TransactionStatus.VOID },
    );

  describe("custom report", () => {
    async function run(
      accountIds: string[],
      config: Record<string, unknown> = {},
      groupBy: GroupByType = GroupByType.NONE,
    ) {
      const report = await dataSource.manager.save(
        dataSource.manager.create(CustomReport, {
          userId,
          name: "Report",
          viewType: ReportViewType.TABLE,
          timeframeType: TimeframeType.CUSTOM,
          groupBy,
          filters: { accountIds },
          config: {
            metric: MetricType.NONE,
            includeTransfers: true,
            direction: DirectionFilter.BOTH,
            customStartDate: START,
            customEndDate: END,
            ...config,
          },
        } as Partial<CustomReport>),
      );
      return asUser(() => reports.execute(userId, report.id));
    }

    it("counts nothing when only the confirmed side is in the report", async () => {
      const result = await run([usdId]);

      expect(result.data.map((d) => [d.account, d.value])).toEqual([
        ["US Chequing", -80],
      ]);
      expect(result.provisionalCount).toBe(0);
      expect(result.summary.provisionalCount).toBe(0);
    });

    it("counts the estimate when only the provisional side is in the report (row 2)", async () => {
      const result = await run([eurId]);

      expect(result.data.map((d) => [d.account, d.value])).toEqual([
        ["Euro Savings", 80],
      ]);
      expect(result.summary.total).toBe(80);
      expect(result.provisionalCount).toBe(1);
      expect(result.summary.provisionalCount).toBe(1);
    });

    it("nets both sides to zero and counts the estimate once (row 3)", async () => {
      const result = await run([usdId, eurId]);

      expect(result.summary.total).toBe(0);
      expect(result.missingCurrencies).toEqual([]);
      expect(result.provisionalCount).toBe(1);
    });

    it("counts the estimate once in a grouped report whose groups both hold it", async () => {
      const result = await run(
        [usdId, eurId],
        { metric: MetricType.TOTAL_AMOUNT },
        GroupByType.TAG,
      );

      expect(result.data.map((d) => d.label)).toEqual(["trip:lisbon"]);
      expect(result.provisionalCount).toBe(1);
    });

    it("counts nothing once the EUR file confirmed what arrived", async () => {
      await confirm(90);

      const result = await run([usdId, eurId]);

      expect(result.summary.total).toBe(0);
      expect(result.provisionalCount).toBe(0);
    });

    it("counts nothing for a void leg", async () => {
      await voidTheLeg();

      const result = await run([eurId]);

      expect(result.data).toEqual([]);
      expect(result.provisionalCount).toBe(0);
    });
  });

  describe("transaction analytics", () => {
    const summaryOf = (accountIds: string[]) =>
      asUser(() =>
        analytics.getSummary(
          userId,
          accountIds,
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

    it("counts nothing in the summary of the confirmed side alone", async () => {
      const summary = await summaryOf([usdId]);

      expect(summary.converted?.netCashFlow).toBe(-80);
      expect(summary.provisionalCount).toBe(0);
      expect(summary.converted?.provisionalCount).toBe(0);
    });

    it("counts the estimate in the summary of the provisional side alone (row 2)", async () => {
      const summary = await summaryOf([eurId]);

      expect(summary.converted?.netCashFlow).toBe(80);
      expect(summary.provisionalCount).toBe(1);
      expect(summary.converted?.provisionalCount).toBe(1);
    });

    it("nets both sides to zero in the summary and counts the estimate once (row 3)", async () => {
      const summary = await summaryOf([usdId, eurId]);

      expect(summary.converted?.netCashFlow).toBe(0);
      expect(summary.converted?.missingCurrencies).toEqual([]);
      expect(summary.provisionalCount).toBe(1);
      expect(summary.converted?.provisionalCount).toBe(1);
    });

    it("counts nothing in the summary once the amount is confirmed, or of a void leg", async () => {
      await confirm(90);
      expect((await summaryOf([usdId, eurId])).provisionalCount).toBe(0);

      await dataSource.manager.update(
        Transaction,
        { id: inId },
        { amountIsProvisional: true },
      );
      await voidTheLeg();
      expect((await summaryOf([eurId])).provisionalCount).toBe(0);
    });

    it("counts the estimate in its payee group, its month and its tag value", async () => {
      const groups = await asUser(() =>
        analytics.getGroupedTotals(userId, {
          groupBy: "payee",
          accountIds: [usdId, eurId],
          startDate: START,
          endDate: END,
        }),
      );
      expect(
        groups.map((g) => [g.currencyCode, g.total, g.provisionalCount]),
      ).toEqual([
        ["USD", -100, 0],
        ["EUR", 80, 1],
      ]);

      const months = await asUser(() =>
        analytics.getMonthlyTotals(userId, [usdId, eurId], START, END),
      );
      expect(months.map((m) => [m.month, m.total, m.provisionalCount])).toEqual(
        [["2026-03", 0, 1]],
      );

      const values = await asUser(() =>
        analytics.getTransactionBreakdownByTagKey(userId, "trip", {
          startDate: START,
          endDate: END,
        }),
      );
      expect(
        values.map((v) => [v.name, v.currencyCode, v.provisionalCount]),
      ).toEqual([
        ["lisbon", "USD", 0],
        ["lisbon", "EUR", 1],
      ]);
    });

    it("counts the estimate in the flow totals that keep transfers, and none in those that do not", async () => {
      const withTransfers = await asUser(() =>
        analytics.getLlmFlowTotals(userId, {
          startDate: START,
          endDate: END,
          excludeTransfers: false,
        }),
      );
      expect(withTransfers.totalIncome).toBe(80);
      expect(withTransfers.totalExpenses).toBe(80);
      expect(withTransfers.provisionalCount).toBe(1);

      const flows = await asUser(() =>
        analytics.getLlmListTransactions(userId, {
          startDate: START,
          endDate: END,
        }),
      );
      expect(flows.provisionalCount).toBe(0);

      const rollup = await asUser(() =>
        analytics.getLlmListTransactions(userId, {
          startDate: START,
          endDate: END,
          transfersOnly: true,
        }),
      );
      expect(
        rollup.transfers?.accounts.map((a) => [
          a.accountName,
          a.provisionalCount,
        ]),
      ).toEqual([
        ["Euro Savings", 1],
        ["US Chequing", 0],
      ]);
      expect(rollup.transfers?.provisionalCount).toBe(1);
    });

    it("reads the period comparison's count, 0 while it leaves transfers out", async () => {
      const comparison = await asUser(() =>
        analytics.getLlmPeriodComparison(userId, {
          period1Start: "2026-02-01",
          period1End: "2026-02-28",
          period2Start: START,
          period2End: END,
          direction: "both",
        }),
      );

      expect(comparison.period1.provisionalCount).toBe(0);
      expect(comparison.period2.provisionalCount).toBe(0);
    });
  });
});
