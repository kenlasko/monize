import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { BadRequestException } from "@nestjs/common";
import { LoanMortgageAccountService } from "./loan-mortgage-account.service";
import { Account, AccountType } from "./entities/account.entity";
import { CategoriesService } from "../categories/categories.service";
import { ScheduledTransactionsService } from "../scheduled-transactions/scheduled-transactions.service";
import { CreateAccountDto } from "./dto/create-account.dto";

describe("LoanMortgageAccountService", () => {
  let service: LoanMortgageAccountService;
  let accountsRepository: Record<string, jest.Mock>;
  let categoriesService: Record<string, jest.Mock>;
  let scheduledTransactionsService: Record<string, jest.Mock>;

  const userId = "user-1";

  beforeEach(async () => {
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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LoanMortgageAccountService,
        {
          provide: getRepositoryToken(Account),
          useValue: accountsRepository,
        },
        {
          provide: CategoriesService,
          useValue: categoriesService,
        },
        {
          provide: ScheduledTransactionsService,
          useValue: scheduledTransactionsService,
        },
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
      const result = await service.createLoanAccount(userId, dto);

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
      const result = await service.createMortgageAccount(userId, dto);

      expect(accountsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId,
          openingBalance: -500000,
          currentBalance: -500000,
          interestRate: 5.0,
          institution: "RBC",
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

    it("should throw BadRequestException when mortgagePaymentFrequency is missing", async () => {
      const dto = makeValidMortgageDto();
      delete (dto as any).mortgagePaymentFrequency;

      await expect(
        service.createMortgageAccount(userId, dto),
      ).rejects.toThrow(BadRequestException);
    });

    it("should throw BadRequestException when amortizationMonths is missing", async () => {
      const dto = makeValidMortgageDto();
      delete dto.amortizationMonths;

      await expect(
        service.createMortgageAccount(userId, dto),
      ).rejects.toThrow(BadRequestException);
    });

    it("should throw BadRequestException when interestRate is undefined", async () => {
      const dto = makeValidMortgageDto();
      delete dto.interestRate;

      await expect(
        service.createMortgageAccount(userId, dto),
      ).rejects.toThrow(BadRequestException);
    });

    it("should throw BadRequestException when institution is missing", async () => {
      const dto = makeValidMortgageDto();
      delete dto.institution;

      await expect(
        service.createMortgageAccount(userId, dto),
      ).rejects.toThrow(BadRequestException);
    });

    it("should throw BadRequestException when paymentStartDate is missing", async () => {
      const dto = makeValidMortgageDto();
      delete (dto as any).paymentStartDate;

      await expect(
        service.createMortgageAccount(userId, dto),
      ).rejects.toThrow(BadRequestException);
    });

    it("should throw BadRequestException when sourceAccountId is missing", async () => {
      const dto = makeValidMortgageDto();
      delete (dto as any).sourceAccountId;

      await expect(
        service.createMortgageAccount(userId, dto),
      ).rejects.toThrow(BadRequestException);
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
        true,
        false,
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
        false,
        false,
      );
      const result2 = service.previewMortgageAmortization(
        -500000,
        5.0,
        300,
        "MONTHLY" as any,
        new Date("2025-01-01"),
        false,
        false,
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
    const makeMortgageAccount = (
      overrides: Partial<Account> = {},
    ): Account =>
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

    it("should save updated account with new rate and payment", async () => {
      const account = makeMortgageAccount();
      await service.updateMortgageRate(
        account,
        userId,
        4.5,
        new Date("2025-06-01"),
      );

      expect(accountsRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          interestRate: 4.5,
        }),
      );
    });

    it("should update scheduled transaction with new split amounts", async () => {
      const account = makeMortgageAccount();
      await service.updateMortgageRate(
        account,
        userId,
        4.5,
        new Date("2025-06-01"),
      );

      expect(scheduledTransactionsService.update).toHaveBeenCalledWith(
        userId,
        "sched-tx-1",
        expect.objectContaining({
          splits: expect.arrayContaining([
            expect.objectContaining({ memo: "Principal" }),
            expect.objectContaining({ memo: "Interest" }),
          ]),
        }),
      );
    });

    it("should throw BadRequestException for non-mortgage accounts", async () => {
      const account = makeMortgageAccount({
        accountType: AccountType.LOAN,
      });

      await expect(
        service.updateMortgageRate(account, userId, 4.5, new Date()),
      ).rejects.toThrow(BadRequestException);
    });

    it("should throw BadRequestException for closed accounts", async () => {
      const account = makeMortgageAccount({ isClosed: true });

      await expect(
        service.updateMortgageRate(account, userId, 4.5, new Date()),
      ).rejects.toThrow(BadRequestException);
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
    });

    it("should handle account without scheduledTransactionId", async () => {
      const account = makeMortgageAccount({
        scheduledTransactionId: null,
      });

      const result = await service.updateMortgageRate(
        account,
        userId,
        4.5,
        new Date("2025-06-01"),
      );

      expect(result.newRate).toBe(4.5);
      expect(scheduledTransactionsService.update).not.toHaveBeenCalled();
    });

    it("should not throw if scheduled transaction update fails", async () => {
      const account = makeMortgageAccount();
      scheduledTransactionsService.update.mockRejectedValue(
        new Error("Update failed"),
      );

      const result = await service.updateMortgageRate(
        account,
        userId,
        4.5,
        new Date("2025-06-01"),
      );

      // Should still return result despite update failure
      expect(result.newRate).toBe(4.5);
    });

    it("should enforce minimum 12 remaining amortization months", async () => {
      const account = makeMortgageAccount({
        paymentStartDate: new Date("2000-01-01"),
        amortizationMonths: 300,
      });

      // Effective date far in the future
      const result = await service.updateMortgageRate(
        account,
        userId,
        4.5,
        new Date("2025-12-01"),
      );

      expect(result.paymentAmount).toBeGreaterThan(0);
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
