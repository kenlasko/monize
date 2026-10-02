import {
  addDaysYMD,
  formatDateYMD,
  formatDateYMDLocal,
  formatMonthKey,
  getMonthEndYMD,
  isTransactionInFuture,
  isValidIanaTimezone,
  todayInTimezone,
  todayYMD,
} from "./date-utils";
import { requestContextStorage } from "./request-context";

describe("formatDateYMD", () => {
  it("formats UTC midnight correctly", () => {
    const d = new Date("2026-04-15T00:00:00Z");
    expect(formatDateYMD(d)).toBe("2026-04-15");
  });

  it("zero-pads single-digit month and day", () => {
    const d = new Date("2026-01-05T00:00:00Z");
    expect(formatDateYMD(d)).toBe("2026-01-05");
  });

  it("does not shift dates due to local timezone", () => {
    const d = new Date("2026-12-31T23:59:59Z");
    expect(formatDateYMD(d)).toBe("2026-12-31");
  });
});

describe("formatDateYMDLocal", () => {
  it("formats using local components and zero-pads", () => {
    // Construct from local year/month/day so the result is timezone-independent
    const d = new Date(2026, 0, 5); // 2026-01-05 local
    expect(formatDateYMDLocal(d)).toBe("2026-01-05");
  });

  it("matches the inline local-time template it replaces", () => {
    const d = new Date(2026, 11, 31, 23, 59);
    const expected = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    expect(formatDateYMDLocal(d)).toBe(expected);
  });
});

describe("isValidIanaTimezone", () => {
  it("accepts a real IANA timezone", () => {
    expect(isValidIanaTimezone("America/Toronto")).toBe(true);
  });

  it("rejects the 'browser' sentinel", () => {
    expect(isValidIanaTimezone("browser")).toBe(false);
  });

  it("rejects empty / whitespace strings", () => {
    expect(isValidIanaTimezone("")).toBe(false);
    expect(isValidIanaTimezone("   ")).toBe(false);
  });

  it("rejects non-string values", () => {
    expect(isValidIanaTimezone(undefined)).toBe(false);
    expect(isValidIanaTimezone(null)).toBe(false);
    expect(isValidIanaTimezone(42)).toBe(false);
  });

  it("rejects invented timezone names", () => {
    expect(isValidIanaTimezone("Not/A_Real_Zone")).toBe(false);
  });
});

describe("todayInTimezone", () => {
  it("returns YYYY-MM-DD for a valid IANA timezone", () => {
    const result = todayInTimezone("America/Toronto");
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("returns null for an invalid timezone", () => {
    expect(todayInTimezone("Not/A_Real_Zone")).toBeNull();
  });

  it("names the calendar date an instant falls on in that zone", () => {
    const at = new Date("2027-03-30T23:30:00.000Z");
    expect(todayInTimezone("UTC", at)).toBe("2027-03-30");
    // Warsaw is UTC+2 on this date, so the same instant is already the 31st.
    expect(todayInTimezone("Europe/Warsaw", at)).toBe("2027-03-31");
    expect(todayInTimezone("America/Los_Angeles", at)).toBe("2027-03-30");
  });
});

describe("todayYMD", () => {
  it("returns today's date in YYYY-MM-DD using server local time when no context is set", () => {
    expect(todayYMD()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("uses request-scoped timezone when set", () => {
    requestContextStorage.run({ timezone: "America/Toronto" }, () => {
      const result = todayYMD();
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  it("falls back to server local date when timezone is invalid", () => {
    requestContextStorage.run({ timezone: "Not/A_Real_Zone" }, () => {
      const result = todayYMD();
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });
});

describe("getMonthEndYMD", () => {
  it("returns last day of January (31)", () => {
    expect(getMonthEndYMD(2026, 1)).toBe("2026-01-31");
  });

  it("returns last day of February in a non-leap year (28)", () => {
    expect(getMonthEndYMD(2026, 2)).toBe("2026-02-28");
  });

  it("returns last day of February in a leap year (29)", () => {
    expect(getMonthEndYMD(2024, 2)).toBe("2024-02-29");
  });

  it("returns last day of December (31)", () => {
    expect(getMonthEndYMD(2026, 12)).toBe("2026-12-31");
  });

  it("returns last day of April (30)", () => {
    expect(getMonthEndYMD(2026, 4)).toBe("2026-04-30");
  });
});

describe("formatMonthKey", () => {
  it("returns YYYY-MM with zero-padded month", () => {
    expect(formatMonthKey(2026, 4)).toBe("2026-04");
  });

  it("returns YYYY-MM with two-digit month unchanged", () => {
    expect(formatMonthKey(2026, 12)).toBe("2026-12");
  });
});

describe("isTransactionInFuture", () => {
  it("returns true for a date well in the future", () => {
    expect(isTransactionInFuture("2999-01-01")).toBe(true);
  });

  it("returns false for a date well in the past", () => {
    expect(isTransactionInFuture("2000-01-01")).toBe(false);
  });

  it("returns false for today's date", () => {
    expect(isTransactionInFuture(todayYMD())).toBe(false);
  });
});

describe("addDaysYMD", () => {
  it("adds days across month and year boundaries", () => {
    expect(addDaysYMD("2024-07-08", 90)).toBe("2024-10-06");
    expect(addDaysYMD("2024-12-31", 1)).toBe("2025-01-01");
  });

  it("steps back for a negative count", () => {
    expect(addDaysYMD("2025-01-01", -1)).toBe("2024-12-31");
  });

  it("crosses a leap day", () => {
    expect(addDaysYMD("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDaysYMD("2023-02-28", 1)).toBe("2023-03-01");
  });

  /**
   * The arithmetic is in UTC, so a spring-forward day is still one day. Reading
   * the input as local time would return the same date for `+1` in the zones
   * where the clock jumps.
   */
  it("adds a whole day across a DST transition", () => {
    expect(addDaysYMD("2025-03-09", 1)).toBe("2025-03-10");
    expect(addDaysYMD("2025-11-02", 1)).toBe("2025-11-03");
  });
});
