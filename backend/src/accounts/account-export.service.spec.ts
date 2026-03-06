import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { AccountExportService } from "./account-export.service";
import { AccountsService } from "./accounts.service";
import { Transaction } from "../transactions/entities/transaction.entity";
import { Category } from "../categories/entities/category.entity";
import { Account } from "./entities/account.entity";

describe("AccountExportService", () => {
  let service: AccountExportService;
  let mockTransactionRepo: Record<string, jest.Mock>;
  let mockCategoryRepo: Record<string, jest.Mock>;
  let mockAccountRepo: Record<string, jest.Mock>;
  let mockAccountsService: Partial<Record<keyof AccountsService, jest.Mock>>;

  const userId = "user-1";
  const accountId = "account-1";

  const mockAccount = {
    id: accountId,
    name: "Chequing",
    accountType: "CHEQUING",
    openingBalance: 1000,
    currentBalance: 1500,
  };

  const mockCategories = [
    { id: "cat-1", name: "Groceries", parentId: "cat-parent", userId },
    { id: "cat-parent", name: "Food", parentId: null, userId },
    { id: "cat-2", name: "Salary", parentId: null, userId },
  ];

  function buildMockTransactions() {
    return [
      {
        id: "tx-1",
        transactionDate: "2025-01-15",
        amount: 500,
        payeeName: "Employer",
        payee: null,
        categoryId: "cat-2",
        category: { id: "cat-2", name: "Salary" },
        description: "January pay",
        referenceNumber: "1001",
        status: "CLEARED",
        isSplit: false,
        isTransfer: false,
        linkedTransaction: null,
        splits: [],
      },
      {
        id: "tx-2",
        transactionDate: "2025-01-20",
        amount: -75.5,
        payeeName: "Loblaws",
        payee: null,
        categoryId: "cat-1",
        category: { id: "cat-1", name: "Groceries" },
        description: "Weekly groceries",
        referenceNumber: "",
        status: "UNRECONCILED",
        isSplit: false,
        isTransfer: false,
        linkedTransaction: null,
        splits: [],
      },
    ];
  }

  function buildTransferTransaction() {
    return {
      id: "tx-3",
      transactionDate: "2025-01-25",
      amount: -200,
      payeeName: "",
      payee: null,
      categoryId: null,
      category: null,
      description: "Transfer to savings",
      referenceNumber: "",
      status: "CLEARED",
      isSplit: false,
      isTransfer: true,
      linkedTransaction: {
        id: "tx-4",
        account: { id: "account-2", name: "Savings" },
      },
      splits: [],
    };
  }

  function buildSplitTransaction() {
    return {
      id: "tx-5",
      transactionDate: "2025-02-01",
      amount: -150,
      payeeName: "Store",
      payee: null,
      categoryId: null,
      category: null,
      description: "Mixed purchase",
      referenceNumber: "",
      status: "UNRECONCILED",
      isSplit: true,
      isTransfer: false,
      linkedTransaction: null,
      splits: [
        {
          categoryId: "cat-1",
          category: { id: "cat-1", name: "Groceries" },
          amount: -100,
          memo: "Food items",
          transferAccountId: null,
          transferAccount: null,
        },
        {
          categoryId: null,
          category: null,
          amount: -50,
          memo: "Gift card",
          transferAccountId: "account-2",
          transferAccount: { id: "account-2", name: "Savings" },
        },
      ],
    };
  }

  // Mock query builder chain
  function createMockQueryBuilder(transactions: any[]) {
    const qb = {
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue(transactions),
    };
    return qb;
  }

  beforeEach(async () => {
    mockTransactionRepo = {
      createQueryBuilder: jest.fn(),
    };
    mockCategoryRepo = {
      find: jest.fn().mockResolvedValue(mockCategories),
    };
    mockAccountRepo = {};
    mockAccountsService = {
      findOne: jest.fn().mockResolvedValue(mockAccount),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AccountExportService,
        {
          provide: getRepositoryToken(Transaction),
          useValue: mockTransactionRepo,
        },
        {
          provide: getRepositoryToken(Category),
          useValue: mockCategoryRepo,
        },
        {
          provide: getRepositoryToken(Account),
          useValue: mockAccountRepo,
        },
        {
          provide: AccountsService,
          useValue: mockAccountsService,
        },
      ],
    }).compile();

    service = module.get<AccountExportService>(AccountExportService);
  });

  describe("exportCsv", () => {
    it("generates CSV with header and transaction rows", async () => {
      const transactions = buildMockTransactions();
      const qb = createMockQueryBuilder(transactions);
      mockTransactionRepo.createQueryBuilder.mockReturnValue(qb);

      const csv = await service.exportCsv(userId, accountId);
      const lines = csv.split("\n");

      expect(lines[0]).toBe(
        "Date,Reference Number,Payee,Category,Description,Amount,Status,Running Balance",
      );
      expect(lines[1]).toContain("2025-01-15");
      expect(lines[1]).toContain("Employer");
      expect(lines[1]).toContain("Salary");
      expect(lines[1]).toContain("1001");
      expect(lines[1]).toContain("CLEARED");
      // Running balance: 1000 + 500 = 1500
      expect(lines[1]).toContain("1500");

      expect(lines[2]).toContain("2025-01-20");
      expect(lines[2]).toContain("Loblaws");
      // Running balance: 1500 - 75.5 = 1424.5
      expect(lines[2]).toContain("1424.5");
    });

    it("handles transfer transactions with account name", async () => {
      const transactions = [buildTransferTransaction()];
      const qb = createMockQueryBuilder(transactions);
      mockTransactionRepo.createQueryBuilder.mockReturnValue(qb);

      const csv = await service.exportCsv(userId, accountId);
      const lines = csv.split("\n");

      expect(lines[1]).toContain("Transfer: Savings");
    });

    it("handles split transactions with sub-rows", async () => {
      const transactions = [buildSplitTransaction()];
      const qb = createMockQueryBuilder(transactions);
      mockTransactionRepo.createQueryBuilder.mockReturnValue(qb);

      const csv = await service.exportCsv(userId, accountId);
      const lines = csv.split("\n");

      // Main row with "-- Split --"
      expect(lines[1]).toContain("-- Split --");
      expect(lines[1]).toContain("Store");
      // Split sub-rows
      expect(lines[2]).toContain("Food:Groceries");
      expect(lines[2]).toContain("Food items");
      expect(lines[3]).toContain("Transfer: Savings");
      expect(lines[3]).toContain("Gift card");
    });

    it("collapses split transactions to single row when expandSplits is false", async () => {
      const transactions = [buildSplitTransaction()];
      const qb = createMockQueryBuilder(transactions);
      mockTransactionRepo.createQueryBuilder.mockReturnValue(qb);

      const csv = await service.exportCsv(userId, accountId, {
        expandSplits: false,
      });
      const lines = csv.split("\n");

      // Header + 1 transaction row only (no sub-rows)
      expect(lines).toHaveLength(2);
      // Should not contain "-- Split --" marker
      expect(lines[1]).not.toContain("-- Split --");
      // Should contain the transaction data on a single line
      expect(lines[1]).toContain("Store");
      expect(lines[1]).toContain("2025-02-01");
      expect(lines[1]).toContain("-150");
    });

    it("still expands splits by default", async () => {
      const transactions = [buildSplitTransaction()];
      const qb = createMockQueryBuilder(transactions);
      mockTransactionRepo.createQueryBuilder.mockReturnValue(qb);

      const csv = await service.exportCsv(userId, accountId);
      const lines = csv.split("\n");

      // Header + main row + 2 split sub-rows
      expect(lines).toHaveLength(4);
      expect(lines[1]).toContain("-- Split --");
    });

    it("escapes CSV values with commas and quotes", async () => {
      const transactions = [
        {
          ...buildMockTransactions()[0],
          payeeName: 'Store, "The Best"',
          description: "Item with, comma",
        },
      ];
      const qb = createMockQueryBuilder(transactions);
      mockTransactionRepo.createQueryBuilder.mockReturnValue(qb);

      const csv = await service.exportCsv(userId, accountId);
      const lines = csv.split("\n");

      expect(lines[1]).toContain('"Store, ""The Best"""');
      expect(lines[1]).toContain('"Item with, comma"');
    });

    it("guards against CSV formula injection", async () => {
      const transactions = [
        {
          ...buildMockTransactions()[0],
          payeeName: "=cmd|'/C calc'!A0",
          description: "+SUM(A1:A2)",
        },
      ];
      const qb = createMockQueryBuilder(transactions);
      mockTransactionRepo.createQueryBuilder.mockReturnValue(qb);

      const csv = await service.exportCsv(userId, accountId);
      const lines = csv.split("\n");

      expect(lines[1]).toContain("'=cmd");
      expect(lines[1]).toContain("'+SUM(A1:A2)");
    });

    it("does not update running balance for void transactions", async () => {
      const transactions = [
        { ...buildMockTransactions()[0], status: "VOID", amount: 9999 },
        buildMockTransactions()[1],
      ];
      const qb = createMockQueryBuilder(transactions);
      mockTransactionRepo.createQueryBuilder.mockReturnValue(qb);

      const csv = await service.exportCsv(userId, accountId);
      const lines = csv.split("\n");

      // Void tx: balance stays at 1000 + 9999 = ... wait, the code does runningBalance + amount for VOID too
      // Let me re-check the logic...
      // Actually the code: if status !== 'VOID', update balance
      // So for VOID: balance stays at 1000 (opening)
      // For the second tx: balance = 1000 + (-75.5) = 924.5
      expect(lines[2]).toContain("924.5");
    });
  });

  describe("exportQif", () => {
    it("generates QIF with proper header and transaction records", async () => {
      const transactions = buildMockTransactions();
      const qb = createMockQueryBuilder(transactions);
      mockTransactionRepo.createQueryBuilder.mockReturnValue(qb);

      const qif = await service.exportQif(userId, accountId);
      const lines = qif.split("\n");

      expect(lines[0]).toBe("!Type:Bank");
      expect(lines).toContain("D01/15/2025");
      expect(lines).toContain("T500");
      expect(lines).toContain("PEmployer");
      expect(lines).toContain("MJanuary pay");
      expect(lines).toContain("N1001");
      expect(lines).toContain("C*");
      expect(lines).toContain("LSalary");
      expect(lines).toContain("^");
    });

    it("handles transfers with [AccountName] format", async () => {
      const transactions = [buildTransferTransaction()];
      const qb = createMockQueryBuilder(transactions);
      mockTransactionRepo.createQueryBuilder.mockReturnValue(qb);

      const qif = await service.exportQif(userId, accountId);

      expect(qif).toContain("L[Savings]");
    });

    it("handles split transactions with S/E/$ lines", async () => {
      const transactions = [buildSplitTransaction()];
      const qb = createMockQueryBuilder(transactions);
      mockTransactionRepo.createQueryBuilder.mockReturnValue(qb);

      const qif = await service.exportQif(userId, accountId);
      const lines = qif.split("\n");

      expect(lines).toContain("SFood:Groceries");
      expect(lines).toContain("EFood items");
      expect(lines).toContain("$-100");
      expect(lines).toContain("S[Savings]");
      expect(lines).toContain("EGift card");
      expect(lines).toContain("$-50");
    });

    it("writes CX for reconciled transactions", async () => {
      const transactions = [
        { ...buildMockTransactions()[0], status: "RECONCILED" },
      ];
      const qb = createMockQueryBuilder(transactions);
      mockTransactionRepo.createQueryBuilder.mockReturnValue(qb);

      const qif = await service.exportQif(userId, accountId);

      expect(qif).toContain("CX");
    });

    it("maps account types to QIF types correctly", async () => {
      const types = [
        { accountType: "CHEQUING", expected: "Bank" },
        { accountType: "SAVINGS", expected: "Bank" },
        { accountType: "CASH", expected: "Cash" },
        { accountType: "CREDIT_CARD", expected: "CCard" },
        { accountType: "INVESTMENT", expected: "Invst" },
        { accountType: "ASSET", expected: "Oth A" },
        { accountType: "LOAN", expected: "Oth L" },
        { accountType: "MORTGAGE", expected: "Oth L" },
        { accountType: "LINE_OF_CREDIT", expected: "Oth L" },
      ];

      for (const { accountType, expected } of types) {
        mockAccountsService.findOne!.mockResolvedValue({
          ...mockAccount,
          accountType,
        });
        const qb = createMockQueryBuilder([]);
        mockTransactionRepo.createQueryBuilder.mockReturnValue(qb);

        const qif = await service.exportQif(userId, accountId);

        expect(qif).toBe(`!Type:${expected}`);
      }
    });
  });

  describe("category path building", () => {
    it("builds hierarchical category paths with colon separator", async () => {
      const transactions = [buildMockTransactions()[1]]; // Uses cat-1 (Groceries -> Food)
      const qb = createMockQueryBuilder(transactions);
      mockTransactionRepo.createQueryBuilder.mockReturnValue(qb);

      const csv = await service.exportCsv(userId, accountId);

      expect(csv).toContain("Food:Groceries");
    });
  });
});
