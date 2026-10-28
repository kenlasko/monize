import { randomUUID } from "node:crypto";
import { withScopedDb } from "@/common/db/scoped-db";
import { withUserContext } from "@/common/db/with-context";
import { BackupRestoreDatabaseService } from "@/backup/backup-restore-database.service";
import { buildExportTableQueries } from "@/backup/export-table-queries";
import {
  createEnforcedIntegrationModule,
  createTestUserDirect,
  type EnforcedIntegrationHarness,
} from "../helpers/integration-setup";

describe("accrual persistence with PostgreSQL/RLS", () => {
  jest.setTimeout(180000);
  let h: EnforcedIntegrationHarness;
  let alice: string;
  let bob: string;
  let account: string;
  let otherAccount: string;
  let source: string;
  let splitSource: string;
  let split: string;
  let schedule: string;

  const scoped = <T>(user: string, fn: () => Promise<T>) =>
    withUserContext(user, fn);
  async function insertSchedule(
    userId = alice,
    transactionId = source,
    splitId: string | null = null,
  ) {
    const [row] = await h.owner.query(
      `INSERT INTO accrual_schedules
       (user_id, source_transaction_id, source_split_id, family, currency_code,
        preset, start_month, month_count, source_fingerprint)
       VALUES ($1,$2,$3,'expense','USD','NTM','2026-10-01',12,$4) RETURNING id`,
      [userId, transactionId, splitId, "a".repeat(64)],
    );
    return row.id as string;
  }
  async function allocate(id = schedule, user = alice, amount = "-33.3300") {
    return h.owner.query(
      `INSERT INTO accrual_allocations
       (user_id,schedule_id,period_index,recognition_date,amount)
       VALUES ($1,$2,0,'2026-10-31',$3) RETURNING id`,
      [user, id, amount],
    );
  }

  beforeAll(async () => {
    h = await createEnforcedIntegrationModule([]);
    alice = (
      await createTestUserDirect(h.owner, {
        email: "accrual-alice@example.invalid",
      })
    ).id;
    bob = (
      await createTestUserDirect(h.owner, {
        email: "accrual-bob@example.invalid",
      })
    ).id;
    await h.owner.query(
      "INSERT INTO currencies(code,name,symbol) VALUES ('USD','US Dollar','$') ON CONFLICT DO NOTHING",
    );
    [account, otherAccount] = [randomUUID(), randomUUID()];
    await h.owner.query(
      `INSERT INTO accounts(id,user_id,account_type,name,currency_code)
      VALUES ($1,$2,'CHEQUING','Alice fixture','USD'),($3,$4,'CHEQUING','Bob fixture','USD')`,
      [account, alice, otherAccount, bob],
    );
  });
  afterAll(async () => {
    if (h) await h.close();
  });
  beforeEach(async () => {
    await h.owner.query("DELETE FROM accrual_allocations");
    await h.owner.query("DELETE FROM accrual_schedules");
    await h.owner.query("DELETE FROM accrual_system_accounts");
    await h.owner.query("DELETE FROM transaction_splits");
    await h.owner.query("DELETE FROM transactions");
    await h.owner.query(
      `INSERT INTO accrual_system_accounts(user_id,family,currency_code)
      VALUES ($1,'expense','USD'),($1,'income','USD'),($2,'expense','USD')`,
      [alice, bob],
    );
    source = randomUUID();
    splitSource = randomUUID();
    split = randomUUID();
    await h.owner.query(
      `INSERT INTO transactions(id,user_id,account_id,transaction_date,amount,currency_code,is_split)
      VALUES ($1,$2,$3,'2026-10-15',-1200,'USD',false),($4,$2,$3,'2026-10-15',-100,'USD',true)`,
      [source, alice, account, splitSource],
    );
    await h.owner.query(
      "INSERT INTO transaction_splits(id,transaction_id,amount) VALUES ($1,$2,-100)",
      [split, splitSource],
    );
    schedule = await insertSchedule();
  });

  it("stores all four places as exact decimal strings", async () => {
    await allocate(schedule, alice, "-9999999999999999.9999");
    const [row] = await scoped(alice, () =>
      withScopedDb(h.app, (m) =>
        m.query("SELECT amount FROM accrual_allocations WHERE schedule_id=$1", [
          schedule,
        ]),
      ),
    );
    expect(row.amount).toBe("-9999999999999999.9999");
  });
  it("isolates system accounts, schedules and allocations from other owners and unscoped connections", async () => {
    await allocate();
    for (const table of ["accrual_schedules", "accrual_allocations"]) {
      expect(
        await scoped(bob, () =>
          withScopedDb(h.app, (m) => m.query(`SELECT id FROM ${table}`)),
        ),
      ).toEqual([]);
      expect(await h.app.query(`SELECT id FROM ${table}`)).toEqual([]);
    }
    const accounts = await scoped(bob, () =>
      withScopedDb(h.app, (m) =>
        m.query("SELECT user_id FROM accrual_system_accounts"),
      ),
    );
    expect(accounts).toEqual([{ user_id: bob }]);
    expect(await h.app.query("SELECT id FROM accrual_system_accounts")).toEqual(
      [],
    );
  });
  it("enforces ownership even through a privileged connection", async () => {
    await expect(insertSchedule(bob, splitSource)).rejects.toMatchObject({
      code: "23503",
    });
    await expect(allocate(schedule, bob)).rejects.toMatchObject({
      code: "23503",
    });
  });
  it("refuses a split belonging to another source transaction", async () => {
    await expect(insertSchedule(alice, source, split)).rejects.toMatchObject({
      code: "23503",
    });
    const id = await insertSchedule(alice, splitSource, split);
    expect(id).toBeDefined();
  });
  it("refuses RLS writes under another user identity", async () => {
    await expect(
      scoped(bob, () =>
        withScopedDb(h.app, (m) =>
          m.query(
            `INSERT INTO accrual_allocations(user_id,schedule_id,period_index,recognition_date,amount)
       VALUES ($1,$2,0,'2026-10-31',-100)`,
            [alice, schedule],
          ),
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });
  it("allows one schedule per source component and one row per recognition period", async () => {
    await expect(insertSchedule()).rejects.toMatchObject({ code: "23505" });
    await allocate();
    await expect(allocate()).rejects.toMatchObject({ code: "23505" });
    await insertSchedule(alice, splitSource, split);
    await expect(
      insertSchedule(alice, splitSource, split),
    ).rejects.toMatchObject({ code: "23505" });
  });
  it.each([
    ["month_count", 0],
    ["month_count", 601],
    ["revision", 0],
    ["preset", "invalid"],
    ["start_month", "2026-10-02"],
    ["source_fingerprint", "invalid"],
  ])("rejects invalid schedule %s", async (column, value) => {
    const columns = new Set([
      "month_count",
      "revision",
      "preset",
      "start_month",
      "source_fingerprint",
    ]);
    if (!columns.has(column)) throw new Error("Invalid fixture column");
    await expect(
      h.owner.query(`UPDATE accrual_schedules SET ${column}=$1 WHERE id=$2`, [
        value,
        schedule,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
  });
  it("requires month-end recognition and bounded period indices", async () => {
    await expect(
      h.owner.query(
        `INSERT INTO accrual_allocations(user_id,schedule_id,period_index,recognition_date,amount)
      VALUES ($1,$2,0,'2026-10-15',-100)`,
        [alice, schedule],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      h.owner.query(
        `INSERT INTO accrual_allocations(user_id,schedule_id,period_index,recognition_date,amount)
      VALUES ($1,$2,600,'2026-10-31',-100)`,
        [alice, schedule],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
  it("cascades schedule and source deletion without changing cash balances", async () => {
    await allocate();
    const before = await h.owner.query(
      "SELECT current_balance FROM accounts WHERE id=$1",
      [account],
    );
    await h.owner.query("DELETE FROM accrual_schedules WHERE id=$1", [
      schedule,
    ]);
    expect(await h.owner.query("SELECT id FROM accrual_allocations")).toEqual(
      [],
    );
    schedule = await insertSchedule();
    await allocate();
    await h.owner.query("DELETE FROM transactions WHERE id=$1", [source]);
    expect(await h.owner.query("SELECT id FROM accrual_schedules")).toEqual([]);
    expect(await h.owner.query("SELECT id FROM accrual_allocations")).toEqual(
      [],
    );
    expect(
      await h.owner.query("SELECT current_balance FROM accounts WHERE id=$1", [
        account,
      ]),
    ).toEqual(before);
  });
  it("exports and restores schedules and amounts through the actual backup SQL adapters", async () => {
    await allocate(schedule, alice, "-33.3400");
    const queries = buildExportTableQueries(async function* () {});
    const tables = [
      "accrual_system_accounts",
      "accrual_schedules",
      "accrual_allocations",
    ];
    const data: Record<string, Record<string, unknown>[]> = {};
    for (const table of tables) {
      const query = queries.find((q) => q.key === table);
      expect(query).toBeDefined();
      data[table] = await h.owner.query(query!.sql, [alice]);
    }
    await h.owner.query("DELETE FROM accrual_allocations WHERE user_id=$1", [
      alice,
    ]);
    await h.owner.query("DELETE FROM accrual_schedules WHERE user_id=$1", [
      alice,
    ]);
    await h.owner.query(
      "DELETE FROM accrual_system_accounts WHERE user_id=$1",
      [alice],
    );
    const restore = new BackupRestoreDatabaseService();
    await scoped(alice, () =>
      withScopedDb(h.app, async (m) => {
        for (const table of tables) {
          expect(await restore.insertRows(m, table, data[table], alice)).toBe(
            data[table].length,
          );
        }
      }),
    );
    expect(
      await h.owner.query(
        "SELECT amount FROM accrual_allocations WHERE schedule_id=$1",
        [schedule],
      ),
    ).toEqual([{ amount: "-33.3400" }]);
  });

  it("defaults reporting to cash and rejects unknown bases", async () => {
    await h.owner.query(
      "INSERT INTO user_preferences(user_id) VALUES ($1) ON CONFLICT DO NOTHING",
      [alice],
    );
    expect(
      await h.owner.query(
        "SELECT reporting_basis FROM user_preferences WHERE user_id=$1",
        [alice],
      ),
    ).toEqual([{ reporting_basis: "cash" }]);
    await h.owner.query(
      "UPDATE user_preferences SET reporting_basis='accrual' WHERE user_id=$1",
      [alice],
    );
    await expect(
      h.owner.query(
        "UPDATE user_preferences SET reporting_basis='other' WHERE user_id=$1",
        [alice],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
  it("keeps system identities unique and requires the correct currency/family tuple", async () => {
    await expect(
      h.owner.query(
        "INSERT INTO accrual_system_accounts(user_id,family,currency_code) VALUES ($1,'expense','USD')",
        [alice],
      ),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      h.owner.query(
        "UPDATE accrual_schedules SET currency_code='ZZZ' WHERE id=$1",
        [schedule],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      h.owner.query("UPDATE accrual_schedules SET family='other' WHERE id=$1", [
        schedule,
      ]),
    ).rejects.toMatchObject({ code: "23503" });
  });
  it("cascades actual split deletion to its linked schedule and recognition", async () => {
    const id = await insertSchedule(alice, splitSource, split);
    await allocate(id);
    await h.owner.query("DELETE FROM transaction_splits WHERE id=$1", [split]);
    expect(
      await h.owner.query("SELECT id FROM accrual_schedules WHERE id=$1", [id]),
    ).toEqual([]);
    expect(
      await h.owner.query(
        "SELECT id FROM accrual_allocations WHERE schedule_id=$1",
        [id],
      ),
    ).toEqual([]);
    expect(
      await h.owner.query("SELECT id FROM transactions WHERE id=$1", [
        splitSource,
      ]),
    ).toHaveLength(1);
  });
});
