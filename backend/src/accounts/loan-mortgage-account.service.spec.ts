import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import {
  createScopedDbMocks,
  ManagerMock,
} from "../test-helpers/scoped-db-testing";
import { ACCOUNT_BALANCE_AS_OF_SQL } from "../common/ledger-balance.sql";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);
import {
  BadRequestException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { LoanMortgageAccountService } from "./loan-mortgage-account.service";
import { Account, AccountType } from "./entities/account.entity";
import { Institution } from "../institutions/entities/institution.entity";
import { CategoriesService } from "../categories/categories.service";
import { ScheduledTransactionsService } from "../scheduled-transactions/scheduled-transactions.service";
import { LoanRateChangesService } from "../loan-rate-changes/loan-rate-changes.service";
import { LoanPaymentDetectorService } from "./loan-payment-detector.service";
import { LoanPaymentMatchingService } from "./loan-payment-matching.service";
import { CreateAccountDto } from "./dto/create-account.dto";

describe("LoanMortgageAccountService", () => {
  let service: LoanMortgageAccountService;
  let accountsRepository: Record<string, jest.Mock>;
  let institutionsRepository: Record<string, jest.Mock>;
  let categoriesService: Record<string, jest.Mock>;
  let scheduledTransactionsService: Record<string, jest.Mock>;
  let loanRateChangesService: Record<string, jest.Mock>;
  let paymentMatching: jest.Mocked<
    Pick<
      LoanPaymentMatchingService,
      "assertDefinable" | "createMatchingRuleReported"
    >
  >;
  let manager: ManagerMock;

  const userId = "user-1";

  beforeEach(async () => {
    paymentMatching = {
      assertDefinable: jest.fn(),
      createMatchingRuleReported: jest
        .fn()
        .mockResolvedValue({ ruleId: "rule-1", error: null }),
    };
    accountsRepository = {
      create: jest.fn().mockImplementation((data: any) => ({
        id: "new-acc-id",
        ...data,
      })),
      save: jest.fn().mockImplementation((entity: any) => {
        if (!entity.id) entity.id = "new-acc-id";
        return Promise.resolve(entity);
      }),
      findOne: jest.fn().mockResolvedValue(null),
    };

    institutionsRepository = {
      findOne: jest.fn().mockResolvedValue(null),
    };

    categoriesService = {
      findLoanCategories: jest.fn().mockResolvedValue({
        interestCategory: { id: "cat-interest", name: "Loan Interest" },
      }),
    };

    scheduledTransactionsService = {
      create: jest.fn().mockResolvedValue({
        id: "sched-tx-1",
      }),
      update: jest.fn().mockResolvedValue({
        id: "sched-tx-1",
      }),
    };

    loanRateChangesService = {
      create: jest.fn().mockImplementation((_userId, _accountId, dto) =>
        Promise.resolve({
          id: "rate-change-1",
          effectiveDate: dto.effectiveDate,
          annualRate: dto.annualRate,
          newPaymentAmount:
            dto.newPaymentAmount ?? (dto.recalculatePayment ? 2750.55 : null),
          source: "manual",
        }),
      ),
      applyScheduledPaymentSync: jest.fn().mockResolvedValue(null),
    };

    const mocks = createScopedDbMocks([
      [Account, accountsRepository],
      [Institution, institutionsRepository],
    ]);
    const { dataSource } = mocks;
    manager = mocks.manager;
    // The dated ledger debt (`datedLoanDebt`): the as-of balance the rate
    // update prices from, here equal to the fixture's current balance.
    manager.query.mockResolvedValue([{ balance: "-450000" }]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LoanMortgageAccountService,
        { provide: DataSource, useValue: dataSource },
        {
          provide: CategoriesService,
          useValue: categoriesService,
        },
        {
          provide: ScheduledTransactionsService,
          useValue: scheduledTransactionsService,
        },
        {
          provide: LoanRateChangesService,
          useValue: loanRateChangesService,
        },
        { provide: LoanPaymentDetectorService, useValue: {} },
        { provide: LoanPaymentMatchingService, useValue: paymentMatching },
      ],
    }).compile();

    service = module.get<LoanMortgageAccountService>(
      LoanMortgageAccountService,
    );
  });

  describe("createLoanAccount", () => {
    const makeValidLoanDto = (): CreateAccountDto =>
      ({
        accountType: AccountType.LOAN,
        name: "Car Loan",
        currencyCode: "CAD",
        openingBalance: 25000,
        paymentAmount: 500,
        paymentFrequency: "MONTHLY",
        paymentStartDate: "2025-01-15",
        sourceAccountId: "acc-chequing",
        interestRate: 5.5,
        institution: "TD Bank",
      }) as any;

    it("should create a loan account with correct fields", async () => {
      const dto = makeValidLoanDto();
      await service.createLoanAccount(userId, dto);

      expect(accountsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId,
          openingBalance: -25000,
          currentBalance: -25000,
          interestRate: 5.5,
          institution: "TD Bank",
          paymentAmount: 500,
          paymentFrequency: "MONTHLY",
          sourceAccountId: "acc-chequing",
        }),
      );
      expect(accountsRepository.save).toHaveBeenCalled();
    });

    it("should create a scheduled transaction for loan payments", async () => {
      const dto = makeValidLoanDto();
      await service.createLoanAccount(userId, dto);

      expect(scheduledTransactionsService.create).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          accountId: "acc-chequing",
          name: expect.stringContaining("Loan Payment"),
          payeeName: "TD Bank",
          amount: -500,
          currencyCode: "CAD",
          frequency: "MONTHLY",
          isActive: true,
          autoPost: false,
          splits: expect.arrayContaining([
            expect.objectContaining({ memo: "Principal" }),
            expect.objectContaining({ memo: "Interest" }),
          ]),
        }),
      );
    });

    it("should save scheduledTransactionId back to account", async () => {
      const dto = makeValidLoanDto();
      await service.createLoanAccount(userId, dto);

      // Save is called twice: once for initial creation, once to add scheduledTransactionId
      expect(accountsRepository.save).toHaveBeenCalledTimes(2);
      const secondSaveArg = accountsRepository.save.mock.calls[1][0];
      expect(secondSaveArg.scheduledTransactionId).toBe("sched-tx-1");
    });

    it("should store openingBalance and currentBalance as negative", async () => {
      const dto = makeValidLoanDto();
      dto.openingBalance = 15000;
      await service.createLoanAccount(userId, dto);

      expect(accountsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          openingBalance: -15000,
          currentBalance: -15000,
        }),
      );
    });

    it("should use absolute value of openingBalance", async () => {
      const dto = makeValidLoanDto();
      dto.openingBalance = -15000;
      await service.createLoanAccount(userId, dto);

      expect(accountsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          openingBalance: -15000,
          currentBalance: -15000,
        }),
      );
    });

    it("should default openingBalance to 0 when not provided", async () => {
      const dto = makeValidLoanDto();
      delete dto.openingBalance;
      await service.createLoanAccount(userId, dto);

      expect(accountsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          openingBalance: -0,
          currentBalance: -0,
        }),
      );
    });

    it("should throw BadRequestException when paymentAmount is missing", async () => {
      const dto = makeValidLoanDto();
      delete (dto as any).paymentAmount;

      await expect(service.createLoanAccount(userId, dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should throw BadRequestException when paymentFrequency is missing", async () => {
      const dto = makeValidLoanDto();
      delete (dto as any).paymentFrequency;

      await expect(service.createLoanAccount(userId, dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should throw BadRequestException when paymentStartDate is missing", async () => {
      const dto = makeValidLoanDto();
      delete (dto as any).paymentStartDate;

      await expect(service.createLoanAccount(userId, dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should throw BadRequestException when sourceAccountId is missing", async () => {
      const dto = makeValidLoanDto();
      delete (dto as any).sourceAccountId;

      await expect(service.createLoanAccount(userId, dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should throw BadRequestException when interestRate is undefined", async () => {
      const dto = makeValidLoanDto();
      delete (dto as any).interestRate;

      await expect(service.createLoanAccount(userId, dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should throw BadRequestException when interestRate is null", async () => {
      const dto = makeValidLoanDto();
      (dto as any).interestRate = null;

      await expect(service.createLoanAccount(userId, dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should throw BadRequestException when institution is missing", async () => {
      const dto = makeValidLoanDto();
      delete (dto as any).institution;

      await expect(service.createLoanAccount(userId, dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should resolve the institution name from institutionId when no free-text institution is given", async () => {
      const dto = makeValidLoanDto();
      delete (dto as any).institution;
      (dto as any).institutionId = "inst-1";
      institutionsRepository.findOne.mockResolvedValue({
        id: "inst-1",
        name: "PKO BP",
      });

      await service.createLoanAccount(userId, dto);

      expect(institutionsRepository.findOne).toHaveBeenCalledWith({
        where: { id: "inst-1", userId },
      });
      expect(scheduledTransactionsService.create).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({ payeeName: "PKO BP" }),
      );
    });

    it("should throw when institutionId references an unknown institution", async () => {
      const dto = makeValidLoanDto();
      delete (dto as any).institution;
      (dto as any).institutionId = "missing";
      institutionsRepository.findOne.mockResolvedValue(null);

      await expect(service.createLoanAccount(userId, dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should use provided interestCategoryId instead of looking up", async () => {
      const dto = makeValidLoanDto();
      (dto as any).interestCategoryId = "custom-cat-id";

      await service.createLoanAccount(userId, dto);

      expect(categoriesService.findLoanCategories).not.toHaveBeenCalled();
      expect(accountsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          interestCategoryId: "custom-cat-id",
        }),
      );
    });

    it("should look up default interest category when not provided", async () => {
      const dto = makeValidLoanDto();

      await service.createLoanAccount(userId, dto);

      expect(categoriesService.findLoanCategories).toHaveBeenCalledWith(userId);
      expect(accountsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          interestCategoryId: "cat-interest",
        }),
      );
    });

    it("should handle missing interestCategory from findLoanCategories", async () => {
      categoriesService.findLoanCategories.mockResolvedValue({
        interestCategory: null,
      });

      const dto = makeValidLoanDto();

      await service.createLoanAccount(userId, dto);

      expect(accountsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          interestCategoryId: null,
        }),
      );
    });
  });

  describe("createMortgageAccount", () => {
    const makeValidMortgageDto = (): CreateAccountDto =>
      ({
        accountType: AccountType.MORTGAGE,
        name: "Home Mortgage",
        currencyCode: "CAD",
        openingBalance: 500000,
        mortgagePaymentFrequency: "MONTHLY",
        paymentStartDate: "2025-01-01",
        sourceAccountId: "acc-chequing",
        interestRate: 5.0,
        institution: "RBC",
        amortizationMonths: 300,
        isCanadianMortgage: true,
        isVariableRate: false,
        termMonths: 60,
      }) as any;

    it("should create a mortgage account with correct fields", async () => {
      const dto = makeValidMortgageDto();
      await service.createMortgageAccount(userId, dto);

      expect(accountsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId,
          openingBalance: -500000,
          currentBalance: -500000,
          interestRate: 5.0,
          institution: "RBC",
          mortgageType: "CANADIAN_FIXED",
          isCanadianMortgage: true,
          isVariableRate: false,
          amortizationMonths: 300,
          originalPrincipal: 500000,
        }),
      );
    });

    it("should create a scheduled transaction for mortgage payments", async () => {
      const dto = makeValidMortgageDto();
      await service.createMortgageAccount(userId, dto);

      expect(scheduledTransactionsService.create).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          accountId: "acc-chequing",
          name: expect.stringContaining("Mortgage Payment"),
          payeeName: "RBC",
          isActive: true,
          autoPost: false,
          splits: expect.arrayContaining([
            expect.objectContaining({ memo: "Principal" }),
            expect.objectContaining({ memo: "Interest" }),
          ]),
        }),
      );
    });

    it("should calculate and set term end date when termMonths is provided", async () => {
      const dto = makeValidMortgageDto();
      dto.termMonths = 60;

      await service.createMortgageAccount(userId, dto);

      expect(accountsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          termMonths: 60,
          termEndDate: expect.any(Date),
        }),
      );
    });

    it("should set termEndDate to null when termMonths is not provided", async () => {
      const dto = makeValidMortgageDto();
      delete dto.termMonths;

      await service.createMortgageAccount(userId, dto);

      expect(accountsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          termMonths: null,
          termEndDate: null,
        }),
      );
    });

    it("should set termEndDate to null when termMonths is 0 (no term)", async () => {
      const dto = makeValidMortgageDto();
      dto.termMonths = 0;

      await service.createMortgageAccount(userId, dto);

      expect(accountsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          termMonths: null,
          termEndDate: null,
        }),
      );
    });

    it("should throw BadRequestException when mortgagePaymentFrequency is missing", async () => {
      const dto = makeValidMortgageDto();
      delete (dto as any).mortgagePaymentFrequency;

      await expect(service.createMortgageAccount(userId, dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should throw BadRequestException when amortizationMonths is missing", async () => {
      const dto = makeValidMortgageDto();
      delete dto.amortizationMonths;

      await expect(service.createMortgageAccount(userId, dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should throw BadRequestException when interestRate is undefined", async () => {
      const dto = makeValidMortgageDto();
      delete dto.interestRate;

      await expect(service.createMortgageAccount(userId, dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should throw BadRequestException when institution is missing", async () => {
      const dto = makeValidMortgageDto();
      delete dto.institution;

      await expect(service.createMortgageAccount(userId, dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should resolve the institution name from institutionId when no free-text institution is given", async () => {
      const dto = makeValidMortgageDto();
      delete dto.institution;
      (dto as any).institutionId = "inst-2";
      institutionsRepository.findOne.mockResolvedValue({
        id: "inst-2",
        name: "PKO BP",
      });

      await service.createMortgageAccount(userId, dto);

      expect(institutionsRepository.findOne).toHaveBeenCalledWith({
        where: { id: "inst-2", userId },
      });
      expect(scheduledTransactionsService.create).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({ payeeName: "PKO BP" }),
      );
    });

    it("should throw when institutionId references an unknown institution", async () => {
      const dto = makeValidMortgageDto();
      delete dto.institution;
      (dto as any).institutionId = "missing";
      institutionsRepository.findOne.mockResolvedValue(null);

      await expect(service.createMortgageAccount(userId, dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should throw BadRequestException when paymentStartDate is missing", async () => {
      const dto = makeValidMortgageDto();
      delete (dto as any).paymentStartDate;

      await expect(service.createMortgageAccount(userId, dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should throw BadRequestException when sourceAccountId is missing", async () => {
      const dto = makeValidMortgageDto();
      delete (dto as any).sourceAccountId;

      await expect(service.createMortgageAccount(userId, dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should map ACCELERATED_BIWEEKLY to BIWEEKLY for scheduled frequency", async () => {
      const dto = makeValidMortgageDto();
      (dto as any).mortgagePaymentFrequency = "ACCELERATED_BIWEEKLY";

      await service.createMortgageAccount(userId, dto);

      expect(scheduledTransactionsService.create).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          frequency: "BIWEEKLY",
        }),
      );
    });

    it("should map ACCELERATED_WEEKLY to WEEKLY for scheduled frequency", async () => {
      const dto = makeValidMortgageDto();
      (dto as any).mortgagePaymentFrequency = "ACCELERATED_WEEKLY";

      await service.createMortgageAccount(userId, dto);

      expect(scheduledTransactionsService.create).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          frequency: "WEEKLY",
        }),
      );
    });

    it("stores originalPrincipal apart from the opening balance when given", async () => {
      await service.createMortgageAccount(userId, {
        ...makeValidMortgageDto(),
        openingBalance: 450000,
        originalPrincipal: 500000,
      });

      expect(accountsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          openingBalance: -450000,
          currentBalance: -450000,
          originalPrincipal: 500000,
        }),
      );
    });

    describe("payment matching", () => {
      const paymentMatchingDto = { payeePattern: "RBC MORTGAGE*" };

      it("checks the patterns before writing, then creates the rule for the saved mortgage", async () => {
        const created = await service.createMortgageAccount(userId, {
          ...makeValidMortgageDto(),
          paymentMatching: paymentMatchingDto,
        });

        expect(paymentMatching.assertDefinable).toHaveBeenCalledWith(
          "acc-chequing",
          paymentMatchingDto,
        );
        expect(
          paymentMatching.assertDefinable.mock.invocationCallOrder[0],
        ).toBeLessThan(accountsRepository.save.mock.invocationCallOrder[0]);
        expect(paymentMatching.createMatchingRuleReported).toHaveBeenCalledWith(
          userId,
          "new-acc-id",
          paymentMatchingDto,
        );
        // After the account points at its schedule.
        expect(
          paymentMatching.createMatchingRuleReported.mock
            .invocationCallOrder[0],
        ).toBeGreaterThan(accountsRepository.save.mock.invocationCallOrder[1]);
        expect(created).toMatchObject({
          scheduledTransactionId: "sched-tx-1",
          paymentMatchingRuleId: "rule-1",
          paymentMatchingError: null,
        });
        // Not spread into the account row.
        expect(accountsRepository.create.mock.calls[0][0]).not.toHaveProperty(
          "paymentMatching",
        );
      });

      it("refuses a pattern the rule would refuse before anything is written", async () => {
        paymentMatching.assertDefinable.mockImplementation(() => {
          throw new BadRequestException("The rule definition is not valid");
        });

        await expect(
          service.createMortgageAccount(userId, {
            ...makeValidMortgageDto(),
            paymentMatching: { payeePattern: "RBC|TD*" },
          }),
        ).rejects.toThrow(BadRequestException);
        expect(accountsRepository.save).not.toHaveBeenCalled();
        expect(scheduledTransactionsService.create).not.toHaveBeenCalled();
      });

      it("reports a rule it could not create on the saved mortgage, which stays", async () => {
        const error = {
          errorCode: "RULE_LIMIT_REACHED",
          message: "At most 200 rules can be created",
        };
        paymentMatching.createMatchingRuleReported.mockResolvedValue({
          ruleId: null,
          error,
        });

        const created = await service.createMortgageAccount(userId, {
          ...makeValidMortgageDto(),
          paymentMatching: paymentMatchingDto,
        });

        expect(created).toMatchObject({
          id: "new-acc-id",
          scheduledTransactionId: "sched-tx-1",
          paymentMatchingRuleId: null,
          paymentMatchingError: error,
        });
        expect(accountsRepository.save).toHaveBeenCalledTimes(2);
      });

      it("creates no rule when the request asks for none", async () => {
        const created = await service.createMortgageAccount(
          userId,
          makeValidMortgageDto(),
        );

        expect(paymentMatching.assertDefinable).not.toHaveBeenCalled();
        expect(
          paymentMatching.createMatchingRuleReported,
        ).not.toHaveBeenCalled();
        expect(created).not.toHaveProperty("paymentMatchingError");
      });

      it("creates the rule for a loan created with its payment too", async () => {
        const created = await service.createLoanAccount(userId, {
          accountType: AccountType.LOAN,
          name: "Car Loan",
          currencyCode: "CAD",
          openingBalance: 25000,
          paymentAmount: 500,
          paymentFrequency: "MONTHLY",
          paymentStartDate: "2025-01-15",
          sourceAccountId: "acc-chequing",
          interestRate: 5.5,
          institution: "TD Bank",
          originalPrincipal: 30000,
          paymentMatching: paymentMatchingDto,
        } as CreateAccountDto);

        expect(paymentMatching.assertDefinable).toHaveBeenCalledWith(
          "acc-chequing",
          paymentMatchingDto,
        );
        expect(accountsRepository.create).toHaveBeenCalledWith(
          expect.objectContaining({
            openingBalance: -25000,
            originalPrincipal: 30000,
          }),
        );
        expect(paymentMatching.createMatchingRuleReported).toHaveBeenCalledWith(
          userId,
          "new-acc-id",
          paymentMatchingDto,
        );
        expect(created.paymentMatchingRuleId).toBe("rule-1");
      });
    });

    it("should save scheduledTransactionId back to account", async () => {
      const dto = makeValidMortgageDto();
      await service.createMortgageAccount(userId, dto);

      expect(accountsRepository.save).toHaveBeenCalledTimes(2);
      const secondSaveArg = accountsRepository.save.mock.calls[1][0];
      expect(secondSaveArg.scheduledTransactionId).toBe("sched-tx-1");
    });
  });

  describe("previewMortgageAmortization", () => {
    it("should return amortization result with payment details", () => {
      const result = service.previewMortgageAmortization(
        500000,
        5.0,
        300,
        "MONTHLY" as any,
        new Date("2025-01-01"),
        "CANADIAN_FIXED",
      );

      expect(result).toBeDefined();
      expect(result.paymentAmount).toBeGreaterThan(0);
      expect(result.principalPayment).toBeGreaterThan(0);
      expect(result.interestPayment).toBeGreaterThan(0);
      expect(result.totalPayments).toBeGreaterThan(0);
      expect(result.endDate).toBeInstanceOf(Date);
    });

    it("should use absolute value of mortgage amount", () => {
      const result1 = service.previewMortgageAmortization(
        500000,
        5.0,
        300,
        "MONTHLY" as any,
        new Date("2025-01-01"),
        "ANNUITY",
      );
      const result2 = service.previewMortgageAmortization(
        -500000,
        5.0,
        300,
        "MONTHLY" as any,
        new Date("2025-01-01"),
        "ANNUITY",
      );

      expect(result1.paymentAmount).toBe(result2.paymentAmount);
    });
  });

  describe("previewLoanAmortization", () => {
    it("should return amortization result with payment split", () => {
      const result = service.previewLoanAmortization(
        25000,
        5.5,
        500,
        "MONTHLY",
        new Date("2025-01-15"),
      );

      expect(result).toBeDefined();
      expect(result.principalPayment).toBeGreaterThan(0);
      expect(result.interestPayment).toBeGreaterThan(0);
      expect(result.remainingBalance).toBeGreaterThan(0);
      expect(result.totalPayments).toBeGreaterThan(0);
      expect(result.endDate).toBeInstanceOf(Date);
    });

    it("should use absolute value of loan amount", () => {
      const result1 = service.previewLoanAmortization(
        25000,
        5.5,
        500,
        "MONTHLY",
        new Date("2025-01-15"),
      );
      const result2 = service.previewLoanAmortization(
        -25000,
        5.5,
        500,
        "MONTHLY",
        new Date("2025-01-15"),
      );

      expect(result1.principalPayment).toBe(result2.principalPayment);
    });
  });

  describe("updateMortgageRate", () => {
    const makeMortgageAccount = (overrides: Partial<Account> = {}): Account =>
      ({
        id: "acc-mortgage",
        userId,
        accountType: AccountType.MORTGAGE,
        name: "Home Mortgage",
        currentBalance: -450000,
        interestRate: 5.0,
        paymentAmount: 2900,
        paymentFrequency: "MONTHLY",
        paymentStartDate: new Date("2024-01-01"),
        amortizationMonths: 300,
        isCanadianMortgage: true,
        isVariableRate: false,
        isClosed: false,
        scheduledTransactionId: "sched-tx-1",
        interestCategoryId: "cat-interest",
        ...overrides,
      }) as Account;

    it("should update the mortgage rate and payment amount", async () => {
      const account = makeMortgageAccount();
      const result = await service.updateMortgageRate(
        account,
        userId,
        4.5,
        new Date("2025-06-01"),
      );

      expect(result.newRate).toBe(4.5);
      expect(result.paymentAmount).toBeGreaterThan(0);
      expect(result.principalPayment).toBeGreaterThan(0);
      expect(result.interestPayment).toBeGreaterThan(0);
      expect(result.effectiveDate).toBe("2025-06-01");
    });

    it("applies the scheduled-payment sync at once through the rate-change service's apply, after recording the change", async () => {
      await service.updateMortgageRate(
        makeMortgageAccount(),
        userId,
        4.5,
        new Date("2025-06-01"),
      );

      expect(
        loanRateChangesService.applyScheduledPaymentSync,
      ).toHaveBeenCalledWith(userId, "acc-mortgage");
      const createOrder =
        loanRateChangesService.create.mock.invocationCallOrder[0];
      const applyOrder =
        loanRateChangesService.applyScheduledPaymentSync.mock
          .invocationCallOrder[0];
      expect(createOrder).toBeLessThan(applyOrder);
      // The template is written by the loan core, never by the schedule
      // service's update (which writes accounts.payment_amount), and the
      // account row is not saved here.
      expect(scheduledTransactionsService.update).not.toHaveBeenCalled();
      expect(accountsRepository.save).not.toHaveBeenCalled();
    });

    it("answers the rate update when the sync fails after the change is recorded", async () => {
      loanRateChangesService.applyScheduledPaymentSync.mockRejectedValue(
        new Error("ledger unreadable"),
      );

      const result = await service.updateMortgageRate(
        makeMortgageAccount(),
        userId,
        4.5,
        new Date("2025-06-01"),
      );

      expect(result.newRate).toBe(4.5);
      expect(loanRateChangesService.create).toHaveBeenCalledTimes(1);
    });

    it("should record a rate-history row with the recalculate default", async () => {
      const account = makeMortgageAccount();
      await service.updateMortgageRate(
        account,
        userId,
        4.5,
        new Date("2025-06-01"),
      );

      expect(loanRateChangesService.create).toHaveBeenCalledWith(
        userId,
        "acc-mortgage",
        {
          effectiveDate: "2025-06-01",
          annualRate: 4.5,
          newPaymentAmount: null,
          recalculatePayment: true,
        },
      );
    });

    it("should throw BadRequestException for non-mortgage accounts", async () => {
      const account = makeMortgageAccount({
        accountType: AccountType.LOAN,
      });

      await expect(
        service.updateMortgageRate(account, userId, 4.5, new Date()),
      ).rejects.toThrow(BadRequestException);
      expect(loanRateChangesService.create).not.toHaveBeenCalled();
    });

    it("should throw BadRequestException for closed accounts", async () => {
      const account = makeMortgageAccount({ isClosed: true });

      await expect(
        service.updateMortgageRate(account, userId, 4.5, new Date()),
      ).rejects.toThrow(BadRequestException);
      expect(loanRateChangesService.create).not.toHaveBeenCalled();
    });

    it("should use custom payment amount when provided", async () => {
      const account = makeMortgageAccount();
      const customPayment = 3000;

      const result = await service.updateMortgageRate(
        account,
        userId,
        4.5,
        new Date("2025-06-01"),
        customPayment,
      );

      expect(result.paymentAmount).toBe(3000);
      expect(loanRateChangesService.create).toHaveBeenCalledWith(
        userId,
        "acc-mortgage",
        {
          effectiveDate: "2025-06-01",
          annualRate: 4.5,
          newPaymentAmount: 3000,
          recalculatePayment: false,
        },
      );
    });

    it("prices the split from the ledger debt through the effective date", async () => {
      // Spec decision 5: a payment already posted for a date before the
      // change is not owed by it, so the debt is the as-of ledger balance at
      // the effective date, not the through-today current balance.
      const account = makeMortgageAccount({
        mortgageType: "ANNUITY",
        isCanadianMortgage: false,
        isVariableRate: false,
      });
      manager.query.mockResolvedValue([{ balance: "-440000" }]);

      const result = await service.updateMortgageRate(
        account,
        userId,
        6,
        new Date("2025-06-01"),
      );

      expect(manager.query).toHaveBeenCalledWith(ACCOUNT_BALANCE_AS_OF_SQL, [
        "acc-mortgage",
        userId,
        "2025-06-01",
      ]);
      // 440,000 at 6% / 12, not the 450,000 the current balance holds.
      expect(result.interestPayment).toBe(2200);
      expect(result.principalPayment).toBe(550.55);
    });

    it("refuses when the ledger cannot be read, rather than price from zero", async () => {
      manager.query.mockResolvedValue([]);

      await expect(
        service.updateMortgageRate(
          makeMortgageAccount(),
          userId,
          4.5,
          new Date("2025-06-01"),
        ),
      ).rejects.toThrow(ServiceUnavailableException);
      // Refused before the rate change is recorded: nothing was written.
      expect(loanRateChangesService.create).not.toHaveBeenCalled();
    });

    it("reads the stored type over the flags", async () => {
      const storedAnnuity = await service.updateMortgageRate(
        makeMortgageAccount({
          mortgageType: "ANNUITY",
          isCanadianMortgage: true,
          isVariableRate: false,
        }),
        userId,
        6,
        new Date("2025-06-01"),
      );
      // ANNUITY divides the nominal rate: 450,000 x 0.06 / 12.
      expect(storedAnnuity.interestPayment).toBe(2250);
    });

    it("should handle variable rate mortgage calculation differently", async () => {
      const fixedAccount = makeMortgageAccount({
        isCanadianMortgage: true,
        isVariableRate: false,
      });
      const variableAccount = makeMortgageAccount({
        isCanadianMortgage: true,
        isVariableRate: true,
      });

      const fixedResult = await service.updateMortgageRate(
        fixedAccount,
        userId,
        5.0,
        new Date("2025-06-01"),
      );
      const variableResult = await service.updateMortgageRate(
        variableAccount,
        userId,
        5.0,
        new Date("2025-06-01"),
      );

      // Canadian fixed uses semi-annual compounding; variable uses monthly
      // So the results should differ
      expect(fixedResult.interestPayment).not.toBe(
        variableResult.interestPayment,
      );
    });
  });
});
