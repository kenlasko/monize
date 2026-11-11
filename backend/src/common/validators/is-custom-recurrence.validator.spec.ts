import "reflect-metadata";
import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { IsCustomRecurrence } from "./is-custom-recurrence.validator";

class Probe {
  @IsCustomRecurrence()
  rule: unknown;
}

async function messages(rule: unknown): Promise<string[]> {
  const errors = await validate(plainToInstance(Probe, { rule }));
  return errors.flatMap((e) => Object.values(e.constraints ?? {}));
}

describe("IsCustomRecurrence", () => {
  it("accepts a rule the stepper can walk", async () => {
    expect(await messages({ unit: "MONTH", monthDays: [1, -1] })).toEqual([]);
  });

  it("names why a rule was refused", async () => {
    expect(await messages({ unit: "WEEK", weekdays: [8] })).toEqual([
      "rule must be a valid custom recurrence rule (weekdays)",
    ]);
    expect(await messages({ unit: "WEEK", weekdays: [1], x: 1 })).toEqual([
      "rule must be a valid custom recurrence rule (extraField)",
    ]);
  });
});
