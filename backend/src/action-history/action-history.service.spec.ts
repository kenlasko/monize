import { Test, TestingModule } from "@nestjs/testing";
import { NotFoundException, ConflictException, Logger } from "@nestjs/common";
import { DataSource } from "typeorm";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import {
  ActionHistoryService,
  settlePendingHistoryWrites,
} from "./action-history.service";
import { ActionHistory } from "./entities/action-history.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { BondPriceService } from "../bonds/bond-price.service";
import { HoldingsService } from "../securities/holdings.service";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

describe("ActionHistoryService", () => {
  let service: ActionHistoryService;
  let mockRepository: Record<string, jest.Mock>;
  let mockQueryRunner: Record<string, any>;
  let mockDataSource: Record<string, any>;
  let holdings: { rebuildAccountsFromTransactions: jest.Mock };
  let bondPrices: {
    clearEnginePrices: jest.Mock;
    publishClearedPrices: jest.Mock;
    recomputeLinkedSecurities: jest.Mock;
  };

  const userId = "user-1";
  const mockAction: Partial<ActionHistory> = {
    id: "action-1",
    userId,
    entityType: "tag",
    entityId: "entity-1",
    action: "create",
    beforeData: null,
    afterData: { id: "entity-1", name: "Test Tag" },
    relatedEntities: null,
    isUndone: false,
    description: 'Created tag "Test Tag"',
    createdAt: new Date(),
  };

  /**
   * The row-lock `SELECT ... FOR UPDATE` over `transactions` answers with the
   * rows given (by id); every other query answers like the balance recompute.
   */
  const mockLockedRows = (
    rows: Record<
      string,
      {
        account_id: string;
        amount: string;
        linked_transaction_id?: string | null;
        status?: string;
        transaction_date?: string;
      }
    >,
  ) => {
    mockQueryRunner.query.mockImplementation(
      async (sql: string, params: unknown[]) => {
        if (/FROM transactions/.test(sql) && /FOR UPDATE/.test(sql)) {
          return (params[0] as string[])
            .filter((id) => rows[id] !== undefined)
            .map((id) => ({
              id,
              status: "UNRECONCILED",
              transaction_date: "2020-01-15",
              is_split: false,
              linked_transaction_id: null,
              parent_transaction_id: null,
              payee_id: null,
              payee_name: null,
              ...rows[id],
            }));
        }
        return [{ opening_balance: "0", tx_sum: "0" }];
      },
    );
  };

  beforeEach(async () => {
    mockRepository = {
      create: jest.fn(),
      save: jest.fn(),
      find: jest.fn(),
      findOne: jest.fn(),
      delete: jest.fn(),
      count: jest.fn(),
      createQueryBuilder: jest.fn(),
    };

    // The service now runs every write through `withScopedDb`, so the former
    // QueryRunner is the transaction's EntityManager: `queryRunner.query` and
    // `queryRunner.manager.*` are the same jest.fn()s the manager exposes, which
    // keeps the assertions below pointed at the same calls they always were.
    const scoped = createScopedDbMocks([[ActionHistory, mockRepository]]);
    mockQueryRunner = {
      query: scoped.manager.query,
      manager: scoped.manager,
    };
    mockDataSource = scoped.dataSource;

    holdings = {
      rebuildAccountsFromTransactions: jest.fn().mockResolvedValue(undefined),
    };
    bondPrices = {
      clearEnginePrices: jest
        .fn()
        .mockResolvedValue({ deleted: 2, accountIds: ["acct-1"] }),
      publishClearedPrices: jest.fn(),
      recomputeLinkedSecurities: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ActionHistoryService,
        {
          provide: DataSource,
          useValue: mockDataSource,
        },
        { provide: BondPriceService, useValue: bondPrices },
        { provide: HoldingsService, useValue: holdings },
      ],
    }).compile();

    service = module.get<ActionHistoryService>(ActionHistoryService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("record", () => {
    it("stays visible to settlePendingHistoryWrites until it has finished", async () => {
      // Every call site invokes `record` without `await`, so the write outlives
      // the request that caused it. A teardown that truncates `users` while one
      // is in flight gets a foreign key violation against a user that no longer
      // exists, and a fixture that writes several rows per test starts the next
      // test body with those chains still holding pooled connections -- which,
      // on a pool that waits forever for a free one, is a 30-second stall with
      // nothing naming the cause. Registering the promise is what lets a
      // teardown wait for it.
      let releaseSave: (value: unknown) => void = () => {};
      mockRepository.delete.mockResolvedValue({});
      mockRepository.create.mockReturnValue(mockAction);
      mockRepository.count.mockResolvedValue(0);
      mockRepository.save.mockReturnValue(
        new Promise((resolve) => {
          releaseSave = resolve;
        }),
      );

      void service.record(userId, {
        entityType: "tag",
        entityId: "entity-1",
        action: "create",
        description: 'Created tag "Test Tag"',
      });

      let settled = false;
      const settling = settlePendingHistoryWrites().then(() => {
        settled = true;
      });
      // Several microtask turns: enough for a settle that was going to resolve
      // immediately to have done so.
      await new Promise((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);

      releaseSave(mockAction);
      await settling;
      expect(settled).toBe(true);
    });

    it("reports a failed recording as an error naming what cannot be undone", async () => {
      // Recording is best-effort so it cannot fail the user's operation, but the
      // operation succeeded and its undo entry did not -- the user will look for
      // an undo that is not there, so this is not a `warn` (DR-04-03).
      const errorSpy = jest
        .spyOn(Logger.prototype, "error")
        .mockImplementation();
      const warnSpy = jest.spyOn(Logger.prototype, "warn").mockImplementation();
      mockRepository.delete.mockResolvedValue({ affected: 0 });
      mockRepository.create.mockReturnValue(mockAction);
      mockRepository.save.mockRejectedValue(new Error("DB down"));

      const result = await service.record(userId, {
        entityType: "transaction",
        entityId: "tx-77",
        action: "delete",
        description: "Deleted a transaction",
      });

      expect(result).toBeNull();
      const message = String(errorSpy.mock.calls[0][0]);
      expect(message).toContain("delete");
      expect(message).toContain("transaction");
      expect(message).toContain("tx-77");
      expect(message).toContain("DB down");
      expect(warnSpy).not.toHaveBeenCalled();

      errorSpy.mockRestore();
      warnSpy.mockRestore();
    });

    it("should record an action", async () => {
      mockRepository.delete.mockResolvedValue({ affected: 0 });
      mockRepository.create.mockReturnValue(mockAction);
      mockRepository.save.mockResolvedValue(mockAction);
      mockRepository.count.mockResolvedValue(1);

      const result = await service.record(userId, {
        entityType: "tag",
        entityId: "entity-1",
        action: "create",
        afterData: { id: "entity-1", name: "Test Tag" },
        description: 'Created tag "Test Tag"',
      });

      expect(result).toEqual(mockAction);
      expect(mockRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId,
          entityType: "tag",
          entityId: "entity-1",
          action: "create",
        }),
      );
      expect(mockRepository.save).toHaveBeenCalled();
    });

    it("should persist the localization key and params", async () => {
      mockRepository.delete.mockResolvedValue({ affected: 0 });
      mockRepository.create.mockReturnValue(mockAction);
      mockRepository.save.mockResolvedValue(mockAction);
      mockRepository.count.mockResolvedValue(1);

      await service.record(userId, {
        entityType: "payee",
        entityId: "payee-1",
        action: "create",
        description: 'Created payee "Acme"',
        descriptionKey: "createdPayee",
        descriptionParams: { name: "Acme" },
      });

      expect(mockRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          descriptionKey: "createdPayee",
          descriptionParams: { name: "Acme" },
        }),
      );
    });

    it("should default localization fields to null when omitted", async () => {
      mockRepository.delete.mockResolvedValue({ affected: 0 });
      mockRepository.create.mockReturnValue(mockAction);
      mockRepository.save.mockResolvedValue(mockAction);
      mockRepository.count.mockResolvedValue(1);

      await service.record(userId, {
        entityType: "tag",
        entityId: "entity-1",
        action: "create",
        description: "test",
      });

      expect(mockRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          descriptionKey: null,
          descriptionParams: null,
        }),
      );
    });

    it("should clear redo stack when recording new action", async () => {
      mockRepository.delete.mockResolvedValue({ affected: 2 });
      mockRepository.create.mockReturnValue(mockAction);
      mockRepository.save.mockResolvedValue(mockAction);
      mockRepository.count.mockResolvedValue(1);

      await service.record(userId, {
        entityType: "tag",
        entityId: "entity-1",
        action: "create",
        description: "test",
      });

      expect(mockRepository.delete).toHaveBeenCalledWith({
        userId,
        isUndone: true,
      });
    });

    it("should skip recording if JSONB payload exceeds size limit", async () => {
      const largeData = { data: "x".repeat(600 * 1024) };

      const result = await service.record(userId, {
        entityType: "tag",
        entityId: "entity-1",
        action: "create",
        afterData: largeData,
        description: "test",
      });

      expect(result).toBeNull();
      expect(mockRepository.save).not.toHaveBeenCalled();
    });

    it("should not throw if recording fails", async () => {
      mockRepository.delete.mockRejectedValue(new Error("DB error"));

      const result = await service.record(userId, {
        entityType: "tag",
        entityId: "entity-1",
        action: "create",
        description: "test",
      });

      expect(result).toBeNull();
    });
  });

  describe("getHistory", () => {
    it("should return history for user", async () => {
      const mockHistory = [mockAction];
      mockRepository.find.mockResolvedValue(mockHistory);

      const result = await service.getHistory(userId, 50);

      expect(result).toEqual(mockHistory);
      expect(mockRepository.find).toHaveBeenCalledWith({
        where: { userId },
        order: { createdAt: "DESC" },
        take: 50,
      });
    });
  });

  describe("undo", () => {
    it("should throw NotFoundException if nothing to undo", async () => {
      mockRepository.findOne.mockResolvedValue(null);

      await expect(service.undo(userId)).rejects.toThrow(NotFoundException);
    });

    it("should undo a simple entity create (tag)", async () => {
      const createAction = {
        ...mockAction,
        action: "create",
        entityType: "tag",
        entityId: "tag-1",
        afterData: { id: "tag-1", name: "Test Tag" },
      };
      mockRepository.findOne.mockResolvedValue(createAction);
      mockQueryRunner.manager.delete.mockResolvedValue({ affected: 1 });
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
      expect(mockDataSource.transaction).toHaveBeenCalled();
      expect(mockQueryRunner.manager.delete).toHaveBeenCalled();
    });

    it("should undo a simple entity delete (tag)", async () => {
      const deleteAction = {
        ...mockAction,
        action: "delete",
        entityType: "tag",
        entityId: "tag-1",
        beforeData: { id: "tag-1", name: "Test Tag", userId },
        afterData: null,
      };
      mockRepository.findOne.mockResolvedValue(deleteAction);
      mockQueryRunner.query.mockResolvedValue([]);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
      expect(mockDataSource.transaction).toHaveBeenCalled();
      // Should have called query to re-insert
      expect(mockQueryRunner.query).toHaveBeenCalled();
    });

    it("should skip disallowed columns in beforeData during re-insert", async () => {
      const deleteAction = {
        ...mockAction,
        action: "delete",
        entityType: "tag",
        entityId: "tag-1",
        beforeData: {
          id: "tag-1",
          name: "Test Tag",
          userId,
          "'; DROP TABLE users; --": "evil",
        },
        afterData: null,
      };
      mockRepository.findOne.mockResolvedValue(deleteAction);
      mockQueryRunner.query.mockResolvedValue([]);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
      expect(mockDataSource.transaction).toHaveBeenCalled();
      // The INSERT query should not contain the malicious column
      const insertCall = mockQueryRunner.query.mock.calls.find(
        (call: any[]) =>
          typeof call[0] === "string" && call[0].includes("INSERT INTO"),
      );
      expect(insertCall).toBeDefined();
      expect(insertCall[0]).not.toContain("DROP TABLE");
    });

    it("should undo a simple entity create (custom_report)", async () => {
      const createAction = {
        ...mockAction,
        action: "create",
        entityType: "custom_report",
        entityId: "report-1",
        afterData: { id: "report-1", name: "Monthly Expenses" },
      };
      mockRepository.findOne.mockResolvedValue(createAction);
      mockQueryRunner.manager.delete.mockResolvedValue({ affected: 1 });
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
      expect(mockDataSource.transaction).toHaveBeenCalled();
      expect(mockQueryRunner.manager.delete).toHaveBeenCalled();
    });

    it("should undo a simple entity delete (custom_report)", async () => {
      const deleteAction = {
        ...mockAction,
        action: "delete",
        entityType: "custom_report",
        entityId: "report-1",
        beforeData: {
          id: "report-1",
          name: "Monthly Expenses",
          userId,
          viewType: "BAR_CHART",
          timeframeType: "LAST_3_MONTHS",
          groupBy: "CATEGORY",
        },
        afterData: null,
      };
      mockRepository.findOne.mockResolvedValue(deleteAction);
      mockQueryRunner.query.mockResolvedValue([]);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
      expect(mockDataSource.transaction).toHaveBeenCalled();
      expect(mockQueryRunner.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO "custom_reports"'),
        expect.any(Array),
      );
    });

    it("should undo a simple entity update (custom_report)", async () => {
      const updateAction = {
        ...mockAction,
        action: "update",
        entityType: "custom_report",
        entityId: "report-1",
        beforeData: {
          id: "report-1",
          name: "Old Name",
          userId,
        },
        afterData: {
          id: "report-1",
          name: "New Name",
          userId,
        },
      };
      mockRepository.findOne.mockResolvedValue(updateAction);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
      expect(mockDataSource.transaction).toHaveBeenCalled();
      expect(mockQueryRunner.manager.update).toHaveBeenCalledWith(
        expect.any(Function),
        "report-1",
        expect.objectContaining({ name: "Old Name" }),
      );
    });

    it("should throw ConflictException for unsupported table in re-insert", async () => {
      const deleteAction = {
        ...mockAction,
        action: "delete",
        entityType: "unsupported_entity",
        entityId: "entity-1",
        beforeData: { id: "entity-1", name: "test" },
        afterData: null,
      };
      mockRepository.findOne.mockResolvedValue(deleteAction);

      await expect(service.undo(userId)).rejects.toThrow(ConflictException);
      expect(mockDataSource.transaction).toHaveBeenCalled();
    });

    it("should rollback on error", async () => {
      const createAction = {
        ...mockAction,
        action: "create",
        entityType: "tag",
        entityId: "tag-1",
      };
      mockRepository.findOne.mockResolvedValue(createAction);
      mockQueryRunner.manager.delete.mockRejectedValue(new Error("DB error"));

      await expect(service.undo(userId)).rejects.toThrow("DB error");
      expect(mockDataSource.transaction).toHaveBeenCalled();
      expect(mockDataSource.transaction).toHaveBeenCalled();
    });
  });

  describe("redo", () => {
    it("should throw NotFoundException if nothing to redo", async () => {
      mockRepository.findOne.mockResolvedValue(null);

      await expect(service.redo(userId)).rejects.toThrow(NotFoundException);
    });

    it("should redo an undone action", async () => {
      const undoneAction = {
        ...mockAction,
        action: "delete",
        entityType: "tag",
        entityId: "tag-1",
        isUndone: true,
        beforeData: { id: "tag-1", name: "Test Tag", userId },
        afterData: null,
      };
      mockRepository.findOne.mockResolvedValue(undoneAction);
      mockQueryRunner.manager.delete.mockResolvedValue({ affected: 1 });
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });

      const result = await service.redo(userId);

      expect(result.description).toContain("Redone");
      expect(mockDataSource.transaction).toHaveBeenCalled();
    });
  });

  describe("undo transaction create", () => {
    it("should delete the transaction and recalculate balance", async () => {
      const txAction = {
        ...mockAction,
        entityType: "transaction",
        action: "create",
        entityId: "tx-1",
        afterData: { id: "tx-1", accountId: "acc-1", amount: 100 },
      };
      mockRepository.findOne.mockResolvedValue(txAction);

      // Mock finding the transaction
      const mockTransaction = {
        id: "tx-1",
        userId,
        accountId: "acc-1",
        amount: 100,
        status: "UNRECONCILED",
        splits: [],
      };
      mockQueryRunner.manager.findOne.mockResolvedValue(mockTransaction);
      mockQueryRunner.manager.remove.mockResolvedValue(undefined);
      mockQueryRunner.manager.delete.mockResolvedValue({ affected: 0 });
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });
      mockQueryRunner.query.mockResolvedValue([
        { opening_balance: "0", tx_sum: "-100" },
      ]);

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
      expect(mockDataSource.transaction).toHaveBeenCalled();
    });
  });

  describe("undo transaction delete", () => {
    it("should re-insert the transaction from snapshot", async () => {
      const deleteAction = {
        ...mockAction,
        entityType: "transaction",
        action: "delete",
        entityId: "tx-1",
        beforeData: {
          id: "tx-1",
          accountId: "acc-1",
          transactionDate: "2024-01-15",
          amount: -45.5,
          currencyCode: "USD",
          payeeName: "Grocery",
          status: "UNRECONCILED",
          isSplit: false,
          isTransfer: false,
          splits: [],
          tagIds: ["tag-1"],
        },
        afterData: null,
      };
      mockRepository.findOne.mockResolvedValue(deleteAction);

      // Mock account exists
      mockQueryRunner.manager.findOne.mockResolvedValue({
        id: "acc-1",
        userId,
      });
      mockQueryRunner.query.mockResolvedValue([
        { opening_balance: "0", tx_sum: "0" },
      ]);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
      expect(mockDataSource.transaction).toHaveBeenCalled();
      // Verify transaction was re-inserted via raw query
      expect(mockQueryRunner.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO transactions"),
        expect.arrayContaining(["tx-1"]),
      );
      // Verify tags were re-inserted
      expect(mockQueryRunner.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO transaction_tags"),
        ["tx-1", "tag-1"],
      );
    });
  });

  describe("undo of a foreign-currency delete restores original_amount and original_currency_code", () => {
    const fx = { originalAmount: 100, originalCurrencyCode: "EUR" };
    const txBase = {
      accountId: "acc-1",
      transactionDate: "2024-01-15",
      amount: -108,
      currencyCode: "USD",
      exchangeRate: 1.08,
    };

    const insertFor = (table: string) =>
      mockQueryRunner.query.mock.calls.find(
        (call: any[]) =>
          typeof call[0] === "string" &&
          call[0].includes(`INSERT INTO ${table} `),
      ) as [string, unknown[]] | undefined;

    const run = async (
      entityType: string,
      action: string,
      beforeData: Record<string, any>,
    ) => {
      mockRepository.findOne.mockResolvedValue({
        ...mockAction,
        entityType,
        action,
        entityId: "tx-1",
        beforeData,
        afterData: null,
      });
      mockQueryRunner.manager.findOne.mockResolvedValue({
        id: "acc-1",
        userId,
      });
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });
      mockQueryRunner.query.mockResolvedValue([
        { opening_balance: "0", tx_sum: "0" },
      ]);
      await service.undo(userId);
    };

    it("single transaction", async () => {
      await run("transaction", "delete", { id: "tx-1", ...txBase, ...fx });
      const insert = insertFor("transactions")!;
      expect(insert[0]).toContain("original_amount, original_currency_code");
      expect(insert[1].slice(-2)).toEqual([100, "EUR"]);
    });

    it("single transaction from a snapshot recorded before the fields existed", async () => {
      await run("transaction", "delete", { id: "tx-1", ...txBase });
      expect(insertFor("transactions")![1].slice(-2)).toEqual([null, null]);
    });

    it("transfer legs", async () => {
      await run("transfer", "delete", {
        fromTransaction: { id: "tx-1", ...txBase, ...fx },
        toTransaction: { id: "tx-2", ...txBase, amount: 108 },
      });
      const inserts = mockQueryRunner.query.mock.calls.filter(
        (c: any[]) =>
          typeof c[0] === "string" &&
          c[0].includes("INSERT INTO transactions "),
      );
      expect(inserts[0][1].slice(-2)).toEqual([100, "EUR"]);
      expect(inserts[1][1].slice(-2)).toEqual([null, null]);
    });

    it("investment linked cash transaction", async () => {
      await run("investment_transaction", "delete", {
        id: "inv-1",
        accountId: "acc-1",
        securityId: "sec-1",
        action: "BUY",
        transactionDate: "2024-01-15",
        linkedCashTransaction: { id: "cash-1", ...txBase, ...fx },
      });
      expect(insertFor("transactions")![1].slice(-2)).toEqual([100, "EUR"]);
    });

    it("bulk delete", async () => {
      await run("bulk_transaction", "bulk_delete", {
        transactions: [{ id: "tx-1", ...txBase, ...fx }],
      });
      expect(insertFor("transactions")![1].slice(-2)).toEqual([100, "EUR"]);
    });
  });

  describe("undo transaction update", () => {
    it("should restore transaction fields from beforeData", async () => {
      const updateAction = {
        ...mockAction,
        entityType: "transaction",
        action: "update",
        entityId: "tx-1",
        beforeData: {
          accountId: "acc-1",
          amount: 50,
          transactionDate: "2024-01-10",
          payeeName: "Old Payee",
          status: "UNRECONCILED",
        },
        afterData: {
          accountId: "acc-1",
          amount: 100,
          transactionDate: "2024-01-15",
          payeeName: "New Payee",
        },
      };
      mockRepository.findOne.mockResolvedValue(updateAction);
      mockQueryRunner.manager.findOne.mockResolvedValue({
        id: "tx-1",
        userId,
        accountId: "acc-1",
      });
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });
      mockQueryRunner.query.mockResolvedValue([
        { opening_balance: "0", tx_sum: "50" },
      ]);

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
      expect(mockQueryRunner.manager.update).toHaveBeenCalledWith(
        expect.any(Function),
        "tx-1",
        expect.objectContaining({ amount: 50, payeeName: "Old Payee" }),
      );
      expect(mockDataSource.transaction).toHaveBeenCalled();
    });

    it("should restore splits when beforeData contains splits", async () => {
      const updateAction = {
        ...mockAction,
        entityType: "transaction",
        action: "update",
        entityId: "tx-1",
        beforeData: {
          accountId: "acc-1",
          splits: [
            { id: "s1", categoryId: "cat-1", amount: 25, memo: "Split 1" },
            { id: "s2", categoryId: "cat-2", amount: 75, memo: null },
          ],
        },
      };
      mockRepository.findOne.mockResolvedValue(updateAction);
      mockQueryRunner.manager.findOne.mockResolvedValue({
        id: "tx-1",
        userId,
        accountId: "acc-1",
      });
      mockQueryRunner.manager.delete.mockResolvedValue({ affected: 1 });
      mockQueryRunner.manager.create.mockImplementation((_, data) => data);
      mockQueryRunner.manager.save.mockResolvedValue({});
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });
      mockQueryRunner.query.mockResolvedValue([
        { opening_balance: "0", tx_sum: "100" },
      ]);

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
      // Should delete existing splits first
      expect(mockQueryRunner.manager.delete).toHaveBeenCalled();
      // Should re-create two splits
      expect(mockQueryRunner.manager.save).toHaveBeenCalledTimes(2);
    });

    describe("a split transaction with a transfer line", () => {
      const transferSplits = (linked: string) => [
        {
          id: "s1",
          kind: "category",
          categoryId: "cat-1",
          transferAccountId: null,
          linkedTransactionId: null,
          amount: -60,
          memo: null,
        },
        {
          id: "s2",
          kind: "transfer",
          categoryId: null,
          transferAccountId: "acc-2",
          linkedTransactionId: linked,
          amount: -40,
          memo: null,
        },
      ];
      const splitAction = (
        beforeSplits: unknown,
        afterSplits: unknown,
      ): Record<string, any> => ({
        ...mockAction,
        entityType: "transaction",
        action: "update",
        entityId: "tx-1",
        beforeData: {
          accountId: "acc-1",
          description: "old",
          splits: beforeSplits,
        },
        afterData: {
          accountId: "acc-1",
          description: "new",
          splits: afterSplits,
        },
      });
      const arrange = (action: unknown) => {
        mockRepository.findOne.mockResolvedValue(action);
        mockQueryRunner.manager.findOne.mockResolvedValue({
          id: "tx-1",
          userId,
          accountId: "acc-1",
        });
        mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });
        mockQueryRunner.manager.delete.mockResolvedValue({ affected: 1 });
        mockQueryRunner.manager.create.mockImplementation((_, data) => data);
        mockQueryRunner.query.mockResolvedValue([
          { opening_balance: "0", tx_sum: "0" },
        ]);
      };

      it("leaves the split rows alone when the edit resent the same lines", async () => {
        // The re-created lines carry new ids and new counterpart ids.
        arrange(
          splitAction(transferSplits("leg-old"), [
            ...transferSplits("leg-new").reverse(),
          ]),
        );

        await service.undo(userId);

        expect(mockQueryRunner.manager.update).toHaveBeenCalledWith(
          expect.any(Function),
          "tx-1",
          expect.objectContaining({ description: "old" }),
        );
        expect(mockQueryRunner.manager.delete).not.toHaveBeenCalled();
        expect(mockQueryRunner.manager.save).not.toHaveBeenCalled();
      });

      it("refuses, before any write, when the edit changed a transfer line", async () => {
        arrange(
          splitAction(transferSplits("leg-old"), [
            { ...transferSplits("leg-new")[0], amount: -50 },
            { ...transferSplits("leg-new")[1], amount: -50 },
          ]),
        );

        await expect(service.undo(userId)).rejects.toMatchObject({
          response: { errorCode: "UNDO_SPLIT_LEGS_CHANGED" },
        });
        expect(mockQueryRunner.manager.update).not.toHaveBeenCalled();
        expect(mockQueryRunner.manager.delete).not.toHaveBeenCalled();
        expect(mockQueryRunner.manager.save).not.toHaveBeenCalled();
      });

      it("refuses the redo of an edit that added a transfer line", async () => {
        arrange(
          splitAction([transferSplits("x")[0]], transferSplits("leg-new")),
        );

        await expect(service.redo(userId)).rejects.toMatchObject({
          response: { errorCode: "UNDO_SPLIT_LEGS_CHANGED" },
        });
        expect(mockQueryRunner.manager.update).not.toHaveBeenCalled();
      });

      it.each([
        ["undo", "UNRECONCILED", "VOID"],
        ["redo", "VOID", "UNRECONCILED"],
      ])(
        "refuses the %s of a status change that voided or restored legs, before any write",
        async (which, beforeStatus, afterStatus) => {
          const action = splitAction(
            transferSplits("leg-1"),
            transferSplits("leg-1"),
          );
          action.beforeData = { ...action.beforeData, status: beforeStatus };
          action.afterData = { ...action.afterData, status: afterStatus };
          arrange(action);

          await expect(
            which === "undo" ? service.undo(userId) : service.redo(userId),
          ).rejects.toMatchObject({
            response: { errorCode: "UNDO_VOID_WITH_LEGS" },
          });
          expect(mockQueryRunner.manager.update).not.toHaveBeenCalled();
          expect(mockQueryRunner.manager.delete).not.toHaveBeenCalled();
        },
      );

      it("refuses an undo of a VOID of a transfer leg", async () => {
        const action = {
          ...splitAction(undefined, undefined),
          beforeData: {
            accountId: "acc-1",
            status: "UNRECONCILED",
            isTransfer: true,
            linkedTransactionId: "tx-2",
          },
          afterData: {
            accountId: "acc-1",
            status: "VOID",
            isTransfer: true,
            linkedTransactionId: "tx-2",
          },
        };
        arrange(action);

        await expect(service.undo(userId)).rejects.toMatchObject({
          response: { errorCode: "UNDO_VOID_WITH_LEGS" },
        });
        expect(mockQueryRunner.manager.update).not.toHaveBeenCalled();
      });

      it("refuses the undo of a conversion between a transaction and a transfer", async () => {
        const action = {
          ...splitAction(undefined, undefined),
          beforeData: {
            accountId: "acc-1",
            amount: -50,
            isTransfer: false,
            linkedTransactionId: null,
          },
          afterData: {
            accountId: "acc-1",
            amount: -50,
            isTransfer: true,
            linkedTransactionId: "tx-2",
          },
        };
        arrange(action);

        await expect(service.undo(userId)).rejects.toMatchObject({
          response: { errorCode: "UNDO_CONVERSION" },
        });
        expect(mockQueryRunner.manager.update).not.toHaveBeenCalled();
      });

      it("still undoes a VOID of a row without legs", async () => {
        const action = {
          ...splitAction(undefined, undefined),
          beforeData: { accountId: "acc-1", status: "UNRECONCILED" },
          afterData: { accountId: "acc-1", status: "VOID" },
        };
        arrange(action);

        await service.undo(userId);

        expect(mockQueryRunner.manager.update).toHaveBeenCalledWith(
          expect.any(Function),
          "tx-1",
          expect.objectContaining({ status: "UNRECONCILED" }),
        );
      });

      it("sets the kind of a re-created category line from the snapshot", async () => {
        arrange(
          splitAction(
            [{ id: "s1", categoryId: "cat-1", amount: 10 }],
            [{ id: "s1", categoryId: "cat-2", amount: 10 }],
          ),
        );

        await service.undo(userId);

        expect(mockQueryRunner.manager.save).toHaveBeenCalledWith(
          expect.objectContaining({ kind: "category", categoryId: "cat-1" }),
        );
      });
    });

    it("should restore tags when beforeData contains tagIds", async () => {
      const updateAction = {
        ...mockAction,
        entityType: "transaction",
        action: "update",
        entityId: "tx-1",
        beforeData: {
          accountId: "acc-1",
          tagIds: ["tag-1", "tag-2"],
        },
      };
      mockRepository.findOne.mockResolvedValue(updateAction);
      mockQueryRunner.manager.findOne.mockResolvedValue({
        id: "tx-1",
        userId,
        accountId: "acc-1",
      });
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });
      mockQueryRunner.query.mockResolvedValue([
        { opening_balance: "0", tx_sum: "0" },
      ]);

      await service.undo(userId);

      // Should delete existing tags
      expect(mockQueryRunner.query).toHaveBeenCalledWith(
        expect.stringContaining("DELETE FROM transaction_tags"),
        ["tx-1"],
      );
      // Should re-insert both tags
      expect(mockQueryRunner.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO transaction_tags"),
        ["tx-1", "tag-1"],
      );
      expect(mockQueryRunner.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO transaction_tags"),
        ["tx-1", "tag-2"],
      );
    });

    it("should throw ConflictException if transaction no longer exists", async () => {
      const updateAction = {
        ...mockAction,
        entityType: "transaction",
        action: "update",
        entityId: "tx-1",
        beforeData: { accountId: "acc-1", amount: 50 },
      };
      mockRepository.findOne.mockResolvedValue(updateAction);
      mockQueryRunner.manager.findOne.mockResolvedValue(null);

      await expect(service.undo(userId)).rejects.toThrow(ConflictException);
      expect(mockDataSource.transaction).toHaveBeenCalled();
    });

    it("should return early if entityId is null", async () => {
      const updateAction = {
        ...mockAction,
        entityType: "transaction",
        action: "update",
        entityId: null,
        beforeData: { accountId: "acc-1" },
      };
      mockRepository.findOne.mockResolvedValue(updateAction);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
      // Should not try to find or update transaction
      expect(mockQueryRunner.manager.findOne).not.toHaveBeenCalled();
    });

    it("should recalculate balance for both old and new accounts when account changed", async () => {
      const updateAction = {
        ...mockAction,
        entityType: "transaction",
        action: "update",
        entityId: "tx-1",
        beforeData: {
          accountId: "acc-old",
          amount: 50,
        },
      };
      mockRepository.findOne.mockResolvedValue(updateAction);
      mockQueryRunner.manager.findOne.mockResolvedValue({
        id: "tx-1",
        userId,
        accountId: "acc-new",
      });
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });
      mockQueryRunner.query.mockResolvedValue([
        { opening_balance: "0", tx_sum: "0" },
      ]);

      await service.undo(userId);

      // Should recalculate balance for both accounts
      const balanceQueries = mockQueryRunner.query.mock.calls.filter(
        (call: any[]) =>
          typeof call[0] === "string" &&
          call[0].includes("UPDATE accounts SET current_balance"),
      );
      expect(balanceQueries.length).toBe(2);
    });

    it("should handle empty splits array in beforeData", async () => {
      const updateAction = {
        ...mockAction,
        entityType: "transaction",
        action: "update",
        entityId: "tx-1",
        beforeData: {
          accountId: "acc-1",
          splits: [],
        },
      };
      mockRepository.findOne.mockResolvedValue(updateAction);
      mockQueryRunner.manager.findOne.mockResolvedValue({
        id: "tx-1",
        userId,
        accountId: "acc-1",
      });
      mockQueryRunner.manager.delete.mockResolvedValue({ affected: 0 });
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });
      mockQueryRunner.query.mockResolvedValue([
        { opening_balance: "0", tx_sum: "0" },
      ]);

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
      // Should delete existing splits but not create new ones
      expect(mockQueryRunner.manager.delete).toHaveBeenCalled();
      expect(mockQueryRunner.manager.save).not.toHaveBeenCalled();
    });
  });

  describe("undo transaction delete (account missing)", () => {
    it("should throw ConflictException if account no longer exists", async () => {
      const deleteAction = {
        ...mockAction,
        entityType: "transaction",
        action: "delete",
        entityId: "tx-1",
        beforeData: {
          id: "tx-1",
          accountId: "acc-1",
          transactionDate: "2024-01-15",
          amount: -45.5,
          currencyCode: "USD",
        },
        afterData: null,
      };
      mockRepository.findOne.mockResolvedValue(deleteAction);
      mockQueryRunner.manager.findOne.mockResolvedValue(null);

      await expect(service.undo(userId)).rejects.toThrow(ConflictException);
    });

    it("should re-insert transaction with splits", async () => {
      const deleteAction = {
        ...mockAction,
        entityType: "transaction",
        action: "delete",
        entityId: "tx-1",
        beforeData: {
          id: "tx-1",
          accountId: "acc-1",
          transactionDate: "2024-01-15",
          amount: -100,
          currencyCode: "USD",
          isSplit: true,
          splits: [
            { id: "s1", categoryId: "cat-1", amount: -60, memo: "Part 1" },
            { id: "s2", categoryId: "cat-2", amount: -40, memo: "Part 2" },
          ],
          tagIds: [],
        },
        afterData: null,
      };
      mockRepository.findOne.mockResolvedValue(deleteAction);
      mockQueryRunner.manager.findOne.mockResolvedValue({
        id: "acc-1",
        userId,
      });
      mockQueryRunner.query.mockResolvedValue([
        { opening_balance: "0", tx_sum: "-100" },
      ]);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
      // Should insert transaction + 2 splits
      const insertCalls = mockQueryRunner.query.mock.calls.filter(
        (call: any[]) =>
          typeof call[0] === "string" &&
          call[0].includes("INSERT INTO transaction_splits"),
      );
      expect(insertCalls.length).toBe(2);
    });

    it("should return early if beforeData is null", async () => {
      const deleteAction = {
        ...mockAction,
        entityType: "transaction",
        action: "delete",
        entityId: "tx-1",
        beforeData: null,
        afterData: null,
      };
      mockRepository.findOne.mockResolvedValue(deleteAction);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
      expect(mockQueryRunner.manager.findOne).not.toHaveBeenCalled();
    });
  });

  describe("undo transfer", () => {
    it("should undo transfer create by deleting both transactions", async () => {
      const transferAction = {
        ...mockAction,
        entityType: "transfer",
        action: "create",
        entityId: "tx-from",
        afterData: {
          fromTransactionId: "tx-from",
          toTransactionId: "tx-to",
          fromAccountId: "acc-1",
          toAccountId: "acc-2",
        },
      };
      mockRepository.findOne.mockResolvedValue(transferAction);
      mockQueryRunner.manager.findOne.mockResolvedValue({
        id: "tx-from",
        userId,
        accountId: "acc-1",
      });
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });
      mockQueryRunner.manager.delete.mockResolvedValue({ affected: 1 });
      mockQueryRunner.query.mockResolvedValue([
        { opening_balance: "0", tx_sum: "0" },
      ]);

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
      expect(mockDataSource.transaction).toHaveBeenCalled();
    });

    it("should undo transfer delete by re-inserting both transactions", async () => {
      const transferAction = {
        ...mockAction,
        entityType: "transfer",
        action: "delete",
        entityId: "tx-from",
        beforeData: {
          fromTransaction: {
            id: "tx-from",
            accountId: "acc-1",
            transactionDate: "2024-01-15",
            amount: -100,
            currencyCode: "USD",
            isTransfer: true,
          },
          toTransaction: {
            id: "tx-to",
            accountId: "acc-2",
            transactionDate: "2024-01-15",
            amount: 100,
            currencyCode: "USD",
            isTransfer: true,
          },
        },
        afterData: null,
      };
      mockRepository.findOne.mockResolvedValue(transferAction);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });
      mockQueryRunner.query.mockResolvedValue([
        { opening_balance: "0", tx_sum: "0" },
      ]);

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
      // Should insert two transactions
      const insertCalls = mockQueryRunner.query.mock.calls.filter(
        (call: any[]) =>
          typeof call[0] === "string" &&
          call[0].includes("INSERT INTO transactions"),
      );
      expect(insertCalls.length).toBe(2);
      // Should re-link them
      expect(mockQueryRunner.manager.update).toHaveBeenCalledWith(
        expect.any(Function),
        "tx-from",
        { linkedTransactionId: "tx-to" },
      );
    });

    it("should throw ConflictException for unsupported transfer action", async () => {
      const transferAction = {
        ...mockAction,
        entityType: "transfer",
        action: "update",
        entityId: "tx-from",
        beforeData: {},
      };
      mockRepository.findOne.mockResolvedValue(transferAction);

      await expect(service.undo(userId)).rejects.toThrow(ConflictException);
    });

    it("should return early if afterData is null for transfer create", async () => {
      const transferAction = {
        ...mockAction,
        entityType: "transfer",
        action: "create",
        entityId: "tx-from",
        afterData: null,
      };
      mockRepository.findOne.mockResolvedValue(transferAction);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
      expect(mockQueryRunner.manager.findOne).not.toHaveBeenCalled();
    });

    it("should return early if beforeData is null for transfer delete", async () => {
      const transferAction = {
        ...mockAction,
        entityType: "transfer",
        action: "delete",
        entityId: "tx-from",
        beforeData: null,
        afterData: null,
      };
      mockRepository.findOne.mockResolvedValue(transferAction);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
    });

    it("should return early if fromTransaction or toTransaction is missing", async () => {
      const transferAction = {
        ...mockAction,
        entityType: "transfer",
        action: "delete",
        entityId: "tx-from",
        beforeData: { fromTransaction: null, toTransaction: null },
        afterData: null,
      };
      mockRepository.findOne.mockResolvedValue(transferAction);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
    });
  });

  describe("undo investment transaction", () => {
    it("should undo investment create by removing investment tx and cash tx", async () => {
      const invAction = {
        ...mockAction,
        entityType: "investment_transaction",
        action: "create",
        entityId: "inv-1",
        afterData: { id: "inv-1" },
      };
      mockRepository.findOne.mockResolvedValue(invAction);

      const mockInvTx = {
        id: "inv-1",
        userId,
        accountId: "acc-1",
        transactionId: "cash-tx-1",
      };
      const mockCashTx = {
        id: "cash-tx-1",
        accountId: "acc-2",
      };
      mockQueryRunner.manager.findOne
        .mockResolvedValueOnce(mockInvTx) // InvestmentTransaction
        .mockResolvedValueOnce(mockCashTx); // Cash Transaction
      mockQueryRunner.manager.remove.mockResolvedValue(undefined);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });
      mockQueryRunner.query.mockResolvedValue([
        { opening_balance: "0", tx_sum: "0" },
      ]);

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
      expect(mockQueryRunner.manager.remove).toHaveBeenCalledTimes(2);
    });

    it("should undo investment create without cash transaction", async () => {
      const invAction = {
        ...mockAction,
        entityType: "investment_transaction",
        action: "create",
        entityId: "inv-1",
        afterData: { id: "inv-1" },
      };
      mockRepository.findOne.mockResolvedValue(invAction);

      const mockInvTx = {
        id: "inv-1",
        userId,
        accountId: "acc-1",
        transactionId: null,
      };
      mockQueryRunner.manager.findOne.mockResolvedValueOnce(mockInvTx);
      mockQueryRunner.manager.remove.mockResolvedValue(undefined);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });
      mockQueryRunner.query.mockResolvedValue([]);

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
      // Should only remove inv tx, not cash tx
      expect(mockQueryRunner.manager.remove).toHaveBeenCalledTimes(1);
    });

    it("should undo investment delete by re-inserting with linked cash tx", async () => {
      const invAction = {
        ...mockAction,
        entityType: "investment_transaction",
        action: "delete",
        entityId: "inv-1",
        beforeData: {
          id: "inv-1",
          accountId: "acc-1",
          securityId: "sec-1",
          action: "BUY",
          transactionDate: "2024-01-15",
          quantity: 10,
          price: 100,
          commission: 5,
          totalAmount: 1005,
          linkedCashTransaction: {
            id: "cash-1",
            accountId: "acc-2",
            transactionDate: "2024-01-15",
            amount: -1005,
            currencyCode: "USD",
          },
        },
        afterData: null,
      };
      mockRepository.findOne.mockResolvedValue(invAction);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });
      mockQueryRunner.query.mockResolvedValue([
        { opening_balance: "0", tx_sum: "0" },
      ]);

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
      // Should insert investment transaction and cash transaction
      const insertCalls = mockQueryRunner.query.mock.calls.filter(
        (call: any[]) =>
          typeof call[0] === "string" && call[0].includes("INSERT INTO"),
      );
      expect(insertCalls.length).toBeGreaterThanOrEqual(2);
    });

    it("reinserts idempotently, preserving exchange_rate and a null price", async () => {
      const invAction = {
        ...mockAction,
        entityType: "investment_transaction",
        action: "delete",
        entityId: "inv-1",
        beforeData: {
          id: "inv-1",
          accountId: "acc-1",
          securityId: "sec-1",
          action: "BUY",
          transactionDate: "2024-01-15",
          quantity: 10,
          price: null,
          commission: 0,
          totalAmount: 1360,
          exchangeRate: 1.36,
        },
        afterData: null,
      };
      mockRepository.findOne.mockResolvedValue(invAction);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });
      mockQueryRunner.query.mockResolvedValue([]);

      await service.undo(userId);

      const insert = mockQueryRunner.query.mock.calls.find(
        (call: any[]) =>
          typeof call[0] === "string" &&
          call[0].includes("INSERT INTO investment_transactions"),
      );
      expect(insert).toBeDefined();
      // Idempotent on id collision (client retry / partial residue).
      expect(insert![0]).toContain("ON CONFLICT (id) DO NOTHING");
      expect(insert![0]).toContain("exchange_rate");
      const params = insert![1] as unknown[];
      // price (param 10) preserved as null, not coerced to 0.
      expect(params[9]).toBeNull();
      // exchange_rate (param 13) restored, not reset to 1.
      expect(params[12]).toBe(1.36);
    });

    it("should undo investment delete without linked cash transaction", async () => {
      const invAction = {
        ...mockAction,
        entityType: "investment_transaction",
        action: "delete",
        entityId: "inv-1",
        beforeData: {
          id: "inv-1",
          accountId: "acc-1",
          securityId: "sec-1",
          action: "BUY",
          transactionDate: "2024-01-15",
          quantity: 10,
          price: 100,
        },
        afterData: null,
      };
      mockRepository.findOne.mockResolvedValue(invAction);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });
      mockQueryRunner.query.mockResolvedValue([]);

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
    });

    it("should undo a transfer create by removing both linked legs", async () => {
      const invAction = {
        ...mockAction,
        entityType: "investment_transaction",
        action: "create",
        entityId: "inv-out",
        afterData: {
          id: "inv-out",
          accountId: "acc-1",
          linkedTransferLeg: { id: "inv-in", accountId: "acc-2" },
        },
      };
      mockRepository.findOne.mockResolvedValue(invAction);

      const outLeg = {
        id: "inv-out",
        userId,
        accountId: "acc-1",
        transactionId: null,
        linkedTransactionId: "inv-in",
      };
      const inLeg = {
        id: "inv-in",
        userId,
        accountId: "acc-2",
        transactionId: null,
        linkedTransactionId: "inv-out",
      };
      mockQueryRunner.manager.findOne
        .mockResolvedValueOnce(outLeg) // entity lookup
        .mockResolvedValueOnce(inLeg); // linked leg lookup
      mockQueryRunner.manager.remove.mockResolvedValue(undefined);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });
      mockQueryRunner.query.mockResolvedValue([]);

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
      // Both legs removed so holdings can't be left half-moved.
      expect(mockQueryRunner.manager.remove).toHaveBeenCalledTimes(2);
      // Both legs unlinked before removal to avoid a dangling self-FK.
      const unlinkCalls = mockQueryRunner.manager.update.mock.calls.filter(
        (c: any[]) => c[2] && c[2].linkedTransactionId === null,
      );
      expect(unlinkCalls).toHaveLength(2);
    });

    it("should undo a transfer delete by re-inserting both legs and relinking them", async () => {
      const invAction = {
        ...mockAction,
        entityType: "investment_transaction",
        action: "delete",
        entityId: "inv-out",
        beforeData: {
          id: "inv-out",
          accountId: "acc-1",
          securityId: "sec-1",
          action: "TRANSFER_OUT",
          transactionDate: "2024-01-15",
          quantity: 100,
          price: 1.5,
          linkedTransferLeg: {
            id: "inv-in",
            accountId: "acc-2",
            securityId: "sec-1",
            action: "TRANSFER_IN",
            transactionDate: "2024-01-15",
            quantity: 100,
            price: 1.5,
          },
        },
        afterData: null,
      };
      mockRepository.findOne.mockResolvedValue(invAction);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });
      mockQueryRunner.query.mockResolvedValue([]);

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
      // Both legs re-inserted.
      const insertCalls = mockQueryRunner.query.mock.calls.filter(
        (call: any[]) =>
          typeof call[0] === "string" &&
          call[0].includes("INSERT INTO investment_transactions"),
      );
      expect(insertCalls).toHaveLength(2);
      // Mutual link restored on both legs once both rows exist.
      const relinkCalls = mockQueryRunner.manager.update.mock.calls.filter(
        (c: any[]) => c[2] && typeof c[2].linkedTransactionId === "string",
      );
      expect(relinkCalls).toHaveLength(2);
    });

    it("should undo a transfer update by restoring both legs to their pre-edit state", async () => {
      const invAction = {
        ...mockAction,
        entityType: "investment_transaction",
        action: "update",
        entityId: "inv-out",
        beforeData: {
          id: "inv-out",
          accountId: "acc-1",
          securityId: "sec-1",
          action: "TRANSFER_OUT",
          transactionDate: "2024-01-15",
          quantity: 100,
          price: 1.5,
          linkedTransactionId: "inv-in",
          linkedTransferLeg: {
            id: "inv-in",
            accountId: "acc-2",
            securityId: "sec-1",
            action: "TRANSFER_IN",
            transactionDate: "2024-01-15",
            quantity: 100,
            price: 1.5,
            linkedTransactionId: "inv-out",
          },
        },
        afterData: {
          id: "inv-out",
          accountId: "acc-1",
          quantity: 50,
          linkedTransferLeg: { id: "inv-in", accountId: "acc-2", quantity: 50 },
        },
      };
      mockRepository.findOne.mockResolvedValue(invAction);
      mockQueryRunner.manager.findOne.mockResolvedValue({
        id: "inv-out",
        accountId: "acc-1",
      });
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });
      mockQueryRunner.query.mockResolvedValue([]);

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
      // Both legs restored to their pre-edit values.
      const restoreCalls = mockQueryRunner.manager.update.mock.calls.filter(
        (c: any[]) => c[2] && "quantity" in c[2],
      );
      expect(restoreCalls).toHaveLength(2);
      expect(restoreCalls.every((c: any[]) => c[2].quantity === 100)).toBe(
        true,
      );
    });

    describe("the bond series of a restored row (INV-BOND-007)", () => {
      const PROGRAM = "33333333-3333-5333-8333-333333333333";
      const SERIES = "11111111-1111-5111-8111-111111111111";
      /**
       * The statements of the restore and of the write guard's ledger reads;
       * everything else answers nothing. `ledgers` are the successive answers of
       * the ledger read (before the write, after it); the last repeats.
       */
      const bondWorld = (opts: {
        linked?: boolean;
        inProgram?: string[];
        onSale?: string[];
        ledgers?: Array<Array<Record<string, unknown>>>;
      }) => {
        let ledgerReads = 0;
        return mockQueryRunner.query.mockImplementation(
          async (sql: string, params: unknown[] = []) => {
            const text = String(sql);
            if (text.includes("bond_auto_fetch")) {
              return [
                {
                  id: "sec-1",
                  user_id: userId,
                  symbol: "EDO",
                  currency_code: "PLN",
                  bond_program_id: opts.linked === false ? null : PROGRAM,
                  bond_auto_fetch: false,
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
            // restoredSeries: the snapshot's series, when it is in the program.
            if (text.includes("JOIN bond_instruments i ON")) {
              return opts.linked !== false &&
                (opts.inProgram ?? []).includes(String(params[2]))
                ? [{ "?column?": 1 }]
                : [];
            }
            if (text.includes("saleWindow")) {
              return (opts.onSale ?? []).map((id) => ({ id }));
            }
            return [];
          },
        );
      };
      const deleted = (before: Record<string, unknown>) => ({
        ...mockAction,
        entityType: "investment_transaction",
        action: "delete",
        entityId: "inv-1",
        beforeData: {
          id: "inv-1",
          accountId: "acc-1",
          securityId: "sec-1",
          action: "BUY",
          transactionDate: "2026-10-15",
          quantity: 10,
          price: 100,
          commission: 0,
          totalAmount: 1000,
          ...before,
        },
        afterData: null,
      });
      const insert = () =>
        mockQueryRunner.query.mock.calls.find(
          (call: any[]) =>
            typeof call[0] === "string" &&
            call[0].includes("INSERT INTO investment_transactions"),
        );

      it("reinserts a deleted row with the series its snapshot carried", async () => {
        bondWorld({ inProgram: [SERIES] });
        mockRepository.findOne.mockResolvedValue(
          deleted({ bondInstrumentId: SERIES }),
        );
        mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });
        await service.undo(userId);
        expect(insert()![0]).toContain("bond_instrument_id");
        // The sixteenth parameter, after created_at.
        expect((insert()![1] as unknown[])[15]).toBe(SERIES);
      });

      it("restores a snapshot that carries no series with NULL, never inferring one from the date", async () => {
        bondWorld({ onSale: [SERIES] });
        mockRepository.findOne.mockResolvedValue(deleted({}));
        mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });
        await service.undo(userId);
        expect((insert()![1] as unknown[])[15]).toBeNull();
      });

      it("never refuses an undo with SERIES_NOT_DETERMINED, even when no series covers the restored purchase's date", async () => {
        bondWorld({ onSale: [] });
        mockRepository.findOne.mockResolvedValue(deleted({}));
        mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });
        await expect(service.undo(userId)).resolves.toBeDefined();
        expect((insert()![1] as unknown[])[15]).toBeNull();
      });

      it("restores a series the security's current program does not hold as NULL, for the ledger to report", async () => {
        bondWorld({ inProgram: [] });
        mockRepository.findOne.mockResolvedValue(
          deleted({ bondInstrumentId: SERIES }),
        );
        mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });
        await service.undo(userId);
        expect((insert()![1] as unknown[])[15]).toBeNull();
      });

      it("refuses the undo of a delete after which a removal is not covered (OVER_REMOVAL), and does not reinsert past it", async () => {
        const sell = {
          id: "inv-1",
          action: "SELL",
          status: "UNRECONCILED",
          tx_date: "2026-10-15",
          quantity: "10",
          account_id: "acc-1",
          bond_instrument_id: null,
          counterpart_account_id: null,
        };
        bondWorld({ ledgers: [[], [sell]] });
        mockRepository.findOne.mockResolvedValue(deleted({ action: "SELL" }));
        mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });
        await expect(service.undo(userId)).rejects.toMatchObject({
          response: { errorCode: "OVER_REMOVAL" },
        });
      });

      it("refuses the undo of a create (a delete) that leaves a later removal uncovered (REMOVAL_EXCEEDS_SERIES)", async () => {
        const row = (over: Record<string, unknown>) => ({
          id: "inv-1",
          action: "BUY",
          status: "UNRECONCILED",
          tx_date: "2026-01-10",
          quantity: "10",
          account_id: "acc-1",
          bond_instrument_id: SERIES,
          counterpart_account_id: null,
          ...over,
        });
        const sell = row({
          id: "s1",
          action: "SELL",
          tx_date: "2026-02-01",
          quantity: "8",
        });
        bondWorld({ ledgers: [[row({}), sell], [sell]] });
        mockRepository.findOne.mockResolvedValue({
          ...mockAction,
          entityType: "investment_transaction",
          action: "create",
          entityId: "inv-1",
        });
        mockQueryRunner.manager.findOne.mockResolvedValue({
          id: "inv-1",
          accountId: "acc-1",
          securityId: "sec-1",
          linkedTransactionId: null,
          transactionId: null,
        });
        await expect(service.undo(userId)).rejects.toMatchObject({
          response: { errorCode: "REMOVAL_EXCEEDS_SERIES" },
        });
      });

      it("restores a security that is no longer linked without the series", async () => {
        bondWorld({ linked: false, inProgram: [SERIES] });
        mockRepository.findOne.mockResolvedValue(
          deleted({ bondInstrumentId: SERIES }),
        );
        mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });
        await service.undo(userId);
        expect((insert()![1] as unknown[])[15]).toBeNull();
      });

      it("restores both legs of a transfer update with their series", async () => {
        bondWorld({ inProgram: [SERIES] });
        mockRepository.findOne.mockResolvedValue({
          ...mockAction,
          entityType: "investment_transaction",
          action: "update",
          entityId: "inv-out",
          beforeData: {
            id: "inv-out",
            accountId: "acc-1",
            securityId: "sec-1",
            action: "TRANSFER_OUT",
            transactionDate: "2026-11-01",
            quantity: 100,
            bondInstrumentId: SERIES,
            linkedTransferLeg: {
              id: "inv-in",
              accountId: "acc-2",
              securityId: "sec-1",
              action: "TRANSFER_IN",
              transactionDate: "2026-11-01",
              quantity: 100,
              bondInstrumentId: SERIES,
            },
          },
          afterData: { id: "inv-out", accountId: "acc-1" },
        });
        mockQueryRunner.manager.findOne.mockResolvedValue({
          id: "inv-out",
          accountId: "acc-1",
        });
        mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });
        await service.undo(userId);
        const restored = mockQueryRunner.manager.update.mock.calls.filter(
          (c: any[]) => c[2] && "bondInstrumentId" in c[2],
        );
        expect(restored.map((c: any[]) => c[2].bondInstrumentId)).toEqual([
          SERIES,
          SERIES,
        ]);
      });
    });

    it("should not undo a regular (non-transfer) investment update", async () => {
      const invAction = {
        ...mockAction,
        entityType: "investment_transaction",
        action: "update",
        entityId: "inv-1",
        beforeData: { id: "inv-1", accountId: "acc-1", quantity: 10 },
      };
      mockRepository.findOne.mockResolvedValue(invAction);

      await expect(service.undo(userId)).rejects.toThrow(ConflictException);
    });

    it("should throw ConflictException for unsupported investment action", async () => {
      const invAction = {
        ...mockAction,
        entityType: "investment_transaction",
        action: "update",
        entityId: "inv-1",
        beforeData: {},
      };
      mockRepository.findOne.mockResolvedValue(invAction);

      await expect(service.undo(userId)).rejects.toThrow(ConflictException);
    });

    it("should return early if entityId is null for investment create", async () => {
      const invAction = {
        ...mockAction,
        entityType: "investment_transaction",
        action: "create",
        entityId: null,
      };
      mockRepository.findOne.mockResolvedValue(invAction);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
      expect(mockQueryRunner.manager.findOne).not.toHaveBeenCalled();
    });

    it("should undo investment delete with null transactionId when linkedCashTransaction is missing", async () => {
      // Older action history records may not have linkedCashTransaction captured.
      // The investment transaction should still be re-inserted with transaction_id = NULL
      // to avoid a FK violation on a deleted cash transaction.
      const invAction = {
        ...mockAction,
        entityType: "investment_transaction",
        action: "delete",
        entityId: "inv-1",
        beforeData: {
          id: "inv-1",
          accountId: "acc-1",
          securityId: "sec-1",
          transactionId: "deleted-cash-tx-1",
          action: "BUY",
          transactionDate: "2024-01-15",
          quantity: 10,
          price: 100,
          commission: 5,
          totalAmount: 1005,
        },
        afterData: null,
      };
      mockRepository.findOne.mockResolvedValue(invAction);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });
      mockQueryRunner.query.mockResolvedValue([]);

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
      // Should insert the investment transaction
      const insertCalls = mockQueryRunner.query.mock.calls.filter(
        (call: any[]) =>
          typeof call[0] === "string" &&
          call[0].includes("INSERT INTO investment_transactions"),
      );
      expect(insertCalls.length).toBe(1);
      // transaction_id parameter (index 3) should be null, not the stale FK
      expect(insertCalls[0][1][3]).toBeNull();
      // Should NOT insert a cash transaction
      const cashInsertCalls = mockQueryRunner.query.mock.calls.filter(
        (call: any[]) =>
          typeof call[0] === "string" &&
          call[0].includes("INSERT INTO transactions"),
      );
      expect(cashInsertCalls.length).toBe(0);
    });

    it("should insert cash transaction before investment transaction when undoing delete", async () => {
      const invAction = {
        ...mockAction,
        entityType: "investment_transaction",
        action: "delete",
        entityId: "inv-1",
        beforeData: {
          id: "inv-1",
          accountId: "acc-1",
          securityId: "sec-1",
          transactionId: "cash-1",
          action: "BUY",
          transactionDate: "2024-01-15",
          quantity: 10,
          price: 100,
          commission: 5,
          totalAmount: 1005,
          linkedCashTransaction: {
            id: "cash-1",
            accountId: "acc-2",
            transactionDate: "2024-01-15",
            amount: -1005,
            currencyCode: "USD",
          },
        },
        afterData: null,
      };
      mockRepository.findOne.mockResolvedValue(invAction);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });
      mockQueryRunner.query.mockResolvedValue([
        { opening_balance: "0", tx_sum: "0" },
      ]);

      await service.undo(userId);

      // Verify ordering: cash transaction INSERT comes before investment transaction INSERT
      const insertCalls = mockQueryRunner.query.mock.calls
        .map((call: any[], idx: number) => ({ sql: call[0], idx }))
        .filter(
          (c: any) =>
            typeof c.sql === "string" && c.sql.includes("INSERT INTO"),
        );
      const cashInsertIdx = insertCalls.find((c: any) =>
        c.sql.includes("INSERT INTO transactions"),
      )?.idx;
      const invInsertIdx = insertCalls.find((c: any) =>
        c.sql.includes("INSERT INTO investment_transactions"),
      )?.idx;
      expect(cashInsertIdx).toBeDefined();
      expect(invInsertIdx).toBeDefined();
      expect(cashInsertIdx).toBeLessThan(invInsertIdx);
      // transaction_id should reference the restored cash tx
      const invInsertCall = mockQueryRunner.query.mock.calls.find(
        (call: any[]) =>
          typeof call[0] === "string" &&
          call[0].includes("INSERT INTO investment_transactions"),
      );
      expect(invInsertCall[1][3]).toBe("cash-1");
    });

    /**
     * A26-L21: the undo re-derives the account through the canonical fold on
     * the undo's own manager, not a second copy of it (which added a
     * DIVIDEND's total to the basis and stored the average at 6 decimals).
     * The fold's own arithmetic -- over-sells carried as negative included --
     * is holdings.service.spec.ts's; holding-undo-fold.integration.spec.ts
     * proves the stored row against the drift report.
     */
    it("re-derives the account's holdings through HoldingsService on the undo's manager", async () => {
      const invAction = {
        ...mockAction,
        entityType: "investment_transaction",
        action: "create",
        entityId: "inv-1",
        afterData: { id: "inv-1" },
      };
      mockRepository.findOne.mockResolvedValue(invAction);

      mockQueryRunner.manager.findOne.mockResolvedValueOnce({
        id: "inv-1",
        userId,
        accountId: "acc-1",
        transactionId: null,
      });
      mockQueryRunner.manager.remove.mockResolvedValue(undefined);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });

      await service.undo(userId);

      expect(holdings.rebuildAccountsFromTransactions).toHaveBeenCalledWith(
        userId,
        ["acc-1"],
        mockQueryRunner.manager,
      );
      const handRolled = mockQueryRunner.query.mock.calls.filter(
        (call: any[]) =>
          typeof call[0] === "string" &&
          /(DELETE FROM|INSERT INTO) holdings/.test(call[0]),
      );
      expect(handRolled).toEqual([]);
    });
  });

  describe("undo bulk transaction", () => {
    it("should undo bulk delete by re-inserting transactions", async () => {
      const bulkAction = {
        ...mockAction,
        entityType: "bulk_transaction",
        action: "bulk_delete",
        entityId: null,
        beforeData: {
          transactions: [
            {
              id: "tx-1",
              accountId: "acc-1",
              transactionDate: "2024-01-15",
              amount: -50,
              currencyCode: "USD",
            },
            {
              id: "tx-2",
              accountId: "acc-2",
              transactionDate: "2024-01-16",
              amount: -75,
              currencyCode: "USD",
            },
          ],
        },
      };
      mockRepository.findOne.mockResolvedValue(bulkAction);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });
      mockQueryRunner.query.mockResolvedValue([
        { opening_balance: "0", tx_sum: "0" },
      ]);

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
      const insertCalls = mockQueryRunner.query.mock.calls.filter(
        (call: any[]) =>
          typeof call[0] === "string" &&
          call[0].includes("INSERT INTO transactions"),
      );
      expect(insertCalls.length).toBe(2);
    });

    it("should undo bulk update by restoring original field values", async () => {
      const bulkAction = {
        ...mockAction,
        entityType: "bulk_transaction",
        action: "bulk_update",
        entityId: null,
        beforeData: {
          transactions: [
            {
              id: "tx-1",
              accountId: "acc-1",
              categoryId: "cat-old",
              tagIds: ["tag-1"],
            },
            {
              id: "tx-2",
              accountId: "acc-1",
              amount: 50,
            },
          ],
        },
      };
      mockRepository.findOne.mockResolvedValue(bulkAction);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });
      mockQueryRunner.query.mockResolvedValue([
        { opening_balance: "0", tx_sum: "0" },
      ]);

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
      // Should update both transactions
      expect(mockQueryRunner.manager.update).toHaveBeenCalledWith(
        expect.any(Function),
        "tx-1",
        expect.objectContaining({ categoryId: "cat-old" }),
      );
      // Should restore tags for tx-1
      expect(mockQueryRunner.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO transaction_tags"),
        ["tx-1", "tag-1"],
      );
      // Backward compat: rows recorded before split snapshots existed carry no
      // `splits` key, and must not produce any transaction_splits write.
      const splitCalls = mockQueryRunner.query.mock.calls.filter(
        (call: any[]) =>
          typeof call[0] === "string" &&
          call[0].includes("UPDATE transaction_splits"),
      );
      expect(splitCalls).toHaveLength(0);
    });

    it.each(["undo", "redo"] as const)(
      "refuses the %s of a bulk update that touches a reconciled row under the lock, before any write",
      async (which) => {
        const rows = [
          { id: "tx-1", accountId: "acc-1", status: "UNRECONCILED" },
          { id: "tx-2", accountId: "acc-1", status: "RECONCILED" },
        ];
        mockRepository.findOne.mockResolvedValue({
          ...mockAction,
          entityType: "bulk_transaction",
          action: "bulk_update",
          entityId: null,
          beforeData: { transactions: rows },
          afterData: {
            transactions: rows.map((r) => ({ ...r, status: "UNRECONCILED" })),
          },
        });
        mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });
        mockLockedRows({
          "tx-1": { account_id: "acc-1", amount: "-5" },
          "tx-2": { account_id: "acc-1", amount: "-5", status: "RECONCILED" },
        });
        const routeRepository =
          mockQueryRunner.manager.getRepository.getMockImplementation();
        mockQueryRunner.manager.getRepository.mockImplementation(
          (entity: unknown) =>
            entity === UserPreference
              ? {
                  findOne: jest
                    .fn()
                    .mockResolvedValue({ lockReconciledTransactions: true }),
                }
              : routeRepository(entity),
        );

        await expect(
          which === "undo" ? service.undo(userId) : service.redo(userId),
        ).rejects.toBeInstanceOf(ConflictException);

        expect(mockQueryRunner.manager.update).not.toHaveBeenCalled();
      },
    );

    it("should restore split-line categories through the user-scoped parent join", async () => {
      const bulkAction = {
        ...mockAction,
        entityType: "bulk_transaction",
        action: "bulk_update",
        entityId: null,
        beforeData: {
          transactions: [
            {
              id: "tx-2",
              accountId: "acc-1",
              splits: [
                { id: "split-1", categoryId: "cat-old" },
                // A null before-category must restore NULL, not a default.
                { id: "split-2", categoryId: null },
              ],
            },
          ],
        },
      };
      mockRepository.findOne.mockResolvedValue(bulkAction);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });
      mockQueryRunner.query.mockResolvedValue([
        { opening_balance: "0", tx_sum: "0" },
      ]);

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
      const splitCalls = mockQueryRunner.query.mock.calls.filter(
        (call: any[]) =>
          typeof call[0] === "string" &&
          call[0].includes("UPDATE transaction_splits"),
      );
      expect(splitCalls).toHaveLength(2);
      // I3: transaction_splits has no user_id, so the write is scoped through
      // its parent transaction with the acting user parameterized.
      expect(splitCalls[0][0]).toContain("EXISTS");
      expect(splitCalls[0][0]).toContain("t.user_id = $3");
      expect(splitCalls[0][1]).toEqual(["cat-old", "split-1", userId]);
      expect(splitCalls[1][1]).toEqual([null, "split-2", userId]);
    });

    it("should redo a bulk update by applying the after side's split categories", async () => {
      // executeRedo swaps before/after, so redo replays afterData's splits.
      const bulkAction = {
        ...mockAction,
        entityType: "bulk_transaction",
        action: "bulk_update",
        entityId: null,
        isUndone: true,
        beforeData: {
          transactions: [
            {
              id: "tx-2",
              accountId: "acc-1",
              splits: [{ id: "split-1", categoryId: "cat-old" }],
            },
          ],
        },
        afterData: {
          transactions: [
            {
              id: "tx-2",
              accountId: "acc-1",
              splits: [{ id: "split-1", categoryId: "cat-new" }],
            },
          ],
        },
      };
      mockRepository.findOne.mockResolvedValue(bulkAction);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });
      mockQueryRunner.query.mockResolvedValue([
        { opening_balance: "0", tx_sum: "0" },
      ]);

      const result = await service.redo(userId);

      expect(result.description).toContain("Redone");
      const splitCalls = mockQueryRunner.query.mock.calls.filter(
        (call: any[]) =>
          typeof call[0] === "string" &&
          call[0].includes("UPDATE transaction_splits"),
      );
      expect(splitCalls).toHaveLength(1);
      expect(splitCalls[0][1]).toEqual(["cat-new", "split-1", userId]);
    });

    it("should throw ConflictException for unsupported bulk action", async () => {
      const bulkAction = {
        ...mockAction,
        entityType: "bulk_transaction",
        action: "create",
        entityId: null,
      };
      mockRepository.findOne.mockResolvedValue(bulkAction);

      await expect(service.undo(userId)).rejects.toThrow(ConflictException);
    });

    it("should return early if beforeData has no transactions array", async () => {
      const bulkAction = {
        ...mockAction,
        entityType: "bulk_transaction",
        action: "bulk_delete",
        entityId: null,
        beforeData: null,
      };
      mockRepository.findOne.mockResolvedValue(bulkAction);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
    });
  });

  describe("undo simple entity (additional entity types)", () => {
    it("should undo account create", async () => {
      const action = {
        ...mockAction,
        entityType: "account",
        action: "create",
        entityId: "acc-1",
        afterData: { id: "acc-1", name: "Chequing" },
      };
      mockRepository.findOne.mockResolvedValue(action);
      mockQueryRunner.manager.delete.mockResolvedValue({ affected: 1 });
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
      expect(mockQueryRunner.manager.delete).toHaveBeenCalled();
    });

    it("re-inserts a deleted account recorded before the mortgage-type contract with its type", async () => {
      // docs/specs/mortgage-types.md, task P3-B1: the snapshot carries the
      // legacy flags and a null type, which would read as ANNUITY.
      const action = {
        ...mockAction,
        entityType: "account",
        action: "delete",
        entityId: "acc-1",
        beforeData: {
          id: "acc-1",
          name: "Home",
          accountType: "MORTGAGE",
          mortgageType: null,
          isCanadianMortgage: true,
          isVariableRate: false,
        },
        afterData: null,
      };
      mockRepository.findOne.mockResolvedValue(action);
      mockQueryRunner.query.mockResolvedValue([]);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });

      await service.undo(userId);

      const insert = mockQueryRunner.query.mock.calls.find(([sql]: [string]) =>
        sql.includes('INSERT INTO "accounts"'),
      );
      expect(insert[0]).toContain('"mortgage_type"');
      expect(insert[0]).not.toContain("is_canadian_mortgage");
      expect(insert[0]).not.toContain("is_variable_rate");
      expect(insert[1]).toContain("CANADIAN_FIXED");
    });

    it("restores an account update recorded before the contract without a null type", async () => {
      const action = {
        ...mockAction,
        entityType: "account",
        action: "update",
        entityId: "acc-1",
        beforeData: {
          id: "acc-1",
          name: "Chequing",
          accountType: "CHEQUING",
          mortgageType: null,
          isCanadianMortgage: false,
          isVariableRate: false,
        },
        afterData: { id: "acc-1", name: "Renamed" },
      };
      mockRepository.findOne.mockResolvedValue(action);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });

      await service.undo(userId);

      const [, , fields] = mockQueryRunner.manager.update.mock.calls.find(
        ([, id]: [unknown, string]) => id === "acc-1",
      );
      expect(fields).toMatchObject({
        name: "Chequing",
        mortgageType: "ANNUITY",
      });
      expect(fields).not.toHaveProperty("isCanadianMortgage");
    });

    it("undoes an account edit without writing derived or lifecycle columns back (A26-H06)", async () => {
      const action = {
        ...mockAction,
        entityType: "account",
        action: "update",
        entityId: "acc-1",
        beforeData: {
          id: "acc-1",
          name: "Chequing",
          openingBalance: 5000,
          currentBalance: 5000,
          isClosed: false,
          closedDate: null,
          linkedAccountId: null,
        },
        afterData: {
          id: "acc-1",
          name: "Renamed",
          openingBalance: 5000,
          currentBalance: 5000,
          isClosed: false,
          closedDate: null,
          linkedAccountId: null,
        },
      };
      mockRepository.findOne.mockResolvedValue(action);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });

      await service.undo(userId);

      const accountUpdate = mockQueryRunner.manager.update.mock.calls.find(
        (call: unknown[]) => call[1] === "acc-1",
      );
      expect(accountUpdate[2]).toEqual({
        name: "Chequing",
        openingBalance: 5000,
      });
      // The opening balance did not change, so nothing is recomputed.
      expect(mockQueryRunner.query).not.toHaveBeenCalledWith(
        expect.stringContaining("SET current_balance"),
        expect.anything(),
      );
    });

    it.each([
      [
        "a method change",
        { mortgageType: "ANNUITY" },
        { mortgageType: "LINEAR" },
      ],
      [
        "an interest-category change",
        { interestCategoryId: "cat-a" },
        { interestCategoryId: "cat-b" },
      ],
    ])(
      "refuses undo of %s on a loan with a schedule, writing nothing (A26-H06)",
      async (_label, beforeLoan, afterLoan) => {
        const action = {
          ...mockAction,
          entityType: "account",
          action: "update",
          entityId: "loan-1",
          beforeData: {
            id: "loan-1",
            scheduledTransactionId: "st-1",
            ...beforeLoan,
          },
          afterData: {
            id: "loan-1",
            scheduledTransactionId: "st-1",
            ...afterLoan,
          },
        };
        mockRepository.findOne.mockResolvedValue(action);

        await expect(service.undo(userId)).rejects.toBeInstanceOf(
          ConflictException,
        );
        expect(mockQueryRunner.manager.update).not.toHaveBeenCalled();
      },
    );

    it("should undo scheduled_transaction delete", async () => {
      const action = {
        ...mockAction,
        entityType: "scheduled_transaction",
        action: "delete",
        entityId: "st-1",
        beforeData: {
          id: "st-1",
          name: "Rent",
          userId,
          accountId: "acc-1",
          amount: -1500,
          frequency: "MONTHLY",
        },
        afterData: null,
      };
      mockRepository.findOne.mockResolvedValue(action);
      mockQueryRunner.query.mockResolvedValue([]);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
      expect(mockQueryRunner.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO "scheduled_transactions"'),
        expect.any(Array),
      );
    });

    it("should undo security update", async () => {
      const action = {
        ...mockAction,
        entityType: "security",
        action: "update",
        entityId: "sec-1",
        beforeData: {
          id: "sec-1",
          symbol: "AAPL",
          name: "Apple Inc.",
          userId,
        },
        afterData: {
          id: "sec-1",
          symbol: "AAPL",
          name: "Apple Inc. Updated",
        },
      };
      mockRepository.findOne.mockResolvedValue(action);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
      expect(mockQueryRunner.manager.update).toHaveBeenCalledWith(
        expect.any(Function),
        "sec-1",
        expect.objectContaining({ symbol: "AAPL", name: "Apple Inc." }),
      );
    });

    describe("a security edit that touches the bond link (R4)", () => {
      const INSTRUMENT = "11111111-1111-5111-8111-111111111111";
      const edit = (before: Record<string, unknown>, after = {}) => ({
        ...mockAction,
        entityType: "security",
        action: "update",
        entityId: "sec-1",
        beforeData: { id: "sec-1", userId, symbol: "EDO1036", ...before },
        afterData: { id: "sec-1", symbol: "EDO1036", ...after },
      });
      /** The security row as it is now (locked) and the instrument's currency. */
      const answer = (
        current: Record<string, unknown>,
        instrumentCurrency: string | null = "PLN",
      ) =>
        mockQueryRunner.query.mockImplementation(async (sql: string) => {
          if (/FROM securities/.test(sql)) return [current];
          if (/FROM bond_programs/.test(sql))
            return instrumentCurrency === null
              ? []
              : [{ currency_code: instrumentCurrency }];
          return [];
        });

      it("clears the series the rows name when the restored link differs (INV-BOND-007)", async () => {
        answer({
          bond_program_id: INSTRUMENT,
          security_type: "BOND",
          currency_code: "PLN",
        });
        mockRepository.findOne.mockResolvedValue(
          edit({ bondProgramId: null, securityType: "BOND" }),
        );
        mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });
        await service.undo(userId);
        const clear = mockQueryRunner.query.mock.calls.find(
          (c: any[]) =>
            typeof c[0] === "string" &&
            c[0].includes("UPDATE investment_transactions"),
        );
        expect(clear).toBeDefined();
        expect(clear![1]).toEqual(["sec-1", userId, null]);
      });

      it("clears nothing when the restored link is the one the security has", async () => {
        answer({
          bond_program_id: INSTRUMENT,
          security_type: "BOND",
          currency_code: "PLN",
        });
        mockRepository.findOne.mockResolvedValue(
          edit({ bondProgramId: INSTRUMENT, securityType: "BOND" }),
        );
        mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });
        await service.undo(userId);
        expect(
          mockQueryRunner.query.mock.calls.some(
            (c: any[]) =>
              typeof c[0] === "string" &&
              c[0].includes("UPDATE investment_transactions"),
          ),
        ).toBe(false);
      });

      it("restores the link with the currency, deletes the engine's prices of the old link, and prices nothing for an unlink", async () => {
        answer({
          bond_program_id: INSTRUMENT,
          security_type: "BOND",
          currency_code: "PLN",
        });
        mockRepository.findOne.mockResolvedValue(
          edit({
            bondProgramId: null,
            currencyCode: "USD",
            securityType: "BOND",
          }),
        );
        mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });

        await service.undo(userId);

        expect(bondPrices.clearEnginePrices).toHaveBeenCalledWith(
          mockQueryRunner.manager,
          userId,
          "sec-1",
        );
        expect(mockQueryRunner.manager.update).toHaveBeenCalledWith(
          expect.any(Function),
          "sec-1",
          expect.objectContaining({
            bondProgramId: null,
            currencyCode: "USD",
          }),
        );
        expect(bondPrices.publishClearedPrices).toHaveBeenCalledWith(userId, [
          "acct-1",
        ]);
        expect(bondPrices.recomputeLinkedSecurities).not.toHaveBeenCalled();
      });

      it("re-links through the same validation and recomputes after the commit", async () => {
        answer({
          bond_program_id: null,
          security_type: "BOND",
          currency_code: "PLN",
        });
        mockRepository.findOne.mockResolvedValue(
          edit({
            bondProgramId: INSTRUMENT,
            currencyCode: "PLN",
            securityType: "BOND",
          }),
        );
        mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });

        await service.undo(userId);

        expect(bondPrices.recomputeLinkedSecurities).toHaveBeenCalledWith(
          userId,
          ["sec-1"],
        );
      });

      it.each([
        ["the instrument is in another currency", "EUR", "BOND", INSTRUMENT],
        ["the instrument no longer exists", null, "BOND", INSTRUMENT],
        ["the security is no longer a BOND", "PLN", "ETF", INSTRUMENT],
      ])(
        "refuses with UNDO_LINK_INVALID and writes nothing when %s",
        async (_why, instrumentCurrency, securityType, link) => {
          answer(
            {
              bond_program_id: null,
              security_type: "BOND",
              currency_code: "PLN",
            },
            instrumentCurrency,
          );
          mockRepository.findOne.mockResolvedValue(
            edit({
              bondProgramId: link,
              currencyCode: "PLN",
              securityType,
            }),
          );

          await expect(service.undo(userId)).rejects.toThrow(ConflictException);

          expect(mockQueryRunner.manager.update).not.toHaveBeenCalled();
          expect(bondPrices.clearEnginePrices).not.toHaveBeenCalled();
          expect(bondPrices.recomputeLinkedSecurities).not.toHaveBeenCalled();
        },
      );

      it("refuses restoring only the currency while the link stays to an instrument in another currency", async () => {
        answer({
          bond_program_id: INSTRUMENT,
          security_type: "BOND",
          currency_code: "PLN",
        });
        mockRepository.findOne.mockResolvedValue(
          edit({ currencyCode: "USD", bondProgramId: INSTRUMENT }),
        );

        await expect(service.undo(userId)).rejects.toThrow(ConflictException);
        expect(mockQueryRunner.manager.update).not.toHaveBeenCalled();
      });

      it("does not clear or recompute when the link is the same in another spelling", async () => {
        answer({
          bond_program_id: INSTRUMENT,
          security_type: "BOND",
          currency_code: "PLN",
        });
        mockRepository.findOne.mockResolvedValue(
          edit({
            bondProgramId: INSTRUMENT.toUpperCase(),
            currencyCode: "PLN",
            securityType: "BOND",
          }),
        );
        mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });

        await service.undo(userId);

        expect(bondPrices.clearEnginePrices).not.toHaveBeenCalled();
        expect(bondPrices.recomputeLinkedSecurities).not.toHaveBeenCalled();
      });

      it("redo applies the edit's own snapshot through the same guard", async () => {
        answer({
          bond_program_id: null,
          security_type: "BOND",
          currency_code: "USD",
        });
        mockRepository.findOne.mockResolvedValue({
          ...edit(
            { bondProgramId: null, currencyCode: "USD" },
            {
              bondProgramId: INSTRUMENT,
              currencyCode: "PLN",
              securityType: "BOND",
            },
          ),
          isUndone: true,
        });
        mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });

        await service.redo(userId);

        expect(bondPrices.recomputeLinkedSecurities).toHaveBeenCalledWith(
          userId,
          ["sec-1"],
        );
      });
    });

    it.each([
      ["undo", false],
      ["redo", true],
    ])(
      "%s of an investment transaction recomputes the engine prices of its securities after the commit",
      async (which, isUndone) => {
        mockRepository.findOne.mockResolvedValue({
          ...mockAction,
          entityType: "investment_transaction",
          action: "update",
          entityId: "itx-1",
          isUndone,
          beforeData: {
            id: "itx-1",
            securityId: "sec-1",
            linkedTransferLeg: { securityId: "sec-2" },
          },
          afterData: { id: "itx-1", securityId: "sec-1" },
        });
        jest
          .spyOn(service as any, "undoInvestmentTransaction")
          .mockResolvedValue(undefined);

        await (which === "undo" ? service.undo(userId) : service.redo(userId));

        expect(bondPrices.recomputeLinkedSecurities).toHaveBeenCalledWith(
          userId,
          ["sec-1", "sec-2"],
        );
      },
    );

    it("should undo budget delete", async () => {
      const action = {
        ...mockAction,
        entityType: "budget",
        action: "delete",
        entityId: "bud-1",
        beforeData: {
          id: "bud-1",
          name: "Monthly Budget",
          userId,
          budgetType: "MONTHLY",
        },
        afterData: null,
      };
      mockRepository.findOne.mockResolvedValue(action);
      mockQueryRunner.query.mockResolvedValue([]);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
      expect(mockQueryRunner.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO "budgets"'),
        expect.any(Array),
      );
    });

    it("should throw ConflictException for unsupported action in undoSimpleEntity", async () => {
      const action = {
        ...mockAction,
        entityType: "tag",
        action: "bulk_delete",
        entityId: "tag-1",
      };
      mockRepository.findOne.mockResolvedValue(action);

      await expect(service.undo(userId)).rejects.toThrow(ConflictException);
    });

    it("should filter out relation properties from update using ALLOWED_COLUMNS", async () => {
      const action = {
        ...mockAction,
        entityType: "tag",
        action: "update",
        entityId: "tag-1",
        beforeData: {
          id: "tag-1",
          name: "Old Name",
          userId,
          createdAt: "2024-01-01",
          updatedAt: "2024-01-01",
          // These should be filtered out (not in ALLOWED_COLUMNS for tags)
          transactions: [{ id: "tx-1" }],
          someRelation: { id: "rel-1" },
        },
      };
      mockRepository.findOne.mockResolvedValue(action);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
      // The update should only include name (id, userId, createdAt, updatedAt are removed explicitly)
      expect(mockQueryRunner.manager.update).toHaveBeenCalledWith(
        expect.any(Function),
        "tag-1",
        expect.objectContaining({ name: "Old Name" }),
      );
      // The update should NOT include relation properties
      const updateCall = mockQueryRunner.manager.update.mock.calls.find(
        (call: any[]) => call[1] === "tag-1",
      );
      expect(updateCall[2]).not.toHaveProperty("transactions");
      expect(updateCall[2]).not.toHaveProperty("someRelation");
    });
  });

  describe("redo", () => {
    it("should redo a create action (which becomes delete)", async () => {
      const undoneCreateAction = {
        ...mockAction,
        action: "create",
        entityType: "tag",
        entityId: "tag-1",
        isUndone: true,
        beforeData: null,
        afterData: { id: "tag-1", name: "Test Tag", userId },
      };
      mockRepository.findOne.mockResolvedValue(undoneCreateAction);
      mockQueryRunner.query.mockResolvedValue([]);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });

      const result = await service.redo(userId);

      expect(result.description).toContain("Redone");
      expect(mockDataSource.transaction).toHaveBeenCalled();
    });

    it("should rollback on redo error", async () => {
      const undoneAction = {
        ...mockAction,
        action: "create",
        entityType: "tag",
        entityId: "tag-1",
        isUndone: true,
        afterData: { id: "tag-1", name: "Test", userId },
      };
      mockRepository.findOne.mockResolvedValue(undoneAction);
      mockQueryRunner.query.mockRejectedValue(new Error("DB error"));

      await expect(service.redo(userId)).rejects.toThrow("DB error");
      expect(mockDataSource.transaction).toHaveBeenCalled();
      expect(mockDataSource.transaction).toHaveBeenCalled();
    });
  });

  describe("undo transaction create (edge cases)", () => {
    it("should return early if transaction not found", async () => {
      const txAction = {
        ...mockAction,
        entityType: "transaction",
        action: "create",
        entityId: "tx-1",
        afterData: { id: "tx-1" },
      };
      mockRepository.findOne.mockResolvedValue(txAction);
      mockQueryRunner.manager.findOne.mockResolvedValue(null);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
      expect(mockQueryRunner.manager.remove).not.toHaveBeenCalled();
    });

    it("should delete splits when transaction has splits", async () => {
      const txAction = {
        ...mockAction,
        entityType: "transaction",
        action: "create",
        entityId: "tx-1",
        afterData: { id: "tx-1", accountId: "acc-1" },
      };
      mockRepository.findOne.mockResolvedValue(txAction);

      const mockTransaction = {
        id: "tx-1",
        userId,
        accountId: "acc-1",
        amount: 100,
        splits: [
          { id: "s1", amount: 60 },
          { id: "s2", amount: 40 },
        ],
      };
      mockQueryRunner.manager.findOne.mockResolvedValue(mockTransaction);
      mockQueryRunner.manager.delete.mockResolvedValue({ affected: 2 });
      mockQueryRunner.manager.remove.mockResolvedValue(undefined);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });
      mockLockedRows({ "tx-1": { account_id: "acc-1", amount: "100" } });

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
      expect(mockQueryRunner.manager.delete).toHaveBeenCalled();
      expect(mockQueryRunner.manager.remove).toHaveBeenCalled();
    });

    describe("a create that wrote legs in other accounts", () => {
      // A rule's convert_to_transfer (or split with a transfer part) writes a
      // counterpart leg in another account in the create's own transaction.
      // Undoing the create must remove it and reverse its balance.
      const createAction = (after: Record<string, unknown>) => ({
        ...mockAction,
        entityType: "transaction",
        action: "create",
        entityId: "tx-1",
        afterData: after,
      });

      it("removes the transfer counterpart and reverses its balance", async () => {
        mockRepository.findOne.mockResolvedValue(
          createAction({ id: "tx-1", accountId: "acc-1" }),
        );
        mockQueryRunner.manager.findOne.mockResolvedValue({
          id: "tx-1",
          userId,
          accountId: "acc-1",
          amount: -640.15,
          isTransfer: true,
          linkedTransactionId: "leg-1",
          splits: [],
        });
        mockQueryRunner.manager.delete.mockResolvedValue({ affected: 1 });
        mockQueryRunner.manager.remove.mockResolvedValue(undefined);
        mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });
        mockLockedRows({
          "tx-1": {
            account_id: "acc-1",
            amount: "-640.15",
            linked_transaction_id: "leg-1",
          },
          "leg-1": {
            account_id: "loan",
            amount: "640.15",
            linked_transaction_id: "tx-1",
          },
        });

        await service.undo(userId);

        expect(mockQueryRunner.manager.delete).toHaveBeenCalledWith(
          Transaction,
          { id: "leg-1", userId },
        );
        const balanceWrites = mockQueryRunner.query.mock.calls.filter(
          ([sql]: [string]) => /SET current_balance = ROUND/.test(sql),
        );
        expect(balanceWrites).toEqual([
          [expect.any(String), [-640.15, "loan", userId]],
        ]);
      });

      it("removes the legs of transfer split lines, each reversed by its own amount", async () => {
        mockRepository.findOne.mockResolvedValue(
          createAction({ id: "tx-1", accountId: "acc-1" }),
        );
        mockQueryRunner.manager.findOne.mockResolvedValue({
          id: "tx-1",
          userId,
          accountId: "acc-1",
          amount: -1500.75,
          isSplit: true,
          splits: [
            { id: "s1", amount: -1200.5, linkedTransactionId: "leg-1" },
            { id: "s2", amount: -300.25, linkedTransactionId: null },
          ],
        });
        mockQueryRunner.manager.delete.mockResolvedValue({ affected: 1 });
        mockQueryRunner.manager.remove.mockResolvedValue(undefined);
        mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });
        mockLockedRows({
          "tx-1": { account_id: "acc-1", amount: "-1500.75" },
          "leg-1": {
            account_id: "loan",
            amount: "1200.50",
            linked_transaction_id: "tx-1",
          },
        });

        await service.undo(userId);

        expect(mockQueryRunner.manager.delete).toHaveBeenCalledWith(
          Transaction,
          { id: "leg-1", userId },
        );
        expect(
          mockQueryRunner.query.mock.calls.filter(([sql]: [string]) =>
            /SET current_balance = ROUND/.test(sql),
          ),
        ).toEqual([[expect.any(String), [-1200.5, "loan", userId]]]);
      });

      it("refuses, before any write, when the counterpart is reconciled and the strict lock is on", async () => {
        mockRepository.findOne.mockResolvedValue(
          createAction({ id: "tx-1", accountId: "acc-1" }),
        );
        mockQueryRunner.manager.findOne.mockResolvedValue({
          id: "tx-1",
          userId,
          accountId: "acc-1",
          amount: -640.15,
          isTransfer: true,
          linkedTransactionId: "leg-1",
          splits: [],
        });
        mockQueryRunner.manager.delete.mockResolvedValue({ affected: 1 });
        mockQueryRunner.manager.remove.mockResolvedValue(undefined);
        mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });
        mockLockedRows({
          "tx-1": {
            account_id: "acc-1",
            amount: "-640.15",
            linked_transaction_id: "leg-1",
          },
          "leg-1": {
            account_id: "loan",
            amount: "640.15",
            status: "RECONCILED",
            linked_transaction_id: "tx-1",
          },
        });
        const routeRepository =
          mockQueryRunner.manager.getRepository.getMockImplementation();
        mockQueryRunner.manager.getRepository.mockImplementation(
          (entity: unknown) =>
            entity === UserPreference
              ? {
                  findOne: jest
                    .fn()
                    .mockResolvedValue({ lockReconciledTransactions: true }),
                }
              : routeRepository(entity),
        );

        await expect(service.undo(userId)).rejects.toBeInstanceOf(
          ConflictException,
        );

        expect(mockQueryRunner.manager.delete).not.toHaveBeenCalled();
        expect(mockQueryRunner.manager.remove).not.toHaveBeenCalled();
        expect(
          mockQueryRunner.query.mock.calls.filter(([sql]: [string]) =>
            /SET current_balance = ROUND/.test(sql),
          ),
        ).toEqual([]);
      });

      it("leaves a leg alone that is linked to another row, and a VOID leg moves nothing", async () => {
        mockRepository.findOne.mockResolvedValue(
          createAction({ id: "tx-1", accountId: "acc-1" }),
        );
        mockQueryRunner.manager.findOne.mockResolvedValue({
          id: "tx-1",
          userId,
          accountId: "acc-1",
          amount: -10,
          isSplit: true,
          splits: [
            { id: "s1", amount: -5, linkedTransactionId: "leg-1" },
            { id: "s2", amount: -5, linkedTransactionId: "leg-2" },
          ],
        });
        mockQueryRunner.manager.delete.mockResolvedValue({ affected: 1 });
        mockQueryRunner.manager.remove.mockResolvedValue(undefined);
        mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });
        mockLockedRows({
          "tx-1": { account_id: "acc-1", amount: "-10" },
          "leg-1": {
            account_id: "loan",
            amount: "5",
            linked_transaction_id: "someone-else",
          },
          "leg-2": {
            account_id: "loan",
            amount: "5",
            status: "VOID",
            linked_transaction_id: "tx-1",
          },
        });

        await service.undo(userId);

        const deletedLegs = mockQueryRunner.manager.delete.mock.calls
          .filter(([entity]: [unknown]) => entity === Transaction)
          .map(([, where]: [unknown, { id: string }]) => where.id);
        expect(deletedLegs).toEqual(["leg-2"]);
        expect(
          mockQueryRunner.query.mock.calls.filter(([sql]: [string]) =>
            /SET current_balance = ROUND/.test(sql),
          ),
        ).toEqual([]);
      });
    });

    describe("redo of a create that wrote legs in other accounts", () => {
      const undoneCreate = (after: Record<string, unknown>) => ({
        ...mockAction,
        entityType: "transaction",
        action: "create",
        entityId: "tx-1",
        isUndone: true,
        beforeData: null,
        afterData: after,
      });

      it("is refused for a transfer leg, before anything is written", async () => {
        mockRepository.findOne.mockResolvedValue(
          undoneCreate({
            id: "tx-1",
            accountId: "acc-1",
            isTransfer: true,
            linkedTransactionId: "leg-1",
          }),
        );
        await expect(service.redo(userId)).rejects.toMatchObject({
          response: expect.objectContaining({
            errorCode: "REDO_CREATE_WITH_LEGS",
          }),
        });
        expect(mockQueryRunner.query).not.toHaveBeenCalled();
        expect(mockQueryRunner.manager.update).not.toHaveBeenCalled();
      });

      it("is refused for a split with a linked leg", async () => {
        mockRepository.findOne.mockResolvedValue(
          undoneCreate({
            id: "tx-1",
            accountId: "acc-1",
            splits: [{ id: "s1", linkedTransactionId: "leg-1" }],
          }),
        );
        await expect(service.redo(userId)).rejects.toBeInstanceOf(
          ConflictException,
        );
      });
    });

    it("should return early if entityId is null", async () => {
      const txAction = {
        ...mockAction,
        entityType: "transaction",
        action: "create",
        entityId: null,
      };
      mockRepository.findOne.mockResolvedValue(txAction);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
      expect(mockQueryRunner.manager.findOne).not.toHaveBeenCalled();
    });
  });

  describe("undo unsupported transaction action", () => {
    it("should throw ConflictException for unsupported transaction action", async () => {
      const txAction = {
        ...mockAction,
        entityType: "transaction",
        action: "bulk_delete",
        entityId: "tx-1",
      };
      mockRepository.findOne.mockResolvedValue(txAction);

      await expect(service.undo(userId)).rejects.toThrow(ConflictException);
    });
  });

  describe("recalculateBalance", () => {
    it("should handle empty result from balance query", async () => {
      const txAction = {
        ...mockAction,
        entityType: "transaction",
        action: "create",
        entityId: "tx-1",
        afterData: { id: "tx-1", accountId: "acc-1" },
      };
      mockRepository.findOne.mockResolvedValue(txAction);

      const mockTransaction = {
        id: "tx-1",
        userId,
        accountId: "acc-1",
        amount: 100,
        splits: [],
      };
      mockQueryRunner.manager.findOne.mockResolvedValue(mockTransaction);
      mockQueryRunner.manager.remove.mockResolvedValue(undefined);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });
      // Return empty result for balance query
      mockQueryRunner.query.mockResolvedValue([]);

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
      // Should NOT try to update balance when no result
      const balanceUpdateCalls = mockQueryRunner.query.mock.calls.filter(
        (call: any[]) =>
          typeof call[0] === "string" &&
          call[0].includes("UPDATE accounts SET current_balance"),
      );
      expect(balanceUpdateCalls.length).toBe(0);
    });
  });

  describe("pruneUserHistory", () => {
    it("should prune when count exceeds limit", async () => {
      mockRepository.delete.mockResolvedValue({ affected: 0 });
      mockRepository.create.mockReturnValue(mockAction);
      mockRepository.save.mockResolvedValue(mockAction);
      mockRepository.count.mockResolvedValue(150);
      mockRepository.find.mockResolvedValue([{ id: "old-1" }, { id: "old-2" }]);

      await service.record(userId, {
        entityType: "tag",
        entityId: "entity-1",
        action: "create",
        description: "test",
      });

      // Should have called find to get old records and delete to remove them
      expect(mockRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId },
          order: { createdAt: "DESC" },
          skip: 100,
          select: ["id"],
        }),
      );
      expect(mockRepository.delete).toHaveBeenCalledWith(["old-1", "old-2"]);
    });

    it("should not prune when count is within limit", async () => {
      mockRepository.delete.mockResolvedValue({ affected: 0 });
      mockRepository.create.mockReturnValue(mockAction);
      mockRepository.save.mockResolvedValue(mockAction);
      mockRepository.count.mockResolvedValue(50);

      await service.record(userId, {
        entityType: "tag",
        entityId: "entity-1",
        action: "create",
        description: "test",
      });

      // Should not try to find old records
      expect(mockRepository.find).not.toHaveBeenCalled();
    });

    it("should handle prune errors gracefully", async () => {
      mockRepository.delete.mockResolvedValue({ affected: 0 });
      mockRepository.create.mockReturnValue(mockAction);
      mockRepository.save.mockResolvedValue(mockAction);
      mockRepository.count.mockRejectedValue(new Error("DB error"));

      const result = await service.record(userId, {
        entityType: "tag",
        entityId: "entity-1",
        action: "create",
        description: "test",
      });

      // Should still return the saved action even if prune fails
      expect(result).toEqual(mockAction);
    });
  });

  describe("cleanupExpiredHistory", () => {
    it("should delete records older than 30 days", async () => {
      const mockQb = {
        delete: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 5 }),
      };
      mockRepository.createQueryBuilder.mockReturnValue(mockQb);

      await service.cleanupExpiredHistory();

      expect(mockQb.delete).toHaveBeenCalled();
      expect(mockQb.where).toHaveBeenCalledWith(
        "created_at < :cutoff",
        expect.objectContaining({ cutoff: expect.any(Date) }),
      );
      expect(mockQb.execute).toHaveBeenCalled();
    });

    it("should handle cleanup when no records affected", async () => {
      const mockQb = {
        delete: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 0 }),
      };
      mockRepository.createQueryBuilder.mockReturnValue(mockQb);

      await service.cleanupExpiredHistory();

      expect(mockQb.execute).toHaveBeenCalled();
    });

    it("should handle cleanup errors gracefully", async () => {
      const mockQb = {
        delete: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockRejectedValue(new Error("DB error")),
      };
      mockRepository.createQueryBuilder.mockReturnValue(mockQb);

      // Should not throw
      await expect(service.cleanupExpiredHistory()).resolves.not.toThrow();
    });
  });

  describe("reinsertEntity edge cases", () => {
    it("should skip re-insert when all keys are undefined or updatedAt", async () => {
      const deleteAction = {
        ...mockAction,
        entityType: "tag",
        action: "delete",
        entityId: "tag-1",
        beforeData: { updatedAt: "2024-01-01" },
        afterData: null,
      };
      mockRepository.findOne.mockResolvedValue(deleteAction);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 1 });

      const result = await service.undo(userId);

      expect(result.description).toContain("Undone");
      // Should not insert since only updatedAt + userId left after filtering
      // userId is added but updatedAt is filtered
    });
  });
});
