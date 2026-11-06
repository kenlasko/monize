import { BadRequestException } from "@nestjs/common";
import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { AccountsModule } from "@/accounts/accounts.module";
import { AccountsService } from "@/accounts/accounts.service";
import { AccountType } from "@/accounts/entities/account.entity";
import { withUserContext } from "@/common/db/with-context";
import {
  cleanTables,
  createIntegrationModule,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { createTestAccount } from "../helpers/test-factories";

/**
 * Issue #2028: an account with no transactions was deletable, and the schema
 * took the schedules naming it with it -- every schedule paid from it (account
 * ON DELETE CASCADE), another schedule's split line transferring into it
 * (ON DELETE CASCADE), and a scheduled transfer into it lost its destination
 * (ON DELETE SET NULL) and posted from then on as a plain transaction. The
 * delete now refuses, and the list and can-delete answers say so first.
 */
describe("Account delete refuses an account a schedule names (integration)", () => {
  jest.setTimeout(60000);

  let module: TestingModule;
  let db: DataSource;
  let accounts: AccountsService;
  let userId: string;
  let a: string;
  let b: string;

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
      "scheduled_transaction_splits",
      "scheduled_transactions",
      "transactions",
      "accounts",
      "users",
    ]);
    userId = (await createTestUserDirect(db)).id;
    a = (await createTestAccount(db, userId, { name: "A" })).id;
    b = (await createTestAccount(db, userId, { name: "B" })).id;
  });

  const insertSchedule = async (
    accountId: string,
    columns: Record<string, unknown> = {},
  ): Promise<string> => {
    const extra = Object.keys(columns);
    const [{ id }] = await db.query(
      `INSERT INTO scheduled_transactions (user_id, account_id, name, amount,
         currency_code, frequency, next_due_date, start_date
         ${extra.map((c) => `, ${c}`).join("")})
       VALUES ($1, $2, 'Schedule', -500, 'USD', 'MONTHLY', '2026-12-01',
               '2026-12-01' ${extra.map((_c, i) => `, $${i + 3}`).join("")})
       RETURNING id`,
      [userId, accountId, ...Object.values(columns)],
    );
    return id;
  };

  const expectRefused = async (accountId: string) => {
    const deletion = withUserContext(userId, () =>
      accounts.delete(userId, accountId),
    );
    await expect(deletion).rejects.toBeInstanceOf(BadRequestException);
    await expect(deletion).rejects.toThrow(/scheduled transaction/);
    const [{ n }] = await db.query(
      `SELECT count(*)::int AS n FROM accounts WHERE id = $1`,
      [accountId],
    );
    expect(n).toBe(1);
  };

  const canDelete = async (accountId: string) =>
    (
      await withUserContext(userId, () =>
        accounts.getTransactionCount(userId, accountId),
      )
    ).canDelete;

  it("refuses an account a schedule is paid from, and keeps the schedule", async () => {
    const rent = await insertSchedule(b);

    expect(await canDelete(b)).toBe(false);
    await expectRefused(b);

    const [{ n }] = await db.query(
      `SELECT count(*)::int AS n FROM scheduled_transactions WHERE id = $1`,
      [rent],
    );
    expect(n).toBe(1);
  });

  it("refuses an account another schedule's split line transfers into, and keeps the line", async () => {
    const schedule = await insertSchedule(a, { is_split: true });
    await db.query(
      `INSERT INTO scheduled_transaction_splits
         (scheduled_transaction_id, kind, transfer_account_id, amount)
       VALUES ($1, 'transfer', $2, -200), ($1, 'category', NULL, -300)`,
      [schedule, b],
    );

    const listed = await withUserContext(userId, () =>
      accounts.findAll(userId),
    );
    expect(listed.find((x) => x.id === b)?.canDelete).toBe(false);
    await expectRefused(b);

    const [{ n }] = await db.query(
      `SELECT count(*)::int AS n FROM scheduled_transaction_splits
       WHERE scheduled_transaction_id = $1`,
      [schedule],
    );
    expect(n).toBe(2);
  });

  it("refuses an account a scheduled transfer goes into, and keeps its destination", async () => {
    const transfer = await insertSchedule(a, {
      is_transfer: true,
      transfer_account_id: b,
    });

    expect(await canDelete(b)).toBe(false);
    await expectRefused(b);

    const [row] = await db.query(
      `SELECT transfer_account_id FROM scheduled_transactions WHERE id = $1`,
      [transfer],
    );
    expect(row.transfer_account_id).toBe(b);
  });

  it("refuses an account a scheduled investment is funded from", async () => {
    await insertSchedule(a, { investment_funding_account_id: b });

    expect(await canDelete(b)).toBe(false);
    await expectRefused(b);
  });

  it("leaves a loan's own payment schedule out of the count, and nothing else", async () => {
    const loan = (
      await createTestAccount(db, userId, {
        name: "Car loan",
        accountType: AccountType.LOAN,
      })
    ).id;
    const payment = await insertSchedule(a, {
      is_transfer: true,
      transfer_account_id: loan,
    });
    await db.query(
      `UPDATE accounts SET scheduled_transaction_id = $1 WHERE id = $2`,
      [payment, loan],
    );

    // The delete removes the loan's own schedule with it; A, which pays it,
    // still has it to lose. (The delete itself is not driven here: this
    // suite's schema comes from the entities, whose
    // accounts.scheduled_transaction_id lacks schema.sql's ON DELETE SET NULL.)
    expect(await canDelete(loan)).toBe(true);
    expect(await canDelete(a)).toBe(false);

    // An extra payment scheduled into the loan is not the loan's own.
    await insertSchedule(a, { is_transfer: true, transfer_account_id: loan });
    expect(await canDelete(loan)).toBe(false);
    await expectRefused(loan);
  });

  it("still deletes an account no schedule names", async () => {
    await insertSchedule(a);

    expect(await canDelete(b)).toBe(true);
    await withUserContext(userId, () => accounts.delete(userId, b));

    const [{ n }] = await db.query(
      `SELECT count(*)::int AS n FROM accounts WHERE id = $1`,
      [b],
    );
    expect(n).toBe(0);
  });
});
