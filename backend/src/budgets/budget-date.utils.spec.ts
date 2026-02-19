import {
  getCurrentMonthPeriodDates,
  getMonthPeriodDates,
  getPreviousMonthPeriodDates,
  parsePeriodFromYYYYMM,
} from "./budget-date.utils";

describe("budget-date.utils", () => {
  describe("getMonthPeriodDates", () => {
    it("should return correct dates for January", () => {
      const result = getMonthPeriodDates(2026, 0);
      expect(result).toEqual({
        periodStart: "2026-01-01",
        periodEnd: "2026-01-31",
      });
    });

    it("should return correct dates for February in non-leap year", () => {
      const result = getMonthPeriodDates(2025, 1);
      expect(result).toEqual({
        periodStart: "2025-02-01",
        periodEnd: "2025-02-28",
      });
    });

    it("should return correct dates for February in leap year", () => {
      const result = getMonthPeriodDates(2024, 1);
      expect(result).toEqual({
        periodStart: "2024-02-01",
        periodEnd: "2024-02-29",
      });
    });

    it("should return correct dates for a 30-day month", () => {
      const result = getMonthPeriodDates(2026, 3);
      expect(result).toEqual({
        periodStart: "2026-04-01",
        periodEnd: "2026-04-30",
      });
    });

    it("should return correct dates for December", () => {
      const result = getMonthPeriodDates(2026, 11);
      expect(result).toEqual({
        periodStart: "2026-12-01",
        periodEnd: "2026-12-31",
      });
    });

    it("should zero-pad single-digit months", () => {
      const result = getMonthPeriodDates(2026, 2);
      expect(result.periodStart).toBe("2026-03-01");
    });
  });

  describe("getCurrentMonthPeriodDates", () => {
    it("should return dates for the current month", () => {
      const result = getCurrentMonthPeriodDates();
      const today = new Date();
      const expectedMonth = String(today.getMonth() + 1).padStart(2, "0");
      expect(result.periodStart).toBe(
        `${today.getFullYear()}-${expectedMonth}-01`,
      );
      expect(result.periodEnd).toMatch(
        new RegExp(`^${today.getFullYear()}-${expectedMonth}-\\d{2}$`),
      );
    });
  });

  describe("getPreviousMonthPeriodDates", () => {
    it("should return dates for the previous month", () => {
      const result = getPreviousMonthPeriodDates();
      const today = new Date();
      const prevMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      const expectedMonth = String(prevMonth.getMonth() + 1).padStart(2, "0");
      expect(result.periodStart).toBe(
        `${prevMonth.getFullYear()}-${expectedMonth}-01`,
      );
    });
  });

  describe("parsePeriodFromYYYYMM", () => {
    it("should parse valid YYYY-MM format", () => {
      const result = parsePeriodFromYYYYMM("2026-02");
      expect(result).toEqual({
        periodStart: "2026-02-01",
        periodEnd: "2026-02-28",
      });
    });

    it("should parse December correctly", () => {
      const result = parsePeriodFromYYYYMM("2026-12");
      expect(result).toEqual({
        periodStart: "2026-12-01",
        periodEnd: "2026-12-31",
      });
    });

    it("should return null for invalid format", () => {
      expect(parsePeriodFromYYYYMM("2026")).toBeNull();
      expect(parsePeriodFromYYYYMM("2026-2")).toBeNull();
      expect(parsePeriodFromYYYYMM("not-a-date")).toBeNull();
      expect(parsePeriodFromYYYYMM("")).toBeNull();
    });

    it("should return null for invalid month", () => {
      expect(parsePeriodFromYYYYMM("2026-00")).toBeNull();
      expect(parsePeriodFromYYYYMM("2026-13")).toBeNull();
    });
  });
});
