import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import {
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from "@nestjs/common";
import { TransactionsService } from "./transactions.service";
import { Transaction, TransactionStatus } from "./entities/transaction.entity";
import { TransactionSplit } from "./entities/transaction-split.entity";
import { Category } from "../categories/entities/category.entity";
import { InvestmentTransaction } from "../securities/entities/investment-transaction.entity";
import { AccountsService } from "../accounts/accounts.service";
import { PayeesService } from "../payees/payees.service";
import { NetWorthService } from "../net-worth/net-worth.service";
import { TransactionSplitService } from "./transaction-split.service";
import { TransactionTransferService } from "./transaction-transfer.service";
import { TransactionReconciliationService } from "./transaction-reconciliation.service";
import { TransactionAnalyticsService } from "./transaction-analytics.service";
import { TransactionBulkUpdateService } from "./transaction-bulk-update.service";

describe("TransactionsService", () => {
  let service: TransactionsService;
  let splitService: TransactionSplitService;
  let transactionsRepository: Record<string, jest.Mock>;
  let splitsRepository: Record<string, jest.Mock>;
  let categoriesRepository: Record<string, jest.Mock>;
  let investmentTxRepository: Record<string, jest.Mock>;
  let accountsService: Record<string, jest.Mock>;
  let payeesService: Record<string, jest.Mock>;
  let netWorthService: Record<string, jest.Mock>;

  const mockAccount = {
    id: "account-1",
    userId: "user-1",
    name: "Checking",
    accountType: "CHEQUING",
    currencyCode: "USD",
    currentBalance: 1000,
    isClosed: false,
  };

  beforeEach(async () => {
    transactionsRepository = {
      create: jest.fn().mockImplementation((data) => ({ ...data, id: "tx-1" })),
      save: jest
        .fn()
        .mockImplementation((data) => ({ ...data, id: data.id || "tx-1" })),
      findOne: jest.fn(),
      find: jest.fn(),
      remove: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
      createQueryBuilder: jest.fn(),
    };

    splitsRepository = {
      create: jest.fn().mockImplementation((data) => data),
      save: jest
        .fn()
        .mockImplementation((data) => ({ ...data, id: "split-1" })),
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      update: jest.fn(),
      delete: jest.fn(),
      remove: jest.fn(),
    };

    categoriesRepository = {
      find: jest.fn().mockResolvedValue([]),
    };

    investmentTxRepository = {
      find: jest.fn().mockResolvedValue([]),
    };

    accountsService = {
      findOne: jest.fn().mockResolvedValue(mockAccount),
      updateBalance: jest.fn().mockResolvedValue(mockAccount),
    };

    payeesService = {
      findOne: jest.fn(),
    };

    netWorthService = {
      recalculateAccount: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionsService,
        {
          provide: getRepositoryToken(Transaction),
          useValue: transactionsRepository,
        },
        {
          provide: getRepositoryToken(TransactionSplit),
          useValue: splitsRepository,
        },
        {
          provide: getRepositoryToken(Category),
          useValue: categoriesRepository,
        },
        {
          provide: getRepositoryToken(InvestmentTransaction),
          useValue: investmentTxRepository,
        },
        { provide: AccountsService, useValue: accountsService },
        { provide: PayeesService, useValue: payeesService },
        { provide: NetWorthService, useValue: netWorthService },
        TransactionSplitService,
        TransactionTransferService,
        TransactionReconciliationService,
        TransactionAnalyticsService,
        TransactionBulkUpdateService,
      ],
    }).compile();

    service = module.get<TransactionsService>(TransactionsService);
    splitService = module.get<TransactionSplitService>(TransactionSplitService);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllTimers();
  });

  describe("validateSplits (via create)", () => {
    it("rejects splits with fewer than 2 entries (non-transfer)", async () => {
      transactionsRepository.findOne.mockResolvedValue({
        id: "tx-1",
        userId: "user-1",
        splits: [],
      });

      await expect(
        service.create("user-1", {
          accountId: "account-1",
          transactionDate: "2026-01-15",
          amount: -100,
          currencyCode: "USD",
          splits: [{ amount: -100, categoryId: "cat-1" }],
        } as any),
      ).rejects.toThrow("Split transactions must have at least 2 splits");
    });

    it("rejects splits where sum does not match transaction amount", async () => {
      await expect(
        service.create("user-1", {
          accountId: "account-1",
          transactionDate: "2026-01-15",
          amount: -100,
          currencyCode: "USD",
          splits: [
            { amount: -60, categoryId: "cat-1" },
            { amount: -30, categoryId: "cat-2" },
          ],
        } as any),
      ).rejects.toThrow("Split amounts");
    });

    it("rejects splits with zero amount", async () => {
      await expect(
        service.create("user-1", {
          accountId: "account-1",
          transactionDate: "2026-01-15",
          amount: -100,
          currencyCode: "USD",
          splits: [
            { amount: 0, categoryId: "cat-1" },
            { amount: -100, categoryId: "cat-2" },
          ],
        } as any),
      ).rejects.toThrow("Split amounts cannot be zero");
    });

    it("allows single split for transfers (with transferAccountId)", async () => {
      transactionsRepository.findOne.mockResolvedValue({
        id: "tx-1",
        userId: "user-1",
        splits: [{ amount: -100, transferAccountId: "acc-2" }],
      });

      // Should not throw for single split with transfer
      await expect(
        service.create("user-1", {
          accountId: "account-1",
          transactionDate: "2026-01-15",
          amount: -100,
          currencyCode: "USD",
          splits: [{ amount: -100, transferAccountId: "acc-2" }],
        } as any),
      ).resolves.toBeDefined();
    });
  });

  describe("create", () => {
    it("creates a basic transaction and updates balance", async () => {
      transactionsRepository.findOne.mockResolvedValue({
        id: "tx-1",
        userId: "user-1",
        accountId: "account-1",
        amount: -50,
        status: TransactionStatus.UNRECONCILED,
        splits: [],
      });

      await service.create("user-1", {
        accountId: "account-1",
        transactionDate: "2026-01-15",
        amount: -50,
        currencyCode: "USD",
      } as any);

      expect(transactionsRepository.create).toHaveBeenCalled();
      expect(transactionsRepository.save).toHaveBeenCalled();
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "account-1",
        -50,
      );
    });

    it("does not update balance for VOID transactions", async () => {
      transactionsRepository.create.mockReturnValue({
        id: "tx-1",
        status: TransactionStatus.VOID,
      });
      transactionsRepository.save.mockResolvedValue({
        id: "tx-1",
        status: TransactionStatus.VOID,
      });
      transactionsRepository.findOne.mockResolvedValue({
        id: "tx-1",
        userId: "user-1",
        status: TransactionStatus.VOID,
        splits: [],
      });

      await service.create("user-1", {
        accountId: "account-1",
        transactionDate: "2026-01-15",
        amount: -50,
        currencyCode: "USD",
        status: TransactionStatus.VOID,
      } as any);

      expect(accountsService.updateBalance).not.toHaveBeenCalled();
    });

    it("auto-assigns category from payee default", async () => {
      payeesService.findOne.mockResolvedValue({
        id: "payee-1",
        defaultCategoryId: "cat-1",
      });
      transactionsRepository.findOne.mockResolvedValue({
        id: "tx-1",
        userId: "user-1",
        categoryId: "cat-1",
        splits: [],
        status: TransactionStatus.UNRECONCILED,
      });

      await service.create("user-1", {
        accountId: "account-1",
        transactionDate: "2026-01-15",
        amount: -50,
        currencyCode: "USD",
        payeeId: "payee-1",
      } as any);

      const createCall = transactionsRepository.create.mock.calls[0][0];
      expect(createCall.categoryId).toBe("cat-1");
    });

    it("verifies account belongs to user", async () => {
      transactionsRepository.findOne.mockResolvedValue({
        id: "tx-1",
        userId: "user-1",
        accountId: "account-1",
        amount: -50,
        status: TransactionStatus.UNRECONCILED,
        splits: [],
      });

      await service.create("user-1", {
        accountId: "account-1",
        transactionDate: "2026-01-15",
        amount: -50,
        currencyCode: "USD",
      } as any);

      expect(accountsService.findOne).toHaveBeenCalledWith(
        "user-1",
        "account-1",
      );
    });
  });

  describe("findOne", () => {
    it("returns transaction when found and belongs to user", async () => {
      const mockTx = {
        id: "tx-1",
        userId: "user-1",
        accountId: "account-1",
        amount: -50,
        splits: [],
      };
      transactionsRepository.findOne.mockResolvedValue(mockTx);

      const result = await service.findOne("user-1", "tx-1");

      expect(result).toEqual(mockTx);
    });

    it("throws NotFoundException when not found", async () => {
      transactionsRepository.findOne.mockResolvedValue(null);

      await expect(service.findOne("user-1", "nonexistent")).rejects.toThrow(
        NotFoundException,
      );
    });

    it("throws ForbiddenException for wrong user", async () => {
      transactionsRepository.findOne.mockResolvedValue({
        id: "tx-1",
        userId: "other-user",
      });

      await expect(service.findOne("user-1", "tx-1")).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe("update", () => {
    const mockTx = {
      id: "tx-1",
      userId: "user-1",
      accountId: "account-1",
      amount: -50,
      status: TransactionStatus.UNRECONCILED,
      isSplit: false,
      splits: [],
    };

    it("updates transaction amount and adjusts balance", async () => {
      transactionsRepository.findOne.mockResolvedValue({ ...mockTx });

      await service.update("user-1", "tx-1", { amount: -80 } as any);

      expect(transactionsRepository.update).toHaveBeenCalledWith(
        "tx-1",
        expect.objectContaining({ amount: -80 }),
      );
    });

    it("handles VOID to non-VOID status change", async () => {
      transactionsRepository.findOne
        .mockResolvedValueOnce({
          ...mockTx,
          status: TransactionStatus.VOID,
        })
        .mockResolvedValueOnce({
          ...mockTx,
          status: TransactionStatus.UNRECONCILED,
          amount: -50,
        });

      await service.update("user-1", "tx-1", {
        status: TransactionStatus.UNRECONCILED,
      } as any);

      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "account-1",
        -50,
      );
    });

    it("handles non-VOID to VOID status change", async () => {
      transactionsRepository.findOne
        .mockResolvedValueOnce({ ...mockTx })
        .mockResolvedValueOnce({
          ...mockTx,
          status: TransactionStatus.VOID,
        });

      await service.update("user-1", "tx-1", {
        status: TransactionStatus.VOID,
      } as any);

      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "account-1",
        50,
      );
    });

    it("verifies new account when account changes", async () => {
      transactionsRepository.findOne.mockResolvedValue({ ...mockTx });

      await service.update("user-1", "tx-1", {
        accountId: "account-2",
      } as any);

      expect(accountsService.findOne).toHaveBeenCalledWith(
        "user-1",
        "account-2",
      );
    });
  });

  describe("remove", () => {
    it("reverts balance and removes transaction", async () => {
      transactionsRepository.findOne.mockResolvedValue({
        id: "tx-1",
        userId: "user-1",
        accountId: "account-1",
        amount: -50,
        status: TransactionStatus.UNRECONCILED,
        isSplit: false,
        splits: [],
      });
      splitsRepository.findOne.mockResolvedValue(null);

      await service.remove("user-1", "tx-1");

      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "account-1",
        50,
      );
      expect(transactionsRepository.remove).toHaveBeenCalled();
    });

    it("does not revert balance for VOID transactions", async () => {
      transactionsRepository.findOne.mockResolvedValue({
        id: "tx-1",
        userId: "user-1",
        accountId: "account-1",
        amount: -50,
        status: TransactionStatus.VOID,
        isSplit: false,
        splits: [],
      });
      splitsRepository.findOne.mockResolvedValue(null);

      await service.remove("user-1", "tx-1");

      expect(accountsService.updateBalance).not.toHaveBeenCalled();
    });
  });

  describe("updateStatus", () => {
    const mockTx = {
      id: "tx-1",
      userId: "user-1",
      accountId: "account-1",
      amount: -50,
      status: TransactionStatus.UNRECONCILED,
      splits: [],
    };

    it("transitions from UNRECONCILED to VOID and reverts balance", async () => {
      transactionsRepository.findOne
        .mockResolvedValueOnce({ ...mockTx })
        .mockResolvedValueOnce({
          ...mockTx,
          status: TransactionStatus.VOID,
        });

      await service.updateStatus("user-1", "tx-1", TransactionStatus.VOID);

      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "account-1",
        50,
      );
    });

    it("transitions from VOID to UNRECONCILED and adds balance", async () => {
      transactionsRepository.findOne
        .mockResolvedValueOnce({
          ...mockTx,
          status: TransactionStatus.VOID,
        })
        .mockResolvedValueOnce({
          ...mockTx,
          status: TransactionStatus.UNRECONCILED,
        });

      await service.updateStatus(
        "user-1",
        "tx-1",
        TransactionStatus.UNRECONCILED,
      );

      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "account-1",
        -50,
      );
    });

    it("sets reconciled date when marking RECONCILED", async () => {
      transactionsRepository.findOne
        .mockResolvedValueOnce({ ...mockTx })
        .mockResolvedValueOnce({
          ...mockTx,
          status: TransactionStatus.RECONCILED,
        });

      await service.updateStatus(
        "user-1",
        "tx-1",
        TransactionStatus.RECONCILED,
      );

      expect(transactionsRepository.update).toHaveBeenCalledWith(
        "tx-1",
        expect.objectContaining({ reconciledDate: expect.any(String) }),
      );
    });
  });

  describe("markCleared", () => {
    it("marks unreconciled transaction as cleared", async () => {
      const mockTx = {
        id: "tx-1",
        userId: "user-1",
        accountId: "account-1",
        amount: -50,
        status: TransactionStatus.UNRECONCILED,
        splits: [],
      };
      transactionsRepository.findOne.mockResolvedValue({ ...mockTx });

      await service.markCleared("user-1", "tx-1", true);

      expect(transactionsRepository.update).toHaveBeenCalledWith(
        "tx-1",
        expect.objectContaining({ status: TransactionStatus.CLEARED }),
      );
    });

    it("throws for reconciled transactions", async () => {
      transactionsRepository.findOne.mockResolvedValue({
        id: "tx-1",
        userId: "user-1",
        status: TransactionStatus.RECONCILED,
        splits: [],
      });

      await expect(service.markCleared("user-1", "tx-1", true)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("throws for void transactions", async () => {
      transactionsRepository.findOne.mockResolvedValue({
        id: "tx-1",
        userId: "user-1",
        status: TransactionStatus.VOID,
        splits: [],
      });

      await expect(service.markCleared("user-1", "tx-1", true)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe("reconcile", () => {
    it("throws for already reconciled transactions", async () => {
      transactionsRepository.findOne.mockResolvedValue({
        id: "tx-1",
        userId: "user-1",
        status: TransactionStatus.RECONCILED,
        splits: [],
      });

      await expect(service.reconcile("user-1", "tx-1")).rejects.toThrow(
        "Transaction is already reconciled",
      );
    });

    it("throws for void transactions", async () => {
      transactionsRepository.findOne.mockResolvedValue({
        id: "tx-1",
        userId: "user-1",
        status: TransactionStatus.VOID,
        splits: [],
      });

      await expect(service.reconcile("user-1", "tx-1")).rejects.toThrow(
        "Cannot reconcile a void transaction",
      );
    });
  });

  describe("unreconcile", () => {
    it("throws for non-reconciled transactions", async () => {
      transactionsRepository.findOne.mockResolvedValue({
        id: "tx-1",
        userId: "user-1",
        status: TransactionStatus.UNRECONCILED,
        splits: [],
      });

      await expect(service.unreconcile("user-1", "tx-1")).rejects.toThrow(
        "Transaction is not reconciled",
      );
    });

    it("sets status to CLEARED and clears reconciled date", async () => {
      transactionsRepository.findOne.mockResolvedValue({
        id: "tx-1",
        userId: "user-1",
        status: TransactionStatus.RECONCILED,
        splits: [],
      });

      await service.unreconcile("user-1", "tx-1");

      expect(transactionsRepository.update).toHaveBeenCalledWith("tx-1", {
        status: TransactionStatus.CLEARED,
        reconciledDate: null,
      });
    });
  });

  describe("createTransfer", () => {
    it("creates two linked transactions", async () => {
      const mockToAccount = {
        ...mockAccount,
        id: "account-2",
        name: "Savings",
      };
      accountsService.findOne
        .mockResolvedValueOnce(mockAccount)
        .mockResolvedValueOnce(mockToAccount);
      transactionsRepository.findOne
        .mockResolvedValueOnce({
          id: "tx-from",
          userId: "user-1",
          splits: [],
        })
        .mockResolvedValueOnce({
          id: "tx-to",
          userId: "user-1",
          splits: [],
        });
      transactionsRepository.save
        .mockResolvedValueOnce({ id: "tx-from" })
        .mockResolvedValueOnce({ id: "tx-to" });

      const result = await service.createTransfer("user-1", {
        fromAccountId: "account-1",
        toAccountId: "account-2",
        transactionDate: "2026-01-15",
        amount: 200,
        fromCurrencyCode: "USD",
      } as any);

      expect(result).toBeDefined();
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "account-1",
        -200,
      );
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "account-2",
        200,
      );
    });

    it("throws when source and destination are the same", async () => {
      await expect(
        service.createTransfer("user-1", {
          fromAccountId: "account-1",
          toAccountId: "account-1",
          transactionDate: "2026-01-15",
          amount: 200,
          fromCurrencyCode: "USD",
        } as any),
      ).rejects.toThrow("Source and destination accounts must be different");
    });

    it("throws when amount is not positive", async () => {
      await expect(
        service.createTransfer("user-1", {
          fromAccountId: "account-1",
          toAccountId: "account-2",
          transactionDate: "2026-01-15",
          amount: -100,
          fromCurrencyCode: "USD",
        } as any),
      ).rejects.toThrow("Transfer amount must be positive");
    });
  });

  describe("getLinkedTransaction", () => {
    it("returns null for non-transfer transaction", async () => {
      transactionsRepository.findOne.mockResolvedValue({
        id: "tx-1",
        userId: "user-1",
        isTransfer: false,
        linkedTransactionId: null,
        splits: [],
      });

      const result = await service.getLinkedTransaction("user-1", "tx-1");

      expect(result).toBeNull();
    });
  });

  describe("removeTransfer", () => {
    it("throws when transaction is not a transfer", async () => {
      transactionsRepository.findOne.mockResolvedValue({
        id: "tx-1",
        userId: "user-1",
        isTransfer: false,
        splits: [],
      });

      await expect(service.removeTransfer("user-1", "tx-1")).rejects.toThrow(
        "Transaction is not a transfer",
      );
    });
  });

  // ========================================================================
  // Additional coverage tests
  // ========================================================================

  describe("findAll", () => {
    const createMockQueryBuilder = (overrides?: Record<string, jest.Mock>) => {
      const mockQb: Record<string, jest.Mock> = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        leftJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        setParameter: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
        getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
        getCount: jest.fn().mockResolvedValue(0),
        getRawMany: jest.fn().mockResolvedValue([]),
        getRawOne: jest.fn().mockResolvedValue(null),
        getQuery: jest.fn().mockReturnValue("SELECT 1"),
        getParameters: jest.fn().mockReturnValue({}),
        limit: jest.fn().mockReturnThis(),
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 0 }),
        ...overrides,
      };
      return mockQb;
    };

    it("returns empty paginated result with defaults", async () => {
      const mockQb = createMockQueryBuilder();
      mockQb.getManyAndCount.mockResolvedValue([[], 0]);
      transactionsRepository.createQueryBuilder.mockReturnValue(mockQb);
      investmentTxRepository.find.mockResolvedValue([]);

      const result = await service.findAll("user-1");

      expect(result).toEqual({
        data: [],
        pagination: {
          page: 1,
          limit: 50,
          total: 0,
          totalPages: 0,
          hasMore: false,
        },
        startingBalance: undefined,
      });
    });

    it("applies pagination with page and limit", async () => {
      const mockQb = createMockQueryBuilder();
      mockQb.getManyAndCount.mockResolvedValue([[], 0]);
      transactionsRepository.createQueryBuilder.mockReturnValue(mockQb);
      investmentTxRepository.find.mockResolvedValue([]);

      await service.findAll(
        "user-1",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        3,
        25,
      );

      expect(mockQb.skip).toHaveBeenCalledWith(50); // (3-1) * 25
      expect(mockQb.take).toHaveBeenCalledWith(25);
    });

    it("clamps page to minimum 1 and limit to minimum 1", async () => {
      const mockQb = createMockQueryBuilder();
      mockQb.getManyAndCount.mockResolvedValue([[], 0]);
      transactionsRepository.createQueryBuilder.mockReturnValue(mockQb);
      investmentTxRepository.find.mockResolvedValue([]);

      await service.findAll(
        "user-1",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        -5,
        -10,
      );

      expect(mockQb.skip).toHaveBeenCalledWith(0); // (max(1,-5) - 1) * max(1,-10) = 0
      expect(mockQb.take).toHaveBeenCalledWith(1);
    });

    it("clamps limit to maximum 200", async () => {
      const mockQb = createMockQueryBuilder();
      mockQb.getManyAndCount.mockResolvedValue([[], 0]);
      transactionsRepository.createQueryBuilder.mockReturnValue(mockQb);
      investmentTxRepository.find.mockResolvedValue([]);

      await service.findAll(
        "user-1",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        1,
        999999,
      );

      expect(mockQb.take).toHaveBeenCalledWith(200);
    });

    it("filters by accountIds", async () => {
      const mockQb = createMockQueryBuilder();
      mockQb.getManyAndCount.mockResolvedValue([[], 0]);
      transactionsRepository.createQueryBuilder.mockReturnValue(mockQb);
      investmentTxRepository.find.mockResolvedValue([]);

      await service.findAll("user-1", ["acc-1", "acc-2"]);

      expect(mockQb.andWhere).toHaveBeenCalledWith(
        "transaction.accountId IN (:...accountIds)",
        { accountIds: ["acc-1", "acc-2"] },
      );
    });

    it("filters by startDate and endDate", async () => {
      const mockQb = createMockQueryBuilder();
      mockQb.getManyAndCount.mockResolvedValue([[], 0]);
      transactionsRepository.createQueryBuilder.mockReturnValue(mockQb);
      investmentTxRepository.find.mockResolvedValue([]);

      await service.findAll("user-1", undefined, "2026-01-01", "2026-12-31");

      expect(mockQb.andWhere).toHaveBeenCalledWith(
        "transaction.transactionDate >= :startDate",
        { startDate: "2026-01-01" },
      );
      expect(mockQb.andWhere).toHaveBeenCalledWith(
        "transaction.transactionDate <= :endDate",
        { endDate: "2026-12-31" },
      );
    });

    it("filters by regular categoryIds including children", async () => {
      const mockQb = createMockQueryBuilder();
      mockQb.getManyAndCount.mockResolvedValue([[], 0]);
      transactionsRepository.createQueryBuilder.mockReturnValue(mockQb);
      investmentTxRepository.find.mockResolvedValue([]);
      categoriesRepository.find.mockResolvedValue([
        { id: "cat-1", parentId: null },
        { id: "cat-1-child", parentId: "cat-1" },
      ]);

      await service.findAll("user-1", undefined, undefined, undefined, [
        "cat-1",
      ]);

      expect(categoriesRepository.find).toHaveBeenCalled();
      expect(mockQb.setParameter).toHaveBeenCalledWith(
        "filterCategoryIds",
        expect.arrayContaining(["cat-1", "cat-1-child"]),
      );
    });

    it("handles 'uncategorized' special category filter", async () => {
      const mockQb = createMockQueryBuilder();
      mockQb.getManyAndCount.mockResolvedValue([[], 0]);
      transactionsRepository.createQueryBuilder.mockReturnValue(mockQb);
      investmentTxRepository.find.mockResolvedValue([]);

      await service.findAll("user-1", undefined, undefined, undefined, [
        "uncategorized",
      ]);

      expect(mockQb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining("transaction.categoryId IS NULL"),
      );
    });

    it("handles 'transfer' special category filter", async () => {
      const mockQb = createMockQueryBuilder();
      mockQb.getManyAndCount.mockResolvedValue([[], 0]);
      transactionsRepository.createQueryBuilder.mockReturnValue(mockQb);
      investmentTxRepository.find.mockResolvedValue([]);

      await service.findAll("user-1", undefined, undefined, undefined, [
        "transfer",
      ]);

      expect(mockQb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining("transaction.isTransfer = true"),
      );
    });

    it("handles combined uncategorized + transfer + regular category filters", async () => {
      const mockQb = createMockQueryBuilder();
      mockQb.getManyAndCount.mockResolvedValue([[], 0]);
      transactionsRepository.createQueryBuilder.mockReturnValue(mockQb);
      investmentTxRepository.find.mockResolvedValue([]);
      categoriesRepository.find.mockResolvedValue([
        { id: "cat-1", parentId: null },
      ]);

      await service.findAll("user-1", undefined, undefined, undefined, [
        "uncategorized",
        "transfer",
        "cat-1",
      ]);

      // Should have a combined OR condition containing all three
      expect(mockQb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining(" OR "),
      );
    });

    it("filters by payeeIds", async () => {
      const mockQb = createMockQueryBuilder();
      mockQb.getManyAndCount.mockResolvedValue([[], 0]);
      transactionsRepository.createQueryBuilder.mockReturnValue(mockQb);
      investmentTxRepository.find.mockResolvedValue([]);

      await service.findAll(
        "user-1",
        undefined,
        undefined,
        undefined,
        undefined,
        ["payee-1"],
      );

      expect(mockQb.andWhere).toHaveBeenCalledWith(
        "transaction.payeeId IN (:...payeeIds)",
        { payeeIds: ["payee-1"] },
      );
    });

    it("filters by search text", async () => {
      const mockQb = createMockQueryBuilder();
      mockQb.getManyAndCount.mockResolvedValue([[], 0]);
      transactionsRepository.createQueryBuilder.mockReturnValue(mockQb);
      investmentTxRepository.find.mockResolvedValue([]);

      await service.findAll(
        "user-1",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        1,
        50,
        false,
        "groceries",
      );

      expect(mockQb.andWhere).toHaveBeenCalledWith(
        "(transaction.description ILIKE :search OR transaction.payeeName ILIKE :search OR splits.memo ILIKE :search)",
        { search: "%groceries%" },
      );
    });

    it("ignores empty/whitespace-only search", async () => {
      const mockQb = createMockQueryBuilder();
      mockQb.getManyAndCount.mockResolvedValue([[], 0]);
      transactionsRepository.createQueryBuilder.mockReturnValue(mockQb);
      investmentTxRepository.find.mockResolvedValue([]);

      await service.findAll(
        "user-1",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        1,
        50,
        false,
        "   ",
      );

      // search ILIKE should not be called for whitespace-only
      const searchCalls = mockQb.andWhere.mock.calls.filter(
        (call: any[]) =>
          typeof call[0] === "string" && call[0].includes("ILIKE"),
      );
      expect(searchCalls.length).toBe(0);
    });

    it("excludes investment brokerage accounts by default", async () => {
      const mockQb = createMockQueryBuilder();
      mockQb.getManyAndCount.mockResolvedValue([[], 0]);
      transactionsRepository.createQueryBuilder.mockReturnValue(mockQb);
      investmentTxRepository.find.mockResolvedValue([]);

      await service.findAll("user-1");

      expect(mockQb.andWhere).toHaveBeenCalledWith(
        "(account.accountSubType IS NULL OR account.accountSubType != 'INVESTMENT_BROKERAGE')",
      );
    });

    it("includes investment brokerage accounts when requested", async () => {
      const mockQb = createMockQueryBuilder();
      mockQb.getManyAndCount.mockResolvedValue([[], 0]);
      transactionsRepository.createQueryBuilder.mockReturnValue(mockQb);
      investmentTxRepository.find.mockResolvedValue([]);

      await service.findAll(
        "user-1",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        1,
        50,
        true,
      );

      const investmentCalls = mockQb.andWhere.mock.calls.filter(
        (call: any[]) =>
          typeof call[0] === "string" &&
          call[0].includes("INVESTMENT_BROKERAGE"),
      );
      expect(investmentCalls.length).toBe(0);
    });

    it("enriches transactions with linked investment transaction IDs", async () => {
      const mockTx = {
        id: "tx-1",
        userId: "user-1",
        accountId: "account-1",
        amount: -100,
        status: TransactionStatus.UNRECONCILED,
        isCleared: false,
        isReconciled: false,
        isVoid: false,
        splits: [],
      };
      const mockQb = createMockQueryBuilder();
      mockQb.getManyAndCount.mockResolvedValue([[mockTx], 1]);
      transactionsRepository.createQueryBuilder.mockReturnValue(mockQb);
      investmentTxRepository.find.mockResolvedValue([
        { id: "inv-tx-1", transactionId: "tx-1" },
      ]);

      const result = await service.findAll("user-1");

      expect(result.data[0].linkedInvestmentTransactionId).toBe("inv-tx-1");
    });

    it("sets linkedInvestmentTransactionId to null when no investment link", async () => {
      const mockTx = {
        id: "tx-1",
        userId: "user-1",
        amount: -100,
        status: TransactionStatus.UNRECONCILED,
        isCleared: false,
        isReconciled: false,
        isVoid: false,
        splits: [],
      };
      const mockQb = createMockQueryBuilder();
      mockQb.getManyAndCount.mockResolvedValue([[mockTx], 1]);
      transactionsRepository.createQueryBuilder.mockReturnValue(mockQb);
      investmentTxRepository.find.mockResolvedValue([]);

      const result = await service.findAll("user-1");

      expect(result.data[0].linkedInvestmentTransactionId).toBeNull();
    });

    it("calculates starting balance for page 1 with single account", async () => {
      const mockTx = {
        id: "tx-1",
        userId: "user-1",
        accountId: "account-1",
        amount: -50,
        status: TransactionStatus.UNRECONCILED,
        isCleared: false,
        isReconciled: false,
        isVoid: false,
        splits: [],
      };
      const mockQb = createMockQueryBuilder();
      mockQb.getManyAndCount.mockResolvedValue([[mockTx], 1]);
      transactionsRepository.createQueryBuilder.mockReturnValue(mockQb);
      investmentTxRepository.find.mockResolvedValue([]);
      accountsService.findOne.mockResolvedValue({
        ...mockAccount,
        currentBalance: 950,
      });

      const result = await service.findAll("user-1", ["account-1"]);

      expect(result.startingBalance).toBe(950);
    });

    it("calculates starting balance for page > 1 using sum of previous pages", async () => {
      const mockTx = {
        id: "tx-2",
        userId: "user-1",
        accountId: "account-1",
        amount: -30,
        status: TransactionStatus.UNRECONCILED,
        isCleared: false,
        isReconciled: false,
        isVoid: false,
        splits: [],
      };
      const mockQb = createMockQueryBuilder();
      mockQb.getManyAndCount.mockResolvedValue([[mockTx], 51]);
      // For the sum of previous pages queries (two additional createQueryBuilder calls):
      // 1st = main query, 2nd = previousPagesQuery, 3rd = sumResult query
      const sumQb = createMockQueryBuilder({
        setParameters: jest.fn().mockReturnThis(),
      });
      sumQb.getRawOne.mockResolvedValue({ sum: -200 });
      const previousPagesQb = createMockQueryBuilder();
      previousPagesQb.getQuery.mockReturnValue("SELECT t.id FROM ...");
      previousPagesQb.getParameters.mockReturnValue({ userId: "user-1" });
      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(mockQb)
        .mockReturnValueOnce(previousPagesQb)
        .mockReturnValueOnce(sumQb);
      investmentTxRepository.find.mockResolvedValue([]);
      accountsService.findOne.mockResolvedValue({
        ...mockAccount,
        currentBalance: 800,
      });

      const result = await service.findAll(
        "user-1",
        ["account-1"],
        undefined,
        undefined,
        undefined,
        undefined,
        2,
        50,
      );

      // startingBalance = currentBalance - sumBefore = 800 - (-200) = 1000
      expect(result.startingBalance).toBe(1000);
    });

    it("does not compute starting balance for multiple accounts", async () => {
      const mockQb = createMockQueryBuilder();
      mockQb.getManyAndCount.mockResolvedValue([[], 0]);
      transactionsRepository.createQueryBuilder.mockReturnValue(mockQb);
      investmentTxRepository.find.mockResolvedValue([]);

      const result = await service.findAll("user-1", ["acc-1", "acc-2"]);

      expect(result.startingBalance).toBeUndefined();
    });

    it("does not compute starting balance when no accounts specified", async () => {
      const mockQb = createMockQueryBuilder();
      mockQb.getManyAndCount.mockResolvedValue([[], 0]);
      transactionsRepository.createQueryBuilder.mockReturnValue(mockQb);
      investmentTxRepository.find.mockResolvedValue([]);

      const result = await service.findAll("user-1");

      expect(result.startingBalance).toBeUndefined();
    });

    it("calculates correct pagination metadata", async () => {
      const mockQb = createMockQueryBuilder();
      mockQb.getManyAndCount.mockResolvedValue([
        [
          {
            id: "tx-1",
            isCleared: false,
            isReconciled: false,
            isVoid: false,
            splits: [],
          },
          {
            id: "tx-2",
            isCleared: false,
            isReconciled: false,
            isVoid: false,
            splits: [],
          },
        ],
        100,
      ]);
      transactionsRepository.createQueryBuilder.mockReturnValue(mockQb);
      investmentTxRepository.find.mockResolvedValue([]);

      const result = await service.findAll(
        "user-1",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        2,
        10,
      );

      expect(result.pagination).toEqual({
        page: 2,
        limit: 10,
        total: 100,
        totalPages: 10,
        hasMore: true,
      });
    });

    it("sets hasMore to false on last page", async () => {
      const mockQb = createMockQueryBuilder();
      mockQb.getManyAndCount.mockResolvedValue([
        [
          {
            id: "tx-1",
            isCleared: false,
            isReconciled: false,
            isVoid: false,
            splits: [],
          },
        ],
        5,
      ]);
      transactionsRepository.createQueryBuilder.mockReturnValue(mockQb);
      investmentTxRepository.find.mockResolvedValue([]);

      const result = await service.findAll(
        "user-1",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        1,
        10,
      );

      expect(result.pagination.hasMore).toBe(false);
    });

    it("calculates page from targetTransactionId", async () => {
      // The main query
      const mockQb = createMockQueryBuilder();
      mockQb.getManyAndCount.mockResolvedValue([[], 0]);

      // The count query for target transaction page calculation
      const countQb = createMockQueryBuilder();
      countQb.getCount.mockResolvedValue(75); // 75 transactions come before

      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(mockQb) // main query
        .mockReturnValueOnce(countQb); // count query

      transactionsRepository.findOne.mockResolvedValue({
        id: "target-tx",
        userId: "user-1",
        transactionDate: "2026-01-15",
        createdAt: new Date("2026-01-15T10:00:00Z"),
      });

      investmentTxRepository.find.mockResolvedValue([]);

      const result = await service.findAll(
        "user-1",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        1,
        50,
        false,
        undefined,
        "target-tx",
      );

      // 75 transactions before / 50 per page + 1 = page 2
      expect(result.pagination.page).toBe(2);
    });

    it("falls back to requested page when targetTransactionId is not found", async () => {
      const mockQb = createMockQueryBuilder();
      mockQb.getManyAndCount.mockResolvedValue([[], 0]);
      transactionsRepository.createQueryBuilder.mockReturnValue(mockQb);
      transactionsRepository.findOne.mockResolvedValue(null);
      investmentTxRepository.find.mockResolvedValue([]);

      const result = await service.findAll(
        "user-1",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        3,
        50,
        false,
        undefined,
        "nonexistent-tx",
      );

      expect(result.pagination.page).toBe(3);
    });

    it("applies account + date + payee + search filters in count query for targetTransactionId", async () => {
      const mockQb = createMockQueryBuilder();
      mockQb.getManyAndCount.mockResolvedValue([[], 0]);

      const countQb = createMockQueryBuilder();
      countQb.getCount.mockResolvedValue(0);

      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(mockQb)
        .mockReturnValueOnce(countQb);

      transactionsRepository.findOne.mockResolvedValue({
        id: "target-tx",
        userId: "user-1",
        transactionDate: "2026-01-15",
        createdAt: new Date("2026-01-15T10:00:00Z"),
      });

      investmentTxRepository.find.mockResolvedValue([]);

      await service.findAll(
        "user-1",
        ["acc-1"],
        "2026-01-01",
        "2026-12-31",
        undefined,
        ["payee-1"],
        1,
        50,
        false,
        "term",
        "target-tx",
      );

      // Count query should have the same filters
      expect(countQb.andWhere).toHaveBeenCalledWith(
        "t.accountId IN (:...accountIds)",
        { accountIds: ["acc-1"] },
      );
      expect(countQb.andWhere).toHaveBeenCalledWith(
        "t.transactionDate >= :startDate",
        { startDate: "2026-01-01" },
      );
      expect(countQb.andWhere).toHaveBeenCalledWith(
        "t.transactionDate <= :endDate",
        { endDate: "2026-12-31" },
      );
      expect(countQb.andWhere).toHaveBeenCalledWith(
        "t.payeeId IN (:...payeeIds)",
        { payeeIds: ["payee-1"] },
      );
    });
  });

  describe("getReconciliationData", () => {
    const createMockQueryBuilder = (overrides?: Record<string, jest.Mock>) => {
      const mockQb: Record<string, jest.Mock> = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        leftJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        setParameter: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
        getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
        getCount: jest.fn().mockResolvedValue(0),
        getRawMany: jest.fn().mockResolvedValue([]),
        getRawOne: jest.fn().mockResolvedValue(null),
        getQuery: jest.fn().mockReturnValue("SELECT 1"),
        getParameters: jest.fn().mockReturnValue({}),
        limit: jest.fn().mockReturnThis(),
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 0 }),
        ...overrides,
      };
      return mockQb;
    };

    it("returns unreconciled transactions and calculates balances", async () => {
      const account = { ...mockAccount, openingBalance: 500 };
      accountsService.findOne.mockResolvedValue(account);

      const unreconciledTx = {
        id: "tx-1",
        userId: "user-1",
        accountId: "account-1",
        amount: -100,
        status: TransactionStatus.CLEARED,
      };

      const txQb = createMockQueryBuilder();
      txQb.getMany.mockResolvedValue([unreconciledTx]);

      const reconciledQb = createMockQueryBuilder();
      reconciledQb.getRawOne.mockResolvedValue({ sum: 200 });

      const clearedQb = createMockQueryBuilder();
      clearedQb.getRawOne.mockResolvedValue({ sum: -50 });

      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(txQb) // unreconciled transactions query
        .mockReturnValueOnce(reconciledQb) // reconciled sum query
        .mockReturnValueOnce(clearedQb); // cleared sum query

      const result = await service.getReconciliationData(
        "user-1",
        "account-1",
        "2026-01-31",
        750,
      );

      expect(result.transactions).toEqual([unreconciledTx]);
      // reconciledBalance = openingBalance + reconciledSum = 500 + 200 = 700
      expect(result.reconciledBalance).toBe(700);
      // clearedBalance = reconciledBalance + clearedSum = 700 + (-50) = 650
      expect(result.clearedBalance).toBe(650);
      // difference = statementBalance - clearedBalance = 750 - 650 = 100
      expect(result.difference).toBe(100);
    });

    it("handles zero reconciled and cleared sums", async () => {
      accountsService.findOne.mockResolvedValue({
        ...mockAccount,
        openingBalance: 0,
      });

      const txQb = createMockQueryBuilder();
      txQb.getMany.mockResolvedValue([]);

      const reconciledQb = createMockQueryBuilder();
      reconciledQb.getRawOne.mockResolvedValue({ sum: null });

      const clearedQb = createMockQueryBuilder();
      clearedQb.getRawOne.mockResolvedValue({ sum: null });

      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(txQb)
        .mockReturnValueOnce(reconciledQb)
        .mockReturnValueOnce(clearedQb);

      const result = await service.getReconciliationData(
        "user-1",
        "account-1",
        "2026-01-31",
        100,
      );

      expect(result.reconciledBalance).toBe(0);
      expect(result.clearedBalance).toBe(0);
      expect(result.difference).toBe(100);
    });

    it("verifies account ownership", async () => {
      accountsService.findOne.mockResolvedValue(mockAccount);

      const txQb = createMockQueryBuilder();
      const reconciledQb = createMockQueryBuilder();
      reconciledQb.getRawOne.mockResolvedValue({ sum: null });
      const clearedQb = createMockQueryBuilder();
      clearedQb.getRawOne.mockResolvedValue({ sum: null });

      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(txQb)
        .mockReturnValueOnce(reconciledQb)
        .mockReturnValueOnce(clearedQb);

      await service.getReconciliationData(
        "user-1",
        "account-1",
        "2026-01-31",
        0,
      );

      expect(accountsService.findOne).toHaveBeenCalledWith(
        "user-1",
        "account-1",
      );
    });

    it("filters transactions up to statement date", async () => {
      accountsService.findOne.mockResolvedValue(mockAccount);

      const txQb = createMockQueryBuilder();
      const reconciledQb = createMockQueryBuilder();
      reconciledQb.getRawOne.mockResolvedValue({ sum: null });
      const clearedQb = createMockQueryBuilder();
      clearedQb.getRawOne.mockResolvedValue({ sum: null });

      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(txQb)
        .mockReturnValueOnce(reconciledQb)
        .mockReturnValueOnce(clearedQb);

      await service.getReconciliationData(
        "user-1",
        "account-1",
        "2026-02-15",
        0,
      );

      expect(txQb.andWhere).toHaveBeenCalledWith(
        "transaction.transactionDate <= :statementDate",
        { statementDate: "2026-02-15" },
      );
    });
  });

  describe("bulkReconcile", () => {
    const createMockQueryBuilder = (overrides?: Record<string, jest.Mock>) => {
      const mockQb: Record<string, jest.Mock> = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        leftJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        setParameter: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
        getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
        getCount: jest.fn().mockResolvedValue(0),
        getRawMany: jest.fn().mockResolvedValue([]),
        getRawOne: jest.fn().mockResolvedValue(null),
        getQuery: jest.fn().mockReturnValue("SELECT 1"),
        getParameters: jest.fn().mockReturnValue({}),
        limit: jest.fn().mockReturnThis(),
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 2 }),
        ...overrides,
      };
      return mockQb;
    };

    it("returns 0 for empty transaction IDs", async () => {
      const result = await service.bulkReconcile(
        "user-1",
        "account-1",
        [],
        "2026-01-31",
      );

      expect(result).toEqual({ reconciled: 0 });
    });

    it("throws when some transactions are not found", async () => {
      const verifyQb = createMockQueryBuilder();
      verifyQb.getMany.mockResolvedValue([
        { id: "tx-1", userId: "user-1", accountId: "account-1" },
      ]);

      transactionsRepository.createQueryBuilder.mockReturnValue(verifyQb);

      await expect(
        service.bulkReconcile(
          "user-1",
          "account-1",
          ["tx-1", "tx-2"],
          "2026-01-31",
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it("reconciles all specified transactions", async () => {
      const verifyQb = createMockQueryBuilder();
      verifyQb.getMany.mockResolvedValue([
        { id: "tx-1", userId: "user-1", accountId: "account-1" },
        { id: "tx-2", userId: "user-1", accountId: "account-1" },
      ]);

      const updateQb = createMockQueryBuilder();
      updateQb.execute.mockResolvedValue({ affected: 2 });

      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(verifyQb) // verification query
        .mockReturnValueOnce(updateQb); // update query

      const result = await service.bulkReconcile(
        "user-1",
        "account-1",
        ["tx-1", "tx-2"],
        "2026-01-31",
      );

      expect(result).toEqual({ reconciled: 2 });
      expect(accountsService.findOne).toHaveBeenCalledWith(
        "user-1",
        "account-1",
      );
    });
  });

  describe("getSummary", () => {
    const createMockQueryBuilder = (overrides?: Record<string, jest.Mock>) => {
      const mockQb: Record<string, jest.Mock> = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        leftJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        setParameter: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
        getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
        getCount: jest.fn().mockResolvedValue(0),
        getRawMany: jest.fn().mockResolvedValue([]),
        getRawOne: jest.fn().mockResolvedValue(null),
        getQuery: jest.fn().mockReturnValue("SELECT 1"),
        getParameters: jest.fn().mockReturnValue({}),
        limit: jest.fn().mockReturnThis(),
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 0 }),
        ...overrides,
      };
      return mockQb;
    };

    it("returns aggregated summary by currency", async () => {
      const mockQb = createMockQueryBuilder();
      mockQb.getRawMany.mockResolvedValue([
        {
          currencyCode: "USD",
          totalIncome: "500",
          totalExpenses: "200",
          transactionCount: "10",
        },
        {
          currencyCode: "CAD",
          totalIncome: "300",
          totalExpenses: "100",
          transactionCount: "5",
        },
      ]);
      transactionsRepository.createQueryBuilder.mockReturnValue(mockQb);

      const result = await service.getSummary("user-1");

      expect(result.totalIncome).toBe(800);
      expect(result.totalExpenses).toBe(300);
      expect(result.netCashFlow).toBe(500);
      expect(result.transactionCount).toBe(15);
      expect(result.byCurrency.USD).toEqual({
        totalIncome: 500,
        totalExpenses: 200,
        netCashFlow: 300,
        transactionCount: 10,
      });
      expect(result.byCurrency.CAD).toEqual({
        totalIncome: 300,
        totalExpenses: 100,
        netCashFlow: 200,
        transactionCount: 5,
      });
    });

    it("returns zeros for no transactions", async () => {
      const mockQb = createMockQueryBuilder();
      mockQb.getRawMany.mockResolvedValue([]);
      transactionsRepository.createQueryBuilder.mockReturnValue(mockQb);

      const result = await service.getSummary("user-1");

      expect(result.totalIncome).toBe(0);
      expect(result.totalExpenses).toBe(0);
      expect(result.netCashFlow).toBe(0);
      expect(result.transactionCount).toBe(0);
      expect(result.byCurrency).toEqual({});
    });

    it("filters by accountIds", async () => {
      const mockQb = createMockQueryBuilder();
      mockQb.getRawMany.mockResolvedValue([]);
      transactionsRepository.createQueryBuilder.mockReturnValue(mockQb);

      await service.getSummary("user-1", ["acc-1"]);

      expect(mockQb.andWhere).toHaveBeenCalledWith(
        "transaction.accountId IN (:...accountIds)",
        { accountIds: ["acc-1"] },
      );
    });

    it("filters by date range", async () => {
      const mockQb = createMockQueryBuilder();
      mockQb.getRawMany.mockResolvedValue([]);
      transactionsRepository.createQueryBuilder.mockReturnValue(mockQb);

      await service.getSummary("user-1", undefined, "2026-01-01", "2026-06-30");

      expect(mockQb.andWhere).toHaveBeenCalledWith(
        "transaction.transactionDate >= :startDate",
        { startDate: "2026-01-01" },
      );
      expect(mockQb.andWhere).toHaveBeenCalledWith(
        "transaction.transactionDate <= :endDate",
        { endDate: "2026-06-30" },
      );
    });

    it("handles 'uncategorized' category filter with account join", async () => {
      const mockQb = createMockQueryBuilder();
      mockQb.getRawMany.mockResolvedValue([]);
      transactionsRepository.createQueryBuilder.mockReturnValue(mockQb);

      await service.getSummary("user-1", undefined, undefined, undefined, [
        "uncategorized",
      ]);

      expect(mockQb.leftJoin).toHaveBeenCalledWith(
        "transaction.account",
        "summaryAccount",
      );
      expect(mockQb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining("transaction.categoryId IS NULL"),
      );
    });

    it("handles 'transfer' category filter", async () => {
      const mockQb = createMockQueryBuilder();
      mockQb.getRawMany.mockResolvedValue([]);
      transactionsRepository.createQueryBuilder.mockReturnValue(mockQb);

      await service.getSummary("user-1", undefined, undefined, undefined, [
        "transfer",
      ]);

      expect(mockQb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining("transaction.isTransfer = true"),
      );
    });

    it("handles regular category filter with children and joins splits", async () => {
      const mockQb = createMockQueryBuilder();
      mockQb.getRawMany.mockResolvedValue([]);
      transactionsRepository.createQueryBuilder.mockReturnValue(mockQb);
      categoriesRepository.find.mockResolvedValue([
        { id: "cat-1", parentId: null },
        { id: "cat-child", parentId: "cat-1" },
      ]);

      await service.getSummary("user-1", undefined, undefined, undefined, [
        "cat-1",
      ]);

      expect(mockQb.leftJoin).toHaveBeenCalledWith(
        "transaction.splits",
        "splits",
      );
      expect(mockQb.setParameter).toHaveBeenCalledWith(
        "summaryCategoryIds",
        expect.arrayContaining(["cat-1", "cat-child"]),
      );
    });

    it("filters by payeeIds", async () => {
      const mockQb = createMockQueryBuilder();
      mockQb.getRawMany.mockResolvedValue([]);
      transactionsRepository.createQueryBuilder.mockReturnValue(mockQb);

      await service.getSummary(
        "user-1",
        undefined,
        undefined,
        undefined,
        undefined,
        ["payee-1"],
      );

      expect(mockQb.andWhere).toHaveBeenCalledWith(
        "transaction.payeeId IN (:...payeeIds)",
        { payeeIds: ["payee-1"] },
      );
    });

    it("filters by search and joins splits when no category filter", async () => {
      const mockQb = createMockQueryBuilder();
      mockQb.getRawMany.mockResolvedValue([]);
      transactionsRepository.createQueryBuilder.mockReturnValue(mockQb);

      await service.getSummary(
        "user-1",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "test search",
      );

      expect(mockQb.leftJoin).toHaveBeenCalledWith(
        "transaction.splits",
        "splits",
      );
      expect(mockQb.andWhere).toHaveBeenCalledWith(
        "(transaction.description ILIKE :search OR transaction.payeeName ILIKE :search OR splits.memo ILIKE :search)",
        { search: "%test search%" },
      );
    });

    it("skips null currencyCode rows", async () => {
      const mockQb = createMockQueryBuilder();
      mockQb.getRawMany.mockResolvedValue([
        {
          currencyCode: null,
          totalIncome: "100",
          totalExpenses: "50",
          transactionCount: "3",
        },
      ]);
      transactionsRepository.createQueryBuilder.mockReturnValue(mockQb);

      const result = await service.getSummary("user-1");

      expect(result.totalIncome).toBe(100);
      expect(result.totalExpenses).toBe(50);
      expect(result.byCurrency).toEqual({});
    });
  });

  describe("getSplits", () => {
    it("returns splits for a transaction", async () => {
      const mockTx = {
        id: "tx-1",
        userId: "user-1",
        splits: [],
      };
      transactionsRepository.findOne.mockResolvedValue(mockTx);

      const mockSplits = [
        {
          id: "split-1",
          transactionId: "tx-1",
          amount: -60,
          categoryId: "cat-1",
        },
        {
          id: "split-2",
          transactionId: "tx-1",
          amount: -40,
          categoryId: "cat-2",
        },
      ];
      splitsRepository.find.mockResolvedValue(mockSplits);

      const result = await service.getSplits("user-1", "tx-1");

      expect(result).toEqual(mockSplits);
      expect(splitsRepository.find).toHaveBeenCalledWith({
        where: { transactionId: "tx-1" },
        relations: ["category", "transferAccount"],
        order: { createdAt: "ASC" },
      });
    });

    it("verifies user access before returning splits", async () => {
      transactionsRepository.findOne.mockResolvedValue(null);

      await expect(service.getSplits("user-1", "tx-1")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("updateSplits", () => {
    it("validates, deletes old splits, and creates new ones", async () => {
      const mockTx = {
        id: "tx-1",
        userId: "user-1",
        accountId: "account-1",
        amount: -100,
        transactionDate: "2026-01-15",
        payeeName: "Store",
        splits: [],
      };
      transactionsRepository.findOne.mockResolvedValue(mockTx);
      splitsRepository.find.mockResolvedValue([]); // deleteTransferSplitLinkedTransactions finds none
      splitsRepository.save.mockImplementation((data) => ({
        ...data,
        id: `split-${Math.random().toString(36).slice(2, 8)}`,
      }));

      const newSplits = [
        { amount: -60, categoryId: "cat-1" },
        { amount: -40, categoryId: "cat-2" },
      ];

      await service.updateSplits("user-1", "tx-1", newSplits as any);

      expect(splitsRepository.delete).toHaveBeenCalledWith({
        transactionId: "tx-1",
      });
      expect(splitsRepository.create).toHaveBeenCalledTimes(2);
      expect(transactionsRepository.update).toHaveBeenCalledWith("tx-1", {
        isSplit: true,
        categoryId: null,
      });
    });

    it("rejects splits that do not sum to transaction amount", async () => {
      const mockTx = {
        id: "tx-1",
        userId: "user-1",
        amount: -100,
        splits: [],
      };
      transactionsRepository.findOne.mockResolvedValue(mockTx);

      await expect(
        service.updateSplits("user-1", "tx-1", [
          { amount: -30, categoryId: "cat-1" },
          { amount: -30, categoryId: "cat-2" },
        ] as any),
      ).rejects.toThrow("Split amounts");
    });

    it("cleans up linked transactions from old transfer splits", async () => {
      const mockTx = {
        id: "tx-1",
        userId: "user-1",
        accountId: "account-1",
        amount: -100,
        transactionDate: "2026-01-15",
        payeeName: null,
        splits: [],
      };
      transactionsRepository.findOne.mockResolvedValue(mockTx);

      // Old transfer split with linked transaction
      const oldLinkedTx = {
        id: "linked-tx-old",
        accountId: "account-2",
        amount: 60,
      };
      splitsRepository.find.mockResolvedValue([
        {
          id: "old-split",
          transactionId: "tx-1",
          linkedTransactionId: "linked-tx-old",
          transferAccountId: "account-2",
        },
      ]);
      transactionsRepository.findOne
        .mockResolvedValueOnce(mockTx) // findOne for the transaction
        .mockResolvedValueOnce(oldLinkedTx); // findOne for linked tx in deleteTransferSplitLinkedTransactions

      splitsRepository.save.mockImplementation((data) => ({
        ...data,
        id: "new-split-1",
      }));

      await service.updateSplits("user-1", "tx-1", [
        { amount: -60, categoryId: "cat-1" },
        { amount: -40, categoryId: "cat-2" },
      ] as any);

      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "account-2",
        -60,
      );
      expect(transactionsRepository.remove).toHaveBeenCalledWith(oldLinkedTx);
    });
  });

  describe("addSplit", () => {
    it("adds a split to a transaction", async () => {
      const mockTx = {
        id: "tx-1",
        userId: "user-1",
        accountId: "account-1",
        amount: -100,
        transactionDate: "2026-01-15",
        payeeName: "Store",
        isSplit: true,
        splits: [],
      };
      transactionsRepository.findOne.mockResolvedValue(mockTx);

      const existingSplits = [
        { id: "split-1", amount: -60, transactionId: "tx-1" },
      ];
      splitsRepository.find.mockResolvedValue(existingSplits);

      const savedSplit = {
        id: "split-new",
        transactionId: "tx-1",
        amount: -40,
        categoryId: "cat-2",
      };
      splitsRepository.save.mockResolvedValue(savedSplit);
      splitsRepository.findOne.mockResolvedValue({
        ...savedSplit,
        category: { id: "cat-2", name: "Groceries" },
      });

      const result = await service.addSplit("user-1", "tx-1", {
        amount: -40,
        categoryId: "cat-2",
      } as any);

      expect(result.id).toBe("split-new");
      expect(splitsRepository.save).toHaveBeenCalled();
    });

    it("throws when adding split would exceed transaction amount", async () => {
      const mockTx = {
        id: "tx-1",
        userId: "user-1",
        amount: -100,
        splits: [],
      };
      transactionsRepository.findOne.mockResolvedValue(mockTx);

      // Existing splits sum to -90
      splitsRepository.find.mockResolvedValue([
        { id: "split-1", amount: -90, transactionId: "tx-1" },
      ]);

      await expect(
        service.addSplit("user-1", "tx-1", {
          amount: -20,
          categoryId: "cat-1",
        } as any),
      ).rejects.toThrow(
        "Adding this split would exceed the transaction amount",
      );
    });

    it("creates linked transaction for transfer splits", async () => {
      const mockTx = {
        id: "tx-1",
        userId: "user-1",
        accountId: "account-1",
        amount: -100,
        transactionDate: "2026-01-15",
        payeeName: null,
        isSplit: true,
        splits: [],
      };
      transactionsRepository.findOne.mockResolvedValue(mockTx);

      const existingSplits = [
        { id: "split-1", amount: -60, transactionId: "tx-1" },
      ];
      splitsRepository.find.mockResolvedValue(existingSplits);

      const savedSplit = {
        id: "split-new",
        transactionId: "tx-1",
        amount: -40,
      };
      splitsRepository.save.mockResolvedValue(savedSplit);

      const linkedTx = { id: "linked-tx-1" };
      transactionsRepository.save.mockResolvedValue(linkedTx);
      transactionsRepository.create.mockReturnValue(linkedTx);

      const targetAccount = {
        ...mockAccount,
        id: "account-2",
        name: "Savings",
        currencyCode: "USD",
      };
      const sourceAccount = {
        ...mockAccount,
        id: "account-1",
        name: "Checking",
      };
      accountsService.findOne
        .mockResolvedValueOnce(mockTx) // findOne for the main tx
        .mockResolvedValueOnce(targetAccount)
        .mockResolvedValueOnce(sourceAccount);

      splitsRepository.findOne.mockResolvedValue({
        ...savedSplit,
        linkedTransactionId: "linked-tx-1",
        transferAccount: targetAccount,
      });

      await service.addSplit("user-1", "tx-1", {
        amount: -40,
        transferAccountId: "account-2",
      } as any);

      expect(transactionsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: "account-2",
          amount: 40,
          isTransfer: true,
        }),
      );
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "account-2",
        40,
      );
      expect(splitsRepository.update).toHaveBeenCalledWith("split-new", {
        linkedTransactionId: "linked-tx-1",
      });
    });

    it("marks transaction as split when reaching 2+ splits", async () => {
      const mockTx = {
        id: "tx-1",
        userId: "user-1",
        accountId: "account-1",
        amount: -100,
        isSplit: false,
        splits: [],
      };
      transactionsRepository.findOne.mockResolvedValue(mockTx);

      // One existing split
      splitsRepository.find.mockResolvedValue([
        { id: "split-1", amount: -60, transactionId: "tx-1" },
      ]);

      const savedSplit = {
        id: "split-new",
        transactionId: "tx-1",
        amount: -40,
      };
      splitsRepository.save.mockResolvedValue(savedSplit);
      splitsRepository.findOne.mockResolvedValue({
        ...savedSplit,
        category: null,
      });

      await service.addSplit("user-1", "tx-1", {
        amount: -40,
        categoryId: "cat-2",
      } as any);

      expect(transactionsRepository.update).toHaveBeenCalledWith("tx-1", {
        isSplit: true,
        categoryId: null,
      });
    });

    it("does not mark as split if already marked", async () => {
      const mockTx = {
        id: "tx-1",
        userId: "user-1",
        accountId: "account-1",
        amount: -100,
        isSplit: true,
        splits: [],
      };
      transactionsRepository.findOne.mockResolvedValue(mockTx);

      // Already 2 splits, adding a third
      splitsRepository.find.mockResolvedValue([
        { id: "split-1", amount: -40, transactionId: "tx-1" },
        { id: "split-2", amount: -30, transactionId: "tx-1" },
      ]);

      const savedSplit = {
        id: "split-new",
        transactionId: "tx-1",
        amount: -30,
      };
      splitsRepository.save.mockResolvedValue(savedSplit);
      splitsRepository.findOne.mockResolvedValue({
        ...savedSplit,
        category: null,
      });

      await service.addSplit("user-1", "tx-1", {
        amount: -30,
        categoryId: "cat-3",
      } as any);

      // Should not call update to set isSplit since it's already true
      const updateCalls = transactionsRepository.update.mock.calls.filter(
        (call: any[]) => call[1]?.isSplit !== undefined,
      );
      expect(updateCalls.length).toBe(0);
    });
  });

  describe("removeSplit", () => {
    it("removes a split from a transaction", async () => {
      const mockTx = {
        id: "tx-1",
        userId: "user-1",
        accountId: "account-1",
        amount: -100,
        isSplit: true,
        splits: [],
      };
      transactionsRepository.findOne.mockResolvedValue(mockTx);

      const splitToRemove = {
        id: "split-1",
        transactionId: "tx-1",
        amount: -30,
        linkedTransactionId: null,
        transferAccountId: null,
      };
      splitsRepository.findOne.mockResolvedValueOnce(splitToRemove);

      // After removal, 2 splits remain - stays as split
      const remainingSplits = [
        { id: "split-2", amount: -40 },
        { id: "split-3", amount: -30 },
      ];
      splitsRepository.find.mockResolvedValue(remainingSplits);

      await service.removeSplit("user-1", "tx-1", "split-1");

      expect(splitsRepository.remove).toHaveBeenCalledWith(splitToRemove);
    });

    it("throws when split not found", async () => {
      transactionsRepository.findOne.mockResolvedValue({
        id: "tx-1",
        userId: "user-1",
        splits: [],
      });
      splitsRepository.findOne.mockResolvedValue(null);

      await expect(
        service.removeSplit("user-1", "tx-1", "nonexistent"),
      ).rejects.toThrow(NotFoundException);
    });

    it("cleans up linked transaction when removing transfer split", async () => {
      const mockTx = {
        id: "tx-1",
        userId: "user-1",
        isSplit: true,
        splits: [],
      };
      transactionsRepository.findOne.mockResolvedValue(mockTx);

      const linkedTx = {
        id: "linked-tx-1",
        accountId: "account-2",
        amount: 40,
      };

      const splitToRemove = {
        id: "split-1",
        transactionId: "tx-1",
        amount: -40,
        linkedTransactionId: "linked-tx-1",
        transferAccountId: "account-2",
      };
      splitsRepository.findOne.mockResolvedValueOnce(splitToRemove);

      transactionsRepository.findOne
        .mockResolvedValueOnce(mockTx) // findOne for access check
        .mockResolvedValueOnce(linkedTx); // findOne for linked tx cleanup

      // After removal, still 2 remaining
      splitsRepository.find.mockResolvedValue([
        { id: "split-2", amount: -30 },
        { id: "split-3", amount: -30 },
      ]);

      await service.removeSplit("user-1", "tx-1", "split-1");

      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "account-2",
        -40,
      );
      expect(transactionsRepository.remove).toHaveBeenCalledWith(linkedTx);
    });

    it("converts to simple transaction when fewer than 2 splits remain (1 left)", async () => {
      const mockTx = {
        id: "tx-1",
        userId: "user-1",
        isSplit: true,
        splits: [],
      };
      transactionsRepository.findOne.mockResolvedValue(mockTx);

      const splitToRemove = {
        id: "split-1",
        transactionId: "tx-1",
        amount: -50,
        linkedTransactionId: null,
        transferAccountId: null,
      };
      splitsRepository.findOne.mockResolvedValueOnce(splitToRemove);

      // After removal, only 1 split remains
      const lastSplit = {
        id: "split-2",
        transactionId: "tx-1",
        amount: -50,
        categoryId: "cat-1",
        linkedTransactionId: null,
        transferAccountId: null,
      };
      splitsRepository.find.mockResolvedValue([lastSplit]);

      await service.removeSplit("user-1", "tx-1", "split-1");

      expect(transactionsRepository.update).toHaveBeenCalledWith("tx-1", {
        isSplit: false,
        categoryId: "cat-1",
      });
      expect(splitsRepository.remove).toHaveBeenCalledWith(lastSplit);
    });

    it("converts back to simple when 0 splits remain", async () => {
      const mockTx = {
        id: "tx-1",
        userId: "user-1",
        isSplit: true,
        splits: [],
      };
      transactionsRepository.findOne.mockResolvedValue(mockTx);

      const splitToRemove = {
        id: "split-1",
        transactionId: "tx-1",
        amount: -100,
        linkedTransactionId: null,
        transferAccountId: null,
      };
      splitsRepository.findOne.mockResolvedValueOnce(splitToRemove);

      // After removal, 0 splits remain
      splitsRepository.find.mockResolvedValue([]);

      await service.removeSplit("user-1", "tx-1", "split-1");

      expect(transactionsRepository.update).toHaveBeenCalledWith("tx-1", {
        isSplit: false,
      });
    });

    it("cleans up linked transaction of last remaining transfer split", async () => {
      const mockTx = {
        id: "tx-1",
        userId: "user-1",
        isSplit: true,
        splits: [],
      };

      const splitToRemove = {
        id: "split-1",
        transactionId: "tx-1",
        amount: -50,
        linkedTransactionId: null,
        transferAccountId: null,
      };
      splitsRepository.findOne.mockResolvedValueOnce(splitToRemove);

      const lastSplitLinkedTx = {
        id: "linked-tx-last",
        accountId: "account-2",
        amount: 50,
      };

      // After removal, 1 transfer split remains
      const lastSplit = {
        id: "split-2",
        transactionId: "tx-1",
        amount: -50,
        categoryId: null,
        linkedTransactionId: "linked-tx-last",
        transferAccountId: "account-2",
      };
      splitsRepository.find.mockResolvedValue([lastSplit]);

      // transactionsRepository.findOne is called:
      // 1. findOne for access check (removeSplit -> findOne)
      // 2. findOne for linked tx of last split
      transactionsRepository.findOne
        .mockResolvedValueOnce(mockTx) // removeSplit -> findOne
        .mockResolvedValueOnce(lastSplitLinkedTx); // linked tx of last split

      await service.removeSplit("user-1", "tx-1", "split-1");

      // Should clean up the linked transaction of the last remaining transfer split
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "account-2",
        -50,
      );
      expect(transactionsRepository.remove).toHaveBeenCalledWith(
        lastSplitLinkedTx,
      );
      expect(transactionsRepository.update).toHaveBeenCalledWith("tx-1", {
        isSplit: false,
        categoryId: null, // Will be null since it was a transfer split
      });
    });
  });

  describe("update with splits", () => {
    const mockTx = {
      id: "tx-1",
      userId: "user-1",
      accountId: "account-1",
      amount: -100,
      status: TransactionStatus.UNRECONCILED,
      isSplit: false,
      transactionDate: "2026-01-15",
      payeeName: null,
      splits: [],
    };

    it("creates splits when providing new splits array", async () => {
      transactionsRepository.findOne.mockResolvedValue({ ...mockTx });
      splitsRepository.find.mockResolvedValue([]); // deleteTransferSplitLinkedTransactions
      splitsRepository.save.mockImplementation((data) => ({
        ...data,
        id: `split-${Math.random().toString(36).slice(2, 8)}`,
      }));

      await service.update("user-1", "tx-1", {
        splits: [
          { amount: -60, categoryId: "cat-1" },
          { amount: -40, categoryId: "cat-2" },
        ],
      } as any);

      expect(splitsRepository.delete).toHaveBeenCalledWith({
        transactionId: "tx-1",
      });
      expect(splitsRepository.create).toHaveBeenCalledTimes(2);
      expect(transactionsRepository.update).toHaveBeenCalledWith(
        "tx-1",
        expect.objectContaining({
          isSplit: true,
          categoryId: null,
        }),
      );
    });

    it("converts back to simple when providing empty splits array", async () => {
      transactionsRepository.findOne.mockResolvedValue({
        ...mockTx,
        isSplit: true,
      });
      splitsRepository.find.mockResolvedValue([]); // deleteTransferSplitLinkedTransactions

      await service.update("user-1", "tx-1", {
        splits: [],
      } as any);

      expect(splitsRepository.delete).toHaveBeenCalledWith({
        transactionId: "tx-1",
      });
      expect(transactionsRepository.update).toHaveBeenCalledWith(
        "tx-1",
        expect.objectContaining({ isSplit: false }),
      );
    });
  });

  describe("update with account change", () => {
    it("adjusts both old and new account balances", async () => {
      const mockTx = {
        id: "tx-1",
        userId: "user-1",
        accountId: "account-1",
        amount: -50,
        status: TransactionStatus.UNRECONCILED,
        isSplit: false,
        splits: [],
      };

      // First findOne: get existing transaction
      // Second findOne: return updated transaction (new account)
      transactionsRepository.findOne
        .mockResolvedValueOnce({ ...mockTx })
        .mockResolvedValueOnce({
          ...mockTx,
          accountId: "account-2",
          amount: -50,
        });

      const newAccount = { ...mockAccount, id: "account-2", name: "Savings" };
      accountsService.findOne
        .mockResolvedValueOnce(mockAccount) // verify old account
        .mockResolvedValueOnce(newAccount); // verify new account

      await service.update("user-1", "tx-1", {
        accountId: "account-2",
      } as any);

      // Should remove amount from old account and add to new account
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "account-1",
        50,
      ); // remove from old
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "account-2",
        -50,
      ); // add to new
    });
  });

  describe("updateTransfer", () => {
    const fromTx = {
      id: "tx-from",
      userId: "user-1",
      accountId: "account-1",
      amount: -200,
      status: TransactionStatus.UNRECONCILED,
      isTransfer: true,
      linkedTransactionId: "tx-to",
      exchangeRate: 1,
      account: { ...mockAccount, id: "account-1", name: "Checking" },
      splits: [],
    };
    const toTx = {
      id: "tx-to",
      userId: "user-1",
      accountId: "account-2",
      amount: 200,
      status: TransactionStatus.UNRECONCILED,
      isTransfer: true,
      linkedTransactionId: "tx-from",
      exchangeRate: 1,
      account: { ...mockAccount, id: "account-2", name: "Savings" },
      splits: [],
    };

    it("throws when transaction is not a transfer", async () => {
      transactionsRepository.findOne.mockResolvedValue({
        id: "tx-1",
        userId: "user-1",
        isTransfer: false,
        linkedTransactionId: null,
        splits: [],
      });

      await expect(
        service.updateTransfer("user-1", "tx-1", { amount: 300 }),
      ).rejects.toThrow("Transaction is not a transfer");
    });

    it("throws when source and destination are the same", async () => {
      transactionsRepository.findOne
        .mockResolvedValueOnce({ ...fromTx })
        .mockResolvedValueOnce({ ...toTx });

      await expect(
        service.updateTransfer("user-1", "tx-from", {
          fromAccountId: "account-1",
          toAccountId: "account-1",
        }),
      ).rejects.toThrow("Source and destination accounts must be different");
    });

    it("updates amount and adjusts balances", async () => {
      // findOne returns from and to transactions for main query
      // Then returns again for the result
      transactionsRepository.findOne
        .mockResolvedValueOnce({ ...fromTx })
        .mockResolvedValueOnce({ ...toTx })
        .mockResolvedValueOnce({ ...fromTx, amount: -300 })
        .mockResolvedValueOnce({ ...toTx, amount: 300 });

      await service.updateTransfer("user-1", "tx-from", { amount: 300 });

      // Revert old balances
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "account-1",
        200,
      ); // revert -200
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "account-2",
        -200,
      ); // revert +200
      // Apply new balances
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "account-1",
        -300,
      );
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "account-2",
        300,
      );
    });

    it("updates accounts and auto-updates payee names", async () => {
      const newToAccount = {
        ...mockAccount,
        id: "account-3",
        name: "Investment",
      };

      transactionsRepository.findOne
        .mockResolvedValueOnce({ ...fromTx })
        .mockResolvedValueOnce({ ...toTx })
        .mockResolvedValueOnce({ ...fromTx })
        .mockResolvedValueOnce({ ...toTx, accountId: "account-3" });

      accountsService.findOne.mockResolvedValue(newToAccount);

      await service.updateTransfer("user-1", "tx-from", {
        toAccountId: "account-3",
      });

      // The from transaction should get updated payeeName
      expect(transactionsRepository.update).toHaveBeenCalledWith(
        "tx-from",
        expect.objectContaining({
          payeeName: "Transfer to Investment",
        }),
      );
    });

    it("updates from account and auto-updates to transaction payee name", async () => {
      const newFromAccount = {
        ...mockAccount,
        id: "account-3",
        name: "Business",
      };

      transactionsRepository.findOne
        .mockResolvedValueOnce({ ...fromTx })
        .mockResolvedValueOnce({ ...toTx })
        .mockResolvedValueOnce({ ...fromTx, accountId: "account-3" })
        .mockResolvedValueOnce({ ...toTx });

      accountsService.findOne.mockResolvedValue(newFromAccount);

      await service.updateTransfer("user-1", "tx-from", {
        fromAccountId: "account-3",
      });

      // The to transaction should get updated payeeName
      expect(transactionsRepository.update).toHaveBeenCalledWith(
        "tx-to",
        expect.objectContaining({
          payeeName: "Transfer from Business",
        }),
      );
    });

    it("handles exchange rate changes", async () => {
      transactionsRepository.findOne
        .mockResolvedValueOnce({ ...fromTx })
        .mockResolvedValueOnce({ ...toTx })
        .mockResolvedValueOnce({ ...fromTx })
        .mockResolvedValueOnce({ ...toTx, amount: 260 });

      await service.updateTransfer("user-1", "tx-from", {
        exchangeRate: 1.3,
      });

      // toAmount = 200 * 1.3 = 260
      expect(transactionsRepository.update).toHaveBeenCalledWith(
        "tx-to",
        expect.objectContaining({
          amount: 260,
          exchangeRate: 1.3,
        }),
      );
    });

    it("handles explicit toAmount override", async () => {
      transactionsRepository.findOne
        .mockResolvedValueOnce({ ...fromTx })
        .mockResolvedValueOnce({ ...toTx })
        .mockResolvedValueOnce({ ...fromTx })
        .mockResolvedValueOnce({ ...toTx, amount: 250 });

      await service.updateTransfer("user-1", "tx-from", {
        toAmount: 250,
      });

      expect(transactionsRepository.update).toHaveBeenCalledWith(
        "tx-to",
        expect.objectContaining({
          amount: 250,
        }),
      );
    });

    it("does not modify payee names when custom payeeName is provided", async () => {
      const newToAccount = {
        ...mockAccount,
        id: "account-3",
        name: "Investment",
      };

      transactionsRepository.findOne
        .mockResolvedValueOnce({ ...fromTx })
        .mockResolvedValueOnce({ ...toTx })
        .mockResolvedValueOnce({ ...fromTx })
        .mockResolvedValueOnce({ ...toTx, accountId: "account-3" });

      accountsService.findOne
        .mockResolvedValueOnce(fromTx.account)
        .mockResolvedValueOnce(toTx.account)
        .mockResolvedValueOnce(newToAccount);

      await service.updateTransfer("user-1", "tx-from", {
        toAccountId: "account-3",
        payeeName: "Custom Transfer Name",
      });

      // Should use custom name, not auto-generated
      expect(transactionsRepository.update).toHaveBeenCalledWith(
        "tx-from",
        expect.objectContaining({
          payeeName: "Custom Transfer Name",
        }),
      );
    });

    it("identifies from/to correctly when starting from the to-side transaction", async () => {
      // If we call updateTransfer with tx-to (positive amount), it should
      // correctly identify tx-to as the toTransaction and tx-from as the fromTransaction
      transactionsRepository.findOne
        .mockResolvedValueOnce({ ...toTx })
        .mockResolvedValueOnce({ ...fromTx })
        .mockResolvedValueOnce({ ...fromTx })
        .mockResolvedValueOnce({ ...toTx });

      await service.updateTransfer("user-1", "tx-to", { amount: 300 });

      // The from transaction should get updated with negative amount
      expect(transactionsRepository.update).toHaveBeenCalledWith(
        "tx-from",
        expect.objectContaining({ amount: -300 }),
      );
    });
  });

  describe("removeTransfer with parent split", () => {
    it("deletes parent transaction and all splits when removing linked transaction from split", async () => {
      const linkedTx = {
        id: "linked-tx-1",
        userId: "user-1",
        accountId: "account-2",
        amount: 40,
        isTransfer: true,
        linkedTransactionId: "tx-parent",
        splits: [],
      };

      // This is a linked transaction from a split
      const parentSplit = {
        id: "parent-split-1",
        transactionId: "tx-parent",
        linkedTransactionId: "linked-tx-1",
      };
      splitsRepository.findOne.mockResolvedValue(parentSplit);

      const parentTx = {
        id: "tx-parent",
        userId: "user-1",
        accountId: "account-1",
        amount: -100,
        status: TransactionStatus.UNRECONCILED,
      };

      const anotherLinkedTx = {
        id: "another-linked-tx",
        accountId: "account-3",
        amount: 60,
      };

      // transactionsRepository.findOne call sequence:
      // 1. findOne(userId, transactionId) -> linkedTx
      // 2. findOne({ where: { id: parentTransactionId } }) -> parentTx
      // 3. findOne({ where: { id: split.linkedTransactionId } }) for "another-linked-tx" -> anotherLinkedTx
      transactionsRepository.findOne
        .mockResolvedValueOnce(linkedTx)
        .mockResolvedValueOnce(parentTx)
        .mockResolvedValueOnce(anotherLinkedTx);

      const allSplits = [
        {
          id: "split-1",
          transactionId: "tx-parent",
          linkedTransactionId: "linked-tx-1",
          transferAccountId: "account-2",
        },
        {
          id: "split-2",
          transactionId: "tx-parent",
          linkedTransactionId: "another-linked-tx",
          transferAccountId: "account-3",
        },
      ];
      splitsRepository.find.mockResolvedValue(allSplits);

      await service.removeTransfer("user-1", "linked-tx-1");

      // Should revert balance for the other linked transaction
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "account-3",
        -60,
      );
      expect(transactionsRepository.remove).toHaveBeenCalledWith(
        anotherLinkedTx,
      );

      // Should remove all splits
      expect(splitsRepository.remove).toHaveBeenCalledWith(allSplits);

      // Should revert parent transaction balance and remove
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "account-1",
        100,
      );
      expect(transactionsRepository.remove).toHaveBeenCalledWith(parentTx);

      // Should revert the linked transaction's own balance and remove it
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "account-2",
        -40,
      );
      expect(transactionsRepository.remove).toHaveBeenCalledWith(linkedTx);
    });
  });

  describe("remove with split transaction", () => {
    it("cleans up linked transfer split transactions when removing split parent", async () => {
      const mockTx = {
        id: "tx-1",
        userId: "user-1",
        accountId: "account-1",
        amount: -100,
        status: TransactionStatus.UNRECONCILED,
        isSplit: true,
        splits: [
          {
            id: "split-1",
            linkedTransactionId: "linked-1",
            transferAccountId: "account-2",
          },
        ],
      };
      transactionsRepository.findOne.mockResolvedValueOnce(mockTx);

      // deleteTransferSplitLinkedTransactions
      const transferSplits = [
        {
          id: "split-1",
          transactionId: "tx-1",
          linkedTransactionId: "linked-1",
          transferAccountId: "account-2",
        },
      ];
      splitsRepository.find.mockResolvedValue(transferSplits);

      const linkedTx = {
        id: "linked-1",
        accountId: "account-2",
        amount: 40,
      };
      transactionsRepository.findOne.mockResolvedValueOnce(linkedTx); // linked tx lookup

      // No parent split (this is the parent itself)
      splitsRepository.findOne.mockResolvedValue(null);

      await service.remove("user-1", "tx-1");

      // Should revert linked tx balance
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "account-2",
        -40,
      );
      expect(transactionsRepository.remove).toHaveBeenCalledWith(linkedTx);

      // Should revert parent balance
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "account-1",
        100,
      );
    });
  });

  describe("remove where transaction is a linked transaction from a split", () => {
    it("deletes entire parent transaction when removing linked child", async () => {
      const childTx = {
        id: "child-tx",
        userId: "user-1",
        accountId: "account-2",
        amount: 40,
        status: TransactionStatus.UNRECONCILED,
        isSplit: false,
        splits: [],
      };
      transactionsRepository.findOne.mockResolvedValueOnce(childTx);

      // Not a split parent, so deleteTransferSplitLinkedTransactions not called for isSplit

      // This is a linked child from a split
      const parentSplit = {
        id: "parent-split",
        transactionId: "tx-parent",
        linkedTransactionId: "child-tx",
      };
      splitsRepository.findOne.mockResolvedValue(parentSplit);

      const parentTx = {
        id: "tx-parent",
        userId: "user-1",
        accountId: "account-1",
        amount: -100,
        status: TransactionStatus.UNRECONCILED,
      };

      const allSplits = [
        {
          id: "split-a",
          transactionId: "tx-parent",
          linkedTransactionId: "child-tx",
        },
        {
          id: "split-b",
          transactionId: "tx-parent",
          linkedTransactionId: "another-child-tx",
        },
      ];

      const anotherChildTx = {
        id: "another-child-tx",
        accountId: "account-3",
        amount: 60,
      };

      transactionsRepository.findOne
        .mockResolvedValueOnce(parentTx) // parent transaction
        .mockResolvedValueOnce(anotherChildTx); // other linked child

      splitsRepository.find.mockResolvedValue(allSplits);

      await service.remove("user-1", "child-tx");

      // Should clean up other linked transactions
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "account-3",
        -60,
      );
      expect(transactionsRepository.remove).toHaveBeenCalledWith(
        anotherChildTx,
      );

      // Should remove all splits
      expect(splitsRepository.remove).toHaveBeenCalledWith(allSplits);

      // Should revert parent balance and remove
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "account-1",
        100,
      );
      expect(transactionsRepository.remove).toHaveBeenCalledWith(parentTx);

      // Should also revert the child tx balance and remove it
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "account-2",
        -40,
      );
      expect(transactionsRepository.remove).toHaveBeenCalledWith(childTx);
    });

    it("does not revert parent balance if parent is VOID", async () => {
      const childTx = {
        id: "child-tx",
        userId: "user-1",
        accountId: "account-2",
        amount: 40,
        status: TransactionStatus.UNRECONCILED,
        isSplit: false,
        splits: [],
      };
      transactionsRepository.findOne.mockResolvedValueOnce(childTx);

      const parentSplit = {
        id: "parent-split",
        transactionId: "tx-parent",
        linkedTransactionId: "child-tx",
      };
      splitsRepository.findOne.mockResolvedValue(parentSplit);

      const parentTx = {
        id: "tx-parent",
        userId: "user-1",
        accountId: "account-1",
        amount: -100,
        status: TransactionStatus.VOID,
      };
      transactionsRepository.findOne.mockResolvedValueOnce(parentTx);

      splitsRepository.find.mockResolvedValue([
        {
          id: "split-a",
          transactionId: "tx-parent",
          linkedTransactionId: "child-tx",
        },
      ]);

      await service.remove("user-1", "child-tx");

      // Should NOT revert parent balance because it's VOID
      const balanceCalls = accountsService.updateBalance.mock.calls;
      const parentRevertCall = balanceCalls.find(
        (call: any[]) => call[0] === "account-1" && call[1] === 100,
      );
      expect(parentRevertCall).toBeUndefined();
    });
  });

  describe("create with splits", () => {
    it("creates transaction with valid splits", async () => {
      transactionsRepository.findOne.mockResolvedValue({
        id: "tx-1",
        userId: "user-1",
        accountId: "account-1",
        amount: -100,
        isSplit: true,
        status: TransactionStatus.UNRECONCILED,
        splits: [
          { id: "split-1", amount: -60 },
          { id: "split-2", amount: -40 },
        ],
      });
      splitsRepository.save.mockImplementation((data) => ({
        ...data,
        id: `split-${Math.random().toString(36).slice(2, 8)}`,
      }));

      const result = await service.create("user-1", {
        accountId: "account-1",
        transactionDate: "2026-01-15",
        amount: -100,
        currencyCode: "USD",
        splits: [
          { amount: -60, categoryId: "cat-1" },
          { amount: -40, categoryId: "cat-2" },
        ],
      } as any);

      expect(result.isSplit).toBe(true);
      expect(transactionsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          isSplit: true,
          categoryId: null, // Split transactions have null category on parent
        }),
      );
      expect(splitsRepository.create).toHaveBeenCalledTimes(2);
    });

    it("creates transaction with transfer splits", async () => {
      const targetAccount = {
        ...mockAccount,
        id: "account-2",
        name: "Savings",
        currencyCode: "USD",
      };
      const sourceAccount = {
        ...mockAccount,
        id: "account-1",
        name: "Checking",
      };

      accountsService.findOne
        .mockResolvedValueOnce(sourceAccount) // verify account belongs to user
        .mockResolvedValueOnce(targetAccount) // for transfer split: target account
        .mockResolvedValueOnce(sourceAccount); // for transfer split: source account

      transactionsRepository.save
        .mockResolvedValueOnce({ id: "tx-1" }) // main transaction save
        .mockResolvedValueOnce({ id: "linked-1" }); // linked transaction save

      transactionsRepository.findOne.mockResolvedValue({
        id: "tx-1",
        userId: "user-1",
        accountId: "account-1",
        amount: -100,
        isSplit: true,
        status: TransactionStatus.UNRECONCILED,
        splits: [
          {
            id: "split-1",
            amount: -100,
            transferAccountId: "account-2",
            linkedTransactionId: "linked-1",
          },
        ],
      });

      splitsRepository.save.mockResolvedValue({
        id: "split-1",
        transactionId: "tx-1",
        amount: -100,
      });

      await service.create("user-1", {
        accountId: "account-1",
        transactionDate: "2026-01-15",
        amount: -100,
        currencyCode: "USD",
        splits: [{ amount: -100, transferAccountId: "account-2" }],
      } as any);

      // Should create linked transaction for transfer split
      expect(transactionsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: "account-2",
          amount: 100, // inverse of -100
          isTransfer: true,
        }),
      );
      // Should update target account balance
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "account-2",
        100,
      );
    });
  });

  describe("triggerNetWorthRecalc", () => {
    it("debounces multiple calls for the same account", () => {
      jest.useFakeTimers();

      const mockTx = {
        id: "tx-1",
        userId: "user-1",
        accountId: "account-1",
        amount: -50,
        status: TransactionStatus.UNRECONCILED,
        splits: [],
      };
      transactionsRepository.findOne.mockResolvedValue(mockTx);

      // Access the private method indirectly by calling create multiple times
      // Since triggerNetWorthRecalc is private, we test via the public API
      // We'll use the fact that create calls triggerNetWorthRecalc
      // But for direct testing, we can access it via bracket notation
      (service as any).triggerNetWorthRecalc("account-1", "user-1");
      (service as any).triggerNetWorthRecalc("account-1", "user-1");
      (service as any).triggerNetWorthRecalc("account-1", "user-1");

      // Should not have called recalculate yet (debounced)
      expect(netWorthService.recalculateAccount).not.toHaveBeenCalled();

      // Advance timer past debounce
      jest.advanceTimersByTime(2500);

      // Should have called only once
      expect(netWorthService.recalculateAccount).toHaveBeenCalledTimes(1);
      expect(netWorthService.recalculateAccount).toHaveBeenCalledWith(
        "user-1",
        "account-1",
      );

      jest.useRealTimers();
    });

    it("calls separately for different accounts", () => {
      jest.useFakeTimers();

      (service as any).triggerNetWorthRecalc("account-1", "user-1");
      (service as any).triggerNetWorthRecalc("account-2", "user-1");

      jest.advanceTimersByTime(2500);

      expect(netWorthService.recalculateAccount).toHaveBeenCalledTimes(2);
      expect(netWorthService.recalculateAccount).toHaveBeenCalledWith(
        "user-1",
        "account-1",
      );
      expect(netWorthService.recalculateAccount).toHaveBeenCalledWith(
        "user-1",
        "account-2",
      );

      jest.useRealTimers();
    });

    it("replaces previous timer on repeated calls", () => {
      jest.useFakeTimers();

      (service as any).triggerNetWorthRecalc("account-1", "user-1");

      // Advance partially
      jest.advanceTimersByTime(1000);

      // Call again - should reset the timer
      (service as any).triggerNetWorthRecalc("account-1", "user-1");

      // Advance another 1500ms (total 2500ms from start, but only 1500 from last call)
      jest.advanceTimersByTime(1500);

      // Should not have fired yet (only 1500ms since last call, need 2000ms)
      expect(netWorthService.recalculateAccount).not.toHaveBeenCalled();

      // Advance the remaining 500ms
      jest.advanceTimersByTime(500);

      expect(netWorthService.recalculateAccount).toHaveBeenCalledTimes(1);

      jest.useRealTimers();
    });

    it("handles recalculation failure gracefully", () => {
      jest.useFakeTimers();

      netWorthService.recalculateAccount.mockRejectedValue(
        new Error("DB connection failed"),
      );

      (service as any).triggerNetWorthRecalc("account-1", "user-1");

      // Should not throw even if recalculation fails
      expect(() => jest.advanceTimersByTime(2500)).not.toThrow();

      jest.useRealTimers();
    });
  });

  describe("deleteTransferSplitLinkedTransactions", () => {
    it("finds and reverts linked transactions", async () => {
      const linkedTx1 = {
        id: "linked-1",
        accountId: "account-2",
        amount: 60,
      };
      const linkedTx2 = {
        id: "linked-2",
        accountId: "account-3",
        amount: 40,
      };

      splitsRepository.find.mockResolvedValue([
        {
          id: "split-1",
          transactionId: "tx-1",
          linkedTransactionId: "linked-1",
          transferAccountId: "account-2",
        },
        {
          id: "split-2",
          transactionId: "tx-1",
          linkedTransactionId: "linked-2",
          transferAccountId: "account-3",
        },
      ]);

      transactionsRepository.findOne
        .mockResolvedValueOnce(linkedTx1)
        .mockResolvedValueOnce(linkedTx2);

      await (splitService as any).deleteTransferSplitLinkedTransactions("tx-1");

      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "account-2",
        -60,
      );
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "account-3",
        -40,
      );
      expect(transactionsRepository.remove).toHaveBeenCalledWith(linkedTx1);
      expect(transactionsRepository.remove).toHaveBeenCalledWith(linkedTx2);
    });

    it("skips splits without linked transactions", async () => {
      splitsRepository.find.mockResolvedValue([
        {
          id: "split-1",
          transactionId: "tx-1",
          linkedTransactionId: null,
          transferAccountId: null,
        },
      ]);

      await (splitService as any).deleteTransferSplitLinkedTransactions("tx-1");

      expect(transactionsRepository.findOne).not.toHaveBeenCalled();
      expect(accountsService.updateBalance).not.toHaveBeenCalled();
    });

    it("handles case where linked transaction no longer exists", async () => {
      splitsRepository.find.mockResolvedValue([
        {
          id: "split-1",
          transactionId: "tx-1",
          linkedTransactionId: "deleted-tx",
          transferAccountId: "account-2",
        },
      ]);

      transactionsRepository.findOne.mockResolvedValue(null);

      await (splitService as any).deleteTransferSplitLinkedTransactions("tx-1");

      expect(accountsService.updateBalance).not.toHaveBeenCalled();
      expect(transactionsRepository.remove).not.toHaveBeenCalled();
    });
  });

  describe("getLinkedTransaction additional", () => {
    it("returns linked transaction for a transfer", async () => {
      const mainTx = {
        id: "tx-1",
        userId: "user-1",
        isTransfer: true,
        linkedTransactionId: "tx-2",
        splits: [],
      };
      const linkedTx = {
        id: "tx-2",
        userId: "user-1",
        isTransfer: true,
        linkedTransactionId: "tx-1",
        splits: [],
      };

      transactionsRepository.findOne
        .mockResolvedValueOnce(mainTx)
        .mockResolvedValueOnce(linkedTx);

      const result = await service.getLinkedTransaction("user-1", "tx-1");

      expect(result).toEqual(linkedTx);
    });

    it("returns null when linked transaction is not found", async () => {
      const mainTx = {
        id: "tx-1",
        userId: "user-1",
        isTransfer: true,
        linkedTransactionId: "deleted-tx",
        splits: [],
      };

      transactionsRepository.findOne
        .mockResolvedValueOnce(mainTx)
        .mockResolvedValueOnce(null); // linked tx not found

      const result = await service.getLinkedTransaction("user-1", "tx-1");

      expect(result).toBeNull();
    });

    it("returns null when linked transaction belongs to another user", async () => {
      const mainTx = {
        id: "tx-1",
        userId: "user-1",
        isTransfer: true,
        linkedTransactionId: "tx-2",
        splits: [],
      };

      transactionsRepository.findOne
        .mockResolvedValueOnce(mainTx)
        .mockResolvedValueOnce({
          id: "tx-2",
          userId: "user-2", // different user
        });

      const result = await service.getLinkedTransaction("user-1", "tx-1");

      // findOne will throw ForbiddenException which is caught and returns null
      expect(result).toBeNull();
    });

    it("returns null for transaction without linkedTransactionId", async () => {
      transactionsRepository.findOne.mockResolvedValue({
        id: "tx-1",
        userId: "user-1",
        isTransfer: true,
        linkedTransactionId: null,
        splits: [],
      });

      const result = await service.getLinkedTransaction("user-1", "tx-1");

      expect(result).toBeNull();
    });
  });

  describe("removeTransfer regular", () => {
    it("removes both linked transfer transactions and reverts balances", async () => {
      const fromTx = {
        id: "tx-from",
        userId: "user-1",
        accountId: "account-1",
        amount: -200,
        isTransfer: true,
        linkedTransactionId: "tx-to",
        splits: [],
      };
      const toTx = {
        id: "tx-to",
        userId: "user-1",
        accountId: "account-2",
        amount: 200,
      };

      transactionsRepository.findOne
        .mockResolvedValueOnce(fromTx) // findOne for the transaction
        .mockResolvedValueOnce(toTx); // findOne for linked transaction

      // Not a parent split child
      splitsRepository.findOne.mockResolvedValue(null);

      await service.removeTransfer("user-1", "tx-from");

      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "account-1",
        200,
      );
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "account-2",
        -200,
      );
      expect(transactionsRepository.remove).toHaveBeenCalledWith(toTx);
      expect(transactionsRepository.remove).toHaveBeenCalledWith(fromTx);
    });

    it("handles removing transfer when linked transaction is missing", async () => {
      const fromTx = {
        id: "tx-from",
        userId: "user-1",
        accountId: "account-1",
        amount: -200,
        isTransfer: true,
        linkedTransactionId: "tx-to",
        splits: [],
      };

      transactionsRepository.findOne
        .mockResolvedValueOnce(fromTx) // findOne for the transaction
        .mockResolvedValueOnce(null); // linked transaction not found

      splitsRepository.findOne.mockResolvedValue(null);

      await service.removeTransfer("user-1", "tx-from");

      // Should still revert the main transaction balance
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "account-1",
        200,
      );
      expect(transactionsRepository.remove).toHaveBeenCalledWith(fromTx);
    });

    it("handles removing transfer without linkedTransactionId", async () => {
      const tx = {
        id: "tx-1",
        userId: "user-1",
        accountId: "account-1",
        amount: -200,
        isTransfer: true,
        linkedTransactionId: null,
        splits: [],
      };

      transactionsRepository.findOne.mockResolvedValueOnce(tx);
      splitsRepository.findOne.mockResolvedValue(null);

      await service.removeTransfer("user-1", "tx-1");

      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "account-1",
        200,
      );
      expect(transactionsRepository.remove).toHaveBeenCalledWith(tx);
    });
  });
});
