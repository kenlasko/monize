import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { LoanPaymentSetupService } from "./loan-payment-setup.service";
import { Account, AccountType } from "./entities/account.entity";
import { CategoriesService } from "../categories/categories.service";
import { ScheduledTransactionsService } from "../scheduled-transactions/scheduled-transactions.service";

describe("LoanPaymentSetupService", () => {
  let service: LoanPaymentSetupService;
  let accountsRepository: Record<string, jest.Mock>;
  let categoriesService: Record<string, jest.Mock>;
  let scheduledTransactionsService: Record<string, jest.Mock>;

  const mockLoanAccount = {
    id: "loan-1",
    userId: "user-1",
    name: "Auto Loan",
    accountType: AccountType.LOAN,
    currencyCode: "USD",
    currentBalance: -15000,
    openingBalance: -20000,
    interestRate: null,
    institution: "Bank of Test",
    scheduledTransactionId: null,
    isCanadianMortgage: false,
    isVariableRate: false,
    originalPrincipal: null,
  };

  const mockSourceAccount = {
    id: "source-1",
    userId: "user-1",
    name: "Checking",
    accountType: AccountType.CHEQUING,
  };

  const mockScheduledTx = {
    id: "sched-1",
  };

  beforeEach(async () => {
    accountsRepository = {
      findOne: jest.fn(),
      update: jest.fn().mockResolvedValue(undefined),
    };

    categoriesService = {
      findLoanCategories: jest.fn().mockResolvedValue({
        principalCategory: null,
        interestCategory: { id: "interest-cat-1", name: "Loan Interest" },
      }),
    };

    scheduledTransactionsService = {
      create: jest.fn().mockResolvedValue(mockScheduledTx),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LoanPaymentSetupService,
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

    service = module.get<LoanPaymentSetupService>(LoanPaymentSetupService);
  });

  describe("setupLoanPayments", () => {
    it("throws NotFoundException for unknown account", async () => {
      accountsRepository.findOne.mockResolvedValue(null);
      await expect(
        service.setupLoanPayments("user-1", "nonexistent", {
          paymentAmount: 500,
          paymentFrequency: "MONTHLY",
          sourceAccountId: "source-1",
          nextDueDate: "2026-04-01",
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it("throws BadRequestException for non-loan account", async () => {
      accountsRepository.findOne.mockResolvedValue({
        ...mockSourceAccount,
        userId: "user-1",
      });
      await expect(
        service.setupLoanPayments("user-1", "source-1", {
          paymentAmount: 500,
          paymentFrequency: "MONTHLY",
          sourceAccountId: "source-1",
          nextDueDate: "2026-04-01",
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("throws BadRequestException if account already has scheduled payment", async () => {
      accountsRepository.findOne.mockResolvedValue({
        ...mockLoanAccount,
        scheduledTransactionId: "existing-sched",
      });
      await expect(
        service.setupLoanPayments("user-1", "loan-1", {
          paymentAmount: 500,
          paymentFrequency: "MONTHLY",
          sourceAccountId: "source-1",
          nextDueDate: "2026-04-01",
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("throws BadRequestException for invalid source account", async () => {
      accountsRepository.findOne
        .mockResolvedValueOnce(mockLoanAccount) // loan account lookup
        .mockResolvedValueOnce(null); // source account lookup
      await expect(
        service.setupLoanPayments("user-1", "loan-1", {
          paymentAmount: 500,
          paymentFrequency: "MONTHLY",
          sourceAccountId: "bad-source",
          nextDueDate: "2026-04-01",
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("creates scheduled transaction and updates account for loan", async () => {
      accountsRepository.findOne
        .mockResolvedValueOnce(mockLoanAccount)
        .mockResolvedValueOnce(mockSourceAccount);

      const result = await service.setupLoanPayments("user-1", "loan-1", {
        paymentAmount: 500,
        paymentFrequency: "MONTHLY",
        sourceAccountId: "source-1",
        nextDueDate: "2026-04-01",
        interestRate: 5.5,
      });

      expect(result.scheduledTransactionId).toBe("sched-1");
      expect(result.accountId).toBe("loan-1");
      expect(result.paymentAmount).toBe(500);
      expect(result.paymentFrequency).toBe("MONTHLY");
      expect(result.nextDueDate).toBe("2026-04-01");

      // Verify scheduled transaction was created
      expect(scheduledTransactionsService.create).toHaveBeenCalledWith(
        "user-1",
        expect.objectContaining({
          accountId: "source-1",
          name: "Loan Payment - Auto Loan",
          amount: -500,
          frequency: "MONTHLY",
          nextDueDate: "2026-04-01",
        }),
      );

      // Verify account was updated
      expect(accountsRepository.update).toHaveBeenCalledWith(
        "loan-1",
        expect.objectContaining({
          paymentAmount: 500,
          paymentFrequency: "MONTHLY",
          sourceAccountId: "source-1",
          scheduledTransactionId: "sched-1",
          interestRate: 5.5,
        }),
      );
    });

    it("creates scheduled transaction with principal/interest splits", async () => {
      accountsRepository.findOne
        .mockResolvedValueOnce(mockLoanAccount)
        .mockResolvedValueOnce(mockSourceAccount);

      await service.setupLoanPayments("user-1", "loan-1", {
        paymentAmount: 500,
        paymentFrequency: "MONTHLY",
        sourceAccountId: "source-1",
        nextDueDate: "2026-04-01",
        interestRate: 5.5,
        interestCategoryId: "my-interest-cat",
      });

      const createCall = scheduledTransactionsService.create.mock.calls[0][1];
      expect(createCall.splits).toBeDefined();
      expect(createCall.splits.length).toBe(2);

      const principalSplit = createCall.splits.find(
        (s: any) => s.memo === "Principal",
      );
      const interestSplit = createCall.splits.find(
        (s: any) => s.memo === "Interest",
      );

      expect(principalSplit).toBeDefined();
      expect(principalSplit.transferAccountId).toBe("loan-1");
      expect(principalSplit.amount).toBeLessThan(0);

      expect(interestSplit).toBeDefined();
      expect(interestSplit.categoryId).toBe("my-interest-cat");
      expect(interestSplit.amount).toBeLessThan(0);

      // Principal + Interest should equal payment amount
      expect(
        Math.abs(principalSplit.amount) + Math.abs(interestSplit.amount),
      ).toBeCloseTo(500, 1);
    });

    it("uses default loan interest category when none provided", async () => {
      accountsRepository.findOne
        .mockResolvedValueOnce(mockLoanAccount)
        .mockResolvedValueOnce(mockSourceAccount);

      await service.setupLoanPayments("user-1", "loan-1", {
        paymentAmount: 500,
        paymentFrequency: "MONTHLY",
        sourceAccountId: "source-1",
        nextDueDate: "2026-04-01",
        interestRate: 5.5,
      });

      expect(categoriesService.findLoanCategories).toHaveBeenCalledWith(
        "user-1",
      );

      // Verify the default interest category was used
      expect(accountsRepository.update).toHaveBeenCalledWith(
        "loan-1",
        expect.objectContaining({
          interestCategoryId: "interest-cat-1",
        }),
      );
    });

    it("handles zero interest rate (entire payment to principal)", async () => {
      accountsRepository.findOne
        .mockResolvedValueOnce(mockLoanAccount)
        .mockResolvedValueOnce(mockSourceAccount);

      await service.setupLoanPayments("user-1", "loan-1", {
        paymentAmount: 500,
        paymentFrequency: "MONTHLY",
        sourceAccountId: "source-1",
        nextDueDate: "2026-04-01",
        interestRate: 0,
      });

      const createCall = scheduledTransactionsService.create.mock.calls[0][1];
      // Should only have principal split, no interest
      expect(createCall.splits.length).toBe(1);
      expect(createCall.splits[0].memo).toBe("Principal");
      expect(createCall.splits[0].amount).toBe(-500);
    });

    it("sets mortgage-specific fields for mortgage accounts", async () => {
      const mortgageAccount = {
        ...mockLoanAccount,
        id: "mortgage-1",
        name: "Home Mortgage",
        accountType: AccountType.MORTGAGE,
        isCanadianMortgage: false,
        isVariableRate: false,
        originalPrincipal: null,
      };

      accountsRepository.findOne
        .mockResolvedValueOnce(mortgageAccount)
        .mockResolvedValueOnce(mockSourceAccount);

      await service.setupLoanPayments("user-1", "mortgage-1", {
        paymentAmount: 1500,
        paymentFrequency: "MONTHLY",
        sourceAccountId: "source-1",
        nextDueDate: "2026-04-01",
        interestRate: 4.25,
        isCanadianMortgage: true,
        amortizationMonths: 300,
        termMonths: 60,
      });

      expect(accountsRepository.update).toHaveBeenCalledWith(
        "mortgage-1",
        expect.objectContaining({
          isCanadianMortgage: true,
          amortizationMonths: 300,
          termMonths: 60,
          originalPrincipal: 20000,
        }),
      );

      // Verify the scheduled transaction name uses "Mortgage"
      const createCall = scheduledTransactionsService.create.mock.calls[0][1];
      expect(createCall.name).toBe("Mortgage Payment - Home Mortgage");
    });
  });
});
