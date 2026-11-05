import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { TransactionsService } from "@/transactions/transactions.service";
import { TransactionsModule } from "@/transactions/transactions.module";
import { Transaction } from "@/transactions/entities/transaction.entity";
import { Account } from "@/accounts/entities/account.entity";
import { withUserContext } from "@/common/db/with-context";
import { settlePendingHistoryWrites } from "@/action-history/action-history.service";
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
 * A cross-currency transfer line of a split posts what the user says arrived
 * (`transferTargetAmount`) at its implied rate, and both reads the transaction
 * form opens a split from -- `findOne` and the register's row query -- carry
 * that counterpart amount back, so an unedited re-save sends it again rather
 * than re-converting the line. No USD->EUR rate is stored here at all: a line
 * without a received amount would be refused, which is what proves the stated
 * figure, not a market rate, is what posted.
 */
describe("Split transfer received amount (integration)", () => {
  let module: TestingModule;
  let service: TransactionsService;
  let dataSource: DataSource;
  let userId: string;
  let usdId: string;
  let eurId: string;
  let categoryId: string;

  beforeAll(async () => {
    module = await createIntegrationModule([TransactionsModule]);
    service = module.get(TransactionsService);
    dataSource = module.get(DataSource);
  });

  afterAll(async () => {
    // An update records its undo entry without awaiting it; the last test's
    // must land before the connection closes.
    await settlePendingHistoryWrites();
    await module.close();
  });

  beforeEach(async () => {
    await cleanTables(dataSource, [
      "action_history",
      "transaction_splits",
      "transactions",
      "exchange_rates",
      "accounts",
      "categories",
      "payees",
      "monthly_account_balances",
      "users",
    ]);
    userId = (await createTestUserDirect(dataSource)).id;
    usdId = (
      await createTestAccount(dataSource, userId, {
        name: "Chequing",
        openingBalance: 1000,
        currentBalance: 1000,
      })
    ).id;
    eurId = (
      await createTestAccount(dataSource, userId, {
        name: "Euro Savings",
        currencyCode: "EUR",
        openingBalance: 0,
        currentBalance: 0,
      })
    ).id;
    categoryId = (
      await createTestCategory(dataSource, userId, { name: "Groceries" })
    ).id;
  });

  const splitsWith = (memo: string) => [
    { categoryId, amount: -60 },
    {
      transferAccountId: eurId,
      amount: -40,
      transferTargetAmount: 35.5,
      memo,
    },
  ];

  async function createSplit(): Promise<Transaction> {
    return withUserContext(userId, () =>
      service.create(userId, {
        accountId: usdId,
        transactionDate: "2026-01-15",
        amount: -100,
        currencyCode: "USD",
        splits: splitsWith("To Europe"),
      }),
    );
  }

  async function counterpart(): Promise<Transaction> {
    return dataSource.manager.findOneOrFail(Transaction, {
      where: { accountId: eurId },
    });
  }

  it("posts the stated received amount at its implied rate", async () => {
    await createSplit();

    const leg = await counterpart();
    expect(Number(leg.amount)).toBe(35.5);
    expect(leg.currencyCode).toBe("EUR");
    expect(Number(leg.exchangeRate)).toBe(0.8875);
    const eur = await dataSource.manager.findOneByOrFail(Account, {
      id: eurId,
    });
    expect(Number(eur.currentBalance)).toBe(35.5);
  });

  it("returns the received amount from findOne and from the register", async () => {
    const created = await createSplit();

    const one = await withUserContext(userId, () =>
      service.findOne(userId, created.id),
    );
    const transferLine = one.splits.find((s) => s.transferAccountId === eurId);
    expect(Number(transferLine?.linkedTransaction?.amount)).toBe(35.5);

    const page = await withUserContext(userId, () =>
      service.findAll(userId, [usdId]),
    );
    const row = page.data.find((tx) => tx.id === created.id);
    const registerLine = row?.splits?.find(
      (s) => s.transferAccountId === eurId,
    );
    expect(Number(registerLine?.linkedTransaction?.amount)).toBe(35.5);
    expect(registerLine?.linkedTransaction?.currencyCode).toBe("EUR");
  });

  it("keeps the received amount across a re-save that sends it back", async () => {
    const created = await createSplit();

    await withUserContext(userId, () =>
      service.update(userId, created.id, {
        splits: splitsWith("Renamed"),
      }),
    );

    const leg = await counterpart();
    expect(Number(leg.amount)).toBe(35.5);
    expect(Number(leg.exchangeRate)).toBe(0.8875);
    const eur = await dataSource.manager.findOneByOrFail(Account, {
      id: eurId,
    });
    expect(Number(eur.currentBalance)).toBe(35.5);
  });
});
