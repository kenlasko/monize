import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { NotFoundException, ForbiddenException } from "@nestjs/common";
import { HoldingsService } from "./holdings.service";
import { Holding } from "./entities/holding.entity";
import {
  InvestmentTransaction,
  InvestmentAction,
} from "./entities/investment-transaction.entity";
import {
  Account,
  AccountType,
  AccountSubType,
} from "../accounts/entities/account.entity";
import { AccountsService } from "../accounts/accounts.service";
import { SecuritiesService } from "./securities.service";

describe("HoldingsService", () => {
  let service: HoldingsService;
  let holdingsRepository: Record<string, jest.Mock>;
  let investmentTransactionsRepository: Record<string, jest.Mock>;
  let accountsRepository: Record<string, jest.Mock>;
  let accountsService: Record<string, jest.Mock>;
  let securitiesService: Record<string, jest.Mock>;

  const mockSecurity = {
    id: "sec-1",
    userId: "user-1",
    symbol: "AAPL",
    name: "Apple Inc.",
    securityType: "STOCK",
    exchange: "NASDAQ",
    currencyCode: "USD",
    isActive: true,
  };

  const mockSecurity2 = {
    id: "sec-2",
    userId: "user-1",
    symbol: "MSFT",
    name: "Microsoft Corp",
    securityType: "STOCK",
    exchange: "NASDAQ",
    currencyCode: "USD",
    isActive: true,
  };

  const mockAccount = {
    id: "acc-1",
    userId: "user-1",
    name: "Brokerage",
    accountType: AccountType.INVESTMENT,
    accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
  };

  const mockAccount2 = {
    id: "acc-2",
    userId: "user-1",
    name: "Brokerage 2",
    accountType: AccountType.INVESTMENT,
    accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
  };

  const mockHolding = {
    id: "hold-1",
    accountId: "acc-1",
    securityId: "sec-1",
    quantity: 100,
    averageCost: 150.25,
    account: mockAccount,
    security: mockSecurity,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockHolding2 = {
    id: "hold-2",
    accountId: "acc-1",
    securityId: "sec-2",
    quantity: 50,
    averageCost: 300.0,
    account: mockAccount,
    security: mockSecurity2,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  // Helper to create a fresh mock QueryBuilder
  const createMockQueryBuilder = (returnValue: unknown = null) => {
    const qb = {
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(returnValue),
      getMany: jest
        .fn()
        .mockResolvedValue(Array.isArray(returnValue) ? returnValue : []),
    };
    return qb;
  };

  beforeEach(async () => {
    holdingsRepository = {
      findOne: jest.fn(),
      find: jest.fn(),
      create: jest.fn().mockImplementation((data) => ({ ...data })),
      save: jest
        .fn()
        .mockImplementation((data) => ({ ...data, id: data.id || "new-hold" })),
      remove: jest.fn().mockResolvedValue(undefined),
      createQueryBuilder: jest.fn(() => createMockQueryBuilder()),
    };

    investmentTransactionsRepository = {
      find: jest.fn().mockResolvedValue([]),
    };

    accountsRepository = {
      find: jest.fn().mockResolvedValue([]),
    };

    accountsService = {
      findOne: jest.fn().mockResolvedValue(mockAccount),
    };

    securitiesService = {
      findOne: jest.fn().mockResolvedValue(mockSecurity),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HoldingsService,
        {
          provide: getRepositoryToken(Holding),
          useValue: holdingsRepository,
        },
        {
          provide: getRepositoryToken(InvestmentTransaction),
          useValue: investmentTransactionsRepository,
        },
        {
          provide: getRepositoryToken(Account),
          useValue: accountsRepository,
        },
        {
          provide: AccountsService,
          useValue: accountsService,
        },
        {
          provide: SecuritiesService,
          useValue: securitiesService,
        },
      ],
    }).compile();

    service = module.get<HoldingsService>(HoldingsService);
  });

  describe("findAll", () => {
    it("returns all holdings for a user", async () => {
      const qb = createMockQueryBuilder([mockHolding, mockHolding2]);
      holdingsRepository.createQueryBuilder.mockReturnValue(qb);

      const result = await service.findAll("user-1");

      expect(holdingsRepository.createQueryBuilder).toHaveBeenCalledWith(
        "holding",
      );
      expect(qb.leftJoinAndSelect).toHaveBeenCalledWith(
        "holding.account",
        "account",
      );
      expect(qb.leftJoinAndSelect).toHaveBeenCalledWith(
        "holding.security",
        "security",
      );
      expect(qb.where).toHaveBeenCalledWith("account.userId = :userId", {
        userId: "user-1",
      });
      expect(qb.getMany).toHaveBeenCalled();
      expect(result).toHaveLength(2);
    });

    it("filters by accountId when provided", async () => {
      const qb = createMockQueryBuilder([mockHolding]);
      holdingsRepository.createQueryBuilder.mockReturnValue(qb);

      const result = await service.findAll("user-1", "acc-1");

      expect(qb.andWhere).toHaveBeenCalledWith(
        "holding.accountId = :accountId",
        {
          accountId: "acc-1",
        },
      );
      expect(result).toHaveLength(1);
    });

    it("does not filter by accountId when not provided", async () => {
      const qb = createMockQueryBuilder([]);
      holdingsRepository.createQueryBuilder.mockReturnValue(qb);

      await service.findAll("user-1");

      expect(qb.andWhere).not.toHaveBeenCalled();
    });

    it("returns empty array when no holdings exist", async () => {
      const qb = createMockQueryBuilder([]);
      holdingsRepository.createQueryBuilder.mockReturnValue(qb);

      const result = await service.findAll("user-1");

      expect(result).toHaveLength(0);
    });
  });

  describe("findOne", () => {
    it("returns holding when found", async () => {
      const qb = createMockQueryBuilder(mockHolding);
      holdingsRepository.createQueryBuilder.mockReturnValue(qb);

      const result = await service.findOne("user-1", "hold-1");

      expect(holdingsRepository.createQueryBuilder).toHaveBeenCalledWith(
        "holding",
      );
      expect(qb.leftJoinAndSelect).toHaveBeenCalledWith(
        "holding.account",
        "account",
      );
      expect(qb.leftJoinAndSelect).toHaveBeenCalledWith(
        "holding.security",
        "security",
      );
      expect(qb.where).toHaveBeenCalledWith("holding.id = :id", {
        id: "hold-1",
      });
      expect(qb.andWhere).toHaveBeenCalledWith("account.userId = :userId", {
        userId: "user-1",
      });
      expect(result).toEqual(mockHolding);
    });

    it("throws NotFoundException when holding not found", async () => {
      const qb = createMockQueryBuilder(null);
      holdingsRepository.createQueryBuilder.mockReturnValue(qb);

      await expect(service.findOne("user-1", "nonexistent")).rejects.toThrow(
        NotFoundException,
      );
    });

    it("throws NotFoundException with descriptive message", async () => {
      const qb = createMockQueryBuilder(null);
      holdingsRepository.createQueryBuilder.mockReturnValue(qb);

      await expect(service.findOne("user-1", "hold-999")).rejects.toThrow(
        "Holding with ID hold-999 not found",
      );
    });
  });

  describe("findByAccountAndSecurity", () => {
    it("returns holding when found", async () => {
      holdingsRepository.findOne.mockResolvedValue(mockHolding);

      const result = await service.findByAccountAndSecurity("acc-1", "sec-1");

      expect(holdingsRepository.findOne).toHaveBeenCalledWith({
        where: { accountId: "acc-1", securityId: "sec-1" },
        relations: ["account", "security"],
      });
      expect(result).toEqual(mockHolding);
    });

    it("returns null when no holding found", async () => {
      holdingsRepository.findOne.mockResolvedValue(null);

      const result = await service.findByAccountAndSecurity("acc-1", "sec-99");

      expect(result).toBeNull();
    });
  });

  describe("createOrUpdate", () => {
    it("creates a new holding when none exists", async () => {
      holdingsRepository.findOne.mockResolvedValue(null);
      const createdHolding = {
        accountId: "acc-1",
        securityId: "sec-1",
        quantity: 10,
        averageCost: 150,
      };
      holdingsRepository.create.mockReturnValue(createdHolding);
      holdingsRepository.save.mockResolvedValue({
        ...createdHolding,
        id: "new-hold",
      });

      const result = await service.createOrUpdate(
        "user-1",
        "acc-1",
        "sec-1",
        10,
        150,
      );

      expect(accountsService.findOne).toHaveBeenCalledWith("user-1", "acc-1");
      expect(securitiesService.findOne).toHaveBeenCalledWith("user-1", "sec-1");
      expect(holdingsRepository.create).toHaveBeenCalledWith({
        accountId: "acc-1",
        securityId: "sec-1",
        quantity: 10,
        averageCost: 150,
      });
      expect(holdingsRepository.save).toHaveBeenCalledWith(createdHolding);
      expect(result.id).toBe("new-hold");
    });

    it("updates existing holding when buying more shares", async () => {
      const existingHolding = {
        id: "hold-1",
        accountId: "acc-1",
        securityId: "sec-1",
        quantity: 100,
        averageCost: 150,
      };
      holdingsRepository.findOne.mockResolvedValue(existingHolding);
      holdingsRepository.save.mockImplementation((data) =>
        Promise.resolve(data),
      );

      const result = await service.createOrUpdate(
        "user-1",
        "acc-1",
        "sec-1",
        50,
        200,
      );

      // New average cost: (100*150 + 50*200) / 150 = (15000 + 10000) / 150 = 166.666...
      expect(result.quantity).toBe(150);
      expect(result.averageCost).toBeCloseTo(166.6667, 3);
    });

    it("updates existing holding when selling shares (keeps average cost)", async () => {
      const existingHolding = {
        id: "hold-1",
        accountId: "acc-1",
        securityId: "sec-1",
        quantity: 100,
        averageCost: 150,
      };
      holdingsRepository.findOne.mockResolvedValue(existingHolding);
      holdingsRepository.save.mockImplementation((data) =>
        Promise.resolve(data),
      );

      const result = await service.createOrUpdate(
        "user-1",
        "acc-1",
        "sec-1",
        -30,
        200,
      );

      expect(result.quantity).toBe(70);
      // Average cost should remain 150 when selling
      expect(result.averageCost).toBe(150);
    });

    it("propagates error when account ownership check fails", async () => {
      accountsService.findOne.mockRejectedValue(
        new NotFoundException("Account not found"),
      );

      await expect(
        service.createOrUpdate("user-1", "acc-999", "sec-1", 10, 150),
      ).rejects.toThrow(NotFoundException);
    });

    it("propagates error when security ownership check fails", async () => {
      securitiesService.findOne.mockRejectedValue(
        new NotFoundException("Security not found"),
      );

      await expect(
        service.createOrUpdate("user-1", "acc-1", "sec-999", 10, 150),
      ).rejects.toThrow(NotFoundException);
    });

    it("handles buying shares when averageCost is null on existing holding", async () => {
      const existingHolding = {
        id: "hold-1",
        accountId: "acc-1",
        securityId: "sec-1",
        quantity: 50,
        averageCost: null,
      };
      holdingsRepository.findOne.mockResolvedValue(existingHolding);
      holdingsRepository.save.mockImplementation((data) =>
        Promise.resolve(data),
      );

      const result = await service.createOrUpdate(
        "user-1",
        "acc-1",
        "sec-1",
        50,
        200,
      );

      // (50*0 + 50*200) / 100 = 100
      expect(result.quantity).toBe(100);
      expect(result.averageCost).toBeCloseTo(100, 2);
    });

    it("correctly handles selling all shares", async () => {
      const existingHolding = {
        id: "hold-1",
        accountId: "acc-1",
        securityId: "sec-1",
        quantity: 100,
        averageCost: 150,
      };
      holdingsRepository.findOne.mockResolvedValue(existingHolding);
      holdingsRepository.save.mockImplementation((data) =>
        Promise.resolve(data),
      );

      const result = await service.createOrUpdate(
        "user-1",
        "acc-1",
        "sec-1",
        -100,
        200,
      );

      expect(result.quantity).toBe(0);
      // Average cost remains unchanged when selling
      expect(result.averageCost).toBe(150);
    });
  });

  describe("updateHolding", () => {
    it("delegates to createOrUpdate", async () => {
      holdingsRepository.findOne.mockResolvedValue(null);
      const createdHolding = {
        accountId: "acc-1",
        securityId: "sec-1",
        quantity: 10,
        averageCost: 100,
      };
      holdingsRepository.create.mockReturnValue(createdHolding);
      holdingsRepository.save.mockResolvedValue({
        ...createdHolding,
        id: "new-hold",
      });

      const result = await service.updateHolding(
        "user-1",
        "acc-1",
        "sec-1",
        10,
        100,
      );

      expect(accountsService.findOne).toHaveBeenCalledWith("user-1", "acc-1");
      expect(securitiesService.findOne).toHaveBeenCalledWith("user-1", "sec-1");
      expect(result.id).toBe("new-hold");
    });
  });

  describe("adjustQuantity", () => {
    it("creates new holding when none exists (positive quantity)", async () => {
      holdingsRepository.findOne.mockResolvedValue(null);
      const createdHolding = {
        accountId: "acc-1",
        securityId: "sec-1",
        quantity: 25,
        averageCost: 0,
      };
      holdingsRepository.create.mockReturnValue(createdHolding);
      holdingsRepository.save.mockResolvedValue({
        ...createdHolding,
        id: "new-hold",
      });

      const result = await service.adjustQuantity(
        "user-1",
        "acc-1",
        "sec-1",
        25,
      );

      expect(accountsService.findOne).toHaveBeenCalledWith("user-1", "acc-1");
      expect(securitiesService.findOne).toHaveBeenCalledWith("user-1", "sec-1");
      expect(holdingsRepository.create).toHaveBeenCalledWith({
        accountId: "acc-1",
        securityId: "sec-1",
        quantity: 25,
        averageCost: 0,
      });
      expect(holdingsRepository.save).toHaveBeenCalled();
    });

    it("throws NotFoundException when removing shares from non-existent holding", async () => {
      holdingsRepository.findOne.mockResolvedValue(null);

      await expect(
        service.adjustQuantity("user-1", "acc-1", "sec-1", -10),
      ).rejects.toThrow(NotFoundException);

      await expect(
        service.adjustQuantity("user-1", "acc-1", "sec-1", -10),
      ).rejects.toThrow("Cannot remove shares from a non-existent holding");
    });

    it("adjusts quantity on existing holding without changing averageCost", async () => {
      const existingHolding = {
        id: "hold-1",
        accountId: "acc-1",
        securityId: "sec-1",
        quantity: 100,
        averageCost: 150,
      };
      holdingsRepository.findOne.mockResolvedValue(existingHolding);
      holdingsRepository.save.mockImplementation((data) =>
        Promise.resolve(data),
      );

      const result = await service.adjustQuantity(
        "user-1",
        "acc-1",
        "sec-1",
        25,
      );

      expect(result.quantity).toBe(125);
      expect(result.averageCost).toBe(150);
    });

    it("reduces quantity on existing holding", async () => {
      const existingHolding = {
        id: "hold-1",
        accountId: "acc-1",
        securityId: "sec-1",
        quantity: 100,
        averageCost: 150,
      };
      holdingsRepository.findOne.mockResolvedValue(existingHolding);
      holdingsRepository.save.mockImplementation((data) =>
        Promise.resolve(data),
      );

      const result = await service.adjustQuantity(
        "user-1",
        "acc-1",
        "sec-1",
        -30,
      );

      expect(result.quantity).toBe(70);
      expect(result.averageCost).toBe(150);
    });

    it("propagates error when account ownership check fails", async () => {
      accountsService.findOne.mockRejectedValue(
        new NotFoundException("Account not found"),
      );

      await expect(
        service.adjustQuantity("user-1", "acc-999", "sec-1", 10),
      ).rejects.toThrow(NotFoundException);
    });

    it("propagates error when security ownership check fails", async () => {
      securitiesService.findOne.mockRejectedValue(
        new NotFoundException("Security not found"),
      );

      await expect(
        service.adjustQuantity("user-1", "acc-1", "sec-999", 10),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("getHoldingsSummary", () => {
    it("returns summary for holdings in an account", async () => {
      const holdings = [
        { ...mockHolding, quantity: 100, averageCost: 150 },
        { ...mockHolding2, quantity: 50, averageCost: 300 },
      ];
      const qb = createMockQueryBuilder(holdings);
      holdingsRepository.createQueryBuilder.mockReturnValue(qb);

      const result = await service.getHoldingsSummary("user-1", "acc-1");

      expect(result.totalHoldings).toBe(2);
      expect(result.totalQuantity).toBe(150); // 100 + 50
      expect(result.totalCostBasis).toBe(30000); // 100*150 + 50*300
      expect(result.holdings).toHaveLength(2);
      expect(result.holdings[0]).toEqual({
        id: "hold-1",
        symbol: "AAPL",
        name: "Apple Inc.",
        quantity: 100,
        averageCost: 150,
        costBasis: 15000,
      });
      expect(result.holdings[1]).toEqual({
        id: "hold-2",
        symbol: "MSFT",
        name: "Microsoft Corp",
        quantity: 50,
        averageCost: 300,
        costBasis: 15000,
      });
    });

    it("returns empty summary when no holdings exist", async () => {
      const qb = createMockQueryBuilder([]);
      holdingsRepository.createQueryBuilder.mockReturnValue(qb);

      const result = await service.getHoldingsSummary("user-1", "acc-1");

      expect(result.totalHoldings).toBe(0);
      expect(result.totalQuantity).toBe(0);
      expect(result.totalCostBasis).toBe(0);
      expect(result.holdings).toHaveLength(0);
    });

    it("handles holdings with null averageCost", async () => {
      const holdingWithNullCost = {
        ...mockHolding,
        quantity: 100,
        averageCost: null,
      };
      const qb = createMockQueryBuilder([holdingWithNullCost]);
      holdingsRepository.createQueryBuilder.mockReturnValue(qb);

      const result = await service.getHoldingsSummary("user-1", "acc-1");

      expect(result.totalCostBasis).toBe(0);
      expect(result.holdings[0].averageCost).toBe(0);
      expect(result.holdings[0].costBasis).toBe(0);
    });
  });

  describe("remove", () => {
    it("removes holding with zero quantity", async () => {
      const zeroHolding = { ...mockHolding, quantity: 0 };
      const qb = createMockQueryBuilder(zeroHolding);
      holdingsRepository.createQueryBuilder.mockReturnValue(qb);

      await service.remove("user-1", "hold-1");

      expect(holdingsRepository.remove).toHaveBeenCalledWith(zeroHolding);
    });

    it("throws ForbiddenException when holding has non-zero quantity", async () => {
      const nonZeroHolding = { ...mockHolding, quantity: 50 };
      const qb = createMockQueryBuilder(nonZeroHolding);
      holdingsRepository.createQueryBuilder.mockReturnValue(qb);

      await expect(service.remove("user-1", "hold-1")).rejects.toThrow(
        ForbiddenException,
      );
    });

    it("throws ForbiddenException with descriptive message for non-zero quantity", async () => {
      const nonZeroHolding = { ...mockHolding, quantity: 10 };
      const qb = createMockQueryBuilder(nonZeroHolding);
      holdingsRepository.createQueryBuilder.mockReturnValue(qb);

      await expect(service.remove("user-1", "hold-1")).rejects.toThrow(
        "Cannot delete holding with non-zero quantity",
      );
    });

    it("throws NotFoundException when holding does not exist", async () => {
      const qb = createMockQueryBuilder(null);
      holdingsRepository.createQueryBuilder.mockReturnValue(qb);

      await expect(service.remove("user-1", "nonexistent")).rejects.toThrow(
        NotFoundException,
      );
    });

    it("handles string quantity '0' correctly (decimal from DB)", async () => {
      // Decimals from the database often come as strings
      const zeroHolding = { ...mockHolding, quantity: "0.00000000" };
      const qb = createMockQueryBuilder(zeroHolding);
      holdingsRepository.createQueryBuilder.mockReturnValue(qb);

      await service.remove("user-1", "hold-1");

      expect(holdingsRepository.remove).toHaveBeenCalledWith(zeroHolding);
    });
  });

  describe("rebuildFromTransactions", () => {
    it("returns zeros when user has no brokerage accounts", async () => {
      accountsRepository.find.mockResolvedValue([]);

      const result = await service.rebuildFromTransactions("user-1");

      expect(result).toEqual({
        holdingsCreated: 0,
        holdingsUpdated: 0,
        holdingsDeleted: 0,
      });
    });

    it("deletes existing holdings and rebuilds from buy transactions", async () => {
      accountsRepository.find.mockResolvedValue([mockAccount]);
      const existingHoldings = [{ id: "old-hold-1" }, { id: "old-hold-2" }];
      holdingsRepository.find.mockResolvedValueOnce(existingHoldings); // existing holdings to delete

      const transactions = [
        {
          accountId: "acc-1",
          securityId: "sec-1",
          action: InvestmentAction.BUY,
          quantity: 100,
          price: 150,
          transactionDate: "2025-01-01",
          createdAt: new Date("2025-01-01"),
        },
        {
          accountId: "acc-1",
          securityId: "sec-1",
          action: InvestmentAction.BUY,
          quantity: 50,
          price: 200,
          transactionDate: "2025-02-01",
          createdAt: new Date("2025-02-01"),
        },
      ];
      investmentTransactionsRepository.find.mockResolvedValue(transactions);

      const createdHolding = {
        accountId: "acc-1",
        securityId: "sec-1",
        quantity: 150,
        averageCost: 166.6667,
      };
      holdingsRepository.create.mockReturnValue(createdHolding);
      holdingsRepository.save.mockResolvedValue({
        ...createdHolding,
        id: "new-hold",
      });

      const result = await service.rebuildFromTransactions("user-1");

      expect(holdingsRepository.remove).toHaveBeenCalledWith(existingHoldings);
      expect(holdingsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: "acc-1",
          securityId: "sec-1",
          quantity: 150,
        }),
      );
      expect(result.holdingsCreated).toBe(1);
      expect(result.holdingsUpdated).toBe(0);
      expect(result.holdingsDeleted).toBe(2);
    });

    it("handles sell transactions reducing quantity and cost basis proportionally", async () => {
      accountsRepository.find.mockResolvedValue([mockAccount]);
      holdingsRepository.find.mockResolvedValue([]);

      const transactions = [
        {
          accountId: "acc-1",
          securityId: "sec-1",
          action: InvestmentAction.BUY,
          quantity: 100,
          price: 150,
          transactionDate: "2025-01-01",
          createdAt: new Date("2025-01-01"),
        },
        {
          accountId: "acc-1",
          securityId: "sec-1",
          action: InvestmentAction.SELL,
          quantity: 40,
          price: 200,
          transactionDate: "2025-02-01",
          createdAt: new Date("2025-02-01"),
        },
      ];
      investmentTransactionsRepository.find.mockResolvedValue(transactions);
      holdingsRepository.create.mockImplementation((data) => data);
      holdingsRepository.save.mockImplementation((data) =>
        Promise.resolve(data),
      );

      const result = await service.rebuildFromTransactions("user-1");

      // After buy: qty=100, totalCost=15000
      // After sell 40: avgCost=150, sell cost=40*150=6000, remaining totalCost=9000, qty=60
      // Final avgCost: 9000/60 = 150
      expect(holdingsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: "acc-1",
          securityId: "sec-1",
          quantity: 60,
          averageCost: 150,
        }),
      );
      expect(result.holdingsCreated).toBe(1);
    });

    it("handles REINVEST and TRANSFER_IN as positive quantity changes", async () => {
      accountsRepository.find.mockResolvedValue([mockAccount]);
      holdingsRepository.find.mockResolvedValue([]);

      const transactions = [
        {
          accountId: "acc-1",
          securityId: "sec-1",
          action: InvestmentAction.REINVEST,
          quantity: 10,
          price: 50,
          transactionDate: "2025-01-01",
          createdAt: new Date("2025-01-01"),
        },
        {
          accountId: "acc-1",
          securityId: "sec-1",
          action: InvestmentAction.TRANSFER_IN,
          quantity: 20,
          price: 60,
          transactionDate: "2025-02-01",
          createdAt: new Date("2025-02-01"),
        },
      ];
      investmentTransactionsRepository.find.mockResolvedValue(transactions);
      holdingsRepository.create.mockImplementation((data) => data);
      holdingsRepository.save.mockImplementation((data) =>
        Promise.resolve(data),
      );

      const result = await service.rebuildFromTransactions("user-1");

      // REINVEST: qty=10, totalCost=500
      // TRANSFER_IN: qty=30, totalCost=500+1200=1700
      // avgCost: 1700/30 = 56.666...
      expect(holdingsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          quantity: 30,
        }),
      );
      expect(result.holdingsCreated).toBe(1);
    });

    it("handles TRANSFER_OUT and REMOVE_SHARES as negative quantity changes", async () => {
      accountsRepository.find.mockResolvedValue([mockAccount]);
      holdingsRepository.find.mockResolvedValue([]);

      const transactions = [
        {
          accountId: "acc-1",
          securityId: "sec-1",
          action: InvestmentAction.BUY,
          quantity: 100,
          price: 100,
          transactionDate: "2025-01-01",
          createdAt: new Date("2025-01-01"),
        },
        {
          accountId: "acc-1",
          securityId: "sec-1",
          action: InvestmentAction.TRANSFER_OUT,
          quantity: 20,
          price: 100,
          transactionDate: "2025-02-01",
          createdAt: new Date("2025-02-01"),
        },
        {
          accountId: "acc-1",
          securityId: "sec-1",
          action: InvestmentAction.REMOVE_SHARES,
          quantity: 10,
          price: 0,
          transactionDate: "2025-03-01",
          createdAt: new Date("2025-03-01"),
        },
      ];
      investmentTransactionsRepository.find.mockResolvedValue(transactions);
      holdingsRepository.create.mockImplementation((data) => data);
      holdingsRepository.save.mockImplementation((data) =>
        Promise.resolve(data),
      );

      const result = await service.rebuildFromTransactions("user-1");

      // BUY: qty=100, totalCost=10000
      // TRANSFER_OUT (sell-like): qty=80, avgCost=100, totalCost=8000
      // REMOVE_SHARES (quantity only): qty=70, totalCost=8000
      expect(holdingsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          quantity: 70,
        }),
      );
      expect(result.holdingsCreated).toBe(1);
    });

    it("handles ADD_SHARES as quantity-only change (no cost basis change)", async () => {
      accountsRepository.find.mockResolvedValue([mockAccount]);
      holdingsRepository.find.mockResolvedValue([]);

      const transactions = [
        {
          accountId: "acc-1",
          securityId: "sec-1",
          action: InvestmentAction.BUY,
          quantity: 100,
          price: 100,
          transactionDate: "2025-01-01",
          createdAt: new Date("2025-01-01"),
        },
        {
          accountId: "acc-1",
          securityId: "sec-1",
          action: InvestmentAction.ADD_SHARES,
          quantity: 5,
          price: 0,
          transactionDate: "2025-02-01",
          createdAt: new Date("2025-02-01"),
        },
      ];
      investmentTransactionsRepository.find.mockResolvedValue(transactions);
      holdingsRepository.create.mockImplementation((data) => data);
      holdingsRepository.save.mockImplementation((data) =>
        Promise.resolve(data),
      );

      const result = await service.rebuildFromTransactions("user-1");

      // BUY: qty=100, totalCost=10000
      // ADD_SHARES (quantity only): qty=105, totalCost=10000
      // avgCost = 10000/105 = 95.238...
      expect(holdingsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          quantity: 105,
        }),
      );
      expect(result.holdingsCreated).toBe(1);
    });

    it("skips transactions without securityId", async () => {
      accountsRepository.find.mockResolvedValue([mockAccount]);
      holdingsRepository.find.mockResolvedValue([]);

      const transactions = [
        {
          accountId: "acc-1",
          securityId: null,
          action: InvestmentAction.DIVIDEND,
          quantity: null,
          price: null,
          transactionDate: "2025-01-01",
          createdAt: new Date("2025-01-01"),
        },
      ];
      investmentTransactionsRepository.find.mockResolvedValue(transactions);

      const result = await service.rebuildFromTransactions("user-1");

      expect(holdingsRepository.create).not.toHaveBeenCalled();
      expect(result.holdingsCreated).toBe(0);
    });

    it("skips non-holdings actions (DIVIDEND, INTEREST, etc.)", async () => {
      accountsRepository.find.mockResolvedValue([mockAccount]);
      holdingsRepository.find.mockResolvedValue([]);

      const transactions = [
        {
          accountId: "acc-1",
          securityId: "sec-1",
          action: InvestmentAction.DIVIDEND,
          quantity: 0,
          price: 0,
          transactionDate: "2025-01-01",
          createdAt: new Date("2025-01-01"),
        },
        {
          accountId: "acc-1",
          securityId: "sec-1",
          action: InvestmentAction.INTEREST,
          quantity: 0,
          price: 0,
          transactionDate: "2025-01-02",
          createdAt: new Date("2025-01-02"),
        },
        {
          accountId: "acc-1",
          securityId: "sec-1",
          action: InvestmentAction.CAPITAL_GAIN,
          quantity: 0,
          price: 0,
          transactionDate: "2025-01-03",
          createdAt: new Date("2025-01-03"),
        },
      ];
      investmentTransactionsRepository.find.mockResolvedValue(transactions);

      const result = await service.rebuildFromTransactions("user-1");

      expect(holdingsRepository.create).not.toHaveBeenCalled();
      expect(result.holdingsCreated).toBe(0);
    });

    it("does not create holdings for near-zero quantities", async () => {
      accountsRepository.find.mockResolvedValue([mockAccount]);
      holdingsRepository.find.mockResolvedValue([]);

      const transactions = [
        {
          accountId: "acc-1",
          securityId: "sec-1",
          action: InvestmentAction.BUY,
          quantity: 100,
          price: 100,
          transactionDate: "2025-01-01",
          createdAt: new Date("2025-01-01"),
        },
        {
          accountId: "acc-1",
          securityId: "sec-1",
          action: InvestmentAction.SELL,
          quantity: 100,
          price: 150,
          transactionDate: "2025-02-01",
          createdAt: new Date("2025-02-01"),
        },
      ];
      investmentTransactionsRepository.find.mockResolvedValue(transactions);

      const result = await service.rebuildFromTransactions("user-1");

      expect(holdingsRepository.create).not.toHaveBeenCalled();
      expect(result.holdingsCreated).toBe(0);
    });

    it("handles multiple securities across multiple accounts", async () => {
      accountsRepository.find.mockResolvedValue([mockAccount, mockAccount2]);
      holdingsRepository.find.mockResolvedValue([]);

      const transactions = [
        {
          accountId: "acc-1",
          securityId: "sec-1",
          action: InvestmentAction.BUY,
          quantity: 100,
          price: 150,
          transactionDate: "2025-01-01",
          createdAt: new Date("2025-01-01"),
        },
        {
          accountId: "acc-1",
          securityId: "sec-2",
          action: InvestmentAction.BUY,
          quantity: 50,
          price: 300,
          transactionDate: "2025-01-02",
          createdAt: new Date("2025-01-02"),
        },
        {
          accountId: "acc-2",
          securityId: "sec-1",
          action: InvestmentAction.BUY,
          quantity: 25,
          price: 160,
          transactionDate: "2025-01-03",
          createdAt: new Date("2025-01-03"),
        },
      ];
      investmentTransactionsRepository.find.mockResolvedValue(transactions);
      holdingsRepository.create.mockImplementation((data) => data);
      holdingsRepository.save.mockImplementation((data) =>
        Promise.resolve(data),
      );

      const result = await service.rebuildFromTransactions("user-1");

      expect(result.holdingsCreated).toBe(3);
      expect(holdingsRepository.create).toHaveBeenCalledTimes(3);
    });

    it("queries only brokerage accounts", async () => {
      accountsRepository.find.mockResolvedValue([]);

      await service.rebuildFromTransactions("user-1");

      expect(accountsRepository.find).toHaveBeenCalledWith({
        where: {
          userId: "user-1",
          accountType: AccountType.INVESTMENT,
          accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
        },
      });
    });

    it("does not call remove when no existing holdings", async () => {
      accountsRepository.find.mockResolvedValue([mockAccount]);
      holdingsRepository.find.mockResolvedValue([]);
      investmentTransactionsRepository.find.mockResolvedValue([]);

      const result = await service.rebuildFromTransactions("user-1");

      expect(holdingsRepository.remove).not.toHaveBeenCalled();
      expect(result.holdingsDeleted).toBe(0);
    });

    it("handles transactions with null quantity and price", async () => {
      accountsRepository.find.mockResolvedValue([mockAccount]);
      holdingsRepository.find.mockResolvedValue([]);

      const transactions = [
        {
          accountId: "acc-1",
          securityId: "sec-1",
          action: InvestmentAction.BUY,
          quantity: null,
          price: null,
          transactionDate: "2025-01-01",
          createdAt: new Date("2025-01-01"),
        },
      ];
      investmentTransactionsRepository.find.mockResolvedValue(transactions);

      const result = await service.rebuildFromTransactions("user-1");

      // quantity=0, price=0 results in near-zero quantity, not created
      expect(holdingsRepository.create).not.toHaveBeenCalled();
      expect(result.holdingsCreated).toBe(0);
    });

    it("sets averageCost to 0 when final quantity is negative", async () => {
      accountsRepository.find.mockResolvedValue([mockAccount]);
      holdingsRepository.find.mockResolvedValue([]);

      // Edge case: more sold than bought (data inconsistency)
      const transactions = [
        {
          accountId: "acc-1",
          securityId: "sec-1",
          action: InvestmentAction.BUY,
          quantity: 10,
          price: 100,
          transactionDate: "2025-01-01",
          createdAt: new Date("2025-01-01"),
        },
        {
          accountId: "acc-1",
          securityId: "sec-1",
          action: InvestmentAction.REMOVE_SHARES,
          quantity: 20,
          price: 0,
          transactionDate: "2025-02-01",
          createdAt: new Date("2025-02-01"),
        },
      ];
      investmentTransactionsRepository.find.mockResolvedValue(transactions);
      holdingsRepository.create.mockImplementation((data) => data);
      holdingsRepository.save.mockImplementation((data) =>
        Promise.resolve(data),
      );

      const result = await service.rebuildFromTransactions("user-1");

      // BUY 10 at 100: qty=10, totalCost=1000
      // REMOVE_SHARES 20 (qty only): qty=-10, totalCost=1000
      // quantity=-10, avgCost = quantity > 0 ? totalCost/quantity : 0 = 0
      expect(holdingsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          quantity: -10,
          averageCost: 0,
        }),
      );
      expect(result.holdingsCreated).toBe(1);
    });
  });

  describe("removeAllForUser", () => {
    it("returns 0 when user has no brokerage accounts", async () => {
      accountsRepository.find.mockResolvedValue([]);

      const result = await service.removeAllForUser("user-1");

      expect(result).toBe(0);
    });

    it("removes all holdings for brokerage accounts and returns count", async () => {
      accountsRepository.find.mockResolvedValue([mockAccount, mockAccount2]);
      const holdings = [{ id: "h1" }, { id: "h2" }, { id: "h3" }];
      holdingsRepository.find.mockResolvedValue(holdings);

      const result = await service.removeAllForUser("user-1");

      expect(holdingsRepository.remove).toHaveBeenCalledWith(holdings);
      expect(result).toBe(3);
    });

    it("returns 0 when brokerage accounts have no holdings", async () => {
      accountsRepository.find.mockResolvedValue([mockAccount]);
      holdingsRepository.find.mockResolvedValue([]);

      const result = await service.removeAllForUser("user-1");

      expect(holdingsRepository.remove).not.toHaveBeenCalled();
      expect(result).toBe(0);
    });

    it("queries only brokerage accounts", async () => {
      accountsRepository.find.mockResolvedValue([]);

      await service.removeAllForUser("user-1");

      expect(accountsRepository.find).toHaveBeenCalledWith({
        where: {
          userId: "user-1",
          accountType: AccountType.INVESTMENT,
          accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
        },
      });
    });

    it("uses In() to query holdings for all brokerage account IDs", async () => {
      accountsRepository.find.mockResolvedValue([mockAccount, mockAccount2]);
      holdingsRepository.find.mockResolvedValue([]);

      await service.removeAllForUser("user-1");

      // Verify find was called with a where clause containing an In() operator for accountId
      expect(holdingsRepository.find).toHaveBeenCalledTimes(1);
      const findCall = holdingsRepository.find.mock.calls[0][0];
      expect(findCall).toHaveProperty("where.accountId");
      // The In() operator creates a FindOperator; verify it wraps the expected IDs
      const accountIdOperator = findCall.where.accountId;
      expect(accountIdOperator._type).toBe("in");
      expect(accountIdOperator._value).toEqual(["acc-1", "acc-2"]);
    });
  });
});
