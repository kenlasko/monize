import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { TransactionsModule } from "@/transactions/transactions.module";
import { TransactionsService } from "@/transactions/transactions.service";
import {
  Transaction,
  TransactionStatus,
} from "@/transactions/entities/transaction.entity";
import { withUserContext } from "@/common/db/with-context";
import { addDaysYMD, todayYMD } from "@/common/date-utils";
import {
  cleanTables,
  createIntegrationModule,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { createTestAccount } from "../helpers/test-factories";

/**
 * The all-accounts register stamps each row's factor into the reporting
 * currency, so the client totals a page that mixes currencies at each row's
 * own rate (INV-FX-002) or the market rate on its own date (INV-FX-001),
 * never at today's and never at face value (issue #2308).
 *
 * The reader reports in EUR; the market says 1 EUR = 1.20 USD from day 14 and
 * 1.10 from day 27. The rows and the factor each must carry:
 *
 *   day 10  EUR 50 spent                                    1
 *   day 15  USD 132 spent, no rate of its own: 1 / 1.20     0.8333...
 *   day 20  EUR 100 charged as USD 125 at its own 1.25      0.8
 *   day 22  USD 110 transferred, arrived as EUR 100         100 / 110
 *   day 24  JPY 1000 spent, no rate anywhere                null
 */
describe("register rows carry their reporting rate (integration)", () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let service: TransactionsService;
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
    service = module.get(TransactionsService);
  });

  afterAll(async () => {
    await module.close();
  });

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
         ('USD', 'US Dollar', '$', 2),
         ('JPY', 'Japanese Yen', 'Y', 0)
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
    const jpWallet = await createTestAccount(dataSource, userId, {
      name: "JP Wallet",
      currencyCode: "JPY",
    });

    const save = (row: Partial<Transaction>) =>
      dataSource.manager.save(
        dataSource.manager.create(Transaction, {
          userId,
          status: TransactionStatus.UNRECONCILED,
          isTransfer: false,
          isSplit: false,
          ...row,
        } as Partial<Transaction>),
      );
    await save({
      accountId: euChequing.id,
      amount: -50,
      currencyCode: "EUR",
      transactionDate: day(10),
      payeeName: "Cafe",
    });
    await save({
      accountId: usCard.id,
      amount: -132,
      currencyCode: "USD",
      transactionDate: day(15),
      payeeName: "Hotel",
    });
    await save({
      accountId: usCard.id,
      amount: -125,
      currencyCode: "USD",
      originalCurrencyCode: "EUR",
      originalAmount: -100,
      exchangeRate: 1.25,
      transactionDate: day(20),
      payeeName: "Rail",
    });
    const out = await save({
      accountId: usCard.id,
      amount: -110,
      currencyCode: "USD",
      transactionDate: day(22),
      isTransfer: true,
      payeeName: "Transfer",
    });
    const into = await save({
      accountId: euChequing.id,
      amount: 100,
      currencyCode: "EUR",
      transactionDate: day(22),
      isTransfer: true,
      linkedTransactionId: out.id,
      payeeName: "Transfer",
    });
    await dataSource.query(
      `UPDATE transactions SET linked_transaction_id = $2 WHERE id = $1`,
      [out.id, into.id],
    );
    await save({
      accountId: jpWallet.id,
      amount: -1000,
      currencyCode: "JPY",
      transactionDate: day(24),
      payeeName: "Ramen",
    });
    for (const [date, rate] of [
      [day(14), "1.2000000000"],
      [day(27), "1.1000000000"],
    ]) {
      await dataSource.query(
        `INSERT INTO exchange_rates (from_currency, to_currency, rate_date, rate, source)
         VALUES ('EUR', 'USD', $1::DATE, $2, 'test')`,
        [date, rate],
      );
    }
  });

  it("stamps each row's own, transfer or dated market factor, and null where none reaches", async () => {
    const page = await withUserContext(userId, () => service.findAll(userId));
    const byPayee = new Map(
      page.data.map((row) => [
        `${row.payeeName}:${row.currencyCode}`,
        row.reportingRate,
      ]),
    );

    expect(page.data.every((row) => row.reportingCurrencyCode === "EUR")).toBe(
      true,
    );
    expect(byPayee.get("Cafe:EUR")).toBe(1);
    expect(byPayee.get("Hotel:USD")).toBeCloseTo(1 / 1.2, 10);
    expect(byPayee.get("Rail:USD")).toBeCloseTo(0.8, 10);
    expect(byPayee.get("Transfer:USD")).toBeCloseTo(100 / 110, 10);
    expect(byPayee.get("Transfer:EUR")).toBe(1);
    expect(byPayee.get("Ramen:JPY")).toBeNull();
  });
});
