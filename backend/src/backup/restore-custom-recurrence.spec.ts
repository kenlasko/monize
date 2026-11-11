import { BadRequestException } from "@nestjs/common";
import {
  validateRestoredSchedules,
  withPairedCustomRecurrence,
} from "./restore-custom-recurrence";

describe("validateRestoredSchedules", () => {
  it("accepts Custom rows with a rule and every other frequency", () => {
    expect(() =>
      validateRestoredSchedules([
        {
          frequency: "CUSTOM",
          custom_recurrence: { unit: "MONTH", interval: 1, monthDays: [1] },
        },
        { frequency: "MONTHLY" },
        { frequency: "WEEKLY", custom_recurrence: null },
      ]),
    ).not.toThrow();
    expect(() => validateRestoredSchedules(undefined)).not.toThrow();
  });

  it.each([undefined, null, { unit: "WEEK", weekdays: [] }])(
    "refuses a Custom row whose rule is %j",
    (custom_recurrence) => {
      expect(() =>
        validateRestoredSchedules([{ frequency: "CUSTOM", custom_recurrence }]),
      ).toThrow(BadRequestException);
    },
  );
});

describe("withPairedCustomRecurrence", () => {
  it("stores a Custom row's rule in canonical form", () => {
    expect(
      withPairedCustomRecurrence({
        id: "a",
        frequency: "CUSTOM",
        custom_recurrence: { unit: "WEEK", weekdays: [5, 1] },
      }),
    ).toEqual({
      id: "a",
      frequency: "CUSTOM",
      custom_recurrence: {
        unit: "WEEK",
        interval: 1,
        weekdays: [1, 5],
        weekStartsOn: 1,
      },
    });
  });

  it("clears a rule beside any other frequency", () => {
    expect(
      withPairedCustomRecurrence({
        frequency: "MONTHLY",
        custom_recurrence: { unit: "WEEK", weekdays: [1] },
      }),
    ).toEqual({ frequency: "MONTHLY", custom_recurrence: null });
  });

  it("leaves a row from before the column as it is", () => {
    const row = { frequency: "MONTHLY" };
    expect(withPairedCustomRecurrence(row)).toBe(row);
  });

  it("refuses an unwalkable Custom row", () => {
    expect(() =>
      withPairedCustomRecurrence({ frequency: "CUSTOM", custom_recurrence: 1 }),
    ).toThrow(BadRequestException);
  });
});
