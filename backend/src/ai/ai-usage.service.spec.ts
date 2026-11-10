import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { AiUsageService } from "./ai-usage.service";
import { AiUsageLog } from "./entities/ai-usage-log.entity";
import { AiProviderConfig } from "./entities/ai-provider-config.entity";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { UserPreference } from "../users/entities/user-preference.entity";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

describe("AiUsageService", () => {
  let service: AiUsageService;
  let mockRepository: Record<string, jest.Mock>;
  let mockConfigRepository: Record<string, jest.Mock>;
  let scopedDb: ReturnType<typeof createScopedDbMocks>;

  const mockQueryBuilder = {
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    addGroupBy: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue([]),
    getRawOne: jest.fn().mockResolvedValue({
      totalRequests: "0",
      totalInputTokens: "0",
      totalOutputTokens: "0",
    }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    mockRepository = {
      create: jest
        .fn()
        .mockImplementation((data) => ({ ...data, id: "log-1" })),
      save: jest
        .fn()
        .mockImplementation((data) =>
          Promise.resolve({ ...data, id: "log-1" }),
        ),
      find: jest.fn().mockResolvedValue([]),
      delete: jest.fn().mockResolvedValue({ affected: 0 }),
      createQueryBuilder: jest.fn().mockReturnValue(mockQueryBuilder),
    };

    mockConfigRepository = {
      find: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AiUsageService,
        {
          provide: DataSource,
          useValue: (scopedDb = createScopedDbMocks([
            [AiUsageLog, mockRepository],
            [AiProviderConfig, mockConfigRepository],
            // The reader reports in USD, the configs' default cost currency.
            [
              UserPreference,
              {
                findOne: jest
                  .fn()
                  .mockResolvedValue({ defaultCurrency: "USD" }),
              },
            ],
          ])).dataSource,
        },
      ],
    }).compile();

    service = module.get<AiUsageService>(AiUsageService);
  });

  describe("logUsage()", () => {
    it("creates and saves a usage log", async () => {
      const params = {
        userId: "user-1",
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        feature: "categorize",
        inputTokens: 100,
        outputTokens: 50,
        durationMs: 1200,
      };

      const result = await service.logUsage(params);

      expect(mockRepository.create).toHaveBeenCalledWith({
        userId: "user-1",
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        feature: "categorize",
        inputTokens: 100,
        outputTokens: 50,
        durationMs: 1200,
        error: null,
      });
      expect(mockRepository.save).toHaveBeenCalled();
      expect(result.id).toBe("log-1");
    });

    it("stores error message when provided", async () => {
      await service.logUsage({
        userId: "user-1",
        provider: "openai",
        model: "gpt-4o",
        feature: "query",
        inputTokens: 0,
        outputTokens: 0,
        durationMs: 500,
        error: "Rate limit exceeded",
      });

      expect(mockRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ error: "Rate limit exceeded" }),
      );
    });
  });

  describe("getUsageSummary()", () => {
    it("returns aggregated usage summary", async () => {
      const summary = await service.getUsageSummary("user-1");

      expect(summary).toEqual({
        totalRequests: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalEstimatedCostByCurrency: {},
        reportingCurrency: "USD",
        totalEstimatedCostInReportingCurrency: 0,
        byProvider: [],
        byFeature: [],
        recentLogs: [],
      });
    });

    it("passes days filter when provided", async () => {
      await service.getUsageSummary("user-1", 30);

      expect(mockQueryBuilder.andWhere).toHaveBeenCalled();
    });

    it("maps recent logs with all fields", async () => {
      const mockLog = {
        id: "log-1",
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        feature: "categorize",
        inputTokens: 100,
        outputTokens: 50,
        durationMs: 1200,
        createdAt: new Date("2024-06-15T12:00:00Z"),
      };
      mockRepository.find.mockResolvedValueOnce([mockLog]);

      const summary = await service.getUsageSummary("user-1");

      expect(summary.recentLogs).toHaveLength(1);
      expect(summary.recentLogs[0]).toEqual({
        id: "log-1",
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        feature: "categorize",
        inputTokens: 100,
        outputTokens: 50,
        durationMs: 1200,
        estimatedCost: null,
        costCurrency: null,
        estimatedCostInReportingCurrency: null,
        createdAt: "2024-06-15T12:00:00.000Z",
      });
    });

    it("parses provider and feature aggregations", async () => {
      mockQueryBuilder.getRawMany
        .mockResolvedValueOnce([
          {
            provider: "anthropic",
            model: "claude-sonnet-4-20250514",
            requests: "5",
            inputTokens: "500",
            outputTokens: "250",
          },
        ])
        .mockResolvedValueOnce([
          {
            feature: "categorize",
            provider: "anthropic",
            model: "claude-sonnet-4-20250514",
            requests: "3",
            inputTokens: "300",
            outputTokens: "150",
          },
        ]);
      mockQueryBuilder.getRawOne.mockResolvedValueOnce({
        totalRequests: "5",
        totalInputTokens: "500",
        totalOutputTokens: "250",
      });

      const summary = await service.getUsageSummary("user-1");

      expect(summary.totalRequests).toBe(5);
      expect(summary.totalInputTokens).toBe(500);
      expect(summary.totalOutputTokens).toBe(250);
      expect(summary.totalEstimatedCostByCurrency).toEqual({});
      expect(summary.byProvider).toEqual([
        {
          provider: "anthropic",
          requests: 5,
          inputTokens: 500,
          outputTokens: 250,
          estimatedCostByCurrency: {},
          estimatedCostInReportingCurrency: 0,
        },
      ]);
      expect(summary.byFeature).toEqual([
        {
          feature: "categorize",
          requests: 3,
          inputTokens: 300,
          outputTokens: 150,
          estimatedCostByCurrency: {},
          estimatedCostInReportingCurrency: 0,
        },
      ]);
    });

    it("computes estimated cost from configured rates", async () => {
      // User configured Anthropic Sonnet with $3 input / $15 output per 1M tokens.
      mockConfigRepository.find.mockResolvedValueOnce([
        {
          provider: "anthropic",
          model: "claude-sonnet-4-20250514",
          inputCostPer1M: 3,
          outputCostPer1M: 15,
          costCurrency: "USD",
        },
      ]);
      mockQueryBuilder.getRawMany
        .mockResolvedValueOnce([
          {
            provider: "anthropic",
            model: "claude-sonnet-4-20250514",
            requests: "2",
            // 1,000,000 input tokens * $3 + 500,000 output tokens * $15 / 1M = $3 + $7.5 = $10.5
            inputTokens: "1000000",
            outputTokens: "500000",
          },
        ])
        .mockResolvedValueOnce([]);
      mockQueryBuilder.getRawOne.mockResolvedValueOnce({
        totalRequests: "2",
        totalInputTokens: "1000000",
        totalOutputTokens: "500000",
      });
      mockRepository.find.mockResolvedValueOnce([
        {
          id: "log-1",
          provider: "anthropic",
          model: "claude-sonnet-4-20250514",
          feature: "query",
          inputTokens: 1000000,
          outputTokens: 500000,
          durationMs: 1200,
          createdAt: new Date("2024-06-15T12:00:00Z"),
        },
      ]);

      const summary = await service.getUsageSummary("user-1");

      expect(summary.totalEstimatedCostByCurrency).toEqual({ USD: 10.5 });
      expect(summary.byProvider[0].estimatedCostByCurrency).toEqual({
        USD: 10.5,
      });
      expect(summary.recentLogs[0].estimatedCost).toBe(10.5);
      expect(summary.recentLogs[0].costCurrency).toBe("USD");
    });

    it("buckets estimated cost by configured rate currency", async () => {
      // Two configs with different billing currencies -- costs should not merge.
      mockConfigRepository.find.mockResolvedValueOnce([
        {
          provider: "anthropic",
          model: "claude-sonnet-4-20250514",
          inputCostPer1M: 3,
          outputCostPer1M: 15,
          costCurrency: "USD",
        },
        {
          provider: "openai",
          model: "gpt-4o",
          inputCostPer1M: 2,
          outputCostPer1M: 8,
          costCurrency: "EUR",
        },
      ]);
      mockQueryBuilder.getRawMany
        .mockResolvedValueOnce([
          {
            provider: "anthropic",
            model: "claude-sonnet-4-20250514",
            requests: "1",
            // 1M input * $3 + 0 = $3
            inputTokens: "1000000",
            outputTokens: "0",
          },
          {
            provider: "openai",
            model: "gpt-4o",
            requests: "1",
            // 1M input * €2 + 0 = €2
            inputTokens: "1000000",
            outputTokens: "0",
          },
        ])
        .mockResolvedValueOnce([]);

      const summary = await service.getUsageSummary("user-1");

      expect(summary.totalEstimatedCostByCurrency).toEqual({
        USD: 3,
        EUR: 2,
      });
    });

    it("converts each day's cost into the reporting currency at that day's rate (issue #2106)", async () => {
      mockConfigRepository.find.mockResolvedValueOnce([
        {
          provider: "openai",
          model: "gpt-4o",
          inputCostPer1M: 2,
          outputCostPer1M: 0,
          costCurrency: "EUR",
        },
      ]);
      mockQueryBuilder.getRawMany
        .mockResolvedValueOnce([
          // 2 EUR in January at 1.05 and 2 EUR in June at 1.15.
          {
            provider: "openai",
            model: "gpt-4o",
            day: "2025-01-15",
            requests: "1",
            inputTokens: "1000000",
            outputTokens: "0",
          },
          {
            provider: "openai",
            model: "gpt-4o",
            day: "2025-06-15",
            requests: "1",
            inputTokens: "1000000",
            outputTokens: "0",
          },
        ])
        .mockResolvedValueOnce([]);
      scopedDb.manager.query.mockResolvedValue([
        {
          from_currency: "EUR",
          to_currency: "USD",
          rate: "1.05",
          rate_date: "2025-01-10",
        },
        {
          from_currency: "EUR",
          to_currency: "USD",
          rate: "1.15",
          rate_date: "2025-06-10",
        },
      ]);

      const summary = await service.getUsageSummary("user-1");

      expect(summary.totalEstimatedCostByCurrency).toEqual({ EUR: 4 });
      expect(summary.reportingCurrency).toBe("USD");
      expect(summary.byProvider[0].estimatedCostInReportingCurrency).toBe(4.4);
      expect(summary.totalEstimatedCostInReportingCurrency).toBe(4.4);
    });

    it("returns empty bucket when provider/model has no configured rate", async () => {
      mockConfigRepository.find.mockResolvedValueOnce([
        {
          provider: "anthropic",
          model: "claude-opus-4-20250514",
          inputCostPer1M: 15,
          outputCostPer1M: 75,
          costCurrency: "USD",
        },
      ]);
      // Log uses a different model than the configured one -- no match, no cost.
      mockQueryBuilder.getRawMany
        .mockResolvedValueOnce([
          {
            provider: "anthropic",
            model: "claude-sonnet-4-20250514",
            requests: "1",
            inputTokens: "1000",
            outputTokens: "500",
          },
        ])
        .mockResolvedValueOnce([]);

      const summary = await service.getUsageSummary("user-1");

      expect(summary.totalEstimatedCostByCurrency).toEqual({});
      expect(summary.byProvider[0].estimatedCostByCurrency).toEqual({});
    });
  });

  describe("purgeOldUsageLogs()", () => {
    it("deletes usage logs older than 30 days", async () => {
      mockRepository.delete.mockResolvedValue({ affected: 10 });

      await service.purgeOldUsageLogs();

      expect(mockRepository.delete).toHaveBeenCalledWith(
        expect.objectContaining({ createdAt: expect.anything() }),
      );
    });

    it("does not log when no logs purged", async () => {
      mockRepository.delete.mockResolvedValue({ affected: 0 });

      await service.purgeOldUsageLogs();

      expect(mockRepository.delete).toHaveBeenCalled();
    });

    it("handles errors gracefully", async () => {
      mockRepository.delete.mockRejectedValue(new Error("DB error"));

      await expect(service.purgeOldUsageLogs()).resolves.not.toThrow();
    });
  });
});
