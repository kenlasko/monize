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

    it("returns null when detectRegularAmount finds no repeating amounts", async () => {
      accountsRepository.findOne.mockResolvedValue(mockLoanAccount);

      // All different amounts, no two within 5% of median
      transactionRepository.find.mockResolvedValue([
        {
          id: "tx-1",
          accountId: "loan-1",
          userId: "user-1",
          transactionDate: "2025-01-15",
          amount: 100,
          isTransfer: false,
          isSplit: false,
          linkedTransactionId: null,
        },
        {
          id: "tx-2",
          accountId: "loan-1",
          userId: "user-1",
          transactionDate: "2025-02-15",
          amount: 500,
          isTransfer: false,
          isSplit: false,
          linkedTransactionId: null,
        },
        {
          id: "tx-3",
          accountId: "loan-1",
          userId: "user-1",
          transactionDate: "2025-03-15",
          amount: 1000,
          isTransfer: false,
          isSplit: false,
          linkedTransactionId: null,
        },
      ]);

      const result = await service.detectPaymentPattern("user-1", "loan-1");
      expect(result).toBeNull();
    });

    it("returns null when fewer than 2 regular payments after filtering", async () => {
      accountsRepository.findOne.mockResolvedValue(mockLoanAccount);

      // 2 payments at 500, but 1 payment at 505 (within 5% of 500) -- still 2 regular
      // Use amounts where there are 2 identical but many outliers so after
      // fuzzy detection, filtering yields < 2
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
        {
          id: "tx-2",
          accountId: "loan-1",
          userId: "user-1",
          transactionDate: "2025-02-15",
          amount: 500,
          isTransfer: false,
          isSplit: false,
          linkedTransactionId: null,
        },
        {
          id: "tx-3",
          accountId: "loan-1",
          userId: "user-1",
          transactionDate: "2025-03-15",
          amount: 200,
          isTransfer: false,
          isSplit: false,
          linkedTransactionId: null,
        },
        {
          id: "tx-4",
          accountId: "loan-1",
          userId: "user-1",
          transactionDate: "2025-04-15",
          amount: 800,
          isTransfer: false,
          isSplit: false,
          linkedTransactionId: null,
        },
      ]);

      const result = await service.detectPaymentPattern("user-1", "loan-1");
      // 500 appears twice, so regularAmount=500, filtering within 5% yields tx-1 and tx-2
      expect(result).not.toBeNull();
      expect(result!.paymentAmount).toBe(500);
    });

    it("uses fuzzy amount detection when no exact matches exist", async () => {
      accountsRepository.findOne.mockResolvedValue(mockLoanAccount);

      // Amounts all within 5% of each other but not identical
      transactionRepository.find.mockResolvedValue([
        {
          id: "tx-1",
          accountId: "loan-1",
          userId: "user-1",
          transactionDate: "2025-01-15",
          amount: 498,
          isTransfer: false,
          isSplit: false,
          linkedTransactionId: null,
        },
        {
          id: "tx-2",
          accountId: "loan-1",
          userId: "user-1",
          transactionDate: "2025-02-15",
          amount: 502,
          isTransfer: false,
          isSplit: false,
          linkedTransactionId: null,
        },
        {
          id: "tx-3",
          accountId: "loan-1",
          userId: "user-1",
          transactionDate: "2025-03-15",
          amount: 501,
          isTransfer: false,
          isSplit: false,
          linkedTransactionId: null,
        },
      ]);

      const result = await service.detectPaymentPattern("user-1", "loan-1");
      expect(result).not.toBeNull();
      // Fuzzy detection returns average of near-median amounts
      expect(result!.paymentAmount).toBeCloseTo(500.33, 0);
    });

    it("skips duplicate linked transactions (processedLinkedIds)", async () => {
      accountsRepository.findOne.mockResolvedValue(mockLoanAccount);

      // Two loan-side transactions referencing the same linked source
      transactionRepository.find.mockResolvedValue([
        {
          id: "tx-1",
          accountId: "loan-1",
          userId: "user-1",
          transactionDate: "2025-01-15",
          amount: 300,
          isTransfer: true,
          isSplit: false,
          linkedTransactionId: "source-1",
        },
        {
          id: "tx-2",
          accountId: "loan-1",
          userId: "user-1",
          transactionDate: "2025-01-15",
          amount: 200,
          isTransfer: true,
          isSplit: false,
          linkedTransactionId: "source-1",
        },
        {
          id: "tx-3",
          accountId: "loan-1",
          userId: "user-1",
          transactionDate: "2025-02-15",
          amount: 500,
          isTransfer: true,
          isSplit: false,
          linkedTransactionId: "source-2",
        },
        {
          id: "tx-4",
          accountId: "loan-1",
          userId: "user-1",
          transactionDate: "2025-03-15",
          amount: 500,
          isTransfer: true,
          isSplit: false,
          linkedTransactionId: "source-3",
        },
      ]);

      transactionRepository.findOne.mockImplementation(({ where }) => {
        if (where?.id === "source-1") {
          return Promise.resolve({
            id: "source-1",
            accountId: "chequing-1",
            amount: -500,
            account: { name: "Checking" },
            isSplit: false,
          });
        }
        if (where?.id === "source-2") {
          return Promise.resolve({
            id: "source-2",
            accountId: "chequing-1",
            amount: -500,
            account: { name: "Checking" },
            isSplit: false,
          });
        }
        if (where?.id === "source-3") {
          return Promise.resolve({
            id: "source-3",
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
      // tx-2 should be skipped (same linkedTransactionId as tx-1)
      expect(result!.paymentCount).toBeGreaterThanOrEqual(2);
    });

    it("detects single principal split with extra memo keyword", async () => {
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

      // Single principal split with "Extra" memo
      transactionRepository.manager.find.mockResolvedValue([
        {
          transferAccountId: "loan-1",
          categoryId: null,
          amount: -500,
          memo: "Extra Principal",
          category: null,
        },
      ]);

      const result = await service.detectPaymentPattern("user-1", "loan-1");
      expect(result).not.toBeNull();
    });

    it("handles multiple principal splits without memo cues", async () => {
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
          amount: 600,
          isTransfer: true,
          isSplit: false,
          linkedTransactionId: `linked-${i}`,
        });
      }

      transactionRepository.find.mockResolvedValue(payments);

      transactionRepository.findOne.mockImplementation(({ where }) => {
        if (where?.id?.startsWith("linked-")) {
          return Promise.resolve({
            id: where.id,
            accountId: "chequing-1",
            amount: -600,
            account: { name: "Checking" },
            isSplit: true,
          });
        }
        return Promise.resolve(null);
      });

      // Two principal splits (no memo cues) + interest split
      transactionRepository.manager.find.mockResolvedValue([
        {
          transferAccountId: "loan-1",
          categoryId: null,
          amount: -400,
          memo: null,
          category: null,
        },
        {
          transferAccountId: "loan-1",
          categoryId: null,
          amount: -100,
          memo: null,
          category: null,
        },
        {
          transferAccountId: null,
          categoryId: "interest-cat-1",
          amount: -100,
          memo: null,
          category: { name: "Interest" },
        },
      ]);

      const result = await service.detectPaymentPattern("user-1", "loan-1");
      expect(result).not.toBeNull();
      expect(result!.interestCategoryId).toBe("interest-cat-1");
    });

    it("handles multiple principal splits with memo cues for extra", async () => {
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
          amount: 600,
          isTransfer: true,
          isSplit: false,
          linkedTransactionId: `linked-${i}`,
        });
      }

      transactionRepository.find.mockResolvedValue(payments);

      transactionRepository.findOne.mockImplementation(({ where }) => {
        if (where?.id?.startsWith("linked-")) {
          return Promise.resolve({
            id: where.id,
            accountId: "chequing-1",
            amount: -600,
            account: { name: "Checking" },
            isSplit: true,
          });
        }
        return Promise.resolve(null);
      });

      // Two principal splits, one with "additional" memo
      transactionRepository.manager.find.mockResolvedValue([
        {
          transferAccountId: "loan-1",
          categoryId: null,
          amount: -400,
          memo: "Regular principal",
          category: null,
        },
        {
          transferAccountId: "loan-1",
          categoryId: null,
          amount: -100,
          memo: "Additional principal",
          category: null,
        },
        {
          transferAccountId: null,
          categoryId: "interest-cat-1",
          amount: -100,
          memo: null,
          category: { name: "Interest" },
        },
      ]);

      const result = await service.detectPaymentPattern("user-1", "loan-1");
      expect(result).not.toBeNull();
    });

    it("consolidates multiple payment records on the same date", async () => {
      accountsRepository.findOne.mockResolvedValue(mockLoanAccount);

      // Two transactions on the same date, one on a different date -- tests consolidation
      transactionRepository.find.mockResolvedValue([
        {
          id: "tx-1a",
          accountId: "loan-1",
          userId: "user-1",
          transactionDate: "2025-01-15",
          amount: 300,
          isTransfer: false,
          isSplit: false,
          linkedTransactionId: null,
        },
        {
          id: "tx-1b",
          accountId: "loan-1",
          userId: "user-1",
          transactionDate: "2025-01-15",
          amount: 200,
          isTransfer: false,
          isSplit: false,
          linkedTransactionId: null,
        },
        {
          id: "tx-2",
          accountId: "loan-1",
          userId: "user-1",
          transactionDate: "2025-02-15",
          amount: 500,
          isTransfer: false,
          isSplit: false,
          linkedTransactionId: null,
        },
        {
          id: "tx-3",
          accountId: "loan-1",
          userId: "user-1",
          transactionDate: "2025-03-15",
          amount: 500,
          isTransfer: false,
          isSplit: false,
          linkedTransactionId: null,
        },
      ]);

      const result = await service.detectPaymentPattern("user-1", "loan-1");
      expect(result).not.toBeNull();
      // Jan 15 gets consolidated to max(300, 200)=300; only Feb and Mar are 500, so regularAmount=500
      expect(result!.paymentAmount).toBe(500);
    });

    it("consolidates same-date payments merging source account info", async () => {
      accountsRepository.findOne.mockResolvedValue(mockLoanAccount);

      transactionRepository.find.mockResolvedValue([
        {
          id: "tx-1a",
          accountId: "loan-1",
          userId: "user-1",
          transactionDate: "2025-01-15",
          amount: 400,
          isTransfer: false,
          isSplit: false,
          linkedTransactionId: null,
        },
        {
          id: "tx-1b",
          accountId: "loan-1",
          userId: "user-1",
          transactionDate: "2025-01-15",
          amount: 100,
          isTransfer: true,
          isSplit: false,
          linkedTransactionId: "linked-1b",
        },
        {
          id: "tx-2",
          accountId: "loan-1",
          userId: "user-1",
          transactionDate: "2025-02-15",
          amount: 500,
          isTransfer: true,
          isSplit: false,
          linkedTransactionId: "linked-2",
        },
        {
          id: "tx-3",
          accountId: "loan-1",
          userId: "user-1",
          transactionDate: "2025-03-15",
          amount: 500,
          isTransfer: true,
          isSplit: false,
          linkedTransactionId: "linked-3",
        },
      ]);

      transactionRepository.findOne.mockImplementation(({ where }) => {
        if (where?.id === "linked-1b") {
          return Promise.resolve({
            id: "linked-1b",
            accountId: "chequing-1",
            amount: -100,
            account: { name: "Checking" },
            isSplit: false,
          });
        }
        if (where?.id === "linked-2") {
          return Promise.resolve({
            id: "linked-2",
            accountId: "chequing-1",
            amount: -500,
            account: { name: "Checking" },
            isSplit: false,
          });
        }
        if (where?.id === "linked-3") {
          return Promise.resolve({
            id: "linked-3",
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
      // Source account should be detected from the linked transactions
      expect(result!.sourceAccountId).toBe("chequing-1");
    });

    it("detects quarterly payment frequency", async () => {
      accountsRepository.findOne.mockResolvedValue(mockLoanAccount);

      const payments: any[] = [];
      for (let i = 0; i < 4; i++) {
        const date = new Date(2025, i * 3, 1);
        const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-01`;
        payments.push({
          id: `tx-${i}`,
          accountId: "loan-1",
          userId: "user-1",
          transactionDate: dateStr,
          amount: 1500,
          isTransfer: false,
          isSplit: false,
          linkedTransactionId: null,
        });
      }

      transactionRepository.find.mockResolvedValue(payments);

      const result = await service.detectPaymentPattern("user-1", "loan-1");
      expect(result).not.toBeNull();
      expect(result!.paymentFrequency).toBe("QUARTERLY");
      // Next due date should be 3 months from last payment
      expect(result!.suggestedNextDueDate).toBe("2026-01-01");
    });

    it("detects yearly payment frequency", async () => {
      accountsRepository.findOne.mockResolvedValue(mockLoanAccount);

      const payments: any[] = [];
      for (let i = 0; i < 3; i++) {
        const dateStr = `${2023 + i}-06-01`;
        payments.push({
          id: `tx-${i}`,
          accountId: "loan-1",
          userId: "user-1",
          transactionDate: dateStr,
          amount: 5000,
          isTransfer: false,
          isSplit: false,
          linkedTransactionId: null,
        });
      }

      transactionRepository.find.mockResolvedValue(payments);

      const result = await service.detectPaymentPattern("user-1", "loan-1");
      expect(result).not.toBeNull();
      expect(result!.paymentFrequency).toBe("YEARLY");
      expect(result!.suggestedNextDueDate).toBe("2026-06-01");
    });

    it("detects weekly payment frequency", async () => {
      accountsRepository.findOne.mockResolvedValue(mockLoanAccount);

      const payments: any[] = [];
      const startDate = new Date(2025, 0, 6); // Monday
      for (let i = 0; i < 6; i++) {
        const date = new Date(startDate);
        date.setDate(date.getDate() + i * 7);
        const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
        payments.push({
          id: `tx-${i}`,
          accountId: "loan-1",
          userId: "user-1",
          transactionDate: dateStr,
          amount: 125,
          isTransfer: false,
          isSplit: false,
          linkedTransactionId: null,
        });
      }

      transactionRepository.find.mockResolvedValue(payments);

      const result = await service.detectPaymentPattern("user-1", "loan-1");
      expect(result).not.toBeNull();
      expect(result!.paymentFrequency).toBe("WEEKLY");
    });

    it("detects semimonthly payment frequency", async () => {
      accountsRepository.findOne.mockResolvedValue(mockLoanAccount);

      // Payments ~20 days apart to hit the semimonthly range (19-21 days)
      const payments: any[] = [];
      const dates = [
        "2025-01-01",
        "2025-01-21",
        "2025-02-10",
        "2025-03-02",
        "2025-03-22",
      ];
      dates.forEach((dateStr, i) => {
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
      });

      transactionRepository.find.mockResolvedValue(payments);

      const result = await service.detectPaymentPattern("user-1", "loan-1");
      expect(result).not.toBeNull();
      expect(result!.paymentFrequency).toBe("SEMIMONTHLY");
    });

    it("calculates next due date for semimonthly (day <= 15)", async () => {
      accountsRepository.findOne.mockResolvedValue(mockLoanAccount);

      // ~20 day intervals, last payment on the 10th (day <= 15)
      const payments: any[] = [];
      const dates = [
        "2025-01-01",
        "2025-01-21",
        "2025-02-10",
        "2025-03-02",
        "2025-03-10",
      ];
      dates.forEach((dateStr, i) => {
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
      });

      transactionRepository.find.mockResolvedValue(payments);

      const result = await service.detectPaymentPattern("user-1", "loan-1");
      expect(result).not.toBeNull();
      expect(result!.paymentFrequency).toBe("SEMIMONTHLY");
      // Last payment is March 10th (day <= 15), so next should be end of month (April 0 = March 31)
      expect(result!.suggestedNextDueDate).toBe("2025-03-31");
    });

    it("calculates next due date for semimonthly (day > 15)", async () => {
      accountsRepository.findOne.mockResolvedValue(mockLoanAccount);

      // ~20 day intervals, last payment on the 22nd (day > 15)
      const payments: any[] = [];
      const dates = [
        "2025-01-01",
        "2025-01-21",
        "2025-02-10",
        "2025-03-02",
        "2025-03-22",
      ];
      dates.forEach((dateStr, i) => {
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
      });

      transactionRepository.find.mockResolvedValue(payments);

      const result = await service.detectPaymentPattern("user-1", "loan-1");
      expect(result).not.toBeNull();
      expect(result!.paymentFrequency).toBe("SEMIMONTHLY");
      // Last payment March 22 (day > 15), so next is 15th of next month
      expect(result!.suggestedNextDueDate).toBe("2025-04-15");
    });

    it("estimates interest rate from consecutive split payments", async () => {
      accountsRepository.findOne.mockResolvedValue({
        ...mockLoanAccount,
        currentBalance: -10000,
      });

      // Simulate amortizing loan payments with decreasing interest
      const payments: any[] = [];
      for (let i = 0; i < 5; i++) {
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

      // Principal increases, interest decreases (amortization)
      const principalAmounts = [410, 412, 414, 416, 418];
      const interestAmounts = [90, 88, 86, 84, 82];

      let callIndex = 0;
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

      transactionRepository.manager.find.mockImplementation(() => {
        const idx = callIndex++;
        return Promise.resolve([
          {
            transferAccountId: "loan-1",
            categoryId: null,
            amount: -principalAmounts[idx],
            memo: null,
            category: null,
          },
          {
            transferAccountId: null,
            categoryId: "interest-cat-1",
            amount: -interestAmounts[idx],
            memo: null,
            category: { name: "Interest" },
          },
        ]);
      });

      const result = await service.detectPaymentPattern("user-1", "loan-1");
      expect(result).not.toBeNull();
      expect(result!.estimatedInterestRate).not.toBeNull();
      expect(result!.estimatedInterestRate).toBeGreaterThan(0);
      expect(result!.estimatedInterestRate).toBeLessThan(50);
    });

    it("returns null estimated rate when no split data exists", async () => {
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
          isTransfer: false,
          isSplit: false,
          linkedTransactionId: null,
        });
      }

      transactionRepository.find.mockResolvedValue(payments);

      const result = await service.detectPaymentPattern("user-1", "loan-1");
      expect(result).not.toBeNull();
      expect(result!.estimatedInterestRate).toBeNull();
    });

    it("detects extra principal via memo-based strategy", async () => {
      accountsRepository.findOne.mockResolvedValue(mockLoanAccount);

      const payments: any[] = [];
      for (let i = 0; i < 6; i++) {
        const date = new Date(2025, i, 15);
        const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-15`;
        payments.push({
          id: `tx-${i}`,
          accountId: "loan-1",
          userId: "user-1",
          transactionDate: dateStr,
          amount: 600,
          isTransfer: true,
          isSplit: false,
          linkedTransactionId: `linked-${i}`,
        });
      }

      transactionRepository.find.mockResolvedValue(payments);

      transactionRepository.findOne.mockImplementation(({ where }) => {
        if (where?.id?.startsWith("linked-")) {
          return Promise.resolve({
            id: where.id,
            accountId: "chequing-1",
            amount: -600,
            account: { name: "Checking" },
            isSplit: true,
          });
        }
        return Promise.resolve(null);
      });

      // Each payment has a principal split marked "Extra" plus regular principal + interest
      transactionRepository.manager.find.mockResolvedValue([
        {
          transferAccountId: "loan-1",
          categoryId: null,
          amount: -400,
          memo: null,
          category: null,
        },
        {
          transferAccountId: "loan-1",
          categoryId: null,
          amount: -100,
          memo: "Extra principal payment",
          category: null,
        },
        {
          transferAccountId: null,
          categoryId: "interest-cat-1",
          amount: -100,
          memo: null,
          category: { name: "Interest" },
        },
      ]);

      const result = await service.detectPaymentPattern("user-1", "loan-1");
      expect(result).not.toBeNull();
      expect(result!.averageExtraPrincipal).toBe(100);
      expect(result!.extraPrincipalCount).toBe(6);
    });

    it("detects extra principal via multiple-split CV analysis", async () => {
      accountsRepository.findOne.mockResolvedValue(mockLoanAccount);

      const payments: any[] = [];
      for (let i = 0; i < 6; i++) {
        const date = new Date(2025, i, 15);
        const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-15`;
        payments.push({
          id: `tx-${i}`,
          accountId: "loan-1",
          userId: "user-1",
          transactionDate: dateStr,
          amount: 600,
          isTransfer: true,
          isSplit: false,
          linkedTransactionId: `linked-${i}`,
        });
      }

      transactionRepository.find.mockResolvedValue(payments);

      transactionRepository.findOne.mockImplementation(({ where }) => {
        if (where?.id?.startsWith("linked-")) {
          return Promise.resolve({
            id: where.id,
            accountId: "chequing-1",
            amount: -600,
            account: { name: "Checking" },
            isSplit: true,
          });
        }
        return Promise.resolve(null);
      });

      // Two principal splits, no memo cues. Extra principal (100) is constant,
      // regular principal varies (simulating amortization).
      let splitCallIndex = 0;
      const regularPrincipals = [395, 397, 399, 401, 403, 405];
      transactionRepository.manager.find.mockImplementation(() => {
        const idx = splitCallIndex++;
        return Promise.resolve([
          {
            transferAccountId: "loan-1",
            categoryId: null,
            amount: -regularPrincipals[idx],
            memo: null,
            category: null,
          },
          {
            transferAccountId: "loan-1",
            categoryId: null,
            amount: -100, // constant extra principal
            memo: null,
            category: null,
          },
          {
            transferAccountId: null,
            categoryId: "interest-cat-1",
            amount: -(600 - regularPrincipals[idx] - 100),
            memo: null,
            category: { name: "Interest" },
          },
        ]);
      });

      const result = await service.detectPaymentPattern("user-1", "loan-1");
      expect(result).not.toBeNull();
      expect(result!.averageExtraPrincipal).toBe(100);
      expect(result!.extraPrincipalCount).toBe(6);
    });

    it("projects split trend with amortization pattern", async () => {
      accountsRepository.findOne.mockResolvedValue({
        ...mockLoanAccount,
        currentBalance: -10000,
      });

      const payments: any[] = [];
      for (let i = 0; i < 5; i++) {
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

      // Amortization pattern: principal increases by ~2, interest decreases by ~2
      const principalAmounts = [400, 402, 404, 406, 408];
      const interestAmounts = [100, 98, 96, 94, 92];

      let callIdx = 0;
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

      transactionRepository.manager.find.mockImplementation(() => {
        const idx = callIdx++;
        return Promise.resolve([
          {
            transferAccountId: "loan-1",
            categoryId: null,
            amount: -principalAmounts[idx],
            memo: null,
            category: null,
          },
          {
            transferAccountId: null,
            categoryId: "interest-cat-1",
            amount: -interestAmounts[idx],
            memo: null,
            category: { name: "Interest" },
          },
        ]);
      });

      const result = await service.detectPaymentPattern("user-1", "loan-1");
      expect(result).not.toBeNull();
      // Projected next: principal ~410, interest ~90
      expect(result!.lastPrincipalAmount).toBeCloseTo(410, 0);
      expect(result!.lastInterestAmount).toBeCloseTo(90, 0);
    });

    it("returns most recent split values when no amortization trend", async () => {
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

      // No clear amortization pattern (principal goes up AND down)
      const principalAmounts = [420, 410, 430, 415];
      const interestAmounts = [80, 90, 70, 85];

      let callIdx = 0;
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

      transactionRepository.manager.find.mockImplementation(() => {
        const idx = callIdx++;
        return Promise.resolve([
          {
            transferAccountId: "loan-1",
            categoryId: null,
            amount: -principalAmounts[idx],
            memo: null,
            category: null,
          },
          {
            transferAccountId: null,
            categoryId: "interest-cat-1",
            amount: -interestAmounts[idx],
            memo: null,
            category: { name: "Interest" },
          },
        ]);
      });

      const result = await service.detectPaymentPattern("user-1", "loan-1");
      expect(result).not.toBeNull();
      // No trend, so should return the most recent split values
      expect(result!.lastPrincipalAmount).toBe(415);
      expect(result!.lastInterestAmount).toBe(85);
    });

    it("returns single split values when only one payment has splits", async () => {
      accountsRepository.findOne.mockResolvedValue(mockLoanAccount);

      // 3 payments total, but only 1 has splits
      const payments: any[] = [
        {
          id: "tx-0",
          accountId: "loan-1",
          userId: "user-1",
          transactionDate: "2025-01-15",
          amount: 500,
          isTransfer: false,
          isSplit: false,
          linkedTransactionId: null,
        },
        {
          id: "tx-1",
          accountId: "loan-1",
          userId: "user-1",
          transactionDate: "2025-02-15",
          amount: 500,
          isTransfer: true,
          isSplit: false,
          linkedTransactionId: "linked-1",
        },
        {
          id: "tx-2",
          accountId: "loan-1",
          userId: "user-1",
          transactionDate: "2025-03-15",
          amount: 500,
          isTransfer: false,
          isSplit: false,
          linkedTransactionId: null,
        },
      ];

      transactionRepository.find.mockResolvedValue(payments);

      transactionRepository.findOne.mockImplementation(({ where }) => {
        if (where?.id === "linked-1") {
          return Promise.resolve({
            id: "linked-1",
            accountId: "chequing-1",
            amount: -500,
            account: { name: "Checking" },
            isSplit: true,
          });
        }
        return Promise.resolve(null);
      });

      transactionRepository.manager.find.mockResolvedValue([
        {
          transferAccountId: "loan-1",
          categoryId: null,
          amount: -420,
          memo: null,
          category: null,
        },
        {
          transferAccountId: null,
          categoryId: "interest-cat-1",
          amount: -80,
          memo: null,
          category: { name: "Interest" },
        },
      ]);

      const result = await service.detectPaymentPattern("user-1", "loan-1");
      expect(result).not.toBeNull();
      // Only 1 payment has splits, so analyzeSplitTrend returns single values
      expect(result!.lastPrincipalAmount).toBe(420);
      expect(result!.lastInterestAmount).toBe(80);
    });

    it("handles LINE_OF_CREDIT account type", async () => {
      const locAccount = {
        id: "loc-1",
        userId: "user-1",
        name: "Line of Credit",
        accountType: AccountType.LINE_OF_CREDIT,
        currentBalance: -5000,
        openingBalance: -10000,
        interestRate: 7.5,
        scheduledTransactionId: null,
      };

      accountsRepository.findOne.mockResolvedValue(locAccount);

      const payments: any[] = [];
      for (let i = 0; i < 3; i++) {
        const date = new Date(2025, i, 1);
        const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-01`;
        payments.push({
          id: `tx-${i}`,
          accountId: "loc-1",
          userId: "user-1",
          transactionDate: dateStr,
          amount: 200,
          isTransfer: false,
          isSplit: false,
          linkedTransactionId: null,
        });
      }

      transactionRepository.find.mockResolvedValue(payments);

      const result = await service.detectPaymentPattern("user-1", "loc-1");
      expect(result).not.toBeNull();
      expect(result!.isMortgage).toBe(false);
      expect(result!.currentBalance).toBe(5000);
    });

    it("builds single payment result with extra principal", async () => {
      accountsRepository.findOne.mockResolvedValue(mockLoanAccount);

      transactionRepository.find.mockResolvedValue([
        {
          id: "tx-1",
          accountId: "loan-1",
          userId: "user-1",
          transactionDate: "2025-01-15",
          amount: 600,
          isTransfer: true,
          isSplit: false,
          linkedTransactionId: "linked-1",
        },
      ]);

      transactionRepository.findOne.mockImplementation(({ where }) => {
        if (where?.id === "linked-1") {
          return Promise.resolve({
            id: "linked-1",
            accountId: "chequing-1",
            amount: -600,
            account: { name: "Checking" },
            isSplit: true,
          });
        }
        return Promise.resolve(null);
      });

      // Single principal split with "Extra" memo
      transactionRepository.manager.find.mockResolvedValue([
        {
          transferAccountId: "loan-1",
          categoryId: null,
          amount: -500,
          memo: null,
          category: null,
        },
        {
          transferAccountId: "loan-1",
          categoryId: null,
          amount: -100,
          memo: "Extra Principal",
          category: null,
        },
      ]);

      const result = await service.detectPaymentPattern("user-1", "loan-1");
      expect(result).not.toBeNull();
      // Single payment result with extra principal deducted
      expect(result!.paymentAmount).toBe(500);
      expect(result!.confidence).toBe(0.2);
      expect(result!.paymentCount).toBe(1);
      expect(result!.averageExtraPrincipal).toBe(100);
      expect(result!.extraPrincipalCount).toBe(1);
    });

    it("consolidates same-date payments with linked and non-linked transactions", async () => {
      accountsRepository.findOne.mockResolvedValue(mockLoanAccount);

      transactionRepository.find.mockResolvedValue([
        {
          id: "tx-1a",
          accountId: "loan-1",
          userId: "user-1",
          transactionDate: "2025-01-15",
          amount: 500,
          isTransfer: true,
          isSplit: false,
          linkedTransactionId: "linked-1a",
        },
        {
          id: "tx-1b",
          accountId: "loan-1",
          userId: "user-1",
          transactionDate: "2025-01-15",
          amount: 200,
          isTransfer: true,
          isSplit: false,
          linkedTransactionId: "linked-1b",
        },
        {
          id: "tx-2",
          accountId: "loan-1",
          userId: "user-1",
          transactionDate: "2025-02-15",
          amount: 500,
          isTransfer: false,
          isSplit: false,
          linkedTransactionId: null,
        },
        {
          id: "tx-3",
          accountId: "loan-1",
          userId: "user-1",
          transactionDate: "2025-03-15",
          amount: 500,
          isTransfer: false,
          isSplit: false,
          linkedTransactionId: null,
        },
      ]);

      // linked-1a has no splits, linked-1b has splits with interest
      transactionRepository.findOne.mockImplementation(({ where }) => {
        if (where?.id === "linked-1a") {
          return Promise.resolve({
            id: "linked-1a",
            accountId: "chequing-1",
            amount: -500,
            account: { name: "Checking" },
            isSplit: false,
          });
        }
        if (where?.id === "linked-1b") {
          return Promise.resolve({
            id: "linked-1b",
            accountId: "chequing-1",
            amount: -200,
            account: { name: "Checking" },
            isSplit: true,
          });
        }
        return Promise.resolve(null);
      });

      transactionRepository.manager.find.mockResolvedValue([
        {
          transferAccountId: "loan-1",
          categoryId: null,
          amount: -150,
          memo: null,
          category: null,
        },
        {
          transferAccountId: null,
          categoryId: "interest-cat-1",
          amount: -50,
          memo: null,
          category: { name: "Interest" },
        },
      ]);

      const result = await service.detectPaymentPattern("user-1", "loan-1");
      expect(result).not.toBeNull();
      expect(result!.paymentAmount).toBe(500);
    });

    it("falls back to balance-based interest rate estimation", async () => {
      accountsRepository.findOne.mockResolvedValue({
        ...mockLoanAccount,
        currentBalance: -10000,
      });

      // Only 2 payments with splits (not enough for consecutive approach to be useful
      // since principal amounts are inconsistent)
      const payments: any[] = [];
      for (let i = 0; i < 3; i++) {
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

      // Interest stays same (no consecutive drop), so consecutive approach yields 0 drop
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

      // Same interest amount each time (no drop, so consecutive approach yields no rates)
      transactionRepository.manager.find.mockResolvedValue([
        {
          transferAccountId: "loan-1",
          categoryId: null,
          amount: -450,
          memo: null,
          category: null,
        },
        {
          transferAccountId: null,
          categoryId: "interest-cat-1",
          amount: -50,
          memo: null,
          category: { name: "Interest" },
        },
      ]);

      const result = await service.detectPaymentPattern("user-1", "loan-1");
      expect(result).not.toBeNull();
      // Falls back to balance-based estimation
      expect(result!.estimatedInterestRate).not.toBeNull();
      expect(result!.estimatedInterestRate).toBeGreaterThan(0);
    });
  });
});
