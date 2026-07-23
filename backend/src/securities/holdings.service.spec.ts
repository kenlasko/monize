import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { NotFoundException, ForbiddenException } from "@nestjs/common";
import { DataSource } from "typeorm";
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
  let mockQueryRunner: {
    connect: jest.Mock;
    startTransaction: jest.Mock;
    commitTransaction: jest.Mock;
    rollbackTransaction: jest.Mock;
    release: jest.Mock;
    query: jest.Mock;
    manager: {
      find: jest.Mock;
      remove: jest.Mock;
      getRepository: jest.Mock;
    };
  };
  let mockQrRepo: {
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
  };

  const mockSecurity = {
    id: "sec-1",
    userId: "11111111-1111-1111-1111-111111111111",
    symbol: "AAPL",
    name: "Apple Inc.",
    securityType: "STOCK",
    exchange: "NASDAQ",
    currencyCode: "USD",
    isActive: true,
  };

  const mockSecurity2 = {
    id: "sec-2",
    userId: "11111111-1111-1111-1111-111111111111",
    symbol: "MSFT",
    name: "Microsoft Corp",
    securityType: "STOCK",
    exchange: "NASDAQ",
    currencyCode: "USD",
    isActive: true,
  };

  const mockAccount = {
    id: "acc-1",
    userId: "11111111-1111-1111-1111-111111111111",
    name: "Brokerage",
    accountType: AccountType.INVESTMENT,
    accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
  };

  const mockAccount2 = {
    id: "acc-2",
    userId: "11111111-1111-1111-1111-111111111111",
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

    mockQrRepo = {
      create: jest.fn().mockImplementation((data: any) => ({ ...data })),
      save: jest.fn().mockImplementation((data: any) => ({
        ...data,
        id: data.id || "new-hold",
      })),
      findOne: jest.fn().mockResolvedValue(null),
    };

    mockQueryRunner = {
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      query: jest.fn().mockResolvedValue([]),
      manager: {
        find: jest.fn().mockResolvedValue([]),
        remove: jest.fn().mockResolvedValue(undefined),
        getRepository: jest.fn().mockReturnValue(mockQrRepo),
      },
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
        {
          provide: DataSource,
          useValue: {
            createQueryRunner: jest.fn().mockReturnValue(mockQueryRunner),
          },
        },
      ],
    }).compile();

    service = module.get<HoldingsService>(HoldingsService);
  });

  describe("findAll", () => {
    it("returns all holdings for a user", async () => {
      const qb = createMockQueryBuilder([mockHolding, mockHolding2]);
      holdingsRepository.createQueryBuilder.mockReturnValue(qb);

      const result = await service.findAll(
        "11111111-1111-1111-1111-111111111111",
      );

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
        userId: "11111111-1111-1111-1111-111111111111",
      });
      expect(qb.getMany).toHaveBeenCalled();
      expect(result).toHaveLength(2);
    });

    it("filters by accountId when provided", async () => {
      const qb = createMockQueryBuilder([mockHolding]);
      holdingsRepository.createQueryBuilder.mockReturnValue(qb);

      const result = await service.findAll(
        "11111111-1111-1111-1111-111111111111",
        "acc-1",
      );

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

      await service.findAll("11111111-1111-1111-1111-111111111111");

      expect(qb.andWhere).not.toHaveBeenCalled();
    });

    it("returns empty array when no holdings exist", async () => {
      const qb = createMockQueryBuilder([]);
      holdingsRepository.createQueryBuilder.mockReturnValue(qb);

      const result = await service.findAll(
        "11111111-1111-1111-1111-111111111111",
      );

      expect(result).toHaveLength(0);
    });
  });

  describe("findOne", () => {
    it("returns holding when found", async () => {
      const qb = createMockQueryBuilder(mockHolding);
      holdingsRepository.createQueryBuilder.mockReturnValue(qb);

      const result = await service.findOne(
        "11111111-1111-1111-1111-111111111111",
        "hold-1",
      );

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
        userId: "11111111-1111-1111-1111-111111111111",
      });
      expect(result).toEqual(mockHolding);
    });

    it("throws NotFoundException when holding not found", async () => {
      const qb = createMockQueryBuilder(null);
      holdingsRepository.createQueryBuilder.mockReturnValue(qb);

      await expect(
        service.findOne("11111111-1111-1111-1111-111111111111", "nonexistent"),
      ).rejects.toThrow(NotFoundException);
    });

    it("throws NotFoundException with descriptive message", async () => {
      const qb = createMockQueryBuilder(null);
      holdingsRepository.createQueryBuilder.mockReturnValue(qb);

      await expect(
        service.findOne("11111111-1111-1111-1111-111111111111", "hold-999"),
      ).rejects.toThrow("Holding with ID hold-999 not found");
    });
  });

  describe("getHoldingAt", () => {
    it("replays only transactions strictly earlier than asOfDate", async () => {
      investmentTransactionsRepository.find.mockResolvedValue([
        {
          id: "tx-1",
          action: InvestmentAction.BUY,
          quantity: 100,
          price: 10,
          transactionDate: "2025-01-15",
          createdAt: new Date("2025-01-15"),
        },
        {
          id: "tx-2",
          action: InvestmentAction.BUY,
          quantity: 50,
          price: 20,
          transactionDate: "2025-03-01", // on/after asOfDate, must be skipped
          createdAt: new Date("2025-03-01"),
        },
      ]);

      const result = await service.getHoldingAt(
        "11111111-1111-1111-1111-111111111111",
        "acc-1",
        "sec-1",
        "2025-03-01",
      );

      // Only the Jan BUY counts: 100 @ $10
      expect(result.quantity).toBe(100);
      expect(result.averageCost).toBe(10);
    });

    it("excludes the supplied transaction id (used by SPLIT edit preview)", async () => {
      investmentTransactionsRepository.find.mockResolvedValue([
        {
          id: "tx-buy",
          action: InvestmentAction.BUY,
          quantity: 1100,
          price: 10,
          transactionDate: "2022-01-01",
          createdAt: new Date("2022-01-01"),
        },
        {
          id: "tx-split-target",
          action: InvestmentAction.SPLIT,
          quantity: 0.5,
          price: 0,
          transactionDate: "2022-07-01",
          createdAt: new Date("2022-07-01"),
        },
      ]);

      // Asking for state as-of the split's own date, excluding the split
      // itself: should reflect the BUY only.
      const result = await service.getHoldingAt(
        "11111111-1111-1111-1111-111111111111",
        "acc-1",
        "sec-1",
        "2022-07-01",
        "tx-split-target",
      );

      expect(result.quantity).toBe(1100);
      expect(result.averageCost).toBe(10);
    });

    it("composes BUY + SPLIT correctly when SPLIT is before asOfDate", async () => {
      investmentTransactionsRepository.find.mockResolvedValue([
        {
          id: "tx-buy",
          action: InvestmentAction.BUY,
          quantity: 1100,
          price: 10,
          transactionDate: "2022-01-01",
          createdAt: new Date("2022-01-01"),
        },
        {
          id: "tx-split",
          action: InvestmentAction.SPLIT,
          quantity: 0.5,
          price: 0,
          transactionDate: "2022-07-01",
          createdAt: new Date("2022-07-01"),
        },
      ]);

      // Asking for state as-of a later date, including the split: 1100*0.5
      const result = await service.getHoldingAt(
        "11111111-1111-1111-1111-111111111111",
        "acc-1",
        "sec-1",
        "2022-12-01",
      );

      expect(result.quantity).toBe(550);
      expect(result.averageCost).toBe(20); // total cost preserved
    });

    it("returns zero quantity / zero cost when there are no prior transactions", async () => {
      investmentTransactionsRepository.find.mockResolvedValue([]);

      const result = await service.getHoldingAt(
        "11111111-1111-1111-1111-111111111111",
        "acc-1",
        "sec-1",
        "2025-01-01",
      );

      expect(result.quantity).toBe(0);
      expect(result.averageCost).toBe(0);
    });

    it("ignores DIVIDEND/INTEREST/CAPITAL_GAIN", async () => {
      investmentTransactionsRepository.find.mockResolvedValue([
        {
          id: "tx-buy",
          action: InvestmentAction.BUY,
          quantity: 10,
          price: 100,
          transactionDate: "2025-01-01",
          createdAt: new Date("2025-01-01"),
        },
        {
          id: "tx-div",
          action: InvestmentAction.DIVIDEND,
          quantity: 1,
          price: 5,
          transactionDate: "2025-02-01",
          createdAt: new Date("2025-02-01"),
        },
      ]);

      const result = await service.getHoldingAt(
        "11111111-1111-1111-1111-111111111111",
        "acc-1",
        "sec-1",
        "2025-03-01",
      );

      expect(result.quantity).toBe(10);
      expect(result.averageCost).toBe(100);
    });

    it("requires the user to own the account", async () => {
      accountsService.findOne.mockRejectedValue(
        new NotFoundException("Account not found"),
      );

      await expect(
        service.getHoldingAt(
          "11111111-1111-1111-1111-111111111111",
          "other-acc",
          "sec-1",
          "2025-01-01",
        ),
      ).rejects.toThrow(NotFoundException);
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
        "11111111-1111-1111-1111-111111111111",
        "acc-1",
        "sec-1",
        10,
        150,
      );

      expect(accountsService.findOne).toHaveBeenCalledWith(
        "11111111-1111-1111-1111-111111111111",
        "acc-1",
      );
      expect(securitiesService.findOne).toHaveBeenCalledWith(
        "11111111-1111-1111-1111-111111111111",
        "sec-1",
      );
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
        "11111111-1111-1111-1111-111111111111",
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
        "11111111-1111-1111-1111-111111111111",
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
        service.createOrUpdate(
          "11111111-1111-1111-1111-111111111111",
          "acc-999",
          "sec-1",
          10,
          150,
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it("propagates error when security ownership check fails", async () => {
      securitiesService.findOne.mockRejectedValue(
        new NotFoundException("Security not found"),
      );

      await expect(
        service.createOrUpdate(
          "11111111-1111-1111-1111-111111111111",
          "acc-1",
          "sec-999",
          10,
          150,
        ),
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
        "11111111-1111-1111-1111-111111111111",
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
        "11111111-1111-1111-1111-111111111111",
        "acc-1",
        "sec-1",
        -100,
        200,
      );

      expect(result.quantity).toBe(0);
      // Average cost remains unchanged when selling
      expect(result.averageCost).toBe(150);
    });

    it("snaps near-zero quantity to exactly zero after selling all shares", async () => {
      // Simulate floating-point drift: 100.00005 - 100 = 0.00005 (below 0.0001 threshold)
      const existingHolding = {
        id: "hold-1",
        accountId: "acc-1",
        securityId: "sec-1",
        quantity: 100.00005,
        averageCost: 150,
      };
      holdingsRepository.findOne.mockResolvedValue(existingHolding);
      holdingsRepository.save.mockImplementation((data) =>
        Promise.resolve(data),
      );

      const result = await service.createOrUpdate(
        "11111111-1111-1111-1111-111111111111",
        "acc-1",
        "sec-1",
        -100,
        150,
      );

      // The tiny residual (0.00005) should be snapped to exactly 0
      expect(result.quantity).toBe(0);
    });

    it("rejects when selling more than held by default", async () => {
      const existingHolding = {
        id: "hold-1",
        accountId: "acc-1",
        securityId: "sec-1",
        quantity: 0,
        averageCost: 150,
      };
      holdingsRepository.findOne.mockResolvedValue(existingHolding);

      await expect(
        service.createOrUpdate(
          "11111111-1111-1111-1111-111111111111",
          "acc-1",
          "sec-1",
          -100,
          150,
        ),
      ).rejects.toThrow(/Insufficient shares/);
    });

    it("allows negative intermediate state when allowNegative=true", async () => {
      const existingHolding = {
        id: "hold-1",
        accountId: "acc-1",
        securityId: "sec-1",
        quantity: 0,
        averageCost: 150,
      };
      holdingsRepository.findOne.mockResolvedValue(existingHolding);
      holdingsRepository.save.mockImplementation((data) =>
        Promise.resolve(data),
      );

      const result = await service.createOrUpdate(
        "11111111-1111-1111-1111-111111111111",
        "acc-1",
        "sec-1",
        -100,
        150,
        undefined,
        true,
      );

      expect(result.quantity).toBe(-100);
    });

    it("does not update averageCost while running quantity stays non-positive", async () => {
      // Reverse of a past BUY can leave quantity at -100 with the original
      // avg cost of 50. Applying a new BUY(150 @ 60) bringing quantity to 50
      // should inherit the new trade's price as the avg cost rather than
      // producing a distorted blended value.
      const existingHolding = {
        id: "hold-1",
        accountId: "acc-1",
        securityId: "sec-1",
        quantity: -100,
        averageCost: 50,
      };
      holdingsRepository.findOne.mockResolvedValue(existingHolding);
      holdingsRepository.save.mockImplementation((data) =>
        Promise.resolve(data),
      );

      const result = await service.createOrUpdate(
        "11111111-1111-1111-1111-111111111111",
        "acc-1",
        "sec-1",
        150,
        60,
        undefined,
        true,
      );

      expect(result.quantity).toBe(50);
      expect(result.averageCost).toBe(60);
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
        "11111111-1111-1111-1111-111111111111",
        "acc-1",
        "sec-1",
        10,
        100,
      );

      expect(accountsService.findOne).toHaveBeenCalledWith(
        "11111111-1111-1111-1111-111111111111",
        "acc-1",
      );
      expect(securitiesService.findOne).toHaveBeenCalledWith(
        "11111111-1111-1111-1111-111111111111",
        "sec-1",
      );
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

      await service.adjustQuantity(
        "11111111-1111-1111-1111-111111111111",
        "acc-1",
        "sec-1",
        25,
      );

      expect(accountsService.findOne).toHaveBeenCalledWith(
        "11111111-1111-1111-1111-111111111111",
        "acc-1",
      );
      expect(securitiesService.findOne).toHaveBeenCalledWith(
        "11111111-1111-1111-1111-111111111111",
        "sec-1",
      );
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
        service.adjustQuantity(
          "11111111-1111-1111-1111-111111111111",
          "acc-1",
          "sec-1",
          -10,
        ),
      ).rejects.toThrow(NotFoundException);

      await expect(
        service.adjustQuantity(
          "11111111-1111-1111-1111-111111111111",
          "acc-1",
          "sec-1",
          -10,
        ),
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
        "11111111-1111-1111-1111-111111111111",
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
        "11111111-1111-1111-1111-111111111111",
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
        service.adjustQuantity(
          "11111111-1111-1111-1111-111111111111",
          "acc-999",
          "sec-1",
          10,
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it("propagates error when security ownership check fails", async () => {
      securitiesService.findOne.mockRejectedValue(
        new NotFoundException("Security not found"),
      );

      await expect(
        service.adjustQuantity(
          "11111111-1111-1111-1111-111111111111",
          "acc-1",
          "sec-999",
          10,
        ),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("applySplit", () => {
    it("doubles quantity and halves averageCost on a 2-for-1 split", async () => {
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

      const result = await service.applySplit("acc-1", "sec-1", 2);

      expect(result?.quantity).toBe(200);
      expect(result?.averageCost).toBe(75);
    });

    it("halves quantity and doubles averageCost on a 1-for-2 reverse split", async () => {
      const existingHolding = {
        id: "hold-1",
        accountId: "acc-1",
        securityId: "sec-1",
        quantity: 100,
        averageCost: 50,
      };
      holdingsRepository.findOne.mockResolvedValue(existingHolding);
      holdingsRepository.save.mockImplementation((data) =>
        Promise.resolve(data),
      );

      const result = await service.applySplit("acc-1", "sec-1", 0.5);

      expect(result?.quantity).toBe(50);
      expect(result?.averageCost).toBe(100);
    });

    it("preserves total cost basis across the split", async () => {
      const existingHolding = {
        id: "hold-1",
        accountId: "acc-1",
        securityId: "sec-1",
        quantity: 75,
        averageCost: 80,
      };
      holdingsRepository.findOne.mockResolvedValue(existingHolding);
      holdingsRepository.save.mockImplementation((data) =>
        Promise.resolve(data),
      );

      const before =
        Number(existingHolding.quantity) * Number(existingHolding.averageCost);
      const result = await service.applySplit("acc-1", "sec-1", 1.5);
      const after = Number(result!.quantity) * Number(result!.averageCost);

      expect(after).toBeCloseTo(before, 6);
    });

    it("returns null without saving when no holding exists", async () => {
      holdingsRepository.findOne.mockResolvedValue(null);

      const result = await service.applySplit("acc-1", "sec-1", 2);

      expect(result).toBeNull();
      expect(holdingsRepository.save).not.toHaveBeenCalled();
    });

    it("rejects ratios that are zero or negative", async () => {
      await expect(service.applySplit("acc-1", "sec-1", 0)).rejects.toThrow(
        "Split ratio must be greater than zero",
      );
      await expect(service.applySplit("acc-1", "sec-1", -1)).rejects.toThrow(
        "Split ratio must be greater than zero",
      );
    });
  });

  describe("reverseSplit", () => {
    it("undoes a 2-for-1 split (halves quantity, doubles averageCost)", async () => {
      const existingHolding = {
        id: "hold-1",
        accountId: "acc-1",
        securityId: "sec-1",
        quantity: 200,
        averageCost: 75,
      };
      holdingsRepository.findOne.mockResolvedValue(existingHolding);
      holdingsRepository.save.mockImplementation((data) =>
        Promise.resolve(data),
      );

      const result = await service.reverseSplit("acc-1", "sec-1", 2);

      expect(result?.quantity).toBe(100);
      expect(result?.averageCost).toBe(150);
    });

    it("rejects ratios that are zero or negative", async () => {
      await expect(service.reverseSplit("acc-1", "sec-1", 0)).rejects.toThrow(
        "Split ratio must be greater than zero",
      );
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

      const result = await service.getHoldingsSummary(
        "11111111-1111-1111-1111-111111111111",
        "acc-1",
      );

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

      const result = await service.getHoldingsSummary(
        "11111111-1111-1111-1111-111111111111",
        "acc-1",
      );

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

      const result = await service.getHoldingsSummary(
        "11111111-1111-1111-1111-111111111111",
        "acc-1",
      );

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

      await service.remove("11111111-1111-1111-1111-111111111111", "hold-1");

      expect(holdingsRepository.remove).toHaveBeenCalledWith(zeroHolding);
    });

    it("throws ForbiddenException when holding has non-zero quantity", async () => {
      const nonZeroHolding = { ...mockHolding, quantity: 50 };
      const qb = createMockQueryBuilder(nonZeroHolding);
      holdingsRepository.createQueryBuilder.mockReturnValue(qb);

      await expect(
        service.remove("11111111-1111-1111-1111-111111111111", "hold-1"),
      ).rejects.toThrow(ForbiddenException);
    });

    it("throws ForbiddenException with descriptive message for non-zero quantity", async () => {
      const nonZeroHolding = { ...mockHolding, quantity: 10 };
      const qb = createMockQueryBuilder(nonZeroHolding);
      holdingsRepository.createQueryBuilder.mockReturnValue(qb);

      await expect(
        service.remove("11111111-1111-1111-1111-111111111111", "hold-1"),
      ).rejects.toThrow("Cannot delete holding with non-zero quantity");
    });

    it("throws NotFoundException when holding does not exist", async () => {
      const qb = createMockQueryBuilder(null);
      holdingsRepository.createQueryBuilder.mockReturnValue(qb);

      await expect(
        service.remove("11111111-1111-1111-1111-111111111111", "nonexistent"),
      ).rejects.toThrow(NotFoundException);
    });

    it("handles string quantity '0' correctly (decimal from DB)", async () => {
      // Decimals from the database often come as strings
      const zeroHolding = { ...mockHolding, quantity: "0.00000000" };
      const qb = createMockQueryBuilder(zeroHolding);
      holdingsRepository.createQueryBuilder.mockReturnValue(qb);

      await service.remove("11111111-1111-1111-1111-111111111111", "hold-1");

      expect(holdingsRepository.remove).toHaveBeenCalledWith(zeroHolding);
    });
  });

  describe("rebuildFromTransactions", () => {
    it("returns zeros when user has no brokerage accounts", async () => {
      accountsRepository.find.mockResolvedValue([]);

      const result = await service.rebuildFromTransactions(
        "11111111-1111-1111-1111-111111111111",
      );

      expect(result).toEqual({
        holdingsCreated: 0,
        holdingsUpdated: 0,
        holdingsDeleted: 0,
      });
    });

    it("deletes existing holdings and rebuilds from buy transactions", async () => {
      accountsRepository.find.mockResolvedValue([mockAccount]);
      const existingHoldings = [{ id: "old-hold-1" }, { id: "old-hold-2" }];
      mockQueryRunner.manager.find.mockResolvedValue(existingHoldings);

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

      const result = await service.rebuildFromTransactions(
        "11111111-1111-1111-1111-111111111111",
      );

      expect(mockQueryRunner.manager.remove).toHaveBeenCalledWith(
        existingHoldings,
      );
      expect(mockQrRepo.create).toHaveBeenCalledWith(
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

      const result = await service.rebuildFromTransactions(
        "11111111-1111-1111-1111-111111111111",
      );

      // After buy: qty=100, totalCost=15000
      // After sell 40: avgCost=150, sell cost=40*150=6000, remaining totalCost=9000, qty=60
      // Final avgCost: 9000/60 = 150
      expect(mockQrRepo.create).toHaveBeenCalledWith(
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

      const result = await service.rebuildFromTransactions(
        "11111111-1111-1111-1111-111111111111",
      );

      // REINVEST: qty=10, totalCost=500
      // TRANSFER_IN: qty=30, totalCost=500+1200=1700
      // avgCost: 1700/30 = 56.666...
      expect(mockQrRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          quantity: 30,
        }),
      );
      expect(result.holdingsCreated).toBe(1);
    });

    it("handles TRANSFER_OUT and REMOVE_SHARES as negative quantity changes", async () => {
      accountsRepository.find.mockResolvedValue([mockAccount]);

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

      const result = await service.rebuildFromTransactions(
        "11111111-1111-1111-1111-111111111111",
      );

      // BUY: qty=100, totalCost=10000
      // TRANSFER_OUT (sell-like): qty=80, avgCost=100, totalCost=8000
      // REMOVE_SHARES (quantity only): qty=70, totalCost=8000
      expect(mockQrRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          quantity: 70,
        }),
      );
      expect(result.holdingsCreated).toBe(1);
    });

    it("rebuilds correctly when a SPLIT is between buys (preserves cost basis)", async () => {
      accountsRepository.find.mockResolvedValue([mockAccount]);

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
          action: InvestmentAction.SPLIT,
          quantity: 2, // 2-for-1
          price: 0,
          transactionDate: "2025-02-01",
          createdAt: new Date("2025-02-01"),
        },
      ];
      investmentTransactionsRepository.find.mockResolvedValue(transactions);

      await service.rebuildFromTransactions(
        "11111111-1111-1111-1111-111111111111",
      );

      // BUY: qty=100, totalCost=10000
      // SPLIT 2:1: qty doubles to 200, totalCost stays 10000 -> avg = 50
      expect(mockQrRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          quantity: 200,
          averageCost: 50,
        }),
      );
    });

    // User-reported scenario: 1100 shares, two consecutive 1-for-2 reverse
    // splits (stored as ratio 0.5 each), then a sell of 275 shares. The
    // rebuild should land on exactly zero remaining shares.
    it("handles two 1-for-2 reverse splits followed by a full sell (no residue)", async () => {
      accountsRepository.find.mockResolvedValue([mockAccount]);

      const transactions = [
        {
          accountId: "acc-1",
          securityId: "sec-1",
          action: InvestmentAction.BUY,
          quantity: 1100,
          price: 10,
          transactionDate: "2022-01-01",
          createdAt: new Date("2022-01-01"),
        },
        {
          accountId: "acc-1",
          securityId: "sec-1",
          action: InvestmentAction.SPLIT,
          quantity: 0.5, // 2-to-1 reverse: 1100 -> 550
          price: 0,
          transactionDate: "2022-07-01",
          createdAt: new Date("2022-07-01"),
        },
        {
          accountId: "acc-1",
          securityId: "sec-1",
          action: InvestmentAction.SPLIT,
          quantity: 0.5, // 2-to-1 reverse: 550 -> 275
          price: 0,
          transactionDate: "2022-11-01",
          createdAt: new Date("2022-11-01"),
        },
        {
          accountId: "acc-1",
          securityId: "sec-1",
          action: InvestmentAction.SELL,
          quantity: 275,
          price: 40,
          transactionDate: "2022-12-01",
          createdAt: new Date("2022-12-01"),
        },
      ];
      investmentTransactionsRepository.find.mockResolvedValue(transactions);

      const result = await service.rebuildFromTransactions(
        "11111111-1111-1111-1111-111111111111",
      );

      // 1100 shares -> *0.5 = 550 -> *0.5 = 275 -> -275 = 0.
      // No holding should be emitted (zero quantity is filtered out).
      expect(result.holdingsCreated).toBe(0);
      const holdingCreates = mockQrRepo.create.mock.calls.map(
        (call: any) => call[0],
      );
      expect(holdingCreates).toEqual([]);
    });

    it("handles ADD_SHARES as quantity-only change (no cost basis change)", async () => {
      accountsRepository.find.mockResolvedValue([mockAccount]);

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

      const result = await service.rebuildFromTransactions(
        "11111111-1111-1111-1111-111111111111",
      );

      // BUY: qty=100, totalCost=10000
      // ADD_SHARES (quantity only): qty=105, totalCost=10000
      // avgCost = 10000/105 = 95.238...
      expect(mockQrRepo.create).toHaveBeenCalledWith(
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

      const result = await service.rebuildFromTransactions(
        "11111111-1111-1111-1111-111111111111",
      );

      expect(mockQrRepo.create).not.toHaveBeenCalled();
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

      const result = await service.rebuildFromTransactions(
        "11111111-1111-1111-1111-111111111111",
      );

      expect(mockQrRepo.create).not.toHaveBeenCalled();
      expect(result.holdingsCreated).toBe(0);
    });

    it("snaps near-zero quantities to zero during rebuild", async () => {
      accountsRepository.find.mockResolvedValue([mockAccount]);
      holdingsRepository.find.mockResolvedValue([]);

      // Buy 0.1 + 0.2 shares then sell 0.3; classic floating-point drift
      // leaves a tiny residual (~4e-17) that should be snapped to zero
      const transactions = [
        {
          accountId: "acc-1",
          securityId: "sec-1",
          action: InvestmentAction.BUY,
          quantity: 0.1,
          price: 100,
          transactionDate: "2025-01-01",
          createdAt: new Date("2025-01-01"),
        },
        {
          accountId: "acc-1",
          securityId: "sec-1",
          action: InvestmentAction.BUY,
          quantity: 0.2,
          price: 100,
          transactionDate: "2025-01-02",
          createdAt: new Date("2025-01-02"),
        },
        {
          accountId: "acc-1",
          securityId: "sec-1",
          action: InvestmentAction.SELL,
          quantity: 0.3,
          price: 150,
          transactionDate: "2025-02-01",
          createdAt: new Date("2025-02-01"),
        },
      ];
      investmentTransactionsRepository.find.mockResolvedValue(transactions);

      const result = await service.rebuildFromTransactions(
        "11111111-1111-1111-1111-111111111111",
      );

      // Near-zero residual should be snapped to zero; no holding created
      expect(mockQrRepo.create).not.toHaveBeenCalled();
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

      const result = await service.rebuildFromTransactions(
        "11111111-1111-1111-1111-111111111111",
      );

      expect(mockQrRepo.create).not.toHaveBeenCalled();
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
      mockQrRepo.create.mockImplementation((data: any) => data);
      mockQrRepo.save.mockImplementation((data: any) => Promise.resolve(data));

      const result = await service.rebuildFromTransactions(
        "11111111-1111-1111-1111-111111111111",
      );

      expect(result.holdingsCreated).toBe(3);
      expect(mockQrRepo.create).toHaveBeenCalledTimes(3);
    });

    it("queries only investment accounts", async () => {
      accountsRepository.find.mockResolvedValue([]);

      await service.rebuildFromTransactions(
        "11111111-1111-1111-1111-111111111111",
      );

      expect(accountsRepository.find).toHaveBeenCalledWith({
        where: {
          userId: "11111111-1111-1111-1111-111111111111",
          accountType: AccountType.INVESTMENT,
        },
      });
    });

    it("does not call remove when no existing holdings", async () => {
      accountsRepository.find.mockResolvedValue([mockAccount]);
      holdingsRepository.find.mockResolvedValue([]);
      investmentTransactionsRepository.find.mockResolvedValue([]);

      const result = await service.rebuildFromTransactions(
        "11111111-1111-1111-1111-111111111111",
      );

      expect(mockQueryRunner.manager.remove).not.toHaveBeenCalled();
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

      const result = await service.rebuildFromTransactions(
        "11111111-1111-1111-1111-111111111111",
      );

      // quantity=0, price=0 results in near-zero quantity, not created
      expect(mockQrRepo.create).not.toHaveBeenCalled();
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
      mockQrRepo.create.mockImplementation((data: any) => data);
      mockQrRepo.save.mockImplementation((data: any) => Promise.resolve(data));

      const result = await service.rebuildFromTransactions(
        "11111111-1111-1111-1111-111111111111",
      );

      // BUY 10 at 100: qty=10, totalCost=1000
      // REMOVE_SHARES 20 (qty only): qty=-10, totalCost=1000
      // quantity=-10, avgCost = quantity > 0 ? totalCost/quantity : 0 = 0
      expect(mockQrRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          quantity: -10,
          averageCost: 0,
        }),
      );
      expect(result.holdingsCreated).toBe(1);
    });
  });

  describe("validateNoNegativeHoldingsHistory", () => {
    it("returns silently when user has no brokerage accounts", async () => {
      accountsRepository.find.mockResolvedValue([]);

      await expect(
        service.validateNoNegativeHoldingsHistory(
          "11111111-1111-1111-1111-111111111111",
        ),
      ).resolves.toBeUndefined();
      expect(investmentTransactionsRepository.find).not.toHaveBeenCalled();
    });

    it("allows a buy-then-sell sequence that ends at zero", async () => {
      accountsRepository.find.mockResolvedValue([mockAccount]);
      investmentTransactionsRepository.find.mockResolvedValue([
        {
          accountId: "acc-1",
          securityId: "sec-1",
          action: InvestmentAction.BUY,
          quantity: 100,
          transactionDate: "2024-01-01",
          security: { symbol: "AAPL" },
        },
        {
          accountId: "acc-1",
          securityId: "sec-1",
          action: InvestmentAction.SELL,
          quantity: 100,
          transactionDate: "2024-06-01",
          security: { symbol: "AAPL" },
        },
      ]);

      await expect(
        service.validateNoNegativeHoldingsHistory(
          "11111111-1111-1111-1111-111111111111",
        ),
      ).resolves.toBeUndefined();
    });

    it("throws when a SELL at some date would drop holdings below zero", async () => {
      accountsRepository.find.mockResolvedValue([mockAccount]);
      investmentTransactionsRepository.find.mockResolvedValue([
        {
          accountId: "acc-1",
          securityId: "sec-1",
          action: InvestmentAction.BUY,
          quantity: 50,
          transactionDate: "2024-01-01",
          security: { symbol: "AAPL" },
        },
        {
          accountId: "acc-1",
          securityId: "sec-1",
          action: InvestmentAction.SELL,
          quantity: 100,
          transactionDate: "2024-06-01",
          security: { symbol: "AAPL" },
        },
      ]);

      await expect(
        service.validateNoNegativeHoldingsHistory(
          "11111111-1111-1111-1111-111111111111",
        ),
      ).rejects.toThrow(/negative/i);
    });

    it("does not count a later BUY to cover an earlier oversold SELL", async () => {
      // Transactions are ordered by date, so an oversell on 2024-06-01 must
      // throw even though a subsequent BUY on 2024-09-01 would restore the
      // final balance.
      accountsRepository.find.mockResolvedValue([mockAccount]);
      investmentTransactionsRepository.find.mockResolvedValue([
        {
          accountId: "acc-1",
          securityId: "sec-1",
          action: InvestmentAction.BUY,
          quantity: 10,
          transactionDate: "2024-01-01",
          security: { symbol: "AAPL" },
        },
        {
          accountId: "acc-1",
          securityId: "sec-1",
          action: InvestmentAction.SELL,
          quantity: 50,
          transactionDate: "2024-06-01",
          security: { symbol: "AAPL" },
        },
        {
          accountId: "acc-1",
          securityId: "sec-1",
          action: InvestmentAction.BUY,
          quantity: 100,
          transactionDate: "2024-09-01",
          security: { symbol: "AAPL" },
        },
      ]);

      await expect(
        service.validateNoNegativeHoldingsHistory(
          "11111111-1111-1111-1111-111111111111",
        ),
      ).rejects.toThrow(/AAPL/);
    });

    it("tracks different securities independently", async () => {
      accountsRepository.find.mockResolvedValue([mockAccount]);
      investmentTransactionsRepository.find.mockResolvedValue([
        {
          accountId: "acc-1",
          securityId: "sec-1",
          action: InvestmentAction.BUY,
          quantity: 100,
          transactionDate: "2024-01-01",
          security: { symbol: "AAPL" },
        },
        {
          accountId: "acc-1",
          securityId: "sec-2",
          action: InvestmentAction.SELL,
          quantity: 10,
          transactionDate: "2024-02-01",
          security: { symbol: "MSFT" },
        },
      ]);

      await expect(
        service.validateNoNegativeHoldingsHistory(
          "11111111-1111-1111-1111-111111111111",
        ),
      ).rejects.toThrow(/MSFT/);
    });

    it("applies SPLIT as a multiplier on running quantity", async () => {
      accountsRepository.find.mockResolvedValue([mockAccount]);
      investmentTransactionsRepository.find.mockResolvedValue([
        {
          accountId: "acc-1",
          securityId: "sec-1",
          action: InvestmentAction.BUY,
          quantity: 10,
          transactionDate: "2024-01-01",
          security: { symbol: "AAPL" },
        },
        {
          accountId: "acc-1",
          securityId: "sec-1",
          action: InvestmentAction.SPLIT,
          quantity: 4,
          transactionDate: "2024-02-01",
          security: { symbol: "AAPL" },
        },
        {
          accountId: "acc-1",
          securityId: "sec-1",
          action: InvestmentAction.SELL,
          quantity: 30,
          transactionDate: "2024-03-01",
          security: { symbol: "AAPL" },
        },
      ]);

      // After BUY 10 + 4-for-1 SPLIT = 40 shares, SELL 30 leaves 10. Valid.
      await expect(
        service.validateNoNegativeHoldingsHistory(
          "11111111-1111-1111-1111-111111111111",
        ),
      ).resolves.toBeUndefined();
    });

    it("limits validation to the supplied accountIds", async () => {
      // A pre-existing oversold state in an unrelated account should not
      // block an edit scoped to a specific account.
      accountsRepository.find.mockResolvedValue([mockAccount, mockAccount2]);
      investmentTransactionsRepository.find.mockResolvedValue([
        // Only the transactions for acc-1 are returned because we query
        // with accountId IN (...) filtered to the scoped list.
        {
          accountId: "acc-1",
          securityId: "sec-1",
          action: InvestmentAction.BUY,
          quantity: 10,
          transactionDate: "2024-01-01",
          security: { symbol: "AAPL" },
        },
      ]);

      await expect(
        service.validateNoNegativeHoldingsHistory(
          "11111111-1111-1111-1111-111111111111",
          undefined,
          ["acc-1"],
        ),
      ).resolves.toBeUndefined();

      // The scoped list must be passed through to the query, not the
      // broader account lookup.
      expect(accountsRepository.find).not.toHaveBeenCalled();
      expect(investmentTransactionsRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            userId: "11111111-1111-1111-1111-111111111111",
          }),
        }),
      );
    });

    it("ignores DIVIDEND/INTEREST/CAPITAL_GAIN transactions", async () => {
      accountsRepository.find.mockResolvedValue([mockAccount]);
      investmentTransactionsRepository.find.mockResolvedValue([
        {
          accountId: "acc-1",
          securityId: "sec-1",
          action: InvestmentAction.BUY,
          quantity: 10,
          transactionDate: "2024-01-01",
          security: { symbol: "AAPL" },
        },
        {
          accountId: "acc-1",
          securityId: "sec-1",
          action: InvestmentAction.DIVIDEND,
          quantity: 0,
          transactionDate: "2024-02-01",
          security: { symbol: "AAPL" },
        },
        {
          accountId: "acc-1",
          securityId: "sec-1",
          action: InvestmentAction.SELL,
          quantity: 10,
          transactionDate: "2024-03-01",
          security: { symbol: "AAPL" },
        },
      ]);

      await expect(
        service.validateNoNegativeHoldingsHistory(
          "11111111-1111-1111-1111-111111111111",
        ),
      ).resolves.toBeUndefined();
    });
  });

  describe("removeAllForUser", () => {
    it("returns 0 when user has no brokerage accounts", async () => {
      accountsRepository.find.mockResolvedValue([]);

      const result = await service.removeAllForUser(
        "11111111-1111-1111-1111-111111111111",
      );

      expect(result).toBe(0);
    });

    it("removes all holdings for brokerage accounts and returns count", async () => {
      accountsRepository.find.mockResolvedValue([mockAccount, mockAccount2]);
      const holdings = [{ id: "h1" }, { id: "h2" }, { id: "h3" }];
      holdingsRepository.find.mockResolvedValue(holdings);

      const result = await service.removeAllForUser(
        "11111111-1111-1111-1111-111111111111",
      );

      expect(holdingsRepository.remove).toHaveBeenCalledWith(holdings);
      expect(result).toBe(3);
    });

    it("returns 0 when brokerage accounts have no holdings", async () => {
      accountsRepository.find.mockResolvedValue([mockAccount]);
      holdingsRepository.find.mockResolvedValue([]);

      const result = await service.removeAllForUser(
        "11111111-1111-1111-1111-111111111111",
      );

      expect(holdingsRepository.remove).not.toHaveBeenCalled();
      expect(result).toBe(0);
    });

    it("queries only brokerage accounts", async () => {
      accountsRepository.find.mockResolvedValue([]);

      await service.removeAllForUser("11111111-1111-1111-1111-111111111111");

      expect(accountsRepository.find).toHaveBeenCalledWith({
        where: {
          userId: "11111111-1111-1111-1111-111111111111",
          accountType: AccountType.INVESTMENT,
          accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
        },
      });
    });

    it("uses In() to query holdings for all brokerage account IDs", async () => {
      accountsRepository.find.mockResolvedValue([mockAccount, mockAccount2]);
      holdingsRepository.find.mockResolvedValue([]);

      await service.removeAllForUser("11111111-1111-1111-1111-111111111111");

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

  describe("rebuildFromTransactions atomicity", () => {
    it("commits transaction on success and releases queryRunner", async () => {
      accountsRepository.find.mockResolvedValue([mockAccount]);
      investmentTransactionsRepository.find.mockResolvedValue([]);

      await service.rebuildFromTransactions(
        "11111111-1111-1111-1111-111111111111",
      );

      expect(mockQueryRunner.connect).toHaveBeenCalled();
      expect(mockQueryRunner.startTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.rollbackTransaction).not.toHaveBeenCalled();
      expect(mockQueryRunner.release).toHaveBeenCalled();
    });

    it("rolls back on error during delete and releases queryRunner", async () => {
      accountsRepository.find.mockResolvedValue([mockAccount]);
      investmentTransactionsRepository.find.mockResolvedValue([]);
      mockQueryRunner.manager.find.mockResolvedValue([{ id: "old-hold" }]);
      mockQueryRunner.manager.remove.mockRejectedValue(
        new Error("Delete failed"),
      );

      await expect(
        service.rebuildFromTransactions("11111111-1111-1111-1111-111111111111"),
      ).rejects.toThrow("Delete failed");

      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.commitTransaction).not.toHaveBeenCalled();
      expect(mockQueryRunner.release).toHaveBeenCalled();
    });

    it("rolls back on error during save and releases queryRunner", async () => {
      accountsRepository.find.mockResolvedValue([mockAccount]);
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
      ];
      investmentTransactionsRepository.find.mockResolvedValue(transactions);
      mockQrRepo.save.mockRejectedValue(new Error("Save failed"));

      await expect(
        service.rebuildFromTransactions("11111111-1111-1111-1111-111111111111"),
      ).rejects.toThrow("Save failed");

      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.commitTransaction).not.toHaveBeenCalled();
      expect(mockQueryRunner.release).toHaveBeenCalled();
    });
  });

  describe("applyMaturedInvestmentHoldings", () => {
    it("rebuilds holdings for users with an investment transaction maturing today", async () => {
      (service as any).dataSource.query = jest
        .fn()
        .mockResolvedValueOnce([
          {
            user_id: "11111111-1111-1111-1111-111111111111",
            timezone: "UTC",
            last_client_timezone: null,
          },
          {
            user_id: "22222222-2222-2222-2222-222222222222",
            timezone: "UTC",
            last_client_timezone: null,
          },
        ])
        .mockResolvedValueOnce([
          { user_id: "11111111-1111-1111-1111-111111111111" },
        ]);
      const rebuildSpy = jest
        .spyOn(service, "rebuildFromTransactions")
        .mockResolvedValue({
          holdingsCreated: 0,
          holdingsUpdated: 0,
          holdingsDeleted: 0,
        });

      await service.applyMaturedInvestmentHoldings();

      // Only the user with a maturing transaction is rebuilt, and the user's
      // timezone-correct today is passed as the cutoff so the just-matured
      // transaction is included.
      expect(rebuildSpy).toHaveBeenCalledTimes(1);
      expect(rebuildSpy).toHaveBeenCalledWith(
        "11111111-1111-1111-1111-111111111111",
        expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      );
    });

    it("does nothing when there are no users", async () => {
      (service as any).dataSource.query = jest.fn().mockResolvedValueOnce([]);
      const rebuildSpy = jest.spyOn(service, "rebuildFromTransactions");

      await service.applyMaturedInvestmentHoldings();

      expect(rebuildSpy).not.toHaveBeenCalled();
    });
  });
});
