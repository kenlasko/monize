import { NotFoundException, ForbiddenException } from "@nestjs/common";
import { HoldingsService } from "./holdings.service";
import { Holding } from "./entities/holding.entity";
import {
  InvestmentTransaction,
  InvestmentAction,
} from "./entities/investment-transaction.entity";
import { NON_VOID_INVESTMENT_STATUS } from "./investment-row-effects.util";
import { INVESTMENT_REPLAY_ORDER } from "./investment-replay.util";
import {
  Account,
  AccountType,
  AccountSubType,
} from "../accounts/entities/account.entity";
import {
  createScopedDbMocks,
  DataSourceMock,
} from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

describe("HoldingsService", () => {
  let service: HoldingsService;
  let holdingsRepository: Record<string, jest.Mock>;
  let investmentTransactionsRepository: Record<string, jest.Mock>;
  let accountsRepository: Record<string, jest.Mock>;
  let accountsService: Record<string, jest.Mock>;
  let securitiesService: Record<string, jest.Mock>;
  // Was the QueryRunner the rebuild opened; now the scoped transaction's
  // EntityManager. `mockQueryRunner.manager` is kept as an alias so the
  // existing direct-manager assertions read unchanged.
  let mockQueryRunner: { manager: Record<string, jest.Mock> };
  let dataSource: DataSourceMock;
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

  beforeEach(() => {
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

    // The rebuild paths get their Holding repository from the transaction's
    // EntityManager, which is the same mock every other path uses now.
    mockQrRepo = holdingsRepository as unknown as typeof mockQrRepo;
    holdingsRepository.findOne.mockResolvedValue(null);

    const mocks = createScopedDbMocks([
      [Holding, holdingsRepository],
      [InvestmentTransaction, investmentTransactionsRepository],
      [Account, accountsRepository],
    ]);
    dataSource = mocks.dataSource;
    const manager = mocks.manager;
    manager.find.mockResolvedValue([]);
    manager.remove.mockResolvedValue(undefined);
    manager.query.mockResolvedValue([]);
    mockQueryRunner = { manager };

    service = new HoldingsService(
      accountsService as never,
      securitiesService as never,
      dataSource as never,
    );
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

    it("multiplies by a split ratio rather than adding it", async () => {
      investmentTransactionsRepository.find.mockResolvedValue([
        {
          id: "tx-1",
          action: InvestmentAction.BUY,
          quantity: 10,
          price: 100,
          transactionDate: "2025-01-01",
          createdAt: new Date("2025-01-01"),
        },
        {
          id: "tx-2",
          action: InvestmentAction.SPLIT,
          quantity: 2,
          price: 0,
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

      // 10 shares * 2 = 20, not 10 + 2 = 12. Total basis is preserved, so the
      // per-share cost halves.
      expect(result.quantity).toBe(20);
      expect(result.averageCost).toBe(50);
    });

    it("counts ADD_SHARES and REMOVE_SHARES", async () => {
      investmentTransactionsRepository.find.mockResolvedValue([
        {
          id: "tx-1",
          action: InvestmentAction.ADD_SHARES,
          quantity: 30,
          price: 0,
          transactionDate: "2025-01-01",
          createdAt: new Date("2025-01-01"),
        },
        {
          id: "tx-2",
          action: InvestmentAction.REMOVE_SHARES,
          quantity: 5,
          price: 0,
          transactionDate: "2025-01-05",
          createdAt: new Date("2025-01-05"),
        },
      ]);

      const result = await service.getHoldingAt(
        "11111111-1111-1111-1111-111111111111",
        "acc-1",
        "sec-1",
        "2025-03-01",
      );

      expect(result.quantity).toBe(25);
      // No cost was supplied for shares booked without a purchase.
      expect(result.averageCost).toBe(0);
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

    it("takes a return of capital off the basis without moving shares (#1800)", async () => {
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
          id: "tx-roc",
          action: InvestmentAction.RETURN_OF_CAPITAL,
          quantity: null,
          price: null,
          totalAmount: 150,
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

      // 1,000 of basis less 150 returned, over the same 10 shares.
      expect(result.quantity).toBe(10);
      expect(result.averageCost).toBe(85);
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

  describe("rebuildScopesFromTransactions", () => {
    const USER = "11111111-1111-1111-1111-111111111111";

    /**
     * A `manager.find` that honours the `order` option, so the spec exercises
     * the ordering the service asks for rather than the order the fixture
     * happens to be written in. Without this the fixture's own array order
     * would silently stand in for the database's ORDER BY and the regression
     * below could not fail.
     */
    const stubLedger = (
      rows: Record<string, unknown>[],
      accounts: Record<string, unknown>[] = [mockAccount],
    ) => {
      mockQueryRunner.manager.find.mockImplementation(
        (entity: unknown, options: { order?: Record<string, string> }) => {
          if (entity === Account) return Promise.resolve(accounts);
          if (entity !== InvestmentTransaction) return Promise.resolve([]);
          const keys = Object.keys(options?.order ?? {});
          const sorted = [...rows].sort((a, b) => {
            for (const key of keys) {
              const left = String(a[key] ?? "");
              const right = String(b[key] ?? "");
              if (left !== right) return left < right ? -1 : 1;
            }
            return 0;
          });
          return Promise.resolve(sorted);
        },
      );
    };

    const sameInstant = new Date("2026-04-01T00:00:00.000Z");

    // The reproduction from issue #1388, written in INSERTION order: the SELL
    // was entered third but dated between the two purchases.
    const buyBuySellOutOfOrder = [
      {
        id: "tx-1",
        accountId: "acc-1",
        securityId: "sec-1",
        action: InvestmentAction.BUY,
        transactionDate: "2026-01-01",
        quantity: 100,
        price: 10,
        commission: 0,
        createdAt: new Date("2026-04-01T00:00:00.000Z"),
      },
      {
        id: "tx-2",
        accountId: "acc-1",
        securityId: "sec-1",
        action: InvestmentAction.BUY,
        transactionDate: "2026-03-01",
        quantity: 100,
        price: 20,
        commission: 0,
        createdAt: new Date("2026-04-01T00:00:01.000Z"),
      },
      {
        id: "tx-3",
        accountId: "acc-1",
        securityId: "sec-1",
        action: InvestmentAction.SELL,
        transactionDate: "2026-02-01",
        quantity: 50,
        price: 12,
        commission: 0,
        createdAt: new Date("2026-04-01T00:00:02.000Z"),
      },
    ];

    it("stores the average cost the ledger replay gives, not the one insertion order gives", async () => {
      // Replayed by date: buy 100 at 10 (basis 1,000), sell 50 relieving 500,
      // then buy 100 at 20 -- 150 shares, basis 2,500, 16.6667 a share.
      // Blended in insertion order the two buys average to 15.00 first and the
      // sale relieves 750, leaving 150 shares at 15.00: the stored figure the
      // issue reports, and what the holdings page showed until something
      // unrelated triggered a rebuild.
      stubLedger(buyBuySellOutOfOrder);
      holdingsRepository.find.mockResolvedValue([]);

      await service.rebuildScopesFromTransactions(
        USER,
        [{ accountId: "acc-1", securityId: "sec-1" }],
        mockQueryRunner.manager as never,
      );

      expect(holdingsRepository.save).toHaveBeenCalledTimes(1);
      const stored = holdingsRepository.save.mock.calls[0][0];
      expect(stored.quantity).toBeCloseTo(150, 8);
      expect(stored.averageCost).toBeCloseTo(2500 / 150, 6);
      expect(stored.averageCost).not.toBeCloseTo(15, 4);
    });

    /**
     * A26-M23 (A26-S12-06), INV-HOLDING-001/002: the fold snapped every
     * intermediate position under 0.0001 shares to zero, so ten daily buys of
     * 0.00009 BTC never formed a holding (each started from the snapped 0).
     * Only a residue at the stored scale (8 dp) is a ghost; both sides of the
     * old 0.0001 line are pinned.
     */
    const microBuys = (count: number, quantity: number) =>
      Array.from({ length: count }, (_, i) => ({
        id: `micro-${i}`,
        accountId: "acc-1",
        securityId: "sec-1",
        action: InvestmentAction.BUY,
        transactionDate: `2026-01-${String(10 + i).padStart(2, "0")}`,
        quantity,
        price: 60000,
        commission: 0,
        createdAt: sameInstant,
      }));

    it("keeps a position built from purchases under 0.0001 shares", async () => {
      stubLedger(microBuys(10, 0.00009));
      holdingsRepository.find.mockResolvedValue([]);

      await service.rebuildScopesFromTransactions(
        USER,
        [{ accountId: "acc-1", securityId: "sec-1" }],
        mockQueryRunner.manager as never,
      );

      expect(holdingsRepository.save).toHaveBeenCalledTimes(1);
      const stored = holdingsRepository.save.mock.calls[0][0];
      expect(stored.quantity).toBeCloseTo(0.0009, 8);
      expect(stored.averageCost).toBeCloseTo(60000, 6);
    });

    it.each([
      ["just under the old line", 0.00009999],
      ["exactly on it", 0.0001],
      ["just over it", 0.00010001],
    ])("stores a single purchase %s", async (_label, quantity) => {
      stubLedger(microBuys(1, quantity));
      holdingsRepository.find.mockResolvedValue([]);

      await service.rebuildScopesFromTransactions(
        USER,
        [{ accountId: "acc-1", securityId: "sec-1" }],
        mockQueryRunner.manager as never,
      );

      const stored = holdingsRepository.save.mock.calls[0][0];
      expect(stored.quantity).toBeCloseTo(quantity, 8);
    });

    it("still drops a residue at the stored scale", async () => {
      // BUY 1, SELL 0.999999995: 5e-9 left, below the 8-decimal column.
      const rows = [
        ...microBuys(1, 1),
        {
          ...microBuys(1, 0.999999995)[0],
          id: "sell",
          action: InvestmentAction.SELL,
          transactionDate: "2026-01-20",
        },
      ];
      stubLedger(rows);
      holdingsRepository.find.mockResolvedValue([]);

      await service.rebuildScopesFromTransactions(
        USER,
        [{ accountId: "acc-1", securityId: "sec-1" }],
        mockQueryRunner.manager as never,
      );

      expect(holdingsRepository.save).not.toHaveBeenCalled();
    });

    it("re-converges after the back-dated row is deleted", async () => {
      // The same position with the SELL gone: two purchases, 200 shares,
      // basis 3,000. A delta applied to the stored 16.6667 could not reach it.
      stubLedger(buyBuySellOutOfOrder.slice(0, 2));
      holdingsRepository.find.mockResolvedValue([
        { ...mockHolding, quantity: 150, averageCost: 2500 / 150 },
      ]);

      await service.rebuildScopesFromTransactions(
        USER,
        [{ accountId: "acc-1", securityId: "sec-1" }],
        mockQueryRunner.manager as never,
      );

      const stored = holdingsRepository.save.mock.calls[0][0];
      expect(stored.quantity).toBeCloseTo(200, 8);
      expect(stored.averageCost).toBeCloseTo(15, 8);
    });

    it("breaks a same-day, same-created_at tie on the primary key", async () => {
      // One import writes both rows in a single transaction, so they share
      // `created_at` to the microsecond and `transaction_date` cannot separate
      // them either. The id is what makes the replay a function of the ledger:
      // "a" buys before "b" sells, so the sale relieves basis that exists.
      stubLedger([
        {
          id: "b-sell",
          accountId: "acc-1",
          securityId: "sec-1",
          action: InvestmentAction.SELL,
          transactionDate: "2026-05-01",
          quantity: 40,
          price: 30,
          commission: 0,
          createdAt: sameInstant,
        },
        {
          id: "a-buy",
          accountId: "acc-1",
          securityId: "sec-1",
          action: InvestmentAction.BUY,
          transactionDate: "2026-05-01",
          quantity: 100,
          price: 10,
          commission: 0,
          createdAt: sameInstant,
        },
      ]);
      holdingsRepository.find.mockResolvedValue([]);

      await service.rebuildScopesFromTransactions(
        USER,
        [{ accountId: "acc-1", securityId: "sec-1" }],
        mockQueryRunner.manager as never,
      );

      const stored = holdingsRepository.save.mock.calls[0][0];
      expect(stored.quantity).toBeCloseTo(60, 8);
      // Basis relieved at the purchase's own average, so the survivors still
      // cost 10 each. Folded the other way round the sale would relieve
      // nothing (no shares held yet) and 60 shares would carry 1,000 of basis.
      expect(stored.averageCost).toBeCloseTo(10, 8);
    });

    it("reads the ledger in the shared replay order", async () => {
      stubLedger(buyBuySellOutOfOrder);
      holdingsRepository.find.mockResolvedValue([]);

      await service.rebuildScopesFromTransactions(
        USER,
        [{ accountId: "acc-1", securityId: "sec-1" }],
        mockQueryRunner.manager as never,
      );

      const call = mockQueryRunner.manager.find.mock.calls.find(
        ([entity]: unknown[]) => entity === InvestmentTransaction,
      );
      expect(call?.[1].order).toBe(INVESTMENT_REPLAY_ORDER);
    });

    it("deletes the holding when the ledger no longer accounts for any shares", async () => {
      stubLedger([]);
      holdingsRepository.find.mockResolvedValue([mockHolding]);

      await service.rebuildScopesFromTransactions(
        USER,
        [{ accountId: "acc-1", securityId: "sec-1" }],
        mockQueryRunner.manager as never,
      );

      expect(holdingsRepository.remove).toHaveBeenCalledWith(mockHolding);
      expect(holdingsRepository.save).not.toHaveBeenCalled();
    });

    it("leaves scopes nobody named alone", async () => {
      // The ledger read is an `In() x In()` cross product, so a row belonging
      // to a pair the caller did not name must not fold into the result, and
      // that pair's stored holding must not be rewritten.
      stubLedger([
        ...buyBuySellOutOfOrder,
        {
          id: "tx-other",
          accountId: "acc-1",
          securityId: "sec-2",
          action: InvestmentAction.BUY,
          transactionDate: "2026-01-01",
          quantity: 10,
          price: 5,
          commission: 0,
          createdAt: sameInstant,
        },
      ]);
      holdingsRepository.find.mockResolvedValue([mockHolding, mockHolding2]);

      await service.rebuildScopesFromTransactions(
        USER,
        [{ accountId: "acc-1", securityId: "sec-1" }],
        mockQueryRunner.manager as never,
      );

      expect(holdingsRepository.save).toHaveBeenCalledTimes(1);
      expect(holdingsRepository.save.mock.calls[0][0].securityId).toBe("sec-1");
      expect(holdingsRepository.remove).not.toHaveBeenCalled();
    });

    it("writes only the named pairs when two scopes span two accounts and two securities", async () => {
      // The cross product the `In() x In()` read returns is
      // {acc-1, acc-2} x {sec-1, sec-2}: four pairs for two that were asked
      // about. The ledger holds a real position in (acc-1, sec-2), which
      // nobody named, and without the `wanted` filter it folds into the map
      // and is written from a read that was never meant to cover it.
      stubLedger(
        [
          ...buyBuySellOutOfOrder,
          {
            id: "tx-b-s2",
            accountId: "acc-2",
            securityId: "sec-2",
            action: InvestmentAction.BUY,
            transactionDate: "2026-01-01",
            quantity: 10,
            price: 5,
            commission: 0,
            createdAt: sameInstant,
          },
          {
            id: "tx-a-s2",
            accountId: "acc-1",
            securityId: "sec-2",
            action: InvestmentAction.BUY,
            transactionDate: "2026-01-01",
            quantity: 7,
            price: 3,
            commission: 0,
            createdAt: sameInstant,
          },
        ],
        [mockAccount, mockAccount2],
      );
      holdingsRepository.find.mockResolvedValue([
        mockHolding,
        // The unnamed pair's stored row: it must survive untouched, neither
        // rewritten nor deleted.
        mockHolding2,
      ]);

      await service.rebuildScopesFromTransactions(
        USER,
        [
          { accountId: "acc-1", securityId: "sec-1" },
          { accountId: "acc-2", securityId: "sec-2" },
        ],
        mockQueryRunner.manager as never,
      );

      const written = holdingsRepository.save.mock.calls.map(
        ([row]: [{ accountId: string; securityId: string }]) =>
          `${row.accountId}:${row.securityId}`,
      );
      expect(new Set(written)).toEqual(new Set(["acc-1:sec-1", "acc-2:sec-2"]));
      expect(holdingsRepository.remove).not.toHaveBeenCalled();
    });

    it("does not touch a non-brokerage account's rows", async () => {
      stubLedger(buyBuySellOutOfOrder, [
        {
          ...mockAccount,
          accountSubType: AccountSubType.INVESTMENT_CASH,
        },
      ]);
      holdingsRepository.find.mockResolvedValue([mockHolding]);

      await service.rebuildScopesFromTransactions(
        USER,
        [{ accountId: "acc-1", securityId: "sec-1" }],
        mockQueryRunner.manager as never,
      );

      expect(holdingsRepository.save).not.toHaveBeenCalled();
      expect(holdingsRepository.remove).not.toHaveBeenCalled();
    });

    it("takes the holdings lock before reading the ledger", async () => {
      stubLedger(buyBuySellOutOfOrder);
      holdingsRepository.find.mockResolvedValue([]);
      const order: string[] = [];
      mockQueryRunner.manager.query.mockImplementation(() => {
        order.push("lock");
        return Promise.resolve([]);
      });
      const find = mockQueryRunner.manager.find.getMockImplementation()!;
      mockQueryRunner.manager.find.mockImplementation((...args: unknown[]) => {
        order.push("find");
        return (find as (...a: unknown[]) => unknown)(...args);
      });

      await service.rebuildScopesFromTransactions(
        USER,
        [{ accountId: "acc-1", securityId: "sec-1" }],
        mockQueryRunner.manager as never,
      );

      expect(order[0]).toBe("lock");
    });
  });

  /**
   * The repair path for holdings written before the ledger-projection rule
   * (INV-HOLDING-001): a read-only comparison a human acts on, never a write.
   */
  describe("findLedgerDiscrepancies", () => {
    const USER = "11111111-1111-1111-1111-111111111111";

    const buyBuySell = [
      {
        id: "tx-1",
        accountId: "acc-1",
        securityId: "sec-1",
        action: InvestmentAction.BUY,
        transactionDate: "2026-01-01",
        quantity: 100,
        price: 10,
        commission: 0,
        createdAt: new Date("2026-04-01T00:00:00.000Z"),
      },
      {
        id: "tx-2",
        accountId: "acc-1",
        securityId: "sec-1",
        action: InvestmentAction.BUY,
        transactionDate: "2026-03-01",
        quantity: 100,
        price: 20,
        commission: 0,
        createdAt: new Date("2026-04-01T00:00:01.000Z"),
      },
      {
        id: "tx-3",
        accountId: "acc-1",
        securityId: "sec-1",
        action: InvestmentAction.SELL,
        transactionDate: "2026-02-01",
        quantity: 50,
        price: 12,
        commission: 0,
        createdAt: new Date("2026-04-01T00:00:02.000Z"),
      },
    ];

    /**
     * The ledger read honours the `order` option, as the database does: the
     * whole point of the comparison is that the replay's order is not the
     * order the rows were entered in, so a stub that returned the fixture's
     * own order would make the mismatch vanish.
     */
    const stubReads = (
      stored: Record<string, unknown>[],
      ledger: Record<string, unknown>[],
    ) => {
      mockQueryRunner.manager.find.mockImplementation(
        (entity: unknown, options: { order?: Record<string, string> }) => {
          if (entity === Account) return Promise.resolve([mockAccount]);
          if (entity === Holding) return Promise.resolve(stored);
          if (entity !== InvestmentTransaction) return Promise.resolve([]);
          const keys = Object.keys(options?.order ?? {});
          const sorted = [...ledger].sort((a, b) => {
            for (const key of keys) {
              const left = String(a[key] ?? "");
              const right = String(b[key] ?? "");
              if (left !== right) return left < right ? -1 : 1;
            }
            return 0;
          });
          return Promise.resolve(sorted);
        },
      );
    };

    it("reports a stored average cost the replay disagrees with, and writes nothing", async () => {
      // The issue #1388 shape: 15.00 blended in insertion order against
      // 16.6667 replayed by date.
      stubReads(
        [{ ...mockHolding, quantity: 150, averageCost: 15 }],
        buyBuySell,
      );

      const found = await service.findLedgerDiscrepancies(
        USER,
        mockQueryRunner.manager as never,
      );

      expect(found).toHaveLength(1);
      expect(found[0].storedAverageCost).toBeCloseTo(15, 8);
      expect(found[0].replayedAverageCost).toBeCloseTo(2500 / 150, 6);
      expect(holdingsRepository.save).not.toHaveBeenCalled();
      expect(holdingsRepository.remove).not.toHaveBeenCalled();
      expect(mockQueryRunner.manager.save).not.toHaveBeenCalled();
      expect(mockQueryRunner.manager.remove).not.toHaveBeenCalled();
    });

    it("reports nothing when the stored row already equals the replay", async () => {
      stubReads(
        [{ ...mockHolding, quantity: 150, averageCost: 2500 / 150 }],
        buyBuySell,
      );

      const found = await service.findLedgerDiscrepancies(
        USER,
        mockQueryRunner.manager as never,
      );

      expect(found).toEqual([]);
    });

    it("reports a stored row the ledger accounts for no shares at all", async () => {
      stubReads([{ ...mockHolding, quantity: 100, averageCost: 12 }], []);

      const found = await service.findLedgerDiscrepancies(
        USER,
        mockQueryRunner.manager as never,
      );

      // A different finding from "a different number": nothing behind it.
      expect(found).toHaveLength(1);
      expect(found[0].replayedQuantity).toBeNull();
      expect(found[0].replayedAverageCost).toBeNull();
    });

    /**
     * A short position carries no per-share basis, and every rebuild writer
     * stores `averageCost = 0` for a negative quantity. The report derived its
     * own expected average instead and refused to produce one below zero
     * shares, so a short position was reported as disagreeing at every boot and
     * `POST /holdings/rebuild` could never clear it -- the rebuild wrote back
     * exactly the `0` that was already stored.
     */
    const shortSale = [
      {
        id: "tx-short",
        accountId: "acc-1",
        securityId: "sec-1",
        action: InvestmentAction.SELL,
        transactionDate: "2026-01-01",
        quantity: 10,
        price: 30,
        commission: 0,
        createdAt: new Date("2026-04-01T00:00:00.000Z"),
      },
    ];

    it("reports nothing for a short position a rebuild would leave alone", async () => {
      stubReads([{ ...mockHolding, quantity: -10, averageCost: 0 }], shortSale);

      const found = await service.findLedgerDiscrepancies(
        USER,
        mockQueryRunner.manager as never,
      );

      expect(found).toEqual([]);
    });

    it("still reports a short position whose stored average a rebuild would change", async () => {
      stubReads(
        [{ ...mockHolding, quantity: -10, averageCost: 30 }],
        shortSale,
      );

      const found = await service.findLedgerDiscrepancies(
        USER,
        mockQueryRunner.manager as never,
      );

      expect(found).toHaveLength(1);
      expect(found[0].storedAverageCost).toBeCloseTo(30, 8);
      expect(found[0].replayedQuantity).toBeCloseTo(-10, 8);
      expect(found[0].replayedAverageCost).toBe(0);
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

      // Unknown is not zero: the total is withheld, not shown as 0.
      expect(result.totalCostBasis).toBeNull();
      expect(result.costBasisComplete).toBe(false);
      expect(result.knownCostBasis).toBe(0);
      expect(result.holdings[0].averageCost).toBeNull();
      expect(result.holdings[0].costBasis).toBeNull();
    });
  });

  describe("remove", () => {
    /**
     * `remove` re-reads the holding inside its transaction, under the lock every
     * holdings writer takes, and checks the zero-quantity rule against *that*
     * row. Checked outside, a buy committing in between would have its shares
     * deleted by a request that had seen zero (P4-006).
     */
    function stageHolding(holding: unknown): void {
      const qb = createMockQueryBuilder(holding);
      holdingsRepository.createQueryBuilder.mockReturnValue(qb);
      holdingsRepository.findOne.mockResolvedValue(holding);
    }

    it("removes holding with zero quantity", async () => {
      const zeroHolding = { ...mockHolding, quantity: 0 };
      stageHolding(zeroHolding);

      await service.remove("11111111-1111-1111-1111-111111111111", "hold-1");

      expect(holdingsRepository.remove).toHaveBeenCalledWith(zeroHolding);
    });

    it("throws ForbiddenException when holding has non-zero quantity", async () => {
      stageHolding({ ...mockHolding, quantity: 50 });

      await expect(
        service.remove("11111111-1111-1111-1111-111111111111", "hold-1"),
      ).rejects.toThrow(ForbiddenException);
    });

    it("throws ForbiddenException with descriptive message for non-zero quantity", async () => {
      stageHolding({ ...mockHolding, quantity: 10 });

      await expect(
        service.remove("11111111-1111-1111-1111-111111111111", "hold-1"),
      ).rejects.toThrow("Cannot delete holding with non-zero quantity");
    });

    it("throws NotFoundException when holding does not exist", async () => {
      stageHolding(null);

      await expect(
        service.remove("11111111-1111-1111-1111-111111111111", "nonexistent"),
      ).rejects.toThrow(NotFoundException);
    });

    it("refuses when the committed row gained shares after the outer read", async () => {
      // The regression guard: the outer read says zero, the locked re-read says
      // 50. Before the re-read existed, the outer snapshot won and the shares
      // were deleted.
      const qb = createMockQueryBuilder({ ...mockHolding, quantity: 0 });
      holdingsRepository.createQueryBuilder.mockReturnValue(qb);
      holdingsRepository.findOne.mockResolvedValue({
        ...mockHolding,
        quantity: 50,
      });

      await expect(
        service.remove("11111111-1111-1111-1111-111111111111", "hold-1"),
      ).rejects.toThrow(ForbiddenException);
      expect(holdingsRepository.remove).not.toHaveBeenCalled();
    });

    it("handles string quantity '0' correctly (decimal from DB)", async () => {
      // Decimals from the database often come as strings
      const zeroHolding = { ...mockHolding, quantity: "0.00000000" };
      stageHolding(zeroHolding);

      await service.remove("11111111-1111-1111-1111-111111111111", "hold-1");

      expect(holdingsRepository.remove).toHaveBeenCalledWith(zeroHolding);
    });

    it("re-reads the holding scoped to the owner-verified account, not a bare id", async () => {
      // Holdings carry no user_id column; ownership is the account's. The outer
      // findOne(userId, id) established the owner via the account join, so the
      // locked re-read has to stay inside that account scope. A bare
      // `where: { id }` dropped the owner scope even though the lock is on the
      // same account -- this asserts the scope is carried through.
      stageHolding({ ...mockHolding, accountId: "acc-1", quantity: 0 });

      await service.remove("11111111-1111-1111-1111-111111111111", "hold-1");

      expect(holdingsRepository.findOne).toHaveBeenCalledWith({
        where: { id: "hold-1", accountId: "acc-1" },
      });
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

    it("reduces the basis by a return of capital, never below zero (#1800)", async () => {
      accountsRepository.find.mockResolvedValue([mockAccount]);

      investmentTransactionsRepository.find.mockResolvedValue([
        {
          accountId: "acc-1",
          securityId: "sec-1",
          action: InvestmentAction.BUY,
          quantity: 100,
          price: 10,
          transactionDate: "2025-01-01",
          createdAt: new Date("2025-01-01"),
        },
        {
          accountId: "acc-1",
          securityId: "sec-1",
          action: InvestmentAction.RETURN_OF_CAPITAL,
          quantity: null,
          price: null,
          totalAmount: 200,
          transactionDate: "2025-02-01",
          createdAt: new Date("2025-02-01"),
        },
        {
          accountId: "acc-1",
          securityId: "sec-2",
          action: InvestmentAction.BUY,
          quantity: 10,
          price: 5,
          transactionDate: "2025-01-01",
          createdAt: new Date("2025-01-01"),
        },
        {
          // More than the 50 the position cost: the basis stops at zero.
          accountId: "acc-1",
          securityId: "sec-2",
          action: InvestmentAction.RETURN_OF_CAPITAL,
          quantity: null,
          price: null,
          totalAmount: 80,
          transactionDate: "2025-02-01",
          createdAt: new Date("2025-02-01"),
        },
      ]);

      await service.rebuildFromTransactions(
        "11111111-1111-1111-1111-111111111111",
      );

      // 1,000 - 200 = 800 over the same 100 shares.
      expect(mockQrRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          securityId: "sec-1",
          quantity: 100,
          averageCost: 8,
        }),
      );
      expect(mockQrRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          securityId: "sec-2",
          quantity: 10,
          averageCost: 0,
        }),
      );
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

    describe("a transferred-in lot carries its paired OUT leg's basis (A26-M22)", () => {
      const instant = new Date("2025-02-10T12:00:00Z");
      const leg = (over: Record<string, unknown>): Record<string, unknown> => ({
        securityId: "sec-1",
        commission: 0,
        transactionDate: "2025-02-10",
        createdAt: instant,
        ...over,
      });
      const buy = (
        id: string,
        transactionDate: string,
        quantity: number,
        price: number,
      ) =>
        leg({
          id,
          accountId: "acc-1",
          action: InvestmentAction.BUY,
          quantity,
          price,
          transactionDate,
          createdAt: new Date(transactionDate),
        });
      const outLeg = (quantity: number, price: number) =>
        leg({
          id: "out-1",
          accountId: "acc-1",
          action: InvestmentAction.TRANSFER_OUT,
          linkedTransactionId: "in-1",
          quantity,
          price,
        });
      const inLeg = (quantity: number, price: number) =>
        leg({
          id: "in-1",
          accountId: "acc-2",
          action: InvestmentAction.TRANSFER_IN,
          linkedTransactionId: "out-1",
          quantity,
          price,
        });
      const rebuiltAverage = (accountId: string) =>
        mockQrRepo.create.mock.calls
          .map(([data]: any[]) => data)
          .find((data: any) => data.accountId === accountId)?.averageCost;

      beforeEach(() => {
        accountsRepository.find.mockResolvedValue([mockAccount, mockAccount2]);
      });

      it("moves the basis the source released, not the IN leg's own price, whichever leg the database returns first", async () => {
        // The legs share `created_at` (one transaction), so the IN leg may
        // come back first; the fold must still read the OUT leg's release.
        // The IN leg's own price (150) is today's average -- the stale figure.
        investmentTransactionsRepository.find.mockResolvedValue([
          buy("b1", "2025-01-10", 10, 100),
          inLeg(10, 150),
          outLeg(10, 150),
          buy("b2", "2025-03-10", 10, 200),
        ]);

        await service.rebuildFromTransactions("user-1");

        expect(rebuiltAverage("acc-2")).toBeCloseTo(100, 8);
        expect(rebuiltAverage("acc-1")).toBeCloseTo(200, 8);
      });

      it("falls back to the IN leg's own price when the OUT leg is not in the rows", async () => {
        investmentTransactionsRepository.find.mockResolvedValue([
          inLeg(10, 60),
        ]);

        await service.rebuildFromTransactions("user-1");

        expect(rebuiltAverage("acc-2")).toBeCloseTo(60, 8);
      });

      it("falls back when the source held fewer units than the OUT leg moved", async () => {
        // 5 held, 10 moved: the release is a basis for 5 units, not for the 10
        // the destination received.
        investmentTransactionsRepository.find.mockResolvedValue([
          buy("b1", "2025-01-10", 5, 100),
          outLeg(10, 100),
          inLeg(10, 70),
        ]);

        await service.rebuildFromTransactions("user-1");

        expect(rebuiltAverage("acc-2")).toBeCloseTo(70, 8);
      });
    });

    describe("releasedBasisPerShare", () => {
      const ledger = (extra: Record<string, unknown>[]) => [
        {
          id: "b1",
          accountId: "acc-1",
          securityId: "sec-1",
          action: InvestmentAction.BUY,
          quantity: 10,
          price: 100,
          commission: 0,
          transactionDate: "2025-01-10",
          createdAt: new Date("2025-01-10"),
        },
        {
          id: "b2",
          accountId: "acc-1",
          securityId: "sec-1",
          action: InvestmentAction.BUY,
          quantity: 10,
          price: 200,
          commission: 0,
          transactionDate: "2025-03-10",
          createdAt: new Date("2025-03-10"),
        },
        ...extra,
      ];
      const outRow = {
        id: "out-1",
        accountId: "acc-1",
        securityId: "sec-1",
        action: InvestmentAction.TRANSFER_OUT,
        quantity: 10,
        price: 999,
        commission: 0,
        transactionDate: "2025-02-10",
        createdAt: new Date("2025-02-10"),
      };

      it("returns the per-share basis the source held at the leg's own date", async () => {
        mockQueryRunner.manager.find.mockResolvedValue(ledger([outRow]));

        const perShare = await service.releasedBasisPerShare(
          "user-1",
          "sec-1",
          "out-1",
          mockQueryRunner.manager as never,
        );

        // 100, not today's 150 average and not the leg's own stored 999.
        expect(perShare).toBeCloseTo(100, 8);
        expect(mockQueryRunner.manager.find).toHaveBeenCalledWith(
          InvestmentTransaction,
          expect.objectContaining({
            where: expect.objectContaining({
              userId: "user-1",
              securityId: "sec-1",
              status: NON_VOID_INVESTMENT_STATUS,
            }),
            order: INVESTMENT_REPLAY_ORDER,
          }),
        );
      });

      it("returns null when the source does not hold the units on that date", async () => {
        mockQueryRunner.manager.find.mockResolvedValue(
          ledger([{ ...outRow, quantity: 15 }]),
        );

        await expect(
          service.releasedBasisPerShare(
            "user-1",
            "sec-1",
            "out-1",
            mockQueryRunner.manager as never,
          ),
        ).resolves.toBeNull();
      });

      it("returns null for a leg that is not in the ledger", async () => {
        mockQueryRunner.manager.find.mockResolvedValue(ledger([]));

        await expect(
          service.releasedBasisPerShare(
            "user-1",
            "sec-1",
            "out-1",
            mockQueryRunner.manager as never,
          ),
        ).resolves.toBeNull();
      });
    });

    it("includes the acquisition commission in averageCost (P5-006)", async () => {
      accountsRepository.find.mockResolvedValue([mockAccount]);

      const transactions = [
        {
          accountId: "acc-1",
          securityId: "sec-1",
          action: InvestmentAction.BUY,
          quantity: 10,
          price: 100,
          commission: 10,
          transactionDate: "2025-01-01",
          createdAt: new Date("2025-01-01"),
        },
      ];
      investmentTransactionsRepository.find.mockResolvedValue(transactions);

      await service.rebuildFromTransactions(
        "11111111-1111-1111-1111-111111111111",
      );

      // The cash debit for this buy is 1,010, so a share cost 101.00 to
      // acquire. Reporting 100.00 turns the commission into gain on the sale.
      expect(mockQrRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ quantity: 10, averageCost: 101 }),
      );
    });

    it("does not invent a cost for an unpriced acquisition", async () => {
      accountsRepository.find.mockResolvedValue([mockAccount]);

      const transactions = [
        {
          accountId: "acc-1",
          securityId: "sec-1",
          action: InvestmentAction.BUY,
          quantity: 10,
          price: null,
          commission: 0,
          transactionDate: "2025-01-01",
          createdAt: new Date("2025-01-01"),
        },
      ];
      investmentTransactionsRepository.find.mockResolvedValue(transactions);

      await service.rebuildFromTransactions(
        "11111111-1111-1111-1111-111111111111",
      );

      // The shares are held; no basis was fabricated for them.
      expect(mockQrRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ quantity: 10, averageCost: 0 }),
      );
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
    it("rebuilds inside a scoped transaction", async () => {
      accountsRepository.find.mockResolvedValue([mockAccount]);
      investmentTransactionsRepository.find.mockResolvedValue([]);

      await service.rebuildFromTransactions(
        "11111111-1111-1111-1111-111111111111",
      );

      // The delete-all + recreate pair shares one transaction.
      expect(dataSource.transaction).toHaveBeenCalled();
      expect(mockQueryRunner.manager.find).toHaveBeenCalledWith(
        Holding,
        expect.anything(),
      );
    });

    it("propagates a delete failure out of the transaction", async () => {
      accountsRepository.find.mockResolvedValue([mockAccount]);
      investmentTransactionsRepository.find.mockResolvedValue([]);
      mockQueryRunner.manager.find.mockResolvedValue([{ id: "old-hold" }]);
      mockQueryRunner.manager.remove.mockRejectedValue(
        new Error("Delete failed"),
      );

      await expect(
        service.rebuildFromTransactions("11111111-1111-1111-1111-111111111111"),
      ).rejects.toThrow("Delete failed");

      // The failure escapes the scoped transaction, so nothing is recreated.
      expect(mockQrRepo.save).not.toHaveBeenCalled();
    });

    it("propagates a save failure out of the transaction", async () => {
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

      expect(dataSource.transaction).toHaveBeenCalled();
    });
  });

  describe("applyMaturedInvestmentHoldings", () => {
    it("rebuilds holdings for users with an investment transaction maturing today", async () => {
      // Both the timezone fan-out and the matured-user query run inside the
      // cron's system context, each in its own scoped transaction -- so both
      // land on the transaction manager, in this order.
      mockQueryRunner.manager.query.mockResolvedValueOnce([
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
      ]);
      mockQueryRunner.manager.query.mockResolvedValueOnce([
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
      mockQueryRunner.manager.query.mockResolvedValueOnce([]);
      const rebuildSpy = jest.spyOn(service, "rebuildFromTransactions");

      await service.applyMaturedInvestmentHoldings();

      expect(rebuildSpy).not.toHaveBeenCalled();
    });
  });

  describe("VOID rows are excluded from every effects read", () => {
    // Rows as effects: a VOID investment transaction moved no shares, so every
    // replay/rebuild/validation query filters on NON_VOID_INVESTMENT_STATUS
    // (docs/specs/investment-transaction-status.md invariant 4). The
    // repositories are mocked, so the claim each test can make is that the
    // query itself carries the filter -- a fixture fed past a mocked `where`
    // would prove nothing.
    const uid = "11111111-1111-1111-1111-111111111111";

    it("getHoldingAt replays only non-VOID rows", async () => {
      investmentTransactionsRepository.find.mockResolvedValue([]);

      await service.getHoldingAt(uid, "acc-1", "sec-1", "2025-03-01");

      expect(investmentTransactionsRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: NON_VOID_INVESTMENT_STATUS,
          }),
        }),
      );
    });

    it("validateNoNegativeHoldingsHistory cannot be oversold by a VOID row", async () => {
      accountsRepository.find.mockResolvedValue([mockAccount]);
      investmentTransactionsRepository.find.mockResolvedValue([]);

      await service.validateNoNegativeHoldingsHistory(uid);

      expect(investmentTransactionsRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: NON_VOID_INVESTMENT_STATUS,
          }),
        }),
      );
    });

    it("rebuildFromTransactions reads only non-VOID rows", async () => {
      accountsRepository.find.mockResolvedValue([mockAccount]);
      investmentTransactionsRepository.find.mockResolvedValue([]);

      await service.rebuildFromTransactions(uid);

      expect(investmentTransactionsRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: NON_VOID_INVESTMENT_STATUS,
          }),
        }),
      );
    });

    it("rebuildAccountsFromTransactions reads only non-VOID rows", async () => {
      mockQueryRunner.manager.find.mockImplementation(
        async (entity: unknown) => (entity === Account ? [mockAccount] : []),
      );

      await service.rebuildAccountsFromTransactions(
        uid,
        ["acc-1"],
        mockQueryRunner.manager as never,
      );

      expect(mockQueryRunner.manager.find).toHaveBeenCalledWith(
        InvestmentTransaction,
        expect.objectContaining({
          where: expect.objectContaining({
            status: NON_VOID_INVESTMENT_STATUS,
          }),
        }),
      );
    });
  });
});
