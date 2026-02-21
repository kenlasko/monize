import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { BadRequestException } from "@nestjs/common";
import { TransactionReconciliationService } from "./transaction-reconciliation.service";
import { Transaction, TransactionStatus } from "./entities/transaction.entity";
import { AccountsService } from "../accounts/accounts.service";
import { isTransactionInFuture } from "../common/date-utils";

jest.mock("../common/date-utils", () => ({
  isTransactionInFuture: jest.fn().mockReturnValue(false),
}));

const mockedIsTransactionInFuture = isTransactionInFuture as jest.MockedFunction<
  typeof isTransactionInFuture
>;

describe("TransactionReconciliationService", () => {
  let service: TransactionReconciliationService;
  let transactionsRepository: Record<string, jest.Mock>;
  let accountsService: Record<string, jest.Mock>;

  const mockFindOne = jest.fn();
  const mockTriggerNetWorthRecalc = jest.fn();

  const userId = "user-1";
  const accountId = "account-1";

  const makeTransaction = (
    overrides: Partial<Transaction> = {},
  ): Transaction => {
    return {
      id: "tx-1",
      userId,
      accountId,
      amount: 100,
      status: TransactionStatus.UNRECONCILED,
      transactionDate: "2026-01-15",
      currencyCode: "USD",
      exchangeRate: 1,
      description: null,
      referenceNumber: null,
      reconciledDate: null,
      payeeId: null,
      payee: null,
      payeeName: null,
      categoryId: null,
      category: null,
      isSplit: false,
      parentTransactionId: null,
      isTransfer: false,
      linkedTransactionId: null,
      linkedTransaction: null,
      splits: [],
      createdAt: new Date("2026-01-15"),
      updatedAt: new Date("2026-01-15"),
      ...overrides,
    } as Transaction;
  };

  beforeEach(async () => {
    mockedIsTransactionInFuture.mockReturnValue(false);

    transactionsRepository = {
      update: jest.fn().mockResolvedValue(undefined),
      createQueryBuilder: jest.fn(),
    };

    accountsService = {
      findOne: jest.fn().mockResolvedValue({
        id: accountId,
        name: "Checking",
        openingBalance: 1000,
        currencyCode: "USD",
      }),
      updateBalance: jest.fn().mockResolvedValue(undefined),
      recalculateCurrentBalance: jest.fn().mockResolvedValue(undefined),
    };

    mockFindOne.mockReset();
    mockTriggerNetWorthRecalc.mockReset();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionReconciliationService,
        {
          provide: getRepositoryToken(Transaction),
          useValue: transactionsRepository,
        },
        { provide: AccountsService, useValue: accountsService },
      ],
    }).compile();

    service = module.get<TransactionReconciliationService>(
      TransactionReconciliationService,
    );
  });

  describe("updateStatus", () => {
    it("updates status from UNRECONCILED to CLEARED without balance change", async () => {
      const transaction = makeTransaction({
        status: TransactionStatus.UNRECONCILED,
      });
      const updatedTx = makeTransaction({
        status: TransactionStatus.CLEARED,
      });
      mockFindOne.mockResolvedValue(updatedTx);

      const result = await service.updateStatus(
        transaction,
        TransactionStatus.CLEARED,
        userId,
        mockTriggerNetWorthRecalc,
        mockFindOne,
      );

      expect(transactionsRepository.update).toHaveBeenCalledWith("tx-1", {
        status: TransactionStatus.CLEARED,
      });
      expect(accountsService.updateBalance).not.toHaveBeenCalled();
      expect(mockTriggerNetWorthRecalc).not.toHaveBeenCalled();
      expect(mockFindOne).toHaveBeenCalledWith(userId, "tx-1");
      expect(result).toEqual(updatedTx);
    });

    it("adds balance back when transitioning from VOID to non-VOID", async () => {
      const transaction = makeTransaction({
        status: TransactionStatus.VOID,
        amount: 250,
      });
      const updatedTx = makeTransaction({
        status: TransactionStatus.CLEARED,
        amount: 250,
      });
      mockFindOne.mockResolvedValue(updatedTx);

      await service.updateStatus(
        transaction,
        TransactionStatus.CLEARED,
        userId,
        mockTriggerNetWorthRecalc,
        mockFindOne,
      );

      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        accountId,
        250,
      );
      expect(mockTriggerNetWorthRecalc).toHaveBeenCalledWith(accountId, userId);
    });

    it("subtracts balance when transitioning from non-VOID to VOID", async () => {
      const transaction = makeTransaction({
        status: TransactionStatus.CLEARED,
        amount: 300,
      });
      const updatedTx = makeTransaction({
        status: TransactionStatus.VOID,
        amount: 300,
      });
      mockFindOne.mockResolvedValue(updatedTx);

      await service.updateStatus(
        transaction,
        TransactionStatus.VOID,
        userId,
        mockTriggerNetWorthRecalc,
        mockFindOne,
      );

      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        accountId,
        -300,
      );
      expect(mockTriggerNetWorthRecalc).toHaveBeenCalledWith(accountId, userId);
    });

    it("does not change balance when staying VOID", async () => {
      const transaction = makeTransaction({
        status: TransactionStatus.VOID,
      });
      mockFindOne.mockResolvedValue(
        makeTransaction({ status: TransactionStatus.VOID }),
      );

      await service.updateStatus(
        transaction,
        TransactionStatus.VOID,
        userId,
        mockTriggerNetWorthRecalc,
        mockFindOne,
      );

      expect(accountsService.updateBalance).not.toHaveBeenCalled();
      expect(mockTriggerNetWorthRecalc).not.toHaveBeenCalled();
    });

    it("does not trigger net worth recalc when VOID status does not change", async () => {
      const transaction = makeTransaction({
        status: TransactionStatus.UNRECONCILED,
      });
      mockFindOne.mockResolvedValue(
        makeTransaction({ status: TransactionStatus.CLEARED }),
      );

      await service.updateStatus(
        transaction,
        TransactionStatus.CLEARED,
        userId,
        mockTriggerNetWorthRecalc,
        mockFindOne,
      );

      expect(mockTriggerNetWorthRecalc).not.toHaveBeenCalled();
    });

    it("sets reconciledDate when transitioning to RECONCILED", async () => {
      const now = new Date(2026, 1, 10);
      jest.useFakeTimers({ now });

      const transaction = makeTransaction({
        status: TransactionStatus.CLEARED,
      });
      mockFindOne.mockResolvedValue(
        makeTransaction({ status: TransactionStatus.RECONCILED }),
      );

      await service.updateStatus(
        transaction,
        TransactionStatus.RECONCILED,
        userId,
        mockTriggerNetWorthRecalc,
        mockFindOne,
      );

      expect(transactionsRepository.update).toHaveBeenCalledWith("tx-1", {
        status: TransactionStatus.RECONCILED,
      });
      expect(transactionsRepository.update).toHaveBeenCalledWith("tx-1", {
        reconciledDate: "2026-02-10",
      });

      jest.useRealTimers();
    });

    it("does not set reconciledDate when already RECONCILED", async () => {
      const transaction = makeTransaction({
        status: TransactionStatus.RECONCILED,
        reconciledDate: "2026-01-01",
      });
      mockFindOne.mockResolvedValue(transaction);

      await service.updateStatus(
        transaction,
        TransactionStatus.RECONCILED,
        userId,
        mockTriggerNetWorthRecalc,
        mockFindOne,
      );

      // Should only be called once for the status update, not a second time for reconciledDate
      expect(transactionsRepository.update).toHaveBeenCalledTimes(1);
      expect(transactionsRepository.update).toHaveBeenCalledWith("tx-1", {
        status: TransactionStatus.RECONCILED,
      });
    });

    it("does not set reconciledDate when transitioning to a non-RECONCILED status", async () => {
      const transaction = makeTransaction({
        status: TransactionStatus.UNRECONCILED,
      });
      mockFindOne.mockResolvedValue(
        makeTransaction({ status: TransactionStatus.VOID }),
      );

      await service.updateStatus(
        transaction,
        TransactionStatus.VOID,
        userId,
        mockTriggerNetWorthRecalc,
        mockFindOne,
      );

      // One call for status, none for reconciledDate
      expect(transactionsRepository.update).toHaveBeenCalledTimes(1);
      expect(transactionsRepository.update).toHaveBeenCalledWith("tx-1", {
        status: TransactionStatus.VOID,
      });
    });

    it("handles negative transaction amounts correctly for VOID transitions", async () => {
      const transaction = makeTransaction({
        status: TransactionStatus.UNRECONCILED,
        amount: -75.5,
      });
      mockFindOne.mockResolvedValue(
        makeTransaction({ status: TransactionStatus.VOID, amount: -75.5 }),
      );

      await service.updateStatus(
        transaction,
        TransactionStatus.VOID,
        userId,
        mockTriggerNetWorthRecalc,
        mockFindOne,
      );

      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        accountId,
        75.5,
      );
    });

    it("returns the result of findOne callback", async () => {
      const updatedTx = makeTransaction({
        id: "tx-1",
        status: TransactionStatus.CLEARED,
      });
      mockFindOne.mockResolvedValue(updatedTx);

      const result = await service.updateStatus(
        makeTransaction(),
        TransactionStatus.CLEARED,
        userId,
        mockTriggerNetWorthRecalc,
        mockFindOne,
      );

      expect(result).toBe(updatedTx);
    });
  });

  describe("markCleared", () => {
    it("marks an UNRECONCILED transaction as CLEARED", async () => {
      const transaction = makeTransaction({
        status: TransactionStatus.UNRECONCILED,
      });
      const updatedTx = makeTransaction({
        status: TransactionStatus.CLEARED,
      });
      mockFindOne.mockResolvedValue(updatedTx);

      const result = await service.markCleared(
        transaction,
        true,
        userId,
        mockTriggerNetWorthRecalc,
        mockFindOne,
      );

      expect(transactionsRepository.update).toHaveBeenCalledWith("tx-1", {
        status: TransactionStatus.CLEARED,
      });
      expect(result).toEqual(updatedTx);
    });

    it("marks a CLEARED transaction as UNRECONCILED when isCleared is false", async () => {
      const transaction = makeTransaction({
        status: TransactionStatus.CLEARED,
      });
      const updatedTx = makeTransaction({
        status: TransactionStatus.UNRECONCILED,
      });
      mockFindOne.mockResolvedValue(updatedTx);

      const result = await service.markCleared(
        transaction,
        false,
        userId,
        mockTriggerNetWorthRecalc,
        mockFindOne,
      );

      expect(transactionsRepository.update).toHaveBeenCalledWith("tx-1", {
        status: TransactionStatus.UNRECONCILED,
      });
      expect(result).toEqual(updatedTx);
    });

    it("throws when transaction is RECONCILED", async () => {
      const transaction = makeTransaction({
        status: TransactionStatus.RECONCILED,
      });

      await expect(
        service.markCleared(
          transaction,
          true,
          userId,
          mockTriggerNetWorthRecalc,
          mockFindOne,
        ),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.markCleared(
          transaction,
          true,
          userId,
          mockTriggerNetWorthRecalc,
          mockFindOne,
        ),
      ).rejects.toThrow(
        "Cannot change cleared status of reconciled or void transactions",
      );
    });

    it("throws when transaction is VOID", async () => {
      const transaction = makeTransaction({
        status: TransactionStatus.VOID,
      });

      await expect(
        service.markCleared(
          transaction,
          false,
          userId,
          mockTriggerNetWorthRecalc,
          mockFindOne,
        ),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.markCleared(
          transaction,
          false,
          userId,
          mockTriggerNetWorthRecalc,
          mockFindOne,
        ),
      ).rejects.toThrow(
        "Cannot change cleared status of reconciled or void transactions",
      );
    });

    it("does not call updateStatus when validation fails", async () => {
      const transaction = makeTransaction({
        status: TransactionStatus.RECONCILED,
      });

      await expect(
        service.markCleared(
          transaction,
          true,
          userId,
          mockTriggerNetWorthRecalc,
          mockFindOne,
        ),
      ).rejects.toThrow(BadRequestException);

      expect(transactionsRepository.update).not.toHaveBeenCalled();
      expect(mockFindOne).not.toHaveBeenCalled();
    });
  });

  describe("reconcile", () => {
    it("reconciles an UNRECONCILED transaction", async () => {
      jest.useFakeTimers({ now: new Date(2026, 0, 20) });

      const transaction = makeTransaction({
        status: TransactionStatus.UNRECONCILED,
      });
      const updatedTx = makeTransaction({
        status: TransactionStatus.RECONCILED,
        reconciledDate: "2026-01-20",
      });
      mockFindOne.mockResolvedValue(updatedTx);

      const result = await service.reconcile(
        transaction,
        userId,
        mockTriggerNetWorthRecalc,
        mockFindOne,
      );

      expect(transactionsRepository.update).toHaveBeenCalledWith("tx-1", {
        status: TransactionStatus.RECONCILED,
      });
      expect(result).toEqual(updatedTx);

      jest.useRealTimers();
    });

    it("reconciles a CLEARED transaction", async () => {
      jest.useFakeTimers({ now: new Date(2026, 0, 20) });

      const transaction = makeTransaction({
        status: TransactionStatus.CLEARED,
      });
      const updatedTx = makeTransaction({
        status: TransactionStatus.RECONCILED,
      });
      mockFindOne.mockResolvedValue(updatedTx);

      const result = await service.reconcile(
        transaction,
        userId,
        mockTriggerNetWorthRecalc,
        mockFindOne,
      );

      expect(transactionsRepository.update).toHaveBeenCalledWith("tx-1", {
        status: TransactionStatus.RECONCILED,
      });
      expect(result).toEqual(updatedTx);

      jest.useRealTimers();
    });

    it("throws when transaction is already RECONCILED", async () => {
      const transaction = makeTransaction({
        status: TransactionStatus.RECONCILED,
      });

      await expect(
        service.reconcile(
          transaction,
          userId,
          mockTriggerNetWorthRecalc,
          mockFindOne,
        ),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.reconcile(
          transaction,
          userId,
          mockTriggerNetWorthRecalc,
          mockFindOne,
        ),
      ).rejects.toThrow("Transaction is already reconciled");
    });

    it("throws when transaction is VOID", async () => {
      const transaction = makeTransaction({
        status: TransactionStatus.VOID,
      });

      await expect(
        service.reconcile(
          transaction,
          userId,
          mockTriggerNetWorthRecalc,
          mockFindOne,
        ),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.reconcile(
          transaction,
          userId,
          mockTriggerNetWorthRecalc,
          mockFindOne,
        ),
      ).rejects.toThrow("Cannot reconcile a void transaction");
    });

    it("does not call repository when validation fails", async () => {
      const transaction = makeTransaction({
        status: TransactionStatus.RECONCILED,
      });

      await expect(
        service.reconcile(
          transaction,
          userId,
          mockTriggerNetWorthRecalc,
          mockFindOne,
        ),
      ).rejects.toThrow(BadRequestException);

      expect(transactionsRepository.update).not.toHaveBeenCalled();
    });
  });

  describe("unreconcile", () => {
    it("sets status to CLEARED and clears reconciledDate", async () => {
      const transaction = makeTransaction({
        status: TransactionStatus.RECONCILED,
        reconciledDate: "2026-01-15",
      });
      const updatedTx = makeTransaction({
        status: TransactionStatus.CLEARED,
        reconciledDate: null,
      });
      mockFindOne.mockResolvedValue(updatedTx);

      const result = await service.unreconcile(
        transaction,
        userId,
        mockFindOne,
      );

      expect(transactionsRepository.update).toHaveBeenCalledWith("tx-1", {
        status: TransactionStatus.CLEARED,
        reconciledDate: null,
      });
      expect(mockFindOne).toHaveBeenCalledWith(userId, "tx-1");
      expect(result).toEqual(updatedTx);
    });

    it("throws when transaction is not RECONCILED (UNRECONCILED)", async () => {
      const transaction = makeTransaction({
        status: TransactionStatus.UNRECONCILED,
      });

      await expect(
        service.unreconcile(transaction, userId, mockFindOne),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.unreconcile(transaction, userId, mockFindOne),
      ).rejects.toThrow("Transaction is not reconciled");
    });

    it("throws when transaction is not RECONCILED (CLEARED)", async () => {
      const transaction = makeTransaction({
        status: TransactionStatus.CLEARED,
      });

      await expect(
        service.unreconcile(transaction, userId, mockFindOne),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.unreconcile(transaction, userId, mockFindOne),
      ).rejects.toThrow("Transaction is not reconciled");
    });

    it("throws when transaction is not RECONCILED (VOID)", async () => {
      const transaction = makeTransaction({
        status: TransactionStatus.VOID,
      });

      await expect(
        service.unreconcile(transaction, userId, mockFindOne),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.unreconcile(transaction, userId, mockFindOne),
      ).rejects.toThrow("Transaction is not reconciled");
    });

    it("does not call repository when validation fails", async () => {
      const transaction = makeTransaction({
        status: TransactionStatus.CLEARED,
      });

      await expect(
        service.unreconcile(transaction, userId, mockFindOne),
      ).rejects.toThrow(BadRequestException);

      expect(transactionsRepository.update).not.toHaveBeenCalled();
      expect(mockFindOne).not.toHaveBeenCalled();
    });
  });

  describe("getReconciliationData", () => {
    let mockQueryBuilder: Record<string, jest.Mock>;

    beforeEach(() => {
      mockQueryBuilder = {
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
        getRawOne: jest.fn().mockResolvedValue({ sum: null }),
      };

      transactionsRepository.createQueryBuilder.mockReturnValue(
        mockQueryBuilder,
      );
    });

    it("returns transactions, balances, and difference for a given account", async () => {
      const mockTransactions = [
        makeTransaction({ id: "tx-1", amount: 50 }),
        makeTransaction({ id: "tx-2", amount: -30 }),
      ];
      mockQueryBuilder.getMany.mockResolvedValue(mockTransactions);

      // First getRawOne for reconciled sum
      mockQueryBuilder.getRawOne
        .mockResolvedValueOnce({ sum: "200" })
        // Second getRawOne for cleared sum
        .mockResolvedValueOnce({ sum: "150" });

      const result = await service.getReconciliationData(
        userId,
        accountId,
        "2026-01-31",
        1500,
      );

      expect(accountsService.findOne).toHaveBeenCalledWith(userId, accountId);
      expect(result.transactions).toEqual(mockTransactions);
      // reconciledBalance = openingBalance(1000) + reconciledSum(200) = 1200
      expect(result.reconciledBalance).toBe(1200);
      // clearedBalance = reconciledBalance(1200) + clearedSum(150) = 1350
      expect(result.clearedBalance).toBe(1350);
      // difference = statementBalance(1500) - clearedBalance(1350) = 150
      expect(result.difference).toBe(150);
    });

    it("handles null sums (no reconciled or cleared transactions)", async () => {
      mockQueryBuilder.getRawOne.mockResolvedValue({ sum: null });

      const result = await service.getReconciliationData(
        userId,
        accountId,
        "2026-01-31",
        1000,
      );

      // reconciledBalance = openingBalance(1000) + 0 = 1000
      expect(result.reconciledBalance).toBe(1000);
      // clearedBalance = reconciledBalance(1000) + 0 = 1000
      expect(result.clearedBalance).toBe(1000);
      // difference = statementBalance(1000) - clearedBalance(1000) = 0
      expect(result.difference).toBe(0);
    });

    it("calculates negative difference when cleared exceeds statement", async () => {
      mockQueryBuilder.getRawOne
        .mockResolvedValueOnce({ sum: "500" })
        .mockResolvedValueOnce({ sum: "300" });

      const result = await service.getReconciliationData(
        userId,
        accountId,
        "2026-01-31",
        1500,
      );

      // reconciledBalance = 1000 + 500 = 1500
      // clearedBalance = 1500 + 300 = 1800
      // difference = 1500 - 1800 = -300
      expect(result.reconciledBalance).toBe(1500);
      expect(result.clearedBalance).toBe(1800);
      expect(result.difference).toBe(-300);
    });

    it("filters transactions by userId, accountId, statuses, and date", async () => {
      mockQueryBuilder.getRawOne.mockResolvedValue({ sum: "0" });

      await service.getReconciliationData(userId, accountId, "2026-02-28", 500);

      // Verify createQueryBuilder was called 3 times (transactions, reconciled sum, cleared sum)
      expect(transactionsRepository.createQueryBuilder).toHaveBeenCalledTimes(
        3,
      );

      // Verify the main transactions query has proper filters
      expect(mockQueryBuilder.where).toHaveBeenCalledWith(
        "transaction.userId = :userId",
        { userId },
      );
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        "transaction.accountId = :accountId",
        { accountId },
      );
    });

    it("delegates account lookup to accountsService.findOne", async () => {
      mockQueryBuilder.getRawOne.mockResolvedValue({ sum: "0" });

      await service.getReconciliationData(
        userId,
        accountId,
        "2026-01-31",
        1000,
      );

      expect(accountsService.findOne).toHaveBeenCalledWith(userId, accountId);
    });

    it("handles zero statement balance", async () => {
      mockQueryBuilder.getRawOne
        .mockResolvedValueOnce({ sum: "-500" })
        .mockResolvedValueOnce({ sum: "-500" });

      const result = await service.getReconciliationData(
        userId,
        accountId,
        "2026-01-31",
        0,
      );

      // reconciledBalance = 1000 + (-500) = 500
      // clearedBalance = 500 + (-500) = 0
      // difference = 0 - 0 = 0
      expect(result.reconciledBalance).toBe(500);
      expect(result.clearedBalance).toBe(0);
      expect(result.difference).toBe(0);
    });
  });

  describe("bulkReconcile", () => {
    let mockQueryBuilder: Record<string, jest.Mock>;

    beforeEach(() => {
      mockQueryBuilder = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
        execute: jest.fn().mockResolvedValue({ affected: 0 }),
      };

      transactionsRepository.createQueryBuilder.mockReturnValue(
        mockQueryBuilder,
      );
    });

    it("reconciles multiple transactions and returns count", async () => {
      const transactions = [
        makeTransaction({ id: "tx-1" }),
        makeTransaction({ id: "tx-2" }),
        makeTransaction({ id: "tx-3" }),
      ];
      mockQueryBuilder.getMany.mockResolvedValue(transactions);

      const result = await service.bulkReconcile(
        userId,
        accountId,
        ["tx-1", "tx-2", "tx-3"],
        "2026-01-31",
      );

      expect(result).toEqual({ reconciled: 3 });
      expect(accountsService.findOne).toHaveBeenCalledWith(userId, accountId);
      expect(mockQueryBuilder.set).toHaveBeenCalledWith({
        status: TransactionStatus.RECONCILED,
        reconciledDate: "2026-01-31",
      });
      expect(mockQueryBuilder.execute).toHaveBeenCalled();
    });

    it("returns zero when transactionIds is empty", async () => {
      const result = await service.bulkReconcile(
        userId,
        accountId,
        [],
        "2026-01-31",
      );

      expect(result).toEqual({ reconciled: 0 });
      expect(transactionsRepository.createQueryBuilder).not.toHaveBeenCalled();
    });

    it("validates account ownership before proceeding", async () => {
      accountsService.findOne.mockRejectedValue(new Error("Account not found"));

      await expect(
        service.bulkReconcile(userId, accountId, ["tx-1"], "2026-01-31"),
      ).rejects.toThrow("Account not found");
    });

    it("throws when some transactions are not found or do not belong to account", async () => {
      mockQueryBuilder.getMany.mockResolvedValue([
        makeTransaction({ id: "tx-1" }),
      ]);

      await expect(
        service.bulkReconcile(
          userId,
          accountId,
          ["tx-1", "tx-2"],
          "2026-01-31",
        ),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.bulkReconcile(
          userId,
          accountId,
          ["tx-1", "tx-2"],
          "2026-01-31",
        ),
      ).rejects.toThrow(
        "Some transactions were not found or do not belong to the specified account",
      );
    });

    it("filters query by userId and accountId for security", async () => {
      mockQueryBuilder.getMany.mockResolvedValue([
        makeTransaction({ id: "tx-1" }),
      ]);

      await service.bulkReconcile(userId, accountId, ["tx-1"], "2026-02-15");

      expect(mockQueryBuilder.where).toHaveBeenCalledWith(
        "transaction.id IN (:...ids)",
        { ids: ["tx-1"] },
      );
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        "transaction.userId = :userId",
        { userId },
      );
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        "transaction.accountId = :accountId",
        { accountId },
      );
    });

    it("uses provided reconciledDate in the update", async () => {
      mockQueryBuilder.getMany.mockResolvedValue([
        makeTransaction({ id: "tx-1" }),
      ]);

      await service.bulkReconcile(userId, accountId, ["tx-1"], "2026-03-15");

      expect(mockQueryBuilder.set).toHaveBeenCalledWith({
        status: TransactionStatus.RECONCILED,
        reconciledDate: "2026-03-15",
      });
    });

    it("reconciles a single transaction", async () => {
      mockQueryBuilder.getMany.mockResolvedValue([
        makeTransaction({ id: "tx-1" }),
      ]);

      const result = await service.bulkReconcile(
        userId,
        accountId,
        ["tx-1"],
        "2026-01-31",
      );

      expect(result).toEqual({ reconciled: 1 });
    });
  });

  describe("future-dated transactions", () => {
    it("does NOT call updateBalance when voiding a future-dated transaction", async () => {
      mockedIsTransactionInFuture.mockReturnValue(true);

      const transaction = makeTransaction({
        status: TransactionStatus.CLEARED,
        amount: 300,
        transactionDate: "2027-06-15",
      });
      const updatedTx = makeTransaction({
        status: TransactionStatus.VOID,
        amount: 300,
        transactionDate: "2027-06-15",
      });
      mockFindOne.mockResolvedValue(updatedTx);

      await service.updateStatus(
        transaction,
        TransactionStatus.VOID,
        userId,
        mockTriggerNetWorthRecalc,
        mockFindOne,
      );

      expect(transactionsRepository.update).toHaveBeenCalledWith("tx-1", {
        status: TransactionStatus.VOID,
      });
      expect(accountsService.updateBalance).not.toHaveBeenCalled();
      // Net worth recalc is still triggered because void status changed
      expect(mockTriggerNetWorthRecalc).toHaveBeenCalledWith(accountId, userId);
    });

    it("does NOT call updateBalance when unvoiding a future-dated transaction", async () => {
      mockedIsTransactionInFuture.mockReturnValue(true);

      const transaction = makeTransaction({
        status: TransactionStatus.VOID,
        amount: 250,
        transactionDate: "2027-06-15",
      });
      const updatedTx = makeTransaction({
        status: TransactionStatus.CLEARED,
        amount: 250,
        transactionDate: "2027-06-15",
      });
      mockFindOne.mockResolvedValue(updatedTx);

      await service.updateStatus(
        transaction,
        TransactionStatus.CLEARED,
        userId,
        mockTriggerNetWorthRecalc,
        mockFindOne,
      );

      expect(transactionsRepository.update).toHaveBeenCalledWith("tx-1", {
        status: TransactionStatus.CLEARED,
      });
      expect(accountsService.updateBalance).not.toHaveBeenCalled();
      // Net worth recalc is still triggered because void status changed
      expect(mockTriggerNetWorthRecalc).toHaveBeenCalledWith(accountId, userId);
    });

    it("still updates the status even for future-dated transactions", async () => {
      mockedIsTransactionInFuture.mockReturnValue(true);

      const transaction = makeTransaction({
        status: TransactionStatus.UNRECONCILED,
        amount: -75.5,
        transactionDate: "2027-06-15",
      });
      const updatedTx = makeTransaction({
        status: TransactionStatus.VOID,
        amount: -75.5,
        transactionDate: "2027-06-15",
      });
      mockFindOne.mockResolvedValue(updatedTx);

      const result = await service.updateStatus(
        transaction,
        TransactionStatus.VOID,
        userId,
        mockTriggerNetWorthRecalc,
        mockFindOne,
      );

      expect(transactionsRepository.update).toHaveBeenCalledWith("tx-1", {
        status: TransactionStatus.VOID,
      });
      expect(accountsService.updateBalance).not.toHaveBeenCalled();
      expect(result).toEqual(updatedTx);
    });
  });
});
