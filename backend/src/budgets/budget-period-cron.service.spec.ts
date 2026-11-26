import { DataSource } from "typeorm";
import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { ConfigService } from "@nestjs/config";
import { I18nService } from "nestjs-i18n";
import { BudgetPeriodCronService } from "./budget-period-cron.service";
import { BudgetPeriodService } from "./budget-period.service";
import { BudgetReportsService } from "./budget-reports.service";
import { EmailService } from "../notifications/email.service";
import { Budget, BudgetType, BudgetStrategy } from "./entities/budget.entity";
import { BudgetPeriod, PeriodStatus } from "./entities/budget-period.entity";
import { User } from "../users/entities/user.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { NotificationPreferenceService } from "../notification-center/notification-preference.service";
import { NotificationCategory } from "../notification-center/entities/notification.entity";
import {
  createScopedDbMocks,
  DataSourceMock,
} from "../test-helpers/scoped-db-testing";
import {
  createJobClaimMock,
  jobClaimProvider,
  type JobClaimMock,
} from "../test-helpers/job-claim-testing";
import { JobClaimType } from "../common/jobs/job-claim.service";
import { NoOpenPeriodError } from "./budget-period.service";
import { rolloverMonthKey } from "./budget-period-cron.service";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

describe("BudgetPeriodCronService", () => {
  let scopedDataSource: DataSourceMock;
  let service: BudgetPeriodCronService;
  let jobClaims: JobClaimMock;
  let budgetsRepository: Record<string, jest.Mock>;
  let periodsRepository: Record<string, jest.Mock>;
  let usersRepository: Record<string, jest.Mock>;
  let preferencesRepository: Record<string, jest.Mock>;
  let budgetPeriodService: Record<string, jest.Mock>;
  let budgetReportsService: Record<string, jest.Mock>;
  let emailService: Record<string, jest.Mock>;
  let configService: Record<string, jest.Mock>;
  let notificationPreferences: { resolveEmail: jest.Mock };

  const mockBudget: Budget = {
    id: "budget-1",
    userId: "11111111-1111-1111-1111-111111111111",
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
        transferAccountId: null,
        transferAccount: null,
        isTransfer: false,
        amount: 500,
        isIncome: false,
        rolloverType: "NONE" as any,
        rolloverCap: null,
        flexGroup: null,
        bucketId: null,
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
        transferAccountId: null,
        transferAccount: null,
        isTransfer: false,
        amount: 5000,
        isIncome: true,
        rolloverType: "NONE" as any,
        rolloverCap: null,
        flexGroup: null,
        bucketId: null,
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
    id: "11111111-1111-1111-1111-111111111111",
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

    // Mirror the real resolver's master-gate: with no per-category row,
    // resolveEmail == the user's notification_email, so the existing
    // preferencesRepository fixtures keep controlling the email path.
    notificationPreferences = {
      resolveEmail: jest.fn(async (userId: string) => {
        const prefs = await preferencesRepository.findOne({
          where: { userId },
        });
        return prefs ? prefs.notificationEmail !== false : true;
      }),
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

    ({ dataSource: scopedDataSource } = createScopedDbMocks([
      [Budget, budgetsRepository as never],
      [BudgetPeriod, periodsRepository as never],
      [User, usersRepository as never],
      [UserPreference, preferencesRepository as never],
    ]));

    jobClaims = createJobClaimMock();

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
        {
          provide: I18nService,
          useValue: {
            translate: (key: string, opts?: { defaultValue?: string }) =>
              opts?.defaultValue ?? key,
          },
        },
        { provide: DataSource, useValue: scopedDataSource },
        {
          provide: NotificationPreferenceService,
          useValue: notificationPreferences,
        },
        jobClaimProvider(jobClaims),
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
        relations: [
          "categories",
          "categories.category",
          "categories.transferAccount",
        ],
      });
      expect(periodsRepository.findOne).not.toHaveBeenCalled();
      expect(budgetPeriodService.closePeriod).not.toHaveBeenCalled();
    });

    // One month rolls over once per owner, and every replica fires this cron.
    it("claims the owner and month before touching anything", async () => {
      budgetsRepository.find.mockResolvedValue([mockBudget]);
      periodsRepository.findOne.mockResolvedValue(null);

      await service.closeExpiredPeriods();

      expect(jobClaims.claimOnce).toHaveBeenCalledWith(
        JobClaimType.BudgetPeriodRollover,
        "11111111-1111-1111-1111-111111111111",
        rolloverMonthKey(new Date()),
      );
    });

    it("takes one claim for an owner with several budgets", async () => {
      const second = { ...mockBudget, id: "budget-2", name: "Second" };
      budgetsRepository.find.mockResolvedValue([mockBudget, second]);
      periodsRepository.findOne.mockResolvedValue(null);

      await service.closeExpiredPeriods();

      // Per owner, not per budget: the rollover's unit of work is the owner,
      // and `job_claims.user_id` is a foreign key to `users` so there is no
      // deployment-wide claim to take instead.
      expect(jobClaims.claimOnce).toHaveBeenCalledTimes(1);
    });

    // The whole point of the claim: the replica that lost does no work at all,
    // rather than racing the winner budget by budget.
    it("skips the owner entirely when another replica holds the claim", async () => {
      jobClaims.claimOnce.mockResolvedValue(false);
      budgetsRepository.find.mockResolvedValue([mockBudget]);
      periodsRepository.findOne.mockResolvedValue({
        ...mockOpenPeriod,
        periodEnd: "2025-12-31",
      });

      await service.closeExpiredPeriods();

      expect(periodsRepository.findOne).not.toHaveBeenCalled();
      expect(budgetPeriodService.closePeriod).not.toHaveBeenCalled();
    });

    // A rollout can briefly run two processes on one replica, and the loser of
    // `closePeriod`'s row lock sees this. It is the normal outcome of that tick,
    // not a failure to log a stack for.
    it("counts a NoOpenPeriodError as a skip, not an error", async () => {
      budgetsRepository.find.mockResolvedValue([mockBudget]);
      periodsRepository.findOne.mockResolvedValue({
        ...mockOpenPeriod,
        periodEnd: "2025-12-31",
      });
      budgetPeriodService.closePeriod.mockRejectedValue(
        new NoOpenPeriodError(),
      );
      const errorSpy = jest
        .spyOn(service["logger"], "error")
        .mockImplementation(() => undefined);

      await service.closeExpiredPeriods();

      expect(errorSpy).not.toHaveBeenCalled();
      errorSpy.mockRestore();
    });

    it("still counts a real failure as an error", async () => {
      budgetsRepository.find.mockResolvedValue([mockBudget]);
      periodsRepository.findOne.mockResolvedValue({
        ...mockOpenPeriod,
        periodEnd: "2025-12-31",
      });
      budgetPeriodService.closePeriod.mockRejectedValue(
        new Error("Connection reset"),
      );
      const errorSpy = jest
        .spyOn(service["logger"], "error")
        .mockImplementation(() => undefined);

      await service.closeExpiredPeriods();

      expect(errorSpy).toHaveBeenCalled();
      errorSpy.mockRestore();
    });

    // A claim is not a record that the work was done. Keeping it after a
    // failure asserts a rollover that did not happen, and because this cron is
    // monthly there is no later tick to notice.
    it("hands the month back when a budget's close failed", async () => {
      budgetsRepository.find.mockResolvedValue([mockBudget]);
      periodsRepository.findOne.mockResolvedValue({
        ...mockOpenPeriod,
        periodEnd: "2025-12-31",
      });
      budgetPeriodService.closePeriod.mockRejectedValue(
        new Error("could not serialize access"),
      );
      jest
        .spyOn(service["logger"], "error")
        .mockImplementation(() => undefined);

      await service.closeExpiredPeriods();

      expect(jobClaims.releasePermanentClaim).toHaveBeenCalledWith(
        JobClaimType.BudgetPeriodRollover,
        "11111111-1111-1111-1111-111111111111",
        rolloverMonthKey(new Date()),
      );
    });

    it("keeps the month when every budget got through", async () => {
      budgetsRepository.find.mockResolvedValue([mockBudget]);
      periodsRepository.findOne.mockResolvedValue({
        ...mockOpenPeriod,
        periodEnd: "2025-12-31",
      });

      await service.closeExpiredPeriods();

      expect(jobClaims.releasePermanentClaim).not.toHaveBeenCalled();
    });

    // The loser of the row lock is a normal tick, not a failure -- so it must
    // not hand back a month the winner has just rolled over.
    it("keeps the month when the only error was a NoOpenPeriodError", async () => {
      budgetsRepository.find.mockResolvedValue([mockBudget]);
      periodsRepository.findOne.mockResolvedValue({
        ...mockOpenPeriod,
        periodEnd: "2025-12-31",
      });
      budgetPeriodService.closePeriod.mockRejectedValue(
        new NoOpenPeriodError(),
      );

      await service.closeExpiredPeriods();

      expect(jobClaims.releasePermanentClaim).not.toHaveBeenCalled();
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
        "11111111-1111-1111-1111-111111111111",
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
        userId: "22222222-2222-2222-2222-222222222222",
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
        "11111111-1111-1111-1111-111111111111",
        "budget-1",
      );
    });

    it("continues processing other budgets when one fails", async () => {
      const budget2: Budget = {
        ...mockBudget,
        id: "budget-2",
        userId: "22222222-2222-2222-2222-222222222222",
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
        "22222222-2222-2222-2222-222222222222",
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
        userId: "22222222-2222-2222-2222-222222222222",
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
        "11111111-1111-1111-1111-111111111111",
        "budget-1",
      );
      expect(budgetPeriodService.closePeriod).toHaveBeenCalledWith(
        "22222222-2222-2222-2222-222222222222",
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
        userId: "11111111-1111-1111-1111-111111111111",
        notificationEmail: false,
        budgetDigestEnabled: true,
      });

      await service.sendMonthlySummaryEmails(closedPeriods);

      expect(usersRepository.findOne).not.toHaveBeenCalled();
      expect(emailService.sendMail).not.toHaveBeenCalled();
    });

    it("skips users whose BUDGETS email channel is off, master on", async () => {
      // The monthly summary is a BUDGETS email: a per-category off must
      // suppress it even while the global master switch is on and the digest
      // toggle is on (audit Finding 1 -- it used to gate on the master only).
      preferencesRepository.findOne.mockResolvedValue({
        userId: "11111111-1111-1111-1111-111111111111",
        notificationEmail: true,
        budgetDigestEnabled: true,
      });
      notificationPreferences.resolveEmail.mockResolvedValue(false);

      await service.sendMonthlySummaryEmails(closedPeriods);

      expect(notificationPreferences.resolveEmail).toHaveBeenCalledWith(
        "11111111-1111-1111-1111-111111111111",
        NotificationCategory.BUDGETS,
      );
      expect(usersRepository.findOne).not.toHaveBeenCalled();
      expect(emailService.sendMail).not.toHaveBeenCalled();
    });

    it("skips users with disabled budget digest", async () => {
      preferencesRepository.findOne.mockResolvedValue({
        userId: "11111111-1111-1111-1111-111111111111",
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

    it.each([
      [-300, "$200.00", false],
      [120, "-$220.00", true],
    ] as const)(
      "uses the signed February opening in the email with net spending of %s",
      async (actual, formattedRemaining, overBudget) => {
        preferencesRepository.findOne.mockResolvedValue(null);
        usersRepository.findOne.mockResolvedValue(mockUser);
        const period = {
          ...mockClosedPeriod,
          periodStart: "2026-02-01",
          periodEnd: "2026-02-28",
          totalBudgeted: 100,
          actualExpenses: actual,
          periodCategories: [
            {
              ...mockClosedPeriod.periodCategories[0],
              budgetedAmount: 100,
              rolloverIn: -200,
              effectiveBudget: -100,
              actualAmount: actual,
            },
          ],
        };

        await service.sendMonthlySummaryEmails([
          { budget: mockBudget, period },
        ]);

        const html = emailService.sendMail.mock.calls[0][2];
        expect(html).toContain(`>${formattedRemaining}</span>`);
        expect(html).toContain("/ -$100.00");
        expect(html.includes(">Over Budget</h4>")).toBe(overBudget);
      },
    );

    it("retains the stored total for missing expense rows and adds only known expense carry", async () => {
      preferencesRepository.findOne.mockResolvedValue(null);
      usersRepository.findOne.mockResolvedValue(mockUser);
      const budget = {
        ...mockBudget,
        categories: [
          ...mockBudget.categories,
          { ...mockBudget.categories[0], id: "missing-line", amount: 200 },
        ],
      };
      const period = {
        ...mockClosedPeriod,
        totalBudgeted: 300,
        actualExpenses: 0,
        periodCategories: [
          {
            ...mockClosedPeriod.periodCategories[0],
            budgetedAmount: 100,
            rolloverIn: -200,
            effectiveBudget: -100,
            actualAmount: 0,
          },
          {
            ...mockClosedPeriod.periodCategories[0],
            budgetCategoryId: "bc-2",
            budgetedAmount: 5000,
            rolloverIn: 50,
            effectiveBudget: 5050,
          },
        ],
      };

      await service.sendMonthlySummaryEmails([{ budget, period }]);

      const html = emailService.sendMail.mock.calls[0][2];
      expect(html).toContain(">$100.00</span>");
      expect(html).not.toContain(">$150.00</span>");
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
        userId: "22222222-2222-2222-2222-222222222222",
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
          id: "22222222-2222-2222-2222-222222222222",
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
