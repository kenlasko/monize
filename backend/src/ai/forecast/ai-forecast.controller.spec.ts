import { Test, TestingModule } from "@nestjs/testing";
import { AiForecastController } from "./ai-forecast.controller";
import { AiForecastService } from "./ai-forecast.service";
import { ForecastResponse } from "./dto/ai-forecast.dto";

describe("AiForecastController", () => {
  let controller: AiForecastController;
  let mockForecastService: Partial<Record<keyof AiForecastService, jest.Mock>>;

  const userId = "user-1";
  const req = { user: { id: userId } };

  const mockResponse: ForecastResponse = {
    generatedAt: "2026-02-18T00:00:00.000Z",
    currency: "USD",
    currentBalance: 15000,
    forecastMonths: 3,
    monthlyProjections: [
      {
        month: "2026-03",
        projectedIncome: 4000,
        projectedExpenses: 3200,
        projectedNetCashFlow: 800,
        projectedEndingBalance: 15800,
        confidenceLow: 14500,
        confidenceHigh: 17000,
        keyExpenses: [],
      },
    ],
    riskFlags: [],
    narrativeSummary: "Your cash flow looks stable.",
  };

  beforeEach(async () => {
    mockForecastService = {
      generateForecast: jest.fn().mockResolvedValue(mockResponse),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AiForecastController],
      providers: [
        {
          provide: AiForecastService,
          useValue: mockForecastService,
        },
      ],
    }).compile();

    controller = module.get<AiForecastController>(AiForecastController);
  });

  describe("generateForecast()", () => {
    it("delegates to forecast service with user id", async () => {
      await controller.generateForecast(req, {});

      expect(mockForecastService.generateForecast).toHaveBeenCalledWith(
        userId,
        undefined,
      );
    });

    it("passes months parameter from dto", async () => {
      await controller.generateForecast(req, { months: 6 });

      expect(mockForecastService.generateForecast).toHaveBeenCalledWith(
        userId,
        6,
      );
    });

    it("returns forecast response", async () => {
      const result = await controller.generateForecast(req, {});

      expect(result).toEqual(mockResponse);
      expect(result.currency).toBe("USD");
      expect(result.monthlyProjections).toHaveLength(1);
    });

    it("uses undefined months when not provided", async () => {
      await controller.generateForecast(req, {});

      expect(mockForecastService.generateForecast).toHaveBeenCalledWith(
        userId,
        undefined,
      );
    });
  });
});
