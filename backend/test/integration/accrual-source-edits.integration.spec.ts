import { randomUUID } from "node:crypto";
import { TransactionStatus } from "@/transactions/entities/transaction.entity";
import { TransactionsModule } from "@/transactions/transactions.module";
import { TransactionsService } from "@/transactions/transactions.service";
import { AccrualsService } from "@/accruals/accruals.service";
import type { BulkUpdateDto } from "@/transactions/dto/bulk-update.dto";
import type { UpdateTransactionDto } from "@/transactions/dto/update-transaction.dto";
import { withUserContext } from "@/common/db/with-context";
import {
  ActionHistoryService,
  settlePendingHistoryWrites,
} from "@/action-history/action-history.service";
import { createTestAccount } from "../helpers/test-factories";
import {
  createEnforcedIntegrationModule,
  createTestUserDirect,
  cleanTables,
  type EnforcedIntegrationHarness,
} from "../helpers/integration-setup";

describe("accruals through actual transaction edit services", () => {
  jest.setTimeout(180000);
  let h: EnforcedIntegrationHarness;
  let history: ActionHistoryService;
  let transactions: TransactionsService;
  let accruals: AccrualsService;
  let user: string;
  let account: string;
  let category: string;
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
  async function create(split = false) {
    return as(() =>
      transactions.create(user, {
        accountId: account,
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
  async function accrue(sourceTransactionId: string, sourceSplitId?: string) {
    const input = {
      sourceTransactionId,
      sourceSplitId,
      preset: "NTM" as const,
    };
    const view = await as(() => accruals.preview(user, input));
    return as(() =>
      accruals.save(user, {
        ...input,
        fingerprint: view.fingerprint,
        expectedRevision: view.expectedRevision,
        expectedScheduleId: view.expectedScheduleId,
      }),
    );
  }
  async function reviewed(id: string, patch: UpdateTransactionDto) {
    const preview = await as(() => accruals.previewSourceEdit(user, id, patch));
    expect(preview.fingerprint).not.toBeNull();
    return { ...patch, accrualImpactFingerprint: preview.fingerprint! };
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
        name: "Fixture",
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
  it("refuses an unreviewed status-only VOID without changing cash or schedule", async () => {
    const source = await create();
    const schedule = await accrue(source.id);
    await expect(
      as(() =>
        transactions.updateStatus(user, source.id, TransactionStatus.VOID),
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(await balance()).toBe("-200.0000");
    const rows = await h.owner.query(
      "SELECT status FROM transactions WHERE id=$1",
      [source.id],
    );
    expect(rows[0].status).not.toBe(TransactionStatus.VOID);
    expect(
      (await as(() => accruals.detail(user, schedule.id))).schedule.revision,
    ).toBe(1);
  });
  it("reviews VOID and reactivation, preserves schedule identity and rejects replay", async () => {
    const source = await create();
    const schedule = await accrue(source.id);
    const patch = await reviewed(source.id, { status: TransactionStatus.VOID });
    await as(() =>
      transactions.updateStatus(
        user,
        source.id,
        TransactionStatus.VOID,
        patch.accrualImpactFingerprint,
      ),
    );
    expect(await balance()).toBe("1000.0000");
    expect(
      (await as(() => accruals.detail(user, schedule.id))).schedule.revision,
    ).toBe(2);
    await expect(
      as(() =>
        transactions.updateStatus(
          user,
          source.id,
          TransactionStatus.UNRECONCILED,
          patch.accrualImpactFingerprint,
        ),
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(await balance()).toBe("1000.0000");
    const restore = await reviewed(source.id, {
      status: TransactionStatus.UNRECONCILED,
    });
    await as(() =>
      transactions.updateStatus(
        user,
        source.id,
        TransactionStatus.UNRECONCILED,
        restore.accrualImpactFingerprint,
      ),
    );
    expect(await balance()).toBe("-200.0000");
    const detail = await as(() => accruals.detail(user, schedule.id));
    expect(detail.schedule.revision).toBe(3);
    expect(detail.plan.amount).toBe("-1200.0000");
  });
  it("refreshes clearing and reconciliation metadata without a financial review", async () => {
    const source = await create();
    const schedule = await accrue(source.id);
    await as(() => transactions.markCleared(user, source.id, true));
    expect(
      (await as(() => accruals.detail(user, schedule.id))).schedule.revision,
    ).toBe(2);
    await as(() => transactions.reconcile(user, source.id));
    expect(
      (await as(() => accruals.detail(user, schedule.id))).schedule.revision,
    ).toBe(3);
    await as(() => transactions.unreconcile(user, source.id));
    expect(
      (await as(() => accruals.detail(user, schedule.id))).schedule.revision,
    ).toBe(4);
    expect(await balance()).toBe("-200.0000");
  });
  it("keeps both split schedules through a reviewed parent VOID", async () => {
    const source = await create(true);
    const rows: { id: string }[] = await h.owner.query(
      "SELECT id FROM transaction_splits WHERE transaction_id=$1 ORDER BY id",
      [source.id],
    );
    const schedules = await Promise.all(
      rows.map((row) => accrue(source.id, row.id)),
    );
    const preview = await as(() =>
      accruals.previewSourceEdit(user, source.id, {
        status: TransactionStatus.VOID,
      }),
    );
    expect(preview.impacts).toHaveLength(2);
    for (const impact of preview.impacts) {
      expect(impact.removed).toBe(false);
      expect(impact.timingBalances.every((row) => row.after === "0.0000")).toBe(
        true,
      );
    }
    await as(() =>
      transactions.updateStatus(
        user,
        source.id,
        TransactionStatus.VOID,
        preview.fingerprint!,
      ),
    );
    expect(await balance()).toBe("1000.0000");
    for (const schedule of schedules) {
      const detail = await as(() => accruals.detail(user, schedule.id));
      expect(detail.schedule.revision).toBe(2);
      expect(detail.plan.amount).toBe("-600.0000");
    }
  });
  async function bulkReview(dto: BulkUpdateDto) {
    const view = await as(() => transactions.previewBulkUpdate(user, dto));
    expect(view.fingerprint).not.toBeNull();
    return {
      view,
      dto: { ...dto, accrualImpactFingerprint: view.fingerprint! },
    };
  }
  it("previews bulk category changes without writing and requires review before commit", async () => {
    const source = await create();
    const schedule = await accrue(source.id);
    const income = randomUUID();
    await h.owner.query(
      "INSERT INTO categories(id,user_id,name,is_income) VALUES($1,$2,'Income',true)",
      [income, user],
    );
    const input: BulkUpdateDto = {
      mode: "ids",
      transactionIds: [source.id],
      categoryId: income,
    };
    await expect(
      as(() => transactions.bulkUpdate(user, input)),
    ).rejects.toMatchObject({ status: 409 });
    const { view, dto } = await bulkReview(input);
    expect(view.impacts[0].schedules[0]).toMatchObject({
      familyBefore: "expense",
      familyAfter: "income",
    });
    expect(
      (await as(() => accruals.detail(user, schedule.id))).schedule.revision,
    ).toBe(1);
    expect(await balance()).toBe("-200.0000");
    await as(() => transactions.bulkUpdate(user, dto));
    const detail = await as(() => accruals.detail(user, schedule.id));
    expect(detail.schedule.family).toBe("income");
    expect(detail.schedule.revision).toBe(2);
    expect(detail.plan.amount).toBe("-1200.0000");
    expect(await balance()).toBe("-200.0000");
  });
  it("honors category-filter restrictions for scheduled split lines", async () => {
    const source = await create(true);
    const lines: { id: string }[] = await h.owner.query(
      "SELECT id FROM transaction_splits WHERE transaction_id=$1 ORDER BY id",
      [source.id],
    );
    const other = randomUUID();
    const income = randomUUID();
    await h.owner.query(
      "INSERT INTO categories(id,user_id,name,is_income) VALUES($1,$3,'Other',false),($2,$3,'Income',true)",
      [other, income, user],
    );
    await h.owner.query(
      "UPDATE transaction_splits SET category_id=$1 WHERE id=$2",
      [other, lines[1].id],
    );
    const first = await accrue(source.id, lines[0].id);
    const second = await accrue(source.id, lines[1].id);
    const { view, dto } = await bulkReview({
      mode: "ids",
      transactionIds: [source.id],
      categoryId: income,
      categoryFilterIds: [category],
    });
    expect(
      view.impacts[0].schedules.find((s) => s.sourceSplitId === lines[0].id)
        ?.familyAfter,
    ).toBe("income");
    expect(
      view.impacts[0].schedules.find((s) => s.sourceSplitId === lines[1].id)
        ?.familyAfter,
    ).toBe("expense");
    await as(() => transactions.bulkUpdate(user, dto));
    expect(
      (await as(() => accruals.detail(user, first.id))).schedule.family,
    ).toBe("income");
    const unchanged = await as(() => accruals.detail(user, second.id));
    expect(unchanged.schedule.family).toBe("expense");
    expect(unchanged.schedule.revision).toBe(1);
  });
  it("refuses altered selection or fields and stale source/schedule previews", async () => {
    const source = await create();
    await accrue(source.id);
    const other = await create();
    const { dto } = await bulkReview({
      mode: "ids",
      transactionIds: [source.id],
      description: "Reviewed",
    });
    await expect(
      as(() =>
        transactions.bulkUpdate(user, { ...dto, description: "Different" }),
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      as(() =>
        transactions.bulkUpdate(user, {
          ...dto,
          transactionIds: [source.id, other.id],
        }),
      ),
    ).rejects.toMatchObject({ status: 409 });
    const edit = await reviewed(source.id, { amount: -2400 });
    await as(() => transactions.update(user, source.id, edit));
    await expect(
      as(() => transactions.bulkUpdate(user, dto)),
    ).rejects.toMatchObject({ status: 409 });
    const rows = await h.owner.query(
      "SELECT description FROM transactions WHERE id=$1",
      [source.id],
    );
    expect(rows[0].description).not.toBe("Reviewed");
  });
  it("refreshes every accrued source in a reviewed metadata batch", async () => {
    const first = await create();
    const second = await create();
    const firstSchedule = await accrue(first.id);
    const secondSchedule = await accrue(second.id);
    const { view, dto } = await bulkReview({
      mode: "filter",
      filters: { accountIds: [account] },
      description: "Batch metadata",
    });
    expect(view.impacts).toHaveLength(2);
    await as(() => transactions.bulkUpdate(user, dto));
    for (const schedule of [firstSchedule, secondSchedule]) {
      expect(
        (await as(() => accruals.detail(user, schedule.id))).schedule.revision,
      ).toBe(2);
    }
    expect(await balance()).toBe("-1400.0000");
  });
  it("rejects filter selection drift between preview and commit", async () => {
    const source = await create();
    await accrue(source.id);
    const { dto } = await bulkReview({
      mode: "filter",
      filters: { accountIds: [account] },
      description: "Batch",
    });
    await create();
    await expect(
      as(() => transactions.bulkUpdate(user, dto)),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("keeps cash and recognition atomic for a reviewed bulk VOID", async () => {
    const source = await create();
    const schedule = await accrue(source.id);
    const { dto, view } = await bulkReview({
      mode: "ids",
      transactionIds: [source.id],
      status: TransactionStatus.VOID,
    });
    expect(
      view.impacts[0].schedules[0].timingBalances.every(
        (row) => row.after === "0.0000",
      ),
    ).toBe(true);
    await as(() => transactions.bulkUpdate(user, dto));
    expect(await balance()).toBe("1000.0000");
    expect(
      (await as(() => accruals.detail(user, schedule.id))).schedule.revision,
    ).toBe(2);
    await expect(
      as(() => transactions.bulkUpdate(user, dto)),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("rolls back bulk bank and status writes when a later tag write fails", async () => {
    const source = await create();
    const schedule = await accrue(source.id);
    const { dto } = await bulkReview({
      mode: "ids",
      transactionIds: [source.id],
      status: TransactionStatus.VOID,
      tagIds: [randomUUID()],
    });
    await expect(
      as(() => transactions.bulkUpdate(user, dto)),
    ).rejects.toBeDefined();
    expect(await balance()).toBe("-200.0000");
    const rows = await h.owner.query(
      "SELECT status FROM transactions WHERE id=$1",
      [source.id],
    );
    expect(rows[0].status).not.toBe(TransactionStatus.VOID);
    expect(
      (await as(() => accruals.detail(user, schedule.id))).schedule.revision,
    ).toBe(1);
  });
  it("undoes and redoes bulk family changes with the same linked schedule", async () => {
    const source = await create();
    const schedule = await accrue(source.id);
    const income = randomUUID();
    await h.owner.query(
      "INSERT INTO categories(id,user_id,name,is_income) VALUES($1,$2,'Income',true)",
      [income, user],
    );
    const { dto } = await bulkReview({
      mode: "ids",
      transactionIds: [source.id],
      categoryId: income,
    });
    await as(() => transactions.bulkUpdate(user, dto));
    await settlePendingHistoryWrites();
    await as(() => history.undo(user));
    let detail = await as(() => accruals.detail(user, schedule.id));
    expect(detail.schedule.family).toBe("expense");
    expect(detail.schedule.revision).toBe(3);
    expect(detail.plan.amount).toBe("-1200.0000");
    await as(() => history.redo(user));
    detail = await as(() => accruals.detail(user, schedule.id));
    expect(detail.schedule.family).toBe("income");
    expect(detail.schedule.revision).toBe(4);
    expect(await balance()).toBe("-200.0000");
  });
  it("undoes and redoes restricted split recategorization without losing either schedule", async () => {
    const source = await create(true);
    const lines: { id: string }[] = await h.owner.query(
      "SELECT id FROM transaction_splits WHERE transaction_id=$1 ORDER BY id",
      [source.id],
    );
    const other = randomUUID(),
      income = randomUUID();
    await h.owner.query(
      "INSERT INTO categories(id,user_id,name,is_income) VALUES($1,$3,'Other',false),($2,$3,'Income',true)",
      [other, income, user],
    );
    await h.owner.query(
      "UPDATE transaction_splits SET category_id=$1 WHERE id=$2",
      [other, lines[1].id],
    );
    const first = await accrue(source.id, lines[0].id);
    const second = await accrue(source.id, lines[1].id);
    const { dto } = await bulkReview({
      mode: "ids",
      transactionIds: [source.id],
      categoryId: income,
      categoryFilterIds: [category],
    });
    await as(() => transactions.bulkUpdate(user, dto));
    await settlePendingHistoryWrites();
    await as(() => history.undo(user));
    expect(
      (await as(() => accruals.detail(user, first.id))).schedule.family,
    ).toBe("expense");
    expect(
      (await as(() => accruals.detail(user, second.id))).schedule.revision,
    ).toBe(1);
    await as(() => history.redo(user));
    expect(
      (await as(() => accruals.detail(user, first.id))).schedule.family,
    ).toBe("income");
    expect(
      (await as(() => accruals.detail(user, second.id))).schedule.revision,
    ).toBe(1);
  });
  it("undoes and redoes a bulk VOID with matching cash and accrual status", async () => {
    const source = await create();
    const schedule = await accrue(source.id);
    const { dto } = await bulkReview({
      mode: "ids",
      transactionIds: [source.id],
      status: TransactionStatus.VOID,
    });
    await as(() => transactions.bulkUpdate(user, dto));
    await settlePendingHistoryWrites();
    await as(() => history.undo(user));
    expect(await balance()).toBe("-200.0000");
    expect(
      (await as(() => accruals.detail(user, schedule.id))).schedule.revision,
    ).toBe(3);
    await as(() => history.redo(user));
    expect(await balance()).toBe("1000.0000");
    expect(
      (await as(() => accruals.detail(user, schedule.id))).schedule.revision,
    ).toBe(4);
  });
  it("refuses bulk undo of a locked reconciled accrued source before changing history", async () => {
    const source = await create();
    const schedule = await accrue(source.id);
    const { dto } = await bulkReview({
      mode: "ids",
      transactionIds: [source.id],
      description: "Current",
    });
    await as(() => transactions.bulkUpdate(user, dto));
    await settlePendingHistoryWrites();
    await h.owner.query(
      "UPDATE transactions SET status='RECONCILED' WHERE id=$1",
      [source.id],
    );
    await h.owner.query(
      "INSERT INTO user_preferences(user_id,lock_reconciled_transactions) VALUES($1,true) ON CONFLICT(user_id) DO UPDATE SET lock_reconciled_transactions=true",
      [user],
    );
    await expect(as(() => history.undo(user))).rejects.toMatchObject({
      status: 409,
    });
    const rows = await h.owner.query(
      "SELECT is_undone FROM action_history WHERE user_id=$1 AND action='bulk_update'",
      [user],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].is_undone).toBe(false);
    expect(
      (await as(() => accruals.detail(user, schedule.id))).schedule.revision,
    ).toBe(2);
    expect(await balance()).toBe("-200.0000");
  });
  it("rolls back history and restored source fields when accrual refresh refuses", async () => {
    const source = await create();
    const schedule = await accrue(source.id);
    const { dto } = await bulkReview({
      mode: "ids",
      transactionIds: [source.id],
      description: "Current",
    });
    await as(() => transactions.bulkUpdate(user, dto));
    await settlePendingHistoryWrites();
    // Simulate a direct writer not yet integrated with accruals.
    await h.owner.query(
      "UPDATE transactions SET is_transfer=true WHERE id=$1",
      [source.id],
    );
    await expect(as(() => history.undo(user))).rejects.toMatchObject({
      status: 400,
    });
    const rows = await h.owner.query(
      "SELECT description FROM transactions WHERE id=$1",
      [source.id],
    );
    expect(rows[0].description).toBe("Current");
    const actions = await h.owner.query(
      "SELECT is_undone FROM action_history WHERE user_id=$1 AND action='bulk_update'",
      [user],
    );
    expect(actions[0].is_undone).toBe(false);
    expect(
      (await as(() => accruals.detail(user, schedule.id))).schedule.revision,
    ).toBe(2);
    expect(await balance()).toBe("-200.0000");
  });
  it("requires impact review before changing an accrued source, with no partial bank movement", async () => {
    const source = await create();
    const schedule = await accrue(source.id);
    expect(await balance()).toBe("-200.0000");
    await expect(
      as(() => transactions.update(user, source.id, { amount: -2400 })),
    ).rejects.toMatchObject({ status: 409 });
    expect(await balance()).toBe("-200.0000");
    expect(
      (await as(() => accruals.detail(user, schedule.id))).plan.amount,
    ).toBe("-1200.0000");
  });
  it("updates the source, recognition and bank balance together after reviewed amount/date edits", async () => {
    const source = await create();
    const schedule = await accrue(source.id);
    const input = { amount: -2400, transactionDate: "2026-05-15" };
    const preview = await as(() =>
      accruals.previewSourceEdit(user, source.id, input),
    );
    expect(
      preview.impacts[0].timingBalances.find(
        (row) => row.asOf === "2026-06-15",
      ),
    ).toEqual({ asOf: "2026-06-15", before: "1200.0000", after: "2200.0000" });
    const patch = { ...input, accrualImpactFingerprint: preview.fingerprint! };
    await as(() => transactions.update(user, source.id, patch));
    const detail = await as(() => accruals.detail(user, schedule.id));
    expect(detail.plan.amount).toBe("-2400.0000");
    expect(detail.plan.allocations[0]).toMatchObject({
      recognitionDate: "2026-05-31",
      amount: "-200.0000",
    });
    expect(detail.schedule.revision).toBe(2);
    expect(await balance()).toBe("-1400.0000");
  });
  it("rejects a token for a different edit and does not create an unreviewed payee", async () => {
    const source = await create();
    await accrue(source.id);
    const patch = await reviewed(source.id, { amount: -2400 });
    await expect(
      as(() =>
        transactions.update(user, source.id, { ...patch, amount: -3000 }),
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      as(() =>
        transactions.update(
          user,
          source.id,
          { payeeName: "Unreviewed new payee" },
          { createPayeeIfMissing: true },
        ),
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      await h.owner.query("SELECT id FROM payees WHERE user_id=$1", [user]),
    ).toEqual([]);
    expect(await balance()).toBe("-200.0000");
  });
  it("retains category split identities and their schedules when the main editor reorders lines", async () => {
    const source = await create(true);
    const rows = await h.owner.query(
      "SELECT id,memo FROM transaction_splits WHERE transaction_id=$1 ORDER BY memo",
      [source.id],
    );
    const first = await accrue(source.id, rows[0].id);
    const second = await accrue(source.id, rows[1].id);
    const splits = [
      { id: rows[1].id, amount: -300, categoryId: category, memo: "B revised" },
      { id: rows[0].id, amount: -900, categoryId: category, memo: "A revised" },
    ];
    const patch = await reviewed(source.id, { splits });
    await as(() => transactions.update(user, source.id, patch));
    const a = await as(() => accruals.detail(user, first.id));
    const b = await as(() => accruals.detail(user, second.id));
    expect(a.source.splitId).toBe(rows[0].id);
    expect(a.plan.amount).toBe("-900.0000");
    expect(b.source.splitId).toBe(rows[1].id);
    expect(b.plan.amount).toBe("-300.0000");
    expect(await balance()).toBe("-200.0000");
  });
  it("retains the same scheduled line through the dedicated split editor", async () => {
    const source = await create(true);
    const rows = await h.owner.query(
      "SELECT id,memo FROM transaction_splits WHERE transaction_id=$1 ORDER BY memo",
      [source.id],
    );
    const schedule = await accrue(source.id, rows[0].id);
    const splits = [
      { id: rows[0].id, amount: -900, categoryId: category },
      { id: rows[1].id, amount: -300, categoryId: category },
    ];
    const patch = await reviewed(source.id, { splits });
    await as(() =>
      transactions.updateSplits(
        user,
        source.id,
        splits,
        patch.accrualImpactFingerprint,
      ),
    );
    const detail = await as(() => accruals.detail(user, schedule.id));
    expect(detail.source.splitId).toBe(rows[0].id);
    expect(detail.plan.amount).toBe("-900.0000");
  });
  it("requires explicit review before a replacement drops a scheduled source line", async () => {
    const source = await create(true);
    const [line] = await h.owner.query(
      "SELECT id FROM transaction_splits WHERE transaction_id=$1 ORDER BY id",
      [source.id],
    );
    await accrue(source.id, line.id);
    const splits = [
      { amount: -600, categoryId: category },
      { amount: -600, categoryId: category },
    ];
    await expect(
      as(() => transactions.updateSplits(user, source.id, splits)),
    ).rejects.toMatchObject({ status: 409 });
    const preview = await as(() =>
      accruals.previewSourceEdit(user, source.id, { splits }),
    );
    expect(preview.impacts[0].removed).toBe(true);
    await as(() =>
      transactions.updateSplits(user, source.id, splits, preview.fingerprint!),
    );
    expect(
      await h.owner.query("SELECT id FROM accrual_schedules WHERE user_id=$1", [
        user,
      ]),
    ).toEqual([]);
    expect(
      await h.owner.query(
        "SELECT id FROM accrual_allocations WHERE user_id=$1",
        [user],
      ),
    ).toEqual([]);
    expect(await balance()).toBe("-200.0000");
  });
  it("refuses duplicate or foreign split IDs before replacement", async () => {
    const source = await create(true);
    const [line] = await h.owner.query(
      "SELECT id FROM transaction_splits WHERE transaction_id=$1",
      [source.id],
    );
    const splits = [
      { id: line.id, amount: -600, categoryId: category },
      { id: line.id, amount: -600, categoryId: category },
    ];
    await expect(
      as(() => accruals.previewSourceEdit(user, source.id, { splits })),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      as(() =>
        accruals.previewSourceEdit(user, source.id, {
          splits: [{ id: randomUUID(), amount: -1200 }],
        }),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
  it("deletes source-linked schedules and recognition through normal transaction deletion", async () => {
    const source = await create();
    await accrue(source.id);
    await as(() => transactions.remove(user, source.id));
    expect(
      await h.owner.query("SELECT id FROM accrual_schedules WHERE user_id=$1", [
        user,
      ]),
    ).toEqual([]);
    expect(
      await h.owner.query(
        "SELECT id FROM accrual_allocations WHERE user_id=$1",
        [user],
      ),
    ).toEqual([]);
    expect(await balance()).toBe("1000.0000");
  });
});
