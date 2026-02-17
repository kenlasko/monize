import { Test, TestingModule } from "@nestjs/testing";
import { AiController } from "./ai.controller";
import { AiService } from "./ai.service";

describe("AiController", () => {
  let controller: AiController;
  let mockAiService: Partial<Record<keyof AiService, jest.Mock>>;
  const mockReq = { user: { id: "user-1" } };

  beforeEach(async () => {
    mockAiService = {
      getStatus: jest.fn().mockResolvedValue({
        configured: true,
        encryptionAvailable: true,
        activeProviders: 1,
      }),
      getConfigs: jest.fn().mockResolvedValue([]),
      createConfig: jest.fn().mockResolvedValue({ id: "new-config" }),
      updateConfig: jest.fn().mockResolvedValue({ id: "config-1" }),
      deleteConfig: jest.fn().mockResolvedValue(undefined),
      testConnection: jest.fn().mockResolvedValue({ available: true }),
      getUsageSummary: jest.fn().mockResolvedValue({ totalRequests: 0 }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AiController],
      providers: [{ provide: AiService, useValue: mockAiService }],
    }).compile();

    controller = module.get<AiController>(AiController);
  });

  describe("getStatus()", () => {
    it("delegates to aiService.getStatus with userId", async () => {
      const result = await controller.getStatus(mockReq);
      expect(result).toEqual({
        configured: true,
        encryptionAvailable: true,
        activeProviders: 1,
      });
      expect(mockAiService.getStatus).toHaveBeenCalledWith("user-1");
    });
  });

  describe("getConfigs()", () => {
    it("delegates to aiService.getConfigs with userId", async () => {
      await controller.getConfigs(mockReq);
      expect(mockAiService.getConfigs).toHaveBeenCalledWith("user-1");
    });
  });

  describe("createConfig()", () => {
    it("delegates to aiService.createConfig with userId and dto", async () => {
      const dto = { provider: "anthropic" as const, apiKey: "sk-key" };
      await controller.createConfig(mockReq, dto);
      expect(mockAiService.createConfig).toHaveBeenCalledWith("user-1", dto);
    });
  });

  describe("updateConfig()", () => {
    it("delegates to aiService.updateConfig with userId, id, and dto", async () => {
      const dto = { model: "claude-haiku-4-20250414" };
      await controller.updateConfig(mockReq, "config-1", dto);
      expect(mockAiService.updateConfig).toHaveBeenCalledWith(
        "user-1",
        "config-1",
        dto,
      );
    });
  });

  describe("deleteConfig()", () => {
    it("delegates to aiService.deleteConfig with userId and id", async () => {
      await controller.deleteConfig(mockReq, "config-1");
      expect(mockAiService.deleteConfig).toHaveBeenCalledWith(
        "user-1",
        "config-1",
      );
    });
  });

  describe("testConnection()", () => {
    it("delegates to aiService.testConnection with userId and id", async () => {
      const result = await controller.testConnection(mockReq, "config-1");
      expect(result).toEqual({ available: true });
      expect(mockAiService.testConnection).toHaveBeenCalledWith(
        "user-1",
        "config-1",
      );
    });
  });

  describe("getUsage()", () => {
    it("delegates to aiService.getUsageSummary with userId", async () => {
      await controller.getUsage(mockReq);
      expect(mockAiService.getUsageSummary).toHaveBeenCalledWith(
        "user-1",
        undefined,
      );
    });

    it("parses days query parameter", async () => {
      await controller.getUsage(mockReq, "30");
      expect(mockAiService.getUsageSummary).toHaveBeenCalledWith("user-1", 30);
    });

    it("ignores invalid days parameter", async () => {
      await controller.getUsage(mockReq, "abc");
      expect(mockAiService.getUsageSummary).toHaveBeenCalledWith(
        "user-1",
        undefined,
      );
    });
  });
});
