import { ConflictException } from "@nestjs/common";
import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { AccountsModule } from "@/accounts/accounts.module";
import { AccountsService } from "@/accounts/accounts.service";
import { withUserContext } from "@/common/db/with-context";
import {
  cleanTables,
  createIntegrationModule,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { createTestAccount } from "../helpers/test-factories";
import { raceTwo } from "../helpers/race";

/**
 * A26-M19 (A26-S10-03): deleting an account counted its transactions in one
 * transaction and removed it in another, so a bank sync or import that wrote
 * into the account in between had its rows cascaded away with it, and their
 * transfer legs in other accounts were left one-sided.
 *
 * Connection 1 (the gate) is the writer: it holds the account's row lock and
 * inserts a row, as the sync writer does. Connection 2 is the delete. Once the
 * delete is parked on that lock the writer commits; the delete must then see
 * the row and refuse.
 */
describe("Account delete checks and deletes under one lock (integration)", () => {
  jest.setTimeout(60000);

  let module: TestingModule;
  let db: DataSource;
  let accounts: AccountsService;
  let userId: string;
  let accountId: string;

  beforeAll(async () => {
    module = await createIntegrationModule([AccountsModule]);
    db = module.get(DataSource);
    accounts = module.get(AccountsService);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanTables(db, [
      "action_history",
      "transactions",
      "accounts",
      "users",
    ]);
    userId = (await createTestUserDirect(db)).id;
    accountId = (
      await createTestAccount(db, userId, {
        name: "Linked chequing",
        openingBalance: 0,
        currentBalance: 0,
      })
    ).id;
  });

  it("refuses a delete when a writer committed a row while it waited, and keeps the row", async () => {
    const outcome = await raceTwo(
      db,
      () => withUserContext(userId, () => accounts.delete(userId, accountId)),
      async () => undefined,
      {
        gate: {
          sql: `SELECT id FROM accounts WHERE id = '${accountId}' FOR UPDATE;
                INSERT INTO transactions (user_id, account_id, transaction_date,
                                          amount, currency_code, status)
                VALUES ('${userId}', '${accountId}', CURRENT_DATE, -20, 'USD',
                        'UNRECONCILED')`,
          parked: 1,
        },
      },
    );

    expect(outcome.a.status).toBe("rejected");
    expect(String((outcome.a as PromiseRejectedResult).reason)).toMatch(
      /transaction/i,
    );
    expect((outcome.a as PromiseRejectedResult).reason).toBeInstanceOf(
      ConflictException,
    );
    const [{ n }] = await db.query(
      `SELECT count(*)::int AS n FROM transactions WHERE account_id = $1`,
      [accountId],
    );
    expect(n).toBe(1);
    const [{ a }] = await db.query(
      `SELECT count(*)::int AS a FROM accounts WHERE id = $1`,
      [accountId],
    );
    expect(a).toBe(1);
  });

  it("still deletes an empty account", async () => {
    await withUserContext(userId, () => accounts.delete(userId, accountId));
    const [{ a }] = await db.query(
      `SELECT count(*)::int AS a FROM accounts WHERE id = $1`,
      [accountId],
    );
    expect(a).toBe(0);
  });
});
