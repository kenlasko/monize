import { TransactionStatus } from "@/transactions/entities/transaction.entity";
import { randomUUID } from "node:crypto";
import { TransactionsModule } from "@/transactions/transactions.module";
import { TransactionsService } from "@/transactions/transactions.service";
import { PayeesService } from "@/payees/payees.service";
import { AccrualsService } from "@/accruals/accruals.service";
import { settlePendingHistoryWrites } from "@/action-history/action-history.service";
import { withUserContext } from "@/common/db/with-context";
import type { UpdatePayeeDto } from "@/payees/dto/update-payee.dto";
import { createTestAccount } from "../helpers/test-factories";
import {
  createEnforcedIntegrationModule,
  createTestUserDirect,
  cleanTables,
  type EnforcedIntegrationHarness,
} from "../helpers/integration-setup";

describe("reviewed payee category backfills through actual services", () => {
  jest.setTimeout(180000);
  let h: EnforcedIntegrationHarness,
    transactions: TransactionsService,
    payees: PayeesService,
    accruals: AccrualsService;
  let user: string,
    account: string,
    expense: string,
    income: string,
    payeeId: string;
  const as = <T>(fn: () => Promise<T>) => withUserContext(user, fn);
  const preview = (dto: UpdatePayeeDto) =>
    as(() => payees.previewCategoryImpact(user, payeeId, dto));
  const update = (dto: UpdatePayeeDto) =>
    as(() => payees.update(user, payeeId, dto));
  const bank = async () =>
    (
      await h.owner.query(
        "SELECT current_balance::text AS amount FROM accounts WHERE id=$1",
        [account],
      )
    )[0].amount;
  async function source(categoryId: string | null = expense, split = false) {
    const tx = await as(() =>
      transactions.create(user, {
        accountId: account,
        currencyCode: "USD",
        transactionDate: "2026-06-15",
        amount: -1200.0001,
        payeeId,
        payeeName: "Tax office",
        ...(split
          ? {
              splits: [
                { amount: -600, categoryId: expense },
                { amount: -600.0001, categoryId: expense },
              ],
            }
          : categoryId
            ? { categoryId }
            : {}),
      }),
    );
    await settlePendingHistoryWrites();
    return tx;
  }
  async function accrue(
    id: string,
    splitId?: string,
    preset: "NTM" | "LTM" = "NTM",
  ) {
    const input = {
      sourceTransactionId: id,
      sourceSplitId: splitId,
      preset,
      family: "expense" as const,
    };
    const p = await as(() => accruals.preview(user, input));
    await as(() =>
      accruals.save(user, {
        ...input,
        fingerprint: p.fingerprint,
        expectedScheduleId: p.expectedScheduleId,
        expectedRevision: p.expectedRevision,
      }),
    );
  }
  const state = async (id: string) =>
    (
      await h.owner.query(
        `SELECT s.id,s.revision,s.family,s.source_fingerprint AS fingerprint,
     (SELECT jsonb_agg(jsonb_build_array(a.recognition_date,a.amount::text) ORDER BY a.period_index)
      FROM accrual_allocations a WHERE a.schedule_id=s.id) AS allocations
     FROM accrual_schedules s WHERE s.source_transaction_id=$1 ORDER BY s.id`,
        [id],
      )
    )[0];
  const payee = async () =>
    (
      await h.owner.query(
        "SELECT name,default_category_id FROM payees WHERE id=$1",
        [payeeId],
      )
    )[0];
  const category = async (id: string) =>
    (
      await h.owner.query("SELECT category_id FROM transactions WHERE id=$1", [
        id,
      ])
    )[0].category_id;
  beforeAll(async () => {
    h = await createEnforcedIntegrationModule([TransactionsModule]);
    transactions = h.module.get(TransactionsService);
    payees = h.module.get(PayeesService);
    accruals = new AccrualsService(h.app);
  });
  afterAll(async () => {
    await settlePendingHistoryWrites();
    if (h) await h.close();
  });
  beforeEach(async () => {
    await settlePendingHistoryWrites();
    await cleanTables(h.owner, [
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
        name: "Backfill",
        openingBalance: 1000,
        currentBalance: 1000,
      })
    ).id;
    expense = randomUUID();
    income = randomUUID();
    await h.owner.query(
      "INSERT INTO categories(id,user_id,name,is_income) VALUES($1,$3,'Expense',false),($2,$3,'Income',true)",
      [expense, income, user],
    );
    payeeId = (await as(() => payees.create(user, { name: "Tax office" }))).id;
  });
  it("reviews family/timing changes and atomically refreshes exact schedules with the cash selection", async () => {
    const tx = await source(),
      cash = await source();
    await accrue(tx.id);
    const before = await state(tx.id),
      balance = await bank();
    const dto: UpdatePayeeDto = {
      defaultCategoryId: income,
      applyCategoryToTransactions: "all",
    };
    const p = await preview(dto);
    expect(p.transactionIds.sort()).toEqual([tx.id, cash.id].sort());
    expect(p.impacts[0].schedules[0]).toMatchObject({
      familyBefore: "expense",
      familyAfter: "income",
      removed: false,
    });
    expect(p.impacts[0].schedules[0].timingBalances.length).toBeGreaterThan(0);
    await expect(update(dto)).rejects.toMatchObject({ status: 409 });
    expect((await payee()).default_category_id).toBeNull();
    expect(await category(tx.id)).toBe(expense);
    const result = await update({
      ...dto,
      accrualImpactFingerprint: p.fingerprint!,
    });
    expect(result.transactionsCategorized).toBe(2);
    const after = await state(tx.id);
    expect(after).toMatchObject({
      id: before.id,
      revision: before.revision + 1,
      family: "income",
      allocations: before.allocations,
    });
    expect(after.fingerprint).not.toBe(before.fingerprint);
    expect(await category(cash.id)).toBe(income);
    expect((await payee()).default_category_id).toBe(income);
    expect(await bank()).toBe(balance);
  });
  it("limits uncategorized mode and leaves category splits and existing categories intact", async () => {
    const uncategorized = await source(null),
      categorized = await source(),
      split = await source(expense, true);
    await accrue(uncategorized.id);
    await accrue(categorized.id);
    const line = (
      await h.owner.query(
        "SELECT id FROM transaction_splits WHERE transaction_id=$1 ORDER BY id",
        [split.id],
      )
    )[0].id;
    await accrue(split.id, line);
    const retained = [await state(categorized.id), await state(split.id)];
    const dto: UpdatePayeeDto = {
      defaultCategoryId: income,
      applyCategoryToTransactions: "uncategorized",
    };
    const p = await preview(dto);
    expect(p.transactionIds).toEqual([uncategorized.id]);
    await update({ ...dto, accrualImpactFingerprint: p.fingerprint! });
    expect(await category(uncategorized.id)).toBe(income);
    expect(await category(categorized.id)).toBe(expense);
    expect(await state(categorized.id)).toEqual(retained[0]);
    expect(await state(split.id)).toEqual(retained[1]);
  });
  it("rejects a changed category, mode, or rename before changing the payee or sources", async () => {
    const tx = await source();
    await accrue(tx.id);
    const dto: UpdatePayeeDto = {
      defaultCategoryId: income,
      applyCategoryToTransactions: "all",
    };
    const p = await preview(dto),
      before = await state(tx.id);
    for (const patch of [
      { defaultCategoryId: expense },
      { applyCategoryToTransactions: "uncategorized" as const },
      { name: "Changed" },
    ])
      await expect(
        update({ ...dto, ...patch, accrualImpactFingerprint: p.fingerprint! }),
      ).rejects.toMatchObject({ status: 409 });
    expect(await state(tx.id)).toEqual(before);
    expect(await payee()).toEqual({
      name: "Tax office",
      default_category_id: null,
    });
  });
  it("rejects a changed selected set even when the accrued source is unchanged", async () => {
    const tx = await source();
    await accrue(tx.id);
    const dto: UpdatePayeeDto = {
      defaultCategoryId: income,
      applyCategoryToTransactions: "all",
    };
    const p = await preview(dto),
      cash = await source();
    await expect(
      update({ ...dto, accrualImpactFingerprint: p.fingerprint! }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await category(cash.id)).toBe(expense);
    expect((await payee()).default_category_id).toBeNull();
  });
  it("rejects a stale schedule revision and a changed cash-only sibling snapshot", async () => {
    const tx = await source(),
      cash = await source();
    await accrue(tx.id);
    const dto: UpdatePayeeDto = {
      defaultCategoryId: income,
      applyCategoryToTransactions: "all",
    };
    let p = await preview(dto);
    await accrue(tx.id, undefined, "LTM");
    await expect(
      update({ ...dto, accrualImpactFingerprint: p.fingerprint! }),
    ).rejects.toMatchObject({ status: 409 });
    p = await preview(dto);
    await h.owner.query(
      "UPDATE transactions SET description='Intervening edit' WHERE id=$1",
      [cash.id],
    );
    await expect(
      update({ ...dto, accrualImpactFingerprint: p.fingerprint! }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await category(tx.id)).toBe(expense);
  });
  it("reads the current default under lock and refuses a default changed since preview", async () => {
    const tx = await source();
    await accrue(tx.id);
    await update({ defaultCategoryId: income });
    const dto: UpdatePayeeDto = { applyCategoryToTransactions: "all" };
    const p = await preview(dto);
    await update({ defaultCategoryId: expense });
    await expect(
      update({ ...dto, accrualImpactFingerprint: p.fingerprint! }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await preview(dto)).categoryId).toBe(expense);
    expect(await category(tx.id)).toBe(expense);
  });
  it("rolls back payee fields and all category writes when schedule maintenance fails", async () => {
    const tx = await source(),
      cash = await source();
    await accrue(tx.id);
    const dto: UpdatePayeeDto = {
      defaultCategoryId: income,
      applyCategoryToTransactions: "all",
      name: "Must roll back",
    };
    const p = await preview(dto),
      before = await state(tx.id),
      balance = await bank();
    await h.owner
      .query(`CREATE FUNCTION reject_payee_category_refresh() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'required category refresh failure'; END $$`);
    await h.owner.query(
      "CREATE TRIGGER reject_payee_category_refresh BEFORE UPDATE ON accrual_schedules FOR EACH ROW EXECUTE FUNCTION reject_payee_category_refresh()",
    );
    try {
      await expect(
        update({ ...dto, accrualImpactFingerprint: p.fingerprint! }),
      ).rejects.toThrow();
      expect(await state(tx.id)).toEqual(before);
      expect(await category(tx.id)).toBe(expense);
      expect(await category(cash.id)).toBe(expense);
      expect(await payee()).toEqual({
        name: "Tax office",
        default_category_id: null,
      });
      expect(await bank()).toBe(balance);
    } finally {
      await h.owner.query(
        "DROP TRIGGER reject_payee_category_refresh ON accrual_schedules",
      );
      await h.owner.query("DROP FUNCTION reject_payee_category_refresh()");
    }
  });
  it("enforces the reconciled lock before preview or mutation", async () => {
    const tx = await source();
    await accrue(tx.id);
    await as(() =>
      transactions.updateStatus(user, tx.id, TransactionStatus.RECONCILED),
    );
    await h.owner.query(
      "INSERT INTO user_preferences(user_id,lock_reconciled_transactions) VALUES($1,true) ON CONFLICT(user_id) DO UPDATE SET lock_reconciled_transactions=true",
      [user],
    );
    const dto: UpdatePayeeDto = {
      defaultCategoryId: income,
      applyCategoryToTransactions: "all",
    };
    await expect(preview(dto)).rejects.toMatchObject({ status: 409 });
    await expect(update(dto)).rejects.toMatchObject({ status: 409 });
    expect((await payee()).default_category_id).toBeNull();
    expect(await category(tx.id)).toBe(expense);
  });
  it("keeps cash-only backfills usable without a fingerprint and does not touch transfer rows", async () => {
    const tx = await source(null),
      other = await source();
    await h.owner.query(
      "UPDATE transactions SET is_transfer=true WHERE id=$1",
      [other.id],
    );
    const dto: UpdatePayeeDto = {
      defaultCategoryId: income,
      applyCategoryToTransactions: "all",
    };
    const p = await preview(dto);
    expect(p.fingerprint).toBeNull();
    expect(p.transactionIds).toEqual([tx.id]);
    expect((await update(dto)).transactionsCategorized).toBe(1);
    expect(await category(other.id)).toBe(expense);
  });
  it("rejects foreign categories and payees without changing either source", async () => {
    const tx = await source();
    await accrue(tx.id);
    const outsider = (await createTestUserDirect(h.owner)).id,
      foreign = randomUUID();
    await h.owner.query(
      "INSERT INTO categories(id,user_id,name,is_income) VALUES($1,$2,'Foreign',true)",
      [foreign, outsider],
    );
    const dto: UpdatePayeeDto = {
      defaultCategoryId: foreign,
      applyCategoryToTransactions: "all",
    };
    await expect(preview(dto)).rejects.toMatchObject({ status: 404 });
    await expect(update(dto)).rejects.toMatchObject({ status: 404 });
    await expect(
      withUserContext(outsider, () =>
        payees.previewCategoryImpact(outsider, payeeId, dto),
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(await category(tx.id)).toBe(expense);
    expect((await payee()).default_category_id).toBeNull();
  });
  it("commits a reviewed combined rename and category change with exact final schedules", async () => {
    const tx = await source();
    await accrue(tx.id);
    const before = await state(tx.id),
      balance = await bank();
    const dto: UpdatePayeeDto = {
      name: "Renamed office",
      defaultCategoryId: income,
      applyCategoryToTransactions: "all",
    };
    const p = await preview(dto);
    await update({ ...dto, accrualImpactFingerprint: p.fingerprint! });
    const after = await state(tx.id);
    expect(after.id).toBe(before.id);
    expect(after.family).toBe("income");
    expect(after.allocations).toEqual(before.allocations);
    expect(after.revision).toBeGreaterThan(before.revision);
    expect(
      (
        await h.owner.query("SELECT payee_name FROM transactions WHERE id=$1", [
          tx.id,
        ])
      )[0].payee_name,
    ).toBe("Renamed office");
    expect(await payee()).toEqual({
      name: "Renamed office",
      default_category_id: income,
    });
    expect(await bank()).toBe(balance);
  });
  it("serializes simultaneous confirmations so a reviewed category change applies once", async () => {
    const tx = await source();
    await accrue(tx.id);
    const before = await state(tx.id),
      balance = await bank();
    const dto: UpdatePayeeDto = {
      defaultCategoryId: income,
      applyCategoryToTransactions: "all",
    };
    const p = await preview(dto),
      command = { ...dto, accrualImpactFingerprint: p.fingerprint! };
    const results = await Promise.allSettled([
      update(command),
      update(command),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    const rejected = results.find(
      (result) => result.status === "rejected",
    ) as PromiseRejectedResult;
    expect(rejected.reason.status).toBe(409);
    expect((await state(tx.id)).revision).toBe(before.revision + 1);
    expect(await category(tx.id)).toBe(income);
    expect(await bank()).toBe(balance);
  });
});
