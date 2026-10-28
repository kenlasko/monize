import { randomUUID } from "node:crypto";
import { TransactionsModule } from "@/transactions/transactions.module";
import { TransactionsService } from "@/transactions/transactions.service";
import { AccrualsService } from "@/accruals/accruals.service";
import {
  ActionHistoryService,
  settlePendingHistoryWrites,
} from "@/action-history/action-history.service";
import { withUserContext } from "@/common/db/with-context";
import type { AccrualPreviewDto } from "@/accruals/dto/accrual-command.dto";
import { createTestAccount } from "../helpers/test-factories";
import {
  createEnforcedIntegrationModule,
  createTestUserDirect,
  cleanTables,
  type EnforcedIntegrationHarness,
} from "../helpers/integration-setup";

describe("versioned accrual bulk deletion through actual services", () => {
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
  const schedules = () =>
    h.owner.query(
      'SELECT id,source_transaction_id AS "sourceId",source_split_id AS "splitId" FROM accrual_schedules WHERE user_id=$1 ORDER BY id',
      [user],
    );
  const sources = () =>
    h.owner.query("SELECT id FROM transactions WHERE user_id=$1 ORDER BY id", [
      user,
    ]);
  const actions = () =>
    h.owner.query(
      "SELECT id,is_undone,before_data FROM action_history WHERE user_id=$1 AND action='bulk_delete'",
      [user],
    );
  async function create(split = false, accountId = account) {
    return as(() =>
      transactions.create(user, {
        accountId,
        currencyCode: "USD",
        transactionDate: "2026-06-15",
        amount: -1200,
        ...(split
          ? {
              splits: [
                { amount: -600, categoryId: category, memo: "A" },
                { amount: -600, categoryId: category, memo: "B" },
              ],
            }
          : { categoryId: category }),
      }),
    );
  }
  async function accrue(id: string, splitId?: string, custom = false) {
    const input: AccrualPreviewDto = {
      sourceTransactionId: id,
      sourceSplitId: splitId,
      ...(custom
        ? { preset: "CUSTOM", startMonth: "2025-01", monthCount: 24 }
        : { preset: "NTM" }),
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
  async function remove(ids: string[]) {
    await settlePendingHistoryWrites();
    return as(() =>
      transactions.bulkDelete(user, { mode: "ids", transactionIds: ids }),
    );
  }
  async function pair() {
    const first = await create(),
      second = await create();
    await accrue(first.id);
    await remove([first.id, second.id]);
    return { first, second };
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
        name: "Bulk history",
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
  it("round-trips a batch of exact custom accruals, category splits/tags and cash rows repeatedly", async () => {
    const first = await create(),
      split = await create(true),
      cash = await create();
    await h.owner.query(
      "UPDATE transactions SET amount=-1200.0001 WHERE id=$1",
      [first.id],
    );
    await h.owner.query(
      "UPDATE accounts SET current_balance=-2600.0001 WHERE id=$1",
      [account],
    );
    const lines: { id: string }[] = await h.owner.query(
      "SELECT id FROM transaction_splits WHERE transaction_id=$1 ORDER BY memo",
      [split.id],
    );
    const tag = randomUUID();
    await h.owner.query(
      "INSERT INTO tags(id,user_id,name) VALUES($1,$2,'Property')",
      [tag, user],
    );
    await h.owner.query(
      "INSERT INTO transaction_split_tags(transaction_split_id,tag_id) VALUES($1,$2)",
      [lines[0].id, tag],
    );
    const oldFirst = await accrue(first.id, undefined, true);
    await accrue(split.id, lines[0].id);
    expect(await remove([first.id, split.id, cash.id])).toEqual({ deleted: 3 });
    expect(await sources()).toHaveLength(0);
    expect(await balance()).toBe("1000.0000");
    expect((await actions())[0].before_data.accrualBulkDeleteVersion).toBe(1);
    for (let cycle = 0; cycle < 2; cycle++) {
      await as(() => history.undo(user));
      expect(await sources()).toHaveLength(3);
      const restored = await schedules();
      expect(restored).toHaveLength(2);
      const firstSchedule = restored.find(
        (row: { sourceId: string }) => row.sourceId === first.id,
      );
      expect(firstSchedule.id).not.toBe(oldFirst.id);
      const detail = await as(() => accruals.detail(user, firstSchedule.id));
      expect(detail.plan.amount).toBe("-1200.0001");
      expect(detail.plan.monthCount).toBe(24);
      expect(detail.plan.allocations[23].amount).toBe("-50.0001");
      expect(
        await h.owner.query(
          "SELECT tag_id FROM transaction_split_tags WHERE transaction_split_id=$1",
          [lines[0].id],
        ),
      ).toEqual([{ tag_id: tag }]);
      expect(await balance()).toBe("-2600.0001");
      await as(() => history.redo(user));
      expect(await sources()).toHaveLength(0);
      expect(await schedules()).toHaveLength(0);
      expect(await balance()).toBe("1000.0000");
    }
  });
  it("records exactly the filter-selected deletion set", async () => {
    const first = await create(),
      excluded = await create();
    await accrue(first.id);
    await settlePendingHistoryWrites();
    await as(() =>
      transactions.bulkDelete(user, {
        mode: "filter",
        filters: { accountIds: [account] },
        excludedIds: [excluded.id],
      }),
    );
    expect(await sources()).toEqual([{ id: excluded.id }]);
    await as(() => history.undo(user));
    expect(await sources()).toHaveLength(2);
    await as(() => history.redo(user));
    expect(await sources()).toEqual([{ id: excluded.id }]);
    expect(await balance()).toBe("-200.0000");
  });
  it("refuses a batch with unsupported transfer structure before deleting any row", async () => {
    const first = await create();
    await accrue(first.id);
    const other = (
      await createTestAccount(h.owner, user, {
        name: "Target",
        openingBalance: 0,
        currentBalance: 0,
      })
    ).id;
    const mixed = await as(() =>
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
    const before = await sources();
    await expect(remove([first.id, mixed.id])).rejects.toMatchObject({
      status: 409,
    });
    expect(await sources()).toEqual(before);
    expect(await schedules()).toHaveLength(1);
    expect(await actions()).toHaveLength(0);
    expect(await balance()).toBe("-1400.0000");
  });
  it("refuses snapshots over the history limit before deleting anything", async () => {
    const first = await create(),
      second = await create();
    await accrue(first.id);
    await h.owner.query(
      "UPDATE transactions SET description=repeat('x',300000) WHERE id=ANY($1)",
      [[first.id, second.id]],
    );
    await expect(remove([first.id, second.id])).rejects.toMatchObject({
      status: 409,
    });
    expect(await sources()).toHaveLength(2);
    expect(await schedules()).toHaveLength(1);
    expect(await actions()).toHaveLength(0);
    expect(await balance()).toBe("-1400.0000");
  });
  it("rolls back deletion, schedules and balances if required history insertion fails", async () => {
    const first = await create(),
      second = await create();
    await accrue(first.id);
    await settlePendingHistoryWrites();
    await h.owner.query(
      "CREATE FUNCTION reject_accrual_bulk_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'history insert failure fixture'; END $$",
    );
    await h.owner.query(
      "CREATE TRIGGER reject_accrual_bulk_history BEFORE INSERT ON action_history FOR EACH ROW WHEN (NEW.action='bulk_delete') EXECUTE FUNCTION reject_accrual_bulk_history()",
    );
    try {
      await expect(remove([first.id, second.id])).rejects.toBeDefined();
      expect(await sources()).toHaveLength(2);
      expect(await schedules()).toHaveLength(1);
      expect(await actions()).toHaveLength(0);
      expect(await balance()).toBe("-1400.0000");
    } finally {
      await h.owner.query(
        "DROP TRIGGER reject_accrual_bulk_history ON action_history",
      );
      await h.owner.query("DROP FUNCTION reject_accrual_bulk_history()");
    }
  });
  it("checks every account before undo so a late currency mismatch cannot partially restore the batch", async () => {
    const other = (
      await createTestAccount(h.owner, user, {
        name: "Other",
        openingBalance: 0,
        currentBalance: 0,
      })
    ).id;
    const first = await create(),
      second = await create(false, other);
    await accrue(first.id);
    await remove([first.id, second.id]);
    await h.owner.query(
      "INSERT INTO currencies(code,name,symbol,decimal_places) VALUES('EUR','Euro','EUR',2) ON CONFLICT DO NOTHING",
    );
    await h.owner.query("UPDATE accounts SET currency_code='EUR' WHERE id=$1", [
      other,
    ]);
    await expect(as(() => history.undo(user))).rejects.toMatchObject({
      status: 409,
    });
    expect(await sources()).toHaveLength(0);
    expect(await schedules()).toHaveLength(0);
    expect((await actions())[0].is_undone).toBe(false);
    await h.owner.query("UPDATE accounts SET currency_code='USD' WHERE id=$1", [
      other,
    ]);
    await as(() => history.undo(user));
    expect(await sources()).toHaveLength(2);
    expect(await schedules()).toHaveLength(1);
  });
  it("refuses redo after an unmaintained cash-row edit without deleting any restored source", async () => {
    const { second } = await pair();
    await as(() => history.undo(user));
    await h.owner.query(
      "UPDATE transactions SET description='Changed after restore' WHERE id=$1",
      [second.id],
    );
    await expect(as(() => history.redo(user))).rejects.toMatchObject({
      status: 409,
    });
    expect(await sources()).toHaveLength(2);
    expect(await schedules()).toHaveLength(1);
    expect((await actions())[0].is_undone).toBe(true);
    expect(await balance()).toBe("-1400.0000");
  });
  it("refuses redo after a restored schedule changes", async () => {
    const { first } = await pair();
    await as(() => history.undo(user));
    const input: AccrualPreviewDto = {
      sourceTransactionId: first.id,
      preset: "LTM",
    };
    const preview = await as(() => accruals.preview(user, input));
    await as(() =>
      accruals.save(user, {
        ...input,
        fingerprint: preview.fingerprint,
        expectedScheduleId: preview.expectedScheduleId,
        expectedRevision: preview.expectedRevision,
      }),
    );
    await expect(as(() => history.redo(user))).rejects.toMatchObject({
      status: 409,
    });
    expect(await sources()).toHaveLength(2);
    expect(await balance()).toBe("-1400.0000");
  });
  it("refuses undo collisions rather than overwriting or skipping an existing row", async () => {
    const { first } = await pair();
    await h.owner.query(
      "INSERT INTO transactions(id,user_id,account_id,transaction_date,amount,currency_code) VALUES($1,$2,$3,'2026-06-15',0,'USD')",
      [first.id, user, account],
    );
    await expect(as(() => history.undo(user))).rejects.toMatchObject({
      status: 409,
    });
    expect(await sources()).toEqual([{ id: first.id }]);
    expect(await schedules()).toHaveLength(0);
    expect((await actions())[0].is_undone).toBe(false);
  });
  it("serializes simultaneous undo requests so one restores the batch and one conflicts", async () => {
    await pair();
    const blocker = h.owner.createQueryRunner();
    await blocker.connect();
    await blocker.startTransaction();
    await blocker.query("SELECT pg_advisory_xact_lock(9,hashtext($1))", [user]);
    const first = as(() => history.undo(user)),
      second = as(() => history.undo(user));
    try {
      let waiting = 0;
      for (let attempt = 0; attempt < 80 && waiting < 2; attempt++) {
        waiting = Number(
          (
            await h.owner.query(
              "SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND classid=9 AND NOT granted",
            )
          )[0].count,
        );
        if (waiting < 2)
          await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(waiting).toBe(2);
      await blocker.commitTransaction();
      const results = await Promise.allSettled([first, second]);
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      const rejected = results.find(
        (result) => result.status === "rejected",
      ) as PromiseRejectedResult;
      expect(rejected.reason).toMatchObject({ status: 409 });
      expect(await sources()).toHaveLength(2);
      expect(await schedules()).toHaveLength(1);
      expect(await balance()).toBe("-1400.0000");
    } finally {
      if (blocker.isTransactionActive) await blocker.rollbackTransaction();
      await Promise.allSettled([first, second]);
      await blocker.release();
    }
  });
});
