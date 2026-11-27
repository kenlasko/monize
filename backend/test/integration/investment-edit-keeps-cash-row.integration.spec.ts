import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
// Import order matters: see holding-concurrent-trades.integration.spec.ts.
import { InvestmentTransactionsService } from "@/securities/investment-transactions.service";
import { SecuritiesModule } from "@/securities/securities.module";
import { SecuritiesService } from "@/securities/securities.service";
import {
  Account,
  AccountSubType,
  AccountType,
} from "@/accounts/entities/account.entity";
import { InvestmentAction } from "@/securities/entities/investment-transaction.entity";
import {
  createIntegrationModule,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { withUserContext } from "@/common/db/with-context";
import { createTestAccount } from "../helpers/test-factories";

/**
 * #2370 -- an edit of an investment transaction keeps the identity of its
 * linked cash row: tags, attachments, links and reconciliation survive, and a
 * row that loses its cash side deletes the leg.
 */
describe("investment edit keeps the cash row (integration, #2370)", () => {
  let module: TestingModule;
  let investments: InvestmentTransactionsService;
  let dataSource: DataSource;
  let userId: string;
  let brokerageAccountId: string;
  let fundingAccountId: string;
  let securityId: string;
  let buyId: string;
  let cashId: string;
  let tagId: string;

  const OPENING_BALANCE = 100000;

  beforeAll(async () => {
    module = await createIntegrationModule([SecuritiesModule]);
    investments = module.get(InvestmentTransactionsService);
    dataSource = module.get(DataSource);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanTables(dataSource, [
      "action_history",
      "holdings",
      "securities",
      "transaction_tags",
      "tags",
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
      "user_preferences",
      "users",
    ]);
    await dataSource.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places)
       VALUES ('USD', 'US Dollar', '$', 2) ON CONFLICT DO NOTHING`,
    );

    userId = (await createTestUserDirect(dataSource)).id;

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

    fundingAccountId = (
      await createTestAccount(dataSource, userId, {
        name: "Funding",
        openingBalance: OPENING_BALANCE,
        currentBalance: OPENING_BALANCE,
      })
    ).id;

    securityId = (
      await withUserContext(userId, () =>
        module.get(SecuritiesService).create(userId, {
          symbol: "AAPL",
          name: "Apple Inc.",
          securityType: "STOCK" as any,
          currencyCode: "USD",
        } as any),
      )
    ).id;

    // BUY 10 @ 100.00: cash row of -1,000.00, balance 99,000.00.
    buyId = (
      await withUserContext(userId, () =>
        investments.create(userId, {
          accountId: brokerageAccountId,
          action: InvestmentAction.BUY,
          transactionDate: "2026-01-15",
          securityId,
          fundingAccountId,
          quantity: 10,
          price: 100,
          commission: 0,
        } as any),
      )
    ).id;
    const [inv] = await dataSource.query(
      `SELECT transaction_id FROM investment_transactions WHERE id = $1`,
      [buyId],
    );
    cashId = inv.transaction_id;

    const [tag] = await dataSource.query(
      `INSERT INTO tags (user_id, name) VALUES ($1, 'keep-me') RETURNING id`,
      [userId],
    );
    tagId = tag.id;
    await dataSource.query(
      `INSERT INTO transaction_tags (transaction_id, tag_id) VALUES ($1, $2)`,
      [cashId, tagId],
    );
    await dataSource.query(
      `UPDATE transactions SET status = 'RECONCILED' WHERE id = $1`,
      [cashId],
    );
  });

  const edit = (dto: Record<string, unknown>) =>
    withUserContext(userId, () =>
      investments.update(userId, buyId, dto as any),
    );

  const balance = async () => {
    const [row] = await dataSource.query(
      `SELECT current_balance FROM accounts WHERE id = $1`,
      [fundingAccountId],
    );
    return Number(row.current_balance);
  };

  const cashRows = () =>
    dataSource.query(
      `SELECT id, amount, status FROM transactions WHERE account_id = $1`,
      [fundingAccountId],
    );

  const tagCount = async () => {
    const [row] = await dataSource.query(
      `SELECT COUNT(*)::int AS n FROM transaction_tags WHERE transaction_id = $1`,
      [cashId],
    );
    return row.n as number;
  };

  it("a description-only edit keeps the row, its tag, RECONCILED status and the balance", async () => {
    const before = await balance();
    await edit({ description: "Renamed" });

    const rows = await cashRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(cashId);
    expect(rows[0].status).toBe("RECONCILED");
    expect(await tagCount()).toBe(1);
    expect(await balance()).toBe(before);
    const [inv] = await dataSource.query(
      `SELECT transaction_id FROM investment_transactions WHERE id = $1`,
      [buyId],
    );
    expect(inv.transaction_id).toBe(cashId);
  });

  it("a quantity change updates the same row and moves the balance by the difference", async () => {
    const before = await balance();
    await edit({ quantity: 12 });

    const rows = await cashRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(cashId);
    expect(Number(rows[0].amount)).toBe(-1200);
    expect(await tagCount()).toBe(1);
    expect(await balance()).toBe(before - 200);
    const [inv] = await dataSource.query(
      `SELECT status FROM investment_transactions WHERE id = $1`,
      [buyId],
    );
    expect(rows[0].status).toBe(inv.status);
  });

  it("an action that has no cash side deletes the cash row and restores the balance", async () => {
    await edit({ action: InvestmentAction.ADD_SHARES });

    expect(await cashRows()).toHaveLength(0);
    expect(await balance()).toBe(OPENING_BALANCE);
    const [inv] = await dataSource.query(
      `SELECT transaction_id FROM investment_transactions WHERE id = $1`,
      [buyId],
    );
    expect(inv.transaction_id).toBeNull();
  });

  it("refuses a quantity change on a reconciled cash row under the strict lock, writing nothing", async () => {
    await dataSource.query(
      `INSERT INTO user_preferences (user_id, lock_reconciled_transactions)
       VALUES ($1, true)
       ON CONFLICT (user_id) DO UPDATE SET lock_reconciled_transactions = true`,
      [userId],
    );

    await expect(edit({ quantity: 12 })).rejects.toMatchObject({
      status: 409,
    });

    const rows = await cashRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(cashId);
    expect(Number(rows[0].amount)).toBe(-1000);
    expect(rows[0].status).toBe("RECONCILED");
    expect(await balance()).toBe(OPENING_BALANCE - 1000);
    const [inv] = await dataSource.query(
      `SELECT quantity FROM investment_transactions WHERE id = $1`,
      [buyId],
    );
    expect(Number(inv.quantity)).toBe(10);
  });
});
