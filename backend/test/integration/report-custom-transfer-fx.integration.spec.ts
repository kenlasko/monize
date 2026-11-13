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
import {
  Transaction,
  TransactionStatus,
} from "@/transactions/entities/transaction.entity";
import { TransactionSplit } from "@/transactions/entities/transaction-split.entity";
import { SplitKind } from "@/transactions/entities/split-kind.enum";
import { UserPreference } from "@/users/entities/user-preference.entity";
import { withUserContext } from "@/common/db/with-context";
import {
  createIntegrationModule,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { createTestAccount } from "../helpers/test-factories";

/**
 * The custom report engine reads a transfer's other side off its own fetch
 * (discussion #2139). 100 USD sent from US Chequing arrived as 90 EUR in Euro
 * Savings; no exchange rate is stored at all, so any figure the report gives
 * for the USD leg in EUR, or the EUR leg in USD, comes from the two posted
 * amounts. Each report names one account, so the other side is outside its
 * scope and must still convert it without becoming a row.
 */
describe("custom report: a transfer leg converts at the amounts moved (integration)", () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let reports: ReportsService;
  let userId: string;
  let usdId: string;
  let eurId: string;

  const START = "2026-03-01";
  const END = "2026-03-31";

  beforeAll(async () => {
    module = await createIntegrationModule([]);
    dataSource = module.get(DataSource);
    const currency = new ReportCurrencyService(dataSource, {
      getRateIndex: async () => new Map(),
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

  beforeEach(async () => {
    await cleanTables(dataSource, [
      "custom_reports",
      "transaction_splits",
      "transactions",
      "accounts",
      "user_preferences",
      "users",
    ]);
    await dataSource.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places, is_active)
       VALUES ('EUR', 'Euro', 'E', 2, true),
              ('USD', 'US Dollar', '$', 2, true)
       ON CONFLICT (code) DO NOTHING`,
    );
    userId = (await createTestUserDirect(dataSource)).id;
    usdId = (
      await createTestAccount(dataSource, userId, {
        name: "US Chequing",
        currencyCode: "USD",
      })
    ).id;
    eurId = (
      await createTestAccount(dataSource, userId, {
        name: "Euro Savings",
        currencyCode: "EUR",
      })
    ).id;
  });

  const preferring = (defaultCurrency: string) =>
    dataSource.manager.save(
      dataSource.manager.create(UserPreference, { userId, defaultCurrency }),
    );

  const insertRow = (overrides: Partial<Transaction>): Promise<Transaction> =>
    dataSource.manager.save(
      dataSource.manager.create(Transaction, {
        userId,
        transactionDate: "2026-03-10",
        status: TransactionStatus.UNRECONCILED,
        isSplit: false,
        isTransfer: true,
        exchangeRate: 1,
        ...overrides,
      } as Partial<Transaction>),
    );

  async function insertPlainTransfer(): Promise<void> {
    const out = await insertRow({
      accountId: usdId,
      amount: -100,
      currencyCode: "USD",
    });
    const into = await insertRow({
      accountId: eurId,
      amount: 90,
      currencyCode: "EUR",
      // Deliberately not 90 / 100: the posted amounts are the fact.
      exchangeRate: 0.85,
      linkedTransactionId: out.id,
    });
    await dataSource.manager.update(
      Transaction,
      { id: out.id },
      { linkedTransactionId: into.id },
    );
  }

  /** -160 USD: 60 of groceries and a 100 USD line that arrived as 90 EUR. */
  async function insertSplitTransfer(): Promise<void> {
    const parent = await insertRow({
      accountId: usdId,
      amount: -160,
      currencyCode: "USD",
      isSplit: true,
      isTransfer: false,
    });
    const into = await insertRow({
      accountId: eurId,
      amount: 90,
      currencyCode: "EUR",
      exchangeRate: 0.9,
      linkedTransactionId: parent.id,
    });
    await dataSource.manager.save(
      dataSource.manager.create(TransactionSplit, {
        transactionId: parent.id,
        amount: -60,
      }),
    );
    await dataSource.manager.save(
      dataSource.manager.create(TransactionSplit, {
        transactionId: parent.id,
        amount: -100,
        kind: SplitKind.TRANSFER,
        transferAccountId: eurId,
        linkedTransactionId: into.id,
      }),
    );
  }

  async function run(accountId: string) {
    const report = await dataSource.manager.save(
      dataSource.manager.create(CustomReport, {
        userId,
        name: "Report",
        viewType: ReportViewType.TABLE,
        timeframeType: TimeframeType.CUSTOM,
        groupBy: GroupByType.NONE,
        filters: { accountIds: [accountId] },
        config: {
          metric: MetricType.NONE,
          includeTransfers: true,
          direction: DirectionFilter.BOTH,
          customStartDate: START,
          customEndDate: END,
        },
      } as Partial<CustomReport>),
    );
    return withUserContext(userId, () => reports.execute(userId, report.id));
  }

  it("reads the outgoing leg alone in EUR at what arrived", async () => {
    await preferring("EUR");
    await insertPlainTransfer();

    const result = await run(usdId);

    expect(result.data.map((d) => [d.account, d.value])).toEqual([
      ["US Chequing", -90],
    ]);
    expect(result.missingCurrencies).toEqual([]);
    expect(result.excludedCount).toBe(0);
  });

  it("reads the incoming leg alone in USD at what was sent", async () => {
    await preferring("USD");
    await insertPlainTransfer();

    const result = await run(eurId);

    expect(result.data.map((d) => [d.account, d.value])).toEqual([
      ["Euro Savings", 100],
    ]);
  });

  it("reads a split's transfer line at its counterpart, its other line unknown", async () => {
    await preferring("EUR");
    await insertSplitTransfer();

    const result = await run(usdId);

    // The groceries line has no rate on file and is left out, named.
    expect(result.data.map((d) => d.value)).toEqual([-90]);
    expect(result.missingCurrencies).toEqual(["USD"]);
    expect(result.excludedCount).toBe(1);
  });

  it("reads a split transfer's counterpart at its own line, not the parent", async () => {
    await preferring("USD");
    await insertSplitTransfer();

    const result = await run(eurId);

    expect(result.data.map((d) => [d.account, d.value])).toEqual([
      ["Euro Savings", 100],
    ]);
  });
});
