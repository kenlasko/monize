import { createAccrualTaxonomyFixture } from "../helpers/accrual-taxonomy-fixture";
import { createTestUserDirect } from "../helpers/integration-setup";
import { withDelegateContext } from "@/common/db/with-context";
import { randomUUID } from "node:crypto";
describe("Protected accrual system movements under enforced RLS", () => {
  jest.setTimeout(180000);
  let f: Awaited<ReturnType<typeof createAccrualTaxonomyFixture>>;
  beforeAll(async () => {
    f = await createAccrualTaxonomyFixture();
  });
  beforeEach(async () => f.reset());
  afterAll(async () => f?.close());
  async function account() {
    return (await f.as(() => f.accruals.systemBalances(f.user, "2026-06-30")))
      .accounts[0];
  }
  const read = (
    id: string,
    startDate = "2026-06-01",
    endDate = "2026-06-30",
    limit?: number,
  ) =>
    f.as(() =>
      f.accruals.systemMovements(f.user, id, { startDate, endDate, limit }),
    );
  it("reconciles exact opening, payment and recognition movements with as-of balances", async () => {
    const { tx } = await f.source();
    await f.accrue(tx.id);
    const a = await account();
    const june = await read(a.id);
    expect(june).toMatchObject({
      readOnly: true,
      basis: "accrual",
      opening: "0.0000",
      closing: a.balance,
      count: 2,
    });
    expect(june.closing).toBe("1100.0001");
    expect(june.rows).toEqual([
      expect.objectContaining({
        date: "2026-06-15",
        kind: "payment",
        amount: "1200.0001",
        cashDate: "2026-06-15",
      }),
      expect.objectContaining({
        date: "2026-06-30",
        kind: "recognition",
        amount: "-100.0000",
        sourceTransactionId: tx.id,
      }),
    ]);
    expect(await read(a.id, "2026-07-01", "2026-07-31")).toMatchObject({
      opening: "1100.0001",
      closing: "1000.0001",
      count: 1,
    });
    expect(await read(a.id, "2027-05-01", "2027-05-31")).toMatchObject({
      closing: "0.0000",
    });
    const patch = { amount: -2400 };
    const review = await f.as(() =>
      f.accruals.previewSourceEdit(f.user, tx.id, patch),
    );
    await f.as(() =>
      f.transactions.update(f.user, tx.id, {
        ...patch,
        accrualImpactFingerprint: review.fingerprint!,
      }),
    );
    expect(await read(a.id)).toMatchObject({ closing: "2200.0000", count: 2 });
  });
  it("nets retrospective periods to zero after payment while retaining every past movement", async () => {
    const { tx } = await f.source();
    const input = { sourceTransactionId: tx.id, preset: "LTM" as const };
    const p = await f.as(() => f.accruals.preview(f.user, input));
    await f.as(() =>
      f.accruals.save(f.user, {
        ...input,
        fingerprint: p.fingerprint,
        expectedRevision: p.expectedRevision,
        expectedScheduleId: p.expectedScheduleId,
      }),
    );
    const a = await account();
    expect(a.balance).toBe("0.0000");
    expect(await read(a.id, "2025-07-01", "2026-06-30")).toMatchObject({
      opening: "0.0000",
      closing: "0.0000",
      count: 13,
    });
    expect(await read(a.id, "2026-06-01", "2026-06-14")).toMatchObject({
      closing: "-1100.0000",
    });
  });
  it("keeps income liabilities separate and reflects schedule removal immediately", async () => {
    const { tx } = await f.source({ categoryId: f.income });
    await f.as(() => f.transactions.update(f.user, tx.id, { amount: 1200 }));
    const input = { sourceTransactionId: tx.id, preset: "NTM" as const };
    const p = await f.as(() => f.accruals.preview(f.user, input));
    await f.as(() =>
      f.accruals.save(f.user, {
        ...input,
        fingerprint: p.fingerprint,
        expectedRevision: p.expectedRevision,
        expectedScheduleId: p.expectedScheduleId,
      }),
    );
    const a = await account();
    expect(a.family).toBe("income");
    expect(await read(a.id)).toMatchObject({ closing: "1100.0000" });
    const schedules = await f.as(() =>
      f.accruals.sourceSchedules(f.user, tx.id),
    );
    const detail = await f.as(() => f.accruals.detail(f.user, schedules[0].id));
    await f.as(() =>
      f.accruals.remove(f.user, detail.schedule.id, {
        fingerprint: detail.fingerprint,
        expectedRevision: detail.schedule.revision,
      }),
    );
    expect(await read(a.id)).toMatchObject({
      opening: "0.0000",
      closing: "0.0000",
      count: 0,
      rows: [],
    });
  });
  it("refuses foreign identity, unknown accounts, delegates, invalid ranges and oversized result windows", async () => {
    const { tx } = await f.source();
    await f.accrue(tx.id);
    const a = await account();
    const foreign = await createTestUserDirect(f.h.owner);
    await expect(
      f.as(() =>
        f.accruals.systemMovements(foreign.id, a.id, {
          startDate: "2026-06-01",
          endDate: "2026-06-30",
        }),
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(read(randomUUID())).rejects.toMatchObject({ status: 404 });
    const foreignSystem = randomUUID();
    await f.h.owner.query(
      "INSERT INTO accrual_system_accounts(id,user_id,family,currency_code) VALUES($1,$2,$3,$4)",
      [foreignSystem, foreign.id, "expense", "USD"],
    );
    await expect(read(foreignSystem)).rejects.toMatchObject({ status: 404 });
    await expect(
      withDelegateContext(f.user, foreign.id, () =>
        f.accruals.systemMovements(f.user, a.id, {
          startDate: "2026-06-01",
          endDate: "2026-06-30",
        }),
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(read(a.id, "2026-07-01", "2026-06-30")).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      read(a.id, "2026-06-01", "2026-06-30", 1),
    ).rejects.toMatchObject({ status: 503 });
  });
});
