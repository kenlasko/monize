import { randomUUID } from "node:crypto";
import { TransactionsModule } from "@/transactions/transactions.module";
import { TransactionsService } from "@/transactions/transactions.service";
import { AccrualsService } from "@/accruals/accruals.service";
import {
  ActionHistoryService,
  settlePendingHistoryWrites,
} from "@/action-history/action-history.service";
import { withUserContext } from "@/common/db/with-context";
import type { UpdateTransactionDto } from "@/transactions/dto/update-transaction.dto";
import type { AccrualPreviewDto } from "@/accruals/dto/accrual-command.dto";
import { createTestAccount } from "../helpers/test-factories";
import {
  createEnforcedIntegrationModule,
  createTestUserDirect,
  cleanTables,
  type EnforcedIntegrationHarness,
} from "../helpers/integration-setup";

describe("accrual structural history through actual services", () => {
  jest.setTimeout(180000);
  let h: EnforcedIntegrationHarness,
    transactions: TransactionsService,
    accruals: AccrualsService,
    history: ActionHistoryService;
  let user: string, account: string, category: string;
  const as = <T>(fn: () => Promise<T>) => withUserContext(user, fn);
  const rows = (id: string) =>
    h.owner.query(
      'SELECT id,source_split_id AS "splitId",revision,preset,month_count AS "monthCount" FROM accrual_schedules WHERE source_transaction_id=$1 ORDER BY id',
      [id],
    );
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
  async function accrue(id: string, splitId?: string, custom = false) {
    const input: AccrualPreviewDto = {
      sourceTransactionId: id,
      sourceSplitId: splitId,
      ...(custom
        ? { preset: "CUSTOM", startMonth: "2025-01", monthCount: 24 }
        : { preset: "NTM" }),
    };
    const preview = await as(() => accruals.preview(user, input));
    const command = {
      ...input,
      fingerprint: preview.fingerprint,
      expectedScheduleId: preview.expectedScheduleId,
      expectedRevision: preview.expectedRevision,
    };
    const saved = await as(() => accruals.save(user, command));
    return { saved, command };
  }
  async function update(id: string, patch: UpdateTransactionDto) {
    const preview = await as(() => accruals.previewSourceEdit(user, id, patch));
    await as(() =>
      transactions.update(user, id, {
        ...patch,
        ...(preview.fingerprint
          ? { accrualImpactFingerprint: preview.fingerprint }
          : {}),
      }),
    );
    await settlePendingHistoryWrites();
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
        name: "History fixture",
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
  it("round-trips an amount/date edit repeatedly without reviving stale schedule revisions", async () => {
    const source = await create();
    const { saved } = await accrue(source.id);
    await update(source.id, { amount: -2400, transactionDate: "2026-05-15" });
    for (let cycle = 0; cycle < 2; cycle++) {
      await as(() => history.undo(user));
      let detail = await as(() => accruals.detail(user, saved.id));
      expect(detail.plan.amount).toBe("-1200.0000");
      expect(detail.plan.startMonth).toBe("2026-06");
      expect(await balance()).toBe("-200.0000");
      await as(() => history.redo(user));
      detail = await as(() => accruals.detail(user, saved.id));
      expect(detail.plan.amount).toBe("-2400.0000");
      expect(detail.plan.startMonth).toBe("2026-05");
      expect(await balance()).toBe("-1400.0000");
    }
  });
  it("restores a deleted source's exact custom plan and rejects pre-deletion preview tokens", async () => {
    const source = await create();
    await h.owner.query(
      "UPDATE transactions SET amount=-1200.0001 WHERE id=$1",
      [source.id],
    );
    await h.owner.query(
      "UPDATE accounts SET current_balance=-200.0001 WHERE id=$1",
      [account],
    );
    const { saved, command } = await accrue(source.id, undefined, true);
    await as(() => transactions.remove(user, source.id));
    await settlePendingHistoryWrites();
    expect(await rows(source.id)).toHaveLength(0);
    await as(() => history.undo(user));
    const restored = (await rows(source.id))[0];
    expect(restored.id).not.toBe(saved.id);
    const detail = await as(() => accruals.detail(user, restored.id));
    expect(detail.plan.amount).toBe("-1200.0001");
    expect(detail.plan.startMonth).toBe("2025-01");
    expect(detail.plan.monthCount).toBe(24);
    expect(
      detail.plan.allocations[detail.plan.allocations.length - 1]?.amount,
    ).toBe("-50.0001");
    expect(await balance()).toBe("-200.0001");
    await expect(as(() => accruals.save(user, command))).rejects.toMatchObject({
      status: 409,
    });
    await as(() => history.redo(user));
    expect(await rows(source.id)).toHaveLength(0);
    expect(await balance()).toBe("1000.0000");
    await as(() => history.undo(user));
    expect(await rows(source.id)).toHaveLength(1);
    expect(await balance()).toBe("-200.0001");
  });
  it("restores removed split identities, their tags and accruals across repeated replacement undo/redo", async () => {
    const source = await create(true);
    const lines: { id: string }[] = await h.owner.query(
      "SELECT id FROM transaction_splits WHERE transaction_id=$1 ORDER BY memo",
      [source.id],
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
    const { saved } = await accrue(source.id, lines[0].id);
    await update(source.id, {
      splits: [
        { amount: -900, categoryId: category },
        { amount: -300, categoryId: category },
      ],
    });
    expect(await rows(source.id)).toHaveLength(0);
    for (let cycle = 0; cycle < 2; cycle++) {
      await as(() => history.undo(user));
      const restored = (await rows(source.id))[0];
      expect(restored.id).not.toBe(saved.id);
      expect(restored.splitId).toBe(lines[0].id);
      const detail = await as(() => accruals.detail(user, restored.id));
      expect(detail.plan.amount).toBe("-600.0000");
      const tags = await h.owner.query(
        "SELECT tag_id FROM transaction_split_tags WHERE transaction_split_id=$1",
        [lines[0].id],
      );
      expect(tags).toEqual([{ tag_id: tag }]);
      await as(() => history.redo(user));
      expect(await rows(source.id)).toHaveLength(0);
    }
    expect(await balance()).toBe("-200.0000");
  });
  it("captures a newly created transaction's accrual before undoing creation and restores it on redo", async () => {
    const source = await create();
    await accrue(source.id);
    await settlePendingHistoryWrites();
    await as(() => history.undo(user));
    expect(await rows(source.id)).toHaveLength(0);
    expect(await balance()).toBe("1000.0000");
    await as(() => history.redo(user));
    expect(await rows(source.id)).toHaveLength(1);
    expect(await balance()).toBe("-200.0000");
    await as(() => history.undo(user));
    await as(() => history.redo(user));
    expect(await rows(source.id)).toHaveLength(1);
  });
  it("rejects a schedule edited after the transaction history entry without changing source or history", async () => {
    const source = await create();
    await accrue(source.id);
    await update(source.id, { amount: -2400 });
    const input: AccrualPreviewDto = {
      sourceTransactionId: source.id,
      preset: "LTM",
    };
    const preview = await as(() => accruals.preview(user, input));
    await as(() =>
      accruals.save(user, {
        ...input,
        fingerprint: preview.fingerprint,
        expectedRevision: preview.expectedRevision,
        expectedScheduleId: preview.expectedScheduleId,
      }),
    );
    await expect(as(() => history.undo(user))).rejects.toMatchObject({
      status: 409,
    });
    expect(await balance()).toBe("-1400.0000");
    const actions = await h.owner.query(
      "SELECT is_undone FROM action_history WHERE user_id=$1 AND action='update'",
      [user],
    );
    expect(actions[0].is_undone).toBe(false);
  });
  it("detects a direct unmaintained source edit before undo overwrites it", async () => {
    const source = await create();
    await accrue(source.id);
    await update(source.id, { amount: -2400 });
    await h.owner.query(
      "UPDATE transactions SET description='External writer' WHERE id=$1",
      [source.id],
    );
    await expect(as(() => history.undo(user))).rejects.toMatchObject({
      status: 409,
    });
    const sourceRows = await h.owner.query(
      "SELECT description,amount::text FROM transactions WHERE id=$1",
      [source.id],
    );
    expect(sourceRows[0]).toEqual({
      description: "External writer",
      amount: "-2400.0000",
    });
    expect(await balance()).toBe("-1400.0000");
  });
  it("keeps new cash-only history backward compatible", async () => {
    const source = await create();
    await update(source.id, { amount: -2400 });
    await as(() => history.undo(user));
    expect(await balance()).toBe("-200.0000");
    await as(() => history.redo(user));
    expect(await balance()).toBe("-1400.0000");
    expect(await rows(source.id)).toHaveLength(0);
  });
  it("refuses unsupported mixed transfer reconstruction before deleting any split or leg", async () => {
    const other = (
      await createTestAccount(h.owner, user, {
        name: "Transfer target",
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
    const lines: {
      id: string;
      kind: string;
      linked_transaction_id: string | null;
    }[] = await h.owner.query(
      "SELECT id,kind,linked_transaction_id FROM transaction_splits WHERE transaction_id=$1 ORDER BY id",
      [source.id],
    );
    const categoryLine = lines.find((line) => line.kind === "category")!;
    await accrue(source.id, categoryLine.id);
    await update(source.id, { description: "Current mixed entry" });
    await expect(as(() => history.undo(user))).rejects.toMatchObject({
      status: 409,
    });
    const after = await h.owner.query(
      "SELECT id,kind,linked_transaction_id FROM transaction_splits WHERE transaction_id=$1 ORDER BY id",
      [source.id],
    );
    expect(after).toEqual(lines);
    expect(await rows(source.id)).toHaveLength(1);
    expect(await balance()).toBe("-200.0000");
  });
  it("refuses to relabel a deleted accrual when its account currency changed", async () => {
    const source = await create();
    await accrue(source.id);
    await as(() => transactions.remove(user, source.id));
    await settlePendingHistoryWrites();
    await h.owner.query(
      "INSERT INTO currencies(code,name,symbol,decimal_places) VALUES('EUR','Euro','EUR',2) ON CONFLICT DO NOTHING",
    );
    await h.owner.query("UPDATE accounts SET currency_code='EUR' WHERE id=$1", [
      account,
    ]);
    await expect(as(() => history.undo(user))).rejects.toMatchObject({
      status: 409,
    });
    expect(await rows(source.id)).toHaveLength(0);
    expect(
      await h.owner.query("SELECT id FROM transactions WHERE id=$1", [
        source.id,
      ]),
    ).toHaveLength(0);
    expect(await balance()).toBe("1000.0000");
  });
  it("refuses malformed saved settings without partially recreating the source", async () => {
    const source = await create();
    await accrue(source.id);
    await as(() => transactions.remove(user, source.id));
    await settlePendingHistoryWrites();
    await h.owner.query(
      "UPDATE action_history SET before_data=jsonb_set(before_data,'{accrualState,schedules,0,monthCount}','601'::jsonb) WHERE user_id=$1 AND action='delete'",
      [user],
    );
    await expect(as(() => history.undo(user))).rejects.toMatchObject({
      status: 409,
    });
    expect(await rows(source.id)).toHaveLength(0);
    expect(
      await h.owner.query("SELECT id FROM transactions WHERE id=$1", [
        source.id,
      ]),
    ).toHaveLength(0);
    expect(await balance()).toBe("1000.0000");
  });
});
