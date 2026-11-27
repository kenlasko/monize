import { BadRequestException } from "@nestjs/common";
import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import type { RateIndex } from "@/common/time-series/rate-index.util";
import { UserPreference } from "@/users/entities/user-preference.entity";
import { ReportCurrencyService } from "@/built-in-reports/report-currency.service";
import { ReportsService } from "@/reports/reports.service";
import {
  CustomReport,
  DirectionFilter,
  GroupByType,
  MetricType,
  ReportViewType,
  TimeframeType,
  TransferMeasure,
} from "@/reports/entities/custom-report.entity";
import {
  Transaction,
  TransactionStatus,
} from "@/transactions/entities/transaction.entity";
import { withUserContext } from "@/common/db/with-context";
import {
  createIntegrationModule,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { createTestAccount } from "../helpers/test-factories";

/**
 * The custom report's transfer measure (`docs/specs/transfer-categories.md`
 * sections 8 and 10, INV-REPORT-004 as amended): transfer legs only, a
 * category's legs netted within it, read as Outgoing (a magnitude), Incoming
 * or Net. The numerical example of section 8.3 is the acceptance test; a
 * saved report without a measure returns what it returned before.
 */
describe("custom report: the transfer measure (integration)", () => {
  jest.setTimeout(60000);

  let module: TestingModule;
  let db: DataSource;
  let reports: ReportsService;
  let userId: string;
  let chequing: string;
  let hisa: string;
  let brokerage: string;
  let savingsCat: string;
  let investmentCat: string;
  let groceriesCat: string;
  let rates: RateIndex = new Map();

  beforeAll(async () => {
    module = await createIntegrationModule([]);
    db = module.get(DataSource);
    const currency = new ReportCurrencyService(db, {
      getRateIndex: async () => rates,
    } as never);
    reports = new ReportsService(
      db,
      {} as never,
      { record: jest.fn() } as never,
      currency,
    );
  });

  afterAll(async () => {
    await module.close();
  });

  const setReporting = (code: string) =>
    db.manager.save(UserPreference, { userId, defaultCurrency: code });

  beforeEach(async () => {
    rates = new Map();
    await cleanTables(db, [
      "custom_reports",
      "transaction_splits",
      "transactions",
      "accounts",
      "categories",
      "users",
    ]);
    for (const [code, name] of [
      ["CAD", "Canadian Dollar"],
      ["USD", "US Dollar"],
      ["EUR", "Euro"],
    ]) {
      await db.query(
        `INSERT INTO currencies (code, name, symbol, decimal_places)
         VALUES ($1, $2, '$', 2) ON CONFLICT DO NOTHING`,
        [code, name],
      );
    }
    userId = (await createTestUserDirect(db)).id;
    await setReporting("CAD");
    const account = async (name: string, currencyCode: string) =>
      (await createTestAccount(db, userId, { name, currencyCode })).id;
    chequing = await account("Chequing", "CAD");
    hisa = await account("HISA", "CAD");
    brokerage = await account("Brokerage", "USD");
    const category = async (name: string, type: string) =>
      (
        await db.query(
          `INSERT INTO categories (user_id, name, category_type)
           VALUES ($1, $2, $3) RETURNING id`,
          [userId, name, type],
        )
      )[0].id as string;
    savingsCat = await category("Savings contributions", "transfer");
    investmentCat = await category("Investment contributions", "transfer");
    groceriesCat = await category("Groceries", "expense");

    // Section 8.3's transfers, and a purchase no measure reads.
    await transfer(chequing, -500, "CAD", hisa, 500, "CAD", savingsCat);
    await transfer(hisa, -200, "CAD", chequing, 200, "CAD", savingsCat);
    await transfer(
      chequing,
      -1370,
      "CAD",
      brokerage,
      1000,
      "USD",
      investmentCat,
    );
    await transfer(chequing, -100, "CAD", hisa, 100, "CAD", null);
    await row({
      accountId: chequing,
      amount: -45,
      currencyCode: "CAD",
      categoryId: groceriesCat,
    });
  });

  const row = (overrides: Partial<Transaction>) =>
    db.manager.save(
      db.manager.create(Transaction, {
        userId,
        transactionDate: "2026-03-10",
        status: TransactionStatus.UNRECONCILED,
        isSplit: false,
        isTransfer: false,
        ...overrides,
      } as Partial<Transaction>),
    );

  /** Two linked legs, each holding the transfer's category. */
  async function transfer(
    from: string,
    fromAmount: number,
    fromCurrency: string,
    to: string,
    toAmount: number,
    toCurrency: string,
    categoryId: string | null,
  ) {
    const out = await row({
      accountId: from,
      amount: fromAmount,
      currencyCode: fromCurrency,
      isTransfer: true,
      categoryId,
    });
    const into = await row({
      accountId: to,
      amount: toAmount,
      currencyCode: toCurrency,
      isTransfer: true,
      categoryId,
      linkedTransactionId: out.id,
    });
    await db.query(
      `UPDATE transactions SET linked_transaction_id = $2 WHERE id = $1`,
      [out.id, into.id],
    );
  }

  async function run(options: {
    measure?: TransferMeasure;
    accountIds?: string[];
    metric?: MetricType;
    groupBy?: GroupByType;
  }) {
    const report = await db.manager.save(
      db.manager.create(CustomReport, {
        userId,
        name: "Transfers",
        viewType: ReportViewType.TABLE,
        timeframeType: TimeframeType.CUSTOM,
        groupBy: options.groupBy ?? GroupByType.CATEGORY,
        filters: options.accountIds ? { accountIds: options.accountIds } : {},
        config: {
          metric: options.metric ?? MetricType.TOTAL_AMOUNT,
          includeTransfers: false,
          direction: DirectionFilter.EXPENSES_ONLY,
          customStartDate: "2026-03-01",
          customEndDate: "2026-03-31",
          ...(options.measure ? { transferMeasure: options.measure } : {}),
        },
      } as Partial<CustomReport>),
    );
    return withUserContext(userId, () => reports.execute(userId, report.id));
  }

  const byLabel = (result: Awaited<ReturnType<typeof run>>) =>
    Object.fromEntries(result.data.map((p) => [p.label, p.value]));

  it.each([
    [TransferMeasure.OUTGOING, undefined, [700, 1370, 100]],
    [TransferMeasure.INCOMING, undefined, [700, 1370, 100]],
    [TransferMeasure.NET, undefined, [0, 0, 0]],
    [TransferMeasure.OUTGOING, "chequing", [500, 1370, 100]],
    [TransferMeasure.INCOMING, "chequing", [200, undefined, undefined]],
    [TransferMeasure.NET, "chequing", [-300, -1370, -100]],
    [TransferMeasure.INCOMING, "brokerage", [undefined, 1370, undefined]],
    [TransferMeasure.NET, "brokerage", [undefined, 1370, undefined]],
  ] as const)(
    "reads section 8.3: %s over %s",
    async (measure, scope, [savings, investment, none]) => {
      const accountIds =
        scope === "chequing"
          ? [chequing]
          : scope === "brokerage"
            ? [brokerage]
            : undefined;
      const result = await run({ measure, accountIds });
      const figures = byLabel(result);
      expect(figures["Savings contributions"]).toBe(savings);
      expect(figures["Investment contributions"]).toBe(investment);
      expect(figures["No category"]).toBe(none);
      // Never the purchase, and no ordinary "Uncategorized".
      expect(figures.Groceries).toBeUndefined();
      expect(figures.Uncategorized).toBeUndefined();
      expect(result.summary.total).not.toBeNull();
    },
  );

  it("counts the legs a measure reads and averages over them", async () => {
    const count = byLabel(
      await run({
        measure: TransferMeasure.OUTGOING,
        metric: MetricType.COUNT,
      }),
    );
    expect(count["Savings contributions"]).toBe(2);
    const average = byLabel(
      await run({
        measure: TransferMeasure.OUTGOING,
        metric: MetricType.AVERAGE,
      }),
    );
    expect(average["Savings contributions"]).toBe(350);
  });

  it("refuses a budget variance under a measure", async () => {
    await expect(
      run({
        measure: TransferMeasure.NET,
        metric: MetricType.BUDGET_VARIANCE,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("leaves a saved report without a measure as it was", async () => {
    const result = await run({});
    // The stored Expenses Only report reads as Both + Expense, signed
    // (section 5): the purchase, no transfer.
    expect(byLabel(result)).toEqual({ Groceries: -45 });
  });

  describe("reported in EUR, section 8.3 and the missing rate of section 10", () => {
    beforeEach(async () => {
      await setReporting("EUR");
    });

    it("converts each leg at the market rate on its date", async () => {
      rates.set("CAD->EUR", [{ date: "2026-03-10", rate: 0.67 }]);
      rates.set("USD->EUR", [{ date: "2026-03-10", rate: 0.92 }]);
      const outgoing = byLabel(
        await run({ measure: TransferMeasure.OUTGOING }),
      );
      const incoming = byLabel(
        await run({ measure: TransferMeasure.INCOMING }),
      );
      const net = byLabel(await run({ measure: TransferMeasure.NET }));
      expect(outgoing["Investment contributions"]).toBe(917.9);
      expect(incoming["Investment contributions"]).toBe(920);
      expect(net["Investment contributions"]).toBe(2.1);
      const chequingNet = byLabel(
        await run({ measure: TransferMeasure.NET, accountIds: [chequing] }),
      );
      expect(chequingNet["Investment contributions"]).toBe(-917.9);
    });

    it("withholds what cannot convert and names the known part", async () => {
      rates.set("CAD->EUR", [{ date: "2026-03-10", rate: 0.67 }]);
      const point = async (measure: TransferMeasure) => {
        const result = await run({ measure });
        return {
          result,
          point: result.data.find(
            (p) => p.label === "Investment contributions",
          ),
        };
      };
      const outgoing = await point(TransferMeasure.OUTGOING);
      expect(outgoing.point).toMatchObject({ value: 917.9 });
      expect(outgoing.point?.incomplete).toBeUndefined();

      const incoming = await point(TransferMeasure.INCOMING);
      expect(incoming.point).toMatchObject({ value: null, incomplete: true });
      expect(incoming.result.summary.total).toBeNull();
      expect(incoming.result.missingCurrencies).toEqual(["USD"]);

      const net = await point(TransferMeasure.NET);
      expect(net.point).toMatchObject({
        value: null,
        knownValue: -917.9,
        incomplete: true,
      });
      expect(net.result.summary.total).toBeNull();
    });

    it("keeps an ungrouped total none of whose legs converted, as unknown", async () => {
      rates.set("CAD->EUR", [{ date: "2026-03-10", rate: 0.67 }]);
      const result = await run({
        measure: TransferMeasure.INCOMING,
        accountIds: [brokerage],
        groupBy: GroupByType.NONE,
      });
      expect(result.data).toHaveLength(1);
      expect(result.data[0]).toMatchObject({
        label: "Total",
        value: null,
        incomplete: true,
      });
      // Nothing converted, so no known part is named, not a known 0.
      expect(result.data[0].knownValue).toBeUndefined();
      expect(result.summary.total).toBeNull();
      expect(result.missingCurrencies).toEqual(["USD"]);
    });
  });
});
