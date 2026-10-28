import { randomUUID } from "node:crypto";
import { withScopedDb } from "@/common/db/scoped-db";
import { TransactionRulesService } from "@/transaction-rules/transaction-rules.service";
import { TransactionRulesRunService } from "@/transaction-rules/transaction-rules-run.service";
import { TransactionRulesApplierService } from "@/transaction-rules/transaction-rules-applier.service";
import type { RuleAction } from "@/transaction-rules/rule-action.types";
import {
  ActionHistoryService,
  settlePendingHistoryWrites,
} from "@/action-history/action-history.service";
import { createAccrualTaxonomyFixture } from "../helpers/accrual-taxonomy-fixture";
import { createTestAccount } from "../helpers/test-factories";

describe("Accrued manual rule runs and history (enforced PostgreSQL)", () => {
  jest.setTimeout(180000);
  let f: Awaited<ReturnType<typeof createAccrualTaxonomyFixture>>;
  let rules: TransactionRulesService,
    run: TransactionRulesRunService,
    history: ActionHistoryService,
    applier: TransactionRulesApplierService;
  beforeAll(async () => {
    f = await createAccrualTaxonomyFixture();
    rules = f.h.module.get(TransactionRulesService);
    run = f.h.module.get(TransactionRulesRunService);
    history = f.h.module.get(ActionHistoryService);
    applier = f.h.module.get(TransactionRulesApplierService);
  });
  beforeEach(async () => f.reset());
  afterAll(async () => f?.close());
  const filters = () => ({ accountIds: [f.account] });
  async function rule(actions: RuleAction[]) {
    return f.as(() =>
      rules.create(f.user, {
        name: "Accrual rule",
        triggers: ["create", "import"],
        condition: { field: "amount", op: "lt", value: 0 },
        actions: actions.map((action) => ({ ...action })),
      }),
    );
  }
  const preview = (id: string) =>
    f.as(() => run.previewRun(f.user, id, filters()));
  const commit = (id: string, fingerprint: string) =>
    f.as(() => run.run(f.user, id, { ...filters(), fingerprint }));
  const row = async (id: string) =>
    (
      await f.h.owner.query(
        "SELECT category_id,payee_id,description,is_transfer FROM transactions WHERE id=$1",
        [id],
      )
    )[0];
  async function clearHistory() {
    await settlePendingHistoryWrites();
    await f.h.owner.query("DELETE FROM action_history WHERE user_id=$1", [
      f.user,
    ]);
  }

  it("previews family impact and retains exact allocations and bank cash through undo/redo", async () => {
    const { tx } = await f.source();
    await f.accrue(tx.id);
    const before = await f.states(tx.id),
      bank = await f.bank();
    const r = await rule([
      { type: "set_category", onlyIfEmpty: false, categoryId: f.income },
    ]);
    await clearHistory();
    const p = await preview(r.id);
    expect(p.accrualImpacts?.[0].schedules[0]).toMatchObject({
      familyBefore: "expense",
      familyAfter: "income",
      removed: false,
    });
    const result = await commit(r.id, p.fingerprint);
    expect(result.historyId).toBeTruthy();
    const after = await f.states(tx.id);
    expect(after[0].id).toBe(before[0].id);
    expect(after[0].family).toBe("income");
    expect(after[0].allocations).toEqual(before[0].allocations);
    await f.as(() => history.undo(f.user));
    expect((await row(tx.id)).category_id).toBe(f.root);
    expect((await f.states(tx.id))[0].family).toBe("expense");
    await f.as(() => history.redo(f.user));
    expect((await row(tx.id)).category_id).toBe(f.income);
    await f.as(() => history.undo(f.user));
    expect((await f.states(tx.id))[0].family).toBe("expense");
    expect(await f.bank()).toBe(bank);
  });

  it("refreshes split schedules for existing payee, description and tag metadata", async () => {
    const { tx } = await f.source({ splitCategories: [f.root, f.other] });
    const lines = await f.h.owner.query(
      "SELECT id FROM transaction_splits WHERE transaction_id=$1 ORDER BY id",
      [tx.id],
    );
    for (const line of lines) await f.accrue(tx.id, line.id);
    const payee = await f.as(() =>
      f.payees.create(f.user, { name: "New tax office" }),
    );
    const tag = randomUUID();
    await f.h.owner.query(
      "INSERT INTO tags(id,user_id,name) VALUES($1,$2,'Rule tag')",
      [tag, f.user],
    );
    const before = await f.states(tx.id);
    const r = await rule([
      { type: "set_payee", onlyIfEmpty: false, payeeId: payee.id },
      {
        type: "set_description",
        template: "Accrued bill",
        mode: "replace",
        onlyIfEmpty: false,
      },
      { type: "add_tags", tagIds: [tag] },
    ]);
    await clearHistory();
    await commit(r.id, (await preview(r.id)).fingerprint);
    expect(await row(tx.id)).toMatchObject({
      payee_id: payee.id,
      description: "Accrued bill",
    });
    expect(
      (await f.states(tx.id)).map(
        (s: { allocations: unknown }) => s.allocations,
      ),
    ).toEqual(before.map((s: { allocations: unknown }) => s.allocations));
    await f.as(() => history.undo(f.user));
    expect((await row(tx.id)).payee_id).toBe(f.payee);
    expect(
      await f.h.owner.query(
        "SELECT tag_id FROM transaction_tags WHERE transaction_id=$1",
        [tx.id],
      ),
    ).toEqual([]);
    await f.as(() => history.redo(f.user));
    expect((await row(tx.id)).description).toBe("Accrued bill");
  });

  it("rejects a schedule revision change after preview before source writes", async () => {
    const { tx } = await f.source();
    await f.accrue(tx.id);
    const r = await rule([
        { type: "set_category", onlyIfEmpty: false, categoryId: f.income },
      ]),
      p = await preview(r.id);
    await f.h.owner.query(
      "UPDATE accrual_schedules SET revision=revision+1 WHERE source_transaction_id=$1",
      [tx.id],
    );
    await expect(commit(r.id, p.fingerprint)).rejects.toMatchObject({
      status: 409,
    });
    expect((await row(tx.id)).category_id).toBe(f.root);
  });

  it("rejects newly accrued sources after a cash-only preview", async () => {
    const { tx } = await f.source();
    const r = await rule([
        { type: "set_category", onlyIfEmpty: false, categoryId: f.income },
      ]),
      p = await preview(r.id);
    expect(p.accrualImpacts).toBeUndefined();
    await f.accrue(tx.id);
    await expect(commit(r.id, p.fingerprint)).rejects.toMatchObject({
      status: 409,
    });
    expect((await row(tx.id)).category_id).toBe(f.root);
  });

  it("refuses structural transfer conversion before any bank or source mutation", async () => {
    const { tx } = await f.source();
    await f.accrue(tx.id);
    const target = await createTestAccount(f.h.owner, f.user, {
      name: "Other",
    });
    const r = await rule([
        {
          type: "convert_to_transfer",
          toAccountId: target.id,
          clearCategory: true,
        },
      ]),
      before = await f.states(tx.id),
      bank = await f.bank();
    await expect(preview(r.id)).rejects.toMatchObject({ status: 400 });
    expect((await row(tx.id)).is_transfer).toBe(false);
    expect(await f.states(tx.id)).toEqual(before);
    expect(await f.bank()).toBe(bank);
  });

  it("refuses a rule-created payee before reference data is created", async () => {
    const { tx } = await f.source();
    await f.accrue(tx.id);
    const r = await rule([
      {
        type: "set_payee_from_text",
        template: "Brand new rule payee",
        createIfMissing: true,
        onlyIfEmpty: false,
      },
    ]);
    await expect(preview(r.id)).rejects.toMatchObject({ status: 400 });
    expect(
      await f.h.owner.query(
        "SELECT id FROM payees WHERE user_id=$1 AND name='Brand new rule payee'",
        [f.user],
      ),
    ).toEqual([]);
  });

  it("refuses automatic existing-source application before category writes", async () => {
    const { tx } = await f.source();
    await f.accrue(tx.id);
    await rule([
      { type: "set_category", onlyIfEmpty: false, categoryId: f.income },
    ]);
    await expect(
      f.as(() =>
        withScopedDb(f.h.app, (m) =>
          applier.applyToNew(m, f.user, [tx.id], "import"),
        ),
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect((await row(tx.id)).category_id).toBe(f.root);
  });

  it("refuses undo after a later exact source edit without changing the schedule", async () => {
    const { tx } = await f.source();
    await f.accrue(tx.id);
    const r = await rule([
      { type: "set_category", onlyIfEmpty: false, categoryId: f.income },
    ]);
    await clearHistory();
    await commit(r.id, (await preview(r.id)).fingerprint);
    await f.h.owner.query(
      "UPDATE transactions SET description='Later source edit' WHERE id=$1",
      [tx.id],
    );
    const before = await f.states(tx.id);
    await expect(f.as(() => history.undo(f.user))).rejects.toMatchObject({
      status: 409,
    });
    expect(await f.states(tx.id)).toEqual(before);
    expect((await row(tx.id)).category_id).toBe(f.income);
  });

  it("rolls back source changes when schedule allocation insertion fails", async () => {
    const { tx } = await f.source();
    await f.accrue(tx.id);
    const r = await rule([
        { type: "set_category", onlyIfEmpty: false, categoryId: f.income },
      ]),
      p = await preview(r.id),
      before = await f.states(tx.id);
    await f.h.owner.query(
      "CREATE FUNCTION fail_rule_accrual() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'rule allocation failure'; END $$",
    );
    await f.h.owner.query(
      "CREATE TRIGGER fail_rule_accrual BEFORE INSERT ON accrual_allocations FOR EACH ROW EXECUTE FUNCTION fail_rule_accrual()",
    );
    try {
      await expect(commit(r.id, p.fingerprint)).rejects.toThrow(
        "rule allocation failure",
      );
    } finally {
      await f.h.owner.query(
        "DROP TRIGGER fail_rule_accrual ON accrual_allocations",
      );
      await f.h.owner.query("DROP FUNCTION fail_rule_accrual()");
    }
    expect((await row(tx.id)).category_id).toBe(f.root);
    expect(await f.states(tx.id)).toEqual(before);
  });

  it("serializes simultaneous reviewed runs so one stale preview is refused", async () => {
    const { tx } = await f.source();
    await f.accrue(tx.id);
    const r = await rule([
        { type: "set_category", onlyIfEmpty: false, categoryId: f.income },
      ]),
      p = await preview(r.id);
    const result = await Promise.allSettled([
      commit(r.id, p.fingerprint),
      commit(r.id, p.fingerprint),
    ]);
    expect(result.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(result.filter((x) => x.status === "rejected")).toHaveLength(1);
    expect((await f.states(tx.id))[0].family).toBe("income");
  });
  it("binds target category classification to the reviewed preview", async () => {
    const { tx } = await f.source();
    await f.accrue(tx.id);
    const r = await rule([
        { type: "set_category", onlyIfEmpty: false, categoryId: f.income },
      ]),
      p = await preview(r.id);
    await f.h.owner.query("UPDATE categories SET is_income=false WHERE id=$1", [
      f.income,
    ]);
    await expect(commit(r.id, p.fingerprint)).rejects.toMatchObject({
      status: 409,
    });
    expect((await row(tx.id)).category_id).toBe(f.root);
  });

  it("rejects remove/recreate schedule ABA after the reviewed preview", async () => {
    const { tx } = await f.source();
    await f.accrue(tx.id);
    const r = await rule([
        { type: "set_category", onlyIfEmpty: false, categoryId: f.income },
      ]),
      p = await preview(r.id);
    await f.h.owner.query(
      "DELETE FROM accrual_schedules WHERE source_transaction_id=$1",
      [tx.id],
    );
    await f.accrue(tx.id);
    await expect(commit(r.id, p.fingerprint)).rejects.toMatchObject({
      status: 409,
    });
    expect((await row(tx.id)).category_id).toBe(f.root);
  });

  it("refuses legacy cash rule history after the source acquires a schedule", async () => {
    const { tx } = await f.source();
    const r = await rule([
      { type: "set_category", onlyIfEmpty: false, categoryId: f.other },
    ]);
    await clearHistory();
    await commit(r.id, (await preview(r.id)).fingerprint);
    await f.accrue(tx.id);
    const before = await f.states(tx.id);
    await expect(f.as(() => history.undo(f.user))).rejects.toMatchObject({
      status: 409,
    });
    expect(await f.states(tx.id)).toEqual(before);
    expect((await row(tx.id)).category_id).toBe(f.other);
  });
  it("rolls back undo metadata and allocations when required history persistence fails", async () => {
    const { tx } = await f.source();
    await f.accrue(tx.id);
    const r = await rule([
      { type: "set_category", onlyIfEmpty: false, categoryId: f.income },
    ]);
    await clearHistory();
    await commit(r.id, (await preview(r.id)).fingerprint);
    const before = await f.states(tx.id);
    await f.h.owner.query(
      "CREATE FUNCTION fail_rule_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'rule history failure'; END $$",
    );
    await f.h.owner.query(
      "CREATE TRIGGER fail_rule_history BEFORE UPDATE ON action_history FOR EACH ROW EXECUTE FUNCTION fail_rule_history()",
    );
    try {
      await expect(f.as(() => history.undo(f.user))).rejects.toThrow(
        "rule history failure",
      );
    } finally {
      await f.h.owner.query("DROP TRIGGER fail_rule_history ON action_history");
      await f.h.owner.query("DROP FUNCTION fail_rule_history()");
    }
    expect((await row(tx.id)).category_id).toBe(f.income);
    expect(await f.states(tx.id)).toEqual(before);
    expect(
      (
        await f.h.owner.query(
          "SELECT is_undone FROM action_history WHERE entity_type='transaction_rule_run' AND user_id=$1",
          [f.user],
        )
      )[0].is_undone,
    ).toBe(false);
  });
  it("restores the explicit expense family when undo returns to an uncategorized source", async () => {
    const { tx } = await f.source({ categoryId: null });
    await f.accrue(tx.id);
    const before = await f.states(tx.id);
    const r = await rule([
      { type: "set_category", onlyIfEmpty: false, categoryId: f.income },
    ]);
    await clearHistory();
    await commit(r.id, (await preview(r.id)).fingerprint);
    expect((await f.states(tx.id))[0].family).toBe("income");
    await f.as(() => history.undo(f.user));
    expect((await row(tx.id)).category_id).toBeNull();
    const restored = await f.states(tx.id);
    expect(restored[0].id).toBe(before[0].id);
    expect(restored[0].family).toBe("expense");
    expect(restored[0].allocations).toEqual(before[0].allocations);
    await f.as(() => history.redo(f.user));
    expect((await f.states(tx.id))[0].family).toBe("income");
  });
});
