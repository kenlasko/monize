import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { AccrualSystemMovementsQueryDto } from "./accrual-system-movements-query.dto";
describe("System movement request boundaries", () => {
  it("parses a bounded row limit", async () => {
    const dto = plainToInstance(AccrualSystemMovementsQueryDto, {
      startDate: "2026-06-01",
      endDate: "2026-06-30",
      limit: "2000",
    });
    expect(dto.limit).toBe(2000);
    expect(await validate(dto)).toEqual([]);
  });
  it.each([
    { limit: "0" },
    { limit: "5001" },
    { limit: "1.5" },
    { startDate: "2026-02-30" },
    { endDate: ["2026-06-30", "2026-07-31"] },
  ])("refuses malformed query %j", async (input) => {
    const dto = plainToInstance(AccrualSystemMovementsQueryDto, {
      startDate: "2026-06-01",
      endDate: "2026-06-30",
      ...input,
    });
    expect((await validate(dto)).length).toBeGreaterThan(0);
  });
});
