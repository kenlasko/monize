import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { TransactionsModule } from "@/transactions/transactions.module";
import {
  Transaction,
  TransactionStatus,
} from "@/transactions/entities/transaction.entity";
import { CurrencyDetailService } from "@/currencies/currency-detail.service";
import { buildRateIndex } from "@/common/time-series/rate-index.util";
import { withScopedDb } from "@/common/db/scoped-db";
import { withUserContext } from "@/common/db/with-context";
import { addDaysYMD, todayYMD } from "@/common/date-utils";
import {
  cleanTables,
  createIntegrationModule,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { createTestAccount } from "../helpers/test-factories";

/**
 * The currency detail page's figures against real PostgreSQL (issue #2243).
 *
 * The reader reports in CAD and looks at EUR; the market says 1 EUR = 1.60 CAD
 * from day 9, stored in the canonical CAD->EUR orientation as 0.625. The rows:
 *
 *   day 10  EUR 100 spent, no rate of its own: 100 * 1.60       CAD 160
 *   day 12  EUR 100 paid from the CAD account at its own 1.50   CAD 150
 *   day 15  EUR 200 transferred, arriving as CAD 290            CAD 290
 *   day 18  EUR 50 received, VOID: not counted
 *   day 20  EUR 40 paid as CAD 64 at its own 0.625 EUR per CAD  CAD  64
 *   day 21  another reader's EUR 999: not counted
 *
 * Four transactions, EUR 440 and CAD 664 gross. Each wrong reader reads a
 * figure of its own: the market rate for every row gives CAD 704; counting
 * the VOID row gives five; netting the signs gives EUR -440 + 0 = -440.
 */
describe("currency detail (integration)", () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let service: CurrencyDetailService;
  let userId: string;

  const today = todayYMD();
  const [year, month] = today.split("-").map(Number);
  const START = new Date(Date.UTC(year, month - 2, 1))
    .toISOString()
    .slice(0, 10);
  const day = (n: number) => addDaysYMD(START, n - 1);

  beforeAll(async () => {
    module = await createIntegrationModule([TransactionsModule]);
    dataSource = module.get(DataSource);
    service = new CurrencyDetailService(dataSource, {
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
  });

  afterAll(async () => {
    await module.close();
  });

  const save = (row: Partial<Transaction>) =>
    dataSource.manager.save(
      dataSource.manager.create(Transaction, {
        status: TransactionStatus.UNRECONCILED,
        isTransfer: false,
        isSplit: false,
        ...row,
      } as Partial<Transaction>),
    );

  beforeEach(async () => {
    await cleanTables(dataSource, [
      "exchange_rates",
      "transaction_splits",
      "transactions",
      "accounts",
      "user_preferences",
      "users",
    ]);
    await dataSource.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places) VALUES
         ('EUR', 'Euro', 'E', 2),
         ('CAD', 'Canadian Dollar', '$', 2)
       ON CONFLICT DO NOTHING`,
    );
    userId = (await createTestUserDirect(dataSource)).id;
    const otherId = (
      await createTestUserDirect(dataSource, { email: "other@example.com" })
    ).id;
    for (const id of [userId, otherId]) {
      await dataSource.query(
        `INSERT INTO user_preferences (user_id, default_currency) VALUES ($1, 'CAD')`,
        [id],
      );
    }
    const euro = await createTestAccount(dataSource, userId, {
      name: "Euro Chequing",
      currencyCode: "EUR",
    });
    const cad = await createTestAccount(dataSource, userId, {
      name: "CAD Chequing",
      currencyCode: "CAD",
    });
    const othersEuro = await createTestAccount(dataSource, otherId, {
      name: "Other Euro",
      currencyCode: "EUR",
    });

    await save({
      userId,
      accountId: euro.id,
      amount: -100,
      currencyCode: "EUR",
      transactionDate: day(10),
      payeeName: "Market",
    });
    await save({
      userId,
      accountId: cad.id,
      amount: -150,
      currencyCode: "CAD",
      originalCurrencyCode: "EUR",
      originalAmount: -100,
      exchangeRate: 1.5,
      transactionDate: day(12),
      payeeName: "Hotel",
    });
    const out = await save({
      userId,
      accountId: euro.id,
      amount: -200,
      currencyCode: "EUR",
      isTransfer: true,
      transactionDate: day(15),
    });
    const arrived = await save({
      userId,
      accountId: cad.id,
      amount: 290,
      currencyCode: "CAD",
      isTransfer: true,
      linkedTransactionId: out.id,
      transactionDate: day(15),
    });
    await dataSource.query(
      `UPDATE transactions SET linked_transaction_id = $1 WHERE id = $2`,
      [arrived.id, out.id],
    );
    await save({
      userId,
      accountId: euro.id,
      amount: 50,
      currencyCode: "EUR",
      status: TransactionStatus.VOID,
      transactionDate: day(18),
    });
    await save({
      userId,
      accountId: euro.id,
      amount: -40,
      currencyCode: "EUR",
      originalCurrencyCode: "CAD",
      originalAmount: -64,
      exchangeRate: 0.625,
      transactionDate: day(20),
      payeeName: "Toronto Shop",
    });
    await save({
      userId: otherId,
      accountId: othersEuro.id,
      amount: -999,
      currencyCode: "EUR",
      transactionDate: day(21),
    });

    await dataSource.query(
      `INSERT INTO exchange_rates (from_currency, to_currency, rate_date, rate, source)
       VALUES ('CAD', 'EUR', $1::DATE, 0.625, 'frankfurter')`,
      [day(9)],
    );
  });

  const asUser = <T>(fn: () => Promise<T>): Promise<T> =>
    withUserContext(userId, fn);

  it("counts and totals the reader's own transactions in the currency, each at its own rate", async () => {
    const summary = await asUser(() => service.getUsageSummary(userId, "EUR"));

    expect(summary).toEqual({
      code: "EUR",
      reportingCurrency: "CAD",
      transactionCount: 4,
      firstTransactionDate: day(10),
      lastTransactionDate: day(20),
      totalInCurrency: 440,
      totalInReportingCurrency: 664,
      knownReportingSubtotal: 664,
      unconvertedCount: 0,
      missingPairs: [],
    });
  });

  it("totals the reporting currency's own page without a rate", async () => {
    const summary = await asUser(() => service.getUsageSummary(userId, "CAD"));

    // The CAD payment of EUR, the transfer's CAD leg, and the EUR account's
    // payment made in CAD (CAD 64 as typed).
    expect(summary.transactionCount).toBe(3);
    expect(summary.totalInCurrency).toBe(150 + 290 + 64);
    expect(summary.totalInReportingCurrency).toBe(150 + 290 + 64);
  });

  it("lists the rates the reader's own transactions settled at, newest first", async () => {
    const list = await asUser(() => service.getTransactionRates(userId, "EUR"));

    expect(list.rates).toEqual([
      expect.objectContaining({
        rateDate: day(20),
        rate: 1.6,
        kind: "foreignEntry",
        accountName: "Euro Chequing",
        payeeName: "Toronto Shop",
      }),
      expect.objectContaining({
        rateDate: day(15),
        rate: 1.45,
        kind: "transfer",
        accountName: "Euro Chequing",
      }),
      expect.objectContaining({
        rateDate: day(12),
        rate: 1.5,
        kind: "foreignEntry",
        accountName: "CAD Chequing",
        payeeName: "Hotel",
      }),
    ]);
    expect(list.truncated).toBe(false);
  });
});
