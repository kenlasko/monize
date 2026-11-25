import {
  bucketStartSql,
  enumerateIncomeExpensePeriods,
  periodKeyForStart,
  weekTruncOffsetDays,
} from "./income-expense-buckets";

describe("income vs expenses bucketing", () => {
  describe("weekTruncOffsetDays", () => {
    it("shifts nothing for a Monday start, which is what PostgreSQL already does", () => {
      expect(weekTruncOffsetDays(1)).toBe(0);
    });

    it("shifts a Sunday start forward by one day so it lands on a Monday", () => {
      expect(weekTruncOffsetDays(0)).toBe(1);
    });

    it("shifts every other start day onto a Monday", () => {
      // Adding the offset must move the chosen day to a Monday (dow 1).
      for (const start of [0, 1, 2, 3, 4, 5, 6] as const) {
        expect((start + weekTruncOffsetDays(start)) % 7).toBe(1);
      }
    });
  });

  describe("bucketStartSql", () => {
    it("truncates to the month, ignoring the week offset", () => {
      const sql = bucketStartSql("month", "t.transaction_date", "$3");
      expect(sql).toContain("date_trunc('month', t.transaction_date)");
      expect(sql).not.toContain("make_interval");
    });

    it("truncates to the year for the breakdown's yearly funds (issue #2413)", () => {
      const sql = bucketStartSql("year", "t.transaction_date", "$3");
      expect(sql).toContain("date_trunc('year', t.transaction_date)");
      expect(sql).not.toContain("make_interval");
    });

    it("shifts, truncates and shifts back for a week", () => {
      const sql = bucketStartSql("week", "t.transaction_date", "$3");
      expect(sql).toContain("date_trunc('week'");
      expect(sql).toContain("+ make_interval(days => $3::int)");
      expect(sql).toContain("- make_interval(days => $3::int)");
    });

    it("reads the date back as text, not as a driver-parsed date", () => {
      expect(bucketStartSql("month", "t.transaction_date", "$3")).toContain(
        "TO_CHAR(",
      );
      expect(bucketStartSql("week", "t.transaction_date", "$3")).toContain(
        "TO_CHAR(",
      );
    });
  });

  describe("enumerateIncomeExpensePeriods", () => {
    it("covers every year the window touches, keyed YYYY", () => {
      const periods = enumerateIncomeExpensePeriods(
        "2024-03-15",
        "2025-06-30",
        "year",
      );
      expect(periods).toEqual([
        { period: "2024", periodStart: "2024-01-01", periodEnd: "2024-12-31" },
        { period: "2025", periodStart: "2025-01-01", periodEnd: "2025-12-31" },
      ]);
      expect(periodKeyForStart("2025-01-01", "year")).toBe("2025");
    });

    it("covers every month the window touches, partial months included", () => {
      const periods = enumerateIncomeExpensePeriods(
        "2025-01-15",
        "2025-03-02",
        "month",
      );
      expect(periods.map((p) => p.period)).toEqual([
        "2025-01",
        "2025-02",
        "2025-03",
      ]);
      expect(periods[0]).toEqual({
        period: "2025-01",
        periodStart: "2025-01-01",
        periodEnd: "2025-01-31",
      });
    });

    it("ends a February on the 29th in a leap year", () => {
      const periods = enumerateIncomeExpensePeriods(
        "2024-02-10",
        "2024-02-20",
        "month",
      );
      expect(periods[0].periodEnd).toBe("2024-02-29");
    });

    it("opens each week on the user's first day", () => {
      // 2025-01-08 is a Wednesday.
      const monday = enumerateIncomeExpensePeriods(
        "2025-01-08",
        "2025-01-08",
        "week",
        1,
      );
      expect(monday[0]).toEqual({
        period: "2025-01-06",
        periodStart: "2025-01-06",
        periodEnd: "2025-01-12",
      });

      const sunday = enumerateIncomeExpensePeriods(
        "2025-01-08",
        "2025-01-08",
        "week",
        0,
      );
      expect(sunday[0]).toEqual({
        period: "2025-01-05",
        periodStart: "2025-01-05",
        periodEnd: "2025-01-11",
      });
    });

    it("keys a week by its first day and a month by its year and month", () => {
      expect(periodKeyForStart("2025-01-06", "week")).toBe("2025-01-06");
      expect(periodKeyForStart("2025-01-01", "month")).toBe("2025-01");
    });

    it("agrees with the key the enumeration produces", () => {
      // The SQL groups by a bucket START date and the enumeration produces the
      // keys those dates are matched against; if the two disagree every bar
      // reads zero, so the round trip is pinned here.
      for (const bucket of ["month", "week"] as const) {
        for (const period of enumerateIncomeExpensePeriods(
          "2025-01-01",
          "2025-03-31",
          bucket,
        )) {
          expect(periodKeyForStart(period.periodStart, bucket)).toBe(
            period.period,
          );
        }
      }
    });

    it("returns nothing when the window is inverted, rather than running away", () => {
      expect(
        enumerateIncomeExpensePeriods("2025-03-01", "2025-01-01", "month"),
      ).toEqual([]);
    });
  });
});
