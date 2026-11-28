import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
// Import order matters: see the note at the top of
// holding-concurrent-trades.integration.spec.ts. InvestmentTransactionsService
// first, HoldingsService last.
import { InvestmentTransactionsService } from "@/securities/investment-transactions.service";
import { SecuritiesModule } from "@/securities/securities.module";
import { SecuritiesService } from "@/securities/securities.service";
import {
  ActionHistoryService,
  settlePendingHistoryWrites,
} from "@/action-history/action-history.service";
import {
  Account,
  AccountSubType,
  AccountType,
} from "@/accounts/entities/account.entity";
import { InvestmentAction } from "@/securities/entities/investment-transaction.entity";
import { withUserContext } from "@/common/db/with-context";
import {
  createIntegrationModule,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { createTestAccount } from "../helpers/test-factories";

describe("undo of an investment create honours the reconciled lock (integration, audit #2365)", () => {
  let module: TestingModule;
  let investments: InvestmentTransactionsService;
  let history: ActionHistoryService;
  let dataSource: DataSource;
  let userId: string;
  let brokerageAccountId: string;
  let fundingAccountId: string;
  let securityId: string;

  beforeAll(async () => {
    module = await createIntegrationModule([SecuritiesModule]);
    investments = module.get(InvestmentTransactionsService);
    history = module.get(ActionHistoryService, { strict: false });
    dataSource = module.get(DataSource);
  });

  afterAll(async () => {
    await settlePendingHistoryWrites();
    await module.close();
  });

  beforeAll(async () => {
    // The synchronize-built schema has NO ACTION here; database/schema.sql has
    // ON DELETE SET NULL, which the undo's delete of the cash row relies on.
    await dataSource.query(
      'ALTER TABLE investment_transactions DROP CONSTRAINT "FK_73200e77d5b658b4e0c6b379dd9", ADD FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE SET NULL',
    );
  });

  beforeEach(async () => {
    await settlePendingHistoryWrites();
    await cleanTables(dataSource, [
      "action_history",
      "holdings",
      "securities",
      "transaction_splits",
      "transactions",
      "accounts",
      "categories",
      "payees",
      "scheduled_transaction_splits",
      "scheduled_transaction_overrides",
      "scheduled_transactions",
      "investment_transactions",
      "monthly_account_balances",
      "users",
    ]);
    await dataSource.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places)
       VALUES ('USD', 'US Dollar', '$', 2) ON CONFLICT DO NOTHING`,
    );

    const user = await createTestUserDirect(dataSource);
    userId = user.id;

    const brokerage = await createTestAccount(dataSource, userId, {
      name: "Brokerage",
      openingBalance: 0,
      currentBalance: 0,
    });
    await dataSource.manager.update(Account, brokerage.id, {
      accountType: AccountType.INVESTMENT,
      accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
    });
    brokerageAccountId = brokerage.id;

    const funding = await createTestAccount(dataSource, userId, {
      name: "Funding",
      openingBalance: 100000,
      currentBalance: 100000,
    });
    fundingAccountId = funding.id;

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

  const trade = (
    action: InvestmentAction,
    quantity: number,
    price: number,
    date: string,
  ) =>
    withUserContext(userId, () =>
      investments.create(userId, {
        accountId: brokerageAccountId,
        action,
        transactionDate: date,
        securityId,
        fundingAccountId,
        quantity,
        price,
        commission: 0,
      } as any),
    );

  const buyAndReconcileCash = async (lockOn: boolean) => {
    await trade(InvestmentAction.BUY, 10, 100, "2026-01-10");
    await settlePendingHistoryWrites();
    await dataSource.query(
      `UPDATE transactions SET status = 'RECONCILED' WHERE account_id = $1`,
      [fundingAccountId],
    );
    await dataSource.query(
      `INSERT INTO user_preferences (user_id, lock_reconciled_transactions)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET lock_reconciled_transactions = $2`,
      [userId, lockOn],
    );
  };

  const cashCount = async (): Promise<number> =>
    (
      await dataSource.query(
        `SELECT id FROM transactions WHERE account_id = $1`,
        [fundingAccountId],
      )
    ).length;

  it("refuses the undo of a BUY whose cash row was reconciled, deleting nothing", async () => {
    await buyAndReconcileCash(true);

    await expect(
      withUserContext(userId, () => history.undo(userId)),
    ).rejects.toMatchObject({ status: 409 });

    expect(await cashCount()).toBe(1);
    const inv = await dataSource.query(
      `SELECT id FROM investment_transactions WHERE account_id = $1`,
      [brokerageAccountId],
    );
    expect(inv).toHaveLength(1);
  });

  it("undoes the same BUY when the lock is off", async () => {
    await buyAndReconcileCash(false);

    await withUserContext(userId, () => history.undo(userId));

    expect(await cashCount()).toBe(0);
  });
});
