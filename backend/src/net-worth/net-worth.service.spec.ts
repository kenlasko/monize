import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { NetWorthService } from "./net-worth.service";
import { MonthlyAccountBalance } from "./entities/monthly-account-balance.entity";
import {
  Account,
  AccountType,
  AccountSubType,
} from "../accounts/entities/account.entity";
import {
  InvestmentTransaction,
  InvestmentAction,
} from "../securities/entities/investment-transaction.entity";
import { SecurityPrice } from "../securities/entities/security-price.entity";
import { Security } from "../securities/entities/security.entity";
import { ExchangeRate } from "../currencies/entities/exchange-rate.entity";
import { UserPreference } from "../users/entities/user-preference.entity";

describe("NetWorthService", () => {
  let service: NetWorthService;
  let mabRepository: Record<string, jest.Mock>;
  let accountRepository: Record<string, jest.Mock>;
  let invTxRepository: Record<string, jest.Mock>;
  let priceRepository: Record<string, jest.Mock>;
  let securityRepository: Record<string, jest.Mock>;
  let rateRepository: Record<string, jest.Mock>;
  let prefRepository: Record<string, jest.Mock>;
  let dataSource: Record<string, jest.Mock>;

  const mockQueryRunner = {
    connect: jest.fn(),
    startTransaction: jest.fn(),
    commitTransaction: jest.fn(),
    rollbackTransaction: jest.fn(),
    release: jest.fn(),
    query: jest.fn(),
  };

  const mockRegularAccount: Account = {
    id: "account-1",
    userId: "user-1",
    name: "Checking",
    accountType: AccountType.CHEQUING,
    accountSubType: null,
    currencyCode: "USD",
    openingBalance: 1000,
    currentBalance: 1500,
    isClosed: false,
    closedDate: null,
    linkedAccountId: null,
    linkedAccount: null,
    description: null,
    accountNumber: null,
    institution: null,
    creditLimit: null,
    interestRate: null,
    isFavourite: false,
    paymentAmount: null,
    paymentFrequency: null,
    paymentStartDate: null,
    sourceAccountId: null,
    sourceAccount: null,
    principalCategoryId: null,
    principalCategory: null,
    interestCategoryId: null,
    interestCategory: null,
    assetCategoryId: null,
    assetCategory: null,
    dateAcquired: null,
    isCanadianMortgage: false,
    isVariableRate: false,
    termMonths: null,
    termEndDate: null,
    amortizationMonths: null,
    originalPrincipal: null,
    scheduledTransactionId: null,
    scheduledTransaction: null,
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
    transactions: [],
  } as Account;

  const mockBrokerageAccount: Account = {
    ...mockRegularAccount,
    id: "brokerage-1",
    name: "Brokerage",
    accountType: AccountType.INVESTMENT,
    accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
    openingBalance: 0,
  };

  const mockCreditCardAccount: Account = {
    ...mockRegularAccount,
    id: "cc-1",
    name: "Credit Card",
    accountType: AccountType.CREDIT_CARD,
    currentBalance: -500,
  };

  const mockAssetAccount: Account = {
    ...mockRegularAccount,
    id: "asset-1",
    name: "House",
    accountType: AccountType.ASSET,
    dateAcquired: new Date("2023-06-15"),
  };

  beforeEach(async () => {
    mabRepository = {
      count: jest.fn().mockResolvedValue(0),
      find: jest.fn(),
      save: jest.fn(),
    };

    accountRepository = {
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
    };

    invTxRepository = {
      find: jest.fn().mockResolvedValue([]),
    };

    priceRepository = {};

    securityRepository = {
      findByIds: jest.fn().mockResolvedValue([]),
    };

    rateRepository = {};

    prefRepository = {
      findOne: jest.fn().mockResolvedValue(null),
    };

    dataSource = {
      query: jest.fn().mockResolvedValue([]),
      createQueryRunner: jest.fn().mockReturnValue(mockQueryRunner),
    };

    // Reset all query runner mocks
    mockQueryRunner.connect.mockReset().mockResolvedValue(undefined);
    mockQueryRunner.startTransaction.mockReset().mockResolvedValue(undefined);
    mockQueryRunner.commitTransaction.mockReset().mockResolvedValue(undefined);
    mockQueryRunner.rollbackTransaction
      .mockReset()
      .mockResolvedValue(undefined);
    mockQueryRunner.release.mockReset().mockResolvedValue(undefined);
    mockQueryRunner.query.mockReset().mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NetWorthService,
        {
          provide: getRepositoryToken(MonthlyAccountBalance),
          useValue: mabRepository,
        },
        { provide: getRepositoryToken(Account), useValue: accountRepository },
        {
          provide: getRepositoryToken(InvestmentTransaction),
          useValue: invTxRepository,
        },
        {
          provide: getRepositoryToken(SecurityPrice),
          useValue: priceRepository,
        },
        { provide: getRepositoryToken(Security), useValue: securityRepository },
        {
          provide: getRepositoryToken(ExchangeRate),
          useValue: rateRepository,
        },
        {
          provide: getRepositoryToken(UserPreference),
          useValue: prefRepository,
        },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    service = module.get<NetWorthService>(NetWorthService);
  });

  describe("recalculateAccount", () => {
    it("returns early when account is not found", async () => {
      accountRepository.findOne.mockResolvedValue(null);

      await service.recalculateAccount("user-1", "nonexistent");

      expect(dataSource.query).not.toHaveBeenCalled();
      expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
    });

    it("delegates to recalculateRegularAccount for non-brokerage accounts", async () => {
      accountRepository.findOne.mockResolvedValue({ ...mockRegularAccount });
      dataSource.query
        .mockResolvedValueOnce([{ earliest: "2024-01-15" }])
        .mockResolvedValueOnce([{ month: "2024-01-01", balance: 1000 }]);

      await service.recalculateAccount("user-1", "account-1");

      expect(dataSource.createQueryRunner).toHaveBeenCalled();
      expect(mockQueryRunner.connect).toHaveBeenCalled();
      expect(mockQueryRunner.startTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.release).toHaveBeenCalled();
    });

    it("delegates to recalculateBrokerageAccount for brokerage accounts", async () => {
      accountRepository.findOne.mockResolvedValue({ ...mockBrokerageAccount });
      // earliest regular tx
      dataSource.query
        .mockResolvedValueOnce([{ earliest: "2024-03-01" }])
        // earliest inv tx
        .mockResolvedValueOnce([{ inv_earliest: "2024-02-15" }])
        // cost rows
        .mockResolvedValueOnce([{ month: "2024-02-01", balance: 0 }]);

      invTxRepository.find.mockResolvedValue([]);

      await service.recalculateAccount("user-1", "brokerage-1");

      expect(dataSource.createQueryRunner).toHaveBeenCalled();
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
    });

    describe("regular account recalculation", () => {
      it("uses opening balance with cumulative transaction sums", async () => {
        accountRepository.findOne.mockResolvedValue({
          ...mockRegularAccount,
          openingBalance: 500,
        });
        dataSource.query
          .mockResolvedValueOnce([{ earliest: "2024-01-10" }])
          .mockResolvedValueOnce([
            { month: "2024-01-01", balance: 600 },
            { month: "2024-02-01", balance: 800 },
          ]);

        await service.recalculateAccount("user-1", "account-1");

        // Verify delete old balances
        expect(mockQueryRunner.query).toHaveBeenCalledWith(
          "DELETE FROM monthly_account_balances WHERE account_id = $1",
          ["account-1"],
        );
        // Verify insert for each month
        expect(mockQueryRunner.query).toHaveBeenCalledTimes(3); // 1 delete + 2 inserts
      });

      it("uses createdAt as start date when no earliest transaction exists", async () => {
        const account = {
          ...mockRegularAccount,
          createdAt: new Date("2024-06-01"),
        };
        accountRepository.findOne.mockResolvedValue(account);
        dataSource.query
          .mockResolvedValueOnce([{ earliest: null }])
          .mockResolvedValueOnce([{ month: "2024-06-01", balance: 1000 }]);

        await service.recalculateAccount("user-1", "account-1");

        // The second query (cost rows) should use account.createdAt substring as startDate
        const secondQueryCall = dataSource.query.mock.calls[1];
        expect(secondQueryCall[1]).toContain("2024-06-01");
      });

      it("zeroes balance for ASSET months before dateAcquired", async () => {
        const assetAccount = {
          ...mockAssetAccount,
          openingBalance: 250000,
        };
        accountRepository.findOne.mockResolvedValue(assetAccount);
        dataSource.query
          .mockResolvedValueOnce([{ earliest: "2023-01-01" }])
          .mockResolvedValueOnce([
            { month: "2023-01-01", balance: 250000 },
            { month: "2023-06-01", balance: 250000 },
            { month: "2023-07-01", balance: 250500 },
          ]);

        await service.recalculateAccount("user-1", "asset-1");

        const insertCalls = mockQueryRunner.query.mock.calls.filter(
          (call: any[]) =>
            typeof call[0] === "string" && call[0].includes("INSERT"),
        );

        // Months before 2023-06 should have balance zeroed
        // 2023-01-01 -> monthYM "2023-01" < dateAcquiredYM "2023-06" => balance=0
        expect(insertCalls[0][1][3]).toBe(0);
        // 2023-06-01 -> monthYM "2023-06" === dateAcquiredYM "2023-06" => balance stays
        expect(insertCalls[1][1][3]).toBe(250000);
        // 2023-07-01 -> monthYM "2023-07" > "2023-06" => balance stays
        expect(insertCalls[2][1][3]).toBe(250500);
      });

      it("uses dateAcquired as start date for ASSET when it is earlier than first tx", async () => {
        const assetAccount = {
          ...mockAssetAccount,
          dateAcquired: new Date("2022-03-01"),
        };
        accountRepository.findOne.mockResolvedValue(assetAccount);
        dataSource.query
          .mockResolvedValueOnce([{ earliest: "2023-01-01" }])
          .mockResolvedValueOnce([]);

        await service.recalculateAccount("user-1", "asset-1");

        // The startDate passed to the cost query should be the earlier dateAcquired
        const costQuery = dataSource.query.mock.calls[1];
        expect(costQuery[1][2]).toBe("2022-03-01");
      });

      it("rolls back transaction on error", async () => {
        accountRepository.findOne.mockResolvedValue({ ...mockRegularAccount });
        dataSource.query
          .mockResolvedValueOnce([{ earliest: "2024-01-01" }])
          .mockResolvedValueOnce([{ month: "2024-01-01", balance: 1000 }]);

        mockQueryRunner.query
          .mockResolvedValueOnce(undefined) // DELETE succeeds
          .mockRejectedValueOnce(new Error("DB error")); // INSERT fails

        await expect(
          service.recalculateAccount("user-1", "account-1"),
        ).rejects.toThrow("DB error");

        expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
        expect(mockQueryRunner.release).toHaveBeenCalled();
      });

      it("always releases query runner even on error", async () => {
        accountRepository.findOne.mockResolvedValue({ ...mockRegularAccount });
        dataSource.query
          .mockResolvedValueOnce([{ earliest: "2024-01-01" }])
          .mockResolvedValueOnce([{ month: "2024-01-01", balance: 1000 }]);

        mockQueryRunner.query.mockRejectedValue(new Error("Fatal"));

        await expect(
          service.recalculateAccount("user-1", "account-1"),
        ).rejects.toThrow("Fatal");

        expect(mockQueryRunner.release).toHaveBeenCalledTimes(1);
      });
    });

    describe("brokerage account recalculation", () => {
      it("computes market value from holdings and prices", async () => {
        accountRepository.findOne.mockResolvedValue({
          ...mockBrokerageAccount,
        });
        dataSource.query
          .mockResolvedValueOnce([{ earliest: null }])
          .mockResolvedValueOnce([{ inv_earliest: "2024-01-15" }])
          .mockResolvedValueOnce([
            { month: "2024-01-01", balance: 0 },
            { month: "2024-02-01", balance: 0 },
          ])
          // loadSecurityPrices query
          .mockResolvedValueOnce([
            {
              security_id: "sec-1",
              price_date: "2024-01-20",
              close_price: 150,
            },
            {
              security_id: "sec-1",
              price_date: "2024-02-10",
              close_price: 160,
            },
          ]);

        const mockSecurity: Partial<Security> = {
          id: "sec-1",
          symbol: "AAPL",
          skipPriceUpdates: false,
        };

        invTxRepository.find.mockResolvedValue([
          {
            securityId: "sec-1",
            action: InvestmentAction.BUY,
            quantity: 10,
            transactionDate: "2024-01-15",
          },
        ]);
        securityRepository.findByIds.mockResolvedValue([mockSecurity]);

        await service.recalculateAccount("user-1", "brokerage-1");

        // Verify market_value was inserted
        const insertCalls = mockQueryRunner.query.mock.calls.filter(
          (call: any[]) =>
            typeof call[0] === "string" && call[0].includes("INSERT"),
        );
        expect(insertCalls.length).toBe(2);
        // Month 2024-01: 10 shares * 150 = 1500
        expect(insertCalls[0][1][4]).toBe(1500);
        // Month 2024-02: 10 shares * 160 = 1600
        expect(insertCalls[1][1][4]).toBe(1600);
      });

      it("handles BUY, SELL, REINVEST, TRANSFER_IN, TRANSFER_OUT, SPLIT actions", async () => {
        accountRepository.findOne.mockResolvedValue({
          ...mockBrokerageAccount,
        });
        dataSource.query
          .mockResolvedValueOnce([{ earliest: null }])
          .mockResolvedValueOnce([{ inv_earliest: "2024-01-01" }])
          .mockResolvedValueOnce([
            { month: "2024-01-01", balance: 0 },
            { month: "2024-02-01", balance: 0 },
            { month: "2024-03-01", balance: 0 },
          ])
          // market prices
          .mockResolvedValueOnce([
            {
              security_id: "sec-1",
              price_date: "2024-01-15",
              close_price: 100,
            },
            {
              security_id: "sec-1",
              price_date: "2024-02-15",
              close_price: 100,
            },
            {
              security_id: "sec-1",
              price_date: "2024-03-15",
              close_price: 100,
            },
          ]);

        const mockSecurity: Partial<Security> = {
          id: "sec-1",
          symbol: "TEST",
          skipPriceUpdates: false,
        };

        invTxRepository.find.mockResolvedValue([
          {
            securityId: "sec-1",
            action: InvestmentAction.BUY,
            quantity: 100,
            transactionDate: "2024-01-05",
          },
          {
            securityId: "sec-1",
            action: InvestmentAction.REINVEST,
            quantity: 5,
            transactionDate: "2024-01-20",
          },
          {
            securityId: "sec-1",
            action: InvestmentAction.SELL,
            quantity: 20,
            transactionDate: "2024-02-10",
          },
          {
            securityId: "sec-1",
            action: InvestmentAction.TRANSFER_IN,
            quantity: 10,
            transactionDate: "2024-02-15",
          },
          {
            securityId: "sec-1",
            action: InvestmentAction.TRANSFER_OUT,
            quantity: 5,
            transactionDate: "2024-03-01",
          },
          {
            securityId: "sec-1",
            action: InvestmentAction.SPLIT,
            quantity: 90,
            transactionDate: "2024-03-05",
          },
        ]);
        securityRepository.findByIds.mockResolvedValue([mockSecurity]);

        await service.recalculateAccount("user-1", "brokerage-1");

        const insertCalls = mockQueryRunner.query.mock.calls.filter(
          (call: any[]) =>
            typeof call[0] === "string" && call[0].includes("INSERT"),
        );
        // Month 1 (Jan): BUY 100 + REINVEST 5 = 105 shares * 100 = 10500
        expect(insertCalls[0][1][4]).toBe(10500);
        // Month 2 (Feb): 105 - SELL 20 + TRANSFER_IN 10 = 95 shares * 100 = 9500
        expect(insertCalls[1][1][4]).toBe(9500);
        // Month 3 (Mar): 95 - TRANSFER_OUT 5 + SPLIT 90 = 180 shares * 100 = 18000
        expect(insertCalls[2][1][4]).toBe(18000);
      });

      it("uses transaction prices for skipPriceUpdates securities", async () => {
        accountRepository.findOne.mockResolvedValue({
          ...mockBrokerageAccount,
        });
        dataSource.query
          .mockResolvedValueOnce([{ earliest: null }])
          .mockResolvedValueOnce([{ inv_earliest: "2024-01-01" }])
          .mockResolvedValueOnce([{ month: "2024-01-01", balance: 0 }])
          // loadTransactionPrices query (no market prices query since all skip)
          .mockResolvedValueOnce([
            {
              security_id: "sec-private",
              transaction_date: "2024-01-10",
              price: 50,
            },
          ]);

        const privateSecurity: Partial<Security> = {
          id: "sec-private",
          symbol: "PRIV",
          skipPriceUpdates: true,
        };

        invTxRepository.find.mockResolvedValue([
          {
            securityId: "sec-private",
            action: InvestmentAction.BUY,
            quantity: 20,
            transactionDate: "2024-01-05",
          },
        ]);
        securityRepository.findByIds.mockResolvedValue([privateSecurity]);

        await service.recalculateAccount("user-1", "brokerage-1");

        const insertCalls = mockQueryRunner.query.mock.calls.filter(
          (call: any[]) =>
            typeof call[0] === "string" && call[0].includes("INSERT"),
        );
        // 20 shares * 50 = 1000
        expect(insertCalls[0][1][4]).toBe(1000);
      });

      it("handles no investment transactions gracefully", async () => {
        accountRepository.findOne.mockResolvedValue({
          ...mockBrokerageAccount,
        });
        dataSource.query
          .mockResolvedValueOnce([{ earliest: null }])
          .mockResolvedValueOnce([{ inv_earliest: null }])
          .mockResolvedValueOnce([{ month: "2024-01-01", balance: 0 }]);

        invTxRepository.find.mockResolvedValue([]);

        await service.recalculateAccount("user-1", "brokerage-1");

        // Market value should be 0 (null) when no holdings
        const insertCalls = mockQueryRunner.query.mock.calls.filter(
          (call: any[]) =>
            typeof call[0] === "string" && call[0].includes("INSERT"),
        );
        expect(insertCalls[0][1][4]).toBe(0);
      });

      it("skips holdings with negligible quantity", async () => {
        accountRepository.findOne.mockResolvedValue({
          ...mockBrokerageAccount,
        });
        dataSource.query
          .mockResolvedValueOnce([{ earliest: null }])
          .mockResolvedValueOnce([{ inv_earliest: "2024-01-01" }])
          .mockResolvedValueOnce([{ month: "2024-01-01", balance: 0 }])
          // market prices
          .mockResolvedValueOnce([
            {
              security_id: "sec-1",
              price_date: "2024-01-15",
              close_price: 100,
            },
          ]);

        const mockSecurity: Partial<Security> = {
          id: "sec-1",
          symbol: "TEST",
          skipPriceUpdates: false,
        };

        // Buy and immediately sell same quantity => qty ~ 0
        invTxRepository.find.mockResolvedValue([
          {
            securityId: "sec-1",
            action: InvestmentAction.BUY,
            quantity: 10,
            transactionDate: "2024-01-05",
          },
          {
            securityId: "sec-1",
            action: InvestmentAction.SELL,
            quantity: 10,
            transactionDate: "2024-01-10",
          },
        ]);
        securityRepository.findByIds.mockResolvedValue([mockSecurity]);

        await service.recalculateAccount("user-1", "brokerage-1");

        const insertCalls = mockQueryRunner.query.mock.calls.filter(
          (call: any[]) =>
            typeof call[0] === "string" && call[0].includes("INSERT"),
        );
        // Market value should be 0 since qty is negligible
        expect(insertCalls[0][1][4]).toBe(0);
      });

      it("rolls back on error during brokerage recalculation", async () => {
        accountRepository.findOne.mockResolvedValue({
          ...mockBrokerageAccount,
        });
        dataSource.query
          .mockResolvedValueOnce([{ earliest: null }])
          .mockResolvedValueOnce([{ inv_earliest: null }])
          .mockResolvedValueOnce([{ month: "2024-01-01", balance: 0 }]);

        invTxRepository.find.mockResolvedValue([]);

        mockQueryRunner.query
          .mockResolvedValueOnce(undefined) // DELETE succeeds
          .mockRejectedValueOnce(new Error("Insert failed")); // INSERT fails

        await expect(
          service.recalculateAccount("user-1", "brokerage-1"),
        ).rejects.toThrow("Insert failed");

        expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
        expect(mockQueryRunner.release).toHaveBeenCalled();
      });
    });
  });

  describe("recalculateAllAccounts", () => {
    it("recalculates all accounts for a user", async () => {
      accountRepository.find.mockResolvedValue([
        { ...mockRegularAccount },
        { ...mockCreditCardAccount },
      ]);

      // Each regular account recalculation needs: earliest query + cost rows query
      dataSource.query
        // Account 1
        .mockResolvedValueOnce([{ earliest: "2024-01-01" }])
        .mockResolvedValueOnce([{ month: "2024-01-01", balance: 1000 }])
        // Account 2
        .mockResolvedValueOnce([{ earliest: "2024-01-01" }])
        .mockResolvedValueOnce([{ month: "2024-01-01", balance: -500 }]);

      await service.recalculateAllAccounts("user-1");

      expect(accountRepository.find).toHaveBeenCalledWith({
        where: { userId: "user-1" },
      });
      // createQueryRunner should be called once per account
      expect(dataSource.createQueryRunner).toHaveBeenCalledTimes(2);
    });

    it("continues processing when one account fails", async () => {
      accountRepository.find.mockResolvedValue([
        { ...mockRegularAccount, id: "acc-1" },
        { ...mockRegularAccount, id: "acc-2" },
      ]);

      dataSource.query
        // Account 1 - earliest fails
        .mockRejectedValueOnce(new Error("DB down"))
        // Account 2 - works fine
        .mockResolvedValueOnce([{ earliest: "2024-01-01" }])
        .mockResolvedValueOnce([{ month: "2024-01-01", balance: 500 }]);

      // Should NOT throw
      await service.recalculateAllAccounts("user-1");

      // Still attempted both accounts
      expect(dataSource.createQueryRunner).toHaveBeenCalledTimes(1);
    });

    it("handles empty accounts list", async () => {
      accountRepository.find.mockResolvedValue([]);

      await service.recalculateAllAccounts("user-1");

      expect(dataSource.query).not.toHaveBeenCalled();
      expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
    });

    it("processes brokerage accounts differently from regular accounts", async () => {
      accountRepository.find.mockResolvedValue([
        { ...mockRegularAccount },
        { ...mockBrokerageAccount },
      ]);

      dataSource.query
        // Regular account
        .mockResolvedValueOnce([{ earliest: "2024-01-01" }])
        .mockResolvedValueOnce([{ month: "2024-01-01", balance: 1000 }])
        // Brokerage account
        .mockResolvedValueOnce([{ earliest: null }])
        .mockResolvedValueOnce([{ inv_earliest: null }])
        .mockResolvedValueOnce([{ month: "2024-01-01", balance: 0 }]);

      invTxRepository.find.mockResolvedValue([]);

      await service.recalculateAllAccounts("user-1");

      expect(dataSource.createQueryRunner).toHaveBeenCalledTimes(2);
    });
  });

  describe("ensurePopulated", () => {
    it("recalculates all accounts when mab count is zero", async () => {
      mabRepository.count.mockResolvedValue(0);
      accountRepository.find.mockResolvedValue([]);

      await service.ensurePopulated("user-1");

      expect(mabRepository.count).toHaveBeenCalledWith({
        where: { userId: "user-1" },
      });
      expect(accountRepository.find).toHaveBeenCalledWith({
        where: { userId: "user-1" },
      });
    });

    it("does not recalculate when mab data already exists", async () => {
      mabRepository.count.mockResolvedValue(10);

      await service.ensurePopulated("user-1");

      expect(accountRepository.find).not.toHaveBeenCalled();
    });
  });

  describe("getMonthlyNetWorth", () => {
    it("returns empty array when no snapshots exist", async () => {
      mabRepository.count.mockResolvedValue(5);
      prefRepository.findOne.mockResolvedValue({
        defaultCurrency: "USD",
      });
      dataSource.query.mockResolvedValueOnce([]);

      const result = await service.getMonthlyNetWorth("user-1");

      expect(result).toEqual([]);
    });

    it("separates assets and liabilities correctly", async () => {
      mabRepository.count.mockResolvedValue(5);
      prefRepository.findOne.mockResolvedValue({
        defaultCurrency: "USD",
      });

      dataSource.query
        .mockResolvedValueOnce([
          {
            month: "2024-01-01",
            balance: 5000,
            market_value: null,
            account_id: "checking",
            account_type: AccountType.CHEQUING,
            account_sub_type: null,
            currency_code: "USD",
          },
          {
            month: "2024-01-01",
            balance: 2000,
            market_value: null,
            account_id: "savings",
            account_type: AccountType.SAVINGS,
            account_sub_type: null,
            currency_code: "USD",
          },
          {
            month: "2024-01-01",
            balance: -1500,
            market_value: null,
            account_id: "cc",
            account_type: AccountType.CREDIT_CARD,
            account_sub_type: null,
            currency_code: "USD",
          },
          {
            month: "2024-01-01",
            balance: -200000,
            market_value: null,
            account_id: "mortgage",
            account_type: AccountType.MORTGAGE,
            account_sub_type: null,
            currency_code: "USD",
          },
        ])
        // buildRateIndex (no foreign currencies)
        .mockResolvedValueOnce([]);

      const result = await service.getMonthlyNetWorth("user-1");

      expect(result).toHaveLength(1);
      expect(result[0].month).toBe("2024-01-01");
      expect(result[0].assets).toBe(7000); // 5000 + 2000
      expect(result[0].liabilities).toBe(201500); // abs(-1500) + abs(-200000)
      expect(result[0].netWorth).toBe(7000 - 201500);
    });

    it("uses market_value for INVESTMENT_BROKERAGE accounts", async () => {
      mabRepository.count.mockResolvedValue(5);
      prefRepository.findOne.mockResolvedValue({
        defaultCurrency: "USD",
      });

      dataSource.query.mockResolvedValueOnce([
        {
          month: "2024-01-01",
          balance: 10000,
          market_value: 15000,
          account_id: "brokerage",
          account_type: AccountType.INVESTMENT,
          account_sub_type: "INVESTMENT_BROKERAGE",
          currency_code: "USD",
        },
      ]);

      const result = await service.getMonthlyNetWorth("user-1");

      expect(result).toHaveLength(1);
      // Should use market_value (15000), not balance (10000)
      expect(result[0].assets).toBe(15000);
    });

    it("falls back to balance when market_value is null for brokerage", async () => {
      mabRepository.count.mockResolvedValue(5);
      prefRepository.findOne.mockResolvedValue({
        defaultCurrency: "USD",
      });

      dataSource.query.mockResolvedValueOnce([
        {
          month: "2024-01-01",
          balance: 10000,
          market_value: null,
          account_id: "brokerage",
          account_type: AccountType.INVESTMENT,
          account_sub_type: "INVESTMENT_BROKERAGE",
          currency_code: "USD",
        },
      ]);

      const result = await service.getMonthlyNetWorth("user-1");

      expect(result[0].assets).toBe(10000);
    });

    it("applies date range filters", async () => {
      mabRepository.count.mockResolvedValue(5);
      prefRepository.findOne.mockResolvedValue({
        defaultCurrency: "USD",
      });
      dataSource.query.mockResolvedValueOnce([]);

      await service.getMonthlyNetWorth("user-1", "2024-01-01", "2024-06-30");

      const queryArgs = dataSource.query.mock.calls[0];
      expect(queryArgs[1]).toEqual(["user-1", "2024-01-01", "2024-06-30"]);
    });

    it("uses default date range when none specified", async () => {
      mabRepository.count.mockResolvedValue(5);
      prefRepository.findOne.mockResolvedValue(null);
      dataSource.query.mockResolvedValueOnce([]);

      await service.getMonthlyNetWorth("user-1");

      const queryArgs = dataSource.query.mock.calls[0];
      expect(queryArgs[1][0]).toBe("user-1");
      expect(queryArgs[1][1]).toBe("1990-01-01");
      // end date should be today
      expect(queryArgs[1][2]).toBe(new Date().toISOString().slice(0, 10));
    });

    it("defaults to USD when user has no preference", async () => {
      mabRepository.count.mockResolvedValue(5);
      prefRepository.findOne.mockResolvedValue(null);
      dataSource.query.mockResolvedValueOnce([
        {
          month: "2024-01-01",
          balance: 1000,
          market_value: null,
          account_id: "a1",
          account_type: AccountType.CHEQUING,
          account_sub_type: null,
          currency_code: "USD",
        },
      ]);

      const result = await service.getMonthlyNetWorth("user-1");

      // No currency conversion needed (USD to USD), so no rate query
      expect(result[0].assets).toBe(1000);
    });

    it("converts foreign currency amounts using exchange rates", async () => {
      mabRepository.count.mockResolvedValue(5);
      prefRepository.findOne.mockResolvedValue({
        defaultCurrency: "USD",
      });

      dataSource.query
        .mockResolvedValueOnce([
          {
            month: "2024-01-01",
            balance: 1000,
            market_value: null,
            account_id: "cad-account",
            account_type: AccountType.CHEQUING,
            account_sub_type: null,
            currency_code: "CAD",
          },
        ])
        // buildRateIndex returns rates
        .mockResolvedValueOnce([
          {
            from_currency: "CAD",
            to_currency: "USD",
            rate: 0.75,
            rate_date: "2024-01-15",
          },
        ]);

      const result = await service.getMonthlyNetWorth("user-1");

      // 1000 CAD * 0.75 = 750 USD
      expect(result[0].assets).toBe(750);
    });

    it("uses reverse exchange rate when direct rate not available", async () => {
      mabRepository.count.mockResolvedValue(5);
      prefRepository.findOne.mockResolvedValue({
        defaultCurrency: "USD",
      });

      dataSource.query
        .mockResolvedValueOnce([
          {
            month: "2024-01-01",
            balance: 1000,
            market_value: null,
            account_id: "eur-account",
            account_type: AccountType.CHEQUING,
            account_sub_type: null,
            currency_code: "EUR",
          },
        ])
        // buildRateIndex returns reverse rate only
        .mockResolvedValueOnce([
          {
            from_currency: "USD",
            to_currency: "EUR",
            rate: 0.92,
            rate_date: "2024-01-15",
          },
        ]);

      const result = await service.getMonthlyNetWorth("user-1");

      // 1000 EUR / 0.92 = ~1087
      expect(result[0].assets).toBe(Math.round(1000 / 0.92));
    });

    it("returns amount unconverted when no rate exists", async () => {
      mabRepository.count.mockResolvedValue(5);
      prefRepository.findOne.mockResolvedValue({
        defaultCurrency: "USD",
      });

      dataSource.query
        .mockResolvedValueOnce([
          {
            month: "2024-01-01",
            balance: 1000,
            market_value: null,
            account_id: "jpy-account",
            account_type: AccountType.CHEQUING,
            account_sub_type: null,
            currency_code: "JPY",
          },
        ])
        // no rates returned
        .mockResolvedValueOnce([]);

      const result = await service.getMonthlyNetWorth("user-1");

      // Falls back to unconverted amount
      expect(result[0].assets).toBe(1000);
    });

    it("aggregates multiple accounts in the same month", async () => {
      mabRepository.count.mockResolvedValue(5);
      prefRepository.findOne.mockResolvedValue({
        defaultCurrency: "USD",
      });

      dataSource.query.mockResolvedValueOnce([
        {
          month: "2024-01-01",
          balance: 3000,
          market_value: null,
          account_id: "a1",
          account_type: AccountType.CHEQUING,
          account_sub_type: null,
          currency_code: "USD",
        },
        {
          month: "2024-01-01",
          balance: 2000,
          market_value: null,
          account_id: "a2",
          account_type: AccountType.SAVINGS,
          account_sub_type: null,
          currency_code: "USD",
        },
        {
          month: "2024-02-01",
          balance: 3500,
          market_value: null,
          account_id: "a1",
          account_type: AccountType.CHEQUING,
          account_sub_type: null,
          currency_code: "USD",
        },
      ]);

      const result = await service.getMonthlyNetWorth("user-1");

      expect(result).toHaveLength(2);
      expect(result[0].month).toBe("2024-01-01");
      expect(result[0].assets).toBe(5000);
      expect(result[1].month).toBe("2024-02-01");
      expect(result[1].assets).toBe(3500);
    });

    it("sorts results by month", async () => {
      mabRepository.count.mockResolvedValue(5);
      prefRepository.findOne.mockResolvedValue({
        defaultCurrency: "USD",
      });

      // Return out of order
      dataSource.query.mockResolvedValueOnce([
        {
          month: "2024-03-01",
          balance: 3000,
          market_value: null,
          account_id: "a1",
          account_type: AccountType.CHEQUING,
          account_sub_type: null,
          currency_code: "USD",
        },
        {
          month: "2024-01-01",
          balance: 1000,
          market_value: null,
          account_id: "a1",
          account_type: AccountType.CHEQUING,
          account_sub_type: null,
          currency_code: "USD",
        },
        {
          month: "2024-02-01",
          balance: 2000,
          market_value: null,
          account_id: "a1",
          account_type: AccountType.CHEQUING,
          account_sub_type: null,
          currency_code: "USD",
        },
      ]);

      const result = await service.getMonthlyNetWorth("user-1");

      expect(result[0].month).toBe("2024-01-01");
      expect(result[1].month).toBe("2024-02-01");
      expect(result[2].month).toBe("2024-03-01");
    });

    it("rounds values to whole numbers", async () => {
      mabRepository.count.mockResolvedValue(5);
      prefRepository.findOne.mockResolvedValue({
        defaultCurrency: "USD",
      });

      dataSource.query.mockResolvedValueOnce([
        {
          month: "2024-01-01",
          balance: 1000.567,
          market_value: null,
          account_id: "a1",
          account_type: AccountType.CHEQUING,
          account_sub_type: null,
          currency_code: "USD",
        },
      ]);

      const result = await service.getMonthlyNetWorth("user-1");

      expect(result[0].assets).toBe(1001);
      expect(Number.isInteger(result[0].assets)).toBe(true);
      expect(Number.isInteger(result[0].liabilities)).toBe(true);
      expect(Number.isInteger(result[0].netWorth)).toBe(true);
    });

    it("classifies all liability types correctly", async () => {
      mabRepository.count.mockResolvedValue(5);
      prefRepository.findOne.mockResolvedValue({
        defaultCurrency: "USD",
      });

      const liabilityTypes = [
        AccountType.CREDIT_CARD,
        AccountType.LOAN,
        AccountType.MORTGAGE,
        AccountType.LINE_OF_CREDIT,
      ];

      const snapshots = liabilityTypes.map((type, i) => ({
        month: "2024-01-01",
        balance: -1000,
        market_value: null,
        account_id: `liability-${i}`,
        account_type: type,
        account_sub_type: null,
        currency_code: "USD",
      }));

      dataSource.query.mockResolvedValueOnce(snapshots);

      const result = await service.getMonthlyNetWorth("user-1");

      expect(result[0].assets).toBe(0);
      expect(result[0].liabilities).toBe(4000); // 4 * abs(-1000)
    });

    it("calls ensurePopulated before fetching data", async () => {
      mabRepository.count.mockResolvedValue(0);
      accountRepository.find.mockResolvedValue([]);
      prefRepository.findOne.mockResolvedValue(null);
      dataSource.query.mockResolvedValueOnce([]);

      await service.getMonthlyNetWorth("user-1");

      // ensurePopulated checks mab count
      expect(mabRepository.count).toHaveBeenCalledWith({
        where: { userId: "user-1" },
      });
    });
  });

  describe("getMonthlyInvestments", () => {
    it("returns empty array when no snapshots exist", async () => {
      mabRepository.count.mockResolvedValue(5);
      prefRepository.findOne.mockResolvedValue({
        defaultCurrency: "USD",
      });
      dataSource.query.mockResolvedValueOnce([]);

      const result = await service.getMonthlyInvestments("user-1");

      expect(result).toEqual([]);
    });

    it("returns investment values aggregated by month", async () => {
      mabRepository.count.mockResolvedValue(5);
      prefRepository.findOne.mockResolvedValue({
        defaultCurrency: "USD",
      });

      dataSource.query.mockResolvedValueOnce([
        {
          month: "2024-01-01",
          balance: 5000,
          market_value: 8000,
          account_id: "inv-1",
          account_sub_type: "INVESTMENT_BROKERAGE",
          currency_code: "USD",
        },
        {
          month: "2024-01-01",
          balance: 2000,
          market_value: null,
          account_id: "inv-cash",
          account_sub_type: "INVESTMENT_CASH",
          currency_code: "USD",
        },
      ]);

      const result = await service.getMonthlyInvestments("user-1");

      expect(result).toHaveLength(1);
      // Brokerage uses market_value (8000), cash uses balance (2000)
      expect(result[0].value).toBe(10000);
    });

    it("filters by specific accountIds when provided", async () => {
      mabRepository.count.mockResolvedValue(5);
      prefRepository.findOne.mockResolvedValue({
        defaultCurrency: "USD",
      });

      // Linked account resolution query
      dataSource.query
        .mockResolvedValueOnce([
          { id: "inv-1", linked_account_id: "inv-cash-1" },
          { id: "inv-cash-1", linked_account_id: "inv-1" },
        ])
        // Main snapshots query
        .mockResolvedValueOnce([
          {
            month: "2024-01-01",
            balance: 5000,
            market_value: 8000,
            account_id: "inv-1",
            account_sub_type: "INVESTMENT_BROKERAGE",
            currency_code: "USD",
          },
        ]);

      const result = await service.getMonthlyInvestments(
        "user-1",
        undefined,
        undefined,
        ["inv-1"],
      );

      expect(result).toHaveLength(1);
      expect(result[0].value).toBe(8000);
    });

    it("uses date range filters", async () => {
      mabRepository.count.mockResolvedValue(5);
      prefRepository.findOne.mockResolvedValue({
        defaultCurrency: "USD",
      });
      dataSource.query.mockResolvedValueOnce([]);

      await service.getMonthlyInvestments("user-1", "2024-01-01", "2024-12-31");

      const queryArgs = dataSource.query.mock.calls[0];
      expect(queryArgs[1]).toContain("2024-01-01");
      expect(queryArgs[1]).toContain("2024-12-31");
    });

    it("converts foreign currency investment values", async () => {
      mabRepository.count.mockResolvedValue(5);
      prefRepository.findOne.mockResolvedValue({
        defaultCurrency: "USD",
      });

      dataSource.query
        .mockResolvedValueOnce([
          {
            month: "2024-01-01",
            balance: 1000,
            market_value: 1500,
            account_id: "cad-inv",
            account_sub_type: "INVESTMENT_BROKERAGE",
            currency_code: "CAD",
          },
        ])
        // exchange rates
        .mockResolvedValueOnce([
          {
            from_currency: "CAD",
            to_currency: "USD",
            rate: 0.75,
            rate_date: "2024-01-20",
          },
        ]);

      const result = await service.getMonthlyInvestments("user-1");

      // 1500 CAD * 0.75 = 1125 USD
      expect(result[0].value).toBe(1125);
    });

    it("sorts results by month", async () => {
      mabRepository.count.mockResolvedValue(5);
      prefRepository.findOne.mockResolvedValue({
        defaultCurrency: "USD",
      });

      dataSource.query.mockResolvedValueOnce([
        {
          month: "2024-03-01",
          balance: 3000,
          market_value: null,
          account_id: "inv-1",
          account_sub_type: "INVESTMENT_CASH",
          currency_code: "USD",
        },
        {
          month: "2024-01-01",
          balance: 1000,
          market_value: null,
          account_id: "inv-1",
          account_sub_type: "INVESTMENT_CASH",
          currency_code: "USD",
        },
      ]);

      const result = await service.getMonthlyInvestments("user-1");

      expect(result[0].month).toBe("2024-01-01");
      expect(result[1].month).toBe("2024-03-01");
    });

    it("rounds values to whole numbers", async () => {
      mabRepository.count.mockResolvedValue(5);
      prefRepository.findOne.mockResolvedValue({
        defaultCurrency: "USD",
      });

      dataSource.query.mockResolvedValueOnce([
        {
          month: "2024-01-01",
          balance: 1234.567,
          market_value: null,
          account_id: "inv-1",
          account_sub_type: "INVESTMENT_CASH",
          currency_code: "USD",
        },
      ]);

      const result = await service.getMonthlyInvestments("user-1");

      expect(result[0].value).toBe(1235);
      expect(Number.isInteger(result[0].value)).toBe(true);
    });

    it("defaults to filtering INVESTMENT_CASH and INVESTMENT_BROKERAGE sub types when no accountIds", async () => {
      mabRepository.count.mockResolvedValue(5);
      prefRepository.findOne.mockResolvedValue({
        defaultCurrency: "USD",
      });
      dataSource.query.mockResolvedValueOnce([]);

      await service.getMonthlyInvestments("user-1");

      const queryStr = dataSource.query.mock.calls[0][0];
      expect(queryStr).toContain("INVESTMENT_CASH");
      expect(queryStr).toContain("INVESTMENT_BROKERAGE");
    });

    it("resolves linked account pairs when filtering by accountIds", async () => {
      mabRepository.count.mockResolvedValue(5);
      prefRepository.findOne.mockResolvedValue({
        defaultCurrency: "USD",
      });

      // First call resolves linked accounts for inv-1
      dataSource.query
        .mockResolvedValueOnce([
          { id: "inv-1", linked_account_id: "inv-cash-1" },
          { id: "inv-cash-1", linked_account_id: "inv-1" },
        ])
        // Second call resolves linked accounts for inv-2
        .mockResolvedValueOnce([{ id: "inv-2", linked_account_id: null }])
        // Main snapshots query
        .mockResolvedValueOnce([
          {
            month: "2024-01-01",
            balance: 5000,
            market_value: 8000,
            account_id: "inv-1",
            account_sub_type: "INVESTMENT_BROKERAGE",
            currency_code: "USD",
          },
          {
            month: "2024-01-01",
            balance: 1000,
            market_value: null,
            account_id: "inv-cash-1",
            account_sub_type: "INVESTMENT_CASH",
            currency_code: "USD",
          },
        ]);

      await service.getMonthlyInvestments("user-1", undefined, undefined, [
        "inv-1",
        "inv-2",
      ]);

      // The snapshot query should include all resolved IDs
      const mainQueryCall = dataSource.query.mock.calls[2];
      expect(mainQueryCall[0]).toContain("IN");
    });

    it("calls ensurePopulated before fetching data", async () => {
      mabRepository.count.mockResolvedValue(0);
      accountRepository.find.mockResolvedValue([]);
      prefRepository.findOne.mockResolvedValue(null);
      dataSource.query.mockResolvedValueOnce([]);

      await service.getMonthlyInvestments("user-1");

      expect(mabRepository.count).toHaveBeenCalledWith({
        where: { userId: "user-1" },
      });
    });
  });

  describe("getDailyInvestments", () => {
    it("returns empty array when no accounts match", async () => {
      prefRepository.findOne.mockResolvedValue({
        defaultCurrency: "USD",
      });
      // accounts query returns empty
      dataSource.query.mockResolvedValueOnce([]);

      const result = await service.getDailyInvestments(
        "user-1",
        "2025-03-01",
        "2025-03-04",
      );

      expect(result).toEqual([]);
    });

    it("returns daily values for brokerage accounts with security prices", async () => {
      prefRepository.findOne.mockResolvedValue({
        defaultCurrency: "USD",
      });

      // accounts query
      dataSource.query.mockResolvedValueOnce([
        {
          id: "brok-1",
          account_type: "INVESTMENT",
          account_sub_type: "INVESTMENT_BROKERAGE",
          currency_code: "USD",
          opening_balance: 0,
        },
      ]);

      // investment transactions query
      dataSource.query.mockResolvedValueOnce([
        {
          account_id: "brok-1",
          security_id: "sec-1",
          action: "BUY",
          quantity: "10",
          transaction_date: "2025-02-01",
        },
      ]);

      // securities
      securityRepository.findByIds.mockResolvedValue([
        { id: "sec-1", skipPriceUpdates: false },
      ]);

      // security prices query
      dataSource.query.mockResolvedValueOnce([
        {
          security_id: "sec-1",
          price_date: "2025-03-01",
          close_price: "100.00",
        },
        {
          security_id: "sec-1",
          price_date: "2025-03-02",
          close_price: "102.00",
        },
        {
          security_id: "sec-1",
          price_date: "2025-03-03",
          close_price: "101.00",
        },
      ]);

      const result = await service.getDailyInvestments(
        "user-1",
        "2025-03-01",
        "2025-03-03",
      );

      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({ date: "2025-03-01", value: 1000 });
      expect(result[1]).toEqual({ date: "2025-03-02", value: 1020 });
      expect(result[2]).toEqual({ date: "2025-03-03", value: 1010 });
    });

    it("includes cash balances from INVESTMENT_CASH accounts", async () => {
      prefRepository.findOne.mockResolvedValue({
        defaultCurrency: "USD",
      });

      // accounts query: only a cash account
      dataSource.query.mockResolvedValueOnce([
        {
          id: "cash-1",
          account_type: "INVESTMENT",
          account_sub_type: "INVESTMENT_CASH",
          currency_code: "USD",
          opening_balance: 5000,
        },
      ]);

      // no investment transactions (no brokerage accounts)

      // securities (empty)
      securityRepository.findByIds.mockResolvedValue([]);

      // cash balances CTE query
      dataSource.query.mockResolvedValueOnce([
        { date: "2025-03-01", balance: "5000", account_id: "cash-1" },
        { date: "2025-03-02", balance: "5100", account_id: "cash-1" },
      ]);

      const result = await service.getDailyInvestments(
        "user-1",
        "2025-03-01",
        "2025-03-02",
      );

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ date: "2025-03-01", value: 5000 });
      expect(result[1]).toEqual({ date: "2025-03-02", value: 5100 });
    });

    it("resolves linked account pairs when accountIds provided", async () => {
      prefRepository.findOne.mockResolvedValue({
        defaultCurrency: "USD",
      });

      // Linked account resolution
      dataSource.query.mockResolvedValueOnce([
        { id: "brok-1", linked_account_id: "cash-1" },
        { id: "cash-1", linked_account_id: "brok-1" },
      ]);

      // accounts query with resolved IDs
      dataSource.query.mockResolvedValueOnce([
        {
          id: "brok-1",
          account_type: "INVESTMENT",
          account_sub_type: "INVESTMENT_BROKERAGE",
          currency_code: "USD",
          opening_balance: 0,
        },
        {
          id: "cash-1",
          account_type: "INVESTMENT",
          account_sub_type: "INVESTMENT_CASH",
          currency_code: "USD",
          opening_balance: 1000,
        },
      ]);

      // investment transactions
      dataSource.query.mockResolvedValueOnce([]);
      // securities
      securityRepository.findByIds.mockResolvedValue([]);
      // cash balances
      dataSource.query.mockResolvedValueOnce([
        { date: "2025-03-01", balance: "1000", account_id: "cash-1" },
      ]);

      const result = await service.getDailyInvestments(
        "user-1",
        "2025-03-01",
        "2025-03-01",
        ["brok-1"],
      );

      expect(result).toHaveLength(1);
      expect(result[0].value).toBe(1000);
    });

    it("converts foreign currency brokerage values to default currency", async () => {
      prefRepository.findOne.mockResolvedValue({
        defaultCurrency: "USD",
      });

      // accounts query: CAD brokerage
      dataSource.query.mockResolvedValueOnce([
        {
          id: "brok-cad",
          account_type: "INVESTMENT",
          account_sub_type: "INVESTMENT_BROKERAGE",
          currency_code: "CAD",
          opening_balance: 0,
        },
      ]);

      // investment transactions
      dataSource.query.mockResolvedValueOnce([
        {
          account_id: "brok-cad",
          security_id: "sec-1",
          action: "BUY",
          quantity: "10",
          transaction_date: "2025-02-01",
        },
      ]);

      // securities
      securityRepository.findByIds.mockResolvedValue([
        { id: "sec-1", skipPriceUpdates: false },
      ]);

      // security prices
      dataSource.query.mockResolvedValueOnce([
        {
          security_id: "sec-1",
          price_date: "2025-03-01",
          close_price: "100.00",
        },
      ]);

      // exchange rates (buildRateIndex)
      dataSource.query.mockResolvedValueOnce([
        {
          from_currency: "CAD",
          to_currency: "USD",
          rate: "0.75",
          rate_date: "2025-02-28",
        },
      ]);

      const result = await service.getDailyInvestments(
        "user-1",
        "2025-03-01",
        "2025-03-01",
      );

      // 10 shares * $100 CAD = $1000 CAD * 0.75 = $750 USD
      expect(result).toHaveLength(1);
      expect(result[0].value).toBe(750);
    });

    it("converts foreign currency cash balances to default currency", async () => {
      prefRepository.findOne.mockResolvedValue({
        defaultCurrency: "USD",
      });

      // accounts query: CAD brokerage + CAD cash
      dataSource.query.mockResolvedValueOnce([
        {
          id: "brok-cad",
          account_type: "INVESTMENT",
          account_sub_type: "INVESTMENT_BROKERAGE",
          currency_code: "CAD",
          opening_balance: 0,
        },
        {
          id: "cash-cad",
          account_type: "INVESTMENT",
          account_sub_type: "INVESTMENT_CASH",
          currency_code: "CAD",
          opening_balance: 5000,
        },
      ]);

      // investment transactions
      dataSource.query.mockResolvedValueOnce([
        {
          account_id: "brok-cad",
          security_id: "sec-1",
          action: "BUY",
          quantity: "10",
          transaction_date: "2025-02-01",
        },
      ]);

      // securities
      securityRepository.findByIds.mockResolvedValue([
        { id: "sec-1", skipPriceUpdates: false },
      ]);

      // security prices
      dataSource.query.mockResolvedValueOnce([
        {
          security_id: "sec-1",
          price_date: "2025-03-01",
          close_price: "100.00",
        },
      ]);

      // cash balances CTE
      dataSource.query.mockResolvedValueOnce([
        { date: "2025-03-01", balance: "5000", account_id: "cash-cad" },
      ]);

      // exchange rates (buildRateIndex)
      dataSource.query.mockResolvedValueOnce([
        {
          from_currency: "CAD",
          to_currency: "USD",
          rate: "0.75",
          rate_date: "2025-02-28",
        },
      ]);

      const result = await service.getDailyInvestments(
        "user-1",
        "2025-03-01",
        "2025-03-01",
      );

      // Securities: 10 * $100 CAD = $1000 CAD * 0.75 = $750 USD
      // Cash: $5000 CAD * 0.75 = $3750 USD
      // Total: $4500 USD
      expect(result).toHaveLength(1);
      expect(result[0].value).toBe(4500);
    });

    it("includes standalone investment account securities with currency conversion", async () => {
      prefRepository.findOne.mockResolvedValue({
        defaultCurrency: "USD",
      });

      // accounts query: standalone EUR investment account (no sub_type)
      dataSource.query.mockResolvedValueOnce([
        {
          id: "inv-eur",
          account_type: "INVESTMENT",
          account_sub_type: null,
          currency_code: "EUR",
          opening_balance: 1000,
        },
      ]);

      // investment transactions (standalone accounts have investment transactions)
      dataSource.query.mockResolvedValueOnce([
        {
          account_id: "inv-eur",
          security_id: "sec-eur",
          action: "BUY",
          quantity: "20",
          transaction_date: "2025-01-15",
        },
      ]);

      // securities
      securityRepository.findByIds.mockResolvedValue([
        { id: "sec-eur", skipPriceUpdates: false },
      ]);

      // security prices
      dataSource.query.mockResolvedValueOnce([
        {
          security_id: "sec-eur",
          price_date: "2025-03-01",
          close_price: "50.00",
        },
      ]);

      // cash balances CTE (standalone accounts also appear in cashIds)
      dataSource.query.mockResolvedValueOnce([
        { date: "2025-03-01", balance: "1000", account_id: "inv-eur" },
      ]);

      // exchange rates (buildRateIndex)
      dataSource.query.mockResolvedValueOnce([
        {
          from_currency: "EUR",
          to_currency: "USD",
          rate: "1.10",
          rate_date: "2025-02-28",
        },
      ]);

      const result = await service.getDailyInvestments(
        "user-1",
        "2025-03-01",
        "2025-03-01",
      );

      // Securities: 20 * 50 EUR = 1000 EUR * 1.10 = 1100 USD
      // Cash: 1000 EUR * 1.10 = 1100 USD
      // Total: 2200 USD
      expect(result).toHaveLength(1);
      expect(result[0].value).toBe(2200);
    });

    it("converts multiple accounts with different currencies to default currency", async () => {
      prefRepository.findOne.mockResolvedValue({
        defaultCurrency: "CAD",
      });

      // accounts query: CAD brokerage + USD brokerage
      dataSource.query.mockResolvedValueOnce([
        {
          id: "brok-cad",
          account_type: "INVESTMENT",
          account_sub_type: "INVESTMENT_BROKERAGE",
          currency_code: "CAD",
          opening_balance: 0,
        },
        {
          id: "brok-usd",
          account_type: "INVESTMENT",
          account_sub_type: "INVESTMENT_BROKERAGE",
          currency_code: "USD",
          opening_balance: 0,
        },
      ]);

      // investment transactions for both accounts
      dataSource.query.mockResolvedValueOnce([
        {
          account_id: "brok-cad",
          security_id: "sec-cad",
          action: "BUY",
          quantity: "100",
          transaction_date: "2025-02-01",
        },
        {
          account_id: "brok-usd",
          security_id: "sec-usd",
          action: "BUY",
          quantity: "50",
          transaction_date: "2025-02-01",
        },
      ]);

      // securities
      securityRepository.findByIds.mockResolvedValue([
        { id: "sec-cad", skipPriceUpdates: false },
        { id: "sec-usd", skipPriceUpdates: false },
      ]);

      // security prices
      dataSource.query.mockResolvedValueOnce([
        {
          security_id: "sec-cad",
          price_date: "2025-03-01",
          close_price: "50.00",
        },
        {
          security_id: "sec-usd",
          price_date: "2025-03-01",
          close_price: "100.00",
        },
      ]);

      // exchange rates (buildRateIndex): USD->CAD rate
      dataSource.query.mockResolvedValueOnce([
        {
          from_currency: "USD",
          to_currency: "CAD",
          rate: "1.37",
          rate_date: "2025-02-28",
        },
      ]);

      const result = await service.getDailyInvestments(
        "user-1",
        "2025-03-01",
        "2025-03-01",
      );

      // CAD brokerage: 100 * $50 CAD = $5000 CAD (no conversion needed)
      // USD brokerage: 50 * $100 USD = $5000 USD * 1.37 = $6850 CAD
      // Total: $11850 CAD
      expect(result).toHaveLength(1);
      expect(result[0].value).toBe(11850);
    });

    it("handles SELL and TRANSFER_OUT actions in daily holdings replay", async () => {
      prefRepository.findOne.mockResolvedValue({
        defaultCurrency: "USD",
      });

      // accounts query
      dataSource.query.mockResolvedValueOnce([
        {
          id: "brok-1",
          account_type: "INVESTMENT",
          account_sub_type: "INVESTMENT_BROKERAGE",
          currency_code: "USD",
          opening_balance: 0,
        },
      ]);

      // investment transactions: BUY 100, SELL 30, TRANSFER_OUT 20, SPLIT 50 = 100 shares
      dataSource.query.mockResolvedValueOnce([
        {
          account_id: "brok-1",
          security_id: "sec-1",
          action: "BUY",
          quantity: "100",
          transaction_date: "2025-01-01",
        },
        {
          account_id: "brok-1",
          security_id: "sec-1",
          action: "SELL",
          quantity: "30",
          transaction_date: "2025-02-01",
        },
        {
          account_id: "brok-1",
          security_id: "sec-1",
          action: "TRANSFER_OUT",
          quantity: "20",
          transaction_date: "2025-02-15",
        },
        {
          account_id: "brok-1",
          security_id: "sec-1",
          action: "SPLIT",
          quantity: "50",
          transaction_date: "2025-02-20",
        },
      ]);

      // securities
      securityRepository.findByIds.mockResolvedValue([
        { id: "sec-1", skipPriceUpdates: false },
      ]);

      // security prices
      dataSource.query.mockResolvedValueOnce([
        {
          security_id: "sec-1",
          price_date: "2025-03-01",
          close_price: "10.00",
        },
      ]);

      const result = await service.getDailyInvestments(
        "user-1",
        "2025-03-01",
        "2025-03-01",
      );

      // 100 - 30 - 20 + 50 = 100 shares * $10 = $1000
      expect(result).toHaveLength(1);
      expect(result[0].value).toBe(1000);
    });

    it("uses transaction prices for skipPriceUpdates securities in daily mode", async () => {
      prefRepository.findOne.mockResolvedValue({
        defaultCurrency: "USD",
      });

      // accounts query
      dataSource.query.mockResolvedValueOnce([
        {
          id: "brok-1",
          account_type: "INVESTMENT",
          account_sub_type: "INVESTMENT_BROKERAGE",
          currency_code: "USD",
          opening_balance: 0,
        },
      ]);

      // investment transactions
      dataSource.query.mockResolvedValueOnce([
        {
          account_id: "brok-1",
          security_id: "sec-skip",
          action: "BUY",
          quantity: "10",
          transaction_date: "2025-01-15",
        },
      ]);

      // securities with skipPriceUpdates
      securityRepository.findByIds.mockResolvedValue([
        { id: "sec-skip", skipPriceUpdates: true },
      ]);

      // transaction-based prices for skipPriceUpdates securities
      // (market prices query is skipped since marketSecIds is empty)
      dataSource.query.mockResolvedValueOnce([
        {
          security_id: "sec-skip",
          transaction_date: "2025-01-15",
          price: "25.00",
        },
      ]);

      const result = await service.getDailyInvestments(
        "user-1",
        "2025-03-01",
        "2025-03-01",
      );

      // 10 shares * $25 (from transaction price) = $250
      expect(result).toHaveLength(1);
      expect(result[0].value).toBe(250);
    });

    it("returns empty when accountIds resolve to no accounts", async () => {
      prefRepository.findOne.mockResolvedValue({
        defaultCurrency: "USD",
      });

      // Linked account resolution returns empty
      dataSource.query.mockResolvedValueOnce([]);

      const result = await service.getDailyInvestments(
        "user-1",
        "2025-03-01",
        "2025-03-01",
        ["nonexistent"],
      );

      expect(result).toEqual([]);
    });
  });
});
