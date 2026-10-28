import { randomUUID } from "node:crypto";
import { TransactionsModule } from "@/transactions/transactions.module";
import { TransactionsService } from "@/transactions/transactions.service";
import { PayeesService } from "@/payees/payees.service";
import { PayeeAutoMergeService } from "@/payees/payee-auto-merge.service";
import { AccrualsService } from "@/accruals/accruals.service";
import { settlePendingHistoryWrites } from "@/action-history/action-history.service";
import { withUserContext } from "@/common/db/with-context";
import { createTestAccount } from "../helpers/test-factories";
import {
  createEnforcedIntegrationModule,
  createTestUserDirect,
  cleanTables,
  type EnforcedIntegrationHarness,
} from "../helpers/integration-setup";

describe("payee metadata accrual maintenance through actual services", () => {
  jest.setTimeout(180000);
  let h: EnforcedIntegrationHarness,
    transactions: TransactionsService,
    payees: PayeesService,
    auto: PayeeAutoMergeService,
    accruals: AccrualsService;
  let user: string, account: string, category: string;
  const as = <T>(fn: () => Promise<T>) => withUserContext(user, fn);
  const payee = (name: string) => as(() => payees.create(user, { name }));
  async function create(payeeId: string, split = false) {
    const tx = await as(() =>
      transactions.create(user, {
        accountId: account,
        currencyCode: "USD",
        transactionDate: "2026-06-15",
        amount: -1200,
        payeeId,
        ...(split
          ? {
              splits: [
                { categoryId: category, amount: -600 },
                { categoryId: category, amount: -600 },
              ],
            }
          : { categoryId: category }),
      }),
    );
    await settlePendingHistoryWrites();
    const lines: { id: string }[] = split
      ? await h.owner.query(
          "SELECT id FROM transaction_splits WHERE transaction_id=$1 ORDER BY id",
          [tx.id],
        )
      : [];
    const input = {
      sourceTransactionId: tx.id,
      sourceSplitId: lines[0]?.id,
      preset: "NTM" as const,
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
    return { tx, input, lines };
  }
  async function state(id: string) {
    const rows = await h.owner.query(
      `SELECT s.id,s.revision,s.source_fingerprint AS fingerprint,
       s.source_split_id AS "splitId",s.family,s.start_month AS "startMonth",
       s.month_count AS "monthCount",
       (SELECT jsonb_agg(jsonb_build_array(a.recognition_date,a.amount::text) ORDER BY a.period_index)
        FROM accrual_allocations a WHERE a.schedule_id=s.id) AS allocations
       FROM accrual_schedules s WHERE s.source_transaction_id=$1 ORDER BY s.id`,
      [id],
    );
    return rows[0];
  }
  const bank = async () =>
    (
      await h.owner.query(
        "SELECT current_balance::text AS amount FROM accounts WHERE id=$1",
        [account],
      )
    )[0].amount;
  function unchanged(before: any, after: any) {
    expect(after).toEqual({
      ...before,
      revision: before.revision + 1,
      fingerprint: expect.any(String),
    });
    expect(after.fingerprint).not.toBe(before.fingerprint);
  }
  beforeAll(async () => {
    h = await createEnforcedIntegrationModule([TransactionsModule]);
    transactions = h.module.get(TransactionsService);
    payees = h.module.get(PayeesService);
    auto = h.module.get(PayeeAutoMergeService);
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
        name: "Payee metadata",
        openingBalance: 1000,
        currentBalance: 1000,
      })
    ).id;
    category = randomUUID();
    await h.owner.query(
      "INSERT INTO categories(id,user_id,name,is_income) VALUES($1,$2,'Tax',false)",
      [category, user],
    );
  });
  it("refreshes renamed source metadata without changing allocations or bank balances", async () => {
    const p = await payee("Original tax office");
    const { tx } = await create(p.id);
    const before = await state(tx.id),
      balance = await bank();
    await as(() => payees.update(user, p.id, { name: "Renamed tax office" }));
    unchanged(before, await state(tx.id));
    expect(
      (
        await h.owner.query("SELECT payee_name FROM transactions WHERE id=$1", [
          tx.id,
        ])
      )[0].payee_name,
    ).toBe("Renamed tax office");
    expect(await bank()).toBe(balance);
  });
  it("maintains category-split schedule identity and allocations during a manual merge", async () => {
    const source = await payee("Source"),
      target = await payee("Canonical");
    const { tx, lines } = await create(source.id, true);
    const before = await state(tx.id),
      balance = await bank();
    const result = await as(() =>
      payees.mergePayees(user, {
        sourcePayeeId: source.id,
        targetPayeeId: target.id,
      }),
    );
    expect(result.transactionsMigrated).toBe(1);
    unchanged(before, await state(tx.id));
    expect((await state(tx.id)).splitId).toBe(lines[0].id);
    expect(
      (
        await h.owner.query(
          "SELECT payee_id,payee_name FROM transactions WHERE id=$1",
          [tx.id],
        )
      )[0],
    ).toEqual({ payee_id: target.id, payee_name: target.name });
    expect(await bank()).toBe(balance);
  });
  it("refreshes all source and canonical schedules during a renamed automatic merge", async () => {
    const source = await payee("Branch"),
      canonical = await payee("Main");
    const first = await create(source.id),
      second = await create(canonical.id, true);
    const before = [await state(first.tx.id), await state(second.tx.id)],
      balance = await bank();
    const result = await as(() =>
      auto.applyAutoMerge(user, [
        {
          canonicalPayeeId: canonical.id,
          sourcePayeeIds: [source.id],
          canonicalName: "Merged office",
        },
      ]),
    );
    expect(result.failures).toEqual([]);
    expect(result.groupsMerged).toBe(1);
    unchanged(before[0], await state(first.tx.id));
    unchanged(before[1], await state(second.tx.id));
    expect(await bank()).toBe(balance);
  });
  it("invalidates a preview made before a payee rename", async () => {
    const p = await payee("Old");
    const { input, tx } = await create(p.id);
    const preview = await as(() => accruals.preview(user, input));
    await as(() => payees.update(user, p.id, { name: "New" }));
    const current = await state(tx.id);
    await expect(
      as(() =>
        accruals.save(user, {
          ...input,
          fingerprint: preview.fingerprint,
          expectedScheduleId: preview.expectedScheduleId,
          expectedRevision: preview.expectedRevision,
        }),
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(await state(tx.id)).toEqual(current);
  });
  it("rolls back payee and transaction changes when schedule refresh fails", async () => {
    const p = await payee("Rollback");
    const { tx } = await create(p.id),
      before = await state(tx.id),
      balance = await bank();
    const beforeSource = (
      await h.owner.query(
        "SELECT payee_id,payee_name FROM transactions WHERE id=$1",
        [tx.id],
      )
    )[0];
    await h.owner
      .query(`CREATE FUNCTION reject_payee_accrual_refresh() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'required refresh failure'; END $$`);
    await h.owner.query(
      "CREATE TRIGGER reject_payee_accrual_refresh BEFORE UPDATE ON accrual_schedules FOR EACH ROW EXECUTE FUNCTION reject_payee_accrual_refresh()",
    );
    try {
      await expect(
        as(() => payees.update(user, p.id, { name: "Must roll back" })),
      ).rejects.toThrow();
      expect(await state(tx.id)).toEqual(before);
      expect(
        (await h.owner.query("SELECT name FROM payees WHERE id=$1", [p.id]))[0]
          .name,
      ).toBe("Rollback");
      expect(
        (
          await h.owner.query(
            "SELECT payee_id,payee_name FROM transactions WHERE id=$1",
            [tx.id],
          )
        )[0],
      ).toEqual(beforeSource);
      expect(await bank()).toBe(balance);
    } finally {
      await h.owner.query(
        "DROP TRIGGER reject_payee_accrual_refresh ON accrual_schedules",
      );
      await h.owner.query("DROP FUNCTION reject_payee_accrual_refresh()");
    }
  });
  it("does not change another owner's payee or schedule", async () => {
    const p = await payee("Owned"),
      { tx } = await create(p.id);
    const before = await state(tx.id),
      outsider = (await createTestUserDirect(h.owner)).id;
    await expect(
      withUserContext(outsider, () =>
        payees.update(outsider, p.id, { name: "Foreign" }),
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(await state(tx.id)).toEqual(before);
  });
});
