jest.mock("../accruals/reporting-basis", () =>
  jest
    .requireActual("../test-helpers/reporting-read-testing")
    .reportingBasisMockModule(),
);
import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";

import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { UserPreference } from "../users/entities/user-preference.entity";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import { NetWorthService } from "./net-worth.service";
import { PortfolioPeriodResultService } from "./portfolio-period-result.service";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

jest.mock("../common/date-utils", () => ({
  ...jest.requireActual("../common/date-utils"),
  todayYMD: jest.fn(() => "2026-09-17"),
}));

interface FakeRow {
  [key: string]: unknown;
}

/**
 * The fixture is the issue's reproduction (#1392): a security at 100 that never
 * moves, a 10,000 deposit and a 100-unit buy on 2026-01-02, the same again on
 * 2026-06-01. The value series therefore runs 10,000 -> 20,000 with nothing
 * having been earned.
 */
describe("PortfolioPeriodResultService", () => {
  let service: PortfolioPeriodResultService;
  let netWorth: {
    getDailyInvestments: jest.Mock;
    getLastPricedDays: jest.Mock;
    loadValuationSeries: jest.Mock;
  };
  /**
   * The accepted closes the share-moving legs are valued from, keyed by
   * security. Empty unless a case puts a transfer in the window: the service
   * asks for no prices where no leg needs one.
   */
  let storedCloses: Map<string, Array<{ date: string; close: number }>>;
  /**
   * The trading session behind each boundary the service asks about. The
   * fixture series runs over calendar days, so a session is its own day unless
   * a test says otherwise -- which is what a weekend boundary does.
   */
  let pricedSessions: Map<string, string | null>;
  let exchangeRates: { ensureRatesForDate: jest.Mock };
  let mocks: ReturnType<typeof createScopedDbMocks>;
  let scopeRows: FakeRow[];
  let flowRows: FakeRow[];
  let investedRows: FakeRow[];
  let rateRows: FakeRow[];
  let settledTradeRows: FakeRow[];
  let shareTransferRows: FakeRow[];
  let mixedSplitRows: FakeRow[];
  let firstTxRows: FakeRow[];
  let queries: Array<{ sql: string; params: unknown[] }>;

  beforeEach(async () => {
    queries = [];
    // The brokerage holds the positions; only the cash sleeve's ledger cash is
    // valued, which is what the flow boundary is drawn around.
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
    flowRows = [];
    investedRows = [];
    rateRows = [];
    settledTradeRows = [{ count: "0" }];
    shareTransferRows = [{ count: "0" }];
    mixedSplitRows = [{ count: "0" }];
    firstTxRows = [{ date: "2026-01-02" }];

    const preferenceRepo = {
      findOne: jest.fn(async () => ({ defaultCurrency: "CAD" })),
    };
    mocks = createScopedDbMocks([[UserPreference, preferenceRepo]]);
    mocks.manager.query.mockImplementation(
      async (sql: string, params: unknown[]) => {
        queries.push({ sql, params });
        // Three statements name `investment_transactions` (the flow query and
        // the mixed-split count do so inside their exclusions), so each is
        // matched on a fragment only it carries.
        if (sql.includes("MIN(it.transaction_date)")) return firstTxRows;
        if (sql.includes("it.action AS action")) return investedRows;
        if (sql.includes("SUM(t.amount)")) return flowRows;
        if (sql.includes("it.funding_account_id")) return settledTradeRows;
        if (sql.includes("it.linked_transaction_id")) return shareTransferRows;
        if (sql.includes("COUNT(*) AS count")) return mixedSplitRows;
        if (sql.includes("FROM exchange_rates")) return rateRows;
        if (sql.includes("FROM accounts")) return scopeRows;
        throw new Error(`unexpected query: ${sql}`);
      },
    );

    pricedSessions = new Map();
    storedCloses = new Map();
    netWorth = {
      getDailyInvestments: jest.fn().mockResolvedValue([]),
      loadValuationSeries: jest.fn(async () => ({
        stored: storedCloses,
        txFallback: new Map(),
      })),
      getLastPricedDays: jest.fn(
        async (_userId: string, boundaries: readonly string[]) =>
          new Map(
            boundaries.map((day) => [
              day,
              pricedSessions.has(day) ? pricedSessions.get(day) : day,
            ]),
          ),
      ),
    };
    exchangeRates = { ensureRatesForDate: jest.fn().mockResolvedValue(0) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PortfolioPeriodResultService,
        { provide: DataSource, useValue: mocks.dataSource },
        { provide: NetWorthService, useValue: netWorth },
        { provide: ExchangeRateService, useValue: exchangeRates },
      ],
    }).compile();

    service = module.get(PortfolioPeriodResultService);
  });

  afterEach(() => jest.restoreAllMocks());

  const point = (
    date: string,
    value: number,
    flags: {
      fxComplete?: boolean;
      pricesComplete?: boolean;
      cashComplete?: boolean;
      unpricedSecurityIds?: string[];
      unknownCashAccountIds?: string[];
      securitiesValue?: number;
    } = {},
  ) => ({
    date,
    value,
    // Cash-free unless a case says otherwise: the invested part IS the value.
    securitiesValue: flags.securitiesValue ?? value,
    fxComplete: flags.fxComplete ?? true,
    missingRatePairs: [],
    pricesComplete: flags.pricesComplete ?? true,
    unpricedSecurityIds: flags.unpricedSecurityIds ?? [],
    cashComplete: flags.cashComplete ?? true,
    unknownCashAccountIds: flags.unknownCashAccountIds ?? [],
  });

  const flatSeries = () => [
    point("2026-01-02", 10_000),
    point("2026-06-01", 20_000),
    point("2026-09-17", 20_000),
  ];

  const run = (overrides: Record<string, unknown> = {}) =>
    service.getPeriodResult("user-1", {
      startDate: "2026-01-02",
      endDate: "2026-09-17",
      ...overrides,
    });

  it("reports the deposit as a flow, so the result is zero", async () => {
    netWorth.getDailyInvestments.mockResolvedValue(flatSeries());
    flowRows = [{ date: "2026-06-01", currency: "CAD", total: "10000" }];

    const result = await run();

    expect(result).toMatchObject({
      currency: "CAD",
      startDate: "2026-01-02",
      endDate: "2026-09-17",
      valueChange: 10_000,
      netExternalFlows: 10_000,
      investmentResult: 0,
      returnPercent: 0,
      returnMethod: "simple",
      complete: true,
      reasons: [],
    });
  });

  /**
   * The whole defect, in one assertion: the figure the report used to print.
   * A `last - first` change over the same series says +10,000, which is the
   * deposit, and +100%, which is nothing that happened.
   */
  it("does not report the value change as the return", async () => {
    netWorth.getDailyInvestments.mockResolvedValue(flatSeries());
    flowRows = [{ date: "2026-06-01", currency: "CAD", total: "10000" }];

    const result = await run();

    expect(result.valueChange).toBe(10_000);
    expect(result.investmentResult).not.toBe(result.valueChange);
    expect(result.returnPercent).not.toBe(100);
  });

  /**
   * The second reading of the same caption (spec section 10). "Portfolio
   * performance" must answer what the INVESTMENTS did, so cash the reader pays
   * in cannot move it -- not the amount, and not the percentage.
   *
   * The series is the same three closes, but with the invested part named: the
   * portfolio holds 8,000 of securities that gain 10% to 8,800, and on
   * 2026-09-16 a 50,000 deposit lands and is left as cash. The ACCOUNT-level
   * value change moves by that 50,000; the invested figures do not move at all.
   */
  it("keeps a late cash deposit out of the invested figures", async () => {
    const invested = [
      point("2026-01-02", 10_000, { securitiesValue: 8_000 }),
      point("2026-06-01", 10_800, { securitiesValue: 8_800 }),
      point("2026-09-17", 60_800, { securitiesValue: 8_800 }),
    ];
    netWorth.getDailyInvestments.mockResolvedValue(invested);
    flowRows = [{ date: "2026-09-16", currency: "CAD", total: "50000" }];

    const result = await run();

    // The account-level measure sees the deposit and subtracts it.
    expect(result.valueChange).toBe(50_800);
    expect(result.netExternalFlows).toBe(50_000);

    // The invested measure never saw it: 8,800 - 8,000 with no capital flow.
    expect(result.investmentPnl).toBe(800);
    // And its value change is the securities line the chart draws, last point
    // less first -- not the 50,800 the account moved by.
    expect(result.investedValueChange).toBe(800);
    expect(result.investedValueChange).toBe(
      result.investedValueEnd! - result.investedValueStart!,
    );
    // +10% on the securities, not +8% on securities-plus-cash, and not a
    // fraction of a base the 50,000 joined.
    expect(result.investmentReturnPercent).toBe(10);
    expect(result.investmentReturnMethod).toBe("twr");
    expect(result.investedComplete).toBe(true);
  });

  it("reports the same invested figures without the late deposit", async () => {
    // The control for the case above: removing the deposit changes the
    // account-level figures and leaves the invested ones identical.
    netWorth.getDailyInvestments.mockResolvedValue([
      point("2026-01-02", 10_000, { securitiesValue: 8_000 }),
      point("2026-06-01", 10_800, { securitiesValue: 8_800 }),
      point("2026-09-17", 10_800, { securitiesValue: 8_800 }),
    ]);

    const result = await run();

    expect(result.valueChange).toBe(800);
    expect(result.investmentPnl).toBe(800);
    expect(result.investmentReturnPercent).toBe(10);
  });

  it("counts a buy as capital and a dividend as income", async () => {
    netWorth.getDailyInvestments.mockResolvedValue([
      point("2026-01-02", 10_000, { securitiesValue: 0 }),
      point("2026-06-01", 10_000, { securitiesValue: 8_000 }),
      point("2026-09-17", 10_100, { securitiesValue: 8_000 }),
    ]);
    investedRows = [
      {
        date: "2026-06-01",
        currency: "CAD",
        action: "BUY",
        total: "8000",
        gross: "8000",
      },
      {
        date: "2026-09-17",
        currency: "CAD",
        action: "DIVIDEND",
        total: "100",
        gross: "100",
      },
    ];

    const result = await run();

    expect(result.investmentCapitalFlows).toBe(8_000);
    expect(result.investmentIncome).toBe(100);
    // The purchase is not a gain; the distribution is, although it ends as cash.
    expect(result.investmentPnl).toBe(100);
    expect(result.investmentReturnPercent).toBe(1.25);
  });

  it("counts no flow dated on the baseline day", async () => {
    netWorth.getDailyInvestments.mockResolvedValue(flatSeries());

    await run();

    const flowQuery = queries.find((q) => q.sql.includes("SUM(t.amount)"))!;
    // $2 is the exclusive lower bound: the baseline's own close already holds
    // the deposit that landed on it.
    expect(flowQuery.params[1]).toBe("2026-01-02");
    expect(flowQuery.params[2]).toBe("2026-09-17");
  });

  it("measures from an explicit baseline and counts the flows after it", async () => {
    netWorth.getDailyInvestments.mockResolvedValue([
      point("2026-09-16", 19_000),
      point("2026-09-17", 20_000),
    ]);

    const result = await run({
      startDate: "2026-09-17",
      baselineDate: "2026-09-16",
    });

    expect(netWorth.getDailyInvestments).toHaveBeenCalledWith(
      "user-1",
      "2026-09-16",
      "2026-09-17",
      undefined,
      "CAD",
      { fetchMissing: undefined },
    );
    const flowQuery = queries.find((q) => q.sql.includes("SUM(t.amount)"))!;
    expect(flowQuery.params[1]).toBe("2026-09-16");
    expect(result.startDate).toBe("2026-09-16");
    expect(result.valueChange).toBe(1_000);
    expect(result.investmentResult).toBe(1_000);
  });

  it("converts a foreign flow at the rate of its own day", async () => {
    netWorth.getDailyInvestments.mockResolvedValue(flatSeries());
    flowRows = [{ date: "2026-06-01", currency: "USD", total: "5000" }];
    rateRows = [
      {
        from_currency: "USD",
        to_currency: "CAD",
        rate: "1.2",
        rate_date: "2026-06-01",
      },
      // A later observation must not price an earlier day (no look-ahead).
      {
        from_currency: "USD",
        to_currency: "CAD",
        rate: "2",
        rate_date: "2026-09-01",
      },
    ];

    const result = await run();

    expect(result.netExternalFlows).toBe(6_000);
    expect(result.investmentResult).toBe(4_000);
  });

  it("withholds the flow and the result when a flow day has no rate", async () => {
    netWorth.getDailyInvestments.mockResolvedValue(flatSeries());
    flowRows = [
      { date: "2026-06-01", currency: "CAD", total: "4000" },
      { date: "2026-06-01", currency: "EUR", total: "5000" },
    ];

    const result = await run();

    expect(result.netExternalFlows).toBeNull();
    expect(result.investmentResult).toBeNull();
    expect(result.returnPercent).toBeNull();
    expect(result.knownFlowSubtotal).toBe(4_000);
    expect(result.missingRatePairs).toEqual(["EUR->CAD"]);
    expect(result.reasons).toEqual(["missingRatePairs"]);
  });

  it("withholds the value change when a boundary day is a subtotal", async () => {
    netWorth.getDailyInvestments.mockResolvedValue([
      point("2026-01-02", 10_000, {
        pricesComplete: false,
        unpricedSecurityIds: ["sec-1"],
      }),
      point("2026-09-17", 20_000),
    ]);
    flowRows = [{ date: "2026-06-01", currency: "CAD", total: "10000" }];

    const result = await run();

    expect(result.valueChange).toBeNull();
    expect(result.investmentResult).toBeNull();
    expect(result.reasons).toEqual(["incompletePrices"]);
    expect(result.unpricedSecurityIds).toEqual(["sec-1"]);
    expect(result.netExternalFlows).toBe(10_000);
  });

  /**
   * The union sets say WHAT is missing; the ranges say when, which is the
   * difference between "no price" and "AGGG, Jun 3 to Jun 5" (#1392). The fold
   * runs over the whole window, not the two boundaries, because a gap in the
   * middle is what breaks the time-weighted chain.
   */
  describe("incompleteRanges", () => {
    const unpricedOn = (dates: string[]) =>
      [
        "2026-06-01",
        "2026-06-02",
        "2026-06-03",
        "2026-06-04",
        "2026-06-05",
        "2026-06-06",
        "2026-06-07",
        "2026-06-08",
        "2026-06-09",
      ].map((date) =>
        dates.includes(date)
          ? point(date, 10_000, {
              pricesComplete: false,
              unpricedSecurityIds: ["sec-1"],
            })
          : point(date, 10_000),
      );

    it("reports nothing for a window with no gap", async () => {
      netWorth.getDailyInvestments.mockResolvedValue(flatSeries());

      const result = await run();

      expect(result.incompleteRanges).toEqual({
        prices: [],
        rates: [],
        cash: [],
        truncated: { prices: false, rates: false, cash: false },
      });
    });

    it("folds a security unpriced on days 3-5 and 9 into two runs", async () => {
      netWorth.getDailyInvestments.mockResolvedValue(
        unpricedOn(["2026-06-03", "2026-06-04", "2026-06-05", "2026-06-09"]),
      );

      const result = await run({ startDate: "2026-06-01" });

      expect(result.incompleteRanges.prices).toEqual([
        { key: "sec-1", start: "2026-06-03", end: "2026-06-05" },
        { key: "sec-1", start: "2026-06-09", end: "2026-06-09" },
      ]);
      expect(result.incompleteRanges.truncated.prices).toBe(false);
    });

    it("dates a missing rate and a cash account with no balance", async () => {
      netWorth.getDailyInvestments.mockResolvedValue([
        point("2026-06-01", 10_000),
        {
          ...point("2026-06-02", 10_000, {
            fxComplete: false,
            cashComplete: false,
            unknownCashAccountIds: ["cash-1"],
          }),
          missingRatePairs: ["USD->CAD"],
        },
        {
          ...point("2026-06-03", 10_000, { fxComplete: false }),
          missingRatePairs: ["USD->CAD"],
        },
      ]);

      const result = await run({ startDate: "2026-06-01" });

      expect(result.incompleteRanges.rates).toEqual([
        { key: "USD->CAD", start: "2026-06-02", end: "2026-06-03" },
      ]);
      expect(result.incompleteRanges.cash).toEqual([
        { key: "cash-1", start: "2026-06-02", end: "2026-06-02" },
      ]);
    });

    it("keeps the newest runs, and says so, past the per-cause bound", async () => {
      // Every other day unpriced over 220 days is 110 runs; the response
      // carries the newest 50 rather than all of them.
      const series = Array.from({ length: 220 }, (_, i) => {
        const date = new Date(Date.UTC(2026, 0, 1 + i))
          .toISOString()
          .slice(0, 10);
        return i % 2 === 0
          ? point(date, 10_000, {
              pricesComplete: false,
              unpricedSecurityIds: ["sec-1"],
            })
          : point(date, 10_000);
      });
      netWorth.getDailyInvestments.mockResolvedValue(series);

      const result = await run({ startDate: "2026-01-01" });

      expect(result.incompleteRanges.prices).toHaveLength(50);
      expect(result.incompleteRanges.truncated.prices).toBe(true);
      // The tail, so the runs a reader can still act on are the ones kept.
      const newest = result.incompleteRanges.prices[49];
      expect(newest).toEqual({
        key: "sec-1",
        start: series[218].date,
        end: series[218].date,
      });
    });
  });

  /**
   * The audit's case (#1389, F1): a 10,000 BUY settled from a chequing account.
   * The purchase raises the market value by 10,000 and leaves no cash leg in
   * the scope, so the flow query sees nothing and a subtraction of the two
   * reports the reader's own money as a hundred per cent gain -- the #1392
   * defect reached by a second route.
   */
  it("withholds the result when a trade settled outside the valued cash", async () => {
    netWorth.getDailyInvestments.mockResolvedValue(flatSeries());
    settledTradeRows = [{ count: "1" }];

    const result = await run();

    expect(result.investmentResult).toBeNull();
    expect(result.returnPercent).toBeNull();
    expect(result.reasons).toEqual(["externallySettledTrade"]);
    // The two measured figures still stand; only their difference is unknown.
    expect(result.valueChange).toBe(10_000);
    expect(result.netExternalFlows).toBe(0);
  });

  /**
   * #1516: the invested measure is drawn around the securities, not the cash,
   * so where a trade's cash settled does not move it. A QIF import's trades
   * point their cash leg at the brokerage row and tripped the count on every
   * trade, which withheld every invested figure on every surface.
   */
  it("still reports the invested figures when a trade settled outside the valued cash", async () => {
    netWorth.getDailyInvestments.mockResolvedValue(flatSeries());
    settledTradeRows = [{ count: "1" }];

    const result = await run();

    expect(result.investedReasons).toEqual([]);
    expect(result.investmentPnl).not.toBeNull();
    expect(result.investmentReturnPercent).not.toBeNull();
  });

  it("asks about trades on the whole scope, settled against the valued cash", async () => {
    netWorth.getDailyInvestments.mockResolvedValue(flatSeries());

    await run();

    const settled = queries.find((q) =>
      q.sql.includes("it.funding_account_id"),
    )!;
    expect(settled.params[1]).toBe("2026-01-02");
    expect(settled.params[2]).toBe("2026-09-17");
    expect(settled.params[3]).toEqual(["brok-1", "cash-1"]);
    expect(settled.params[4]).toEqual(["cash-1"]);
  });

  /**
   * The flow sum drops a mixed split parent WHOLE (`external-flow.util.ts`), so
   * its ordinary cash line is in the value change with nothing to subtract it.
   */
  it("withholds the result when a split parent mixes investment and cash lines", async () => {
    netWorth.getDailyInvestments.mockResolvedValue(flatSeries());
    mixedSplitRows = [{ count: "2" }];

    const result = await run();

    expect(result.investmentResult).toBeNull();
    expect(result.reasons).toEqual(["mixedSplit"]);
    expect(result.valueChange).toBe(10_000);
  });

  it("still reports the invested figures when a split parent mixes investment and cash lines", async () => {
    netWorth.getDailyInvestments.mockResolvedValue(flatSeries());
    mixedSplitRows = [{ count: "2" }];

    const result = await run();

    expect(result.investedReasons).toEqual([]);
    expect(result.investmentPnl).not.toBeNull();
  });

  it("reports nothing for a scope with no accounts", async () => {
    scopeRows = [];

    const result = await run();

    expect(result.reasons).toEqual(["noValueSeries"]);
    expect(result.valueChange).toBeNull();
    expect(netWorth.getDailyInvestments).not.toHaveBeenCalled();
  });

  it("reports nothing when the scope produced no valued day", async () => {
    netWorth.getDailyInvestments.mockResolvedValue([]);

    const result = await run();

    expect(result.reasons).toEqual(["noValueSeries"]);
    expect(result.startDate).toBe("2026-01-02");
  });

  it("draws the flow boundary around the accounts whose cash is valued", async () => {
    netWorth.getDailyInvestments.mockResolvedValue(flatSeries());

    await run({ accountIds: ["brok-1"] });

    const flowQuery = queries.find((q) => q.sql.includes("SUM(t.amount)"))!;
    // The brokerage row's own ledger cash is NOT in the series, so a row posted
    // to it is not a flow of this period either: one boundary, or a deposit
    // there is subtracted from a value change that never held it.
    expect(flowQuery.params[3]).toEqual(["cash-1"]);
    // ...but a trade on the brokerage whose cash leg transfers into that sleeve
    // settled inside it (the QIF/CSV import's shape), so the whole scope is the
    // investment scope that leaves such a sleeve leg out of the flow.
    expect(flowQuery.params[4]).toEqual(["brok-1", "cash-1"]);
    // The series is asked with the ids the caller gave: getDailyInvestments
    // does the same widening itself, and doing it twice is a no-op.
    expect(netWorth.getDailyInvestments).toHaveBeenCalledWith(
      "user-1",
      "2026-01-02",
      "2026-09-17",
      ["brok-1"],
      "CAD",
      { fetchMissing: undefined },
    );
  });

  it("honours an explicit display currency over the preference", async () => {
    netWorth.getDailyInvestments.mockResolvedValue(flatSeries());

    const result = await run({ displayCurrency: "USD" });

    expect(result.currency).toBe("USD");
    expect(netWorth.getDailyInvestments).toHaveBeenCalledWith(
      "user-1",
      "2026-01-02",
      "2026-09-17",
      undefined,
      "USD",
      { fetchMissing: undefined },
    );
  });

  describe("read-path FX fill", () => {
    // A EUR deposit into a CAD-reported portfolio, over a window the
    // exchange_rates table has no row for: the flow is the component that
    // cannot convert, so it is the flow fold that asks the provider (#1390).
    const eurFlow = () => {
      netWorth.getDailyInvestments.mockResolvedValue(flatSeries());
      flowRows = [{ date: "2026-06-01", currency: "EUR", total: "10000" }];
    };

    it("asks the provider for the month the flow could not convert", async () => {
      eurFlow();

      const result = await run();

      expect(exchangeRates.ensureRatesForDate).toHaveBeenCalledTimes(1);
      expect(exchangeRates.ensureRatesForDate).toHaveBeenCalledWith(
        [{ from: "EUR", to: "CAD" }],
        "2026-06-01",
      );
      // Nothing was stored, so the pair stays missing and the figure withheld.
      expect(result.netExternalFlows).toBeNull();
      expect(result.missingRatePairs).toContain("EUR->CAD");
    });

    it("re-reads the rates and completes the flow when the fill stored rows", async () => {
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

      const result = await run();

      expect(result.netExternalFlows).toBe(15_000);
      expect(result.missingRatePairs).toEqual([]);
    });

    it("makes no provider call, on either half, when the caller opted out", async () => {
      eurFlow();

      const result = await run({ fetchMissing: false });

      expect(exchangeRates.ensureRatesForDate).not.toHaveBeenCalled();
      expect(netWorth.getDailyInvestments).toHaveBeenCalledWith(
        "user-1",
        "2026-01-02",
        "2026-09-17",
        undefined,
        "CAD",
        { fetchMissing: false },
      );
      expect(result.netExternalFlows).toBeNull();
    });

    it("answers the period when the provider throws", async () => {
      eurFlow();
      exchangeRates.ensureRatesForDate.mockRejectedValue(
        new Error("provider unreachable"),
      );

      const result = await run();

      expect(result.netExternalFlows).toBeNull();
      expect(result.missingRatePairs).toContain("EUR->CAD");
    });
  });

  /**
   * The portfolio summary's "TWR (time-weighted)" is this window of this
   * measure. It used to be a second implementation of the same caption, which
   * valued each boundary from `security_prices` alone and dropped an unpriced
   * position out of the value instead of withholding the figure (#1392). The
   * cases below hold the two properties that implementation's own tests stated,
   * plus the equivalence that makes this method a window rather than a
   * calculation of its own.
   */
  describe("getInvestedResultSinceInception", () => {
    const buyRow = {
      date: "2026-01-02",
      currency: "CAD",
      action: "BUY",
      security_id: "sec-1",
      total: "8000",
      quantity: "80",
    };

    /** 8,000 bought on the first day, worth 8,800 today; the baseline is empty. */
    const sinceSeries = () => [
      point("2026-01-01", 0),
      point("2026-01-02", 8_000),
      point("2026-09-17", 8_800),
    ];

    it("equals the single route asked for the first transaction and the day before", async () => {
      netWorth.getDailyInvestments.mockResolvedValue(sinceSeries());
      investedRows = [buyRow];

      const since = await service.getInvestedResultSinceInception("user-1");
      const direct = await service.getPeriodResult("user-1", {
        startDate: "2026-01-02",
        baselineDate: "2026-01-01",
        endDate: "2026-09-17",
      });

      expect(since).toEqual(direct);
      expect(since.investmentPnl).toBe(800);
      expect(since.investmentReturnPercent).toBe(10);
      expect(since.investedReasons).toEqual([]);
    });

    it("asks for the series from the day before the first transaction", async () => {
      netWorth.getDailyInvestments.mockResolvedValue(sinceSeries());

      await service.getInvestedResultSinceInception("user-1");

      expect(netWorth.getDailyInvestments).toHaveBeenCalledWith(
        "user-1",
        "2026-01-01",
        "2026-09-17",
        undefined,
        "CAD",
        { fetchMissing: undefined },
      );
    });

    it("returns the empty decision when the scope has no investment transaction", async () => {
      firstTxRows = [{ date: null }];

      const result = await service.getInvestedResultSinceInception("user-1");

      expect(result.investedReasons).toEqual(["noValueSeries"]);
      expect(result.investmentReturnPercent).toBeNull();
      expect(netWorth.getDailyInvestments).not.toHaveBeenCalled();
    });

    it("returns the empty decision for a scope with no accounts", async () => {
      scopeRows = [];

      const result = await service.getInvestedResultSinceInception("user-1");

      expect(result.investedReasons).toEqual(["noValueSeries"]);
      expect(result.investmentReturnPercent).toBeNull();
    });

    it("reports the price return through a split, not a share-count jump", async () => {
      // A 2-for-1 on 2026-06-01: twice the shares at half the price is the same
      // value, and a SPLIT is neither capital nor income, so the day is a
      // factor of 1 and the window is still the security's own 10%.
      netWorth.getDailyInvestments.mockResolvedValue([
        point("2026-01-01", 0),
        point("2026-01-02", 8_000),
        point("2026-06-01", 8_000),
        point("2026-09-17", 8_800),
      ]);
      investedRows = [
        buyRow,
        {
          date: "2026-06-01",
          currency: "CAD",
          action: "SPLIT",
          total: "0",
          gross: "8000",
        },
      ];

      const result = await service.getInvestedResultSinceInception("user-1");

      expect(result.investmentCapitalFlows).toBe(8_000);
      expect(result.investmentReturnPercent).toBe(10);
    });

    it("withholds the return when a day the chain spans could not convert a position", async () => {
      netWorth.getDailyInvestments.mockResolvedValue([
        point("2026-01-01", 0),
        point("2026-01-02", 8_000),
        point("2026-09-17", 8_800, { fxComplete: false }),
      ]);
      investedRows = [buyRow];

      const result = await service.getInvestedResultSinceInception("user-1");

      expect(result.investmentReturnPercent).toBeNull();
      expect(result.investmentPnl).toBeNull();
      expect(result.investedReasons).toContain("missingRatePairs");
    });

    it("withholds the return when a held position has no close on a day the chain spans", async () => {
      // The defect this replaced: the old summary TWR left an unpriced
      // position OUT of the period value, so the position entered the chain as
      // a gain on the first boundary that priced it.
      netWorth.getDailyInvestments.mockResolvedValue([
        point("2026-01-01", 0),
        point("2026-01-02", 8_000, {
          pricesComplete: false,
          unpricedSecurityIds: ["sec-2"],
        }),
        point("2026-09-17", 20_000),
      ]);
      investedRows = [buyRow];

      const result = await service.getInvestedResultSinceInception("user-1");

      expect(result.investmentReturnPercent).toBeNull();
      expect(result.investedReasons).toContain("incompletePrices");
    });

    it("counts a dividend as return and a cash deposit as neither", async () => {
      netWorth.getDailyInvestments.mockResolvedValue([
        point("2026-01-01", 0),
        point("2026-01-02", 8_000),
        point("2026-09-17", 8_000),
      ]);
      investedRows = [
        buyRow,
        {
          date: "2026-09-17",
          currency: "CAD",
          action: "DIVIDEND",
          total: "100",
          gross: "0",
        },
      ];
      flowRows = [{ date: "2026-09-17", currency: "CAD", total: "50000" }];

      const result = await service.getInvestedResultSinceInception("user-1");

      expect(result.netExternalFlows).toBe(50_000);
      expect(result.investmentIncome).toBe(100);
      expect(result.investmentCapitalFlows).toBe(8_000);
      expect(result.investmentPnl).toBe(100);
      expect(result.investmentReturnPercent).toBe(1.25);
    });
  });
  /**
   * A caller that NAMES its window instead of dating it.
   *
   * The window a portfolio chart draws is deliberately not the period its
   * button names: `resolveRangePreset` widens 1D to a week so a daily fallback
   * has more than one point, `portfolio-range-window.ts` opens 3M a day early
   * so the first plotted close precedes the quarter, and `all` resolves to no
   * start date at all. Sending the drawn window measured those days, so the
   * chart's card and the performance card beside it -- which resolves its
   * windows from `portfolio-period-presets.util.ts` -- reported different
   * figures under the same caption. A preset is resolved HERE, from that same
   * file, so there is one window per name.
   */
  describe("a named window", () => {
    it("measures 1D over the day, not over whatever dates the caller holds", async () => {
      netWorth.getDailyInvestments.mockResolvedValue([
        point("2026-09-16", 20_000),
        point("2026-09-17", 20_400),
      ]);

      await service.getPeriodResult("user-1", { period: "1d" });

      // Today, measured from the close before it -- not the week
      // `resolveRangePreset('1d')` hands a chart to draw.
      expect(netWorth.getDailyInvestments).toHaveBeenCalledWith(
        "user-1",
        "2026-09-16",
        "2026-09-17",
        undefined,
        "CAD",
        { fetchMissing: undefined },
      );
    });

    it("opens each preset where the presets file says, not a day early", async () => {
      netWorth.getDailyInvestments.mockResolvedValue(flatSeries());

      for (const [preset, start] of [
        ["3m", "2026-06-19"],
        ["1y", "2025-09-17"],
        ["5y", "2021-09-17"],
      ] as const) {
        netWorth.getDailyInvestments.mockClear();
        await service.getPeriodResult("user-1", { period: preset });
        expect(netWorth.getDailyInvestments).toHaveBeenCalledWith(
          "user-1",
          start,
          "2026-09-17",
          undefined,
          "CAD",
          { fetchMissing: undefined },
        );
      }
    });

    it("opens the all-time window on the close before the scope's first holding", async () => {
      // The range with no arithmetic: the client cannot date it, so it sent
      // nothing and both figures read n/a for every account.
      netWorth.getDailyInvestments.mockResolvedValue([
        point("2026-01-01", 0),
        point("2026-09-17", 20_000),
      ]);

      const result = await service.getPeriodResult("user-1", { period: "all" });

      expect(netWorth.getDailyInvestments).toHaveBeenCalledWith(
        "user-1",
        "2026-01-01",
        "2026-09-17",
        undefined,
        "CAD",
        { fetchMissing: undefined },
      );
      expect(result.startDate).toBe("2026-01-01");
      expect(result.investmentPnl).not.toBeNull();
    });

    it("answers the all-time preset exactly as the since-inception figure", async () => {
      // Two spellings of one window would be two answers to one question.
      netWorth.getDailyInvestments.mockResolvedValue([
        point("2026-01-01", 0),
        point("2026-09-17", 20_000),
      ]);

      expect(
        await service.getPeriodResult("user-1", { period: "all" }),
      ).toEqual(await service.getInvestedResultSinceInception("user-1"));
    });

    it("has no window to measure for a scope that never held anything", async () => {
      firstTxRows = [{ date: null }];

      const result = await service.getPeriodResult("user-1", { period: "all" });

      expect(result.investmentPnl).toBeNull();
      expect(result.reasons).toContain("noValueSeries");
      expect(netWorth.getDailyInvestments).not.toHaveBeenCalled();
    });
  });

  /**
   * Which SESSION a window is measured from, as opposed to which calendar day
   * it is dated.
   *
   * `getDailyInvestments` values every calendar day from the latest close at or
   * before it, so a Monday 1D window opens on Sunday and carries Friday's
   * close. A surface printing the boundary told the reader the figure was
   * measured from a day the market was shut.
   */
  describe("the session behind the boundary", () => {
    it("names the trading day the opening value came from", async () => {
      // Monday 2026-09-21 measured from Sunday the 20th, priced on Friday.
      pricedSessions.set("2026-09-20", "2026-09-18");
      netWorth.getDailyInvestments.mockResolvedValue([
        point("2026-09-20", 20_000),
        point("2026-09-21", 20_400),
      ]);

      const result = await service.getPeriodResult("user-1", {
        startDate: "2026-09-21",
        baselineDate: "2026-09-20",
        endDate: "2026-09-21",
      });

      expect(result.startDate).toBe("2026-09-20");
      expect(result.startPriceDate).toBe("2026-09-18");
      expect(netWorth.getLastPricedDays).toHaveBeenCalledWith(
        "user-1",
        ["2026-09-20"],
        ["brok-1", "cash-1"],
      );
    });

    it("leaves the session unknown rather than substituting the calendar day", async () => {
      pricedSessions.set("2026-01-02", null);
      netWorth.getDailyInvestments.mockResolvedValue(flatSeries());

      const result = await run();

      expect(result.startDate).toBe("2026-01-02");
      expect(result.startPriceDate).toBeNull();
    });
  });
  /**
   * A share-moving leg is valued at the day's accepted CLOSE, not at the basis
   * the row carries.
   *
   * `IV` moves by the position's market value, so a leg valued at anything
   * else leaves the difference in the P&L as a gain nobody made. Valuing it at
   * the same close `positionCloseAsOf` gave the valuation makes the two cancel
   * exactly, which is what lets the invested figures report over a window a
   * transfer falls in -- a portfolio built by transferring holdings in reported
   * "n/a" for every window that reached them (`docs/specs/portfolio-period-result.md`
   * section 10.6).
   */
  describe("a share transfer from outside the portfolio", () => {
    /** A transfer leg recorded at a historical cost, far from the day's close. */
    const transferRow = {
      date: "2026-06-01",
      currency: "CAD",
      action: "TRANSFER_IN",
      security_id: "sec-1",
      total: "0",
      quantity: "100",
    };

    beforeEach(() => {
      shareTransferRows = [{ count: "1" }];
      investedRows = [transferRow];
      // 100 shares arrive at 100 on the day: IV rises by 10,000 and nothing
      // was earned.
      netWorth.getDailyInvestments.mockResolvedValue([
        point("2026-01-02", 10_000),
        point("2026-06-01", 20_000),
        point("2026-09-17", 20_000),
      ]);
      storedCloses = new Map([["sec-1", [{ date: "2026-06-01", close: 100 }]]]);
    });

    it("reports the invested result, with the transfer counted as capital", async () => {
      const result = await run();

      // 20,000 - 10,000 - 10,000 of arriving shares = nothing earned.
      expect(result.investmentPnl).toBe(0);
      expect(result.investmentCapitalFlows).toBe(10_000);
      expect(result.investedReasons).not.toContain("externallySettledTrade");
    });

    it("asks for the close of the security whose leg it is, over the window", async () => {
      await run();

      expect(netWorth.loadValuationSeries).toHaveBeenCalledWith(
        ["sec-1"],
        "2026-01-02",
        "2026-09-17",
      );
    });

    it("still withholds the ACCOUNT's result, which has no flow to net it", async () => {
      // The shares are value that entered `MV` with no cash crossing the
      // boundary: that subtraction is not the market's, and never was.
      const result = await run();

      expect(result.investmentResult).toBeNull();
      expect(result.reasons).toContain("externallySettledTrade");
    });

    it("withholds the invested figures, naming the price to add, when nothing priced the leg", async () => {
      storedCloses = new Map();

      const result = await run();

      expect(result.investmentPnl).toBeNull();
      // A price for a named security on a named day, not a movement nobody
      // can act on.
      expect(result.investedReasons).toContain("incompletePrices");
      expect(result.investedReasons).not.toContain("externallySettledTrade");
    });

    it("dates the unvaluable leg, so the reader is sent to one price history", async () => {
      storedCloses = new Map();

      const result = await run();

      expect(result.incompleteRanges.prices).toEqual([
        { key: "sec-1", start: "2026-06-01", end: "2026-06-01" },
      ]);
    });

    it("asks for no close at all when no leg moves shares", async () => {
      investedRows = [];
      shareTransferRows = [{ count: "0" }];

      await run();

      expect(netWorth.loadValuationSeries).toHaveBeenCalledWith(
        [],
        "2026-01-02",
        "2026-09-17",
      );
    });
  });
});
