import { Test, TestingModule } from "@nestjs/testing";
import { HoldingsController } from "./holdings.controller";
import { HoldingsService } from "./holdings.service";

describe("HoldingsController", () => {
  let controller: HoldingsController;
  let holdingsService: Record<string, jest.Mock>;

  const req = { user: { id: "user-1" } };

  const mockHolding = {
    id: "hold-1",
    userId: "user-1",
    accountId: "acc-1",
    securityId: "sec-1",
    quantity: 10,
    costBasis: 1500.0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    holdingsService = {
      findAll: jest.fn(),
      getHoldingsSummary: jest.fn(),
      findOne: jest.fn(),
      remove: jest.fn(),
      rebuildFromTransactions: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [HoldingsController],
      providers: [{ provide: HoldingsService, useValue: holdingsService }],
    }).compile();

    controller = module.get<HoldingsController>(HoldingsController);
  });

  it("should be defined", () => {
    expect(controller).toBeDefined();
  });

  describe("findAll", () => {
    it("returns all holdings for the user", async () => {
      holdingsService.findAll.mockResolvedValue([mockHolding]);

      const result = await controller.findAll(req);

      expect(holdingsService.findAll).toHaveBeenCalledWith("user-1", undefined);
      expect(result).toEqual([mockHolding]);
    });

    it("filters by accountId when provided", async () => {
      holdingsService.findAll.mockResolvedValue([mockHolding]);

      const result = await controller.findAll(req, "acc-1");

      expect(holdingsService.findAll).toHaveBeenCalledWith("user-1", "acc-1");
      expect(result).toEqual([mockHolding]);
    });
  });

  describe("getSummary", () => {
    it("returns holdings summary for an account", async () => {
      const summary = {
        totalValue: 5000,
        totalCostBasis: 4000,
        totalGainLoss: 1000,
      };
      holdingsService.getHoldingsSummary.mockResolvedValue(summary);

      const result = await controller.getSummary(req, "acc-1");

      expect(holdingsService.getHoldingsSummary).toHaveBeenCalledWith(
        "user-1",
        "acc-1",
      );
      expect(result).toEqual(summary);
    });
  });

  describe("findOne", () => {
    it("returns a single holding by id", async () => {
      holdingsService.findOne.mockResolvedValue(mockHolding);

      const result = await controller.findOne(req, "hold-1");

      expect(holdingsService.findOne).toHaveBeenCalledWith("user-1", "hold-1");
      expect(result).toEqual(mockHolding);
    });
  });

  describe("remove", () => {
    it("delegates to holdingsService.remove", async () => {
      holdingsService.remove.mockResolvedValue(undefined);

      await controller.remove(req, "hold-1");

      expect(holdingsService.remove).toHaveBeenCalledWith("user-1", "hold-1");
    });
  });

  describe("rebuild", () => {
    it("delegates to holdingsService.rebuildFromTransactions", async () => {
      const rebuildResult = {
        holdingsCreated: 5,
        holdingsUpdated: 2,
        holdingsDeleted: 1,
      };
      holdingsService.rebuildFromTransactions.mockResolvedValue(rebuildResult);

      const result = await controller.rebuild(req);

      expect(holdingsService.rebuildFromTransactions).toHaveBeenCalledWith(
        "user-1",
      );
      expect(result).toEqual(rebuildResult);
    });
  });
});
