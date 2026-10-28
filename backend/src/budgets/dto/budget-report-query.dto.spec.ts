import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { BudgetReportQueryDto } from "./budget-report-query.dto";

describe("budget report basis query validation", () => {
  const check = (input: Record<string, unknown>) =>
    validate(plainToInstance(BudgetReportQueryDto, input), {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
  it.each(["cash", "accrual"])(
    "accepts the reporting basis sent by the budget page: %s",
    async (basis) => {
      expect(await check({ basis, months: "6" })).toEqual([]);
    },
  );
  it.each(["invalid", ["cash", "accrual"]])(
    "rejects an invalid or repeated basis: %j",
    async (basis) => {
      expect(await check({ basis })).not.toEqual([]);
    },
  );
  it("still refuses unknown query properties", async () => {
    expect(await check({ basis: "cash", unexpected: true })).not.toEqual([]);
  });
});
