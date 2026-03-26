import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { NotFoundException } from "@nestjs/common";
import { LoanPaymentDetectorService } from "./loan-payment-detector.service";
import { Account, AccountType } from "./entities/account.entity";
import { Transaction } from "../transactions/entities/transaction.entity";

describe("LoanPaymentDetectorService", () => {
  let service: LoanPaymentDetectorService;
  let accountsRepository: any;
  let transactionRepository: any;

  const mockLoanAccount = {
    id: "loan-1",
    userId: "user-1",
    name: "Auto Loan",
    accountType: AccountType.LOAN,
    currentBalance: -15000,
    openingBalance: -20000,
    interestRate: 5.5,
    scheduledTransactionId: null,
  };

  const mockMortgageAccount = {
    id: "mortgage-1",
    userId: "user-1",
    name: "Home Mortgage",
    accountType: AccountType.MORTGAGE,
    currentBalance: -250000,
    openingBalance: -300000,
    interestRate: 4.25,
    scheduledTransactionId: null,
  };

  const mockChequingAccount = {
    id: "chequing-1",
    userId: "user-1",
    name: "Checking",
    accountType: AccountType.CHEQUING,
    currentBalance: 5000,
  };

  beforeEach(async () => {
    accountsRepository = {
      findOne: jest.fn(),
      find: jest.fn(),
    };

    transactionRepository = {
      find: jest.fn(),
      findOne: jest.fn(),
      manager: {
        find: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LoanPaymentDetectorService,
        {
          provide: getRepositoryToken(Account),
          useValue: accountsRepository,
        },
        {
          provide: getRepositoryToken(Transaction),
          useValue: transactionRepository,
        },
      ],
    }).compile();

    service = module.get<LoanPaymentDetectorService>(
      LoanPaymentDetectorService,
    );
  });

  describe("detectPaymentPattern", () => {
    it("throws NotFoundException for unknown account", async () => {
      accountsRepository.findOne.mockResolvedValue(null);
      await expect(
        service.detectPaymentPattern("user-1", "nonexistent"),
      ).rejects.toThrow(NotFoundException);
    });

    it("returns null for non-loan account type", async () => {
      accountsRepository.findOne.mockResolvedValue(mockChequingAccount);
      const result = await service.detectPaymentPattern("user-1", "chequing-1");
      expect(result).toBeNull();
    });

    it("returns null when no transactions exist", async () => {
      accountsRepository.findOne.mockResolvedValue(mockLoanAccount);
      transactionRepository.find.mockResolvedValue([]);
      const result = await service.detectPaymentPattern("user-1", "loan-1");
      expect(result).toBeNull();
    });

    it("detects monthly payment pattern from regular transactions", async () => {
      accountsRepository.findOne.mockResolvedValue(mockLoanAccount);

      // Simulate 6 monthly payments of $500
      const payments: any[] = [];
      for (let i = 0; i < 6; i++) {
        const date = new Date(2025, i, 15);
        const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
        payments.push({
          id: `tx-${i}`,
          accountId: "loan-1",
          userId: "user-1",
          transactionDate: dateStr,
          amount: 500,
          isTransfer: true,
          isSplit: false,
          linkedTransactionId: `linked-${i}`,
        });
      }

      transactionRepository.find.mockResolvedValue(payments);

      // Mock linked transactions (source account)
      transactionRepository.findOne.mockImplementation(({ where }) => {
        if (where?.id?.startsWith("linked-")) {
          return Promise.resolve({
            id: where.id,
            accountId: "chequing-1",
            amount: -500,
            account: { name: "Checking" },
            isSplit: false,
          });
        }
        return Promise.resolve(null);
      });

      const result = await service.detectPaymentPattern("user-1", "loan-1");

      expect(result).not.toBeNull();
      expect(result!.paymentAmount).toBe(500);
      expect(result!.paymentFrequency).toBe("MONTHLY");
      expect(result!.sourceAccountId).toBe("chequing-1");
      expect(result!.sourceAccountName).toBe("Checking");
      expect(result!.paymentCount).toBe(6);
      expect(result!.currentBalance).toBe(15000);
      expect(result!.isMortgage).toBe(false);
      expect(result!.confidence).toBeGreaterThan(0.3);
    });

    it("detects biweekly payment pattern", async () => {
      accountsRepository.findOne.mockResolvedValue(mockLoanAccount);

      // Simulate biweekly payments (every 14 days)
      const payments: any[] = [];
      const startDate = new Date(2025, 0, 1);
      for (let i = 0; i < 8; i++) {
        const date = new Date(startDate);
        date.setDate(date.getDate() + i * 14);
        const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
        payments.push({
          id: `tx-${i}`,
          accountId: "loan-1",
          userId: "user-1",
          transactionDate: dateStr,
          amount: 250,
          isTransfer: false,
          isSplit: false,
          linkedTransactionId: null,
        });
      }

      transactionRepository.find.mockResolvedValue(payments);

      const result = await service.detectPaymentPattern("user-1", "loan-1");

      expect(result).not.toBeNull();
      expect(result!.paymentAmount).toBe(250);
      expect(result!.paymentFrequency).toBe("BIWEEKLY");
    });

    it("returns isMortgage true for mortgage accounts", async () => {
      accountsRepository.findOne.mockResolvedValue(mockMortgageAccount);

      const payments: any[] = [];
      for (let i = 0; i < 3; i++) {
        const date = new Date(2025, i, 1);
        const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-01`;
        payments.push({
          id: `tx-${i}`,
          accountId: "mortgage-1",
          userId: "user-1",
          transactionDate: dateStr,
          amount: 1500,
          isTransfer: false,
          isSplit: false,
          linkedTransactionId: null,
        });
      }

      transactionRepository.find.mockResolvedValue(payments);

      const result = await service.detectPaymentPattern("user-1", "mortgage-1");

      expect(result).not.toBeNull();
      expect(result!.isMortgage).toBe(true);
      expect(result!.currentBalance).toBe(250000);
    });

    it("detects interest/principal splits from linked transactions", async () => {
      accountsRepository.findOne.mockResolvedValue(mockLoanAccount);

      const payments: any[] = [];
      for (let i = 0; i < 4; i++) {
        const date = new Date(2025, i, 15);
        const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-15`;
        payments.push({
          id: `tx-${i}`,
          accountId: "loan-1",
          userId: "user-1",
          transactionDate: dateStr,
          amount: 500,
          isTransfer: true,
          isSplit: false,
          linkedTransactionId: `linked-${i}`,
        });
      }

      transactionRepository.find.mockResolvedValue(payments);

      // Mock linked transactions with splits (source account side)
      transactionRepository.findOne.mockImplementation(({ where }) => {
        if (where?.id?.startsWith("linked-")) {
          return Promise.resolve({
            id: where.id,
            accountId: "chequing-1",
            amount: -500,
            account: { name: "Checking" },
            isSplit: true,
          });
        }
        return Promise.resolve(null);
      });

      // Mock split data
      transactionRepository.manager.find.mockResolvedValue([
        {
          transferAccountId: "loan-1",
          categoryId: null,
          amount: -420,
          category: null,
        },
        {
          transferAccountId: null,
          categoryId: "interest-cat-1",
          amount: -80,
          category: { name: "Interest" },
        },
      ]);

      const result = await service.detectPaymentPattern("user-1", "loan-1");

      expect(result).not.toBeNull();
      expect(result!.interestCategoryId).toBe("interest-cat-1");
      expect(result!.interestCategoryName).toBe("Interest");
    });

    it("handles single payment with low confidence", async () => {
      accountsRepository.findOne.mockResolvedValue(mockLoanAccount);

      transactionRepository.find.mockResolvedValue([
        {
          id: "tx-1",
          accountId: "loan-1",
          userId: "user-1",
          transactionDate: "2025-01-15",
          amount: 500,
          isTransfer: false,
          isSplit: false,
          linkedTransactionId: null,
        },
      ]);

      const result = await service.detectPaymentPattern("user-1", "loan-1");

      expect(result).not.toBeNull();
      expect(result!.paymentAmount).toBe(500);
      expect(result!.paymentFrequency).toBe("MONTHLY"); // Default
      expect(result!.confidence).toBe(0.2);
      expect(result!.paymentCount).toBe(1);
    });

    it("ignores outgoing transactions (negative amounts)", async () => {
      accountsRepository.findOne.mockResolvedValue(mockLoanAccount);

      transactionRepository.find.mockResolvedValue([
        {
          id: "tx-1",
          accountId: "loan-1",
          userId: "user-1",
          transactionDate: "2025-01-15",
          amount: -100, // Outgoing (e.g., fee)
          isTransfer: false,
          isSplit: false,
          linkedTransactionId: null,
        },
      ]);

      const result = await service.detectPaymentPattern("user-1", "loan-1");
      expect(result).toBeNull();
    });

    it("calculates next due date correctly", async () => {
      accountsRepository.findOne.mockResolvedValue(mockLoanAccount);

      transactionRepository.find.mockResolvedValue([
        {
          id: "tx-1",
          accountId: "loan-1",
          userId: "user-1",
          transactionDate: "2025-05-15",
          amount: 500,
          isTransfer: false,
          isSplit: false,
          linkedTransactionId: null,
        },
        {
          id: "tx-2",
          accountId: "loan-1",
          userId: "user-1",
          transactionDate: "2025-06-15",
          amount: 500,
          isTransfer: false,
          isSplit: false,
          linkedTransactionId: null,
        },
      ]);

      const result = await service.detectPaymentPattern("user-1", "loan-1");

      expect(result).not.toBeNull();
      expect(result!.suggestedNextDueDate).toBe("2025-07-15");
    });
  });
});
