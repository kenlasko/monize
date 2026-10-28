import { withScopedDb } from "@/common/db/scoped-db";
import { refreshSourceAccruals } from "@/accruals/accrual-lifecycle";
import { randomUUID } from "node:crypto";
import { AccrualsService } from "@/accruals/accruals.service";
import type {
  AccrualPreviewDto,
  AccrualCommitDto,
} from "@/accruals/dto/accrual-command.dto";
import { withUserContext, withDelegateContext } from "@/common/db/with-context";
import {
  createEnforcedIntegrationModule,
  createTestUserDirect,
  type EnforcedIntegrationHarness,
} from "../helpers/integration-setup";

describe("accrual command core with real PostgreSQL/RLS", () => {
  jest.setTimeout(180000);
  let h: EnforcedIntegrationHarness;
  let service: AccrualsService;
  let alice: string;
  let bob: string;
  let account: string;
  let source: string;
  let category: string;
  const as = <T>(id: string, fn: () => Promise<T>) => withUserContext(id, fn);
  const request = (): AccrualPreviewDto => ({
    sourceTransactionId: source,
    preset: "NTM",
  });
  async function preview(dto = request()) {
    return as(alice, () => service.preview(alice, dto));
  }
  async function command(dto = request()): Promise<AccrualCommitDto> {
    const view = await preview(dto);
    return {
      ...dto,
      fingerprint: view.fingerprint,
      expectedRevision: view.expectedRevision,
      expectedScheduleId: view.expectedScheduleId,
    };
  }
  async function save(dto = request()) {
    const confirmed = await command(dto);
    return as(alice, () => service.save(alice, confirmed));
  }
  beforeAll(async () => {
    h = await createEnforcedIntegrationModule([]);
    service = new AccrualsService(h.app);
    alice = (
      await createTestUserDirect(h.owner, {
        email: "accrual-core-alice@example.invalid",
      })
    ).id;
    bob = (
      await createTestUserDirect(h.owner, {
        email: "accrual-core-bob@example.invalid",
      })
    ).id;
    await h.owner.query(
      "INSERT INTO currencies(code,name,symbol) VALUES ('USD','US Dollar','$') ON CONFLICT DO NOTHING",
    );
    account = randomUUID();
    category = randomUUID();
    await h.owner.query(
      `INSERT INTO accounts(id,user_id,account_type,name,currency_code,current_balance)
      VALUES ($1,$2,'CHEQUING','Fixture','USD',1000)`,
      [account, alice],
    );
    await h.owner.query(
      "INSERT INTO categories(id,user_id,name,is_income) VALUES ($1,$2,'Tax fixture',false)",
      [category, alice],
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
    await h.owner.query("DELETE FROM user_preferences");
    source = randomUUID();
    await h.owner.query(
      `INSERT INTO transactions(id,user_id,account_id,transaction_date,amount,currency_code,category_id)
      VALUES($1,$2,$3,'2026-10-15',-1200,'USD',$4)`,
      [source, alice, account, category],
    );
  });

  it("previews without persistence and commits exactly that plan without moving cash", async () => {
    const view = await preview();
    expect(view.family).toBe("expense");
    expect(view.plan.allocations.map((row) => row.amount)).toEqual(
      Array(12).fill("-100.0000"),
    );
    expect(view.timingBalances[0]).toEqual({
      asOf: "2026-10-15",
      amount: "1200.0000",
    });
    expect(await h.owner.query("SELECT id FROM accrual_schedules")).toEqual([]);
    const result = await save();
    expect(result.revision).toBe(1);
    expect(
      await h.owner.query(
        "SELECT SUM(amount)::text AS total,COUNT(*)::int AS count FROM accrual_allocations",
      ),
    ).toEqual([{ total: "-1200.0000", count: 12 }]);
    expect(
      await h.owner.query("SELECT current_balance FROM accounts WHERE id=$1", [
        account,
      ]),
    ).toEqual([{ current_balance: "1000.0000" }]);
  });
  it("preserves exact money beyond Number precision", async () => {
    await h.owner.query(
      "UPDATE transactions SET amount=-9999999999999999.9999 WHERE id=$1",
      [source],
    );
    const view = await preview();
    expect(view.source.amount).toBe("-9999999999999999.9999");
    await save();
    expect(
      await h.owner.query(
        "SELECT SUM(amount)::text AS total FROM accrual_allocations",
      ),
    ).toEqual([{ total: "-9999999999999999.9999" }]);
  });
  it("requires explicit family for uncategorized sources and respects category family", async () => {
    await expect(
      preview({ ...request(), family: "income" }),
    ).rejects.toMatchObject({ status: 400 });
    await h.owner.query(
      "UPDATE transactions SET category_id=NULL WHERE id=$1",
      [source],
    );
    await expect(preview()).rejects.toMatchObject({ status: 400 });
    const view = await preview({ ...request(), family: "income" });
    expect(view.family).toBe("income");
    expect(view.timingBalances[0].amount).toBe("-1200.0000");
  });
  it("rejects stale source expectations before any write", async () => {
    const dto = await command();
    await h.owner.query("UPDATE transactions SET amount=-2400 WHERE id=$1", [
      source,
    ]);
    await expect(
      as(alice, () => service.save(alice, dto)),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      await h.owner.query("SELECT id FROM accrual_system_accounts"),
    ).toEqual([]);
    expect(await h.owner.query("SELECT id FROM accrual_schedules")).toEqual([]);
  });
  it("serializes two identical create confirmations to one winner", async () => {
    const dto = await command();
    const results = await Promise.allSettled([
      as(alice, () => service.save(alice, dto)),
      as(alice, () => service.save(alice, dto)),
    ]);
    expect(results.filter((row) => row.status === "fulfilled")).toHaveLength(1);
    const failure = results.find(
      (row) => row.status === "rejected",
    ) as PromiseRejectedResult;
    expect(failure.reason).toMatchObject({ status: 409 });
    expect(
      await h.owner.query(
        "SELECT COUNT(*)::int AS count FROM accrual_schedules",
      ),
    ).toEqual([{ count: 1 }]);
    expect(
      await h.owner.query(
        "SELECT COUNT(*)::int AS count FROM accrual_allocations",
      ),
    ).toEqual([{ count: 12 }]);
  });
  it("replaces a reviewed schedule and rejects old revisions without partial changes", async () => {
    const first = await save();
    const replacement = await command({
      ...request(),
      preset: "CUSTOM",
      startMonth: "2026-01",
      monthCount: 3,
    });
    const second = await as(alice, () => service.save(alice, replacement));
    expect(second.id).toBe(first.id);
    expect(second.revision).toBe(2);
    expect(
      await h.owner.query(
        "SELECT COUNT(*)::int AS count FROM accrual_allocations",
      ),
    ).toEqual([{ count: 3 }]);
    await expect(
      as(alice, () => service.save(alice, replacement)),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      await h.owner.query(
        "SELECT COUNT(*)::int AS count FROM accrual_allocations",
      ),
    ).toEqual([{ count: 3 }]);
  });
  it("removes only reviewed recognition effects and preserves the source", async () => {
    const value = await save();
    const detail = await as(alice, () => service.detail(alice, value.id));
    await expect(
      as(alice, () =>
        service.remove(alice, value.id, {
          fingerprint: "0".repeat(64),
          expectedRevision: 1,
        }),
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      await h.owner.query(
        "SELECT COUNT(*)::int AS count FROM accrual_allocations",
      ),
    ).toEqual([{ count: 12 }]);
    await as(alice, () =>
      service.remove(alice, value.id, {
        fingerprint: detail.fingerprint,
        expectedRevision: detail.schedule.revision,
      }),
    );
    expect(await h.owner.query("SELECT id FROM accrual_allocations")).toEqual(
      [],
    );
    expect(
      await h.owner.query("SELECT id FROM transactions WHERE id=$1", [source]),
    ).toHaveLength(1);
  });
  it("rejects another owner and delegated command contexts", async () => {
    const dto = await command();
    await expect(
      as(bob, () => service.preview(bob, request())),
    ).rejects.toMatchObject({ status: 404 });
    await expect(as(bob, () => service.save(alice, dto))).rejects.toMatchObject(
      { status: 403 },
    );
    await expect(
      withDelegateContext(alice, bob, () => service.preview(alice, request())),
    ).rejects.toMatchObject({ status: 403 });
    const value = await save();
    await expect(
      as(bob, () => service.detail(bob, value.id)),
    ).rejects.toMatchObject({ status: 404 });
  });
  it.each(["VOID", "transfer"])("refuses %s source state", async (state) => {
    if (state === "VOID")
      await h.owner.query("UPDATE transactions SET status='VOID' WHERE id=$1", [
        source,
      ]);
    else
      await h.owner.query(
        "UPDATE transactions SET is_transfer=true WHERE id=$1",
        [source],
      );
    await expect(preview()).rejects.toMatchObject({ status: 400 });
  });
  it("requires a specific eligible category split and refuses wrong-parent splits", async () => {
    const split = randomUUID();
    await h.owner.query(
      "UPDATE transactions SET is_split=true,category_id=NULL WHERE id=$1",
      [source],
    );
    await h.owner.query(
      "INSERT INTO transaction_splits(id,transaction_id,amount,category_id) VALUES($1,$2,-100,$3)",
      [split, source, category],
    );
    await expect(preview()).rejects.toMatchObject({ status: 400 });
    const value = await save({ ...request(), sourceSplitId: split });
    expect(value.plan.amount).toBe("-100.0000");
    await expect(
      preview({ ...request(), sourceSplitId: randomUUID() }),
    ).rejects.toMatchObject({ status: 404 });
    await h.owner.query(
      "UPDATE transaction_splits SET kind='investment',category_id=NULL WHERE id=$1",
      [split],
    );
    await expect(
      preview({ ...request(), sourceSplitId: split }),
    ).rejects.toMatchObject({ status: 400 });
  });
  it("enforces the existing reconciled lock for schedule changes", async () => {
    await h.owner.query(
      "INSERT INTO user_preferences(user_id,lock_reconciled_transactions) VALUES($1,true)",
      [alice],
    );
    await h.owner.query(
      "UPDATE transactions SET status='RECONCILED' WHERE id=$1",
      [source],
    );
    await expect(preview()).rejects.toMatchObject({ status: 409 });
    expect(await h.owner.query("SELECT id FROM accrual_schedules")).toEqual([]);
  });
  it("does not reuse an expectation after a schedule is removed and recreated", async () => {
    const first = await save();
    const old = await command();
    const detail = await as(alice, () => service.detail(alice, first.id));
    await as(alice, () =>
      service.remove(alice, first.id, {
        fingerprint: detail.fingerprint,
        expectedRevision: 1,
      }),
    );
    const replacement = await save();
    expect(replacement.id).not.toBe(first.id);
    await expect(
      as(alice, () => service.save(alice, old)),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("rechecks the source after waiting for a concurrent writer's row lock", async () => {
    const dto = await command();
    const runner = h.owner.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await runner.query("SELECT id FROM transactions WHERE id=$1 FOR UPDATE", [
        source,
      ]);
      const pending = as(alice, () => service.save(alice, dto)).then(
        (value) => ({ value, error: null }),
        (error) => ({ value: null, error }),
      );
      let blocked = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const rows = await h.owner.query(`SELECT 1 FROM pg_stat_activity
          WHERE datname=current_database() AND wait_event_type='Lock'
          AND query LIKE '%FROM transactions%' AND pid<>pg_backend_pid()`);
        if (rows.length) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      await runner.query("UPDATE transactions SET amount=-2400 WHERE id=$1", [
        source,
      ]);
      await runner.commitTransaction();
      expect((await pending).error).toMatchObject({ status: 409 });
      expect(await h.owner.query("SELECT id FROM accrual_schedules")).toEqual(
        [],
      );
    } finally {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      await runner.release();
    }
  });

  it("refreshes source amounts and relative periods in the source transaction", async () => {
    const value = await save();
    await as(alice, () =>
      withScopedDb(h.app, async (m) => {
        await m.query(
          "UPDATE transactions SET amount=-2400,transaction_date='2026-11-15' WHERE id=$1",
          [source],
        );
        expect(await refreshSourceAccruals(m, alice, source)).toBe(1);
      }),
    );
    const detail = await as(alice, () => service.detail(alice, value.id));
    expect(detail.schedule.revision).toBe(2);
    expect(detail.plan.amount).toBe("-2400.0000");
    expect(detail.plan.allocations[0]).toMatchObject({
      recognitionDate: "2026-11-30",
      amount: "-200.0000",
    });
  });
  it("retains custom dates and skips timestamp-only source touches", async () => {
    const value = await save({
      ...request(),
      preset: "CUSTOM",
      startMonth: "2026-01",
      monthCount: 3,
    });
    await as(alice, () =>
      withScopedDb(h.app, async (m) => {
        await m.query(
          "UPDATE transactions SET updated_at=CURRENT_TIMESTAMP WHERE id=$1",
          [source],
        );
        expect(await refreshSourceAccruals(m, alice, source)).toBe(0);
        await m.query(
          "UPDATE transactions SET transaction_date='2027-01-15' WHERE id=$1",
          [source],
        );
        expect(await refreshSourceAccruals(m, alice, source)).toBe(1);
      }),
    );
    const detail = await as(alice, () => service.detail(alice, value.id));
    expect(detail.plan.startMonth).toBe("2026-01");
    expect(detail.plan.allocations[0].recognitionDate).toBe("2026-01-31");
  });
  it("rolls the source and all allocations back when refresh or a later step refuses", async () => {
    const value = await save();
    await expect(
      as(alice, () =>
        withScopedDb(h.app, async (m) => {
          await m.query(
            "UPDATE transactions SET is_transfer=true WHERE id=$1",
            [source],
          );
          await refreshSourceAccruals(m, alice, source);
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(
      await h.owner.query("SELECT is_transfer FROM transactions WHERE id=$1", [
        source,
      ]),
    ).toEqual([{ is_transfer: false }]);
    await expect(
      as(alice, () =>
        withScopedDb(h.app, async (m) => {
          await m.query("UPDATE transactions SET amount=-2400 WHERE id=$1", [
            source,
          ]);
          await refreshSourceAccruals(m, alice, source);
          throw new Error("fixture refusal after refresh");
        }),
      ),
    ).rejects.toThrow("fixture refusal after refresh");
    const detail = await as(alice, () => service.detail(alice, value.id));
    expect(detail.plan.amount).toBe("-1200.0000");
    expect(detail.schedule.revision).toBe(1);
  });
  it("retains schedules across void and unvoid and updates their source expectation", async () => {
    const value = await save();
    for (const status of ["VOID", "UNRECONCILED"]) {
      await as(alice, () =>
        withScopedDb(h.app, async (m) => {
          await m.query("UPDATE transactions SET status=$1 WHERE id=$2", [
            status,
            source,
          ]);
          expect(await refreshSourceAccruals(m, alice, source)).toBe(1);
        }),
      );
      const detail = await as(alice, () => service.detail(alice, value.id));
      expect(detail.plan.allocations).toHaveLength(12);
      expect(detail.source.status).toBe(status);
    }
  });
  it("moves timing identity when source category classification changes", async () => {
    const value = await save();
    try {
      await as(alice, () =>
        withScopedDb(h.app, async (m) => {
          await m.query("UPDATE categories SET is_income=true WHERE id=$1", [
            category,
          ]);
          expect(await refreshSourceAccruals(m, alice, source)).toBe(1);
        }),
      );
      expect(
        (await as(alice, () => service.detail(alice, value.id))).schedule
          .family,
      ).toBe("income");
      expect(
        await h.owner.query(
          "SELECT family FROM accrual_system_accounts WHERE user_id=$1 ORDER BY family",
          [alice],
        ),
      ).toEqual([{ family: "expense" }, { family: "income" }]);
    } finally {
      await h.owner.query("UPDATE categories SET is_income=false WHERE id=$1", [
        category,
      ]);
    }
  });
});
