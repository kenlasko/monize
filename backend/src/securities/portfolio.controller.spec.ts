import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { PortfolioController } from "./portfolio.controller";
import { PortfolioService } from "./portfolio.service";
import { SectorWeightingService } from "./sector-weighting.service";
import { DelegationService } from "../delegation/delegation.service";
import { DailyMovementService } from "./daily-movement.service";

describe("PortfolioController", () => {
  let controller: PortfolioController;
  let portfolioService: Record<string, jest.Mock>;
  let sectorWeightingService: Record<string, jest.Mock>;
  let delegationService: Record<string, jest.Mock>;
  let dailyMovementService: Record<string, jest.Mock>;

  const req = { user: { id: "user-1" } };
  const UUID1 = "00000000-0000-0000-0000-000000000001";
  const UUID2 = "00000000-0000-0000-0000-000000000002";
  const NO_READABLE = "00000000-0000-0000-0000-000000000000";

  beforeEach(async () => {
    portfolioService = {
      getPortfolioSummary: jest.fn(),
      getPortfolioValuation: jest.fn(),
      getAssetAllocation: jest.fn(),
      getAllocationByTag: jest.fn(),
      getTopMovers: jest.fn(),
      getInvestmentAccounts: jest.fn(),
      getIntradayValueSeries: jest.fn(),
      getIntradayBreakdown: jest.fn(),
    };

    const emptyWeightings = {
      items: [],
      totalPortfolioValue: 0,
      totalDirectValue: 0,
      totalEtfValue: 0,
      unclassifiedValue: 0,
    };
    sectorWeightingService = {
      getSectorWeightings: jest.fn().mockResolvedValue(emptyWeightings),
      getCountryWeightings: jest.fn().mockResolvedValue(emptyWeightings),
      getAssetClassWeightings: jest.fn().mockResolvedValue(emptyWeightings),
    };

    delegationService = {
      readableAccountIds: jest.fn().mockResolvedValue([]),
    };

    dailyMovementService = {
      getDailyMovements: jest.fn(),
      getDailyMovementDetail: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PortfolioController],
      providers: [
        { provide: PortfolioService, useValue: portfolioService },
        {
          provide: SectorWeightingService,
          useValue: sectorWeightingService,
        },
        { provide: DelegationService, useValue: delegationService },
        { provide: DailyMovementService, useValue: dailyMovementService },
      ],
    }).compile();

    controller = module.get<PortfolioController>(PortfolioController);
  });

  it("should be defined", () => {
    expect(controller).toBeDefined();
  });

  describe("getValuation", () => {
    it("returns the valuation for the requested accounts", async () => {
      const valuation = { totalPortfolioValue: 50000, holdings: [] };
      portfolioService.getPortfolioValuation.mockResolvedValue(valuation);

      const result = await controller.getValuation(req, `${UUID1},${UUID2}`);

      expect(portfolioService.getPortfolioValuation).toHaveBeenCalledWith(
        "user-1",
        [UUID1, UUID2],
      );
      expect(result).toEqual(valuation);
      expect(portfolioService.getPortfolioSummary).not.toHaveBeenCalled();
    });

    it("rejects invalid UUIDs in accountIds", async () => {
      await expect(controller.getValuation(req, "not-a-uuid")).rejects.toThrow(
        BadRequestException,
      );
    });

    it("scopes accountIds to readable accounts for an acting delegate", async () => {
      portfolioService.getPortfolioValuation.mockResolvedValue({});
      delegationService.readableAccountIds.mockResolvedValue([UUID1]);
      const actReq = {
        user: { id: "owner-1", isActing: true, delegationId: "d-1" },
      };

      await controller.getValuation(actReq, `${UUID1},${UUID2}`);

      expect(portfolioService.getPortfolioValuation).toHaveBeenCalledWith(
        "owner-1",
        [UUID1],
      );
    });
  });

  describe("getSummary", () => {
    it("returns portfolio summary without account filter", async () => {
      const summary = {
        totalValue: 50000,
        totalCostBasis: 40000,
        totalGainLoss: 10000,
        holdings: [],
      };
      portfolioService.getPortfolioSummary.mockResolvedValue(summary);

      const result = await controller.getSummary(req);

      expect(portfolioService.getPortfolioSummary).toHaveBeenCalledWith(
        "user-1",
        undefined,
      );
      expect(result).toEqual(summary);
    });

    it("parses accountIds CSV and passes to service", async () => {
      portfolioService.getPortfolioSummary.mockResolvedValue({});

      await controller.getSummary(req, `${UUID1},${UUID2}`);

      expect(portfolioService.getPortfolioSummary).toHaveBeenCalledWith(
        "user-1",
        [UUID1, UUID2],
      );
    });

    it("filters out empty strings from CSV", async () => {
      portfolioService.getPortfolioSummary.mockResolvedValue({});

      await controller.getSummary(req, `${UUID1},,${UUID2},`);

      expect(portfolioService.getPortfolioSummary).toHaveBeenCalledWith(
        "user-1",
        [UUID1, UUID2],
      );
    });

    it("rejects invalid UUIDs in accountIds", async () => {
      await expect(controller.getSummary(req, "not-a-uuid")).rejects.toThrow(
        BadRequestException,
      );
    });

    it("scopes accountIds to readable accounts for an acting delegate", async () => {
      portfolioService.getPortfolioSummary.mockResolvedValue({});
      delegationService.readableAccountIds.mockResolvedValue([UUID1]);
      const actReq = {
        user: { id: "owner-1", isActing: true, delegationId: "d-1" },
      };

      await controller.getSummary(actReq, `${UUID1},${UUID2}`);

      expect(delegationService.readableAccountIds).toHaveBeenCalledWith("d-1");
      expect(portfolioService.getPortfolioSummary).toHaveBeenCalledWith(
        "owner-1",
        [UUID1],
      );
    });

    it("returns an empty-shaped result for a delegate with no readable accounts", async () => {
      portfolioService.getPortfolioSummary.mockResolvedValue({});
      delegationService.readableAccountIds.mockResolvedValue([]);
      const actReq = {
        user: { id: "owner-1", isActing: true, delegationId: "d-1" },
      };

      await controller.getSummary(actReq);

      expect(portfolioService.getPortfolioSummary).toHaveBeenCalledWith(
        "owner-1",
        [NO_READABLE],
      );
    });
  });

  describe("getAllocation", () => {
    it("returns asset allocation without account filter", async () => {
      const allocation = [
        { type: "STOCK", percentage: 80 },
        { type: "BOND", percentage: 20 },
      ];
      portfolioService.getAssetAllocation.mockResolvedValue(allocation);

      const result = await controller.getAllocation(req);

      expect(portfolioService.getAssetAllocation).toHaveBeenCalledWith(
        "user-1",
        undefined,
      );
      expect(result).toEqual(allocation);
    });

    it("parses accountIds CSV and passes to service", async () => {
      portfolioService.getAssetAllocation.mockResolvedValue([]);

      await controller.getAllocation(req, UUID1);

      expect(portfolioService.getAssetAllocation).toHaveBeenCalledWith(
        "user-1",
        [UUID1],
      );
    });

    it("rejects invalid UUIDs in accountIds", async () => {
      await expect(controller.getAllocation(req, "not-a-uuid")).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe("getAllocationByTag", () => {
    it("returns tag allocation without account filter", async () => {
      const allocation = {
        allocation: [{ name: "AI", type: "tag", value: 100, percentage: 50 }],
        totalValue: 200,
      };
      portfolioService.getAllocationByTag.mockResolvedValue(allocation);

      const result = await controller.getAllocationByTag(req);

      expect(portfolioService.getAllocationByTag).toHaveBeenCalledWith(
        "user-1",
        undefined,
      );
      expect(result).toEqual(allocation);
    });

    it("parses accountIds CSV and passes to service", async () => {
      portfolioService.getAllocationByTag.mockResolvedValue({
        allocation: [],
        totalValue: 0,
      });

      await controller.getAllocationByTag(req, UUID1);

      expect(portfolioService.getAllocationByTag).toHaveBeenCalledWith(
        "user-1",
        [UUID1],
      );
    });

    it("rejects invalid UUIDs in accountIds", async () => {
      await expect(
        controller.getAllocationByTag(req, "not-a-uuid"),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("getTopMovers", () => {
    it("delegates to portfolioService.getTopMovers", async () => {
      const movers = {
        gainers: [{ symbol: "AAPL", change: 2.5 }],
        losers: [{ symbol: "MSFT", change: -1.2 }],
      };
      portfolioService.getTopMovers.mockResolvedValue(movers);

      const result = await controller.getTopMovers(req);

      expect(portfolioService.getTopMovers).toHaveBeenCalledWith("user-1");
      expect(result).toEqual(movers);
    });
  });

  describe("getInvestmentAccounts", () => {
    it("delegates to portfolioService.getInvestmentAccounts", async () => {
      const accounts = [{ id: UUID1, name: "Brokerage", type: "INVESTMENT" }];
      portfolioService.getInvestmentAccounts.mockResolvedValue(accounts);

      const result = await controller.getInvestmentAccounts(req);

      expect(portfolioService.getInvestmentAccounts).toHaveBeenCalledWith(
        "user-1",
      );
      expect(result).toEqual(accounts);
    });

    it("filters accounts to readable ones for an acting delegate", async () => {
      const accounts = [
        { id: UUID1, name: "Granted", type: "INVESTMENT" },
        { id: UUID2, name: "Not granted", type: "INVESTMENT" },
      ];
      portfolioService.getInvestmentAccounts.mockResolvedValue(accounts);
      delegationService.readableAccountIds.mockResolvedValue([UUID1]);
      const actReq = {
        user: { id: "owner-1", isActing: true, delegationId: "d-1" },
      };

      const result = await controller.getInvestmentAccounts(actReq);

      expect(result).toEqual([accounts[0]]);
    });
  });

  describe("getIntradayValue", () => {
    it("delegates to service with parsed account IDs", async () => {
      portfolioService.getIntradayValueSeries.mockResolvedValue({
        points: [],
        interval: "1m",
        currency: "CAD",
        range: "1d",
        fetchedAt: "2026-05-06T12:00:00.000Z",
      });

      await controller.getIntradayValue(req, {
        range: "1d",
        accountIds: `${UUID1},${UUID2}`,
        displayCurrency: "USD",
      });

      expect(portfolioService.getIntradayValueSeries).toHaveBeenCalledWith(
        "user-1",
        {
          range: "1d",
          accountIds: [UUID1, UUID2],
          displayCurrency: "USD",
        },
      );
    });

    it("passes undefined accountIds when not provided", async () => {
      portfolioService.getIntradayValueSeries.mockResolvedValue({
        points: [],
        interval: "1m",
        currency: "CAD",
        range: "1d",
        fetchedAt: "2026-05-06T12:00:00.000Z",
      });

      await controller.getIntradayValue(req, { range: "1w" });

      expect(portfolioService.getIntradayValueSeries).toHaveBeenCalledWith(
        "user-1",
        { range: "1w", accountIds: undefined, displayCurrency: undefined },
      );
    });

    it("rejects invalid UUIDs in accountIds", async () => {
      await expect(
        controller.getIntradayValue(req, {
          range: "1d",
          accountIds: "not-a-uuid",
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("getIntradayBreakdown", () => {
    it("delegates to service with parsed account IDs", async () => {
      portfolioService.getIntradayBreakdown.mockResolvedValue({
        series: [],
        points: [],
        interval: "1m",
        currency: "CAD",
        range: "1d",
        fetchedAt: "2026-05-06T12:00:00.000Z",
        skippedSymbols: [],
        failedSymbols: [],
        fallbackToDaily: false,
      });

      await controller.getIntradayBreakdown(req, {
        range: "1w",
        accountIds: `${UUID1},${UUID2}`,
        displayCurrency: "USD",
      });

      expect(portfolioService.getIntradayBreakdown).toHaveBeenCalledWith(
        "user-1",
        { range: "1w", accountIds: [UUID1, UUID2], displayCurrency: "USD" },
      );
    });

    it("rejects invalid UUIDs in accountIds", async () => {
      await expect(
        controller.getIntradayBreakdown(req, {
          range: "1d",
          accountIds: "not-a-uuid",
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("getAssetClassWeightings", () => {
    it("delegates to service with parsed account and security IDs", async () => {
      await controller.getAssetClassWeightings(req, UUID1, UUID2);

      expect(
        sectorWeightingService.getAssetClassWeightings,
      ).toHaveBeenCalledWith("user-1", [UUID1], [UUID2]);
    });

    it("passes undefined when no filters provided", async () => {
      await controller.getAssetClassWeightings(req);

      expect(
        sectorWeightingService.getAssetClassWeightings,
      ).toHaveBeenCalledWith("user-1", undefined, undefined);
    });

    it("rejects invalid UUID in accountIds", async () => {
      await expect(
        controller.getAssetClassWeightings(req, "not-a-uuid"),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects invalid UUID in securityIds", async () => {
      await expect(
        controller.getAssetClassWeightings(req, UUID1, "nope"),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("getSectorWeightings", () => {
    it("delegates to service with parsed account and security IDs", async () => {
      await controller.getSectorWeightings(req, UUID1, UUID2);

      expect(sectorWeightingService.getSectorWeightings).toHaveBeenCalledWith(
        "user-1",
        [UUID1],
        [UUID2],
      );
    });

    it("passes undefined when no filters provided", async () => {
      await controller.getSectorWeightings(req);

      expect(sectorWeightingService.getSectorWeightings).toHaveBeenCalledWith(
        "user-1",
        undefined,
        undefined,
      );
    });

    it("rejects invalid UUID in accountIds", async () => {
      await expect(
        controller.getSectorWeightings(req, "not-a-uuid"),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects invalid UUID in securityIds", async () => {
      await expect(
        controller.getSectorWeightings(req, undefined, "not-a-uuid"),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("daily movements", () => {
    const range = {
      startDate: "2026-09-01",
      endDate: "2026-09-30",
    };

    it("passes an owner's scope and currency straight through", async () => {
      dailyMovementService.getDailyMovements.mockResolvedValue("movements");

      const result = await controller.getDailyMovements(req, {
        ...range,
        accountIds: [UUID1],
        displayCurrency: "CAD",
      });

      expect(result).toBe("movements");
      expect(dailyMovementService.getDailyMovements).toHaveBeenCalledWith(
        "user-1",
        "2026-09-01",
        "2026-09-30",
        [UUID1],
        "CAD",
      );
    });

    it("narrows an acting delegate to their readable accounts", async () => {
      delegationService.readableAccountIds.mockResolvedValue([UUID1]);
      dailyMovementService.getDailyMovements.mockResolvedValue("movements");

      await controller.getDailyMovements(
        { user: { id: "owner-1", isActing: true, delegationId: "d-1" } },
        { ...range, accountIds: [UUID1, UUID2] },
      );

      expect(dailyMovementService.getDailyMovements).toHaveBeenCalledWith(
        "owner-1",
        "2026-09-01",
        "2026-09-30",
        [UUID1],
        undefined,
      );
    });

    it("gives a delegate with no readable accounts an empty scope", async () => {
      delegationService.readableAccountIds.mockResolvedValue([]);
      dailyMovementService.getDailyMovements.mockResolvedValue("movements");

      await controller.getDailyMovements(
        { user: { id: "owner-1", isActing: true, delegationId: "d-1" } },
        range,
      );

      expect(dailyMovementService.getDailyMovements.mock.calls[0][3]).toEqual([
        NO_READABLE,
      ]);
    });

    it("scopes the detail route the same way", async () => {
      delegationService.readableAccountIds.mockResolvedValue([UUID2]);
      dailyMovementService.getDailyMovementDetail.mockResolvedValue("detail");

      const result = await controller.getDailyMovementDetail(
        { user: { id: "owner-1", isActing: true, delegationId: "d-1" } },
        { date: "2026-09-11", accountIds: [UUID1, UUID2] },
      );

      expect(result).toBe("detail");
      expect(dailyMovementService.getDailyMovementDetail).toHaveBeenCalledWith(
        "owner-1",
        "2026-09-11",
        [UUID2],
        undefined,
      );
    });
  });
});
