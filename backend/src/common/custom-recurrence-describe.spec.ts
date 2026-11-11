import {
  describeCustomRecurrenceForModel,
  describeFrequencyForModel,
} from "./custom-recurrence-describe";

describe("describeCustomRecurrenceForModel", () => {
  it.each([
    [
      { unit: "WEEK", interval: 1, weekdays: [5, 1, 3] },
      "every week on Mon, Wed, Fri",
    ],
    [
      { unit: "WEEK", interval: 2, weekdays: [2, 4] },
      "every 2 weeks on Tue, Thu",
    ],
    [
      { unit: "MONTH", interval: 1, monthDays: [-1, 5, 20] },
      "every month on day 5, 20, last day",
    ],
    [
      { unit: "YEAR", interval: 2, dates: ["06-01", "02-29"] },
      "every 2 years on Feb 29, Jun 1",
    ],
  ] as const)("describes %j", (rule, expected) => {
    expect(describeCustomRecurrenceForModel(rule as never)).toBe(expected);
  });

  it("names the first twelve dates of a long yearly rule and counts the rest", () => {
    const dates = Array.from(
      { length: 15 },
      (_, i) => `01-${String(i + 1).padStart(2, "0")}`,
    );
    expect(
      describeCustomRecurrenceForModel({ unit: "YEAR", interval: 1, dates }),
    ).toBe(
      "every year on Jan 1, Jan 2, Jan 3, Jan 4, Jan 5, Jan 6, Jan 7, Jan 8, Jan 9, Jan 10, Jan 11, Jan 12 and 3 more dates",
    );
  });

  it("says when the rule cannot be read", () => {
    expect(describeCustomRecurrenceForModel(null)).toBe(
      "custom schedule (rule unreadable)",
    );
  });
});

describe("describeFrequencyForModel", () => {
  it("spells out CUSTOM and leaves every other word alone", () => {
    expect(
      describeFrequencyForModel("CUSTOM", {
        unit: "WEEK",
        interval: 1,
        weekdays: [1],
      }),
    ).toBe("custom: every week on Mon");
    expect(describeFrequencyForModel("MONTHLY", null)).toBe("MONTHLY");
  });
});
