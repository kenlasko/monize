import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { NotFoundException, BadRequestException } from "@nestjs/common";
import { InvestmentTransactionsService } from "./investment-transactions.service";
import {
  InvestmentTransaction,
  InvestmentAction,
} from "./entities/investment-transaction.entity";
import {
  Transaction,
  TransactionStatus,
} from "../transactions/entities/transaction.entity";
import { AccountSubType } from "../accounts/entities/account.entity";
import { AccountsService } from "../accounts/accounts.service";
import { TransactionsService } from "../transactions/transactions.service";
import { HoldingsService } from "./holdings.service";
import { SecuritiesService } from "./securities.service";
import { NetWorthService } from "../net-worth/net-worth.service";
import { DataSource } from "typeorm";
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
  let transactionsService: Record<string, jest.Mock>;
  let holdingsService: Record<string, jest.Mock>;
  let securitiesService: Record<string, jest.Mock>;
  let netWorthService: Record<string, jest.Mock>;
  let dataSource: Record<string, jest.Mock>;
  let mockQueryRunner: Record<string, any>;

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
    action: InvestmentAction.BUY,
    transactionDate: "2025-01-15",
    quantity: 10,
    price: 150,
    commission: 9.99,
    totalAmount: 1509.99,
    description: "Buy AAPL",
    account: mockInvestmentAccount as any,
    transaction: null as any,
    security: mockSecurity as any,
    fundingAccount: null,
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
    action: InvestmentAction.SELL,
    transactionDate: "2025-02-15",
    quantity: 5,
    price: 160,
    commission: 9.99,
    totalAmount: 790.01,
    description: "Sell AAPL",
    account: mockInvestmentAccount as any,
    transaction: null as any,
    security: mockSecurity as any,
    fundingAccount: null,
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
    action: InvestmentAction.DIVIDEND,
    transactionDate: "2025-03-15",
    quantity: 1,
    price: 25,
    commission: 0,
    totalAmount: 25,
    description: "AAPL Dividend",
    account: mockInvestmentAccount as any,
    transaction: null as any,
    security: mockSecurity as any,
    fundingAccount: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  // Helper to build a mock query builder with fluent chaining
  const createMockQueryBuilder = (result: any = null, count: number = 0) => ({
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
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
    };

    transactionsService = {};

    holdingsService = {
      updateHolding: jest.fn().mockResolvedValue(undefined),
      adjustQuantity: jest.fn().mockResolvedValue(undefined),
      removeAllForUser: jest.fn().mockResolvedValue(5),
    };

    securitiesService = {
      findOne: jest.fn().mockResolvedValue(mockSecurity),
    };

    netWorthService = {
      recalculateAccount: jest.fn().mockResolvedValue(undefined),
      triggerDebouncedRecalc: jest.fn(),
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
          provide: SecuritiesService,
          useValue: securitiesService,
        },
        {
          provide: NetWorthService,
          useValue: netWorthService,
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

    it("triggers net worth recalculation after create", async () => {
      await service.create(userId, createBuyDto);

      expect(netWorthService.triggerDebouncedRecalc).toHaveBeenCalledWith(
        accountId,
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

    it("orders transactions by date descending", async () => {
      const mockQB = createMockQueryBuilder([], 0);
      investmentTransactionsRepository.createQueryBuilder.mockReturnValue(
        mockQB,
      );

      await service.findAll(userId);

      expect(mockQB.orderBy).toHaveBeenCalledWith("it.transactionDate", "DESC");
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
      );

      // Then apply new effects
      expect(holdingsService.updateHolding).toHaveBeenCalledWith(
        userId,
        accountId,
        securityId,
        expect.any(Number), // New quantity applied
        expect.any(Number),
        expect.anything(),
      );
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

    it("triggers net worth recalculation after update", async () => {
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

    it("triggers net worth recalculation after remove", async () => {
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

    it("sets exchangeRate to 1", async () => {
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

      expect(transactionRepository.create).not.toHaveBeenCalled();
      expect(transactionRepository.save).not.toHaveBeenCalled();
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
      expect(transactionRepository.create).not.toHaveBeenCalled();
    });

    it("does NOT reverse effects when deleting a future-dated transaction", async () => {
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
});
