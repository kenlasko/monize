import { UserPreference } from "../users/entities/user-preference.entity";
import {
  createScopedDbMocks,
  DataSourceMock,
} from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

import {
  NotFoundException,
  BadRequestException,
  ConflictException,
} from "@nestjs/common";
import { InvestmentTransactionsService } from "./investment-transactions.service";
import { INVESTMENT_REPLAY_ORDER } from "./investment-replay.util";
import { UpdateInvestmentTransactionDto } from "./dto/update-investment-transaction.dto";
import {
  InvestmentTransaction,
  InvestmentAction,
} from "./entities/investment-transaction.entity";
import {
  Transaction,
  TransactionStatus,
} from "../transactions/entities/transaction.entity";
import { TransactionSplit } from "../transactions/entities/transaction-split.entity";
import { AccountSubType } from "../accounts/entities/account.entity";
import { isTransactionInFuture, todayYMD } from "../common/date-utils";

jest.mock("../common/date-utils", () => ({
  ...jest.requireActual("../common/date-utils"),
  isTransactionInFuture: jest.fn().mockReturnValue(false),
}));

const mockedIsTransactionInFuture =
  isTransactionInFuture as jest.MockedFunction<typeof isTransactionInFuture>;

describe("InvestmentTransactionsService", () => {
  let service: InvestmentTransactionsService;
  let investmentTransactionsRepository: Record<string, jest.Mock>;
  let transactionRepository: Record<string, jest.Mock>;
  let transactionSplitRepository: Record<string, jest.Mock>;
  let userPreferenceRepository: Record<string, jest.Mock>;
  let accountsService: Record<string, jest.Mock>;
  let portfolioCalculationService: Record<string, jest.Mock>;
  let transactionsService: Record<string, jest.Mock>;
  let holdingsService: Record<string, jest.Mock>;
  let securitiesService: Record<string, jest.Mock>;
  let securityPriceService: Record<string, jest.Mock>;
  let netWorthService: Record<string, jest.Mock>;
  let exchangeRateService: Record<string, jest.Mock>;
  let currenciesService: Record<string, jest.Mock>;
  let bondHoldingsService: Record<string, jest.Mock>;
  let dataSource: DataSourceMock;
  let mockQueryRunner: Record<string, any>;
  let mockActionHistoryService: Record<string, jest.Mock>;
  let findOneSpy: jest.SpyInstance;
  let lockedInvestmentRows: (id: string) => Promise<unknown[]>;

  const userId = "user-1";
  const accountId = "account-1";
  const securityId = "sec-1";
  const transactionId = "inv-tx-1";
  const cashTransactionId = "cash-tx-1";
  const cashAccountId = "cash-account-1";
  const fundingAccountId = "funding-account-1";

  const mockInvestmentAccount = {
    id: accountId,
    userId,
    accountType: "INVESTMENT",
    accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
    linkedAccountId: cashAccountId,
    currencyCode: "USD",
    name: "Brokerage Account",
  };

  const mockCashAccount = {
    id: cashAccountId,
    userId,
    accountType: "INVESTMENT",
    accountSubType: AccountSubType.INVESTMENT_CASH,
    linkedAccountId: null,
    currencyCode: "USD",
    name: "Cash Account",
  };

  const mockFundingAccount = {
    id: fundingAccountId,
    userId,
    accountType: "CHEQUING",
    accountSubType: null,
    linkedAccountId: null,
    currencyCode: "USD",
    name: "Checking Account",
  };

  const mockSecurity = {
    id: securityId,
    userId,
    symbol: "AAPL",
    name: "Apple Inc.",
    securityType: "STOCK",
    currencyCode: "USD",
  };

  const mockBuyTransaction: InvestmentTransaction = {
    id: transactionId,
    userId,
    accountId,
    securityId,
    fundingAccountId: null,
    transactionId: cashTransactionId,
    linkedTransactionId: null,
    action: InvestmentAction.BUY,
    status: TransactionStatus.CLEARED,
    transactionDate: "2025-01-15",
    quantity: 10,
    price: 150,
    commission: 9.99,
    totalAmount: 1509.99,
    exchangeRate: 1,
    description: "Buy AAPL",
    account: mockInvestmentAccount as any,
    transaction: null as any,
    security: mockSecurity as any,
    fundingAccount: null,
    transactionSplitId: null,
    transactionSplit: null,
    bondInstrumentId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockSellTransaction: InvestmentTransaction = {
    id: "inv-tx-2",
    userId,
    accountId,
    securityId,
    fundingAccountId: null,
    transactionId: "cash-tx-2",
    linkedTransactionId: null,
    action: InvestmentAction.SELL,
    status: TransactionStatus.CLEARED,
    transactionDate: "2025-02-15",
    quantity: 5,
    price: 160,
    commission: 9.99,
    totalAmount: 790.01,
    exchangeRate: 1,
    description: "Sell AAPL",
    account: mockInvestmentAccount as any,
    transaction: null as any,
    security: mockSecurity as any,
    fundingAccount: null,
    transactionSplitId: null,
    transactionSplit: null,
    bondInstrumentId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockDividendTransaction: InvestmentTransaction = {
    id: "inv-tx-3",
    userId,
    accountId,
    securityId,
    fundingAccountId: null,
    transactionId: "cash-tx-3",
    linkedTransactionId: null,
    action: InvestmentAction.DIVIDEND,
    status: TransactionStatus.CLEARED,
    transactionDate: "2025-03-15",
    quantity: 1,
    price: 25,
    commission: 0,
    totalAmount: 25,
    exchangeRate: 1,
    description: "AAPL Dividend",
    account: mockInvestmentAccount as any,
    transaction: null as any,
    security: mockSecurity as any,
    fundingAccount: null,
    transactionSplitId: null,
    transactionSplit: null,
    bondInstrumentId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  // Helper to build a mock query builder with fluent chaining
  const createMockQueryBuilder = (result: any = null, count: number = 0) => ({
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getOne: jest.fn().mockResolvedValue(result),
    getMany: jest
      .fn()
      .mockResolvedValue(
        Array.isArray(result) ? result : result ? [result] : [],
      ),
    getCount: jest.fn().mockResolvedValue(count),
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    distinct: jest.fn().mockReturnThis(),
    getRawMany: jest
      .fn()
      .mockResolvedValue(Array.isArray(result) ? result : []),
  });

  beforeEach(async () => {
    jest.useFakeTimers();
    mockedIsTransactionInFuture.mockReturnValue(false);

    investmentTransactionsRepository = {
      create: jest
        .fn()
        .mockImplementation((data) => ({ ...data, id: transactionId })),
      save: jest
        .fn()
        .mockImplementation((data) =>
          Promise.resolve({ ...data, id: data.id || transactionId }),
        ),
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      remove: jest.fn().mockResolvedValue(undefined),
      createQueryBuilder: jest.fn(),
    };

    transactionRepository = {
      create: jest
        .fn()
        .mockImplementation((data) => ({ ...data, id: cashTransactionId })),
      save: jest
        .fn()
        .mockImplementation((data) =>
          Promise.resolve({ ...data, id: data.id || cashTransactionId }),
        ),
      findOne: jest.fn(),
      remove: jest.fn().mockResolvedValue(undefined),
    };

    accountsService = {
      findOne: jest.fn(),
      findByIds: jest.fn().mockResolvedValue([]),
      updateBalance: jest.fn().mockResolvedValue(undefined),
      resetBrokerageBalances: jest.fn().mockResolvedValue(2),
      resolveByName: jest.fn(),
      resolveBrokerageByName: jest.fn(),
    };

    transactionsService = {};

    holdingsService = {
      rebuildScopesFromTransactions: jest.fn().mockResolvedValue(undefined),
      findByAccountAndSecurity: jest.fn().mockResolvedValue(null),
      // null: the ledger cannot say what the OUT leg released (the real method
      // returns number | null).
      releasedBasisPerShare: jest.fn().mockResolvedValue(null),
      removeAllForUser: jest.fn().mockResolvedValue(5),
      rebuildFromTransactions: jest.fn().mockResolvedValue({
        holdingsCreated: 0,
        holdingsUpdated: 0,
        holdingsDeleted: 0,
      }),
      rebuildAccountsFromTransactions: jest.fn().mockResolvedValue(undefined),
      validateNoNegativeHoldingsHistory: jest.fn().mockResolvedValue(undefined),
    };

    securitiesService = {
      recomputeBondPricesAfterWrite: jest.fn().mockResolvedValue(undefined),
      findOne: jest.fn().mockResolvedValue(mockSecurity),
      resolveBySymbolOrName: jest
        .fn()
        .mockResolvedValue({ match: mockSecurity, candidates: [] }),
    };

    securityPriceService = {
      upsertTransactionPrice: jest.fn().mockResolvedValue(undefined),
    };

    netWorthService = {
      recalculateAccount: jest.fn().mockResolvedValue(undefined),
      triggerDebouncedRecalc: jest.fn(),
    };

    exchangeRateService = {
      getLatestRate: jest.fn().mockResolvedValue(1),
      // Default to "no dated rate stored": a cross-currency posting then has no
      // rate unless a test opts into a dated one. `getLatestRate` is never part
      // of the posting path; it stays mocked so a test can assert it is unused.
      getRateForDate: jest.fn().mockResolvedValue(null),
    };

    currenciesService = {
      findOne: jest.fn().mockImplementation((code: string) =>
        Promise.resolve({
          code,
          name: code,
          symbol: "$",
          decimalPlaces: 2,
          isActive: true,
          createdByUserId: null,
          createdAt: new Date(),
        }),
      ),
    };

    // Was the QueryRunner every write block opened; now the scoped
    // transaction's EntityManager, kept under `.manager` so the existing
    // assertions read unchanged.
    mockQueryRunner = {
      manager: {
        create: jest.fn().mockImplementation((_Entity: any, data: any) => {
          if (_Entity === InvestmentTransaction)
            return investmentTransactionsRepository.create(data);
          if (_Entity === Transaction)
            return transactionRepository.create(data);
          return { ...data };
        }),
        save: jest.fn().mockImplementation((data: any) => {
          if ("securityId" in data && "action" in data)
            return investmentTransactionsRepository.save(data);
          return transactionRepository.save(data);
        }),
        update: jest
          .fn()
          .mockImplementation((_Entity: any, id: any, data: any) => {
            if (_Entity === InvestmentTransaction)
              return investmentTransactionsRepository.update(id, data);
            return Promise.resolve(undefined);
          }),
        findOne: jest.fn().mockImplementation((_Entity: any, opts: any) => {
          if (_Entity === Transaction)
            return transactionRepository.findOne(opts);
          return investmentTransactionsRepository.findOne(opts);
        }),
        find: jest.fn().mockResolvedValue([]),
        remove: jest.fn().mockImplementation((data: any) => {
          if ("securityId" in data && "action" in data)
            return investmentTransactionsRepository.remove(data);
          return transactionRepository.remove(data);
        }),
      },
    };

    mockActionHistoryService = {
      record: jest.fn().mockResolvedValue(null),
    };

    portfolioCalculationService = {
      calculateRealizedGains: jest.fn().mockResolvedValue([]),
      calculateCapitalGainsByMonth: jest.fn().mockResolvedValue([]),
    };

    // The embedded-row status pass reads the parent's splits; default "this
    // parent has none", which is what a non-investment split parent looks like.
    transactionSplitRepository = { find: jest.fn().mockResolvedValue([]) };
    userPreferenceRepository = {
      findOne: jest.fn().mockResolvedValue({ defaultCurrency: "CAD" }),
    };

    const mocks = createScopedDbMocks([
      [InvestmentTransaction, investmentTransactionsRepository],
      [Transaction, transactionRepository],
      [TransactionSplit, transactionSplitRepository],
      [UserPreference, userPreferenceRepository],
    ]);
    dataSource = mocks.dataSource;
    // Reuse the direct-manager behaviours the spec already defines.
    for (const [name, impl] of Object.entries(mockQueryRunner.manager)) {
      mocks.manager[name] = impl as jest.Mock;
    }
    /**
     * The cash-leg reads that feed a balance reversal are locked ones now, so
     * they arrive through `manager.query` rather than `findOne` -- the amount a
     * delta reverses has to be the version the delete removes (audit P4-003).
     *
     * Answered from whatever `transactionRepository.findOne` is returning, so a
     * spec states the row once. Column names are the raw SQL ones.
     */
    // Deletes are conditional and each reversal is gated on what the database
    // actually removed, so the double reports a count.
    mocks.manager.delete = jest.fn().mockResolvedValue({ affected: 1 });
    mocks.manager.query = jest
      .fn()
      .mockImplementation(async (sql: string, params?: unknown[]) => {
        if (!String(sql).includes("FOR UPDATE")) return [];
        if (String(sql).includes("FROM investment_transactions")) {
          return lockedInvestmentRows(String(params?.[0]));
        }
        const row = (await transactionRepository.findOne({})) as {
          id?: string;
          accountId?: string;
          amount?: number;
          transactionDate?: string;
          status?: string | null;
        } | null;
        if (!row?.id) return [];
        return [
          {
            id: row.id,
            account_id: row.accountId,
            amount: String(row.amount ?? 0),
            transaction_date: row.transactionDate ?? null,
            status: row.status ?? null,
            is_split: false,
            linked_transaction_id: null,
            parent_transaction_id: null,
          },
        ];
      });
    mockQueryRunner = { manager: mocks.manager };

    /**
     * `update()` and `remove()` row-lock the investment row they read and
     * refuse a row that changed since (A26-H04). Unless a spec says otherwise
     * the lock finds the row as the service last read it -- through `findOne`
     * or the repository -- so nothing changed in between.
     */
    lockedInvestmentRows = async (id: string) => {
      const reads = [
        ...findOneSpy.mock.results,
        ...investmentTransactionsRepository.findOne.mock.results,
      ].reverse();
      for (const read of reads) {
        let row: Partial<InvestmentTransaction> | null | undefined;
        try {
          row = await read.value;
        } catch {
          continue;
        }
        if (row?.id !== id) continue;
        return [
          {
            id: row.id,
            account_id: row.accountId,
            security_id: row.securityId ?? null,
            funding_account_id: row.fundingAccountId ?? null,
            transaction_id: row.transactionId ?? null,
            transaction_split_id: row.transactionSplitId ?? null,
            linked_transaction_id: row.linkedTransactionId ?? null,
            action: row.action,
            transaction_date: row.transactionDate,
            quantity: row.quantity ?? null,
            price: row.price ?? null,
            commission: row.commission ?? null,
            total_amount: row.totalAmount,
            exchange_rate: row.exchangeRate,
            status: row.status,
          },
        ];
      }
      return [];
    };

    // A bond redemption's split and the series an account holds; a spec that
    // exercises them sets the answers.
    bondHoldingsService = {
      seriesHoldings: jest.fn().mockResolvedValue({ holdings: [] }),
      redemptionSplit: jest.fn(),
    };

    service = new InvestmentTransactionsService(
      dataSource as never,
      accountsService as never,
      transactionsService as never,
      holdingsService as never,
      portfolioCalculationService as never,
      securitiesService as never,
      securityPriceService as never,
      netWorthService as never,
      mockActionHistoryService as never,
      exchangeRateService as never,
      currenciesService as never,
      bondHoldingsService as never,
    );
    findOneSpy = jest.spyOn(service, "findOne");
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("create", () => {
    const createBuyDto = {
      accountId,
      securityId,
      action: InvestmentAction.BUY,
      transactionDate: "2025-01-15",
      quantity: 10,
      price: 150,
      commission: 9.99,
      description: "Buy AAPL",
    };

    beforeEach(() => {
      // Default: account is an investment account
      accountsService.findOne.mockImplementation((uid: string, aid: string) => {
        if (aid === accountId) return Promise.resolve(mockInvestmentAccount);
        if (aid === cashAccountId) return Promise.resolve(mockCashAccount);
        if (aid === fundingAccountId)
          return Promise.resolve(mockFundingAccount);
        return Promise.reject(new NotFoundException("Account not found"));
      });

      // findOne after create returns the full transaction
      const findOneQB = createMockQueryBuilder(mockBuyTransaction);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        findOneQB,
      );
    });

    it("creates a BUY transaction with correct total amount", async () => {
      const result = await service.create(userId, createBuyDto);

      // totalAmount = (10 * 150) + 9.99 = 1509.99
      expect(investmentTransactionsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId,
          accountId,
          securityId,
          action: InvestmentAction.BUY,
          quantity: 10,
          price: 150,
          commission: 9.99,
          totalAmount: 1509.99,
        }),
      );
      expect(investmentTransactionsRepository.save).toHaveBeenCalled();
      expect(result).toEqual(mockBuyTransaction);
    });

    it("runs the caller's beforeWrite hook first in the write's transaction, before any row is created", async () => {
      const beforeWrite = jest.fn().mockResolvedValue(undefined);
      await service.create(userId, createBuyDto, { beforeWrite });
      expect(beforeWrite).toHaveBeenCalledTimes(1);
      expect(beforeWrite.mock.invocationCallOrder[0]).toBeLessThan(
        investmentTransactionsRepository.create.mock.invocationCallOrder[0],
      );
    });

    it("writes nothing when the beforeWrite hook refuses", async () => {
      const beforeWrite = jest
        .fn()
        .mockRejectedValue(new ConflictException("no longer open"));
      await expect(
        service.create(userId, createBuyDto, { beforeWrite }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(investmentTransactionsRepository.create).not.toHaveBeenCalled();
      expect(investmentTransactionsRepository.save).not.toHaveBeenCalled();
      expect(
        holdingsService.rebuildScopesFromTransactions,
      ).not.toHaveBeenCalled();
    });

    it("recomputes the bond-engine prices of its security after the commit (R7)", async () => {
      await service.create(userId, createBuyDto);
      expect(
        securitiesService.recomputeBondPricesAfterWrite,
      ).toHaveBeenCalledWith(userId, [securityId]);
      // After the write: the holdings were rebuilt first.
      expect(
        holdingsService.rebuildScopesFromTransactions.mock
          .invocationCallOrder[0],
      ).toBeLessThan(
        securitiesService.recomputeBondPricesAfterWrite.mock
          .invocationCallOrder[0],
      );
    });

    it("does not recompute for a VOID row, which recorded nothing", async () => {
      await service.create(userId, {
        ...createBuyDto,
        status: TransactionStatus.VOID,
      });
      expect(
        securitiesService.recomputeBondPricesAfterWrite,
      ).not.toHaveBeenCalled();
    });

    it("updates holdings for a BUY transaction at the commission-inclusive unit cost", async () => {
      await service.create(userId, createBuyDto);

      // The live holding must agree with what a rebuild would compute: a
      // rebuild folds commission into basis (10 * 150 + 9.99 = 1509.99, so
      // 150.999 per share), so blending the raw price in here would report the
      // commission as gain on the eventual disposal until something happened to
      // trigger a recompute (FR-008).
      expect(
        holdingsService.rebuildScopesFromTransactions,
      ).toHaveBeenCalledWith(
        userId,
        [{ accountId: accountId, securityId: securityId }],
        expect.anything(),
      );
    });

    it("creates a cash transaction for BUY (negative outflow)", async () => {
      await service.create(userId, createBuyDto);

      expect(transactionRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId,
          accountId: cashAccountId,
          amount: -1509.99,
          // The cash leg carries the investment row's own status; a DTO with
          // none defaults to UNRECONCILED, matching the regular register.
          status: TransactionStatus.UNRECONCILED,
        }),
      );
      expect(transactionRepository.save).toHaveBeenCalled();
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        cashAccountId,
        -1509.99,
      );
    });

    it("links the cash transaction ID back to the investment transaction", async () => {
      await service.create(userId, createBuyDto);

      expect(investmentTransactionsRepository.update).toHaveBeenCalledWith(
        transactionId,
        { transactionId: cashTransactionId },
      );
    });

    it("creates a SELL transaction with correct total amount", async () => {
      const sellDto = {
        accountId,
        securityId,
        action: InvestmentAction.SELL,
        transactionDate: "2025-02-15",
        quantity: 5,
        price: 160,
        commission: 9.99,
        description: "Sell AAPL",
      };

      const findOneQB = createMockQueryBuilder(mockSellTransaction);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        findOneQB,
      );

      await service.create(userId, sellDto);

      // totalAmount = (5 * 160) - 9.99 = 790.01
      expect(investmentTransactionsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          totalAmount: 790.01,
        }),
      );
    });

    it("removes holdings for a SELL transaction", async () => {
      const sellDto = {
        accountId,
        securityId,
        action: InvestmentAction.SELL,
        transactionDate: "2025-02-15",
        quantity: 5,
        price: 160,
        commission: 0,
      };

      const savedTx = {
        ...mockSellTransaction,
        quantity: 5,
        price: 160,
        commission: 0,
        totalAmount: 800,
      };
      investmentTransactionsRepository.save.mockResolvedValue(savedTx);

      const findOneQB = createMockQueryBuilder(mockSellTransaction);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        findOneQB,
      );

      await service.create(userId, sellDto);

      expect(
        holdingsService.rebuildScopesFromTransactions,
      ).toHaveBeenCalledWith(
        userId,
        [{ accountId: accountId, securityId: securityId }],
        expect.anything(),
      );
    });

    it("creates a positive cash transaction for SELL", async () => {
      const sellDto = {
        accountId,
        securityId,
        action: InvestmentAction.SELL,
        transactionDate: "2025-02-15",
        quantity: 5,
        price: 160,
        commission: 0,
      };

      const savedTx = {
        ...mockSellTransaction,
        quantity: 5,
        price: 160,
        commission: 0,
        totalAmount: 800,
      };
      investmentTransactionsRepository.save.mockResolvedValue(savedTx);

      const findOneQB = createMockQueryBuilder(mockSellTransaction);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        findOneQB,
      );

      await service.create(userId, sellDto);

      expect(transactionRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: 800,
        }),
      );
    });

    it("creates a DIVIDEND transaction with correct total amount", async () => {
      const divDto = {
        accountId,
        securityId,
        action: InvestmentAction.DIVIDEND,
        transactionDate: "2025-03-15",
        quantity: 1,
        price: 25,
      };

      const findOneQB = createMockQueryBuilder(mockDividendTransaction);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        findOneQB,
      );

      await service.create(userId, divDto);

      // DIVIDEND: total = (quantity || 1) * (price || 0) = 1 * 25 = 25
      expect(investmentTransactionsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          totalAmount: 25,
        }),
      );
    });

    it("creates a positive cash transaction for DIVIDEND", async () => {
      const divDto = {
        accountId,
        securityId,
        action: InvestmentAction.DIVIDEND,
        transactionDate: "2025-03-15",
        price: 25,
      };

      const savedTx = {
        ...mockDividendTransaction,
        quantity: 0,
        price: 25,
        totalAmount: 25,
      };
      investmentTransactionsRepository.save.mockResolvedValue(savedTx);

      const findOneQB = createMockQueryBuilder(mockDividendTransaction);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        findOneQB,
      );

      await service.create(userId, divDto);

      expect(transactionRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: 25,
        }),
      );
    });

    it("creates a positive cash transaction for RETURN_OF_CAPITAL (#1800)", async () => {
      const rocDto = {
        accountId,
        securityId,
        action: InvestmentAction.RETURN_OF_CAPITAL,
        transactionDate: "2025-03-15",
        totalAmount: 40,
      };

      const savedTx = {
        ...mockDividendTransaction,
        action: InvestmentAction.RETURN_OF_CAPITAL,
        quantity: 0,
        price: 40,
        totalAmount: 40,
      };
      investmentTransactionsRepository.save.mockResolvedValue(savedTx);

      const findOneQB = createMockQueryBuilder(savedTx);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        findOneQB,
      );

      await service.create(userId, rocDto);

      expect(investmentTransactionsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ totalAmount: 40 }),
      );
      expect(transactionRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 40 }),
      );
    });

    it("creates an INTEREST transaction with a positive cash transaction", async () => {
      const interestDto = {
        accountId,
        action: InvestmentAction.INTEREST,
        transactionDate: "2025-03-15",
        price: 12.5,
      };

      const savedTx = {
        id: transactionId,
        userId,
        accountId,
        securityId: null,
        fundingAccountId: null,
        transactionId: null,
        action: InvestmentAction.INTEREST,
        transactionDate: "2025-03-15",
        quantity: 0,
        price: 12.5,
        commission: 0,
        totalAmount: 12.5,
        description: undefined,
      };
      investmentTransactionsRepository.save.mockResolvedValue(savedTx);

      const findOneQB = createMockQueryBuilder(savedTx);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        findOneQB,
      );

      await service.create(userId, interestDto);

      expect(transactionRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: 12.5,
        }),
      );
    });

    it("creates a CAPITAL_GAIN transaction with a positive cash transaction", async () => {
      const cgDto = {
        accountId,
        securityId,
        action: InvestmentAction.CAPITAL_GAIN,
        transactionDate: "2025-03-15",
        price: 500,
      };

      const savedTx = {
        id: transactionId,
        userId,
        accountId,
        securityId,
        fundingAccountId: null,
        transactionId: null,
        action: InvestmentAction.CAPITAL_GAIN,
        transactionDate: "2025-03-15",
        quantity: 0,
        price: 500,
        commission: 0,
        totalAmount: 500,
      };
      investmentTransactionsRepository.save.mockResolvedValue(savedTx);

      const findOneQB = createMockQueryBuilder(savedTx);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        findOneQB,
      );

      await service.create(userId, cgDto);

      expect(transactionRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: 500,
        }),
      );
    });

    it("creates a REINVEST transaction with holdings update but no cash transaction", async () => {
      const reinvestDto = {
        accountId,
        securityId,
        action: InvestmentAction.REINVEST,
        transactionDate: "2025-03-15",
        quantity: 2,
        price: 150,
      };

      const savedTx = {
        id: transactionId,
        userId,
        accountId,
        securityId,
        fundingAccountId: null,
        transactionId: null,
        action: InvestmentAction.REINVEST,
        transactionDate: "2025-03-15",
        quantity: 2,
        price: 150,
        commission: 0,
        totalAmount: 0,
      };
      investmentTransactionsRepository.save.mockResolvedValue(savedTx);

      const findOneQB = createMockQueryBuilder(savedTx);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        findOneQB,
      );

      await service.create(userId, reinvestDto);

      expect(
        holdingsService.rebuildScopesFromTransactions,
      ).toHaveBeenCalledWith(
        userId,
        [{ accountId: accountId, securityId: securityId }],
        expect.anything(),
      );
      // No cash transaction for REINVEST
      expect(transactionRepository.create).not.toHaveBeenCalled();
      expect(investmentTransactionsRepository.update).not.toHaveBeenCalled();
    });

    it("creates a TRANSFER_IN transaction that adds shares without cash impact", async () => {
      const transferInDto = {
        accountId,
        securityId,
        action: InvestmentAction.TRANSFER_IN,
        transactionDate: "2025-03-15",
        quantity: 20,
        price: 100,
      };

      const savedTx = {
        id: transactionId,
        userId,
        accountId,
        securityId,
        fundingAccountId: null,
        transactionId: null,
        action: InvestmentAction.TRANSFER_IN,
        transactionDate: "2025-03-15",
        quantity: 20,
        price: 100,
        commission: 0,
        totalAmount: 0,
      };
      investmentTransactionsRepository.save.mockResolvedValue(savedTx);

      const findOneQB = createMockQueryBuilder(savedTx);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        findOneQB,
      );

      await service.create(userId, transferInDto);

      expect(
        holdingsService.rebuildScopesFromTransactions,
      ).toHaveBeenCalledWith(
        userId,
        [{ accountId: accountId, securityId: securityId }],
        expect.anything(),
      );
      expect(transactionRepository.create).not.toHaveBeenCalled();
    });

    it("creates a TRANSFER_OUT transaction that removes shares without cash impact", async () => {
      const transferOutDto = {
        accountId,
        securityId,
        action: InvestmentAction.TRANSFER_OUT,
        transactionDate: "2025-03-15",
        quantity: 10,
        price: 100,
      };

      const savedTx = {
        id: transactionId,
        userId,
        accountId,
        securityId,
        fundingAccountId: null,
        transactionId: null,
        action: InvestmentAction.TRANSFER_OUT,
        transactionDate: "2025-03-15",
        quantity: 10,
        price: 100,
        commission: 0,
        totalAmount: 0,
      };
      investmentTransactionsRepository.save.mockResolvedValue(savedTx);

      const findOneQB = createMockQueryBuilder(savedTx);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        findOneQB,
      );

      await service.create(userId, transferOutDto);

      expect(
        holdingsService.rebuildScopesFromTransactions,
      ).toHaveBeenCalledWith(
        userId,
        [{ accountId: accountId, securityId: securityId }],
        expect.anything(),
      );
      expect(transactionRepository.create).not.toHaveBeenCalled();
    });

    it("creates an ADD_SHARES transaction that adds to the position", async () => {
      const addSharesDto = {
        accountId,
        securityId,
        action: InvestmentAction.ADD_SHARES,
        transactionDate: "2025-03-15",
        quantity: 5,
      };

      const savedTx = {
        id: transactionId,
        userId,
        accountId,
        securityId,
        fundingAccountId: null,
        transactionId: null,
        action: InvestmentAction.ADD_SHARES,
        transactionDate: "2025-03-15",
        quantity: 5,
        price: 0,
        commission: 0,
        totalAmount: 0,
      };
      investmentTransactionsRepository.save.mockResolvedValue(savedTx);

      const findOneQB = createMockQueryBuilder(savedTx);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        findOneQB,
      );

      await service.create(userId, addSharesDto);

      expect(
        holdingsService.rebuildScopesFromTransactions,
      ).toHaveBeenCalledWith(
        userId,
        [{ accountId: accountId, securityId: securityId }],
        expect.anything(),
      );
      expect(transactionRepository.create).not.toHaveBeenCalled();
    });

    it("creates a REMOVE_SHARES transaction that reduces the position", async () => {
      const removeSharesDto = {
        accountId,
        securityId,
        action: InvestmentAction.REMOVE_SHARES,
        transactionDate: "2025-03-15",
        quantity: 3,
      };

      const savedTx = {
        id: transactionId,
        userId,
        accountId,
        securityId,
        fundingAccountId: null,
        transactionId: null,
        action: InvestmentAction.REMOVE_SHARES,
        transactionDate: "2025-03-15",
        quantity: 3,
        price: 0,
        commission: 0,
        totalAmount: 0,
      };
      investmentTransactionsRepository.save.mockResolvedValue(savedTx);

      const findOneQB = createMockQueryBuilder(savedTx);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        findOneQB,
      );

      await service.create(userId, removeSharesDto);

      expect(
        holdingsService.rebuildScopesFromTransactions,
      ).toHaveBeenCalledWith(
        userId,
        [{ accountId: accountId, securityId: securityId }],
        expect.anything(),
      );
    });

    it("uses fundingAccountId when provided instead of linked cash account", async () => {
      const buyWithFundingDto = {
        ...createBuyDto,
        fundingAccountId,
      };

      const savedTx = {
        ...mockBuyTransaction,
        fundingAccountId,
      };
      investmentTransactionsRepository.save.mockResolvedValue(savedTx);

      await service.create(userId, buyWithFundingDto);

      // The cash transaction should use the funding account, not the linked cash account
      expect(transactionRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: fundingAccountId,
        }),
      );
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        fundingAccountId,
        expect.any(Number),
      );
    });

    it("throws BadRequestException when account is not INVESTMENT type", async () => {
      accountsService.findOne.mockResolvedValue({
        ...mockInvestmentAccount,
        accountType: "CHEQUING",
      });

      await expect(service.create(userId, createBuyDto)).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.create(userId, createBuyDto)).rejects.toThrow(
        "Account must be of type INVESTMENT",
      );
    });

    it("throws BadRequestException when BUY has no securityId", async () => {
      const noSecDto = {
        accountId,
        action: InvestmentAction.BUY,
        transactionDate: "2025-01-15",
        quantity: 10,
        price: 150,
      };

      await expect(service.create(userId, noSecDto)).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.create(userId, noSecDto)).rejects.toThrow(
        "Security ID is required for BUY transactions",
      );
    });

    it("throws BadRequestException when SELL has no securityId", async () => {
      const noSecDto = {
        accountId,
        action: InvestmentAction.SELL,
        transactionDate: "2025-01-15",
        quantity: 5,
        price: 160,
      };

      await expect(service.create(userId, noSecDto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("throws BadRequestException when SPLIT has no securityId", async () => {
      const noSecDto = {
        accountId,
        action: InvestmentAction.SPLIT,
        transactionDate: "2025-01-15",
        quantity: 2,
      };

      await expect(service.create(userId, noSecDto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("throws BadRequestException when SPLIT has no quantity", async () => {
      accountsService.findOne.mockResolvedValue(mockInvestmentAccount);
      const dto = {
        accountId,
        action: InvestmentAction.SPLIT,
        securityId,
        transactionDate: "2025-01-15",
      };

      await expect(service.create(userId, dto)).rejects.toThrow(
        "Split ratio (quantity) must be greater than zero",
      );
    });

    it("throws BadRequestException when SPLIT quantity is zero", async () => {
      accountsService.findOne.mockResolvedValue(mockInvestmentAccount);
      const dto = {
        accountId,
        action: InvestmentAction.SPLIT,
        securityId,
        transactionDate: "2025-01-15",
        quantity: 0,
      };

      await expect(service.create(userId, dto)).rejects.toThrow(
        "Split ratio (quantity) must be greater than zero",
      );
    });

    it("re-derives the position from the ledger for a SPLIT", async () => {
      accountsService.findOne.mockResolvedValue(mockInvestmentAccount);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder({ ...mockBuyTransaction, action: "SPLIT" }),
      );
      const dto = {
        accountId,
        action: InvestmentAction.SPLIT,
        securityId,
        transactionDate: "2025-01-15",
        quantity: 2,
      };

      await service.create(userId, dto);

      expect(
        holdingsService.rebuildScopesFromTransactions,
      ).toHaveBeenCalledWith(
        userId,
        [{ accountId: accountId, securityId: securityId }],
        expect.anything(),
      );
      // SPLIT must not write a cash transaction.
    });

    it("rebuilds holdings from history after creating a SPLIT", async () => {
      accountsService.findOne.mockResolvedValue(mockInvestmentAccount);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder({ ...mockBuyTransaction, action: "SPLIT" }),
      );
      await service.create(userId, {
        accountId,
        action: InvestmentAction.SPLIT,
        securityId,
        transactionDate: "2025-01-15",
        quantity: 2,
      });
      expect(holdingsService.rebuildFromTransactions).toHaveBeenCalledWith(
        userId,
      );
    });

    it("does NOT trigger a holdings rebuild for non-SPLIT creates", async () => {
      accountsService.findOne.mockResolvedValue(mockInvestmentAccount);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder(mockBuyTransaction),
      );
      await service.create(userId, {
        accountId,
        action: InvestmentAction.BUY,
        securityId,
        transactionDate: "2025-01-15",
        quantity: 10,
        price: 150,
      });
      expect(holdingsService.rebuildFromTransactions).not.toHaveBeenCalled();
    });

    it("supports reverse splits (ratio < 1) for SPLIT", async () => {
      accountsService.findOne.mockResolvedValue(mockInvestmentAccount);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder({ ...mockBuyTransaction, action: "SPLIT" }),
      );
      const dto = {
        accountId,
        action: InvestmentAction.SPLIT,
        securityId,
        transactionDate: "2025-01-15",
        quantity: 0.5,
      };

      await service.create(userId, dto);

      expect(
        holdingsService.rebuildScopesFromTransactions,
      ).toHaveBeenCalledWith(
        userId,
        [{ accountId: accountId, securityId: securityId }],
        expect.anything(),
      );
    });

    it("throws BadRequestException when REINVEST has no securityId", async () => {
      const noSecDto = {
        accountId,
        action: InvestmentAction.REINVEST,
        transactionDate: "2025-01-15",
        quantity: 2,
        price: 150,
      };

      await expect(service.create(userId, noSecDto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("throws BadRequestException when ADD_SHARES has no securityId", async () => {
      const noSecDto = {
        accountId,
        action: InvestmentAction.ADD_SHARES,
        transactionDate: "2025-01-15",
        quantity: 5,
      };

      await expect(service.create(userId, noSecDto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("throws BadRequestException when REMOVE_SHARES has no securityId", async () => {
      const noSecDto = {
        accountId,
        action: InvestmentAction.REMOVE_SHARES,
        transactionDate: "2025-01-15",
        quantity: 3,
      };

      await expect(service.create(userId, noSecDto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("requires a securityId for RETURN_OF_CAPITAL: it reduces one security's basis", async () => {
      const noSecDto = {
        accountId,
        action: InvestmentAction.RETURN_OF_CAPITAL,
        transactionDate: "2025-03-15",
        totalAmount: 40,
      };

      await expect(service.create(userId, noSecDto)).rejects.toThrow(
        "Security ID is required for RETURN_OF_CAPITAL transactions",
      );
    });

    it("does not require securityId for DIVIDEND transactions", async () => {
      const divDto = {
        accountId,
        action: InvestmentAction.DIVIDEND,
        transactionDate: "2025-03-15",
        price: 25,
      };

      const savedTx = {
        id: transactionId,
        userId,
        accountId,
        securityId: null,
        fundingAccountId: null,
        transactionId: null,
        action: InvestmentAction.DIVIDEND,
        transactionDate: "2025-03-15",
        quantity: 0,
        price: 25,
        commission: 0,
        totalAmount: 25,
      };
      investmentTransactionsRepository.save.mockResolvedValue(savedTx);

      const findOneQB = createMockQueryBuilder(savedTx);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        findOneQB,
      );

      // Should not throw
      await expect(service.create(userId, divDto)).resolves.toBeDefined();
    });

    it("does not require securityId for INTEREST transactions", async () => {
      const interestDto = {
        accountId,
        action: InvestmentAction.INTEREST,
        transactionDate: "2025-03-15",
        price: 10,
      };

      const savedTx = {
        id: transactionId,
        userId,
        accountId,
        securityId: null,
        fundingAccountId: null,
        transactionId: null,
        action: InvestmentAction.INTEREST,
        transactionDate: "2025-03-15",
        quantity: 0,
        price: 10,
        commission: 0,
        totalAmount: 10,
      };
      investmentTransactionsRepository.save.mockResolvedValue(savedTx);

      const findOneQB = createMockQueryBuilder(savedTx);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        findOneQB,
      );

      await expect(service.create(userId, interestDto)).resolves.toBeDefined();
    });

    it("verifies security ownership when securityId is provided", async () => {
      await service.create(userId, createBuyDto);

      expect(securitiesService.findOne).toHaveBeenCalledWith(
        userId,
        securityId,
      );
    });

    it("triggers net worth recalculation for brokerage and cash accounts after create", async () => {
      await service.create(userId, createBuyDto);

      expect(netWorthService.triggerDebouncedRecalc).toHaveBeenCalledWith(
        accountId,
        userId,
      );
      expect(netWorthService.triggerDebouncedRecalc).toHaveBeenCalledWith(
        cashAccountId,
        userId,
      );
    });

    it("triggers net worth recalculation for funding account when specified", async () => {
      const dtoWithFunding = {
        ...createBuyDto,
        fundingAccountId,
      };
      await service.create(userId, dtoWithFunding);

      expect(netWorthService.triggerDebouncedRecalc).toHaveBeenCalledWith(
        accountId,
        userId,
      );
      expect(netWorthService.triggerDebouncedRecalc).toHaveBeenCalledWith(
        fundingAccountId,
        userId,
      );
    });

    it("uses standalone account as cash account when no linked account", async () => {
      const standaloneAccount = {
        ...mockInvestmentAccount,
        accountSubType: null,
        linkedAccountId: null,
      };

      accountsService.findOne.mockImplementation((uid: string, aid: string) => {
        if (aid === accountId) return Promise.resolve(standaloneAccount);
        return Promise.reject(new NotFoundException("Account not found"));
      });

      await service.create(userId, createBuyDto);

      // Cash transaction should be on the same account
      expect(transactionRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId,
        }),
      );
    });

    it("records action history on create", async () => {
      await service.create(userId, createBuyDto);

      expect(mockActionHistoryService.record).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          entityType: "investment_transaction",
          action: "create",
          description: expect.stringContaining("BUY"),
        }),
      );
    });

    it("captures linkedCashTransaction in afterData for action history on create", async () => {
      const mockCashTx = {
        id: cashTransactionId,
        userId,
        accountId: cashAccountId,
        transactionDate: "2025-01-15",
        amount: -1509.99,
        currencyCode: "USD",
      };
      transactionRepository.findOne.mockResolvedValue(mockCashTx);

      await service.create(userId, createBuyDto);

      expect(transactionRepository.findOne).toHaveBeenCalledWith({
        where: { id: cashTransactionId, userId },
      });
      expect(mockActionHistoryService.record).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          afterData: expect.objectContaining({
            linkedCashTransaction: expect.objectContaining({
              id: cashTransactionId,
              accountId: cashAccountId,
              amount: -1509.99,
            }),
          }),
        }),
      );
    });

    it("records afterData without linkedCashTransaction when no cash tx exists", async () => {
      // REINVEST does not create a cash transaction
      const reinvestDto = {
        accountId,
        securityId,
        action: InvestmentAction.REINVEST,
        transactionDate: "2025-01-15",
        quantity: 3,
        price: 150,
        description: "Reinvest",
      };
      const mockReinvestResult = {
        ...mockBuyTransaction,
        action: InvestmentAction.REINVEST,
        transactionId: null,
      };
      const findOneQB = createMockQueryBuilder(mockReinvestResult);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        findOneQB,
      );

      await service.create(userId, reinvestDto);

      expect(mockActionHistoryService.record).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          afterData: expect.not.objectContaining({
            linkedCashTransaction: expect.anything(),
          }),
        }),
      );
    });
  });

  describe("getRegisterFilterOptions", () => {
    /** The distinct (action, symbol) pairs the register's rows hold. */
    const optionsFor = (
      rows: Array<{ action: InvestmentAction; symbol?: string | null }>,
    ) => {
      const qb = createMockQueryBuilder(
        rows.map((r) => ({ action: r.action, symbol: r.symbol ?? null })),
      );
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(qb);
      return qb;
    };

    it("returns only the actions the rows use", async () => {
      optionsFor([
        { action: InvestmentAction.SELL, symbol: "XEQT" },
        { action: InvestmentAction.BUY, symbol: "VTI" },
      ]);

      const result = await service.getRegisterFilterOptions(userId);

      expect(result.actions).toEqual([
        InvestmentAction.BUY,
        InvestmentAction.SELL,
      ]);
    });

    it("orders them by the vocabulary, not by what was traded first", async () => {
      // The picker's order is a property of the action list; deriving it from
      // the rows would reshuffle the control as the ledger grows.
      optionsFor([
        { action: InvestmentAction.SELL, symbol: "XEQT" },
        { action: InvestmentAction.BUY, symbol: "VTI" },
      ]);

      const result = await service.getRegisterFilterOptions(userId);
      const vocabulary = Object.values(InvestmentAction);

      expect(result.actions).toEqual(
        vocabulary.filter((a) =>
          [InvestmentAction.BUY, InvestmentAction.SELL].includes(a),
        ),
      );
    });

    it("offers the symbols the rows use, sold-out positions included", async () => {
      // The picker used to be built from current holdings, so a position sold
      // in full was not offered -- and its trades are exactly what somebody
      // filtering by symbol is looking for.
      optionsFor([
        { action: InvestmentAction.SELL, symbol: "XEQT" },
        { action: InvestmentAction.BUY, symbol: "VTI" },
      ]);

      const result = await service.getRegisterFilterOptions(userId);

      expect(result.symbols).toEqual(["VTI", "XEQT"]);
    });

    it("offers no blank symbol for a row that has no security", async () => {
      // An interest posting against the cash ledger carries none, and a blank
      // option is not a symbol to filter by.
      optionsFor([
        { action: InvestmentAction.INTEREST, symbol: null },
        { action: InvestmentAction.BUY, symbol: "VTI" },
      ]);

      const result = await service.getRegisterFilterOptions(userId);

      expect(result.symbols).toEqual(["VTI"]);
    });

    it("offers nothing for an account with no trades", async () => {
      // Known and empty: this account has done nothing, and the picker says so.
      optionsFor([]);

      const result = await service.getRegisterFilterOptions(userId, [
        accountId,
      ]);

      expect(result.actions).toEqual([]);
    });

    it("reads the whole pair, as the register itself does", async () => {
      // A register scoped to the brokerage half alone answers with part of what
      // the user is looking at, so the picker must not be narrower either.
      accountsService.findByIds.mockResolvedValue([
        { id: accountId, linkedAccountId: "cash-account-id" },
      ]);
      const qb = optionsFor([{ action: InvestmentAction.BUY, symbol: "VTI" }]);

      await service.getRegisterFilterOptions(userId, [accountId]);

      expect(qb.andWhere).toHaveBeenCalledWith("it.accountId IN (:...allIds)", {
        allIds: [accountId, "cash-account-id"],
      });
    });

    it("asks about every account when none is named", async () => {
      const qb = optionsFor([{ action: InvestmentAction.BUY, symbol: "VTI" }]);

      await service.getRegisterFilterOptions(userId);

      expect(qb.andWhere).not.toHaveBeenCalled();
    });
  });

  describe("findAll", () => {
    const mockTransactions = [mockBuyTransaction, mockSellTransaction];

    beforeEach(() => {
      accountsService.findOne.mockImplementation((uid: string, aid: string) => {
        if (aid === accountId) return Promise.resolve(mockInvestmentAccount);
        return Promise.resolve({
          ...mockInvestmentAccount,
          id: aid,
          linkedAccountId: null,
        });
      });
      accountsService.findByIds.mockImplementation(
        (uid: string, ids: string[]) => {
          return Promise.resolve(
            ids.map((aid) => {
              if (aid === accountId) return mockInvestmentAccount;
              return {
                ...mockInvestmentAccount,
                id: aid,
                linkedAccountId: null,
              };
            }),
          );
        },
      );
    });

    it("returns paginated transactions for a user", async () => {
      const mockQB = createMockQueryBuilder(mockTransactions, 2);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        mockQB,
      );

      const result = await service.findAll(userId);

      expect(result.data).toEqual(mockTransactions);
      expect(result.pagination).toEqual({
        page: 1,
        limit: 50,
        total: 2,
        totalPages: 1,
        hasMore: false,
      });
    });

    it("keeps a redemption's interest companion out of the register", async () => {
      // The companion is not its own event: the redemption row already shows
      // the interest, and its single cash row already carries it. Excluded
      // before the count as well as the page, so a pair cannot straddle two
      // pages and appear once.
      const mockQB = createMockQueryBuilder(mockTransactions, 2);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        mockQB,
      );

      await service.findAll(userId);

      const exclusion = mockQB.andWhere.mock.calls.find(
        ([sql]: [string]) =>
          typeof sql === "string" && sql.includes("linked_transaction_id"),
      );
      expect(exclusion?.[1]).toEqual({
        companionAction: InvestmentAction.INTEREST,
        redeemAction: InvestmentAction.REDEEM,
      });
    });

    it("applies accountIds filter including linked accounts", async () => {
      const mockQB = createMockQueryBuilder(mockTransactions, 2);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        mockQB,
      );

      await service.findAll(userId, [accountId]);

      // Should batch-resolve linked accounts via findByIds
      expect(accountsService.findByIds).toHaveBeenCalledWith(userId, [
        accountId,
      ]);
      // andWhere should be called with the expanded account IDs
      expect(mockQB.andWhere).toHaveBeenCalledWith(
        "it.accountId IN (:...allIds)",
        expect.objectContaining({
          allIds: expect.arrayContaining([accountId, cashAccountId]),
        }),
      );
    });

    it("applies date range filters", async () => {
      const mockQB = createMockQueryBuilder([], 0);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        mockQB,
      );

      await service.findAll(userId, undefined, "2025-01-01", "2025-12-31");

      expect(mockQB.andWhere).toHaveBeenCalledWith(
        "it.transactionDate >= :startDate",
        { startDate: "2025-01-01" },
      );
      expect(mockQB.andWhere).toHaveBeenCalledWith(
        "it.transactionDate <= :endDate",
        { endDate: "2025-12-31" },
      );
    });

    it("applies symbol filter", async () => {
      const mockQB = createMockQueryBuilder([], 0);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        mockQB,
      );

      await service.findAll(
        userId,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "AAPL",
      );

      expect(mockQB.andWhere).toHaveBeenCalledWith(
        "LOWER(security.symbol) = LOWER(:symbol)",
        { symbol: "AAPL" },
      );
    });

    it("applies action filter", async () => {
      const mockQB = createMockQueryBuilder([], 0);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        mockQB,
      );

      await service.findAll(
        userId,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "BUY",
      );

      expect(mockQB.andWhere).toHaveBeenCalledWith("it.action = :action", {
        action: "BUY",
      });
    });

    it("uses custom page and limit values", async () => {
      const mockQB = createMockQueryBuilder([], 100);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        mockQB,
      );

      const result = await service.findAll(
        userId,
        undefined,
        undefined,
        undefined,
        3,
        25,
      );

      expect(mockQB.skip).toHaveBeenCalledWith(50); // (3 - 1) * 25
      expect(mockQB.take).toHaveBeenCalledWith(25);
      expect(result.pagination.page).toBe(3);
      expect(result.pagination.limit).toBe(25);
    });

    it("defaults to page 1 and limit 50 when not provided", async () => {
      const mockQB = createMockQueryBuilder([], 0);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        mockQB,
      );

      const result = await service.findAll(userId);

      expect(mockQB.skip).toHaveBeenCalledWith(0);
      expect(mockQB.take).toHaveBeenCalledWith(50);
      expect(result.pagination.page).toBe(1);
      expect(result.pagination.limit).toBe(50);
    });

    it("caps limit at 200", async () => {
      const mockQB = createMockQueryBuilder([], 0);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        mockQB,
      );

      const result = await service.findAll(
        userId,
        undefined,
        undefined,
        undefined,
        1,
        500,
      );

      expect(mockQB.take).toHaveBeenCalledWith(200);
      expect(result.pagination.limit).toBe(200);
    });

    it("calculates hasMore correctly when there are more pages", async () => {
      const mockQB = createMockQueryBuilder([mockBuyTransaction], 100);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        mockQB,
      );

      const result = await service.findAll(
        userId,
        undefined,
        undefined,
        undefined,
        1,
        10,
      );

      expect(result.pagination.hasMore).toBe(true);
      expect(result.pagination.totalPages).toBe(10);
    });

    it("handles account not found gracefully when resolving linked accounts", async () => {
      accountsService.findByIds.mockResolvedValue([]);

      const mockQB = createMockQueryBuilder([], 0);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        mockQB,
      );

      // Should not throw even if account not found during linked account resolution
      const result = await service.findAll(userId, ["nonexistent-id"]);

      expect(result.data).toEqual([]);
    });

    it("orders transactions by date descending, breaking ties by creation order", async () => {
      const mockQB = createMockQueryBuilder([], 0);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        mockQB,
      );

      await service.findAll(userId);

      expect(mockQB.orderBy).toHaveBeenCalledWith("it.transactionDate", "DESC");
      expect(mockQB.addOrderBy).toHaveBeenCalledWith("it.createdAt", "DESC");
    });
  });

  describe("findOne", () => {
    it("returns a transaction when found", async () => {
      const mockQB = createMockQueryBuilder(mockBuyTransaction);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        mockQB,
      );

      const result = await service.findOne(userId, transactionId);

      expect(result).toEqual(mockBuyTransaction);
      expect(mockQB.where).toHaveBeenCalledWith("it.id = :id", {
        id: transactionId,
      });
      expect(mockQB.andWhere).toHaveBeenCalledWith("it.userId = :userId", {
        userId,
      });
    });

    it("throws NotFoundException when transaction is not found", async () => {
      const mockQB = createMockQueryBuilder(null);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        mockQB,
      );

      await expect(service.findOne(userId, "nonexistent")).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.findOne(userId, "nonexistent")).rejects.toThrow(
        "Investment transaction with ID nonexistent not found",
      );
    });

    it("joins account, security, and fundingAccount relations", async () => {
      const mockQB = createMockQueryBuilder(mockBuyTransaction);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        mockQB,
      );

      await service.findOne(userId, transactionId);

      expect(mockQB.leftJoinAndSelect).toHaveBeenCalledWith(
        "it.account",
        "account",
      );
      expect(mockQB.leftJoinAndSelect).toHaveBeenCalledWith(
        "it.security",
        "security",
      );
      expect(mockQB.leftJoinAndSelect).toHaveBeenCalledWith(
        "it.fundingAccount",
        "fundingAccount",
      );
    });
  });

  describe("update", () => {
    beforeEach(() => {
      accountsService.findOne.mockImplementation((uid: string, aid: string) => {
        if (aid === accountId) return Promise.resolve(mockInvestmentAccount);
        if (aid === cashAccountId) return Promise.resolve(mockCashAccount);
        if (aid === fundingAccountId)
          return Promise.resolve(mockFundingAccount);
        return Promise.reject(new NotFoundException("Account not found"));
      });

      // First call: findOne for existing transaction
      // Subsequent calls: findOne after save
      const existingTx = { ...mockBuyTransaction };
      const findOneQB = createMockQueryBuilder(existingTx);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        findOneQB,
      );
    });

    /**
     * Invariant: an acquisition states what it cost -- on every path that can
     * write one, not only on `create`.
     * Canonical adversarial input: a rejected command reintroduced through a
     * second entry point (testing contract, ownership / money precision).
     * Minimal mutation: delete the `assertAcquisitionPriced` call in
     * `update`.
     * Test that fails under it: the first two below -- a purchase is edited
     * into a free one and its gain and tax are reported as known.
     */
    it("refuses to price an existing BUY at zero", async () => {
      await expect(
        service.update(userId, transactionId, { price: 0 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("refuses to turn an unpriced action into a BUY with no price", async () => {
      const unpriced = {
        ...mockBuyTransaction,
        action: InvestmentAction.ADD_SHARES,
        price: null,
      };
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder(unpriced),
      );

      await expect(
        service.update(userId, transactionId, {
          action: InvestmentAction.BUY,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("still allows an unrelated edit on a row that has no price", async () => {
      // Rows written before the rule existed must stay correctable. Refusing
      // every edit would strand them with no way to fix anything at all, and
      // a change of description is not the write that made one wrong.
      const unpriced = {
        ...mockBuyTransaction,
        action: InvestmentAction.ADD_SHARES,
        price: null,
      };
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder(unpriced),
      );

      await expect(
        service.update(userId, transactionId, { description: "renamed" }),
      ).resolves.toBeDefined();
    });

    /**
     * Invariant: the carve-out for rows that predate the rule keys on what the
     * edit *changes*, not on which fields the request carried.
     * Canonical adversarial input: the payload the real client sends, rather
     * than the minimal one a unit test would hand-write (testing contract --
     * "fixtures are claims about production data").
     * Minimal mutation: key the guard on `updateDto.action !== undefined ||
     * updateDto.price !== undefined` again.
     * Test that fails under it: all three below. `InvestmentTransactionForm`
     * always sends `action`, and loads a legacy blank price as `0` and sends it
     * back, so a presence-keyed guard rejects every edit of a pre-guard
     * zero-price BUY -- exactly the stranding the carve-out exists to prevent.
     */
    describe("a legacy zero-price acquisition stays correctable", () => {
      /** What the form posts for such a row: every field, price echoed as 0. */
      const asTheFormSends = (
        overrides: Partial<UpdateInvestmentTransactionDto> = {},
      ): UpdateInvestmentTransactionDto =>
        ({
          action: InvestmentAction.BUY,
          accountId,
          securityId,
          transactionDate: "2024-01-15",
          quantity: 10,
          price: 0,
          commission: 9.99,
          description: "renamed",
          ...overrides,
        }) as UpdateInvestmentTransactionDto;

      const storedAsZeroPrice = () => {
        investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
          createMockQueryBuilder({ ...mockBuyTransaction, price: 0 }),
        );
      };

      it("accepts the whole-form payload that only renames it", async () => {
        storedAsZeroPrice();
        await expect(
          service.update(userId, transactionId, asTheFormSends()),
        ).resolves.toBeDefined();
      });

      it("accepts the edit that gives it a real price", async () => {
        storedAsZeroPrice();
        await expect(
          service.update(userId, transactionId, asTheFormSends({ price: 150 })),
        ).resolves.toBeDefined();
      });

      it("accepts being reclassified as ADD_SHARES, whose cost is unknown", async () => {
        // The honest correction for shares that arrived without a cost, and the
        // guard must not stand in front of it.
        storedAsZeroPrice();
        await expect(
          service.update(
            userId,
            transactionId,
            asTheFormSends({ action: InvestmentAction.ADD_SHARES }),
          ),
        ).resolves.toBeDefined();
      });

      it("still refuses to take a real price away from a priced BUY", async () => {
        // The other side of the same comparison: this row *was* priced, so the
        // edit is what makes it unpriced.
        investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
          createMockQueryBuilder({ ...mockBuyTransaction, price: 150 }),
        );
        await expect(
          service.update(userId, transactionId, asTheFormSends({ price: 0 })),
        ).rejects.toBeInstanceOf(BadRequestException);
      });
    });

    it("recomputes the bond-engine prices of the old and the new security after the edit (R7)", async () => {
      const existingTx = { ...mockBuyTransaction };
      investmentTransactionsRepository.createQueryBuilder
        .mockReturnValueOnce(createMockQueryBuilder(existingTx))
        .mockReturnValueOnce(
          createMockQueryBuilder({ ...existingTx, quantity: 20 }),
        );
      transactionRepository.findOne.mockResolvedValue({
        id: cashTransactionId,
        userId,
        accountId: cashAccountId,
        amount: -1509.99,
      });

      await service.update(userId, transactionId, { quantity: 20 });

      expect(
        securitiesService.recomputeBondPricesAfterWrite,
      ).toHaveBeenCalledWith(userId, [securityId, securityId]);
    });

    it("updates transaction fields and re-applies effects", async () => {
      // findOne returns existing BUY transaction
      const existingTx = { ...mockBuyTransaction };
      const firstFindQB = createMockQueryBuilder(existingTx);
      const secondFindQB = createMockQueryBuilder({
        ...existingTx,
        quantity: 20,
      });

      investmentTransactionsRepository.createQueryBuilder
        .mockReturnValueOnce(firstFindQB) // findOne in update
        .mockReturnValueOnce(secondFindQB); // findOne at the end

      transactionRepository.findOne.mockResolvedValue({
        id: cashTransactionId,
        userId,
        accountId: cashAccountId,
        amount: -1509.99,
      });

      await service.update(userId, transactionId, { quantity: 20 });

      // Should reverse the original effects first
      expect(
        holdingsService.rebuildScopesFromTransactions,
      ).toHaveBeenCalledWith(
        userId,
        [{ accountId: accountId, securityId: securityId }],
        expect.anything(),
      );

      // Then apply new effects
      expect(
        holdingsService.rebuildScopesFromTransactions,
      ).toHaveBeenCalledWith(
        userId,
        [{ accountId: accountId, securityId: securityId }],
        expect.anything(),
      );
    });

    it("allows editing a past transaction when current holdings are zero", async () => {
      // Regression: previously the update flow rejected any edit to a past
      // BUY transaction when current holdings were zero because reversing
      // the original BUY drove the running balance negative. The fix passes
      // allowNegative=true through reverse+apply and validates the full
      // history after instead.
      const existingTx = { ...mockBuyTransaction };
      const firstFindQB = createMockQueryBuilder(existingTx);
      const secondFindQB = createMockQueryBuilder({
        ...existingTx,
        quantity: 15,
        totalAmount: 2259.99,
      });

      investmentTransactionsRepository.createQueryBuilder
        .mockReturnValueOnce(firstFindQB)
        .mockReturnValueOnce(secondFindQB);

      transactionRepository.findOne.mockResolvedValue({
        id: cashTransactionId,
        userId,
        accountId: cashAccountId,
        amount: -1509.99,
      });

      await expect(
        service.update(userId, transactionId, { quantity: 15 }),
      ).resolves.toBeDefined();

      expect(
        holdingsService.validateNoNegativeHoldingsHistory,
      ).toHaveBeenCalledWith(
        userId,
        expect.anything(),
        [accountId],
        // Validation is now also scoped to the deleted transaction's
        // security so unrelated pre-existing oversells don't get blamed.
        expect.arrayContaining([expect.any(String)]),
      );
      expect(dataSource.transaction).toHaveBeenCalled();
    });

    it("aborts the edit when it would cause negative holdings on some date", async () => {
      const existingTx = { ...mockBuyTransaction };
      const firstFindQB = createMockQueryBuilder(existingTx);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValueOnce(
        firstFindQB,
      );

      transactionRepository.findOne.mockResolvedValue({
        id: cashTransactionId,
        userId,
        accountId: cashAccountId,
        amount: -1509.99,
      });

      holdingsService.validateNoNegativeHoldingsHistory.mockRejectedValueOnce(
        new BadRequestException("Negative holdings of AAPL on 2024-06-01"),
      );

      await expect(
        service.update(userId, transactionId, { quantity: 1 }),
      ).rejects.toThrow(/Negative holdings/);

      // The guard throws inside the scoped transaction, which rolls back, so
      // the post-commit history record never runs.
      expect(mockActionHistoryService.record).not.toHaveBeenCalled();
    });

    it("recalculates totalAmount when quantity changes", async () => {
      const existingTx = { ...mockBuyTransaction };
      const firstFindQB = createMockQueryBuilder(existingTx);
      const secondFindQB = createMockQueryBuilder({
        ...existingTx,
        quantity: 20,
        totalAmount: 3009.99,
      });

      investmentTransactionsRepository.createQueryBuilder
        .mockReturnValueOnce(firstFindQB)
        .mockReturnValueOnce(secondFindQB);

      transactionRepository.findOne.mockResolvedValue({
        id: cashTransactionId,
        userId,
        accountId: cashAccountId,
        amount: -1509.99,
      });

      await service.update(userId, transactionId, { quantity: 20 });

      // save should be called with recalculated totalAmount
      // (20 * 150) + 9.99 = 3009.99
      expect(investmentTransactionsRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          totalAmount: 3009.99,
        }),
      );
    });

    it("recalculates totalAmount when price changes", async () => {
      const existingTx = { ...mockBuyTransaction };
      const firstFindQB = createMockQueryBuilder(existingTx);
      const secondFindQB = createMockQueryBuilder({
        ...existingTx,
        price: 200,
        totalAmount: 2009.99,
      });

      investmentTransactionsRepository.createQueryBuilder
        .mockReturnValueOnce(firstFindQB)
        .mockReturnValueOnce(secondFindQB);

      transactionRepository.findOne.mockResolvedValue({
        id: cashTransactionId,
        userId,
        accountId: cashAccountId,
        amount: -1509.99,
      });

      await service.update(userId, transactionId, { price: 200 });

      // (10 * 200) + 9.99 = 2009.99
      expect(investmentTransactionsRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          totalAmount: 2009.99,
        }),
      );
    });

    it("recalculates totalAmount when commission changes", async () => {
      const existingTx = { ...mockBuyTransaction };
      const firstFindQB = createMockQueryBuilder(existingTx);
      const secondFindQB = createMockQueryBuilder({
        ...existingTx,
        commission: 0,
        totalAmount: 1500,
      });

      investmentTransactionsRepository.createQueryBuilder
        .mockReturnValueOnce(firstFindQB)
        .mockReturnValueOnce(secondFindQB);

      transactionRepository.findOne.mockResolvedValue({
        id: cashTransactionId,
        userId,
        accountId: cashAccountId,
        amount: -1509.99,
      });

      await service.update(userId, transactionId, { commission: 0 });

      // (10 * 150) + 0 = 1500
      expect(investmentTransactionsRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          totalAmount: 1500,
        }),
      );
    });

    /**
     * Invariant: a change is a value difference, not a field being present
     * (AGENTS.md, "Financial math"), and the stored executed total is the fact.
     * Canonical adversarial input: the transaction form's own payload, which
     * resends quantity, price, commission and action unchanged on an edit that
     * only touches the description.
     * Minimal mutation: key the re-derivation on `!== undefined` again.
     * Test that fails under it: this one -- the stored 1510.5000 comes back as
     * 10 x 150 + 9.99 = 1509.99, because the price is a rounded quotient.
     */
    it("keeps the stored total when a resent edit changes only the description", async () => {
      const existingTx = { ...mockBuyTransaction, totalAmount: 1510.5 };
      const firstFindQB = createMockQueryBuilder(existingTx);
      const secondFindQB = createMockQueryBuilder({ ...existingTx });

      investmentTransactionsRepository.createQueryBuilder
        .mockReturnValueOnce(firstFindQB)
        .mockReturnValueOnce(secondFindQB);

      transactionRepository.findOne.mockResolvedValue({
        id: cashTransactionId,
        userId,
        accountId: cashAccountId,
        amount: -1510.5,
      });

      await service.update(userId, transactionId, {
        action: InvestmentAction.BUY,
        quantity: 10,
        price: 150,
        commission: 9.99,
        description: "Updated",
      });

      expect(investmentTransactionsRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ totalAmount: 1510.5 }),
      );
    });

    it("re-derives the total from the price when the quantity changes", async () => {
      const existingTx = { ...mockBuyTransaction, totalAmount: 1510.5 };
      const firstFindQB = createMockQueryBuilder(existingTx);
      const secondFindQB = createMockQueryBuilder({ ...existingTx });

      investmentTransactionsRepository.createQueryBuilder
        .mockReturnValueOnce(firstFindQB)
        .mockReturnValueOnce(secondFindQB);

      transactionRepository.findOne.mockResolvedValue({
        id: cashTransactionId,
        userId,
        accountId: cashAccountId,
        amount: -1510.5,
      });

      await service.update(userId, transactionId, {
        quantity: 20,
        price: 150,
        commission: 9.99,
      });

      // 20 x 150 + 9.99
      expect(investmentTransactionsRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ totalAmount: 3009.99 }),
      );
    });

    it("takes a supplied total as the fact and derives the price from it", async () => {
      const existingTx = { ...mockBuyTransaction };
      const firstFindQB = createMockQueryBuilder(existingTx);
      const secondFindQB = createMockQueryBuilder({ ...existingTx });

      investmentTransactionsRepository.createQueryBuilder
        .mockReturnValueOnce(firstFindQB)
        .mockReturnValueOnce(secondFindQB);

      transactionRepository.findOne.mockResolvedValue({
        id: cashTransactionId,
        userId,
        accountId: cashAccountId,
        amount: -1509.99,
      });

      await service.update(userId, transactionId, {
        quantity: 10,
        price: 150,
        commission: 9.99,
        totalAmount: 1520.91,
      });

      expect(investmentTransactionsRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          totalAmount: 1520.91,
          // (1520.91 - 9.99) / 10
          price: 151.092,
        }),
      );
    });

    it("does not recalculate totalAmount when only description changes", async () => {
      const existingTx = { ...mockBuyTransaction };
      const firstFindQB = createMockQueryBuilder(existingTx);
      const secondFindQB = createMockQueryBuilder({
        ...existingTx,
        description: "Updated description",
      });

      investmentTransactionsRepository.createQueryBuilder
        .mockReturnValueOnce(firstFindQB)
        .mockReturnValueOnce(secondFindQB);

      transactionRepository.findOne.mockResolvedValue({
        id: cashTransactionId,
        userId,
        accountId: cashAccountId,
        amount: -1509.99,
      });

      await service.update(userId, transactionId, {
        description: "Updated description",
      });

      // totalAmount should remain unchanged (1509.99)
      expect(investmentTransactionsRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          totalAmount: 1509.99,
          description: "Updated description",
        }),
      );
    });

    it("updates multiple fields at once", async () => {
      const existingTx = { ...mockBuyTransaction };
      const firstFindQB = createMockQueryBuilder(existingTx);
      const secondFindQB = createMockQueryBuilder(existingTx);

      investmentTransactionsRepository.createQueryBuilder
        .mockReturnValueOnce(firstFindQB)
        .mockReturnValueOnce(secondFindQB);

      transactionRepository.findOne.mockResolvedValue({
        id: cashTransactionId,
        userId,
        accountId: cashAccountId,
        amount: -1509.99,
      });

      await service.update(userId, transactionId, {
        transactionDate: "2025-06-01",
        description: "Changed date",
      });

      expect(investmentTransactionsRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          transactionDate: "2025-06-01",
          description: "Changed date",
        }),
      );
    });

    it("deletes old cash transaction and reverses balance during reversal", async () => {
      const existingTx = {
        ...mockBuyTransaction,
        transactionId: cashTransactionId,
      };
      const firstFindQB = createMockQueryBuilder(existingTx);
      const secondFindQB = createMockQueryBuilder(existingTx);

      investmentTransactionsRepository.createQueryBuilder
        .mockReturnValueOnce(firstFindQB)
        .mockReturnValueOnce(secondFindQB);

      transactionRepository.findOne.mockResolvedValue({
        id: cashTransactionId,
        userId,
        accountId: cashAccountId,
        amount: -1509.99,
      });

      await service.update(userId, transactionId, { description: "Updated" });

      // Should clear FK reference first
      expect(investmentTransactionsRepository.update).toHaveBeenCalledWith(
        transactionId,
        { transactionId: null },
      );

      // Should reverse the balance
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        cashAccountId,
        1509.99, // Reverse of -1509.99
      );

      // Should remove the cash transaction -- conditionally, with the reversal
      // gated on the row the database actually removed.
      expect(mockQueryRunner.manager.delete).toHaveBeenCalledWith(Transaction, {
        id: cashTransactionId,
        userId,
      });
    });

    it("triggers net worth recalculation for brokerage and cash accounts after update", async () => {
      const existingTx = { ...mockBuyTransaction, transactionId: null };
      const firstFindQB = createMockQueryBuilder(existingTx);
      const secondFindQB = createMockQueryBuilder(existingTx);

      investmentTransactionsRepository.createQueryBuilder
        .mockReturnValueOnce(firstFindQB)
        .mockReturnValueOnce(secondFindQB);

      await service.update(userId, transactionId, { description: "Updated" });

      expect(netWorthService.triggerDebouncedRecalc).toHaveBeenCalledWith(
        accountId,
        userId,
      );
      expect(netWorthService.triggerDebouncedRecalc).toHaveBeenCalledWith(
        cashAccountId,
        userId,
      );
    });

    it("throws NotFoundException when transaction does not exist", async () => {
      const mockQB = createMockQueryBuilder(null);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        mockQB,
      );

      await expect(
        service.update(userId, "nonexistent", { description: "Test" }),
      ).rejects.toThrow(NotFoundException);
    });

    it("clears fundingAccountId when set to empty string", async () => {
      const existingTx = { ...mockBuyTransaction, fundingAccountId };
      const firstFindQB = createMockQueryBuilder(existingTx);
      const secondFindQB = createMockQueryBuilder({
        ...existingTx,
        fundingAccountId: null,
      });

      investmentTransactionsRepository.createQueryBuilder
        .mockReturnValueOnce(firstFindQB)
        .mockReturnValueOnce(secondFindQB);

      transactionRepository.findOne.mockResolvedValue(null);

      await service.update(userId, transactionId, { fundingAccountId: "" });

      expect(investmentTransactionsRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          fundingAccountId: null,
        }),
      );
    });

    it("debits the new funding account and refunds the old one when fundingAccountId changes", async () => {
      const newFundingAccountId = "funding-account-2";
      const newCashTxId = "cash-tx-new-funding";
      const mockNewFundingAccount = {
        id: newFundingAccountId,
        userId,
        accountType: "CHEQUING",
        accountSubType: null,
        linkedAccountId: null,
        currencyCode: "USD",
        name: "Other Checking",
      };
      accountsService.findOne.mockImplementation((uid: string, aid: string) => {
        if (aid === accountId) return Promise.resolve(mockInvestmentAccount);
        if (aid === cashAccountId) return Promise.resolve(mockCashAccount);
        if (aid === fundingAccountId)
          return Promise.resolve(mockFundingAccount);
        if (aid === newFundingAccountId)
          return Promise.resolve(mockNewFundingAccount);
        return Promise.reject(new NotFoundException("Account not found"));
      });

      // Existing BUY that was funded from the original fundingAccountId, with
      // the eager-loaded fundingAccount relation pointing at the OLD account
      // (this is what `findOne`'s leftJoinAndSelect produces in real usage).
      const existingTx = {
        ...mockBuyTransaction,
        fundingAccountId,
        fundingAccount: mockFundingAccount as any,
      };
      const firstFindQB = createMockQueryBuilder(existingTx);
      const secondFindQB = createMockQueryBuilder({
        ...existingTx,
        fundingAccountId: newFundingAccountId,
        fundingAccount: mockNewFundingAccount as any,
      });
      investmentTransactionsRepository.createQueryBuilder
        .mockReturnValueOnce(firstFindQB)
        .mockReturnValueOnce(secondFindQB);

      // Linked cash transaction currently sits in the OLD funding account
      transactionRepository.findOne.mockResolvedValue({
        id: cashTransactionId,
        userId,
        accountId: fundingAccountId,
        transactionDate: existingTx.transactionDate,
        amount: -1509.99,
      });

      transactionRepository.create.mockImplementationOnce((data: any) => ({
        ...data,
        id: newCashTxId,
      }));

      await service.update(userId, transactionId, {
        fundingAccountId: newFundingAccountId,
      });

      // OLD funding account should be refunded by reversing the original cash tx
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        fundingAccountId,
        1509.99,
      );

      // NEW funding account should be debited via a freshly created cash tx
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        newFundingAccountId,
        -1509.99,
      );

      // The new linked cash transaction must be persisted on the NEW account
      expect(transactionRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: newFundingAccountId,
          amount: -1509.99,
        }),
      );

      // And the investment row must be saved with the NEW fundingAccountId
      expect(investmentTransactionsRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          fundingAccountId: newFundingAccountId,
        }),
      );
    });

    it("records action history on update", async () => {
      investmentTransactionsRepository.findOne.mockResolvedValue({
        ...mockBuyTransaction,
      });
      transactionRepository.findOne.mockResolvedValue(null);

      await service.update(userId, transactionId, { price: 200 });

      expect(mockActionHistoryService.record).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          entityType: "investment_transaction",
          entityId: transactionId,
          action: "update",
          description: expect.stringContaining("Updated BUY transaction"),
        }),
      );
    });

    it("keeps the stored exchange rate when only description changes", async () => {
      const existingTx = {
        ...mockBuyTransaction,
        exchangeRate: 1.35,
      };
      const firstFindQB = createMockQueryBuilder(existingTx);
      const secondFindQB = createMockQueryBuilder(existingTx);
      investmentTransactionsRepository.createQueryBuilder
        .mockReturnValueOnce(firstFindQB)
        .mockReturnValueOnce(secondFindQB);
      transactionRepository.findOne.mockResolvedValue(null);

      await service.update(userId, transactionId, {
        description: "tweaked",
      });

      expect(exchangeRateService.getLatestRate).not.toHaveBeenCalled();
      expect(investmentTransactionsRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          exchangeRate: 1.35,
        }),
      );
    });

    it("uses the DTO exchange rate override when supplied", async () => {
      const existingTx = {
        ...mockBuyTransaction,
        exchangeRate: 1.35,
      };
      const firstFindQB = createMockQueryBuilder(existingTx);
      const secondFindQB = createMockQueryBuilder(existingTx);
      investmentTransactionsRepository.createQueryBuilder
        .mockReturnValueOnce(firstFindQB)
        .mockReturnValueOnce(secondFindQB);
      transactionRepository.findOne.mockResolvedValue(null);

      await service.update(userId, transactionId, { exchangeRate: 1.5 });

      // Explicit rate should bypass the market lookup
      expect(exchangeRateService.getLatestRate).not.toHaveBeenCalled();
      expect(investmentTransactionsRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          exchangeRate: 1.5,
        }),
      );
    });

    it("re-resolves the exchange rate when the security changes", async () => {
      const existingTx = {
        ...mockBuyTransaction,
        exchangeRate: 1.35,
      };
      const firstFindQB = createMockQueryBuilder(existingTx);
      const secondFindQB = createMockQueryBuilder(existingTx);
      investmentTransactionsRepository.createQueryBuilder
        .mockReturnValueOnce(firstFindQB)
        .mockReturnValueOnce(secondFindQB);
      transactionRepository.findOne.mockResolvedValue(null);

      // New security is in EUR, cash account is in USD
      const eurSecurity = {
        ...mockSecurity,
        id: "sec-eur",
        currencyCode: "EUR",
      };
      securitiesService.findOne.mockImplementation(
        (_uid: string, sid: string) => {
          if (sid === "sec-eur") return Promise.resolve(eurSecurity);
          return Promise.resolve(mockSecurity);
        },
      );
      exchangeRateService.getRateForDate.mockResolvedValue(1.08);

      await service.update(userId, transactionId, { securityId: "sec-eur" });

      expect(exchangeRateService.getRateForDate).toHaveBeenCalledWith(
        "EUR",
        "USD",
        expect.anything(),
      );
      expect(exchangeRateService.getLatestRate).not.toHaveBeenCalled();
      expect(investmentTransactionsRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          exchangeRate: 1.08,
        }),
      );
    });
  });

  describe("remove", () => {
    beforeEach(() => {
      accountsService.findOne.mockImplementation((uid: string, aid: string) => {
        if (aid === accountId) return Promise.resolve(mockInvestmentAccount);
        if (aid === cashAccountId) return Promise.resolve(mockCashAccount);
        return Promise.reject(new NotFoundException("Account not found"));
      });
    });

    it("recomputes the bond-engine prices of its security after the delete (R7)", async () => {
      const mockQB = createMockQueryBuilder({ ...mockBuyTransaction });
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        mockQB,
      );
      transactionRepository.findOne.mockResolvedValue(null);

      await service.remove(userId, transactionId);

      expect(
        securitiesService.recomputeBondPricesAfterWrite,
      ).toHaveBeenCalledWith(userId, [securityId]);
    });

    it("reverses effects and deletes the transaction", async () => {
      const tx = { ...mockBuyTransaction, transactionId: cashTransactionId };
      const mockQB = createMockQueryBuilder(tx);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        mockQB,
      );

      transactionRepository.findOne.mockResolvedValue({
        id: cashTransactionId,
        userId,
        accountId: cashAccountId,
        amount: -1509.99,
      });

      await service.remove(userId, transactionId);

      // The position is re-derived from the ledger the row has just left --
      // not from the stored figure minus this row's delta, which is what made
      // deleting a back-dated trade converge on the wrong average cost.
      expect(
        holdingsService.rebuildScopesFromTransactions,
      ).toHaveBeenCalledWith(
        userId,
        [{ accountId: accountId, securityId: securityId }],
        expect.anything(),
      );

      // Should delete cash transaction and reverse balance
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        cashAccountId,
        1509.99,
      );
      expect(mockQueryRunner.manager.delete).toHaveBeenCalledWith(Transaction, {
        id: cashTransactionId,
        userId,
      });

      // Should delete the investment transaction
      expect(investmentTransactionsRepository.remove).toHaveBeenCalledWith(tx);
    });

    it("reverses SELL transaction by adding shares back", async () => {
      const tx = { ...mockSellTransaction, transactionId: "cash-tx-2" };
      const mockQB = createMockQueryBuilder(tx);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        mockQB,
      );

      transactionRepository.findOne.mockResolvedValue({
        id: "cash-tx-2",
        userId,
        accountId: cashAccountId,
        amount: 790.01,
      });

      await service.remove(userId, tx.id);

      // Should reverse SELL: add shares back
      expect(
        holdingsService.rebuildScopesFromTransactions,
      ).toHaveBeenCalledWith(
        userId,
        [{ accountId: accountId, securityId: securityId }],
        expect.anything(),
      );
    });

    it("reverses REINVEST by removing shares", async () => {
      const reinvestTx = {
        ...mockBuyTransaction,
        id: "inv-tx-reinvest",
        action: InvestmentAction.REINVEST,
        transactionId: null,
        quantity: 3,
        price: 150,
      };
      const mockQB = createMockQueryBuilder(reinvestTx);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        mockQB,
      );

      await service.remove(userId, reinvestTx.id);

      expect(
        holdingsService.rebuildScopesFromTransactions,
      ).toHaveBeenCalledWith(
        userId,
        [{ accountId: accountId, securityId: securityId }],
        expect.anything(),
      );
    });

    it("reverses TRANSFER_IN by removing shares", async () => {
      const transferInTx = {
        ...mockBuyTransaction,
        id: "inv-tx-transfer-in",
        action: InvestmentAction.TRANSFER_IN,
        transactionId: null,
        quantity: 20,
        price: 100,
      };
      const mockQB = createMockQueryBuilder(transferInTx);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        mockQB,
      );

      await service.remove(userId, transferInTx.id);

      expect(
        holdingsService.rebuildScopesFromTransactions,
      ).toHaveBeenCalledWith(
        userId,
        [{ accountId: accountId, securityId: securityId }],
        expect.anything(),
      );
    });

    it("reverses TRANSFER_OUT by adding shares back", async () => {
      const transferOutTx = {
        ...mockBuyTransaction,
        id: "inv-tx-transfer-out",
        action: InvestmentAction.TRANSFER_OUT,
        transactionId: null,
        quantity: 10,
        price: 100,
      };
      const mockQB = createMockQueryBuilder(transferOutTx);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        mockQB,
      );

      await service.remove(userId, transferOutTx.id);

      expect(
        holdingsService.rebuildScopesFromTransactions,
      ).toHaveBeenCalledWith(
        userId,
        [{ accountId: accountId, securityId: securityId }],
        expect.anything(),
      );
    });

    it("reverses ADD_SHARES by removing quantity", async () => {
      const addSharesTx = {
        ...mockBuyTransaction,
        id: "inv-tx-add-shares",
        action: InvestmentAction.ADD_SHARES,
        transactionId: null,
        quantity: 5,
        price: 0,
      };
      const mockQB = createMockQueryBuilder(addSharesTx);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        mockQB,
      );

      await service.remove(userId, addSharesTx.id);

      expect(
        holdingsService.rebuildScopesFromTransactions,
      ).toHaveBeenCalledWith(
        userId,
        [{ accountId: accountId, securityId: securityId }],
        expect.anything(),
      );
    });

    it("reverses REMOVE_SHARES by adding quantity back", async () => {
      const removeSharesTx = {
        ...mockBuyTransaction,
        id: "inv-tx-remove-shares",
        action: InvestmentAction.REMOVE_SHARES,
        transactionId: null,
        quantity: 3,
        price: 0,
      };
      const mockQB = createMockQueryBuilder(removeSharesTx);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        mockQB,
      );

      await service.remove(userId, removeSharesTx.id);

      expect(
        holdingsService.rebuildScopesFromTransactions,
      ).toHaveBeenCalledWith(
        userId,
        [{ accountId: accountId, securityId: securityId }],
        expect.anything(),
      );
    });

    it("re-derives the position after removing an embedded SPLIT", async () => {
      const splitTx = {
        ...mockBuyTransaction,
        id: "inv-tx-split",
        action: InvestmentAction.SPLIT,
        transactionId: null,
        quantity: 2,
        price: 0,
      };
      const mockQB = createMockQueryBuilder(splitTx);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        mockQB,
      );

      await service.remove(userId, splitTx.id);

      expect(
        holdingsService.rebuildScopesFromTransactions,
      ).toHaveBeenCalledWith(
        userId,
        [{ accountId: accountId, securityId: securityId }],
        expect.anything(),
      );
      // Reversing a SPLIT must NOT remove cash transactions.
      // Rebuild holdings from history so any incremental drift from the
      // original (possibly buggy) apply is corrected.
      expect(holdingsService.rebuildFromTransactions).toHaveBeenCalledWith(
        userId,
      );
    });

    it("skips cash transaction deletion when no transactionId is linked", async () => {
      const tx = { ...mockBuyTransaction, transactionId: null };
      const mockQB = createMockQueryBuilder(tx);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        mockQB,
      );

      await service.remove(userId, transactionId);

      // Should not attempt to find or delete cash transaction
      expect(transactionRepository.findOne).not.toHaveBeenCalled();
      expect(transactionRepository.remove).not.toHaveBeenCalled();
    });

    it("handles missing cash transaction gracefully during reversal", async () => {
      const tx = { ...mockBuyTransaction, transactionId: cashTransactionId };
      const mockQB = createMockQueryBuilder(tx);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        mockQB,
      );

      // Cash transaction not found in DB
      transactionRepository.findOne.mockResolvedValue(null);

      // Should not throw
      await expect(
        service.remove(userId, transactionId),
      ).resolves.toBeUndefined();
      expect(transactionRepository.remove).not.toHaveBeenCalled();
    });

    it("triggers net worth recalculation for brokerage and cash accounts after remove", async () => {
      const tx = { ...mockBuyTransaction, transactionId: null };
      const mockQB = createMockQueryBuilder(tx);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        mockQB,
      );

      await service.remove(userId, transactionId);

      expect(netWorthService.triggerDebouncedRecalc).toHaveBeenCalledWith(
        accountId,
        userId,
      );
      expect(netWorthService.triggerDebouncedRecalc).toHaveBeenCalledWith(
        cashAccountId,
        userId,
      );
    });

    it("throws NotFoundException when transaction does not exist", async () => {
      const mockQB = createMockQueryBuilder(null);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        mockQB,
      );

      await expect(service.remove(userId, "nonexistent")).rejects.toThrow(
        NotFoundException,
      );
    });

    it("records action history on remove", async () => {
      const mockQB = createMockQueryBuilder({ ...mockBuyTransaction });
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        mockQB,
      );

      await service.remove(userId, transactionId);

      expect(mockActionHistoryService.record).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          entityType: "investment_transaction",
          entityId: transactionId,
          action: "delete",
          description: expect.stringContaining("Deleted BUY transaction"),
        }),
      );
    });

    it("captures linkedCashTransaction in beforeData for action history on remove", async () => {
      const mockCashTx = {
        id: cashTransactionId,
        userId,
        accountId: cashAccountId,
        transactionDate: "2025-01-15",
        amount: -1509.99,
        currencyCode: "USD",
        status: "CLEARED",
      };
      const tx = { ...mockBuyTransaction, transactionId: cashTransactionId };
      const mockQB = createMockQueryBuilder(tx);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        mockQB,
      );
      transactionRepository.findOne.mockResolvedValue(mockCashTx);

      await service.remove(userId, transactionId);

      expect(transactionRepository.findOne).toHaveBeenCalledWith({
        where: { id: cashTransactionId, userId },
      });
      expect(mockActionHistoryService.record).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          beforeData: expect.objectContaining({
            linkedCashTransaction: expect.objectContaining({
              id: cashTransactionId,
              accountId: cashAccountId,
              amount: -1509.99,
            }),
          }),
        }),
      );
    });

    it("records beforeData without linkedCashTransaction when transactionId is null", async () => {
      const tx = { ...mockBuyTransaction, transactionId: null };
      const mockQB = createMockQueryBuilder(tx);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        mockQB,
      );

      await service.remove(userId, transactionId);

      expect(transactionRepository.findOne).not.toHaveBeenCalled();
      const recordCall = mockActionHistoryService.record.mock.calls[0];
      expect(recordCall[1].beforeData.linkedCashTransaction).toBeUndefined();
    });

    it("reverses nothing when removing a VOID row: no holdings, no balance", async () => {
      // Adversarial against the naive `-amount` reversal: a VOID row moved no
      // shares and its VOID cash leg moved no balance (deletionBalanceEffect
      // gives delta 0), so deleting the pair must move neither.
      const tx = {
        ...mockBuyTransaction,
        status: TransactionStatus.VOID,
        transactionId: cashTransactionId,
      };
      const mockQB = createMockQueryBuilder(tx);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        mockQB,
      );

      transactionRepository.findOne.mockResolvedValue({
        id: cashTransactionId,
        userId,
        accountId: cashAccountId,
        amount: -1509.99,
        transactionDate: "2025-01-15",
        status: TransactionStatus.VOID,
      });

      await service.remove(userId, transactionId);

      // Both rows are still deleted -- a VOID row is a record...
      expect(mockQueryRunner.manager.delete).toHaveBeenCalledWith(Transaction, {
        id: cashTransactionId,
        userId,
      });
      expect(investmentTransactionsRepository.remove).toHaveBeenCalledWith(tx);
      // ...and the position is re-derived from what is left of the ledger.
      // That a VOID row contributed nothing is the rebuild's filter, covered
      // in holdings.service.spec.ts, not a delta this seam declines to apply.
      expect(
        holdingsService.rebuildScopesFromTransactions,
      ).toHaveBeenCalledWith(
        userId,
        [{ accountId, securityId }],
        expect.anything(),
      );
      expect(accountsService.updateBalance).not.toHaveBeenCalled();
    });
  });

  describe("updateStatus", () => {
    /**
     * `updateStatus` reads its rows through the raw row locks
     * (`lockInvestmentTransactionRow` / `lockTransactionRow`), which arrive via
     * `manager.query` with snake_case columns. The two lock queries are told
     * apart by the table named in the SQL string.
     */
    const invLockRow = (overrides: Record<string, unknown> = {}) => ({
      id: transactionId,
      account_id: accountId,
      security_id: securityId,
      funding_account_id: null,
      transaction_id: cashTransactionId,
      transaction_split_id: null,
      linked_transaction_id: null,
      action: InvestmentAction.BUY,
      transaction_date: "2025-01-15",
      quantity: "10",
      price: "150",
      commission: "9.99",
      total_amount: "1509.99",
      exchange_rate: "1",
      status: TransactionStatus.CLEARED,
      ...overrides,
    });

    const cashLockRow = (overrides: Record<string, unknown> = {}) => ({
      id: cashTransactionId,
      account_id: cashAccountId,
      amount: "-1509.99",
      transaction_date: "2025-01-15",
      status: TransactionStatus.CLEARED,
      is_split: false,
      linked_transaction_id: null,
      parent_transaction_id: null,
      payee_id: null,
      payee_name: null,
      ...overrides,
    });

    const stageLocks = (
      invRows: Record<string, unknown>[],
      cashRows: Record<string, unknown>[] = [],
    ) => {
      mockQueryRunner.manager.query.mockImplementation(
        async (sql: string, params?: unknown[]) => {
          const text = String(sql);
          // The unlocked scope read that feeds the advisory lock: the row's
          // own account and its linked transfer leg's.
          if (text.includes("SELECT DISTINCT account_id")) {
            const self = invRows.find((row) => row.id === params?.[0]);
            const legId = self?.linked_transaction_id ?? null;
            const rows = invRows.filter(
              (row) => row.id === params?.[0] || row.id === legId,
            );
            return [...new Set(rows.map((row) => row.account_id))].map(
              (account_id) => ({ account_id }),
            );
          }
          if (!text.includes("FOR UPDATE")) return [];
          const rows = text.includes("FROM investment_transactions")
            ? invRows
            : cashRows;
          return rows.filter((row) => row.id === params?.[0]);
        },
      );
    };

    beforeEach(() => {
      accountsService.findOne.mockImplementation((uid: string, aid: string) => {
        if (aid === accountId) return Promise.resolve(mockInvestmentAccount);
        if (aid === cashAccountId) return Promise.resolve(mockCashAccount);
        return Promise.reject(new NotFoundException("Account not found"));
      });
      const findOneQB = createMockQueryBuilder(mockBuyTransaction);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        findOneQB,
      );
    });

    /**
     * Advisory locks are taken before row locks (`common/db/locks.ts`).
     * `updateStatus` reached the holdings advisory lock only inside the
     * rebuild at the end, by which time `applyVoidTransitionToMirrorLeg` had
     * already row-locked `accounts` for the cash leg -- the opposite order
     * from create/update/remove, so two concurrent writers of one account
     * deadlock (40P01).
     */
    it("recomputes the bond-engine prices of the security whose row crossed the VOID boundary (R7)", async () => {
      stageLocks([invLockRow()], [cashLockRow()]);

      await service.updateStatus(userId, transactionId, TransactionStatus.VOID);

      expect(
        securitiesService.recomputeBondPricesAfterWrite,
      ).toHaveBeenCalledWith(userId, [securityId]);
    });

    it("takes the holdings advisory lock before its first row lock", async () => {
      stageLocks([invLockRow()], [cashLockRow()]);

      await service.updateStatus(userId, transactionId, TransactionStatus.VOID);

      const calls = mockQueryRunner.manager.query.mock.calls as unknown[][];
      const advisory = calls.findIndex(([sql]) =>
        String(sql).includes("pg_advisory_xact_lock"),
      );
      const firstRowLock = calls.findIndex(([sql]) =>
        String(sql).includes("FOR UPDATE"),
      );
      expect(advisory).toBeGreaterThanOrEqual(0);
      expect(firstRowLock).toBeGreaterThanOrEqual(0);
      expect(advisory).toBeLessThan(firstRowLock);
    });

    /** The scope covers the transfer leg that crosses the boundary with it. */
    it("locks both legs' accounts when a linked transfer leg crosses too", async () => {
      stageLocks(
        [
          invLockRow({ linked_transaction_id: "inv-tx-2" }),
          invLockRow({
            id: "inv-tx-2",
            account_id: "other-brokerage",
            linked_transaction_id: transactionId,
            transaction_id: null,
          }),
        ],
        [cashLockRow()],
      );

      await service.updateStatus(userId, transactionId, TransactionStatus.VOID);

      const advisoryIds = (
        mockQueryRunner.manager.query.mock.calls as unknown[][]
      )
        .filter(([sql]) => String(sql).includes("pg_advisory_xact_lock"))
        .map(([, params]) => (params as unknown[])[1]);
      expect(advisoryIds).toEqual(
        [accountId, "other-brokerage"].sort((a, b) => (a < b ? -1 : 1)),
      );
    });

    it("UNRECONCILED -> CLEARED updates only the column (presentational)", async () => {
      stageLocks([invLockRow({ status: TransactionStatus.UNRECONCILED })]);

      await service.updateStatus(
        userId,
        transactionId,
        TransactionStatus.CLEARED,
      );

      expect(investmentTransactionsRepository.update).toHaveBeenCalledWith(
        transactionId,
        { status: TransactionStatus.CLEARED },
      );
      // Only crossing the VOID boundary moves shares or money.
      expect(
        holdingsService.rebuildScopesFromTransactions,
      ).not.toHaveBeenCalled();
      expect(accountsService.updateBalance).not.toHaveBeenCalled();
      expect(
        holdingsService.validateNoNegativeHoldingsHistory,
      ).not.toHaveBeenCalled();
    });

    it("active BUY -> VOID reverses the holdings and flips the cash leg", async () => {
      stageLocks([invLockRow()], [cashLockRow()]);

      await service.updateStatus(userId, transactionId, TransactionStatus.VOID);

      // Holdings reversal at the row's stored quantities (unit cost is the
      // commissioned figure, as everywhere else).
      expect(
        holdingsService.rebuildScopesFromTransactions,
      ).toHaveBeenCalledWith(
        userId,
        [{ accountId: accountId, securityId: securityId }],
        expect.anything(),
      );
      expect(investmentTransactionsRepository.update).toHaveBeenCalledWith(
        transactionId,
        { status: TransactionStatus.VOID },
      );
      // The cash leg is flipped in place, not deleted, and its balance is
      // adjusted by its own contribution: -(-1509.99).
      expect(mockQueryRunner.manager.update).toHaveBeenCalledWith(
        Transaction,
        cashTransactionId,
        { status: TransactionStatus.VOID },
      );
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        cashAccountId,
        1509.99,
      );
      // The crossing is validated inside the same transaction.
      expect(
        holdingsService.validateNoNegativeHoldingsHistory,
      ).toHaveBeenCalled();
    });

    it("VOID -> CLEARED applies the holdings and debits the cash leg", async () => {
      stageLocks(
        [invLockRow({ status: TransactionStatus.VOID })],
        [cashLockRow({ status: TransactionStatus.VOID })],
      );

      await service.updateStatus(
        userId,
        transactionId,
        TransactionStatus.CLEARED,
      );

      expect(
        holdingsService.rebuildScopesFromTransactions,
      ).toHaveBeenCalledWith(
        userId,
        [{ accountId: accountId, securityId: securityId }],
        expect.anything(),
      );
      expect(mockQueryRunner.manager.update).toHaveBeenCalledWith(
        Transaction,
        cashTransactionId,
        { status: TransactionStatus.CLEARED },
      );
      // Un-voiding a BUY takes the purchase money back out of the cash account.
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        cashAccountId,
        -1509.99,
      );
    });

    it("writes nothing on a same-status no-op", async () => {
      stageLocks([invLockRow({ status: TransactionStatus.CLEARED })]);

      await service.updateStatus(
        userId,
        transactionId,
        TransactionStatus.CLEARED,
      );

      expect(investmentTransactionsRepository.update).not.toHaveBeenCalled();
      expect(mockQueryRunner.manager.update).not.toHaveBeenCalled();
      expect(
        holdingsService.rebuildScopesFromTransactions,
      ).not.toHaveBeenCalled();
      expect(accountsService.updateBalance).not.toHaveBeenCalled();
    });

    it("refuses an embedded row and writes nothing (contract 7.1)", async () => {
      // The parent split transaction owns an embedded row's status; the
      // refusal must precede every write.
      stageLocks([
        invLockRow({
          transaction_split_id: "split-1",
          status: TransactionStatus.CLEARED,
        }),
      ]);

      await expect(
        service.updateStatus(userId, transactionId, TransactionStatus.VOID),
      ).rejects.toThrow(BadRequestException);

      expect(mockQueryRunner.manager.update).not.toHaveBeenCalled();
      expect(investmentTransactionsRepository.update).not.toHaveBeenCalled();
      expect(
        holdingsService.rebuildScopesFromTransactions,
      ).not.toHaveBeenCalled();
      expect(accountsService.updateBalance).not.toHaveBeenCalled();
    });

    it("throws NotFoundException for a missing row", async () => {
      stageLocks([]);

      await expect(
        service.updateStatus(userId, "nonexistent", TransactionStatus.VOID),
      ).rejects.toThrow(NotFoundException);

      expect(mockQueryRunner.manager.update).not.toHaveBeenCalled();
    });

    it("propagates an oversell refusal from the history validation", async () => {
      // Un-voiding or voiding into an oversold history is refused inside the
      // same transaction, rolling the writes above back.
      stageLocks([invLockRow()], [cashLockRow()]);
      holdingsService.validateNoNegativeHoldingsHistory.mockRejectedValue(
        new BadRequestException("Holdings would go negative"),
      );

      await expect(
        service.updateStatus(userId, transactionId, TransactionStatus.VOID),
      ).rejects.toThrow(/negative/);
    });

    it("carries a VOID crossing onto the linked transfer leg (both holdings move)", async () => {
      // Two legs of one movement of shares share the VOID boundary
      // (spec section 1). Transfer legs have no cash side.
      const linkedLegId = "inv-tx-linked-leg";
      stageLocks([
        invLockRow({
          action: InvestmentAction.TRANSFER_OUT,
          transaction_id: null,
          linked_transaction_id: linkedLegId,
          quantity: "10",
          price: "0",
          commission: "0",
          total_amount: "0",
        }),
        invLockRow({
          id: linkedLegId,
          account_id: "account-2",
          action: InvestmentAction.TRANSFER_IN,
          transaction_id: null,
          linked_transaction_id: transactionId,
          quantity: "10",
          price: "0",
          commission: "0",
          total_amount: "0",
        }),
      ]);

      await service.updateStatus(userId, transactionId, TransactionStatus.VOID);

      // Both legs' status columns cross together.
      expect(investmentTransactionsRepository.update).toHaveBeenCalledWith(
        transactionId,
        { status: TransactionStatus.VOID },
      );
      expect(investmentTransactionsRepository.update).toHaveBeenCalledWith(
        linkedLegId,
        { status: TransactionStatus.VOID },
      );
      // Two rows describing one movement of shares cross the boundary
      // together, so both positions are re-derived in one call.
      expect(
        holdingsService.rebuildScopesFromTransactions,
      ).toHaveBeenCalledWith(
        userId,
        [
          { accountId: accountId, securityId: securityId },
          { accountId: "account-2", securityId: securityId },
        ],
        expect.anything(),
      );
      expect(accountsService.updateBalance).not.toHaveBeenCalled();
    });

    it("voids an active row over an already-VOID cash leg without moving the balance", async () => {
      // The pre-migration half-void state (spec truth table, last row): a
      // Money import wrote VOID onto the cash leg only. Voiding the
      // investment row reverses the holdings but skips the leg -- it is
      // already on the target side, and it contributed nothing to reverse.
      stageLocks(
        [invLockRow()],
        [cashLockRow({ status: TransactionStatus.VOID })],
      );

      await service.updateStatus(userId, transactionId, TransactionStatus.VOID);

      expect(
        holdingsService.rebuildScopesFromTransactions,
      ).toHaveBeenCalledWith(
        userId,
        [{ accountId: accountId, securityId: securityId }],
        expect.anything(),
      );
      expect(mockQueryRunner.manager.update).not.toHaveBeenCalledWith(
        Transaction,
        cashTransactionId,
        expect.anything(),
      );
      expect(accountsService.updateBalance).not.toHaveBeenCalled();
    });
  });

  describe("applyParentStatusToEmbeddedRows", () => {
    /**
     * The split parent's status change row-locks `accounts` for the parent's
     * own balance; this pass rebuilds the embedded rows' positions under the
     * holdings advisory lock. Taking that lock only inside the rebuild put the
     * two in the opposite order from an investment write (40P01), so the lock
     * is this method's own first statement as well as its callers'.
     */
    it("takes the holdings advisory lock before it touches a row", async () => {
      mockQueryRunner.manager.query.mockImplementation(async (sql: string) =>
        String(sql).includes("SELECT DISTINCT it.account_id")
          ? [{ account_id: accountId }]
          : [],
      );

      await service.applyParentStatusToEmbeddedRows(
        mockQueryRunner.manager as never,
        userId,
        "parent-tx-1",
        TransactionStatus.VOID,
      );

      const advisory = (
        mockQueryRunner.manager.query.mock.calls as unknown[][]
      ).filter(([sql]) => String(sql).includes("pg_advisory_xact_lock"));
      expect(advisory).toHaveLength(1);
      expect((advisory[0][1] as unknown[])[1]).toBe(accountId);
    });
  });

  describe("VOID create", () => {
    const createVoidBuyDto = {
      accountId,
      securityId,
      action: InvestmentAction.BUY,
      transactionDate: "2025-01-15",
      quantity: 10,
      price: 150,
      commission: 9.99,
      status: TransactionStatus.VOID,
    };

    beforeEach(() => {
      accountsService.findOne.mockImplementation((uid: string, aid: string) => {
        if (aid === accountId) return Promise.resolve(mockInvestmentAccount);
        if (aid === cashAccountId) return Promise.resolve(mockCashAccount);
        return Promise.reject(new NotFoundException("Account not found"));
      });
      const findOneQB = createMockQueryBuilder({
        ...mockBuyTransaction,
        status: TransactionStatus.VOID,
      });
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        findOneQB,
      );
    });

    it("applies no holdings, posts a VOID cash leg, and moves no balance", async () => {
      // Adversarial against the naive implementation that applies holdings
      // and credits the balance unconditionally and stamps the status after:
      // a VOID trade records something that did not happen, on every axis.
      await service.create(userId, createVoidBuyDto);

      expect(investmentTransactionsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ status: TransactionStatus.VOID }),
      );
      // The VOID row's exclusion is the rebuild's status filter, not a
      // holdings write this path declines to make.
      // The cash leg is still created -- the event stays visible in the cash
      // ledger -- but carries VOID and moves nothing.
      expect(transactionRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: cashAccountId,
          status: TransactionStatus.VOID,
        }),
      );
      expect(accountsService.updateBalance).not.toHaveBeenCalled();
    });

    it("contributes no transaction-derived price row for a VOID trade", async () => {
      await service.create(userId, createVoidBuyDto);

      expect(
        securityPriceService.upsertTransactionPrice,
      ).not.toHaveBeenCalled();
    });
  });

  describe("getSummary", () => {
    it("returns correct summary statistics", async () => {
      const transactions = [
        {
          ...mockBuyTransaction,
          action: InvestmentAction.BUY,
          totalAmount: 1500,
          commission: 9.99,
        },
        {
          ...mockSellTransaction,
          action: InvestmentAction.SELL,
          totalAmount: 800,
          commission: 9.99,
        },
        {
          ...mockDividendTransaction,
          action: InvestmentAction.DIVIDEND,
          totalAmount: 25,
          commission: 0,
        },
        {
          id: "inv-tx-4",
          userId,
          action: InvestmentAction.INTEREST,
          totalAmount: 10,
          commission: 0,
        },
        {
          id: "inv-tx-5",
          userId,
          action: InvestmentAction.CAPITAL_GAIN,
          totalAmount: 500,
          commission: 0,
        },
      ];

      const mockQB = createMockQueryBuilder(transactions, transactions.length);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        mockQB,
      );

      const result = await service.getSummary(userId);

      expect(result).toEqual({
        totalTransactions: 5,
        totalBuys: 1,
        totalSells: 1,
        totalDividends: 25,
        totalInterest: 10,
        totalCapitalGains: 500,
        totalCommissions: 19.98,
      });
    });

    it("counts a reinvested distribution in the total of its kind", async () => {
      // As the app writes a reinvest: quantity and price, no total.
      const transactions = [
        {
          id: "inv-tx-1",
          userId,
          action: InvestmentAction.DIVIDEND,
          totalAmount: 25,
          commission: 0,
        },
        {
          id: "inv-tx-2",
          userId,
          action: InvestmentAction.REINVEST,
          quantity: 2,
          price: 30,
          totalAmount: 0,
          commission: 0,
        },
        {
          id: "inv-tx-3",
          userId,
          action: InvestmentAction.REINVEST_INTEREST,
          quantity: 1,
          price: 4,
          totalAmount: 0,
          commission: 0,
        },
        {
          id: "inv-tx-4",
          userId,
          action: InvestmentAction.REINVEST_CAPITAL_GAIN_SHORT,
          quantity: 1,
          price: 7.5,
          totalAmount: 0,
          commission: 0,
        },
      ];
      const mockQB = createMockQueryBuilder(transactions, transactions.length);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        mockQB,
      );

      const result = await service.getSummary(userId);

      expect(result.totalDividends).toBe(85);
      expect(result.totalInterest).toBe(4);
      expect(result.totalCapitalGains).toBe(7.5);
    });

    it("returns zero values when no transactions exist", async () => {
      const mockQB = createMockQueryBuilder([], 0);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        mockQB,
      );

      const result = await service.getSummary(userId);

      expect(result).toEqual({
        totalTransactions: 0,
        totalBuys: 0,
        totalSells: 0,
        totalDividends: 0,
        totalInterest: 0,
        totalCapitalGains: 0,
        totalCommissions: 0,
      });
    });

    it("passes accountIds to findAll", async () => {
      const mockQB = createMockQueryBuilder([], 0);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        mockQB,
      );
      accountsService.findByIds.mockResolvedValue([mockInvestmentAccount]);

      await service.getSummary(userId, [accountId]);

      // Should call findAll with accountIds and a large limit
      expect(
        investmentTransactionsRepository.createQueryBuilder,
      ).toHaveBeenCalled();
      expect(accountsService.findByIds).toHaveBeenCalledWith(userId, [
        accountId,
      ]);
    });
  });

  describe("getLlmInvestmentTransactions", () => {
    const buy = {
      ...mockBuyTransaction,
      action: InvestmentAction.BUY,
      transactionDate: "2026-03-10",
      quantity: 10,
      price: 150,
      commission: 9.99,
      totalAmount: 1509.99,
      account: { ...mockInvestmentAccount, currencyCode: "USD" },
      security: mockSecurity,
    };
    const sell = {
      ...mockSellTransaction,
      action: InvestmentAction.SELL,
      transactionDate: "2026-03-20",
      quantity: 5,
      price: 160,
      commission: 9.99,
      totalAmount: 790.01,
      account: { ...mockInvestmentAccount, currencyCode: "USD" },
      security: mockSecurity,
    };
    const dividend = {
      ...mockDividendTransaction,
      action: InvestmentAction.DIVIDEND,
      transactionDate: "2026-03-15",
      quantity: null,
      price: null,
      commission: 0,
      totalAmount: 25,
      account: { ...mockInvestmentAccount, currencyCode: "USD" },
      security: mockSecurity,
    };

    it("returns aggregate totals, action counts, and transactions list", async () => {
      const rows = [sell, dividend, buy];
      const mockQB = createMockQueryBuilder(rows, rows.length);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        mockQB,
      );

      const result = await service.getLlmInvestmentTransactions(userId, {});

      expect(result.transactionCount).toBe(3);
      expect(result.totalAmount).toBeCloseTo(2325, 2);
      expect(result.totalCommission).toBeCloseTo(19.98, 2);
      expect(result.totalQuantity).toBeCloseTo(15, 8);
      expect(result.actionCounts).toEqual({ BUY: 1, SELL: 1, DIVIDEND: 1 });
      expect(result.groupedBy).toBeNull();
      expect(result.groups).toBeNull();
      expect(result.truncatedTransactionList).toBe(false);
      expect(result.transactions).toHaveLength(3);
      expect(result.transactions[0]).toEqual({
        transactionDate: "2026-03-20",
        action: "SELL",
        status: TransactionStatus.CLEARED,
        accountName: "Brokerage Account",
        symbol: "AAPL",
        securityName: "Apple Inc.",
        quantity: 5,
        price: 160,
        commission: 9.99,
        totalAmount: 790.01,
        incomeAmount: 0,
        incomeCurrency: mockSecurity.currencyCode,
        currency: "USD",
        description: "Sell AAPL",
      });
      expect(result.incomeByCurrency).toEqual({
        [mockSecurity.currencyCode]: 25,
      });
    });

    it("counts a reinvested distribution as income, though it stores no total", async () => {
      // Discussion #1670: "what dividends did I receive" summed totalAmount,
      // and a reinvest created in the app stores 0 there.
      const reinvest = {
        ...dividend,
        id: "inv-tx-reinvest",
        action: InvestmentAction.REINVEST,
        quantity: 2,
        price: 12.5,
        totalAmount: 0,
      };
      const rows = [reinvest, dividend, buy];
      const mockQB = createMockQueryBuilder(rows, rows.length);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        mockQB,
      );

      const result = await service.getLlmInvestmentTransactions(userId, {
        groupBy: "action",
      });

      expect(result.incomeByCurrency).toEqual({
        [mockSecurity.currencyCode]: 50,
      });
      expect(result.transactions[0]).toMatchObject({
        action: "REINVEST",
        totalAmount: 0,
        incomeAmount: 25,
      });
      expect(
        result.groups?.find((group) => group.key === "REINVEST")
          ?.incomeByCurrency,
      ).toEqual({ [mockSecurity.currencyCode]: 25 });
      expect(
        result.groups?.find((group) => group.key === "BUY")?.incomeByCurrency,
      ).toEqual({});
    });

    it("keeps income in different currencies apart rather than adding it", async () => {
      const cadDividend = {
        ...dividend,
        id: "inv-tx-cad",
        totalAmount: 40,
        security: { ...mockSecurity, id: "sec-cad", currencyCode: "CAD" },
      };
      const usdDividend = {
        ...dividend,
        security: { ...mockSecurity, currencyCode: "USD" },
      };
      const rows = [cadDividend, usdDividend];
      const mockQB = createMockQueryBuilder(rows, rows.length);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        mockQB,
      );

      const result = await service.getLlmInvestmentTransactions(userId, {});

      expect(result.incomeByCurrency).toEqual({ CAD: 40, USD: 25 });
    });

    it("applies date, symbol, action and accountId filters", async () => {
      const mockQB = createMockQueryBuilder([], 0);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        mockQB,
      );
      accountsService.findByIds.mockResolvedValue([
        { ...mockInvestmentAccount, linkedAccountId: cashAccountId },
      ]);

      await service.getLlmInvestmentTransactions(userId, {
        startDate: "2026-01-01",
        endDate: "2026-03-31",
        accountIds: [accountId],
        symbols: ["aapl"],
        actions: [InvestmentAction.BUY, InvestmentAction.SELL],
      });

      expect(accountsService.findByIds).toHaveBeenCalledWith(userId, [
        accountId,
      ]);
      // Base userId filter + 5 andWhere calls (accountIds, startDate, endDate, symbols, actions)
      expect(mockQB.andWhere).toHaveBeenCalledWith(
        "it.accountId IN (:...allIds)",
        { allIds: expect.arrayContaining([accountId, cashAccountId]) },
      );
      expect(mockQB.andWhere).toHaveBeenCalledWith(
        "it.transactionDate >= :startDate",
        { startDate: "2026-01-01" },
      );
      expect(mockQB.andWhere).toHaveBeenCalledWith(
        "it.transactionDate <= :endDate",
        { endDate: "2026-03-31" },
      );
      expect(mockQB.andWhere).toHaveBeenCalledWith(
        "UPPER(security.symbol) IN (:...upperSymbols)",
        { upperSymbols: ["AAPL"] },
      );
      expect(mockQB.andWhere).toHaveBeenCalledWith(
        "it.action IN (:...actions)",
        { actions: [InvestmentAction.BUY, InvestmentAction.SELL] },
      );
    });

    it("groups by security symbol with per-group totals", async () => {
      const tsla = {
        ...buy,
        id: "tx-tsla",
        totalAmount: 500,
        quantity: 2,
        commission: 1,
        security: { ...mockSecurity, id: "sec-tsla", symbol: "TSLA" },
      };
      const rows = [buy, sell, dividend, tsla];
      const mockQB = createMockQueryBuilder(rows, rows.length);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        mockQB,
      );

      const result = await service.getLlmInvestmentTransactions(userId, {
        groupBy: "security",
      });

      expect(result.groupedBy).toBe("security");
      expect(result.groups).not.toBeNull();
      const aapl = result.groups!.find((g) => g.key === "AAPL");
      const tslaGroup = result.groups!.find((g) => g.key === "TSLA");
      expect(aapl).toBeDefined();
      expect(tslaGroup).toBeDefined();
      expect(aapl!.transactionCount).toBe(3);
      expect(aapl!.totalAmount).toBeCloseTo(2325, 2);
      expect(aapl!.totalCommission).toBeCloseTo(19.98, 2);
      expect(aapl!.totalQuantity).toBeCloseTo(15, 8);
      expect(tslaGroup!.transactionCount).toBe(1);
      expect(tslaGroup!.totalAmount).toBeCloseTo(500, 2);
      // Sorted by totalAmount descending (non-date grouping)
      expect(result.groups![0].key).toBe("AAPL");
    });

    it("groups by date with date-descending ordering", async () => {
      const rows = [buy, sell, dividend];
      const mockQB = createMockQueryBuilder(rows, rows.length);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        mockQB,
      );

      const result = await service.getLlmInvestmentTransactions(userId, {
        groupBy: "date",
      });

      expect(result.groupedBy).toBe("date");
      expect(result.groups!.map((g) => g.key)).toEqual([
        "2026-03-20",
        "2026-03-15",
        "2026-03-10",
      ]);
    });

    it("groups by action type", async () => {
      const rows = [buy, sell, dividend];
      const mockQB = createMockQueryBuilder(rows, rows.length);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        mockQB,
      );

      const result = await service.getLlmInvestmentTransactions(userId, {
        groupBy: "action",
      });

      expect(result.groupedBy).toBe("action");
      expect(new Set(result.groups!.map((g) => g.key))).toEqual(
        new Set(["BUY", "SELL", "DIVIDEND"]),
      );
    });

    it("groups by account name", async () => {
      const otherAccountTx = {
        ...buy,
        id: "tx-other",
        accountId: "acc-2",
        account: {
          ...mockInvestmentAccount,
          id: "acc-2",
          name: "TFSA",
        },
      };
      const rows = [buy, otherAccountTx];
      const mockQB = createMockQueryBuilder(rows, rows.length);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        mockQB,
      );

      const result = await service.getLlmInvestmentTransactions(userId, {
        groupBy: "account",
      });

      expect(result.groupedBy).toBe("account");
      expect(new Set(result.groups!.map((g) => g.key))).toEqual(
        new Set(["Brokerage Account", "TFSA"]),
      );
    });

    it("truncates the transactions list at 100 but preserves full aggregate totals", async () => {
      const rows = Array.from({ length: 150 }, (_, i) => ({
        ...buy,
        id: `tx-${i}`,
        totalAmount: 10,
        commission: 1,
        quantity: 1,
      }));
      const mockQB = createMockQueryBuilder(rows, rows.length);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        mockQB,
      );

      const result = await service.getLlmInvestmentTransactions(userId, {});

      expect(result.transactionCount).toBe(150);
      expect(result.transactions).toHaveLength(100);
      expect(result.truncatedTransactionList).toBe(true);
      expect(result.totalAmount).toBeCloseTo(1500, 2);
      expect(result.totalCommission).toBeCloseTo(150, 2);
    });

    it("handles empty result set cleanly", async () => {
      const mockQB = createMockQueryBuilder([], 0);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        mockQB,
      );

      const result = await service.getLlmInvestmentTransactions(userId, {
        groupBy: "action",
      });

      expect(result.transactionCount).toBe(0);
      expect(result.totalAmount).toBe(0);
      expect(result.totalCommission).toBe(0);
      expect(result.totalQuantity).toBe(0);
      expect(result.actionCounts).toEqual({});
      expect(result.groups).toEqual([]);
      expect(result.transactions).toEqual([]);
      expect(result.truncatedTransactionList).toBe(false);
    });
  });

  describe("getLlmCapitalGains", () => {
    const makeEntry = (
      overrides: Partial<{
        month: string;
        accountId: string;
        accountName: string | null;
        accountCurrencyCode: string | null;
        securityId: string;
        symbol: string | null;
        securityName: string | null;
        startValue: number;
        endValue: number;
        realizedGain: number;
        unrealizedGain: number;
        totalCapitalGain: number;
      }>,
    ) => ({
      month: "2024-06",
      accountId: "acc-1",
      accountName: "TFSA",
      accountCurrencyCode: "CAD",
      securityId: "sec-1",
      symbol: "AAA",
      securityName: "Alpha",
      securityCurrencyCode: "CAD",
      startQuantity: 10,
      endQuantity: 10,
      startValue: 1000,
      endValue: 1100,
      buys: 0,
      sells: 0,
      realizedGain: 0,
      unrealizedGain: 100,
      totalCapitalGain: 100,
      ...overrides,
    });

    it("names the known part when a month's realized gain rests on an unknown basis", async () => {
      const raw = [
        makeEntry({ month: "2024-06", realizedGain: 40 }),
        {
          ...makeEntry({ month: "2024-07" }),
          realizedGain: null,
          realizedGainComplete: false,
          realizedGainKnownSubtotal: 15,
        },
      ];
      (
        portfolioCalculationService.calculateCapitalGainsByMonth as jest.Mock
      ).mockResolvedValue(raw);

      const result = await service.getLlmCapitalGains(userId, {
        startDate: "2024-06-01",
        endDate: "2024-07-31",
      });

      expect(result.totals).toMatchObject({
        realizedGain: null,
        realizedGainComplete: false,
        realizedGainKnownSubtotal: 55,
      });
      const [june, july] = result.entries;
      expect(june).toMatchObject({
        realizedGain: 40,
        realizedGainComplete: true,
        realizedGainKnownSubtotal: null,
      });
      expect(july).toMatchObject({
        realizedGain: null,
        realizedGainComplete: false,
        realizedGainKnownSubtotal: 15,
      });
    });

    it("aggregates the raw per-(account,security,month) rows into monthly buckets by default", async () => {
      const raw = [
        makeEntry({
          month: "2024-06",
          symbol: "AAA",
          securityName: "Alpha",
          securityId: "sec-1",
          totalCapitalGain: 100,
          unrealizedGain: 100,
          startValue: 1000,
          endValue: 1100,
        }),
        makeEntry({
          month: "2024-06",
          symbol: "BBB",
          securityName: "Beta",
          securityId: "sec-2",
          totalCapitalGain: -50,
          unrealizedGain: -50,
          startValue: 500,
          endValue: 450,
        }),
        makeEntry({
          month: "2024-07",
          symbol: "AAA",
          securityName: "Alpha",
          securityId: "sec-1",
          totalCapitalGain: 200,
          realizedGain: 120,
          unrealizedGain: 80,
          startValue: 1100,
          endValue: 1300,
        }),
      ];
      (
        portfolioCalculationService.calculateCapitalGainsByMonth as jest.Mock
      ).mockResolvedValue(raw);

      const result = await service.getLlmCapitalGains(userId, {
        startDate: "2024-06-01",
        endDate: "2024-07-31",
      });

      expect(result.startDate).toBe("2024-06-01");
      expect(result.endDate).toBe("2024-07-31");
      expect(result.groupedBy).toBe("month");
      expect(result.totals.totalCapitalGain).toBeCloseTo(250, 4);
      expect(result.totals.realizedGain).toBeCloseTo(120, 4);
      expect(result.totals.unrealizedGain).toBeCloseTo(130, 4);
      expect(result.entries).toHaveLength(2);
      // Sorted by month ascending for the month grouping.
      expect(result.entries.map((e) => e.month)).toEqual([
        "2024-06",
        "2024-07",
      ]);
      // June combines Alpha + Beta sums.
      expect(result.entries[0].totalCapitalGain).toBe(50);
      expect(result.entries[0].startValue).toBe(1500);
      expect(result.entries[0].endValue).toBe(1550);
      // Same account currency across all rows → kept as CAD.
      expect(result.entries[0].currency).toBe("CAD");
      expect(result.entryCount).toBe(2);
      expect(result.truncatedEntryList).toBe(false);
    });

    it("groups by security when requested and sorts descending by total gain", async () => {
      (
        portfolioCalculationService.calculateCapitalGainsByMonth as jest.Mock
      ).mockResolvedValue([
        makeEntry({
          month: "2024-06",
          symbol: "AAA",
          securityId: "sec-1",
          totalCapitalGain: 80,
          realizedGain: 0,
          unrealizedGain: 80,
        }),
        makeEntry({
          month: "2024-07",
          symbol: "AAA",
          securityId: "sec-1",
          totalCapitalGain: 120,
          realizedGain: 60,
          unrealizedGain: 60,
        }),
        makeEntry({
          month: "2024-06",
          symbol: "BBB",
          securityName: "Beta",
          securityId: "sec-2",
          totalCapitalGain: -50,
          realizedGain: 0,
          unrealizedGain: -50,
        }),
      ]);

      const result = await service.getLlmCapitalGains(userId, {
        startDate: "2024-06-01",
        endDate: "2024-07-31",
        groupBy: "security",
      });

      expect(result.groupedBy).toBe("security");
      expect(result.entries.map((e) => e.symbol)).toEqual(["AAA", "BBB"]);
      expect(result.entries[0].totalCapitalGain).toBe(200); // 80 + 120
      expect(result.entries[0].realizedGain).toBe(60);
      expect(result.entries[1].totalCapitalGain).toBe(-50);
    });

    const usdToCad = (rate: number) => [
      {
        from_currency: "USD",
        to_currency: "CAD",
        rate,
        rate_date: "2024-06-28",
      },
    ];

    it("converts a mixed-currency month into the default currency instead of adding CAD to USD", async () => {
      (
        portfolioCalculationService.calculateCapitalGainsByMonth as jest.Mock
      ).mockResolvedValue([
        makeEntry({
          accountCurrencyCode: "CAD",
          totalCapitalGain: 100,
          unrealizedGain: 100,
        }),
        makeEntry({
          accountCurrencyCode: "USD",
          totalCapitalGain: 50,
          unrealizedGain: 50,
          symbol: "USS",
          securityId: "sec-us",
        }),
      ]);
      mockQueryRunner.manager.query.mockResolvedValue(usdToCad(1.5));

      const result = await service.getLlmCapitalGains(userId, {
        startDate: "2024-06-01",
        endDate: "2024-06-30",
      });

      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].currency).toBe("CAD");
      expect(result.totals.totalCapitalGain).toBe(175); // 100 + 50 * 1.5
      expect(result.totals.fxComplete).toBe(true);
      expect(result.totals.missingRatePairs).toEqual([]);
    });

    it("withholds the total and names the pair when a rate is missing", async () => {
      (
        portfolioCalculationService.calculateCapitalGainsByMonth as jest.Mock
      ).mockResolvedValue([
        makeEntry({ accountCurrencyCode: "CAD", totalCapitalGain: 100 }),
        makeEntry({
          accountCurrencyCode: "USD",
          totalCapitalGain: 50,
          symbol: "USS",
          securityId: "sec-us",
        }),
      ]);
      mockQueryRunner.manager.query.mockResolvedValue([]);

      const result = await service.getLlmCapitalGains(userId, {
        startDate: "2024-06-01",
        endDate: "2024-06-30",
      });

      expect(result.totals.totalCapitalGain).toBeNull();
      expect(result.totals.unrealizedGain).toBeNull();
      expect(result.totals.fxComplete).toBe(false);
      expect(result.totals.missingRatePairs).toEqual(["USD->CAD"]);
      expect(result.entries[0].totalCapitalGain).toBeNull();
    });

    it("filters by symbol (case-insensitive) before aggregating", async () => {
      (
        portfolioCalculationService.calculateCapitalGainsByMonth as jest.Mock
      ).mockResolvedValue([
        makeEntry({ symbol: "AAA", totalCapitalGain: 100 }),
        makeEntry({
          symbol: "BBB",
          securityId: "sec-2",
          totalCapitalGain: 200,
        }),
      ]);

      const result = await service.getLlmCapitalGains(userId, {
        startDate: "2024-06-01",
        endDate: "2024-06-30",
        symbols: ["aaa"],
      });

      expect(result.entries).toHaveLength(1);
      expect(result.totals.totalCapitalGain).toBe(100);
    });

    it("resolves linked brokerage/cash account pairs when an accountId filter is passed", async () => {
      (accountsService.findByIds as jest.Mock).mockResolvedValue([
        { id: "brok-1", linkedAccountId: "cash-1" },
      ]);
      (
        portfolioCalculationService.calculateCapitalGainsByMonth as jest.Mock
      ).mockResolvedValue([]);

      await service.getLlmCapitalGains(userId, {
        startDate: "2024-06-01",
        endDate: "2024-06-30",
        accountIds: ["brok-1"],
      });

      expect(
        portfolioCalculationService.calculateCapitalGainsByMonth,
      ).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          accountIds: expect.arrayContaining(["brok-1", "cash-1"]),
        }),
      );
    });
  });

  describe("removeAll", () => {
    it("deletes all transactions, holdings, and resets account balances", async () => {
      const transactions = [mockBuyTransaction, mockSellTransaction];
      const cashTx1 = {
        id: cashTransactionId,
        userId,
        accountId: cashAccountId,
        amount: -1509.99,
        status: TransactionStatus.CLEARED,
      };
      const cashTx2 = {
        id: "cash-tx-2",
        userId,
        accountId: cashAccountId,
        amount: 790.01,
        status: TransactionStatus.CLEARED,
      };

      mockQueryRunner.manager.find.mockImplementation(
        (entity: any, _opts: any) => {
          if (entity === InvestmentTransaction)
            return Promise.resolve(transactions);
          if (entity === Transaction)
            return Promise.resolve([cashTx1, cashTx2]);
          return Promise.resolve([]);
        },
      );
      // The cash legs are locked in ascending id order before their amounts
      // become reversals (audit P4-003), so they arrive through the locked read.
      mockQueryRunner.manager.query.mockImplementation(async (sql: string) => {
        if (!String(sql).includes("FOR UPDATE")) return [];
        return [cashTx1, cashTx2].map((tx) => ({
          id: tx.id,
          account_id: tx.accountId,
          amount: String(tx.amount),
          transaction_date: null,
          status: tx.status,
          is_split: false,
          linked_transaction_id: null,
          parent_transaction_id: null,
        }));
      });

      const result = await service.removeAll(userId);

      expect(mockQueryRunner.manager.find).toHaveBeenCalledWith(
        InvestmentTransaction,
        { where: { userId } },
      );
      // Should reverse balance for each cash transaction
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        cashAccountId,
        1509.99,
      );
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        cashAccountId,
        -790.01,
      );
      // Should remove cash transactions
      // Conditional DELETEs, one per locked leg, each reversal gated on the row
      // the database actually removed.
      expect(mockQueryRunner.manager.delete).toHaveBeenCalledWith(Transaction, {
        id: cashTx1.id,
        userId,
      });
      expect(mockQueryRunner.manager.delete).toHaveBeenCalledWith(Transaction, {
        id: cashTx2.id,
        userId,
      });
      // Should remove investment transactions
      expect(mockQueryRunner.manager.remove).toHaveBeenCalledWith(transactions);
      expect(holdingsService.removeAllForUser).toHaveBeenCalledWith(userId);
      expect(accountsService.resetBrokerageBalances).toHaveBeenCalledWith(
        userId,
      );
      expect(result).toEqual({
        transactionsDeleted: 2,
        holdingsDeleted: 5,
        accountsReset: 2,
      });
      // No lots are left on any linked bond: its engine rows go (R7).
      expect(
        securitiesService.recomputeBondPricesAfterWrite,
      ).toHaveBeenCalledWith(userId, [
        mockBuyTransaction.securityId,
        mockSellTransaction.securityId,
      ]);
    });

    it("handles zero transactions gracefully", async () => {
      mockQueryRunner.manager.find.mockResolvedValue([]);

      const result = await service.removeAll(userId);

      expect(mockQueryRunner.manager.remove).not.toHaveBeenCalled();
      expect(result.transactionsDeleted).toBe(0);
    });

    it("still deletes holdings and resets accounts even with no transactions", async () => {
      mockQueryRunner.manager.find.mockResolvedValue([]);

      await service.removeAll(userId);

      expect(holdingsService.removeAllForUser).toHaveBeenCalledWith(userId);
      expect(accountsService.resetBrokerageBalances).toHaveBeenCalledWith(
        userId,
      );
    });
  });

  describe("calculateTotalAmount (via create)", () => {
    beforeEach(() => {
      accountsService.findOne.mockImplementation((uid: string, aid: string) => {
        if (aid === accountId) return Promise.resolve(mockInvestmentAccount);
        if (aid === cashAccountId) return Promise.resolve(mockCashAccount);
        return Promise.reject(new NotFoundException("Account not found"));
      });

      const findOneQB = createMockQueryBuilder(mockBuyTransaction);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        findOneQB,
      );
    });

    it("BUY: totalAmount = (qty * price) + commission", async () => {
      await service.create(userId, {
        accountId,
        securityId,
        action: InvestmentAction.BUY,
        transactionDate: "2025-01-15",
        quantity: 10,
        price: 100,
        commission: 5,
      });

      expect(investmentTransactionsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ totalAmount: 1005 }),
      );
    });

    it("SELL: totalAmount = (qty * price) - commission", async () => {
      await service.create(userId, {
        accountId,
        securityId,
        action: InvestmentAction.SELL,
        transactionDate: "2025-01-15",
        quantity: 10,
        price: 100,
        commission: 5,
      });

      expect(investmentTransactionsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ totalAmount: 995 }),
      );
    });

    it("DIVIDEND: totalAmount = (qty || 1) * price", async () => {
      await service.create(userId, {
        accountId,
        securityId,
        action: InvestmentAction.DIVIDEND,
        transactionDate: "2025-01-15",
        price: 50,
      });

      // quantity defaults to 1 for dividend: 1 * 50 = 50
      expect(investmentTransactionsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ totalAmount: 50 }),
      );
    });

    it("INTEREST: totalAmount = (qty || 1) * price", async () => {
      await service.create(userId, {
        accountId,
        action: InvestmentAction.INTEREST,
        transactionDate: "2025-01-15",
        price: 30,
      });

      expect(investmentTransactionsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ totalAmount: 30 }),
      );
    });

    it("CAPITAL_GAIN: totalAmount = (qty || 1) * price", async () => {
      await service.create(userId, {
        accountId,
        securityId,
        action: InvestmentAction.CAPITAL_GAIN,
        transactionDate: "2025-01-15",
        price: 200,
      });

      expect(investmentTransactionsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ totalAmount: 200 }),
      );
    });

    it("ADD_SHARES: totalAmount = 0", async () => {
      await service.create(userId, {
        accountId,
        securityId,
        action: InvestmentAction.ADD_SHARES,
        transactionDate: "2025-01-15",
        quantity: 10,
      });

      expect(investmentTransactionsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ totalAmount: 0 }),
      );
    });

    /**
     * Invariant: the executed total is the fact; the per-share price is
     * derived from it (`docs/financial-semantics.md` section 4).
     * Canonical adversarial input: a sale whose total does not divide into a
     * two-decimal price -- 141 shares for 820.91.
     * Minimal mutation: resolve the amounts from `price` alone.
     * Test that fails under it: this one -- the row stores 141 x 5.82 =
     * 820.62, and the realized-gains report is 0.29 light before FX.
     */
    it("stores a supplied total as given and derives the price from it", async () => {
      await service.create(userId, {
        accountId,
        securityId,
        action: InvestmentAction.SELL,
        transactionDate: "2025-01-15",
        quantity: 141,
        price: 5.82,
        totalAmount: 820.91,
      });

      expect(investmentTransactionsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          totalAmount: 820.91,
          price: 5.8220567376,
        }),
      );
    });

    it("REMOVE_SHARES: totalAmount = 0", async () => {
      await service.create(userId, {
        accountId,
        securityId,
        action: InvestmentAction.REMOVE_SHARES,
        transactionDate: "2025-01-15",
        quantity: 5,
      });

      expect(investmentTransactionsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ totalAmount: 0 }),
      );
    });

    /**
     * Invariant: an omitted acquisition price is a missing fact, never a
     * zero-cost purchase.
     * Canonical adversarial input: a nullable money column left out of the
     * request (testing contract, money precision / missing data).
     * Minimal mutation: restore `price: createDto.price ?? 0` and drop the
     * guard above it.
     * Test that fails under it: this one -- the row is written at zero.
     */
    it("refuses a BUY with no price rather than recording a free purchase", async () => {
      await expect(
        service.create(userId, {
          accountId,
          securityId,
          action: InvestmentAction.BUY,
          transactionDate: "2025-01-15",
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(investmentTransactionsRepository.create).not.toHaveBeenCalled();
    });

    it("refuses a BUY priced at zero, which ADD_SHARES exists to record", async () => {
      await expect(
        service.create(userId, {
          accountId,
          securityId,
          action: InvestmentAction.BUY,
          transactionDate: "2025-01-15",
          quantity: 10,
          price: 0,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("stores no price at all for shares added without one", async () => {
      // ADD_SHARES is the action for units whose cost is not known. It must
      // persist that as null: written as 0 it is indistinguishable from a
      // free acquisition, and the replay can no longer refuse to price it.
      await service.create(userId, {
        accountId,
        securityId,
        action: InvestmentAction.ADD_SHARES,
        transactionDate: "2025-01-15",
        quantity: 10,
      });

      expect(investmentTransactionsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ price: null, totalAmount: 0 }),
      );
    });

    it("stores the price a valid BUY was given", async () => {
      await service.create(userId, {
        accountId,
        securityId,
        action: InvestmentAction.BUY,
        transactionDate: "2025-01-15",
        quantity: 10,
        price: 25,
        commission: 5,
      });

      expect(investmentTransactionsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ price: 25, totalAmount: 255 }),
      );
    });
  });

  describe("resolveCashExchangeRateOrNull (issue #1167)", () => {
    const crossCurrency = () => {
      accountsService.findOne.mockImplementation((_u: string, id: string) =>
        id === accountId
          ? Promise.resolve({ ...mockInvestmentAccount })
          : id === cashAccountId
            ? Promise.resolve({ ...mockCashAccount, currencyCode: "CAD" })
            : Promise.resolve(null),
      );
      securitiesService.findOne.mockResolvedValue({
        ...mockSecurity,
        currencyCode: "EUR",
      });
    };

    it("returns null (not throw) when a cross-currency rate is unavailable", async () => {
      crossCurrency();
      exchangeRateService.getLatestRate.mockResolvedValue(null);
      exchangeRateService.getRateForDate.mockResolvedValue(null);

      const rate = await service.resolveCashExchangeRateOrNull(
        userId,
        accountId,
        null,
        securityId,
        undefined,
        undefined,
      );
      expect(rate).toBeNull();
    });

    it("returns the resolved rate for a cross-currency pair", async () => {
      crossCurrency();
      exchangeRateService.getRateForDate.mockResolvedValue(1.35);

      const rate = await service.resolveCashExchangeRateOrNull(
        userId,
        accountId,
        null,
        securityId,
        undefined,
        undefined,
      );
      expect(rate).toBe(1.35);
      // No date means today, answered by the dated path, never the latest row.
      expect(exchangeRateService.getRateForDate).toHaveBeenCalledWith(
        "EUR",
        "CAD",
        todayYMD(),
      );
      expect(exchangeRateService.getLatestRate).not.toHaveBeenCalled();
    });

    it("uses the date-aware (provider-capable) path when a date is supplied", async () => {
      // The forecast passes today's date so it resolves through the same path as
      // posting: getRateForDate can obtain a rate the stored snapshot lacks
      // (issue #1167 re-review). getLatestRate alone would miss it.
      crossCurrency();
      exchangeRateService.getLatestRate.mockResolvedValue(null);
      exchangeRateService.getRateForDate.mockResolvedValue(1.35);

      const rate = await service.resolveCashExchangeRateOrNull(
        userId,
        accountId,
        null,
        securityId,
        undefined,
        new Date("2026-08-18T00:00:00.000Z"),
      );
      expect(rate).toBe(1.35);
      expect(exchangeRateService.getRateForDate).toHaveBeenCalledWith(
        "EUR",
        "CAD",
        expect.any(Date),
      );
    });

    it("returns 1 for a same-currency pair (never null)", async () => {
      accountsService.findOne.mockResolvedValue({ ...mockInvestmentAccount });
      securitiesService.findOne.mockResolvedValue({ ...mockSecurity }); // USD

      const rate = await service.resolveCashExchangeRateOrNull(
        userId,
        accountId,
        null,
        securityId,
        undefined,
        undefined,
      );
      expect(rate).toBe(1);
    });

    it("still throws for a non-positive supplied rate (a caller error, not a missing rate)", async () => {
      await expect(
        service.resolveCashExchangeRateOrNull(
          userId,
          accountId,
          null,
          securityId,
          0,
          undefined,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("normalizes an explicit non-1 rate to 1 for a same-currency pair -- same-currency dominates (R12-F1)", async () => {
      // The security and cash account are both USD, so the settlement pair is
      // USD->USD. A supplied 1.50 (e.g. a rate that was legitimate before the
      // security's currency changed to the cash currency, then explicitly
      // re-entered) must resolve to 1, never convert the amount away from par.
      accountsService.findOne.mockResolvedValue({ ...mockInvestmentAccount });
      securitiesService.findOne.mockResolvedValue({ ...mockSecurity }); // USD

      const rate = await service.resolveCashExchangeRateOrNull(
        userId,
        accountId,
        null,
        securityId,
        1.5,
        undefined,
      );
      expect(rate).toBe(1);
    });
  });

  describe("resolveSettlementCurrencyPair (issue #1167)", () => {
    it("pairs the security currency with the linked cash account currency", async () => {
      accountsService.findOne.mockImplementation((_u: string, id: string) =>
        id === accountId
          ? Promise.resolve({ ...mockInvestmentAccount })
          : id === cashAccountId
            ? Promise.resolve({ ...mockCashAccount, currencyCode: "CAD" })
            : Promise.resolve(null),
      );
      securitiesService.findOne.mockResolvedValue({
        ...mockSecurity,
        currencyCode: "EUR",
      });

      const pair = await service.resolveSettlementCurrencyPair(
        userId,
        accountId,
        null,
        securityId,
      );
      expect(pair).toEqual({ from: "EUR", to: "CAD" });
    });

    it("uses the funding account currency as the settlement target", async () => {
      accountsService.findOne.mockImplementation((_u: string, id: string) =>
        id === fundingAccountId
          ? Promise.resolve({ ...mockFundingAccount, currencyCode: "GBP" })
          : Promise.resolve({ ...mockInvestmentAccount }),
      );
      securitiesService.findOne.mockResolvedValue({
        ...mockSecurity,
        currencyCode: "EUR",
      });

      const pair = await service.resolveSettlementCurrencyPair(
        userId,
        accountId,
        fundingAccountId,
        securityId,
      );
      expect(pair).toEqual({ from: "EUR", to: "GBP" });
    });

    it("falls back to the account currency when there is no security", async () => {
      accountsService.findOne.mockImplementation((_u: string, id: string) =>
        id === accountId
          ? Promise.resolve({ ...mockInvestmentAccount, currencyCode: "JPY" })
          : id === cashAccountId
            ? Promise.resolve({ ...mockCashAccount, currencyCode: "JPY" })
            : Promise.resolve(null),
      );

      const pair = await service.resolveSettlementCurrencyPair(
        userId,
        accountId,
        null,
        null,
      );
      expect(pair).toEqual({ from: "JPY", to: "JPY" });
      expect(securitiesService.findOne).not.toHaveBeenCalled();
    });
  });

  describe("findCashAccount (via create)", () => {
    beforeEach(() => {
      const findOneQB = createMockQueryBuilder(mockBuyTransaction);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        findOneQB,
      );
    });

    it("returns linked cash account for brokerage account with linkedAccountId", async () => {
      accountsService.findOne.mockImplementation((uid: string, aid: string) => {
        if (aid === accountId) return Promise.resolve(mockInvestmentAccount);
        if (aid === cashAccountId) return Promise.resolve(mockCashAccount);
        return Promise.reject(new NotFoundException("Account not found"));
      });

      await service.create(userId, {
        accountId,
        securityId,
        action: InvestmentAction.BUY,
        transactionDate: "2025-01-15",
        quantity: 1,
        price: 100,
      });

      // Cash transaction should use the linked cash account
      expect(transactionRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: cashAccountId,
        }),
      );
    });

    it("returns same account when account has no linked account", async () => {
      const standaloneInvestmentAccount = {
        ...mockInvestmentAccount,
        accountSubType: AccountSubType.INVESTMENT_CASH,
        linkedAccountId: null,
      };

      accountsService.findOne.mockImplementation((uid: string, aid: string) => {
        if (aid === accountId)
          return Promise.resolve(standaloneInvestmentAccount);
        return Promise.reject(new NotFoundException("Account not found"));
      });

      await service.create(userId, {
        accountId,
        securityId,
        action: InvestmentAction.BUY,
        transactionDate: "2025-01-15",
        quantity: 1,
        price: 100,
      });

      // Cash transaction should use the same account
      expect(transactionRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId,
        }),
      );
    });

    it("returns same account when account is not INVESTMENT_BROKERAGE subtype", async () => {
      const nonBrokerageAccount = {
        ...mockInvestmentAccount,
        accountSubType: null,
        linkedAccountId: null,
      };

      accountsService.findOne.mockImplementation((uid: string, aid: string) => {
        if (aid === accountId) return Promise.resolve(nonBrokerageAccount);
        return Promise.reject(new NotFoundException("Account not found"));
      });

      await service.create(userId, {
        accountId,
        securityId,
        action: InvestmentAction.BUY,
        transactionDate: "2025-01-15",
        quantity: 1,
        price: 100,
      });

      expect(transactionRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId,
        }),
      );
    });
  });

  describe("formatInvestmentCashPayeeName (via create)", () => {
    beforeEach(() => {
      accountsService.findOne.mockImplementation((uid: string, aid: string) => {
        if (aid === accountId) return Promise.resolve(mockInvestmentAccount);
        if (aid === cashAccountId) return Promise.resolve(mockCashAccount);
        return Promise.reject(new NotFoundException("Account not found"));
      });
    });

    it("formats BUY payee as 'Buy: SYMBOL qty @ $price'", async () => {
      const savedTx = {
        ...mockBuyTransaction,
        securityId,
        quantity: 10,
        price: 150.25,
        totalAmount: 1502.5,
      };
      investmentTransactionsRepository.save.mockResolvedValue(savedTx);

      const findOneQB = createMockQueryBuilder(savedTx);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        findOneQB,
      );

      await service.create(userId, {
        accountId,
        securityId,
        action: InvestmentAction.BUY,
        transactionDate: "2025-01-15",
        quantity: 10,
        price: 150.25,
      });

      expect(transactionRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          // Exact, because the shared formatter is what the .mny and QIF
          // importers now write too, and a `toContain` cannot see a format
          // drift between the three (issue #1204).
          payeeName: "Buy: AAPL 10 @ $150.25",
        }),
      );
      expect(transactionRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          payeeName: expect.stringContaining("AAPL"),
        }),
      );
    });

    it("formats DIVIDEND payee as 'Dividend: SYMBOL $amount'", async () => {
      const savedTx = {
        ...mockDividendTransaction,
        securityId,
        quantity: 1,
        price: 25,
        totalAmount: 25,
      };
      investmentTransactionsRepository.save.mockResolvedValue(savedTx);

      const findOneQB = createMockQueryBuilder(savedTx);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        findOneQB,
      );

      await service.create(userId, {
        accountId,
        securityId,
        action: InvestmentAction.DIVIDEND,
        transactionDate: "2025-03-15",
        price: 25,
      });

      expect(transactionRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          payeeName: expect.stringContaining("Dividend:"),
        }),
      );
      expect(transactionRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          payeeName: expect.stringContaining("AAPL"),
        }),
      );
    });

    it("formats INTEREST payee as 'Interest: $amount' without symbol", async () => {
      const savedTx = {
        id: transactionId,
        userId,
        accountId,
        securityId: null,
        fundingAccountId: null,
        transactionId: null,
        action: InvestmentAction.INTEREST,
        transactionDate: "2025-03-15",
        quantity: 0,
        price: 12.5,
        commission: 0,
        totalAmount: 12.5,
      };
      investmentTransactionsRepository.save.mockResolvedValue(savedTx);

      const findOneQB = createMockQueryBuilder(savedTx);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        findOneQB,
      );

      await service.create(userId, {
        accountId,
        action: InvestmentAction.INTEREST,
        transactionDate: "2025-03-15",
        price: 12.5,
      });

      expect(transactionRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          payeeName: expect.stringContaining("Interest:"),
        }),
      );
    });

    it("formats CAPITAL_GAIN payee as 'Capital Gain: SYMBOL $amount'", async () => {
      const savedTx = {
        id: transactionId,
        userId,
        accountId,
        securityId,
        fundingAccountId: null,
        transactionId: null,
        action: InvestmentAction.CAPITAL_GAIN,
        transactionDate: "2025-03-15",
        quantity: 0,
        price: 500,
        commission: 0,
        totalAmount: 500,
      };
      investmentTransactionsRepository.save.mockResolvedValue(savedTx);

      const findOneQB = createMockQueryBuilder(savedTx);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        findOneQB,
      );

      await service.create(userId, {
        accountId,
        securityId,
        action: InvestmentAction.CAPITAL_GAIN,
        transactionDate: "2025-03-15",
        price: 500,
      });

      expect(transactionRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          payeeName: expect.stringContaining("Capital Gain:"),
        }),
      );
    });

    it("uses 'Unknown' when security has no symbol", async () => {
      // Security with null symbol scenario - securityId is null on the transaction
      const savedTx = {
        id: transactionId,
        userId,
        accountId,
        securityId: null,
        fundingAccountId: null,
        transactionId: null,
        action: InvestmentAction.DIVIDEND,
        transactionDate: "2025-03-15",
        quantity: 1,
        price: 25,
        commission: 0,
        totalAmount: 25,
      };
      investmentTransactionsRepository.save.mockResolvedValue(savedTx);

      const findOneQB = createMockQueryBuilder(savedTx);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        findOneQB,
      );

      await service.create(userId, {
        accountId,
        action: InvestmentAction.DIVIDEND,
        transactionDate: "2025-03-15",
        price: 25,
      });

      // symbol is null because securityId is null
      expect(transactionRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          payeeName: expect.stringContaining("Unknown"),
        }),
      );
    });
  });

  describe("createCashTransaction (via create)", () => {
    beforeEach(() => {
      accountsService.findOne.mockImplementation((uid: string, aid: string) => {
        if (aid === accountId) return Promise.resolve(mockInvestmentAccount);
        if (aid === cashAccountId) return Promise.resolve(mockCashAccount);
        return Promise.reject(new NotFoundException("Account not found"));
      });

      const findOneQB = createMockQueryBuilder(mockBuyTransaction);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        findOneQB,
      );
    });

    it("gives the cash leg the investment row's status, defaulting to UNRECONCILED", async () => {
      await service.create(userId, {
        accountId,
        securityId,
        action: InvestmentAction.BUY,
        transactionDate: "2025-01-15",
        quantity: 10,
        price: 100,
      });

      // The old contract hard-coded CLEARED here; the two rows are one event,
      // so the leg now inherits the row's status instead.
      expect(transactionRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          status: TransactionStatus.UNRECONCILED,
        }),
      );

      transactionRepository.create.mockClear();
      await service.create(userId, {
        accountId,
        securityId,
        action: InvestmentAction.BUY,
        transactionDate: "2025-01-15",
        quantity: 10,
        price: 100,
        status: TransactionStatus.RECONCILED,
      });

      expect(transactionRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          status: TransactionStatus.RECONCILED,
        }),
      );
    });

    it("uses cash account currency code", async () => {
      await service.create(userId, {
        accountId,
        securityId,
        action: InvestmentAction.BUY,
        transactionDate: "2025-01-15",
        quantity: 10,
        price: 100,
      });

      expect(transactionRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          currencyCode: "USD",
        }),
      );
    });

    it("sets exchangeRate to 1 when security and cash currencies match", async () => {
      await service.create(userId, {
        accountId,
        securityId,
        action: InvestmentAction.BUY,
        transactionDate: "2025-01-15",
        quantity: 10,
        price: 100,
      });

      expect(transactionRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          exchangeRate: 1,
        }),
      );
      // Should not look up a market rate when currencies match
      expect(exchangeRateService.getLatestRate).not.toHaveBeenCalled();
    });

    it("converts cash amount using the rate for the transaction date when currencies differ", async () => {
      // USD security bought inside a CAD brokerage/cash account
      const cadCashAccount = { ...mockCashAccount, currencyCode: "CAD" };
      const cadInvestmentAccount = {
        ...mockInvestmentAccount,
        currencyCode: "CAD",
      };
      accountsService.findOne.mockImplementation(
        (_uid: string, aid: string) => {
          if (aid === accountId) return Promise.resolve(cadInvestmentAccount);
          if (aid === cashAccountId) return Promise.resolve(cadCashAccount);
          return Promise.reject(new NotFoundException("Account not found"));
        },
      );
      exchangeRateService.getRateForDate.mockResolvedValue(1.365);

      await service.create(userId, {
        accountId,
        securityId,
        action: InvestmentAction.BUY,
        transactionDate: "2025-01-15",
        quantity: 10,
        price: 100,
      });

      // Market rate lookup should happen in the security->cash direction, on the
      // transaction's own date
      expect(exchangeRateService.getRateForDate).toHaveBeenCalledWith(
        "USD",
        "CAD",
        "2025-01-15",
      );
      expect(exchangeRateService.getLatestRate).not.toHaveBeenCalled();

      // Investment transaction keeps the source-currency amount but stores the rate
      expect(investmentTransactionsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          totalAmount: 1000,
          exchangeRate: 1.365,
        }),
      );

      // Cash transaction is posted in the cash account's currency
      expect(transactionRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: cashAccountId,
          currencyCode: "CAD",
          // -1000 USD * 1.365 = -1365 CAD
          amount: -1365,
          exchangeRate: 1.365,
        }),
      );
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        cashAccountId,
        -1365,
      );
    });

    it("rejects a cross-currency buy when no exchange rate can be determined (issue #744)", async () => {
      // USD security funded from a CAD cash account, with neither a dated rate
      // nor anything else. Previously this silently posted at rate 1.0 and
      // corrupted the cash balance; now it must reject so the caller can supply
      // an explicit exchangeRate. A latest stored snapshot is not a fallback: a
      // back-dated trade priced at today's rate is the wrong rate, not a rate.
      const cadCashAccount = { ...mockCashAccount, currencyCode: "CAD" };
      const cadInvestmentAccount = {
        ...mockInvestmentAccount,
        currencyCode: "CAD",
      };
      accountsService.findOne.mockImplementation(
        (_uid: string, aid: string) => {
          if (aid === accountId) return Promise.resolve(cadInvestmentAccount);
          if (aid === cashAccountId) return Promise.resolve(cadCashAccount);
          return Promise.reject(new NotFoundException("Account not found"));
        },
      );
      exchangeRateService.getRateForDate.mockResolvedValue(null);
      // A snapshot exists, and must not be reached for.
      exchangeRateService.getLatestRate.mockResolvedValue(1.99);

      await expect(
        service.create(userId, {
          accountId,
          securityId,
          action: InvestmentAction.BUY,
          transactionDate: "2025-01-15",
          quantity: 10,
          price: 100,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(exchangeRateService.getLatestRate).not.toHaveBeenCalled();
      expect(investmentTransactionsRepository.create).not.toHaveBeenCalled();
      expect(transactionRepository.create).not.toHaveBeenCalled();
    });

    it("prices a posting with no transaction date at today's rate for date, never the latest snapshot", async () => {
      const cadCashAccount = { ...mockCashAccount, currencyCode: "CAD" };
      const cadInvestmentAccount = {
        ...mockInvestmentAccount,
        currencyCode: "CAD",
      };
      accountsService.findOne.mockImplementation(
        (_uid: string, aid: string) => {
          if (aid === accountId) return Promise.resolve(cadInvestmentAccount);
          if (aid === cashAccountId) return Promise.resolve(cadCashAccount);
          return Promise.reject(new NotFoundException("Account not found"));
        },
      );
      exchangeRateService.getRateForDate.mockResolvedValue(null);
      exchangeRateService.getLatestRate.mockResolvedValue(1.99);

      const rate = await service.resolveCashExchangeRateOrNull(
        userId,
        accountId,
        cashAccountId,
        securityId,
        undefined,
      );

      expect(rate).toBeNull();
      expect(exchangeRateService.getRateForDate).toHaveBeenCalledWith(
        "USD",
        "CAD",
        todayYMD(),
      );
      expect(exchangeRateService.getLatestRate).not.toHaveBeenCalled();
    });

    it("answers null from the forecast variant when no rate exists for the date", async () => {
      const cadCashAccount = { ...mockCashAccount, currencyCode: "CAD" };
      const cadInvestmentAccount = {
        ...mockInvestmentAccount,
        currencyCode: "CAD",
      };
      accountsService.findOne.mockImplementation(
        (_uid: string, aid: string) => {
          if (aid === accountId) return Promise.resolve(cadInvestmentAccount);
          if (aid === cashAccountId) return Promise.resolve(cadCashAccount);
          return Promise.reject(new NotFoundException("Account not found"));
        },
      );
      exchangeRateService.getRateForDate.mockResolvedValue(null);
      exchangeRateService.getLatestRate.mockResolvedValue(1.99);

      const rate = await service.resolveCashExchangeRateOrNull(
        userId,
        accountId,
        cashAccountId,
        securityId,
        undefined,
        "2025-01-15",
      );

      expect(rate).toBeNull();
      expect(exchangeRateService.getLatestRate).not.toHaveBeenCalled();
    });

    it("uses the rate for the transaction date when available (issue #744)", async () => {
      // A back-dated cross-currency buy (USD security funded from a CAD cash
      // account) converts at the dated rate, not the latest snapshot or a
      // silent 1.0.
      const cadCashAccount = { ...mockCashAccount, currencyCode: "CAD" };
      const cadInvestmentAccount = {
        ...mockInvestmentAccount,
        currencyCode: "CAD",
      };
      accountsService.findOne.mockImplementation(
        (_uid: string, aid: string) => {
          if (aid === accountId) return Promise.resolve(cadInvestmentAccount);
          if (aid === cashAccountId) return Promise.resolve(cadCashAccount);
          return Promise.reject(new NotFoundException("Account not found"));
        },
      );
      exchangeRateService.getRateForDate.mockResolvedValue(1.31);
      exchangeRateService.getLatestRate.mockResolvedValue(1.99);

      await service.create(userId, {
        accountId,
        securityId,
        action: InvestmentAction.BUY,
        transactionDate: "2025-01-15",
        quantity: 10,
        price: 100,
      });

      expect(exchangeRateService.getRateForDate).toHaveBeenCalledWith(
        "USD",
        "CAD",
        "2025-01-15",
      );
      // The latest snapshot is not consulted once the dated rate resolves.
      expect(exchangeRateService.getLatestRate).not.toHaveBeenCalled();
      expect(investmentTransactionsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ exchangeRate: 1.31 }),
      );
    });

    it("uses an explicit DTO exchangeRate override when provided", async () => {
      const cadCashAccount = { ...mockCashAccount, currencyCode: "CAD" };
      const cadInvestmentAccount = {
        ...mockInvestmentAccount,
        currencyCode: "CAD",
      };
      accountsService.findOne.mockImplementation(
        (_uid: string, aid: string) => {
          if (aid === accountId) return Promise.resolve(cadInvestmentAccount);
          if (aid === cashAccountId) return Promise.resolve(cadCashAccount);
          return Promise.reject(new NotFoundException("Account not found"));
        },
      );
      exchangeRateService.getLatestRate.mockResolvedValue(1.35);

      await service.create(userId, {
        accountId,
        securityId,
        action: InvestmentAction.BUY,
        transactionDate: "2025-01-15",
        quantity: 10,
        price: 100,
        exchangeRate: 1.42,
      });

      // Explicit rate wins — no market lookup required
      expect(exchangeRateService.getLatestRate).not.toHaveBeenCalled();
      expect(investmentTransactionsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          exchangeRate: 1.42,
        }),
      );
      expect(transactionRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          // -1000 USD * 1.42 = -1420 CAD
          amount: -1420,
          exchangeRate: 1.42,
        }),
      );
    });

    it("converts SELL proceeds into the cash account currency", async () => {
      const cadCashAccount = { ...mockCashAccount, currencyCode: "CAD" };
      const cadInvestmentAccount = {
        ...mockInvestmentAccount,
        currencyCode: "CAD",
      };
      accountsService.findOne.mockImplementation(
        (_uid: string, aid: string) => {
          if (aid === accountId) return Promise.resolve(cadInvestmentAccount);
          if (aid === cashAccountId) return Promise.resolve(cadCashAccount);
          return Promise.reject(new NotFoundException("Account not found"));
        },
      );
      exchangeRateService.getRateForDate.mockResolvedValue(1.3);

      await service.create(userId, {
        accountId,
        securityId,
        action: InvestmentAction.SELL,
        transactionDate: "2025-02-15",
        quantity: 5,
        price: 200,
      });

      expect(transactionRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: cashAccountId,
          currencyCode: "CAD",
          // +1000 USD * 1.3 = +1300 CAD
          amount: 1300,
          exchangeRate: 1.3,
        }),
      );
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        cashAccountId,
        1300,
      );
    });

    it("converts DIVIDEND income into the cash account currency", async () => {
      const cadCashAccount = { ...mockCashAccount, currencyCode: "CAD" };
      const cadInvestmentAccount = {
        ...mockInvestmentAccount,
        currencyCode: "CAD",
      };
      accountsService.findOne.mockImplementation(
        (_uid: string, aid: string) => {
          if (aid === accountId) return Promise.resolve(cadInvestmentAccount);
          if (aid === cashAccountId) return Promise.resolve(cadCashAccount);
          return Promise.reject(new NotFoundException("Account not found"));
        },
      );
      exchangeRateService.getRateForDate.mockResolvedValue(1.4);

      await service.create(userId, {
        accountId,
        securityId,
        action: InvestmentAction.DIVIDEND,
        transactionDate: "2025-03-15",
        quantity: 1,
        price: 50,
      });

      expect(transactionRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: cashAccountId,
          currencyCode: "CAD",
          // +50 USD * 1.4 = +70 CAD
          amount: 70,
          exchangeRate: 1.4,
        }),
      );
    });

    it("sets payeeId to null (display-only payee name)", async () => {
      await service.create(userId, {
        accountId,
        securityId,
        action: InvestmentAction.BUY,
        transactionDate: "2025-01-15",
        quantity: 10,
        price: 100,
      });

      expect(transactionRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          payeeId: null,
        }),
      );
    });

    it("uses investment transaction date for the cash transaction", async () => {
      await service.create(userId, {
        accountId,
        securityId,
        action: InvestmentAction.BUY,
        transactionDate: "2025-06-15",
        quantity: 10,
        price: 100,
      });

      expect(transactionRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          transactionDate: "2025-06-15",
        }),
      );
    });

    it("rounds cash amount to the currency's precision to prevent sub-cent drift", async () => {
      // Regression: 0.1985 shares * $50.01 = $9.926985, which previously
      // was rounded to 4 decimals ($9.9270) and stored as the cash amount.
      // Over repeated transactions where the user also received a clean
      // $9.93 dividend, the sub-cent residue accumulated as a visible
      // 1-cent drift in the displayed cash balance. Cash should only ever
      // move in whole cents (for 2-decimal currencies).
      await service.create(userId, {
        accountId,
        securityId,
        action: InvestmentAction.BUY,
        transactionDate: "2025-01-15",
        quantity: 0.1985,
        price: 50.01,
        commission: 0,
      });

      // Cash transaction amount is rounded to 2 decimals for USD
      expect(transactionRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: -9.93,
        }),
      );

      // Balance update uses the same rounded amount, so the cash balance
      // cleanly mirrors what the user sees (e.g. $1.51 + $9.93 - $9.93 = $1.51)
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        cashAccountId,
        -9.93,
      );
    });

    it("honours a 3-decimal currency (BHD) when rounding cash amounts", async () => {
      // BHD has decimalPlaces=3, so the cash amount should retain 3 decimals
      // instead of being over-rounded to 2.
      const bhdCashAccount = { ...mockCashAccount, currencyCode: "BHD" };
      const bhdInvestmentAccount = {
        ...mockInvestmentAccount,
        currencyCode: "BHD",
      };
      const bhdSecurity = { ...mockSecurity, currencyCode: "BHD" };

      accountsService.findOne.mockImplementation(
        (_uid: string, aid: string) => {
          if (aid === accountId) return Promise.resolve(bhdInvestmentAccount);
          if (aid === cashAccountId) return Promise.resolve(bhdCashAccount);
          return Promise.reject(new NotFoundException("Account not found"));
        },
      );
      securitiesService.findOne.mockResolvedValue(bhdSecurity);
      currenciesService.findOne.mockImplementation((code: string) =>
        Promise.resolve({
          code,
          name: code,
          symbol: code,
          decimalPlaces: code === "BHD" ? 3 : 2,
          isActive: true,
          createdByUserId: null,
          createdAt: new Date(),
        }),
      );

      await service.create(userId, {
        accountId,
        securityId,
        action: InvestmentAction.BUY,
        transactionDate: "2025-01-15",
        quantity: 0.1985,
        price: 50.01,
        commission: 0,
      });

      // 0.1985 * 50.01 = 9.926985 -> rounded to 3 decimals = 9.927
      expect(transactionRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: -9.927,
        }),
      );
    });
  });

  describe("future-dated transactions", () => {
    const createBuyDto = {
      accountId,
      securityId,
      action: InvestmentAction.BUY,
      transactionDate: "2027-06-15",
      quantity: 10,
      price: 150,
      commission: 9.99,
      description: "Future Buy AAPL",
    };

    beforeEach(() => {
      mockedIsTransactionInFuture.mockReturnValue(true);

      accountsService.findOne.mockImplementation((uid: string, aid: string) => {
        if (aid === accountId) return Promise.resolve(mockInvestmentAccount);
        if (aid === cashAccountId) return Promise.resolve(mockCashAccount);
        if (aid === fundingAccountId)
          return Promise.resolve(mockFundingAccount);
        return Promise.reject(new NotFoundException("Account not found"));
      });
    });

    it("re-derives the position for a future-dated BUY, which the cutoff excludes", async () => {
      const savedTx = {
        ...mockBuyTransaction,
        transactionDate: "2027-06-15",
      };
      investmentTransactionsRepository.save.mockResolvedValue(savedTx);

      const findOneQB = createMockQueryBuilder(savedTx);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        findOneQB,
      );

      await service.create(userId, createBuyDto);

      // The row is future-dated, so `transaction_date <= cutoff` leaves it out
      // of the replay -- the exclusion is the rebuild's, and is covered in
      // holdings.service.spec.ts. What this path owes is the request.
      expect(
        holdingsService.rebuildScopesFromTransactions,
      ).toHaveBeenCalledWith(
        userId,
        [{ accountId, securityId }],
        expect.anything(),
      );
    });

    it("does NOT create a cash transaction for a future-dated BUY", async () => {
      const savedTx = {
        ...mockBuyTransaction,
        transactionDate: "2027-06-15",
      };
      investmentTransactionsRepository.save.mockResolvedValue(savedTx);

      const findOneQB = createMockQueryBuilder(savedTx);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        findOneQB,
      );

      await service.create(userId, createBuyDto);

      // Future-dated investments DO create a linked cash transaction so it
      // shows in the cash account's ledger as a projected entry. Holdings
      // and the account currentBalance still wait until the date arrives.
      expect(transactionRepository.create).toHaveBeenCalled();
      expect(accountsService.updateBalance).not.toHaveBeenCalled();
    });

    it("re-derives the position for a future-dated SELL, which the cutoff excludes", async () => {
      const sellDto = {
        accountId,
        securityId,
        action: InvestmentAction.SELL,
        transactionDate: "2027-06-15",
        quantity: 5,
        price: 160,
        commission: 9.99,
      };

      const savedTx = {
        ...mockSellTransaction,
        transactionDate: "2027-06-15",
      };
      investmentTransactionsRepository.save.mockResolvedValue(savedTx);

      const findOneQB = createMockQueryBuilder(savedTx);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        findOneQB,
      );

      await service.create(userId, sellDto);

      expect(holdingsService.rebuildScopesFromTransactions).toHaveBeenCalled();
      // The cash side IS created so the user sees the projected proceeds.
      expect(transactionRepository.create).toHaveBeenCalled();
    });

    it("re-derives the position when deleting a future-dated transaction", async () => {
      const futureTx = {
        ...mockBuyTransaction,
        transactionDate: "2027-06-15",
        transactionId: cashTransactionId,
      };
      const mockQB = createMockQueryBuilder(futureTx);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        mockQB,
      );

      await service.remove(userId, transactionId);

      expect(holdingsService.rebuildScopesFromTransactions).toHaveBeenCalled();
      expect(accountsService.updateBalance).not.toHaveBeenCalled();
      // The linked cash transaction (which was created with the future date)
      // is torn down with the investment row.
      expect(investmentTransactionsRepository.remove).toHaveBeenCalledWith(
        futureTx,
      );
    });

    it("still saves the investment transaction record for future-dated BUY", async () => {
      const savedTx = {
        ...mockBuyTransaction,
        transactionDate: "2027-06-15",
      };
      investmentTransactionsRepository.save.mockResolvedValue(savedTx);

      const findOneQB = createMockQueryBuilder(savedTx);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        findOneQB,
      );

      const result = await service.create(userId, createBuyDto);

      expect(investmentTransactionsRepository.create).toHaveBeenCalled();
      expect(investmentTransactionsRepository.save).toHaveBeenCalled();
      expect(result).toEqual(savedTx);
    });
  });

  describe("transaction atomicity", () => {
    const createBuyDto = {
      accountId,
      securityId,
      action: InvestmentAction.BUY,
      transactionDate: "2025-01-15",
      quantity: 10,
      price: 150,
    };

    beforeEach(() => {
      accountsService.findOne.mockImplementation((uid: string, aid: string) => {
        if (aid === accountId) return Promise.resolve(mockInvestmentAccount);
        if (aid === cashAccountId) return Promise.resolve(mockCashAccount);
        if (aid === fundingAccountId)
          return Promise.resolve(mockFundingAccount);
        return Promise.reject(new NotFoundException("Account not found"));
      });
    });

    it("create runs its writes in one scoped transaction", async () => {
      const savedTx = {
        id: "inv-tx-1",
        ...createBuyDto,
        userId,
        totalAmount: 1500,
        commission: 0,
        exchangeRate: 1,
        fundingAccountId: null,
        transactionId: "cash-tx-1",
        account: mockInvestmentAccount,
        security: mockSecurity,
      };

      investmentTransactionsRepository.save.mockResolvedValue(savedTx);
      transactionRepository.save.mockResolvedValue({
        id: "cash-tx-1",
        amount: -1500,
      });

      const findOneQB = createMockQueryBuilder(savedTx);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        findOneQB,
      );

      await service.create(userId, createBuyDto);

      expect(dataSource.transaction).toHaveBeenCalled();
      expect(mockQueryRunner.manager.save).toHaveBeenCalled();
    });

    it("create propagates a write failure out of the transaction", async () => {
      investmentTransactionsRepository.save.mockRejectedValue(
        new Error("DB error"),
      );

      await expect(service.create(userId, createBuyDto)).rejects.toThrow(
        "DB error",
      );

      // The transaction rolled back, so none of the post-commit side effects
      // (price upsert, history record) ran.
      expect(dataSource.transaction).toHaveBeenCalled();
      expect(mockActionHistoryService.record).not.toHaveBeenCalled();
    });

    it("update runs its writes in one scoped transaction", async () => {
      const existingTx = {
        id: "inv-tx-1",
        userId,
        accountId,
        securityId,
        action: InvestmentAction.BUY,
        transactionDate: "2025-01-15",
        quantity: 10,
        price: 150,
        totalAmount: 1500,
        commission: 0,
        exchangeRate: 1,
        fundingAccountId: null,
        transactionId: null,
        account: mockInvestmentAccount,
        security: mockSecurity,
      };

      const findOneQB = createMockQueryBuilder(existingTx);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        findOneQB,
      );
      investmentTransactionsRepository.save.mockResolvedValue(existingTx);

      await service.update(userId, "inv-tx-1", { quantity: 20 });

      expect(dataSource.transaction).toHaveBeenCalled();
      expect(mockQueryRunner.manager.save).toHaveBeenCalled();
    });

    it("remove runs its writes in one scoped transaction", async () => {
      const existingTx = {
        id: "inv-tx-1",
        userId,
        accountId,
        securityId,
        action: InvestmentAction.BUY,
        transactionDate: "2025-01-15",
        quantity: 10,
        price: 150,
        totalAmount: 1500,
        commission: 0,
        exchangeRate: 1,
        fundingAccountId: null,
        transactionId: null,
        account: mockInvestmentAccount,
        security: mockSecurity,
      };

      const findOneQB = createMockQueryBuilder(existingTx);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        findOneQB,
      );

      await service.remove(userId, "inv-tx-1");

      expect(dataSource.transaction).toHaveBeenCalled();
      expect(mockQueryRunner.manager.remove).toHaveBeenCalled();
    });

    it("remove propagates a delete failure out of the transaction", async () => {
      const existingTx = {
        id: "inv-tx-1",
        userId,
        accountId,
        securityId,
        action: InvestmentAction.BUY,
        transactionDate: "2025-01-15",
        quantity: 10,
        price: 150,
        totalAmount: 1500,
        commission: 0,
        exchangeRate: 1,
        fundingAccountId: null,
        transactionId: "cash-tx-1",
        account: mockInvestmentAccount,
        security: mockSecurity,
      };

      const findOneQB = createMockQueryBuilder(existingTx);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        findOneQB,
      );

      // Make the cash transaction deletion fail
      transactionRepository.findOne.mockResolvedValue({
        id: "cash-tx-1",
        userId,
        accountId: "cash-acc",
        amount: -1500,
      });
      accountsService.updateBalance.mockRejectedValueOnce(
        new Error("Balance error"),
      );

      await expect(service.remove(userId, "inv-tx-1")).rejects.toThrow(
        "Balance error",
      );

      // Rolled back inside the scoped transaction, so nothing was recorded.
      expect(dataSource.transaction).toHaveBeenCalled();
      expect(mockActionHistoryService.record).not.toHaveBeenCalled();
    });

    /**
     * Advisory locks are taken before row locks (`common/db/locks.ts`). A
     * ledger write that took the holdings advisory lock only inside the
     * rebuild at the end had already row-locked `accounts` for its cash
     * effects -- the opposite order from a split status change, which takes
     * the advisory lock first and then row-locks the legs, so two concurrent
     * writers of one account can deadlock (40P01).
     */
    const lockOrder = (): number => {
      const calls = mockQueryRunner.manager.query.mock.calls as unknown[][];
      const index = calls.findIndex(([sql]) =>
        String(sql).includes("pg_advisory_xact_lock"),
      );
      expect(index).toBeGreaterThanOrEqual(0);
      return mockQueryRunner.manager.query.mock.invocationCallOrder[index];
    };

    /** When the transaction first touched a row lock or wrote anything. */
    const firstRowTouchOrder = (): number =>
      Math.min(
        ...[
          ...mockQueryRunner.manager.save.mock.invocationCallOrder,
          ...accountsService.updateBalance.mock.invocationCallOrder,
          ...mockQueryRunner.manager.remove.mock.invocationCallOrder,
          ...(mockQueryRunner.manager.query.mock.calls as unknown[][])
            .map(([sql], i) =>
              String(sql).includes("FOR UPDATE")
                ? mockQueryRunner.manager.query.mock.invocationCallOrder[i]
                : Number.POSITIVE_INFINITY,
            )
            .filter((n) => Number.isFinite(n)),
          Number.POSITIVE_INFINITY,
        ],
      );

    it("create takes the holdings advisory lock before its first row lock or write", async () => {
      const savedTx = {
        id: "inv-tx-1",
        ...createBuyDto,
        userId,
        totalAmount: 1500,
        commission: 0,
        exchangeRate: 1,
        fundingAccountId: null,
        transactionId: "cash-tx-1",
        account: mockInvestmentAccount,
        security: mockSecurity,
      };
      investmentTransactionsRepository.save.mockResolvedValue(savedTx);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder(savedTx),
      );

      await service.create(userId, createBuyDto);

      expect(lockOrder()).toBeLessThan(firstRowTouchOrder());
    });

    it("remove takes the holdings advisory lock before its first row lock or write", async () => {
      const existingTx = {
        id: "inv-tx-1",
        userId,
        accountId,
        securityId,
        action: InvestmentAction.BUY,
        transactionDate: "2025-01-15",
        quantity: 10,
        price: 150,
        totalAmount: 1500,
        commission: 0,
        exchangeRate: 1,
        fundingAccountId: null,
        transactionId: null,
        account: mockInvestmentAccount,
        security: mockSecurity,
      };
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder(existingTx),
      );

      await service.remove(userId, "inv-tx-1");

      expect(lockOrder()).toBeLessThan(firstRowTouchOrder());
    });

    /**
     * A26-H04: the row the edit or delete decides from is the one under its
     * own lock. A cash leg replaced by a concurrent edit (or a row a
     * concurrent delete removed) is refused before anything is written.
     */
    it("update refuses with 409, writing nothing, when the row's cash leg changed since the read", async () => {
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder(mockBuyTransaction),
      );
      lockedInvestmentRows = async (id: string) => [
        {
          id,
          account_id: accountId,
          security_id: securityId,
          funding_account_id: null,
          transaction_id: "cash-tx-replaced",
          transaction_split_id: null,
          linked_transaction_id: null,
          action: InvestmentAction.BUY,
          transaction_date: "2025-01-15",
          quantity: "10",
          price: "150",
          commission: "9.99",
          total_amount: "1509.99",
          exchange_rate: "1",
          status: TransactionStatus.CLEARED,
        },
      ];

      await expect(
        service.update(userId, transactionId, { price: 160 }),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(mockQueryRunner.manager.save).not.toHaveBeenCalled();
      expect(mockQueryRunner.manager.delete).not.toHaveBeenCalled();
      expect(investmentTransactionsRepository.update).not.toHaveBeenCalled();
    });

    it("remove refuses with 404, writing nothing, when the row was deleted since the read", async () => {
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder(mockBuyTransaction),
      );
      lockedInvestmentRows = async () => [];

      await expect(
        service.remove(userId, transactionId),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(mockQueryRunner.manager.delete).not.toHaveBeenCalled();
      expect(investmentTransactionsRepository.remove).not.toHaveBeenCalled();
      expect(mockActionHistoryService.record).not.toHaveBeenCalled();
    });

    it("update takes the holdings advisory lock before its first row lock or write", async () => {
      const existingTx = {
        id: "inv-tx-1",
        userId,
        accountId,
        securityId,
        action: InvestmentAction.BUY,
        transactionDate: "2025-01-15",
        quantity: 10,
        price: 150,
        totalAmount: 1500,
        commission: 0,
        exchangeRate: 1,
        fundingAccountId: null,
        transactionId: null,
        account: mockInvestmentAccount,
        security: mockSecurity,
      };
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder(existingTx),
      );
      investmentTransactionsRepository.save.mockResolvedValue(existingTx);

      await service.update(userId, "inv-tx-1", { quantity: 20 });

      expect(lockOrder()).toBeLessThan(firstRowTouchOrder());
    });

    /**
     * The rebuild is the ledger write's own last statement, not a follow-up:
     * dispatched after the commit it would read a ledger another writer had
     * already changed, and the position would be written from outside the
     * lock the write took.
     */
    it("rebuilds the position on the transaction's own manager, before the transaction returns", async () => {
      const savedTx = {
        id: "inv-tx-1",
        ...createBuyDto,
        userId,
        totalAmount: 1500,
        commission: 0,
        exchangeRate: 1,
        fundingAccountId: null,
        transactionId: "cash-tx-1",
        account: mockInvestmentAccount,
        security: mockSecurity,
      };
      investmentTransactionsRepository.save.mockResolvedValue(savedTx);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder(savedTx),
      );

      let rebuiltBeforeReturn = false;
      dataSource.transaction.mockImplementation(async (...args: unknown[]) => {
        const fn = (typeof args[0] === "function" ? args[0] : args[1]) as (
          m: unknown,
        ) => Promise<unknown>;
        const result = await fn(mockQueryRunner.manager);
        rebuiltBeforeReturn =
          holdingsService.rebuildScopesFromTransactions.mock.calls.length > 0;
        return result;
      });

      await service.create(userId, createBuyDto);

      expect(rebuiltBeforeReturn).toBe(true);
      expect(
        holdingsService.rebuildScopesFromTransactions,
      ).toHaveBeenCalledWith(
        userId,
        [{ accountId, securityId }],
        mockQueryRunner.manager,
      );
    });
  });

  describe("createEmbeddedForSplit", () => {
    it("refuses an embedded BUY with no price", async () => {
      accountsService.findOne.mockResolvedValue(mockInvestmentAccount);
      securitiesService.findOne.mockResolvedValue(mockSecurity);

      // The split path wrote `dto.price ?? 0`, so this was the way around the
      // guard `create` had: a free purchase inside a split transaction.
      await expect(
        service.createEmbeddedForSplit(
          mockQueryRunner.manager as any,
          userId,
          "2026-05-09",
          "split-1",
          accountId,
          cashAccountId,
          {
            action: InvestmentAction.BUY,
            securityId,
            quantity: 75,
            commission: 0,
          } as never,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    // The cash side of a split and the investment side beside it have to describe
    // the same money. `validateSplits` runs before the security is loaded, so it
    // cannot know a conversion applies and used to assume a rate of 1 -- which
    // demanded the UNCONVERTED cash impact and let the two halves diverge by the
    // whole FX spread. The check therefore also happens here, against the rate
    // actually stored.
    describe("the parent split's cash amount", () => {
      const cadCashAccount = {
        ...mockCashAccount,
        currencyCode: "CAD",
      };

      const runEmbedded = (splitAmount: number) =>
        service.createEmbeddedForSplit(
          mockQueryRunner.manager as never,
          userId,
          "2026-05-09",
          "split-1",
          accountId,
          cashAccountId,
          {
            action: InvestmentAction.BUY,
            securityId,
            quantity: 75,
            price: 10,
            commission: 0,
          },
          splitAmount,
        );

      beforeEach(() => {
        // USD security, CAD cash sleeve, 1.35 on the parent's date.
        accountsService.findOne.mockImplementation((_u: string, id: string) =>
          Promise.resolve(
            id === cashAccountId ? cadCashAccount : mockInvestmentAccount,
          ),
        );
        securitiesService.findOne.mockResolvedValue(mockSecurity);
        exchangeRateService.getRateForDate.mockResolvedValue(1.35);
      });

      it("accepts the cash impact converted at the resolved rate", async () => {
        // 75 x 10 USD = 750 out, x 1.35 = 1012.50 CAD.
        await expect(runEmbedded(-1012.5)).resolves.toBeDefined();
        expect(
          mockQueryRunner.manager.create.mock.calls.at(-1)![1],
        ).toMatchObject({ exchangeRate: 1.35 });
      });

      it("refuses the unconverted amount the old check demanded", async () => {
        await expect(runEmbedded(-750)).rejects.toThrow(
          /converts to -1012.5 at a rate of 1.35/,
        );
        expect(mockQueryRunner.manager.save).not.toHaveBeenCalled();
      });

      it("accepts the 4dp amount a real rate produces, not its cents rounding", async () => {
        // A real FX rate rarely yields a 2dp-clean product, and the amount is
        // stored as decimal(20,4). 75 x 10 USD = 750, x 1.36523 = 1023.9225 CAD.
        // The producer must state that 4dp figure; the cents rounding a
        // 2dp-only producer would send (-1023.92) is off by the sub-cent and
        // must be refused, or the split's two halves disagree again.
        exchangeRateService.getRateForDate.mockResolvedValue(1.36523);
        await expect(runEmbedded(-1023.9225)).resolves.toBeDefined();
        await expect(runEmbedded(-1023.92)).rejects.toThrow(
          /converts to -1023.9225 at a rate of 1.36523/,
        );
      });

      it("has nothing to check when the caller states no split amount", async () => {
        await expect(
          service.createEmbeddedForSplit(
            mockQueryRunner.manager as never,
            userId,
            "2026-05-09",
            "split-1",
            accountId,
            cashAccountId,
            {
              action: InvestmentAction.BUY,
              securityId,
              quantity: 75,
              price: 10,
              commission: 0,
            },
          ),
        ).resolves.toBeDefined();
      });
    });

    it("creates an embedded BUY without spawning a linked cash transaction", async () => {
      accountsService.findOne.mockResolvedValue(mockInvestmentAccount);
      securitiesService.findOne.mockResolvedValue(mockSecurity);
      // resolveCashExchangeRate path: same currency -> rate 1
      exchangeRateService.getLatestRate.mockResolvedValue(1);

      const created = await service.createEmbeddedForSplit(
        mockQueryRunner.manager as any,
        userId,
        "2026-05-09",
        "split-1",
        accountId,
        cashAccountId,
        {
          action: InvestmentAction.BUY,
          securityId,
          quantity: 75,
          price: 10,
          commission: 0,
        },
      );

      // No linked cash transaction created
      const transactionSaves = mockQueryRunner.manager.save.mock.calls.filter(
        ([entity]: any[]) =>
          entity && entity.constructor && entity.constructor.name === "Object",
      );
      expect(transactionSaves.length).toBeGreaterThan(0); // saved the InvestmentTransaction
      expect(
        holdingsService.rebuildScopesFromTransactions,
      ).toHaveBeenCalledWith(
        userId,
        [{ accountId: accountId, securityId: securityId }],
        expect.anything(),
      );
      // The embedded path should never invoke the cash-side balance update
      // for a cash account (only holdings updates).
      expect(accountsService.updateBalance).not.toHaveBeenCalled();

      // The created entity carries the split linkage and a null transactionId
      expect(mockQueryRunner.manager.create).toHaveBeenCalledWith(
        InvestmentTransaction,
        expect.objectContaining({
          transactionSplitId: "split-1",
          transactionId: null,
          accountId,
          securityId,
          action: InvestmentAction.BUY,
          quantity: 75,
          price: 10,
        }),
      );
      expect(created).toBeDefined();
    });

    it("rejects disallowed actions in an embedded split", async () => {
      await expect(
        service.createEmbeddedForSplit(
          mockQueryRunner.manager as any,
          userId,
          "2026-05-09",
          "split-1",
          accountId,
          cashAccountId,
          {
            action: InvestmentAction.ADD_SHARES,
            securityId,
            quantity: 5,
          },
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects non-brokerage target accounts", async () => {
      accountsService.findOne.mockResolvedValueOnce({
        ...mockInvestmentAccount,
        accountSubType: AccountSubType.INVESTMENT_CASH,
      });

      await expect(
        service.createEmbeddedForSplit(
          mockQueryRunner.manager as any,
          userId,
          "2026-05-09",
          "split-1",
          accountId,
          cashAccountId,
          {
            action: InvestmentAction.BUY,
            securityId,
            quantity: 1,
            price: 1,
          },
        ),
      ).rejects.toThrow(/INVESTMENT_BROKERAGE/);
    });

    it("rejects BUY without a securityId", async () => {
      accountsService.findOne.mockResolvedValue(mockInvestmentAccount);

      await expect(
        service.createEmbeddedForSplit(
          mockQueryRunner.manager as any,
          userId,
          "2026-05-09",
          "split-1",
          accountId,
          cashAccountId,
          {
            action: InvestmentAction.BUY,
            // no securityId
            quantity: 5,
            price: 10,
          },
        ),
      ).rejects.toThrow(/Security ID is required/);
    });

    it.each([InvestmentAction.DIVIDEND, InvestmentAction.CAPITAL_GAIN])(
      "rejects %s without a securityId",
      async (action) => {
        accountsService.findOne.mockResolvedValue(mockInvestmentAccount);

        await expect(
          service.createEmbeddedForSplit(
            mockQueryRunner.manager as any,
            userId,
            "2026-05-09",
            "split-1",
            accountId,
            cashAccountId,
            { action, price: 50 },
          ),
        ).rejects.toThrow(/Security ID is required/);
      },
    );

    it("creates a DIVIDEND embedded split (no quantity required)", async () => {
      accountsService.findOne.mockResolvedValue(mockInvestmentAccount);
      securitiesService.findOne.mockResolvedValue(mockSecurity);
      exchangeRateService.getLatestRate.mockResolvedValue(1);

      const created = await service.createEmbeddedForSplit(
        mockQueryRunner.manager as any,
        userId,
        "2026-05-09",
        "split-1",
        accountId,
        cashAccountId,
        {
          action: InvestmentAction.DIVIDEND,
          securityId,
          price: 50, // dividend amount
        },
      );

      // No cash transaction either. A DIVIDEND moves no shares, which is the
      // replay reducer's answer, not something this seam decides.
      expect(accountsService.updateBalance).not.toHaveBeenCalled();
      expect(created).toBeDefined();
      expect(mockQueryRunner.manager.create).toHaveBeenCalledWith(
        InvestmentTransaction,
        expect.objectContaining({
          action: InvestmentAction.DIVIDEND,
          transactionId: null,
          transactionSplitId: "split-1",
        }),
      );
    });

    it("creates a SELL embedded split that updates holdings without cash side", async () => {
      accountsService.findOne.mockResolvedValue(mockInvestmentAccount);
      securitiesService.findOne.mockResolvedValue(mockSecurity);
      exchangeRateService.getLatestRate.mockResolvedValue(1);

      await service.createEmbeddedForSplit(
        mockQueryRunner.manager as any,
        userId,
        "2026-05-09",
        "split-1",
        accountId,
        cashAccountId,
        {
          action: InvestmentAction.SELL,
          securityId,
          quantity: 10,
          price: 50,
          commission: 0,
        },
      );

      expect(
        holdingsService.rebuildScopesFromTransactions,
      ).toHaveBeenCalledWith(
        userId,
        [{ accountId: accountId, securityId: securityId }],
        expect.anything(),
      );
      // Cash side suppressed
      expect(accountsService.updateBalance).not.toHaveBeenCalled();
    });
  });

  describe("update embedded in split", () => {
    const splitId = "split-1";
    const parentTxId = "parent-tx-1";
    const incomeSplitId = "split-income-1";

    const buildEmbeddedBuy = (overrides: Partial<InvestmentTransaction> = {}) =>
      ({
        ...mockBuyTransaction,
        id: transactionId,
        transactionId: null,
        transactionSplitId: splitId,
        quantity: 10,
        price: 100,
        commission: 0,
        totalAmount: 1000,
        exchangeRate: 1,
        ...overrides,
      }) as InvestmentTransaction;

    const wireSplitFetches = (opts: {
      embedded: InvestmentTransaction;
      parentAmount: number;
      siblingIncomeAmount: number;
      parentDate?: string;
    }) => {
      const split: any = {
        id: splitId,
        transactionId: parentTxId,
        amount: Number(opts.embedded.totalAmount) * -1,
      };
      const incomeSplit: any = {
        id: incomeSplitId,
        transactionId: parentTxId,
        amount: opts.siblingIncomeAmount,
      };
      const parentTx: any = {
        id: parentTxId,
        userId,
        accountId: cashAccountId,
        transactionDate: opts.parentDate ?? "2026-01-15",
        amount: opts.parentAmount,
      };

      mockQueryRunner.manager.findOne = jest
        .fn()
        .mockImplementation((Entity: any, query: any) => {
          if (Entity === TransactionSplit) return Promise.resolve(split);
          if (Entity === Transaction) {
            if (query?.where?.id === parentTxId)
              return Promise.resolve(parentTx);
            return transactionRepository.findOne(query);
          }
          return investmentTransactionsRepository.findOne(query);
        });
      mockQueryRunner.manager.find = jest
        .fn()
        .mockImplementation((Entity: any) => {
          if (Entity === TransactionSplit)
            return Promise.resolve([split, incomeSplit]);
          return Promise.resolve([]);
        });
      // The parent amount a delta is derived from is read under a row lock: two
      // concurrent edits to the same parent's splits would otherwise each apply a
      // delta from the same stale amount (audit P4-003).
      mockQueryRunner.manager.query = jest
        .fn()
        .mockImplementation(async (sql: string, params?: unknown[]) =>
          String(sql).includes("FROM investment_transactions")
            ? lockedInvestmentRows(String(params?.[0]))
            : String(sql).includes("FOR UPDATE")
              ? [
                  {
                    id: parentTx.id,
                    account_id: parentTx.accountId,
                    amount: String(parentTx.amount),
                    transaction_date: parentTx.transactionDate,
                    status: null,
                    is_split: true,
                    linked_transaction_id: null,
                    parent_transaction_id: null,
                  },
                ]
              : [],
        );

      return { split, incomeSplit, parentTx };
    };

    beforeEach(() => {
      accountsService.findOne.mockImplementation((uid: string, aid: string) => {
        if (aid === accountId) return Promise.resolve(mockInvestmentAccount);
        if (aid === cashAccountId) return Promise.resolve(mockCashAccount);
        return Promise.reject(new NotFoundException("Account not found"));
      });
    });

    it("does not create a new cash transaction when price changes", async () => {
      const embedded = buildEmbeddedBuy();
      const firstFindQB = createMockQueryBuilder(embedded);
      const secondFindQB = createMockQueryBuilder({
        ...embedded,
        price: 150,
        totalAmount: 1500,
      });
      investmentTransactionsRepository.createQueryBuilder
        .mockReturnValueOnce(firstFindQB)
        .mockReturnValueOnce(secondFindQB);

      wireSplitFetches({
        embedded,
        parentAmount: 0, // $1000 income + -$1000 investment
        siblingIncomeAmount: 1000,
      });

      await service.update(userId, transactionId, { price: 150 });

      // No standalone cash transaction is created on the cash account
      const cashSaves = transactionRepository.save.mock.calls.filter(
        ([data]: any[]) =>
          data && data.accountId === cashAccountId && "amount" in data,
      );
      expect(cashSaves.length).toBe(0);
    });

    it("updates the parent split's amount and parent transaction amount", async () => {
      const embedded = buildEmbeddedBuy();
      const firstFindQB = createMockQueryBuilder(embedded);
      const secondFindQB = createMockQueryBuilder({
        ...embedded,
        price: 150,
        totalAmount: 1500,
      });
      investmentTransactionsRepository.createQueryBuilder
        .mockReturnValueOnce(firstFindQB)
        .mockReturnValueOnce(secondFindQB);

      wireSplitFetches({
        embedded,
        parentAmount: 0,
        siblingIncomeAmount: 1000,
      });

      await service.update(userId, transactionId, { price: 150 });

      // Investment split amount = -(10 * 150) = -1500
      expect(mockQueryRunner.manager.update).toHaveBeenCalledWith(
        TransactionSplit,
        splitId,
        { amount: -1500 },
      );
      // Parent total = income (1000) + investment (-1500) = -500
      expect(mockQueryRunner.manager.update).toHaveBeenCalledWith(
        Transaction,
        parentTxId,
        { amount: -500 },
      );
    });

    it("applies the delta to the cash account balance", async () => {
      const embedded = buildEmbeddedBuy();
      const firstFindQB = createMockQueryBuilder(embedded);
      const secondFindQB = createMockQueryBuilder({
        ...embedded,
        price: 150,
        totalAmount: 1500,
      });
      investmentTransactionsRepository.createQueryBuilder
        .mockReturnValueOnce(firstFindQB)
        .mockReturnValueOnce(secondFindQB);

      wireSplitFetches({
        embedded,
        parentAmount: 0,
        siblingIncomeAmount: 1000,
      });

      await service.update(userId, transactionId, { price: 150 });

      // Old parent amount = 0, new = -500, delta = -500
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        cashAccountId,
        -500,
      );
    });

    it("rejects changing the brokerage account", async () => {
      const embedded = buildEmbeddedBuy();
      const firstFindQB = createMockQueryBuilder(embedded);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValueOnce(
        firstFindQB,
      );

      await expect(
        service.update(userId, transactionId, {
          accountId: "different-account",
        }),
      ).rejects.toThrow(/Cannot change the account/);
    });

    it("rejects changing the transaction date", async () => {
      const embedded = buildEmbeddedBuy();
      const firstFindQB = createMockQueryBuilder(embedded);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValueOnce(
        firstFindQB,
      );

      await expect(
        service.update(userId, transactionId, {
          transactionDate: "2027-01-01",
        }),
      ).rejects.toThrow(/Cannot change the date/);
    });

    it("rejects switching to an action not allowed in splits", async () => {
      const embedded = buildEmbeddedBuy();
      const firstFindQB = createMockQueryBuilder(embedded);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValueOnce(
        firstFindQB,
      );

      await expect(
        service.update(userId, transactionId, {
          action: InvestmentAction.ADD_SHARES,
        }),
      ).rejects.toThrow(/not allowed inside a split/);
    });
  });

  describe("reverseAndRemoveEmbedded", () => {
    it("reverses holdings and removes the row", async () => {
      const embedded: any = {
        id: "emb-1",
        userId,
        accountId,
        securityId,
        action: InvestmentAction.BUY,
        quantity: 5,
        price: 10,
        commission: 0,
        totalAmount: 50,
        exchangeRate: 1,
        transactionDate: "2026-05-09",
        transactionId: null,
        transactionSplitId: "split-1",
      };

      await service.reverseAndRemoveEmbedded(
        mockQueryRunner.manager as any,
        userId,
        embedded,
      );

      // Reverse-of-BUY decrements holdings by qty
      expect(
        holdingsService.rebuildScopesFromTransactions,
      ).toHaveBeenCalledWith(
        userId,
        [{ accountId: accountId, securityId: securityId }],
        expect.anything(),
      );
      expect(mockQueryRunner.manager.remove).toHaveBeenCalledWith(embedded);
    });
  });

  describe("transferSecurity", () => {
    const toAccountId = "account-2";
    const mockToAccount = {
      id: toAccountId,
      userId,
      accountType: "INVESTMENT",
      accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
      linkedAccountId: null,
      currencyCode: "USD",
      name: "Brokerage B",
    };

    const transferDto = {
      fromAccountId: accountId,
      toAccountId,
      securityId,
      transactionDate: "2025-04-01",
      quantity: 100,
      costPerShare: 1.67,
      description: "Move to Brokerage B",
    };

    beforeEach(() => {
      accountsService.findOne.mockImplementation((uid: string, aid: string) => {
        if (aid === accountId) return Promise.resolve(mockInvestmentAccount);
        if (aid === toAccountId) return Promise.resolve(mockToAccount);
        if (aid === cashAccountId) return Promise.resolve(mockCashAccount);
        return Promise.reject(new NotFoundException("Account not found"));
      });
      // findOne (post-commit reload) uses the query builder.
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder({ id: transactionId, action: "TRANSFER_OUT" }),
      );
    });

    it("creates both legs and moves holdings at the supplied cost basis", async () => {
      const result = await service.transferSecurity(userId, transferDto);

      // Both legs carry the per-share cost basis into the ledger, and both
      // positions are then re-derived from it in one call.
      const legPrices = mockQueryRunner.manager.create.mock.calls
        .filter(([entity]: any[]) => entity === InvestmentTransaction)
        .map(([, data]: any[]) => data.price);
      expect(legPrices).toEqual([1.67, 1.67]);
      expect(
        holdingsService.rebuildScopesFromTransactions,
      ).toHaveBeenCalledWith(
        userId,
        [
          { accountId, securityId },
          { accountId: toAccountId, securityId },
        ],
        expect.anything(),
      );
      expect(dataSource.transaction).toHaveBeenCalled();
      expect(result).toHaveProperty("transferOut");
      expect(result).toHaveProperty("transferIn");
    });

    it("recomputes the bond-engine prices of the security after the transfer (R7)", async () => {
      await service.transferSecurity(userId, transferDto);
      expect(
        securitiesService.recomputeBondPricesAfterWrite,
      ).toHaveBeenCalledWith(userId, [securityId]);
    });

    it("does not create any cash transaction", async () => {
      await service.transferSecurity(userId, transferDto);
      expect(transactionRepository.create).not.toHaveBeenCalled();
      expect(transactionRepository.save).not.toHaveBeenCalled();
    });

    it("validates the full history so the source cannot be over-drawn", async () => {
      await service.transferSecurity(userId, transferDto);
      expect(
        holdingsService.validateNoNegativeHoldingsHistory,
      ).toHaveBeenCalledWith(
        userId,
        mockQueryRunner.manager,
        [accountId, toAccountId],
        [securityId],
      );
    });

    it("rejects a transfer to the same account", async () => {
      await expect(
        service.transferSecurity(userId, {
          ...transferDto,
          toAccountId: accountId,
        }),
      ).rejects.toThrow(BadRequestException);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it("rejects when an account is not an investment account", async () => {
      accountsService.findOne.mockImplementation((uid: string, aid: string) => {
        if (aid === accountId) return Promise.resolve(mockInvestmentAccount);
        if (aid === toAccountId)
          return Promise.resolve({ ...mockToAccount, accountType: "CHEQUING" });
        return Promise.reject(new NotFoundException("Account not found"));
      });
      await expect(
        service.transferSecurity(userId, transferDto),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects transferring into a closed destination account", async () => {
      accountsService.findOne.mockImplementation((uid: string, aid: string) => {
        if (aid === accountId) return Promise.resolve(mockInvestmentAccount);
        if (aid === toAccountId)
          return Promise.resolve({ ...mockToAccount, isClosed: true });
        return Promise.reject(new NotFoundException("Account not found"));
      });
      await expect(
        service.transferSecurity(userId, transferDto),
      ).rejects.toThrow(BadRequestException);
    });

    it("rolls back when the over-draw guard throws", async () => {
      holdingsService.validateNoNegativeHoldingsHistory.mockRejectedValueOnce(
        new BadRequestException("Insufficient shares"),
      );
      await expect(
        service.transferSecurity(userId, transferDto),
      ).rejects.toThrow(BadRequestException);
      expect(dataSource.transaction).toHaveBeenCalled();
    });

    it("links the two legs to each other", async () => {
      await service.transferSecurity(userId, transferDto);
      // Each leg is updated to point at the other via linkedTransactionId.
      const linkUpdates = mockQueryRunner.manager.update.mock.calls.filter(
        (c: any[]) =>
          c[0] === InvestmentTransaction &&
          c[2] &&
          "linkedTransactionId" in c[2],
      );
      expect(linkUpdates).toHaveLength(2);
    });

    it("moves holdings even when the cost basis is zero", async () => {
      // A zero-cost-basis holding (gifted/spun-off shares) is a legitimate
      // transfer. The holdings move must still happen -- a falsy `price` guard
      // previously skipped it, recording both legs while moving no shares.
      await service.transferSecurity(userId, {
        ...transferDto,
        costPerShare: 0,
      });

      const zeroLegPrices = mockQueryRunner.manager.create.mock.calls
        .filter(([entity]: any[]) => entity === InvestmentTransaction)
        .map(([, data]: any[]) => data.price);
      expect(zeroLegPrices).toEqual([0, 0]);
      expect(
        holdingsService.rebuildScopesFromTransactions,
      ).toHaveBeenCalledWith(
        userId,
        [
          { accountId, securityId },
          { accountId: toAccountId, securityId },
        ],
        expect.anything(),
      );
      expect(dataSource.transaction).toHaveBeenCalled();
    });

    it("carries the basis the ledger says the OUT leg releases, ignoring the client value (A26-M22)", async () => {
      // The server is authoritative: both legs take what the source position
      // released at the transfer's own date (here 4.25 a share), read from the
      // ledger under the lock -- a stale/zero client costPerShare cannot poison
      // it, and neither can today's stored average.
      holdingsService.releasedBasisPerShare.mockResolvedValue(4.25);

      await service.transferSecurity(userId, {
        ...transferDto,
        costPerShare: 0,
      });

      const created = mockQueryRunner.manager.create.mock.calls
        .filter(([entity]: any[]) => entity === InvestmentTransaction)
        .map(([, data]: any[]) => data);
      // The IN leg is written at the carried figure; the OUT leg is corrected
      // by an update once the ledger has been read with it in.
      expect(created[1].price).toBe(4.25);
      const priceUpdates = mockQueryRunner.manager.update.mock.calls.filter(
        (c: any[]) => c[0] === InvestmentTransaction && c[2] && "price" in c[2],
      );
      expect(priceUpdates).toHaveLength(1);
      expect(priceUpdates[0][2]).toEqual({ price: 4.25 });
      expect(holdingsService.releasedBasisPerShare).toHaveBeenCalledWith(
        userId,
        securityId,
        expect.anything(),
        mockQueryRunner.manager,
      );
    });

    it("rounds the carried basis at the investment price scale, not 6 places", async () => {
      holdingsService.releasedBasisPerShare.mockResolvedValue(1 / 3);

      await service.transferSecurity(userId, transferDto);

      const created = mockQueryRunner.manager.create.mock.calls
        .filter(([entity]: any[]) => entity === InvestmentTransaction)
        .map(([, data]: any[]) => data);
      expect(created[1].price).toBe(0.3333333333);
    });

    it("no longer reads the stored holding, and keeps the client figure when the ledger cannot say", async () => {
      holdingsService.findByAccountAndSecurity.mockResolvedValue({
        quantity: 200,
        averageCost: 4.25,
      } as any);

      await service.transferSecurity(userId, transferDto);

      expect(holdingsService.findByAccountAndSecurity).not.toHaveBeenCalled();
      const created = mockQueryRunner.manager.create.mock.calls
        .filter(([entity]: any[]) => entity === InvestmentTransaction)
        .map(([, data]: any[]) => data.price);
      expect(created).toEqual([1.67, 1.67]);
    });

    it("rejects transferring into a non-brokerage (cash sleeve) account", async () => {
      accountsService.findOne.mockImplementation((uid: string, aid: string) => {
        if (aid === accountId) return Promise.resolve(mockInvestmentAccount);
        if (aid === toAccountId)
          return Promise.resolve({
            ...mockToAccount,
            accountSubType: AccountSubType.INVESTMENT_CASH,
          });
        return Promise.reject(new NotFoundException("Account not found"));
      });

      await expect(
        service.transferSecurity(userId, transferDto),
      ).rejects.toThrow(BadRequestException);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });
  });

  describe("linked transfer cascade", () => {
    const toAccountId = "account-2";
    const mockToAccount = {
      id: toAccountId,
      userId,
      accountType: "INVESTMENT",
      accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
      linkedAccountId: null,
      currencyCode: "USD",
      name: "Brokerage B",
    };

    function makeLegs() {
      const base = {
        userId,
        securityId,
        fundingAccountId: null,
        transactionId: null,
        transactionSplitId: null,
        transactionDate: "2025-04-01",
        quantity: 100,
        price: 1.67,
        commission: 0,
        totalAmount: 0,
        exchangeRate: 1,
        description: null,
        account: null as any,
        transaction: null as any,
        security: mockSecurity as any,
        fundingAccount: null,
        transactionSplit: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const outLeg = {
        ...base,
        id: "leg-out",
        accountId,
        action: InvestmentAction.TRANSFER_OUT,
        linkedTransactionId: "leg-in",
      } as InvestmentTransaction;
      const inLeg = {
        ...base,
        id: "leg-in",
        accountId: toAccountId,
        action: InvestmentAction.TRANSFER_IN,
        linkedTransactionId: "leg-out",
      } as InvestmentTransaction;
      return { outLeg, inLeg };
    }

    beforeEach(() => {
      accountsService.findOne.mockImplementation((uid: string, aid: string) => {
        if (aid === accountId) return Promise.resolve(mockInvestmentAccount);
        if (aid === toAccountId) return Promise.resolve(mockToAccount);
        if (aid === cashAccountId) return Promise.resolve(mockCashAccount);
        return Promise.reject(new NotFoundException("Account not found"));
      });
      transactionRepository.findOne.mockResolvedValue(null);
    });

    it("remove deletes both legs and validates both accounts", async () => {
      const { outLeg, inLeg } = makeLegs();
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder(outLeg),
      );
      investmentTransactionsRepository.findOne.mockResolvedValue(inLeg);

      await service.remove(userId, "leg-out");

      expect(mockQueryRunner.manager.remove).toHaveBeenCalledTimes(2);
      expect(
        holdingsService.validateNoNegativeHoldingsHistory,
      ).toHaveBeenCalledWith(
        userId,
        mockQueryRunner.manager,
        expect.arrayContaining([accountId, toAccountId]),
        [securityId],
      );
      expect(dataSource.transaction).toHaveBeenCalled();
    });

    it("update propagates the edit to both legs and keeps them linked", async () => {
      const { outLeg, inLeg } = makeLegs();
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder(outLeg),
      );
      investmentTransactionsRepository.findOne.mockResolvedValue(inLeg);

      await service.update(userId, "leg-out", { quantity: 50 });

      // A transfer edit re-derives both accounts from the ledger in the
      // caller's transaction.
      expect(
        holdingsService.rebuildAccountsFromTransactions,
      ).toHaveBeenCalled();
      // Both legs saved.
      const savedActions = mockQueryRunner.manager.save.mock.calls
        .map((c: any[]) => c[0]?.action)
        .filter(Boolean);
      expect(savedActions).toContain(InvestmentAction.TRANSFER_OUT);
      expect(savedActions).toContain(InvestmentAction.TRANSFER_IN);
      // Edit propagated to the linked leg too.
      expect(inLeg.quantity).toBe(50);
      expect(dataSource.transaction).toHaveBeenCalled();
    });

    it("update ignores a price the client sends and writes the carried basis on both legs (A26-M22)", async () => {
      const { outLeg, inLeg } = makeLegs();
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder(outLeg),
      );
      investmentTransactionsRepository.findOne.mockResolvedValue(inLeg);
      holdingsService.releasedBasisPerShare.mockResolvedValue(150);

      await service.update(userId, "leg-out", { price: 999 } as any);

      expect(holdingsService.releasedBasisPerShare).toHaveBeenCalledWith(
        userId,
        securityId,
        "leg-out",
        mockQueryRunner.manager,
      );
      const priceUpdates = mockQueryRunner.manager.update.mock.calls.filter(
        (c: any[]) => c[0] === InvestmentTransaction && c[2] && "price" in c[2],
      );
      expect(priceUpdates).toEqual([
        [InvestmentTransaction, ["leg-out", "leg-in"], { price: 150 }],
      ]);
      expect(outLeg.price).toBe(150);
      expect(inLeg.price).toBe(150);
      // The carried basis is in the ledger before the rebuild reads it.
      const updateOrder =
        mockQueryRunner.manager.update.mock.invocationCallOrder[
          mockQueryRunner.manager.update.mock.calls.indexOf(priceUpdates[0])
        ];
      expect(updateOrder).toBeLessThan(
        holdingsService.rebuildAccountsFromTransactions.mock
          .invocationCallOrder[0],
      );
    });

    it("update keeps the stored price, not the client's, when the ledger cannot say what the OUT leg releases", async () => {
      const { outLeg, inLeg } = makeLegs();
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder(outLeg),
      );
      investmentTransactionsRepository.findOne.mockResolvedValue(inLeg);

      await service.update(userId, "leg-out", { price: 999 } as any);

      expect(outLeg.price).toBe(1.67);
      expect(inLeg.price).toBe(1.67);
    });

    it("update keeps the stored series of both legs when the edit changes neither it, the security nor the date (INV-BOND-007)", async () => {
      const STORED = "22222222-2222-5222-8222-222222222222";
      const original = mockQueryRunner.manager.query.getMockImplementation();
      mockQueryRunner.manager.query.mockImplementation(
        async (sql: string, params?: unknown[]) => {
          const text = String(sql);
          if (text.includes("s.bond_program_id AS id")) {
            return [{ id: "prog-1", program_code: "EDO" }];
          }
          if (text.includes("bond_auto_fetch")) {
            return [
              {
                id: securityId,
                user_id: userId,
                symbol: "EDO",
                currency_code: "PLN",
                bond_program_id: "prog-1",
                bond_auto_fetch: false,
              },
            ];
          }
          if (text.includes("counterpart_account_id")) return [];
          // The program holds no such series any more: only the rule that
          // keeps an unchanged stored value lets it through.
          if (text.includes("id = $1::uuid AND bond_program_id")) return [];
          return original ? original(sql, params) : [];
        },
      );
      const { outLeg, inLeg } = makeLegs();
      outLeg.bondInstrumentId = STORED;
      inLeg.bondInstrumentId = STORED;
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder(outLeg),
      );
      investmentTransactionsRepository.findOne.mockResolvedValue(inLeg);

      await service.update(userId, "leg-out", {
        quantity: 50,
        bondInstrumentId: STORED,
      });

      expect(outLeg.bondInstrumentId).toBe(STORED);
      expect(inLeg.bondInstrumentId).toBe(STORED);
    });

    it("update rejects changing the transfer direction", async () => {
      const { outLeg, inLeg } = makeLegs();
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder(outLeg),
      );
      investmentTransactionsRepository.findOne.mockResolvedValue(inLeg);

      await expect(
        service.update(userId, "leg-out", { action: InvestmentAction.BUY }),
      ).rejects.toThrow(BadRequestException);
    });

    it("update reroutes the destination account onto the linked leg", async () => {
      const { outLeg, inLeg } = makeLegs();
      const account3 = "account-3";
      accountsService.findOne.mockImplementation((uid: string, aid: string) => {
        if (aid === accountId) return Promise.resolve(mockInvestmentAccount);
        if (aid === toAccountId) return Promise.resolve(mockToAccount);
        if (aid === account3)
          return Promise.resolve({ ...mockToAccount, id: account3 });
        if (aid === cashAccountId) return Promise.resolve(mockCashAccount);
        return Promise.reject(new NotFoundException("Account not found"));
      });
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder(outLeg),
      );
      investmentTransactionsRepository.findOne.mockResolvedValue(inLeg);

      await service.update(userId, "leg-out", {
        destinationAccountId: account3,
      });

      // The destination (linked) leg moves to the new account.
      expect(inLeg.accountId).toBe(account3);
      expect(dataSource.transaction).toHaveBeenCalled();
    });

    it("update rejects rerouting the destination to the source account", async () => {
      const { outLeg, inLeg } = makeLegs();
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder(outLeg),
      );
      investmentTransactionsRepository.findOne.mockResolvedValue(inLeg);

      await expect(
        service.update(userId, "leg-out", { destinationAccountId: accountId }),
      ).rejects.toThrow(BadRequestException);
    });

    it("keeps the transfer direction when the IN leg is edited directly", async () => {
      // Editing via the IN leg id must still route accountId -> source (OUT
      // leg) and destinationAccountId -> destination (IN leg), not invert them.
      const { outLeg, inLeg } = makeLegs();
      const account3 = "account-3";
      accountsService.findOne.mockImplementation((uid: string, aid: string) => {
        if (aid === accountId) return Promise.resolve(mockInvestmentAccount);
        if (aid === toAccountId) return Promise.resolve(mockToAccount);
        if (aid === account3)
          return Promise.resolve({ ...mockToAccount, id: account3 });
        return Promise.reject(new NotFoundException("Account not found"));
      });
      // findOne (the entity being edited) returns the IN leg; the linked leg is
      // the OUT leg.
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder(inLeg),
      );
      investmentTransactionsRepository.findOne.mockResolvedValue(outLeg);

      await service.update(userId, "leg-in", {
        accountId: account3,
        destinationAccountId: toAccountId,
      });

      // Source account applied to the OUT leg, destination to the IN leg.
      expect(outLeg.accountId).toBe(account3);
      expect(inLeg.accountId).toBe(toAccountId);
      expect(dataSource.transaction).toHaveBeenCalled();
    });

    it("rebuilds the affected accounts' holdings inside the edit transaction", async () => {
      const { outLeg, inLeg } = makeLegs();
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder(outLeg),
      );
      investmentTransactionsRepository.findOne.mockResolvedValue(inLeg);

      await service.update(userId, "leg-out", { quantity: 50 });

      // The rebuild runs on the open queryRunner (atomic with the edit) rather
      // than a best-effort post-commit call, so a failure rolls the edit back.
      expect(
        holdingsService.rebuildAccountsFromTransactions,
      ).toHaveBeenCalledWith(
        userId,
        expect.arrayContaining([accountId, toAccountId]),
        mockQueryRunner.manager,
      );
    });

    it("rejects rerouting the destination to a closed account", async () => {
      const { outLeg, inLeg } = makeLegs();
      const closedId = "account-closed";
      accountsService.findOne.mockImplementation((uid: string, aid: string) => {
        if (aid === accountId) return Promise.resolve(mockInvestmentAccount);
        if (aid === toAccountId) return Promise.resolve(mockToAccount);
        if (aid === closedId)
          return Promise.resolve({
            ...mockToAccount,
            id: closedId,
            isClosed: true,
          });
        return Promise.reject(new NotFoundException("Account not found"));
      });
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder(outLeg),
      );
      investmentTransactionsRepository.findOne.mockResolvedValue(inLeg);

      await expect(
        service.update(userId, "leg-out", { destinationAccountId: closedId }),
      ).rejects.toThrow(BadRequestException);
    });

    it("refuses to edit a transfer leg whose pair is missing", async () => {
      const { outLeg } = makeLegs();
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder(outLeg),
      );
      // Linked leg cannot be loaded (stale link / partial data).
      investmentTransactionsRepository.findOne.mockResolvedValue(null);

      await expect(
        service.update(userId, "leg-out", { quantity: 50 }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe("getSecurityTransactionHistory", () => {
    const acctA = "acct-a";
    const acctB = "acct-b";

    function tx(
      id: string,
      accountId: string,
      accountName: string,
      isClosed: boolean,
      action: InvestmentAction,
      transactionDate: string,
      quantity: number | null,
      extra: Partial<InvestmentTransaction> = {},
    ): InvestmentTransaction {
      return {
        id,
        userId,
        accountId,
        securityId,
        action,
        transactionDate,
        quantity,
        price: 1,
        commission: 0,
        totalAmount: 0,
        exchangeRate: 1,
        description: null,
        account: { id: accountId, name: accountName, isClosed } as any,
        ...extra,
      } as InvestmentTransaction;
    }

    beforeEach(() => {
      securitiesService.findOne.mockResolvedValue({
        ...mockSecurity,
        isActive: false,
      });
    });

    it("reads the history in chronological order, which callers depend on", async () => {
      // Two readers rely on this ordering and neither can recover it: the
      // running totals below are computed by replaying the rows in sequence, and
      // the detail page's chart takes the last row of each day as that day's
      // closing balance (`buildQuantitySteps`). Same-day order cannot be derived
      // from the date alone, so sorting on the client is not an option -- the
      // order is part of this method's contract, and a future change to the
      // query should fail here rather than quietly skew a chart.
      investmentTransactionsRepository.find.mockResolvedValue([]);

      await service.getSecurityTransactionHistory(userId, securityId);

      expect(investmentTransactionsRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({ order: INVESTMENT_REPLAY_ORDER }),
      );
    });

    it("computes per-account and cross-account running totals without snapping", async () => {
      investmentTransactionsRepository.find.mockResolvedValue([
        tx(
          "t1",
          acctA,
          "Account A",
          false,
          InvestmentAction.BUY,
          "2025-01-01",
          100,
        ),
        tx(
          "t2",
          acctB,
          "Account B",
          true,
          InvestmentAction.BUY,
          "2025-02-01",
          50,
        ),
        tx(
          "t3",
          acctA,
          "Account A",
          false,
          InvestmentAction.SELL,
          "2025-03-01",
          99.9999,
        ),
        tx(
          "t4",
          acctB,
          "Account B",
          true,
          InvestmentAction.SPLIT,
          "2025-04-01",
          2,
        ),
      ]);

      const result = await service.getSecurityTransactionHistory(
        userId,
        securityId,
      );

      expect(result.transactions).toHaveLength(4);

      // Account A drawn down to a tiny residual, kept visible (not snapped).
      const sell = result.transactions[2];
      expect(sell.runningQuantityAccount).toBeCloseTo(0.0001, 8);
      expect(sell.runningQuantityAll).toBeCloseTo(50.0001, 8);

      // SPLIT multiplies only Account B's balance; cross-account total follows.
      const split = result.transactions[3];
      expect(split.runningQuantityAccount).toBe(100);
      expect(split.runningQuantityAll).toBeCloseTo(100.0001, 8);

      expect(result.currentQuantityAll).toBeCloseTo(100.0001, 8);
    });

    it("lists every account the security was used in, including closed ones", async () => {
      investmentTransactionsRepository.find.mockResolvedValue([
        tx(
          "t1",
          acctA,
          "Account A",
          false,
          InvestmentAction.BUY,
          "2025-01-01",
          100,
        ),
        tx(
          "t2",
          acctB,
          "Account B",
          true,
          InvestmentAction.BUY,
          "2025-02-01",
          50,
        ),
        tx(
          "t3",
          acctA,
          "Account A",
          false,
          InvestmentAction.SELL,
          "2025-03-01",
          99.9999,
        ),
      ]);

      const result = await service.getSecurityTransactionHistory(
        userId,
        securityId,
      );

      expect(result.accounts).toHaveLength(2);
      const a = result.accounts.find((x) => x.accountId === acctA)!;
      const b = result.accounts.find((x) => x.accountId === acctB)!;
      expect(a.currentQuantity).toBeCloseTo(0.0001, 8);
      expect(b.isClosed).toBe(true);
      expect(b.currentQuantity).toBe(50);
      // Works for an inactive security.
      expect(result.isActive).toBe(false);
    });

    it("returns empty history for a security with no transactions", async () => {
      investmentTransactionsRepository.find.mockResolvedValue([]);

      const result = await service.getSecurityTransactionHistory(
        userId,
        securityId,
      );

      expect(result.transactions).toEqual([]);
      expect(result.accounts).toEqual([]);
      expect(result.currentQuantityAll).toBe(0);
    });

    it("throws when the security does not exist", async () => {
      securitiesService.findOne.mockRejectedValue(
        new NotFoundException("Security not found"),
      );

      await expect(
        service.getSecurityTransactionHistory(userId, securityId),
      ).rejects.toThrow(NotFoundException);
    });
  });

  /**
   * A26-L18: the email-receipt pipeline builds a trade card's preview inside
   * the receipt's transaction, with its row lock held. There the preview reads
   * only stored rates; a provider call would hold the lock and a pooled
   * connection for its response time.
   */
  describe("previewCreateInvestmentTransaction inside a caller's transaction", () => {
    const scopedDb = jest.requireMock("../common/db/scoped-db") as {
      getActiveScopedManager: jest.Mock;
    };

    beforeEach(() => {
      accountsService.findOne.mockImplementation(
        (_uid: string, aid: string) => {
          if (aid === accountId)
            return Promise.resolve({
              ...mockInvestmentAccount,
              currencyCode: "CAD",
            });
          if (aid === cashAccountId)
            return Promise.resolve({ ...mockCashAccount, currencyCode: "CAD" });
          return Promise.reject(new NotFoundException("Account not found"));
        },
      );
      securitiesService.resolveBySymbolOrName.mockResolvedValue({
        match: mockSecurity,
        candidates: [],
      });
      securitiesService.findOne.mockResolvedValue(mockSecurity);
      exchangeRateService.getRateForDate.mockResolvedValue(1.37);
    });

    const preview = () =>
      service.previewCreateInvestmentTransaction(userId, {
        accountId,
        action: InvestmentAction.BUY,
        transactionDate: "2026-10-15",
        securityQuery: "AAPL",
        quantity: 10,
        price: 100,
      });

    it("reads only stored rates, never the provider", async () => {
      scopedDb.getActiveScopedManager.mockReturnValue({});
      try {
        await preview();
      } finally {
        scopedDb.getActiveScopedManager.mockReturnValue(undefined);
      }
      expect(exchangeRateService.getRateForDate).toHaveBeenCalledWith(
        "USD",
        "CAD",
        "2026-10-15",
        { fetchMissing: false },
      );
    });

    it("refuses by name when no stored rate answers", async () => {
      scopedDb.getActiveScopedManager.mockReturnValue({});
      exchangeRateService.getRateForDate.mockResolvedValue(null);
      try {
        await expect(preview()).rejects.toBeInstanceOf(BadRequestException);
      } finally {
        scopedDb.getActiveScopedManager.mockReturnValue(undefined);
      }
    });

    it("still fetches for a request-scoped preview", async () => {
      await preview();
      expect(exchangeRateService.getRateForDate).toHaveBeenCalledWith(
        "USD",
        "CAD",
        "2026-10-15",
      );
    });
  });

  describe("previewCreateInvestmentTransaction", () => {
    beforeEach(() => {
      accountsService.findOne.mockImplementation(
        (_uid: string, aid: string) => {
          if (aid === accountId) return Promise.resolve(mockInvestmentAccount);
          if (aid === cashAccountId) return Promise.resolve(mockCashAccount);
          if (aid === fundingAccountId)
            return Promise.resolve(mockFundingAccount);
          return Promise.reject(new NotFoundException("Account not found"));
        },
      );
      securitiesService.resolveBySymbolOrName.mockResolvedValue({
        match: mockSecurity,
        candidates: [],
      });
      securitiesService.findOne.mockResolvedValue(mockSecurity);
    });

    it("resolves the security and computes total + cash impact for a BUY", async () => {
      const preview = await service.previewCreateInvestmentTransaction(userId, {
        accountId,
        action: InvestmentAction.BUY,
        transactionDate: "2026-01-15",
        securityQuery: "aapl",
        quantity: 10,
        price: 150,
        commission: 9.99,
      });

      expect(securitiesService.resolveBySymbolOrName).toHaveBeenCalledWith(
        userId,
        "aapl",
      );
      expect(preview).toMatchObject({
        accountId,
        accountName: "Brokerage Account",
        accountCurrency: "USD",
        action: InvestmentAction.BUY,
        transactionDate: "2026-01-15",
        securityId,
        symbol: "AAPL",
        securityName: "Apple Inc.",
        securityCurrency: "USD",
        quantity: 10,
        price: 150,
        commission: 9.99,
        totalAmount: 1509.99,
        exchangeRate: 1,
        fundingAccountId: null,
        // BUY debits the brokerage's linked cash account.
        cashAccountName: "Cash Account",
        cashCurrency: "USD",
        cashAmount: -1509.99,
        description: null,
      });
    });

    it("credits the cash account on a SELL", async () => {
      const preview = await service.previewCreateInvestmentTransaction(userId, {
        accountId,
        action: InvestmentAction.SELL,
        transactionDate: "2026-01-15",
        securityQuery: "AAPL",
        quantity: 5,
        price: 160,
        commission: 9.99,
      });
      expect(preview.totalAmount).toBe(790.01);
      expect(preview.cashAmount).toBe(790.01);
    });

    it("rounds quantity/price/commission to their column scale", async () => {
      const preview = await service.previewCreateInvestmentTransaction(userId, {
        accountId,
        action: InvestmentAction.BUY,
        transactionDate: "2026-01-15",
        securityQuery: "AAPL",
        quantity: 1.123456789,
        price: 2.12345678901,
        commission: 0.12345,
      });
      expect(preview.quantity).toBe(1.12345679);
      // The price column is NUMERIC(24,10). A preview that narrowed it to six
      // showed a figure the commit would not store, and a price derived from
      // an executed total needs all ten.
      expect(preview.price).toBe(2.123456789);
      expect(preview.commission).toBe(0.1235);
    });

    it("uses an explicit funding account for the cash side", async () => {
      const preview = await service.previewCreateInvestmentTransaction(userId, {
        accountId,
        action: InvestmentAction.BUY,
        transactionDate: "2026-01-15",
        securityQuery: "AAPL",
        quantity: 10,
        price: 150,
        commission: 0,
        fundingAccountId,
      });
      expect(preview.fundingAccountId).toBe(fundingAccountId);
      expect(preview.cashAccountName).toBe("Checking Account");
    });

    it("reports no cash side for a share-only action", async () => {
      const preview = await service.previewCreateInvestmentTransaction(userId, {
        accountId,
        action: InvestmentAction.ADD_SHARES,
        transactionDate: "2026-01-15",
        securityQuery: "AAPL",
        quantity: 5,
      });
      expect(preview.totalAmount).toBe(0);
      expect(preview.cashAccountName).toBeNull();
      expect(preview.cashCurrency).toBeNull();
      expect(preview.cashAmount).toBeNull();
    });

    it("converts the cash impact when the security currency differs", async () => {
      // resolveCashExchangeRate reads the source currency from findOne.
      securitiesService.findOne.mockResolvedValue({
        ...mockSecurity,
        currencyCode: "EUR",
      });
      securitiesService.resolveBySymbolOrName.mockResolvedValue({
        match: { ...mockSecurity, currencyCode: "EUR" },
        candidates: [],
      });
      exchangeRateService.getRateForDate.mockResolvedValue(1.1);

      const preview = await service.previewCreateInvestmentTransaction(userId, {
        accountId,
        action: InvestmentAction.BUY,
        transactionDate: "2026-01-15",
        securityQuery: "AAPL",
        quantity: 10,
        price: 100,
        commission: 0,
      });
      expect(preview.exchangeRate).toBe(1.1);
      // 1000 EUR * 1.1 = 1100 USD, debited.
      expect(preview.cashAmount).toBe(-1100);
    });

    it("sanitizes the description", async () => {
      const preview = await service.previewCreateInvestmentTransaction(userId, {
        accountId,
        action: InvestmentAction.BUY,
        transactionDate: "2026-01-15",
        securityQuery: "AAPL",
        quantity: 1,
        price: 1,
        description: "<script>alert(1)</script>Dividend reinvest",
      });
      expect(preview.description).not.toContain("<script>");
      expect(preview.description).toContain("Dividend reinvest");
    });

    it("rejects a non-investment account", async () => {
      accountsService.findOne.mockResolvedValue(mockFundingAccount);
      await expect(
        service.previewCreateInvestmentTransaction(userId, {
          accountId: fundingAccountId,
          action: InvestmentAction.BUY,
          transactionDate: "2026-01-15",
          securityQuery: "AAPL",
          quantity: 1,
          price: 1,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects an ambiguous security with the candidate list", async () => {
      securitiesService.resolveBySymbolOrName.mockResolvedValue({
        match: null,
        candidates: [
          { ...mockSecurity, symbol: "AAPL", name: "Apple Inc." },
          { ...mockSecurity, symbol: "AAPL.L", name: "Apple London" },
        ],
      });
      await expect(
        service.previewCreateInvestmentTransaction(userId, {
          accountId,
          action: InvestmentAction.BUY,
          transactionDate: "2026-01-15",
          securityQuery: "Apple",
          quantity: 1,
          price: 1,
        }),
      ).rejects.toThrow(/multiple securities/i);
    });

    it("rejects an unknown security", async () => {
      securitiesService.resolveBySymbolOrName.mockResolvedValue({
        match: null,
        candidates: [],
      });
      await expect(
        service.previewCreateInvestmentTransaction(userId, {
          accountId,
          action: InvestmentAction.BUY,
          transactionDate: "2026-01-15",
          securityQuery: "ZZZZ",
          quantity: 1,
          price: 1,
        }),
      ).rejects.toThrow(/No security matches/i);
    });

    it("requires a security for a security-bound action", async () => {
      await expect(
        service.previewCreateInvestmentTransaction(userId, {
          accountId,
          action: InvestmentAction.BUY,
          transactionDate: "2026-01-15",
          quantity: 1,
          price: 1,
        }),
      ).rejects.toThrow(BadRequestException);
      expect(securitiesService.resolveBySymbolOrName).not.toHaveBeenCalled();
    });

    it("requires a positive ratio for a SPLIT", async () => {
      await expect(
        service.previewCreateInvestmentTransaction(userId, {
          accountId,
          action: InvestmentAction.SPLIT,
          transactionDate: "2026-01-15",
          securityQuery: "AAPL",
          quantity: 0,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("allows a cash-only INTEREST with no security", async () => {
      const preview = await service.previewCreateInvestmentTransaction(userId, {
        accountId,
        action: InvestmentAction.INTEREST,
        transactionDate: "2026-01-15",
        price: 25,
      });
      expect(preview.securityId).toBeNull();
      expect(preview.cashAmount).toBe(25);
    });
  });

  describe("previewUpdateInvestmentTransaction", () => {
    beforeEach(() => {
      accountsService.findOne.mockImplementation(
        (_uid: string, aid: string) => {
          if (aid === accountId) return Promise.resolve(mockInvestmentAccount);
          if (aid === cashAccountId) return Promise.resolve(mockCashAccount);
          return Promise.reject(new NotFoundException("Account not found"));
        },
      );
      securitiesService.resolveBySymbolOrName.mockResolvedValue({
        match: mockSecurity,
        candidates: [],
      });
      securitiesService.findOne.mockResolvedValue(mockSecurity);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder(mockBuyTransaction),
      );
    });

    it("merges overrides over the stored transaction and recomputes totals", async () => {
      const preview = await service.previewUpdateInvestmentTransaction(
        userId,
        transactionId,
        { action: InvestmentAction.SELL, quantity: 5, price: 160 },
      );

      expect(preview.transactionId).toBe(transactionId);
      expect(preview.action).toBe(InvestmentAction.SELL);
      expect(preview.quantity).toBe(5);
      expect(preview.price).toBe(160);
      // Commission kept from the stored transaction (not overridden).
      expect(preview.commission).toBe(9.99);
      // SELL credits cash.
      expect(preview.totalAmount).toBe(790.01);
      expect(preview.cashAmount).toBe(790.01);
    });

    it("rejects when no field is provided", async () => {
      await expect(
        service.previewUpdateInvestmentTransaction(userId, transactionId, {}),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    /**
     * A26-M20 (INV-FX-002): a SELL of 141 USD shares from a CAD brokerage,
     * entered at its statement total 820.91 USD and the broker's settlement
     * rate 1.40 (cash +1,149.27 CAD); today's USD/CAD is 1.37. The MCP and
     * assistant adapters commit `preview.exchangeRate` as the DTO's rate, so a
     * description-only edit that re-resolved it wrote 1.37 and moved the cash
     * leg to +1,124.65.
     */
    describe("the row's own exchange rate", () => {
      const usdSecurity = {
        ...mockSecurity,
        id: "sec-usd",
        currencyCode: "USD",
      };
      const otherUsdSecurity = {
        ...mockSecurity,
        id: "sec-usd-2",
        symbol: "MSFT",
        currencyCode: "USD",
      };
      const settlementSell = {
        ...mockBuyTransaction,
        action: InvestmentAction.SELL,
        securityId: usdSecurity.id,
        security: usdSecurity as any,
        quantity: 141,
        price: 5.8220567376,
        commission: 0,
        totalAmount: 820.91,
        exchangeRate: 1.4,
      };

      beforeEach(() => {
        accountsService.findOne.mockImplementation(
          (_uid: string, aid: string) => {
            if (aid === accountId)
              return Promise.resolve({
                ...mockInvestmentAccount,
                currencyCode: "CAD",
              });
            if (aid === cashAccountId)
              return Promise.resolve({
                ...mockCashAccount,
                currencyCode: "CAD",
              });
            return Promise.reject(new NotFoundException("Account not found"));
          },
        );
        securitiesService.findOne.mockImplementation(
          (_uid: string, sid: string) =>
            Promise.resolve(
              sid === otherUsdSecurity.id ? otherUsdSecurity : usdSecurity,
            ),
        );
        securitiesService.resolveBySymbolOrName.mockImplementation(
          (_uid: string, query: string) =>
            Promise.resolve({
              match: query === "MSFT" ? otherUsdSecurity : usdSecurity,
              candidates: [],
            }),
        );
        investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
          createMockQueryBuilder(settlementSell),
        );
        exchangeRateService.getRateForDate.mockResolvedValue(1.37);
      });

      it("keeps the stored rate and cash on a description-only edit", async () => {
        const preview = await service.previewUpdateInvestmentTransaction(
          userId,
          transactionId,
          { description: "renamed" },
        );

        expect(preview.exchangeRate).toBe(1.4);
        expect(preview.cashAmount).toBe(1149.27);
        expect(exchangeRateService.getRateForDate).not.toHaveBeenCalled();
      });

      it("takes a rate the edit names", async () => {
        const preview = await service.previewUpdateInvestmentTransaction(
          userId,
          transactionId,
          { exchangeRate: 1.39 },
        );

        expect(preview.exchangeRate).toBe(1.39);
      });

      it("re-resolves the rate for the new pair when the security changes", async () => {
        const preview = await service.previewUpdateInvestmentTransaction(
          userId,
          transactionId,
          { securityQuery: "MSFT" },
        );

        expect(preview.exchangeRate).toBe(1.37);
        expect(exchangeRateService.getRateForDate).toHaveBeenCalledWith(
          "USD",
          "CAD",
          settlementSell.transactionDate,
        );
      });
    });
  });

  describe("previewDeleteInvestmentTransaction", () => {
    it("returns a display preview without persisting", async () => {
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder(mockBuyTransaction),
      );

      const preview = await service.previewDeleteInvestmentTransaction(
        userId,
        transactionId,
      );

      expect(preview).toMatchObject({
        transactionId,
        accountName: mockInvestmentAccount.name,
        action: InvestmentAction.BUY,
        symbol: "AAPL",
        quantity: 10,
        price: 150,
        commission: 9.99,
        totalAmount: 1509.99,
      });
    });
  });

  describe("manage_investment_transactions bulk prep", () => {
    const okPreview = {
      accountId,
      accountName: "Brokerage Account",
      accountCurrency: "USD",
      action: InvestmentAction.BUY,
      transactionDate: "2026-01-15",
      securityId,
      symbol: "AAPL",
      securityName: "Apple Inc.",
      securityCurrency: "USD",
      quantity: 10,
      price: 150,
      commission: 0,
      totalAmount: 1500,
      exchangeRate: 1,
      fundingAccountId: null,
      cashAccountName: "Cash Account",
      cashCurrency: "USD",
      cashAmount: -1500,
      description: null,
    };

    describe("prepareCreateInvestmentSingle", () => {
      it("resolves the account name and previews the row", async () => {
        accountsService.resolveBrokerageByName.mockResolvedValue({
          match: {
            id: accountId,
            name: "Brokerage Account",
            currencyCode: "USD",
          },
          candidates: [],
        });
        const spy = jest
          .spyOn(service, "previewCreateInvestmentTransaction")
          .mockResolvedValue(okPreview as never);

        const preview = await service.prepareCreateInvestmentSingle(userId, {
          accountName: "Brokerage Account",
          action: InvestmentAction.BUY,
          date: "2026-01-15",
          securityQuery: "AAPL",
          quantity: 10,
          price: 150,
        });

        expect(spy).toHaveBeenCalledWith(
          userId,
          expect.objectContaining({ accountId, securityQuery: "AAPL" }),
        );
        expect(preview.symbol).toBe("AAPL");
      });

      it("resolves the base pair name to its brokerage account", async () => {
        accountsService.resolveBrokerageByName.mockResolvedValue({
          match: {
            id: accountId,
            name: "RRSP - Brokerage",
            currencyCode: "CAD",
          },
          candidates: [],
        });
        const spy = jest
          .spyOn(service, "previewCreateInvestmentTransaction")
          .mockResolvedValue(okPreview as never);

        await service.prepareCreateInvestmentSingle(userId, {
          accountName: "RRSP",
          action: InvestmentAction.BUY,
          date: "2026-01-15",
          securityQuery: "AAPL",
          quantity: 10,
          price: 150,
        });

        expect(accountsService.resolveBrokerageByName).toHaveBeenCalledWith(
          userId,
          "RRSP",
        );
        expect(spy).toHaveBeenCalledWith(
          userId,
          expect.objectContaining({ accountId }),
        );
      });

      it("throws when the account name is unknown", async () => {
        accountsService.resolveBrokerageByName.mockResolvedValue({
          match: undefined,
          candidates: [],
        });
        await expect(
          service.prepareCreateInvestmentSingle(userId, {
            accountName: "Nope",
            action: InvestmentAction.BUY,
            date: "2026-01-15",
          }),
        ).rejects.toBeInstanceOf(NotFoundException);
      });

      it("throws a bad-request error when the base name is ambiguous", async () => {
        accountsService.resolveBrokerageByName.mockResolvedValue({
          match: undefined,
          candidates: [
            { id: "a", name: "RRSP - Brokerage" },
            { id: "b", name: "RRSP - Brokerage" },
          ],
        });
        await expect(
          service.prepareCreateInvestmentSingle(userId, {
            accountName: "RRSP",
            action: InvestmentAction.BUY,
            date: "2026-01-15",
          }),
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it("throws when an explicit funding account name is unknown", async () => {
        accountsService.resolveBrokerageByName.mockResolvedValue({
          match: {
            id: accountId,
            name: "Brokerage Account",
            currencyCode: "USD",
          },
          candidates: [],
        });
        accountsService.resolveByName.mockResolvedValue(undefined);
        await expect(
          service.prepareCreateInvestmentSingle(userId, {
            accountName: "Brokerage Account",
            action: InvestmentAction.BUY,
            date: "2026-01-15",
            fundingAccountName: "Ghost Cash",
          }),
        ).rejects.toBeInstanceOf(NotFoundException);
      });
    });

    describe("prepareCreateInvestmentBulk", () => {
      it("collects ok rows and skips unknown account / failed preview rows", async () => {
        accountsService.resolveBrokerageByName.mockImplementation(
          (_uid: string, name: string) =>
            name === "Brokerage Account"
              ? Promise.resolve({
                  match: {
                    id: accountId,
                    name: "Brokerage Account",
                    currencyCode: "USD",
                  },
                  candidates: [],
                })
              : Promise.resolve({ match: undefined, candidates: [] }),
        );
        jest
          .spyOn(service, "previewCreateInvestmentTransaction")
          .mockResolvedValueOnce(okPreview as never)
          .mockRejectedValueOnce(new BadRequestException("Oversell"));

        const result = await service.prepareCreateInvestmentBulk(userId, [
          {
            accountName: "Brokerage Account",
            action: InvestmentAction.BUY,
            date: "2026-01-15",
            securityQuery: "AAPL",
            quantity: 10,
            price: 150,
          },
          {
            accountName: "Brokerage Account",
            action: InvestmentAction.SELL,
            date: "2026-01-16",
            securityQuery: "AAPL",
            quantity: 999,
            price: 150,
          },
          {
            accountName: "Ghost",
            action: InvestmentAction.BUY,
            date: "2026-01-17",
            securityQuery: "AAPL",
          },
        ]);

        expect(result.okPreviews).toHaveLength(1);
        expect(result.okIndex).toEqual([0]);
        expect(result.previewRows).toHaveLength(3);
        expect(result.previewRows[0].status).toBe("ok");
        expect(result.previewRows[1].status).toBe("error");
        expect(result.previewRows[1].error).toBe("Oversell");
        expect(result.previewRows[2].error).toContain("Unknown account");
        expect(result.skipped.map((s) => s.index)).toEqual([1, 2]);
      });

      it("skips an ambiguous base account name with the matching brokerages", async () => {
        accountsService.resolveBrokerageByName.mockResolvedValue({
          match: undefined,
          candidates: [
            { id: "a", name: "RRSP - Brokerage" },
            { id: "b", name: "RRSP - Brokerage" },
          ],
        });
        const result = await service.prepareCreateInvestmentBulk(userId, [
          {
            accountName: "RRSP",
            action: InvestmentAction.BUY,
            date: "2026-01-15",
            securityQuery: "AAPL",
          },
        ]);
        expect(result.okPreviews).toHaveLength(0);
        expect(result.previewRows[0].error).toContain("Ambiguous account");
        expect(result.previewRows[0].error).toContain("RRSP - Brokerage");
      });

      it("skips a row whose funding account name is unknown", async () => {
        accountsService.resolveBrokerageByName.mockResolvedValueOnce({
          match: {
            id: accountId,
            name: "Brokerage Account",
            currencyCode: "USD",
          },
          candidates: [],
        });
        accountsService.resolveByName.mockResolvedValueOnce(undefined);
        const result = await service.prepareCreateInvestmentBulk(userId, [
          {
            accountName: "Brokerage Account",
            action: InvestmentAction.BUY,
            date: "2026-01-15",
            securityQuery: "AAPL",
            fundingAccountName: "Ghost Cash",
          },
        ]);
        expect(result.okPreviews).toHaveLength(0);
        expect(result.previewRows[0].error).toContain(
          "Unknown funding account",
        );
      });
    });

    describe("prepareUpdateInvestmentBulk", () => {
      it("maps ok edits to batch rows and skips failures", async () => {
        jest
          .spyOn(service, "previewUpdateInvestmentTransaction")
          .mockResolvedValueOnce({
            ...okPreview,
            transactionId,
            action: InvestmentAction.SELL,
          } as never)
          .mockRejectedValueOnce(new NotFoundException("not found"));

        const result = await service.prepareUpdateInvestmentBulk(userId, [
          { transactionId, action: InvestmentAction.SELL },
          { transactionId: "missing", quantity: 1 },
        ]);

        expect(result.okRows).toHaveLength(1);
        expect(result.okRows[0]).toMatchObject({
          transactionId,
          action: InvestmentAction.SELL,
          securityId,
          exchangeRate: 1,
        });
        expect(result.okIndex).toEqual([0]);
        expect(result.skipped).toEqual([{ index: 1, reason: "not found" }]);
        expect(result.previewRows[1].status).toBe("error");
      });
    });

    describe("prepareDeleteInvestmentBulk", () => {
      it("maps ok deletions to batch rows and skips failures", async () => {
        jest
          .spyOn(service, "previewDeleteInvestmentTransaction")
          .mockResolvedValueOnce({
            transactionId,
            accountName: "Brokerage Account",
            action: InvestmentAction.BUY,
            transactionDate: "2026-01-15",
            symbol: "AAPL",
            securityName: "Apple Inc.",
            securityCurrency: "USD",
            quantity: 10,
            price: 150,
            commission: 0,
            totalAmount: 1500,
            description: null,
          } as never)
          .mockRejectedValueOnce(new NotFoundException("gone"));

        const result = await service.prepareDeleteInvestmentBulk(userId, [
          transactionId,
          "missing",
        ]);

        expect(result.okRows).toEqual([{ transactionId }]);
        expect(result.okIndex).toEqual([0]);
        expect(result.previewRows[0].status).toBe("ok");
        expect(result.previewRows[0].symbol).toBe("AAPL");
        expect(result.previewRows[1].status).toBe("error");
        expect(result.skipped).toEqual([{ index: 1, reason: "gone" }]);
      });
    });
  });

  describe("createBulk", () => {
    const dto = (overrides = {}) => ({
      accountId,
      securityId,
      action: InvestmentAction.BUY,
      transactionDate: "2025-01-15",
      quantity: 10,
      price: 150,
      commission: 0,
      ...overrides,
    });

    it("creates every valid row in input order and returns them", async () => {
      const createSpy = jest
        .spyOn(service, "create")
        .mockResolvedValueOnce({ id: "inv-1" } as never)
        .mockResolvedValueOnce({ id: "inv-2" } as never);

      const result = await service.createBulk(userId, [dto(), dto()]);

      expect(createSpy).toHaveBeenCalledTimes(2);
      expect(result.created.map((t) => t.id)).toEqual(["inv-1", "inv-2"]);
      expect(result.skipped).toEqual([]);
    });

    it("recomputes the bond-engine prices once per security after the whole batch, not once per row (R7)", async () => {
      const createSpy = jest
        .spyOn(service, "create")
        .mockResolvedValueOnce({ id: "inv-1", securityId: "s1" } as never)
        .mockResolvedValueOnce({ id: "inv-2", securityId: "s1" } as never)
        .mockResolvedValueOnce({ id: "inv-3", securityId: "s2" } as never);

      await service.createBulk(userId, [dto(), dto(), dto()]);

      for (const call of createSpy.mock.calls) {
        expect(call[2]).toEqual({ deferBondRecompute: true });
      }
      expect(
        securitiesService.recomputeBondPricesAfterWrite,
      ).toHaveBeenCalledTimes(1);
      expect(
        securitiesService.recomputeBondPricesAfterWrite,
      ).toHaveBeenCalledWith(userId, ["s1", "s1", "s2"]);
    });

    it("isolates a failing row into skipped without aborting the rest", async () => {
      jest
        .spyOn(service, "create")
        .mockResolvedValueOnce({ id: "inv-1" } as never)
        .mockRejectedValueOnce(new BadRequestException("Oversell"))
        .mockResolvedValueOnce({ id: "inv-3" } as never);

      const result = await service.createBulk(userId, [dto(), dto(), dto()]);

      expect(result.created.map((t) => t.id)).toEqual(["inv-1", "inv-3"]);
      expect(result.skipped).toEqual([{ index: 1, reason: "Oversell" }]);
    });
  });

  /**
   * docs/specs/redemption-accrued-interest.md. A redemption is proceeds on the
   * REDEEM row plus a linked INTEREST companion, and ONE cash row for both --
   * so the interest reaches the cash account without a split parent, and stays
   * out of `totalAmount`, which every realized-gain fold reads as proceeds.
   */
  describe("accrued interest on a redemption", () => {
    const companionId = "inv-tx-interest";
    const redeemDto = (overrides: Record<string, unknown> = {}) => ({
      accountId,
      securityId,
      action: InvestmentAction.REDEEM,
      transactionDate: "2025-06-30",
      quantity: 10,
      price: 1000,
      commission: 25,
      accruedInterest: 87.5,
      ...overrides,
    });

    const storedRedemption = (
      overrides: Partial<InvestmentTransaction> = {},
    ): InvestmentTransaction =>
      ({
        id: transactionId,
        userId,
        accountId,
        securityId,
        fundingAccountId: null,
        transactionId: cashTransactionId,
        linkedTransactionId: companionId,
        transactionSplitId: null,
        action: InvestmentAction.REDEEM,
        status: TransactionStatus.CLEARED,
        transactionDate: "2025-06-30",
        quantity: 10,
        price: 1000,
        commission: 25,
        totalAmount: 9975,
        exchangeRate: 1,
        description: null,
        account: mockInvestmentAccount as never,
        security: mockSecurity as never,
        ...overrides,
      }) as InvestmentTransaction;

    const storedCompanion = (
      overrides: Partial<InvestmentTransaction> = {},
    ): InvestmentTransaction =>
      ({
        id: companionId,
        userId,
        accountId,
        securityId,
        fundingAccountId: null,
        transactionId: null,
        linkedTransactionId: transactionId,
        transactionSplitId: null,
        action: InvestmentAction.INTEREST,
        status: TransactionStatus.CLEARED,
        transactionDate: "2025-06-30",
        quantity: null,
        price: 87.5,
        commission: 0,
        totalAmount: 87.5,
        exchangeRate: 1,
        description: null,
        ...overrides,
      }) as InvestmentTransaction;

    beforeEach(() => {
      accountsService.findOne.mockImplementation(
        (_uid: string, aid: string) => {
          if (aid === accountId) return Promise.resolve(mockInvestmentAccount);
          if (aid === cashAccountId) return Promise.resolve(mockCashAccount);
          if (aid === fundingAccountId)
            return Promise.resolve(mockFundingAccount);
          return Promise.reject(new NotFoundException("Account not found"));
        },
      );
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder(storedRedemption()),
      );
      investmentTransactionsRepository.find.mockResolvedValue([
        storedCompanion(),
      ]);
      // The companion is saved before the redemption's id is reused by the
      // default save() double, so give it one of its own.
      investmentTransactionsRepository.save.mockImplementation((data: any) =>
        Promise.resolve({
          ...data,
          id:
            data.id ||
            (data.action === InvestmentAction.INTEREST
              ? companionId
              : transactionId),
        }),
      );
    });

    describe("create", () => {
      it("stores proceeds -- not proceeds plus interest -- as totalAmount", async () => {
        await service.create(userId, redeemDto());

        // 10 * 1000 - 25. Folding the 87.50 in here would report interest as
        // capital gain on every realized-gain surface.
        expect(investmentTransactionsRepository.create).toHaveBeenCalledWith(
          expect.objectContaining({
            action: InvestmentAction.REDEEM,
            totalAmount: 9975,
          }),
        );
      });

      it("writes the interest as a linked INTEREST row with no cash row of its own", async () => {
        await service.create(userId, redeemDto());

        expect(investmentTransactionsRepository.create).toHaveBeenCalledWith(
          expect.objectContaining({
            action: InvestmentAction.INTEREST,
            totalAmount: 87.5,
            price: 87.5,
            quantity: null,
            transactionId: null,
            linkedTransactionId: transactionId,
            // One event, one status.
            status: TransactionStatus.UNRECONCILED,
          }),
        );
      });

      it("moves the cash once, for proceeds plus interest", async () => {
        await service.create(userId, redeemDto());

        const cashRows = transactionRepository.create.mock.calls.filter(
          ([row]: [{ accountId: string }]) => row.accountId === cashAccountId,
        );
        expect(cashRows).toHaveLength(1);
        expect(cashRows[0][0]).toEqual(
          expect.objectContaining({ amount: 10062.5 }),
        );
        expect(accountsService.updateBalance).toHaveBeenCalledTimes(1);
        expect(accountsService.updateBalance).toHaveBeenCalledWith(
          cashAccountId,
          10062.5,
        );
      });

      it("writes no companion when there is no accrued interest", async () => {
        await service.create(userId, redeemDto({ accruedInterest: 0 }));

        const interestRows =
          investmentTransactionsRepository.create.mock.calls.filter(
            ([row]: [{ action: InvestmentAction }]) =>
              row.action === InvestmentAction.INTEREST,
          );
        expect(interestRows).toHaveLength(0);
        expect(accountsService.updateBalance).toHaveBeenCalledWith(
          cashAccountId,
          9975,
        );
      });

      it("converts the combined figure at one rate", async () => {
        currenciesService.findOne.mockResolvedValue({
          code: "CAD",
          decimalPlaces: 2,
        });
        accountsService.findOne.mockImplementation(
          (_uid: string, aid: string) => {
            if (aid === accountId)
              return Promise.resolve(mockInvestmentAccount);
            if (aid === cashAccountId)
              return Promise.resolve({
                ...mockCashAccount,
                currencyCode: "CAD",
              });
            return Promise.reject(new NotFoundException("Account not found"));
          },
        );

        await service.create(userId, redeemDto({ exchangeRate: 1.35 }));

        // (9975 + 87.50) * 1.35 = 13,584.375 -> 13,584.38 at the cash
        // currency's 2dp. Converting each component separately would round
        // twice and land elsewhere.
        expect(accountsService.updateBalance).toHaveBeenCalledWith(
          cashAccountId,
          13584.38,
        );
      });

      it("creates a VOID companion for a VOID redemption and moves no balance", async () => {
        await service.create(
          userId,
          redeemDto({ status: TransactionStatus.VOID }),
        );

        expect(investmentTransactionsRepository.create).toHaveBeenCalledWith(
          expect.objectContaining({
            action: InvestmentAction.INTEREST,
            status: TransactionStatus.VOID,
          }),
        );
        expect(accountsService.updateBalance).not.toHaveBeenCalled();
      });

      it("refuses accrued interest on an action that cannot carry it", async () => {
        await expect(
          service.create(
            userId,
            redeemDto({ action: InvestmentAction.SELL, accruedInterest: 87.5 }),
          ),
        ).rejects.toThrow(BadRequestException);

        expect(investmentTransactionsRepository.save).not.toHaveBeenCalled();
      });
    });

    describe("update", () => {
      beforeEach(() => {
        transactionRepository.findOne.mockResolvedValue({
          id: cashTransactionId,
          accountId: cashAccountId,
          amount: 10062.5,
          transactionDate: "2025-06-30",
          status: TransactionStatus.CLEARED,
        });
      });

      it("re-amounts the single cash row when the interest changes", async () => {
        investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
          createMockQueryBuilder(storedRedemption()),
        );
        investmentTransactionsRepository.findOne.mockResolvedValue(
          storedCompanion(),
        );

        await service.update(userId, transactionId, {
          accruedInterest: 100,
        } as UpdateInvestmentTransactionDto);

        const cashRows = transactionRepository.create.mock.calls.filter(
          ([row]: [{ accountId: string }]) => row.accountId === cashAccountId,
        );
        expect(cashRows).toHaveLength(1);
        expect(cashRows[0][0]).toEqual(
          expect.objectContaining({ amount: 10075 }),
        );
      });

      it("keeps the stored interest when the edit does not mention it", async () => {
        // The form resends the whole row, so an absent field means unchanged --
        // reading it as zero would silently delete the interest and shrink the
        // cash row on a description-only edit.
        investmentTransactionsRepository.findOne.mockResolvedValue(
          storedCompanion(),
        );

        await service.update(userId, transactionId, {
          description: "Matured",
        } as UpdateInvestmentTransactionDto);

        const cashRows = transactionRepository.create.mock.calls.filter(
          ([row]: [{ accountId: string }]) => row.accountId === cashAccountId,
        );
        expect(cashRows[0][0]).toEqual(
          expect.objectContaining({ amount: 10062.5 }),
        );
      });

      it("deletes the companion when the interest goes to zero", async () => {
        investmentTransactionsRepository.findOne.mockResolvedValue(
          storedCompanion(),
        );

        await service.update(userId, transactionId, {
          accruedInterest: 0,
        } as UpdateInvestmentTransactionDto);

        expect(investmentTransactionsRepository.delete).toHaveBeenCalledWith({
          id: companionId,
          userId,
        });
        const cashRows = transactionRepository.create.mock.calls.filter(
          ([row]: [{ accountId: string }]) => row.accountId === cashAccountId,
        );
        expect(cashRows[0][0]).toEqual(
          expect.objectContaining({ amount: 9975 }),
        );
      });

      it("creates a companion when interest is added to a redemption without one", async () => {
        investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
          createMockQueryBuilder(
            storedRedemption({ linkedTransactionId: null }),
          ),
        );

        await service.update(userId, transactionId, {
          accruedInterest: 42,
        } as UpdateInvestmentTransactionDto);

        expect(investmentTransactionsRepository.create).toHaveBeenCalledWith(
          expect.objectContaining({
            action: InvestmentAction.INTEREST,
            totalAmount: 42,
            linkedTransactionId: transactionId,
          }),
        );
      });

      it("refuses to drop the action that carries the interest while interest remains", async () => {
        investmentTransactionsRepository.findOne.mockResolvedValue(
          storedCompanion(),
        );

        await expect(
          service.update(userId, transactionId, {
            action: InvestmentAction.SELL,
          } as UpdateInvestmentTransactionDto),
        ).rejects.toThrow(BadRequestException);
      });

      it("refuses a direct edit of the companion", async () => {
        investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
          createMockQueryBuilder(storedCompanion()),
        );
        investmentTransactionsRepository.findOne.mockResolvedValue(
          storedRedemption(),
        );

        await expect(
          service.update(userId, companionId, {
            price: 500,
          } as UpdateInvestmentTransactionDto),
        ).rejects.toThrow(BadRequestException);
      });
    });

    describe("delete", () => {
      it("refuses direct deletion of the companion before changing either row", async () => {
        investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
          createMockQueryBuilder(storedCompanion()),
        );
        investmentTransactionsRepository.findOne.mockResolvedValue(
          storedRedemption(),
        );

        await expect(service.remove(userId, companionId)).rejects.toThrow(
          BadRequestException,
        );

        expect(investmentTransactionsRepository.remove).not.toHaveBeenCalled();
        expect(mockQueryRunner.manager.update).not.toHaveBeenCalled();
        expect(accountsService.updateBalance).not.toHaveBeenCalled();
        expect(
          holdingsService.rebuildScopesFromTransactions,
        ).not.toHaveBeenCalled();
        expect(mockActionHistoryService.record).not.toHaveBeenCalled();
      });

      it("removes the companion with the redemption and reverses the cash once", async () => {
        investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
          createMockQueryBuilder(storedRedemption()),
        );
        investmentTransactionsRepository.findOne.mockResolvedValue(
          storedCompanion(),
        );
        transactionRepository.findOne.mockResolvedValue({
          id: cashTransactionId,
          accountId: cashAccountId,
          amount: 10062.5,
          transactionDate: "2025-06-30",
          status: TransactionStatus.CLEARED,
        });

        await service.remove(userId, transactionId);

        const removed = investmentTransactionsRepository.remove.mock.calls.map(
          ([row]: [{ id: string }]) => row.id,
        );
        expect(removed).toEqual(
          expect.arrayContaining([transactionId, companionId]),
        );
        expect(accountsService.updateBalance).toHaveBeenCalledTimes(1);
        expect(accountsService.updateBalance).toHaveBeenCalledWith(
          cashAccountId,
          -10062.5,
        );
      });
    });
  });

  /**
   * INV-BOND-007: every share-moving row of a program-linked security names a
   * series of that program, resolved by `resolveTransactionSeries` inside the
   * write's own transaction and before anything is written.
   * Canonical adversarial input: a rejected command reintroduced through a
   * second entry point -- so each write path of the service is driven.
   * Minimal mutation: delete the `resolveTransactionSeries` call of one path.
   */
  describe("the bond series of a share-moving row (INV-BOND-007)", () => {
    const PROGRAM = "prog-1";
    const SERIES_ON_SALE = "11111111-1111-5111-8111-111111111111";
    const OTHER_SERIES = "22222222-2222-5222-8222-222222222222";
    const buyDto = {
      accountId,
      securityId,
      action: InvestmentAction.BUY,
      transactionDate: "2026-10-15",
      quantity: 10,
      price: 100,
      commission: 0,
    };

    /** Answers the resolver's statements; everything else as the harness does. */
    /** A row of the bond ledger query (`loadBondLedger`). */
    const ledgerRow = (
      over: Partial<{
        id: string;
        action: string;
        tx_date: string;
        quantity: string;
        account_id: string;
        bond_instrument_id: string | null;
      }>,
    ) => ({
      id: "row-x",
      action: "BUY",
      status: "UNRECONCILED",
      tx_date: "2026-01-10",
      quantity: "10",
      account_id: accountId,
      bond_instrument_id: SERIES_ON_SALE,
      counterpart_account_id: null,
      ...over,
    });

    /**
     * Answers the resolver's statements and the write guard's ledger reads;
     * everything else as the harness does. `ledgers` are the answers of
     * successive ledger reads (the guard reads it before the mutation and again
     * after it); the last repeats.
     */
    const bondDatabase = (opts: {
      linked?: boolean;
      inProgram?: string[];
      onSale?: string[];
      ledgers?: Array<Array<ReturnType<typeof ledgerRow>>>;
      /**
       * The answers of successive reads of the price band
       * (`findQuantitiesNotBonds`: the rows outside it); the last repeats,
       * none at all means no row is out of band.
       */
      band?: Array<Array<{ id: string; price: string; face: string }>>;
    }) => {
      const original = mockQueryRunner.manager.query.getMockImplementation();
      let ledgerReads = 0;
      let bandReads = 0;
      mockQueryRunner.manager.query.mockImplementation(
        async (sql: string, params?: unknown[]) => {
          const text = String(sql);
          if (text.includes("bond_auto_fetch")) {
            return [
              {
                id: securityId,
                user_id: userId,
                symbol: "EDO",
                currency_code: "PLN",
                bond_program_id: opts.linked === false ? null : PROGRAM,
                bond_auto_fetch: false,
              },
            ];
          }
          if (text.includes("t.price IS NOT NULL")) {
            const all = opts.band ?? [[]];
            const rows = all[Math.min(bandReads, all.length - 1)];
            bandReads += 1;
            return rows;
          }
          if (text.includes("FROM bond_programs WHERE id")) {
            return [
              {
                issuer_country_code: "PL",
                issuer_code: "PL_MF",
                program_code: "EDO",
              },
            ];
          }
          if (text.includes("counterpart_account_id")) {
            const all = opts.ledgers ?? [[]];
            const rows = all[Math.min(ledgerReads, all.length - 1)];
            ledgerReads += 1;
            return rows;
          }
          if (text.includes("s.bond_program_id AS id")) {
            return [
              opts.linked === false
                ? { id: null, program_code: null }
                : { id: PROGRAM, program_code: "EDO" },
            ];
          }
          if (text.includes("id = $1::uuid AND bond_program_id")) {
            return (opts.inProgram ?? []).includes(String(params?.[0]))
              ? [{ "?column?": 1 }]
              : [];
          }
          if (text.includes("saleWindow")) {
            return (opts.onSale ?? []).map((id) => ({ id }));
          }
          if (text.includes("SELECT series_code")) {
            return [{ series_code: "EDO1036" }];
          }
          return original ? original(sql, params) : [];
        },
      );
    };
    const created = () =>
      mockQueryRunner.manager.create.mock.calls
        .filter(([entity]: any[]) => entity === InvestmentTransaction)
        .map(([, data]: any[]) => data);

    beforeEach(() => {
      accountsService.findOne.mockImplementation((_u: string, aid: string) => {
        if (aid === accountId) return Promise.resolve(mockInvestmentAccount);
        if (aid === cashAccountId) return Promise.resolve(mockCashAccount);
        return Promise.reject(new NotFoundException("Account not found"));
      });
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder(mockBuyTransaction),
      );
    });

    describe("create (also bulk, AI and MCP, which commit through it)", () => {
      it("infers the series on sale on the date and stores it", async () => {
        bondDatabase({ onSale: [SERIES_ON_SALE] });
        await service.create(userId, buyDto);
        expect(created()[0]).toMatchObject({
          bondInstrumentId: SERIES_ON_SALE,
        });
      });

      it("stores a series of the program that is named, whatever is on sale", async () => {
        bondDatabase({ inProgram: [OTHER_SERIES], onSale: [SERIES_ON_SALE] });
        await service.create(userId, {
          ...buyDto,
          bondInstrumentId: OTHER_SERIES,
        });
        expect(created()[0]).toMatchObject({ bondInstrumentId: OTHER_SERIES });
      });

      it("refuses a series of another program before anything is written", async () => {
        bondDatabase({ inProgram: [], onSale: [SERIES_ON_SALE] });
        await expect(
          service.create(userId, { ...buyDto, bondInstrumentId: OTHER_SERIES }),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(created()).toEqual([]);
        expect(mockQueryRunner.manager.save).not.toHaveBeenCalled();
        expect(
          holdingsService.rebuildScopesFromTransactions,
        ).not.toHaveBeenCalled();
        expect(
          securitiesService.recomputeBondPricesAfterWrite,
        ).not.toHaveBeenCalled();
      });

      it("refuses an acquisition no stored series covers (SERIES_NOT_DETERMINED), naming the date, before anything is written", async () => {
        bondDatabase({ onSale: [] });
        await expect(service.create(userId, buyDto)).rejects.toThrow(
          /2026-10-15/,
        );
        expect(created()).toEqual([]);
        expect(mockQueryRunner.manager.save).not.toHaveBeenCalled();
      });

      it("does not guess when two stored series were on sale", async () => {
        bondDatabase({ onSale: [SERIES_ON_SALE, OTHER_SERIES] });
        await expect(service.create(userId, buyDto)).rejects.toBeInstanceOf(
          BadRequestException,
        );
        expect(created()).toEqual([]);
      });

      it("leaves a removal without a series when none is named, and checks one that is", async () => {
        bondDatabase({ inProgram: [SERIES_ON_SALE], onSale: [] });
        await service.create(userId, {
          ...buyDto,
          action: InvestmentAction.SELL,
        });
        expect(created()[0]).toMatchObject({ bondInstrumentId: null });

        mockQueryRunner.manager.create.mockClear();
        await service.create(userId, {
          ...buyDto,
          action: InvestmentAction.SELL,
          bondInstrumentId: SERIES_ON_SALE,
        });
        expect(created()[0]).toMatchObject({
          bondInstrumentId: SERIES_ON_SALE,
        });

        await expect(
          service.create(userId, {
            ...buyDto,
            action: InvestmentAction.SELL,
            bondInstrumentId: OTHER_SERIES,
          }),
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it("never sets a series on a security that is not linked to a program, and refuses one that is named", async () => {
        bondDatabase({ linked: false, onSale: [SERIES_ON_SALE] });
        await service.create(userId, buyDto);
        expect(created()[0]).toMatchObject({ bondInstrumentId: null });

        mockQueryRunner.manager.create.mockClear();
        await expect(
          service.create(userId, { ...buyDto, bondInstrumentId: OTHER_SERIES }),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(created()).toEqual([]);
      });

      it("refuses a SELL naming a series the account does not hold enough of (REMOVAL_EXCEEDS_SERIES), after the mutation, so nothing commits", async () => {
        const buy = ledgerRow({ id: "b1", quantity: "5" });
        const sell = ledgerRow({
          id: "written-1",
          action: "SELL",
          tx_date: "2026-10-15",
          quantity: "10",
        });
        bondDatabase({
          inProgram: [SERIES_ON_SALE],
          ledgers: [[buy], [buy, sell]],
        });
        mockQueryRunner.manager.save.mockImplementationOnce(
          async (data: object) => ({ ...data, id: "written-1" }),
        );
        const attempt = service.create(userId, {
          ...buyDto,
          action: InvestmentAction.SELL,
          bondInstrumentId: SERIES_ON_SALE,
        });
        await expect(attempt).rejects.toMatchObject({
          response: { errorCode: "REMOVAL_EXCEEDS_SERIES" },
        });
        await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
        // The check ran inside the write's transaction, after the mutation;
        // the throw rolls the scoped transaction back, so nothing after it ran.
        expect(mockQueryRunner.manager.save).toHaveBeenCalled();
        expect(
          securitiesService.recomputeBondPricesAfterWrite,
        ).not.toHaveBeenCalled();
        expect(mockActionHistoryService.record).not.toHaveBeenCalled();
      });

      it("refuses a SELL that names no series when it removes more bonds than the account holds (OVER_REMOVAL)", async () => {
        const buy = ledgerRow({ id: "b1", quantity: "5" });
        const sell = ledgerRow({
          id: "written-1",
          action: "SELL",
          tx_date: "2026-10-15",
          quantity: "10",
          bond_instrument_id: null,
        });
        bondDatabase({ ledgers: [[buy], [buy, sell]] });
        await expect(
          service.create(userId, { ...buyDto, action: InvestmentAction.SELL }),
        ).rejects.toMatchObject({ response: { errorCode: "OVER_REMOVAL" } });
      });

      it("is not blocked by a removal problem that already existed about another row, but is when the refusal names the written row", async () => {
        const buy = ledgerRow({ id: "b1", quantity: "5" });
        const oldSell = ledgerRow({
          id: "old",
          action: "SELL",
          tx_date: "2026-03-01",
          quantity: "9",
          bond_instrument_id: null,
        });
        bondDatabase({
          onSale: [SERIES_ON_SALE],
          ledgers: [
            [buy, oldSell],
            [buy, oldSell],
          ],
        });
        await expect(service.create(userId, buyDto)).resolves.toBeDefined();

        // The same old refusal, but now the written row is the one refused.
        const written = ledgerRow({
          id: "written-1",
          action: "SELL",
          tx_date: "2026-02-01",
          quantity: "9",
          bond_instrument_id: null,
        });
        bondDatabase({
          onSale: [SERIES_ON_SALE],
          ledgers: [
            [buy, oldSell],
            [buy, written, oldSell],
          ],
        });
        mockQueryRunner.manager.save.mockImplementationOnce(
          async (data: object) => ({ ...data, id: "written-1" }),
        );
        await expect(service.create(userId, buyDto)).rejects.toMatchObject({
          response: { errorCode: "OVER_REMOVAL" },
        });
      });

      it("refuses an ADD_SHARES or an unpaired TRANSFER_IN that names no series (SERIES_REQUIRED), never inferring one from the date", async () => {
        bondDatabase({ onSale: [SERIES_ON_SALE] });
        for (const action of [
          InvestmentAction.ADD_SHARES,
          InvestmentAction.TRANSFER_IN,
        ]) {
          await expect(
            service.create(userId, { ...buyDto, action, price: undefined }),
          ).rejects.toMatchObject({
            response: { errorCode: "SERIES_REQUIRED" },
          });
        }
        expect(created()).toEqual([]);

        // Named, they are accepted.
        bondDatabase({ inProgram: [OTHER_SERIES], onSale: [SERIES_ON_SALE] });
        await service.create(userId, {
          ...buyDto,
          action: InvestmentAction.ADD_SHARES,
          price: undefined,
          bondInstrumentId: OTHER_SERIES,
        });
        expect(created()[0]).toMatchObject({ bondInstrumentId: OTHER_SERIES });
      });

      it("refuses a series on a cash action", async () => {
        bondDatabase({ inProgram: [SERIES_ON_SALE] });
        await expect(
          service.create(userId, {
            accountId,
            securityId,
            action: InvestmentAction.DIVIDEND,
            transactionDate: "2026-10-15",
            price: 5,
            bondInstrumentId: SERIES_ON_SALE,
          }),
        ).rejects.toBeInstanceOf(BadRequestException);
      });
    });

    describe("update", () => {
      it("refuses a series of another program before the reversal writes anything", async () => {
        bondDatabase({ inProgram: [] });
        await expect(
          service.update(userId, transactionId, {
            bondInstrumentId: OTHER_SERIES,
          }),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(mockQueryRunner.manager.save).not.toHaveBeenCalled();
        expect(accountsService.updateBalance).not.toHaveBeenCalled();
      });

      it("keeps the stored series as it is when the edit changes neither it, the security, the action nor the date, even if the program no longer holds it", async () => {
        bondDatabase({ inProgram: [], onSale: [SERIES_ON_SALE] });
        investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
          createMockQueryBuilder({
            ...mockBuyTransaction,
            bondInstrumentId: OTHER_SERIES,
          }),
        );
        await service.update(userId, transactionId, {
          description: "renamed",
          bondInstrumentId: OTHER_SERIES,
        });
        // Not a request (the value is unchanged), so it is neither refused nor
        // re-resolved: the stored value stays as it is.
        expect(mockQueryRunner.manager.save).toHaveBeenCalledWith(
          expect.objectContaining({ bondInstrumentId: OTHER_SERIES }),
        );
      });

      it("keeps a NULL series of a legacy row on an unrelated edit instead of asking for a series (a BUY with none on sale, an ADD_SHARES)", async () => {
        bondDatabase({ onSale: [] });
        for (const action of [
          InvestmentAction.BUY,
          InvestmentAction.ADD_SHARES,
        ]) {
          mockQueryRunner.manager.save.mockClear();
          investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
            createMockQueryBuilder({
              ...mockBuyTransaction,
              action,
              bondInstrumentId: null,
            }),
          );
          await service.update(userId, transactionId, {
            description: "renamed",
            action,
            transactionDate: mockBuyTransaction.transactionDate,
          });
          expect(mockQueryRunner.manager.save).toHaveBeenCalledWith(
            expect.objectContaining({ bondInstrumentId: null }),
          );
        }
      });

      it("resolves the series again when the date changes (a BUY with none on the new date is refused before any write)", async () => {
        bondDatabase({ onSale: [] });
        await expect(
          service.update(userId, transactionId, {
            transactionDate: "2025-02-20",
          }),
        ).rejects.toThrow(/2025-02-20/);
        expect(mockQueryRunner.manager.save).not.toHaveBeenCalled();
      });

      it("asks for the series when an edit turns the row into an ADD_SHARES that has none (SERIES_REQUIRED)", async () => {
        bondDatabase({ onSale: [SERIES_ON_SALE] });
        await expect(
          service.update(userId, transactionId, {
            action: InvestmentAction.ADD_SHARES,
          }),
        ).rejects.toMatchObject({
          response: { errorCode: "SERIES_REQUIRED" },
        });
        expect(mockQueryRunner.manager.save).not.toHaveBeenCalled();
      });

      it("refuses an edit after which a removal naming a series is not covered (REMOVAL_EXCEEDS_SERIES), and an unrelated edit is not blocked by an old refusal", async () => {
        const buy = ledgerRow({ id: "b1", quantity: "10" });
        const sell = ledgerRow({
          id: transactionId,
          action: "SELL",
          tx_date: "2026-02-01",
          quantity: "8",
        });
        // Derivable before; after the edit the BUY holds fewer than the SELL.
        bondDatabase({
          ledgers: [
            [buy, sell],
            [{ ...buy, quantity: "5" }, sell],
          ],
        });
        await expect(
          service.update(userId, transactionId, { quantity: 5 }),
        ).rejects.toMatchObject({
          response: { errorCode: "REMOVAL_EXCEEDS_SERIES" },
        });

        // A refusal that already existed about another row blocks nothing.
        const oldSell = ledgerRow({
          id: "old",
          action: "SELL",
          tx_date: "2026-03-01",
          quantity: "99",
        });
        bondDatabase({ ledgers: [[buy, oldSell]] });
        await expect(
          service.update(userId, transactionId, { description: "renamed" }),
        ).resolves.toBeDefined();
      });

      it("stores a newly named series of the program", async () => {
        bondDatabase({ inProgram: [OTHER_SERIES] });
        await service.update(userId, transactionId, {
          bondInstrumentId: OTHER_SERIES,
        });
        expect(mockQueryRunner.manager.save).toHaveBeenCalledWith(
          expect.objectContaining({ bondInstrumentId: OTHER_SERIES }),
        );
      });
    });

    describe("remove and void (an acquisition leaving a later removal uncovered)", () => {
      const buy = () => ledgerRow({ id: transactionId, quantity: "10" });
      const sell = (series: string | null) =>
        ledgerRow({
          id: "s1",
          action: "SELL",
          tx_date: "2026-02-01",
          quantity: "8",
          bond_instrument_id: series,
        });

      it("refuses deleting a purchase a later SELL of its series depends on (REMOVAL_EXCEEDS_SERIES), after the mutation, so the delete rolls back", async () => {
        bondDatabase({
          ledgers: [[buy(), sell(SERIES_ON_SALE)], [sell(SERIES_ON_SALE)]],
        });
        await expect(
          service.remove(userId, transactionId),
        ).rejects.toMatchObject({
          response: { errorCode: "REMOVAL_EXCEEDS_SERIES" },
        });
        expect(mockQueryRunner.manager.remove).toHaveBeenCalled();
        expect(mockActionHistoryService.record).not.toHaveBeenCalled();
        expect(
          securitiesService.recomputeBondPricesAfterWrite,
        ).not.toHaveBeenCalled();
      });

      it("refuses it as OVER_REMOVAL when the SELL names no series, and allows a delete nothing depends on", async () => {
        bondDatabase({ ledgers: [[buy(), sell(null)], [sell(null)]] });
        await expect(
          service.remove(userId, transactionId),
        ).rejects.toMatchObject({
          response: { errorCode: "OVER_REMOVAL" },
        });
        bondDatabase({ ledgers: [[buy()], []] });
        await expect(
          service.remove(userId, transactionId),
        ).resolves.toBeUndefined();
      });

      it("is not blocked by an older removal problem that was already there", async () => {
        const old = [sell(null)];
        bondDatabase({ ledgers: [old, old] });
        await expect(
          service.remove(userId, transactionId),
        ).resolves.toBeUndefined();
      });

      it("refuses voiding such a purchase (updateStatus) under the same rule", async () => {
        bondDatabase({
          ledgers: [[buy(), sell(SERIES_ON_SALE)], [sell(SERIES_ON_SALE)]],
        });
        const bondQuery =
          mockQueryRunner.manager.query.getMockImplementation()!;
        mockQueryRunner.manager.query.mockImplementation(
          async (sql: string, params?: unknown[]) =>
            /FOR UPDATE/i.test(String(sql)) &&
            /investment_transactions/i.test(String(sql))
              ? [
                  {
                    id: transactionId,
                    account_id: accountId,
                    security_id: securityId,
                    funding_account_id: null,
                    transaction_id: null,
                    transaction_split_id: null,
                    linked_transaction_id: null,
                    action: InvestmentAction.BUY,
                    transaction_date: "2026-01-10",
                    quantity: "10",
                    price: "100",
                    commission: "0",
                    total_amount: "1000",
                    exchange_rate: "1",
                    status: TransactionStatus.CLEARED,
                  },
                ]
              : bondQuery(sql, params),
        );
        await expect(
          service.updateStatus(userId, transactionId, TransactionStatus.VOID),
        ).rejects.toMatchObject({
          response: { errorCode: "REMOVAL_EXCEEDS_SERIES" },
        });
      });
    });

    describe("transferSecurity", () => {
      const toAccountId = "account-2";
      beforeEach(() => {
        accountsService.findOne.mockImplementation((_u: string, aid: string) =>
          Promise.resolve(
            aid === toAccountId
              ? {
                  id: toAccountId,
                  userId,
                  accountType: "INVESTMENT",
                  accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
                  currencyCode: "USD",
                  name: "B",
                }
              : mockInvestmentAccount,
          ),
        );
      });
      const transferDto = {
        fromAccountId: accountId,
        toAccountId,
        securityId,
        transactionDate: "2026-11-01",
        quantity: 5,
        costPerShare: 100,
      };

      it("stores a named series on both legs, and none when none is named (FIFO across series)", async () => {
        bondDatabase({ inProgram: [OTHER_SERIES] });
        await service.transferSecurity(userId, {
          ...transferDto,
          bondInstrumentId: OTHER_SERIES,
        });
        expect(created().map((leg: any) => leg.bondInstrumentId)).toEqual([
          OTHER_SERIES,
          OTHER_SERIES,
        ]);

        mockQueryRunner.manager.create.mockClear();
        await service.transferSecurity(userId, transferDto);
        expect(created().map((leg: any) => leg.bondInstrumentId)).toEqual([
          null,
          null,
        ]);
      });

      it("refuses a transfer after which the source does not hold enough of the series (REMOVAL_EXCEEDS_SERIES)", async () => {
        const buy = ledgerRow({ id: "b1", quantity: "3" });
        const out = ledgerRow({
          id: "out-1",
          action: "TRANSFER_OUT",
          tx_date: "2026-11-01",
          quantity: "5",
          counterpart_account_id: toAccountId,
        } as never);
        bondDatabase({
          inProgram: [SERIES_ON_SALE],
          ledgers: [[buy], [buy, out]],
        });
        await expect(
          service.transferSecurity(userId, {
            ...transferDto,
            bondInstrumentId: SERIES_ON_SALE,
          }),
        ).rejects.toMatchObject({
          response: { errorCode: "REMOVAL_EXCEEDS_SERIES" },
        });
      });

      it("refuses a series of another program before either leg is written", async () => {
        bondDatabase({ inProgram: [] });
        await expect(
          service.transferSecurity(userId, {
            ...transferDto,
            bondInstrumentId: OTHER_SERIES,
          }),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(created()).toEqual([]);
      });
    });

    describe("a transaction embedded in a split", () => {
      it("infers the series from the parent's date", async () => {
        bondDatabase({ onSale: [SERIES_ON_SALE] });
        accountsService.findOne.mockResolvedValue(mockInvestmentAccount);
        securitiesService.findOne.mockResolvedValue(mockSecurity);
        await service.createEmbeddedForSplit(
          mockQueryRunner.manager as never,
          userId,
          "2026-10-15",
          "split-1",
          accountId,
          cashAccountId,
          {
            action: InvestmentAction.BUY,
            securityId,
            quantity: 10,
            price: 100,
            commission: 0,
          },
        );
        expect(created().at(-1)).toMatchObject({
          bondInstrumentId: SERIES_ON_SALE,
        });
      });

      it("keeps the series its predecessor carried, NULL included, when the incoming split names none and none is on sale (a parent-only edit)", async () => {
        bondDatabase({ onSale: [] });
        accountsService.findOne.mockResolvedValue(mockInvestmentAccount);
        securitiesService.findOne.mockResolvedValue(mockSecurity);
        const dto = {
          action: InvestmentAction.BUY,
          securityId,
          quantity: 10,
          price: 100,
          commission: 0,
        };
        for (const carried of [null, OTHER_SERIES]) {
          await service.createEmbeddedForSplit(
            mockQueryRunner.manager as never,
            userId,
            "2026-10-15",
            "split-1",
            accountId,
            cashAccountId,
            dto,
            undefined,
            undefined,
            { bondInstrumentId: carried },
          );
          expect(created().at(-1)).toMatchObject({ bondInstrumentId: carried });
        }
      });

      it("takes a series the incoming split names over the carried one", async () => {
        bondDatabase({ inProgram: [SERIES_ON_SALE], onSale: [] });
        accountsService.findOne.mockResolvedValue(mockInvestmentAccount);
        securitiesService.findOne.mockResolvedValue(mockSecurity);
        await service.createEmbeddedForSplit(
          mockQueryRunner.manager as never,
          userId,
          "2026-10-15",
          "split-1",
          accountId,
          cashAccountId,
          {
            action: InvestmentAction.BUY,
            securityId,
            quantity: 10,
            price: 100,
            commission: 0,
            bondInstrumentId: SERIES_ON_SALE,
          },
          undefined,
          undefined,
          { bondInstrumentId: null },
        );
        expect(created().at(-1)).toMatchObject({
          bondInstrumentId: SERIES_ON_SALE,
        });
      });

      it("refuses before the row is written when no series covers the date", async () => {
        bondDatabase({ onSale: [] });
        accountsService.findOne.mockResolvedValue(mockInvestmentAccount);
        securitiesService.findOne.mockResolvedValue(mockSecurity);
        await expect(
          service.createEmbeddedForSplit(
            mockQueryRunner.manager as never,
            userId,
            "2026-10-15",
            "split-1",
            accountId,
            cashAccountId,
            {
              action: InvestmentAction.BUY,
              securityId,
              quantity: 10,
              price: 100,
              commission: 0,
            },
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(mockQueryRunner.manager.save).not.toHaveBeenCalled();
      });
    });

    describe("the preview of the AI assistant and MCP", () => {
      beforeEach(() => {
        securitiesService.resolveBySymbolOrName.mockResolvedValue({
          match: mockSecurity,
          candidates: [],
        });
        securitiesService.findOne.mockResolvedValue(mockSecurity);
      });
      const previewInput = {
        accountId,
        action: InvestmentAction.BUY,
        transactionDate: "2026-10-15",
        securityQuery: "AAPL",
        quantity: 10,
        price: 100,
      };

      it("shows the series the commit will store, inferred from the date", async () => {
        bondDatabase({ onSale: [SERIES_ON_SALE] });
        await expect(
          service.previewCreateInvestmentTransaction(userId, previewInput),
        ).resolves.toMatchObject({
          bondInstrumentId: SERIES_ON_SALE,
          bondSeriesCode: "EDO1036",
        });
      });

      it("resolves a series code within the program, and refuses one it does not hold", async () => {
        bondDatabase({ inProgram: [SERIES_ON_SALE] });
        const original = mockQueryRunner.manager.query.getMockImplementation()!;
        mockQueryRunner.manager.query.mockImplementation(
          async (sql: string, params?: unknown[]) =>
            String(sql).includes("UPPER(series_code) = UPPER($2)")
              ? params?.[1] === "EDO1036"
                ? [{ id: SERIES_ON_SALE }]
                : []
              : original(sql, params),
        );
        await expect(
          service.previewCreateInvestmentTransaction(userId, {
            ...previewInput,
            bondSeriesCode: "EDO9999",
          }),
        ).rejects.toBeInstanceOf(BadRequestException);

        await expect(
          service.previewCreateInvestmentTransaction(userId, {
            ...previewInput,
            bondSeriesCode: "EDO1036",
          }),
        ).resolves.toMatchObject({ bondInstrumentId: SERIES_ON_SALE });
        await expect(
          service.previewCreateInvestmentTransaction(userId, {
            ...previewInput,
            bondSeriesCode: "COI1030",
          }),
        ).rejects.toThrow(/COI1030/);
      });

      it("refuses what the commit would refuse: no series covers the date", async () => {
        bondDatabase({ onSale: [] });
        await expect(
          service.previewCreateInvestmentTransaction(userId, previewInput),
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it("shows no series for a security that is not linked", async () => {
        bondDatabase({ linked: false });
        await expect(
          service.previewCreateInvestmentTransaction(userId, previewInput),
        ).resolves.toMatchObject({
          bondInstrumentId: null,
          bondSeriesCode: null,
        });
      });
    });

    describe("the preview of an edit of a legacy row with no stored series (L4)", () => {
      beforeEach(() => {
        securitiesService.resolveBySymbolOrName.mockResolvedValue({
          match: mockSecurity,
          candidates: [],
        });
        securitiesService.findOne.mockResolvedValue(mockSecurity);
      });
      const legacy = (action: InvestmentAction) =>
        investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
          createMockQueryBuilder({
            ...mockBuyTransaction,
            action,
            bondInstrumentId: null,
          }),
        );

      it.each([InvestmentAction.ADD_SHARES, InvestmentAction.BUY])(
        "keeps the NULL series of a %s on a description-only edit instead of refusing it, as update() does",
        async (action) => {
          bondDatabase({ onSale: [] });
          legacy(action);
          await expect(
            service.previewUpdateInvestmentTransaction(userId, transactionId, {
              description: "renamed",
            }),
          ).resolves.toMatchObject({
            bondInstrumentId: null,
            bondSeriesCode: null,
            description: "renamed",
          });
        },
      );

      it("still resolves the series when the edit changes the date, the action or names a series", async () => {
        bondDatabase({ onSale: [] });
        legacy(InvestmentAction.BUY);
        await expect(
          service.previewUpdateInvestmentTransaction(userId, transactionId, {
            transactionDate: "2025-02-20",
          }),
        ).rejects.toMatchObject({
          response: { errorCode: "SERIES_NOT_DETERMINED" },
        });
        legacy(InvestmentAction.BUY);
        await expect(
          service.previewUpdateInvestmentTransaction(userId, transactionId, {
            action: InvestmentAction.ADD_SHARES,
          }),
        ).rejects.toMatchObject({
          response: { errorCode: "SERIES_REQUIRED" },
        });
      });
    });

    /**
     * INV-BOND-009: a bond-linked REDEEM through the assistant or MCP is split
     * into returned principal and interest by the server, never left to the
     * caller to book as a capital gain.
     */
    describe("the redemption split of a bond REDEEM in the preview (INV-BOND-009)", () => {
      const EDO0423 = "33333333-3333-5333-8333-333333333333";
      // 10 x EDO0423 redeemed at maturity: 147.05 per bond, i.e. 100.00 of
      // principal and 47.05 of interest each.
      const AT_MATURITY = {
        date: "2023-04-01",
        quantity: 10,
        principal: "1000.00",
        grossInterest: "470.50",
        deduction: "0.00",
        interest: "470.50",
        principalReturned: "1000.00",
        payout: "1470.50",
        refusal: null,
      };
      const redeem = {
        accountId,
        action: InvestmentAction.REDEEM,
        transactionDate: "2023-04-01",
        securityQuery: "AAPL",
        quantity: 10,
      };

      beforeEach(() => {
        securitiesService.resolveBySymbolOrName.mockResolvedValue({
          match: mockSecurity,
          candidates: [],
        });
        securitiesService.findOne.mockResolvedValue(mockSecurity);
        bondDatabase({});
        bondHoldingsService.seriesHoldings.mockResolvedValue({
          holdings: [
            { instrumentId: EDO0423, seriesCode: "EDO0423", quantity: 10 },
          ],
        });
        bondHoldingsService.redemptionSplit.mockResolvedValue(AT_MATURITY);
      });

      it("fills price 100.00 and accrued interest 470.50 when the caller gave neither, and names the series the split was worked out for", async () => {
        const preview = await service.previewCreateInvestmentTransaction(
          userId,
          redeem,
        );
        expect(bondHoldingsService.redemptionSplit).toHaveBeenCalledWith(
          userId,
          securityId,
          accountId,
          EDO0423,
          "2023-04-01",
          10,
          undefined,
        );
        expect(preview).toMatchObject({
          price: 100,
          accruedInterest: 470.5,
          totalAmount: 1000,
          // The one cash row is the payout.
          cashAmount: 1470.5,
          bondInstrumentId: EDO0423,
          bondSeriesCode: "EDO0423",
          redemptionSplit: {
            principal: 1000,
            interest: 470.5,
            deduction: 0,
            payout: 1470.5,
            outcome: "filled",
          },
        });
      });

      it("splits a price that is the whole payout per bond (147.05) instead of booking its interest as a gain", async () => {
        const preview = await service.previewCreateInvestmentTransaction(
          userId,
          { ...redeem, price: 147.05 },
        );
        expect(preview).toMatchObject({
          price: 100,
          accruedInterest: 470.5,
          totalAmount: 1000,
          cashAmount: 1470.5,
        });
        expect(preview.redemptionSplit?.outcome).toBe("filled");

        // The same payout stated as an executed total.
        const byTotal = await service.previewCreateInvestmentTransaction(
          userId,
          { ...redeem, totalAmount: 1470.5 },
        );
        expect(byTotal).toMatchObject({
          price: 100,
          accruedInterest: 470.5,
          totalAmount: 1000,
        });
      });

      it("fills only the price when the caller gave the interest", async () => {
        const preview = await service.previewCreateInvestmentTransaction(
          userId,
          { ...redeem, accruedInterest: 470.5 },
        );
        expect(preview).toMatchObject({ price: 100, accruedInterest: 470.5 });
        expect(preview.redemptionSplit?.outcome).toBe("filled");
      });

      it("keeps both figures the caller gave and flags a difference from the split instead of overriding", async () => {
        const matching = await service.previewCreateInvestmentTransaction(
          userId,
          { ...redeem, price: 100, accruedInterest: 470.5 },
        );
        expect(matching.redemptionSplit?.outcome).toBe("matches");

        const differing = await service.previewCreateInvestmentTransaction(
          userId,
          { ...redeem, price: 100, accruedInterest: 400 },
        );
        expect(differing).toMatchObject({
          price: 100,
          accruedInterest: 400,
          cashAmount: 1400,
          redemptionSplit: {
            interest: 470.5,
            payout: 1470.5,
            outcome: "differs",
          },
        });

        // A price that is not the payout, with no interest: kept, flagged.
        const principalOnly = await service.previewCreateInvestmentTransaction(
          userId,
          { ...redeem, price: 100 },
        );
        expect(principalOnly).toMatchObject({
          price: 100,
          accruedInterest: 0,
          redemptionSplit: { outcome: "differs" },
        });
      });

      it("refuses the preview when the split cannot be worked out, guessing nothing", async () => {
        bondHoldingsService.redemptionSplit.mockResolvedValue({
          ...AT_MATURITY,
          interest: null,
          grossInterest: null,
          principalReturned: null,
          payout: null,
          refusal: "RATE_UNKNOWN",
        });
        await expect(
          service.previewCreateInvestmentTransaction(userId, redeem),
        ).rejects.toMatchObject({
          response: { errorCode: "RATE_UNKNOWN" },
        });
        // Both figures stated: the split is only a comparison, so no refusal.
        await expect(
          service.previewCreateInvestmentTransaction(userId, {
            ...redeem,
            price: 100,
            accruedInterest: 470.5,
          }),
        ).resolves.toMatchObject({
          price: 100,
          accruedInterest: 470.5,
          redemptionSplit: null,
        });
      });

      it("asks for the series when the account holds none or several, unless both figures were given", async () => {
        bondHoldingsService.seriesHoldings.mockResolvedValue({
          holdings: [
            { instrumentId: EDO0423, seriesCode: "EDO0423", quantity: 5 },
            { instrumentId: OTHER_SERIES, seriesCode: "EDO0523", quantity: 5 },
          ],
        });
        await expect(
          service.previewCreateInvestmentTransaction(userId, redeem),
        ).rejects.toMatchObject({
          response: { errorCode: "REDEEM_SERIES_REQUIRED" },
        });
        expect(bondHoldingsService.redemptionSplit).not.toHaveBeenCalled();
        await expect(
          service.previewCreateInvestmentTransaction(userId, {
            ...redeem,
            price: 100,
            accruedInterest: 470.5,
          }),
        ).resolves.toMatchObject({ redemptionSplit: null });
      });

      it("takes the split of the series the caller named, whatever else the account holds", async () => {
        bondDatabase({ inProgram: [EDO0423] });
        const original = mockQueryRunner.manager.query.getMockImplementation()!;
        mockQueryRunner.manager.query.mockImplementation(
          async (sql: string, params?: unknown[]) =>
            String(sql).includes("UPPER(series_code) = UPPER($2)")
              ? [{ id: EDO0423 }]
              : original(sql, params),
        );
        const preview = await service.previewCreateInvestmentTransaction(
          userId,
          { ...redeem, bondSeriesCode: "EDO0423" },
        );
        expect(bondHoldingsService.seriesHoldings).not.toHaveBeenCalled();
        expect(bondHoldingsService.redemptionSplit).toHaveBeenCalledWith(
          userId,
          securityId,
          accountId,
          EDO0423,
          "2023-04-01",
          10,
          undefined,
        );
        expect(preview).toMatchObject({ price: 100, accruedInterest: 470.5 });
      });

      it("leaves a security that is not linked to a bond program alone", async () => {
        bondDatabase({ linked: false });
        const preview = await service.previewCreateInvestmentTransaction(
          userId,
          { ...redeem, price: 100 },
        );
        expect(bondHoldingsService.redemptionSplit).not.toHaveBeenCalled();
        expect(preview).toMatchObject({
          price: 100,
          accruedInterest: 0,
          redemptionSplit: null,
        });
      });

      it("works the split of an edit without the row being edited, keeps its stored series and pins none", async () => {
        investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
          createMockQueryBuilder({
            ...mockBuyTransaction,
            action: InvestmentAction.REDEEM,
            quantity: 10,
            price: 100,
            transactionDate: "2023-04-01",
            bondInstrumentId: null,
          }),
        );
        const preview = await service.previewUpdateInvestmentTransaction(
          userId,
          transactionId,
          { description: "renamed" },
        );
        expect(bondHoldingsService.redemptionSplit).toHaveBeenCalledWith(
          userId,
          securityId,
          accountId,
          EDO0423,
          "2023-04-01",
          10,
          transactionId,
        );
        // The stored row books the interest as a gain: the card says so.
        expect(preview).toMatchObject({
          bondInstrumentId: null,
          price: 100,
          accruedInterest: 0,
          redemptionSplit: { interest: 470.5, outcome: "differs" },
        });
      });

      it("splits a REST create that states no accrued interest instead of booking it as a gain", async () => {
        await service.create(userId, {
          accountId,
          securityId,
          action: InvestmentAction.REDEEM,
          transactionDate: "2023-04-01",
          quantity: 10,
          price: 147.05,
        });
        expect(bondHoldingsService.redemptionSplit).toHaveBeenCalled();
        expect(created()[0]).toMatchObject({
          action: InvestmentAction.REDEEM,
          price: 100,
          totalAmount: 1000,
        });
        // The one cash row is the payout: principal plus the split's interest.
        expect(accountsService.updateBalance).toHaveBeenCalledWith(
          cashAccountId,
          1470.5,
        );
      });

      it("splits a REST edit that changes a redemption's price and states no accrued interest", async () => {
        investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
          createMockQueryBuilder({
            ...mockBuyTransaction,
            action: InvestmentAction.REDEEM,
            quantity: 10,
            price: 100,
            totalAmount: 1000,
            transactionDate: "2023-04-01",
            bondInstrumentId: null,
          }),
        );
        await service.update(userId, transactionId, { price: 147.05 });
        expect(bondHoldingsService.redemptionSplit).toHaveBeenCalledWith(
          userId,
          securityId,
          accountId,
          EDO0423,
          "2023-04-01",
          10,
          transactionId,
        );
        expect(mockQueryRunner.manager.save).toHaveBeenCalledWith(
          expect.objectContaining({ price: 100, totalAmount: 990.01 }),
        );
      });

      it("refuses a REST create whose split is refused, writing nothing", async () => {
        bondHoldingsService.redemptionSplit.mockResolvedValue({
          ...AT_MATURITY,
          interest: null,
          grossInterest: null,
          principalReturned: null,
          payout: null,
          refusal: "RATE_UNKNOWN",
        });
        await expect(
          service.create(userId, {
            accountId,
            securityId,
            action: InvestmentAction.REDEEM,
            transactionDate: "2023-04-01",
            quantity: 10,
            price: 147.05,
          }),
        ).rejects.toMatchObject({ response: { errorCode: "RATE_UNKNOWN" } });
        expect(created()).toEqual([]);
      });

      it("keeps the stated figures of a REST create that names no series when the account holds several", async () => {
        bondHoldingsService.seriesHoldings.mockResolvedValue({
          holdings: [
            { instrumentId: EDO0423, seriesCode: "EDO0423", quantity: 5 },
            { instrumentId: OTHER_SERIES, seriesCode: "EDO0523", quantity: 5 },
          ],
        });
        await service.create(userId, {
          accountId,
          securityId,
          action: InvestmentAction.REDEEM,
          transactionDate: "2023-04-01",
          quantity: 10,
          price: 147.05,
        });
        expect(bondHoldingsService.redemptionSplit).not.toHaveBeenCalled();
        expect(created()[0]).toMatchObject({
          action: InvestmentAction.REDEEM,
          price: 147.05,
        });
      });

      it("splits a REST edit of the quantity again instead of keeping the interest stored for the old quantity", async () => {
        const companion = {
          id: "inv-tx-interest",
          userId,
          action: InvestmentAction.INTEREST,
          linkedTransactionId: transactionId,
          totalAmount: 470.5,
          price: 470.5,
        };
        investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
          createMockQueryBuilder({
            ...mockBuyTransaction,
            action: InvestmentAction.REDEEM,
            quantity: 10,
            price: 100,
            totalAmount: 1000,
            transactionDate: "2023-04-01",
            bondInstrumentId: EDO0423,
            linkedTransactionId: companion.id,
          }),
        );
        investmentTransactionsRepository.findOne.mockResolvedValue(companion);
        bondHoldingsService.redemptionSplit.mockResolvedValue({
          ...AT_MATURITY,
          quantity: 5,
          principal: "500.00",
          grossInterest: "235.25",
          interest: "235.25",
          principalReturned: "500.00",
          payout: "735.25",
        });
        await service.update(userId, transactionId, { quantity: 5 });
        expect(bondHoldingsService.redemptionSplit).toHaveBeenCalledWith(
          userId,
          securityId,
          accountId,
          EDO0423,
          "2023-04-01",
          5,
          transactionId,
        );
        expect(mockQueryRunner.manager.save).toHaveBeenCalledWith(
          expect.objectContaining({
            id: transactionId,
            price: 100,
            totalAmount: 490.01,
          }),
        );
        // Proceeds plus the new interest, not the old 470.50.
        expect(mockQueryRunner.manager.save).toHaveBeenCalledWith(
          expect.objectContaining({ amount: 725.26 }),
        );
      });
    });

    /**
     * INV-BOND-007 (M1): a split parent's deletion, void and replacement reach
     * the lots through the embedded rows. The guard runs there too, so the whole
     * parent operation rolls back; a replacement verifies once after the
     * recreation.
     */
    describe("split-embedded rows (M1)", () => {
      const embedded: any = {
        id: "emb-1",
        userId,
        accountId,
        securityId,
        action: InvestmentAction.BUY,
        quantity: 10,
        price: 100,
        commission: 0,
        totalAmount: 1000,
        exchangeRate: 1,
        transactionDate: "2026-01-10",
        transactionId: null,
        transactionSplitId: "split-1",
      };
      const buyRow = ledgerRow({ id: "emb-1" });
      const laterSell = ledgerRow({
        id: "sell-1",
        action: "SELL",
        tx_date: "2026-02-01",
        bond_instrument_id: SERIES_ON_SALE,
      });

      it("reverseAndRemoveEmbedded refuses removing a purchase a later SELL of its series depends on (REMOVAL_EXCEEDS_SERIES), after the removal, so the parent operation rolls back", async () => {
        bondDatabase({
          ledgers: [[buyRow, laterSell], [laterSell]],
        });
        const touched = new Set<string>();
        await expect(
          service.reverseAndRemoveEmbedded(
            mockQueryRunner.manager as any,
            userId,
            embedded,
            { touchedSecurityIds: touched },
          ),
        ).rejects.toMatchObject({
          response: { errorCode: "REMOVAL_EXCEEDS_SERIES" },
        });
        expect(mockQueryRunner.manager.remove).toHaveBeenCalledWith(embedded);
        expect(
          holdingsService.rebuildScopesFromTransactions,
        ).toHaveBeenCalled();
      });

      it("reverseAndRemoveEmbedded removes what nothing depends on and reports the security for the post-commit recompute", async () => {
        bondDatabase({ ledgers: [[buyRow], []] });
        const touched = new Set<string>();
        await service.reverseAndRemoveEmbedded(
          mockQueryRunner.manager as any,
          userId,
          embedded,
          { touchedSecurityIds: touched },
        );
        expect([...touched]).toEqual([securityId]);
      });

      it("reverseAndRemoveEmbedded leaves the verdict to a caller's own guard (a replacement recreates the row first)", async () => {
        bondDatabase({ ledgers: [[buyRow, laterSell], [laterSell]] });
        const callerGuard = {
          track: jest.fn(),
          verify: jest.fn(),
        };
        await service.reverseAndRemoveEmbedded(
          mockQueryRunner.manager as any,
          userId,
          embedded,
          { bondGuard: callerGuard },
        );
        expect(callerGuard.verify).not.toHaveBeenCalled();
      });

      it("applyParentStatusToEmbeddedRows refuses voiding an embedded purchase a later SELL depends on (REMOVAL_EXCEEDS_SERIES)", async () => {
        transactionSplitRepository.find.mockResolvedValue([
          { id: "split-1", kind: "investment" },
        ]);
        investmentTransactionsRepository.find.mockResolvedValue([
          { ...embedded, status: TransactionStatus.UNRECONCILED },
        ]);
        bondDatabase({ ledgers: [[buyRow, laterSell], [laterSell]] });
        await expect(
          service.applyParentStatusToEmbeddedRows(
            mockQueryRunner.manager as any,
            userId,
            "parent-1",
            TransactionStatus.VOID,
          ),
        ).rejects.toMatchObject({
          response: { errorCode: "REMOVAL_EXCEEDS_SERIES" },
        });
      });

      it("applyParentStatusToEmbeddedRows reports the security of a row that crossed the boundary, and says nothing of one that did not", async () => {
        transactionSplitRepository.find.mockResolvedValue([
          { id: "split-1", kind: "investment" },
        ]);
        investmentTransactionsRepository.find.mockResolvedValue([
          { ...embedded, status: TransactionStatus.UNRECONCILED },
        ]);
        bondDatabase({ ledgers: [[buyRow], []] });
        const touched = new Set<string>();
        await service.applyParentStatusToEmbeddedRows(
          mockQueryRunner.manager as any,
          userId,
          "parent-1",
          TransactionStatus.VOID,
          touched,
        );
        expect([...touched]).toEqual([securityId]);

        const idle = new Set<string>();
        investmentTransactionsRepository.find.mockResolvedValue([
          { ...embedded, status: TransactionStatus.VOID },
        ]);
        await service.applyParentStatusToEmbeddedRows(
          mockQueryRunner.manager as any,
          userId,
          "parent-1",
          TransactionStatus.VOID,
          idle,
        );
        expect(idle.size).toBe(0);
      });

      it("applyParentStatusToEmbeddedRows refuses un-voiding a row whose price is not a price per bond (QUANTITY_NOT_BONDS)", async () => {
        transactionSplitRepository.find.mockResolvedValue([
          { id: "split-1", kind: "investment" },
        ]);
        investmentTransactionsRepository.find.mockResolvedValue([
          { ...embedded, price: 1, status: TransactionStatus.VOID },
        ]);
        bondDatabase({
          band: [[], [{ id: "emb-1", price: "1.0000", face: "100.00" }]],
        });
        await expect(
          service.applyParentStatusToEmbeddedRows(
            mockQueryRunner.manager as any,
            userId,
            "parent-1",
            TransactionStatus.UNRECONCILED,
          ),
        ).rejects.toMatchObject({
          response: { errorCode: "QUANTITY_NOT_BONDS" },
        });
      });

      it("recomputeBondPricesAfterSplitWrite dispatches the engine recompute for the ids, and nothing for none", async () => {
        await service.recomputeBondPricesAfterSplitWrite(userId, []);
        expect(
          securitiesService.recomputeBondPricesAfterWrite,
        ).not.toHaveBeenCalled();
        await service.recomputeBondPricesAfterSplitWrite(userId, [securityId]);
        expect(
          securitiesService.recomputeBondPricesAfterWrite,
        ).toHaveBeenCalledWith(userId, [securityId]);
      });
    });
  });
});
