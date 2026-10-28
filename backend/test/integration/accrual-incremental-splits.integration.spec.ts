import { randomUUID } from "node:crypto";
import { TransactionsModule } from "@/transactions/transactions.module";
import { TransactionsService } from "@/transactions/transactions.service";
import { AccrualsService } from "@/accruals/accruals.service";
import {
  ActionHistoryService,
  settlePendingHistoryWrites,
} from "@/action-history/action-history.service";
import { withUserContext } from "@/common/db/with-context";
import type { IncrementalSplitPreviewDto } from "@/transactions/dto/incremental-split.dto";
import { createTestAccount } from "../helpers/test-factories";
import {
  createEnforcedIntegrationModule,
  createTestUserDirect,
  cleanTables,
  type EnforcedIntegrationHarness,
} from "../helpers/integration-setup";

describe("individual split accrual mutations through actual services", () => {
  jest.setTimeout(180000);
  let h: EnforcedIntegrationHarness,
    transactions: TransactionsService,
    accruals: AccrualsService,
    history: ActionHistoryService;
  let user: string, account: string, category: string;
  const as = <T>(fn: () => Promise<T>) => withUserContext(user, fn);
  const balance = async () =>
    String(
      (
        await h.owner.query(
          "SELECT current_balance FROM accounts WHERE id=$1",
          [account],
        )
      )[0].current_balance,
    );
  const lines = (id: string) =>
    h.owner.query(
      "SELECT id,kind,amount::text,memo FROM transaction_splits WHERE transaction_id=$1 ORDER BY memo NULLS LAST,id",
      [id],
    );
  const schedules = (id: string) =>
    h.owner.query(
      'SELECT id,source_split_id AS "splitId",revision FROM accrual_schedules WHERE source_transaction_id=$1 ORDER BY id',
      [id],
    );
  async function create(count = 0) {
    const source = await as(() =>
      transactions.create(user, {
        accountId: account,
        currencyCode: "USD",
        transactionDate: "2026-06-15",
        amount: -1200,
        ...(count
          ? {
              splits: Array.from({ length: count }, (_, index) => ({
                amount: -1200 / count,
                categoryId: category,
                memo: String(index),
              })),
            }
          : { categoryId: category }),
      }),
    );
    await settlePendingHistoryWrites();
    return source;
  }
  async function accrue(id: string, splitId?: string) {
    const input = {
      sourceTransactionId: id,
      sourceSplitId: splitId,
      preset: "NTM" as const,
    };
    const preview = await as(() => accruals.preview(user, input));
    return as(() =>
      accruals.save(user, {
        ...input,
        fingerprint: preview.fingerprint,
        expectedScheduleId: preview.expectedScheduleId,
        expectedRevision: preview.expectedRevision,
      }),
    );
  }
  const preview = (id: string, command: IncrementalSplitPreviewDto) =>
    as(() => transactions.previewIncrementalSplit(user, id, command));
  async function add(id: string, amount: number, tagIds?: string[]) {
    const split = {
      amount,
      categoryId: category,
      ...(tagIds ? { tagIds } : {}),
    };
    const view = await preview(id, { operation: "add", split });
    return as(() =>
      transactions.addSplit(user, id, split, view.fingerprint ?? undefined),
    );
  }
  async function remove(id: string, splitId: string) {
    const view = await preview(id, { operation: "remove", splitId });
    await as(() =>
      transactions.removeSplit(
        user,
        id,
        splitId,
        view.fingerprint ?? undefined,
      ),
    );
    return view;
  }
  beforeAll(async () => {
    h = await createEnforcedIntegrationModule([TransactionsModule]);
    transactions = h.module.get(TransactionsService);
    history = h.module.get(ActionHistoryService);
    accruals = new AccrualsService(h.app);
  });
  afterAll(async () => {
    await settlePendingHistoryWrites();
    if (h) await h.close();
  });
  beforeEach(async () => {
    await settlePendingHistoryWrites();
    await cleanTables(h.owner, [
      "transaction_splits",
      "transactions",
      "accounts",
      "categories",
      "payees",
      "users",
    ]);
    await h.owner.query(
      "INSERT INTO currencies(code,name,symbol,decimal_places) VALUES('USD','US Dollar','$',2) ON CONFLICT DO NOTHING",
    );
    user = (await createTestUserDirect(h.owner)).id;
    account = (
      await createTestAccount(h.owner, user, {
        name: "Individual splits",
        openingBalance: 1000,
        currentBalance: 1000,
      })
    ).id;
    category = randomUUID();
    await h.owner.query(
      "INSERT INTO categories(id,user_id,name,is_income) VALUES($1,$2,'Tax fixture',false)",
      [category, user],
    );
  });
  it("reviews unsplit conversion, preserves the first partial line, and restores each stage through history", async () => {
    const source = await create();
    const original = await accrue(source.id);
    await expect(
      as(() =>
        transactions.addSplit(user, source.id, {
          amount: -600,
          categoryId: category,
        }),
      ),
    ).rejects.toMatchObject({ status: 409 });
    const tag = randomUUID();
    await h.owner.query(
      "INSERT INTO tags(id,user_id,name) VALUES($1,$2,'First part')",
      [tag, user],
    );
    const first = await add(source.id, -600, [tag]);
    expect((await schedules(source.id))[0].id).toBe(original.id);
    expect(
      await h.owner.query(
        "SELECT tag_id FROM transaction_split_tags WHERE transaction_split_id=$1",
        [first.id],
      ),
    ).toEqual([{ tag_id: tag }]);
    await as(() => history.undo(user));
    expect(await lines(source.id)).toHaveLength(0);
    await as(() => history.redo(user));
    expect(await lines(source.id)).toHaveLength(1);
    const split = { amount: -600, categoryId: category };
    const view = await preview(source.id, { operation: "add", split });
    expect(view.activatesSplit).toBe(true);
    expect(view.impacts[0].removed).toBe(true);
    await as(() =>
      transactions.addSplit(user, source.id, split, view.fingerprint!),
    );
    expect(await schedules(source.id)).toHaveLength(0);
    expect(await lines(source.id)).toHaveLength(2);
    await as(() => history.undo(user));
    expect(await schedules(source.id)).toHaveLength(1);
    expect(await lines(source.id)).toHaveLength(1);
    await as(() => history.redo(user));
    expect(await schedules(source.id)).toHaveLength(0);
    expect(await lines(source.id)).toHaveLength(2);
    expect(await balance()).toBe("-200.0000");
  });
  it("removes only the selected scheduled component when three lines become two", async () => {
    const source = await create(3);
    const original = await lines(source.id);
    await h.owner.query(
      "UPDATE transaction_splits SET amount=-400.0001 WHERE id=$1",
      [original[0].id],
    );
    await h.owner.query(
      "UPDATE transaction_splits SET amount=-399.9999 WHERE id=$1",
      [original[1].id],
    );
    await accrue(source.id, original[0].id);
    const retained = await accrue(source.id, original[1].id);
    const view = await remove(source.id, original[0].id);
    expect(view.collapse).toBe(false);
    expect(view.impacts.filter((row) => row.removed)).toHaveLength(1);
    expect(await schedules(source.id)).toEqual([
      { id: retained.id, splitId: original[1].id, revision: 1 },
    ]);
    expect(
      (await as(() => accruals.detail(user, retained.id))).plan.amount,
    ).toBe("-399.9999");
    await as(() => history.undo(user));
    expect(await lines(source.id)).toHaveLength(3);
    expect(await schedules(source.id)).toHaveLength(2);
    await as(() => history.redo(user));
    expect(await lines(source.id)).toHaveLength(2);
    expect(await schedules(source.id)).toHaveLength(1);
    expect(await balance()).toBe("-200.0000");
  });
  it("previews removal of both schedules when deleting one line collapses the remaining line", async () => {
    const source = await create(2);
    const original = await lines(source.id);
    await accrue(source.id, original[0].id);
    await accrue(source.id, original[1].id);
    const view = await preview(source.id, {
      operation: "remove",
      splitId: original[0].id,
    });
    expect(view.collapse).toBe(true);
    expect(view.removedSourceSplitIds).toHaveLength(2);
    expect(view.impacts.every((row) => row.removed && row.after === null)).toBe(
      true,
    );
    await expect(
      as(() => transactions.removeSplit(user, source.id, original[0].id)),
    ).rejects.toMatchObject({ status: 409 });
    expect(await schedules(source.id)).toHaveLength(2);
    await as(() =>
      transactions.removeSplit(
        user,
        source.id,
        original[0].id,
        view.fingerprint!,
      ),
    );
    expect(await lines(source.id)).toHaveLength(0);
    expect(await schedules(source.id)).toHaveLength(0);
    const parent = (
      await h.owner.query(
        "SELECT is_split,amount::text FROM transactions WHERE id=$1",
        [source.id],
      )
    )[0];
    expect(parent).toEqual({ is_split: false, amount: "-1200.0000" });
    await as(() => history.undo(user));
    expect(await schedules(source.id)).toHaveLength(2);
    await as(() => history.redo(user));
    expect(await schedules(source.id)).toHaveLength(0);
    expect(await balance()).toBe("-200.0000");
  });
  it("rejects altered commands and changes to an unaccrued sibling before mutating anything", async () => {
    const source = await create(3);
    const original = await lines(source.id);
    await accrue(source.id, original[0].id);
    const view = await preview(source.id, {
      operation: "remove",
      splitId: original[2].id,
    });
    await h.owner.query(
      "UPDATE transaction_splits SET memo='Changed sibling' WHERE id=$1",
      [original[2].id],
    );
    await expect(
      as(() =>
        transactions.removeSplit(
          user,
          source.id,
          original[2].id,
          view.fingerprint!,
        ),
      ),
    ).rejects.toMatchObject({ status: 409 });
    const addition = await preview(source.id, {
      operation: "add",
      split: { amount: 0, categoryId: category },
    });
    await expect(
      as(() =>
        transactions.addSplit(
          user,
          source.id,
          { amount: 10, categoryId: category },
          addition.fingerprint!,
        ),
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(await lines(source.id)).toHaveLength(3);
    expect(await schedules(source.id)).toHaveLength(1);
  });
  it("rolls the new line and accrual state back if required history cannot be saved", async () => {
    const source = await create(2);
    const original = await lines(source.id);
    const schedule = await accrue(source.id, original[0].id);
    const split = { amount: 0, categoryId: category };
    const view = await preview(source.id, { operation: "add", split });
    await h.owner.query(
      "CREATE FUNCTION reject_incremental_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'history write failure fixture'; END $$",
    );
    await h.owner.query(
      "CREATE TRIGGER reject_incremental_history BEFORE INSERT ON action_history FOR EACH ROW WHEN (NEW.action='update') EXECUTE FUNCTION reject_incremental_history()",
    );
    try {
      await expect(
        as(() =>
          transactions.addSplit(user, source.id, split, view.fingerprint!),
        ),
      ).rejects.toBeDefined();
      expect(await lines(source.id)).toHaveLength(2);
      expect(await schedules(source.id)).toEqual([
        { id: schedule.id, splitId: original[0].id, revision: 1 },
      ]);
      expect(await balance()).toBe("-200.0000");
    } finally {
      await h.owner.query(
        "DROP TRIGGER reject_incremental_history ON action_history",
      );
      await h.owner.query("DROP FUNCTION reject_incremental_history()");
    }
  });
  it("keeps cash-only mutations compatible and applies owned tags on added lines", async () => {
    const source = await create();
    const tag = randomUUID();
    await h.owner.query(
      "INSERT INTO tags(id,user_id,name) VALUES($1,$2,'Cash line')",
      [tag, user],
    );
    const first = await as(() =>
      transactions.addSplit(user, source.id, {
        amount: -600,
        categoryId: category,
        tagIds: [tag],
      }),
    );
    await as(() =>
      transactions.addSplit(user, source.id, {
        amount: -600,
        categoryId: category,
      }),
    );
    expect(
      await h.owner.query(
        "SELECT tag_id FROM transaction_split_tags WHERE transaction_split_id=$1",
        [first.id],
      ),
    ).toEqual([{ tag_id: tag }]);
    await as(() => transactions.removeSplit(user, source.id, first.id));
    expect(await lines(source.id)).toHaveLength(0);
    expect(await schedules(source.id)).toHaveLength(0);
    expect(
      await h.owner.query(
        "SELECT id FROM action_history WHERE user_id=$1 AND action='update'",
        [user],
      ),
    ).toHaveLength(0);
    expect(await balance()).toBe("-200.0000");
  });
  it("refuses incremental mixed transfer history before changing lines or linked legs", async () => {
    const other = (
      await createTestAccount(h.owner, user, {
        name: "Target",
        openingBalance: 0,
        currentBalance: 0,
      })
    ).id;
    const source = await as(() =>
      transactions.create(user, {
        accountId: account,
        currencyCode: "USD",
        transactionDate: "2026-06-15",
        amount: -1200,
        splits: [
          { amount: -600, categoryId: category },
          { amount: -600, transferAccountId: other },
        ],
      }),
    );
    await settlePendingHistoryWrites();
    const original = await lines(source.id);
    const categoryLine = original.find(
      (line: { kind: string }) => line.kind === "category",
    );
    await accrue(source.id, categoryLine.id);
    await expect(
      preview(source.id, { operation: "remove", splitId: categoryLine.id }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      as(() =>
        transactions.addSplit(user, source.id, {
          amount: 0,
          categoryId: category,
        }),
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(await lines(source.id)).toEqual(original);
    expect(await schedules(source.id)).toHaveLength(1);
    expect(await balance()).toBe("-200.0000");
  });
  it("serializes concurrent removals of one reviewed split without double history or deletion", async () => {
    const source = await create(3);
    const original = await lines(source.id);
    await accrue(source.id, original[0].id);
    const view = await preview(source.id, {
      operation: "remove",
      splitId: original[0].id,
    });
    const results = await Promise.allSettled([
      as(() =>
        transactions.removeSplit(
          user,
          source.id,
          original[0].id,
          view.fingerprint!,
        ),
      ),
      as(() =>
        transactions.removeSplit(
          user,
          source.id,
          original[0].id,
          view.fingerprint!,
        ),
      ),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(await lines(source.id)).toHaveLength(2);
    expect(await schedules(source.id)).toHaveLength(0);
    expect(
      await h.owner.query(
        "SELECT id FROM action_history WHERE user_id=$1 AND action='update'",
        [user],
      ),
    ).toHaveLength(1);
    expect(await balance()).toBe("-200.0000");
  });
  it("refuses preview and mutation when the reconciled-source lock is enabled", async () => {
    const source = await create(2);
    const original = await lines(source.id);
    await accrue(source.id, original[0].id);
    await as(() => transactions.reconcile(user, source.id));
    await h.owner.query(
      "INSERT INTO user_preferences(user_id,lock_reconciled_transactions) VALUES($1,true) ON CONFLICT(user_id) DO UPDATE SET lock_reconciled_transactions=true",
      [user],
    );
    await expect(
      preview(source.id, { operation: "remove", splitId: original[0].id }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      as(() => transactions.removeSplit(user, source.id, original[0].id)),
    ).rejects.toMatchObject({ status: 409 });
    expect(await lines(source.id)).toHaveLength(2);
    expect(await schedules(source.id)).toHaveLength(1);
  });
});
