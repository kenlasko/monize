import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { ConfigService } from "@nestjs/config";
import { BudgetPeriodCronService } from "./budget-period-cron.service";
import { BudgetPeriodService } from "./budget-period.service";
import { BudgetReportsService } from "./budget-reports.service";
import { EmailService } from "../notifications/email.service";
import { Budget, BudgetType, BudgetStrategy } from "./entities/budget.entity";
import { BudgetPeriod, PeriodStatus } from "./entities/budget-period.entity";
import { User } from "../users/entities/user.entity";
import { UserPreference } from "../users/entities/user-preference.entity";

describe("BudgetPeriodCronService", () => {
  let service: BudgetPeriodCronService;
  let budgetsRepository: Record<string, jest.Mock>;
  let periodsRepository: Record<string, jest.Mock>;
  let usersRepository: Record<string, jest.Mock>;
  let preferencesRepository: Record<string, jest.Mock>;
  let budgetPeriodService: Record<string, jest.Mock>;
  let budgetReportsService: Record<string, jest.Mock>;
  let emailService: Record<string, jest.Mock>;
  let configService: Record<string, jest.Mock>;

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
    categories: [
      {
        id: "bc-1",
        budgetId: "budget-1",
        budget: null as unknown as Budget,
        categoryId: "cat-1",
        category: { name: "Groceries" } as any,
        categoryGroup: null,
        amount: 500,
        isIncome: false,
        rolloverType: "NONE" as any,
        rolloverCap: null,
        flexGroup: null,
        alertWarnPercent: 80,
        alertCriticalPercent: 95,
        notes: null,
        sortOrder: 0,
        createdAt: new Date("2026-01-01"),
        updatedAt: new Date("2026-01-01"),
      },
      {
        id: "bc-2",
        budgetId: "budget-1",
        budget: null as unknown as Budget,
        categoryId: "cat-2",
        category: { name: "Salary" } as any,
        categoryGroup: null,
        amount: 5000,
        isIncome: true,
        rolloverType: "NONE" as any,
        rolloverCap: null,
        flexGroup: null,
        alertWarnPercent: 80,
        alertCriticalPercent: 95,
        notes: null,
        sortOrder: 1,
        createdAt: new Date("2026-01-01"),
        updatedAt: new Date("2026-01-01"),
      },
    ],
    periods: [],
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
  };

  const mockClosedPeriod: BudgetPeriod = {
    id: "period-1",
    budgetId: "budget-1",
    budget: mockBudget,
    periodStart: "2026-01-01",
    periodEnd: "2026-01-31",
    actualIncome: 5000,
    actualExpenses: 480,
    totalBudgeted: 500,
    status: PeriodStatus.CLOSED,
    periodCategories: [
      {
        id: "pc-1",
        budgetPeriodId: "period-1",
        budgetPeriod: null as any,
        budgetCategoryId: "bc-1",
        budgetCategory: null as any,
        categoryId: "cat-1",
        category: null,
        budgetedAmount: 500,
        rolloverIn: 0,
        effectiveBudget: 500,
        actualAmount: 480,
        rolloverOut: 20,
        createdAt: new Date("2026-01-01"),
        updatedAt: new Date("2026-01-31"),
      },
    ],
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-31"),
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

  const mockUser: Partial<User> = {
    id: "user-1",
    email: "alice@example.com",
    firstName: "Alice",
    lastName: "Smith",
    isActive: true,
  };

  beforeEach(async () => {
    budgetsRepository = {
      find: jest.fn().mockResolvedValue([]),
    };

    periodsRepository = {
      findOne: jest.fn().mockResolvedValue(null),
    };

    usersRepository = {
      findOne: jest.fn().mockResolvedValue(null),
    };

    preferencesRepository = {
      findOne: jest.fn().mockResolvedValue(null),
    };

    budgetPeriodService = {
      closePeriod: jest.fn().mockResolvedValue(mockClosedPeriod),
    };

    budgetReportsService = {
      getHealthScore: jest.fn().mockResolvedValue({
        score: 85,
        label: "Good",
        breakdown: {
          baseScore: 100,
          overBudgetDeductions: 0,
          underBudgetBonus: 5,
          trendBonus: 0,
          essentialWeightPenalty: 0,
        },
        categoryScores: [],
      }),
    };

    emailService = {
      getStatus: jest.fn().mockReturnValue({ configured: true }),
      sendMail: jest.fn().mockResolvedValue(undefined),
    };

    configService = {
      get: jest.fn().mockImplementation((key: string, defaultVal?: string) => {
        if (key === "PUBLIC_APP_URL") return "https://monize.app";
        return defaultVal;
      }),
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
          provide: getRepositoryToken(User),
          useValue: usersRepository,
        },
        {
          provide: getRepositoryToken(UserPreference),
          useValue: preferencesRepository,
        },
        {
          provide: BudgetPeriodService,
          useValue: budgetPeriodService,
        },
        {
          provide: BudgetReportsService,
          useValue: budgetReportsService,
        },
        {
          provide: EmailService,
          useValue: emailService,
        },
        {
          provide: ConfigService,
          useValue: configService,
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
        relations: ["categories", "categories.category"],
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
        .mockResolvedValueOnce(mockClosedPeriod);

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

    it("calls sendMonthlySummaryEmails after closing periods", async () => {
      budgetsRepository.find.mockResolvedValue([mockBudget]);
      periodsRepository.findOne.mockResolvedValue({
        ...mockOpenPeriod,
        periodEnd: "2025-12-31",
      });
      budgetPeriodService.closePeriod.mockResolvedValue(mockClosedPeriod);

      usersRepository.findOne.mockResolvedValue(mockUser);
      preferencesRepository.findOne.mockResolvedValue(null);

      await service.closeExpiredPeriods();

      expect(emailService.sendMail).toHaveBeenCalled();
    });

    it("does not call sendMonthlySummaryEmails when no periods were closed", async () => {
      budgetsRepository.find.mockResolvedValue([mockBudget]);
      periodsRepository.findOne.mockResolvedValue({
        ...mockOpenPeriod,
        periodEnd: "2099-12-31",
      });

      await service.closeExpiredPeriods();

      expect(emailService.sendMail).not.toHaveBeenCalled();
    });
  });

  describe("sendMonthlySummaryEmails", () => {
    const closedPeriods = [{ budget: mockBudget, period: mockClosedPeriod }];

    it("skips if SMTP is not configured", async () => {
      emailService.getStatus.mockReturnValue({ configured: false });

      await service.sendMonthlySummaryEmails(closedPeriods);

      expect(usersRepository.findOne).not.toHaveBeenCalled();
      expect(emailService.sendMail).not.toHaveBeenCalled();
    });

    it("skips users with disabled email notifications", async () => {
      preferencesRepository.findOne.mockResolvedValue({
        userId: "user-1",
        notificationEmail: false,
        budgetDigestEnabled: true,
      });

      await service.sendMonthlySummaryEmails(closedPeriods);

      expect(usersRepository.findOne).not.toHaveBeenCalled();
      expect(emailService.sendMail).not.toHaveBeenCalled();
    });

    it("skips users with disabled budget digest", async () => {
      preferencesRepository.findOne.mockResolvedValue({
        userId: "user-1",
        notificationEmail: true,
        budgetDigestEnabled: false,
      });

      await service.sendMonthlySummaryEmails(closedPeriods);

      expect(usersRepository.findOne).not.toHaveBeenCalled();
      expect(emailService.sendMail).not.toHaveBeenCalled();
    });

    it("skips users without an email address", async () => {
      preferencesRepository.findOne.mockResolvedValue(null);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        email: null,
      });

      await service.sendMonthlySummaryEmails(closedPeriods);

      expect(emailService.sendMail).not.toHaveBeenCalled();
    });

    it("skips when user is not found", async () => {
      preferencesRepository.findOne.mockResolvedValue(null);
      usersRepository.findOne.mockResolvedValue(null);

      await service.sendMonthlySummaryEmails(closedPeriods);

      expect(emailService.sendMail).not.toHaveBeenCalled();
    });

    it("sends email with correct template data", async () => {
      preferencesRepository.findOne.mockResolvedValue(null);
      usersRepository.findOne.mockResolvedValue(mockUser);

      await service.sendMonthlySummaryEmails(closedPeriods);

      expect(emailService.sendMail).toHaveBeenCalledTimes(1);
      expect(emailService.sendMail).toHaveBeenCalledWith(
        "alice@example.com",
        expect.stringContaining("Monthly budget summary"),
        expect.stringContaining("Monthly Budget Summary"),
      );

      const htmlArg = emailService.sendMail.mock.calls[0][2];
      expect(htmlArg).toContain("Alice");
      expect(htmlArg).toContain("Monthly Budget");
    });

    it("includes health score in email when available", async () => {
      preferencesRepository.findOne.mockResolvedValue(null);
      usersRepository.findOne.mockResolvedValue(mockUser);

      await service.sendMonthlySummaryEmails(closedPeriods);

      const htmlArg = emailService.sendMail.mock.calls[0][2];
      expect(htmlArg).toContain("Health Score");
      expect(htmlArg).toContain("85/100");
    });

    it("still sends email when health score fetch fails", async () => {
      budgetReportsService.getHealthScore.mockRejectedValue(
        new Error("Health score unavailable"),
      );
      preferencesRepository.findOne.mockResolvedValue(null);
      usersRepository.findOne.mockResolvedValue(mockUser);

      await service.sendMonthlySummaryEmails(closedPeriods);

      expect(emailService.sendMail).toHaveBeenCalledTimes(1);
      const htmlArg = emailService.sendMail.mock.calls[0][2];
      expect(htmlArg).not.toContain("Health Score");
    });

    it("groups multiple budgets for the same user into one email", async () => {
      const secondBudget = {
        ...mockBudget,
        id: "budget-2",
        name: "Annual Budget",
      };
      const secondPeriod = {
        ...mockClosedPeriod,
        id: "period-2",
        budgetId: "budget-2",
      };
      const multiPeriods = [
        { budget: mockBudget, period: mockClosedPeriod },
        { budget: secondBudget, period: secondPeriod },
      ];

      preferencesRepository.findOne.mockResolvedValue(null);
      usersRepository.findOne.mockResolvedValue(mockUser);

      await service.sendMonthlySummaryEmails(multiPeriods);

      expect(emailService.sendMail).toHaveBeenCalledTimes(1);
      expect(emailService.sendMail).toHaveBeenCalledWith(
        "alice@example.com",
        expect.stringContaining("2 budgets"),
        expect.any(String),
      );
    });

    it("handles errors for individual users without stopping others", async () => {
      const otherBudget = {
        ...mockBudget,
        id: "budget-3",
        userId: "user-2",
        name: "Other Budget",
      };
      const multiPeriods = [
        { budget: mockBudget, period: mockClosedPeriod },
        {
          budget: otherBudget,
          period: { ...mockClosedPeriod, budgetId: otherBudget.id },
        },
      ];

      preferencesRepository.findOne.mockResolvedValue(null);
      usersRepository.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: "user-2",
          email: "bob@example.com",
          firstName: "Bob",
        });

      await service.sendMonthlySummaryEmails(multiPeriods);

      expect(emailService.sendMail).toHaveBeenCalledTimes(1);
      expect(emailService.sendMail).toHaveBeenCalledWith(
        "bob@example.com",
        expect.any(String),
        expect.any(String),
      );
    });

    it("uses correct subject line for single budget", async () => {
      preferencesRepository.findOne.mockResolvedValue(null);
      usersRepository.findOne.mockResolvedValue(mockUser);

      await service.sendMonthlySummaryEmails(closedPeriods);

      const subject = emailService.sendMail.mock.calls[0][1];
      expect(subject).toMatch(/^Monize: Monthly budget summary -/);
    });

    it("includes the app URL link in the email", async () => {
      preferencesRepository.findOne.mockResolvedValue(null);
      usersRepository.findOne.mockResolvedValue(mockUser);

      await service.sendMonthlySummaryEmails(closedPeriods);

      const htmlArg = emailService.sendMail.mock.calls[0][2];
      expect(htmlArg).toContain("https://monize.app/budgets");
    });
  });
});
