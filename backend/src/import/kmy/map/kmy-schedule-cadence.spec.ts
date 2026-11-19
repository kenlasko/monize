import { FrequencyType } from "../../../scheduled-transactions/dto/create-scheduled-transaction.dto";
import {
  OCCURRENCE,
  addMonths,
  cadenceFor,
  firstOccurrenceAfter,
  isoWeekday,
  lastDayOf,
  normalizeOccurrence,
  stepOccurrence,
} from "./kmy-schedule-cadence";

const { ONCE, DAILY, WEEKLY, HALF_MONTH, MONTHLY, YEARLY } = OCCURRENCE;
const F = FrequencyType;

function cadence(
  base: number,
  multiplier: number,
  due = "2024-03-04",
  lastDay = false,
) {
  return cadenceFor({ base, multiplier }, due, lastDay);
}

describe("normalizeOccurrence (reference 11.2)", () => {
  it("keeps the base codes and reads a multiplier below 1 as 1", () => {
    expect(normalizeOccurrence(32, 3)).toEqual({ base: 32, multiplier: 3 });
    expect(normalizeOccurrence(32, 0)).toEqual({ base: 32, multiplier: 1 });
    expect(normalizeOccurrence(32, Number.NaN)).toEqual({
      base: 32,
      multiplier: 1,
    });
  });

  it.each([
    [8, WEEKLY, 2],
    [16, WEEKLY, 2],
    [20, WEEKLY, 3],
    [30, DAILY, 30],
    [64, WEEKLY, 4],
    [126, WEEKLY, 8],
    [128, MONTHLY, 2],
    [256, MONTHLY, 3],
    [4096, MONTHLY, 3],
    [8192, MONTHLY, 4],
    [1024, MONTHLY, 6],
    [2048, YEARLY, 2],
  ])(
    "normalizes legacy code %i to base %i x %i, multiplying the stored one",
    (code, base, m) => {
      expect(normalizeOccurrence(code, 1)).toEqual({ base, multiplier: m });
      expect(normalizeOccurrence(code, 2)).toEqual({ base, multiplier: m * 2 });
    },
  );

  it("refuses an unknown code", () => {
    expect(normalizeOccurrence(0, 1)).toBeNull();
    expect(normalizeOccurrence(7, 1)).toBeNull();
  });
});

describe("cadenceFor (spec 5.10.2)", () => {
  it.each([
    ["Once", ONCE, 5, F.ONCE],
    ["Daily 1", DAILY, 1, F.DAILY],
    ["Daily 7", DAILY, 7, F.WEEKLY],
    ["Daily 14", DAILY, 14, F.BIWEEKLY],
    ["Daily 28", DAILY, 28, F.EVERY4WEEKS],
    ["Weekly 1", WEEKLY, 1, F.WEEKLY],
    ["Weekly 2", WEEKLY, 2, F.BIWEEKLY],
    ["Weekly 4", WEEKLY, 4, F.EVERY4WEEKS],
    ["EveryHalfMonth 1", HALF_MONTH, 1, F.SEMIMONTHLY],
    ["Monthly 1", MONTHLY, 1, F.MONTHLY],
    ["Monthly 2", MONTHLY, 2, F.EVERY2MONTHS],
    ["Monthly 3", MONTHLY, 3, F.QUARTERLY],
    ["Monthly 4", MONTHLY, 4, F.EVERY4MONTHS],
    ["Monthly 6", MONTHLY, 6, F.SEMIANNUAL],
    ["Monthly 12", MONTHLY, 12, F.YEARLY],
    ["Monthly 24", MONTHLY, 24, F.EVERY2YEARS],
    ["Yearly 1", YEARLY, 1, F.YEARLY],
    ["Yearly 2", YEARLY, 2, F.EVERY2YEARS],
  ])("%s is exactly %s", (_name, base, m, expected) => {
    expect(cadence(base, m)).toEqual({
      frequency: expected,
      customRecurrence: null,
      approximate: false,
    });
  });

  it("makes a multiple of 7 days up to 84 a weekly custom rule on the due date's weekday", () => {
    // 2024-03-04 is a Monday; 2024-03-06 a Wednesday.
    expect(cadence(DAILY, 21)).toEqual({
      frequency: F.CUSTOM,
      customRecurrence: {
        unit: "WEEK",
        interval: 3,
        weekdays: [1],
        weekStartsOn: 1,
      },
      approximate: false,
    });
    expect(cadence(DAILY, 84, "2024-03-06").customRecurrence).toEqual({
      unit: "WEEK",
      interval: 12,
      weekdays: [3],
      weekStartsOn: 1,
    });
  });

  it("approximates other daily intervals by the largest cycle not longer", () => {
    expect(cadence(DAILY, 30)).toEqual({
      frequency: F.EVERY4WEEKS,
      customRecurrence: null,
      approximate: true,
    });
    expect(cadence(DAILY, 3).frequency).toBe(F.DAILY);
    expect(cadence(DAILY, 91).frequency).toBe(F.EVERY2MONTHS);
    expect(cadence(DAILY, 91).approximate).toBe(true);
  });

  it.each([3, 5, 8, 12])("makes Weekly %i a weekly custom rule", (m) => {
    expect(cadence(WEEKLY, m).customRecurrence).toEqual({
      unit: "WEEK",
      interval: m,
      weekdays: [1],
      weekStartsOn: 1,
    });
  });

  it("approximates Weekly over 12", () => {
    expect(cadence(WEEKLY, 13)).toMatchObject({
      frequency: F.EVERY2MONTHS,
      approximate: true,
    });
  });

  it("treats EveryHalfMonth as Monthly with m/2 when even and SEMIMONTHLY, approximated, when odd", () => {
    expect(cadence(HALF_MONTH, 4).frequency).toBe(F.EVERY2MONTHS);
    expect(cadence(HALF_MONTH, 2).frequency).toBe(F.MONTHLY);
    expect(cadence(HALF_MONTH, 3)).toEqual({
      frequency: F.SEMIMONTHLY,
      customRecurrence: null,
      approximate: true,
    });
    expect(cadence(HALF_MONTH, 10).customRecurrence).toEqual({
      unit: "MONTH",
      interval: 5,
      monthDays: [4],
    });
  });

  it.each([5, 7, 8, 9, 10, 11])(
    "makes Monthly %i a monthly custom rule on the due day",
    (m) => {
      expect(cadence(MONTHLY, m, "2024-03-15").customRecurrence).toEqual({
        unit: "MONTH",
        interval: m,
        monthDays: [15],
      });
    },
  );

  it.each([36, 60, 144])(
    "makes Monthly %i a yearly custom rule on the due date",
    (m) => {
      expect(cadence(MONTHLY, m, "2024-03-15").customRecurrence).toEqual({
        unit: "YEAR",
        interval: m / 12,
        dates: ["03-15"],
      });
    },
  );

  it("approximates Monthly over 12 that is not one of those", () => {
    expect(cadence(MONTHLY, 13)).toMatchObject({
      frequency: F.YEARLY,
      approximate: true,
    });
    expect(cadence(MONTHLY, 30)).toMatchObject({
      frequency: F.EVERY2YEARS,
      approximate: true,
    });
    expect(cadence(MONTHLY, 150)).toMatchObject({
      frequency: F.EVERY2YEARS,
      approximate: true,
    });
  });

  it("makes lastDayInMonth a monthly custom rule on the last day, up to 12", () => {
    expect(cadence(MONTHLY, 1, "2024-02-29", true).customRecurrence).toEqual({
      unit: "MONTH",
      interval: 1,
      monthDays: [-1],
    });
    expect(
      cadence(MONTHLY, 12, "2024-02-29", true).customRecurrence?.interval,
    ).toBe(12);
    expect(cadence(MONTHLY, 24, "2024-02-29", true).frequency).toBe(
      F.EVERY2YEARS,
    );
  });

  it.each([3, 7, 12])("makes Yearly %i a yearly custom rule", (m) => {
    expect(cadence(YEARLY, m, "2024-07-09").customRecurrence).toEqual({
      unit: "YEAR",
      interval: m,
      dates: ["07-09"],
    });
  });

  it("approximates Yearly over 12 as EVERY2YEARS", () => {
    expect(cadence(YEARLY, 13)).toMatchObject({
      frequency: F.EVERY2YEARS,
      approximate: true,
    });
  });

  it("falls back to the approximation when a custom rule cannot be expressed", () => {
    // A 29 February yearly rule is valid; an interval of 0 is not reachable, but an invalid date is.
    expect(cadence(YEARLY, 3, "2024-13-40").frequency).toBe(F.EVERY2YEARS);
  });
});

describe("KMyMoney's date stepping (reference 11.4)", () => {
  const monthly = { base: MONTHLY, multiplier: 1 };

  it("clamps addMonths like QDate and restores the start day where the month has it", () => {
    expect(addMonths("2024-01-31", 1)).toBe("2024-02-29");
    expect(addMonths("2023-01-31", 1)).toBe("2023-02-28");
    expect(addMonths("2024-11-30", 3)).toBe("2025-02-28");
    expect(addMonths("2024-03-31", -1)).toBe("2024-02-29");
    expect(stepOccurrence("2024-01-31", monthly, "2024-01-31", false)).toBe(
      "2024-02-29",
    );
    expect(stepOccurrence("2024-02-29", monthly, "2024-01-31", false)).toBe(
      "2024-03-31",
    );
    expect(stepOccurrence("2024-03-31", monthly, "2024-01-31", false)).toBe(
      "2024-04-30",
    );
    expect(stepOccurrence("2024-04-30", monthly, "2024-01-31", false)).toBe(
      "2024-05-31",
    );
  });

  it("follows the last day of the month under lastDayInMonth", () => {
    expect(stepOccurrence("2024-02-29", monthly, "2024-01-10", true)).toBe(
      "2024-03-31",
    );
    expect(lastDayOf("2023-02-10")).toBe("2023-02-28");
  });

  it("steps days, weeks, years and half months", () => {
    expect(
      stepOccurrence(
        "2024-01-01",
        { base: DAILY, multiplier: 10 },
        "2024-01-01",
        false,
      ),
    ).toBe("2024-01-11");
    expect(
      stepOccurrence(
        "2024-01-01",
        { base: WEEKLY, multiplier: 2 },
        "2024-01-01",
        false,
      ),
    ).toBe("2024-01-15");
    expect(
      stepOccurrence(
        "2024-02-29",
        { base: YEARLY, multiplier: 1 },
        "2024-02-29",
        false,
      ),
    ).toBe("2025-02-28");
    expect(
      stepOccurrence(
        "2024-01-01",
        { base: ONCE, multiplier: 1 },
        "2024-01-01",
        false,
      ),
    ).toBeNull();
  });

  it.each([
    ["2024-01-05", 1, "2024-01-20"],
    ["2024-01-05", 2, "2024-02-05"],
    ["2024-01-05", 3, "2024-02-20"],
    ["2024-01-13", 1, "2024-01-28"],
    ["2024-01-14", 1, "2024-01-29"],
    ["2024-02-14", 1, "2024-02-29"],
    ["2024-04-14", 1, "2024-04-29"],
    ["2024-01-15", 1, "2024-01-31"],
    ["2024-01-31", 1, "2024-02-15"],
    ["2024-01-20", 1, "2024-02-05"],
    ["2024-01-20", 3, "2024-03-05"],
  ])("steps half months: %s x %i gives %s", (date, m, expected) => {
    expect(
      stepOccurrence(date, { base: HALF_MONTH, multiplier: m }, date, false),
    ).toBe(expected);
  });

  it("finds the first occurrence after the last payment, stepped from the start date", () => {
    expect(
      firstOccurrenceAfter("2024-02-01", "2024-01-31", monthly, false),
    ).toBe("2024-02-29");
    expect(
      firstOccurrenceAfter("2024-03-31", "2024-01-31", monthly, false),
    ).toBe("2024-04-30");
    expect(
      firstOccurrenceAfter("2023-12-01", "2024-01-31", monthly, false),
    ).toBe("2024-01-31");
    expect(
      firstOccurrenceAfter(
        "2024-02-01",
        "2024-01-01",
        { base: ONCE, multiplier: 1 },
        false,
      ),
    ).toBeNull();
  });

  it("answers the ISO weekday", () => {
    expect(isoWeekday("2024-03-03")).toBe(7);
    expect(isoWeekday("2024-03-04")).toBe(1);
  });
});
