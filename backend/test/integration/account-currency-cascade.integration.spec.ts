import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { AccountsService } from "@/accounts/accounts.service";
import { AccountsModule } from "@/accounts/accounts.module";
import { TransactionsModule } from "@/transactions/transactions.module";
import { TransactionsService } from "@/transactions/transactions.service";
import { Transaction } from "@/transactions/entities/transaction.entity";
import { ScheduledTransaction } from "@/scheduled-transactions/entities/scheduled-transaction.entity";
import {
  createIntegrationModule,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { createTestAccount } from "../helpers/test-factories";

// Regression test for the bug where changing an account's currency left
// existing transactions and scheduled transactions stuck on the old code.
// The fix cascades the new currency to every row tied to the account in the
// same QueryRunner transaction.
describe("AccountsService.update currency cascade (integration)", () => {
  let module: TestingModule;
  let accountsService: AccountsService;
  let transactionsService: TransactionsService;
  let dataSource: DataSource;
  let userId: string;
  let accountId: string;

  beforeAll(async () => {
    module = await createIntegrationModule([
      AccountsModule,
      TransactionsModule,
    ]);
    accountsService = module.get(AccountsService);
    transactionsService = module.get(TransactionsService);
    dataSource = module.get(DataSource);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanTables(dataSource, [
      "action_history",
      "transaction_splits",
      "transactions",
      "scheduled_transaction_splits",
      "scheduled_transaction_overrides",
      "scheduled_transactions",
      "investment_transactions",
      "monthly_account_balances",
      "accounts",
      "categories",
      "payees",
      "users",
    ]);
    const user = await createTestUserDirect(dataSource);
    userId = user.id;
    const account = await createTestAccount(dataSource, userId, {
      currencyCode: "USD",
      openingBalance: 1000,
      currentBalance: 1000,
    });
    accountId = account.id;
  });

  it("updates every transaction on the account to the new currency", async () => {
    await transactionsService.create(userId, {
      accountId,
      transactionDate: "2026-01-15",
      amount: -50,
      currencyCode: "USD",
    });
    await transactionsService.create(userId, {
      accountId,
      transactionDate: "2026-01-20",
      amount: -25,
      currencyCode: "USD",
    });

    await accountsService.update(userId, accountId, { currencyCode: "CAD" });

    const rows = await dataSource.manager.find(Transaction, {
      where: { accountId, userId },
    });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.currencyCode === "CAD")).toBe(true);
  });

  it("leaves transactions on other accounts untouched", async () => {
    const otherAccount = await createTestAccount(dataSource, userId, {
      currencyCode: "USD",
      openingBalance: 0,
      currentBalance: 0,
    });
    await transactionsService.create(userId, {
      accountId,
      transactionDate: "2026-01-15",
      amount: -10,
      currencyCode: "USD",
    });
    await transactionsService.create(userId, {
      accountId: otherAccount.id,
      transactionDate: "2026-01-15",
      amount: -10,
      currencyCode: "USD",
    });

    await accountsService.update(userId, accountId, { currencyCode: "CAD" });

    const ours = await dataSource.manager.find(Transaction, {
      where: { accountId, userId },
    });
    const others = await dataSource.manager.find(Transaction, {
      where: { accountId: otherAccount.id, userId },
    });
    expect(ours.every((r) => r.currencyCode === "CAD")).toBe(true);
    expect(others.every((r) => r.currencyCode === "USD")).toBe(true);
  });

  it("cascades the new currency to scheduled transactions tied to the account", async () => {
    await dataSource.manager.save(
      dataSource.manager.create(ScheduledTransaction, {
        userId,
        accountId,
        name: "Monthly rent",
        amount: -1200,
        currencyCode: "USD",
        frequency: "MONTHLY",
        nextDueDate: "2026-02-01",
        startDate: "2026-01-01",
        isActive: true,
        autoPost: false,
      }),
    );

    await accountsService.update(userId, accountId, { currencyCode: "CAD" });

    const rows = await dataSource.manager.find(ScheduledTransaction, {
      where: { accountId, userId },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].currencyCode).toBe("CAD");
  });

  it("does not change anything when the currency is set to the same value", async () => {
    await transactionsService.create(userId, {
      accountId,
      transactionDate: "2026-01-15",
      amount: -50,
      currencyCode: "USD",
    });

    await accountsService.update(userId, accountId, { currencyCode: "USD" });

    const rows = await dataSource.manager.find(Transaction, {
      where: { accountId, userId },
    });
    expect(rows[0].currencyCode).toBe("USD");
  });
});
