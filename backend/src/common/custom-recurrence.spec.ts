import {
  CustomRecurrence,
  customMinGapDays,
  customOccurrencesPerYear,
  firstCustomDate,
  isCustomDate,
  nextCustomDate,
  normalizeCustomRecurrence,
} from "./custom-recurrence";

const week = (
  weekdays: number[],
  interval = 1,
  weekStartsOn = 1,
): CustomRecurrence => ({ unit: "WEEK", interval, weekdays, weekStartsOn });
const month = (monthDays: number[], interval = 1): CustomRecurrence => ({
  unit: "MONTH",
  interval,
  monthDays,
});
const year = (dates: string[], interval = 1): CustomRecurrence => ({
  unit: "YEAR",
  interval,
  dates,
});

describe("nextCustomDate (docs/specs/custom-recurrence.md section 7)", () => {
  // The same table the frontend spec carries, so both layers produce the same
  // slots for the same rule.
  it.each<[string, CustomRecurrence, string | null, string, string]>([
    [
      "WEEK 1 [1,3,5] from Wed",
      week([1, 3, 5]),
      null,
      "2026-11-11",
      "2026-11-13",
    ],
    [
      "WEEK 1 [1,3,5] from Fri",
      week([1, 3, 5]),
      null,
      "2026-11-13",
      "2026-11-16",
    ],
    [
      "WEEK 2 [2,4]",
      week([2, 4], 2, 1),
      "2026-11-11",
      "2026-11-12",
      "2026-11-24",
    ],
    ["MONTH 1 [5,20,-1]", month([5, 20, -1]), null, "2026-11-20", "2026-11-30"],
    [
      "MONTH 1 [30,31] into February",
      month([30, 31]),
      null,
      "2027-01-31",
      "2027-02-28",
    ],
    [
      "MONTH 1 [30,31] out of February",
      month([30, 31]),
      null,
      "2027-02-28",
      "2027-03-30",
    ],
    ["MONTH 3 [15]", month([15], 3), "2026-11-15", "2026-11-15", "2027-02-15"],
    [
      "YEAR 1 [02-29] into a common year",
      year(["02-29"]),
      null,
      "2026-03-01",
      "2027-02-28",
    ],
    [
      "YEAR 1 [02-29] into a leap year",
      year(["02-29"]),
      null,
      "2027-02-28",
      "2028-02-29",
    ],
    [
      "YEAR 2 [06-01]",
      year(["06-01"], 2),
      "2026-01-10",
      "2026-06-01",
      "2028-06-01",
    ],
  ])("%s", (_label, rule, startDate, from, expected) => {
    expect(nextCustomDate(from, rule, startDate)).toBe(expected);
  });

  it("is strictly after its input", () => {
    expect(nextCustomDate("2026-11-16", week([1]))).toBe("2026-11-23");
  });

  it("resumes the pattern from an off-pattern cursor", () => {
    // A cursor the user moved to a Tuesday steps to the next rule date.
    expect(nextCustomDate("2026-11-17", week([1, 3, 5]))).toBe("2026-11-18");
  });

  it("keeps the last day separate from the 31st", () => {
    expect(nextCustomDate("2026-04-29", month([31]))).toBe("2026-04-30");
    expect(nextCustomDate("2026-04-30", month([-1, 31]))).toBe("2026-05-31");
  });

  it("counts week periods from the week start the rule was saved with", () => {
    // Start Wednesday 2026-11-11. Weeks starting Sunday: 11-08 is week 0,
    // 11-22 week 2. Weeks starting Monday: 11-09 week 0, 11-23 week 2.
    expect(nextCustomDate("2026-11-21", week([7], 2, 0), "2026-11-11")).toBe(
      "2026-11-22",
    );
    expect(nextCustomDate("2026-11-21", week([7], 2, 1), "2026-11-11")).toBe(
      "2026-11-29",
    );
  });

  it("throws without a valid rule, rather than repeating a date", () => {
    expect(() => nextCustomDate("2026-11-11", null)).toThrow(/CUSTOM/);
    expect(() =>
      nextCustomDate("2026-11-11", {
        unit: "WEEK",
        interval: 1,
        weekdays: [],
      }),
    ).toThrow(/weekdays/);
  });
});

describe("firstCustomDate", () => {
  it("is the start date itself when it is on the rule", () => {
    expect(firstCustomDate("2026-11-13", week([1, 3, 5]))).toBe("2026-11-13");
  });

  it("is the first rule date after an off-pattern start", () => {
    expect(firstCustomDate("2026-11-14", week([1, 3, 5]))).toBe("2026-11-16");
    expect(firstCustomDate("2026-11-21", month([5, 20, -1]))).toBe(
      "2026-11-30",
    );
    expect(firstCustomDate("2026-03-01", year(["02-29"]))).toBe("2027-02-28");
  });
});

describe("isCustomDate", () => {
  it("answers for a date on and off the pattern", () => {
    expect(isCustomDate("2026-11-16", week([1, 3, 5]))).toBe(true);
    expect(isCustomDate("2026-11-17", week([1, 3, 5]))).toBe(false);
    expect(isCustomDate("2027-02-28", month([30, 31]))).toBe(true);
    expect(isCustomDate("2027-02-27", month([30, 31]))).toBe(false);
  });

  it("honours the interval from the start date's period", () => {
    const rule = month([15], 3);
    expect(isCustomDate("2027-02-15", rule, "2026-11-15")).toBe(true);
    expect(isCustomDate("2026-12-15", rule, "2026-11-15")).toBe(false);
  });
});

describe("normalizeCustomRecurrence", () => {
  it("sorts and de-duplicates, with the last day last", () => {
    expect(
      normalizeCustomRecurrence({
        unit: "MONTH",
        interval: 1,
        monthDays: [-1, 20, 5, 20],
      }),
    ).toEqual({
      ok: true,
      rule: { unit: "MONTH", interval: 1, monthDays: [5, 20, -1] },
    });
    expect(
      normalizeCustomRecurrence({ unit: "WEEK", weekdays: [5, 1, 3, 1] }),
    ).toEqual({
      ok: true,
      rule: { unit: "WEEK", interval: 1, weekdays: [1, 3, 5], weekStartsOn: 1 },
    });
    expect(
      normalizeCustomRecurrence({
        unit: "YEAR",
        interval: 2,
        dates: ["10-01", "02-01", "10-01"],
      }),
    ).toEqual({
      ok: true,
      rule: { unit: "YEAR", interval: 2, dates: ["02-01", "10-01"] },
    });
  });

  it("refuses a field that is not the unit's own", () => {
    expect(
      normalizeCustomRecurrence({
        unit: "WEEK",
        interval: 1,
        weekdays: [1],
        monthDays: [1],
      }),
    ).toEqual({ ok: false, error: "extraField" });
    expect(
      normalizeCustomRecurrence({
        unit: "MONTH",
        monthDays: [1],
        note: { nested: "anything" },
      }),
    ).toEqual({ ok: false, error: "extraField" });
    expect(
      normalizeCustomRecurrence(
        JSON.parse('{"unit":"YEAR","dates":["01-01"],"__proto__":{"x":1}}'),
      ),
    ).toEqual({ ok: false, error: "extraField" });
  });

  it.each<[unknown, string]>([
    [null, "notAnObject"],
    ["WEEK", "notAnObject"],
    [[1, 2], "notAnObject"],
    [{ unit: "DAY", interval: 1 }, "unit"],
    [{ unit: "WEEK", interval: 0, weekdays: [1] }, "interval"],
    [{ unit: "WEEK", interval: 13, weekdays: [1] }, "interval"],
    [{ unit: "WEEK", interval: 1.5, weekdays: [1] }, "interval"],
    [{ unit: "WEEK", interval: 1, weekdays: [] }, "weekdays"],
    [{ unit: "WEEK", interval: 1, weekdays: [0] }, "weekdays"],
    [{ unit: "WEEK", interval: 1, weekdays: [8] }, "weekdays"],
    [
      { unit: "WEEK", interval: 1, weekdays: [1, 1, 1, 1, 1, 1, 1, 1] },
      "weekdays",
    ],
    [
      { unit: "WEEK", interval: 1, weekdays: [1], weekStartsOn: 7 },
      "weekStartsOn",
    ],
    [{ unit: "MONTH", interval: 1, monthDays: [0] }, "monthDays"],
    [{ unit: "MONTH", interval: 1, monthDays: [32] }, "monthDays"],
    [{ unit: "MONTH", interval: 1, monthDays: [-2] }, "monthDays"],
    [{ unit: "MONTH", interval: 1, monthDays: ["5"] }, "monthDays"],
    [
      { unit: "MONTH", interval: 1, monthDays: new Array(33).fill(1) },
      "monthDays",
    ],
    [{ unit: "YEAR", interval: 1, dates: ["02-30"] }, "dates"],
    [{ unit: "YEAR", interval: 1, dates: ["13-01"] }, "dates"],
    [{ unit: "YEAR", interval: 1, dates: ["2-1"] }, "dates"],
    [{ unit: "YEAR", interval: 1, dates: [] }, "dates"],
    [
      { unit: "YEAR", interval: 1, dates: new Array(367).fill("01-01") },
      "dates",
    ],
  ])("refuses %j as %s", (raw, error) => {
    expect(normalizeCustomRecurrence(raw)).toEqual({ ok: false, error });
  });

  it("allows 29 February, which exists in a leap year", () => {
    expect(
      normalizeCustomRecurrence({
        unit: "YEAR",
        interval: 1,
        dates: ["02-29"],
      }),
    ).toEqual({
      ok: true,
      rule: { unit: "YEAR", interval: 1, dates: ["02-29"] },
    });
  });

  it("accepts the bounds", () => {
    expect(
      normalizeCustomRecurrence({
        unit: "WEEK",
        interval: 12,
        weekdays: [1, 2, 3, 4, 5, 6, 7],
        weekStartsOn: 0,
      }).ok,
    ).toBe(true);
    expect(
      normalizeCustomRecurrence({ unit: "MONTH", monthDays: [31, -1] }).ok,
    ).toBe(true);
  });
});

describe("customOccurrencesPerYear", () => {
  it("counts each unit's dates over its interval", () => {
    expect(customOccurrencesPerYear(week([1, 3, 5]))).toBeCloseTo(
      (3 * 365.25) / 7,
    );
    expect(customOccurrencesPerYear(week([2, 4], 2))).toBeCloseTo(
      (2 * 365.25) / 7 / 2,
    );
    expect(customOccurrencesPerYear(month([5, 20, -1]))).toBe(36);
    // A collision in February is ignored.
    expect(customOccurrencesPerYear(month([30, 31]))).toBe(24);
    expect(customOccurrencesPerYear(month([15], 3))).toBe(4);
    expect(customOccurrencesPerYear(year(["02-01", "06-01", "10-01"]))).toBe(3);
    expect(customOccurrencesPerYear(year(["06-01"], 2))).toBe(0.5);
  });

  it("is zero without a valid rule", () => {
    expect(customOccurrencesPerYear(null)).toBe(0);
  });
});

describe("customMinGapDays", () => {
  it("is the shortest gap between consecutive rule dates", () => {
    expect(customMinGapDays(week([1, 2]))).toBe(1);
    expect(customMinGapDays(week([1, 3, 5]))).toBe(2);
    expect(customMinGapDays(week([1]))).toBe(7);
    expect(customMinGapDays(week([1], 2))).toBe(14);
    // 30 and 31 merge in February; across January the gap is one day.
    expect(customMinGapDays(month([30, 31]))).toBe(1);
    expect(customMinGapDays(month([15]))).toBe(28);
    expect(customMinGapDays(year(["01-01"]))).toBe(365);
  });

  it("is zero without a valid rule", () => {
    expect(customMinGapDays(undefined)).toBe(0);
  });
});
