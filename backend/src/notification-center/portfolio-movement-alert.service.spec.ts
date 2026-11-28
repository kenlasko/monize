import { Logger } from "@nestjs/common";
import type { BaselinePosition } from "./portfolio-price-freshness.util";
import { PortfolioMovementAlertService } from "./portfolio-movement-alert.service";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { UserPreference } from "../users/entities/user-preference.entity";
import { NotificationType } from "./entities/notification.entity";
import type {
  HoldingWithMarketValue,
  PortfolioService,
  PortfolioSummary,
} from "../securities/portfolio.service";
import { EMPTY_RETURN_DIAGNOSTICS } from "../securities/return-diagnostics.util";
import type { ExchangeRateService } from "../currencies/exchange-rate.service";
import type { NotificationDispatchService } from "../notifications/notification-dispatch.service";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);
jest.mock("../common/db/with-context", () => ({
  withSystemContext: jest.fn((fn: () => unknown) => fn()),
  withUserContext: jest.fn((_userId: string, fn: () => unknown) => fn()),
}));
jest.mock("../common/date-utils", () => ({
  ...jest.requireActual("../common/date-utils"),
  todayYMD: () => "2026-09-14",
}));

/** Monday; the baseline was captured on the previous Friday. */
const TODAY = "2026-09-14";
const FRIDAY = "2026-09-11";
const SATURDAY = "2026-09-12";
const USER = "11111111-1111-4111-8111-111111111111";
const SECURITY = "22222222-2222-4222-8222-222222222222";

/**
 * A held position as `getPortfolioSummary().holdings` reports one. Typed to the
 * real interface, so a field the producer starts reading cannot be invented
 * here without `tsc` noticing it is not one the service could have received.
 */
const holding = (
  over: Partial<HoldingWithMarketValue> = {},
): HoldingWithMarketValue => ({
  id: "h1",
  accountId: "a1",
  securityId: SECURITY,
  symbol: "VTI",
  name: "Vanguard Total Market",
  securityType: "ETF",
  currencyCode: "USD",
  quantity: 100,
  averageCost: 200,
  costBasis: 20_000,
  costBasisAccountCurrency: 20_000,
  currentPrice: 250,
  marketValue: 25_000,
  marketValueAccountCurrency: 25_000,
  marketValueDefaultCurrency: 25_000,
  gainLoss: 5_000,
  gainLossPercent: 25,
  ...over,
});

const summaryOf = (over: Partial<PortfolioSummary> = {}): PortfolioSummary => ({
  totalCashValue: 0,
  totalHoldingsValue: 100_000,
  totalCostBasis: 80_000,
  totalNetInvested: 80_000,
  totalPortfolioValue: 100_000,
  totalGainOverNetInvested: 20_000,
  totalGainLoss: 20_000,
  knownCashValueSubtotal: 0,
  knownHoldingsValueSubtotal: 100_000,
  knownCostBasisSubtotal: 80_000,
  knownNetInvestedSubtotal: 80_000,
  knownPortfolioValueSubtotal: 100_000,
  knownGainOverNetInvestedSubtotal: 20_000,
  knownGainLossSubtotal: 20_000,
  knownGainLossPercentSubtotal: 0,
  portfolioValueMissingRatePairs: [],
  cashMissingRatePairs: [],
  holdingsValueMissingRatePairs: [],
  costBasisMissingRatePairs: [],
  netInvestedMissingRatePairs: [],
  totalGainLossPercent: 25,
  gainCostBasis: 80_000,
  unpricedCostBasis: 0,
  timeWeightedReturn: null,
  timeWeightedReturnReasons: [],
  timeWeightedReturnSince: null,
  moneyWeightedReturn: null,
  moneyWeightedReturnReasons: [],
  returnDiagnostics: EMPTY_RETURN_DIAGNOSTICS,
  cagr: null,
  fxComplete: true,
  missingRatePairs: [],
  pricesComplete: true,
  unpricedSecurityIds: [],
  valuationComplete: true,
  holdings: [holding()],
  holdingsByAccount: [],
  allocation: [],
  ...over,
});

/** One row of `notification_portfolio_state`, as the producer's SELECT reads it. */
interface StateRow {
  move_alert_percent: string | null;
  baseline_value: string | null;
  baseline_currency: string | null;
  baseline_captured_on: string | null;
  baseline_positions: BaselinePosition[] | null;
}

/** The held position as Friday's baseline recorded it: 100 x 250, struck Friday. */
const positionOf = (
  over: Partial<BaselinePosition> = {},
): BaselinePosition => ({
  securityId: SECURITY,
  quantity: 100,
  close: 250,
  priceDate: FRIDAY,
  currency: "USD",
  ...over,
});

const stateOf = (over: Partial<StateRow> = {}): StateRow => ({
  move_alert_percent: "5",
  baseline_value: "100000",
  baseline_currency: "USD",
  baseline_captured_on: FRIDAY,
  baseline_positions: [positionOf()],
  ...over,
});

/** One row of the external-flow subtotal query, in the shape the SQL returns. */
interface FlowRow {
  date: string | null;
  currency: string;
  total: string;
}

interface Scenario {
  summary?: PortfolioSummary;
  state?: StateRow | null;
  flows?: FlowRow[];
  /** `currency@date` -> rate into the reporting currency, or null for none. */
  rates?: Record<string, number | null>;
  /** securityId -> the latest observation (close and date) for it. */
  prices?: Record<string, { close: number; date: string }>;
  currency?: string;
}

function setup(scenario: Scenario = {}) {
  const currency = scenario.currency ?? "USD";
  const { dataSource, manager } = createScopedDbMocks([
    [UserPreference, { findOne: jest.fn().mockResolvedValue(null) }],
  ]);

  const baselineWrites: Array<{ value: number; currency: string; on: string }> =
    [];
  const snapshotWrites: Array<BaselinePosition[] | null> = [];
  const flowStatements: string[] = [];

  manager.query.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql.includes("SELECT user_id FROM notification_portfolio_state")) {
      return [{ user_id: USER }];
    }
    if (sql.includes("default_currency")) {
      return [{ default_currency: currency }];
    }
    if (sql.includes("TO_CHAR(baseline_captured_on")) {
      const state = scenario.state === undefined ? stateOf() : scenario.state;
      return state === null ? [] : [state];
    }
    if (sql.includes("FROM transactions t")) {
      flowStatements.push(sql);
      return scenario.flows ?? [];
    }
    if (sql.includes("INSERT INTO notification_portfolio_state")) {
      const [, value, ccy, on, positions] = params as [
        string,
        number,
        string,
        string,
        string | null,
      ];
      baselineWrites.push({ value, currency: ccy, on });
      snapshotWrites.push(
        positions === null
          ? null
          : (JSON.parse(positions) as BaselinePosition[]),
      );
      return [];
    }
    throw new Error(`unexpected statement: ${sql}`);
  });

  const getPortfolioSummary = jest
    .fn<Promise<PortfolioSummary>, [string, string[]?]>()
    .mockResolvedValue(scenario.summary ?? summaryOf());
  const getLatestPriceObservations = jest
    .fn<Promise<Map<string, { close: number; date: string }>>, [string[]]>()
    .mockImplementation(async (ids) => {
      const prices = scenario.prices ?? {
        [SECURITY]: { close: 250, date: TODAY },
      };
      return new Map(
        ids
          .filter((id) => prices[id] !== undefined)
          .map((id) => [id, prices[id]]),
      );
    });
  const getRateForDate = jest
    .fn<Promise<number | null>, [string, string, string | Date]>()
    .mockImplementation(async (from, _to, on) => {
      const rates = scenario.rates ?? {};
      const key = `${from}@${String(on)}`;
      return key in rates ? rates[key] : null;
    });
  const notify = jest.fn().mockResolvedValue({ id: "written" });

  const service = new PortfolioMovementAlertService(
    dataSource as never,
    { getPortfolioSummary, getLatestPriceObservations } as Pick<
      PortfolioService,
      "getPortfolioSummary" | "getLatestPriceObservations"
    > as PortfolioService,
    { getRateForDate } as Pick<
      ExchangeRateService,
      "getRateForDate"
    > as ExchangeRateService,
    { notify } as Pick<
      NotificationDispatchService,
      "notify"
    > as NotificationDispatchService,
  );

  return {
    service,
    notify,
    baselineWrites,
    snapshotWrites,
    flowStatements,
    getRateForDate,
    getLatestPriceObservations,
  };
}

describe("PortfolioMovementAlertService", () => {
  it("converts a weekend deposit at its own day's rate, not the run day's", async () => {
    // INV-PORTMOVE-007. A 1,000 CAD deposit landed on Saturday at 0.70; by
    // Monday the pair is 0.80. At Saturday's rate the deposit is 700 USD and the
    // portfolio moved nothing; at Monday's it is 800 and the producer would
    // report a -100 "market loss" that is purely the weekend's FX move.
    const { service, notify, baselineWrites, getRateForDate, flowStatements } =
      setup({
        summary: summaryOf({ totalPortfolioValue: 100_700 }),
        flows: [{ date: SATURDAY, currency: "CAD", total: "1000" }],
        rates: { [`CAD@${SATURDAY}`]: 0.7, [`CAD@${TODAY}`]: 0.8 },
      });

    await service.run();

    expect(getRateForDate).toHaveBeenCalledWith("CAD", "USD", SATURDAY);
    expect(getRateForDate).not.toHaveBeenCalledWith("CAD", "USD", TODAY);
    // movement = 100,700 - 100,000 - 700 = 0 -> nothing to report, rebaseline.
    expect(notify).not.toHaveBeenCalled();
    expect(baselineWrites).toEqual([
      { value: 100_700, currency: "USD", on: TODAY },
    ]);
    // The subtotals have to arrive dated, or there is no day to price at.
    expect(flowStatements[0]).toContain(
      "TO_CHAR(t.transaction_date, 'YYYY-MM-DD') AS date",
    );
    expect(flowStatements[0]).toContain(
      "GROUP BY t.transaction_date, t.currency_code",
    );
  });

  it("withholds and does not advance the baseline when one flow day has no rate", async () => {
    // INV-PORTMOVE-001/002: an unconvertible contribution makes the movement
    // unknown. Not 0, not the unconverted amount, and not a new baseline -- a
    // baseline taken on an unknown run makes the NEXT comparison wrong too.
    const { service, notify, baselineWrites } = setup({
      summary: summaryOf({ totalPortfolioValue: 120_000 }),
      flows: [
        { date: SATURDAY, currency: "CAD", total: "1000" },
        { date: TODAY, currency: "CAD", total: "1000" },
      ],
      rates: { [`CAD@${TODAY}`]: 0.8, [`CAD@${SATURDAY}`]: null },
    });

    await service.run();

    expect(notify).not.toHaveBeenCalled();
    expect(baselineWrites).toEqual([]);
  });

  it("does not let a hand-priced holding silence the alert (#1435)", async () => {
    // The holding was last priced in June and still is. Before, the run was
    // withheld and the baseline never advanced, so no alert ever fired again.
    // The carried close contributes the same figure to both ends; the rest of
    // the portfolio fell 8%, and that is what the alert reports.
    const june = "2026-06-30";
    const { service, notify, baselineWrites, snapshotWrites } = setup({
      state: stateOf({
        baseline_positions: [positionOf({ priceDate: june })],
      }),
      summary: summaryOf({ totalPortfolioValue: 92_000 }),
      prices: { [SECURITY]: { close: 250, date: june } },
    });

    await service.run();

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][1].data).toMatchObject({
      changePercent: -8,
      latePriceAdjustment: 0,
      latePrices: [],
    });
    expect(baselineWrites).toEqual([
      { value: 92_000, currency: "USD", on: TODAY },
    ]);
    expect(snapshotWrites).toEqual([
      [positionOf({ priceDate: june, close: 250 })],
    ]);
  });

  it("restates the baseline at a late close instead of reporting the catch-up (#1391)", async () => {
    // The holding was valued at June's 200 at the baseline; today's close is
    // 250. Booked as a move, 100 x 50 = 5,000 reads as +5.5% and fires. It is
    // a late price, so the baseline is restated to 105,000 and the period's
    // own move is +500 (+0.48%): silent, and the baseline still advances.
    const { service, notify, baselineWrites } = setup({
      state: stateOf({
        baseline_positions: [
          positionOf({ priceDate: "2026-06-30", close: 200 }),
        ],
      }),
      summary: summaryOf({ totalPortfolioValue: 105_500 }),
    });

    await service.run();

    expect(notify).not.toHaveBeenCalled();
    expect(baselineWrites).toEqual([
      { value: 105_500, currency: "USD", on: TODAY },
    ]);
  });

  it("keeps the baseline when the alert could not be written (A26-L28)", async () => {
    const { service, notify, baselineWrites } = setup({
      summary: summaryOf({ totalPortfolioValue: 90_000 }),
    });
    notify.mockRejectedValueOnce(new Error("connection reset"));

    await service.run();

    expect(notify).toHaveBeenCalledTimes(1);
    expect(baselineWrites).toEqual([]);

    // The next run still sees the movement and raises the alert.
    await service.run();
    expect(notify).toHaveBeenCalledTimes(2);
    expect(baselineWrites).toEqual([
      { value: 90_000, currency: "USD", on: TODAY },
    ]);
  });

  it("writes the alert before it moves the baseline (A26-L28)", async () => {
    const order: string[] = [];
    const { service, notify, baselineWrites } = setup({
      summary: summaryOf({ totalPortfolioValue: 90_000 }),
    });
    notify.mockImplementation(async () => {
      order.push(`notify:${baselineWrites.length}`);
      return { id: "written" };
    });

    await service.run();

    expect(order).toEqual(["notify:0"]);
    expect(baselineWrites).toHaveLength(1);
  });

  it("still moves the baseline when another replica wrote today's alert (A26-L28)", async () => {
    const { service, notify, baselineWrites } = setup({
      summary: summaryOf({ totalPortfolioValue: 90_000 }),
    });
    notify.mockResolvedValueOnce(null);

    await service.run();

    expect(baselineWrites).toEqual([
      { value: 90_000, currency: "USD", on: TODAY },
    ]);
  });

  it("names the late close it removed when the period's own move fires", async () => {
    const { service, notify } = setup({
      state: stateOf({
        baseline_positions: [
          positionOf({ priceDate: "2026-06-30", close: 200 }),
        ],
      }),
      // Restated baseline 105,000; 94,500 is -10,500 / 105,000 = -10%.
      summary: summaryOf({ totalPortfolioValue: 94_500 }),
    });

    await service.run();

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][1].data).toMatchObject({
      changePercent: -10,
      movementValue: -10_500,
      baselineValue: 100_000,
      latePriceAdjustment: 5_000,
      latePrices: [
        {
          securityId: SECURITY,
          symbol: "VTI",
          fromDate: "2026-06-30",
          toDate: TODAY,
          value: 5_000,
        },
      ],
    });
  });

  it("values a late close on a position sold since at the resolver's rate for today", async () => {
    // The CAD position is no longer held, so no holding carries its rate; its
    // proceeds are in today's cash at the new close, so it is restated too:
    // 10 x (60 - 50) x 0.75 = 75.
    const sold = "33333333-3333-4333-8333-333333333333";
    const { service, notify, getRateForDate } = setup({
      state: stateOf({
        baseline_positions: [
          positionOf(),
          positionOf({
            securityId: sold,
            quantity: 10,
            close: 50,
            priceDate: "2026-06-30",
            currency: "CAD",
          }),
        ],
      }),
      summary: summaryOf({ totalPortfolioValue: 91_567.5 }),
      prices: {
        [SECURITY]: { close: 250, date: TODAY },
        [sold]: { close: 60, date: TODAY },
      },
      rates: { [`CAD@${TODAY}`]: 0.75 },
    });

    await service.run();

    expect(getRateForDate).toHaveBeenCalledWith("CAD", "USD", TODAY);
    // (91,567.5 - 100,075) / 100,075 = -8.5%
    expect(notify.mock.calls[0][1].data).toMatchObject({
      latePriceAdjustment: 75,
      changePercent: -8.5,
    });
  });

  it("rebaselines without firing when a late close cannot be valued", async () => {
    // No rate for the sold position's currency: the movement is unknown, so
    // nothing fires, and the baseline moves on rather than keeping the closes
    // that would make every later run unknown too.
    const sold = "33333333-3333-4333-8333-333333333333";
    const { service, notify, baselineWrites } = setup({
      state: stateOf({
        baseline_positions: [
          positionOf({
            securityId: sold,
            quantity: 10,
            close: 50,
            priceDate: "2026-06-30",
            currency: "CAD",
          }),
        ],
      }),
      summary: summaryOf({ totalPortfolioValue: 80_000 }),
      prices: {
        [SECURITY]: { close: 250, date: TODAY },
        [sold]: { close: 60, date: TODAY },
      },
    });
    const warn = jest
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => undefined);

    await service.run();

    const lines = warn.mock.calls.map(([message]) => String(message));
    warn.mockRestore();
    expect(notify).not.toHaveBeenCalled();
    expect(baselineWrites).toEqual([
      { value: 80_000, currency: "USD", on: TODAY },
    ]);
    expect(lines.some((line) => line.includes(sold))).toBe(true);
  });

  it("replaces a baseline stored without its closes instead of comparing against it", async () => {
    // Every baseline written before the closes were recorded. It cannot tell a
    // late price from a market move, so the first run after the upgrade records
    // a fresh baseline with its closes, and the next one compares.
    const { service, notify, baselineWrites, snapshotWrites, flowStatements } =
      setup({
        state: stateOf({ baseline_positions: null }),
        summary: summaryOf({ totalPortfolioValue: 80_000 }),
      });

    await service.run();

    expect(notify).not.toHaveBeenCalled();
    expect(flowStatements).toEqual([]);
    expect(baselineWrites).toEqual([
      { value: 80_000, currency: "USD", on: TODAY },
    ]);
    expect(snapshotWrites).toEqual([[positionOf({ priceDate: TODAY })]]);
  });

  it("fires once and re-baselines on a complete run over the threshold", async () => {
    const { service, notify, baselineWrites } = setup({
      summary: summaryOf({ totalPortfolioValue: 92_000 }),
    });

    await service.run();

    expect(notify).toHaveBeenCalledTimes(1);
    const [recipient, written] = notify.mock.calls[0];
    expect(recipient).toBe(USER);
    expect(written).toMatchObject({
      type: NotificationType.PORTFOLIO_MOVEMENT,
      target: "/investments",
      dedupeKey: `portmove:USD:${TODAY}`,
    });
    // The payload identifies what was measured and over which period, so a
    // reader can reproduce the figure rather than take it on trust.
    expect(written.data).toEqual({
      changePercent: -8,
      direction: "down",
      movementValue: -8_000,
      baselineValue: 100_000,
      currentValue: 92_000,
      externalFlow: 0,
      latePriceAdjustment: 0,
      latePrices: [],
      baselineDate: FRIDAY,
      valuationDate: TODAY,
      currencyCode: "USD",
    });
    expect(written.message).toContain(FRIDAY);
    expect(written.message).toContain(TODAY);
    expect(baselineWrites).toEqual([
      { value: 92_000, currency: "USD", on: TODAY },
    ]);
  });

  it("does not fire on a deposit-only day, and still re-baselines", async () => {
    // The requester's actual requirement (INV-PORTMOVE-006): a 20,000 deposit
    // raised the total by 20,000 and the market did nothing.
    const { service, notify, baselineWrites } = setup({
      summary: summaryOf({ totalPortfolioValue: 120_000 }),
      flows: [{ date: TODAY, currency: "USD", total: "20000" }],
    });

    await service.run();

    expect(notify).not.toHaveBeenCalled();
    expect(baselineWrites).toEqual([
      { value: 120_000, currency: "USD", on: TODAY },
    ]);
  });

  it("captures a first baseline, with its closes, without asking for a flow", async () => {
    const { service, notify, baselineWrites, snapshotWrites, flowStatements } =
      setup({
        state: stateOf({
          baseline_value: null,
          baseline_captured_on: null,
          baseline_positions: null,
        }),
      });

    await service.run();

    expect(notify).not.toHaveBeenCalled();
    expect(flowStatements).toEqual([]);
    expect(baselineWrites).toEqual([
      { value: 100_000, currency: "USD", on: TODAY },
    ]);
    expect(snapshotWrites).toEqual([[positionOf({ priceDate: TODAY })]]);
  });

  it("replaces a baseline stored without a capture date instead of comparing against it", async () => {
    // A value and a currency with no date name no period. Comparing against
    // one used to fire on a flow of a complete zero and a price-freshness
    // check with nothing to be stale against, and stamped the run's own date
    // on the notification as the period's opening.
    const { service, notify, baselineWrites, flowStatements } = setup({
      state: stateOf({ baseline_captured_on: null }),
      summary: summaryOf({ totalPortfolioValue: 130_000 }),
    });

    await service.run();

    expect(notify).not.toHaveBeenCalled();
    expect(flowStatements).toEqual([]);
    expect(baselineWrites).toEqual([
      { value: 130_000, currency: "USD", on: TODAY },
    ]);
  });

  it("still measures the move when only the cost basis is incomplete", async () => {
    // The movement compares the portfolio value, so a missing dated cost rate
    // (summary-wide `valuationComplete: false`) must not withhold it.
    const { service, notify } = setup({
      summary: summaryOf({
        totalPortfolioValue: 80_000,
        totalCostBasis: null,
        costBasisMissingRatePairs: ["CAD->USD"],
        fxComplete: false,
        valuationComplete: false,
      }),
    });

    await service.run();

    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("withholds everything, including the baseline, on an incomplete valuation", async () => {
    const { service, notify, baselineWrites } = setup({
      summary: summaryOf({
        totalPortfolioValue: null,
        knownPortfolioValueSubtotal: 110_000,
        pricesComplete: false,
        valuationComplete: false,
        unpricedSecurityIds: [SECURITY],
      }),
    });

    await service.run();

    expect(notify).not.toHaveBeenCalled();
    expect(baselineWrites).toEqual([]);
  });
});
