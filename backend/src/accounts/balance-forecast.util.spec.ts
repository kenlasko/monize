import {
  ForecastScheduleInput,
  accumulateForecastDeltas,
  addDaysYMD,
  buildForecastSeries,
} from "./balance-forecast.util";

function schedule(
  overrides: Partial<ForecastScheduleInput> = {},
): ForecastScheduleInput {
  return {
    accountId: "acc-1",
    transferAccountId: null,
    amount: -100,
    frequency: "MONTHLY",
    nextDueDate: "2024-07-15",
    endDate: null,
    occurrencesRemaining: null,
    ...overrides,
  };
}

describe("balance-forecast.util", () => {
  describe("addDaysYMD", () => {
    it("adds days across month boundaries", () => {
      expect(addDaysYMD("2024-07-08", 90)).toBe("2024-10-06");
      expect(addDaysYMD("2024-12-31", 1)).toBe("2025-01-01");
    });
  });

  describe("accumulateForecastDeltas", () => {
    const today = "2024-07-08";
    const horizon = "2024-10-08";

    it("expands recurring occurrences within the horizon", () => {
      const deltas = accumulateForecastDeltas(
        [schedule()],
        "acc-1",
        today,
        horizon,
      );
      // MONTHLY from 2024-07-15: Jul 15, Aug 15, Sep 15 (Oct 15 is past horizon).
      expect([...deltas.keys()].sort()).toEqual([
        "2024-07-15",
        "2024-08-15",
        "2024-09-15",
      ]);
      expect(deltas.get("2024-08-15")).toBe(-100);
    });

    it("treats a transfer target as an inflow", () => {
      const s = schedule({
        accountId: "other",
        transferAccountId: "acc-1",
        amount: -250,
      });
      const deltas = accumulateForecastDeltas([s], "acc-1", today, horizon);
      expect(deltas.get("2024-07-15")).toBe(250);
    });

    it("stops a ONCE schedule after one occurrence", () => {
      const deltas = accumulateForecastDeltas(
        [schedule({ frequency: "ONCE" })],
        "acc-1",
        today,
        horizon,
      );
      expect([...deltas.keys()]).toEqual(["2024-07-15"]);
    });

    it("respects the end date and remaining occurrences", () => {
      const capped = accumulateForecastDeltas(
        [schedule({ occurrencesRemaining: 2 })],
        "acc-1",
        today,
        horizon,
      );
      expect([...capped.keys()].sort()).toEqual(["2024-07-15", "2024-08-15"]);

      const ended = accumulateForecastDeltas(
        [schedule({ endDate: "2024-08-31" })],
        "acc-1",
        today,
        horizon,
      );
      expect([...ended.keys()].sort()).toEqual(["2024-07-15", "2024-08-15"]);
    });

    it("skips occurrences on or before today and merges with actuals", () => {
      const actuals = new Map([["2024-07-20", 500]]);
      const deltas = accumulateForecastDeltas(
        [schedule({ nextDueDate: "2024-07-01" })], // starts in the past
        "acc-1",
        today,
        horizon,
        actuals,
      );
      // The 2024-07-01 occurrence is <= today, so it is not added.
      expect(deltas.has("2024-07-01")).toBe(false);
      expect(deltas.get("2024-07-20")).toBe(500);
      expect(deltas.get("2024-08-01")).toBe(-100);
    });
  });

  describe("buildForecastSeries", () => {
    it("anchors at today and accumulates deltas", () => {
      const deltas = new Map([
        ["2024-07-15", -100],
        ["2024-08-15", -100],
      ]);
      const series = buildForecastSeries(
        1000,
        "2024-07-08",
        "2024-10-08",
        deltas,
      );
      expect(series).toEqual([
        { date: "2024-07-08", balance: 1000 },
        { date: "2024-07-15", balance: 900 },
        { date: "2024-08-15", balance: 800 },
      ]);
    });

    it("returns just the anchor when there are no future deltas", () => {
      const series = buildForecastSeries(
        500,
        "2024-07-08",
        "2024-10-08",
        new Map(),
      );
      expect(series).toEqual([{ date: "2024-07-08", balance: 500 }]);
    });
  });
});
