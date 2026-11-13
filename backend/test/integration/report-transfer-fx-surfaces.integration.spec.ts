import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { ReportCurrencyService } from "@/built-in-reports/report-currency.service";
import { CashFlowSankeyService } from "@/built-in-reports/cash-flow-sankey.service";
import { MonthlyCategoryBreakdownService } from "@/built-in-reports/monthly-category-breakdown.service";
import { IncomeReportsService } from "@/built-in-reports/income-reports.service";
import { TransactionAnalyticsService } from "@/transactions/transaction-analytics.service";
import { TransactionsModule } from "@/transactions/transactions.module";
import { PayeeDetailService } from "@/payees/payee-detail.service";
import {
  Transaction,
  TransactionStatus,
} from "@/transactions/entities/transaction.entity";
import { TransactionSplit } from "@/transactions/entities/transaction-split.entity";
import { SplitKind } from "@/transactions/entities/split-kind.enum";
import { buildRateIndex } from "@/common/time-series/rate-index.util";
import { withScopedDb } from "@/common/db/scoped-db";
import { withUserContext } from "@/common/db/with-context";
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
 * A transfer leg converts at the two amounts its transfer moved on every
 * report, chart and analytics read that counts transfers, not only in a custom
 * report (issue #2153, after #2150): the SQL reads of the built-in reports, the
 * Cash Flow Sankey and the assistant's and MCP tools' analytics, against real
 * PostgreSQL.
 *
 * The market says 1 EUR = 1.25 USD. On 10 March:
 *
 *   a plain transfer: 100 USD from US Chequing arrived as 90 EUR in Euro
 *     Savings (the incoming leg stores 0.85, deliberately not 90 / 100);
 *   a split: -160 USD on US Chequing, 60 USD of groceries and a 100 USD line
 *     to Euro Savings that arrived as 90 EUR.
 *
 * In EUR each 100 USD transfer is 90, not the market's 80, and the groceries
 * line is the market's 48. In USD each 90 EUR leg is 100, not the market's
 * 112.50.
 */
describe("a transfer leg at the amounts moved, on every report (integration)", () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let analytics: TransactionAnalyticsService;
  let sankey: CashFlowSankeyService;
  let breakdown: MonthlyCategoryBreakdownService;
  let income: IncomeReportsService;

  let userId: string;
  let usId: string;
  let euId: string;
  let plainOutId: string;
  let payeeId: string;
  let transferLineId: string;

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
    sankey = new CashFlowSankeyService(dataSource, currency);
    breakdown = new MonthlyCategoryBreakdownService(dataSource, currency);
    income = new IncomeReportsService(dataSource, currency);
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
        ...overrides,
      } as Partial<Transaction>),
    );

  const tag = async (column: string, id: string): Promise<void> => {
    const [existing] = await dataSource.query(
      `SELECT id FROM tags WHERE user_id = $1 AND name = 'scope:home'`,
      [userId],
    );
    const tagId =
      existing?.id ??
      (
        await dataSource.query(
          `INSERT INTO tags (user_id, name) VALUES ($1, 'scope:home') RETURNING id`,
          [userId],
        )
      )[0].id;
    const table =
      column === "transaction_id"
        ? "transaction_tags"
        : "transaction_split_tags";
    await dataSource.query(
      `INSERT INTO ${table} (${column}, tag_id) VALUES ($1, $2)`,
      [id, tagId],
    );
  };

  async function seed(reporting: "EUR" | "USD"): Promise<void> {
    await dataSource.query(
      `INSERT INTO user_preferences (user_id, default_currency) VALUES ($1, $2)`,
      [userId, reporting],
    );

    const payee = await createTestPayee(dataSource, userId, {
      name: "Exchange",
    });
    payeeId = payee.id;
    const out = await insertRow({
      accountId: usId,
      amount: -100,
      currencyCode: "USD",
      payeeId,
      payeeName: payee.name,
    });
    const into = await insertRow({
      accountId: euId,
      amount: 90,
      currencyCode: "EUR",
      exchangeRate: 0.85,
      linkedTransactionId: out.id,
    });
    await dataSource.manager.update(
      Transaction,
      { id: out.id },
      { linkedTransactionId: into.id },
    );
    plainOutId = out.id;

    const groceries = await createTestCategory(dataSource, userId, {
      name: "Groceries",
    });
    const parent = await insertRow({
      accountId: usId,
      amount: -160,
      currencyCode: "USD",
      isSplit: true,
      isTransfer: false,
    });
    const counterpart = await insertRow({
      accountId: euId,
      amount: 90,
      currencyCode: "EUR",
      exchangeRate: 0.9,
      linkedTransactionId: parent.id,
    });
    await dataSource.manager.save(
      dataSource.manager.create(TransactionSplit, {
        transactionId: parent.id,
        amount: -60,
        categoryId: groceries.id,
      }),
    );
    const line = await dataSource.manager.save(
      dataSource.manager.create(TransactionSplit, {
        transactionId: parent.id,
        amount: -100,
        kind: SplitKind.TRANSFER,
        transferAccountId: euId,
        linkedTransactionId: counterpart.id,
      }),
    );
    transferLineId = line.id;

    // EUR->USD, the canonical orientation (`EUR` sorts before `USD`).
    await dataSource.query(
      `INSERT INTO exchange_rates (from_currency, to_currency, rate_date, rate, source)
       VALUES ('EUR', 'USD', '2026-03-01'::DATE, 1.2500000000, 'test')`,
    );
  }

  beforeEach(async () => {
    await cleanTables(dataSource, [
      "exchange_rates",
      "transaction_split_tags",
      "transaction_tags",
      "tags",
      "transaction_splits",
      "transactions",
      "monthly_account_balances",
      "accounts",
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
    usId = (
      await createTestAccount(dataSource, userId, {
        name: "US Chequing",
        accountType: "CHEQUING",
        currencyCode: "USD",
      })
    ).id;
    euId = (
      await createTestAccount(dataSource, userId, {
        name: "Euro Savings",
        accountType: "SAVINGS",
        currencyCode: "EUR",
      })
    ).id;
  });

  const asUser = <T>(fn: () => Promise<T>): Promise<T> =>
    withUserContext(userId, fn);

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

  it("reads both outgoing transfers at 90 EUR in the Cash Flow Sankey", async () => {
    await seed("EUR");

    const result = await asUser(() =>
      sankey.getCashFlowSankey(userId, START, END, { accountIds: [usId] }),
    );

    // The plain leg and the split's transfer line, each 90 EUR, not 80.
    expect(result.nodes.find((n) => n.id === "class:savings")?.total).toBe(180);
    expect(result.missingCurrencies).toEqual([]);
  });

  it("reads the outgoing leg at 90 EUR in the monthly category breakdown", async () => {
    await seed("EUR");

    const result = await asUser(() =>
      breakdown.getMonthlyCategoryBreakdown(userId, START, END, {
        accountIds: [usId],
      }),
    );

    expect(result.transfers).toEqual([
      {
        accountId: usId,
        accountName: "US Chequing",
        direction: "from",
        valuesByMonth: { "2026-03": 90 },
      },
    ]);
    expect(result.missingCurrencies).toEqual([]);
  });

  it("reads tagged transfer flows at 90 EUR each in Income vs Expenses", async () => {
    await seed("EUR");
    await tag("transaction_id", plainOutId);
    await tag("transaction_split_id", transferLineId);

    const result = await asUser(() =>
      income.getIncomeVsExpenses(userId, START, END, {
        tagKey: "scope",
        accountIds: [usId],
      }),
    );

    const home = result.buckets?.find((b) => b.value === "home");
    expect(home?.taggedOutflows).toBe(180);
    expect(result.missingCurrencies).toEqual([]);
  });

  it("reads the outgoing leg at 90 EUR in the transaction summary and grouped totals", async () => {
    await seed("EUR");
    await tag("transaction_id", plainOutId);

    const summary = await summaryOf([usId]);
    const byPayee = await asUser(() =>
      analytics.getGroupedTotals(userId, {
        groupBy: "payee",
        accountIds: [usId],
        startDate: START,
        endDate: END,
      }),
    );
    const byTag = await asUser(() =>
      analytics.getTransactionBreakdownByTagKey(userId, "scope", {
        accountIds: [usId],
        startDate: START,
        endDate: END,
      }),
    );

    // The plain leg's 90 and the groceries line's 60 / 1.25; the split's
    // transfer line is not a row of these reads.
    expect(summary.converted).toMatchObject({
      currency: "EUR",
      totalExpenses: 138,
      missingCurrencies: [],
    });
    const payeeTotal = byPayee.reduce(
      (sum, row) => sum + (row.convertedTotal as number),
      0,
    );
    expect(payeeTotal).toBe(-138);
    expect(byTag).toEqual([
      expect.objectContaining({ name: "home", total: 100, convertedTotal: 90 }),
    ]);
  });

  it("reads the outgoing leg at 90 EUR in a payee's account panel", async () => {
    await seed("EUR");

    const detail = await asUser(() =>
      new PayeeDetailService(dataSource, {
        findOne: async () => ({ id: payeeId }),
      } as never).getDetail(userId, payeeId),
    );

    expect(
      detail.accounts.map((r) => [r.accountName, r.total, r.convertedTotal]),
    ).toEqual([["US Chequing", -100, -90]]);
  });

  it("reads every leg at the amounts moved in the monthly totals and the MCP flow totals", async () => {
    await seed("EUR");

    const monthly = await asUser(() =>
      analytics.getMonthlyTotals(userId, undefined, START, END),
    );
    const flows = await asUser(() =>
      analytics.getLlmFlowTotals(userId, {
        startDate: START,
        endDate: END,
        excludeTransfers: false,
      }),
    );

    // -90 - 48 + 90 + 90; the market rate would read -80 - 48 + 180.
    expect(monthly).toEqual([
      expect.objectContaining({ month: "2026-03", currency: "EUR", total: 42 }),
    ]);
    expect(flows).toMatchObject({
      fxComplete: true,
      totalExpenses: 138,
      totalIncome: 180,
    });
  });

  it("reads each incoming EUR leg at the 100 USD sent, a split's counterpart at its own line", async () => {
    await seed("USD");

    const summary = await summaryOf([euId]);

    // 100 each, not 90 x 1.25 = 112.50, and the split counterpart at its line's
    // 100, not the parent's 160.
    expect(summary.converted).toMatchObject({
      currency: "USD",
      totalIncome: 200,
      missingCurrencies: [],
    });
  });
});
