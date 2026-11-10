import {
  ESTIMATE_GROWTH_MAX,
  buildEstimateProfile,
  estimateForMonth,
  historyWindowStart,
  shiftMonthKey,
  yearOverYearGrowth,
} from "./amount-estimate";

const TODAY = "2026-11-09";

describe("amount-estimate", () => {
  describe("calendar helpers", () => {
    it("clamps the window's day to the target month's end", () => {
      expect(historyWindowStart("2026-02-28")).toBe("2024-02-28");
      expect(historyWindowStart("2026-03-31")).toBe("2024-03-31");
      expect(historyWindowStart("2026-08-31")).toBe("2024-08-31");
    });

    it("steps month keys across years", () => {
      expect(shiftMonthKey("2026-12", 1)).toBe("2027-01");
      expect(shiftMonthKey("2026-01", -1)).toBe("2025-12");
      expect(shiftMonthKey("2026-11", 25)).toBe("2028-12");
    });

    it("opens the history window 24 months before today", () => {
      expect(historyWindowStart(TODAY)).toBe("2024-11-09");
    });
  });

  describe("buildEstimateProfile", () => {
    it("is null with no payment in the window", () => {
      expect(buildEstimateProfile([], TODAY, 2)).toBeNull();
      expect(
        buildEstimateProfile(
          [
            // On the window's exclusive lower bound, and after today.
            { date: "2024-11-09", amount: -100 },
            { date: "2026-11-10", amount: -100 },
          ],
          TODAY,
          2,
        ),
      ).toBeNull();
    });

    it("drops a refund on the other side of zero, and zero payments", () => {
      const profile = buildEstimateProfile(
        [
          { date: "2026-08-15", amount: -100 },
          { date: "2026-09-15", amount: 30 },
          { date: "2026-10-15", amount: -100 },
          { date: "2026-10-20", amount: 0 },
        ],
        TODAY,
        2,
      )!;
      expect(profile.payments.map((p) => p.amount)).toEqual([-100, -100]);
      expect(profile.recentMean).toBe(-100);
    });

    it("is not seasonal while the history covers one year", () => {
      const profile = buildEstimateProfile(
        [
          { date: "2026-07-15", amount: -100 },
          { date: "2026-08-15", amount: -110 },
          { date: "2026-09-15", amount: -120 },
          { date: "2026-10-15", amount: -130 },
        ],
        TODAY,
        2,
      )!;
      expect(profile.seasonal).toBe(false);
      expect(profile.growthRate).toBe(0);
      // The newest three: (-110 - 120 - 130) / 3.
      expect(estimateForMonth(profile, "2026-12")).toEqual({
        amount: -120,
        basis: "recent",
      });
      expect(estimateForMonth(profile, "2027-07").basis).toBe("recent");
    });
  });

  describe("seasonal history with a year-over-year trend", () => {
    // A heating bill: each calendar month 10% dearer in the latest year.
    const history = [
      { date: "2025-01-15", amount: -200 },
      { date: "2025-02-15", amount: -180 },
      { date: "2025-07-15", amount: -50 },
      { date: "2026-01-15", amount: -220 },
      { date: "2026-02-15", amount: -198 },
      { date: "2026-07-15", amount: -55 },
    ];

    it("reads the growth off the calendar months both years hold", () => {
      // (220 + 198 + 55) / (200 + 180 + 50) - 1 = 473 / 430 - 1 = 0.1
      expect(yearOverYearGrowth(history, TODAY)).toBeCloseTo(0.1, 10);
    });

    it("projects each same-month payment forward by whole years", () => {
      const profile = buildEstimateProfile(history, TODAY, 2)!;
      expect(profile.seasonal).toBe(true);
      // January 2027: -200 x 1.1^2 and -220 x 1.1^1, both -242.
      expect(estimateForMonth(profile, "2027-01")).toEqual({
        amount: -242,
        basis: "seasonal",
      });
      // July 2027: -50 x 1.21 = -60.5 and -55 x 1.1 = -60.5.
      expect(estimateForMonth(profile, "2027-07").amount).toBe(-60.5);
      // A month with no payment of its own falls back to the newest three:
      // (-220 - 198 - 55) / 3 = -157.666..., at the currency's two places.
      expect(estimateForMonth(profile, "2026-12")).toEqual({
        amount: -157.67,
        basis: "recent",
      });
    });

    it("compounds the growth a further year out", () => {
      const profile = buildEstimateProfile(history, TODAY, 2)!;
      // January 2028: -220 x 1.1^2 = -266.2, -200 x 1.1^3 = -266.2.
      expect(estimateForMonth(profile, "2028-01").amount).toBe(-266.2);
    });

    it("applies no trend with fewer than three matched months", () => {
      const twoMonths = history.filter((p) => !p.date.includes("-07-"));
      expect(yearOverYearGrowth(twoMonths, TODAY)).toBe(0);
      const profile = buildEstimateProfile(twoMonths, TODAY, 2)!;
      // (-200 + -220) / 2, unprojected.
      expect(estimateForMonth(profile, "2027-01").amount).toBe(-210);
    });

    it("never pools the current month's payments across two years", () => {
      // Offsets 0 (Nov 2026) and 12 (Nov 2025) compare; Nov 2024 (offset 24)
      // is too old to compare. Three matched months, each 10% dearer.
      const matched = [
        { date: "2024-11-15", amount: -500 },
        { date: "2025-09-15", amount: -100 },
        { date: "2025-10-15", amount: -100 },
        { date: "2025-11-15", amount: -100 },
        { date: "2026-09-15", amount: -110 },
        { date: "2026-10-15", amount: -110 },
        { date: "2026-11-01", amount: -110 },
      ];
      expect(yearOverYearGrowth(matched, TODAY)).toBeCloseTo(0.1, 10);
    });

    it("clamps a runaway growth rate", () => {
      const tripled = [
        { date: "2025-01-15", amount: -10 },
        { date: "2025-02-15", amount: -10 },
        { date: "2025-03-15", amount: -10 },
        { date: "2026-01-15", amount: -30 },
        { date: "2026-02-15", amount: -30 },
        { date: "2026-03-15", amount: -30 },
      ];
      expect(yearOverYearGrowth(tripled, TODAY)).toBe(ESTIMATE_GROWTH_MAX);
    });

    it("rounds at the currency's places", () => {
      const profile = buildEstimateProfile(
        [
          { date: "2026-09-15", amount: -10 },
          { date: "2026-10-15", amount: -10.01 },
          { date: "2026-10-20", amount: -10.01 },
        ],
        TODAY,
        0,
      )!;
      expect(estimateForMonth(profile, "2026-12").amount).toBe(-10);
    });
  });
});
