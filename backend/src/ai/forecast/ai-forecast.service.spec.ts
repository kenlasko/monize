import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { BadRequestException } from "@nestjs/common";
import { AiForecastService } from "./ai-forecast.service";
import { AiService } from "../ai.service";
import { AiUsageService } from "../ai-usage.service";
import { AiUsageLog } from "../entities/ai-usage-log.entity";
import {
  ForecastAggregatorService,
  ForecastAggregates,
} from "./forecast-aggregator.service";
import { UserPreference } from "../../users/entities/user-preference.entity";

describe("AiForecastService", () => {
  let service: AiForecastService;

  let mockUsageLogRepo: Record<string, any>;
  let mockPrefRepo: Record<string, jest.Mock>;
  let mockAiService: Partial<Record<keyof AiService, jest.Mock>>;
  let mockUsageService: Partial<Record<keyof AiUsageService, jest.Mock>>;
  let mockAggregatorService: Partial<
    Record<keyof ForecastAggregatorService, jest.Mock>
  >;

  const userId = "user-1";

  function makeAggregates(
    overrides: Partial<ForecastAggregates> = {},
  ): ForecastAggregates {
    return {
      currency: "USD",
      today: "2026-02-18",
      monthlyHistory: [
        {
          month: "2025-03",
          totalIncome: 4000,
          totalExpenses: 3000,
          netCashFlow: 1000,
          categoryBreakdown: [
            { categoryName: "Groceries", total: 500, isIncome: false },
          ],
        },
        {
          month: "2025-04",
          totalIncome: 4000,
          totalExpenses: 3200,
          netCashFlow: 800,
          categoryBreakdown: [
            { categoryName: "Groceries", total: 550, isIncome: false },
          ],
        },
        {
          month: "2025-05",
          totalIncome: 4000,
          totalExpenses: 2800,
          netCashFlow: 1200,
          categoryBreakdown: [],
        },
      ],
      accountBalances: {
        totalBalance: 15000,
        accounts: [
          {
            name: "Chequing",
            accountType: "CHEQUING",
            balance: 5000,
            currencyCode: "USD",
          },
          {
            name: "Savings",
            accountType: "SAVINGS",
            balance: 10000,
            currencyCode: "USD",
          },
        ],
      },
      scheduledTransactions: [
        {
          name: "Rent",
          amount: 1500,
          frequency: "MONTHLY",
          nextDueDate: "2026-03-01",
          categoryName: "Housing",
          isIncome: false,
          isTransfer: false,
        },
      ],
      incomePatterns: {
        monthlyIncome: [
          { month: "2025-03", total: 4000, sourceCount: 1 },
          { month: "2025-04", total: 4000, sourceCount: 1 },
        ],
        averageMonthlyIncome: 4000,
        incomeVariability: 0.05,
      },
      recurringCharges: [],
      ...overrides,
    };
  }

  function makeValidAiResponse() {
    return JSON.stringify({
      monthlyProjections: [
        {
          month: "2026-03",
          projectedIncome: 4000,
          projectedExpenses: 3200,
          projectedNetCashFlow: 800,
          projectedEndingBalance: 15800,
          confidenceLow: 14500,
          confidenceHigh: 17000,
          keyExpenses: [
            {
              description: "Rent",
              amount: 1500,
              category: "Housing",
              isRecurring: true,
              isIrregular: false,
            },
          ],
        },
        {
          month: "2026-04",
          projectedIncome: 4000,
          projectedExpenses: 3100,
          projectedNetCashFlow: 900,
          projectedEndingBalance: 16700,
          confidenceLow: 14800,
          confidenceHigh: 18500,
          keyExpenses: [],
        },
      ],
      riskFlags: [
        {
          month: "2026-05",
          severity: "warning",
          title: "Annual insurance premium due",
          description:
            "Your annual insurance premium of $1,200 is expected in May.",
        },
      ],
      narrativeSummary:
        "Your cash flow looks stable over the next 3 months with a projected ending balance of $16,700 by April.",
    });
  }

  const mockQb = () => {
    const qb: Record<string, jest.Mock> = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(null),
    };
    return qb;
  };

  beforeEach(async () => {
    const qb = mockQb();

    mockUsageLogRepo = {
      createQueryBuilder: jest.fn().mockReturnValue(qb),
    };

    mockPrefRepo = {
      findOne: jest.fn().mockResolvedValue({ defaultCurrency: "USD" }),
    };

    mockAiService = {
      complete: jest.fn().mockResolvedValue({
        content: makeValidAiResponse(),
        usage: { inputTokens: 800, outputTokens: 400 },
        model: "claude-sonnet-4-20250514",
        provider: "anthropic",
      }),
    };

    mockUsageService = {
      logUsage: jest.fn().mockResolvedValue({ id: "log-1" }),
    };

    mockAggregatorService = {
      computeAggregates: jest.fn().mockResolvedValue(makeAggregates()),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AiForecastService,
        {
          provide: getRepositoryToken(UserPreference),
          useValue: mockPrefRepo,
        },
        {
          provide: getRepositoryToken(AiUsageLog),
          useValue: mockUsageLogRepo,
        },
        { provide: AiService, useValue: mockAiService },
        { provide: AiUsageService, useValue: mockUsageService },
        {
          provide: ForecastAggregatorService,
          useValue: mockAggregatorService,
        },
      ],
    }).compile();

    service = module.get<AiForecastService>(AiForecastService);
  });

  describe("generateForecast()", () => {
    it("generates forecast successfully", async () => {
      const result = await service.generateForecast(userId);

      expect(result.currency).toBe("USD");
      expect(result.currentBalance).toBe(15000);
      expect(result.forecastMonths).toBe(3);
      expect(result.monthlyProjections).toHaveLength(2);
      expect(result.riskFlags).toHaveLength(1);
      expect(result.narrativeSummary).toBeTruthy();
      expect(result.generatedAt).toBeTruthy();
    });

    it("throws BadRequestException when forecast was recently generated", async () => {
      const qb = mockQb();
      qb.getOne.mockResolvedValue({
        id: "log-1",
        userId,
        feature: "forecast",
        createdAt: new Date(),
      });
      mockUsageLogRepo.createQueryBuilder.mockReturnValue(qb);

      await expect(service.generateForecast(userId)).rejects.toThrow(
        BadRequestException,
      );
      expect(mockAggregatorService.computeAggregates).not.toHaveBeenCalled();
    });

    it("uses default currency when no preferences exist", async () => {
      mockPrefRepo.findOne.mockResolvedValue(null);

      const result = await service.generateForecast(userId);

      expect(mockAggregatorService.computeAggregates).toHaveBeenCalledWith(
        userId,
        "USD",
      );
      expect(result.currency).toBe("USD");
    });

    it("passes months parameter correctly", async () => {
      const result = await service.generateForecast(userId, 6);

      expect(result.forecastMonths).toBe(6);
    });

    it("defaults to 3 months when months not specified", async () => {
      const result = await service.generateForecast(userId);

      expect(result.forecastMonths).toBe(3);
    });

    it("throws BadRequestException when insufficient history", async () => {
      mockAggregatorService.computeAggregates!.mockResolvedValue(
        makeAggregates({
          monthlyHistory: [
            {
              month: "2025-06",
              totalIncome: 4000,
              totalExpenses: 3000,
              netCashFlow: 1000,
              categoryBreakdown: [],
            },
          ],
        }),
      );

      await expect(service.generateForecast(userId)).rejects.toThrow(
        BadRequestException,
      );
      expect(mockAiService.complete).not.toHaveBeenCalled();
    });

    it("handles AI service failure gracefully", async () => {
      mockAiService.complete!.mockRejectedValue(new Error("Provider down"));

      await expect(service.generateForecast(userId)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("handles malformed AI response", async () => {
      mockAiService.complete!.mockResolvedValue({
        content: "This is not valid JSON at all",
        usage: { inputTokens: 100, outputTokens: 50 },
        model: "test",
        provider: "test",
      });

      await expect(service.generateForecast(userId)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("handles AI response without JSON object", async () => {
      mockAiService.complete!.mockResolvedValue({
        content: "I cannot generate a forecast.",
        usage: { inputTokens: 100, outputTokens: 50 },
        model: "test",
        provider: "test",
      });

      await expect(service.generateForecast(userId)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("validates monthly projections from AI response", async () => {
      mockAiService.complete!.mockResolvedValue({
        content: JSON.stringify({
          monthlyProjections: [
            {
              month: "2026-03",
              projectedIncome: 4000,
              projectedExpenses: 3000,
              projectedNetCashFlow: 1000,
              projectedEndingBalance: 16000,
              confidenceLow: 14000,
              confidenceHigh: 18000,
              keyExpenses: [],
            },
            {
              month: "invalid",
              projectedIncome: "not a number",
              projectedExpenses: 1000,
            },
          ],
          riskFlags: [],
          narrativeSummary: "Test.",
        }),
        usage: { inputTokens: 100, outputTokens: 50 },
        model: "test",
        provider: "test",
      });

      const result = await service.generateForecast(userId);

      // Invalid month format should be filtered out
      expect(result.monthlyProjections).toHaveLength(1);
      expect(result.monthlyProjections[0].month).toBe("2026-03");
    });

    it("validates risk flag severities from AI response", async () => {
      mockAiService.complete!.mockResolvedValue({
        content: JSON.stringify({
          monthlyProjections: [
            {
              month: "2026-03",
              projectedIncome: 4000,
              projectedExpenses: 3000,
              projectedNetCashFlow: 1000,
              projectedEndingBalance: 16000,
              confidenceLow: 14000,
              confidenceHigh: 18000,
              keyExpenses: [],
            },
          ],
          riskFlags: [
            {
              month: "2026-03",
              severity: "warning",
              title: "Valid flag",
              description: "This is valid.",
            },
            {
              month: "2026-03",
              severity: "critical",
              title: "Invalid severity",
              description: "Invalid.",
            },
          ],
          narrativeSummary: "Test.",
        }),
        usage: { inputTokens: 100, outputTokens: 50 },
        model: "test",
        provider: "test",
      });

      const result = await service.generateForecast(userId);

      expect(result.riskFlags).toHaveLength(1);
      expect(result.riskFlags[0].severity).toBe("warning");
    });

    it("truncates long narrative summary", async () => {
      const longNarrative = "A".repeat(6000);
      mockAiService.complete!.mockResolvedValue({
        content: JSON.stringify({
          monthlyProjections: [
            {
              month: "2026-03",
              projectedIncome: 4000,
              projectedExpenses: 3000,
              projectedNetCashFlow: 1000,
              projectedEndingBalance: 16000,
              confidenceLow: 14000,
              confidenceHigh: 18000,
              keyExpenses: [],
            },
          ],
          riskFlags: [],
          narrativeSummary: longNarrative,
        }),
        usage: { inputTokens: 100, outputTokens: 50 },
        model: "test",
        provider: "test",
      });

      const result = await service.generateForecast(userId);

      expect(result.narrativeSummary.length).toBe(5000);
    });

    it("calls aiService.complete with correct feature name", async () => {
      await service.generateForecast(userId);

      expect(mockAiService.complete).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          temperature: 0.3,
          maxTokens: 4096,
        }),
        "forecast",
      );
    });

    it("handles aggregator failure gracefully", async () => {
      mockAggregatorService.computeAggregates!.mockRejectedValue(
        new Error("Database error"),
      );

      await expect(service.generateForecast(userId)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("includes empty key expenses when AI returns non-array", async () => {
      mockAiService.complete!.mockResolvedValue({
        content: JSON.stringify({
          monthlyProjections: [
            {
              month: "2026-03",
              projectedIncome: 4000,
              projectedExpenses: 3000,
              projectedNetCashFlow: 1000,
              projectedEndingBalance: 16000,
              confidenceLow: 14000,
              confidenceHigh: 18000,
              keyExpenses: "not an array",
            },
          ],
          riskFlags: [],
          narrativeSummary: "Test.",
        }),
        usage: { inputTokens: 100, outputTokens: 50 },
        model: "test",
        provider: "test",
      });

      const result = await service.generateForecast(userId);

      expect(result.monthlyProjections[0].keyExpenses).toEqual([]);
    });

    it("handles missing narrativeSummary in AI response", async () => {
      mockAiService.complete!.mockResolvedValue({
        content: JSON.stringify({
          monthlyProjections: [
            {
              month: "2026-03",
              projectedIncome: 4000,
              projectedExpenses: 3000,
              projectedNetCashFlow: 1000,
              projectedEndingBalance: 16000,
              confidenceLow: 14000,
              confidenceHigh: 18000,
              keyExpenses: [],
            },
          ],
          riskFlags: [],
        }),
        usage: { inputTokens: 100, outputTokens: 50 },
        model: "test",
        provider: "test",
      });

      const result = await service.generateForecast(userId);

      expect(result.narrativeSummary).toBe("");
    });

    it("re-throws BadRequestException from aiService without wrapping", async () => {
      mockAiService.complete!.mockRejectedValue(
        new BadRequestException("No active AI providers configured"),
      );

      await expect(service.generateForecast(userId)).rejects.toThrow(
        "No active AI providers configured",
      );
    });
  });
});
