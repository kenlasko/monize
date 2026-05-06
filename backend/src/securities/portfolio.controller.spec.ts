import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { PortfolioController } from "./portfolio.controller";
import { PortfolioService } from "./portfolio.service";
import { SectorWeightingService } from "./sector-weighting.service";

describe("PortfolioController", () => {
  let controller: PortfolioController;
  let portfolioService: Record<string, jest.Mock>;
  let sectorWeightingService: Record<string, jest.Mock>;

  const req = { user: { id: "user-1" } };
  const UUID1 = "00000000-0000-0000-0000-000000000001";
  const UUID2 = "00000000-0000-0000-0000-000000000002";

  beforeEach(async () => {
    portfolioService = {
      getPortfolioSummary: jest.fn(),
      getAssetAllocation: jest.fn(),
      getTopMovers: jest.fn(),
      getInvestmentAccounts: jest.fn(),
      getIntradayValueSeries: jest.fn(),
    };

    sectorWeightingService = {
      getSectorWeightings: jest.fn().mockResolvedValue({
        items: [],
        totalPortfolioValue: 0,
        totalDirectValue: 0,
        totalEtfValue: 0,
        unclassifiedValue: 0,
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PortfolioController],
      providers: [
        { provide: PortfolioService, useValue: portfolioService },
        {
          provide: SectorWeightingService,
          useValue: sectorWeightingService,
        },
      ],
    }).compile();

    controller = module.get<PortfolioController>(PortfolioController);
  });

  it("should be defined", () => {
    expect(controller).toBeDefined();
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

    it("rejects invalid UUIDs in accountIds", () => {
      expect(() => controller.getSummary(req, "not-a-uuid")).toThrow(
        BadRequestException,
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

    it("rejects invalid UUIDs in accountIds", () => {
      expect(() => controller.getAllocation(req, "not-a-uuid")).toThrow(
        BadRequestException,
      );
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

    it("rejects invalid UUIDs in accountIds", () => {
      expect(() =>
        controller.getIntradayValue(req, {
          range: "1d",
          accountIds: "not-a-uuid",
        }),
      ).toThrow(BadRequestException);
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

    it("rejects invalid UUID in accountIds", () => {
      expect(() => controller.getSectorWeightings(req, "not-a-uuid")).toThrow(
        BadRequestException,
      );
    });

    it("rejects invalid UUID in securityIds", () => {
      expect(() =>
        controller.getSectorWeightings(req, undefined, "not-a-uuid"),
      ).toThrow(BadRequestException);
    });
  });
});
