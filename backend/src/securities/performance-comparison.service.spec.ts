import { NotFoundException } from "@nestjs/common";
import { PerformanceComparisonService } from "./performance-comparison.service";
import { MarketIndexService } from "./market-index.service";
import { SecurityPriceService } from "./security-price.service";
import { LoadedPriceSeries } from "../common/time-series/price-series.util";
import { Security } from "./entities/security.entity";
import {
  createScopedDbMocks,
  DataSourceMock,
  ManagerMock,
} from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

// The security price load goes through the shared per-series-basis loader; the
// loader's own SQL is asserted in its spec, so here it is stubbed and the
// service's arithmetic is what is under test.
jest.mock("../common/time-series/price-series.util", () => {
  const actual = jest.requireActual("../common/time-series/price-series.util");
  return { ...actual, loadPriceSeries: jest.fn() };
});
import { loadPriceSeries } from "../common/time-series/price-series.util";

const USER = "11111111-1111-4111-8111-111111111111";
const SEC_A = "22222222-2222-4222-8222-222222222222";
const SEC_B = "33333333-3333-4333-8333-333333333333";

/**
 * A security row as the repository hands it back. The backfill attempt stamp is
 * fresh by default so the deep-backfill cooldown holds and specs exercise the
 * read path; the backfill specs construct their own stampless rows.
 */
function security(id: string, symbol: string, currencyCode = "USD"): Security {
  return {
    id,
    userId: USER,
    symbol,
    name: `${symbol} Inc`,
    currencyCode,
    skipPriceUpdates: false,
    historicalBackfillAttemptedAt: new Date(),
  } as Security;
}

/** One row of the activity query, driver-shaped. */
function activityRow(
  securityId: string,
  firstUsablePrice: string | null,
  firstTransaction: string | null,
) {
  return {
    security_id: securityId,
    first_usable_price: firstUsablePrice,
    first_transaction: firstTransaction,
  };
}

/** A close series, oldest first, exactly as the loader hands it over. */
function series(
  points: Array<[string, number]>,
  basis: LoadedPriceSeries["basis"] = "ADJUSTED",
): LoadedPriceSeries {
  return {
    basis,
    points: points.map(([date, close]) => ({ date, close })),
  };
}

/** A lone early observation ahead of a continuous run. */
function withHead(
  head: [string, number],
  rest: LoadedPriceSeries,
): LoadedPriceSeries {
  return {
    basis: rest.basis,
    points: [{ date: head[0], close: head[1] }, ...rest.points],
  };
}

function shift(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * A regularly-observed series from `from` to `to`, closing at `startClose` and
 * `endClose` with a straight line between.
 *
 * Fixtures matter here more than usual. A series carrying three points across a
 * year is a shape the loader never emits for daily sampling, and a spec built on
 * one exercises only the half of the code that walks boundaries -- the
 * stride-checking half then looks broken when it correctly reports ten
 * unobserved months (financial contract section 8.3). `stepDays` defaults to a
 * week, inside every carry-forward bound, so these read as continuous history.
 */
function dense(
  from: string,
  to: string,
  startClose: number,
  endClose: number,
  stepDays = 7,
  basis: LoadedPriceSeries["basis"] = "ADJUSTED",
): LoadedPriceSeries {
  const points: Array<[string, number]> = [];
  const span =
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
    86_400_000;
  for (let day = 0; day < span; day += stepDays) {
    points.push([
      shift(from, day),
      startClose + ((endClose - startClose) * day) / span,
    ]);
  }
  points.push([to, endClose]);
  return series(points, basis);
}

describe("PerformanceComparisonService", () => {
  let service: PerformanceComparisonService;
  let manager: ManagerMock;
  let dataSource: DataSourceMock;
  let securityRepo: Record<string, jest.Mock>;
  let marketIndexService: jest.Mocked<
    Pick<MarketIndexService, "ensureHistory" | "loadSeries">
  >;
  let securityPriceService: jest.Mocked<
    Pick<SecurityPriceService, "backfillSecurityRange">
  >;

  afterEach(() => {
    jest.useRealTimers();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    securityRepo = {
      find: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue(undefined),
    };
    const mocks = createScopedDbMocks([[Security, securityRepo]]);
    manager = mocks.manager;
    dataSource = mocks.dataSource;
    // The activity/window queries; overridden per test.
    manager.query.mockResolvedValue([]);
    marketIndexService = {
      ensureHistory: jest.fn().mockResolvedValue(undefined),
      loadSeries: jest.fn().mockResolvedValue(new Map()),
    };
    securityPriceService = {
      backfillSecurityRange: jest.fn().mockResolvedValue(0),
    };
    service = new PerformanceComparisonService(
      dataSource as never,
      marketIndexService as never,
      securityPriceService as never,
    );
  });

  /** Wire one security with the given series and run a 2025 calendar-year window. */
  async function runYear(
    loaded: Map<string, LoadedPriceSeries>,
    securities: Security[] = [security(SEC_A, "AAA")],
    indexCodes: string[] = [],
  ) {
    securityRepo.find.mockResolvedValue(securities);
    (loadPriceSeries as jest.Mock).mockResolvedValue(loaded);
    return service.getComparison(USER, {
      securityIds: securities.map((s) => s.id),
      indexCodes,
      startDate: "2025-01-01",
      endDate: "2025-12-31",
    });
  }

  // --- ownership -----------------------------------------------------------

  it("refuses a security the caller does not own, and leaks nothing about it", async () => {
    securityRepo.find.mockResolvedValue([]);
    await expect(
      service.getComparison(USER, {
        securityIds: [SEC_A],
        indexCodes: [],
        startDate: "2025-01-01",
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(loadPriceSeries).not.toHaveBeenCalled();
  });

  it("refuses when only some of the requested securities are owned", async () => {
    securityRepo.find.mockResolvedValue([security(SEC_A, "AAA")]);
    await expect(
      service.getComparison(USER, {
        securityIds: [SEC_A, SEC_B],
        indexCodes: [],
        startDate: "2025-01-01",
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("scopes the ownership read to the caller", async () => {
    await runYear(
      new Map([[SEC_A, dense("2024-12-30", "2025-12-30", 100, 110)]]),
    );
    expect(securityRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: USER }),
      }),
    );
  });

  // --- the ordinary case ---------------------------------------------------

  it("rebases on the close standing for the window start", async () => {
    const view = await runYear(
      new Map([[SEC_A, dense("2024-12-30", "2025-12-30", 100, 125)]]),
    );

    expect(view.series).toHaveLength(1);
    expect(view.series[0]).toMatchObject({
      key: `sec:${SEC_A}`,
      kind: "SECURITY",
      label: "AAA",
      basis: "ADJUSTED",
    });
    // Every included series leaves the axis together at the window start.
    expect(view.points[0]).toEqual({
      date: "2025-01-01",
      values: { [`sec:${SEC_A}`]: 0 },
    });
    expect(view.totals[`sec:${SEC_A}`]).toBe(25);
    expect(view.excluded).toEqual([]);
    expect(view.status).toBe("complete");
  });

  it("reports the basis the loader chose, so a raw series is not read as adjusted", async () => {
    const view = await runYear(
      new Map([[SEC_A, dense("2024-12-30", "2025-12-30", 100, 110, 7, "RAW")]]),
    );
    expect(view.series[0].basis).toBe("RAW");
  });

  // --- the exclusion truth table ------------------------------------------

  it("excludes a security with no stored history at all", async () => {
    const view = await runYear(new Map());
    expect(view.series).toEqual([]);
    expect(view.excluded).toEqual([
      expect.objectContaining({
        key: `sec:${SEC_A}`,
        reason: "NO_PRICE_HISTORY",
      }),
    ]);
    expect(view.points).toEqual([]);
    expect(view.status).toBe("incomplete");
  });

  /**
   * The regression test for the behaviour this replaces. The chart used to
   * rebase each series on its own first price, so an instrument listed in March
   * started at 0% on a January window and its line reported the year's return
   * measured from March under a label that said January.
   */
  it("excludes a series whose history starts after the window, rather than rebasing it later", async () => {
    const view = await runYear(
      new Map([
        [
          SEC_A,
          series([
            ["2025-03-03", 50],
            ["2025-12-30", 75],
          ]),
        ],
      ]),
    );
    expect(view.series).toEqual([]);
    expect(view.excluded[0].reason).toBe("NO_PRICE_AT_WINDOW_START");
    // Emphatically not a +50% line drawn from March.
    expect(view.totals[`sec:${SEC_A}`]).toBeUndefined();
  });

  /**
   * An instrument whose feed has a hole straddling the window start: one close
   * before it, then nothing until March. The bound is what decides whether that
   * lone close may speak for 1 January.
   */
  it("excludes a base close struck just outside the boundary window", async () => {
    // Daily sampling tolerates 10 days; 2024-12-21 is 11 days before 2025-01-01.
    const view = await runYear(
      new Map([
        [
          SEC_A,
          withHead(
            ["2024-12-21", 100],
            dense("2025-03-01", "2025-12-30", 110, 125),
          ),
        ],
      ]),
    );
    expect(view.excluded[0].reason).toBe("NO_PRICE_AT_WINDOW_START");
  });

  it("accepts a base close struck exactly at the boundary limit", async () => {
    // 2024-12-22 is exactly 10 days before the window start.
    const view = await runYear(
      new Map([
        [
          SEC_A,
          withHead(
            ["2024-12-22", 100],
            dense("2025-03-01", "2025-12-30", 110, 125),
          ),
        ],
      ]),
    );
    expect(view.series).toHaveLength(1);
    expect(view.totals[`sec:${SEC_A}`]).toBe(25);
    // The hole between the base and March is still a hole: accepting the base
    // says the window has a start, not that its interior was observed.
    expect(view.status).toBe("incomplete");
  });

  it("excludes a non-positive base instead of returning Infinity", async () => {
    const view = await runYear(
      new Map([[SEC_A, dense("2024-12-30", "2025-12-30", 0, 125)]]),
    );
    expect(view.excluded[0].reason).toBe("NON_POSITIVE_BASE");
    expect(Object.values(view.totals)).not.toContain(Infinity);
  });

  /**
   * Time-series contract section 2.3: bounding each end independently lets both
   * resolve to one observation, and the arithmetic then returns exactly zero --
   * a hard 0% that counts itself as a fully covered period.
   */
  it("excludes a window holding only one observation, rather than reporting 0%", async () => {
    securityRepo.find.mockResolvedValue([security(SEC_A, "AAA")]);
    (loadPriceSeries as jest.Mock).mockResolvedValue(
      new Map([[SEC_A, series([["2025-01-02", 100]])]]),
    );
    const view = await service.getComparison(USER, {
      securityIds: [SEC_A],
      indexCodes: [],
      startDate: "2025-01-05",
      endDate: "2025-01-08",
    });
    expect(view.excluded[0].reason).toBe("SINGLE_OBSERVATION");
    expect(view.totals[`sec:${SEC_A}`]).toBeUndefined();
  });

  // --- gaps and stopped feeds ---------------------------------------------

  /**
   * Time-series contract section 2.4: two boundaries say nothing about the
   * interior. Where every series shares a hole there is no observation inside it
   * to plot, so without measuring the stride the line is drawn straight across
   * months nobody watched -- indistinguishable from measured data.
   */
  it("breaks the line across an unobserved stretch, lists it, and marks the view incomplete", async () => {
    const key = `sec:${SEC_A}`;
    const view = await runYear(
      new Map([
        [
          SEC_A,
          {
            basis: "ADJUSTED" as const,
            points: [
              ...dense("2024-12-30", "2025-02-03", 100, 105).points,
              // Eight months with nothing, then the feed resumes.
              ...dense("2025-11-03", "2025-12-30", 130, 125).points,
            ],
          },
        ],
      ]),
    );

    const nulls = view.points.filter((point) => point.values[key] === null);
    expect(nulls.length).toBeGreaterThan(0);
    // The break is planted just past the carry-forward bound, not at the far
    // end of the hole: the line has to stop where the evidence does.
    expect(nulls[0].date).toBe("2025-02-14");
    expect(view.gaps).toContainEqual(
      expect.objectContaining({ key, from: "2025-02-14" }),
    );
    expect(view.points.find((p) => p.date === "2025-11-03")?.values[key]).toBe(
      30,
    );
    expect(view.status).toBe("incomplete");
  });

  it("reports no total for a series whose feed stopped inside the window", async () => {
    const view = await runYear(
      new Map([
        [SEC_A, dense("2024-12-30", "2025-03-31", 100, 108)],
        [SEC_B, dense("2024-12-30", "2025-12-30", 50, 60)],
      ]),
      [security(SEC_A, "AAA"), security(SEC_B, "BBB")],
    );
    // Up 8% to March and unknown since -- not up 8% over the year.
    expect(view.totals[`sec:${SEC_A}`]).toBeNull();
    expect(view.totals[`sec:${SEC_B}`]).toBe(20);
    expect(view.status).toBe("incomplete");
  });

  it("carries a series over a date another instrument observed alone", async () => {
    const view = await runYear(
      new Map([
        [SEC_A, dense("2024-12-30", "2025-06-30", 100, 110)],
        // Observes on a day AAA's market was shut. AAA must carry, not hole.
        [SEC_B, dense("2024-12-30", "2025-07-01", 50, 55)],
      ]),
      [security(SEC_A, "AAA"), security(SEC_B, "BBB")],
    );
    const july = view.points.find((p) => p.date === "2025-07-01");
    expect(july?.values[`sec:${SEC_A}`]).toBe(10);
    expect(july?.values[`sec:${SEC_B}`]).toBe(10);
  });

  // --- indexes -------------------------------------------------------------

  it("plots an index beside a security, benchmarks last", async () => {
    securityRepo.find.mockResolvedValue([security(SEC_A, "AAA")]);
    (loadPriceSeries as jest.Mock).mockResolvedValue(
      new Map([[SEC_A, dense("2024-12-30", "2025-12-30", 100, 125)]]),
    );
    marketIndexService.loadSeries.mockResolvedValue(
      new Map([["SP500", dense("2024-12-30", "2025-12-30", 5000, 5500)]]),
    );

    const view = await service.getComparison(USER, {
      securityIds: [SEC_A],
      indexCodes: ["SP500"],
      startDate: "2025-01-01",
      endDate: "2025-12-31",
    });

    expect(view.series.map((s) => s.key)).toEqual([
      `sec:${SEC_A}`,
      "idx:SP500",
    ]);
    expect(view.series[1]).toMatchObject({
      kind: "INDEX",
      id: "SP500",
      name: "S&P 500",
      currencyCode: "USD",
    });
    expect(view.totals["idx:SP500"]).toBe(10);
    expect(marketIndexService.ensureHistory).toHaveBeenCalledWith(
      ["SP500"],
      "2025-01-01",
    );
  });

  it("excludes an index whose backfill produced nothing, without failing the request", async () => {
    securityRepo.find.mockResolvedValue([security(SEC_A, "AAA")]);
    (loadPriceSeries as jest.Mock).mockResolvedValue(
      new Map([[SEC_A, dense("2024-12-30", "2025-12-30", 100, 125)]]),
    );
    marketIndexService.loadSeries.mockResolvedValue(new Map());

    const view = await service.getComparison(USER, {
      securityIds: [SEC_A],
      indexCodes: ["SP500"],
      startDate: "2025-01-01",
      endDate: "2025-12-31",
    });

    // The security is still drawn: a provider outage on the benchmark must not
    // take the holding's line down with it.
    expect(view.series.map((s) => s.key)).toEqual([`sec:${SEC_A}`]);
    expect(view.excluded).toEqual([
      expect.objectContaining({ key: "idx:SP500", reason: "NO_PRICE_HISTORY" }),
    ]);
    expect(view.status).toBe("incomplete");
  });

  it("ignores an index code that is not in the catalog", async () => {
    await runYear(
      new Map([[SEC_A, dense("2024-12-30", "2025-12-30", 100, 110)]]),
      [security(SEC_A, "AAA")],
      ["NOT_AN_INDEX"],
    );
    expect(marketIndexService.ensureHistory).toHaveBeenCalledWith(
      [],
      "2025-01-01",
    );
  });

  // --- window resolution ---------------------------------------------------

  /**
   * The reported defect, as a test.
   *
   * The S&P 500's stored history reaches back to 1927. Taking the earliest
   * observation across the *whole* selection opened "all time" there, the
   * security had no close within the boundary window of 1927, and it was
   * excluded -- so the chart drew the benchmark alone. The window is measured
   * off the securities; the benchmark follows.
   */
  it("opens an all-time window on the securities, not on a benchmark's deeper history", async () => {
    securityRepo.find.mockResolvedValue([security(SEC_A, "VTI")]);
    manager.query.mockResolvedValue([
      activityRow(SEC_A, "2010-01-04", "2010-01-04"),
    ]);
    (loadPriceSeries as jest.Mock).mockResolvedValue(
      new Map([[SEC_A, dense("2010-01-04", "2025-12-30", 50, 250, 30)]]),
    );
    marketIndexService.loadSeries.mockResolvedValue(
      new Map([["SP500", dense("1927-12-30", "2025-12-30", 17, 5900, 30)]]),
    );

    const view = await service.getComparison(USER, {
      securityIds: [SEC_A],
      indexCodes: ["SP500"],
      endDate: "2025-12-31",
    });

    expect(view.window.start).toBe("2010-01-04");
    // Both lines, and the security is emphatically not excluded.
    expect(view.series.map((s) => s.key)).toEqual([
      `sec:${SEC_A}`,
      "idx:SP500",
    ]);
    expect(view.excluded).toEqual([]);
    // The benchmark is rebased at the same boundary, so it reports its return
    // since the holding began rather than since 1927.
    expect(view.totals["idx:SP500"]).not.toBeNull();
  });

  /**
   * The second half of the same defect. The resolver used a plain
   * MIN(price_date), which counts rows the loader will never return: a raw
   * transaction-derived close from 2010 sitting beside adjusted provider rows
   * from 2025 opened the window on 2010, the basis rule kept only the adjusted
   * rows, and VTI was excluded from its own chart with a price row for that
   * very day sitting in the table. The first price must be computed on the same
   * basis the loader will choose.
   */
  it("opens the window where the usable series begins, not where any row does", async () => {
    securityRepo.find.mockResolvedValue([security(SEC_A, "VTI")]);
    // The activity query answers basis-aware: the raw 2010 rows do not count
    // because adjusted rows exist, so the first usable price is 2025-02-03.
    manager.query.mockResolvedValue([
      activityRow(SEC_A, "2025-02-03", "2010-01-15"),
    ]);
    (loadPriceSeries as jest.Mock).mockResolvedValue(
      new Map([[SEC_A, dense("2025-02-03", "2025-12-30", 280, 300)]]),
    );

    const view = await service.getComparison(USER, {
      securityIds: [SEC_A],
      indexCodes: [],
      endDate: "2025-12-31",
    });

    // Later of first usable price and first transaction: the price, here.
    expect(view.window.start).toBe("2025-02-03");
    expect(view.series).toHaveLength(1);
    expect(view.excluded).toEqual([]);
  });

  it("asks the activity question basis-aware, and without consulting the indexes", async () => {
    securityRepo.find.mockResolvedValue([security(SEC_A, "VTI")]);
    manager.query.mockResolvedValue([
      activityRow(SEC_A, "2010-01-04", "2010-01-15"),
    ]);
    (loadPriceSeries as jest.Mock).mockResolvedValue(
      new Map([[SEC_A, dense("2010-01-04", "2025-12-30", 50, 250, 30)]]),
    );

    const view = await service.getComparison(USER, {
      securityIds: [SEC_A],
      indexCodes: ["SP500"],
      endDate: "2025-12-31",
    });

    const [sql, params] = manager.query.mock.calls[0];
    const statement = String(sql).replace(/\s+/g, " ");
    // A unit spec cannot execute the SQL, so the rule is asserted as expressed;
    // the semantics run against a real PostgreSQL in the integration suite. The
    // first price is the first row *the loader will return*: adjusted rows only
    // where any exist, raw throughout where none do -- never a plain MIN over
    // both, which counts rows the basis rule then discards.
    expect(statement).toContain("bool_or(adjusted_close IS NOT NULL)");
    expect(statement).toContain(
      "MIN(price_date) FILTER (WHERE adjusted_close IS NOT NULL)",
    );
    expect(statement).toContain("MIN(transaction_date) AS first_transaction");
    // LEFT JOINs off the id list, so a watch-list security still gets a row.
    expect(statement).toContain("LEFT JOIN");
    expect(String(sql)).not.toContain("market_index_prices");
    expect(params).toEqual([[SEC_A]]);
    // Later of the two bounds: the transaction, here.
    expect(view.window.start).toBe("2010-01-15");
    // The benchmark is fetched to fit the window the securities set.
    expect(marketIndexService.ensureHistory).toHaveBeenCalledWith(
      ["SP500"],
      "2010-01-15",
    );
  });

  /**
   * Time-series contract section 2.5: "all time" is a request with no start
   * date, and where the series enumerates its own sample points a hardcoded
   * epoch materializes an empty point for every period before the first datum.
   */
  it("resolves an open-ended window from the data, not an epoch", async () => {
    securityRepo.find.mockResolvedValue([security(SEC_A, "AAA")]);
    manager.query.mockResolvedValue([activityRow(SEC_A, "2019-05-02", null)]);
    (loadPriceSeries as jest.Mock).mockResolvedValue(
      new Map([[SEC_A, dense("2019-05-02", "2025-12-30", 10, 40, 30)]]),
    );

    const view = await service.getComparison(USER, {
      securityIds: [SEC_A],
      indexCodes: [],
      endDate: "2025-12-31",
    });

    expect(view.window.start).toBe("2019-05-02");
    expect(view.points[0].date).toBe("2019-05-02");
    // Over six years, so the series is thinned rather than shipped daily.
    expect(view.sampling).toBe("month");
  });

  it("opens a multi-security window at the latest start, so every line is drawable", async () => {
    securityRepo.find.mockResolvedValue([
      security(SEC_A, "AAA"),
      security(SEC_B, "BBB"),
    ]);
    manager.query.mockResolvedValue([
      activityRow(SEC_A, "2010-01-04", "2010-01-15"),
      activityRow(SEC_B, "2018-05-02", "2018-06-01"),
    ]);
    (loadPriceSeries as jest.Mock).mockResolvedValue(
      new Map([
        [SEC_A, dense("2010-01-04", "2025-12-30", 50, 250, 30)],
        [SEC_B, dense("2018-05-02", "2025-12-30", 20, 60, 30)],
      ]),
    );

    const view = await service.getComparison(USER, {
      securityIds: [SEC_A, SEC_B],
      indexCodes: [],
      endDate: "2025-12-31",
    });

    // Opening earlier would draw AAA and exclude BBB.
    expect(view.window.start).toBe("2018-06-01");
    expect(view.excluded).toEqual([]);
  });

  /**
   * With nothing to measure off, the benchmark is the subject rather than the
   * yardstick -- and its full history has to be in hand before its own earliest
   * observation can be read, which is what a null start asks for.
   */
  it("fetches an index's full history before resolving a window with no securities", async () => {
    securityRepo.find.mockResolvedValue([]);
    const order: string[] = [];
    marketIndexService.ensureHistory.mockImplementation(async () => {
      order.push("ensureHistory");
    });
    manager.query.mockImplementation(async () => {
      order.push("resolveStart");
      return [{ start: "1927-12-30" }];
    });
    marketIndexService.loadSeries.mockResolvedValue(
      new Map([["SP500", dense("1927-12-30", "2025-12-30", 17, 5900, 30)]]),
    );

    const view = await service.getComparison(USER, {
      securityIds: [],
      indexCodes: ["SP500"],
      endDate: "2025-12-31",
    });

    expect(order).toEqual(["ensureHistory", "resolveStart"]);
    expect(marketIndexService.ensureHistory).toHaveBeenCalledWith(
      ["SP500"],
      null,
    );
    expect(view.window.start).toBe("1927-12-30");
  });

  it("keeps an explicit window exactly as asked, benchmark history notwithstanding", async () => {
    securityRepo.find.mockResolvedValue([security(SEC_A, "VTI")]);
    manager.query.mockResolvedValue([
      activityRow(SEC_A, "2010-01-04", "2010-01-15"),
    ]);
    (loadPriceSeries as jest.Mock).mockResolvedValue(
      new Map([[SEC_A, dense("2024-12-30", "2025-12-30", 100, 125)]]),
    );
    marketIndexService.loadSeries.mockResolvedValue(
      new Map([["SP500", dense("1927-12-30", "2025-12-30", 17, 5900)]]),
    );

    const view = await service.getComparison(USER, {
      securityIds: [SEC_A],
      indexCodes: ["SP500"],
      startDate: "2025-01-01",
      endDate: "2025-12-31",
    });

    // A named range means what it says; nothing resolves it from the data.
    expect(view.window.start).toBe("2025-01-01");
    expect(view.series).toHaveLength(2);
  });

  // --- the on-demand deep backfill -----------------------------------------

  /**
   * The other half of the reported defect: nothing ever fetched a security's
   * deep history. Creation backfills one year, so an all-time request on a
   * holding bought in 2010 had nothing usable to open on -- the indexes have
   * had `ensureHistory` from the start, and the securities now get the same.
   */
  it("backfills a security whose usable history starts after its first transaction", async () => {
    const stale = {
      ...security(SEC_A, "VTI"),
      historicalBackfillAttemptedAt: null,
    };
    securityRepo.find.mockResolvedValue([stale]);
    // Usable history starts 2025; the user first bought in 2010.
    manager.query.mockResolvedValue([
      activityRow(SEC_A, "2025-02-03", "2010-01-15"),
    ]);
    (loadPriceSeries as jest.Mock).mockResolvedValue(
      new Map([[SEC_A, dense("2010-01-04", "2025-12-30", 50, 250, 30)]]),
    );

    await service.getComparison(USER, {
      securityIds: [SEC_A],
      indexCodes: [],
      endDate: "2025-12-31",
    });

    // Sixteen years back needs the provider's full history.
    expect(securityPriceService.backfillSecurityRange).toHaveBeenCalledWith(
      expect.objectContaining({ id: SEC_A }),
      "max",
    );
    // Stamped whether or not the data improved: the cooldown spares the
    // provider, it does not record success.
    expect(securityRepo.update).toHaveBeenCalledWith(
      { id: expect.anything() },
      expect.objectContaining({
        historicalBackfillAttemptedAt: expect.any(Date),
      }),
    );
  });

  it("does not backfill within the cooldown", async () => {
    // The default fixture carries a fresh attempt stamp.
    securityRepo.find.mockResolvedValue([security(SEC_A, "VTI")]);
    manager.query.mockResolvedValue([
      activityRow(SEC_A, "2025-02-03", "2010-01-15"),
    ]);
    (loadPriceSeries as jest.Mock).mockResolvedValue(new Map());

    await service.getComparison(USER, {
      securityIds: [SEC_A],
      indexCodes: [],
      endDate: "2025-12-31",
    });

    expect(securityPriceService.backfillSecurityRange).not.toHaveBeenCalled();
  });

  it("does not backfill a security whose history already covers the window", async () => {
    const stale = {
      ...security(SEC_A, "VTI"),
      historicalBackfillAttemptedAt: null,
    };
    securityRepo.find.mockResolvedValue([stale]);
    manager.query.mockResolvedValue([
      activityRow(SEC_A, "2010-01-04", "2010-01-15"),
    ]);
    (loadPriceSeries as jest.Mock).mockResolvedValue(
      new Map([[SEC_A, dense("2010-01-04", "2025-12-30", 50, 250, 30)]]),
    );

    await service.getComparison(USER, {
      securityIds: [SEC_A],
      indexCodes: [],
      endDate: "2025-12-31",
    });

    expect(securityPriceService.backfillSecurityRange).not.toHaveBeenCalled();
  });

  it("does not backfill a watch-list security on an open-ended window", async () => {
    // No transactions: there is nothing older to want, and its own stored
    // history is where its line begins.
    const stale = {
      ...security(SEC_A, "WATCH"),
      historicalBackfillAttemptedAt: null,
    };
    securityRepo.find.mockResolvedValue([stale]);
    manager.query.mockResolvedValue([activityRow(SEC_A, "2019-05-02", null)]);
    (loadPriceSeries as jest.Mock).mockResolvedValue(
      new Map([[SEC_A, dense("2019-05-02", "2025-12-30", 10, 40, 30)]]),
    );

    await service.getComparison(USER, {
      securityIds: [SEC_A],
      indexCodes: [],
      endDate: "2025-12-31",
    });

    expect(securityPriceService.backfillSecurityRange).not.toHaveBeenCalled();
  });

  it("backfills toward a named window's own start", async () => {
    // The range is measured from the wanted start to today, so the clock is
    // pinned: unpinned, 2022-01-01 crossed the five-year tier's 58-month
    // ceiling in November 2026 and the request became "10y".
    jest.useFakeTimers().setSystemTime(new Date("2026-01-15T12:00:00.000Z"));
    const stale = {
      ...security(SEC_A, "VTI"),
      historicalBackfillAttemptedAt: null,
    };
    securityRepo.find.mockResolvedValue([stale]);
    manager.query.mockResolvedValue([
      activityRow(SEC_A, "2025-02-03", "2010-01-15"),
    ]);
    (loadPriceSeries as jest.Mock).mockResolvedValue(
      new Map([[SEC_A, dense("2024-12-30", "2025-12-30", 100, 125)]]),
    );

    await service.getComparison(USER, {
      securityIds: [SEC_A],
      indexCodes: [],
      startDate: "2022-01-01",
      endDate: "2025-12-31",
    });

    // Four years back fits inside the five-year range.
    expect(securityPriceService.backfillSecurityRange).toHaveBeenCalledWith(
      expect.objectContaining({ id: SEC_A }),
      "5y",
    );
  });

  it("survives a backfill failure and reports the exclusion instead", async () => {
    const stale = {
      ...security(SEC_A, "VTI"),
      historicalBackfillAttemptedAt: null,
    };
    securityRepo.find.mockResolvedValue([stale]);
    manager.query.mockResolvedValue([
      activityRow(SEC_A, "2025-02-03", "2010-01-15"),
    ]);
    securityPriceService.backfillSecurityRange.mockRejectedValue(
      new Error("provider gone"),
    );
    (loadPriceSeries as jest.Mock).mockResolvedValue(new Map());

    const view = await service.getComparison(USER, {
      securityIds: [SEC_A],
      indexCodes: [],
      endDate: "2025-12-31",
    });

    expect(view.excluded).toEqual([
      expect.objectContaining({ key: `sec:${SEC_A}` }),
    ]);
    // The attempt is still stamped, or the next render retries immediately.
    expect(securityRepo.update).toHaveBeenCalled();
  });

  it("thins a long window and widens the boundary tolerance with it", async () => {
    securityRepo.find.mockResolvedValue([security(SEC_A, "AAA")]);
    (loadPriceSeries as jest.Mock).mockResolvedValue(
      new Map([
        [
          SEC_A,
          // A monthly series: the base is 20 days before the window start,
          // which the daily bound would refuse and the monthly bound accepts.
          series([
            ["2022-12-12", 100],
            ["2025-12-31", 150],
          ]),
        ],
      ]),
    );
    const view = await service.getComparison(USER, {
      securityIds: [SEC_A],
      indexCodes: [],
      startDate: "2023-01-01",
      endDate: "2025-12-31",
    });
    expect(view.sampling).toBe("week");
    expect(view.series).toHaveLength(1);
  });

  it("handles a leap-day window boundary without an off-by-one", async () => {
    securityRepo.find.mockResolvedValue([security(SEC_A, "AAA")]);
    (loadPriceSeries as jest.Mock).mockResolvedValue(
      new Map([[SEC_A, dense("2024-02-29", "2024-12-31", 100, 120)]]),
    );
    const view = await service.getComparison(USER, {
      securityIds: [SEC_A],
      indexCodes: [],
      startDate: "2024-02-29",
      endDate: "2024-12-31",
    });
    expect(view.window.start).toBe("2024-02-29");
    expect(view.totals[`sec:${SEC_A}`]).toBe(20);
  });

  it("returns an empty view rather than throwing when nothing was selected", async () => {
    const view = await service.getComparison(USER, {
      securityIds: [],
      indexCodes: [],
      startDate: "2025-01-01",
      endDate: "2025-12-31",
    });
    expect(view.series).toEqual([]);
    expect(view.points).toEqual([]);
    expect(view.status).toBe("incomplete");
  });

  it("does not ask the same security twice", async () => {
    await runYear(
      new Map([[SEC_A, dense("2024-12-30", "2025-12-30", 100, 110)]]),
      [security(SEC_A, "AAA")],
    );
    const call = (loadPriceSeries as jest.Mock).mock.calls[0][1];
    expect(call.ids).toEqual([SEC_A]);
  });

  it("loads behind the window start so the boundary close is reachable", async () => {
    await runYear(
      new Map([[SEC_A, dense("2024-12-30", "2025-12-30", 100, 110)]]),
    );
    const call = (loadPriceSeries as jest.Mock).mock.calls[0][1];
    // A read starting exactly at the boundary cannot contain the close that
    // prices it, because the lookup can only search backwards.
    expect(call.fromDate < "2025-01-01").toBe(true);
    expect(call.toDate).toBe("2025-12-31");
  });
});
