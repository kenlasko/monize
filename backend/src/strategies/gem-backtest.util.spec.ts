import { PricePoint } from "./gem-momentum.util";
import { GemBacktestInput, runBacktest } from "./gem-backtest.util";

/** A flat-then-stepped daily series: `closes` keyed by date. */
const series = (closes: Record<string, number>): PricePoint[] =>
  Object.entries(closes)
    .map(([date, close]) => ({ date, close }))
    .sort((a, b) => a.date.localeCompare(b.date));

/**
 * A series observed every seven days between waypoints, linearly interpolated.
 *
 * The backtest reads `"day"` sampling -- real input is a daily close with at
 * most a long weekend between observations -- and the drawdown now refuses to
 * describe a path it did not see. A fixture of three points a quarter apart is
 * not a sparser version of that input, it is a different one, and a test built
 * on it proves nothing about the code that runs on daily prices.
 */
const walk = (waypoints: Record<string, number>): PricePoint[] => {
  const marks = Object.entries(waypoints).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const points: PricePoint[] = [];
  const day = 86_400_000;
  for (let leg = 0; leg < marks.length - 1; leg += 1) {
    const [fromDate, fromClose] = marks[leg];
    const [toDate, toClose] = marks[leg + 1];
    const start = Date.parse(`${fromDate}T00:00:00Z`);
    const span = Date.parse(`${toDate}T00:00:00Z`) - start;
    for (let at = 0; at < span; at += 7 * day) {
      points.push({
        date: new Date(start + at).toISOString().slice(0, 10),
        close: fromClose + ((toClose - fromClose) * at) / span,
      });
    }
  }
  const [lastDate, lastClose] = marks[marks.length - 1];
  points.push({ date: lastDate, close: lastClose });
  return points;
};

const input = (
  overrides: Partial<GemBacktestInput> = {},
): GemBacktestInput => ({
  periods: [
    {
      effectiveFrom: "2024-01-01",
      targetRole: "US_EQUITY",
      targetSecurityId: "sec-spy",
      previousRole: null,
    },
    {
      effectiveFrom: "2024-07-01",
      targetRole: "US_EQUITY",
      targetSecurityId: "sec-spy",
      previousRole: "US_EQUITY",
    },
  ],
  seriesBySecurity: new Map([
    [
      "sec-spy",
      series({ "2024-01-01": 100, "2024-07-01": 110, "2025-01-01": 121 }),
    ],
  ]),
  safeSecurityId: null,
  taxRatePercent: null,
  commissionAmount: null,
  notional: null,
  accountCount: 1,
  hasEarlierSignals: false,
  asOf: "2025-01-01",
  ...overrides,
});

describe("runBacktest", () => {
  it("compounds the periods into an annualized return", () => {
    // 100 -> 121 over the simulated span: ~21% a year. The assertions are to
    // within half a point because 2024 is a leap year and the annualization
    // divides by 365.25 days, which dilutes a 366-day run very slightly.
    const result = runBacktest(input());

    expect(result).toMatchObject({ from: "2024-01-01", to: "2025-01-01" });
    expect(result?.cagrPercent).toBeCloseTo(21, 0);
    expect(result?.taxApplied).toBe(false);
    expect(result?.commissionApplied).toBe(false);
  });

  it("reports the worst decline inside a period, not only at its ends", () => {
    // The period starts and ends level, but halves in between: a period-end
    // simulation would report no drawdown at all.
    const result = runBacktest(
      input({
        seriesBySecurity: new Map([
          [
            "sec-spy",
            walk({
              "2024-01-01": 100,
              "2024-04-01": 50,
              "2024-07-01": 100,
              "2025-01-01": 100,
            }),
          ],
        ]),
      }),
    );

    expect(result?.maxDrawdownPercent).toBeCloseTo(-50, 1);
    expect(result?.cagrPercent).toBeCloseTo(0, 6);
  });

  /**
   * The adversarial case for the drawdown (time-series contract rule 4): the
   * two boundaries are priced and near enough to stand for their dates, so the
   * return is honest -- but nobody observed the middle, and that is exactly
   * where a drawdown lives.
   */
  it("refuses a drawdown over a period whose interior was never observed", () => {
    const result = runBacktest(
      input({
        periods: [
          {
            effectiveFrom: "2024-01-01",
            targetRole: "US_EQUITY",
            targetSecurityId: "sec-spy",
            previousRole: null,
          },
        ],
        // A 33-day hole with no observation inside the period at all. The
        // instrument may have halved and recovered inside it; nothing here
        // says otherwise.
        seriesBySecurity: new Map([
          ["sec-spy", series({ "2023-12-29": 100, "2024-02-01": 100 })],
        ]),
        asOf: "2024-02-01",
      }),
    );

    expect(result?.maxDrawdownPercent).toBeNull();
    // The period return itself is still knowable: both boundaries are priced.
    expect(result?.cagrPercent).toBeCloseTo(0, 6);
  });

  it("values the trailing period from the newest close, not from a close dated after today", () => {
    // The settled rule -- a boundary is priceable only once the series holds a
    // close dated at or after it -- applies to the calendar boundaries the
    // strategy fixed, and must not apply to `asOf`. "Now" never has a close
    // dated at or after it until the market shuts, so applying it here would
    // drop the trailing mark-to-market period on every trading day: for a
    // strategy with one evaluation, the entire run.
    const result = runBacktest(
      input({
        periods: [
          {
            effectiveFrom: "2024-01-01",
            targetRole: "US_EQUITY",
            targetSecurityId: "sec-spy",
            previousRole: null,
          },
        ],
        seriesBySecurity: new Map([
          ["sec-spy", walk({ "2023-12-29": 100, "2024-06-28": 110 })],
        ]),
        // Two days past the newest close, the ordinary state of a live series.
        asOf: "2024-06-30",
      }),
    );

    expect(result).toMatchObject({ from: "2024-01-01", to: "2024-06-30" });
    expect(result?.coveragePercent).toBe(100);
  });

  /**
   * The adversarial case for the boundary rule: a period younger than
   * `BOUNDARY_LAG_DAYS` resolves both of its ends to the same close, which used
   * to come back as a hard 0% and count itself as a fully covered period.
   */
  it("drops a period too young to have produced a second close", () => {
    const result = runBacktest(
      input({
        periods: [
          {
            effectiveFrom: "2024-01-01",
            targetRole: "US_EQUITY",
            targetSecurityId: "sec-spy",
            previousRole: null,
          },
          {
            effectiveFrom: "2024-07-01",
            targetRole: "US_EQUITY",
            targetSecurityId: "sec-spy",
            previousRole: "US_EQUITY",
          },
        ],
        seriesBySecurity: new Map([
          ["sec-spy", walk({ "2024-01-01": 100, "2024-07-01": 110 })],
        ]),
        // Three days into the second period, whose newest close is 2024-07-01.
        asOf: "2024-07-04",
      }),
    );

    // The young period is not a gap: the first period survives it, and the run
    // ends where the prices do rather than being thrown away entirely.
    expect(result).toMatchObject({ from: "2024-01-01", to: "2024-07-01" });
    // 100 % coverage over one elapsed period -- the young one is not counted
    // in the denominator either, because it has not happened.
    expect(result?.coveragePercent).toBe(100);
  });

  it("charges tax on the gain realized when the instrument changes", () => {
    // Doubles in the first period, then switches: 100% of the gain is realized
    // and 20% of it is taxed away before the second leg starts.
    const result = runBacktest(
      input({
        periods: [
          {
            effectiveFrom: "2024-01-01",
            targetRole: "US_EQUITY",
            targetSecurityId: "sec-spy",
            previousRole: null,
          },
          {
            effectiveFrom: "2024-07-01",
            targetRole: "EM_EQUITY",
            targetSecurityId: "sec-emim",
            previousRole: "US_EQUITY",
          },
        ],
        seriesBySecurity: new Map([
          ["sec-spy", series({ "2024-01-01": 100, "2024-07-01": 200 })],
          ["sec-emim", series({ "2024-07-01": 10, "2025-01-01": 10 })],
        ]),
        taxRatePercent: 20,
      }),
    );

    // Equity 2.0 at the switch, minus 20% of the 1.0 gain = 1.8 over one year.
    expect(result?.cagrPercent).toBeCloseTo(80, 0);
    expect(result?.taxApplied).toBe(true);
  });

  it("charges no tax on a switch out of a loss", () => {
    const result = runBacktest(
      input({
        periods: [
          {
            effectiveFrom: "2024-01-01",
            targetRole: "US_EQUITY",
            targetSecurityId: "sec-spy",
            previousRole: null,
          },
          {
            effectiveFrom: "2024-07-01",
            targetRole: "EM_EQUITY",
            targetSecurityId: "sec-emim",
            previousRole: "US_EQUITY",
          },
        ],
        seriesBySecurity: new Map([
          ["sec-spy", series({ "2024-01-01": 100, "2024-07-01": 50 })],
          ["sec-emim", series({ "2024-07-01": 10, "2025-01-01": 10 })],
        ]),
        taxRatePercent: 20,
      }),
    );

    // A halving and nothing after it: exactly -50% over the year, untaxed.
    expect(result?.cagrPercent).toBeCloseTo(-50, 0);
  });

  it("turns the per-trade commission into a drag against the notional", () => {
    const result = runBacktest(
      input({ commissionAmount: 100, notional: 10_000 }),
    );

    // The run grows 1.21x gross, so today's 10,000 was 8,264 at the start and
    // one order costs 100 / 8,264 = 0.0121 of the starting 1.
    const fee = 0.01 * 1.21;
    const years = 366 / 365.25;
    expect(result?.cagrPercent).toBeCloseTo(
      (Math.pow((1 - fee) * 1.21, 1 / years) - 1) * 100,
      2,
    );
    expect(result?.commissionApplied).toBe(true);
  });

  /**
   * Invariant: a switch costs one order per account, in the simulation as in
   * the live estimate.
   * Canonical adversarial input: the same instrument held across several
   * accounts (testing contract, collections).
   * Minimal mutation: charge `legs` trades instead of `legs * ordersPerLeg`.
   * Test that fails under it: this one -- three accounts read as one.
   */
  /**
   * Invariant: the acquisition commission is part of the tax basis, in the
   * simulation as in the live report.
   * Canonical adversarial input: money with a fee alongside the principal,
   * carried across a boundary (testing contract, money precision).
   * Minimal mutation: move `legEntryEquity = equity` back below the buy
   * commission. Test that fails under it: this one -- the tax comes out on a
   * basis of 0.99 rather than 1.
   */
  it("counts the buy commission in the basis the next switch is taxed on", () => {
    const result = runBacktest(
      input({
        periods: [
          {
            effectiveFrom: "2024-01-01",
            targetRole: "US_EQUITY",
            targetSecurityId: "sec-spy",
            previousRole: null,
          },
          {
            effectiveFrom: "2024-07-01",
            targetRole: "EM_EQUITY",
            targetSecurityId: "sec-emim",
            previousRole: "US_EQUITY",
          },
        ],
        seriesBySecurity: new Map([
          ["sec-spy", series({ "2024-01-01": 100, "2024-07-01": 110 })],
          ["sec-emim", series({ "2024-07-01": 10, "2025-01-01": 10 })],
        ]),
        taxRatePercent: 20,
        commissionAmount: 100,
        notional: 10_000,
        accountCount: 1,
      }),
    );

    // 100 against a 10,000 notional today; the run is 1.08x net of tax, so
    // the starting capital was 10,000 / 1.08 and an order is 0.0108 of it.
    const fee = 0.01 * 1.08;
    // The whole sum committed to the position, fee included -- what the
    // purchase cost, not what ended up invested. This is the one line the
    // test exists for.
    const basis = 1;
    const grossAtSwitch = (basis - fee) * 1.1;
    const tax = (grossAtSwitch - basis) * 0.2;
    // Each leg's fee is the same sum of equity units.
    const finalEquity = grossAtSwitch - tax - fee - fee;
    const years = 366 / 365.25;

    expect(result?.cagrPercent).toBeCloseTo(
      (Math.pow(finalEquity, 1 / years) - 1) * 100,
      2,
    );

    // And not this: a basis of 0.99 taxes the fee as though it were profit.
    const understated = grossAtSwitch - (grossAtSwitch - (basis - fee)) * 0.2;
    expect(result?.cagrPercent).not.toBeCloseTo(
      (Math.pow(understated - fee - fee, 1 / years) - 1) * 100,
      2,
    );
  });

  /**
   * Invariant: the commission is an absolute sum per order, so a run that has
   * doubled does not make an order cost twice as many equity units.
   * Minimal mutation: charge `equity * fraction` instead of a fixed cost.
   * Test that fails under it: this one -- the switch fee grows to 0.04.
   */
  it("keeps the per-order cost constant while the equity doubles", () => {
    const result = runBacktest(
      input({
        periods: [
          {
            effectiveFrom: "2024-01-01",
            targetRole: "US_EQUITY",
            targetSecurityId: "sec-spy",
            previousRole: null,
          },
          {
            effectiveFrom: "2024-07-01",
            targetRole: "EM_EQUITY",
            targetSecurityId: "sec-emim",
            previousRole: "US_EQUITY",
          },
        ],
        seriesBySecurity: new Map([
          ["sec-spy", series({ "2024-01-01": 100, "2024-07-01": 200 })],
          ["sec-emim", series({ "2024-07-01": 10, "2025-01-01": 10 })],
        ]),
        commissionAmount: 100,
        notional: 10_000,
      }),
    );

    // Gross 2x, so the starting capital was 5,000 and an order is 0.02.
    const fee = 0.01 * 2;
    const finalEquity = (1 - fee) * 2 - fee - fee;
    const years = 366 / 365.25;
    expect(result?.cagrPercent).toBeCloseTo(
      (Math.pow(finalEquity, 1 / years) - 1) * 100,
      2,
    );
  });

  it("charges the commission once per account, not once per switch", () => {
    const oneAccount = runBacktest(
      input({ commissionAmount: 100, notional: 10_000, accountCount: 1 }),
    );
    const threeAccounts = runBacktest(
      input({ commissionAmount: 100, notional: 10_000, accountCount: 3 }),
    );

    // The opening purchase is three orders rather than one: 3% off the
    // notional instead of 1%, and the gap grows with every later switch.
    expect(threeAccounts?.cagrPercent).toBeLessThan(
      oneAccount?.cagrPercent as number,
    );
    expect(threeAccounts?.commissionApplied).toBe(true);
    // One order is 0.0121 of the starting 1 (gross 1.21x): 3 against 1 order.
    const ratio =
      (1 + (threeAccounts?.cagrPercent as number) / 100) /
      (1 + (oneAccount?.cagrPercent as number) / 100);
    expect(ratio).toBeCloseTo((1 - 3 * 0.0121) / (1 - 0.0121), 3);
  });

  it("restarts the run after a period it could not price", () => {
    // Holding a gap flat is not a simplification: the switch out of it would
    // realize nothing, so no tax comes off, and every later period compounds
    // from a balance the simulation invented. The run therefore begins after
    // the last gap, and `from` says so.
    const result = runBacktest(
      input({
        periods: [
          {
            effectiveFrom: "2024-01-01",
            targetRole: "US_EQUITY",
            targetSecurityId: "sec-unpriced",
            previousRole: null,
          },
          {
            effectiveFrom: "2024-07-01",
            targetRole: "US_EQUITY",
            targetSecurityId: "sec-spy",
            previousRole: "US_EQUITY",
          },
        ],
      }),
    );

    expect(result?.from).toBe("2024-07-01");
    expect(result?.to).toBe("2025-01-01");
    expect(result?.coveragePercent).toBe(50);
    // 110 -> 121 over half a year: ~21% annualised, and nothing from the gap.
    expect(result?.cagrPercent).toBeCloseTo(21, 0);
  });

  it("reports a truncated run gross, whatever costs are configured", () => {
    // The run opens on 2024-04-01 because the period before it could not be
    // priced -- but the strategy was already invested then, in something the
    // simulation cannot see and at a price it does not know. Charging an
    // opening commission bills a trade that never happened, and dating the tax
    // basis to 2024-04-01 taxes the July switch on the gain since the restart
    // rather than since the real purchase. Both are inventions, so a truncated
    // run reports gross and says so.
    const periods: GemBacktestInput["periods"] = [
      {
        effectiveFrom: "2024-01-01",
        targetRole: "US_EQUITY",
        targetSecurityId: "sec-unpriced",
        previousRole: null,
      },
      {
        effectiveFrom: "2024-04-01",
        targetRole: "US_EQUITY",
        targetSecurityId: "sec-spy",
        previousRole: "US_EQUITY",
      },
      {
        effectiveFrom: "2024-07-01",
        targetRole: "EM_EQUITY",
        targetSecurityId: "sec-emim",
        previousRole: "US_EQUITY",
      },
    ];
    const seriesBySecurity = new Map([
      ["sec-spy", series({ "2024-04-01": 100, "2024-07-01": 200 })],
      ["sec-emim", series({ "2024-07-01": 10, "2025-01-01": 10 })],
    ]);

    const taxed = runBacktest(
      input({ periods, seriesBySecurity, taxRatePercent: 20 }),
    );
    const gross = runBacktest(
      input({ periods, seriesBySecurity, taxRatePercent: null }),
    );

    expect(taxed?.from).toBe("2024-04-01");
    expect(taxed?.taxApplied).toBe(false);
    expect(taxed?.commissionApplied).toBe(false);
    // The doubling reaches the end intact: no tax came off the switch.
    expect(taxed?.cagrPercent).toBe(gross?.cagrPercent);
    expect(taxed?.coveragePercent).toBeCloseTo(66.67, 1);
  });

  it("has nothing to report when the most recent period is unpriced", () => {
    expect(
      runBacktest(
        input({
          periods: [
            {
              effectiveFrom: "2024-01-01",
              targetRole: "US_EQUITY",
              targetSecurityId: "sec-spy",
              previousRole: null,
            },
            {
              effectiveFrom: "2024-07-01",
              targetRole: "US_EQUITY",
              targetSecurityId: "sec-unpriced",
              previousRole: "US_EQUITY",
            },
          ],
        }),
      ),
    ).toBeNull();
  });

  it("does not let one stale quote price both ends of a period", () => {
    // A security last quoted in January answers a lookup for July and one for
    // January the following year with the same number. That is not a period
    // that opened and closed level -- it is a period nobody priced, and it used
    // to count towards full coverage with a confident 0% return.
    const result = runBacktest(
      input({
        seriesBySecurity: new Map([["sec-spy", series({ "2024-01-01": 100 })]]),
      }),
    );

    expect(result).toBeNull();
  });

  it("prices a period that opens on a day the market was shut", () => {
    // The 1st is regularly a weekend or a holiday, so the close that prices it
    // is the one a few days earlier. Within a fortnight it stands for the
    // boundary; older than that it does not.
    const result = runBacktest(
      input({
        seriesBySecurity: new Map([
          [
            "sec-spy",
            series({
              "2023-12-28": 100, // last trading day before the period opens
              "2024-06-28": 110,
              "2024-12-30": 121,
            }),
          ],
        ]),
      }),
    );

    expect(result?.coveragePercent).toBe(100);
    expect(result?.cagrPercent).toBeCloseTo(21, 0);
  });

  it("leaves commission out when the capital it applies to is unknown", () => {
    const result = runBacktest(
      input({ commissionAmount: 100, notional: null }),
    );

    expect(result?.cagrPercent).toBeCloseTo(21, 0);
    expect(result?.taxApplied).toBe(false);
    expect(result?.commissionApplied).toBe(false);
  });

  it("reports tax and commission separately when only one could be applied", () => {
    // Both are configured, but the portfolio total is unknown -- which is what
    // happens whenever a single holding cannot be priced -- so the absolute
    // commission cannot be turned into a drag while the tax percentage still
    // can. Under one `netOfCosts` flag this came out true, and the report then
    // told the user the figures were net of estimated taxes *and commissions*.
    const result = runBacktest(
      input({
        periods: [
          {
            effectiveFrom: "2024-01-01",
            targetRole: "US_EQUITY",
            targetSecurityId: "sec-spy",
            previousRole: null,
          },
          {
            effectiveFrom: "2024-07-01",
            targetRole: "EM_EQUITY",
            targetSecurityId: "sec-emim",
            previousRole: "US_EQUITY",
          },
        ],
        seriesBySecurity: new Map([
          ["sec-spy", series({ "2024-01-01": 100, "2024-07-01": 200 })],
          ["sec-emim", series({ "2024-07-01": 10, "2025-01-01": 10 })],
        ]),
        taxRatePercent: 20,
        commissionAmount: 100,
        notional: null,
      }),
    );

    expect(result?.taxApplied).toBe(true);
    expect(result?.commissionApplied).toBe(false);
    // The tax really did come off: 2.0 at the switch, less 20% of the gain.
    expect(result?.cagrPercent).toBeCloseTo(80, 0);
  });

  it("counts the periods whose asset beat the safe one", () => {
    const result = runBacktest(
      input({
        periods: [
          {
            effectiveFrom: "2024-01-01",
            targetRole: "US_EQUITY",
            targetSecurityId: "sec-spy",
            previousRole: null,
          },
          {
            effectiveFrom: "2024-07-01",
            targetRole: "US_EQUITY",
            targetSecurityId: "sec-spy",
            previousRole: "US_EQUITY",
          },
        ],
        seriesBySecurity: new Map([
          [
            "sec-spy",
            series({ "2024-01-01": 100, "2024-07-01": 110, "2025-01-01": 100 }),
          ],
          [
            "sec-ief",
            series({ "2024-01-01": 100, "2024-07-01": 101, "2025-01-01": 105 }),
          ],
        ]),
        safeSecurityId: "sec-ief",
      }),
    );

    // Equities won the first period (+10% vs +1%) and lost the second.
    expect(result?.hitRatePercent).toBe(50);
  });

  it("has no hit rate when a simulated period cannot be compared", () => {
    // The safe asset stops being quoted halfway through. Counting only the
    // periods that could be checked answers a question nobody asked -- "of the
    // ones we could check, how many won" -- and prints the ratio beside a run
    // twice as long, under a denominator the reader cannot see.
    const result = runBacktest(
      input({
        seriesBySecurity: new Map([
          [
            "sec-spy",
            series({ "2024-01-01": 100, "2024-07-01": 110, "2025-01-01": 121 }),
          ],
          ["sec-ief", series({ "2024-01-01": 100, "2024-07-01": 101 })],
        ]),
        safeSecurityId: "sec-ief",
      }),
    );

    expect(result?.cagrPercent).toBeCloseTo(21, 0);
    expect(result?.hitRatePercent).toBeNull();
  });

  it("has no hit rate without a safe asset to compare against", () => {
    expect(runBacktest(input())?.hitRatePercent).toBeNull();
  });

  it("simulates a single evaluation, whose period runs to asOf", () => {
    // One signal effective in January and an `asOf` of the following January
    // is a complete year: an entry price, an exit price and the daily path in
    // between. Requiring a second evaluation withheld the report from a
    // strategy that had simply not switched yet.
    const result = runBacktest(input({ periods: [input().periods[0]] }));

    expect(result).toMatchObject({ from: "2024-01-01", to: "2025-01-01" });
    expect(result?.cagrPercent).toBeCloseTo(21, 0);
    expect(result?.coveragePercent).toBe(100);
  });

  it("reports gross when the first period already had a predecessor", () => {
    // The history keeps the last 24 periods, so the oldest signal in hand is
    // usually not the strategy's first allocation. Opening a fresh position
    // there charges a purchase commission for a trade that never happened and
    // resets the tax basis to the edge of the visible window, so the switch
    // below would be taxed on the gain since that reset rather than since the
    // real purchase.
    const periods: GemBacktestInput["periods"] = [
      {
        effectiveFrom: "2024-01-01",
        targetRole: "US_EQUITY",
        targetSecurityId: "sec-spy",
        previousRole: "SAFE",
      },
      {
        effectiveFrom: "2024-07-01",
        targetRole: "EM_EQUITY",
        targetSecurityId: "sec-emim",
        previousRole: "US_EQUITY",
      },
    ];
    const seriesBySecurity = new Map([
      ["sec-spy", series({ "2024-01-01": 100, "2024-07-01": 200 })],
      ["sec-emim", series({ "2024-07-01": 10, "2025-01-01": 10 })],
    ]);

    const withCosts = runBacktest(
      input({
        periods,
        seriesBySecurity,
        taxRatePercent: 20,
        commissionAmount: 100,
        notional: 10_000,
      }),
    );
    const gross = runBacktest(input({ periods, seriesBySecurity }));

    // Every period is priced, so coverage is full and the run is not truncated
    // by prices -- the costs are dropped because of what came *before* it.
    expect(withCosts?.coveragePercent).toBe(100);
    expect(withCosts?.taxApplied).toBe(false);
    expect(withCosts?.commissionApplied).toBe(false);
    expect(withCosts?.cagrPercent).toBe(gross?.cagrPercent);
  });

  it("reports gross when the strategy evaluated before the oldest period held", () => {
    // The dangerous shape: the first period in hand has *no* predecessor of its
    // own -- the row before it was written by another configuration or an older
    // algorithm version, so materialization gave it `previousRole: null` -- and
    // yet the strategy has been running for years. Reading that null as "this
    // is where it began" invents a purchase at the boundary price and, with the
    // real basis far lower, understates the tax on every later switch.
    const periods: GemBacktestInput["periods"] = [
      {
        effectiveFrom: "2024-01-01",
        targetRole: "US_EQUITY",
        targetSecurityId: "sec-spy",
        previousRole: null,
      },
      {
        effectiveFrom: "2024-07-01",
        targetRole: "EM_EQUITY",
        targetSecurityId: "sec-emim",
        previousRole: "US_EQUITY",
      },
    ];
    const seriesBySecurity = new Map([
      ["sec-spy", series({ "2024-01-01": 100, "2024-07-01": 200 })],
      ["sec-emim", series({ "2024-07-01": 10, "2025-01-01": 10 })],
    ]);

    const result = runBacktest(
      input({
        periods,
        seriesBySecurity,
        accountCount: 1,
        hasEarlierSignals: true,
        taxRatePercent: 20,
        commissionAmount: 100,
        notional: 10_000,
      }),
    );

    expect(result?.taxApplied).toBe(false);
    expect(result?.commissionApplied).toBe(false);
    expect(result?.cagrPercent).toBe(
      runBacktest(input({ periods, seriesBySecurity }))?.cagrPercent,
    );
  });

  it("ignores a period that opened today and has not elapsed", () => {
    // On the morning a period opens, its start and end are the same date: it
    // grows by exactly 1, which loses a hit-rate comparison against a safe
    // asset that also did nothing. The ratio dropped overnight and climbed
    // back over the month, with nothing about the strategy having changed.
    const periods: GemBacktestInput["periods"] = [
      {
        effectiveFrom: "2024-01-01",
        targetRole: "US_EQUITY",
        targetSecurityId: "sec-spy",
        previousRole: null,
      },
      {
        effectiveFrom: "2024-07-01",
        targetRole: "US_EQUITY",
        targetSecurityId: "sec-spy",
        previousRole: "US_EQUITY",
      },
      // Materialized this morning: asOf is its own effectiveFrom.
      {
        effectiveFrom: "2025-01-01",
        targetRole: "US_EQUITY",
        targetSecurityId: "sec-spy",
        previousRole: "US_EQUITY",
      },
    ];
    const seriesBySecurity = new Map([
      [
        "sec-spy",
        series({ "2024-01-01": 100, "2024-07-01": 110, "2025-01-01": 121 }),
      ],
      [
        "sec-ief",
        series({ "2024-01-01": 100, "2024-07-01": 100, "2025-01-01": 100 }),
      ],
    ]);

    const result = runBacktest(
      input({ periods, seriesBySecurity, safeSecurityId: "sec-ief" }),
    );

    // Two elapsed periods, both won, and the empty one counts for nothing --
    // neither against the hit rate nor against coverage.
    expect(result?.hitRatePercent).toBe(100);
    expect(result?.coveragePercent).toBe(100);
    expect(result?.to).toBe("2025-01-01");
  });

  it("has nothing to report without an evaluation or any price", () => {
    expect(runBacktest(input({ periods: [] }))).toBeNull();
    expect(runBacktest(input({ seriesBySecurity: new Map() }))).toBeNull();
    // A signal that became effective today has no period behind it yet.
    expect(
      runBacktest(input({ periods: [input().periods[0]], asOf: "2024-01-01" })),
    ).toBeNull();
  });

  it("reports nothing when the gap is the last thing that happened", () => {
    // The second leg has no prices at all, so there is no unbroken stretch
    // ending at today. Reporting the first half as though it were the run
    // would date the figures to a window that has since moved on.
    const result = runBacktest(
      input({
        periods: [
          {
            effectiveFrom: "2024-01-01",
            targetRole: "US_EQUITY",
            targetSecurityId: "sec-spy",
            previousRole: null,
          },
          {
            effectiveFrom: "2024-07-01",
            targetRole: "EM_EQUITY",
            targetSecurityId: "sec-unpriced",
            previousRole: "US_EQUITY",
          },
        ],
        seriesBySecurity: new Map([
          ["sec-spy", series({ "2024-01-01": 100, "2024-07-01": 110 })],
        ]),
      }),
    );

    expect(result).toBeNull();
  });
});
