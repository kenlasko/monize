import { Test, TestingModule } from "@nestjs/testing";
import { BudgetsController } from "./budgets.controller";
import { BudgetsService } from "./budgets.service";
import { BudgetPeriodService } from "./budget-period.service";
import { BudgetGeneratorService } from "./budget-generator.service";
import { BudgetReportsService } from "./budget-reports.service";
import { BudgetBucketsService } from "./budget-buckets.service";
import { ParseUUIDPipe } from "@nestjs/common";
import { ROUTE_ARGS_METADATA } from "@nestjs/common/constants";
import { ALLOW_DELEGATE_KEY } from "../delegation/decorators/delegate-access.decorator";

describe("BudgetsController", () => {
  let controller: BudgetsController;
  let mockBudgetsService: Partial<Record<keyof BudgetsService, jest.Mock>>;
  let mockBudgetPeriodService: Partial<
    Record<keyof BudgetPeriodService, jest.Mock>
  >;
  let mockBudgetGeneratorService: Partial<
    Record<keyof BudgetGeneratorService, jest.Mock>
  >;
  let mockBudgetReportsService: Partial<
    Record<keyof BudgetReportsService, jest.Mock>
  >;
  let mockBudgetBucketsService: Partial<
    Record<keyof BudgetBucketsService, jest.Mock>
  >;
  const mockReq = { user: { id: "user-1" } };

  beforeEach(async () => {
    mockBudgetsService = {
      create: jest.fn(),
      findAll: jest.fn(),
      findOne: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
      addCategory: jest.fn(),
      addTransferIncomeLine: jest.fn(),
      updateCategory: jest.fn(),
      removeCategory: jest.fn(),
      bulkUpdateCategories: jest.fn(),
      getSummary: jest.fn(),
      getVelocity: jest.fn(),
      getDashboardSummary: jest.fn(),
      getCategoryBudgetStatus: jest.fn(),
    };

    mockBudgetBucketsService = {
      findAll: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
    };

    mockBudgetPeriodService = {
      findAll: jest.fn(),
      findOne: jest.fn(),
      closePeriod: jest.fn(),
    };

    mockBudgetGeneratorService = {
      generate: jest.fn(),
      apply: jest.fn(),
    };

    mockBudgetReportsService = {
      getTrend: jest.fn(),
      getCategoryTrend: jest.fn(),
      getHealthScore: jest.fn(),
      getSeasonalPatterns: jest.fn(),
      getFlexGroupStatus: jest.fn(),
      getBucketStatus: jest.fn(),
      getDailySpending: jest.fn(),
      getSavingsRate: jest.fn(),
      getHealthScoreHistory: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [BudgetsController],
      providers: [
        { provide: BudgetsService, useValue: mockBudgetsService },
        { provide: BudgetPeriodService, useValue: mockBudgetPeriodService },
        {
          provide: BudgetGeneratorService,
          useValue: mockBudgetGeneratorService,
        },
        {
          provide: BudgetReportsService,
          useValue: mockBudgetReportsService,
        },
        { provide: BudgetBucketsService, useValue: mockBudgetBucketsService },
      ],
    }).compile();

    controller = module.get<BudgetsController>(BudgetsController);
  });

  describe("bucket routes", () => {
    const proto = BudgetsController.prototype as unknown as Record<
      string,
      (...args: never[]) => unknown
    >;
    // The pipes Nest attaches to each @Param argument of a handler.
    const paramPipes = (method: string): Record<string, unknown[]> => {
      const args = Reflect.getMetadata(
        ROUTE_ARGS_METADATA,
        BudgetsController,
        method,
      ) as Record<string, { data: string; pipes: unknown[] }>;
      return Object.fromEntries(
        Object.values(args)
          .filter((a) => a.data !== undefined)
          .map((a) => [a.data, a.pipes]),
      );
    };

    it.each([
      ["findBuckets", ["id"]],
      ["createBucket", ["id"]],
      ["updateBucket", ["id", "bucketId"]],
      ["removeBucket", ["id", "bucketId"]],
    ])("%s pins ParseUUIDPipe on every id", (method, params) => {
      const pipes = paramPipes(method);
      expect(Object.keys(pipes).sort()).toEqual([...params].sort());
      for (const p of params) expect(pipes[p]).toContain(ParseUUIDPipe);
    });

    it("only the GET is open to a delegate", () => {
      expect(Reflect.getMetadata(ALLOW_DELEGATE_KEY, proto.findBuckets)).toBe(
        true,
      );
      for (const m of ["createBucket", "updateBucket", "removeBucket"]) {
        expect(
          Reflect.getMetadata(ALLOW_DELEGATE_KEY, proto[m]),
        ).toBeUndefined();
      }
    });

    it("findBuckets delegates with userId and id", () => {
      mockBudgetBucketsService.findAll!.mockReturnValue("list");
      expect(controller.findBuckets(mockReq, "b-1")).toBe("list");
      expect(mockBudgetBucketsService.findAll).toHaveBeenCalledWith(
        "user-1",
        "b-1",
      );
    });

    it("createBucket delegates with userId, id and dto", () => {
      const dto = { name: "Needs" } as never;
      mockBudgetBucketsService.create!.mockReturnValue("made");
      expect(controller.createBucket(mockReq, "b-1", dto)).toBe("made");
      expect(mockBudgetBucketsService.create).toHaveBeenCalledWith(
        "user-1",
        "b-1",
        dto,
      );
    });

    it("updateBucket delegates with both ids", () => {
      const dto = { sortOrder: 1 } as never;
      mockBudgetBucketsService.update!.mockReturnValue("changed");
      expect(controller.updateBucket(mockReq, "b-1", "k-1", dto)).toBe(
        "changed",
      );
      expect(mockBudgetBucketsService.update).toHaveBeenCalledWith(
        "user-1",
        "b-1",
        "k-1",
        dto,
      );
    });

    it("removeBucket delegates with both ids", () => {
      mockBudgetBucketsService.remove!.mockReturnValue("gone");
      expect(controller.removeBucket(mockReq, "b-1", "k-1")).toBe("gone");
      expect(mockBudgetBucketsService.remove).toHaveBeenCalledWith(
        "user-1",
        "b-1",
        "k-1",
      );
    });
  });

  describe("create()", () => {
    it("delegates to budgetsService.create with userId and dto", () => {
      const dto = {
        name: "Budget",
        periodStart: "2026-02-01",
        currencyCode: "USD",
      } as any;
      mockBudgetsService.create!.mockReturnValue("created");

      const result = controller.create(mockReq, dto);

      expect(result).toBe("created");
      expect(mockBudgetsService.create).toHaveBeenCalledWith("user-1", dto);
    });
  });

  describe("findAll()", () => {
    it("delegates to budgetsService.findAll with userId", () => {
      mockBudgetsService.findAll!.mockReturnValue("budgets");

      const result = controller.findAll(mockReq);

      expect(result).toBe("budgets");
      expect(mockBudgetsService.findAll).toHaveBeenCalledWith("user-1");
    });
  });

  describe("findOne()", () => {
    it("delegates to budgetsService.findOne with userId and id", () => {
      mockBudgetsService.findOne!.mockReturnValue("budget");

      const result = controller.findOne(mockReq, "budget-1");

      expect(result).toBe("budget");
      expect(mockBudgetsService.findOne).toHaveBeenCalledWith(
        "user-1",
        "budget-1",
      );
    });
  });

  describe("update()", () => {
    it("delegates to budgetsService.update with userId, id, and dto", () => {
      const dto = { name: "Updated" } as any;
      mockBudgetsService.update!.mockReturnValue("updated");

      const result = controller.update(mockReq, "budget-1", dto);

      expect(result).toBe("updated");
      expect(mockBudgetsService.update).toHaveBeenCalledWith(
        "user-1",
        "budget-1",
        dto,
      );
    });
  });

  describe("remove()", () => {
    it("delegates to budgetsService.remove with userId and id", () => {
      mockBudgetsService.remove!.mockReturnValue("removed");

      const result = controller.remove(mockReq, "budget-1");

      expect(result).toBe("removed");
      expect(mockBudgetsService.remove).toHaveBeenCalledWith(
        "user-1",
        "budget-1",
      );
    });
  });

  describe("addTransferIncomeLine()", () => {
    it("delegates to budgetsService.addTransferIncomeLine with the JWT's user", () => {
      const dto = { transferAccountId: "acct-hisa", amount: 2000 };
      mockBudgetsService.addTransferIncomeLine!.mockReturnValue("added");

      const result = controller.addTransferIncomeLine(mockReq, "budget-1", dto);

      expect(result).toBe("added");
      expect(mockBudgetsService.addTransferIncomeLine).toHaveBeenCalledWith(
        mockReq.user.id,
        "budget-1",
        dto,
      );
    });
  });

  describe("addCategory()", () => {
    it("delegates to budgetsService.addCategory", () => {
      const dto = { categoryId: "cat-1", amount: 500 } as any;
      mockBudgetsService.addCategory!.mockReturnValue("added");

      const result = controller.addCategory(mockReq, "budget-1", dto);

      expect(result).toBe("added");
      expect(mockBudgetsService.addCategory).toHaveBeenCalledWith(
        "user-1",
        "budget-1",
        dto,
      );
    });
  });

  describe("updateCategory()", () => {
    it("delegates to budgetsService.updateCategory", () => {
      const dto = { amount: 600 } as any;
      mockBudgetsService.updateCategory!.mockReturnValue("updated");

      const result = controller.updateCategory(
        mockReq,
        "budget-1",
        "bc-1",
        dto,
      );

      expect(result).toBe("updated");
      expect(mockBudgetsService.updateCategory).toHaveBeenCalledWith(
        "user-1",
        "budget-1",
        "bc-1",
        dto,
      );
    });
  });

  describe("removeCategory()", () => {
    it("delegates to budgetsService.removeCategory", () => {
      mockBudgetsService.removeCategory!.mockReturnValue("removed");

      const result = controller.removeCategory(mockReq, "budget-1", "bc-1");

      expect(result).toBe("removed");
      expect(mockBudgetsService.removeCategory).toHaveBeenCalledWith(
        "user-1",
        "budget-1",
        "bc-1",
      );
    });
  });

  describe("bulkUpdateCategories()", () => {
    it("delegates to budgetsService.bulkUpdateCategories", () => {
      const dto = {
        categories: [
          { id: "bc-1", amount: 600 },
          { id: "bc-2", amount: 300 },
        ],
      };
      mockBudgetsService.bulkUpdateCategories!.mockReturnValue("bulk-updated");

      const result = controller.bulkUpdateCategories(mockReq, "budget-1", dto);

      expect(result).toBe("bulk-updated");
      expect(mockBudgetsService.bulkUpdateCategories).toHaveBeenCalledWith(
        "user-1",
        "budget-1",
        dto.categories,
      );
    });
  });

  describe("getSummary()", () => {
    it("delegates to budgetsService.getSummary", () => {
      mockBudgetsService.getSummary!.mockReturnValue("summary");

      const result = controller.getSummary(mockReq, "budget-1");

      expect(result).toBe("summary");
      expect(mockBudgetsService.getSummary).toHaveBeenCalledWith(
        "user-1",
        "budget-1",
      );
    });
  });

  describe("getVelocity()", () => {
    it("delegates to budgetsService.getVelocity", () => {
      mockBudgetsService.getVelocity!.mockReturnValue("velocity");

      const result = controller.getVelocity(mockReq, "budget-1");

      expect(result).toBe("velocity");
      expect(mockBudgetsService.getVelocity).toHaveBeenCalledWith(
        "user-1",
        "budget-1",
      );
    });
  });

  describe("getPeriods()", () => {
    it("delegates to budgetPeriodService.findAll", () => {
      mockBudgetPeriodService.findAll!.mockReturnValue("periods");

      const result = controller.getPeriods(mockReq, "budget-1");

      expect(result).toBe("periods");
      expect(mockBudgetPeriodService.findAll).toHaveBeenCalledWith(
        "user-1",
        "budget-1",
      );
    });
  });

  describe("getPeriodDetail()", () => {
    it("delegates to budgetPeriodService.findOne", () => {
      mockBudgetPeriodService.findOne!.mockReturnValue("period-detail");

      const result = controller.getPeriodDetail(
        mockReq,
        "budget-1",
        "period-1",
      );

      expect(result).toBe("period-detail");
      expect(mockBudgetPeriodService.findOne).toHaveBeenCalledWith(
        "user-1",
        "budget-1",
        "period-1",
      );
    });
  });

  describe("closePeriod()", () => {
    it("delegates to budgetPeriodService.closePeriod", () => {
      mockBudgetPeriodService.closePeriod!.mockReturnValue("closed");

      const result = controller.closePeriod(mockReq, "budget-1");

      expect(result).toBe("closed");
      expect(mockBudgetPeriodService.closePeriod).toHaveBeenCalledWith(
        "user-1",
        "budget-1",
      );
    });
  });

  describe("generate()", () => {
    it("delegates to budgetGeneratorService.generate with userId and dto", () => {
      const dto = { analysisMonths: 6 } as any;
      mockBudgetGeneratorService.generate!.mockReturnValue("suggestions");

      const result = controller.generate(mockReq, dto);

      expect(result).toBe("suggestions");
      expect(mockBudgetGeneratorService.generate).toHaveBeenCalledWith(
        "user-1",
        dto,
      );
    });
  });

  describe("applyGenerated()", () => {
    it("delegates to budgetGeneratorService.apply with userId and dto", () => {
      const dto = {
        name: "Budget",
        periodStart: "2026-02-01",
        currencyCode: "USD",
        categories: [{ categoryId: "cat-1", amount: 500 }],
      } as any;
      mockBudgetGeneratorService.apply!.mockReturnValue("applied");

      const result = controller.applyGenerated(mockReq, dto);

      expect(result).toBe("applied");
      expect(mockBudgetGeneratorService.apply).toHaveBeenCalledWith(
        "user-1",
        dto,
      );
    });
  });

  describe("getTrend()", () => {
    it("delegates to budgetReportsService.getTrend with default months", () => {
      mockBudgetReportsService.getTrend!.mockReturnValue("trend");

      const result = controller.getTrend(mockReq, "budget-1", {} as any);

      expect(result).toBe("trend");
      expect(mockBudgetReportsService.getTrend).toHaveBeenCalledWith(
        "user-1",
        "budget-1",
        6,
      );
    });

    it("delegates to budgetReportsService.getTrend with specified months", () => {
      mockBudgetReportsService.getTrend!.mockReturnValue("trend-12");

      const result = controller.getTrend(mockReq, "budget-1", {
        months: 12,
      } as any);

      expect(result).toBe("trend-12");
      expect(mockBudgetReportsService.getTrend).toHaveBeenCalledWith(
        "user-1",
        "budget-1",
        12,
      );
    });
  });

  describe("getCategoryTrend()", () => {
    it("delegates to budgetReportsService.getCategoryTrend", () => {
      mockBudgetReportsService.getCategoryTrend!.mockReturnValue("cat-trend");

      const query = { months: 3, categoryIds: ["cat-1", "cat-2"] } as any;
      const result = controller.getCategoryTrend(mockReq, "budget-1", query);

      expect(result).toBe("cat-trend");
      expect(mockBudgetReportsService.getCategoryTrend).toHaveBeenCalledWith(
        "user-1",
        "budget-1",
        3,
        ["cat-1", "cat-2"],
      );
    });
  });

  describe("getHealthScore()", () => {
    it("delegates to budgetReportsService.getHealthScore", () => {
      mockBudgetReportsService.getHealthScore!.mockReturnValue("health");

      const result = controller.getHealthScore(mockReq, "budget-1");

      expect(result).toBe("health");
      expect(mockBudgetReportsService.getHealthScore).toHaveBeenCalledWith(
        "user-1",
        "budget-1",
      );
    });
  });

  describe("getSeasonalPatterns()", () => {
    it("delegates to budgetReportsService.getSeasonalPatterns", () => {
      mockBudgetReportsService.getSeasonalPatterns!.mockReturnValue("seasonal");

      const result = controller.getSeasonalPatterns(mockReq, "budget-1");

      expect(result).toBe("seasonal");
      expect(mockBudgetReportsService.getSeasonalPatterns).toHaveBeenCalledWith(
        "user-1",
        "budget-1",
      );
    });
  });

  describe("getFlexGroupStatus()", () => {
    it("delegates to budgetReportsService.getFlexGroupStatus", () => {
      mockBudgetReportsService.getFlexGroupStatus!.mockReturnValue(
        "flex-groups",
      );

      const result = controller.getFlexGroupStatus(mockReq, "budget-1");

      expect(result).toBe("flex-groups");
      expect(mockBudgetReportsService.getFlexGroupStatus).toHaveBeenCalledWith(
        "user-1",
        "budget-1",
      );
    });
  });

  describe("getBucketStatus()", () => {
    it("pins ParseUUIDPipe on the id and is open to a delegate", () => {
      const args = Reflect.getMetadata(
        ROUTE_ARGS_METADATA,
        BudgetsController,
        "getBucketStatus",
      ) as Record<string, { data: string; pipes: unknown[] }>;
      const idArg = Object.values(args).find((a) => a.data === "id");
      expect(idArg?.pipes).toContain(ParseUUIDPipe);
      expect(
        Reflect.getMetadata(
          ALLOW_DELEGATE_KEY,
          BudgetsController.prototype.getBucketStatus,
        ),
      ).toBe(true);
    });

    it("delegates to budgetReportsService.getBucketStatus", () => {
      mockBudgetReportsService.getBucketStatus!.mockReturnValue(
        "bucket-status",
      );

      const result = controller.getBucketStatus(mockReq, "budget-1");

      expect(result).toBe("bucket-status");
      expect(mockBudgetReportsService.getBucketStatus).toHaveBeenCalledWith(
        "user-1",
        "budget-1",
      );
    });
  });

  describe("getDashboardSummary()", () => {
    it("delegates to budgetsService.getDashboardSummary", () => {
      mockBudgetsService.getDashboardSummary!.mockReturnValue("summary");

      const result = controller.getDashboardSummary(mockReq);

      expect(result).toBe("summary");
      expect(mockBudgetsService.getDashboardSummary).toHaveBeenCalledWith(
        "user-1",
      );
    });
  });

  describe("getCategoryBudgetStatus()", () => {
    it("converts the returned Map to a plain object", async () => {
      const map = new Map<string, unknown>([
        ["cat-1", { spent: 100 }],
        ["cat-2", { spent: 200 }],
      ]);
      mockBudgetsService.getCategoryBudgetStatus!.mockResolvedValue(map);

      const result = await controller.getCategoryBudgetStatus(mockReq, {
        categoryIds: ["cat-1", "cat-2"],
      } as any);

      expect(mockBudgetsService.getCategoryBudgetStatus).toHaveBeenCalledWith(
        "user-1",
        ["cat-1", "cat-2"],
      );
      expect(result).toEqual({
        "cat-1": { spent: 100 },
        "cat-2": { spent: 200 },
      });
    });
  });

  describe("getDailySpending()", () => {
    it("delegates to budgetReportsService.getDailySpending", () => {
      mockBudgetReportsService.getDailySpending!.mockReturnValue("daily");

      const result = controller.getDailySpending(mockReq, "budget-1");

      expect(result).toBe("daily");
      expect(mockBudgetReportsService.getDailySpending).toHaveBeenCalledWith(
        "user-1",
        "budget-1",
      );
    });
  });

  describe("getSavingsRate()", () => {
    it("uses the default 12 months when none specified", () => {
      mockBudgetReportsService.getSavingsRate!.mockReturnValue("rate-12");

      const result = controller.getSavingsRate(mockReq, "budget-1", {} as any);

      expect(result).toBe("rate-12");
      expect(mockBudgetReportsService.getSavingsRate).toHaveBeenCalledWith(
        "user-1",
        "budget-1",
        12,
      );
    });

    it("forwards specified months", () => {
      mockBudgetReportsService.getSavingsRate!.mockReturnValue("rate-6");

      const result = controller.getSavingsRate(mockReq, "budget-1", {
        months: 6,
      } as any);

      expect(result).toBe("rate-6");
      expect(mockBudgetReportsService.getSavingsRate).toHaveBeenCalledWith(
        "user-1",
        "budget-1",
        6,
      );
    });
  });

  describe("getHealthScoreHistory()", () => {
    it("uses the default 12 months when none specified", () => {
      mockBudgetReportsService.getHealthScoreHistory!.mockReturnValue("hist");

      const result = controller.getHealthScoreHistory(
        mockReq,
        "budget-1",
        {} as any,
      );

      expect(result).toBe("hist");
      expect(
        mockBudgetReportsService.getHealthScoreHistory,
      ).toHaveBeenCalledWith("user-1", "budget-1", 12);
    });

    it("forwards specified months", () => {
      mockBudgetReportsService.getHealthScoreHistory!.mockReturnValue("h-3");

      const result = controller.getHealthScoreHistory(mockReq, "budget-1", {
        months: 3,
      } as any);

      expect(result).toBe("h-3");
      expect(
        mockBudgetReportsService.getHealthScoreHistory,
      ).toHaveBeenCalledWith("user-1", "budget-1", 3);
    });
  });

  // ─── Default-fallback branch coverage ─────────────────────────────────

  describe("getCategoryTrend default months", () => {
    it("uses default 6 when months not provided", () => {
      mockBudgetReportsService.getCategoryTrend!.mockReturnValue("ct");
      controller.getCategoryTrend(mockReq, "budget-1", {} as never);
      expect(mockBudgetReportsService.getCategoryTrend).toHaveBeenCalledWith(
        "user-1",
        "budget-1",
        6,
        undefined,
      );
    });
  });

  describe("getSavingsRate default months", () => {
    it("uses default 12 when months not provided", () => {
      mockBudgetReportsService.getSavingsRate!.mockReturnValue("sr");
      controller.getSavingsRate(mockReq, "budget-1", {} as never);
      expect(mockBudgetReportsService.getSavingsRate).toHaveBeenCalledWith(
        "user-1",
        "budget-1",
        12,
      );
    });

    it("uses provided months", () => {
      mockBudgetReportsService.getSavingsRate!.mockReturnValue("sr");
      controller.getSavingsRate(mockReq, "budget-1", { months: 6 } as never);
      expect(mockBudgetReportsService.getSavingsRate).toHaveBeenCalledWith(
        "user-1",
        "budget-1",
        6,
      );
    });
  });
});
