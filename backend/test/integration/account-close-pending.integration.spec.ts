import { BadRequestException } from "@nestjs/common";
import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { AccountsModule } from "@/accounts/accounts.module";
import { AccountsService } from "@/accounts/accounts.service";
import { Account } from "@/accounts/entities/account.entity";
import { withUserContext } from "@/common/db/with-context";
import {
  cleanTables,
  createIntegrationModule,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { createTestAccount } from "../helpers/test-factories";

/**
 * A26-M12 (A26-S07-06): an empty account (0.00) carrying a -25.00 row dated
 * in the future closed, and when the date arrived the due-balance pass
 * applied the row: `is_closed = true`, `current_balance = -25.00`, a balance
 * the user cannot touch without reopening. "Zero now" was checked; "zero
 * including what is already booked" was not.
 */
describe("Closing an account over a pending future-dated row (integration)", () => {
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
      "transaction_splits",
      "transactions",
      "accounts",
      "users",
    ]);
    userId = (await createTestUserDirect(db)).id;
    accountId = (
      await createTestAccount(db, userId, {
        name: "Empty",
        openingBalance: 0,
        currentBalance: 0,
      })
    ).id;
  });

  async function addRow(dateSql: string, status = "UNRECONCILED") {
    await db.query(
      `INSERT INTO transactions (user_id, account_id, transaction_date, amount,
                                 currency_code, status)
       VALUES ($1, $2, ${dateSql}, -25, 'USD', $3)`,
      [userId, accountId, status],
    );
  }

  const close = () =>
    withUserContext(userId, () => accounts.close(userId, accountId));
  const account = () => db.manager.findOneByOrFail(Account, { id: accountId });

  it("refuses the close while a non-VOID row is dated after today, writing nothing", async () => {
    await addRow("CURRENT_DATE + 10");

    await expect(close()).rejects.toBeInstanceOf(BadRequestException);
    expect((await account()).isClosed).toBe(false);

    // The row falls due: the balance moves on an open account, as it should.
    await db.query(
      `UPDATE transactions SET transaction_date = CURRENT_DATE WHERE account_id = $1`,
      [accountId],
    );
    await withUserContext(userId, () =>
      accounts.recalculateCurrentBalance(userId, accountId),
    );
    expect(Number((await account()).currentBalance)).toBe(-25);
    expect((await account()).isClosed).toBe(false);
  });

  it("closes over a non-zero balance and keeps it, refusing any later write to it", async () => {
    await db.query(
      `UPDATE accounts SET current_balance = 250, opening_balance = 250 WHERE id = $1`,
      [accountId],
    );

    await close();

    const closed = await account();
    expect(closed.isClosed).toBe(true);
    expect(Number(closed.currentBalance)).toBe(250);
    // Frozen: the balance write's own `is_closed = false` predicate refuses.
    await expect(
      withUserContext(userId, () => accounts.updateBalance(accountId, -25)),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(Number((await account()).currentBalance)).toBe(250);
  });

  it("still closes over a VOID future row, which moves nothing", async () => {
    await addRow("CURRENT_DATE + 10", "VOID");

    await close();

    expect((await account()).isClosed).toBe(true);
  });
});
