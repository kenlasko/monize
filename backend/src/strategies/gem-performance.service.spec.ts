import { GemAssetRole } from "./entities/gem-strategy-asset.entity";
import { GemPerformanceService } from "./gem-performance.service";

describe("GemPerformanceService", () => {
  let service: GemPerformanceService;
  let priceService: { loadSeries: jest.Mock };

  const securityByRole = new Map<GemAssetRole, string>([
    ["US_EQUITY", "sec-spy"],
    ["EM_EQUITY", "sec-emim"],
  ]);

  beforeEach(() => {
    priceService = { loadSeries: jest.fn() };
    service = new GemPerformanceService(priceService as never);
  });

  const build = (overrides: Record<string, unknown> = {}) =>
    service.build({
      userId: "user-1",
      range: "1Y",
      securityByRole,
      asOf: "2025-08-14",
      ...overrides,
    } as never);

  it("rebases every asset to zero at the start of the window", async () => {
    priceService.loadSeries.mockResolvedValue(
      new Map([
        [
          "sec-spy",
          [
            { date: "2024-08-14", close: 100 },
            { date: "2025-08-14", close: 115 },
          ],
        ],
        [
          "sec-emim",
          [
            { date: "2024-08-14", close: 50 },
            { date: "2025-08-14", close: 65 },
          ],
        ],
      ]),
    );

    const performance = await build();

    expect(performance?.points[0].values).toEqual({
      US_EQUITY: 0,
      EM_EQUITY: 0,
    });
    expect(performance?.totals).toEqual({ US_EQUITY: 15, EM_EQUITY: 30 });
    expect(performance?.incomplete).toBe(false);
    expect(performance?.range).toBe("1Y");
  });

  it("carries an asset forward over a date the other traded on", async () => {
    priceService.loadSeries.mockResolvedValue(
      new Map([
        [
          "sec-spy",
          [
            { date: "2025-01-02", close: 100 },
            { date: "2025-01-03", close: 110 },
          ],
        ],
        ["sec-emim", [{ date: "2025-01-02", close: 50 }]],
      ]),
    );

    const performance = await build();

    expect(performance?.points.map((point) => point.date)).toEqual([
      "2025-01-02",
      "2025-01-03",
    ]);
    // The holiday date reuses the last known close rather than leaving a hole.
    expect(performance?.points[1].values.EM_EQUITY).toBe(0);
  });

  it("flags a window an asset does not cover", async () => {
    priceService.loadSeries.mockResolvedValue(
      new Map([
        [
          "sec-spy",
          [
            { date: "2024-08-14", close: 100 },
            { date: "2025-08-14", close: 115 },
          ],
        ],
      ]),
    );

    const performance = await build();
    expect(performance?.incomplete).toBe(true);
    expect(performance?.totals.EM_EQUITY).toBeUndefined();
  });

  it("flags an asset that only starts mid-window", async () => {
    // A newly listed ETF is rebased to its own later start, so its line cannot
    // be read against a full-window series without the caveat.
    priceService.loadSeries.mockResolvedValue(
      new Map([
        [
          "sec-spy",
          [
            { date: "2024-08-14", close: 100 },
            { date: "2025-08-14", close: 115 },
          ],
        ],
        [
          "sec-emim",
          [
            { date: "2025-02-03", close: 50 },
            { date: "2025-08-14", close: 65 },
          ],
        ],
      ]),
    );

    const performance = await build();

    expect(performance?.incomplete).toBe(true);
    // The line is still drawn -- flagged, not dropped.
    expect(performance?.totals.EM_EQUITY).toBe(30);
  });

  it("tolerates a start a few days into the window", async () => {
    // The window opens on a day the market was shut; that is not a gap.
    priceService.loadSeries.mockResolvedValue(
      new Map([
        [
          "sec-spy",
          [
            { date: "2024-08-16", close: 100 },
            { date: "2025-08-14", close: 115 },
          ],
        ],
        [
          "sec-emim",
          [
            { date: "2024-08-19", close: 50 },
            { date: "2025-08-14", close: 65 },
          ],
        ],
      ]),
    );

    expect((await build())?.incomplete).toBe(false);
  });

  it("measures MAX coverage against the longest history, not a fixed date", async () => {
    priceService.loadSeries.mockResolvedValue(
      new Map([
        [
          "sec-spy",
          [
            { date: "2005-01-31", close: 100 },
            { date: "2025-08-14", close: 115 },
          ],
        ],
        [
          "sec-emim",
          [
            { date: "2005-02-28", close: 50 },
            { date: "2025-08-14", close: 65 },
          ],
        ],
      ]),
    );

    // Both start in 2005, so neither is short against the other even though the
    // MAX window nominally reaches back to 1900.
    expect((await build({ range: "MAX" }))?.incomplete).toBe(false);
  });

  it("drops a series whose first close is not positive", async () => {
    priceService.loadSeries.mockResolvedValue(
      new Map([
        ["sec-spy", [{ date: "2025-01-02", close: 0 }]],
        ["sec-emim", [{ date: "2025-01-02", close: 50 }]],
      ]),
    );

    const performance = await build();
    expect(performance?.totals.US_EQUITY).toBeUndefined();
    expect(performance?.incomplete).toBe(true);
  });

  it("is null when no asset has prices in the window", async () => {
    priceService.loadSeries.mockResolvedValue(new Map());
    await expect(build()).resolves.toBeNull();
  });

  it("is null with no instrument assigned at all", async () => {
    await expect(build({ securityByRole: new Map() })).resolves.toBeNull();
    expect(priceService.loadSeries).not.toHaveBeenCalled();
  });

  it("asks for the window and sampling the range implies", async () => {
    priceService.loadSeries.mockResolvedValue(new Map());

    await build({ range: "3M" });
    expect(priceService.loadSeries).toHaveBeenLastCalledWith(
      ["sec-spy", "sec-emim"],
      "2025-05-14",
      "day",
      undefined,
      "user-1",
    );

    await build({ range: "5Y" });
    expect(priceService.loadSeries).toHaveBeenLastCalledWith(
      ["sec-spy", "sec-emim"],
      "2020-08-14",
      "month",
      undefined,
      "user-1",
    );

    await build({ range: "MAX" });
    expect(priceService.loadSeries).toHaveBeenLastCalledWith(
      ["sec-spy", "sec-emim"],
      "1900-01-01",
      "month",
      undefined,
      "user-1",
    );
  });

  describe("today's composition, simulated", () => {
    /** Two funds and a cash balance, priced today and over the window. */
    const twoHoldings = (): Array<{
      securityId: string | null;
      symbol: string | null;
      marketValue: number | null;
      isCash: boolean;
    }> => {
      priceService.loadSeries.mockResolvedValue(
        new Map([
          [
            "sec-spy",
            [
              { date: "2024-08-14", close: 100 },
              { date: "2025-08-14", close: 120 },
            ],
          ],
          [
            "sec-emim",
            [
              { date: "2024-08-14", close: 50 },
              { date: "2025-08-14", close: 55 },
            ],
          ],
        ]),
      );
      return [
        {
          securityId: "sec-spy",
          symbol: "SPY",
          marketValue: 7500,
          isCash: false,
        },
        {
          securityId: "sec-emim",
          symbol: "EMIM",
          marketValue: 2500,
          isCash: false,
        },
        {
          securityId: null,
          symbol: null,
          marketValue: 4000,
          isCash: true,
        },
      ];
    };

    it("holds today's weights fixed from the start of the window", async () => {
      // 75% of a fund up 20% and 25% of one up 10%: 0.75*1.2 + 0.25*1.1 =
      // 1.175. Fixed weights, struck once -- rebalancing back to 75/25 along
      // the way would be a different strategy, and one nobody ran.
      const performance = await build({ holdings: twoHoldings() });
      const simulation = performance?.currentPortfolio;

      expect(simulation?.unavailableReason).toBeNull();
      expect(simulation?.points[0]).toEqual({
        date: "2024-08-14",
        returnPercent: 0,
      });
      expect(simulation?.totalReturnPercent).toBeCloseTo(17.5, 4);
      expect(simulation?.completeRange).toBe(true);
      expect(simulation?.startsOn).toBe("2024-08-14");
    });

    it("weights by market value and leaves cash out of both ends", async () => {
      const performance = await build({ holdings: twoHoldings() });

      // 7500 and 2500 of securities: 75/25. The 4000 of cash is neither a
      // weight nor a line -- it has no price history to replay.
      expect(performance?.currentPortfolio?.includedHoldings).toEqual([
        { securityId: "sec-spy", symbol: "SPY", weightPercent: 75 },
        { securityId: "sec-emim", symbol: "EMIM", weightPercent: 25 },
      ]);
    });

    it("starts later, and says so, when a holding is younger than the window", async () => {
      priceService.loadSeries.mockResolvedValue(
        new Map([
          [
            "sec-spy",
            [
              { date: "2024-08-14", close: 100 },
              { date: "2025-02-14", close: 110 },
              { date: "2025-08-14", close: 120 },
            ],
          ],
          [
            // Listed halfway through the window.
            "sec-new",
            [
              { date: "2025-02-14", close: 10 },
              { date: "2025-08-14", close: 12 },
            ],
          ],
        ]),
      );

      const simulation = (
        await build({
          holdings: [
            {
              securityId: "sec-spy",
              symbol: "SPY",
              marketValue: 5000,
              isCash: false,
            },
            {
              securityId: "sec-new",
              symbol: "NEW",
              marketValue: 5000,
              isCash: false,
            },
          ],
        })
      )?.currentPortfolio;

      expect(simulation?.startsOn).toBe("2025-02-14");
      expect(simulation?.completeRange).toBe(false);
      // Nothing is drawn before every leg can be priced: half a portfolio
      // carried backwards would be a line nobody held.
      expect(simulation?.points[0]).toEqual({
        date: "2024-08-14",
        returnPercent: null,
      });
      // 0.5 * (120/110) + 0.5 * (12/10) = 1.1454...
      expect(simulation?.totalReturnPercent).toBeCloseTo(14.55, 1);
    });

    it("reports nothing rather than a partial portfolio", async () => {
      priceService.loadSeries.mockResolvedValue(
        new Map([
          [
            "sec-spy",
            [
              { date: "2024-08-14", close: 100 },
              { date: "2025-08-14", close: 120 },
            ],
          ],
          [
            "sec-emim",
            [
              { date: "2024-08-14", close: 50 },
              { date: "2025-08-14", close: 55 },
            ],
          ],
        ]),
      );

      const simulation = (
        await build({
          holdings: [
            {
              securityId: "sec-spy",
              symbol: "SPY",
              marketValue: 5000,
              isCash: false,
            },
            // Never priced: the remaining fund is a different portfolio, and
            // the line would be read as this one.
            {
              securityId: "sec-unpriced",
              symbol: "XYZ",
              marketValue: 5000,
              isCash: false,
            },
          ],
        })
      )?.currentPortfolio;

      expect(simulation?.unavailableReason).toBe("MISSING_PRICE_HISTORY");
      expect(simulation?.points).toEqual([]);
    });

    it("will not infer equal weights from an unknown value", async () => {
      const holdings = twoHoldings();
      holdings[1].marketValue = null;

      const simulation = (await build({ holdings }))?.currentPortfolio;

      expect(simulation?.unavailableReason).toBe("UNKNOWN_CURRENT_VALUE");
      expect(simulation?.totalReturnPercent).toBeNull();
    });

    it("never bases the line off-chart when a holding is older than the window", async () => {
      // The regression: rebasing to the holding's own first close, which can
      // predate every point the chart draws. The line then opens hundreds of
      // percent above zero, reports a different window's return, and stretches
      // the y-axis until the asset lines beside it are flat.
      priceService.loadSeries.mockResolvedValue(
        new Map([
          [
            "sec-spy",
            [
              { date: "2025-02-03", close: 100 },
              { date: "2025-08-14", close: 110 },
            ],
          ],
          [
            "sec-old",
            [
              { date: "2024-08-14", close: 50 },
              { date: "2025-02-03", close: 60 },
              { date: "2025-08-14", close: 75 },
            ],
          ],
        ]),
      );

      const simulation = (
        await build({
          holdings: [
            {
              securityId: "sec-old",
              symbol: "OLD",
              marketValue: 5000,
              isCash: false,
            },
          ],
        })
      )?.currentPortfolio;

      // The chart starts at 2025-02-03, so the base is 60 and the window
      // return is 75/60 = 25%, not 75/50 = 50%.
      expect(simulation?.startsOn).toBe("2025-02-03");
      expect(simulation?.points[0]).toEqual({
        date: "2025-02-03",
        returnPercent: 0,
      });
      expect(simulation?.totalReturnPercent).toBeCloseTo(25, 4);
      // Complete as far as this chart goes: the window was cut short by the
      // strategy's own instrument, and the simulation starts on the same point
      // every asset line does. Saying otherwise blamed the user's holdings for
      // a gap in someone else's data.
      expect(simulation?.completeRange).toBe(true);
    });

    it("explains a holding listed after the last point the chart draws", async () => {
      // Every point would be null, which renders as a legend entry and a
      // footnote for a line with no segment. It is an absence, and it says so.
      priceService.loadSeries.mockResolvedValue(
        new Map([
          [
            "sec-spy",
            [
              { date: "2024-08-14", close: 100 },
              { date: "2025-07-01", close: 120 },
            ],
          ],
          ["sec-ipo", [{ date: "2025-07-15", close: 10 }]],
        ]),
      );

      const simulation = (
        await build({
          holdings: [
            {
              securityId: "sec-ipo",
              symbol: "IPO",
              marketValue: 5000,
              isCash: false,
            },
          ],
        })
      )?.currentPortfolio;

      expect(simulation?.unavailableReason).toBe("MISSING_PRICE_HISTORY");
      expect(simulation?.points).toEqual([]);
    });

    it("explains a holding whose feed stops before every plotted date", async () => {
      /**
       * Invariant: a simulation with no drawable point is reported as
       * unavailable, with a reason.
       * Canonical adversarial input: a feed that is fresh at its own last
       * close and stale at every date the chart draws -- the holding is
       * priceable, so it passes the base check, and then carries forward to
       * nothing.
       * Minimal mutation: drop the all-null check in
       * `simulateCurrentComposition`.
       * Test that fails under it: this one -- `unavailableReason` is null, so
       * the legend gains "Today's composition" for a line that is never drawn
       * and the chart says nothing about why.
       */
      priceService.loadSeries.mockResolvedValue(
        new Map([
          [
            "sec-spy",
            [
              { date: "2024-08-14", close: 100 },
              { date: "2025-08-14", close: 120 },
            ],
          ],
          // Its own last close is what the simulation is based on, and it is
          // three weeks before the only later date the chart plots -- beyond
          // the carry-forward window, so that point is unknown too.
          ["sec-stale", [{ date: "2025-07-20", close: 10 }]],
        ]),
      );

      const simulation = (
        await build({
          holdings: [
            {
              securityId: "sec-stale",
              symbol: "STALE",
              marketValue: 5000,
              isCash: false,
            },
          ],
        })
      )?.currentPortfolio;

      expect(simulation?.unavailableReason).toBe("MISSING_PRICE_HISTORY");
      expect(simulation?.points).toEqual([]);
      expect(simulation?.totalReturnPercent).toBeNull();
    });

    it("names the instrument whose prices ran out, and where the line stops", async () => {
      /**
       * Invariant: a line that ends early says where and because of what.
       * Canonical adversarial input: two holdings, one of whose feeds stops
       * mid-window -- a point needs every leg, so the whole line ends there.
       * Minimal mutation: return `endsOn: null, stoppedBy: []` unconditionally.
       * Test that fails under it: this one -- the chart stops mid-air and the
       * user has nothing to act on.
       */
      priceService.loadSeries.mockResolvedValue(
        new Map([
          [
            "sec-spy",
            [
              { date: "2024-08-14", close: 100 },
              { date: "2025-02-14", close: 110 },
              { date: "2025-08-14", close: 120 },
            ],
          ],
          [
            "sec-live",
            [
              { date: "2024-08-14", close: 10 },
              { date: "2025-02-14", close: 11 },
              { date: "2025-08-14", close: 12 },
            ],
          ],
          // Refreshed until February and never again.
          [
            "sec-lapsed",
            [
              { date: "2024-08-14", close: 20 },
              { date: "2025-02-14", close: 21 },
            ],
          ],
        ]),
      );

      const simulation = (
        await build({
          holdings: [
            {
              securityId: "sec-live",
              symbol: "LIVE",
              marketValue: 5000,
              isCash: false,
            },
            {
              securityId: "sec-lapsed",
              symbol: "LAPSED",
              marketValue: 5000,
              isCash: false,
            },
          ],
        })
      )?.currentPortfolio;

      expect(simulation?.unavailableReason).toBeNull();
      expect(simulation?.endsOn).toBe("2025-02-14");
      // Named, not counted: the user has to know which one to go and refresh.
      expect(simulation?.stoppedBy).toEqual(["LAPSED"]);
      // And the window return is unknown rather than February's figure wearing
      // today's date.
      expect(simulation?.totalReturnPercent).toBeNull();
    });

    it("explains a simulation that never gets past its zero opening", async () => {
      /**
       * Invariant: a single priceable point is not a line. Rebasing makes the
       * opening 0% whatever the instrument did, so a lone point on the zero
       * axis reads as "your portfolio returned nothing" -- a claim, from one
       * quote.
       * Canonical adversarial input: a feed that reaches the window's opening
       * and stops.
       * Minimal mutation: require only one drawable point instead of two.
       * Test that fails under it: this one.
       */
      priceService.loadSeries.mockResolvedValue(
        new Map([
          [
            "sec-spy",
            [
              { date: "2024-08-14", close: 100 },
              { date: "2025-02-14", close: 110 },
              { date: "2025-08-14", close: 120 },
            ],
          ],
          // Priced on the window's first plotted date and never again.
          ["sec-quiet", [{ date: "2024-08-14", close: 10 }]],
        ]),
      );

      const simulation = (
        await build({
          holdings: [
            {
              securityId: "sec-quiet",
              symbol: "QUIET",
              marketValue: 5000,
              isCash: false,
            },
          ],
        })
      )?.currentPortfolio;

      expect(simulation?.unavailableReason).toBe("MISSING_PRICE_HISTORY");
      expect(simulation?.points).toEqual([]);
    });

    it("says there is nothing to simulate for empty accounts", async () => {
      twoHoldings();
      const simulation = (await build({ holdings: [] }))?.currentPortfolio;

      expect(simulation?.unavailableReason).toBe("NO_HOLDINGS");
    });

    it("prices the simulation from the same adjusted series as the asset lines", async () => {
      // One query, one basis. A second read could disagree with the lines the
      // simulation is drawn beside -- and `loadSeries` is the only place the
      // adjusted-close fallback lives.
      const holdings = twoHoldings();
      await build({ holdings });

      expect(priceService.loadSeries).toHaveBeenCalledTimes(1);
      const [ids] = priceService.loadSeries.mock.calls[0];
      expect([...ids].sort()).toEqual(["sec-emim", "sec-spy"]);
    });
  });

  /**
   * The adversarial cases for time-series rules 2, 3 and 4 on the chart.
   *
   * A feed that stops is not a flat line. Both of these passed before the
   * carry-forward was bounded: the chart drew EMIM level across eleven months
   * it had no price for, called it +20% for the year, and reported the whole
   * window as complete.
   */
  describe("a series whose feed stops mid-window", () => {
    const deadFeed = () =>
      priceService.loadSeries.mockResolvedValue(
        new Map([
          [
            "sec-spy",
            [
              { date: "2024-08-14", close: 100 },
              { date: "2024-09-30", close: 105 },
              { date: "2025-08-14", close: 111 },
            ],
          ],
          // Last quoted 2024-09-30: 318 days before the right edge of the
          // chart, 31 times the daily carry-forward window.
          [
            "sec-emim",
            [
              { date: "2024-08-14", close: 100 },
              { date: "2024-09-30", close: 120 },
            ],
          ],
        ]),
      );

    it("breaks the line instead of holding it level, and reports no total", async () => {
      deadFeed();

      const performance = await build();

      expect(performance?.totals).toEqual({ US_EQUITY: 11, EM_EQUITY: null });
      const last = performance?.points[performance.points.length - 1];
      expect(last?.date).toBe("2025-08-14");
      expect(last?.values.EM_EQUITY).toBeNull();
      // The window is not covered, and the caveat is what says so.
      expect(performance?.incomplete).toBe(true);
    });

    it("will not report a simulated return for a holding it stopped pricing", async () => {
      deadFeed();

      const simulation = (
        await build({
          holdings: [
            {
              securityId: "sec-emim",
              symbol: "EMIM",
              marketValue: 5000,
              isCash: false,
            },
          ],
        })
      )?.currentPortfolio;

      // Not +20%: that is the return to the day the prices stopped, and
      // printing it as the window's return dates a dead quote to today.
      expect(simulation?.totalReturnPercent).toBeNull();
      expect(simulation?.completeRange).toBe(false);
      expect(
        simulation?.points[simulation.points.length - 1].returnPercent,
      ).toBeNull();
    });
  });
});
