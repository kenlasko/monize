import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { AccrualPreviewDto, AccrualCommitDto } from "./accrual-command.dto";
const sourceTransactionId = "00000000-0000-4000-8000-000000000001";
describe("accrual command DTOs", () => {
  const check = (value: object) =>
    validate(plainToInstance(AccrualCommitDto, value), {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
  const valid = {
    sourceTransactionId,
    preset: "NTM",
    fingerprint: "a".repeat(64),
    expectedScheduleId: null,
    expectedRevision: null,
  };
  it("requires explicit null expectations for new schedules", async () => {
    expect(await check(valid)).toEqual([]);
    const {
      expectedScheduleId: _id,
      expectedRevision: _revision,
      ...missing
    } = valid;
    expect((await check(missing)).map((row) => row.property).sort()).toEqual([
      "expectedRevision",
      "expectedScheduleId",
    ]);
  });
  it("refuses caller-supplied ownership and money facts", async () => {
    expect(
      (await check({ ...valid, userId: sourceTransactionId, amount: 1200 }))
        .map((row) => row.property)
        .sort(),
    ).toEqual(["amount", "userId"]);
  });
  it.each([0, 601, 1.5, "12", null])(
    "bounds custom month count %s",
    async (monthCount) => {
      const errors = await validate(
        plainToInstance(AccrualPreviewDto, {
          sourceTransactionId,
          preset: "CUSTOM",
          startMonth: "2026-10",
          monthCount,
        }),
      );
      expect(errors.some((row) => row.property === "monthCount")).toBe(true);
    },
  );
});
