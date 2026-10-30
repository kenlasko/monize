import { GemStrategy } from "./entities/gem-strategy.entity";
import { GemStrategySignal } from "./entities/gem-strategy-signal.entity";
import { GemBacktestService } from "./gem-backtest.service";

const strategy = (overrides: Partial<GemStrategy> = {}): GemStrategy =>
  ({
    id: "strategy-1",
    userId: "user-1",
    // Quarterly, so the signals below sit on consecutive periods: a monthly
    // calendar with signals six months apart is five missing periods, and the
    // simulation is required to treat those as holes rather than hold the
    // previous instrument through them.
    cadence: "QUARTERLY",
    lookbackMonths: 12,
    taxRatePercent: 19,
    commissionAmount: 29.9,
    ...overrides,
  }) as GemStrategy;

const signal = (
  effectiveFrom: string,
  targetSecurityId: string | null,
  previousRole: string | null = null,
): GemStrategySignal =>
  ({
    effectiveFrom,
    targetRole: "US_EQUITY",
    targetSecurityId,
    previousRole,
  }) as GemStrategySignal;

describe("GemBacktestService", () => {
  let priceService: { loadSeries: jest.Mock };
  let service: GemBacktestService;

  beforeEach(() => {
    priceService = {
      loadSeries: jest.fn().mockResolvedValue(
        new Map([
          [
            "sec-spy",
            [
              // A close at, or within days of, every period boundary. A series
              // with a six-month hole is not a priced run: the same stale
              // quote would answer both ends of a period.
              { date: "2023-12-29", close: 100 },
              { date: "2024-03-28", close: 102 },
              { date: "2024-06-28", close: 105 },
              { date: "2024-09-27", close: 108 },
              { date: "2024-12-31", close: 110 },
            ],
          ],
        ]),
      ),
    };
    service = new GemBacktestService(priceService as never);
  });

  it("simulates the stored evaluations and loads a lead window of prices", async () => {
    const result = await service.build({
      strategy: strategy(),
      signals: [
        // Deliberately out of order: the service sorts them.
        signal("2024-07-01", "sec-spy", "US_EQUITY"),
        signal("2024-01-01", "sec-spy"),
        signal("2024-10-01", "sec-spy", "US_EQUITY"),
        signal("2024-04-01", "sec-spy", "US_EQUITY"),
      ],
      safeSecurityId: null,
      notional: 10_000,
      accountCount: 1,
      hasEarlierSignals: false,
      asOf: "2025-01-01",
    });

    // Signals arrive newest-first from the report; the simulation sorts them,
    // so the series is loaded from the oldest period, not the newest -- and
    // from a fortnight before it, because a period opening on a weekend or a
    // holiday is priced by the close before it, which `price_date >= from`
    // would otherwise leave out.
    expect(priceService.loadSeries).toHaveBeenCalledWith(
      ["sec-spy"],
      "2023-12-18",
      "day",
      undefined,
      // Closes are converted into this user's reporting currency.
      "user-1",
    );
    // Every boundary falls on a day the market was shut -- 1 January, 1 July --
    // and is priced by the close before it, which is what the lead window
    // fetched. Without it the first period read as unpriced.
    expect(result).toMatchObject({
      from: "2024-01-01",
      to: "2025-01-01",
      taxApplied: true,
      commissionApplied: true,
      coveragePercent: 100,
    });
  });

  it("includes the safe asset's prices for the hit-rate comparison", async () => {
    await service.build({
      strategy: strategy(),
      signals: [
        signal("2024-01-01", "sec-spy"),
        signal("2024-04-01", "sec-spy", "US_EQUITY"),
      ],
      safeSecurityId: "sec-ief",
      notional: null,
      accountCount: 1,
      hasEarlierSignals: false,
      asOf: "2025-01-01",
    });

    expect(priceService.loadSeries.mock.calls[0][0].sort()).toEqual([
      "sec-ief",
      "sec-spy",
    ]);
  });

  it("simulates a strategy that has produced only one evaluation", async () => {
    // The period runs to `asOf`, not to the next signal, so one evaluation and
    // a month of prices is a complete month. Withholding the whole backtest
    // until a second evaluation exists kept it from precisely the users most
    // likely to open it -- and contradicted the promise that a strategy
    // configured last month reports a month.
    const result = await service.build({
      strategy: strategy(),
      // One quarter old: a strategy configured last quarter, not one that has
      // been silent for a year -- those would be three unanswered periods.
      signals: [signal("2024-10-01", "sec-spy")],
      safeSecurityId: null,
      notional: 10_000,
      accountCount: 1,
      hasEarlierSignals: false,
      asOf: "2025-01-01",
    });

    expect(result).toMatchObject({
      from: "2024-10-01",
      to: "2025-01-01",
      coveragePercent: 100,
      // A first allocation with nothing before it: the opening buy is real.
      taxApplied: true,
      commissionApplied: true,
    });
  });

  it("reports gross when the oldest retained signal already held something", async () => {
    // The history is bounded to the last 24 periods, so for any older strategy
    // the oldest signal here is not its first allocation. Its `previousRole`
    // says so, and without that the simulation charges a purchase commission
    // for a trade that never happened and dates the tax basis to the edge of
    // the visible window -- taxing a later switch on the gain since an
    // arbitrary reset.
    const result = await service.build({
      strategy: strategy(),
      signals: [
        signal("2024-01-01", "sec-spy", "SAFE"),
        signal("2024-04-01", "sec-spy", "US_EQUITY"),
        signal("2024-07-01", "sec-spy", "US_EQUITY"),
        signal("2024-10-01", "sec-spy", "US_EQUITY"),
      ],
      safeSecurityId: null,
      notional: 10_000,
      accountCount: 1,
      hasEarlierSignals: false,
      asOf: "2025-01-01",
    });

    expect(result).toMatchObject({
      from: "2024-01-01",
      coveragePercent: 100,
      taxApplied: false,
      commissionApplied: false,
    });
  });

  it("does not hold a legacy period's instrument through its month", async () => {
    // June is answered only by a row this configuration cannot use, so it is
    // not in the signals handed here. Bounding May by "the next signal
    // supplied" would run SPY through June as well -- a month the strategy
    // decided differently -- and still report full coverage. The hole goes
    // back on the calendar instead, and the run restarts after it.
    priceService.loadSeries.mockResolvedValue(
      new Map([
        [
          "sec-spy",
          [
            { date: "2026-04-30", close: 100 },
            { date: "2026-06-30", close: 130 },
            { date: "2026-07-31", close: 140 },
            { date: "2026-08-31", close: 150 },
          ],
        ],
      ]),
    );

    const result = await service.build({
      strategy: strategy({ cadence: "MONTHLY" }),
      signals: [
        signal("2026-05-01", "sec-spy"),
        // June is missing: only a legacy row answers for it.
        signal("2026-07-01", "sec-spy", "US_EQUITY"),
      ],
      safeSecurityId: null,
      notional: 10_000,
      accountCount: 1,
      hasEarlierSignals: false,
      // Inside the July period, so the tail is not a hole of its own.
      asOf: "2026-07-31",
    });

    // Three periods on the calendar, one of them unpriceable, so the run is
    // the stretch after it and the coverage figure says so.
    expect(result?.from).toBe("2026-07-01");
    expect(result?.coveragePercent).toBeCloseTo(33.33, 1);
    // And a truncated run is reported gross, so the panel cannot claim the
    // figures are net of costs that were never charged.
    expect(result?.taxApplied).toBe(false);
    expect(result?.commissionApplied).toBe(false);
  });

  it("has nothing to simulate when no period named an instrument", async () => {
    const result = await service.build({
      strategy: strategy(),
      signals: [signal("2024-01-01", null), signal("2024-04-01", null)],
      safeSecurityId: null,
      notional: null,
      accountCount: 1,
      hasEarlierSignals: false,
      asOf: "2025-01-01",
    });

    expect(result).toBeNull();
    expect(priceService.loadSeries).not.toHaveBeenCalled();
  });
});
