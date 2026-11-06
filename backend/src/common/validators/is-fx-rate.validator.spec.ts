import "reflect-metadata";
import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { IsFxRate, MIN_FX_RATE } from "./is-fx-rate.validator";

class Probe {
  @IsFxRate()
  rate: number;
}

async function constraints(rate: unknown): Promise<string[]> {
  const errors = await validate(plainToInstance(Probe, { rate }));
  return errors.flatMap((e) => Object.keys(e.constraints ?? {}));
}

describe("IsFxRate", () => {
  it("floors at one unit of the column's last place", () => {
    expect(MIN_FX_RATE).toBe(0.0000000001);
  });

  it.each([1, 0.9234, 0.0000073529, 0.00000007, 0.0000000001, 1_000_000])(
    "accepts %p",
    async (rate) => {
      expect(await constraints(rate)).toEqual([]);
    },
  );

  it("refuses zero and negatives", async () => {
    expect(await constraints(0)).toContain("min");
    expect(await constraints(-1)).toContain("min");
  });

  it("refuses an eleventh decimal place without throwing", async () => {
    expect(await constraints(0.00000000011)).toContain("hasFxRatePlaces");
    expect(await constraints(1.00000000001)).toContain("hasFxRatePlaces");
  });

  it("refuses non-numbers", async () => {
    expect(await constraints("0.5")).toContain("isNumber");
    expect(await constraints(Infinity)).not.toEqual([]);
    expect(await constraints(NaN)).not.toEqual([]);
  });
});
