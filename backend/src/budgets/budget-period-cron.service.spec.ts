import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { BudgetPeriodCronService } from "./budget-period-cron.service";
import { BudgetPeriodService } from "./budget-period.service";
import { Budget, BudgetType, BudgetStrategy } from "./entities/budget.entity";
import { BudgetPeriod, PeriodStatus } from "./entities/budget-period.entity";

describe("BudgetPeriodCronService", () => {
  let service: BudgetPeriodCronService;
  let budgetsRepository: Record<string, jest.Mock>;
  let periodsRepository: Record<string, jest.Mock>;
  let budgetPeriodService: Record<string, jest.Mock>;

  const mockBudget: Budget = {
    id: "budget-1",
    userId: "user-1",
    name: "Monthly Budget",
    description: null,
    budgetType: BudgetType.MONTHLY,
    periodStart: "2026-01-01",
    periodEnd: null,
    baseIncome: 5000,
    incomeLinked: false,
    strategy: BudgetStrategy.FIXED,
    isActive: true,
    currencyCode: "USD",
    config: {},
    categories: [],
    periods: [],
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
  };

  const mockOpenPeriod: BudgetPeriod = {
    id: "period-1",
    budgetId: "budget-1",
    budget: mockBudget,
    periodStart: "2026-01-01",
    periodEnd: "2026-01-31",
    actualIncome: 0,
    actualExpenses: 0,
    totalBudgeted: 3000,
    status: PeriodStatus.OPEN,
    periodCategories: [],
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
  };

  beforeEach(async () => {
    budgetsRepository = {
      find: jest.fn().mockResolvedValue([]),
    };

    periodsRepository = {
      findOne: jest.fn().mockResolvedValue(null),
    };

    budgetPeriodService = {
      closePeriod: jest.fn().mockResolvedValue({}),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BudgetPeriodCronService,
        {
          provide: getRepositoryToken(Budget),
          useValue: budgetsRepository,
        },
        {
          provide: getRepositoryToken(BudgetPeriod),
          useValue: periodsRepository,
        },
        {
          provide: BudgetPeriodService,
          useValue: budgetPeriodService,
        },
      ],
    }).compile();

    service = module.get<BudgetPeriodCronService>(BudgetPeriodCronService);
  });

  describe("closeExpiredPeriods", () => {
    it("does nothing when no active budgets exist", async () => {
      budgetsRepository.find.mockResolvedValue([]);

      await service.closeExpiredPeriods();

      expect(budgetsRepository.find).toHaveBeenCalledWith({
        where: { isActive: true },
      });
      expect(periodsRepository.findOne).not.toHaveBeenCalled();
      expect(budgetPeriodService.closePeriod).not.toHaveBeenCalled();
    });

    it("skips budgets with no open period", async () => {
      budgetsRepository.find.mockResolvedValue([mockBudget]);
      periodsRepository.findOne.mockResolvedValue(null);

      await service.closeExpiredPeriods();

      expect(periodsRepository.findOne).toHaveBeenCalledWith({
        where: { budgetId: "budget-1", status: PeriodStatus.OPEN },
      });
      expect(budgetPeriodService.closePeriod).not.toHaveBeenCalled();
    });

    it("closes period when period end date has passed", async () => {
      const pastPeriod = {
        ...mockOpenPeriod,
        periodEnd: "2025-12-31",
      };
      budgetsRepository.find.mockResolvedValue([mockBudget]);
      periodsRepository.findOne.mockResolvedValue(pastPeriod);

      await service.closeExpiredPeriods();

      expect(budgetPeriodService.closePeriod).toHaveBeenCalledWith(
        "user-1",
        "budget-1",
      );
    });

    it("does not close period when period end date is in the future", async () => {
      const futurePeriod = {
        ...mockOpenPeriod,
        periodEnd: "2099-12-31",
      };
      budgetsRepository.find.mockResolvedValue([mockBudget]);
      periodsRepository.findOne.mockResolvedValue(futurePeriod);

      await service.closeExpiredPeriods();

      expect(budgetPeriodService.closePeriod).not.toHaveBeenCalled();
    });

    it("handles multiple budgets and closes only expired ones", async () => {
      const budget2: Budget = {
        ...mockBudget,
        id: "budget-2",
        userId: "user-2",
        name: "Second Budget",
      };

      budgetsRepository.find.mockResolvedValue([mockBudget, budget2]);

      periodsRepository.findOne
        .mockResolvedValueOnce({
          ...mockOpenPeriod,
          periodEnd: "2025-12-31",
        })
        .mockResolvedValueOnce({
          ...mockOpenPeriod,
          budgetId: "budget-2",
          periodEnd: "2099-12-31",
        });

      await service.closeExpiredPeriods();

      expect(budgetPeriodService.closePeriod).toHaveBeenCalledTimes(1);
      expect(budgetPeriodService.closePeriod).toHaveBeenCalledWith(
        "user-1",
        "budget-1",
      );
    });

    it("continues processing other budgets when one fails", async () => {
      const budget2: Budget = {
        ...mockBudget,
        id: "budget-2",
        userId: "user-2",
        name: "Second Budget",
      };

      budgetsRepository.find.mockResolvedValue([mockBudget, budget2]);

      periodsRepository.findOne
        .mockResolvedValueOnce({
          ...mockOpenPeriod,
          periodEnd: "2025-12-31",
        })
        .mockResolvedValueOnce({
          ...mockOpenPeriod,
          budgetId: "budget-2",
          periodEnd: "2025-11-30",
        });

      budgetPeriodService.closePeriod
        .mockRejectedValueOnce(new Error("Database error"))
        .mockResolvedValueOnce({});

      await service.closeExpiredPeriods();

      expect(budgetPeriodService.closePeriod).toHaveBeenCalledTimes(2);
      expect(budgetPeriodService.closePeriod).toHaveBeenCalledWith(
        "user-2",
        "budget-2",
      );
    });

    it("handles error when fetching active budgets", async () => {
      budgetsRepository.find.mockRejectedValue(new Error("Connection error"));

      await expect(service.closeExpiredPeriods()).resolves.not.toThrow();

      expect(budgetPeriodService.closePeriod).not.toHaveBeenCalled();
    });

    it("closes all expired periods across multiple budgets", async () => {
      const budget2: Budget = {
        ...mockBudget,
        id: "budget-2",
        userId: "user-2",
        name: "Second Budget",
      };

      budgetsRepository.find.mockResolvedValue([mockBudget, budget2]);

      periodsRepository.findOne
        .mockResolvedValueOnce({
          ...mockOpenPeriod,
          periodEnd: "2025-12-31",
        })
        .mockResolvedValueOnce({
          ...mockOpenPeriod,
          budgetId: "budget-2",
          periodEnd: "2025-11-30",
        });

      await service.closeExpiredPeriods();

      expect(budgetPeriodService.closePeriod).toHaveBeenCalledTimes(2);
      expect(budgetPeriodService.closePeriod).toHaveBeenCalledWith(
        "user-1",
        "budget-1",
      );
      expect(budgetPeriodService.closePeriod).toHaveBeenCalledWith(
        "user-2",
        "budget-2",
      );
    });
  });
});
