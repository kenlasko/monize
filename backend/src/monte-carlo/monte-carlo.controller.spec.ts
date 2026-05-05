import { Test, TestingModule } from "@nestjs/testing";
import { MonteCarloController } from "./monte-carlo.controller";
import { MonteCarloService } from "./monte-carlo.service";
import { CreateScenarioDto } from "./dto/create-scenario.dto";
import { UpdateScenarioDto } from "./dto/update-scenario.dto";
import { RunScenarioDto } from "./dto/run-scenario.dto";

describe("MonteCarloController", () => {
  let controller: MonteCarloController;
  let mockService: Partial<Record<keyof MonteCarloService, jest.Mock>>;
  const mockReq = { user: { id: "user-1" } } as any;

  beforeEach(async () => {
    mockService = {
      findAll: jest.fn(),
      create: jest.fn(),
      findOne: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
      reorder: jest.fn(),
      runSaved: jest.fn(),
      runAdHoc: jest.fn(),
      getHistoricalStats: jest.fn(),
      getHoldingStats: jest.fn(),
      getBrokerageAccounts: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [MonteCarloController],
      providers: [{ provide: MonteCarloService, useValue: mockService }],
    }).compile();

    controller = module.get(MonteCarloController);
  });

  describe("list()", () => {
    it("delegates to service.findAll with the userId", () => {
      mockService.findAll!.mockReturnValue("scenarios");
      expect(controller.list(mockReq)).toBe("scenarios");
      expect(mockService.findAll).toHaveBeenCalledWith("user-1");
    });
  });

  describe("create()", () => {
    it("delegates to service.create with the userId and dto", () => {
      const dto = { name: "New" } as CreateScenarioDto;
      mockService.create!.mockReturnValue("created");
      expect(controller.create(mockReq, dto)).toBe("created");
      expect(mockService.create).toHaveBeenCalledWith("user-1", dto);
    });
  });

  describe("findOne()", () => {
    it("delegates to service.findOne with the userId and id", () => {
      mockService.findOne!.mockReturnValue("scenario");
      expect(controller.findOne(mockReq, "scn-1")).toBe("scenario");
      expect(mockService.findOne).toHaveBeenCalledWith("user-1", "scn-1");
    });
  });

  describe("update()", () => {
    it("delegates to service.update with the userId, id and dto", () => {
      const dto = { name: "Renamed" } as UpdateScenarioDto;
      mockService.update!.mockReturnValue("updated");
      expect(controller.update(mockReq, "scn-1", dto)).toBe("updated");
      expect(mockService.update).toHaveBeenCalledWith("user-1", "scn-1", dto);
    });
  });

  describe("remove()", () => {
    it("delegates to service.remove with the userId and id", () => {
      controller.remove(mockReq, "scn-1");
      expect(mockService.remove).toHaveBeenCalledWith("user-1", "scn-1");
    });
  });

  describe("reorder()", () => {
    it("delegates to service.reorder with userId and scenarioIds from the dto", () => {
      const dto = { scenarioIds: ["a", "b", "c"] };
      mockService.reorder!.mockResolvedValue(undefined);
      controller.reorder(mockReq, dto);
      expect(mockService.reorder).toHaveBeenCalledWith("user-1", [
        "a",
        "b",
        "c",
      ]);
    });
  });

  describe("runSaved()", () => {
    it("delegates to service.runSaved", () => {
      mockService.runSaved!.mockReturnValue("result");
      expect(controller.runSaved(mockReq, "scn-1")).toBe("result");
      expect(mockService.runSaved).toHaveBeenCalledWith("user-1", "scn-1");
    });
  });

  describe("run()", () => {
    it("delegates to service.runAdHoc with the userId and dto", () => {
      const dto = { startingValue: 1000 } as unknown as RunScenarioDto;
      mockService.runAdHoc!.mockReturnValue("result");
      expect(controller.run(mockReq, dto)).toBe("result");
      expect(mockService.runAdHoc).toHaveBeenCalledWith("user-1", dto);
    });
  });

  describe("historicalStats()", () => {
    it("parses the comma-delimited accountIds and forwards them", () => {
      mockService.getHistoricalStats!.mockReturnValue("stats");
      const aId = "11111111-1111-4111-8111-111111111111";
      const bId = "22222222-2222-4222-8222-222222222222";
      expect(controller.historicalStats(mockReq, `${aId},${bId}`)).toBe(
        "stats",
      );
      expect(mockService.getHistoricalStats).toHaveBeenCalledWith("user-1", [
        aId,
        bId,
      ]);
    });

    it("passes an empty array when no accountIds are provided", () => {
      mockService.getHistoricalStats!.mockReturnValue("stats");
      controller.historicalStats(mockReq);
      expect(mockService.getHistoricalStats).toHaveBeenCalledWith("user-1", []);
    });
  });

  describe("holdingStats()", () => {
    it("parses the comma-delimited accountIds and forwards them", () => {
      mockService.getHoldingStats!.mockReturnValue("stats");
      const aId = "11111111-1111-4111-8111-111111111111";
      controller.holdingStats(mockReq, aId);
      expect(mockService.getHoldingStats).toHaveBeenCalledWith("user-1", [aId]);
    });
  });

  describe("brokerageAccounts()", () => {
    it("delegates to service.getBrokerageAccounts", () => {
      mockService.getBrokerageAccounts!.mockReturnValue("accounts");
      expect(controller.brokerageAccounts(mockReq)).toBe("accounts");
      expect(mockService.getBrokerageAccounts).toHaveBeenCalledWith("user-1");
    });
  });
});
