import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { Currency } from "../currencies/entities/currency.entity";
import { currencyPlacesRepoMock } from "../test-helpers/currency-places-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);
import {
  AccountExportService,
  CSV_SPLIT_CATEGORY_LABEL,
  exportAmount,
} from "./account-export.service";
import { AccountsService } from "./accounts.service";
import { Transaction } from "../transactions/entities/transaction.entity";
import { Category } from "../categories/entities/category.entity";

describe("AccountExportService", () => {
  let service: AccountExportService;
  let mockTransactionRepo: Record<string, jest.Mock>;
  let mockCategoryRepo: Record<string, jest.Mock>;
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

  // Mock query builder chain. `getMany` hands back a fixed array, so the order
  // the export asked for is never observable in its output -- it is recorded
  // here instead, and asserted on its own below.
  function createMockQueryBuilder(transactions: any[]) {
    const orderCalls: [string, string, string | undefined][] = [];
    const qb = {
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn((column: string, direction: string, nulls?: string) => {
        orderCalls.push([column, direction, nulls]);
        return qb;
      }),
      addOrderBy: jest.fn(
        (column: string, direction: string, nulls?: string) => {
          orderCalls.push([column, direction, nulls]);
          return qb;
        },
      ),
      getMany: jest.fn().mockResolvedValue(transactions),
      orderCalls,
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
    mockAccountsService = {
      findOne: jest.fn().mockResolvedValue(mockAccount),
    };

    const { dataSource } = createScopedDbMocks([
      [Currency, currencyPlacesRepoMock({ BTC: 8 })],
      [Transaction, mockTransactionRepo],
      [Category, mockCategoryRepo],
    ]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AccountExportService,
        { provide: DataSource, useValue: dataSource },
        {
          provide: AccountsService,
          useValue: mockAccountsService,
        },
        {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          provide: require("../delegation/cross-owner-access.service")
            .CrossOwnerAccessService,
          useValue: {
            readableAccountIdSetFor: jest
              .fn()
              .mockImplementation(async () => new Set<string>()),
          },
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

    it("reads the rows in the register's own order, oldest first", async () => {
      // The export walks a balance FORWARD from the opening balance, so the
      // order it reads in is the order the Running Balance column is computed
      // in -- and it used to spell that order out for itself, without the
      // amount leg. `created_at` is transaction start time, so an import
      // writes a day's rows with one value; within such a tie the order fell
      // through to a random UUID, and a purchase funded by a same-day
      // transfer came out before the transfer about half the time. The
      // exported column then showed the account overdrawn on a day it was
      // never short.
      //
      // The amount leg runs opposite to the list, which is what puts the
      // credit first in an oldest-first read: money has to arrive before it
      // can be spent, and no file we import carries a time of day.
      const qb = createMockQueryBuilder(buildMockTransactions());
      mockTransactionRepo.createQueryBuilder.mockReturnValue(qb);

      await service.exportCsv(userId, accountId);

      expect(qb.orderCalls).toEqual([
        ["transaction.transactionDate", "ASC", undefined],
        ["transaction.createdAt", "ASC", undefined],
        ["transaction.amount", "DESC", undefined],
        ["transaction.id", "ASC", undefined],
      ]);
    });

    it("handles transfer transactions with account name", async () => {
      const transactions = [buildTransferTransaction()];
      const qb = createMockQueryBuilder(transactions);
      mockTransactionRepo.createQueryBuilder.mockReturnValue(qb);

      const csv = await service.exportCsv(userId, accountId);
      const lines = csv.split("\n");

      // -200 left this account, so the counterpart is where it went.
      expect(lines[1].split(",")[3]).toBe("Transfer To Savings");
    });

    it("resolves a blank transfer payee from the counterpart account (issue #1214)", async () => {
      // A transfer stored with no payee (the persisted state since #1214)
      // exports the same "Transfer to <account>" text the old writers used to
      // stamp, resolved from the counterpart's current name -- so an export
      // taken before and after the migration reads identically.
      const transactions = [buildTransferTransaction()];
      const qb = createMockQueryBuilder(transactions);
      mockTransactionRepo.createQueryBuilder.mockReturnValue(qb);

      const csv = await service.exportCsv(userId, accountId);
      const lines = csv.split("\n");

      expect(lines[1].split(",")[2]).toBe("Transfer to Savings");
    });

    it("resolves the receiving leg's blank payee as Transfer from (issue #1214)", async () => {
      const transactions = [{ ...buildTransferTransaction(), amount: 200 }];
      const qb = createMockQueryBuilder(transactions);
      mockTransactionRepo.createQueryBuilder.mockReturnValue(qb);

      const csv = await service.exportCsv(userId, accountId);

      expect(csv.split("\n")[1].split(",")[2]).toBe("Transfer from Savings");
    });

    it("resolves a blank transfer payee into the QIF P line (issue #1214)", async () => {
      const transactions = [buildTransferTransaction()];
      const qb = createMockQueryBuilder(transactions);
      mockTransactionRepo.createQueryBuilder.mockReturnValue(qb);

      const qif = await service.exportQif(userId, accountId);

      expect(qif).toContain("PTransfer to Savings");
    });

    it("masks the resolved payee of an unreadable cross-owner counterpart (issue #1214)", async () => {
      // The mask rewrites the linked account's name before the label is
      // resolved, so a blank-payee cross-owner transfer exports the stub, not
      // the counterpart's live account name.
      const transfer = {
        ...buildTransferTransaction(),
        userId,
        payeeName: "",
        linkedTransaction: {
          id: "tx-4",
          userId: "owner-2",
          accountId: "account-2",
          account: { id: "account-2", name: "Savings" },
        },
      };
      const qb = createMockQueryBuilder([transfer]);
      mockTransactionRepo.createQueryBuilder.mockReturnValue(qb);

      const csv = await service.exportCsv(userId, accountId);
      const lines = csv.split("\n");

      expect(lines[1].split(",")[2]).toBe("Transfer to Hidden account");
      expect(csv).not.toContain("Savings");
    });

    it("labels the receiving leg of a transfer From its counterpart", async () => {
      // The same transfer read from the other account is money arriving. Both
      // legs are correct and they read differently; the sign is what decides.
      const transactions = [{ ...buildTransferTransaction(), amount: 200 }];
      const qb = createMockQueryBuilder(transactions);
      mockTransactionRepo.createQueryBuilder.mockReturnValue(qb);

      const csv = await service.exportCsv(userId, accountId);

      expect(csv.split("\n")[1].split(",")[3]).toBe("Transfer From Savings");
    });

    it("masks a cross-owner counterpart the reader cannot read (post-unshare)", async () => {
      const transfer = {
        ...buildTransferTransaction(),
        userId,
        payeeName: "Transfer to Savings",
        linkedTransaction: {
          id: "tx-4",
          userId: "owner-2",
          accountId: "account-2",
          account: { id: "account-2", name: "Savings" },
        },
      };
      const qb = createMockQueryBuilder([transfer]);
      mockTransactionRepo.createQueryBuilder.mockReturnValue(qb);

      const csv = await service.exportCsv(userId, accountId);
      const lines = csv.split("\n");

      expect(lines[1].split(",")[3]).toBe("Transfer To Hidden account");
      expect(lines[1]).toContain("Transfer to Hidden account");
      expect(csv).not.toContain("Savings");
    });

    it("keeps a readable cross-owner counterpart unmasked (connected pair)", async () => {
      const crossOwnerAccess = (service as any).crossOwnerAccess;
      crossOwnerAccess.readableAccountIdSetFor.mockResolvedValue(
        new Set(["account-2"]),
      );
      const transfer = {
        ...buildTransferTransaction(),
        userId,
        payeeName: "Transfer to Savings",
        linkedTransaction: {
          id: "tx-4",
          userId: "owner-2",
          accountId: "account-2",
          account: { id: "account-2", name: "Savings" },
        },
      };
      const qb = createMockQueryBuilder([transfer]);
      mockTransactionRepo.createQueryBuilder.mockReturnValue(qb);

      const csv = await service.exportCsv(userId, accountId);
      const lines = csv.split("\n");

      expect(lines[1].split(",")[3]).toBe("Transfer To Savings");
      expect(lines[1]).toContain("Transfer to Savings");
    });

    it("never queries grants for a same-owner export (fast path)", async () => {
      const crossOwnerAccess = (service as any).crossOwnerAccess;
      const transactions = [buildTransferTransaction()];
      const qb = createMockQueryBuilder(transactions);
      mockTransactionRepo.createQueryBuilder.mockReturnValue(qb);

      await service.exportCsv(userId, accountId);

      expect(crossOwnerAccess.readableAccountIdSetFor).not.toHaveBeenCalled();
    });

    it("handles split transactions with sub-rows", async () => {
      const transactions = [buildSplitTransaction()];
      const qb = createMockQueryBuilder(transactions);
      mockTransactionRepo.createQueryBuilder.mockReturnValue(qb);

      const csv = await service.exportCsv(userId, accountId);
      const lines = csv.split("\n");

      // Main row carries the split marker in the category column.
      expect(lines[1].split(",")[3]).toBe(CSV_SPLIT_CATEGORY_LABEL);
      expect(lines[1]).toContain("Store");
      // Split sub-rows
      expect(lines[2]).toContain("Food:Groceries");
      expect(lines[2]).toContain("Food items");
      // A split line is labelled from its own amount (-50), not the parent's.
      expect(lines[3].split(",")[3]).toBe("Transfer To Savings");
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
      // Should show the split marker as the category label
      expect(lines[1].split(",")[3]).toBe(CSV_SPLIT_CATEGORY_LABEL);
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
      expect(lines[1].split(",")[3]).toBe(CSV_SPLIT_CATEGORY_LABEL);
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

    it("writes the split marker as a plain cell, not a neutralized one", async () => {
      // `toContain("-- Split --")` is satisfied by "'-- Split --", which is how
      // the exporter's own label sat in every split row of every account export
      // wearing the formula guard's apostrophe. Compare the field.
      const transactions = [buildSplitTransaction()];
      const qb = createMockQueryBuilder(transactions);
      mockTransactionRepo.createQueryBuilder.mockReturnValue(qb);

      const csv = await service.exportCsv(userId, accountId);
      const categoryCell = csv.split("\n")[1].split(",")[3];

      expect(categoryCell).toBe(CSV_SPLIT_CATEGORY_LABEL);
    });

    it("neutralizes nothing in a document whose own data is inert", async () => {
      // Every user-supplied field in these fixtures is ordinary text, so an
      // apostrophe anywhere in the output came from a literal the exporter
      // wrote itself -- which is a label that needs to be renamed, not guarded.
      // This is the check the split marker escaped for as long as it existed.
      const transactions = [
        ...buildMockTransactions(),
        buildTransferTransaction(),
        buildSplitTransaction(),
      ];
      const qb = createMockQueryBuilder(transactions);
      mockTransactionRepo.createQueryBuilder.mockReturnValue(qb);

      const csv = await service.exportCsv(userId, accountId);
      const guarded = csv
        .split("\n")
        .flatMap((line) => line.split(","))
        .filter((cell) => cell.startsWith("'") || cell.startsWith("\"'"));

      expect(guarded).toEqual([]);
    });

    it("writes a numeric reference number as a number", async () => {
      // Same rule as the frontend writer (issue #1134): a value a spreadsheet
      // reads as a number is data, so guarding it only stops the column adding
      // up. A cheque number is the one text column that can hold one.
      const transactions = [
        { ...buildMockTransactions()[0], referenceNumber: "-123" },
      ];
      const qb = createMockQueryBuilder(transactions);
      mockTransactionRepo.createQueryBuilder.mockReturnValue(qb);

      const csv = await service.exportCsv(userId, accountId);

      expect(csv.split("\n")[1].split(",")[1]).toBe("-123");
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

  describe("a BTC wallet (INV-MONEY-001)", () => {
    const wallet = {
      id: accountId,
      name: "Bitcoin Wallet",
      accountType: "CRYPTO",
      currencyCode: "BTC",
      openingBalance: 0,
      currentBalance: 0.01247468,
    };
    const walletRows = () => [
      {
        ...buildMockTransactions()[0],
        id: "tx-buy",
        amount: 0.01249993,
        payeeName: "Exchange",
      },
      {
        ...buildMockTransactions()[1],
        id: "tx-fee",
        amount: -0.000025,
        payeeName: "Network fee",
      },
      {
        ...buildMockTransactions()[1],
        id: "tx-dust",
        amount: -0.00000025,
        payeeName: "Dust",
      },
    ];

    it("runs the CSV balance at eight places and never prints an exponent", async () => {
      mockAccountsService.findOne!.mockResolvedValue(wallet);
      mockTransactionRepo.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder(walletRows()),
      );

      const lines = (await service.exportCsv(userId, accountId)).split("\n");
      const cells = lines.slice(1).map((line) => line.split(","));

      // Amount, then Running Balance: at four places the fee moved nothing and
      // the balance read 0.0125; a bare toString printed the dust as 2.5e-7.
      expect(cells.map((c) => [c[5], c[7]])).toEqual([
        ["0.01249993", "0.01249993"],
        ["-0.000025", "0.01247493"],
        ["-0.00000025", "0.01247468"],
      ]);
    });

    it("prints QIF amounts at eight places, plainly", async () => {
      mockAccountsService.findOne!.mockResolvedValue(wallet);
      mockTransactionRepo.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder(walletRows()),
      );

      const lines = (await service.exportQif(userId, accountId)).split("\n");

      expect(lines).toContain("T0.01249993");
      expect(lines).toContain("T-0.000025");
      expect(lines).toContain("T-0.00000025");
    });
  });

  describe("exportAmount", () => {
    it.each([
      [-67.99, 4, "-67.99"],
      [12.345, 4, "12.345"],
      [1500, 4, "1500"],
      [0, 4, "0"],
      [-0, 8, "0"],
      [0.1 + 0.2, 4, "0.3"],
      [-0.00000025, 8, "-0.00000025"],
      [21000000, 8, "21000000"],
    ])("writes %p at %p places as %p", (value, decimals, expected) => {
      expect(exportAmount(value, decimals)).toBe(expected);
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
      expect(lines).toContain("D1/15/2025");
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
        { accountType: "CRYPTO", expected: "Oth A" },
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

  describe("date formatting", () => {
    it("formats CSV dates with specified dateFormat", async () => {
      const transactions = buildMockTransactions();
      const qb = createMockQueryBuilder(transactions);
      mockTransactionRepo.createQueryBuilder.mockReturnValue(qb);

      const csv = await service.exportCsv(userId, accountId, {
        dateFormat: "MM/DD/YYYY",
      });
      const lines = csv.split("\n");

      expect(lines[1]).toContain("01/15/2025");
      expect(lines[2]).toContain("01/20/2025");
    });

    it("formats CSV dates as DD/MM/YYYY", async () => {
      const transactions = buildMockTransactions();
      const qb = createMockQueryBuilder(transactions);
      mockTransactionRepo.createQueryBuilder.mockReturnValue(qb);

      const csv = await service.exportCsv(userId, accountId, {
        dateFormat: "DD/MM/YYYY",
      });
      const lines = csv.split("\n");

      expect(lines[1]).toContain("15/01/2025");
    });

    it("formats CSV dates as DD-MMM-YYYY", async () => {
      const transactions = buildMockTransactions();
      const qb = createMockQueryBuilder(transactions);
      mockTransactionRepo.createQueryBuilder.mockReturnValue(qb);

      const csv = await service.exportCsv(userId, accountId, {
        dateFormat: "DD-MMM-YYYY",
      });
      const lines = csv.split("\n");

      expect(lines[1]).toContain("15-Jan-2025");
    });

    it("formats CSV dates with custom format", async () => {
      const transactions = buildMockTransactions();
      const qb = createMockQueryBuilder(transactions);
      mockTransactionRepo.createQueryBuilder.mockReturnValue(qb);

      const csv = await service.exportCsv(userId, accountId, {
        dateFormat: "DD.MM.YYYY",
      });
      const lines = csv.split("\n");

      expect(lines[1]).toContain("15.01.2025");
    });

    it("formats QIF dates with specified dateFormat", async () => {
      const transactions = buildMockTransactions();
      const qb = createMockQueryBuilder(transactions);
      mockTransactionRepo.createQueryBuilder.mockReturnValue(qb);

      const qif = await service.exportQif(userId, accountId, {
        dateFormat: "YYYY-MM-DD",
      });

      expect(qif).toContain("D2025-01-15");
    });

    it("defaults QIF dates to M/D/YYYY when no dateFormat", async () => {
      const transactions = buildMockTransactions();
      const qb = createMockQueryBuilder(transactions);
      mockTransactionRepo.createQueryBuilder.mockReturnValue(qb);

      const qif = await service.exportQif(userId, accountId);

      expect(qif).toContain("D1/15/2025");
    });

    it("defaults CSV dates to YYYY-MM-DD when no dateFormat", async () => {
      const transactions = buildMockTransactions();
      const qb = createMockQueryBuilder(transactions);
      mockTransactionRepo.createQueryBuilder.mockReturnValue(qb);

      const csv = await service.exportCsv(userId, accountId);
      const lines = csv.split("\n");

      expect(lines[1]).toContain("2025-01-15");
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
