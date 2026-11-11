import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";

import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { EMPTY_INVESTED_FLOW_DAY } from "./invested-capital-flow.util";
import type { InvestedFlowDay } from "./invested-capital-flow.util";
import { investedPeriodResult } from "./invested-period-result.util";
import { NetWorthService } from "./net-worth.service";
import { PortfolioPeriodResultService } from "./portfolio-period-result.service";
import { PortfolioTwrSeriesService } from "./portfolio-twr-series.service";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

jest.mock("../common/date-utils", () => ({
  ...jest.requireActual("../common/date-utils"),
  todayYMD: jest.fn(() => "2026-09-17"),
}));

const DATES = ["2026-09-15", "2026-09-16", "2026-09-17"];

const point = (date: string, securitiesValue: number, flags = {}) => ({
  date,
  securitiesValue,
  value: securitiesValue,
  fxComplete: true,
  pricesComplete: true,
  missingRatePairs: [],
  unpricedSecurityIds: [],
  ...flags,
});

const BROKERAGE = (id: string) => ({
  id,
  account_type: "INVESTMENT",
  account_sub_type: "INVESTMENT_BROKERAGE",
});

/**
 * The window is 2026-09-15 .. 2026-09-17. The series is 1,000 -> 1,500 (a 500
 * buy on the 16th) -> 1,650, so the line is 0, 0, +10 where the value chart
 * over the same days steps from 1,000 to 1,500. The arithmetic is
 * `invested-twr-series.util.spec.ts`'s; this pins what the service reads it
 * from and how it scopes it.
 */
describe("PortfolioTwrSeriesService", () => {
  let service: PortfolioTwrSeriesService;
  let periodResult: {
    reportingCurrency: jest.Mock;
    measuredFrom: jest.Mock;
    resolveScope: jest.Mock;
    foldFlows: jest.Mock;
    loadInvestedRows: jest.Mock;
    loadShareLegClose: jest.Mock;
  };
  let netWorth: {
    getDailyInvestments: jest.Mock;
    loadValuationSeries: jest.Mock;
  };
  let byDay: Map<string, InvestedFlowDay>;

  beforeEach(async () => {
    byDay = new Map([
      [DATES[1], { ...EMPTY_INVESTED_FLOW_DAY, capitalIn: 500 }],
    ]);
    const mocks = createScopedDbMocks([]);
    mocks.manager.query.mockImplementation(async (sql: string) => {
      if (sql.includes("it.action AS action")) return [];
      throw new Error(`unexpected query: ${sql}`);
    });

    periodResult = {
      reportingCurrency: jest.fn(async () => "CAD"),
      measuredFrom: jest.fn(async () => DATES[0]),
      resolveScope: jest.fn(async (_userId: string, ids?: string[]) =>
        (ids ?? ["brok-1"]).map(BROKERAGE),
      ),
      loadInvestedRows: jest.fn(async () => []),
      loadShareLegClose: jest.fn(async () => jest.fn()),
      foldFlows: jest.fn(async () => ({
        flow: { gaps: [] },
        invested: { byDay, gaps: [] },
      })),
    };
    netWorth = {
      getDailyInvestments: jest.fn(async () => [
        point(DATES[0], 1000),
        point(DATES[1], 1500),
        point(DATES[2], 1650),
      ]),
      loadValuationSeries: jest.fn(async () => ({
        stored: new Map(),
        txFallback: new Map(),
      })),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PortfolioTwrSeriesService,
        { provide: DataSource, useValue: mocks.dataSource },
        { provide: NetWorthService, useValue: netWorth },
        { provide: PortfolioPeriodResultService, useValue: periodResult },
      ],
    }).compile();
    service = module.get(PortfolioTwrSeriesService);
  });

  describe("getSeries", () => {
    it("draws the running return over the series the value chart draws", async () => {
      const result = await service.getSeries("u1", {
        period: "1y",
        accountIds: ["brok-1"],
      });
      expect(result.currency).toBe("CAD");
      expect(result.startDate).toBe(DATES[0]);
      expect(result.endDate).toBe(DATES[2]);
      expect(result.complete).toBe(true);
      expect(result.reasons).toEqual([]);
      expect(result.points).toEqual([
        { date: DATES[0], returnPercent: 0 },
        { date: DATES[1], returnPercent: 0 },
        { date: DATES[2], returnPercent: 10 },
      ]);
    });

    it("reads the invested rows and closes through the period result's loaders", async () => {
      await service.getSeries("u1", { period: "1y", accountIds: ["brok-1"] });
      expect(periodResult.loadInvestedRows).toHaveBeenCalledWith(
        "u1",
        [BROKERAGE("brok-1")],
        DATES[0],
        DATES[2],
      );
      expect(periodResult.loadShareLegClose).toHaveBeenCalledTimes(1);
    });

    it("INV-PORTTWR-001: ends on the figure the period result reports for the same inputs", async () => {
      const result = await service.getSeries("u1", { period: "1y" });
      const decision = investedPeriodResult({
        points: await netWorth.getDailyInvestments(),
        startIndex: 0,
        endIndex: 2,
        flowsByDay: byDay,
      });
      expect(result.points[result.points.length - 1].returnPercent).toBe(
        decision.investmentReturnPercent,
      );
    });

    it("asks for the invested part only, over one fold of the invested rows", async () => {
      await service.getSeries("u1", { period: "1y", accountIds: ["brok-1"] });
      expect(netWorth.getDailyInvestments).toHaveBeenCalledWith(
        "u1",
        DATES[0],
        DATES[2],
        ["brok-1"],
        "CAD",
        { fetchMissing: undefined },
      );
      // No account-level cash flow rows are folded: this measure reads none.
      expect(periodResult.foldFlows.mock.calls[0][0]).toEqual([]);
    });

    it("withholds with the period result's reasons when a day is a subtotal", async () => {
      netWorth.getDailyInvestments.mockResolvedValueOnce([
        point(DATES[0], 1000),
        point(DATES[1], 1500, { pricesComplete: false }),
        point(DATES[2], 1650),
      ]);
      const result = await service.getSeries("u1", { period: "1y" });
      expect(result.complete).toBe(false);
      expect(result.points).toEqual([]);
      expect(result.reasons).toContain("incompletePrices");
    });

    it("returns noValueSeries for a scope with no accounts", async () => {
      periodResult.resolveScope.mockResolvedValueOnce([]);
      const result = await service.getSeries("u1", { period: "1y" });
      expect(result.points).toEqual([]);
      expect(result.reasons).toEqual(["noValueSeries"]);
      expect(netWorth.getDailyInvestments).not.toHaveBeenCalled();
    });

    it("returns noValueSeries when the preset has no history for the scope", async () => {
      periodResult.measuredFrom.mockResolvedValueOnce(null);
      const result = await service.getSeries("u1", { period: "1y" });
      expect(result.points).toEqual([]);
      expect(result.reasons).toEqual(["noValueSeries"]);
    });

    it("returns noValueSeries when the valuation has no days", async () => {
      netWorth.getDailyInvestments.mockResolvedValueOnce([]);
      const result = await service.getSeries("u1", { period: "1y" });
      expect(result.reasons).toEqual(["noValueSeries"]);
    });
  });

  describe("getSeriesByAccount", () => {
    it("is one series per account, each its own scope, in the order asked", async () => {
      const result = await service.getSeriesByAccount("u1", {
        period: "1y",
        accountIds: ["brok-1", "brok-2"],
      });
      expect(result.accounts.map((a) => a.accountId)).toEqual([
        "brok-1",
        "brok-2",
      ]);
      expect(netWorth.getDailyInvestments.mock.calls.map((c) => c[3])).toEqual([
        ["brok-1"],
        ["brok-2"],
      ]);
      expect(result.accounts[0].points[2].returnPercent).toBe(10);
    });

    it("draws a repeated or re-cased id once", async () => {
      const result = await service.getSeriesByAccount("u1", {
        period: "1y",
        accountIds: ["BROK-1", "brok-1", "Brok-1"],
      });
      expect(result.accounts.map((a) => a.accountId)).toEqual(["brok-1"]);
      expect(netWorth.getDailyInvestments).toHaveBeenCalledTimes(1);
    });

    it("opens every account on the same day, measured once for the whole request", async () => {
      await service.getSeriesByAccount("u1", {
        period: "all",
        accountIds: ["brok-1", "brok-2"],
      });
      expect(periodResult.measuredFrom).toHaveBeenCalledTimes(1);
      const opened = netWorth.getDailyInvestments.mock.calls.map((c) => c[1]);
      expect(opened).toEqual([DATES[0], DATES[0]]);
    });

    it("one account's gap withholds that account only", async () => {
      netWorth.getDailyInvestments
        .mockResolvedValueOnce([
          point(DATES[0], 1000),
          point(DATES[1], 1500, { fxComplete: false }),
          point(DATES[2], 1650),
        ])
        .mockResolvedValueOnce([
          point(DATES[0], 1000),
          point(DATES[1], 1500),
          point(DATES[2], 1650),
        ]);
      const result = await service.getSeriesByAccount("u1", {
        period: "1y",
        accountIds: ["brok-1", "brok-2"],
      });
      expect(result.accounts[0].complete).toBe(false);
      expect(result.accounts[0].reasons).toContain("missingRatePairs");
      expect(result.accounts[1].complete).toBe(true);
    });

    it("names every account empty when the window cannot be measured", async () => {
      periodResult.measuredFrom.mockResolvedValueOnce(null);
      const result = await service.getSeriesByAccount("u1", {
        period: "1y",
        accountIds: ["brok-1", "brok-2"],
      });
      expect(result.accounts).toHaveLength(2);
      expect(
        result.accounts.every((a) => a.reasons[0] === "noValueSeries"),
      ).toBe(true);
      expect(netWorth.getDailyInvestments).not.toHaveBeenCalled();
    });
  });
});
