import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";

import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import { Security } from "../securities/entities/security.entity";
import { NetWorthService } from "./net-worth.service";
import { PortfolioPeriodResultService } from "./portfolio-period-result.service";
import { SecurityPeriodResultsService } from "./security-period-results.service";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

jest.mock("../common/date-utils", () => ({
  ...jest.requireActual("../common/date-utils"),
  todayYMD: jest.fn(() => "2026-09-17"),
}));

type Row = Record<string, unknown>;

/**
 * The window is 2026-09-15 .. 2026-09-17. `sec-a` is held throughout at 100,
 * then 110; `sec-b` is bought on the 16th for 1,000 and closes at 120. The
 * figures themselves are `security-period-result.util.spec.ts`'s; this pins
 * what the service reads them from.
 */
describe("SecurityPeriodResultsService", () => {
  let service: SecurityPeriodResultsService;
  let periodResult: {
    reportingCurrency: jest.Mock;
    measuredFrom: jest.Mock;
    resolveScope: jest.Mock;
  };
  let netWorth: {
    getDailyInvestmentPositions: jest.Mock;
    loadValuationSeries: jest.Mock;
  };
  let securityRepo: { findBy: jest.Mock };
  let investedRows: Row[];
  let queries: Array<{ sql: string; params: unknown[] }>;

  const DATES = ["2026-09-15", "2026-09-16", "2026-09-17"];
  const security = (id: string, symbol: string) =>
    ({ id, symbol, name: `${symbol} Inc`, currencyCode: "CAD" }) as Security;

  const day = (
    date: string,
    held: Record<string, { qty: number; close: number }>,
  ) => ({
    date,
    quantities: new Map(Object.entries(held).map(([id, h]) => [id, h.qty])),
    closes: new Map(Object.entries(held).map(([id, h]) => [id, h.close])),
    closeValues: new Map(
      Object.entries(held).map(([id, h]) => [id, h.qty * h.close]),
    ),
    cashByCurrency: new Map(),
  });

  const flowRow = (overrides: Row): Row => ({
    date: "2026-09-16",
    currency: "CAD",
    action: "BUY",
    security_id: "sec-b",
    total: "1000",
    quantity: "10",
    price: "100",
    commission: "0",
    ...overrides,
  });

  beforeEach(async () => {
    queries = [];
    investedRows = [flowRow({})];
    securityRepo = { findBy: jest.fn(async () => []) };
    const mocks = createScopedDbMocks([[Security, securityRepo]]);
    mocks.manager.query.mockImplementation(
      async (sql: string, params: unknown[]) => {
        queries.push({ sql, params });
        if (sql.includes("it.action AS action")) return investedRows;
        if (sql.includes("FROM exchange_rates")) return [];
        throw new Error(`unexpected query: ${sql}`);
      },
    );

    periodResult = {
      reportingCurrency: jest.fn(async () => "CAD"),
      measuredFrom: jest.fn(async () => "2026-09-15"),
      resolveScope: jest.fn(async () => [
        {
          id: "brok-1",
          account_type: "INVESTMENT",
          account_sub_type: "INVESTMENT_BROKERAGE",
        },
      ]),
    };
    const closes: Record<string, number[]> = {
      "sec-a": [100, 105, 110],
      "sec-b": [90, 100, 120],
    };
    netWorth = {
      getDailyInvestmentPositions: jest.fn(async () => ({
        series: [],
        positions: [
          day(DATES[0], { "sec-a": { qty: 10, close: 100 } }),
          day(DATES[1], {
            "sec-a": { qty: 10, close: 105 },
            "sec-b": { qty: 10, close: 100 },
          }),
          day(DATES[2], {
            "sec-a": { qty: 10, close: 110 },
            "sec-b": { qty: 10, close: 120 },
          }),
        ],
        securities: new Map([["sec-a", security("sec-a", "AAA")]]),
      })),
      loadValuationSeries: jest.fn(async () => ({
        stored: new Map(
          Object.entries(closes).map(([id, values]) => [
            id,
            values.map((close, i) => ({ date: DATES[i], close })),
          ]),
        ),
        txFallback: new Map(),
      })),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SecurityPeriodResultsService,
        { provide: DataSource, useValue: mocks.dataSource },
        { provide: NetWorthService, useValue: netWorth },
        { provide: PortfolioPeriodResultService, useValue: periodResult },
        {
          provide: ExchangeRateService,
          useValue: { ensureRatesForDate: jest.fn().mockResolvedValue(0) },
        },
      ],
    }).compile();
    service = module.get(SecurityPeriodResultsService);
  });

  it("opens on the day the portfolio route's own resolver draws", async () => {
    await service.getSecurityPeriodResults("user-1", {
      period: "1m",
      accountIds: ["brok-1"],
    });
    expect(periodResult.measuredFrom).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ period: "1m", accountIds: ["brok-1"] }),
      "2026-09-17",
    );
    expect(netWorth.getDailyInvestmentPositions).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({
        startDate: "2026-09-15",
        endDate: "2026-09-17",
        accountIds: ["brok-1"],
        displayCurrency: "CAD",
      }),
    );
    // Flows strictly after the baseline, over the resolved scope.
    const flowQuery = queries.find((q) =>
      q.sql.includes("it.action AS action"),
    );
    expect(flowQuery?.params.slice(0, 4)).toEqual([
      "user-1",
      "2026-09-15",
      "2026-09-17",
      ["brok-1"],
    ]);
  });

  it("measures each security over its own slice and flows", async () => {
    const result = await service.getSecurityPeriodResults("user-1", {
      period: "1m",
    });
    expect(result).toMatchObject({
      currency: "CAD",
      startDate: "2026-09-15",
      endDate: "2026-09-17",
      reasons: [],
      unattributedPnl: 0,
    });
    const byId = new Map(result.securities.map((r) => [r.securityId, r]));
    expect(byId.get("sec-a")).toMatchObject({
      symbol: "AAA",
      investmentPnl: 100,
      investmentReturnPercent: 10,
      priceChangePercent: 10,
    });
    expect(byId.get("sec-b")).toMatchObject({
      investmentCapitalFlows: 1000,
      investmentPnl: 200,
      investmentReturnPercent: 20,
      priceChangePercent: 33.33,
    });
  });

  it("reads the identity of a security only the flow rows name", async () => {
    securityRepo.findBy.mockResolvedValue([security("sec-b", "BBB")]);
    const result = await service.getSecurityPeriodResults("user-1", {
      period: "1m",
    });
    expect(securityRepo.findBy).toHaveBeenCalledTimes(1);
    expect(
      result.securities.find((r) => r.securityId === "sec-b")?.symbol,
    ).toBe("BBB");
  });

  it("keeps the rows naming no security apart, and withholds a split's price change", async () => {
    investedRows = [
      flowRow({}),
      flowRow({ action: "INTEREST", security_id: null, total: "5" }),
      flowRow({
        action: "SPLIT",
        security_id: "sec-a",
        total: "0",
        quantity: "2",
      }),
    ];
    const result = await service.getSecurityPeriodResults("user-1", {
      period: "1m",
    });
    expect(result.unattributedPnl).toBe(5);
    expect(
      result.securities.find((r) => r.securityId === "sec-a"),
    ).toMatchObject({
      priceChangePercent: null,
      priceChangeReason: "splitInWindow",
    });
  });

  it("answers no window, rather than zeros, where there is none", async () => {
    periodResult.measuredFrom.mockResolvedValue(null);
    await expect(
      service.getSecurityPeriodResults("user-1", { period: "5y" }),
    ).resolves.toEqual({
      currency: "CAD",
      startDate: "2026-09-17",
      endDate: "2026-09-17",
      reasons: ["noValueSeries"],
      securities: [],
      unattributedPnl: null,
    });
    expect(netWorth.getDailyInvestmentPositions).not.toHaveBeenCalled();
  });

  it("answers no window for an empty scope", async () => {
    periodResult.resolveScope.mockResolvedValue([]);
    const result = await service.getSecurityPeriodResults("user-1", {
      startDate: "2026-09-01",
      baselineDate: "2026-08-31",
    });
    expect(result.reasons).toEqual(["noValueSeries"]);
    expect(result.startDate).toBe("2026-09-15");
  });

  it("answers no window when the fold produced no day", async () => {
    netWorth.getDailyInvestmentPositions.mockResolvedValue({
      series: [],
      positions: [],
      securities: new Map(),
    });
    const result = await service.getSecurityPeriodResults("user-1", {
      period: "1m",
    });
    expect(result.securities).toEqual([]);
    expect(result.reasons).toEqual(["noValueSeries"]);
  });

  it("answers no window for a start after the end", async () => {
    periodResult.measuredFrom.mockResolvedValue("2026-09-20");
    const result = await service.getSecurityPeriodResults("user-1", {
      startDate: "2026-09-20",
    });
    expect(result.reasons).toEqual(["noValueSeries"]);
    expect(result.startDate).toBe("2026-09-20");
  });
});
