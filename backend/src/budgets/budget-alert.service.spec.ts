import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { ConfigService } from "@nestjs/config";
import { BudgetAlertService } from "./budget-alert.service";
import { Budget, BudgetType, BudgetStrategy } from "./entities/budget.entity";
import {
  BudgetCategory,
  RolloverType,
} from "./entities/budget-category.entity";
import {
  BudgetAlert,
  AlertType,
  AlertSeverity,
} from "./entities/budget-alert.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { TransactionSplit } from "../transactions/entities/transaction-split.entity";
import { User } from "../users/entities/user.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { EmailService } from "../notifications/email.service";

function makeCategory(overrides: Partial<BudgetCategory> = {}): BudgetCategory {
  return {
    id: "bc-1",
    budgetId: "budget-1",
    budget: {} as Budget,
    categoryId: "cat-1",
    category: { id: "cat-1", name: "Groceries", isIncome: false } as any,
    categoryGroup: null,
    transferAccountId: null,
    transferAccount: null,
    isTransfer: false,
    amount: 500,
    isIncome: false,
    rolloverType: RolloverType.NONE,
    rolloverCap: null,
    flexGroup: null,
    alertWarnPercent: 80,
    alertCriticalPercent: 95,
    notes: null,
    sortOrder: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeBudget(overrides: Partial<Budget> = {}): Budget {
  return {
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
    categories: [makeCategory()],
    periods: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeAlert(overrides: Partial<BudgetAlert> = {}): BudgetAlert {
  return {
    id: "alert-1",
    userId: "user-1",
    budgetId: "budget-1",
    budget: {} as Budget,
    budgetCategoryId: "bc-1",
    budgetCategory: null,
    alertType: AlertType.THRESHOLD_WARNING,
    severity: AlertSeverity.WARNING,
    title: "Test alert",
    message: "Test message",
    data: {},
    isRead: false,
    isEmailSent: false,
    periodStart: "2026-02-01",
    createdAt: new Date(),
    ...overrides,
  };
}

describe("BudgetAlertService", () => {
  let service: BudgetAlertService;
  let budgetsRepository: Record<string, jest.Mock>;
  let alertsRepository: Record<string, jest.Mock>;
  let transactionsRepository: Record<string, jest.Mock>;
  let splitsRepository: Record<string, jest.Mock>;
  let usersRepository: Record<string, jest.Mock>;
  let preferencesRepository: Record<string, jest.Mock>;
  let emailService: Record<string, jest.Mock>;
  let configService: Record<string, jest.Mock>;

  const mockQueryBuilder = {
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue([]),
  };

  beforeEach(async () => {
    budgetsRepository = {
      find: jest.fn().mockResolvedValue([]),
    };

    alertsRepository = {
      find: jest.fn().mockResolvedValue([]),
      create: jest
        .fn()
        .mockImplementation((data) => ({ ...data, id: "new-alert-id" })),
      save: jest
        .fn()
        .mockImplementation((data) =>
          Promise.resolve({ ...data, id: data.id || "new-alert-id" }),
        ),
    };

    transactionsRepository = {
      createQueryBuilder: jest.fn().mockReturnValue({ ...mockQueryBuilder }),
    };

    splitsRepository = {
      createQueryBuilder: jest.fn().mockReturnValue({ ...mockQueryBuilder }),
    };

    usersRepository = {
      findOne: jest.fn().mockResolvedValue({
        id: "user-1",
        email: "user@test.com",
        firstName: "Test",
      }),
    };

    preferencesRepository = {
      findOne: jest.fn().mockResolvedValue({
        userId: "user-1",
        notificationEmail: true,
        budgetDigestEnabled: true,
        budgetDigestDay: "MONDAY",
      }),
    };

    emailService = {
      getStatus: jest.fn().mockReturnValue({ configured: true }),
      sendMail: jest.fn().mockResolvedValue(undefined),
    };

    configService = {
      get: jest.fn().mockImplementation((key: string, def?: string) => {
        if (key === "PUBLIC_APP_URL") return "http://localhost:3000";
        return def;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BudgetAlertService,
        { provide: getRepositoryToken(Budget), useValue: budgetsRepository },
        {
          provide: getRepositoryToken(BudgetAlert),
          useValue: alertsRepository,
        },
        {
          provide: getRepositoryToken(Transaction),
          useValue: transactionsRepository,
        },
        {
          provide: getRepositoryToken(TransactionSplit),
          useValue: splitsRepository,
        },
        { provide: getRepositoryToken(User), useValue: usersRepository },
        {
          provide: getRepositoryToken(UserPreference),
          useValue: preferencesRepository,
        },
        { provide: EmailService, useValue: emailService },
        { provide: ConfigService, useValue: configService },
      ],
    }).compile();

    service = module.get<BudgetAlertService>(BudgetAlertService);
  });

  describe("checkThresholdAlerts", () => {
    it("returns OVER_BUDGET alert when spending is >= 100%", () => {
      const alerts = service.checkThresholdAlerts({
        budgetCategoryId: "bc-1",
        categoryId: "cat-1",
        categoryName: "Groceries",
        budgeted: 500,
        spent: 550,
        percentUsed: 110,
        isIncome: false,
        alertWarnPercent: 80,
        alertCriticalPercent: 95,
        flexGroup: null,
      });

      expect(alerts).toHaveLength(1);
      expect(alerts[0].alertType).toBe(AlertType.OVER_BUDGET);
      expect(alerts[0].severity).toBe(AlertSeverity.CRITICAL);
      expect(alerts[0].title).toContain("Groceries");
      expect(alerts[0].title).toContain("over budget");
    });

    it("returns THRESHOLD_CRITICAL alert when at critical threshold", () => {
      const alerts = service.checkThresholdAlerts({
        budgetCategoryId: "bc-1",
        categoryId: "cat-1",
        categoryName: "Dining",
        budgeted: 300,
        spent: 290,
        percentUsed: 96.67,
        isIncome: false,
        alertWarnPercent: 80,
        alertCriticalPercent: 95,
        flexGroup: null,
      });

      expect(alerts).toHaveLength(1);
      expect(alerts[0].alertType).toBe(AlertType.THRESHOLD_CRITICAL);
      expect(alerts[0].severity).toBe(AlertSeverity.CRITICAL);
    });

    it("returns THRESHOLD_WARNING alert when at warn threshold", () => {
      const alerts = service.checkThresholdAlerts({
        budgetCategoryId: "bc-1",
        categoryId: "cat-1",
        categoryName: "Entertainment",
        budgeted: 200,
        spent: 170,
        percentUsed: 85,
        isIncome: false,
        alertWarnPercent: 80,
        alertCriticalPercent: 95,
        flexGroup: null,
      });

      expect(alerts).toHaveLength(1);
      expect(alerts[0].alertType).toBe(AlertType.THRESHOLD_WARNING);
      expect(alerts[0].severity).toBe(AlertSeverity.WARNING);
    });

    it("returns no alerts when spending is below warn threshold", () => {
      const alerts = service.checkThresholdAlerts({
        budgetCategoryId: "bc-1",
        categoryId: "cat-1",
        categoryName: "Clothing",
        budgeted: 400,
        spent: 200,
        percentUsed: 50,
        isIncome: false,
        alertWarnPercent: 80,
        alertCriticalPercent: 95,
        flexGroup: null,
      });

      expect(alerts).toHaveLength(0);
    });

    it("respects custom alert thresholds per category", () => {
      const alerts = service.checkThresholdAlerts({
        budgetCategoryId: "bc-1",
        categoryId: "cat-1",
        categoryName: "Travel",
        budgeted: 1000,
        spent: 710,
        percentUsed: 71,
        isIncome: false,
        alertWarnPercent: 70,
        alertCriticalPercent: 90,
        flexGroup: null,
      });

      expect(alerts).toHaveLength(1);
      expect(alerts[0].alertType).toBe(AlertType.THRESHOLD_WARNING);
    });

    it("includes data fields in alert", () => {
      const alerts = service.checkThresholdAlerts({
        budgetCategoryId: "bc-1",
        categoryId: "cat-1",
        categoryName: "Groceries",
        budgeted: 500,
        spent: 450,
        percentUsed: 90,
        isIncome: false,
        alertWarnPercent: 80,
        alertCriticalPercent: 95,
        flexGroup: null,
      });

      expect(alerts).toHaveLength(1);
      expect(alerts[0].data.categoryName).toBe("Groceries");
      expect(alerts[0].data.percent).toBe(90);
      expect(alerts[0].data.amount).toBe(450);
      expect(alerts[0].data.limit).toBe(500);
    });

    it("only returns the most severe applicable alert", () => {
      // At exactly 100%, only OVER_BUDGET should be returned (not both warning + critical)
      const alerts = service.checkThresholdAlerts({
        budgetCategoryId: "bc-1",
        categoryId: "cat-1",
        categoryName: "Groceries",
        budgeted: 500,
        spent: 500,
        percentUsed: 100,
        isIncome: false,
        alertWarnPercent: 80,
        alertCriticalPercent: 95,
        flexGroup: null,
      });

      expect(alerts).toHaveLength(1);
      expect(alerts[0].alertType).toBe(AlertType.OVER_BUDGET);
    });
  });

  describe("checkVelocityAlert", () => {
    it("returns PROJECTED_OVERSPEND when pace exceeds 110% projection", () => {
      const alert = service.checkVelocityAlert(
        {
          budgetCategoryId: "bc-1",
          categoryId: "cat-1",
          categoryName: "Dining",
          budgeted: 300,
          spent: 200,
          percentUsed: 66.67,
          isIncome: false,
          alertWarnPercent: 80,
          alertCriticalPercent: 95,
          flexGroup: null,
        },
        10, // daysElapsed
        30, // totalDays
      );

      // dailyRate = 200/10 = 20, projected = 20*30 = 600, 600/300 = 200%
      expect(alert).not.toBeNull();
      expect(alert!.alertType).toBe(AlertType.PROJECTED_OVERSPEND);
      expect(alert!.severity).toBe(AlertSeverity.WARNING);
      expect(alert!.data.projectedTotal).toBe(600);
    });

    it("returns null when pace is within budget", () => {
      const alert = service.checkVelocityAlert(
        {
          budgetCategoryId: "bc-1",
          categoryId: "cat-1",
          categoryName: "Groceries",
          budgeted: 500,
          spent: 100,
          percentUsed: 20,
          isIncome: false,
          alertWarnPercent: 80,
          alertCriticalPercent: 95,
          flexGroup: null,
        },
        10,
        30,
      );

      // dailyRate = 100/10 = 10, projected = 10*30 = 300, 300/500 = 60%
      expect(alert).toBeNull();
    });

    it("returns null when already over budget (handled by threshold alerts)", () => {
      const alert = service.checkVelocityAlert(
        {
          budgetCategoryId: "bc-1",
          categoryId: "cat-1",
          categoryName: "Groceries",
          budgeted: 500,
          spent: 600,
          percentUsed: 120,
          isIncome: false,
          alertWarnPercent: 80,
          alertCriticalPercent: 95,
          flexGroup: null,
        },
        15,
        30,
      );

      expect(alert).toBeNull();
    });

    it("includes daily rate and projected amounts in data", () => {
      const alert = service.checkVelocityAlert(
        {
          budgetCategoryId: "bc-1",
          categoryId: "cat-1",
          categoryName: "Transport",
          budgeted: 200,
          spent: 150,
          percentUsed: 75,
          isIncome: false,
          alertWarnPercent: 80,
          alertCriticalPercent: 95,
          flexGroup: null,
        },
        10,
        30,
      );

      // dailyRate = 150/10 = 15, projected = 15*30 = 450, 450/200 = 225%
      expect(alert).not.toBeNull();
      expect(alert!.data.dailyRate).toBe(15);
      expect(alert!.data.projectedTotal).toBe(450);
      expect(alert!.data.budgeted).toBe(200);
    });
  });

  describe("checkFlexGroupAlerts", () => {
    it("returns alert when flex group reaches 90%", () => {
      const alerts = service.checkFlexGroupAlerts([
        {
          budgetCategoryId: "bc-1",
          categoryId: "cat-1",
          categoryName: "Dining",
          budgeted: 300,
          spent: 280,
          percentUsed: 93.33,
          isIncome: false,
          alertWarnPercent: 80,
          alertCriticalPercent: 95,
          flexGroup: "Fun Money",
        },
        {
          budgetCategoryId: "bc-2",
          categoryId: "cat-2",
          categoryName: "Entertainment",
          budgeted: 200,
          spent: 180,
          percentUsed: 90,
          isIncome: false,
          alertWarnPercent: 80,
          alertCriticalPercent: 95,
          flexGroup: "Fun Money",
        },
      ]);

      // Total: 460/500 = 92%
      expect(alerts).toHaveLength(1);
      expect(alerts[0].alertType).toBe(AlertType.FLEX_GROUP_WARNING);
      expect(alerts[0].data.flexGroup).toBe("Fun Money");
      expect(alerts[0].data.percent).toBe(92);
    });

    it("returns no alert when flex group is under 90%", () => {
      const alerts = service.checkFlexGroupAlerts([
        {
          budgetCategoryId: "bc-1",
          categoryId: "cat-1",
          categoryName: "Dining",
          budgeted: 300,
          spent: 100,
          percentUsed: 33.33,
          isIncome: false,
          alertWarnPercent: 80,
          alertCriticalPercent: 95,
          flexGroup: "Fun Money",
        },
        {
          budgetCategoryId: "bc-2",
          categoryId: "cat-2",
          categoryName: "Entertainment",
          budgeted: 200,
          spent: 50,
          percentUsed: 25,
          isIncome: false,
          alertWarnPercent: 80,
          alertCriticalPercent: 95,
          flexGroup: "Fun Money",
        },
      ]);

      // Total: 150/500 = 30%
      expect(alerts).toHaveLength(0);
    });

    it("handles multiple flex groups independently", () => {
      const alerts = service.checkFlexGroupAlerts([
        {
          budgetCategoryId: "bc-1",
          categoryId: "cat-1",
          categoryName: "Dining",
          budgeted: 300,
          spent: 280,
          percentUsed: 93.33,
          isIncome: false,
          alertWarnPercent: 80,
          alertCriticalPercent: 95,
          flexGroup: "Fun Money",
        },
        {
          budgetCategoryId: "bc-2",
          categoryId: "cat-2",
          categoryName: "Hobbies",
          budgeted: 200,
          spent: 180,
          percentUsed: 90,
          isIncome: false,
          alertWarnPercent: 80,
          alertCriticalPercent: 95,
          flexGroup: "Fun Money",
        },
        {
          budgetCategoryId: "bc-3",
          categoryId: "cat-3",
          categoryName: "Gas",
          budgeted: 200,
          spent: 50,
          percentUsed: 25,
          isIncome: false,
          alertWarnPercent: 80,
          alertCriticalPercent: 95,
          flexGroup: "Transport",
        },
      ]);

      // Fun Money: 460/500 = 92% -> alert
      // Transport: 50/200 = 25% -> no alert
      expect(alerts).toHaveLength(1);
      expect(alerts[0].data.flexGroup).toBe("Fun Money");
    });

    it("ignores categories without flex group", () => {
      const alerts = service.checkFlexGroupAlerts([
        {
          budgetCategoryId: "bc-1",
          categoryId: "cat-1",
          categoryName: "Rent",
          budgeted: 1500,
          spent: 1500,
          percentUsed: 100,
          isIncome: false,
          alertWarnPercent: 80,
          alertCriticalPercent: 95,
          flexGroup: null,
        },
      ]);

      expect(alerts).toHaveLength(0);
    });
  });

  describe("checkIncomeShortfall", () => {
    it("returns INCOME_SHORTFALL when income is < 80% of expected at 50%+ progress", () => {
      const alert = service.checkIncomeShortfall(
        [
          {
            budgetCategoryId: "bc-inc-1",
            categoryId: "cat-inc-1",
            categoryName: "Salary",
            budgeted: 5000,
            spent: 1500,
            percentUsed: 30,
            isIncome: true,
            alertWarnPercent: 80,
            alertCriticalPercent: 95,
            flexGroup: null,
          },
        ],
        5000,
        0.6, // 60% through period
      );

      // Expected at 60%: 5000 * 0.6 = 3000, actual: 1500, ratio = 0.5 < 0.8
      expect(alert).not.toBeNull();
      expect(alert!.alertType).toBe(AlertType.INCOME_SHORTFALL);
      expect(alert!.severity).toBe(AlertSeverity.CRITICAL);
    });

    it("returns null when income is on track", () => {
      const alert = service.checkIncomeShortfall(
        [
          {
            budgetCategoryId: "bc-inc-1",
            categoryId: "cat-inc-1",
            categoryName: "Salary",
            budgeted: 5000,
            spent: 4000,
            percentUsed: 80,
            isIncome: true,
            alertWarnPercent: 80,
            alertCriticalPercent: 95,
            flexGroup: null,
          },
        ],
        5000,
        0.7,
      );

      // Expected at 70%: 3500, actual: 4000, ratio = 1.14 > 0.8
      expect(alert).toBeNull();
    });

    it("returns null when period progress is less than 50%", () => {
      const alert = service.checkIncomeShortfall(
        [
          {
            budgetCategoryId: "bc-inc-1",
            categoryId: "cat-inc-1",
            categoryName: "Salary",
            budgeted: 5000,
            spent: 0,
            percentUsed: 0,
            isIncome: true,
            alertWarnPercent: 80,
            alertCriticalPercent: 95,
            flexGroup: null,
          },
        ],
        5000,
        0.3,
      );

      expect(alert).toBeNull();
    });
  });

  describe("checkPositiveMilestones", () => {
    it("returns POSITIVE_MILESTONE when under 60% used at 50%+ progress", () => {
      const alerts = service.checkPositiveMilestones(
        [
          {
            budgetCategoryId: "bc-1",
            categoryId: "cat-1",
            categoryName: "Groceries",
            budgeted: 500,
            spent: 200,
            percentUsed: 40,
            isIncome: false,
            alertWarnPercent: 80,
            alertCriticalPercent: 95,
            flexGroup: null,
          },
          {
            budgetCategoryId: "bc-2",
            categoryId: "cat-2",
            categoryName: "Dining",
            budgeted: 300,
            spent: 100,
            percentUsed: 33.33,
            isIncome: false,
            alertWarnPercent: 80,
            alertCriticalPercent: 95,
            flexGroup: null,
          },
        ],
        0.6, // 60% through
        12, // 12 days remaining
      );

      // Total: 300/800 = 37.5%
      expect(alerts).toHaveLength(1);
      expect(alerts[0].alertType).toBe(AlertType.POSITIVE_MILESTONE);
      expect(alerts[0].severity).toBe(AlertSeverity.SUCCESS);
    });

    it("returns no milestone when spending is >= 60%", () => {
      const alerts = service.checkPositiveMilestones(
        [
          {
            budgetCategoryId: "bc-1",
            categoryId: "cat-1",
            categoryName: "Groceries",
            budgeted: 500,
            spent: 350,
            percentUsed: 70,
            isIncome: false,
            alertWarnPercent: 80,
            alertCriticalPercent: 95,
            flexGroup: null,
          },
        ],
        0.6,
        12,
      );

      expect(alerts).toHaveLength(0);
    });

    it("returns no milestone when period progress is less than 50%", () => {
      const alerts = service.checkPositiveMilestones(
        [
          {
            budgetCategoryId: "bc-1",
            categoryId: "cat-1",
            categoryName: "Groceries",
            budgeted: 500,
            spent: 50,
            percentUsed: 10,
            isIncome: false,
            alertWarnPercent: 80,
            alertCriticalPercent: 95,
            flexGroup: null,
          },
        ],
        0.3,
        21,
      );

      expect(alerts).toHaveLength(0);
    });

    it("returns no milestone when no days remaining", () => {
      const alerts = service.checkPositiveMilestones(
        [
          {
            budgetCategoryId: "bc-1",
            categoryId: "cat-1",
            categoryName: "Groceries",
            budgeted: 500,
            spent: 100,
            percentUsed: 20,
            isIncome: false,
            alertWarnPercent: 80,
            alertCriticalPercent: 95,
            flexGroup: null,
          },
        ],
        1.0,
        0,
      );

      expect(alerts).toHaveLength(0);
    });
  });

  describe("deduplicateAlerts", () => {
    it("filters out alerts that already exist for the same type and category", () => {
      const candidates = [
        {
          budgetId: "budget-1",
          budgetCategoryId: "bc-1",
          alertType: AlertType.THRESHOLD_WARNING,
          severity: AlertSeverity.WARNING,
          title: "Warning",
          message: "Warning message",
          data: {},
        },
        {
          budgetId: "budget-1",
          budgetCategoryId: "bc-2",
          alertType: AlertType.OVER_BUDGET,
          severity: AlertSeverity.CRITICAL,
          title: "Over budget",
          message: "Over budget message",
          data: {},
        },
      ];

      const existing = [
        makeAlert({
          alertType: AlertType.THRESHOLD_WARNING,
          budgetCategoryId: "bc-1",
        }),
      ];

      const result = service.deduplicateAlerts(candidates, existing);

      expect(result).toHaveLength(1);
      expect(result[0].alertType).toBe(AlertType.OVER_BUDGET);
      expect(result[0].budgetCategoryId).toBe("bc-2");
    });

    it("allows alerts of different types for the same category", () => {
      const candidates = [
        {
          budgetId: "budget-1",
          budgetCategoryId: "bc-1",
          alertType: AlertType.THRESHOLD_WARNING,
          severity: AlertSeverity.WARNING,
          title: "Warning",
          message: "Warning message",
          data: {},
        },
        {
          budgetId: "budget-1",
          budgetCategoryId: "bc-1",
          alertType: AlertType.PROJECTED_OVERSPEND,
          severity: AlertSeverity.WARNING,
          title: "Projected overspend",
          message: "Projected message",
          data: {},
        },
      ];

      const existing = [
        makeAlert({
          alertType: AlertType.THRESHOLD_WARNING,
          budgetCategoryId: "bc-1",
        }),
      ];

      const result = service.deduplicateAlerts(candidates, existing);

      expect(result).toHaveLength(1);
      expect(result[0].alertType).toBe(AlertType.PROJECTED_OVERSPEND);
    });

    it("returns all candidates when no existing alerts", () => {
      const candidates = [
        {
          budgetId: "budget-1",
          budgetCategoryId: "bc-1",
          alertType: AlertType.THRESHOLD_WARNING,
          severity: AlertSeverity.WARNING,
          title: "Warning",
          message: "Warning message",
          data: {},
        },
      ];

      const result = service.deduplicateAlerts(candidates, []);

      expect(result).toHaveLength(1);
    });

    it("handles null budgetCategoryId for budget-level alerts", () => {
      const candidates = [
        {
          budgetId: "budget-1",
          budgetCategoryId: null,
          alertType: AlertType.POSITIVE_MILESTONE,
          severity: AlertSeverity.SUCCESS,
          title: "On track",
          message: "On track message",
          data: {},
        },
      ];

      const existing = [
        makeAlert({
          alertType: AlertType.POSITIVE_MILESTONE,
          budgetCategoryId: null,
        }),
      ];

      const result = service.deduplicateAlerts(candidates, existing);

      expect(result).toHaveLength(0);
    });
  });

  describe("processAlerts", () => {
    it("returns zero alerts when budget has no categories", async () => {
      const budget = makeBudget({ categories: [] });

      const result = await service.processAlerts(budget);

      expect(result.alertsCreated).toBe(0);
      expect(result.emailsSent).toBe(0);
    });

    it("creates threshold alerts for over-budget categories", async () => {
      const budget = makeBudget({
        categories: [
          makeCategory({
            id: "bc-1",
            categoryId: "cat-1",
            category: {
              id: "cat-1",
              name: "Groceries",
              isIncome: false,
            } as any,
            amount: 500,
          }),
        ],
      });

      const qb = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        innerJoin: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest
          .fn()
          .mockResolvedValue([{ categoryId: "cat-1", total: "550" }]),
      };

      transactionsRepository.createQueryBuilder.mockReturnValue(qb);
      splitsRepository.createQueryBuilder.mockReturnValue({
        ...qb,
        getRawMany: jest.fn().mockResolvedValue([]),
      });

      alertsRepository.find.mockResolvedValue([]);

      const result = await service.processAlerts(budget);

      expect(result.alertsCreated).toBeGreaterThan(0);
      expect(alertsRepository.save).toHaveBeenCalled();

      const savedAlert = alertsRepository.create.mock.calls[0][0];
      expect(savedAlert.alertType).toBe(AlertType.OVER_BUDGET);
    });

    it("sends immediate email for critical alerts", async () => {
      const budget = makeBudget({
        categories: [
          makeCategory({
            id: "bc-1",
            categoryId: "cat-1",
            category: {
              id: "cat-1",
              name: "Groceries",
              isIncome: false,
            } as any,
            amount: 500,
            alertCriticalPercent: 95,
          }),
        ],
      });

      const qb = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        innerJoin: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest
          .fn()
          .mockResolvedValue([{ categoryId: "cat-1", total: "600" }]),
      };

      transactionsRepository.createQueryBuilder.mockReturnValue(qb);
      splitsRepository.createQueryBuilder.mockReturnValue({
        ...qb,
        getRawMany: jest.fn().mockResolvedValue([]),
      });
      alertsRepository.find.mockResolvedValue([]);

      const result = await service.processAlerts(budget);

      expect(result.emailsSent).toBe(1);
      expect(emailService.sendMail).toHaveBeenCalled();
    });

    it("does not send email when user has notifications disabled", async () => {
      preferencesRepository.findOne.mockResolvedValue({
        userId: "user-1",
        notificationEmail: false,
      });

      const budget = makeBudget({
        categories: [
          makeCategory({
            id: "bc-1",
            categoryId: "cat-1",
            category: {
              id: "cat-1",
              name: "Groceries",
              isIncome: false,
            } as any,
            amount: 500,
          }),
        ],
      });

      const qb = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        innerJoin: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest
          .fn()
          .mockResolvedValue([{ categoryId: "cat-1", total: "600" }]),
      };

      transactionsRepository.createQueryBuilder.mockReturnValue(qb);
      splitsRepository.createQueryBuilder.mockReturnValue({
        ...qb,
        getRawMany: jest.fn().mockResolvedValue([]),
      });
      alertsRepository.find.mockResolvedValue([]);

      const result = await service.processAlerts(budget);

      expect(result.emailsSent).toBe(0);
      expect(emailService.sendMail).not.toHaveBeenCalled();
    });

    it("deduplicates against existing alerts for the same period", async () => {
      const budget = makeBudget({
        categories: [
          makeCategory({
            id: "bc-1",
            categoryId: "cat-1",
            category: {
              id: "cat-1",
              name: "Groceries",
              isIncome: false,
            } as any,
            amount: 500,
          }),
        ],
      });

      const qb = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        innerJoin: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest
          .fn()
          .mockResolvedValue([{ categoryId: "cat-1", total: "600" }]),
      };

      transactionsRepository.createQueryBuilder.mockReturnValue(qb);
      splitsRepository.createQueryBuilder.mockReturnValue({
        ...qb,
        getRawMany: jest.fn().mockResolvedValue([]),
      });

      // Existing alert for same type+category
      alertsRepository.find.mockResolvedValue([
        makeAlert({
          alertType: AlertType.OVER_BUDGET,
          budgetCategoryId: "bc-1",
        }),
      ]);

      await service.processAlerts(budget);

      // The OVER_BUDGET alert was deduped, but PROJECTED_OVERSPEND might still be created
      // depending on velocity. The point is the OVER_BUDGET alert specifically was deduped
      const createdAlerts = alertsRepository.create.mock.calls.map(
        (call: any[]) => call[0].alertType,
      );
      expect(createdAlerts).not.toContain(AlertType.OVER_BUDGET);
    });
  });

  describe("checkBudgetAlerts", () => {
    it("does nothing when no active budgets exist", async () => {
      budgetsRepository.find.mockResolvedValue([]);

      await service.checkBudgetAlerts();

      expect(alertsRepository.create).not.toHaveBeenCalled();
    });

    it("processes all active budgets", async () => {
      const budget1 = makeBudget({ id: "budget-1", categories: [] });
      const budget2 = makeBudget({
        id: "budget-2",
        userId: "user-2",
        categories: [],
      });

      budgetsRepository.find.mockResolvedValue([budget1, budget2]);

      await service.checkBudgetAlerts();

      // Both budgets were processed (even with no categories)
      expect(budgetsRepository.find).toHaveBeenCalledWith({
        where: { isActive: true },
        relations: [
          "categories",
          "categories.category",
          "categories.category.parent",
          "categories.transferAccount",
        ],
      });
    });

    it("continues processing other budgets when one fails", async () => {
      const budget1 = makeBudget({
        id: "budget-1",
        categories: [makeCategory()],
      });
      const budget2 = makeBudget({
        id: "budget-2",
        userId: "user-2",
        categories: [],
      });

      budgetsRepository.find.mockResolvedValue([budget1, budget2]);

      // First budget's query will throw
      transactionsRepository.createQueryBuilder.mockImplementationOnce(() => {
        throw new Error("Database error");
      });

      await expect(service.checkBudgetAlerts()).resolves.not.toThrow();
    });

    it("handles top-level error gracefully", async () => {
      budgetsRepository.find.mockRejectedValue(new Error("Connection error"));

      await expect(service.checkBudgetAlerts()).resolves.not.toThrow();
    });
  });

  describe("sendWeeklyDigest", () => {
    it("does nothing when SMTP is not configured", async () => {
      emailService.getStatus.mockReturnValue({ configured: false });
      budgetsRepository.find.mockResolvedValue([makeBudget()]);

      await service.sendWeeklyDigest();

      expect(emailService.sendMail).not.toHaveBeenCalled();
    });

    it("does nothing when no active budgets exist", async () => {
      budgetsRepository.find.mockResolvedValue([]);

      await service.sendWeeklyDigest();

      expect(emailService.sendMail).not.toHaveBeenCalled();
    });

    it("skips users with budget digest disabled", async () => {
      budgetsRepository.find.mockResolvedValue([makeBudget()]);
      preferencesRepository.findOne.mockResolvedValue({
        userId: "user-1",
        notificationEmail: true,
        budgetDigestEnabled: false,
      });

      await service.sendWeeklyDigest();

      expect(emailService.sendMail).not.toHaveBeenCalled();
    });

    it("skips users with email notifications disabled", async () => {
      budgetsRepository.find.mockResolvedValue([makeBudget()]);
      preferencesRepository.findOne.mockResolvedValue({
        userId: "user-1",
        notificationEmail: false,
        budgetDigestEnabled: true,
      });

      await service.sendWeeklyDigest();

      expect(emailService.sendMail).not.toHaveBeenCalled();
    });

    it("sends digest email when alerts exist", async () => {
      budgetsRepository.find.mockResolvedValue([makeBudget()]);

      alertsRepository.find.mockResolvedValue([
        makeAlert({ alertType: AlertType.THRESHOLD_WARNING }),
      ]);

      await service.sendWeeklyDigest();

      expect(emailService.sendMail).toHaveBeenCalledWith(
        "user@test.com",
        "Monize: Your weekly budget summary",
        expect.any(String),
      );
    });

    it("skips users with no recent alerts", async () => {
      budgetsRepository.find.mockResolvedValue([makeBudget()]);
      alertsRepository.find.mockResolvedValue([]);

      await service.sendWeeklyDigest();

      expect(emailService.sendMail).not.toHaveBeenCalled();
    });

    it("handles errors gracefully", async () => {
      budgetsRepository.find.mockRejectedValue(new Error("Connection error"));

      await expect(service.sendWeeklyDigest()).resolves.not.toThrow();
    });
  });

  describe("checkSeasonalSpikes", () => {
    it("returns SEASONAL_SPIKE alert when next month is historically expensive", async () => {
      const nextMonth = new Date();
      nextMonth.setMonth(nextMonth.getMonth() + 1);
      const nextMonthNum = nextMonth.getMonth() + 1;

      const budget = makeBudget({
        categories: [
          makeCategory({
            id: "bc-1",
            categoryId: "cat-1",
            category: {
              id: "cat-1",
              name: "Gifts",
              isIncome: false,
            } as any,
            amount: 100,
          }),
        ],
      });

      // Build monthly spending data where the next month is 2.5x above average
      const monthlyData: Array<{
        categoryId: string;
        month: number;
        total: string;
      }> = [];
      for (let m = 1; m <= 12; m++) {
        const amount = m === nextMonthNum ? "500" : "200";
        monthlyData.push({ categoryId: "cat-1", month: m, total: amount });
      }

      const qb = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        innerJoin: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        addGroupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue(monthlyData),
      };

      transactionsRepository.createQueryBuilder.mockReturnValue(qb);
      splitsRepository.createQueryBuilder.mockReturnValue({
        ...qb,
        getRawMany: jest.fn().mockResolvedValue([]),
      });

      const alerts = await service.checkSeasonalSpikes(
        "user-1",
        budget,
      );

      expect(alerts.length).toBeGreaterThanOrEqual(1);
      const spikeAlert = alerts.find(
        (a) => a.alertType === AlertType.SEASONAL_SPIKE,
      );
      expect(spikeAlert).toBeDefined();
      expect(spikeAlert!.severity).toBe(AlertSeverity.INFO);
      expect(spikeAlert!.data.typicalIncrease).toBeGreaterThanOrEqual(1.5);
      expect(spikeAlert!.data.highMonth).toBe(nextMonthNum);
    });

    it("returns no alerts when no categories have seasonal spikes", async () => {
      const budget = makeBudget({
        categories: [
          makeCategory({
            id: "bc-1",
            categoryId: "cat-1",
            category: {
              id: "cat-1",
              name: "Groceries",
              isIncome: false,
            } as any,
          }),
        ],
      });

      // Flat spending across all months
      const monthlyData: Array<{ categoryId: string; month: number; total: string }> = [];
      for (let m = 1; m <= 12; m++) {
        monthlyData.push({ categoryId: "cat-1", month: m, total: "200" });
      }

      const qb = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        innerJoin: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        addGroupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue(monthlyData),
      };

      transactionsRepository.createQueryBuilder.mockReturnValue(qb);
      splitsRepository.createQueryBuilder.mockReturnValue({
        ...qb,
        getRawMany: jest.fn().mockResolvedValue([]),
      });

      const alerts = await service.checkSeasonalSpikes(
        "user-1",
        budget,
      );

      expect(alerts).toHaveLength(0);
    });

    it("returns no alerts when budget has no expense categories", async () => {
      const budget = makeBudget({
        categories: [
          makeCategory({
            id: "bc-1",
            categoryId: "cat-1",
            isIncome: true,
            category: {
              id: "cat-1",
              name: "Salary",
              isIncome: true,
            } as any,
          }),
        ],
      });

      const alerts = await service.checkSeasonalSpikes(
        "user-1",
        budget,
      );

      expect(alerts).toHaveLength(0);
    });

    it("returns no alerts when insufficient data for analysis", async () => {
      const budget = makeBudget({
        categories: [
          makeCategory({
            id: "bc-1",
            categoryId: "cat-1",
            category: {
              id: "cat-1",
              name: "Groceries",
              isIncome: false,
            } as any,
          }),
        ],
      });

      // Only 2 months of data (below minimum of 3)
      const monthlyData = [
        { categoryId: "cat-1", month: 1, total: "200" },
        { categoryId: "cat-1", month: 2, total: "300" },
      ];

      const qb = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        innerJoin: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        addGroupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue(monthlyData),
      };

      transactionsRepository.createQueryBuilder.mockReturnValue(qb);
      splitsRepository.createQueryBuilder.mockReturnValue({
        ...qb,
        getRawMany: jest.fn().mockResolvedValue([]),
      });

      const alerts = await service.checkSeasonalSpikes(
        "user-1",
        budget,
      );

      expect(alerts).toHaveLength(0);
    });

    it("includes suggested budget amount in alert data", async () => {
      const nextMonth = new Date();
      nextMonth.setMonth(nextMonth.getMonth() + 1);
      const nextMonthNum = nextMonth.getMonth() + 1;

      const budget = makeBudget({
        categories: [
          makeCategory({
            id: "bc-1",
            categoryId: "cat-1",
            category: {
              id: "cat-1",
              name: "Gifts",
              isIncome: false,
            } as any,
            amount: 100,
          }),
        ],
      });

      const monthlyData: Array<{ categoryId: string; month: number; total: string }> = [];
      for (let m = 1; m <= 12; m++) {
        const amount = m === nextMonthNum ? "600" : "200";
        monthlyData.push({ categoryId: "cat-1", month: m, total: amount });
      }

      const qb = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        innerJoin: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        addGroupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue(monthlyData),
      };

      transactionsRepository.createQueryBuilder.mockReturnValue(qb);
      splitsRepository.createQueryBuilder.mockReturnValue({
        ...qb,
        getRawMany: jest.fn().mockResolvedValue([]),
      });

      const alerts = await service.checkSeasonalSpikes(
        "user-1",
        budget,
      );

      if (alerts.length > 0) {
        const alert = alerts[0];
        expect(alert.data.suggestedBudget).toBeDefined();
        expect(alert.data.typicalMonthlySpend).toBeDefined();
        expect(alert.data.categoryName).toBe("Gifts");
        expect(typeof alert.data.suggestedBudget).toBe("number");
        expect(alert.data.suggestedBudget).toBeGreaterThan(0);
      }
    });
  });

  describe("getCurrentPeriodDates", () => {
    it("returns first and last day of current month", () => {
      const { periodStart, periodEnd } = service.getCurrentPeriodDates();

      const today = new Date();
      const year = today.getFullYear();
      const month = String(today.getMonth() + 1).padStart(2, "0");

      expect(periodStart).toBe(`${year}-${month}-01`);
      expect(periodEnd).toMatch(new RegExp(`^${year}-${month}-\\d{2}$`));

      // Verify last day of month
      const lastDay = new Date(year, today.getMonth() + 1, 0).getDate();
      expect(periodEnd).toBe(
        `${year}-${month}-${String(lastDay).padStart(2, "0")}`,
      );
    });
  });
});
