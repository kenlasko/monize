import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { TransactionsService } from "@/transactions/transactions.service";
import { TransactionsModule } from "@/transactions/transactions.module";
import {
  Transaction,
  TransactionStatus,
} from "@/transactions/entities/transaction.entity";
import { TransactionSplit } from "@/transactions/entities/transaction-split.entity";
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
 * getFxFeeSummary against a real PostgreSQL database. The unit suite mocks the
 * QueryBuilder, so only this test exercises the actual SQL: the folded-in fee
 * derivation (ROUND(originalAmount * exchangeRate, 2) - amount) for ordinary
 * foreign entries, the is_fx_fee split path for split transactions, the
 * per-currency monthly grouping, and the void/child exclusions.
 */
describe("TransactionsService.getFxFeeSummary (integration)", () => {
  let module: TestingModule;
  let service: TransactionsService;
  let dataSource: DataSource;
  let userId: string;
  let accountId: string;

  beforeAll(async () => {
    module = await createIntegrationModule([TransactionsModule]);
    service = module.get(TransactionsService);
    dataSource = module.get(DataSource);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanTables(dataSource, [
      "transaction_splits",
      "transactions",
      "accounts",
      "categories",
      "payees",
      "users",
    ]);
    const user = await createTestUserDirect(dataSource);
    userId = user.id;
    const account = await createTestAccount(dataSource, userId, {
      currencyCode: "CAD",
      openingBalance: 0,
      currentBalance: 0,
    });
    accountId = account.id;
  });

  async function insertTransaction(
    overrides: Partial<Transaction>,
  ): Promise<Transaction> {
    const tx = dataSource.manager.create(Transaction, {
      userId,
      accountId,
      transactionDate: "2026-07-21",
      amount: -50,
      currencyCode: "CAD",
      exchangeRate: 1,
      status: TransactionStatus.UNRECONCILED,
      isSplit: false,
      ...overrides,
    } as Partial<Transaction>);
    return dataSource.manager.save(tx);
  }

  it("recovers the fee folded into amount for an ordinary foreign entry", async () => {
    // The screenshot case: 100 EUR at 1.6020 with a 2.5% fee. base = 160.20,
    // fee = 4.01, amount = -164.21.
    await insertTransaction({
      amount: -164.21,
      currencyCode: "CAD",
      originalAmount: -100,
      originalCurrencyCode: "EUR",
      exchangeRate: 1.602,
    });

    const rows = await service.getFxFeeSummary(userId, accountId);

    expect(rows).toEqual([
      { month: "2026-07", currencyCode: "EUR", feeTotal: 4.01, count: 1 },
    ]);
  });

  it("returns a zero fee for a foreign entry recorded without a fee", async () => {
    await insertTransaction({
      amount: -160.2,
      currencyCode: "CAD",
      originalAmount: -100,
      originalCurrencyCode: "EUR",
      exchangeRate: 1.602,
    });

    const rows = await service.getFxFeeSummary(userId, accountId);

    expect(rows).toEqual([
      { month: "2026-07", currencyCode: "EUR", feeTotal: 0, count: 1 },
    ]);
  });

  it("groups by month and paid currency and sums fees within a group", async () => {
    await insertTransaction({
      transactionDate: "2026-07-05",
      amount: -164.21,
      originalAmount: -100,
      originalCurrencyCode: "EUR",
      exchangeRate: 1.602,
    });
    await insertTransaction({
      transactionDate: "2026-07-20",
      amount: -82.1,
      originalAmount: -50,
      originalCurrencyCode: "EUR",
      exchangeRate: 1.602,
    });
    await insertTransaction({
      transactionDate: "2026-08-01",
      amount: -137.5,
      originalAmount: -100,
      originalCurrencyCode: "USD",
      exchangeRate: 1.34,
    });

    const rows = await service.getFxFeeSummary(userId, accountId);

    // July EUR: fee 4.01 + fee (round(80.10)=80.10 - 82.10 = 2.00) = 6.01.
    // August USD: base 134.00 - 137.50 = 3.50.
    expect(rows).toEqual([
      { month: "2026-07", currencyCode: "EUR", feeTotal: 6.01, count: 2 },
      { month: "2026-08", currencyCode: "USD", feeTotal: 3.5, count: 1 },
    ]);
  });

  it("recovers the folded-in fee for a split foreign transaction", async () => {
    // A split foreign transaction folds the fee into the parent amount exactly
    // like an ordinary one; the category splits sum to that fee-inclusive total
    // (-101.19 + -63.02 = -164.21). base 160.20 - amount 164.21 = 4.01.
    const category = await createTestCategory(dataSource, userId);
    const parent = await insertTransaction({
      amount: -164.21,
      originalAmount: -100,
      originalCurrencyCode: "EUR",
      exchangeRate: 1.602,
      isSplit: true,
    });
    await dataSource.manager.save(
      dataSource.manager.create(TransactionSplit, {
        transactionId: parent.id,
        categoryId: category.id,
        amount: -101.19,
      } as Partial<TransactionSplit>),
    );
    await dataSource.manager.save(
      dataSource.manager.create(TransactionSplit, {
        transactionId: parent.id,
        categoryId: category.id,
        amount: -63.02,
      } as Partial<TransactionSplit>),
    );

    const rows = await service.getFxFeeSummary(userId, accountId);

    expect(rows).toEqual([
      { month: "2026-07", currencyCode: "EUR", feeTotal: 4.01, count: 1 },
    ]);
  });

  it("excludes void and domestic transactions", async () => {
    await insertTransaction({
      amount: -164.21,
      originalAmount: -100,
      originalCurrencyCode: "EUR",
      exchangeRate: 1.602,
      status: TransactionStatus.VOID,
    });
    await insertTransaction({ amount: -25, currencyCode: "CAD" });

    const rows = await service.getFxFeeSummary(userId, accountId);

    expect(rows).toEqual([]);
  });
});
