import { assertImportAccrualMatch } from "@/import/import-accrual-guard";
import { randomUUID } from "node:crypto";
import { withScopedDb } from "@/common/db/scoped-db";
import {
  ActionHistoryService,
  settlePendingHistoryWrites,
} from "@/action-history/action-history.service";
import { ImportRegularProcessorService } from "@/import/import-regular-processor.service";
import { TransactionRulesApplierService } from "@/transaction-rules/transaction-rules-applier.service";
import type { ImportContext } from "@/import/import-context";
import { ExchangeRateService } from "@/currencies/exchange-rate.service";
import { Account } from "@/accounts/entities/account.entity";
import { createTestAccount } from "../helpers/test-factories";
import { createAccrualTaxonomyFixture } from "../helpers/accrual-taxonomy-fixture";

describe("Accrued imports and relationship history (enforced PostgreSQL)", () => {
  jest.setTimeout(180000);
  let f: Awaited<ReturnType<typeof createAccrualTaxonomyFixture>>,
    history: ActionHistoryService,
    processor: ImportRegularProcessorService;
  beforeAll(async () => {
    f = await createAccrualTaxonomyFixture();
    history = f.h.module.get(ActionHistoryService);
    processor = new ImportRegularProcessorService(
      f.h.module.get(TransactionRulesApplierService),
      f.h.module.get(ExchangeRateService),
    );
  });
  beforeEach(async () => f.reset());
  afterAll(async () => f?.close());
  async function clearHistory() {
    await settlePendingHistoryWrites();
    await f.h.owner.query("DELETE FROM action_history WHERE user_id=$1", [
      f.user,
    ]);
  }
  async function categoryUpdate(
    id: string,
    dto: { isIncome?: boolean; parentId?: string; name?: string },
  ) {
    const preview = await f.as(() =>
      f.categories.previewCategoryUpdate(f.user, id, dto),
    );
    return f.as(() =>
      f.categories.update(f.user, id, {
        ...dto,
        ...(preview.fingerprint
          ? { accrualImpactFingerprint: preview.fingerprint }
          : {}),
      }),
    );
  }
  const latest = async () =>
    (
      await f.h.owner.query(
        "SELECT before_data,after_data,is_undone FROM action_history WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1",
        [f.user],
      )
    )[0];

  it("restores a classified subtree, exact schedules and cash source identities through undo/redo", async () => {
    const { tx } = await f.source({ categoryId: f.child });
    await f.accrue(tx.id);
    await f.source({ categoryId: f.grandchild });
    const before = await f.states(tx.id),
      graph = await f.graph(),
      bank = await f.bank();
    await clearHistory();
    await categoryUpdate(f.root, { isIncome: true });
    expect((await latest()).before_data.accrualRelationships.version).toBe(1);
    expect((await f.states(tx.id))[0].family).toBe("income");
    await f.as(() => history.undo(f.user));
    expect(await f.graph()).toEqual(graph);
    const restored = await f.states(tx.id);
    expect(restored[0].id).toBe(before[0].id);
    expect(restored[0].family).toBe("expense");
    expect(restored[0].allocations).toEqual(before[0].allocations);
    await f.as(() => history.redo(f.user));
    expect((await f.states(tx.id))[0].family).toBe("income");
    expect(await f.bank()).toBe(bank);
  });

  it("restores reparented descendants and split configuration IDs", async () => {
    const { tx, lines } = await f.source({
      splitCategories: [f.child, f.grandchild],
    });
    for (const line of lines) await f.accrue(tx.id, line.id);
    const graph = await f.graph(),
      before = await f.states(tx.id);
    await clearHistory();
    await categoryUpdate(f.child, { parentId: f.income });
    await f.as(() => history.undo(f.user));
    expect(await f.graph()).toEqual(graph);
    expect(
      (await f.states(tx.id)).map((row: { id: string }) => row.id),
    ).toEqual(before.map((row: { id: string }) => row.id));
    await f.as(() => history.redo(f.user));
    expect(
      (await f.states(tx.id)).every(
        (row: { family: string }) => row.family === "income",
      ),
    ).toBe(true);
  });

  it("restores payee rename, category backfill, scheduled label and exact accrued/cash sources", async () => {
    const { tx } = await f.source();
    await f.accrue(tx.id);
    const cash = await f.source();
    const scheduled = await f.scheduled();
    const originalRows = await f.h.owner.query(
      "SELECT category_id,payee_name FROM transactions WHERE id=ANY($1::uuid[]) ORDER BY id",
      [[tx.id, cash.tx.id]],
    );
    await clearHistory();
    const bank = await f.bank();
    const dto = {
      name: "Renamed office",
      defaultCategoryId: f.income,
      applyCategoryToTransactions: "all" as const,
    };
    const preview = await f.as(() =>
      f.payees.previewCategoryImpact(f.user, f.payee, dto),
    );
    await f.as(() =>
      f.payees.update(f.user, f.payee, {
        ...dto,
        accrualImpactFingerprint: preview.fingerprint!,
      }),
    );
    expect((await f.states(tx.id))[0].family).toBe("income");
    await f.as(() => history.undo(f.user));
    const rows = await f.h.owner.query(
      "SELECT category_id,payee_name FROM transactions WHERE id=ANY($1::uuid[]) ORDER BY id",
      [[tx.id, cash.tx.id]],
    );
    expect(rows).toEqual(originalRows);
    expect(
      (
        await f.h.owner.query(
          "SELECT payee_name FROM scheduled_transactions WHERE id=$1",
          [scheduled.id],
        )
      )[0].payee_name,
    ).toBeNull();
    expect((await f.states(tx.id))[0].family).toBe("expense");
    await f.as(() => history.redo(f.user));
    expect((await f.states(tx.id))[0].family).toBe("income");
    expect(await f.bank()).toBe(bank);
  });

  it("refuses changed source membership before undoing a category", async () => {
    const { tx } = await f.source();
    await f.accrue(tx.id);
    await clearHistory();
    await categoryUpdate(f.root, { isIncome: true });
    await f.source();
    await settlePendingHistoryWrites();
    // Keep the new source but select the category history, as a history stack would after unrelated entries are removed.
    await f.h.owner.query(
      "DELETE FROM action_history WHERE entity_type='transaction' AND user_id=$1",
      [f.user],
    );
    const graph = await f.graph();
    await expect(f.as(() => history.undo(f.user))).rejects.toMatchObject({
      status: 409,
    });
    expect(await f.graph()).toEqual(graph);
  });

  it("refuses changed schedule revisions before relationship undo", async () => {
    const { tx } = await f.source();
    await f.accrue(tx.id);
    await clearHistory();
    await categoryUpdate(f.root, { isIncome: true });
    await f.h.owner.query(
      "UPDATE accrual_schedules SET revision=revision+1 WHERE source_transaction_id=$1",
      [tx.id],
    );
    const graph = await f.graph();
    await expect(f.as(() => history.undo(f.user))).rejects.toMatchObject({
      status: 409,
    });
    expect(await f.graph()).toEqual(graph);
  });

  it("refuses legacy category and payee history after sources acquire accruals", async () => {
    const { tx } = await f.source();
    await clearHistory();
    await categoryUpdate(f.root, { name: "Old history name" });
    await settlePendingHistoryWrites();
    await f.accrue(tx.id);
    await expect(f.as(() => history.undo(f.user))).rejects.toMatchObject({
      status: 409,
    });
    await clearHistory();
    // A legacy record from before accrual support has no relationship snapshot.
    await f.h.owner.query(
      "INSERT INTO action_history(user_id,entity_type,entity_id,action,before_data,after_data,description) VALUES($1,'payee',$2,'update',$3::jsonb,$4::jsonb,'Legacy rename')",
      [
        f.user,
        f.payee,
        JSON.stringify({ name: "Former name" }),
        JSON.stringify({ name: "Tax office" }),
      ],
    );
    await expect(f.as(() => history.undo(f.user))).rejects.toMatchObject({
      status: 409,
    });
  });

  it("rolls back all taxonomy/source changes if required history insertion fails", async () => {
    const { tx } = await f.source();
    await f.accrue(tx.id);
    await clearHistory();
    const before = await f.states(tx.id),
      graph = await f.graph();
    await f.h.owner.query(
      "CREATE FUNCTION fail_relationship_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'relationship history failure'; END $$",
    );
    await f.h.owner.query(
      "CREATE TRIGGER fail_relationship_history BEFORE INSERT ON action_history FOR EACH ROW EXECUTE FUNCTION fail_relationship_history()",
    );
    try {
      await expect(categoryUpdate(f.root, { isIncome: true })).rejects.toThrow(
        "relationship history failure",
      );
    } finally {
      await f.h.owner.query(
        "DROP TRIGGER fail_relationship_history ON action_history",
      );
      await f.h.owner.query("DROP FUNCTION fail_relationship_history()");
    }
    expect(await f.graph()).toEqual(graph);
    expect(await f.states(tx.id)).toEqual(before);
  });

  it("rolls back undo if fresh replay expectation persistence fails", async () => {
    const { tx } = await f.source();
    await f.accrue(tx.id);
    await clearHistory();
    await categoryUpdate(f.root, { isIncome: true });
    const before = await f.states(tx.id),
      graph = await f.graph();
    await f.h.owner.query(
      "CREATE FUNCTION fail_relationship_replay() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'relationship replay failure'; END $$",
    );
    await f.h.owner.query(
      "CREATE TRIGGER fail_relationship_replay BEFORE UPDATE ON action_history FOR EACH ROW EXECUTE FUNCTION fail_relationship_replay()",
    );
    try {
      await expect(f.as(() => history.undo(f.user))).rejects.toThrow(
        "relationship replay failure",
      );
    } finally {
      await f.h.owner.query(
        "DROP TRIGGER fail_relationship_replay ON action_history",
      );
      await f.h.owner.query("DROP FUNCTION fail_relationship_replay()");
    }
    expect(await f.graph()).toEqual(graph);
    expect(await f.states(tx.id)).toEqual(before);
    expect((await latest()).is_undone).toBe(false);
  });

  async function importFixture(accrue: boolean) {
    const { tx } = await f.source();
    if (accrue) await f.accrue(tx.id);
    const other = await createTestAccount(f.h.owner, f.user, {
        name: "Other import account",
      }),
      linked = randomUUID();
    await f.h.owner.query(
      "INSERT INTO transactions(id,user_id,account_id,transaction_date,amount,currency_code,is_transfer,linked_transaction_id) VALUES($1,$2,$3,'2026-06-15',1200.0001,'USD',true,$4)",
      [linked, f.user, other.id, tx.id],
    );
    return { tx, other, linked };
  }
  async function importRow(otherId: string) {
    return f.as(() =>
      withScopedDb(f.h.app, async (m) => {
        const account = await m.findOneByOrFail(Account, {
          id: f.account,
          userId: f.user,
        });
        const ctx: ImportContext = {
          manager: m,
          userId: f.user,
          accountId: f.account,
          account,
          categoryMap: new Map([["Other", f.other]]),
          accountMap: new Map([["Other import account", otherId]]),
          loanCategoryMap: new Map(),
          securityMap: new Map(),
          tagMap: new Map(),
          importStartTime: new Date(),
          dateCounters: new Map(),
          affectedAccountIds: new Set(),
          settledScheduleIds: new Set(),
          transferDupCounts: new Map(),
          heldExternalIds: new Map(),
          importResult: {
            imported: 0,
            skipped: 0,
            skippedRows: [],
            errors: 0,
            errorMessages: [],
            accountsCreated: 0,
            categoriesCreated: 0,
            payeesCreated: 0,
            securitiesCreated: 0,
          },
        };
        await processor.processTransaction(ctx, {
          date: "2026-06-15",
          amount: -1300.0001,
          payee: "Imported payee",
          splits: [
            {
              amount: -1200.0001,
              isTransfer: true,
              transferAccount: "Other import account",
            },
            { amount: -100, category: "Other" },
          ],
        });
        return ctx.importResult;
      }),
    );
  }

  it("refuses an accrued placeholder match before creating import rows or payees", async () => {
    const { tx, other } = await importFixture(true),
      before = await f.states(tx.id),
      bank = await f.bank();
    await expect(importRow(other.id)).rejects.toMatchObject({ status: 409 });
    expect(await f.states(tx.id)).toEqual(before);
    expect(await f.bank()).toBe(bank);
    expect(
      await f.h.owner.query(
        "SELECT id FROM payees WHERE user_id=$1 AND name='Imported payee'",
        [f.user],
      ),
    ).toEqual([]);
    expect(
      await f.h.owner.query("SELECT id FROM transactions WHERE user_id=$1", [
        f.user,
      ]),
    ).toHaveLength(2);
  });

  it("retains cash-only placeholder cleanup and same-source balance behavior", async () => {
    const { tx, other } = await importFixture(false),
      bank = Number(await f.bank());
    const result = await importRow(other.id);
    expect(result.imported).toBe(1);
    expect(
      await f.h.owner.query("SELECT id FROM transactions WHERE id=$1", [tx.id]),
    ).toEqual([]);
    expect(Number(await f.bank())).toBeCloseTo(bank - 100, 4);
  });

  it("serializes duplicate relationship undo attempts without partial replay", async () => {
    const { tx } = await f.source();
    await f.accrue(tx.id);
    await clearHistory();
    await categoryUpdate(f.root, { isIncome: true });
    const results = await Promise.allSettled([
      f.as(() => history.undo(f.user)),
      f.as(() => history.undo(f.user)),
    ]);
    expect(results.filter((row) => row.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((row) => row.status === "rejected")).toHaveLength(1);
    expect((await f.states(tx.id))[0].family).toBe("expense");
  });
  it("refuses legacy payee deletion replay when detached accrued sources have null labels", async () => {
    const { tx } = await f.source();
    await f.accrue(tx.id);
    await clearHistory();
    const preview = await f.as(() => f.payees.previewRemoval(f.user, f.payee));
    await f.as(() => f.payees.remove(f.user, f.payee, preview.fingerprint!));
    await settlePendingHistoryWrites();
    const row = (
      await f.h.owner.query(
        "SELECT payee_id,payee_name FROM transactions WHERE id=$1",
        [tx.id],
      )
    )[0];
    expect(row).toEqual({ payee_id: null, payee_name: null });
    const before = await f.states(tx.id);
    await f.as(() => history.undo(f.user));
    expect((await f.states(tx.id))[0].id).toBe(before[0].id);
    expect(
      await f.h.owner.query(
        "SELECT payee_id,payee_name FROM transactions WHERE id=$1",
        [tx.id],
      ),
    ).toEqual([{ payee_id: f.payee, payee_name: null }]);
    await f.as(() => history.redo(f.user));
    expect(
      await f.h.owner.query("SELECT id FROM payees WHERE id=$1", [f.payee]),
    ).toEqual([]);
  });

  it("permits later matching of counterparts created earlier in the same import", async () => {
    const other = await createTestAccount(f.h.owner, f.user, {
      name: "Other import account",
    });
    await f.as(() =>
      withScopedDb(f.h.app, async (m) => {
        const account = await m.findOneByOrFail(Account, {
          id: f.account,
          userId: f.user,
        });
        const ctx: ImportContext = {
          manager: m,
          userId: f.user,
          accountId: f.account,
          account,
          categoryMap: new Map(),
          accountMap: new Map([["Other import account", other.id]]),
          loanCategoryMap: new Map(),
          securityMap: new Map(),
          tagMap: new Map(),
          importStartTime: new Date(),
          dateCounters: new Map(),
          affectedAccountIds: new Set(),
          settledScheduleIds: new Set(),
          transferDupCounts: new Map(),
          heldExternalIds: new Map(),
          importResult: {
            imported: 0,
            skipped: 0,
            skippedRows: [],
            errors: 0,
            errorMessages: [],
            accountsCreated: 0,
            categoriesCreated: 0,
            payeesCreated: 0,
            securitiesCreated: 0,
          },
        };
        await processor.processTransaction(ctx, {
          date: "2026-06-15",
          amount: -100,
          isTransfer: true,
          transferAccount: "Other import account",
        });
        const rows: { id: string }[] = await m.query(
          "SELECT id FROM transactions WHERE user_id=$1 ORDER BY id",
          [f.user],
        );
        expect(rows).toHaveLength(2);
        await expect(
          assertImportAccrualMatch(
            ctx,
            rows.map((row) => row.id),
          ),
        ).resolves.toBeUndefined();
      }),
    );
  });
});
