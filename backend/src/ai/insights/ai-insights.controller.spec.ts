import { Test, TestingModule } from "@nestjs/testing";
import { AiInsightsController } from "./ai-insights.controller";
import { AiInsightsService } from "./ai-insights.service";

describe("AiInsightsController", () => {
  let controller: AiInsightsController;
  let mockInsightsService: Partial<Record<keyof AiInsightsService, jest.Mock>>;

  const userId = "user-1";
  const req = { user: { id: userId } };

  beforeEach(async () => {
    mockInsightsService = {
      getInsights: jest.fn().mockResolvedValue({
        insights: [],
        total: 0,
        lastGeneratedAt: null,
        isGenerating: false,
      }),
      generateInsights: jest.fn().mockResolvedValue({
        insights: [],
        total: 0,
        lastGeneratedAt: null,
        isGenerating: false,
      }),
      dismissInsight: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AiInsightsController],
      providers: [
        { provide: AiInsightsService, useValue: mockInsightsService },
      ],
    }).compile();

    controller = module.get<AiInsightsController>(AiInsightsController);
  });

  describe("getInsights()", () => {
    it("returns insights for the authenticated user", async () => {
      const result = await controller.getInsights(req, {});

      expect(mockInsightsService.getInsights).toHaveBeenCalledWith(
        userId,
        undefined,
        undefined,
        false,
      );
      expect(result).toEqual({
        insights: [],
        total: 0,
        lastGeneratedAt: null,
        isGenerating: false,
      });
    });

    it("passes filter parameters", async () => {
      await controller.getInsights(req, {
        type: "anomaly",
        severity: "warning",
        includeDismissed: true,
      });

      expect(mockInsightsService.getInsights).toHaveBeenCalledWith(
        userId,
        "anomaly",
        "warning",
        true,
      );
    });

    it("handles includeDismissed=false", async () => {
      await controller.getInsights(req, { includeDismissed: false });

      expect(mockInsightsService.getInsights).toHaveBeenCalledWith(
        userId,
        undefined,
        undefined,
        false,
      );
    });
  });

  describe("triggerGeneration()", () => {
    it("triggers background generation and returns status immediately", () => {
      mockInsightsService.generateInsights!.mockResolvedValue({
        insights: [],
        total: 0,
        lastGeneratedAt: null,
      });

      const result = controller.triggerGeneration(req);

      expect(mockInsightsService.generateInsights).toHaveBeenCalledWith(userId);
      expect(result).toEqual({ status: "generating" });
    });
  });

  describe("dismissInsight()", () => {
    it("dismisses an insight for the authenticated user", async () => {
      await controller.dismissInsight(req, "insight-1");

      expect(mockInsightsService.dismissInsight).toHaveBeenCalledWith(
        userId,
        "insight-1",
      );
    });
  });
});
