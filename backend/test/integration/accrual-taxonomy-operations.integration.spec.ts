import { createTestAccount } from "../helpers/test-factories";
import { SplitKind } from "@/transactions/entities/split-kind.enum";
import { convertRowToTransfer } from "@/transactions/convert-to-transfer";
import { randomUUID } from "node:crypto";
import {
  ActionHistoryService,
  settlePendingHistoryWrites,
} from "@/action-history/action-history.service";
import { PayeeAutoMergeService } from "@/payees/payee-auto-merge.service";
import { TagsService } from "@/tags/tags.service";
import { withScopedDb } from "@/common/db/scoped-db";
import { ActionHistory } from "@/action-history/entities/action-history.entity";
import { createAccrualTaxonomyFixture } from "../helpers/accrual-taxonomy-fixture";

describe("Accrual taxonomy operation reconstruction and writer guards (enforced PostgreSQL)", () => {
  jest.setTimeout(180000);
  let f: Awaited<ReturnType<typeof createAccrualTaxonomyFixture>>,
    history: ActionHistoryService;
  beforeAll(async () => {
    f = await createAccrualTaxonomyFixture();
    history = f.h.module.get(ActionHistoryService);
  });
  beforeEach(async () => f.reset());
  afterAll(async () => f?.close());
  async function clear() {
    await settlePendingHistoryWrites();
    await f.h.owner.query("DELETE FROM action_history WHERE user_id=$1", [
      f.user,
    ]);
  }
  async function links() {
    return f.h.owner.query(
      "SELECT id,payee_id,payee_name,category_id,amount::text FROM transactions WHERE user_id=$1 ORDER BY id",
      [f.user],
    );
  }
  async function aliases() {
    return f.h.owner.query(
      "SELECT id,payee_id,alias,created_at::text FROM payee_aliases WHERE user_id=$1 ORDER BY id",
      [f.user],
    );
  }
  async function addAlias() {
    await f.h.owner.query(
      "INSERT INTO payee_aliases(id,user_id,payee_id,alias) VALUES($1,$2,$3,'Tax alias')",
      [randomUUID(), f.user, f.payee],
    );
  }
  async function remove() {
    const p = await f.as(() => f.payees.previewRemoval(f.user, f.payee));
    await f.as(() => f.payees.remove(f.user, f.payee, p.fingerprint!));
  }
  async function reassign(from: string, to: string | null) {
    const p = await f.as(() =>
      f.categories.previewCategoryReassignment(f.user, from, to),
    );
    await f.as(() =>
      f.categories.reassignTransactions(f.user, from, to, p.fingerprint!),
    );
  }
  it("restores deleted payees, null labels, aliases and scheduled links through undo/redo", async () => {
    const { tx } = await f.source();
    await f.accrue(tx.id);
    await f.scheduled();
    await addAlias();
    const original = await links(),
      alias = await aliases(),
      bank = await f.bank(),
      states = await f.states(tx.id);
    const scheduled = await f.h.owner.query(
      "SELECT id,payee_id,payee_name FROM scheduled_transactions WHERE user_id=$1",
      [f.user],
    );
    await clear();
    await remove();
    expect((await links())[0].payee_id).toBeNull();
    await f.as(() => history.undo(f.user));
    expect(await links()).toEqual(original);
    expect(await aliases()).toEqual(alias);
    expect(
      await f.h.owner.query(
        "SELECT id,payee_id,payee_name FROM scheduled_transactions WHERE user_id=$1",
        [f.user],
      ),
    ).toEqual(scheduled);
    expect((await f.states(tx.id))[0].id).toBe(states[0].id);
    await f.as(() => history.redo(f.user));
    expect((await links())[0].payee_id).toBeNull();
    expect(await aliases()).toEqual([]);
    await f.as(() => history.undo(f.user));
    expect(await links()).toEqual(original);
    expect(await f.bank()).toBe(bank);
  });
  it("round trips manual merges including source and target aliases without replaying cash", async () => {
    const { tx } = await f.source();
    await f.accrue(tx.id);
    await f.scheduled();
    await addAlias();
    const target = await f.as(() =>
      f.payees.create(f.user, { name: "Combined tax" }),
    );
    const original = await links(),
      alias = await aliases(),
      bank = await f.bank();
    await clear();
    await f.as(() =>
      f.payees.mergePayees(f.user, {
        sourcePayeeId: f.payee,
        targetPayeeId: target.id,
        addAsAlias: true,
      }),
    );
    expect((await links())[0].payee_id).toBe(target.id);
    await f.as(() => history.undo(f.user));
    expect(await links()).toEqual(original);
    expect(await aliases()).toEqual(alias);
    await f.as(() => history.redo(f.user));
    expect((await links())[0].payee_id).toBe(target.id);
    expect(await f.bank()).toBe(bank);
  });
  it("reconstructs auto merge roots, wildcard aliases, rename and backfill", async () => {
    const { tx } = await f.source({ categoryId: null });
    await f.accrue(tx.id);
    await addAlias();
    const target = await f.as(() =>
      f.payees.create(f.user, { name: "Tax canonical" }),
    );
    const original = await links(),
      alias = await aliases();
    await clear();
    const service = f.h.module.get(PayeeAutoMergeService);
    // Exercise the same per-group transaction used by the public batch operation.
    const group = {
      canonicalPayeeId: target.id,
      sourcePayeeIds: [f.payee],
      canonicalName: "All tax",
      alias: "*TAX*",
    };
    await f.as(() => (service as any).applyGroup(f.user, group));
    await f.as(() => history.undo(f.user));
    expect(await links()).toEqual(original);
    expect(await aliases()).toEqual(alias);
    await f.as(() => history.redo(f.user));
    expect((await links())[0].payee_id).toBe(target.id);
  });
  it("restores category parent and split reassignment, scheduled references and explicit family", async () => {
    const { tx, lines } = await f.source({
      splitCategories: [f.other, f.other],
    });
    for (const line of lines) await f.accrue(tx.id, line.id);
    await f.scheduled(f.other);
    const bank = await f.bank(),
      states = await f.states(tx.id);
    await clear();
    await reassign(f.other, f.income);
    expect((await f.states(tx.id))[0].family).toBe("income");
    await f.as(() => history.undo(f.user));
    expect((await f.states(tx.id))[0].family).toBe("expense");
    expect((await f.states(tx.id)).map((r: { id: string }) => r.id)).toEqual(
      states.map((r: { id: string }) => r.id),
    );
    await f.as(() => history.redo(f.user));
    expect((await f.states(tx.id))[0].family).toBe("income");
    expect(await f.bank()).toBe(bank);
  });
  it("supports category merge as reassign then delete, with inverse order undo and restored payee defaults", async () => {
    const { tx } = await f.source({ categoryId: f.other });
    await f.accrue(tx.id);
    await f.scheduled(f.other);
    await f.h.owner.query(
      "UPDATE payees SET default_category_id=$1 WHERE id=$2",
      [f.other, f.payee],
    );
    await clear();
    await reassign(f.other, f.root);
    await f.as(() => f.categories.remove(f.user, f.other));
    await f.as(() => history.undo(f.user));
    expect(
      await f.h.owner.query(
        "SELECT default_category_id FROM payees WHERE id=$1",
        [f.payee],
      ),
    ).toEqual([{ default_category_id: f.other }]);
    await f.as(() => history.undo(f.user));
    expect((await links())[0].category_id).toBe(f.other);
    await f.as(() => history.redo(f.user));
    await f.as(() => history.redo(f.user));
    expect((await links())[0].category_id).toBe(f.root);
    expect(
      await f.h.owner.query("SELECT id FROM categories WHERE id=$1", [f.other]),
    ).toEqual([]);
  });
  it("refuses replay after an affected source or alias changes", async () => {
    const { tx } = await f.source();
    await f.accrue(tx.id);
    await addAlias();
    await clear();
    const target = await f.as(() =>
      f.payees.create(f.user, { name: "Target" }),
    );
    await clear();
    await f.as(() =>
      f.payees.mergePayees(f.user, {
        sourcePayeeId: f.payee,
        targetPayeeId: target.id,
      }),
    );
    await f.h.owner.query(
      "UPDATE payee_aliases SET alias='Changed' WHERE id=(SELECT id FROM payee_aliases WHERE user_id=$1 ORDER BY id LIMIT 1)",
      [f.user],
    );
    const before = await links(),
      states = await f.states(tx.id);
    await expect(f.as(() => history.undo(f.user))).rejects.toMatchObject({
      status: 409,
    });
    expect(await links()).toEqual(before);
    expect(await f.states(tx.id)).toEqual(states);
  });
  it("refuses a newly referencing source before undo", async () => {
    const { tx } = await f.source();
    await f.accrue(tx.id);
    const target = await f.as(() =>
      f.payees.create(f.user, { name: "Target" }),
    );
    await clear();
    await f.as(() =>
      f.payees.mergePayees(f.user, {
        sourcePayeeId: f.payee,
        targetPayeeId: target.id,
      }),
    );
    await f.h.owner.query(
      "INSERT INTO transactions(id,user_id,account_id,amount,currency_code,transaction_date,payee_id) VALUES($1,$2,$3,-1,'USD','2026-06-15',$4)",
      [randomUUID(), f.user, f.account, target.id],
    );
    const before = await links();
    await expect(f.as(() => history.undo(f.user))).rejects.toMatchObject({
      status: 409,
    });
    expect(await links()).toEqual(before);
  });
  it("rolls back the relationship mutation if the required history save fails", async () => {
    const { tx } = await f.source();
    await f.accrue(tx.id);
    await addAlias();
    await clear();
    const original = await links(),
      alias = await aliases(),
      states = await f.states(tx.id);
    await expect(
      f.as(() =>
        withScopedDb(f.h.app, async (m) => {
          const repo = m.getRepository(ActionHistory);
          jest
            .spyOn(repo, "save")
            .mockRejectedValueOnce(new Error("history unavailable"));
          await remove();
        }),
      ),
    ).rejects.toThrow("history unavailable");
    expect(await links()).toEqual(original);
    expect(await aliases()).toEqual(alias);
    expect(await f.states(tx.id)).toEqual(states);
  });
  it("refuses accrued parent and split tag cascades while allowing tag metadata edits", async () => {
    const tags = f.h.module.get(TagsService),
      tag = await f.as(() => tags.create(f.user, { name: "Tax" }));
    const { tx, lines } = await f.source({
      splitCategories: [f.root, f.other],
    });
    await f.accrue(tx.id, lines[0].id);
    await f.h.owner.query(
      "INSERT INTO transaction_split_tags(transaction_split_id,tag_id) VALUES($1,$2)",
      [lines[0].id, tag.id],
    );
    await expect(f.as(() => tags.remove(f.user, tag.id))).rejects.toMatchObject(
      { status: 409 },
    );
    await f.as(() => tags.update(f.user, tag.id, { name: "Annual tax" }));
    expect(
      await f.h.owner.query(
        "SELECT tag_id FROM transaction_split_tags WHERE transaction_split_id=$1",
        [lines[0].id],
      ),
    ).toEqual([{ tag_id: tag.id }]);
  });

  it("serializes simultaneous undo attempts without double reconstruction", async () => {
    const { tx } = await f.source();
    await f.accrue(tx.id);
    await addAlias();
    await clear();
    await remove();
    const outcomes = await Promise.allSettled([
      f.as(() => history.undo(f.user)),
      f.as(() => history.undo(f.user)),
    ]);
    expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      await f.h.owner.query("SELECT id FROM payees WHERE id=$1", [f.payee]),
    ).toHaveLength(1);
    expect(await aliases()).toHaveLength(1);
    expect((await links())[0].payee_id).toBe(f.payee);
  });
  it("refuses oversized reconstruction snapshots before deleting relationships", async () => {
    const { tx } = await f.source();
    await f.accrue(tx.id);
    await f.h.owner.query(
      "INSERT INTO payee_aliases(user_id,payee_id,alias) SELECT $1,$2,repeat($3,220)||g::text FROM generate_series(1,1000) g",
      [f.user, f.payee, "x"],
    );
    await clear();
    const original = await links(),
      states = await f.states(tx.id);
    await expect(remove()).rejects.toMatchObject({ status: 409 });
    expect(await links()).toEqual(original);
    expect(await f.states(tx.id)).toEqual(states);
    expect(await aliases()).toHaveLength(1000);
    expect(
      await f.h.owner.query("SELECT id FROM action_history WHERE user_id=$1", [
        f.user,
      ]),
    ).toEqual([]);
  });
  it("refuses lower-level accrued conversion before any bank or counterpart mutation", async () => {
    const { tx } = await f.source();
    await f.accrue(tx.id);
    const original = await links(),
      states = await f.states(tx.id),
      bank = await f.bank();
    const balances = {
      updateBalance: jest.fn(),
      recalculateCurrentBalance: jest.fn(),
    };
    await expect(
      f.as(() =>
        withScopedDb(f.h.app, (m) =>
          convertRowToTransfer(m, balances as never, f.user, tx.id, f.account, {
            clearCategory: true,
          }),
        ),
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(balances.updateBalance).not.toHaveBeenCalled();
    expect(await links()).toEqual(original);
    expect(await f.states(tx.id)).toEqual(states);
    expect(await f.bank()).toBe(bank);
  });
  it("permits a cash-only tag cascade without touching unrelated accruals", async () => {
    const { tx } = await f.source();
    await f.accrue(tx.id);
    const cash = await f.source();
    const states = await f.states(tx.id);
    const tags = f.h.module.get(TagsService),
      tag = await f.as(() => tags.create(f.user, { name: "Cash tag" }));
    await f.h.owner.query(
      "INSERT INTO transaction_tags(transaction_id,tag_id) VALUES($1,$2)",
      [cash.tx.id, tag.id],
    );
    await f.as(() => tags.remove(f.user, tag.id));
    expect(await f.states(tx.id)).toEqual(states);
    expect(
      await f.h.owner.query(
        "SELECT tag_id FROM transaction_tags WHERE transaction_id=$1",
        [cash.tx.id],
      ),
    ).toEqual([]);
  });

  it("locks the owning accrued parent before a tagged transfer split leg", async () => {
    const other = await createTestAccount(f.h.owner, f.user, {
      name: "Transfer target",
    });
    const tx = await f.as(() =>
      f.transactions.create(f.user, {
        accountId: f.account,
        currencyCode: "USD",
        transactionDate: "2026-06-15",
        amount: -1200,
        splits: [
          { categoryId: f.root, amount: -600 },
          {
            transferAccountId: other.id,
            amount: -600,
          },
        ],
      }),
    );
    const lines = await f.h.owner.query(
      "SELECT id,linked_transaction_id,kind FROM transaction_splits WHERE transaction_id=$1",
      [tx.id],
    );
    const category = lines.find(
        (r: { kind: string }) => r.kind === SplitKind.CATEGORY,
      ),
      leg = lines.find(
        (r: { kind: string }) => r.kind === SplitKind.TRANSFER,
      ).linked_transaction_id;
    await f.accrue(tx.id, category.id);
    const tags = f.h.module.get(TagsService),
      tag = await f.as(() => tags.create(f.user, { name: "Transfer tag" }));
    await f.h.owner.query(
      "INSERT INTO transaction_tags(transaction_id,tag_id) VALUES($1,$2)",
      [leg, tag.id],
    );
    const locks: { parameters?: any[] }[] = [];
    await expect(
      f.as(() =>
        withScopedDb(f.h.app, async (m) => {
          const query = m.query.bind(m);
          jest
            .spyOn(m, "query")
            .mockImplementation((sql: string, parameters?: any[]) => {
              if (sql.includes("FOR UPDATE")) locks.push({ parameters });
              return query(sql, parameters);
            });
          await tags.remove(f.user, tag.id);
        }),
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(locks[0].parameters?.flat(Infinity)).toContain(tx.id);
    expect(locks[1].parameters?.flat(Infinity)).toContain(leg);
    expect(
      await f.h.owner.query(
        "SELECT tag_id FROM transaction_tags WHERE transaction_id=$1",
        [leg],
      ),
    ).toEqual([{ tag_id: tag.id }]);
  });
});
