import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { NotFoundException } from "@nestjs/common";
import { AiInsightsService } from "./ai-insights.service";
import { AiInsight } from "../entities/ai-insight.entity";
import { AiService } from "../ai.service";
import { AiUsageService } from "../ai-usage.service";
import {
  InsightsAggregatorService,
  SpendingAggregates,
} from "./insights-aggregator.service";
import { ConfigService } from "@nestjs/config";
import { UserPreference } from "../../users/entities/user-preference.entity";

describe("AiInsightsService", () => {
  let service: AiInsightsService;

  let mockInsightRepo: Record<string, any>;
  let mockPrefRepo: Record<string, jest.Mock>;
  let mockAiService: Partial<Record<keyof AiService, jest.Mock>>;
  let mockUsageService: Partial<Record<keyof AiUsageService, jest.Mock>>;
  let mockAggregatorService: Partial<
    Record<keyof InsightsAggregatorService, jest.Mock>
  >;

  const userId = "user-1";
  const now = new Date();

  function makeInsight(overrides: Partial<AiInsight> = {}): AiInsight {
    const insight = new AiInsight();
    insight.id = "insight-1";
    insight.userId = userId;
    insight.type = "anomaly";
    insight.title = "High spending on Dining";
    insight.description = "Your dining spending is 80% above average.";
    insight.severity = "warning";
    insight.data = { categoryName: "Dining", currentAmount: 450 };
    insight.isDismissed = false;
    insight.generatedAt = now;
    insight.expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    insight.createdAt = now;
    Object.assign(insight, overrides);
    return insight;
  }

  function makeAggregates(
    overrides: Partial<SpendingAggregates> = {},
  ): SpendingAggregates {
    return {
      categorySpending: [
        {
          categoryName: "Dining",
          categoryId: "cat-1",
          currentMonthTotal: 450,
          previousMonthTotal: 250,
          averageMonthlyTotal: 250,
          monthCount: 6,
          transactionCount: 15,
        },
      ],
      monthlySpending: [
        {
          month: "2026-01",
          total: 2000,
          categoryBreakdown: [{ categoryName: "Dining", total: 250 }],
        },
      ],
      recurringCharges: [],
      totalSpendingCurrentMonth: 2500,
      totalSpendingPreviousMonth: 2000,
      averageMonthlySpending: 2100,
      daysElapsedInMonth: 18,
      daysInMonth: 28,
      currency: "USD",
      ...overrides,
    };
  }

  const mockQb = () => {
    const qb: Record<string, jest.Mock> = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
      getOne: jest.fn().mockResolvedValue(null),
      getRawOne: jest.fn().mockResolvedValue(null),
    };
    return qb;
  };

  beforeEach(async () => {
    const qb = mockQb();

    mockInsightRepo = {
      createQueryBuilder: jest.fn().mockReturnValue(qb),
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockImplementation((data) => ({ ...data })),
      save: jest.fn().mockImplementation((data) => Promise.resolve(data)),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      delete: jest.fn().mockResolvedValue({ affected: 0 }),
      remove: jest.fn().mockResolvedValue(undefined),
      manager: {
        createQueryBuilder: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnThis(),
          from: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          getRawMany: jest.fn().mockResolvedValue([]),
        }),
      },
    };

    mockPrefRepo = {
      findOne: jest.fn().mockResolvedValue({ defaultCurrency: "USD" }),
    };

    mockAiService = {
      complete: jest.fn().mockResolvedValue({
        content: JSON.stringify([
          {
            type: "anomaly",
            title: "High spending on Dining",
            description: "Your dining spending is 80% above average.",
            severity: "warning",
            data: { categoryName: "Dining", currentAmount: 450 },
          },
        ]),
        usage: { inputTokens: 500, outputTokens: 200 },
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
        AiInsightsService,
        {
          provide: getRepositoryToken(AiInsight),
          useValue: mockInsightRepo,
        },
        {
          provide: getRepositoryToken(UserPreference),
          useValue: mockPrefRepo,
        },
        { provide: AiService, useValue: mockAiService },
        { provide: AiUsageService, useValue: mockUsageService },
        {
          provide: InsightsAggregatorService,
          useValue: mockAggregatorService,
        },
        { provide: ConfigService, useValue: { get: jest.fn() } },
      ],
    }).compile();

    service = module.get<AiInsightsService>(AiInsightsService);
  });

  describe("getInsights()", () => {
    it("returns empty list when no insights exist", async () => {
      const result = await service.getInsights(userId);

      expect(result.insights).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.lastGeneratedAt).toBeNull();
      expect(result.isGenerating).toBe(false);
    });

    it("returns insights ordered by severity", async () => {
      const insights = [
        makeInsight({ id: "i1", severity: "info" }),
        makeInsight({ id: "i2", severity: "alert" }),
      ];

      const qb = mockQb();
      qb.getMany.mockResolvedValue(insights);
      mockInsightRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.getInsights(userId);

      expect(result.insights).toHaveLength(2);
      expect(result.insights[0].id).toBe("i1");
    });

    it("filters by type", async () => {
      const qb = mockQb();
      qb.getMany.mockResolvedValue([]);
      mockInsightRepo.createQueryBuilder.mockReturnValue(qb);

      await service.getInsights(userId, "anomaly");

      expect(qb.andWhere).toHaveBeenCalledWith("i.type = :type", {
        type: "anomaly",
      });
    });

    it("filters by severity", async () => {
      const qb = mockQb();
      qb.getMany.mockResolvedValue([]);
      mockInsightRepo.createQueryBuilder.mockReturnValue(qb);

      await service.getInsights(userId, undefined, "alert");

      expect(qb.andWhere).toHaveBeenCalledWith("i.severity = :severity", {
        severity: "alert",
      });
    });

    it("excludes dismissed by default", async () => {
      const qb = mockQb();
      qb.getMany.mockResolvedValue([]);
      mockInsightRepo.createQueryBuilder.mockReturnValue(qb);

      await service.getInsights(userId);

      expect(qb.andWhere).toHaveBeenCalledWith("i.isDismissed = false");
    });

    it("includes dismissed when requested", async () => {
      const qb = mockQb();
      qb.getMany.mockResolvedValue([]);
      mockInsightRepo.createQueryBuilder.mockReturnValue(qb);

      await service.getInsights(userId, undefined, undefined, true);

      const calls = qb.andWhere.mock.calls.map(
        (c: unknown[]) => c[0] as string,
      );
      expect(calls).not.toContain("i.isDismissed = false");
    });
  });

  describe("dismissInsight()", () => {
    it("dismisses an existing insight", async () => {
      const insight = makeInsight();
      mockInsightRepo.findOne.mockResolvedValue(insight);

      await service.dismissInsight(userId, "insight-1");

      expect(mockInsightRepo.update).toHaveBeenCalledWith(
        { id: "insight-1" },
        { isDismissed: true },
      );
    });

    it("throws NotFoundException for non-existent insight", async () => {
      mockInsightRepo.findOne.mockResolvedValue(null);

      await expect(
        service.dismissInsight(userId, "non-existent"),
      ).rejects.toThrow(NotFoundException);
    });

    it("throws NotFoundException when insight belongs to different user", async () => {
      mockInsightRepo.findOne.mockResolvedValue(null);

      await expect(
        service.dismissInsight("other-user", "insight-1"),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("generateInsights()", () => {
    it("skips generation if insights were recently generated", async () => {
      const qb = mockQb();
      qb.getOne.mockResolvedValue(makeInsight());
      qb.getMany.mockResolvedValue([makeInsight()]);
      qb.getRawOne.mockResolvedValue({ lastGenerated: now.toISOString() });
      mockInsightRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.generateInsights(userId);

      expect(mockAggregatorService.computeAggregates).not.toHaveBeenCalled();
      expect(result.insights).toHaveLength(1);
    });

    it("generates insights when no recent insights exist", async () => {
      const qb = mockQb();
      let callIndex = 0;
      qb.getOne.mockImplementation(() => {
        callIndex++;
        return Promise.resolve(callIndex === 1 ? null : null);
      });
      qb.getMany.mockResolvedValue([]);
      qb.getRawOne.mockResolvedValue(null);
      mockInsightRepo.createQueryBuilder.mockReturnValue(qb);

      await service.generateInsights(userId);

      expect(mockAggregatorService.computeAggregates).toHaveBeenCalledWith(
        userId,
        "USD",
      );
      expect(mockAiService.complete).toHaveBeenCalled();
      expect(mockInsightRepo.save).toHaveBeenCalled();
    });

    it("skips AI call when no spending data exists", async () => {
      const qb = mockQb();
      qb.getOne.mockResolvedValue(null);
      qb.getMany.mockResolvedValue([]);
      qb.getRawOne.mockResolvedValue(null);
      mockInsightRepo.createQueryBuilder.mockReturnValue(qb);

      mockAggregatorService.computeAggregates!.mockResolvedValue(
        makeAggregates({
          categorySpending: [],
          monthlySpending: [],
        }),
      );

      await service.generateInsights(userId);

      expect(mockAiService.complete).not.toHaveBeenCalled();
    });

    it("handles AI service failure gracefully", async () => {
      const qb = mockQb();
      qb.getOne.mockResolvedValue(null);
      qb.getMany.mockResolvedValue([]);
      qb.getRawOne.mockResolvedValue(null);
      mockInsightRepo.createQueryBuilder.mockReturnValue(qb);

      mockAiService.complete!.mockRejectedValue(new Error("Provider down"));

      const result = await service.generateInsights(userId);

      expect(result.insights).toEqual([]);
    });

    it("handles malformed AI response", async () => {
      const qb = mockQb();
      qb.getOne.mockResolvedValue(null);
      qb.getMany.mockResolvedValue([]);
      qb.getRawOne.mockResolvedValue(null);
      mockInsightRepo.createQueryBuilder.mockReturnValue(qb);

      mockAiService.complete!.mockResolvedValue({
        content: "This is not valid JSON",
        usage: { inputTokens: 100, outputTokens: 50 },
        model: "test",
        provider: "test",
      });

      const result = await service.generateInsights(userId);

      expect(mockInsightRepo.save).not.toHaveBeenCalled();
      expect(result.insights).toEqual([]);
    });

    it("validates insight types from AI response", async () => {
      const qb = mockQb();
      qb.getOne.mockResolvedValue(null);
      qb.getMany.mockResolvedValue([]);
      qb.getRawOne.mockResolvedValue(null);
      mockInsightRepo.createQueryBuilder.mockReturnValue(qb);

      mockAiService.complete!.mockResolvedValue({
        content: JSON.stringify([
          {
            type: "invalid_type",
            title: "Bad",
            description: "Bad insight",
            severity: "info",
            data: {},
          },
          {
            type: "anomaly",
            title: "Good",
            description: "Good insight",
            severity: "warning",
            data: {},
          },
        ]),
        usage: { inputTokens: 100, outputTokens: 50 },
        model: "test",
        provider: "test",
      });

      await service.generateInsights(userId);

      const savedInsights = mockInsightRepo.save.mock.calls[0]?.[0];
      if (savedInsights) {
        expect(savedInsights).toHaveLength(1);
        expect(savedInsights[0].type).toBe("anomaly");
      }
    });

    it("uses default currency when no preferences exist", async () => {
      const qb = mockQb();
      qb.getOne.mockResolvedValue(null);
      qb.getMany.mockResolvedValue([]);
      qb.getRawOne.mockResolvedValue(null);
      mockInsightRepo.createQueryBuilder.mockReturnValue(qb);
      mockPrefRepo.findOne.mockResolvedValue(null);

      await service.generateInsights(userId);

      expect(mockAggregatorService.computeAggregates).toHaveBeenCalledWith(
        userId,
        "USD",
      );
    });

    it("enforces max insights per user", async () => {
      const qb = mockQb();
      qb.getOne.mockResolvedValue(null);
      qb.getMany.mockResolvedValue([]);
      qb.getRawOne.mockResolvedValue(null);
      mockInsightRepo.createQueryBuilder.mockReturnValue(qb);
      mockInsightRepo.count.mockResolvedValue(55);
      mockInsightRepo.find.mockResolvedValue([
        makeInsight({ id: "old-1" }),
        makeInsight({ id: "old-2" }),
      ]);

      await service.generateInsights(userId);

      expect(mockInsightRepo.remove).toHaveBeenCalled();
    });
  });

  describe("handleDailyInsightGeneration()", () => {
    it("cleans up expired and old dismissed insights", async () => {
      mockInsightRepo.delete
        .mockResolvedValueOnce({ affected: 3 })
        .mockResolvedValueOnce({ affected: 2 });

      await service.handleDailyInsightGeneration();

      expect(mockInsightRepo.delete).toHaveBeenCalledTimes(2);
      // First call: expired insights
      expect(mockInsightRepo.delete).toHaveBeenCalledWith(
        expect.objectContaining({ expiresAt: expect.anything() }),
      );
      // Second call: dismissed insights older than 30 days
      expect(mockInsightRepo.delete).toHaveBeenCalledWith(
        expect.objectContaining({
          isDismissed: true,
          createdAt: expect.anything(),
        }),
      );
    });

    it("continues generating insights even if cleanup fails", async () => {
      mockInsightRepo.delete.mockRejectedValue(new Error("DB error"));

      await expect(
        service.handleDailyInsightGeneration(),
      ).resolves.not.toThrow();
    });
  });
});
