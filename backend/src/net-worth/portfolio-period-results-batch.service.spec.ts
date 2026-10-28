jest.mock("../accruals/reporting-basis", () =>
  jest
    .requireActual("../test-helpers/reporting-read-testing")
    .reportingBasisMockModule(),
);
import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";

import { addDaysYMD } from "../common/date-utils";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { UserPreference } from "../users/entities/user-preference.entity";
import { NetWorthService } from "./net-worth.service";
import {
  PORTFOLIO_PERIOD_PRESETS,
  PortfolioPeriodPreset,
  presetWindowStart,
  usesPriorCloseBaseline,
} from "./portfolio-period-presets.util";
import { PortfolioPeriodResults } from "./portfolio-period-results-batch.service";
import { PortfolioPeriodResultService } from "./portfolio-period-result.service";
import { PortfolioPeriodResultsBatchService } from "./portfolio-period-results-batch.service";
import { ExchangeRateService } from "../currencies/exchange-rate.service";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

jest.mock("../common/date-utils", () => ({
  ...jest.requireActual("../common/date-utils"),
  todayYMD: jest.fn(() => "2026-09-17"),
}));

const TODAY = "2026-09-17";

interface FakeRow {
  [key: string]: unknown;
}

interface SeriesPoint {
  date: string;
  value: number;
  securitiesValue: number;
  fxComplete: boolean;
  missingRatePairs: string[];
  pricesComplete: boolean;
  unpricedSecurityIds: string[];
  cashComplete: boolean;
  unknownCashAccountIds: string[];
}

/** The scope holds a flat 2,000 of uninvested cash on every day of the series. */
const SERIES_CASH = 2_000;

function point(date: string, value: number): SeriesPoint {
  return {
    date,
    value,
    securitiesValue: value - SERIES_CASH,
    fxComplete: true,
    missingRatePairs: [],
    pricesComplete: true,
    unpricedSecurityIds: [],
    cashComplete: true,
    unknownCashAccountIds: [],
  };
}

/**
 * A full year of daily closes ending today: flat at 10,000 until a 10,000
 * deposit on 2026-06-01 doubles it, then one real gain of 200 on the last day.
 *
 * The deposit is deliberately inside the YTD and 1Y windows and outside the 3M
 * one (which opens on 2026-06-19), so a preset that took the wrong slice of the
 * flows would report the reader's own money as a gain in one window or lose a
 * real one in another.
 */
function canonicalSeries(from = "2025-09-17", to = TODAY): SeriesPoint[] {
  const points: SeriesPoint[] = [];
  for (let date = from; date <= to; date = addDaysYMD(date, 1)) {
    const value =
      date === TODAY ? 20_200 : date >= "2026-06-01" ? 20_000 : 10_000;
    points.push(point(date, value));
  }
  return points;
}

describe("PortfolioPeriodResultsBatchService", () => {
  let batch: PortfolioPeriodResultsBatchService;
  let single: PortfolioPeriodResultService;
  let netWorth: {
    getDailyInvestments: jest.Mock;
    getLastPricedDays: jest.Mock;
    loadValuationSeries: jest.Mock;
  };
  /** The accepted closes a share-moving leg is valued from; see the single-range spec. */
  let storedCloses: Map<string, Array<{ date: string; close: number }>>;
  let exchangeRates: { ensureRatesForDate: jest.Mock };
  let mocks: ReturnType<typeof createScopedDbMocks>;
  let scopeRows: FakeRow[];
  let flowRows: Array<{ date: string; currency: string; total: string }>;
  let investedRows: Array<{
    date: string;
    currency: string;
    action: string;
    total: string;
    gross: string;
  }>;
  let rateRows: FakeRow[];
  let settledTradeDays: Array<{ date: string; count: string }>;
  let shareTransferDays: Array<{ date: string; count: string }>;
  let mixedSplitDays: Array<{ date: string; count: string }>;
  let series: SeriesPoint[];
  let inception: string | null;
  let queries: Array<{ sql: string; params: unknown[] }>;

  beforeEach(async () => {
    queries = [];
    scopeRows = [
      {
        id: "brok-1",
        account_type: "INVESTMENT",
        account_sub_type: "INVESTMENT_BROKERAGE",
      },
      {
        id: "cash-1",
        account_type: "INVESTMENT",
        account_sub_type: "INVESTMENT_CASH",
      },
    ];
    series = canonicalSeries();
    // The day the scope's first holding was bought: one day into the series,
    // so the all-time window has the close before it to measure from.
    inception = "2025-09-18";
    flowRows = [{ date: "2026-06-01", currency: "CAD", total: "10000" }];
    // The deposit of 2026-06-01 is invested the same day, so the invested part
    // grows by a capital flow rather than by a gain: the day contributes factor
    // 1 to every preset whose window holds it.
    investedRows = [
      {
        date: "2026-06-01",
        currency: "CAD",
        action: "BUY",
        total: "10000",
        gross: "10000",
      },
    ];
    rateRows = [];
    settledTradeDays = [];
    shareTransferDays = [];
    mixedSplitDays = [];

    const preferenceRepo = {
      findOne: jest.fn(async () => ({ defaultCurrency: "CAD" })),
    };
    mocks = createScopedDbMocks([[UserPreference, preferenceRepo]]);
    // Every loader is answered the way the database would answer it: the rows
    // in the window the statement asked for, per day where it asked per day.
    // Slicing is the whole claim under test, so a mock that ignored the bounds
    // would make the batch and the single route agree by construction.
    mocks.manager.query.mockImplementation(
      async (sql: string, params: unknown[]) => {
        queries.push({ sql, params });
        const after = params[1] as string;
        const through = params[2] as string;
        const inWindow = (date: string) => date > after && date <= through;
        const perDay = sql.includes("TO_CHAR");
        const counts = (days: Array<{ date: string; count: string }>) => {
          const rows = days.filter((day) => inWindow(day.date));
          if (perDay) return rows;
          const total = rows.reduce((sum, row) => sum + Number(row.count), 0);
          return [{ date: null, count: String(total) }];
        };
        if (sql.includes("MIN(it.transaction_date)"))
          return [{ date: inception }];
        if (sql.includes("it.action AS action"))
          return investedRows.filter((row) => inWindow(row.date));
        if (sql.includes("SUM(t.amount)"))
          return flowRows.filter((row) => inWindow(row.date));
        if (sql.includes("it.funding_account_id"))
          return counts(settledTradeDays);
        if (sql.includes("it.linked_transaction_id"))
          return counts(shareTransferDays);
        if (sql.includes("COUNT(*) AS count")) return counts(mixedSplitDays);
        if (sql.includes("FROM exchange_rates")) return rateRows;
        if (sql.includes("FROM accounts")) return scopeRows;
        throw new Error(`unexpected query: ${sql}`);
      },
    );

    storedCloses = new Map();
    netWorth = {
      loadValuationSeries: jest.fn(async () => ({
        stored: storedCloses,
        txFallback: new Map(),
      })),
      getDailyInvestments: jest.fn(
        async (_userId: string, from: string, to: string) =>
          series.filter((p) => p.date >= from && p.date <= to),
      ),
      // The fixture series runs over calendar days and every one of them
      // carries a close, so each boundary's session is its own day.
      getLastPricedDays: jest.fn(
        async (_userId: string, boundaries: readonly string[]) =>
          new Map(boundaries.map((day) => [day, day])),
      ),
    };

    exchangeRates = { ensureRatesForDate: jest.fn(async () => 0) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PortfolioPeriodResultService,
        PortfolioPeriodResultsBatchService,
        { provide: DataSource, useValue: mocks.dataSource },
        { provide: NetWorthService, useValue: netWorth },
        { provide: ExchangeRateService, useValue: exchangeRates },
      ],
    }).compile();

    batch = module.get(PortfolioPeriodResultsBatchService);
    single = module.get(PortfolioPeriodResultService);
  });

  afterEach(() => jest.restoreAllMocks());

  /**
   * What the client used to send for one preset: the window's start, plus the
   * close before the window's first point where the preset reports against the
   * prior close (`usesPriorCloseBaseline`, `previousCalendarDay`).
   */
  /**
   * The windows the answer actually reports. A long window the fixture's
   * history does not reach back to is absent rather than "n/a", so the
   * equivalence loops below compare what was reported, and the cases further
   * down assert WHICH windows those are.
   */
  const reported = (results: PortfolioPeriodResults): PortfolioPeriodPreset[] =>
    Object.keys(results.periods) as PortfolioPeriodPreset[];

  const singleRouteArgs = (preset: PortfolioPeriodPreset) => {
    // `all` has no arithmetic of its own: it opens where the scope's history
    // does, which is the date the batch route asked the database for.
    const startDate = presetWindowStart(preset, TODAY) ?? inception ?? TODAY;
    const firstPoint = series.find((p) => p.date >= startDate);
    const baselineDate =
      usesPriorCloseBaseline(preset) && firstPoint
        ? addDaysYMD(firstPoint.date, -1)
        : undefined;
    return { startDate, endDate: TODAY, baselineDate };
  };

  it("answers every preset with what the single-range route answers", async () => {
    const results = await batch.getPeriodResults("user-1");

    expect(reported(results).length).toBeGreaterThan(0);
    for (const preset of reported(results)) {
      const expected = await single.getPeriodResult(
        "user-1",
        singleRouteArgs(preset),
      );
      expect(results.periods[preset]).toEqual(expected);
    }
  });

  it("answers every preset with the same money-weighted figures as the single route", async () => {
    // The MWR is a second figure of one measure, sliced from the same series
    // and the same per-day flows, so the two routes cannot disagree about it
    // any more than they may about the TWR (spec section 11.8).
    const results = await batch.getPeriodResults("user-1");

    for (const preset of reported(results)) {
      const expected = await single.getPeriodResult(
        "user-1",
        singleRouteArgs(preset),
      );
      expect(results.periods[preset]).toMatchObject({
        investmentMoneyWeightedReturnPercent:
          expected.investmentMoneyWeightedReturnPercent,
        investmentMoneyWeightedTotalPercent:
          expected.investmentMoneyWeightedTotalPercent,
        investmentMoneyWeightedMethod: "xirr",
      });
    }
    // Not a vacuous comparison of two nulls: the year-to-date window is long
    // enough to annualise and carries a rate.
    expect(results.periods.ytd?.investmentMoneyWeightedReturnPercent).toEqual(
      expect.any(Number),
    );
    // A week is not long enough to annualise, and says so rather than
    // printing a week's move as a claim about a year.
    expect(
      results.periods["1w"]?.investmentMoneyWeightedReturnPercent,
    ).toBeNull();
    expect(results.periods["1w"]?.investedReasons).toContain("windowTooShort");
    expect(results.periods["1w"]?.investmentMoneyWeightedTotalPercent).toEqual(
      expect.any(Number),
    );
  });

  it("dates each preset's gaps from its own slice, as the single route does", async () => {
    // Two outages of one security: one inside the 3M window, one only the
    // wider windows reach back to. A preset folding the whole series would
    // report a gap from before its own window opened, which is a repair the
    // reader's figure does not depend on (#1392).
    const unpriced = (date: string) => {
      const p = series.find((point) => point.date === date)!;
      p.pricesComplete = false;
      p.unpricedSecurityIds = ["sec-1"];
    };
    unpriced("2026-01-05");
    unpriced("2026-01-06");
    unpriced("2026-08-10");

    const results = await batch.getPeriodResults("user-1");

    for (const preset of reported(results)) {
      const expected = await single.getPeriodResult(
        "user-1",
        singleRouteArgs(preset),
      );
      expect(results.periods[preset]?.incompleteRanges).toEqual(
        expected.incompleteRanges,
      );
    }
    // Not a vacuous comparison of two empty lists: the year holds both runs,
    // the quarter only the newer one.
    expect(results.periods["1y"]?.incompleteRanges.prices).toEqual([
      { key: "sec-1", start: "2026-01-05", end: "2026-01-06" },
      { key: "sec-1", start: "2026-08-10", end: "2026-08-10" },
    ]);
    expect(results.periods["3m"]?.incompleteRanges.prices).toEqual([
      { key: "sec-1", start: "2026-08-10", end: "2026-08-10" },
    ]);
  });

  it("builds the value series once, over the widest window asked for", async () => {
    await batch.getPeriodResults("user-1");

    expect(netWorth.getDailyInvestments).toHaveBeenCalledTimes(1);
    expect(netWorth.getDailyInvestments).toHaveBeenCalledWith(
      "user-1",
      // 1Y opens on 2025-09-17; nothing reaches further back.
      "2025-09-17",
      TODAY,
      undefined,
      "CAD",
      { fetchMissing: undefined },
    );
  });

  it("loads only what the presets asked for need", async () => {
    await batch.getPeriodResults("user-1", { periods: ["1d", "1w"] });

    expect(netWorth.getDailyInvestments).toHaveBeenCalledWith(
      "user-1",
      // A prior-close preset reaches one day further back than its window.
      "2026-09-09",
      TODAY,
      undefined,
      "CAD",
      { fetchMissing: undefined },
    );
    const flowQuery = queries.find((q) => q.sql.includes("SUM(t.amount)"))!;
    expect(flowQuery.params[1]).toBe("2026-09-09");
    // The flow is drawn around the sleeve, with the whole scope as the
    // investment scope an imported trade's sleeve leg settles inside.
    expect(flowQuery.params[3]).toEqual(["cash-1"]);
    expect(flowQuery.params[4]).toEqual(["brok-1", "cash-1"]);
  });

  it("measures a day against the previous close", async () => {
    const results = await batch.getPeriodResults("user-1", { periods: ["1d"] });

    expect(results.periods["1d"]).toMatchObject({
      startDate: "2026-09-16",
      endDate: TODAY,
      startValue: 20_000,
      endValue: 20_200,
      valueChange: 200,
      netExternalFlows: 0,
      investmentResult: 200,
      returnPercent: 1,
      complete: true,
      reasons: [],
    });
  });

  /**
   * The issue's defect, sliced: the 10,000 deposit of 2026-06-01 is inside YTD
   * and outside 3M. A window that counted it as performance would report a 3M
   * gain of 10,200 and a YTD return of 102%; only the last day's 200 was earned.
   */
  it("counts a flow in the windows that contain it, and in no others", async () => {
    const results = await batch.getPeriodResults("user-1");

    expect(results.periods.ytd).toMatchObject({
      valueChange: 10_200,
      netExternalFlows: 10_000,
      investmentResult: 200,
      returnPercent: 2,
    });
    expect(results.periods["3m"]).toMatchObject({
      valueChange: 200,
      netExternalFlows: 0,
      investmentResult: 200,
      returnPercent: 1,
    });
  });

  /**
   * The same slicing, read through the invested measure (spec section 10): the
   * 10,000 that arrived on 2026-06-01 was INVESTED that day, so it is a capital
   * flow in the windows that contain it and factor 1 on its own day. The 2,000
   * of idle cash is in neither window's base, which is why the invested return
   * is larger than the account-level one over the same days.
   */
  it("slices the invested figures per preset from the one load", async () => {
    const results = await batch.getPeriodResults("user-1");

    expect(results.periods.ytd).toMatchObject({
      investedValueStart: 8_000,
      investedValueEnd: 18_200,
      investmentCapitalFlows: 10_000,
      investmentIncome: 0,
      investmentPnl: 200,
      // 18,000 / (8,000 + 10,000) = 1 on the purchase day, 18,200 / 18,000 on
      // the last: the deposit that was invested is not a gain.
      investmentReturnPercent: 1.11,
      investmentReturnMethod: "twr",
      investedComplete: true,
      investedReasons: [],
    });
    // The purchase is outside the 3M window, which sees only the real gain.
    expect(results.periods["3m"]).toMatchObject({
      investmentCapitalFlows: 0,
      investmentPnl: 200,
      investmentReturnPercent: 1.11,
    });
    // The account-level return over the same days divides by a base that holds
    // the idle cash, so the two measures disagree -- and each says which it is.
    expect(results.periods.ytd?.returnPercent).toBe(2);
  });

  it("loads the invested capital and income once, over the widest window", async () => {
    await batch.getPeriodResults("user-1");

    const investedQueries = queries.filter((q) =>
      q.sql.includes("it.action AS action"),
    );
    expect(investedQueries).toHaveLength(1);
    expect(investedQueries[0].params[1]).toBe("2025-09-17");
    expect(investedQueries[0].params[2]).toBe(TODAY);
  });

  it("withholds a window that holds an uncountable movement, and no other", async () => {
    settledTradeDays = [{ date: "2026-06-02", count: "1" }];

    const results = await batch.getPeriodResults("user-1");

    expect(results.periods["1y"]).toMatchObject({
      investmentResult: null,
      returnPercent: null,
      reasons: ["externallySettledTrade"],
      valueChange: 10_200,
    });
    // The invested measure does not read where a trade's cash settled (#1516).
    expect(results.periods["1y"]?.investedReasons).toEqual([]);
    expect(results.periods["1y"]?.investmentPnl).not.toBeNull();
    // The trade is outside the 1M window, which stays measurable.
    expect(results.periods["1m"]).toMatchObject({
      investmentResult: 200,
      reasons: [],
    });
  });

  it("says nothing for a period the history does not reach back to", async () => {
    series = canonicalSeries("2026-09-15");
    inception = "2026-09-16";

    const results = await batch.getPeriodResults("user-1");

    // Three days of history: the day is measurable, the year is not, and the
    // year is not measured from the first day the portfolio existed.
    expect(results.periods["1d"]?.investmentResult).toBe(200);
    expect(results.periods["1y"]).toMatchObject({
      startDate: "2025-09-17",
      valueChange: null,
      investmentResult: null,
      returnPercent: null,
      reasons: ["noValueSeries"],
    });
  });

  /**
   * The long windows, and the rule that decides whether a reader sees them.
   *
   * A window a portfolio cannot have is not an "n/a" worth a row: unlike a
   * window withheld for a missing price, there is nothing the reader could add
   * to fill it in, and six of them under a card the width of a chart's margin
   * is noise. So the answer reports the long windows the scope's history
   * reaches back to, and leaves the rest out.
   */
  describe("the long windows", () => {
    /** A scope whose first holding was bought on `first`, valued from the day before. */
    const historyFrom = (first: string) => {
      inception = first;
      series = canonicalSeries(addDaysYMD(first, -1));
    };

    it("leaves out a window the scope's history does not reach back to", async () => {
      // One year of history: 2Y opens 730 days ago, 5Y and 10Y earlier still.
      const results = await batch.getPeriodResults("user-1");

      expect(results.periods["2y"]).toBeUndefined();
      expect(results.periods["5y"]).toBeUndefined();
      expect(results.periods["10y"]).toBeUndefined();
      // And nothing wider than the year was valued for them.
      expect(netWorth.getDailyInvestments).toHaveBeenCalledWith(
        "user-1",
        "2025-09-17",
        TODAY,
        undefined,
        "CAD",
        { fetchMissing: undefined },
      );
    });

    it("reports a window the history does reach back to", async () => {
      historyFrom("2015-01-02");

      const results = await batch.getPeriodResults("user-1");

      // A portfolio older than the widest window has every window there is.
      expect(reported(results).sort()).toEqual(
        [...PORTFOLIO_PERIOD_PRESETS].sort(),
      );
      for (const preset of ["2y", "5y", "10y"] as const) {
        expect(results.periods[preset]).toMatchObject({
          startDate: presetWindowStart(preset, TODAY),
          endDate: TODAY,
          investmentPnl: expect.any(Number),
        });
      }
    });

    it("keeps a window whose history reaches it and drops the one it does not", async () => {
      // Three years: 2Y is inside the history, 5Y and 10Y are not. The
      // boundary is the window's own start, not the widest window asked for.
      historyFrom("2023-09-16");

      const results = await batch.getPeriodResults("user-1");

      expect(results.periods["2y"]).toBeDefined();
      expect(results.periods["5y"]).toBeUndefined();
      expect(results.periods["10y"]).toBeUndefined();
    });

    it("opens the all-time window on the scope's first holding", async () => {
      const results = await batch.getPeriodResults("user-1");

      // Measured from the close BEFORE the first purchase: that day's own
      // close already holds it, so opening there would drop the day that
      // bought the portfolio out of the chain.
      expect(results.periods.all).toMatchObject({
        startDate: addDaysYMD(inception as string, -1),
        endDate: TODAY,
      });
    });

    it("answers the all-time window with the since-inception figures", async () => {
      // Two surfaces, one question: the card's all-time row and the portfolio
      // summary's since-inception return must not open on different days or
      // divide by different bases.
      const results = await batch.getPeriodResults("user-1");
      const sinceInception =
        await single.getInvestedResultSinceInception("user-1");

      expect(results.periods.all).toEqual(sinceInception);
    });

    it("leaves out the all-time window for a scope that has never held anything", async () => {
      inception = null;

      const results = await batch.getPeriodResults("user-1");

      expect(results.periods.all).toBeUndefined();
      // The short windows are still answered: they are what a portfolio with
      // no holdings is shown, and they report the nothing it did.
      expect(results.periods["1m"]).toBeDefined();
    });

    it("asks the database where the history starts exactly once", async () => {
      await batch.getPeriodResults("user-1");

      expect(
        queries.filter((q) => q.sql.includes("MIN(it.transaction_date)")),
      ).toHaveLength(1);
    });

    it("asks nothing about history when no window needs it", async () => {
      await batch.getPeriodResults("user-1", { periods: ["1m", "ytd"] });

      expect(
        queries.filter((q) => q.sql.includes("MIN(it.transaction_date)")),
      ).toHaveLength(0);
    });
  });

  it("reports in the currency it was asked for", async () => {
    const results = await batch.getPeriodResults("user-1", {
      displayCurrency: "USD",
      periods: ["1m"],
    });

    expect(results.currency).toBe("USD");
    expect(results.periods["1m"]?.currency).toBe("USD");
    expect(netWorth.getDailyInvestments).toHaveBeenCalledWith(
      "user-1",
      "2026-08-18",
      TODAY,
      undefined,
      "USD",
      { fetchMissing: undefined },
    );
  });

  it("answers every ungated preset for a scope with no accounts, and values none", async () => {
    scopeRows = [];

    const results = await batch.getPeriodResults("user-1");

    // A scope with no accounts has no history, so the windows that exist only
    // where history does are not reported at all -- including all-time, which
    // has no first holding to open on.
    expect(reported(results).sort()).toEqual([
      "1d",
      "1m",
      "1w",
      "1y",
      "3m",
      "ytd",
    ]);
    for (const preset of reported(results)) {
      expect(results.periods[preset]).toMatchObject({
        valueChange: null,
        investmentResult: null,
        reasons: ["noValueSeries"],
      });
    }
    expect(netWorth.getDailyInvestments).not.toHaveBeenCalled();
  });

  it("names the day every period is measured to", async () => {
    const results = await batch.getPeriodResults("user-1", { periods: ["1m"] });

    expect(results.asOf).toBe(TODAY);
    expect(results.periods["1m"]?.endDate).toBe(TODAY);
    expect(results.periods["3m"]).toBeUndefined();
  });

  describe("read-path FX fill", () => {
    // A EUR deposit into a CAD-reported portfolio with no stored EUR rate: the
    // flow is the component that cannot convert, so the batch asks the
    // provider ONCE for the whole window, not once per preset (#1390).
    const eurFlow = () => {
      flowRows = [{ date: "2026-06-01", currency: "EUR", total: "10000" }];
    };

    it("asks the provider once for the month the flow could not convert", async () => {
      eurFlow();

      const results = await batch.getPeriodResults("user-1");

      expect(exchangeRates.ensureRatesForDate).toHaveBeenCalledTimes(1);
      expect(exchangeRates.ensureRatesForDate).toHaveBeenCalledWith(
        [{ from: "EUR", to: "CAD" }],
        "2026-06-01",
      );
      // Nothing was stored: every window holding the flow stays withheld, and
      // the 3M window, which does not hold it, is unaffected.
      expect(results.periods["1y"]?.netExternalFlows).toBeNull();
      expect(results.periods["1y"]?.missingRatePairs).toContain("EUR->CAD");
      expect(results.periods["3m"]?.netExternalFlows).toBe(0);
    });

    it("re-reads the rates once and every preset sees the filled index", async () => {
      eurFlow();
      exchangeRates.ensureRatesForDate.mockImplementation(async () => {
        rateRows = [
          {
            from_currency: "EUR",
            to_currency: "CAD",
            rate: "1.5",
            rate_date: "2026-06-01",
          },
        ];
        return 20;
      });

      const results = await batch.getPeriodResults("user-1");

      expect(exchangeRates.ensureRatesForDate).toHaveBeenCalledTimes(1);
      expect(results.periods["1y"]?.netExternalFlows).toBe(15_000);
      expect(results.periods["ytd"]?.netExternalFlows).toBe(15_000);
      expect(results.periods["1y"]?.missingRatePairs).toEqual([]);
    });

    it("makes no provider call, on either half, when the caller opted out", async () => {
      eurFlow();

      const results = await batch.getPeriodResults("user-1", {
        fetchMissing: false,
      });

      expect(exchangeRates.ensureRatesForDate).not.toHaveBeenCalled();
      expect(netWorth.getDailyInvestments).toHaveBeenCalledWith(
        "user-1",
        "2025-09-17",
        TODAY,
        undefined,
        "CAD",
        { fetchMissing: false },
      );
      expect(results.periods["1y"]?.netExternalFlows).toBeNull();
    });
  });
});
