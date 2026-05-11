import {
  formatDateYMD,
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
