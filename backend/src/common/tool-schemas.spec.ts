import { z } from "zod";
import {
  DEFAULT_LOOKBACK_DAYS,
  DEFAULT_TOP_N,
  getDefaultComparePeriods,
  getDefaultDateRange,
  getDefaultPreviousMonth,
  resolveComparePeriods,
  numberArg,
  booleanArg,
} from "./tool-schemas";
import { todayInTimezone } from "./date-utils";

describe("tool-schemas defaults", () => {
  // The caller passes the user's day (todayYMD()); nothing here reads a clock.
  // 12:00 UTC on 2026-11-27 is already 2026-11-28 in Kiritimati.
  const TODAY = "2026-11-28";

  describe("getDefaultDateRange()", () => {
    it("ends at the given day and starts DEFAULT_LOOKBACK_DAYS before it", () => {
      expect(getDefaultDateRange(TODAY)).toEqual({
        startDate: "2026-10-29",
        endDate: TODAY,
      });
      expect(DEFAULT_LOOKBACK_DAYS).toBe(30);
    });

    it("honors a custom lookback window", () => {
      expect(getDefaultDateRange(TODAY, 7)).toEqual({
        startDate: "2026-11-21",
        endDate: TODAY,
      });
    });
  });

  describe("getDefaultComparePeriods()", () => {
    it("compares the previous full month with the month to date", () => {
      expect(getDefaultComparePeriods(TODAY)).toEqual({
        period1Start: "2026-10-01",
        period1End: "2026-10-31",
        period2Start: "2026-11-01",
        period2End: TODAY,
      });
    });

    it("crosses a year boundary and a leap February", () => {
      expect(getDefaultComparePeriods("2027-01-05")).toEqual({
        period1Start: "2026-12-01",
        period1End: "2026-12-31",
        period2Start: "2027-01-01",
        period2End: "2027-01-05",
      });
      expect(getDefaultComparePeriods("2024-03-10").period1End).toBe(
        "2024-02-29",
      );
    });
  });

  describe("getDefaultPreviousMonth()", () => {
    it("returns the previous calendar month in YYYY-MM", () => {
      expect(getDefaultPreviousMonth(TODAY)).toBe("2026-10");
      expect(getDefaultPreviousMonth("2027-01-05")).toBe("2026-12");
    });
  });

  describe("a Kiritimati user at 12:00 UTC (#2365)", () => {
    it("derives every default from the user's day, not the server's", () => {
      jest.useFakeTimers({ now: new Date("2026-11-27T12:00:00Z") });
      try {
        const today = todayInTimezone("Pacific/Kiritimati") as string;
        expect(today).toBe("2026-11-28");
        expect(getDefaultDateRange(today).endDate).toBe("2026-11-28");
        expect(getDefaultComparePeriods(today).period2End).toBe("2026-11-28");
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe("constants", () => {
    it("exposes sensible default values", () => {
      expect(DEFAULT_LOOKBACK_DAYS).toBe(30);
      expect(DEFAULT_TOP_N).toBe(10);
    });
  });

  describe("resolveComparePeriods()", () => {
    it("returns caller-supplied periods when all four dates are present", () => {
      const periods = resolveComparePeriods(
        {
          period1Start: "2025-01-01",
          period1End: "2025-01-31",
          period2Start: "2025-02-01",
          period2End: "2025-02-28",
        },
        TODAY,
      );
      expect(periods).toEqual({
        period1Start: "2025-01-01",
        period1End: "2025-01-31",
        period2Start: "2025-02-01",
        period2End: "2025-02-28",
      });
    });

    it("falls back to defaults when any date is missing", () => {
      const periods = resolveComparePeriods(
        {
          period1Start: "2025-01-01",
          period1End: "2025-01-31",
          period2Start: "2025-02-01",
          // period2End missing -- all-or-nothing
        },
        TODAY,
      );
      expect(periods).toEqual(getDefaultComparePeriods(TODAY));
    });

    it("falls back to defaults on entirely empty input", () => {
      expect(resolveComparePeriods({}, TODAY)).toEqual(
        getDefaultComparePeriods(TODAY),
      );
    });
  });
});

describe("numberArg and booleanArg (what a model actually sends)", () => {
  // An LLM writes JSON by hand, so a numeric argument arrives as "10" often
  // enough that refusing it is a defect. list_payees answered
  // -32602 "expected number, received string" to a limit of "10".

  it("accepts a number written as a string, and the number itself", () => {
    expect(numberArg().parse("10")).toBe(10);
    expect(numberArg().parse(10)).toBe(10);
    expect(numberArg().parse("-2.5")).toBe(-2.5);
  });

  it("still refuses what is not a number", () => {
    for (const junk of ["abc", "", "   ", null, undefined, [], {}]) {
      expect(numberArg().safeParse(junk).success).toBe(false);
    }
  });

  it("keeps the bounds the field declares", () => {
    const limit = numberArg(z.number().int().min(1).max(500));
    expect(limit.parse("500")).toBe(500);
    expect(limit.safeParse("501").success).toBe(false);
    expect(limit.safeParse("0").success).toBe(false);
  });

  it("reads 'false' as false, which coerce.boolean gets backwards", () => {
    // Boolean("false") is true, so z.coerce.boolean() would turn
    // `hasEmail: "false"` -- the way to ask which payees are MISSING an email
    // -- into a filter for the ones that have one.
    expect(booleanArg().parse("false")).toBe(false);
    expect(booleanArg().parse("true")).toBe(true);
    expect(booleanArg().parse(false)).toBe(false);
    expect(booleanArg().parse(true)).toBe(true);
  });

  it("refuses a string that only looks boolean", () => {
    for (const junk of ["yes", "no", "1", 1, 0, null]) {
      expect(booleanArg().safeParse(junk).success).toBe(false);
    }
  });

  it("costs nothing in the tool list: the JSON Schema is unchanged", () => {
    // The whole point of coercing rather than accepting a union: a union would
    // emit an anyOf into every tools/list response.
    const coerced = z.toJSONSchema(
      z.object({ limit: numberArg(z.number().int()), flag: booleanArg() }),
      { io: "input" },
    );
    const plain = z.toJSONSchema(
      z.object({ limit: z.number().int(), flag: z.boolean() }),
      { io: "input" },
    );
    expect(coerced).toEqual(plain);
  });
});
