import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { ReportingDetailsQueryDto } from "./reporting-details-query.dto";
describe("Reporting detail filter query validation", () => {
  it.each([
    ["true", true],
    ["false", false],
  ])("parses %s exactly", async (value, expected) => {
    const dto = plainToInstance(ReportingDetailsQueryDto, {
      startDate: "2026-01-01",
      endDate: "2026-01-31",
      uncategorized: value,
      categoryType: "expense",
    });
    expect(dto.uncategorized).toBe(expected);
    expect(await validate(dto)).toEqual([]);
  });
  it.each([
    { uncategorized: "yes" },
    { categoryType: "other" },
    { startDate: "2026-02-30" },
  ])("rejects invalid filters %j", async (input) => {
    const dto = plainToInstance(ReportingDetailsQueryDto, {
      startDate: "2026-01-01",
      endDate: "2026-01-31",
      ...input,
    });
    expect((await validate(dto)).length).toBeGreaterThan(0);
  });
});
