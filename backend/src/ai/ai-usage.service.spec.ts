import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { AiUsageService } from "./ai-usage.service";
import { AiUsageLog } from "./entities/ai-usage-log.entity";

describe("AiUsageService", () => {
  let service: AiUsageService;
  let mockRepository: Record<string, jest.Mock>;

  const mockQueryBuilder = {
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AiUsageService,
        {
          provide: getRepositoryToken(AiUsageLog),
          useValue: mockRepository,
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
        createdAt: "2024-06-15T12:00:00.000Z",
      });
    });

    it("parses provider and feature aggregations", async () => {
      mockQueryBuilder.getRawMany
        .mockResolvedValueOnce([
          {
            provider: "anthropic",
            requests: "5",
            inputTokens: "500",
            outputTokens: "250",
          },
        ])
        .mockResolvedValueOnce([
          {
            feature: "categorize",
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
      expect(summary.byProvider).toEqual([
        {
          provider: "anthropic",
          requests: 5,
          inputTokens: 500,
          outputTokens: 250,
        },
      ]);
      expect(summary.byFeature).toEqual([
        {
          feature: "categorize",
          requests: 3,
          inputTokens: 300,
          outputTokens: 150,
        },
      ]);
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
