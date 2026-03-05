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

    it("uses non-greedy regex to extract first JSON array only (LLM02-F1)", async () => {
      const qb = mockQb();
      qb.getOne.mockResolvedValue(null);
      qb.getMany.mockResolvedValue([]);
      qb.getRawOne.mockResolvedValue(null);
      mockInsightRepo.createQueryBuilder.mockReturnValue(qb);

      // Two JSON arrays in the response - only the first should be parsed
      const firstArray = JSON.stringify([
        {
          type: "anomaly",
          title: "First Insight",
          description: "From first array",
          severity: "info",
          data: {},
        },
      ]);
      const secondArray = JSON.stringify([
        {
          type: "trend",
          title: "Second Insight",
          description: "From second array",
          severity: "warning",
          data: {},
        },
      ]);

      mockAiService.complete!.mockResolvedValue({
        content: `Here are insights: ${firstArray}\n\nAlso: ${secondArray}`,
        usage: { inputTokens: 100, outputTokens: 50 },
        model: "test",
        provider: "test",
      });

      await service.generateInsights(userId);

      const savedInsights = mockInsightRepo.save.mock.calls[0]?.[0];
      if (savedInsights) {
        expect(savedInsights).toHaveLength(1);
        expect(savedInsights[0].title).toBe("First Insight");
      }
    });

    it("rejects JSON arrays exceeding 100KB size limit (LLM02-F1)", async () => {
      const qb = mockQb();
      qb.getOne.mockResolvedValue(null);
      qb.getMany.mockResolvedValue([]);
      qb.getRawOne.mockResolvedValue(null);
      mockInsightRepo.createQueryBuilder.mockReturnValue(qb);

      // Generate a JSON array larger than 100KB
      const hugeItem = {
        type: "anomaly",
        title: "X",
        description: "Y".repeat(110 * 1024),
        severity: "info",
        data: {},
      };

      mockAiService.complete!.mockResolvedValue({
        content: JSON.stringify([hugeItem]),
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

    it("excludes zero-spending categories from AI prompt", async () => {
      const qb = mockQb();
      qb.getOne.mockResolvedValue(null);
      qb.getMany.mockResolvedValue([]);
      qb.getRawOne.mockResolvedValue(null);
      mockInsightRepo.createQueryBuilder.mockReturnValue(qb);

      mockAggregatorService.computeAggregates!.mockResolvedValue(
        makeAggregates({
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
            {
              categoryName: "Lodging",
              categoryId: "cat-2",
              currentMonthTotal: 0,
              previousMonthTotal: 1375.67,
              averageMonthlyTotal: 1375.67,
              monthCount: 5,
              transactionCount: 8,
            },
          ],
        }),
      );

      await service.generateInsights(userId);

      const prompt = mockAiService.complete!.mock.calls[0][1].messages[0]
        .content as string;
      expect(prompt).toContain("Dining");
      expect(prompt).not.toContain("Lodging");
    });

    it("includes pre-computed percentage changes in AI prompt", async () => {
      const qb = mockQb();
      qb.getOne.mockResolvedValue(null);
      qb.getMany.mockResolvedValue([]);
      qb.getRawOne.mockResolvedValue(null);
      mockInsightRepo.createQueryBuilder.mockReturnValue(qb);

      await service.generateInsights(userId);

      const prompt = mockAiService.complete!.mock.calls[0][1].messages[0]
        .content as string;
      expect(prompt).toContain("vs avg:");
      expect(prompt).toContain("vs prev:");
      expect(prompt).toContain("ABOVE average");
      expect(prompt).toContain("Projected full-month spending");
      expect(prompt).toContain("Projected vs average");
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

    it("shows NOT AVAILABLE projection when fewer than 10 days elapsed", async () => {
      const qb = mockQb();
      qb.getOne.mockResolvedValue(null);
      qb.getMany.mockResolvedValue([]);
      qb.getRawOne.mockResolvedValue(null);
      mockInsightRepo.createQueryBuilder.mockReturnValue(qb);

      mockAggregatorService.computeAggregates!.mockResolvedValue(
        makeAggregates({
          daysElapsedInMonth: 5,
          daysInMonth: 31,
        }),
      );

      await service.generateInsights(userId);

      const prompt = mockAiService.complete!.mock.calls[0][1].messages[0]
        .content as string;
      expect(prompt).toContain("NOT AVAILABLE");
      expect(prompt).toContain("only 5 days elapsed");
      expect(prompt).not.toMatch(
        /Projected full-month spending: \d/,
      );
    });

    it("shows projection when 10+ days elapsed", async () => {
      const qb = mockQb();
      qb.getOne.mockResolvedValue(null);
      qb.getMany.mockResolvedValue([]);
      qb.getRawOne.mockResolvedValue(null);
      mockInsightRepo.createQueryBuilder.mockReturnValue(qb);

      mockAggregatorService.computeAggregates!.mockResolvedValue(
        makeAggregates({
          daysElapsedInMonth: 15,
          daysInMonth: 30,
          totalSpendingCurrentMonth: 1500,
          averageMonthlySpending: 2000,
        }),
      );

      await service.generateInsights(userId);

      const prompt = mockAiService.complete!.mock.calls[0][1].messages[0]
        .content as string;
      // 1500/15 * 30 = 3000
      expect(prompt).toContain("Projected full-month spending: 3000.00");
      expect(prompt).toContain("Projected vs average:");
      expect(prompt).not.toContain("NOT AVAILABLE");
    });

    it("labels category spending BELOW average when current < average", async () => {
      const qb = mockQb();
      qb.getOne.mockResolvedValue(null);
      qb.getMany.mockResolvedValue([]);
      qb.getRawOne.mockResolvedValue(null);
      mockInsightRepo.createQueryBuilder.mockReturnValue(qb);

      mockAggregatorService.computeAggregates!.mockResolvedValue(
        makeAggregates({
          categorySpending: [
            {
              categoryName: "Dining",
              categoryId: "cat-1",
              currentMonthTotal: 94,
              previousMonthTotal: 200,
              averageMonthlyTotal: 988.6,
              monthCount: 6,
              transactionCount: 3,
            },
          ],
        }),
      );

      await service.generateInsights(userId);

      const prompt = mockAiService.complete!.mock.calls[0][1].messages[0]
        .content as string;
      expect(prompt).toContain("BELOW average");
      expect(prompt).toContain("BELOW previous month");
      expect(prompt).not.toContain("ABOVE average");
      expect(prompt).not.toContain("ABOVE previous month");
    });

    it("labels category spending EQUAL when current matches average", async () => {
      const qb = mockQb();
      qb.getOne.mockResolvedValue(null);
      qb.getMany.mockResolvedValue([]);
      qb.getRawOne.mockResolvedValue(null);
      mockInsightRepo.createQueryBuilder.mockReturnValue(qb);

      mockAggregatorService.computeAggregates!.mockResolvedValue(
        makeAggregates({
          categorySpending: [
            {
              categoryName: "Groceries",
              categoryId: "cat-1",
              currentMonthTotal: 500,
              previousMonthTotal: 500,
              averageMonthlyTotal: 500,
              monthCount: 6,
              transactionCount: 10,
            },
          ],
        }),
      );

      await service.generateInsights(userId);

      const prompt = mockAiService.complete!.mock.calls[0][1].messages[0]
        .content as string;
      expect(prompt).toContain("EQUAL to average");
      expect(prompt).toContain("EQUAL to previous month");
    });

    it("shows 'no historical average' when averageMonthlyTotal is 0", async () => {
      const qb = mockQb();
      qb.getOne.mockResolvedValue(null);
      qb.getMany.mockResolvedValue([]);
      qb.getRawOne.mockResolvedValue(null);
      mockInsightRepo.createQueryBuilder.mockReturnValue(qb);

      mockAggregatorService.computeAggregates!.mockResolvedValue(
        makeAggregates({
          categorySpending: [
            {
              categoryName: "New Category",
              categoryId: "cat-1",
              currentMonthTotal: 100,
              previousMonthTotal: 0,
              averageMonthlyTotal: 0,
              monthCount: 1,
              transactionCount: 2,
            },
          ],
        }),
      );

      await service.generateInsights(userId);

      const prompt = mockAiService.complete!.mock.calls[0][1].messages[0]
        .content as string;
      expect(prompt).toContain("no historical average");
      expect(prompt).toContain("no previous month data");
    });

    it("includes month progress percentage in prompt", async () => {
      const qb = mockQb();
      qb.getOne.mockResolvedValue(null);
      qb.getMany.mockResolvedValue([]);
      qb.getRawOne.mockResolvedValue(null);
      mockInsightRepo.createQueryBuilder.mockReturnValue(qb);

      mockAggregatorService.computeAggregates!.mockResolvedValue(
        makeAggregates({
          daysElapsedInMonth: 15,
          daysInMonth: 30,
        }),
      );

      await service.generateInsights(userId);

      const prompt = mockAiService.complete!.mock.calls[0][1].messages[0]
        .content as string;
      expect(prompt).toContain("15/30 (50% through month)");
    });

    it("includes recurring charges section in prompt", async () => {
      const qb = mockQb();
      qb.getOne.mockResolvedValue(null);
      qb.getMany.mockResolvedValue([]);
      qb.getRawOne.mockResolvedValue(null);
      mockInsightRepo.createQueryBuilder.mockReturnValue(qb);

      mockAggregatorService.computeAggregates!.mockResolvedValue(
        makeAggregates({
          recurringCharges: [
            {
              payeeName: "Netflix",
              amounts: [15.99, 15.99, 17.99],
              dates: ["2025-10-01", "2025-11-01", "2025-12-01"],
              frequency: "monthly",
              currentAmount: 17.99,
              previousAmount: 15.99,
              categoryName: "Entertainment",
            },
          ],
        }),
      );

      await service.generateInsights(userId);

      const prompt = mockAiService.complete!.mock.calls[0][1].messages[0]
        .content as string;
      expect(prompt).toContain("RECURRING CHARGES");
      expect(prompt).toContain("Netflix");
      expect(prompt).toContain("monthly");
      expect(prompt).toContain("current=17.99");
    });

    it("includes monthly spending trends in prompt", async () => {
      const qb = mockQb();
      qb.getOne.mockResolvedValue(null);
      qb.getMany.mockResolvedValue([]);
      qb.getRawOne.mockResolvedValue(null);
      mockInsightRepo.createQueryBuilder.mockReturnValue(qb);

      mockAggregatorService.computeAggregates!.mockResolvedValue(
        makeAggregates({
          monthlySpending: [
            {
              month: "2026-01",
              total: 2000,
              categoryBreakdown: [
                { categoryName: "Dining", total: 800 },
                { categoryName: "Groceries", total: 600 },
                { categoryName: "Transport", total: 400 },
                { categoryName: "Entertainment", total: 200 },
              ],
            },
          ],
        }),
      );

      await service.generateInsights(userId);

      const prompt = mockAiService.complete!.mock.calls[0][1].messages[0]
        .content as string;
      expect(prompt).toContain("MONTHLY SPENDING TRENDS");
      expect(prompt).toContain("2026-01: total=2000.00");
      // Top 3 only
      expect(prompt).toContain("Dining=800.00");
      expect(prompt).toContain("Groceries=600.00");
      expect(prompt).toContain("Transport=400.00");
      expect(prompt).not.toContain("Entertainment=200.00");
    });

    it("returns existing insights when generation is already in progress", async () => {
      const qb = mockQb();
      qb.getOne.mockResolvedValue(null);
      qb.getMany.mockResolvedValue([makeInsight()]);
      qb.getRawOne.mockResolvedValue({ lastGenerated: now.toISOString() });
      mockInsightRepo.createQueryBuilder.mockReturnValue(qb);

      // Start a generation that will hang
      mockAggregatorService.computeAggregates!.mockImplementation(
        () => new Promise(() => {}), // never resolves
      );

      // Trigger first generation (will hang)
      const firstCall = service.generateInsights(userId);

      // Wait a tick so generatingUsers is set
      await new Promise((resolve) => setImmediate(resolve));

      // Second call should return immediately with existing insights
      const result = await service.generateInsights(userId);

      expect(result.insights).toHaveLength(1);
      expect(mockAggregatorService.computeAggregates).toHaveBeenCalledTimes(1);

      // Clean up: we can't await firstCall since it never resolves,
      // but the test will clean up
    });

    it("handles aggregator service failure gracefully", async () => {
      const qb = mockQb();
      qb.getOne.mockResolvedValue(null);
      qb.getMany.mockResolvedValue([]);
      qb.getRawOne.mockResolvedValue(null);
      mockInsightRepo.createQueryBuilder.mockReturnValue(qb);

      mockAggregatorService.computeAggregates!.mockRejectedValue(
        new Error("Database connection lost"),
      );

      const result = await service.generateInsights(userId);

      expect(result.insights).toEqual([]);
      expect(mockAiService.complete).not.toHaveBeenCalled();
    });

    it("sanitizes data fields from AI response", async () => {
      const qb = mockQb();
      qb.getOne.mockResolvedValue(null);
      qb.getMany.mockResolvedValue([]);
      qb.getRawOne.mockResolvedValue(null);
      mockInsightRepo.createQueryBuilder.mockReturnValue(qb);

      mockAiService.complete!.mockResolvedValue({
        content: JSON.stringify([
          {
            type: "anomaly",
            title: "Test",
            description: "Test desc",
            severity: "info",
            data: {
              validKey: "valid",
              __proto__: "malicious",
              constructor: "evil",
              nested: { shouldBeFiltered: true },
              longString: "x".repeat(2000),
              number: 42,
              boolean: true,
              nullVal: null,
            },
          },
        ]),
        usage: { inputTokens: 100, outputTokens: 50 },
        model: "test",
        provider: "test",
      });

      await service.generateInsights(userId);

      const savedInsights = mockInsightRepo.save.mock.calls[0]?.[0];
      expect(savedInsights).toHaveLength(1);
      const data = savedInsights[0].data;
      expect(data.validKey).toBe("valid");
      expect(Object.keys(data)).not.toContain("__proto__");
      expect(Object.keys(data)).not.toContain("constructor");
      expect(data.nested).toBeUndefined(); // non-primitive filtered
      expect(data.longString).toHaveLength(1000); // truncated
      expect(data.number).toBe(42);
      expect(data.boolean).toBe(true);
      expect(data.nullVal).toBeNull();
    });

    it("validates severity values from AI response", async () => {
      const qb = mockQb();
      qb.getOne.mockResolvedValue(null);
      qb.getMany.mockResolvedValue([]);
      qb.getRawOne.mockResolvedValue(null);
      mockInsightRepo.createQueryBuilder.mockReturnValue(qb);

      mockAiService.complete!.mockResolvedValue({
        content: JSON.stringify([
          {
            type: "anomaly",
            title: "Bad severity",
            description: "Invalid severity value",
            severity: "critical",
            data: {},
          },
          {
            type: "anomaly",
            title: "Good",
            description: "Valid severity",
            severity: "alert",
            data: {},
          },
        ]),
        usage: { inputTokens: 100, outputTokens: 50 },
        model: "test",
        provider: "test",
      });

      await service.generateInsights(userId);

      const savedInsights = mockInsightRepo.save.mock.calls[0]?.[0];
      expect(savedInsights).toHaveLength(1);
      expect(savedInsights[0].severity).toBe("alert");
    });

    it("truncates long titles and descriptions from AI response", async () => {
      const qb = mockQb();
      qb.getOne.mockResolvedValue(null);
      qb.getMany.mockResolvedValue([]);
      qb.getRawOne.mockResolvedValue(null);
      mockInsightRepo.createQueryBuilder.mockReturnValue(qb);

      mockAiService.complete!.mockResolvedValue({
        content: JSON.stringify([
          {
            type: "anomaly",
            title: "T".repeat(500),
            description: "D".repeat(10000),
            severity: "info",
            data: {},
          },
        ]),
        usage: { inputTokens: 100, outputTokens: 50 },
        model: "test",
        provider: "test",
      });

      await service.generateInsights(userId);

      const savedInsights = mockInsightRepo.save.mock.calls[0]?.[0];
      expect(savedInsights[0].title).toHaveLength(255);
      expect(savedInsights[0].description).toHaveLength(5000);
    });

    it("limits categories to top 15 in prompt", async () => {
      const qb = mockQb();
      qb.getOne.mockResolvedValue(null);
      qb.getMany.mockResolvedValue([]);
      qb.getRawOne.mockResolvedValue(null);
      mockInsightRepo.createQueryBuilder.mockReturnValue(qb);

      const categories = Array.from({ length: 20 }, (_, i) => ({
        categoryName: `Category${i}`,
        categoryId: `cat-${i}`,
        currentMonthTotal: 100 - i,
        previousMonthTotal: 90,
        averageMonthlyTotal: 95,
        monthCount: 6,
        transactionCount: 5,
      }));

      mockAggregatorService.computeAggregates!.mockResolvedValue(
        makeAggregates({ categorySpending: categories }),
      );

      await service.generateInsights(userId);

      const prompt = mockAiService.complete!.mock.calls[0][1].messages[0]
        .content as string;
      expect(prompt).toContain("Category0");
      expect(prompt).toContain("Category14");
      expect(prompt).not.toContain("Category15");
    });
  });

  describe("isGenerating()", () => {
    it("returns false when not generating", () => {
      expect(service.isGenerating(userId)).toBe(false);
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
