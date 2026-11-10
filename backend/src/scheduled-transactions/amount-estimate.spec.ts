import {
  ESTIMATE_GROWTH_MAX,
  EstimatePayment,
  buildEstimateProfile,
  estimateForMonth,
  historyWindowStart,
  seasonalIndex,
  shiftMonthKey,
  yearOverYearGrowth,
} from "./amount-estimate";

const TODAY = "2026-11-09";

/**
 * One payment on the 5th of each month from December 2024 through November
 * 2026: the 24 months the window holds on TODAY. `amountFor` gets the
 * calendar month (1-12) and the year of the payment.
 */
const twoYears = (
  amountFor: (month: number, year: number) => number,
): EstimatePayment[] => {
  const payments: EstimatePayment[] = [];
  for (let i = 0; i < 24; i++) {
    const key = shiftMonthKey("2024-12", i);
    const year = Number(key.slice(0, 4));
    const month = Number(key.slice(5, 7));
    payments.push({ date: `${key}-05`, amount: amountFor(month, year) });
  }
  return payments;
};

const months = (
  profile: ReturnType<typeof buildEstimateProfile>,
  keys: string[],
) => keys.map((key) => estimateForMonth(profile!, key).amount);

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
      expect(profile.level).toBe(-100);
    });

    it("estimates a short history at the newest three payments' mean", () => {
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
      // (-110 - 120 - 130) / 3, every month.
      expect(estimateForMonth(profile, "2026-12")).toEqual({
        amount: -120,
        basis: "recent",
      });
      expect(estimateForMonth(profile, "2027-07").amount).toBe(-120);
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

  /**
   * The bills that are not seasonal must not be read as seasonal: two years of
   * history are not a season, and a price change is a new level, not a
   * pattern or a trend.
   */
  describe("a bill that does not vary by season", () => {
    it("estimates a flat bill at its price", () => {
      const profile = buildEstimateProfile(
        twoYears(() => -10),
        TODAY,
        2,
      )!;
      expect(profile.seasonal).toBe(false);
      expect(profile.growthRate).toBe(0);
      expect(months(profile, ["2026-12", "2027-03", "2027-11"])).toEqual([
        -10, -10, -10,
      ]);
    });

    it("reads billing noise as no season", () => {
      const profile = buildEstimateProfile(
        twoYears((month) => (month % 2 === 0 ? -100 : -104)),
        TODAY,
        2,
      )!;
      expect(profile.seasonal).toBe(false);
    });

    it("estimates a price step at the new price, over two years of history", () => {
      // 10 a month, 15 a month from May 2026.
      const profile = buildEstimateProfile(
        twoYears((month, year) => (year === 2026 && month >= 5 ? -15 : -10)),
        TODAY,
        2,
      )!;
      expect(profile.seasonal).toBe(false);
      expect(profile.growthRate).toBe(0);
      expect(
        months(profile, [
          "2026-12",
          "2027-01",
          "2027-04",
          "2027-05",
          "2027-11",
        ]),
      ).toEqual([-15, -15, -15, -15, -15]);
    });

    it("estimates a price step at the new price, over thirteen months of history", () => {
      const history = twoYears((month, year) =>
        year === 2026 && month >= 5 ? -15 : -10,
      ).filter((p) => p.date >= "2025-11-01");
      expect(history).toHaveLength(13);
      const profile = buildEstimateProfile(history, TODAY, 2)!;
      expect(months(profile, ["2026-12", "2027-04", "2027-11"])).toEqual([
        -15, -15, -15,
      ]);
    });
  });

  describe("a steady trend", () => {
    it("grows the latest price by the year-over-year rate", () => {
      // Every month 5% dearer than a year before.
      const profile = buildEstimateProfile(
        twoYears((month, year) =>
          year === 2026 || (year === 2025 && month === 12) ? -105 : -100,
        ),
        TODAY,
        2,
      )!;
      expect(profile.seasonal).toBe(false);
      expect(profile.growthRate).toBeCloseTo(0.05, 10);
      // From November 2026's -105: one month out, then a full year.
      expect(estimateForMonth(profile, "2026-12").amount).toBeCloseTo(
        -105 * Math.pow(1.05, 1 / 12),
        2,
      );
      expect(estimateForMonth(profile, "2027-11").amount).toBe(-110.25);
    });

    it("clamps a runaway growth rate", () => {
      const tripled = twoYears((month, year) =>
        year === 2026 || (year === 2025 && month === 12) ? -30 : -10,
      );
      expect(yearOverYearGrowth(tripled, TODAY)).toBe(ESTIMATE_GROWTH_MAX);
    });

    it("applies no trend with fewer than three months to compare", () => {
      const history = [
        { date: "2025-01-15", amount: -200 },
        { date: "2025-02-15", amount: -180 },
        { date: "2026-01-15", amount: -220 },
        { date: "2026-02-15", amount: -198 },
      ];
      expect(yearOverYearGrowth(history, TODAY)).toBe(0);
    });
  });

  describe("a seasonal bill", () => {
    // A heating bill's shape, January first; the latest year 10% dearer.
    const SHAPE = [200, 180, 150, 100, 60, 50, 50, 50, 60, 100, 150, 190];
    const heating = twoYears((month, year) => {
      const latest = year === 2026 || (year === 2025 && month === 12);
      return -SHAPE[month - 1] * (latest ? 1.1 : 1);
    });

    it("finds the season both years agree on", () => {
      const index = seasonalIndex(heating, TODAY)!;
      const yearMean = SHAPE.reduce((a, v) => a + v, 0) / 12;
      expect(index.get(1)).toBeCloseTo(200 / yearMean, 10);
      expect(index.get(7)).toBeCloseTo(50 / yearMean, 10);
    });

    it("shapes the latest level by the month's index and grows it", () => {
      const profile = buildEstimateProfile(heating, TODAY, 2)!;
      expect(profile.seasonal).toBe(true);
      expect(profile.growthRate).toBeCloseTo(0.1, 10);
      // The newest payments (Sep to Nov 2026) put a month of index 1 at
      // -1.1 x the shape's mean; January is 200 / mean of that, two months
      // past November, and July eight.
      expect(estimateForMonth(profile, "2027-01")).toEqual({
        amount: Number((-220 * Math.pow(1.1, 2 / 12)).toFixed(2)),
        basis: "seasonal",
      });
      expect(estimateForMonth(profile, "2027-07").amount).toBe(
        Number((-55 * Math.pow(1.1, 8 / 12)).toFixed(2)),
      );
      // A season and a trend do not compound into a runaway: next November
      // is last November's -165 grown one year.
      expect(estimateForMonth(profile, "2027-11").amount).toBe(-181.5);
    });

    it("is no season when only one year varies", () => {
      const oneYear = heating.map((p) =>
        p.date < "2025-12-01" ? { ...p, amount: -100 } : p,
      );
      expect(seasonalIndex(oneYear, TODAY)).toBeNull();
    });
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
});
