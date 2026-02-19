import { Test, TestingModule } from "@nestjs/testing";
import { BudgetsController } from "./budgets.controller";
import { BudgetsService } from "./budgets.service";
import { BudgetPeriodService } from "./budget-period.service";
import { BudgetGeneratorService } from "./budget-generator.service";
import { BudgetReportsService } from "./budget-reports.service";

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
  const mockReq = { user: { id: "user-1" } };

  beforeEach(async () => {
    mockBudgetsService = {
      create: jest.fn(),
      findAll: jest.fn(),
      findOne: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
      addCategory: jest.fn(),
      updateCategory: jest.fn(),
      removeCategory: jest.fn(),
      bulkUpdateCategories: jest.fn(),
      getSummary: jest.fn(),
      getVelocity: jest.fn(),
      getAlerts: jest.fn(),
      markAlertRead: jest.fn(),
      markAllAlertsRead: jest.fn(),
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
      ],
    }).compile();

    controller = module.get<BudgetsController>(BudgetsController);
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

  describe("getAlerts()", () => {
    it("delegates to budgetsService.getAlerts with unreadOnly", () => {
      mockBudgetsService.getAlerts!.mockReturnValue("alerts");

      const result = controller.getAlerts(mockReq, true);

      expect(result).toBe("alerts");
      expect(mockBudgetsService.getAlerts).toHaveBeenCalledWith("user-1", true);
    });

    it("defaults unreadOnly to false when undefined", () => {
      mockBudgetsService.getAlerts!.mockReturnValue("alerts");

      controller.getAlerts(mockReq, undefined);

      expect(mockBudgetsService.getAlerts).toHaveBeenCalledWith(
        "user-1",
        false,
      );
    });
  });

  describe("markAlertRead()", () => {
    it("delegates to budgetsService.markAlertRead", () => {
      mockBudgetsService.markAlertRead!.mockReturnValue("read");

      const result = controller.markAlertRead(mockReq, "alert-1");

      expect(result).toBe("read");
      expect(mockBudgetsService.markAlertRead).toHaveBeenCalledWith(
        "user-1",
        "alert-1",
      );
    });
  });

  describe("markAllAlertsRead()", () => {
    it("delegates to budgetsService.markAllAlertsRead", () => {
      mockBudgetsService.markAllAlertsRead!.mockReturnValue("all-read");

      const result = controller.markAllAlertsRead(mockReq);

      expect(result).toBe("all-read");
      expect(mockBudgetsService.markAllAlertsRead).toHaveBeenCalledWith(
        "user-1",
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
      expect(
        mockBudgetReportsService.getSeasonalPatterns,
      ).toHaveBeenCalledWith("user-1", "budget-1");
    });
  });

  describe("getFlexGroupStatus()", () => {
    it("delegates to budgetReportsService.getFlexGroupStatus", () => {
      mockBudgetReportsService.getFlexGroupStatus!.mockReturnValue(
        "flex-groups",
      );

      const result = controller.getFlexGroupStatus(mockReq, "budget-1");

      expect(result).toBe("flex-groups");
      expect(
        mockBudgetReportsService.getFlexGroupStatus,
      ).toHaveBeenCalledWith("user-1", "budget-1");
    });
  });
});
