import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import {
  NotFoundException,
  BadRequestException,
  ConflictException,
} from "@nestjs/common";
import { InvestmentTransactionsService } from "./investment-transactions.service";
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
import { AccountsService } from "../accounts/accounts.service";
import { TransactionsService } from "../transactions/transactions.service";
import { HoldingsService } from "./holdings.service";
import { PortfolioCalculationService } from "./portfolio-calculation.service";
import { SecuritiesService } from "./securities.service";
import { SecurityPriceService } from "./security-price.service";
import { NetWorthService } from "../net-worth/net-worth.service";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import { CurrenciesService } from "../currencies/currencies.service";
import { DataSource } from "typeorm";
import { ActionHistoryService } from "../action-history/action-history.service";
import { isTransactionInFuture } from "../common/date-utils";

jest.mock("../common/date-utils", () => ({
  isTransactionInFuture: jest.fn().mockReturnValue(false),
}));

const mockedIsTransactionInFuture =
  isTransactionInFuture as jest.MockedFunction<typeof isTransactionInFuture>;

describe("InvestmentTransactionsService", () => {
  let service: InvestmentTransactionsService;
  let investmentTransactionsRepository: Record<string, jest.Mock>;
  let transactionRepository: Record<string, jest.Mock>;
  let accountsService: Record<string, jest.Mock>;
  let portfolioCalculationService: Record<string, jest.Mock>;
  let transactionsService: Record<string, jest.Mock>;
  let holdingsService: Record<string, jest.Mock>;
  let securitiesService: Record<string, jest.Mock>;
  let securityPriceService: Record<string, jest.Mock>;
  let netWorthService: Record<string, jest.Mock>;
  let exchangeRateService: Record<string, jest.Mock>;
  let currenciesService: Record<string, jest.Mock>;
  let dataSource: Record<string, jest.Mock>;
  let mockQueryRunner: Record<string, any>;
  let mockActionHistoryService: Record<string, jest.Mock>;

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
      find: jest.fn(),
      update: jest.fn().mockResolvedValue(undefined),
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
      updateHolding: jest.fn().mockResolvedValue(undefined),
      adjustQuantity: jest.fn().mockResolvedValue(undefined),
      applySplit: jest.fn().mockResolvedValue(undefined),
      reverseSplit: jest.fn().mockResolvedValue(undefined),
      findByAccountAndSecurity: jest.fn().mockResolvedValue(null),
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

    mockQueryRunner = {
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      query: jest.fn().mockResolvedValue([]),
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

    dataSource = {
      createQueryRunner: jest.fn().mockReturnValue(mockQueryRunner),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvestmentTransactionsService,
        {
          provide: getRepositoryToken(InvestmentTransaction),
          useValue: investmentTransactionsRepository,
        },
        {
          provide: getRepositoryToken(Transaction),
          useValue: transactionRepository,
        },
        {
          provide: DataSource,
          useValue: dataSource,
        },
        {
          provide: AccountsService,
          useValue: accountsService,
        },
        {
          provide: TransactionsService,
          useValue: transactionsService,
        },
        {
          provide: HoldingsService,
          useValue: holdingsService,
        },
        {
          provide: PortfolioCalculationService,
          useValue: (portfolioCalculationService = {
            calculateRealizedGains: jest.fn().mockResolvedValue([]),
            calculateCapitalGainsByMonth: jest.fn().mockResolvedValue([]),
          }),
        },
        {
          provide: SecuritiesService,
          useValue: securitiesService,
        },
        {
          provide: SecurityPriceService,
          useValue: securityPriceService,
        },
        {
          provide: NetWorthService,
          useValue: netWorthService,
        },
        {
          provide: ActionHistoryService,
          useValue: mockActionHistoryService,
        },
        {
          provide: ExchangeRateService,
          useValue: exchangeRateService,
        },
        {
          provide: CurrenciesService,
          useValue: currenciesService,
        },
      ],
    }).compile();

    service = module.get<InvestmentTransactionsService>(
      InvestmentTransactionsService,
    );
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

    it("updates holdings for a BUY transaction", async () => {
      await service.create(userId, createBuyDto);

      expect(holdingsService.updateHolding).toHaveBeenCalledWith(
        userId,
        accountId,
        securityId,
        10,
        150,
        expect.anything(),
        false,
      );
    });

    it("creates a cash transaction for BUY (negative outflow)", async () => {
      await service.create(userId, createBuyDto);

      expect(transactionRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId,
          accountId: cashAccountId,
          amount: -1509.99,
          status: TransactionStatus.CLEARED,
        }),
      );
      expect(transactionRepository.save).toHaveBeenCalled();
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        cashAccountId,
        -1509.99,
        expect.anything(),
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

      expect(holdingsService.updateHolding).toHaveBeenCalledWith(
        userId,
        accountId,
        securityId,
        -5,
        160,
        expect.anything(),
        false,
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

      expect(holdingsService.updateHolding).toHaveBeenCalledWith(
        userId,
        accountId,
        securityId,
        2,
        150,
        expect.anything(),
        false,
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

      expect(holdingsService.updateHolding).toHaveBeenCalledWith(
        userId,
        accountId,
        securityId,
        20,
        100,
        expect.anything(),
        false,
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

      expect(holdingsService.updateHolding).toHaveBeenCalledWith(
        userId,
        accountId,
        securityId,
        -10,
        100,
        expect.anything(),
        false,
      );
      expect(transactionRepository.create).not.toHaveBeenCalled();
    });

    it("creates an ADD_SHARES transaction using adjustQuantity", async () => {
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

      expect(holdingsService.adjustQuantity).toHaveBeenCalledWith(
        userId,
        accountId,
        securityId,
        5,
        expect.anything(),
      );
      expect(holdingsService.updateHolding).not.toHaveBeenCalled();
      expect(transactionRepository.create).not.toHaveBeenCalled();
    });

    it("creates a REMOVE_SHARES transaction using adjustQuantity with negative delta", async () => {
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

      expect(holdingsService.adjustQuantity).toHaveBeenCalledWith(
        userId,
        accountId,
        securityId,
        -3,
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
        expect.anything(),
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

    it("calls holdingsService.applySplit with the supplied ratio for SPLIT", async () => {
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

      expect(holdingsService.applySplit).toHaveBeenCalledWith(
        accountId,
        securityId,
        2,
        expect.anything(),
      );
      // SPLIT must not write a cash transaction.
      expect(holdingsService.updateHolding).not.toHaveBeenCalled();
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

      expect(holdingsService.applySplit).toHaveBeenCalledWith(
        accountId,
        securityId,
        0.5,
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
      expect(holdingsService.updateHolding).toHaveBeenCalledWith(
        userId,
        accountId,
        securityId,
        -10, // Reverse: remove original 10 shares
        150,
        expect.anything(),
        true,
      );

      // Then apply new effects
      expect(holdingsService.updateHolding).toHaveBeenCalledWith(
        userId,
        accountId,
        securityId,
        expect.any(Number), // New quantity applied
        expect.any(Number),
        expect.anything(),
        true,
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
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.rollbackTransaction).not.toHaveBeenCalled();
    });

    it("rolls back when the edit would cause negative holdings on some date", async () => {
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

      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.commitTransaction).not.toHaveBeenCalled();
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
        expect.anything(),
      );

      // Should remove the cash transaction
      expect(transactionRepository.remove).toHaveBeenCalled();
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
        expect.anything(),
      );

      // NEW funding account should be debited via a freshly created cash tx
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        newFundingAccountId,
        -1509.99,
        expect.anything(),
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
      exchangeRateService.getLatestRate.mockResolvedValue(1.08);

      await service.update(userId, transactionId, { securityId: "sec-eur" });

      expect(exchangeRateService.getLatestRate).toHaveBeenCalledWith(
        "EUR",
        "USD",
      );
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

      // Should reverse BUY holdings (remove shares)
      expect(holdingsService.updateHolding).toHaveBeenCalledWith(
        userId,
        accountId,
        securityId,
        -10,
        150,
        expect.anything(),
        true,
      );

      // Should delete cash transaction and reverse balance
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        cashAccountId,
        1509.99,
        expect.anything(),
      );
      expect(transactionRepository.remove).toHaveBeenCalled();

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
      expect(holdingsService.updateHolding).toHaveBeenCalledWith(
        userId,
        accountId,
        securityId,
        5, // Add back the sold shares
        160,
        expect.anything(),
        true,
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

      expect(holdingsService.updateHolding).toHaveBeenCalledWith(
        userId,
        accountId,
        securityId,
        -3,
        150,
        expect.anything(),
        true,
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

      expect(holdingsService.updateHolding).toHaveBeenCalledWith(
        userId,
        accountId,
        securityId,
        -20,
        100,
        expect.anything(),
        true,
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

      expect(holdingsService.updateHolding).toHaveBeenCalledWith(
        userId,
        accountId,
        securityId,
        10,
        100,
        expect.anything(),
        true,
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

      expect(holdingsService.adjustQuantity).toHaveBeenCalledWith(
        userId,
        accountId,
        securityId,
        -5,
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

      expect(holdingsService.adjustQuantity).toHaveBeenCalledWith(
        userId,
        accountId,
        securityId,
        3,
        expect.anything(),
      );
    });

    it("reverses SPLIT by calling reverseSplit on holdings", async () => {
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

      expect(holdingsService.reverseSplit).toHaveBeenCalledWith(
        accountId,
        securityId,
        2,
        expect.anything(),
      );
      // Reversing a SPLIT must NOT remove cash transactions or call updateHolding.
      expect(holdingsService.updateHolding).not.toHaveBeenCalled();
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
        accountName: "Brokerage Account",
        symbol: "AAPL",
        securityName: "Apple Inc.",
        quantity: 5,
        price: 160,
        commission: 9.99,
        totalAmount: 790.01,
        currency: "USD",
        description: "Sell AAPL",
      });
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

    it("flags mixed currencies with a null currency on the bucket", async () => {
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

      const result = await service.getLlmCapitalGains(userId, {
        startDate: "2024-06-01",
        endDate: "2024-06-30",
      });

      expect(result.entries).toHaveLength(1); // single month bucket
      expect(result.entries[0].currency).toBeNull();
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

      const result = await service.removeAll(userId);

      expect(mockQueryRunner.manager.find).toHaveBeenCalledWith(
        InvestmentTransaction,
        { where: { userId } },
      );
      // Should reverse balance for each cash transaction
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        cashAccountId,
        1509.99,
        mockQueryRunner,
      );
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        cashAccountId,
        -790.01,
        mockQueryRunner,
      );
      // Should remove cash transactions
      expect(mockQueryRunner.manager.remove).toHaveBeenCalledWith([
        cashTx1,
        cashTx2,
      ]);
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

    it("handles missing quantity and price for BUY (defaults to 0)", async () => {
      await service.create(userId, {
        accountId,
        securityId,
        action: InvestmentAction.BUY,
        transactionDate: "2025-01-15",
      });

      // (0 * 0) + 0 = 0
      expect(investmentTransactionsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ totalAmount: 0 }),
      );
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

  describe("formatCashTransactionPayeeName (via create)", () => {
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
          payeeName: expect.stringContaining("Buy:"),
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

    it("sets status to CLEARED for cash transactions", async () => {
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
          status: TransactionStatus.CLEARED,
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

    it("converts cash amount using the latest market rate when currencies differ", async () => {
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
      exchangeRateService.getLatestRate.mockResolvedValue(1.365);

      await service.create(userId, {
        accountId,
        securityId,
        action: InvestmentAction.BUY,
        transactionDate: "2025-01-15",
        quantity: 10,
        price: 100,
      });

      // Market rate lookup should happen in the security->cash direction
      expect(exchangeRateService.getLatestRate).toHaveBeenCalledWith(
        "USD",
        "CAD",
      );

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
        expect.anything(),
      );
    });

    it("falls back to rate 1 when no market rate is available", async () => {
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
      exchangeRateService.getLatestRate.mockResolvedValue(null);

      await service.create(userId, {
        accountId,
        securityId,
        action: InvestmentAction.BUY,
        transactionDate: "2025-01-15",
        quantity: 10,
        price: 100,
      });

      expect(investmentTransactionsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          exchangeRate: 1,
        }),
      );
      expect(transactionRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: -1000,
        }),
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
      exchangeRateService.getLatestRate.mockResolvedValue(1.3);

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
        expect.anything(),
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
      exchangeRateService.getLatestRate.mockResolvedValue(1.4);

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
        expect.anything(),
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

    it("does NOT update holdings for a future-dated BUY transaction", async () => {
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

      expect(holdingsService.updateHolding).not.toHaveBeenCalled();
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

    it("does NOT update holdings for a future-dated SELL transaction", async () => {
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

      expect(holdingsService.updateHolding).not.toHaveBeenCalled();
      // The cash side IS created so the user sees the projected proceeds.
      expect(transactionRepository.create).toHaveBeenCalled();
    });

    it("does NOT touch holdings when deleting a future-dated transaction", async () => {
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

      expect(holdingsService.updateHolding).not.toHaveBeenCalled();
      expect(holdingsService.adjustQuantity).not.toHaveBeenCalled();
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

    it("create commits transaction on success and releases queryRunner", async () => {
      const savedTx = {
        id: "inv-tx-1",
        ...createBuyDto,
        userId,
        totalAmount: 1500,
        commission: 0,
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

      expect(mockQueryRunner.connect).toHaveBeenCalled();
      expect(mockQueryRunner.startTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.rollbackTransaction).not.toHaveBeenCalled();
      expect(mockQueryRunner.release).toHaveBeenCalled();
    });

    it("create rolls back on error and releases queryRunner", async () => {
      investmentTransactionsRepository.save.mockRejectedValue(
        new Error("DB error"),
      );

      await expect(service.create(userId, createBuyDto)).rejects.toThrow(
        "DB error",
      );

      expect(mockQueryRunner.startTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.commitTransaction).not.toHaveBeenCalled();
      expect(mockQueryRunner.release).toHaveBeenCalled();
    });

    it("update commits transaction on success and releases queryRunner", async () => {
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

      expect(mockQueryRunner.connect).toHaveBeenCalled();
      expect(mockQueryRunner.startTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.rollbackTransaction).not.toHaveBeenCalled();
      expect(mockQueryRunner.release).toHaveBeenCalled();
    });

    it("remove commits transaction on success and releases queryRunner", async () => {
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

      expect(mockQueryRunner.connect).toHaveBeenCalled();
      expect(mockQueryRunner.startTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.rollbackTransaction).not.toHaveBeenCalled();
      expect(mockQueryRunner.release).toHaveBeenCalled();
    });

    it("remove rolls back on error and releases queryRunner", async () => {
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

      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.commitTransaction).not.toHaveBeenCalled();
      expect(mockQueryRunner.release).toHaveBeenCalled();
    });
  });

  describe("createEmbeddedForSplit", () => {
    it("creates an embedded BUY without spawning a linked cash transaction", async () => {
      accountsService.findOne.mockResolvedValue(mockInvestmentAccount);
      securitiesService.findOne.mockResolvedValue(mockSecurity);
      // resolveCashExchangeRate path: same currency -> rate 1
      exchangeRateService.getLatestRate.mockResolvedValue(1);

      const created = await service.createEmbeddedForSplit(
        mockQueryRunner as any,
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
      expect(holdingsService.updateHolding).toHaveBeenCalledWith(
        userId,
        accountId,
        securityId,
        75,
        10,
        mockQueryRunner,
        false,
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
          mockQueryRunner as any,
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
          mockQueryRunner as any,
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
          mockQueryRunner as any,
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
            mockQueryRunner as any,
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
        mockQueryRunner as any,
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

      // No holdings update for DIVIDEND, no cash transaction either
      expect(holdingsService.updateHolding).not.toHaveBeenCalled();
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
        mockQueryRunner as any,
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

      expect(holdingsService.updateHolding).toHaveBeenCalledWith(
        userId,
        accountId,
        securityId,
        -10,
        50,
        mockQueryRunner,
        false,
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
        mockQueryRunner,
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
        mockQueryRunner as any,
        userId,
        embedded,
      );

      // Reverse-of-BUY decrements holdings by qty
      expect(holdingsService.updateHolding).toHaveBeenCalledWith(
        userId,
        accountId,
        securityId,
        -5,
        10,
        mockQueryRunner,
        true,
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

      // TRANSFER_OUT draws down the source at cost basis.
      expect(holdingsService.updateHolding).toHaveBeenCalledWith(
        userId,
        accountId,
        securityId,
        -100,
        1.67,
        mockQueryRunner,
        false,
      );
      // TRANSFER_IN adds to the destination at the same per-share cost.
      expect(holdingsService.updateHolding).toHaveBeenCalledWith(
        userId,
        toAccountId,
        securityId,
        100,
        1.67,
        mockQueryRunner,
        false,
      );
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
      expect(result).toHaveProperty("transferOut");
      expect(result).toHaveProperty("transferIn");
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
        mockQueryRunner,
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
      expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
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
      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.commitTransaction).not.toHaveBeenCalled();
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

      expect(holdingsService.updateHolding).toHaveBeenCalledWith(
        userId,
        accountId,
        securityId,
        -100,
        0,
        mockQueryRunner,
        false,
      );
      expect(holdingsService.updateHolding).toHaveBeenCalledWith(
        userId,
        toAccountId,
        securityId,
        100,
        0,
        mockQueryRunner,
        false,
      );
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
    });

    it("carries the source holding's average cost, ignoring the client value", async () => {
      // The server is authoritative: when the source holds the security, both
      // legs use its real blended average cost (here 4.25) so basis is
      // conserved -- a stale/zero client costPerShare cannot poison it.
      holdingsService.findByAccountAndSecurity.mockResolvedValue({
        quantity: 200,
        averageCost: 4.25,
      } as any);

      await service.transferSecurity(userId, {
        ...transferDto,
        costPerShare: 0,
      });

      expect(holdingsService.updateHolding).toHaveBeenCalledWith(
        userId,
        accountId,
        securityId,
        -100,
        4.25,
        mockQueryRunner,
        false,
      );
      expect(holdingsService.updateHolding).toHaveBeenCalledWith(
        userId,
        toAccountId,
        securityId,
        100,
        4.25,
        mockQueryRunner,
        false,
      );
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
      expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
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
        mockQueryRunner,
        expect.arrayContaining([accountId, toAccountId]),
        [securityId],
      );
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
    });

    it("update propagates the edit to both legs and keeps them linked", async () => {
      const { outLeg, inLeg } = makeLegs();
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        createMockQueryBuilder(outLeg),
      );
      investmentTransactionsRepository.findOne.mockResolvedValue(inLeg);

      await service.update(userId, "leg-out", { quantity: 50 });

      // Both legs reversed (add/remove) and reapplied -> 4 holding updates.
      expect(holdingsService.updateHolding).toHaveBeenCalled();
      // Both legs saved.
      const savedActions = mockQueryRunner.manager.save.mock.calls
        .map((c: any[]) => c[0]?.action)
        .filter(Boolean);
      expect(savedActions).toContain(InvestmentAction.TRANSFER_OUT);
      expect(savedActions).toContain(InvestmentAction.TRANSFER_IN);
      // Edit propagated to the linked leg too.
      expect(inLeg.quantity).toBe(50);
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
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
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
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
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
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
        mockQueryRunner,
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
        price: 2.1234567,
        commission: 0.12345,
      });
      expect(preview.quantity).toBe(1.12345679);
      expect(preview.price).toBe(2.123457);
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
      exchangeRateService.getLatestRate.mockResolvedValue(1.1);

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
});
