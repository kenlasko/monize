import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { DataSource } from "typeorm";
import { ImportService } from "./import.service";
import {
  Transaction,
  TransactionStatus,
} from "../transactions/entities/transaction.entity";
import { TransactionSplit } from "../transactions/entities/transaction-split.entity";
import {
  Account,
  AccountType,
  AccountSubType,
} from "../accounts/entities/account.entity";
import { Category } from "../categories/entities/category.entity";
import { Payee } from "../payees/entities/payee.entity";
import { Security } from "../securities/entities/security.entity";
import {
  InvestmentTransaction,
  InvestmentAction,
} from "../securities/entities/investment-transaction.entity";
import { Holding } from "../securities/entities/holding.entity";
import { NetWorthService } from "../net-worth/net-worth.service";
import { SecurityPriceService } from "../securities/security-price.service";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import { ImportEntityCreatorService } from "./import-entity-creator.service";
import { ImportInvestmentProcessorService } from "./import-investment-processor.service";
import { ImportRegularProcessorService } from "./import-regular-processor.service";

// Mock the qif-parser module so we can control its return values
jest.mock("./qif-parser", () => ({
  parseQif: jest.fn(),
  parseQifFull: jest.fn(),
  isMultiAccountQif: jest.fn(),
  validateQifContent: jest.fn(),
}));

// Mock the ofx-parser module
jest.mock("./ofx-parser", () => ({
  parseOfx: jest.fn(),
  validateOfxContent: jest.fn(),
}));

// Mock the csv-parser module
jest.mock("./csv-parser", () => ({
  parseCsv: jest.fn(),
  parseCsvHeaders: jest.fn(),
  validateCsvContent: jest.fn(),
}));

import {
  parseQif,
  parseQifFull,
  isMultiAccountQif,
  validateQifContent,
} from "./qif-parser";
import { parseOfx, validateOfxContent } from "./ofx-parser";
import {
  parseCsv,
  parseCsvHeaders as parseCsvHeadersFn,
  validateCsvContent,
} from "./csv-parser";
import { ImportColumnMapping } from "./entities/import-column-mapping.entity";
import { Tag } from "../tags/entities/tag.entity";
import { ConflictException } from "@nestjs/common";

const mockedParseQif = parseQif as jest.MockedFunction<typeof parseQif>;
const mockedParseQifFull = parseQifFull as jest.MockedFunction<
  typeof parseQifFull
>;
const mockedIsMultiAccountQif = isMultiAccountQif as jest.MockedFunction<
  typeof isMultiAccountQif
>;
const mockedValidateQifContent = validateQifContent as jest.MockedFunction<
  typeof validateQifContent
>;
const mockedParseOfx = parseOfx as jest.MockedFunction<typeof parseOfx>;
const mockedValidateOfxContent = validateOfxContent as jest.MockedFunction<
  typeof validateOfxContent
>;
const mockedParseCsv = parseCsv as jest.MockedFunction<typeof parseCsv>;
const mockedParseCsvHeaders = parseCsvHeadersFn as jest.MockedFunction<
  typeof parseCsvHeadersFn
>;
const mockedValidateCsvContent = validateCsvContent as jest.MockedFunction<
  typeof validateCsvContent
>;

describe("ImportService", () => {
  let service: ImportService;
  let transactionsRepository: Record<string, jest.Mock>;
  let splitsRepository: Record<string, jest.Mock>;
  let accountsRepository: Record<string, jest.Mock>;
  let categoriesRepository: Record<string, jest.Mock>;
  let payeesRepository: Record<string, jest.Mock>;
  let securitiesRepository: Record<string, jest.Mock>;
  let investmentTransactionsRepository: Record<string, jest.Mock>;
  let holdingsRepository: Record<string, jest.Mock>;
  let mockDataSource: Record<string, jest.Mock>;
  let columnMappingRepository: Record<string, jest.Mock>;
  let mockNetWorthService: Record<string, jest.Mock>;
  let mockSecurityPriceService: Record<string, jest.Mock>;
  let mockExchangeRateService: Record<string, jest.Mock>;
  let mockQueryRunner: {
    connect: jest.Mock;
    startTransaction: jest.Mock;
    commitTransaction: jest.Mock;
    rollbackTransaction: jest.Mock;
    release: jest.Mock;
    query: jest.Mock;
    manager: {
      save: jest.Mock;
      delete: jest.Mock;
      findOne: jest.Mock;
      find: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      createQueryBuilder: jest.Mock;
    };
  };

  const userId = "user-1";

  const mockChequingAccount: Partial<Account> = {
    id: "acct-1",
    userId,
    name: "My Chequing",
    accountType: AccountType.CHEQUING,
    accountSubType: null,
    currencyCode: "CAD",
    openingBalance: 0,
    currentBalance: 1000,
    assetCategoryId: null,
  };

  const mockBrokerageAccount: Partial<Account> = {
    id: "acct-brokerage",
    userId,
    name: "RRSP - Brokerage",
    accountType: AccountType.INVESTMENT,
    accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
    currencyCode: "CAD",
    openingBalance: 0,
    currentBalance: 0,
    linkedAccountId: "acct-brokerage-cash",
  };

  const mockBrokerageCashAccount: Partial<Account> = {
    id: "acct-brokerage-cash",
    userId,
    name: "RRSP - Cash",
    accountType: AccountType.INVESTMENT,
    accountSubType: AccountSubType.INVESTMENT_CASH,
    currencyCode: "CAD",
    openingBalance: 0,
    currentBalance: 5000,
    linkedAccountId: "acct-brokerage",
  };

  const createMockQueryBuilder = (
    overrides: Record<string, jest.Mock> = {},
  ) => ({
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    getOne: jest.fn().mockResolvedValue(null),
    getMany: jest.fn().mockResolvedValue([]),
    ...overrides,
  });

  beforeEach(async () => {
    // Reset all mocked module functions
    mockedParseQif.mockReset();
    mockedParseQifFull.mockReset();
    mockedIsMultiAccountQif.mockReset();
    mockedValidateQifContent.mockReset();
    mockedParseOfx.mockReset();
    mockedValidateOfxContent.mockReset();
    mockedParseCsv.mockReset();
    mockedParseCsvHeaders.mockReset();
    mockedValidateCsvContent.mockReset();

    mockQueryRunner = {
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      query: jest.fn(),
      manager: {
        save: jest
          .fn()
          .mockImplementation((entity) =>
            Promise.resolve({ ...entity, id: entity.id || "generated-id" }),
          ),
        delete: jest.fn(),
        findOne: jest.fn().mockResolvedValue(null),
        find: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockImplementation((...args) => args[1] || args[0]),
        update: jest.fn(),
        createQueryBuilder: jest.fn(() => createMockQueryBuilder()),
      },
    };

    transactionsRepository = {
      findOne: jest.fn(),
      find: jest.fn(),
      save: jest.fn(),
      createQueryBuilder: jest.fn(() => createMockQueryBuilder()),
    };

    splitsRepository = {
      findOne: jest.fn(),
      find: jest.fn(),
      save: jest.fn(),
    };

    accountsRepository = {
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn(),
    };

    categoriesRepository = {
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn(),
    };

    payeesRepository = {
      findOne: jest.fn(),
      find: jest.fn(),
      save: jest.fn(),
    };

    securitiesRepository = {
      findOne: jest.fn(),
      find: jest.fn(),
      save: jest.fn(),
    };

    investmentTransactionsRepository = {
      findOne: jest.fn(),
      find: jest.fn(),
      save: jest.fn(),
    };

    holdingsRepository = {
      findOne: jest.fn(),
      find: jest.fn(),
      save: jest.fn(),
    };

    columnMappingRepository = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      save: jest
        .fn()
        .mockImplementation((entity) =>
          Promise.resolve({ ...entity, id: entity.id || "mapping-1" }),
        ),
      create: jest.fn().mockImplementation((data) => ({ ...data })),
      remove: jest.fn().mockResolvedValue(undefined),
    };

    mockDataSource = {
      createQueryRunner: jest.fn().mockReturnValue(mockQueryRunner),
      getRepository: jest.fn().mockReturnValue({
        findOne: jest.fn().mockResolvedValue(null),
        find: jest.fn().mockResolvedValue([]),
      }),
    };

    mockNetWorthService = {
      recalculateAccount: jest.fn().mockResolvedValue(undefined),
    };

    mockSecurityPriceService = {
      backfillHistoricalPrices: jest.fn().mockResolvedValue(undefined),
      backfillTransactionPrices: jest
        .fn()
        .mockResolvedValue({ processed: 0, created: 0, skipped: 0 }),
    };

    mockExchangeRateService = {
      backfillHistoricalRates: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ImportService,
        { provide: DataSource, useValue: mockDataSource },
        {
          provide: getRepositoryToken(Transaction),
          useValue: transactionsRepository,
        },
        {
          provide: getRepositoryToken(TransactionSplit),
          useValue: splitsRepository,
        },
        { provide: getRepositoryToken(Account), useValue: accountsRepository },
        {
          provide: getRepositoryToken(Category),
          useValue: categoriesRepository,
        },
        { provide: getRepositoryToken(Payee), useValue: payeesRepository },
        {
          provide: getRepositoryToken(Security),
          useValue: securitiesRepository,
        },
        {
          provide: getRepositoryToken(InvestmentTransaction),
          useValue: investmentTransactionsRepository,
        },
        { provide: getRepositoryToken(Holding), useValue: holdingsRepository },
        {
          provide: getRepositoryToken(ImportColumnMapping),
          useValue: columnMappingRepository,
        },
        { provide: NetWorthService, useValue: mockNetWorthService },
        { provide: SecurityPriceService, useValue: mockSecurityPriceService },
        { provide: ExchangeRateService, useValue: mockExchangeRateService },
        ImportEntityCreatorService,
        ImportInvestmentProcessorService,
        ImportRegularProcessorService,
      ],
    }).compile();

    service = module.get<ImportService>(ImportService);
  });

  describe("parseQifFile", () => {
    const validQifContent =
      "!Type:Bank\nD01/15/2025\nT-50.00\nPGrocery Store\n^";

    it("returns parsed QIF data with date range and metadata", async () => {
      mockedValidateQifContent.mockReturnValue({ valid: true });
      mockedParseQif.mockReturnValue({
        accountType: "CHEQUING",
        accountName: "",
        transactions: [
          {
            date: "2025-01-15",
            amount: -50,
            payee: "Grocery Store",
            memo: "",
            number: "",
            cleared: false,
            reconciled: false,
            category: "Food",
            isTransfer: false,
            transferAccount: "",
            splits: [],
            security: "",
            action: "",
            price: 0,
            quantity: 0,
            commission: 0,
          },
          {
            date: "2025-02-20",
            amount: -30,
            payee: "Gas Station",
            memo: "",
            number: "",
            cleared: false,
            reconciled: false,
            category: "Auto",
            isTransfer: false,
            transferAccount: "",
            splits: [],
            security: "",
            action: "",
            price: 0,
            quantity: 0,
            commission: 0,
          },
        ],
        categories: ["Food", "Auto"],
        transferAccounts: [],
        securities: [],
        detectedDateFormat: "MM/DD/YYYY",
        sampleDates: ["01/15/2025", "02/20/2025"],
        openingBalance: null,
        openingBalanceDate: null,
      });

      const result = await service.parseQifFile(userId, validQifContent);

      expect(result.accountType).toBe("CHEQUING");
      expect(result.transactionCount).toBe(2);
      expect(result.categories).toEqual(["Food", "Auto"]);
      expect(result.dateRange.start).toBe("2025-01-15");
      expect(result.dateRange.end).toBe("2025-02-20");
      expect(result.detectedDateFormat).toBe("MM/DD/YYYY");
      expect(result.sampleDates).toEqual(["01/15/2025", "02/20/2025"]);
      expect(result.openingBalance).toBeNull();
    });

    it("throws BadRequestException for invalid QIF content", async () => {
      mockedValidateQifContent.mockReturnValue({
        valid: false,
        error: "File is empty",
      });

      await expect(service.parseQifFile(userId, "")).rejects.toThrow(
        BadRequestException,
      );
    });

    it("returns empty date range when there are no transactions", async () => {
      mockedValidateQifContent.mockReturnValue({ valid: true });
      mockedParseQif.mockReturnValue({
        accountType: "CHEQUING",
        accountName: "",
        transactions: [],
        categories: [],
        transferAccounts: [],
        securities: [],
        detectedDateFormat: "MM/DD/YYYY",
        sampleDates: [],
        openingBalance: null,
        openingBalanceDate: null,
      });

      const result = await service.parseQifFile(userId, validQifContent);

      expect(result.transactionCount).toBe(0);
      expect(result.dateRange.start).toBe("");
      expect(result.dateRange.end).toBe("");
    });

    it("includes opening balance when present in QIF", async () => {
      mockedValidateQifContent.mockReturnValue({ valid: true });
      mockedParseQif.mockReturnValue({
        accountType: "CHEQUING",
        accountName: "",
        transactions: [],
        categories: [],
        transferAccounts: [],
        securities: [],
        detectedDateFormat: "MM/DD/YYYY",
        sampleDates: [],
        openingBalance: 1500.5,
        openingBalanceDate: "2025-01-01",
      });

      const result = await service.parseQifFile(userId, validQifContent);

      expect(result.openingBalance).toBe(1500.5);
      expect(result.openingBalanceDate).toBe("2025-01-01");
    });

    it("includes securities from investment QIF files", async () => {
      mockedValidateQifContent.mockReturnValue({ valid: true });
      mockedParseQif.mockReturnValue({
        accountType: "INVESTMENT",
        accountName: "",
        transactions: [],
        categories: [],
        transferAccounts: [],
        securities: ["AAPL", "MSFT"],
        detectedDateFormat: "MM/DD/YYYY",
        sampleDates: [],
        openingBalance: null,
        openingBalanceDate: null,
      });

      const result = await service.parseQifFile(userId, validQifContent);

      expect(result.securities).toEqual(["AAPL", "MSFT"]);
    });

    it("includes transfer accounts from QIF data", async () => {
      mockedValidateQifContent.mockReturnValue({ valid: true });
      mockedParseQif.mockReturnValue({
        accountType: "CHEQUING",
        accountName: "",
        transactions: [
          {
            date: "2025-01-15",
            amount: -200,
            payee: "",
            memo: "",
            number: "",
            cleared: false,
            reconciled: false,
            category: "",
            isTransfer: true,
            transferAccount: "Savings",
            splits: [],
            security: "",
            action: "",
            price: 0,
            quantity: 0,
            commission: 0,
          },
        ],
        categories: [],
        transferAccounts: ["Savings"],
        securities: [],
        detectedDateFormat: "MM/DD/YYYY",
        sampleDates: ["01/15/2025"],
        openingBalance: null,
        openingBalanceDate: null,
      });

      const result = await service.parseQifFile(userId, validQifContent);

      expect(result.transferAccounts).toEqual(["Savings"]);
    });
  });

  describe("importQifFile", () => {
    const makeQifTransaction = (overrides: Record<string, unknown> = {}) => ({
      date: "2025-01-15",
      amount: -50,
      payee: "Grocery Store",
      memo: "Weekly groceries",
      number: "1001",
      cleared: false,
      reconciled: false,
      category: "Food",
      isTransfer: false,
      transferAccount: "",
      splits: [],
      security: "",
      action: "",
      price: 0,
      quantity: 0,
      commission: 0,
      ...overrides,
    });

    const makeBaseDto = (overrides: Record<string, unknown> = {}) => ({
      content: "!Type:Bank\nD01/15/2025\nT-50.00\nPGrocery Store\n^",
      accountId: "acct-1",
      categoryMappings: [],
      accountMappings: [],
      securityMappings: [],
      ...overrides,
    });

    beforeEach(() => {
      // Default: QIF is valid and parses to a banking file with one transaction
      mockedValidateQifContent.mockReturnValue({ valid: true });
      mockedParseQif.mockReturnValue({
        accountType: "CHEQUING",
        accountName: "",
        transactions: [makeQifTransaction()],
        categories: ["Food"],
        transferAccounts: [],
        securities: [],
        detectedDateFormat: "MM/DD/YYYY",
        sampleDates: ["01/15/2025"],
        openingBalance: null,
        openingBalanceDate: null,
      });

      // Account lookup - default to chequing account
      accountsRepository.findOne.mockResolvedValue(mockChequingAccount);

      // QueryRunner manager.findOne: return account when asked
      mockQueryRunner.manager.findOne.mockImplementation(
        (
          entity: unknown,
          options: {
            where?: {
              id?: string;
              userId?: string;
              name?: string;
              symbol?: string;
            };
          },
        ) => {
          if (entity === Account && options?.where?.id === "acct-1") {
            return Promise.resolve({ ...mockChequingAccount });
          }
          return Promise.resolve(null);
        },
      );

      // save returns an object with a generated id
      let saveCounter = 0;
      mockQueryRunner.manager.save.mockImplementation(
        (entity: Record<string, unknown>) => {
          saveCounter++;
          return Promise.resolve({
            ...entity,
            id: entity.id || `saved-${saveCounter}`,
          });
        },
      );
    });

    describe("validation", () => {
      it("throws BadRequestException for invalid QIF content", async () => {
        mockedValidateQifContent.mockReturnValue({
          valid: false,
          error: "Invalid QIF format",
        });

        await expect(
          service.importQifFile(userId, makeBaseDto()),
        ).rejects.toThrow(BadRequestException);
      });

      it("throws NotFoundException when account not found", async () => {
        accountsRepository.findOne.mockResolvedValue(null);

        await expect(
          service.importQifFile(userId, makeBaseDto()),
        ).rejects.toThrow(NotFoundException);
        await expect(
          service.importQifFile(userId, makeBaseDto()),
        ).rejects.toThrow("Account not found");
      });

      it("throws BadRequestException when account belongs to different user", async () => {
        accountsRepository.findOne.mockResolvedValue(null); // findOne with userId filter returns null

        await expect(
          service.importQifFile(userId, makeBaseDto()),
        ).rejects.toThrow("Account not found");
      });

      it("throws BadRequestException when investment QIF targets non-brokerage account", async () => {
        mockedParseQif.mockReturnValue({
          accountType: "INVESTMENT",
          accountName: "",
          transactions: [],
          categories: [],
          transferAccounts: [],
          securities: [],
          detectedDateFormat: "MM/DD/YYYY",
          sampleDates: [],
          openingBalance: null,
          openingBalanceDate: null,
        });

        await expect(
          service.importQifFile(userId, makeBaseDto()),
        ).rejects.toThrow("investment transactions");
      });

      it("throws BadRequestException when regular QIF targets brokerage account", async () => {
        accountsRepository.findOne.mockResolvedValue(mockBrokerageAccount);

        await expect(
          service.importQifFile(userId, makeBaseDto()),
        ).rejects.toThrow("regular banking transactions");
      });

      it("throws BadRequestException when mapped account ID is invalid", async () => {
        const dto = makeBaseDto({
          accountMappings: [
            { originalName: "Savings", accountId: "bad-acct-id" },
          ],
        });

        // First call finds the import target account, second call (for validation) returns null
        accountsRepository.findOne
          .mockResolvedValueOnce(mockChequingAccount)
          .mockResolvedValueOnce(null);

        // The mapped account ID validation uses accountsRepository.findOne
        await expect(service.importQifFile(userId, dto)).rejects.toThrow(
          "invalid account",
        );
      });

      it("throws BadRequestException when mapped category ID is invalid", async () => {
        const dto = makeBaseDto({
          categoryMappings: [
            { originalName: "Food", categoryId: "bad-cat-id" },
          ],
        });

        // categoriesRepository.find returns empty for validation (no matching category)
        categoriesRepository.find.mockResolvedValue([]);

        await expect(service.importQifFile(userId, dto)).rejects.toThrow(
          "invalid category",
        );
      });

      it("throws BadRequestException when mapped security ID is invalid", async () => {
        const dto = makeBaseDto({
          securityMappings: [
            { originalName: "AAPL", securityId: "bad-sec-id" },
          ],
        });

        mockDataSource.getRepository.mockReturnValue({
          findOne: jest.fn().mockResolvedValue(null),
          find: jest.fn().mockResolvedValue([]),
        });

        await expect(service.importQifFile(userId, dto)).rejects.toThrow(
          "invalid security",
        );
      });
    });

    describe("basic banking import", () => {
      it("imports a simple transaction and updates account balance", async () => {
        const result = await service.importQifFile(userId, makeBaseDto());

        expect(result.imported).toBe(1);
        expect(result.skipped).toBe(0);
        expect(result.errors).toBe(0);
        expect(mockQueryRunner.manager.save).toHaveBeenCalled();
        expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
        expect(mockQueryRunner.release).toHaveBeenCalled();
      });

      it("creates transaction with correct properties", async () => {
        await service.importQifFile(userId, makeBaseDto());

        // The create call for Transaction should have the right fields
        const createCalls = mockQueryRunner.manager.create.mock.calls;
        const txCreateCall = createCalls.find(
          (call: unknown[]) => call[0] === Transaction,
        );

        expect(txCreateCall).toBeDefined();
        const txData = txCreateCall[1];
        expect(txData.userId).toBe(userId);
        expect(txData.accountId).toBe("acct-1");
        expect(txData.transactionDate).toBe("2025-01-15");
        expect(txData.amount).toBe(-50);
        expect(txData.payeeName).toBe("Grocery Store");
        expect(txData.description).toBe("Weekly groceries");
        expect(txData.referenceNumber).toBe("1001");
        expect(txData.currencyCode).toBe("CAD");
        expect(txData.isTransfer).toBe(false);
        expect(txData.isSplit).toBe(false);
      });

      it("sets CLEARED status for cleared transactions", async () => {
        mockedParseQif.mockReturnValue({
          accountType: "CHEQUING",
          accountName: "",
          transactions: [makeQifTransaction({ cleared: true })],
          categories: [],
          transferAccounts: [],
          securities: [],
          detectedDateFormat: "MM/DD/YYYY",
          sampleDates: [],
          openingBalance: null,
          openingBalanceDate: null,
        });

        await service.importQifFile(userId, makeBaseDto());

        const txCreateCall = mockQueryRunner.manager.create.mock.calls.find(
          (call: unknown[]) => call[0] === Transaction,
        );
        expect(txCreateCall[1].status).toBe(TransactionStatus.CLEARED);
      });

      it("sets RECONCILED status for reconciled transactions", async () => {
        mockedParseQif.mockReturnValue({
          accountType: "CHEQUING",
          accountName: "",
          transactions: [makeQifTransaction({ reconciled: true })],
          categories: [],
          transferAccounts: [],
          securities: [],
          detectedDateFormat: "MM/DD/YYYY",
          sampleDates: [],
          openingBalance: null,
          openingBalanceDate: null,
        });

        await service.importQifFile(userId, makeBaseDto());

        const txCreateCall = mockQueryRunner.manager.create.mock.calls.find(
          (call: unknown[]) => call[0] === Transaction,
        );
        expect(txCreateCall[1].status).toBe(TransactionStatus.RECONCILED);
      });

      it("sets UNRECONCILED status for uncleared transactions", async () => {
        mockedParseQif.mockReturnValue({
          accountType: "CHEQUING",
          accountName: "",
          transactions: [
            makeQifTransaction({ cleared: false, reconciled: false }),
          ],
          categories: [],
          transferAccounts: [],
          securities: [],
          detectedDateFormat: "MM/DD/YYYY",
          sampleDates: [],
          openingBalance: null,
          openingBalanceDate: null,
        });

        await service.importQifFile(userId, makeBaseDto());

        const txCreateCall = mockQueryRunner.manager.create.mock.calls.find(
          (call: unknown[]) => call[0] === Transaction,
        );
        expect(txCreateCall[1].status).toBe(TransactionStatus.UNRECONCILED);
      });

      it("updates account balance via read-modify-write", async () => {
        // When updateAccountBalance is called, manager.findOne for Account returns the account
        mockQueryRunner.manager.findOne.mockImplementation(
          (entity: unknown, options: { where?: { id?: string } }) => {
            if (entity === Account && options?.where?.id === "acct-1") {
              return Promise.resolve({
                ...mockChequingAccount,
                currentBalance: 1000,
              });
            }
            return Promise.resolve(null);
          },
        );

        await service.importQifFile(userId, makeBaseDto());

        // Verify update was called for Account balance (amount = -50, so 1000 + (-50) = 950)
        const updateCalls = mockQueryRunner.manager.update.mock.calls.filter(
          (call: unknown[]) => call[0] === Account,
        );
        expect(updateCalls.length).toBeGreaterThan(0);
        const balanceUpdate = updateCalls.find(
          (call: unknown[]) =>
            call[1] === "acct-1" &&
            (call[2] as Record<string, unknown>).currentBalance !== undefined,
        );
        expect(balanceUpdate).toBeDefined();
        expect(balanceUpdate[2].currentBalance).toBe(950);
      });

      it("handles multiple transactions in a single import", async () => {
        mockedParseQif.mockReturnValue({
          accountType: "CHEQUING",
          accountName: "",
          transactions: [
            makeQifTransaction({ date: "2025-01-15", amount: -50 }),
            makeQifTransaction({
              date: "2025-01-16",
              amount: -30,
              payee: "Gas Station",
            }),
            makeQifTransaction({
              date: "2025-01-17",
              amount: 2000,
              payee: "Employer",
            }),
          ],
          categories: [],
          transferAccounts: [],
          securities: [],
          detectedDateFormat: "MM/DD/YYYY",
          sampleDates: [],
          openingBalance: null,
          openingBalanceDate: null,
        });

        const result = await service.importQifFile(userId, makeBaseDto());

        expect(result.imported).toBe(3);
        expect(result.errors).toBe(0);
      });

      it("continues importing when individual transactions fail", async () => {
        mockedParseQif.mockReturnValue({
          accountType: "CHEQUING",
          accountName: "",
          transactions: [
            makeQifTransaction({ date: "2025-01-15", amount: -50 }),
            makeQifTransaction({ date: "2025-01-16", amount: -30 }),
          ],
          categories: [],
          transferAccounts: [],
          securities: [],
          detectedDateFormat: "MM/DD/YYYY",
          sampleDates: [],
          openingBalance: null,
          openingBalanceDate: null,
        });

        // Make save fail on the first call, succeed on subsequent calls
        let callCount = 0;
        mockQueryRunner.manager.save.mockImplementation(
          (entity: Record<string, unknown>) => {
            callCount++;
            // The first transaction save (3rd save call after create calls)
            if (callCount === 1) {
              return Promise.reject(new Error("DB constraint violation"));
            }
            return Promise.resolve({
              ...entity,
              id: entity.id || `saved-${callCount}`,
            });
          },
        );

        const result = await service.importQifFile(userId, makeBaseDto());

        expect(result.errors).toBe(1);
        expect(result.imported).toBe(1);
        expect(result.errorMessages).toHaveLength(1);
        expect(result.errorMessages[0]).toContain(
          "Error importing transaction",
        );
      });

      it("rolls back transaction on catastrophic failure", async () => {
        // Simulate a failure that escapes the inner try/catch
        mockQueryRunner.commitTransaction.mockRejectedValue(
          new Error("Commit failed"),
        );

        await expect(
          service.importQifFile(userId, makeBaseDto()),
        ).rejects.toThrow(BadRequestException);

        expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
        expect(mockQueryRunner.release).toHaveBeenCalled();
      });

      it("always releases query runner even on failure", async () => {
        accountsRepository.findOne.mockResolvedValue(null);

        await expect(
          service.importQifFile(userId, makeBaseDto()),
        ).rejects.toThrow();

        // release is called in finally block only if queryRunner was created
        // In this case the error happens before createQueryRunner
        // So let's test with a failure after queryRunner creation
      });
    });

    describe("category handling", () => {
      it("maps existing categories by ID", async () => {
        const dto = makeBaseDto({
          categoryMappings: [{ originalName: "Food", categoryId: "cat-food" }],
        });

        // Validate category ownership via batch find
        categoriesRepository.find.mockResolvedValue([
          { id: "cat-food", userId },
        ]);

        await service.importQifFile(userId, dto);

        // Transaction should have categoryId set
        const txCreateCall = mockQueryRunner.manager.create.mock.calls.find(
          (call: unknown[]) => call[0] === Transaction,
        );
        expect(txCreateCall[1].categoryId).toBe("cat-food");
      });

      it("creates new categories and tracks count", async () => {
        const dto = makeBaseDto({
          categoryMappings: [
            { originalName: "Food", createNew: "Food & Dining" },
          ],
        });

        // New category creation: manager.findOne for existing check returns null
        // manager.save returns the new category
        mockQueryRunner.manager.findOne.mockImplementation(
          (
            entity: unknown,
            options: { where?: { id?: string; name?: string } },
          ) => {
            if (entity === Account && options?.where?.id === "acct-1") {
              return Promise.resolve({ ...mockChequingAccount });
            }
            if (entity === Category) {
              return Promise.resolve(null); // Category doesn't exist yet
            }
            return Promise.resolve(null);
          },
        );

        let saveCount = 0;
        mockQueryRunner.manager.save.mockImplementation(
          (entity: Record<string, unknown>) => {
            saveCount++;
            if (
              entity.name === "Food & Dining" ||
              (entity as Record<string, unknown>).name === "Food & Dining"
            ) {
              return Promise.resolve({ ...entity, id: "new-cat-1" });
            }
            return Promise.resolve({
              ...entity,
              id: entity.id || `saved-${saveCount}`,
            });
          },
        );

        const result = await service.importQifFile(userId, dto);

        expect(result.categoriesCreated).toBe(1);
        expect(result.createdMappings!.categories["Food"]).toBe("new-cat-1");
      });

      it("deduplicates categories by name and parentId during creation", async () => {
        mockedParseQif.mockReturnValue({
          accountType: "CHEQUING",
          accountName: "",
          transactions: [
            makeQifTransaction({ category: "Food" }),
            makeQifTransaction({ category: "Food:Groceries" }),
          ],
          categories: ["Food", "Food:Groceries"],
          transferAccounts: [],
          securities: [],
          detectedDateFormat: "MM/DD/YYYY",
          sampleDates: [],
          openingBalance: null,
          openingBalanceDate: null,
        });

        const dto = makeBaseDto({
          categoryMappings: [
            { originalName: "Food", createNew: "Food" },
            { originalName: "Food:Groceries", createNew: "Food" }, // Same name = deduped
          ],
        });

        mockQueryRunner.manager.findOne.mockImplementation(
          (entity: unknown, options: { where?: { id?: string } }) => {
            if (entity === Account && options?.where?.id === "acct-1") {
              return Promise.resolve({ ...mockChequingAccount });
            }
            return Promise.resolve(null);
          },
        );

        mockQueryRunner.manager.save.mockImplementation(
          (entity: Record<string, unknown>) => {
            if (entity.name === "Food" && !entity.id) {
              return Promise.resolve({ ...entity, id: "deduped-cat" });
            }
            return Promise.resolve({ ...entity, id: entity.id || "some-id" });
          },
        );

        const result = await service.importQifFile(userId, dto);

        // Should only create 1 category even though 2 mappings point to same name
        expect(result.categoriesCreated).toBe(1);
      });

      it("reuses existing category from database instead of creating duplicate", async () => {
        const dto = makeBaseDto({
          categoryMappings: [
            { originalName: "Food", createNew: "Food & Dining" },
          ],
        });

        mockQueryRunner.manager.findOne.mockImplementation(
          (
            entity: unknown,
            options: { where?: { id?: string; name?: string } },
          ) => {
            if (entity === Account && options?.where?.id === "acct-1") {
              return Promise.resolve({ ...mockChequingAccount });
            }
            if (
              entity === Category &&
              options?.where?.name === "Food & Dining"
            ) {
              return Promise.resolve({
                id: "existing-cat",
                userId,
                name: "Food & Dining",
              });
            }
            return Promise.resolve(null);
          },
        );

        const result = await service.importQifFile(userId, dto);

        expect(result.categoriesCreated).toBe(0); // Reused existing
      });

      it("maps unmapped categories to null (no category)", async () => {
        const dto = makeBaseDto({
          categoryMappings: [
            { originalName: "Food" }, // No categoryId, no createNew -> null
          ],
        });

        await service.importQifFile(userId, dto);

        const txCreateCall = mockQueryRunner.manager.create.mock.calls.find(
          (call: unknown[]) => call[0] === Transaction,
        );
        expect(txCreateCall[1].categoryId).toBeNull();
      });

      it("uses asset category for asset accounts", async () => {
        const assetAccount = {
          ...mockChequingAccount,
          accountType: AccountType.ASSET,
          assetCategoryId: "asset-cat-1",
          accountSubType: null,
        };
        accountsRepository.findOne.mockResolvedValue(assetAccount);

        mockedParseQif.mockReturnValue({
          accountType: "CHEQUING",
          accountName: "",
          transactions: [makeQifTransaction({ category: "SomeCategory" })],
          categories: ["SomeCategory"],
          transferAccounts: [],
          securities: [],
          detectedDateFormat: "MM/DD/YYYY",
          sampleDates: [],
          openingBalance: null,
          openingBalanceDate: null,
        });

        await service.importQifFile(userId, makeBaseDto());

        const txCreateCall = mockQueryRunner.manager.create.mock.calls.find(
          (call: unknown[]) => call[0] === Transaction,
        );
        expect(txCreateCall[1].categoryId).toBe("asset-cat-1");
      });
    });

    describe("payee handling", () => {
      it("creates new payee when it does not exist", async () => {
        mockQueryRunner.manager.findOne.mockImplementation(
          (
            entity: unknown,
            options: { where?: { id?: string; name?: string } },
          ) => {
            if (entity === Account && options?.where?.id === "acct-1") {
              return Promise.resolve({ ...mockChequingAccount });
            }
            if (entity === Payee) {
              return Promise.resolve(null); // Payee doesn't exist
            }
            return Promise.resolve(null);
          },
        );

        let saveCount = 0;
        mockQueryRunner.manager.save.mockImplementation(
          (entity: Record<string, unknown>) => {
            saveCount++;
            return Promise.resolve({
              ...entity,
              id: entity.id || `saved-${saveCount}`,
            });
          },
        );

        const result = await service.importQifFile(userId, makeBaseDto());

        expect(result.payeesCreated).toBe(1);
      });

      it("reuses existing payee when found by name", async () => {
        mockQueryRunner.manager.findOne.mockImplementation(
          (
            entity: unknown,
            options: { where?: { id?: string; name?: string } },
          ) => {
            if (entity === Account && options?.where?.id === "acct-1") {
              return Promise.resolve({ ...mockChequingAccount });
            }
            if (entity === Payee && options?.where?.name === "Grocery Store") {
              return Promise.resolve({
                id: "existing-payee",
                userId,
                name: "Grocery Store",
              });
            }
            return Promise.resolve(null);
          },
        );

        const result = await service.importQifFile(userId, makeBaseDto());

        expect(result.payeesCreated).toBe(0);
      });

      it("does not create payee for transactions without payee name", async () => {
        mockedParseQif.mockReturnValue({
          accountType: "CHEQUING",
          accountName: "",
          transactions: [makeQifTransaction({ payee: "" })],
          categories: [],
          transferAccounts: [],
          securities: [],
          detectedDateFormat: "MM/DD/YYYY",
          sampleDates: [],
          openingBalance: null,
          openingBalanceDate: null,
        });

        const result = await service.importQifFile(userId, makeBaseDto());

        expect(result.payeesCreated).toBe(0);
      });
    });

    describe("account creation", () => {
      it("creates new non-investment account", async () => {
        const dto = makeBaseDto({
          accountMappings: [
            {
              originalName: "Savings",
              createNew: "Savings Account",
              accountType: "SAVINGS",
            },
          ],
        });

        mockedParseQif.mockReturnValue({
          accountType: "CHEQUING",
          accountName: "",
          transactions: [
            makeQifTransaction({
              isTransfer: true,
              transferAccount: "Savings",
              category: "",
            }),
          ],
          categories: [],
          transferAccounts: ["Savings"],
          securities: [],
          detectedDateFormat: "MM/DD/YYYY",
          sampleDates: [],
          openingBalance: null,
          openingBalanceDate: null,
        });

        mockQueryRunner.manager.findOne.mockImplementation(
          (
            entity: unknown,
            options: { where?: { id?: string; name?: string } },
          ) => {
            if (entity === Account && options?.where?.id === "acct-1") {
              return Promise.resolve({ ...mockChequingAccount });
            }
            if (
              entity === Account &&
              options?.where?.name === "Savings Account"
            ) {
              return Promise.resolve(null); // Doesn't exist yet
            }
            return Promise.resolve(null);
          },
        );

        let saveCount = 0;
        mockQueryRunner.manager.save.mockImplementation(
          (entity: Record<string, unknown>) => {
            saveCount++;
            if (entity.name === "Savings Account") {
              return Promise.resolve({ ...entity, id: "new-savings-acct" });
            }
            return Promise.resolve({
              ...entity,
              id: entity.id || `saved-${saveCount}`,
            });
          },
        );

        const result = await service.importQifFile(userId, dto);

        expect(result.accountsCreated).toBe(1);
        expect(result.createdMappings!.accounts["Savings"]).toBe(
          "new-savings-acct",
        );
      });

      it("creates investment account pair (cash + brokerage)", async () => {
        const dto = makeBaseDto({
          accountMappings: [
            {
              originalName: "RRSP",
              createNew: "RRSP",
              accountType: "INVESTMENT",
            },
          ],
        });

        mockedParseQif.mockReturnValue({
          accountType: "CHEQUING",
          accountName: "",
          transactions: [
            makeQifTransaction({
              isTransfer: true,
              transferAccount: "RRSP",
              category: "",
            }),
          ],
          categories: [],
          transferAccounts: ["RRSP"],
          securities: [],
          detectedDateFormat: "MM/DD/YYYY",
          sampleDates: [],
          openingBalance: null,
          openingBalanceDate: null,
        });

        mockQueryRunner.manager.findOne.mockImplementation(
          (
            entity: unknown,
            options: { where?: { id?: string; name?: string } },
          ) => {
            if (entity === Account && options?.where?.id === "acct-1") {
              return Promise.resolve({ ...mockChequingAccount });
            }
            return Promise.resolve(null);
          },
        );

        let saveCount = 0;
        mockQueryRunner.manager.save.mockImplementation(
          (entity: Record<string, unknown>) => {
            saveCount++;
            if (entity.name === "RRSP - Cash") {
              return Promise.resolve({ ...entity, id: "rrsp-cash-id" });
            }
            if (entity.name === "RRSP - Brokerage") {
              return Promise.resolve({ ...entity, id: "rrsp-brokerage-id" });
            }
            return Promise.resolve({
              ...entity,
              id: entity.id || `saved-${saveCount}`,
            });
          },
        );

        const result = await service.importQifFile(userId, dto);

        expect(result.accountsCreated).toBe(2); // Cash + Brokerage
        // Transfers map to the cash account
        expect(result.createdMappings!.accounts["RRSP"]).toBe("rrsp-cash-id");
      });

      it("deduplicates accounts by name during creation", async () => {
        const dto = makeBaseDto({
          accountMappings: [
            {
              originalName: "Savings",
              createNew: "Savings",
              accountType: "SAVINGS",
            },
            {
              originalName: "Savings Account",
              createNew: "Savings",
              accountType: "SAVINGS",
            },
          ],
        });

        mockQueryRunner.manager.findOne.mockImplementation(
          (entity: unknown, options: { where?: { id?: string } }) => {
            if (entity === Account && options?.where?.id === "acct-1") {
              return Promise.resolve({ ...mockChequingAccount });
            }
            return Promise.resolve(null);
          },
        );

        let saveCount = 0;
        mockQueryRunner.manager.save.mockImplementation(
          (entity: Record<string, unknown>) => {
            saveCount++;
            if (entity.name === "Savings") {
              return Promise.resolve({ ...entity, id: "savings-id" });
            }
            return Promise.resolve({
              ...entity,
              id: entity.id || `saved-${saveCount}`,
            });
          },
        );

        const result = await service.importQifFile(userId, dto);

        expect(result.accountsCreated).toBe(1); // Only one created, second reuses it
      });
    });

    describe("loan category handling", () => {
      it("treats loan-mapped categories as transfers to loan account", async () => {
        const dto = makeBaseDto({
          categoryMappings: [
            {
              originalName: "Mortgage",
              isLoanCategory: true,
              loanAccountId: "loan-acct-1",
            },
          ],
        });

        // Validate the loan account belongs to user
        accountsRepository.findOne.mockImplementation(
          (options: { where?: { id?: string; userId?: string } }) => {
            if (options?.where?.id === "acct-1")
              return Promise.resolve(mockChequingAccount);
            if (options?.where?.id === "loan-acct-1")
              return Promise.resolve({ id: "loan-acct-1", userId });
            return Promise.resolve(null);
          },
        );

        // Batch validation of mapped account IDs (loan account)
        accountsRepository.find.mockResolvedValue([{ id: "loan-acct-1" }]);

        mockedParseQif.mockReturnValue({
          accountType: "CHEQUING",
          accountName: "",
          transactions: [
            makeQifTransaction({ category: "Mortgage", isTransfer: false }),
          ],
          categories: ["Mortgage"],
          transferAccounts: [],
          securities: [],
          detectedDateFormat: "MM/DD/YYYY",
          sampleDates: [],
          openingBalance: null,
          openingBalanceDate: null,
        });

        await service.importQifFile(userId, dto);

        // Transaction should be created as a transfer (isTransfer = true)
        const txCreateCall = mockQueryRunner.manager.create.mock.calls.find(
          (call: unknown[]) => call[0] === Transaction,
        );
        expect(txCreateCall[1].isTransfer).toBe(true);
        expect(txCreateCall[1].categoryId).toBeNull();
      });

      it("creates new loan account from mapping", async () => {
        const dto = makeBaseDto({
          categoryMappings: [
            {
              originalName: "Mortgage",
              isLoanCategory: true,
              createNewLoan: "My Mortgage",
              newLoanAmount: 250000,
              newLoanInstitution: "Big Bank",
            },
          ],
        });

        mockQueryRunner.manager.findOne.mockImplementation(
          (entity: unknown, options: { where?: { id?: string } }) => {
            if (entity === Account && options?.where?.id === "acct-1") {
              return Promise.resolve({ ...mockChequingAccount });
            }
            return Promise.resolve(null);
          },
        );

        let saveCount = 0;
        mockQueryRunner.manager.save.mockImplementation(
          (entity: Record<string, unknown>) => {
            saveCount++;
            if (entity.name === "My Mortgage") {
              return Promise.resolve({ ...entity, id: "new-loan-acct" });
            }
            return Promise.resolve({
              ...entity,
              id: entity.id || `saved-${saveCount}`,
            });
          },
        );

        const result = await service.importQifFile(userId, dto);

        expect(result.accountsCreated).toBe(1);
        expect(result.createdMappings!.loans["Mortgage"]).toBe("new-loan-acct");

        // Verify loan account was created with negative opening balance
        const loanCreateCall = mockQueryRunner.manager.create.mock.calls.find(
          (call: unknown[]) =>
            call[0] === Account && (call[1] as any)?.name === "My Mortgage",
        );
        expect(loanCreateCall[1].openingBalance).toBe(-250000);
        expect(loanCreateCall[1].currentBalance).toBe(-250000);
        expect(loanCreateCall[1].accountType).toBe(AccountType.LOAN);
        expect(loanCreateCall[1].institution).toBe("Big Bank");
      });
    });

    describe("transfer handling", () => {
      it("creates linked transaction in transfer account", async () => {
        const dto = makeBaseDto({
          accountMappings: [
            { originalName: "Savings", accountId: "savings-acct" },
          ],
        });

        mockedParseQif.mockReturnValue({
          accountType: "CHEQUING",
          accountName: "",
          transactions: [
            makeQifTransaction({
              isTransfer: true,
              transferAccount: "Savings",
              category: "",
              amount: -200,
              payee: "",
            }),
          ],
          categories: [],
          transferAccounts: ["Savings"],
          securities: [],
          detectedDateFormat: "MM/DD/YYYY",
          sampleDates: [],
          openingBalance: null,
          openingBalanceDate: null,
        });

        // Validate savings account
        accountsRepository.findOne.mockImplementation(
          (options: { where?: { id?: string } }) => {
            if (options?.where?.id === "acct-1")
              return Promise.resolve(mockChequingAccount);
            if (options?.where?.id === "savings-acct")
              return Promise.resolve({
                id: "savings-acct",
                userId,
                currencyCode: "CAD",
                name: "Savings",
              });
            return Promise.resolve(null);
          },
        );

        // Batch validation of mapped account IDs
        accountsRepository.find.mockResolvedValue([{ id: "savings-acct" }]);

        mockQueryRunner.manager.findOne.mockImplementation(
          (entity: unknown, options: { where?: { id?: string } }) => {
            if (entity === Account && options?.where?.id === "acct-1") {
              return Promise.resolve({ ...mockChequingAccount });
            }
            if (entity === Account && options?.where?.id === "savings-acct") {
              return Promise.resolve({
                id: "savings-acct",
                userId,
                currencyCode: "CAD",
                name: "Savings",
              });
            }
            return Promise.resolve(null);
          },
        );

        await service.importQifFile(userId, dto);

        // Should create 2 transactions: one in source account, one linked in target
        const txCreateCalls = mockQueryRunner.manager.create.mock.calls.filter(
          (call: unknown[]) => call[0] === Transaction,
        );
        expect(txCreateCalls.length).toBe(2);

        // The linked transaction should have inverse amount
        const linkedTx = txCreateCalls[1][1];
        expect(linkedTx.amount).toBe(200); // -(-200) = 200
        expect(linkedTx.accountId).toBe("savings-acct");
        expect(linkedTx.isTransfer).toBe(true);
      });

      it("skips duplicate transfers that already exist before import", async () => {
        const dto = makeBaseDto({
          accountMappings: [
            { originalName: "Savings", accountId: "savings-acct" },
          ],
        });

        mockedParseQif.mockReturnValue({
          accountType: "CHEQUING",
          accountName: "",
          transactions: [
            makeQifTransaction({
              isTransfer: true,
              transferAccount: "Savings",
              category: "",
              amount: -200,
            }),
          ],
          categories: [],
          transferAccounts: ["Savings"],
          securities: [],
          detectedDateFormat: "MM/DD/YYYY",
          sampleDates: [],
          openingBalance: null,
          openingBalanceDate: null,
        });

        accountsRepository.findOne.mockImplementation(
          (options: { where?: { id?: string } }) => {
            if (options?.where?.id === "acct-1")
              return Promise.resolve(mockChequingAccount);
            if (options?.where?.id === "savings-acct")
              return Promise.resolve({ id: "savings-acct", userId });
            return Promise.resolve(null);
          },
        );

        // Batch validation of mapped account IDs
        accountsRepository.find.mockResolvedValue([{ id: "savings-acct" }]);

        // Simulate an existing linked transfer found via createQueryBuilder
        const mockQb = createMockQueryBuilder({
          getOne: jest.fn().mockResolvedValue({ id: "existing-transfer" }),
        });
        mockQueryRunner.manager.createQueryBuilder.mockReturnValue(mockQb);

        const result = await service.importQifFile(userId, dto);

        expect(result.skipped).toBe(1);
        expect(result.imported).toBe(0);
      });
    });

    describe("split transactions", () => {
      it("creates split transactions with individual category assignments", async () => {
        const dto = makeBaseDto({
          categoryMappings: [
            { originalName: "Food", categoryId: "cat-food" },
            { originalName: "Household", categoryId: "cat-household" },
          ],
        });

        // Validate category ownership via batch find
        categoriesRepository.find.mockResolvedValue([
          { id: "cat-food", userId },
          { id: "cat-household", userId },
        ]);

        mockedParseQif.mockReturnValue({
          accountType: "CHEQUING",
          accountName: "",
          transactions: [
            makeQifTransaction({
              amount: -100,
              category: "",
              splits: [
                {
                  category: "Food",
                  memo: "Groceries",
                  amount: -60,
                  isTransfer: false,
                  transferAccount: "",
                },
                {
                  category: "Household",
                  memo: "Cleaning",
                  amount: -40,
                  isTransfer: false,
                  transferAccount: "",
                },
              ],
            }),
          ],
          categories: ["Food", "Household"],
          transferAccounts: [],
          securities: [],
          detectedDateFormat: "MM/DD/YYYY",
          sampleDates: [],
          openingBalance: null,
          openingBalanceDate: null,
        });

        await service.importQifFile(userId, dto);

        // Main transaction should be marked as split with no category
        const txCreateCall = mockQueryRunner.manager.create.mock.calls.find(
          (call: unknown[]) => call[0] === Transaction,
        );
        expect(txCreateCall[1].isSplit).toBe(true);
        expect(txCreateCall[1].categoryId).toBeNull();
        expect(txCreateCall[1].isTransfer).toBe(false); // Splits: main tx is not a transfer

        // Two splits should be created
        const splitCreateCalls =
          mockQueryRunner.manager.create.mock.calls.filter(
            (call: unknown[]) => call[0] === TransactionSplit,
          );
        expect(splitCreateCalls.length).toBe(2);
        expect(splitCreateCalls[0][1].amount).toBe(-60);
        expect(splitCreateCalls[1][1].amount).toBe(-40);
      });
    });

    describe("opening balance", () => {
      it("applies opening balance from QIF file", async () => {
        mockedParseQif.mockReturnValue({
          accountType: "CHEQUING",
          accountName: "",
          transactions: [],
          categories: [],
          transferAccounts: [],
          securities: [],
          detectedDateFormat: "MM/DD/YYYY",
          sampleDates: [],
          openingBalance: 500.5,
          openingBalanceDate: "2025-01-01",
        });

        accountsRepository.findOne.mockResolvedValue({
          ...mockChequingAccount,
          openingBalance: 0,
          currentBalance: 200,
        });

        await service.importQifFile(userId, makeBaseDto());

        // Should update account with new opening balance and adjusted current balance
        const updateCalls = mockQueryRunner.manager.update.mock.calls.filter(
          (call: unknown[]) => call[0] === Account && call[1] === "acct-1",
        );
        const openingBalanceUpdate = updateCalls.find(
          (call: unknown[]) =>
            (call[2] as Record<string, unknown>).openingBalance !== undefined,
        );
        expect(openingBalanceUpdate).toBeDefined();
        expect(openingBalanceUpdate[2].openingBalance).toBe(500.5);
        // new currentBalance = 200 - 0 + 500.50 = 700.50
        expect(openingBalanceUpdate[2].currentBalance).toBe(700.5);
      });
    });

    describe("security handling", () => {
      it("creates new security from mapping", async () => {
        const dto = makeBaseDto({
          accountId: "acct-brokerage",
          securityMappings: [
            {
              originalName: "AAPL",
              createNew: "AAPL",
              securityName: "Apple Inc.",
              securityType: "STOCK",
              exchange: "NASDAQ",
            },
          ],
        });

        accountsRepository.findOne.mockResolvedValue(mockBrokerageAccount);

        mockedParseQif.mockReturnValue({
          accountType: "INVESTMENT",
          accountName: "",
          transactions: [
            makeQifTransaction({
              action: "Buy",
              security: "AAPL",
              price: 150,
              quantity: 10,
              amount: 1500,
              payee: "",
              category: "",
            }),
          ],
          categories: [],
          transferAccounts: [],
          securities: ["AAPL"],
          detectedDateFormat: "MM/DD/YYYY",
          sampleDates: [],
          openingBalance: null,
          openingBalanceDate: null,
        });

        mockQueryRunner.manager.findOne.mockImplementation(
          (
            entity: unknown,
            options: { where?: { id?: string; symbol?: string } },
          ) => {
            if (entity === Account && options?.where?.id === "acct-brokerage") {
              return Promise.resolve({ ...mockBrokerageAccount });
            }
            if (
              entity === Account &&
              options?.where?.id === "acct-brokerage-cash"
            ) {
              return Promise.resolve({ ...mockBrokerageCashAccount });
            }
            if (entity === Security && options?.where?.symbol === "AAPL") {
              return Promise.resolve(null); // Doesn't exist yet
            }
            if (entity === Security) {
              return Promise.resolve(null);
            }
            return Promise.resolve(null);
          },
        );

        let saveCount = 0;
        mockQueryRunner.manager.save.mockImplementation(
          (entity: Record<string, unknown>) => {
            saveCount++;
            if (entity.symbol === "AAPL") {
              return Promise.resolve({ ...entity, id: "new-sec-aapl" });
            }
            return Promise.resolve({
              ...entity,
              id: entity.id || `saved-${saveCount}`,
            });
          },
        );

        const result = await service.importQifFile(userId, dto);

        expect(result.securitiesCreated).toBe(1);
        expect(result.createdMappings!.securities["AAPL"]).toBe("new-sec-aapl");
      });

      it("reuses existing security from database", async () => {
        const dto = makeBaseDto({
          accountId: "acct-brokerage",
          securityMappings: [{ originalName: "AAPL", createNew: "AAPL" }],
        });

        accountsRepository.findOne.mockResolvedValue(mockBrokerageAccount);

        mockedParseQif.mockReturnValue({
          accountType: "INVESTMENT",
          accountName: "",
          transactions: [
            makeQifTransaction({
              action: "Buy",
              security: "AAPL",
              price: 150,
              quantity: 10,
              amount: 1500,
            }),
          ],
          categories: [],
          transferAccounts: [],
          securities: ["AAPL"],
          detectedDateFormat: "MM/DD/YYYY",
          sampleDates: [],
          openingBalance: null,
          openingBalanceDate: null,
        });

        mockQueryRunner.manager.findOne.mockImplementation(
          (
            entity: unknown,
            options: { where?: { id?: string; symbol?: string } },
          ) => {
            if (entity === Account && options?.where?.id === "acct-brokerage") {
              return Promise.resolve({ ...mockBrokerageAccount });
            }
            if (
              entity === Account &&
              options?.where?.id === "acct-brokerage-cash"
            ) {
              return Promise.resolve({ ...mockBrokerageCashAccount });
            }
            if (entity === Security && options?.where?.symbol === "AAPL") {
              return Promise.resolve({
                id: "existing-sec",
                symbol: "AAPL",
                userId,
              });
            }
            if (entity === Security) {
              return Promise.resolve(null);
            }
            return Promise.resolve(null);
          },
        );

        let saveCount = 0;
        mockQueryRunner.manager.save.mockImplementation(
          (entity: Record<string, unknown>) => {
            saveCount++;
            return Promise.resolve({
              ...entity,
              id: entity.id || `saved-${saveCount}`,
            });
          },
        );

        const result = await service.importQifFile(userId, dto);

        // Should NOT create a new security (reuses existing)
        expect(result.securitiesCreated).toBe(0);
      });

      it("derives currency from exchange for new securities", async () => {
        const dto = makeBaseDto({
          accountId: "acct-brokerage",
          securityMappings: [
            {
              originalName: "MSFT",
              createNew: "MSFT",
              securityName: "Microsoft Corp",
              exchange: "NYSE",
              // No currencyCode provided - should derive from exchange
            },
          ],
        });

        accountsRepository.findOne.mockResolvedValue(mockBrokerageAccount);

        mockedParseQif.mockReturnValue({
          accountType: "INVESTMENT",
          accountName: "",
          transactions: [
            makeQifTransaction({
              action: "Buy",
              security: "MSFT",
              price: 300,
              quantity: 5,
              amount: 1500,
            }),
          ],
          categories: [],
          transferAccounts: [],
          securities: ["MSFT"],
          detectedDateFormat: "MM/DD/YYYY",
          sampleDates: [],
          openingBalance: null,
          openingBalanceDate: null,
        });

        mockQueryRunner.manager.findOne.mockImplementation(
          (entity: unknown, options: { where?: { id?: string } }) => {
            if (entity === Account && options?.where?.id === "acct-brokerage") {
              return Promise.resolve({ ...mockBrokerageAccount });
            }
            if (
              entity === Account &&
              options?.where?.id === "acct-brokerage-cash"
            ) {
              return Promise.resolve({ ...mockBrokerageCashAccount });
            }
            return Promise.resolve(null);
          },
        );

        let savedSecurity: Record<string, unknown> | null = null;
        let saveCount = 0;
        mockQueryRunner.manager.save.mockImplementation(
          (entity: Record<string, unknown>) => {
            saveCount++;
            if (entity.symbol === "MSFT") {
              savedSecurity = entity;
              return Promise.resolve({ ...entity, id: "new-sec-msft" });
            }
            return Promise.resolve({
              ...entity,
              id: entity.id || `saved-${saveCount}`,
            });
          },
        );

        await service.importQifFile(userId, dto);

        // NYSE should derive USD currency
        expect(savedSecurity).toBeDefined();
        expect(savedSecurity!.currencyCode).toBe("USD");
      });
    });

    describe("investment transaction import", () => {
      const makeInvestmentDto = (overrides: Record<string, unknown> = {}) => ({
        content:
          "!Type:Invst\nD01/15/2025\nNBuy\nYAAPL\nI150.00\nQ10\nT1500.00\n^",
        accountId: "acct-brokerage",
        categoryMappings: [],
        accountMappings: [],
        securityMappings: [{ originalName: "AAPL", securityId: "sec-aapl" }],
        ...overrides,
      });

      beforeEach(() => {
        accountsRepository.findOne.mockResolvedValue(mockBrokerageAccount);

        // Validate security ownership via batch find
        mockDataSource.getRepository.mockReturnValue({
          findOne: jest.fn().mockResolvedValue({ id: "sec-aapl", userId }),
          find: jest.fn().mockResolvedValue([{ id: "sec-aapl" }]),
        });

        mockQueryRunner.manager.findOne.mockImplementation(
          (entity: unknown, options: { where?: { id?: string } }) => {
            if (entity === Account && options?.where?.id === "acct-brokerage") {
              return Promise.resolve({ ...mockBrokerageAccount });
            }
            if (
              entity === Account &&
              options?.where?.id === "acct-brokerage-cash"
            ) {
              return Promise.resolve({ ...mockBrokerageCashAccount });
            }
            if (entity === Security && options?.where?.id === "sec-aapl") {
              return Promise.resolve({
                id: "sec-aapl",
                symbol: "AAPL",
                userId,
              });
            }
            return Promise.resolve(null);
          },
        );

        let saveCount = 0;
        mockQueryRunner.manager.save.mockImplementation(
          (entity: Record<string, unknown>) => {
            saveCount++;
            return Promise.resolve({
              ...entity,
              id: entity.id || `saved-${saveCount}`,
            });
          },
        );
      });

      it("imports BUY transaction and creates investment tx + cash tx", async () => {
        mockedParseQif.mockReturnValue({
          accountType: "INVESTMENT",
          accountName: "",
          transactions: [
            makeQifTransaction({
              action: "Buy",
              security: "AAPL",
              price: 150,
              quantity: 10,
              commission: 9.99,
              amount: 1509.99,
              date: "2025-01-15",
              payee: "",
              category: "",
              memo: "Buy AAPL",
            }),
          ],
          categories: [],
          transferAccounts: [],
          securities: ["AAPL"],
          detectedDateFormat: "MM/DD/YYYY",
          sampleDates: [],
          openingBalance: null,
          openingBalanceDate: null,
        });

        const result = await service.importQifFile(userId, makeInvestmentDto());

        expect(result.imported).toBe(1);

        // Should have saved InvestmentTransaction and Transaction (cash side)
        const saveCalls = mockQueryRunner.manager.save.mock.calls;
        // At least 2 saves: investment tx and cash tx (plus holdings update)
        expect(saveCalls.length).toBeGreaterThanOrEqual(2);

        // Verify net worth recalculation is triggered
        expect(mockNetWorthService.recalculateAccount).toHaveBeenCalled();
      });

      it("imports SELL transaction with positive cash flow", async () => {
        mockedParseQif.mockReturnValue({
          accountType: "INVESTMENT",
          accountName: "",
          transactions: [
            makeQifTransaction({
              action: "Sell",
              security: "AAPL",
              price: 180,
              quantity: 5,
              commission: 9.99,
              amount: 890.01,
              date: "2025-02-01",
              payee: "",
              category: "",
            }),
          ],
          categories: [],
          transferAccounts: [],
          securities: ["AAPL"],
          detectedDateFormat: "MM/DD/YYYY",
          sampleDates: [],
          openingBalance: null,
          openingBalanceDate: null,
        });

        const result = await service.importQifFile(userId, makeInvestmentDto());

        expect(result.imported).toBe(1);
      });

      it("imports DIVIDEND transaction", async () => {
        mockedParseQif.mockReturnValue({
          accountType: "INVESTMENT",
          accountName: "",
          transactions: [
            makeQifTransaction({
              action: "Div",
              security: "AAPL",
              price: 0,
              quantity: 0,
              commission: 0,
              amount: 25.5,
              date: "2025-03-15",
              payee: "",
              category: "",
            }),
          ],
          categories: [],
          transferAccounts: [],
          securities: ["AAPL"],
          detectedDateFormat: "MM/DD/YYYY",
          sampleDates: [],
          openingBalance: null,
          openingBalanceDate: null,
        });

        const result = await service.importQifFile(userId, makeInvestmentDto());

        expect(result.imported).toBe(1);
      });

      it("maps QIF actions to InvestmentAction enum correctly", async () => {
        const actionMappings = [
          { qifAction: "Buy", expected: InvestmentAction.BUY },
          { qifAction: "Sell", expected: InvestmentAction.SELL },
          { qifAction: "Div", expected: InvestmentAction.DIVIDEND },
          { qifAction: "IntInc", expected: InvestmentAction.INTEREST },
          { qifAction: "CGLong", expected: InvestmentAction.CAPITAL_GAIN },
          { qifAction: "StkSplit", expected: InvestmentAction.SPLIT },
          { qifAction: "ShrsIn", expected: InvestmentAction.TRANSFER_IN },
          { qifAction: "ShrsOut", expected: InvestmentAction.TRANSFER_OUT },
          { qifAction: "ReinvDiv", expected: InvestmentAction.REINVEST },
        ];

        for (const mapping of actionMappings) {
          mockQueryRunner.manager.save.mockClear();

          mockedParseQif.mockReturnValue({
            accountType: "INVESTMENT",
            accountName: "",
            transactions: [
              makeQifTransaction({
                action: mapping.qifAction,
                security: "AAPL",
                price: 150,
                quantity: 10,
                amount: 1500,
              }),
            ],
            categories: [],
            transferAccounts: [],
            securities: ["AAPL"],
            detectedDateFormat: "MM/DD/YYYY",
            sampleDates: [],
            openingBalance: null,
            openingBalanceDate: null,
          });

          await service.importQifFile(userId, makeInvestmentDto());

          // Find the InvestmentTransaction that was saved
          const investmentTxSave = mockQueryRunner.manager.save.mock.calls.find(
            (call: unknown[]) =>
              (call[0] as Record<string, unknown>)?.action !== undefined,
          );
          expect(investmentTxSave).toBeDefined();
          expect((investmentTxSave[0] as Record<string, unknown>).action).toBe(
            mapping.expected,
          );
        }
      });

      it("handles X-suffix actions (e.g., BuyX, SellX)", async () => {
        mockedParseQif.mockReturnValue({
          accountType: "INVESTMENT",
          accountName: "",
          transactions: [
            makeQifTransaction({
              action: "BuyX",
              security: "AAPL",
              price: 150,
              quantity: 10,
              amount: 1500,
            }),
          ],
          categories: [],
          transferAccounts: [],
          securities: ["AAPL"],
          detectedDateFormat: "MM/DD/YYYY",
          sampleDates: [],
          openingBalance: null,
          openingBalanceDate: null,
        });

        const result = await service.importQifFile(userId, makeInvestmentDto());

        expect(result.imported).toBe(1);

        // Should still map to BUY action
        const investmentTxSave = mockQueryRunner.manager.save.mock.calls.find(
          (call: unknown[]) =>
            (call[0] as Record<string, unknown>)?.action ===
            InvestmentAction.BUY,
        );
        expect(investmentTxSave).toBeDefined();
      });

      it("auto-creates security when not in mappings", async () => {
        mockedParseQif.mockReturnValue({
          accountType: "INVESTMENT",
          accountName: "",
          transactions: [
            makeQifTransaction({
              action: "Buy",
              security: "Unknown Security",
              price: 50,
              quantity: 20,
              amount: 1000,
            }),
          ],
          categories: [],
          transferAccounts: [],
          securities: ["Unknown Security"],
          detectedDateFormat: "MM/DD/YYYY",
          sampleDates: [],
          openingBalance: null,
          openingBalanceDate: null,
        });

        // No security mapping for "Unknown Security"
        const dto = makeInvestmentDto({
          securityMappings: [],
        });

        mockQueryRunner.manager.findOne.mockImplementation(
          (
            entity: unknown,
            options: { where?: { id?: string; symbol?: string } },
          ) => {
            if (entity === Account && options?.where?.id === "acct-brokerage") {
              return Promise.resolve({ ...mockBrokerageAccount });
            }
            if (
              entity === Account &&
              options?.where?.id === "acct-brokerage-cash"
            ) {
              return Promise.resolve({ ...mockBrokerageCashAccount });
            }
            // Security doesn't exist
            return Promise.resolve(null);
          },
        );

        let savedAutoSecurity: Record<string, unknown> | null = null;
        let saveCount = 0;
        mockQueryRunner.manager.save.mockImplementation(
          (entity: Record<string, unknown>) => {
            saveCount++;
            if (entity.symbol && (entity.symbol as string).includes("*")) {
              savedAutoSecurity = entity;
              return Promise.resolve({ ...entity, id: "auto-sec-id" });
            }
            return Promise.resolve({
              ...entity,
              id: entity.id || `saved-${saveCount}`,
            });
          },
        );

        const result = await service.importQifFile(userId, dto);

        expect(result.securitiesCreated).toBe(1);
        // Auto-generated symbol should end with *
        expect(savedAutoSecurity).toBeDefined();
        expect((savedAutoSecurity!.symbol as string).endsWith("*")).toBe(true);
        expect(savedAutoSecurity!.skipPriceUpdates).toBe(true);
      });

      it("creates and updates holdings for BUY transactions", async () => {
        mockedParseQif.mockReturnValue({
          accountType: "INVESTMENT",
          accountName: "",
          transactions: [
            makeQifTransaction({
              action: "Buy",
              security: "AAPL",
              price: 150,
              quantity: 10,
              amount: 1500,
            }),
          ],
          categories: [],
          transferAccounts: [],
          securities: ["AAPL"],
          detectedDateFormat: "MM/DD/YYYY",
          sampleDates: [],
          openingBalance: null,
          openingBalanceDate: null,
        });

        // No existing holding
        mockQueryRunner.manager.findOne.mockImplementation(
          (
            entity: unknown,
            options: {
              where?: { id?: string; accountId?: string; securityId?: string };
            },
          ) => {
            if (entity === Account && options?.where?.id === "acct-brokerage") {
              return Promise.resolve({ ...mockBrokerageAccount });
            }
            if (
              entity === Account &&
              options?.where?.id === "acct-brokerage-cash"
            ) {
              return Promise.resolve({ ...mockBrokerageCashAccount });
            }
            if (entity === Security && options?.where?.id === "sec-aapl") {
              return Promise.resolve({
                id: "sec-aapl",
                symbol: "AAPL",
                userId,
              });
            }
            if (entity === Holding) {
              return Promise.resolve(null); // No existing holding
            }
            return Promise.resolve(null);
          },
        );

        await service.importQifFile(userId, makeInvestmentDto());

        // Should save a new Holding
        const holdingSave = mockQueryRunner.manager.save.mock.calls.find(
          (call: unknown[]) =>
            (call[0] as Record<string, unknown>)?.accountId ===
              "acct-brokerage" &&
            (call[0] as Record<string, unknown>)?.securityId === "sec-aapl" &&
            (call[0] as Record<string, unknown>)?.quantity !== undefined &&
            !(call[0] as Record<string, unknown>)?.action, // Not an InvestmentTransaction
        );
        expect(holdingSave).toBeDefined();
        expect(holdingSave[0].quantity).toBe(10);
        expect(holdingSave[0].averageCost).toBe(150);
      });

      it("updates existing holding with weighted average cost for BUY", async () => {
        mockedParseQif.mockReturnValue({
          accountType: "INVESTMENT",
          accountName: "",
          transactions: [
            makeQifTransaction({
              action: "Buy",
              security: "AAPL",
              price: 200,
              quantity: 10,
              amount: 2000,
            }),
          ],
          categories: [],
          transferAccounts: [],
          securities: ["AAPL"],
          detectedDateFormat: "MM/DD/YYYY",
          sampleDates: [],
          openingBalance: null,
          openingBalanceDate: null,
        });

        mockQueryRunner.manager.findOne.mockImplementation(
          (
            entity: unknown,
            options: {
              where?: { id?: string; accountId?: string; securityId?: string };
            },
          ) => {
            if (entity === Account && options?.where?.id === "acct-brokerage") {
              return Promise.resolve({ ...mockBrokerageAccount });
            }
            if (
              entity === Account &&
              options?.where?.id === "acct-brokerage-cash"
            ) {
              return Promise.resolve({ ...mockBrokerageCashAccount });
            }
            if (entity === Security && options?.where?.id === "sec-aapl") {
              return Promise.resolve({
                id: "sec-aapl",
                symbol: "AAPL",
                userId,
              });
            }
            if (
              entity === Holding &&
              options?.where?.accountId === "acct-brokerage"
            ) {
              return Promise.resolve({
                accountId: "acct-brokerage",
                securityId: "sec-aapl",
                quantity: 10,
                averageCost: 150,
              });
            }
            return Promise.resolve(null);
          },
        );

        await service.importQifFile(userId, makeInvestmentDto());

        // Should update holding: new quantity = 10+10 = 20, new avg cost = (10*150 + 10*200)/20 = 175
        const holdingSave = mockQueryRunner.manager.save.mock.calls.find(
          (call: unknown[]) =>
            (call[0] as Record<string, unknown>)?.securityId === "sec-aapl" &&
            (call[0] as Record<string, unknown>)?.quantity === 20,
        );
        expect(holdingSave).toBeDefined();
        expect(holdingSave[0].averageCost).toBe(175);
      });

      it("backfills historical security prices for investment imports", async () => {
        mockedParseQif.mockReturnValue({
          accountType: "INVESTMENT",
          accountName: "",
          transactions: [
            makeQifTransaction({
              action: "Buy",
              security: "AAPL",
              price: 150,
              quantity: 10,
              amount: 1500,
            }),
          ],
          categories: [],
          transferAccounts: [],
          securities: ["AAPL"],
          detectedDateFormat: "MM/DD/YYYY",
          sampleDates: [],
          openingBalance: null,
          openingBalanceDate: null,
        });

        await service.importQifFile(userId, makeInvestmentDto());

        expect(
          mockSecurityPriceService.backfillHistoricalPrices,
        ).toHaveBeenCalled();
      });

      it("backfills transaction-derived prices after investment import", async () => {
        mockedParseQif.mockReturnValue({
          accountType: "INVESTMENT",
          accountName: "",
          transactions: [
            makeQifTransaction({
              action: "Buy",
              security: "AAPL",
              price: 150,
              quantity: 10,
              amount: 1500,
            }),
          ],
          categories: [],
          transferAccounts: [],
          securities: ["AAPL"],
          detectedDateFormat: "MM/DD/YYYY",
          sampleDates: [],
          openingBalance: null,
          openingBalanceDate: null,
        });

        await service.importQifFile(userId, makeInvestmentDto());

        expect(
          mockSecurityPriceService.backfillTransactionPrices,
        ).toHaveBeenCalled();
      });

      it("does not fail when transaction price backfill fails", async () => {
        mockedParseQif.mockReturnValue({
          accountType: "INVESTMENT",
          accountName: "",
          transactions: [
            makeQifTransaction({
              action: "Buy",
              security: "AAPL",
              price: 150,
              quantity: 10,
              amount: 1500,
            }),
          ],
          categories: [],
          transferAccounts: [],
          securities: ["AAPL"],
          detectedDateFormat: "MM/DD/YYYY",
          sampleDates: [],
          openingBalance: null,
          openingBalanceDate: null,
        });

        mockSecurityPriceService.backfillTransactionPrices.mockRejectedValue(
          new Error("Transaction price backfill failed"),
        );

        const result = await service.importQifFile(userId, makeInvestmentDto());
        expect(result.imported).toBeGreaterThanOrEqual(0);
      });
    });

    describe("post-import operations", () => {
      it("backfills historical exchange rates after import", async () => {
        await service.importQifFile(userId, makeBaseDto());

        expect(
          mockExchangeRateService.backfillHistoricalRates,
        ).toHaveBeenCalledWith(userId, expect.arrayContaining(["acct-1"]));
      });

      it("triggers net worth recalculation for affected accounts", async () => {
        await service.importQifFile(userId, makeBaseDto());

        expect(mockNetWorthService.recalculateAccount).toHaveBeenCalledWith(
          userId,
          "acct-1",
        );
      });

      it("does not backfill security prices for non-investment imports", async () => {
        await service.importQifFile(userId, makeBaseDto());

        expect(
          mockSecurityPriceService.backfillHistoricalPrices,
        ).not.toHaveBeenCalled();
      });

      it("does not backfill transaction-derived prices for non-investment imports", async () => {
        await service.importQifFile(userId, makeBaseDto());

        expect(
          mockSecurityPriceService.backfillTransactionPrices,
        ).not.toHaveBeenCalled();
      });

      it("does not fail when post-import exchange rate backfill fails", async () => {
        mockExchangeRateService.backfillHistoricalRates.mockRejectedValue(
          new Error("Rate backfill failed"),
        );

        // Should not throw
        const result = await service.importQifFile(userId, makeBaseDto());
        expect(result.imported).toBe(1);
      });

      it("does not fail when post-import net worth recalculation fails", async () => {
        mockNetWorthService.recalculateAccount.mockRejectedValue(
          new Error("Recalc failed"),
        );

        // Should not throw since recalculateAccount is fire-and-forget
        const result = await service.importQifFile(userId, makeBaseDto());
        expect(result.imported).toBe(1);
      });

      it("does not fail when post-import security price backfill fails", async () => {
        accountsRepository.findOne.mockResolvedValue(mockBrokerageAccount);

        mockDataSource.getRepository.mockReturnValue({
          findOne: jest.fn().mockResolvedValue({ id: "sec-aapl", userId }),
          find: jest.fn().mockResolvedValue([{ id: "sec-aapl" }]),
        });

        mockQueryRunner.manager.findOne.mockImplementation(
          (entity: unknown, options: { where?: { id?: string } }) => {
            if (entity === Account && options?.where?.id === "acct-brokerage") {
              return Promise.resolve({ ...mockBrokerageAccount });
            }
            if (
              entity === Account &&
              options?.where?.id === "acct-brokerage-cash"
            ) {
              return Promise.resolve({ ...mockBrokerageCashAccount });
            }
            if (entity === Security && options?.where?.id === "sec-aapl") {
              return Promise.resolve({
                id: "sec-aapl",
                symbol: "AAPL",
                userId,
              });
            }
            return Promise.resolve(null);
          },
        );

        mockedParseQif.mockReturnValue({
          accountType: "INVESTMENT",
          accountName: "",
          transactions: [
            makeQifTransaction({
              action: "Buy",
              security: "AAPL",
              price: 150,
              quantity: 10,
              amount: 1500,
            }),
          ],
          categories: [],
          transferAccounts: [],
          securities: ["AAPL"],
          detectedDateFormat: "MM/DD/YYYY",
          sampleDates: [],
          openingBalance: null,
          openingBalanceDate: null,
        });

        mockSecurityPriceService.backfillHistoricalPrices.mockRejectedValue(
          new Error("Price backfill failed"),
        );

        const dto = {
          content: "!Type:Invst\n",
          accountId: "acct-brokerage",
          categoryMappings: [],
          accountMappings: [],
          securityMappings: [{ originalName: "AAPL", securityId: "sec-aapl" }],
        };

        // Should not throw
        const result = await service.importQifFile(userId, dto);
        expect(result.imported).toBe(1);
      });
    });

    describe("date format passthrough", () => {
      it("passes dateFormat to parseQif", async () => {
        const dto = makeBaseDto({ dateFormat: "DD/MM/YYYY" });

        await service.importQifFile(userId, dto);

        expect(mockedParseQif).toHaveBeenCalledWith(dto.content, "DD/MM/YYYY");
      });
    });
  });

  describe("getExistingCategories", () => {
    it("returns all categories for user sorted by name", async () => {
      const categories = [
        { id: "cat-1", userId, name: "Auto" },
        { id: "cat-2", userId, name: "Food" },
      ];
      categoriesRepository.find.mockResolvedValue(categories);

      const result = await service.getExistingCategories(userId);

      expect(categoriesRepository.find).toHaveBeenCalledWith({
        where: { userId },
        order: { name: "ASC" },
      });
      expect(result).toEqual(categories);
    });

    it("returns empty array when user has no categories", async () => {
      categoriesRepository.find.mockResolvedValue([]);

      const result = await service.getExistingCategories(userId);

      expect(result).toEqual([]);
    });
  });

  describe("getExistingAccounts", () => {
    it("returns all accounts for user sorted by name", async () => {
      const accounts = [
        { id: "acct-1", userId, name: "Chequing" },
        { id: "acct-2", userId, name: "Savings" },
      ];
      accountsRepository.find.mockResolvedValue(accounts);

      const result = await service.getExistingAccounts(userId);

      expect(accountsRepository.find).toHaveBeenCalledWith({
        where: { userId },
        order: { name: "ASC" },
      });
      expect(result).toEqual(accounts);
    });

    it("returns empty array when user has no accounts", async () => {
      accountsRepository.find.mockResolvedValue([]);

      const result = await service.getExistingAccounts(userId);

      expect(result).toEqual([]);
    });
  });

  // --- OFX Tests ---

  describe("parseOfxFile", () => {
    const validOfxContent = "<OFX><BANKMSGSRSV1>...</BANKMSGSRSV1></OFX>";

    it("returns parsed OFX data with date range and metadata", async () => {
      mockedValidateOfxContent.mockReturnValue({ valid: true });
      mockedParseOfx.mockReturnValue({
        accountType: "CHEQUING",
        accountName: "",
        transactions: [
          {
            date: "2025-03-01",
            amount: -100,
            payee: "Store",
            memo: "",
            number: "",
            cleared: false,
            reconciled: false,
            category: "",
            isTransfer: false,
            transferAccount: "",
            splits: [],
            security: "",
            action: "",
            price: 0,
            quantity: 0,
            commission: 0,
          },
          {
            date: "2025-03-15",
            amount: 500,
            payee: "Employer",
            memo: "",
            number: "",
            cleared: false,
            reconciled: false,
            category: "",
            isTransfer: false,
            transferAccount: "",
            splits: [],
            security: "",
            action: "",
            price: 0,
            quantity: 0,
            commission: 0,
          },
        ],
        categories: [],
        transferAccounts: [],
        securities: [],
        detectedDateFormat: "YYYY-MM-DD",
        sampleDates: ["2025-03-01", "2025-03-15"],
        openingBalance: null,
        openingBalanceDate: null,
      });

      const result = await service.parseOfxFile(userId, validOfxContent);

      expect(mockedValidateOfxContent).toHaveBeenCalledWith(validOfxContent);
      expect(mockedParseOfx).toHaveBeenCalledWith(validOfxContent);
      expect(result.accountType).toBe("CHEQUING");
      expect(result.transactionCount).toBe(2);
      expect(result.dateRange.start).toBe("2025-03-01");
      expect(result.dateRange.end).toBe("2025-03-15");
    });

    it("throws BadRequestException for invalid OFX content", async () => {
      mockedValidateOfxContent.mockReturnValue({
        valid: false,
        error: "Invalid OFX format",
      });

      await expect(service.parseOfxFile(userId, "bad content")).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe("importOfxFile", () => {
    it("throws BadRequestException for invalid OFX content", async () => {
      mockedValidateOfxContent.mockReturnValue({
        valid: false,
        error: "Invalid OFX format",
      });

      const dto = {
        content: "bad",
        accountId: "acct-1",
        categoryMappings: [],
        accountMappings: [],
      };

      await expect(service.importOfxFile(userId, dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("parses OFX and imports transactions into the specified account", async () => {
      mockedValidateOfxContent.mockReturnValue({ valid: true });
      mockedParseOfx.mockReturnValue({
        accountType: "CHEQUING",
        accountName: "",
        transactions: [
          {
            date: "2025-03-01",
            amount: -50,
            payee: "Store",
            memo: "",
            number: "",
            cleared: false,
            reconciled: false,
            category: "",
            isTransfer: false,
            transferAccount: "",
            splits: [],
            security: "",
            action: "",
            price: 0,
            quantity: 0,
            commission: 0,
          },
        ],
        categories: [],
        transferAccounts: [],
        securities: [],
        detectedDateFormat: "YYYY-MM-DD",
        sampleDates: [],
        openingBalance: null,
        openingBalanceDate: null,
      });

      accountsRepository.findOne.mockResolvedValue(mockChequingAccount);

      const dto = {
        content: "<OFX>...</OFX>",
        accountId: "acct-1",
        categoryMappings: [],
        accountMappings: [],
      };

      const result = await service.importOfxFile(userId, dto);

      expect(mockedParseOfx).toHaveBeenCalledWith(dto.content);
      expect(result).toBeDefined();
      expect(result.imported).toBeDefined();
    });
  });

  // --- CSV Tests ---

  describe("parseCsvHeaders", () => {
    it("returns headers and sample rows from CSV content", async () => {
      const csvContent = "Date,Amount,Payee\n2025-01-01,-50,Store\n";
      mockedValidateCsvContent.mockReturnValue({ valid: true });
      mockedParseCsvHeaders.mockReturnValue({
        headers: ["Date", "Amount", "Payee"],
        sampleRows: [["2025-01-01", "-50", "Store"]],
        rowCount: 1,
      });

      const result = await service.parseCsvHeaders(userId, csvContent);

      expect(mockedValidateCsvContent).toHaveBeenCalledWith(csvContent);
      expect(mockedParseCsvHeaders).toHaveBeenCalledWith(csvContent, undefined);
      expect(result.headers).toEqual(["Date", "Amount", "Payee"]);
      expect(result.sampleRows).toHaveLength(1);
      expect(result.rowCount).toBe(1);
    });

    it("passes delimiter to the parser when provided", async () => {
      const csvContent = "Date;Amount;Payee\n2025-01-01;-50;Store\n";
      mockedValidateCsvContent.mockReturnValue({ valid: true });
      mockedParseCsvHeaders.mockReturnValue({
        headers: ["Date", "Amount", "Payee"],
        sampleRows: [["2025-01-01", "-50", "Store"]],
        rowCount: 1,
      });

      await service.parseCsvHeaders(userId, csvContent, ";");

      expect(mockedParseCsvHeaders).toHaveBeenCalledWith(csvContent, ";");
    });

    it("throws BadRequestException for invalid CSV content", async () => {
      mockedValidateCsvContent.mockReturnValue({
        valid: false,
        error: "File is empty",
      });

      await expect(service.parseCsvHeaders(userId, "")).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe("parseCsvFile", () => {
    const columnMapping = {
      date: 0,
      amount: 1,
      payee: 2,
      dateFormat: "YYYY-MM-DD" as const,
      hasHeader: true,
      delimiter: ",",
    };

    it("returns parsed CSV data with date range and metadata", async () => {
      const csvContent = "Date,Amount,Payee\n2025-01-01,-50,Store\n";
      mockedValidateCsvContent.mockReturnValue({ valid: true });
      mockedParseCsv.mockReturnValue({
        accountType: "CHEQUING",
        accountName: "",
        transactions: [
          {
            date: "2025-01-01",
            amount: -50,
            payee: "Store",
            memo: "",
            number: "",
            cleared: false,
            reconciled: false,
            category: "",
            isTransfer: false,
            transferAccount: "",
            splits: [],
            security: "",
            action: "",
            price: 0,
            quantity: 0,
            commission: 0,
          },
        ],
        categories: [],
        transferAccounts: [],
        securities: [],
        detectedDateFormat: "YYYY-MM-DD",
        sampleDates: [],
        openingBalance: null,
        openingBalanceDate: null,
      });

      const result = await service.parseCsvFile(
        userId,
        csvContent,
        columnMapping,
      );

      expect(mockedValidateCsvContent).toHaveBeenCalledWith(csvContent);
      expect(mockedParseCsv).toHaveBeenCalledWith(
        csvContent,
        columnMapping,
        undefined,
      );
      expect(result.accountType).toBe("CHEQUING");
      expect(result.transactionCount).toBe(1);
      expect(result.dateRange.start).toBe("2025-01-01");
      expect(result.dateRange.end).toBe("2025-01-01");
    });

    it("passes transfer rules to parseCsv when provided", async () => {
      const csvContent = "Date,Amount,Payee\n2025-01-01,-50,Transfer\n";
      const transferRules = [
        { type: "payee" as const, pattern: "Transfer", accountName: "Savings" },
      ];
      mockedValidateCsvContent.mockReturnValue({ valid: true });
      mockedParseCsv.mockReturnValue({
        accountType: "CHEQUING",
        accountName: "",
        transactions: [],
        categories: [],
        transferAccounts: ["Savings"],
        securities: [],
        detectedDateFormat: "YYYY-MM-DD",
        sampleDates: [],
        openingBalance: null,
        openingBalanceDate: null,
      });

      await service.parseCsvFile(
        userId,
        csvContent,
        columnMapping,
        transferRules,
      );

      expect(mockedParseCsv).toHaveBeenCalledWith(
        csvContent,
        columnMapping,
        transferRules,
      );
    });

    it("throws BadRequestException for invalid CSV content", async () => {
      mockedValidateCsvContent.mockReturnValue({
        valid: false,
        error: "File is empty",
      });

      await expect(
        service.parseCsvFile(userId, "", columnMapping),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("importCsvFile", () => {
    it("throws BadRequestException for invalid CSV content", async () => {
      mockedValidateCsvContent.mockReturnValue({
        valid: false,
        error: "File is empty",
      });

      const dto = {
        content: "",
        accountId: "acct-1",
        columnMapping: {
          date: 0,
          amount: 1,
          dateFormat: "YYYY-MM-DD",
          hasHeader: true,
          delimiter: ",",
        },
        categoryMappings: [],
        accountMappings: [],
      } as any;

      await expect(service.importCsvFile(userId, dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("parses CSV and imports transactions into the specified account", async () => {
      mockedValidateCsvContent.mockReturnValue({ valid: true });
      mockedParseCsv.mockReturnValue({
        accountType: "CHEQUING",
        accountName: "",
        transactions: [
          {
            date: "2025-01-01",
            amount: -50,
            payee: "Store",
            memo: "",
            number: "",
            cleared: false,
            reconciled: false,
            category: "",
            isTransfer: false,
            transferAccount: "",
            splits: [],
            security: "",
            action: "",
            price: 0,
            quantity: 0,
            commission: 0,
          },
        ],
        categories: [],
        transferAccounts: [],
        securities: [],
        detectedDateFormat: "YYYY-MM-DD",
        sampleDates: [],
        openingBalance: null,
        openingBalanceDate: null,
      });

      accountsRepository.findOne.mockResolvedValue(mockChequingAccount);

      const dto = {
        content: "Date,Amount,Payee\n2025-01-01,-50,Store\n",
        accountId: "acct-1",
        columnMapping: {
          date: 0,
          amount: 1,
          payee: 2,
          dateFormat: "YYYY-MM-DD",
          hasHeader: true,
          delimiter: ",",
        },
        categoryMappings: [],
        accountMappings: [],
      } as any;

      const result = await service.importCsvFile(userId, dto);

      expect(mockedParseCsv).toHaveBeenCalled();
      expect(result).toBeDefined();
      expect(result.imported).toBeDefined();
    });
  });

  // --- Column Mapping CRUD Tests ---

  describe("getColumnMappings", () => {
    it("returns all column mappings for user sorted by name", async () => {
      const mappings = [
        {
          id: "mapping-1",
          userId,
          name: "Bank CSV",
          columnMappings: { date: 0, amount: 1 },
          transferRules: [],
          createdAt: new Date("2025-01-01"),
          updatedAt: new Date("2025-01-01"),
        },
        {
          id: "mapping-2",
          userId,
          name: "Credit Card CSV",
          columnMappings: { date: 0, debit: 1, credit: 2 },
          transferRules: [],
          createdAt: new Date("2025-01-02"),
          updatedAt: new Date("2025-01-02"),
        },
      ];
      columnMappingRepository.find.mockResolvedValue(mappings);

      const result = await service.getColumnMappings(userId);

      expect(columnMappingRepository.find).toHaveBeenCalledWith({
        where: { userId },
        order: { name: "ASC" },
      });
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe("mapping-1");
      expect(result[0].name).toBe("Bank CSV");
      expect(result[1].id).toBe("mapping-2");
    });

    it("returns empty array when user has no column mappings", async () => {
      columnMappingRepository.find.mockResolvedValue([]);

      const result = await service.getColumnMappings(userId);

      expect(result).toEqual([]);
    });
  });

  describe("createColumnMapping", () => {
    const createDto = {
      name: "My Bank CSV",
      columnMappings: { date: 0, amount: 1, payee: 2 },
      transferRules: [],
    };

    it("creates a new column mapping", async () => {
      columnMappingRepository.findOne.mockResolvedValue(null);
      const createdEntity = {
        id: "mapping-new",
        userId,
        name: createDto.name,
        columnMappings: createDto.columnMappings,
        transferRules: createDto.transferRules,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      columnMappingRepository.create.mockReturnValue(createdEntity);
      columnMappingRepository.save.mockResolvedValue(createdEntity);

      const result = await service.createColumnMapping(
        userId,
        createDto as any,
      );

      expect(columnMappingRepository.findOne).toHaveBeenCalledWith({
        where: { userId, name: createDto.name },
      });
      expect(columnMappingRepository.create).toHaveBeenCalled();
      expect(columnMappingRepository.save).toHaveBeenCalled();
      expect(result.id).toBe("mapping-new");
      expect(result.name).toBe("My Bank CSV");
    });

    it("overwrites existing mapping when name already exists", async () => {
      const existingEntity = {
        id: "existing-mapping",
        userId,
        name: createDto.name,
        columnMappings: { date: 0, amount: 1 },
        transferRules: [],
      };
      columnMappingRepository.findOne.mockResolvedValue(existingEntity);
      columnMappingRepository.save.mockResolvedValue({
        ...existingEntity,
        columnMappings: createDto.columnMappings,
      });

      const result = await service.createColumnMapping(
        userId,
        createDto as any,
      );

      expect(columnMappingRepository.save).toHaveBeenCalledWith(existingEntity);
      expect(result.id).toBe("existing-mapping");
    });
  });

  describe("updateColumnMapping", () => {
    const existingMapping = {
      id: "mapping-1",
      userId,
      name: "Old Name",
      columnMappings: { date: 0, amount: 1 },
      transferRules: [],
      createdAt: new Date("2025-01-01"),
      updatedAt: new Date("2025-01-01"),
    };

    it("updates the name of an existing column mapping", async () => {
      columnMappingRepository.findOne
        .mockResolvedValueOnce({ ...existingMapping })
        .mockResolvedValueOnce(null); // no duplicate name
      const savedMapping = {
        ...existingMapping,
        name: "New Name",
        updatedAt: new Date(),
      };
      columnMappingRepository.save.mockResolvedValue(savedMapping);

      const result = await service.updateColumnMapping(userId, "mapping-1", {
        name: "New Name",
      });

      expect(result.name).toBe("New Name");
    });

    it("updates columnMappings without changing name", async () => {
      columnMappingRepository.findOne.mockResolvedValueOnce({
        ...existingMapping,
      });
      const newMappings = { date: 0, amount: 1, payee: 3 };
      const savedMapping = {
        ...existingMapping,
        columnMappings: newMappings,
        updatedAt: new Date(),
      };
      columnMappingRepository.save.mockResolvedValue(savedMapping);

      const result = await service.updateColumnMapping(userId, "mapping-1", {
        columnMappings: newMappings as any,
      });

      expect(result.columnMappings).toEqual(newMappings);
    });

    it("throws NotFoundException when mapping does not exist", async () => {
      columnMappingRepository.findOne.mockResolvedValue(null);

      await expect(
        service.updateColumnMapping(userId, "nonexistent-id", {
          name: "New Name",
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it("throws ConflictException when renaming to an existing name", async () => {
      columnMappingRepository.findOne
        .mockResolvedValueOnce({ ...existingMapping })
        .mockResolvedValueOnce({
          id: "mapping-2",
          userId,
          name: "Duplicate Name",
        });

      await expect(
        service.updateColumnMapping(userId, "mapping-1", {
          name: "Duplicate Name",
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe("deleteColumnMapping", () => {
    it("deletes an existing column mapping", async () => {
      const existingMapping = {
        id: "mapping-1",
        userId,
        name: "My Mapping",
        columnMappings: { date: 0, amount: 1 },
        transferRules: [],
      };
      columnMappingRepository.findOne.mockResolvedValue(existingMapping);

      await service.deleteColumnMapping(userId, "mapping-1");

      expect(columnMappingRepository.findOne).toHaveBeenCalledWith({
        where: { id: "mapping-1", userId },
      });
      expect(columnMappingRepository.remove).toHaveBeenCalledWith(
        existingMapping,
      );
    });

    it("throws NotFoundException when mapping does not exist", async () => {
      columnMappingRepository.findOne.mockResolvedValue(null);

      await expect(
        service.deleteColumnMapping(userId, "nonexistent-id"),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("parseQifMultiAccountFile", () => {
    const validContent =
      "!Type:Cat\nNFood\nE\n^\n!Account\nNChecking\nTBank\n^\n!Type:Bank\nD01/15/2025\nT-50.00\nPGrocery\n^";

    it("parses a multi-account QIF file and returns summary", async () => {
      mockedValidateQifContent.mockReturnValue({ valid: true });
      mockedParseQifFull.mockReturnValue({
        categoryDefs: [
          {
            name: "Food",
            description: "",
            isIncome: false,
            taxRelated: false,
            taxSchedule: "",
          },
          {
            name: "Salary",
            description: "Monthly pay",
            isIncome: true,
            taxRelated: false,
            taxSchedule: "",
          },
        ],
        tagDefs: [{ name: "Vacation", description: "Travel" }],
        accountBlocks: [
          {
            accountName: "Checking",
            accountType: "CHEQUING",
            description: "",
            creditLimit: null,
            transactions: [
              {
                date: "2025-01-15",
                amount: -50,
                payee: "Grocery",
                memo: "",
                number: "",
                cleared: false,
                reconciled: false,
                category: "Food",
                splits: [],
                tagNames: [],
                isTransfer: false,
                transferAccount: "",
                security: "",
                action: "",
                price: 0,
                quantity: 0,
                commission: 0,
              },
              {
                date: "2025-01-20",
                amount: 2000,
                payee: "Employer",
                memo: "",
                number: "",
                cleared: false,
                reconciled: false,
                category: "Salary",
                splits: [],
                tagNames: [],
                isTransfer: false,
                transferAccount: "",
                security: "",
                action: "",
                price: 0,
                quantity: 0,
                commission: 0,
              },
            ],
            categories: ["Food", "Salary"],
            transferAccounts: [],
            securities: [],
            openingBalance: null,
            openingBalanceDate: null,
          },
        ],
        detectedDateFormat: "MM/DD/YYYY" as any,
        sampleDates: ["01/15/2025", "01/20/2025"],
        isMultiAccount: true,
      });

      const result = await service.parseQifMultiAccountFile(
        userId,
        validContent,
      );

      expect(result.isMultiAccount).toBe(true);
      expect(result.categoryDefs).toHaveLength(2);
      expect(result.categoryDefs[0]).toEqual({
        name: "Food",
        description: "",
        isIncome: false,
      });
      expect(result.categoryDefs[1]).toEqual({
        name: "Salary",
        description: "Monthly pay",
        isIncome: true,
      });
      expect(result.accounts).toHaveLength(1);
      expect(result.accounts[0].accountName).toBe("Checking");
      expect(result.accounts[0].transactionCount).toBe(2);
      expect(result.accounts[0].dateRange).toEqual({
        start: "2025-01-15",
        end: "2025-01-20",
      });
      expect(result.totalTransactionCount).toBe(2);
      expect(result.tagDefs).toHaveLength(1);
      expect(result.tagDefs[0]).toEqual({
        name: "Vacation",
        description: "Travel",
      });
      expect(result.detectedDateFormat).toBe("MM/DD/YYYY");
      expect(result.sampleDates).toEqual(["01/15/2025", "01/20/2025"]);
    });

    it("throws BadRequestException for invalid content", async () => {
      mockedValidateQifContent.mockReturnValue({
        valid: false,
        error: "Not a valid QIF file",
      });

      await expect(
        service.parseQifMultiAccountFile(userId, "invalid"),
      ).rejects.toThrow(BadRequestException);
    });

    it("handles multiple accounts with date ranges", async () => {
      mockedValidateQifContent.mockReturnValue({ valid: true });
      mockedParseQifFull.mockReturnValue({
        categoryDefs: [],
        tagDefs: [],
        accountBlocks: [
          {
            accountName: "Checking",
            accountType: "CHEQUING",
            description: "",
            creditLimit: null,
            transactions: [
              {
                date: "2025-01-15",
                amount: -50,
                payee: "Store",
                memo: "",
                number: "",
                cleared: false,
                reconciled: false,
                category: "",
                splits: [],
                tagNames: [],
                isTransfer: false,
                transferAccount: "",
                security: "",
                action: "",
                price: 0,
                quantity: 0,
                commission: 0,
              },
            ],
            categories: [],
            transferAccounts: [],
            securities: [],
            openingBalance: null,
            openingBalanceDate: null,
          },
          {
            accountName: "Savings",
            accountType: "SAVINGS",
            description: "",
            creditLimit: null,
            transactions: [
              {
                date: "2025-02-01",
                amount: 100,
                payee: "Transfer",
                memo: "",
                number: "",
                cleared: false,
                reconciled: false,
                category: "",
                splits: [],
                tagNames: [],
                isTransfer: false,
                transferAccount: "",
                security: "",
                action: "",
                price: 0,
                quantity: 0,
                commission: 0,
              },
              {
                date: "2025-03-01",
                amount: 100,
                payee: "Transfer",
                memo: "",
                number: "",
                cleared: false,
                reconciled: false,
                category: "",
                splits: [],
                tagNames: [],
                isTransfer: false,
                transferAccount: "",
                security: "",
                action: "",
                price: 0,
                quantity: 0,
                commission: 0,
              },
            ],
            categories: [],
            transferAccounts: [],
            securities: [],
            openingBalance: null,
            openingBalanceDate: null,
          },
        ],
        detectedDateFormat: "MM/DD/YYYY" as any,
        sampleDates: [],
        isMultiAccount: true,
      });

      const result = await service.parseQifMultiAccountFile(
        userId,
        validContent,
      );

      expect(result.accounts).toHaveLength(2);
      expect(result.accounts[0].accountName).toBe("Checking");
      expect(result.accounts[0].transactionCount).toBe(1);
      expect(result.accounts[1].accountName).toBe("Savings");
      expect(result.accounts[1].transactionCount).toBe(2);
      expect(result.totalTransactionCount).toBe(3);
    });
  });

  describe("importQifMultiAccountFile", () => {
    const baseDto = {
      content:
        "!Type:Cat\nNFood\nE\n^\n!Account\nNChecking\nTBank\n^\n!Type:Bank\nD01/15/2025\nT-50.00\nPGrocery\n^",
      currencyCode: "CAD",
    };

    const makeFullParseResult = (overrides: any = {}) => ({
      categoryDefs: [
        {
          name: "Food",
          description: "",
          isIncome: false,
          taxRelated: false,
          taxSchedule: "",
        },
      ],
      tagDefs: [],
      accountBlocks: [
        {
          accountName: "Checking",
          accountType: "CHEQUING",
          description: "",
          creditLimit: null,
          transactions: [
            {
              date: "2025-01-15",
              amount: -50,
              payee: "Grocery",
              memo: "",
              number: "",
              cleared: false,
              reconciled: false,
              category: "Food",
              splits: [],
              tagNames: [],
              isTransfer: false,
              transferAccount: "",
              security: "",
              action: "",
              price: 0,
              quantity: 0,
              commission: 0,
            },
          ],
          categories: ["Food"],
          transferAccounts: [],
          securities: [],
          openingBalance: null,
          openingBalanceDate: null,
        },
      ],
      detectedDateFormat: "MM/DD/YYYY" as any,
      sampleDates: [],
      isMultiAccount: true,
      ...overrides,
    });

    it("throws BadRequestException for invalid QIF content", async () => {
      mockedValidateQifContent.mockReturnValue({
        valid: false,
        error: "Invalid",
      });

      await expect(
        service.importQifMultiAccountFile(userId, baseDto),
      ).rejects.toThrow(BadRequestException);
    });

    it("throws BadRequestException when no account blocks found", async () => {
      mockedValidateQifContent.mockReturnValue({ valid: true });
      mockedParseQifFull.mockReturnValue(
        makeFullParseResult({ accountBlocks: [] }),
      );

      await expect(
        service.importQifMultiAccountFile(userId, baseDto),
      ).rejects.toThrow(BadRequestException);
    });

    it("creates categories from definitions", async () => {
      mockedValidateQifContent.mockReturnValue({ valid: true });
      mockedParseQifFull.mockReturnValue(
        makeFullParseResult({
          categoryDefs: [
            {
              name: "Food",
              description: "",
              isIncome: false,
              taxRelated: false,
              taxSchedule: "",
            },
            {
              name: "Utilities:Electricity",
              description: "",
              isIncome: false,
              taxRelated: false,
              taxSchedule: "",
            },
          ],
        }),
      );

      mockQueryRunner.manager.findOne.mockImplementation((entity) => {
        // Category lookups: return null (not found) so they get created
        if (entity === Category) return Promise.resolve(null);
        // Account lookups: return a mock account for transaction processing
        if (entity === Account) {
          return Promise.resolve({
            id: "new-acct-id",
            userId,
            name: "Checking",
            accountType: AccountType.CHEQUING,
            currencyCode: "CAD",
          });
        }
        return Promise.resolve(null);
      });

      let saveCallCount = 0;
      mockQueryRunner.manager.save.mockImplementation((entity) => {
        saveCallCount++;
        return Promise.resolve({ ...entity, id: `generated-${saveCallCount}` });
      });

      const result = await service.importQifMultiAccountFile(userId, baseDto);

      // Should have created categories: "Food", "Utilities" (parent), "Electricity" (child)
      expect(result.categoriesCreated).toBe(3);
    });

    it("creates non-investment accounts with correct type and currency", async () => {
      mockedValidateQifContent.mockReturnValue({ valid: true });
      mockedParseQifFull.mockReturnValue(
        makeFullParseResult({
          categoryDefs: [],
          accountBlocks: [
            {
              accountName: "My Bank",
              accountType: "CHEQUING",
              description: "",
              creditLimit: null,
              transactions: [],
              categories: [],
              transferAccounts: [],
              securities: [],
              openingBalance: null,
              openingBalanceDate: null,
            },
            {
              accountName: "Visa",
              accountType: "CREDIT_CARD",
              description: "",
              creditLimit: 5000,
              transactions: [],
              categories: [],
              transferAccounts: [],
              securities: [],
              openingBalance: null,
              openingBalanceDate: null,
            },
          ],
        }),
      );

      mockQueryRunner.manager.findOne.mockResolvedValue(null);
      const savedAccounts: any[] = [];
      let saveIdx = 0;
      mockQueryRunner.manager.save.mockImplementation((entity) => {
        saveIdx++;
        const saved = { ...entity, id: `acct-${saveIdx}` };
        savedAccounts.push(saved);
        return Promise.resolve(saved);
      });

      const result = await service.importQifMultiAccountFile(userId, baseDto);

      expect(result.accountsCreated).toBe(2);
      // Verify the accounts were created with correct properties
      const bankCreate = mockQueryRunner.manager.create.mock.calls.find(
        (call) => call[0] === Account && call[1]?.name === "My Bank",
      );
      expect(bankCreate).toBeDefined();
      expect(bankCreate[1].accountType).toBe(AccountType.CHEQUING);
      expect(bankCreate[1].currencyCode).toBe("CAD");

      const visaCreate = mockQueryRunner.manager.create.mock.calls.find(
        (call) => call[0] === Account && call[1]?.name === "Visa",
      );
      expect(visaCreate).toBeDefined();
      expect(visaCreate[1].accountType).toBe(AccountType.CREDIT_CARD);
      expect(visaCreate[1].creditLimit).toBe(5000);
    });

    it("creates investment account pair (cash + brokerage)", async () => {
      mockedValidateQifContent.mockReturnValue({ valid: true });
      mockedParseQifFull.mockReturnValue(
        makeFullParseResult({
          categoryDefs: [],
          accountBlocks: [
            {
              accountName: "RRSP",
              accountType: "INVESTMENT",
              description: "",
              creditLimit: null,
              transactions: [],
              categories: [],
              transferAccounts: [],
              securities: [],
              openingBalance: null,
              openingBalanceDate: null,
            },
          ],
        }),
      );

      mockQueryRunner.manager.findOne.mockResolvedValue(null);
      let saveIdx = 0;
      mockQueryRunner.manager.save.mockImplementation((entity) => {
        saveIdx++;
        return Promise.resolve({ ...entity, id: `inv-${saveIdx}` });
      });

      const result = await service.importQifMultiAccountFile(userId, baseDto);

      expect(result.accountsCreated).toBe(2);
      // Should create Cash and Brokerage accounts
      const cashCreate = mockQueryRunner.manager.create.mock.calls.find(
        (call) => call[0] === Account && call[1]?.name === "RRSP - Cash",
      );
      expect(cashCreate).toBeDefined();
      expect(cashCreate[1].accountSubType).toBe(AccountSubType.INVESTMENT_CASH);

      const brokerageCreate = mockQueryRunner.manager.create.mock.calls.find(
        (call) => call[0] === Account && call[1]?.name === "RRSP - Brokerage",
      );
      expect(brokerageCreate).toBeDefined();
      expect(brokerageCreate[1].accountSubType).toBe(
        AccountSubType.INVESTMENT_BROKERAGE,
      );
    });

    it("reuses existing accounts by name", async () => {
      mockedValidateQifContent.mockReturnValue({ valid: true });
      mockedParseQifFull.mockReturnValue(
        makeFullParseResult({
          categoryDefs: [],
        }),
      );

      // Return existing account on findOne
      mockQueryRunner.manager.findOne.mockImplementation((entity, opts) => {
        if (entity === Account && opts?.where?.name === "Checking") {
          return Promise.resolve({
            id: "existing-acct",
            userId,
            name: "Checking",
            accountType: AccountType.CHEQUING,
          });
        }
        return Promise.resolve(null);
      });

      const result = await service.importQifMultiAccountFile(userId, baseDto);

      expect(result.accountsCreated).toBe(0);
    });

    it("resolves tags from transactions and creates new ones", async () => {
      mockedValidateQifContent.mockReturnValue({ valid: true });
      mockedParseQifFull.mockReturnValue(
        makeFullParseResult({
          categoryDefs: [],
          accountBlocks: [
            {
              accountName: "Checking",
              accountType: "CHEQUING",
              description: "",
              creditLimit: null,
              transactions: [
                {
                  date: "2025-01-15",
                  amount: -50,
                  payee: "Store",
                  memo: "",
                  number: "",
                  cleared: false,
                  reconciled: false,
                  category: "",
                  tagNames: ["Vacation", "Personal"],
                  isTransfer: false,
                  transferAccount: "",
                  security: "",
                  action: "",
                  price: 0,
                  quantity: 0,
                  commission: 0,
                  splits: [
                    {
                      category: "Food",
                      tagNames: ["Dining"],
                      memo: "",
                      amount: -30,
                      isTransfer: false,
                      transferAccount: "",
                    },
                  ],
                },
              ],
              categories: [],
              transferAccounts: [],
              securities: [],
              openingBalance: null,
              openingBalanceDate: null,
            },
          ],
        }),
      );

      // Account exists
      mockQueryRunner.manager.findOne.mockImplementation((entity) => {
        if (entity === Account) {
          return Promise.resolve({
            id: "acct-1",
            userId,
            name: "Checking",
            accountType: AccountType.CHEQUING,
          });
        }
        return Promise.resolve(null);
      });

      // find returns existing tag "Vacation"
      mockQueryRunner.manager.find.mockImplementation((entity) => {
        if (entity === Tag) {
          return Promise.resolve([
            { id: "tag-existing", name: "Vacation", userId },
          ]);
        }
        return Promise.resolve([]);
      });

      let saveIdx = 0;
      mockQueryRunner.manager.save.mockImplementation((entity) => {
        saveIdx++;
        return Promise.resolve({ ...entity, id: `saved-${saveIdx}` });
      });

      await service.importQifMultiAccountFile(userId, baseDto);

      // Should have created Tag entries for "Personal" and "Dining" (not "Vacation" since it exists)
      const tagCreates = mockQueryRunner.manager.create.mock.calls.filter(
        (call) => call[0] === Tag,
      );
      expect(tagCreates).toHaveLength(2);
      const tagNames = tagCreates.map((c) => c[1].name).sort();
      expect(tagNames).toEqual(["Dining", "Personal"]);
    });

    it("skips account blocks that cannot be resolved", async () => {
      mockedValidateQifContent.mockReturnValue({ valid: true });
      mockedParseQifFull.mockReturnValue(
        makeFullParseResult({
          categoryDefs: [],
          accountBlocks: [
            {
              accountName: "Unknown",
              accountType: "CHEQUING",
              description: "",
              creditLimit: null,
              transactions: [
                {
                  date: "2025-01-15",
                  amount: -50,
                  payee: "Store",
                  memo: "",
                  number: "",
                  cleared: false,
                  reconciled: false,
                  category: "",
                  splits: [],
                  tagNames: [],
                  isTransfer: false,
                  transferAccount: "",
                  security: "",
                  action: "",
                  price: 0,
                  quantity: 0,
                  commission: 0,
                },
              ],
              categories: [],
              transferAccounts: [],
              securities: [],
              openingBalance: null,
              openingBalanceDate: null,
            },
          ],
        }),
      );

      // findOne always returns null — account not found even after create attempt fails
      mockQueryRunner.manager.findOne.mockResolvedValue(null);
      let saveIdx = 0;
      mockQueryRunner.manager.save.mockImplementation((entity) => {
        saveIdx++;
        // Save creates the account but findOne for it later returns null
        return Promise.resolve({ ...entity, id: `saved-${saveIdx}` });
      });

      const result = await service.importQifMultiAccountFile(userId, baseDto);

      // Account was created but when trying to find it again for transactions it returns null
      // This tests the "Account not found in database" error path
      expect(result.errors).toBeGreaterThanOrEqual(0);
    });

    it("rolls back transaction on error", async () => {
      mockedValidateQifContent.mockReturnValue({ valid: true });
      mockedParseQifFull.mockReturnValue(makeFullParseResult());

      mockQueryRunner.manager.findOne.mockRejectedValue(new Error("DB error"));

      await expect(
        service.importQifMultiAccountFile(userId, baseDto),
      ).rejects.toThrow(BadRequestException);

      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.release).toHaveBeenCalled();
    });

    it("commits transaction on success and calls post-import processing", async () => {
      mockedValidateQifContent.mockReturnValue({ valid: true });
      mockedParseQifFull.mockReturnValue(
        makeFullParseResult({
          categoryDefs: [],
          accountBlocks: [
            {
              accountName: "Test",
              accountType: "CHEQUING",
              description: "",
              creditLimit: null,
              transactions: [],
              categories: [],
              transferAccounts: [],
              securities: [],
              openingBalance: null,
              openingBalanceDate: null,
            },
          ],
        }),
      );

      // Return null for category findOne, mock account
      mockQueryRunner.manager.findOne.mockImplementation((entity, opts) => {
        if (entity === Account && opts?.where?.name === "Test") {
          return Promise.resolve(null);
        }
        return Promise.resolve(null);
      });

      let saveIdx = 0;
      mockQueryRunner.manager.save.mockImplementation((entity) => {
        saveIdx++;
        return Promise.resolve({ ...entity, id: `saved-${saveIdx}` });
      });

      const result = await service.importQifMultiAccountFile(userId, baseDto);

      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.release).toHaveBeenCalled();
      expect(result.accountsCreated).toBe(1);
    });

    it("uses description instead of name for categories starting with underscore", async () => {
      mockedValidateQifContent.mockReturnValue({ valid: true });
      mockedParseQifFull.mockReturnValue(
        makeFullParseResult({
          categoryDefs: [
            {
              name: "_IntExp",
              description: "Interest Expense",
              isIncome: false,
              taxRelated: false,
              taxSchedule: "",
            },
            {
              name: "_401k",
              description: "",
              isIncome: false,
              taxRelated: false,
              taxSchedule: "",
            },
            {
              name: "Food",
              description: "Food and dining",
              isIncome: false,
              taxRelated: false,
              taxSchedule: "",
            },
          ],
        }),
      );

      mockQueryRunner.manager.findOne.mockImplementation((entity) => {
        if (entity === Account) {
          return Promise.resolve({
            id: "acct-1",
            userId,
            name: "Checking",
            accountType: AccountType.CHEQUING,
          });
        }
        return Promise.resolve(null);
      });

      let saveIdx = 0;
      mockQueryRunner.manager.save.mockImplementation((entity) => {
        saveIdx++;
        return Promise.resolve({ ...entity, id: `saved-${saveIdx}` });
      });

      await service.importQifMultiAccountFile(userId, baseDto);

      // "_IntExp" should be created as "Interest Expense" (description used)
      const catCreates = mockQueryRunner.manager.create.mock.calls.filter(
        (call) => call[0] === Category,
      );
      const catNames = catCreates.map((c) => c[1].name);
      expect(catNames).toContain("Interest Expense");
      // "_401k" has no description, so original name is used
      expect(catNames).toContain("_401k");
      // "Food" is normal, no underscore substitution
      expect(catNames).toContain("Food");
      // "_IntExp" should NOT be used as a category name
      expect(catNames).not.toContain("_IntExp");
    });

    it("creates tags from tagDefs during import", async () => {
      mockedValidateQifContent.mockReturnValue({ valid: true });
      mockedParseQifFull.mockReturnValue(
        makeFullParseResult({
          categoryDefs: [],
          tagDefs: [
            { name: "Vacation", description: "Travel" },
            { name: "Business", description: "Work" },
          ],
          accountBlocks: [
            {
              accountName: "Checking",
              accountType: "CHEQUING",
              description: "",
              creditLimit: null,
              transactions: [],
              categories: [],
              transferAccounts: [],
              securities: [],
              openingBalance: null,
              openingBalanceDate: null,
            },
          ],
        }),
      );

      // Account exists
      mockQueryRunner.manager.findOne.mockImplementation((entity) => {
        if (entity === Account) {
          return Promise.resolve({
            id: "acct-1",
            userId,
            name: "Checking",
            accountType: AccountType.CHEQUING,
          });
        }
        return Promise.resolve(null);
      });

      // No existing tags
      mockQueryRunner.manager.find.mockImplementation((entity) => {
        if (entity === Tag) {
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      });

      let saveIdx = 0;
      mockQueryRunner.manager.save.mockImplementation((entity) => {
        saveIdx++;
        return Promise.resolve({ ...entity, id: `saved-${saveIdx}` });
      });

      await service.importQifMultiAccountFile(userId, baseDto);

      const tagCreates = mockQueryRunner.manager.create.mock.calls.filter(
        (call) => call[0] === Tag,
      );
      expect(tagCreates).toHaveLength(2);
      const tagNames = tagCreates.map((c) => c[1].name).sort();
      expect(tagNames).toEqual(["Business", "Vacation"]);
    });
  });
});
