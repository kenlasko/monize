import { createAccrualTaxonomyFixture } from "../helpers/accrual-taxonomy-fixture";
import { withUserContext } from "@/common/db/with-context";
import { createTestUserDirect } from "../helpers/integration-setup";
import type { TransactionsService } from "@/transactions/transactions.service";

describe("recognition register through actual authorized query (PostgreSQL)", () => {
  jest.setTimeout(180000);
  let f: Awaited<ReturnType<typeof createAccrualTaxonomyFixture>>;
  beforeAll(async () => {
    f = await createAccrualTaxonomyFixture();
  });
  beforeEach(async () => f.reset());
  afterAll(async () => f?.close());
  function list(
    options: {
      basis?: "cash" | "accrual";
      page?: number;
      limit?: number;
      start?: string;
      end?: string;
      categories?: string[];
      search?: string;
      direction?: "ASC" | "DESC";
      sort?: "date" | "amount";
      target?: string;
    } = {},
  ) {
    const args: Parameters<TransactionsService["findAll"]> = [
      f.user,
      [f.account],
      options.start,
      options.end,
      options.categories,
      undefined,
      options.page ?? 1,
      options.limit ?? 50,
      false,
      options.search,
      options.target,
      undefined,
      undefined,
      undefined,
      undefined,
      options.sort ?? "date",
      options.direction ?? "ASC",
      undefined,
      undefined,
      undefined,
      [],
      undefined,
      options.basis ?? "accrual",
    ];
    return f.as(() => f.transactions.findAll(...args));
  }
  it("pages stable recognition ids without payments duplicated or bank-balance seeds", async () => {
    const { tx } = await f.source();
    await f.accrue(tx.id);
    const bank = await f.bank();
    const first = await list({ limit: 5 });
    const second = await list({ page: 2, limit: 5 });
    const last = await list({ page: 3, limit: 5 });
    const all = [...first.data, ...second.data, ...last.data];
    expect(first.pagination.total).toBe(12);
    expect(all).toHaveLength(12);
    expect(new Set(all.map((x) => x.id)).size).toBe(12);
    expect(all[0].transactionDate).toBe("2026-06-30");
    expect(all[11].transactionDate).toBe("2027-05-31");
    expect(all[0].reportingProvenance).toMatchObject({
      readOnly: true,
      sourceTransactionId: tx.id,
      cashDate: "2026-06-15",
    });
    expect(first.startingBalance).toBeUndefined();
    expect(await f.bank()).toBe(bank);
    expect((await list()).data.map((x) => x.id)).toEqual(all.map((x) => x.id));
    const cash = await list({ basis: "cash" });
    expect(cash.data).toHaveLength(1);
    expect(cash.data[0].id).toBe(tx.id);
  });
  it("filters effective dates and keeps unscheduled split components at the payment date", async () => {
    const { tx, lines } = await f.source({
      splitCategories: [f.root, f.other],
    });
    await f.accrue(tx.id, lines[0].id);
    const payment = await list({ start: "2026-06-15", end: "2026-06-15" });
    expect(payment.data).toHaveLength(1);
    expect(Number(payment.data[0].amount)).toBe(-600.0001);
    expect(payment.data[0].reportingProvenance?.isRecognition).toBe(false);
    expect(payment.data[0].splits).toHaveLength(1);
    expect(payment.data[0].splits[0].categoryId).toBe(f.other);
    const recognition = await list({
      start: "2026-06-30",
      end: "2026-06-30",
      categories: [f.root],
    });
    expect(recognition.data[0].reportingProvenance?.isRecognition).toBe(true);
    expect(recognition.pagination.total).toBe(1);
    expect(Number(recognition.data[0].amount)).toBe(-50);
    expect(recognition.data[0].splits).toHaveLength(1);
    expect(
      recognition.data[0].splits[0].reportingProvenance?.sourceSplitId,
    ).toBe(lines[0].id);
  });
  it("uses the same search and ordering filters on projected rows", async () => {
    const { tx } = await f.source();
    await f.accrue(tx.id);
    const rows = await list({
      search: "Tax",
      start: "2026-07-01",
      end: "2026-08-31",
      direction: "DESC",
    });
    expect(rows.pagination.total).toBe(2);
    expect(rows.data.map((x) => x.transactionDate)).toEqual([
      "2026-08-31",
      "2026-07-31",
    ]);
    expect((await list({ search: "nonexistent" })).pagination.total).toBe(0);
    await expect(list({ target: tx.id })).rejects.toThrow("cash view");
  });
  it("cannot read a foreign user's schedule in another user context", async () => {
    const { tx } = await f.source();
    await f.accrue(tx.id);
    const other = (await createTestUserDirect(f.h.owner)).id;
    const result = await withUserContext(other, () =>
      f.transactions.findAll(
        other,
        [f.account],
        undefined,
        undefined,
        undefined,
        undefined,
        1,
        50,
        false,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "date",
        "ASC",
        undefined,
        undefined,
        undefined,
        [],
        undefined,
        "accrual",
      ),
    );
    expect(result.data).toEqual([]);
    expect(result.pagination.total).toBe(0);
  });
  it("reflects reviewed source edits and schedule removal without stale rows", async () => {
    const { tx } = await f.source();
    await f.accrue(tx.id);
    const patch = { amount: -2400 };
    const impact = await f.as(() =>
      f.accruals.previewSourceEdit(f.user, tx.id, patch),
    );
    const fingerprint = impact.fingerprint;
    if (!fingerprint) throw new Error("Expected a reviewed scheduled source");
    await f.as(() =>
      f.transactions.update(f.user, tx.id, {
        ...patch,
        accrualImpactFingerprint: fingerprint,
      }),
    );
    const updated = await list();
    expect(updated.data).toHaveLength(12);
    expect(updated.data.every((row) => Number(row.amount) === -200)).toBe(true);
    const schedule = (await f.states(tx.id))[0];
    const detail = await f.as(() => f.accruals.detail(f.user, schedule.id));
    await f.as(() =>
      f.accruals.remove(f.user, schedule.id, {
        expectedRevision: detail.schedule.revision,
        fingerprint: detail.fingerprint,
      }),
    );
    const removed = await list();
    expect(removed.data).toHaveLength(1);
    expect(Number(removed.data[0].amount)).toBe(-2400);
    expect(removed.data[0].id).toBe(tx.id);
    expect(removed.data[0].reportingProvenance).toBeUndefined();
  });
  it("lists forward income and retrospective expenses on recognition dates", async () => {
    const { tx } = await f.source({ categoryId: f.income });
    await f.as(() => f.transactions.update(f.user, tx.id, { amount: 2400 }));
    const input = {
      sourceTransactionId: tx.id,
      preset: "NTM" as const,
      family: "income" as const,
    };
    const preview = await f.as(() => f.accruals.preview(f.user, input));
    await f.as(() =>
      f.accruals.save(f.user, {
        ...input,
        fingerprint: preview.fingerprint,
        expectedScheduleId: preview.expectedScheduleId,
        expectedRevision: preview.expectedRevision,
      }),
    );
    const income = await list();
    expect(income.pagination.total).toBe(12);
    expect(income.data.every((row) => Number(row.amount) === 200)).toBe(true);
    const { tx: expense } = await f.source();
    const ltm = {
      sourceTransactionId: expense.id,
      preset: "LTM" as const,
      family: "expense" as const,
    };
    const before = await f.as(() => f.accruals.preview(f.user, ltm));
    await f.as(() =>
      f.accruals.save(f.user, {
        ...ltm,
        fingerprint: before.fingerprint,
        expectedScheduleId: before.expectedScheduleId,
        expectedRevision: before.expectedRevision,
      }),
    );
    const past = await list({ start: "2025-07-01", end: "2026-05-31" });
    expect(past.pagination.total).toBe(11);
    expect(
      past.data.every(
        (row) => row.reportingProvenance?.sourceTransactionId === expense.id,
      ),
    ).toBe(true);
  });
  it("projects only readable joint schedules and honors revocation under RLS", async () => {
    const { tx } = await f.source();
    await f.accrue(tx.id);
    const member = (await createTestUserDirect(f.h.owner)).id;
    await f.h.owner.query(
      "INSERT INTO user_preferences(user_id,accrual_enabled,reporting_basis) VALUES($1,true,'accrual') ON CONFLICT(user_id) DO UPDATE SET accrual_enabled=true,reporting_basis='accrual'",
      [member],
    );
    const [delegation] = await f.h.owner.query(
      "INSERT INTO account_delegates(owner_user_id,delegate_user_id,status) VALUES($1,$2,'active') RETURNING id",
      [f.user, member],
    );
    await f.h.owner.query(
      "INSERT INTO account_delegate_grants(delegation_id,account_id,can_read,is_joint) VALUES($1,$2,true,true)",
      [delegation.id, f.account],
    );
    const readJoint = () =>
      withUserContext(member, () =>
        f.transactions.findAll(
          member,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          1,
          50,
          false,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          "date",
          "ASC",
          undefined,
          undefined,
          undefined,
          [f.account],
          undefined,
          "accrual",
        ),
      );
    const visible = await readJoint();
    expect(visible.pagination.total).toBe(12);
    expect(
      visible.data.every(
        (row) => row.reportingProvenance?.sourceTransactionId === tx.id,
      ),
    ).toBe(true);
    await f.h.owner.query(
      "UPDATE account_delegate_grants SET can_read=false WHERE delegation_id=$1",
      [delegation.id],
    );
    const revoked = await readJoint();
    expect(revoked.data).toEqual([]);
    expect(revoked.pagination.total).toBe(0);
  });
});
