/**
 * `docs/specs/portfolio-twr-series.md` section 5, table-driven over the pure
 * series, and INV-PORTTWR-001 held as a property: over generated value and flow
 * paths the series' last point is `investedPeriodResult`'s return, and the
 * series is withheld exactly where that figure is.
 */
import { addDaysYMD } from "../common/date-utils";
import {
  EMPTY_INVESTED_FLOW_DAY,
  InvestedFlowDay,
} from "./invested-capital-flow.util";
import {
  InvestedDayValue,
  investedPeriodResult,
} from "./invested-period-result.util";
import { investedTwrSeries } from "./invested-twr-series.util";

const START = "2026-01-01";

function day(
  date: string,
  securitiesValue: number,
  flags: Partial<InvestedDayValue> = {},
): InvestedDayValue {
  return {
    date,
    securitiesValue,
    fxComplete: true,
    pricesComplete: true,
    missingRatePairs: [],
    unpricedSecurityIds: [],
    ...flags,
  };
}

function flow(partial: Partial<InvestedFlowDay>): InvestedFlowDay {
  return { ...EMPTY_INVESTED_FLOW_DAY, ...partial };
}

/** `values[i]` is the close of day `START + i`; index 0 is the baseline. */
function input(
  values: number[],
  flows: Record<number, Partial<InvestedFlowDay>> = {},
  flags: Record<number, Partial<InvestedDayValue>> = {},
) {
  const points = values.map((value, i) =>
    day(addDaysYMD(START, i), value, flags[i]),
  );
  const flowsByDay = new Map<string, InvestedFlowDay>(
    Object.entries(flows).map(([i, f]) => [
      addDaysYMD(START, Number(i)),
      flow(f),
    ]),
  );
  return {
    points,
    startIndex: 0,
    endIndex: points.length - 1,
    flowsByDay,
  };
}

const percents = (values: number[], flows = {}, flags = {}) =>
  investedTwrSeries(input(values, flows, flags)).points.map(
    (p) => p.returnPercent,
  );

describe("investedTwrSeries", () => {
  it("opens on the baseline close at zero, one point per day", () => {
    const result = investedTwrSeries(input([1000, 1100, 1210]));
    expect(result.complete).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.points.map((p) => p.date)).toEqual([
      "2026-01-01",
      "2026-01-02",
      "2026-01-03",
    ]);
    expect(result.points.map((p) => p.returnPercent)).toEqual([0, 10, 21]);
  });

  describe("section 5 worked examples", () => {
    it("1. a deposit is not a return: a buy funded at the start of the day", () => {
      // 1,000 held; day 1 buys 500 (IV 1,500); day 2 closes at 1,650.
      expect(percents([1000, 1500, 1650], { 1: { capitalIn: 500 } })).toEqual([
        0, 0, 10,
      ]);
    });

    it("2. a withdrawal is not a loss: a sale leaves at the end of the day", () => {
      // 2,000 held; day 1 sells 1,000 (IV 1,000); day 2 closes at 1,100.
      expect(percents([2000, 1000, 1100], { 1: { capitalOut: 1000 } })).toEqual(
        [0, 0, 10],
      );
    });

    it("3. a dividend is return", () => {
      expect(percents([1000, 1000], { 1: { income: 20 } })).toEqual([0, 2]);
    });

    it("4. nothing held is flat until the first day with capital at risk", () => {
      // Nothing on day 0; a 1,000 buy on day 2; 1,100 on day 3.
      expect(percents([0, 0, 1000, 1100], { 2: { capitalIn: 1000 } })).toEqual([
        0, 0, 0, 10,
      ]);
    });
  });

  it("a negative day is drawn as negative and rounds negative zero to zero", () => {
    const result = percents([1000, 900, 1000]);
    expect(result).toEqual([0, -10, 0]);
    expect(Object.is(result[2], -0)).toBe(false);
  });

  it("a known zero (nothing ever at risk, nothing earned) is a flat line at zero", () => {
    const result = investedTwrSeries(input([0, 0, 0]));
    expect(result.complete).toBe(true);
    expect(result.points.map((p) => p.returnPercent)).toEqual([0, 0, 0]);
  });

  describe("withheld exactly where the period result is", () => {
    it("a subtotal day inside the window withholds the whole series", () => {
      const result = investedTwrSeries(
        input([1000, 1100, 1200], {}, { 1: { pricesComplete: false } }),
      );
      expect(result.complete).toBe(false);
      expect(result.points).toEqual([]);
      expect(result.reasons).toContain("incompletePrices");
    });

    it("a missing rate withholds with missingRatePairs", () => {
      const result = investedTwrSeries(
        input([1000, 1100, 1200], {}, { 2: { fxComplete: false } }),
      );
      expect(result.points).toEqual([]);
      expect(result.reasons).toContain("missingRatePairs");
    });

    it("a flow that did not convert withholds with missingRatePairs", () => {
      const result = investedTwrSeries(
        input([1000, 1100], {
          1: { complete: false, missingPairs: ["EUR->USD"] },
        }),
      );
      expect(result.points).toEqual([]);
      expect(result.reasons).toContain("missingRatePairs");
    });

    it("nothing at risk but something earned has no ratio: zeroStart", () => {
      // No base on any day, yet the securities moved: the period result
      // reports no figure and so does the series.
      const result = investedTwrSeries(input([0, 0, 50], { 2: { income: 5 } }));
      const decision = investedPeriodResult(
        input([0, 0, 50], { 2: { income: 5 } }),
      );
      expect(decision.investmentReturnPercent).toBeNull();
      expect(result.points).toEqual([]);
      expect(result.reasons).toEqual(decision.investedReasons);
    });

    it("an empty series has no window and no points", () => {
      const result = investedTwrSeries({
        points: [],
        startIndex: 0,
        endIndex: 0,
        flowsByDay: new Map(),
      });
      expect(result.points).toEqual([]);
      expect(result.reasons).toEqual(["noValueSeries"]);
    });
  });

  describe("INV-PORTTWR-001: the line ends where the card ends", () => {
    // A small deterministic generator, so a failure is reproducible.
    function lcg(seed: number) {
      let s = seed;
      return () => {
        s = (s * 1664525 + 1013904223) % 4294967296;
        return s / 4294967296;
      };
    }

    it.each([1, 2, 3, 4, 5, 6, 7, 8])(
      "random path seeded %i: last point equals the decision's return",
      (seed) => {
        const rand = lcg(seed);
        const days = 40;
        const values: number[] = [Math.round(rand() * 5000)];
        const flows: Record<number, Partial<InvestedFlowDay>> = {};
        for (let i = 1; i <= days; i++) {
          const move = 1 + (rand() - 0.5) * 0.06;
          let next = Math.max(0, values[i - 1] * move);
          const f: Partial<InvestedFlowDay> = {};
          if (rand() < 0.2) {
            const buy = Math.round(rand() * 2000);
            f.capitalIn = buy;
            next += buy;
          }
          if (rand() < 0.15 && next > 100) {
            const sell = Math.min(next, Math.round(rand() * 1500));
            f.capitalOut = sell;
            next -= sell;
          }
          if (rand() < 0.1) f.income = Math.round(rand() * 40);
          if (Object.keys(f).length > 0) flows[i] = f;
          values.push(Math.round(next * 100) / 100);
        }

        const data = input(values, flows);
        const series = investedTwrSeries(data);
        const decision = investedPeriodResult(data);

        if (decision.investmentReturnPercent === null) {
          expect(series.complete).toBe(false);
          expect(series.points).toEqual([]);
        } else {
          expect(series.complete).toBe(true);
          expect(series.points).toHaveLength(days + 1);
          expect(series.points[series.points.length - 1].returnPercent).toBe(
            decision.investmentReturnPercent,
          );
        }
      },
    );

    it("a sub-window ends on the decision for that sub-window", () => {
      const data = input([1000, 1100, 1210, 1331, 1464.1]);
      const window = { ...data, startIndex: 1, endIndex: 3 };
      const series = investedTwrSeries(window);
      expect(series.points.map((p) => p.date)).toEqual([
        "2026-01-02",
        "2026-01-03",
        "2026-01-04",
      ]);
      expect(series.points[series.points.length - 1].returnPercent).toBe(
        investedPeriodResult(window).investmentReturnPercent,
      );
      expect(series.points[0].returnPercent).toBe(0);
    });
  });
});
