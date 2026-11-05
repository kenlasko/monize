import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";

import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { NetWorthService } from "../net-worth/net-worth.service";
import { PricePoint } from "../common/time-series/price-boundary.util";
import { UserPreference } from "../users/entities/user-preference.entity";
import { Security } from "./entities/security.entity";
import { DailyMovementService } from "./daily-movement.service";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

// Pin only the clock: replacing the module would delete `addDaysYMD`, which the
// date walk needs.
jest.mock("../common/date-utils", () => ({
  ...jest.requireActual("../common/date-utils"),
  todayYMD: jest.fn(() => "2026-09-14"),
}));

interface FakeRow {
  [key: string]: unknown;
}

/** The fixture behind the design's examples 3 to 6. */
describe("DailyMovementService", () => {
  const TODAY = "2026-09-14";
  let service: DailyMovementService;
  let netWorth: {
    getDailyInvestments: jest.Mock;
    loadValuationSeries: jest.Mock;
  };
  let mocks: ReturnType<typeof createScopedDbMocks>;
  let scopeRows: FakeRow[];
  let replayRows: FakeRow[];
  let flowRows: FakeRow[];
  let rateRows: FakeRow[];
  let securities: Array<Partial<Security>>;
  let programRows: FakeRow[];
  let queries: Array<{ sql: string; params: unknown[] }>;

  beforeEach(async () => {
    queries = [];
    scopeRows = [{ id: "brok-1" }, { id: "cash-1" }];
    replayRows = [];
    flowRows = [];
    rateRows = [];
    securities = [];
    programRows = [
      {
        issuer_country_code: "PL",
        issuer_code: "PL_MF",
        program_code: "EDO",
      },
    ];

    const preferenceRepo = {
      findOne: jest.fn(async () => ({ defaultCurrency: "CAD" })),
    };
    const securityRepo = { findByIds: jest.fn(async () => securities) };
    mocks = createScopedDbMocks([
      [UserPreference, preferenceRepo],
      [Security, securityRepo],
    ]);
    mocks.manager.query.mockImplementation(
      async (sql: string, params: unknown[]) => {
        queries.push({ sql, params });
        // Matched on a fragment unique to each statement. Matching on
        // "FROM investment_transactions" would also catch the external-flow
        // query, whose exclusion subqueries name that table.
        if (sql.includes("SUM(t.amount)")) return flowRows;
        if (sql.includes("SELECT account_id, security_id")) return replayRows;
        if (sql.includes("FROM exchange_rates")) return rateRows;
        if (sql.includes("FROM bond_programs")) return programRows;
        if (sql.includes("FROM accounts")) return scopeRows;
        throw new Error(`unexpected query: ${sql}`);
      },
    );

    netWorth = {
      getDailyInvestments: jest.fn().mockResolvedValue([]),
      loadValuationSeries: jest
        .fn()
        .mockResolvedValue({ stored: new Map(), txFallback: new Map() }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DailyMovementService,
        { provide: DataSource, useValue: mocks.dataSource },
        { provide: NetWorthService, useValue: netWorth },
      ],
    }).compile();

    service = module.get(DailyMovementService);
  });

  afterEach(() => jest.restoreAllMocks());

  const value = (
    date: string,
    amount: number,
    flags: {
      fxComplete?: boolean;
      pricesComplete?: boolean;
      cashComplete?: boolean;
    } = {},
  ) => ({
    date,
    value: amount,
    fxComplete: flags.fxComplete ?? true,
    missingRatePairs: [],
    pricesComplete: flags.pricesComplete ?? true,
    unpricedSecurityIds: [],
    cashComplete: flags.cashComplete ?? true,
    unknownCashAccountIds: [],
  });

  const buy = (
    securityId: string,
    quantity: number,
    date: string,
  ): FakeRow => ({
    account_id: "brok-1",
    security_id: securityId,
    action: "BUY",
    quantity: String(quantity),
    transaction_date: date,
  });

  const series = (
    entries: Record<string, PricePoint[]>,
  ): {
    stored: Map<string, PricePoint[]>;
    txFallback: Map<string, PricePoint[]>;
  } => ({
    stored: new Map(Object.entries(entries)),
    txFallback: new Map(),
  });

  describe("example 3: a deposit and a trade on the same day", () => {
    beforeEach(() => {
      // 100 ABC and 40 XYZ and one DEF, all held since before the window.
      replayRows = [
        buy("abc", 100, "2026-09-01"),
        buy("xyz", 40, "2026-09-01"),
        buy("def", 10, "2026-09-01"),
      ];
      securities = [
        { id: "abc", symbol: "ABC", name: "ABC Corp", currencyCode: "CAD" },
        { id: "xyz", symbol: "XYZ", name: "XYZ Inc", currencyCode: "CAD" },
        { id: "def", symbol: "DEF", name: "DEF Ltd", currencyCode: "CAD" },
      ];
      netWorth.loadValuationSeries.mockResolvedValue(
        series({
          abc: [
            { date: "2026-09-10", close: 50 },
            { date: "2026-09-11", close: 52 },
          ],
          xyz: [
            { date: "2026-09-10", close: 25 },
            { date: "2026-09-11", close: 24.5 },
          ],
          def: [
            { date: "2026-09-10", close: 30 },
            { date: "2026-09-11", close: 30 },
          ],
        }),
      );
      netWorth.getDailyInvestments.mockResolvedValue([
        value("2026-09-10", 100_000),
        value("2026-09-11", 101_200),
      ]);
      // A 1,000 deposit into the cash sleeve that day (external); the 500 of
      // ABC bought is investment-linked and never reaches this query.
      flowRows = [{ date: "2026-09-11", currency: "CAD", total: "1000" }];
    });

    it("reports the movement net of the deposit, to the cent", async () => {
      const res = await service.getDailyMovements(
        "user-1",
        "2026-09-11",
        "2026-09-11",
      );

      expect(res.currencyCode).toBe("CAD");
      expect(res.today).toBe(TODAY);
      // 101,200 - 100,000 - 1,000 = +200.00 -> +0.20%
      expect(res.days[0]).toEqual({
        date: "2026-09-11",
        isTradingDay: true,
        movement: 200,
        movementPercent: 0.2,
        complete: true,
        reasons: [],
      });
    });

    it("breaks the day down so the popup sums to the headline (table D)", async () => {
      const res = await service.getDailyMovementDetail("user-1", "2026-09-11");

      expect(res.movement).toBe(200);
      expect(res.gains).toHaveLength(1);
      expect(res.gains[0]).toMatchObject({
        securityId: "abc",
        symbol: "ABC",
        quantity: 100,
        close: 52,
        previousClose: 50,
        previousCloseDate: "2026-09-10",
        priceChange: 2,
        change: 200,
      });
      expect(res.losses).toHaveLength(1);
      expect(res.losses[0]).toMatchObject({
        securityId: "xyz",
        priceChange: -0.5,
        change: -20,
      });
      // DEF closed unchanged: counted, not listed.
      expect(res.unchangedCount).toBe(1);
      // 200 - (200 - 20) = +20.00, the dividend cash.
      expect(res.remainder).toBe(20);
    });

    it("reports each row's own price move as a percentage of its own close", async () => {
      const res = await service.getDailyMovementDetail("user-1", "2026-09-11");
      expect(res.gains[0].changePercent).toBe(4);
      expect(res.losses[0].changePercent).toBe(-2);
    });
  });

  describe("example 4: a weekend", () => {
    it("is blank even though a deposit landed, because no held security was priced", async () => {
      replayRows = [buy("abc", 100, "2026-09-01")];
      securities = [{ id: "abc", symbol: "ABC", currencyCode: "CAD" }];
      netWorth.loadValuationSeries.mockResolvedValue(
        series({
          abc: [
            { date: "2026-09-11", close: 52 },
            // Nothing on the 12th: the market was shut.
          ],
        }),
      );
      netWorth.getDailyInvestments.mockResolvedValue([
        value("2026-09-11", 101_200),
        value("2026-09-12", 101_700),
      ]);
      flowRows = [{ date: "2026-09-12", currency: "CAD", total: "500" }];

      const res = await service.getDailyMovements(
        "user-1",
        "2026-09-12",
        "2026-09-12",
      );

      expect(res.days[0]).toMatchObject({
        isTradingDay: false,
        movement: null,
        movementPercent: null,
        complete: false,
        reasons: ["notTradingDay"],
      });
    });
  });

  describe("example 5: the first day of holdings", () => {
    it("has no percentage and says why", async () => {
      replayRows = [buy("abc", 100, "2026-09-11")];
      securities = [{ id: "abc", symbol: "ABC", currencyCode: "CAD" }];
      netWorth.loadValuationSeries.mockResolvedValue(
        series({
          abc: [
            { date: "2026-09-10", close: 50 },
            { date: "2026-09-11", close: 52 },
          ],
        }),
      );
      netWorth.getDailyInvestments.mockResolvedValue([
        value("2026-09-10", 0),
        value("2026-09-11", 5200),
      ]);

      const res = await service.getDailyMovements(
        "user-1",
        "2026-09-11",
        "2026-09-11",
      );

      expect(res.days[0].movementPercent).toBeNull();
      expect(res.days[0].complete).toBe(false);
      expect(res.days[0].reasons).toEqual(["zeroBaseline"]);
      // The money that moved is still known, for the day panel.
      expect(res.days[0].movement).toBe(5200);
    });

    it("reports noPriorValue when the series does not reach the day before", async () => {
      replayRows = [buy("abc", 100, "2026-09-11")];
      securities = [{ id: "abc", symbol: "ABC", currencyCode: "CAD" }];
      netWorth.loadValuationSeries.mockResolvedValue(
        series({ abc: [{ date: "2026-09-11", close: 52 }] }),
      );
      netWorth.getDailyInvestments.mockResolvedValue([
        value("2026-09-11", 5200),
      ]);

      const res = await service.getDailyMovements(
        "user-1",
        "2026-09-11",
        "2026-09-11",
      );

      expect(res.days[0].reasons).toEqual(["noPriorValue"]);
    });
  });

  describe("example 6: an unpriced holding", () => {
    it("is unknown on every trading day, naming the cause", async () => {
      replayRows = [buy("abc", 100, "2026-09-01"), buy("gic", 1, "2026-09-01")];
      securities = [
        { id: "abc", symbol: "ABC", currencyCode: "CAD" },
        { id: "gic", symbol: "GIC", currencyCode: "CAD" },
      ];
      netWorth.loadValuationSeries.mockResolvedValue(
        series({
          abc: [
            { date: "2026-09-10", close: 50 },
            { date: "2026-09-11", close: 52 },
          ],
        }),
      );
      netWorth.getDailyInvestments.mockResolvedValue([
        value("2026-09-10", 5000, { pricesComplete: false }),
        value("2026-09-11", 5200, { pricesComplete: false }),
      ]);

      const res = await service.getDailyMovements(
        "user-1",
        "2026-09-11",
        "2026-09-11",
      );

      // ABC was priced that day, so it IS a trading day -- and still unknown.
      expect(res.days[0].isTradingDay).toBe(true);
      expect(res.days[0].movement).toBeNull();
      expect(res.days[0].reasons).toEqual(["unpricedHolding"]);
    });
  });

  /**
   * A scoped cash account with no balance for the day makes the value a
   * subtotal with neither a price nor a rate missing, so the day's move is
   * unknown. Asserted at the service, not only on `valueReasons`: the reason
   * list and the completeness the movement is withheld on are two reads of the
   * same bit, and only this one decides whether a figure is printed.
   */
  describe("a day whose cash is incomplete", () => {
    it("has no movement, and names the cash as the cause", async () => {
      replayRows = [buy("abc", 100, "2026-09-01")];
      securities = [{ id: "abc", symbol: "ABC", currencyCode: "CAD" }];
      netWorth.loadValuationSeries.mockResolvedValue(
        series({
          abc: [
            { date: "2026-09-10", close: 50 },
            { date: "2026-09-11", close: 52 },
          ],
        }),
      );
      netWorth.getDailyInvestments.mockResolvedValue([
        value("2026-09-10", 5000, { cashComplete: false }),
        value("2026-09-11", 5200, { cashComplete: false }),
      ]);

      const res = await service.getDailyMovements(
        "user-1",
        "2026-09-11",
        "2026-09-11",
      );

      expect(res.days[0].isTradingDay).toBe(true);
      expect(res.days[0].movement).toBeNull();
      expect(res.days[0].reasons).toEqual(["cashIncomplete"]);
    });
  });

  describe("missing rates", () => {
    it("withholds the day when a value could not be converted", async () => {
      replayRows = [buy("abc", 100, "2026-09-01")];
      securities = [{ id: "abc", symbol: "ABC", currencyCode: "CAD" }];
      netWorth.loadValuationSeries.mockResolvedValue(
        series({
          abc: [
            { date: "2026-09-10", close: 50 },
            { date: "2026-09-11", close: 52 },
          ],
        }),
      );
      netWorth.getDailyInvestments.mockResolvedValue([
        value("2026-09-10", 5000),
        value("2026-09-11", 5200, { fxComplete: false }),
      ]);

      const res = await service.getDailyMovements(
        "user-1",
        "2026-09-11",
        "2026-09-11",
      );

      expect(res.days[0].movement).toBeNull();
      expect(res.days[0].reasons).toEqual(["missingRate"]);
    });

    it("withholds the day when a flow currency has no rate, rather than counting it as zero", async () => {
      replayRows = [buy("abc", 100, "2026-09-01")];
      securities = [{ id: "abc", symbol: "ABC", currencyCode: "CAD" }];
      netWorth.loadValuationSeries.mockResolvedValue(
        series({
          abc: [
            { date: "2026-09-10", close: 50 },
            { date: "2026-09-11", close: 52 },
          ],
        }),
      );
      netWorth.getDailyInvestments.mockResolvedValue([
        value("2026-09-10", 5000),
        value("2026-09-11", 5200),
      ]);
      // A USD deposit with no stored USD->CAD rate.
      flowRows = [{ date: "2026-09-11", currency: "USD", total: "100" }];

      const res = await service.getDailyMovements(
        "user-1",
        "2026-09-11",
        "2026-09-11",
      );

      expect(res.days[0].movement).toBeNull();
      expect(res.days[0].reasons).toEqual(["flowIncomplete"]);
    });

    it("lists a row whose rate is absent with change null, and withholds the remainder (table D)", async () => {
      replayRows = [buy("usd-sec", 10, "2026-09-01")];
      securities = [
        {
          id: "usd-sec",
          symbol: "USD1",
          name: "US Thing",
          currencyCode: "USD",
        },
      ];
      netWorth.loadValuationSeries.mockResolvedValue(
        series({
          "usd-sec": [
            { date: "2026-09-10", close: 50 },
            { date: "2026-09-11", close: 52 },
          ],
        }),
      );
      netWorth.getDailyInvestments.mockResolvedValue([
        value("2026-09-10", 5000),
        value("2026-09-11", 5200),
      ]);

      const res = await service.getDailyMovementDetail("user-1", "2026-09-11");

      expect(res.gains).toHaveLength(1);
      expect(res.gains[0]).toMatchObject({
        securityId: "usd-sec",
        currencyCode: "USD",
        priceChange: 2,
        change: null,
      });
      // A remainder computed from a subtotal would be a fabricated
      // reconciliation.
      expect(res.remainder).toBeNull();
    });

    it("converts a row at the day's own rate", async () => {
      replayRows = [buy("usd-sec", 10, "2026-09-01")];
      securities = [
        {
          id: "usd-sec",
          symbol: "USD1",
          name: "US Thing",
          currencyCode: "USD",
        },
      ];
      rateRows = [
        {
          from_currency: "USD",
          to_currency: "CAD",
          rate: "1.5",
          rate_date: "2026-09-11",
        },
      ];
      netWorth.loadValuationSeries.mockResolvedValue(
        series({
          "usd-sec": [
            { date: "2026-09-10", close: 50 },
            { date: "2026-09-11", close: 52 },
          ],
        }),
      );
      netWorth.getDailyInvestments.mockResolvedValue([
        value("2026-09-10", 5000),
        value("2026-09-11", 5200),
      ]);

      const res = await service.getDailyMovementDetail("user-1", "2026-09-11");

      // 10 shares x $2 USD = $20 USD x 1.50 = $30 CAD.
      expect(res.gains[0].change).toBe(30);
    });
  });

  describe("table D: which positions get a row", () => {
    beforeEach(() => {
      netWorth.getDailyInvestments.mockResolvedValue([
        value("2026-09-10", 5000),
        value("2026-09-11", 5200),
      ]);
    });

    it("gives no row to a position whose close was carried, not struck, that day", async () => {
      replayRows = [buy("abc", 100, "2026-09-01")];
      securities = [{ id: "abc", symbol: "ABC", currencyCode: "CAD" }];
      netWorth.loadValuationSeries.mockResolvedValue(
        series({
          abc: [
            { date: "2026-09-09", close: 40 },
            { date: "2026-09-10", close: 50 },
          ],
        }),
      );

      const res = await service.getDailyMovementDetail("user-1", "2026-09-11");

      expect(res.gains).toEqual([]);
      expect(res.losses).toEqual([]);
      expect(res.unchangedCount).toBe(0);
    });

    it("gives no row to a bond-linked position on a day the engine refused, whatever a trade struck", async () => {
      // A26-M26: the engine priced 09-10 and refused 09-11; an imported BUY
      // struck 45.00 on 09-11. A quoted security would read that trade price
      // as the day's close and report a 10.00 fall; a linked one has no close.
      replayRows = [buy("edo", 100, "2026-09-01")];
      securities = [
        {
          id: "edo",
          symbol: "EDO",
          currencyCode: "CAD",
          bondProgramId: "prog-edo",
        },
      ];
      netWorth.loadValuationSeries.mockResolvedValue({
        stored: new Map([["edo", [{ date: "2026-09-10", close: 55 }]]]),
        txFallback: new Map([["edo", [{ date: "2026-09-11", close: 45 }]]]),
      });

      const res = await service.getDailyMovementDetail("user-1", "2026-09-11");

      expect(res.gains).toEqual([]);
      expect(res.losses).toEqual([]);
    });

    it("gives a marketable coupon bond a row from the person's own prices, the previous close carried to the previous day", async () => {
      // A US Treasury note: the engine writes no price for it, so the manual
      // prices are its closes. 40 on 09-09, none on 09-10, 52 on 09-11: the
      // move of 100 units is 100 x (52 - 40) = 1200.
      programRows = [
        {
          issuer_country_code: "US",
          issuer_code: "US_TREASURY",
          program_code: "NOTE",
        },
      ];
      replayRows = [buy("ust", 100, "2026-09-01")];
      securities = [
        {
          id: "ust",
          symbol: "UST",
          currencyCode: "CAD",
          bondProgramId: "prog-note",
        },
      ];
      netWorth.loadValuationSeries.mockResolvedValue({
        stored: new Map([
          [
            "ust",
            [
              { date: "2026-09-09", close: 40 },
              { date: "2026-09-11", close: 52 },
            ],
          ],
        ]),
        txFallback: new Map(),
      });

      const res = await service.getDailyMovementDetail("user-1", "2026-09-11");

      expect(res.gains.map((g) => [g.securityId, g.change])).toEqual([
        ["ust", 1200],
      ]);
    });

    it("gives no row to a position sold to zero", async () => {
      replayRows = [
        buy("abc", 100, "2026-09-01"),
        {
          account_id: "brok-1",
          security_id: "abc",
          action: "SELL",
          quantity: "100",
          transaction_date: "2026-09-02",
        },
      ];
      securities = [{ id: "abc", symbol: "ABC", currencyCode: "CAD" }];
      netWorth.loadValuationSeries.mockResolvedValue(
        series({
          abc: [
            { date: "2026-09-10", close: 50 },
            { date: "2026-09-11", close: 52 },
          ],
        }),
      );

      const res = await service.getDailyMovementDetail("user-1", "2026-09-11");

      expect(res.gains).toEqual([]);
      // ...and the day is not a trading day for THIS portfolio either.
      expect(res.reasons).toEqual(["notTradingDay"]);
    });

    it("gives no row to a position with no previous accepted close, leaving it in the remainder", async () => {
      replayRows = [buy("new", 10, "2026-09-11")];
      securities = [{ id: "new", symbol: "NEW", currencyCode: "CAD" }];
      netWorth.loadValuationSeries.mockResolvedValue(
        series({ new: [{ date: "2026-09-11", close: 52 }] }),
      );

      const res = await service.getDailyMovementDetail("user-1", "2026-09-11");

      expect(res.gains).toEqual([]);
      expect(res.losses).toEqual([]);
      // 200 of movement, none of it explained by a per-security close.
      expect(res.remainder).toBe(200);
    });

    it("sorts each bucket by the money it moved, largest first", async () => {
      replayRows = [
        buy("small", 1, "2026-09-01"),
        buy("big", 100, "2026-09-01"),
      ];
      securities = [
        { id: "small", symbol: "SML", currencyCode: "CAD" },
        { id: "big", symbol: "BIG", currencyCode: "CAD" },
      ];
      netWorth.loadValuationSeries.mockResolvedValue(
        series({
          small: [
            { date: "2026-09-10", close: 10 },
            { date: "2026-09-11", close: 15 },
          ],
          big: [
            { date: "2026-09-10", close: 50 },
            { date: "2026-09-11", close: 51 },
          ],
        }),
      );

      const res = await service.getDailyMovementDetail("user-1", "2026-09-11");

      // BIG moved 100 x 1 = 100; SML moved 1 x 5 = 5.
      expect(res.gains.map((g) => g.securityId)).toEqual(["big", "small"]);
    });
  });

  describe("the range", () => {
    it("does not evaluate a day after the server's today", async () => {
      const res = await service.getDailyMovements(
        "user-1",
        "2026-09-15",
        "2026-09-16",
      );

      expect(res.days).toHaveLength(2);
      expect(res.days.every((d) => d.reasons[0] === "notTradingDay")).toBe(
        true,
      );
      expect(netWorth.getDailyInvestments).not.toHaveBeenCalled();
    });

    it("clamps a range that straddles today rather than refusing it", async () => {
      netWorth.getDailyInvestments.mockResolvedValue([]);

      const res = await service.getDailyMovements(
        "user-1",
        "2026-09-13",
        "2026-09-16",
      );

      expect(res.days.map((d) => d.date)).toEqual([
        "2026-09-13",
        "2026-09-14",
        "2026-09-15",
        "2026-09-16",
      ]);
      // The value series is asked for one day BEFORE the first evaluated day: a
      // change is a difference of two observations.
      expect(netWorth.getDailyInvestments).toHaveBeenCalledWith(
        "user-1",
        "2026-09-12",
        TODAY,
        undefined,
        "CAD",
      );
    });

    it("answers an empty scope without asking for a value series", async () => {
      scopeRows = [];

      const res = await service.getDailyMovements(
        "user-1",
        "2026-09-11",
        "2026-09-11",
      );

      expect(res.days[0].reasons).toEqual(["notTradingDay"]);
      expect(netWorth.getDailyInvestments).not.toHaveBeenCalled();
    });

    it("widens an explicit account filter to its linked pairs", async () => {
      await service.getDailyMovements("user-1", "2026-09-11", "2026-09-11", [
        "cash-1",
      ]);

      const scopeQuery = queries.find((q) =>
        q.sql.includes("linked_account_id = ANY"),
      );
      expect(scopeQuery).toBeDefined();
      expect(scopeQuery!.params).toEqual([["cash-1"], "user-1"]);
    });

    it("asks the flow query for the resolved scope, per day", async () => {
      await service.getDailyMovements("user-1", "2026-09-11", "2026-09-11");

      const flowQuery = queries.find((q) =>
        q.sql.includes("FROM transactions t"),
      )!;
      expect(flowQuery.sql).toContain("GROUP BY t.transaction_date");
      expect(flowQuery.params).toEqual([
        "user-1",
        // Exclusive lower bound, so the first evaluated day's own flows count.
        "2026-09-10",
        "2026-09-11",
        ["brok-1", "cash-1"],
      ]);
    });

    it("honours an explicit display currency over the preference", async () => {
      await service.getDailyMovements(
        "user-1",
        "2026-09-11",
        "2026-09-11",
        undefined,
        "USD",
      );

      expect(netWorth.getDailyInvestments).toHaveBeenCalledWith(
        "user-1",
        "2026-09-10",
        "2026-09-11",
        undefined,
        "USD",
      );
    });
  });

  describe("the detail endpoint", () => {
    it("is blank for a day after today, and asks for nothing", async () => {
      const res = await service.getDailyMovementDetail("user-1", "2026-09-20");

      expect(res.date).toBe("2026-09-20");
      expect(res.reasons).toEqual(["notTradingDay"]);
      expect(res.gains).toEqual([]);
      expect(res.remainder).toBeNull();
      expect(netWorth.getDailyInvestments).not.toHaveBeenCalled();
    });

    it("withholds the remainder on a day whose movement is unknown", async () => {
      replayRows = [buy("abc", 100, "2026-09-01")];
      securities = [{ id: "abc", symbol: "ABC", currencyCode: "CAD" }];
      netWorth.loadValuationSeries.mockResolvedValue(
        series({
          abc: [
            { date: "2026-09-10", close: 50 },
            { date: "2026-09-11", close: 52 },
          ],
        }),
      );
      netWorth.getDailyInvestments.mockResolvedValue([
        value("2026-09-10", 5000),
        value("2026-09-11", 5200, { pricesComplete: false }),
      ]);

      const res = await service.getDailyMovementDetail("user-1", "2026-09-11");

      expect(res.movement).toBeNull();
      expect(res.remainder).toBeNull();
      // The rows are still listed: what each security did is known even when
      // the portfolio total is not.
      expect(res.gains).toHaveLength(1);
    });
  });
});
