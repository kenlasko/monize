import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import {
  ActionHistoryService,
  settlePendingHistoryWrites,
} from "@/action-history/action-history.service";
import { withUserContext } from "@/common/db/with-context";
import { PayrollDeductionsModule } from "@/payroll-deductions/payroll-deductions.module";
import { PayrollDeductionsService } from "@/payroll-deductions/payroll-deductions.service";
import { ScheduledTransactionsModule } from "@/scheduled-transactions/scheduled-transactions.module";
import { ScheduledTransactionsService } from "@/scheduled-transactions/scheduled-transactions.service";
import {
  cleanTables,
  createIntegrationModule,
  createTestUserDirect,
} from "../helpers/integration-setup";
import {
  createTestAccount,
  createTestCategory,
} from "../helpers/test-factories";
import { holdLock, waitForLockWaiters } from "../helpers/race";

/**
 * The Custom frequency's pairing of `frequency` with `custom_recurrence`
 * (docs/specs/custom-recurrence.md sections 2 and 5) against real PostgreSQL:
 * an undo or redo writes the two back together, a schedule update decides the
 * pair from the row it locked, and a payroll rule write locks the bill before
 * reading its frequency. Each race is forced with a gate held on a third
 * connection (`docs/verification-contract.md` VER-002).
 */
describe("Custom recurrence pairing (integration)", () => {
  jest.setTimeout(60000);

  const MONDAYS = { unit: "WEEK", interval: 1, weekdays: [1], weekStartsOn: 1 };

  let module: TestingModule;
  let db: DataSource;
  let scheduled: ScheduledTransactionsService;
  let payroll: PayrollDeductionsService;
  let history: ActionHistoryService;
  let userId: string;
  let accountId: string;
  let categoryId: string;

  const asUser = <T>(fn: () => Promise<T>) => withUserContext(userId, fn);

  beforeAll(async () => {
    module = await createIntegrationModule([
      ScheduledTransactionsModule,
      PayrollDeductionsModule,
    ]);
    db = module.get(DataSource);
    scheduled = module.get(ScheduledTransactionsService);
    payroll = module.get(PayrollDeductionsService);
    history = module.get(ActionHistoryService, { strict: false });
  });

  afterAll(async () => {
    await module.close();
  });

  // A write's history entry is recorded after it returns; let it land before
  // the next test truncates, or the module closes, under it.
  afterEach(() => settlePendingHistoryWrites());

  beforeEach(async () => {
    await cleanTables(db, [
      "action_history",
      "payroll_deduction_rule_periods",
      "payroll_deduction_rules",
      "scheduled_transaction_overrides",
      "scheduled_transaction_splits",
      "scheduled_transactions",
      "transactions",
      "categories",
      "accounts",
      "users",
    ]);
    userId = (await createTestUserDirect(db)).id;
    accountId = (await createTestAccount(db, userId, { name: "Chequing" })).id;
    categoryId = (await createTestCategory(db, userId, { name: "Pension" })).id;
  });

  /** A monthly bill on the 15th, due 15 January 2030. */
  async function monthlyBill(): Promise<string> {
    const created = await asUser(() =>
      scheduled.create(userId, {
        accountId,
        name: "Payroll",
        amount: -100,
        currencyCode: "USD",
        frequency: "MONTHLY",
        startDate: "2030-01-15",
        nextDueDate: "2030-01-15",
      } as never),
    );
    return created.id;
  }

  async function pairOf(
    id: string,
  ): Promise<{ frequency: string; rule: unknown } | undefined> {
    const [row] = await db.query(
      `SELECT frequency, custom_recurrence AS rule
         FROM scheduled_transactions WHERE id = $1`,
      [id],
    );
    return row;
  }

  async function undo() {
    await settlePendingHistoryWrites();
    return asUser(() => history.undo(userId));
  }

  async function redo() {
    await settlePendingHistoryWrites();
    return asUser(() => history.redo(userId));
  }

  it("undo and redo write the frequency and its rule back as a pair", async () => {
    const id = await monthlyBill();
    await asUser(() =>
      scheduled.update(userId, id, {
        frequency: "CUSTOM",
        customRecurrence: MONDAYS,
      } as never),
    );
    expect(await pairOf(id)).toEqual({ frequency: "CUSTOM", rule: MONDAYS });

    await undo();
    expect(await pairOf(id)).toEqual({ frequency: "MONTHLY", rule: null });

    await redo();
    expect(await pairOf(id)).toEqual({ frequency: "CUSTOM", rule: MONDAYS });

    // The delete's undo reinserts the row with its rule.
    await asUser(() => scheduled.remove(userId, id));
    expect(await pairOf(id)).toBeUndefined();
    await undo();
    expect(await pairOf(id)).toEqual({ frequency: "CUSTOM", rule: MONDAYS });
  });

  it("an edit prepared against a stale row clears the rule a concurrent switch to CUSTOM stored", async () => {
    const id = await monthlyBill();
    // The concurrent switch, uncommitted while the edit reads the row and then
    // waits for the lock: the edit's first read sees MONTHLY, its locked read
    // CUSTOM with a rule.
    const gate = await holdLock(
      db,
      `UPDATE scheduled_transactions
          SET frequency = 'CUSTOM', custom_recurrence = $2::jsonb
        WHERE id = $1`,
      [id, JSON.stringify(MONDAYS)],
    );
    let settled = false;
    const edit = asUser(() =>
      scheduled.update(userId, id, {
        name: "Payroll (renamed)",
        frequency: "MONTHLY",
      } as never),
    ).finally(() => {
      settled = true;
    });
    edit.catch(() => undefined);
    try {
      await waitForLockWaiters(db, 1, { stop: () => settled });
    } finally {
      await gate.release();
    }
    await edit;

    expect(await pairOf(id)).toEqual({ frequency: "MONTHLY", rule: null });
  });

  it("a payroll rule and a concurrent switch of its bill to CUSTOM cannot both commit", async () => {
    const id = await monthlyBill();
    // A Friday override: orphaned by a Mondays-only rule, so the switch
    // deletes it -- after its payroll check, while it holds the bill's lock.
    const [{ id: overrideId }] = await db.query(
      `INSERT INTO scheduled_transaction_overrides
         (scheduled_transaction_id, original_date, override_date, amount)
       VALUES ($1, '2030-03-15', '2030-03-15', -100)
       RETURNING id`,
      [id],
    );
    const gate = await holdLock(
      db,
      `SELECT 1 FROM scheduled_transaction_overrides WHERE id = $1 FOR UPDATE`,
      [overrideId],
    );

    let switchSettled = false;
    const toCustom = asUser(() =>
      scheduled.update(userId, id, {
        frequency: "CUSTOM",
        customRecurrence: MONDAYS,
      } as never),
    ).finally(() => {
      switchSettled = true;
    });
    toCustom.catch(() => undefined);

    let ruleSettled = false;
    let rule: Promise<unknown> | undefined;
    try {
      // The switch is parked on the override, holding the bill's row lock.
      await waitForLockWaiters(db, 1, { stop: () => switchSettled });
      rule = asUser(() =>
        payroll.createMany(userId, {
          scheduledTransactionId: id,
          resetDate: "2030-01-01",
          lines: [
            { categoryId, yearlyMaximum: 1000, expectedPerPaycheque: 50 },
          ],
        } as never),
      ).finally(() => {
        ruleSettled = true;
      });
      rule.catch(() => undefined);
      // With the lock, the rule write parks on the bill row before reading
      // its frequency. Without it, it reads MONTHLY at once and parks only on
      // its insert's foreign-key check, then commits after the switch did.
      await waitForLockWaiters(db, 2, {
        stop: () => ruleSettled || switchSettled,
      });
      expect(ruleSettled).toBe(false);
    } finally {
      await gate.release();
    }

    const [switchOutcome, ruleOutcome] = await Promise.allSettled([
      toCustom,
      rule,
    ]);
    expect(switchOutcome.status).toBe("fulfilled");
    expect(ruleOutcome.status).toBe("rejected");
    expect(String((ruleOutcome as PromiseRejectedResult).reason)).toMatch(
      /custom/i,
    );

    const [{ rules }] = await db.query(
      `SELECT count(*)::int AS rules FROM payroll_deduction_rules
        WHERE scheduled_transaction_id = $1`,
      [id],
    );
    expect(await pairOf(id)).toEqual({ frequency: "CUSTOM", rule: MONDAYS });
    expect(rules).toBe(0);
  });
});
