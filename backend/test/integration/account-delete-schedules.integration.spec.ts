import { BadRequestException, NotFoundException } from "@nestjs/common";
import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { AccountsModule } from "@/accounts/accounts.module";
import { AccountsService } from "@/accounts/accounts.service";
import { AccountType } from "@/accounts/entities/account.entity";
import {
  ActionHistoryService,
  settlePendingHistoryWrites,
} from "@/action-history/action-history.service";
import { withUserContext } from "@/common/db/with-context";
import { ScheduledTransactionsService } from "@/scheduled-transactions/scheduled-transactions.service";
import {
  cleanTables,
  createIntegrationModule,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { createTestAccount } from "../helpers/test-factories";
import { holdLock, waitForLockWaiters } from "../helpers/race";

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
  let scheduled: ScheduledTransactionsService;
  let history: ActionHistoryService;
  let userId: string;
  let a: string;
  let b: string;

  beforeAll(async () => {
    module = await createIntegrationModule([AccountsModule]);
    db = module.get(DataSource);
    accounts = module.get(AccountsService);
    scheduled = module.get(ScheduledTransactionsService, { strict: false });
    history = module.get(ActionHistoryService, { strict: false });
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanTables(db, [
      "action_history",
      "scheduled_transaction_overrides",
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

  it("refuses an account a pending override's split line transfers into, and ignores a spent one", async () => {
    // insertSchedule's next_due_date is 2026-12-01.
    const schedule = await insertSchedule(a);
    const overrideInto = (originalDate: string) =>
      db.query(
        `INSERT INTO scheduled_transaction_overrides
           (scheduled_transaction_id, original_date, override_date, amount,
            is_split, splits)
         VALUES ($1, $2, $2, -500, true, $3::jsonb)`,
        [
          schedule,
          originalDate,
          JSON.stringify([
            {
              splitKind: "transfer",
              categoryId: null,
              transferAccountId: b,
              amount: -200,
            },
            { splitKind: "category", categoryId: null, amount: -300 },
          ]),
        ],
      );

    await overrideInto("2026-11-01");
    expect(await canDelete(b)).toBe(true);

    await overrideInto("2027-01-01");
    expect(await canDelete(b)).toBe(false);
    await expectRefused(b);
  });

  it("refuses an account a scheduled investment is funded from", async () => {
    await insertSchedule(a, { investment_funding_account_id: b });

    expect(await canDelete(b)).toBe(false);
    await expectRefused(b);
  });

  it("deletes a loan with only its own payment schedule, and that schedule with it", async () => {
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

    // A, which pays it, still has it to lose.
    expect(await canDelete(a)).toBe(false);
    expect(await canDelete(loan)).toBe(true);
    await withUserContext(userId, () => accounts.delete(userId, loan));

    const [{ n }] = await db.query(
      `SELECT count(*)::int AS n FROM accounts WHERE id = $1`,
      [loan],
    );
    expect(n).toBe(0);
    const [{ s }] = await db.query(
      `SELECT count(*)::int AS s FROM scheduled_transactions WHERE id = $1`,
      [payment],
    );
    expect(s).toBe(0);
  });

  it("undoes a loan's delete, restoring the loan and then its schedule", async () => {
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
    await withUserContext(userId, () => accounts.delete(userId, loan));

    const undo = async () => {
      await settlePendingHistoryWrites();
      return withUserContext(userId, () => history.undo(userId));
    };
    await undo();
    await undo();

    const [{ n }] = await db.query(
      `SELECT count(*)::int AS n FROM accounts WHERE id = $1`,
      [loan],
    );
    expect(n).toBe(1);
    const [row] = await db.query(
      `SELECT transfer_account_id FROM scheduled_transactions WHERE id = $1`,
      [payment],
    );
    expect(row?.transfer_account_id).toBe(loan);
  });

  it("refuses a loan another schedule pays into, and keeps the loan's own schedule", async () => {
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
    await insertSchedule(a, { is_transfer: true, transfer_account_id: loan });

    expect(await canDelete(loan)).toBe(false);
    await expectRefused(loan);

    // Refused before anything was written: the loan still has its schedule.
    const [row] = await db.query(
      `SELECT scheduled_transaction_id FROM accounts WHERE id = $1`,
      [loan],
    );
    expect(row.scheduled_transaction_id).toBe(payment);
    const [{ s }] = await db.query(
      `SELECT count(*)::int AS s FROM scheduled_transactions WHERE id = $1`,
      [payment],
    );
    expect(s).toBe(1);
  });

  it("matches an override's account id whatever its case, and ignores a non-split override's lines", async () => {
    const schedule = await insertSchedule(a);
    const override = (originalDate: string, isSplit: boolean, id: string) =>
      db.query(
        `INSERT INTO scheduled_transaction_overrides
           (scheduled_transaction_id, original_date, override_date, amount,
            is_split, splits)
         VALUES ($1, $2, $2, -500, $3, $4::jsonb)`,
        [
          schedule,
          originalDate,
          isSplit,
          JSON.stringify([
            { categoryId: null, transferAccountId: id, amount: -200 },
            { categoryId: null, amount: -300 },
          ]),
        ],
      );

    await override("2027-01-01", false, b);
    expect(await canDelete(b)).toBe(true);

    await override("2027-02-01", true, b.toUpperCase());
    expect(await canDelete(b)).toBe(false);
  });

  it("counts an override that follows its split schedule's own is_split", async () => {
    const schedule = await insertSchedule(a, { is_split: true });
    await db.query(
      `INSERT INTO scheduled_transaction_overrides
         (scheduled_transaction_id, original_date, override_date, amount,
          is_split, splits)
       VALUES ($1, '2027-01-01', '2027-01-01', -500, NULL, $2::jsonb)`,
      [
        schedule,
        JSON.stringify([
          { categoryId: null, transferAccountId: b, amount: -200 },
          { categoryId: null, amount: -300 },
        ]),
      ],
    );

    expect(await canDelete(b)).toBe(false);
    await expectRefused(b);
  });

  it("refuses an override line into an account a delete removed while it waited", async () => {
    const schedule = await insertSchedule(a);
    // The delete's own lock, then its removal, committed only on release.
    const deletion = await holdLock(
      db,
      `SELECT id FROM accounts WHERE id = '${b}' FOR UPDATE;
       DELETE FROM accounts WHERE id = '${b}'`,
    );
    const write = withUserContext(userId, () =>
      scheduled.createOverride(userId, schedule, {
        originalDate: "2027-01-01",
        overrideDate: "2027-01-01",
        amount: -500,
        isSplit: true,
        splits: [{ amount: -200, transferAccountId: b }, { amount: -300 }],
      }),
    );
    write.catch(() => undefined);
    try {
      await waitForLockWaiters(db, 1);
    } finally {
      await deletion.release();
    }

    await expect(write).rejects.toBeInstanceOf(NotFoundException);
    const [{ n }] = await db.query(
      `SELECT count(*)::int AS n FROM scheduled_transaction_overrides
       WHERE scheduled_transaction_id = $1`,
      [schedule],
    );
    expect(n).toBe(0);
  });

  it("refuses a delete when an override line into the account committed while it waited", async () => {
    const schedule = await insertSchedule(a);
    // An override writer's share lock on B, then its row, committed on release.
    const overrideWrite = await holdLock(
      db,
      `SELECT id FROM accounts WHERE id = '${b}' FOR SHARE;
       INSERT INTO scheduled_transaction_overrides
         (scheduled_transaction_id, original_date, override_date, amount,
          is_split, splits)
       VALUES ('${schedule}', '2027-01-01', '2027-01-01', -500, true,
               '[{"transferAccountId": "${b}", "amount": -500}]'::jsonb)`,
    );
    const deletion = withUserContext(userId, () => accounts.delete(userId, b));
    deletion.catch(() => undefined);
    try {
      await waitForLockWaiters(db, 1);
    } finally {
      await overrideWrite.release();
    }

    await expect(deletion).rejects.toBeInstanceOf(BadRequestException);
    const [{ n }] = await db.query(
      `SELECT count(*)::int AS n FROM accounts WHERE id = $1`,
      [b],
    );
    expect(n).toBe(1);
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
