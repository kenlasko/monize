import { createAccrualTaxonomyFixture } from "../helpers/accrual-taxonomy-fixture";
import { TransactionAccrualEditorController } from "@/transactions/transaction-accrual-editor.controller";
import { createTestUserDirect } from "../helpers/integration-setup";
import { withUserContext } from "@/common/db/with-context";

describe("atomic source and accrual editor (PostgreSQL)", () => {
  jest.setTimeout(180000);
  let f: Awaited<ReturnType<typeof createAccrualTaxonomyFixture>>;
  let controller: TransactionAccrualEditorController;
  beforeAll(async () => {
    f = await createAccrualTaxonomyFixture();
    controller = new TransactionAccrualEditorController(
      f.transactions,
      f.accruals,
    );
  });
  beforeEach(async () => f.reset());
  afterAll(async () => f?.close());
  const req = () => ({ user: { id: f.user } });
  it("previews unsaved amount/date and commits source and custom allocation together", async () => {
    const { tx } = await f.source();
    await f.accrue(tx.id);
    const input = {
      patch: { amount: -2400, transactionDate: "2026-10-15" },
      settings: [
        {
          sourceTransactionId: tx.id,
          preset: "CUSTOM" as const,
          startMonth: "2026-11",
          monthCount: 6,
        },
      ],
    };
    const before = await f.bank();
    const preview = await f.as(() => controller.preview(req(), tx.id, input));
    expect(preview.previews[0].plan?.allocations).toHaveLength(6);
    expect(preview.previews[0].plan?.allocations[0]).toMatchObject({
      recognitionDate: "2026-11-30",
      amount: "-400.0000",
    });
    expect(
      Number((await f.as(() => f.transactions.findOne(f.user, tx.id))).amount),
    ).toBe(Number(tx.amount));
    expect(await f.bank()).toBe(before);
    await f.as(() =>
      controller.save(req(), tx.id, {
        ...input,
        fingerprint: preview.fingerprint,
      }),
    );
    expect(
      Number((await f.as(() => f.transactions.findOne(f.user, tx.id))).amount),
    ).toBe(-2400);
    const schedules = await f.as(() =>
      f.accruals.sourceSchedules(f.user, tx.id),
    );
    expect(schedules[0]).toMatchObject({
      preset: "CUSTOM",
      monthCount: 6,
      startMonth: "2026-11",
    });
    const detail = await f.as(() => f.accruals.detail(f.user, schedules[0].id));
    expect(detail.plan.allocations[0].amount).toBe("-400.0000");
  });
  it("rolls source, bank balance and allocation writes back when the schedule phase fails", async () => {
    const { tx } = await f.source();
    await f.accrue(tx.id);
    const input = {
      patch: { amount: -3600 },
      settings: [{ sourceTransactionId: tx.id, preset: "NTM" as const }],
    };
    const preview = await f.as(() => controller.preview(req(), tx.id, input));
    const before = await f.bank();
    const schedules = await f.as(() =>
      f.accruals.sourceSchedules(f.user, tx.id),
    );
    const original = f.accruals.applyEditorSettings.bind(f.accruals);
    const failure = jest
      .spyOn(f.accruals, "applyEditorSettings")
      .mockImplementationOnce(async (...args) => {
        await original(...args);
        throw new Error("forced post-schedule failure");
      });
    try {
      await expect(
        f.as(() =>
          controller.save(req(), tx.id, {
            ...input,
            fingerprint: preview.fingerprint,
          }),
        ),
      ).rejects.toThrow("forced post-schedule failure");
    } finally {
      failure.mockRestore();
    }
    expect(
      Number((await f.as(() => f.transactions.findOne(f.user, tx.id))).amount),
    ).toBe(Number(tx.amount));
    expect(await f.bank()).toBe(before);
    expect(await f.as(() => f.accruals.sourceSchedules(f.user, tx.id))).toEqual(
      schedules,
    );
  });
  it("rejects a stale schedule preview without changing the source", async () => {
    const { tx } = await f.source();
    await f.accrue(tx.id);
    const input = {
      patch: { amount: -2400 },
      settings: [{ sourceTransactionId: tx.id, preset: "LTM" as const }],
    };
    const preview = await f.as(() => controller.preview(req(), tx.id, input));
    await f.accrue(tx.id);
    const before = await f.bank();
    await expect(
      f.as(() =>
        controller.save(req(), tx.id, {
          ...input,
          fingerprint: preview.fingerprint,
        }),
      ),
    ).rejects.toThrow();
    expect(await f.bank()).toBe(before);
    expect(
      Number((await f.as(() => f.transactions.findOne(f.user, tx.id))).amount),
    ).toBe(Number(tx.amount));
  });
  it("removes an allocation and updates its source in one commit", async () => {
    const { tx } = await f.source();
    await f.accrue(tx.id);
    const input = {
      patch: { amount: -900 },
      settings: [
        { sourceTransactionId: tx.id, preset: "NTM" as const, remove: true },
      ],
    };
    const preview = await f.as(() => controller.preview(req(), tx.id, input));
    await f.as(() =>
      controller.save(req(), tx.id, {
        ...input,
        fingerprint: preview.fingerprint,
      }),
    );
    expect(await f.as(() => f.accruals.sourceSchedules(f.user, tx.id))).toEqual(
      [],
    );
    expect(
      Number((await f.as(() => f.transactions.findOne(f.user, tx.id))).amount),
    ).toBe(-900);
  });
  it("cannot preview another owner source", async () => {
    const { tx } = await f.source();
    const other = (await createTestUserDirect(f.h.owner)).id;
    await expect(
      withUserContext(other, () =>
        controller.preview({ user: { id: other } }, tx.id, {
          patch: { amount: -1 },
          settings: [],
        }),
      ),
    ).rejects.toThrow();
  });
});
