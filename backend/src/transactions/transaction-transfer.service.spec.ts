import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { BadRequestException } from "@nestjs/common";
import {
  TransactionTransferService,
  TransferResult,
} from "./transaction-transfer.service";
import { Transaction, TransactionStatus } from "./entities/transaction.entity";
import { TransactionSplit } from "./entities/transaction-split.entity";
import { AccountsService } from "../accounts/accounts.service";
import { NetWorthService } from "../net-worth/net-worth.service";

describe("TransactionTransferService", () => {
  let service: TransactionTransferService;
  let transactionsRepository: Record<string, jest.Mock>;
  let splitsRepository: Record<string, jest.Mock>;
  let accountsService: Record<string, jest.Mock>;
  let netWorthService: Record<string, jest.Mock>;

  const mockFindOne = jest.fn();

  const mockFromAccount = {
    id: "from-account",
    name: "Checking",
    currencyCode: "USD",
  };

  const mockToAccount = {
    id: "to-account",
    name: "Savings",
    currencyCode: "USD",
  };

  const baseTransferDto = {
    fromAccountId: "from-account",
    toAccountId: "to-account",
    transactionDate: "2026-01-15",
    amount: 500,
    fromCurrencyCode: "USD",
  };

  beforeEach(async () => {
    jest.useFakeTimers();

    transactionsRepository = {
      create: jest.fn().mockImplementation((data) => ({ ...data, id: `tx-${Date.now()}` })),
      save: jest.fn()
        .mockResolvedValueOnce({ id: "from-tx-id", ...baseTransferDto, amount: -500 })
        .mockResolvedValueOnce({ id: "to-tx-id", ...baseTransferDto, amount: 500 }),
      update: jest.fn().mockResolvedValue(undefined),
      findOne: jest.fn(),
      remove: jest.fn().mockResolvedValue(undefined),
    };

    splitsRepository = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      remove: jest.fn().mockResolvedValue(undefined),
    };

    accountsService = {
      findOne: jest.fn().mockImplementation((_userId: string, accountId: string) => {
        if (accountId === "from-account") return Promise.resolve(mockFromAccount);
        if (accountId === "to-account") return Promise.resolve(mockToAccount);
        return Promise.resolve({ id: accountId, name: "Unknown", currencyCode: "USD" });
      }),
      updateBalance: jest.fn().mockResolvedValue(undefined),
    };

    netWorthService = {
      recalculateAccount: jest.fn().mockResolvedValue(undefined),
    };

    mockFindOne.mockReset();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionTransferService,
        {
          provide: getRepositoryToken(Transaction),
          useValue: transactionsRepository,
        },
        {
          provide: getRepositoryToken(TransactionSplit),
          useValue: splitsRepository,
        },
        { provide: AccountsService, useValue: accountsService },
        { provide: NetWorthService, useValue: netWorthService },
      ],
    }).compile();

    service = module.get<TransactionTransferService>(TransactionTransferService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("createTransfer", () => {
    it("creates from and to transactions with correct amounts and links them", async () => {
      mockFindOne
        .mockResolvedValueOnce({ id: "from-tx-id", amount: -500 })
        .mockResolvedValueOnce({ id: "to-tx-id", amount: 500 });

      const result = await service.createTransfer(
        "user-1",
        baseTransferDto,
        mockFindOne,
      );

      expect(transactionsRepository.create).toHaveBeenCalledTimes(2);

      // from transaction should have negative amount
      const fromCreateCall = transactionsRepository.create.mock.calls[0][0];
      expect(fromCreateCall.amount).toBe(-500);
      expect(fromCreateCall.isTransfer).toBe(true);
      expect(fromCreateCall.accountId).toBe("from-account");

      // to transaction should have positive amount
      const toCreateCall = transactionsRepository.create.mock.calls[1][0];
      expect(toCreateCall.amount).toBe(500);
      expect(toCreateCall.isTransfer).toBe(true);
      expect(toCreateCall.accountId).toBe("to-account");

      expect(transactionsRepository.save).toHaveBeenCalledTimes(2);

      // linked transaction IDs updated
      expect(transactionsRepository.update).toHaveBeenCalledWith("from-tx-id", {
        linkedTransactionId: "to-tx-id",
      });
      expect(transactionsRepository.update).toHaveBeenCalledWith("to-tx-id", {
        linkedTransactionId: "from-tx-id",
      });

      // balances updated
      expect(accountsService.updateBalance).toHaveBeenCalledWith("from-account", -500);
      expect(accountsService.updateBalance).toHaveBeenCalledWith("to-account", 500);

      expect(result.fromTransaction.id).toBe("from-tx-id");
      expect(result.toTransaction.id).toBe("to-tx-id");
    });

    it("throws when source and destination accounts are the same", async () => {
      const dto = { ...baseTransferDto, toAccountId: "from-account" };

      await expect(
        service.createTransfer("user-1", dto, mockFindOne),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.createTransfer("user-1", dto, mockFindOne),
      ).rejects.toThrow("Source and destination accounts must be different");
    });

    it("throws when amount is zero or negative", async () => {
      const zeroDto = { ...baseTransferDto, amount: 0 };
      await expect(
        service.createTransfer("user-1", zeroDto, mockFindOne),
      ).rejects.toThrow(BadRequestException);

      const negDto = { ...baseTransferDto, amount: -100 };
      await expect(
        service.createTransfer("user-1", negDto, mockFindOne),
      ).rejects.toThrow("Transfer amount must be positive");
    });

    it("uses explicit toAmount when provided", async () => {
      transactionsRepository.save
        .mockReset()
        .mockResolvedValueOnce({ id: "from-tx-id" })
        .mockResolvedValueOnce({ id: "to-tx-id" });

      mockFindOne
        .mockResolvedValueOnce({ id: "from-tx-id" })
        .mockResolvedValueOnce({ id: "to-tx-id" });

      const dto = {
        ...baseTransferDto,
        toCurrencyCode: "CAD",
        exchangeRate: 1.35,
        toAmount: 680,
      };

      await service.createTransfer("user-1", dto, mockFindOne);

      const toCreateCall = transactionsRepository.create.mock.calls[1][0];
      expect(toCreateCall.amount).toBe(680);
      expect(accountsService.updateBalance).toHaveBeenCalledWith("to-account", 680);
    });

    it("calculates toAmount from exchangeRate when toAmount not provided", async () => {
      transactionsRepository.save
        .mockReset()
        .mockResolvedValueOnce({ id: "from-tx-id" })
        .mockResolvedValueOnce({ id: "to-tx-id" });

      mockFindOne
        .mockResolvedValueOnce({ id: "from-tx-id" })
        .mockResolvedValueOnce({ id: "to-tx-id" });

      const dto = {
        ...baseTransferDto,
        toCurrencyCode: "CAD",
        exchangeRate: 1.35,
      };

      await service.createTransfer("user-1", dto, mockFindOne);

      const toCreateCall = transactionsRepository.create.mock.calls[1][0];
      // 500 * 1.35 = 675
      expect(toCreateCall.amount).toBe(675);
    });

    it("uses custom payeeName when provided", async () => {
      transactionsRepository.save
        .mockReset()
        .mockResolvedValueOnce({ id: "from-tx-id" })
        .mockResolvedValueOnce({ id: "to-tx-id" });

      mockFindOne
        .mockResolvedValueOnce({ id: "from-tx-id" })
        .mockResolvedValueOnce({ id: "to-tx-id" });

      const dto = { ...baseTransferDto, payeeName: "My Transfer" };

      await service.createTransfer("user-1", dto, mockFindOne);

      const fromCreateCall = transactionsRepository.create.mock.calls[0][0];
      const toCreateCall = transactionsRepository.create.mock.calls[1][0];
      expect(fromCreateCall.payeeName).toBe("My Transfer");
      expect(toCreateCall.payeeName).toBe("My Transfer");
    });

    it("generates default payeeName from account names when not provided", async () => {
      transactionsRepository.save
        .mockReset()
        .mockResolvedValueOnce({ id: "from-tx-id" })
        .mockResolvedValueOnce({ id: "to-tx-id" });

      mockFindOne
        .mockResolvedValueOnce({ id: "from-tx-id" })
        .mockResolvedValueOnce({ id: "to-tx-id" });

      await service.createTransfer("user-1", baseTransferDto, mockFindOne);

      const fromCreateCall = transactionsRepository.create.mock.calls[0][0];
      const toCreateCall = transactionsRepository.create.mock.calls[1][0];
      expect(fromCreateCall.payeeName).toBe("Transfer to Savings");
      expect(toCreateCall.payeeName).toBe("Transfer from Checking");
    });

    it("triggers net worth recalc for both accounts (debounced)", async () => {
      transactionsRepository.save
        .mockReset()
        .mockResolvedValueOnce({ id: "from-tx-id" })
        .mockResolvedValueOnce({ id: "to-tx-id" });

      mockFindOne
        .mockResolvedValueOnce({ id: "from-tx-id" })
        .mockResolvedValueOnce({ id: "to-tx-id" });

      await service.createTransfer("user-1", baseTransferDto, mockFindOne);

      // Before timer fires, recalc should not have been called
      expect(netWorthService.recalculateAccount).not.toHaveBeenCalled();

      // Advance timers
      jest.advanceTimersByTime(2000);

      expect(netWorthService.recalculateAccount).toHaveBeenCalledWith(
        "user-1",
        "from-account",
      );
      expect(netWorthService.recalculateAccount).toHaveBeenCalledWith(
        "user-1",
        "to-account",
      );
    });

    it("uses default status UNRECONCILED when not specified", async () => {
      transactionsRepository.save
        .mockReset()
        .mockResolvedValueOnce({ id: "from-tx-id" })
        .mockResolvedValueOnce({ id: "to-tx-id" });

      mockFindOne
        .mockResolvedValueOnce({ id: "from-tx-id" })
        .mockResolvedValueOnce({ id: "to-tx-id" });

      await service.createTransfer("user-1", baseTransferDto, mockFindOne);

      const fromCreateCall = transactionsRepository.create.mock.calls[0][0];
      expect(fromCreateCall.status).toBe(TransactionStatus.UNRECONCILED);
    });
  });

  describe("getLinkedTransaction", () => {
    it("returns linked transaction for a transfer", async () => {
      const linkedTx = { id: "linked-tx-id", amount: 500 };
      mockFindOne
        .mockResolvedValueOnce({
          id: "tx-1",
          isTransfer: true,
          linkedTransactionId: "linked-tx-id",
        })
        .mockResolvedValueOnce(linkedTx);

      const result = await service.getLinkedTransaction(
        "user-1",
        "tx-1",
        mockFindOne,
      );

      expect(result).toEqual(linkedTx);
    });

    it("returns null when transaction is not a transfer", async () => {
      mockFindOne.mockResolvedValue({
        id: "tx-1",
        isTransfer: false,
        linkedTransactionId: null,
      });

      const result = await service.getLinkedTransaction(
        "user-1",
        "tx-1",
        mockFindOne,
      );

      expect(result).toBeNull();
    });

    it("returns null when linkedTransactionId is null", async () => {
      mockFindOne.mockResolvedValue({
        id: "tx-1",
        isTransfer: true,
        linkedTransactionId: null,
      });

      const result = await service.getLinkedTransaction(
        "user-1",
        "tx-1",
        mockFindOne,
      );

      expect(result).toBeNull();
    });

    it("returns null when linked transaction lookup fails", async () => {
      mockFindOne
        .mockResolvedValueOnce({
          id: "tx-1",
          isTransfer: true,
          linkedTransactionId: "missing-tx",
        })
        .mockRejectedValueOnce(new Error("Not found"));

      const result = await service.getLinkedTransaction(
        "user-1",
        "tx-1",
        mockFindOne,
      );

      expect(result).toBeNull();
    });
  });

  describe("removeTransfer", () => {
    it("removes both from and to transactions for standalone transfer", async () => {
      const fromTx = {
        id: "from-tx",
        isTransfer: true,
        linkedTransactionId: "to-tx",
        accountId: "from-account",
        amount: -500,
      };
      const toTx = {
        id: "to-tx",
        accountId: "to-account",
        amount: 500,
      };

      mockFindOne.mockResolvedValue(fromTx);
      splitsRepository.findOne.mockResolvedValue(null);
      transactionsRepository.findOne.mockResolvedValue(toTx);

      await service.removeTransfer("user-1", "from-tx", mockFindOne);

      // Reverse from transaction balance
      expect(accountsService.updateBalance).toHaveBeenCalledWith("from-account", 500);
      // Reverse to transaction balance
      expect(accountsService.updateBalance).toHaveBeenCalledWith("to-account", -500);
      // Both transactions removed
      expect(transactionsRepository.remove).toHaveBeenCalledWith(toTx);
      expect(transactionsRepository.remove).toHaveBeenCalledWith(fromTx);
    });

    it("throws when transaction is not a transfer", async () => {
      mockFindOne.mockResolvedValue({
        id: "tx-1",
        isTransfer: false,
      });

      await expect(
        service.removeTransfer("user-1", "tx-1", mockFindOne),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.removeTransfer("user-1", "tx-1", mockFindOne),
      ).rejects.toThrow("Transaction is not a transfer");
    });

    it("removes only the current transaction when no linked transaction", async () => {
      const tx = {
        id: "tx-1",
        isTransfer: true,
        linkedTransactionId: null,
        accountId: "from-account",
        amount: -500,
      };

      mockFindOne.mockResolvedValue(tx);
      splitsRepository.findOne.mockResolvedValue(null);

      await service.removeTransfer("user-1", "tx-1", mockFindOne);

      expect(accountsService.updateBalance).toHaveBeenCalledWith("from-account", 500);
      expect(transactionsRepository.remove).toHaveBeenCalledTimes(1);
      expect(transactionsRepository.remove).toHaveBeenCalledWith(tx);
    });

    it("delegates to removeTransferFromSplit when transaction is part of a split", async () => {
      const tx = {
        id: "linked-from-split",
        isTransfer: true,
        linkedTransactionId: "parent-tx",
        accountId: "account-2",
        amount: 50,
      };

      const parentSplit = {
        id: "parent-split",
        transactionId: "parent-tx",
        linkedTransactionId: "linked-from-split",
      };

      mockFindOne.mockResolvedValue(tx);
      splitsRepository.findOne.mockResolvedValue(parentSplit);

      // Mock for removeTransferFromSplit internal calls
      transactionsRepository.findOne.mockResolvedValue({
        id: "parent-tx",
        accountId: "account-1",
        amount: -100,
      });
      splitsRepository.find.mockResolvedValue([parentSplit]);

      await service.removeTransfer("user-1", "linked-from-split", mockFindOne);

      // Should remove the parent transaction and all related splits
      expect(splitsRepository.remove).toHaveBeenCalled();
      expect(transactionsRepository.remove).toHaveBeenCalled();
    });

    it("triggers net worth recalc for affected accounts", async () => {
      const fromTx = {
        id: "from-tx",
        isTransfer: true,
        linkedTransactionId: "to-tx",
        accountId: "from-account",
        amount: -500,
      };
      const toTx = {
        id: "to-tx",
        accountId: "to-account",
        amount: 500,
      };

      mockFindOne.mockResolvedValue(fromTx);
      splitsRepository.findOne.mockResolvedValue(null);
      transactionsRepository.findOne.mockResolvedValue(toTx);

      await service.removeTransfer("user-1", "from-tx", mockFindOne);

      jest.advanceTimersByTime(2000);

      expect(netWorthService.recalculateAccount).toHaveBeenCalledWith(
        "user-1",
        "from-account",
      );
      expect(netWorthService.recalculateAccount).toHaveBeenCalledWith(
        "user-1",
        "to-account",
      );
    });
  });

  describe("updateTransfer", () => {
    const fromTransaction = {
      id: "from-tx",
      accountId: "from-account",
      amount: -500,
      isTransfer: true,
      linkedTransactionId: "to-tx",
      exchangeRate: 1,
      account: mockFromAccount,
    } as unknown as Transaction;

    const toTransaction = {
      id: "to-tx",
      accountId: "to-account",
      amount: 500,
      isTransfer: true,
      linkedTransactionId: "from-tx",
      exchangeRate: 1,
      account: mockToAccount,
    } as unknown as Transaction;

    beforeEach(() => {
      mockFindOne.mockReset();
    });

    it("throws when transaction is not a transfer", async () => {
      mockFindOne.mockResolvedValue({
        id: "tx-1",
        isTransfer: false,
        linkedTransactionId: null,
      });

      await expect(
        service.updateTransfer("user-1", "tx-1", {}, mockFindOne),
      ).rejects.toThrow(BadRequestException);
    });

    it("throws when source and destination accounts are the same after update", async () => {
      mockFindOne
        .mockResolvedValueOnce(fromTransaction)
        .mockResolvedValueOnce(toTransaction);

      await expect(
        service.updateTransfer(
          "user-1",
          "from-tx",
          { fromAccountId: "to-account" },
          mockFindOne,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it("updates amount for both sides of the transfer", async () => {
      mockFindOne
        .mockResolvedValueOnce(fromTransaction)
        .mockResolvedValueOnce(toTransaction)
        .mockResolvedValueOnce({ ...fromTransaction, amount: -750 })
        .mockResolvedValueOnce({ ...toTransaction, amount: 750 });

      const result = await service.updateTransfer(
        "user-1",
        "from-tx",
        { amount: 750 },
        mockFindOne,
      );

      // Old balances reversed
      expect(accountsService.updateBalance).toHaveBeenCalledWith("from-account", 500);
      expect(accountsService.updateBalance).toHaveBeenCalledWith("to-account", -500);
      // New balances applied
      expect(accountsService.updateBalance).toHaveBeenCalledWith("from-account", -750);
      expect(accountsService.updateBalance).toHaveBeenCalledWith("to-account", 750);

      expect(transactionsRepository.update).toHaveBeenCalledWith(
        "from-tx",
        expect.objectContaining({ amount: -750 }),
      );
      expect(transactionsRepository.update).toHaveBeenCalledWith(
        "to-tx",
        expect.objectContaining({ amount: 750 }),
      );

      expect(result.fromTransaction).toBeDefined();
      expect(result.toTransaction).toBeDefined();
    });

    it("updates description and other metadata without changing balances", async () => {
      mockFindOne
        .mockResolvedValueOnce(fromTransaction)
        .mockResolvedValueOnce(toTransaction)
        .mockResolvedValueOnce(fromTransaction)
        .mockResolvedValueOnce(toTransaction);

      await service.updateTransfer(
        "user-1",
        "from-tx",
        { description: "Updated description", referenceNumber: "REF-123" },
        mockFindOne,
      );

      // Balances should NOT be touched for metadata-only updates
      expect(accountsService.updateBalance).not.toHaveBeenCalled();

      expect(transactionsRepository.update).toHaveBeenCalledWith(
        "from-tx",
        expect.objectContaining({
          description: "Updated description",
          referenceNumber: "REF-123",
        }),
      );
    });

    it("updates account IDs and adjusts payee names", async () => {
      const newToAccount = { id: "new-to-account", name: "Investment", currencyCode: "USD" };
      accountsService.findOne.mockImplementation((_userId: string, accountId: string) => {
        if (accountId === "new-to-account") return Promise.resolve(newToAccount);
        if (accountId === "from-account") return Promise.resolve(mockFromAccount);
        return Promise.resolve(mockToAccount);
      });

      mockFindOne
        .mockResolvedValueOnce(fromTransaction)
        .mockResolvedValueOnce(toTransaction)
        .mockResolvedValueOnce({ ...fromTransaction })
        .mockResolvedValueOnce({ ...toTransaction, accountId: "new-to-account" });

      await service.updateTransfer(
        "user-1",
        "from-tx",
        { toAccountId: "new-to-account" },
        mockFindOne,
      );

      // from-tx should get updated payeeName
      expect(transactionsRepository.update).toHaveBeenCalledWith(
        "from-tx",
        expect.objectContaining({
          payeeName: "Transfer to Investment",
        }),
      );

      // to-tx should get new accountId
      expect(transactionsRepository.update).toHaveBeenCalledWith(
        "to-tx",
        expect.objectContaining({
          accountId: "new-to-account",
        }),
      );
    });

    it("handles cross-currency exchange rate update", async () => {
      mockFindOne
        .mockResolvedValueOnce(fromTransaction)
        .mockResolvedValueOnce(toTransaction)
        .mockResolvedValueOnce(fromTransaction)
        .mockResolvedValueOnce(toTransaction);

      await service.updateTransfer(
        "user-1",
        "from-tx",
        { exchangeRate: 1.35 },
        mockFindOne,
      );

      // 500 * 1.35 = 675
      expect(transactionsRepository.update).toHaveBeenCalledWith(
        "to-tx",
        expect.objectContaining({ amount: 675 }),
      );

      expect(accountsService.updateBalance).toHaveBeenCalledWith("to-account", 675);
    });

    it("uses explicit toAmount over calculated amount", async () => {
      mockFindOne
        .mockResolvedValueOnce(fromTransaction)
        .mockResolvedValueOnce(toTransaction)
        .mockResolvedValueOnce(fromTransaction)
        .mockResolvedValueOnce(toTransaction);

      await service.updateTransfer(
        "user-1",
        "from-tx",
        { toAmount: 680 },
        mockFindOne,
      );

      expect(transactionsRepository.update).toHaveBeenCalledWith(
        "to-tx",
        expect.objectContaining({ amount: 680 }),
      );
    });

    it("correctly identifies from/to when called with to-transaction ID", async () => {
      // When the to-tx (positive amount) is passed as the transactionId
      mockFindOne
        .mockResolvedValueOnce(toTransaction)
        .mockResolvedValueOnce(fromTransaction)
        .mockResolvedValueOnce(fromTransaction)
        .mockResolvedValueOnce(toTransaction);

      await service.updateTransfer(
        "user-1",
        "to-tx",
        { amount: 600 },
        mockFindOne,
      );

      // Should update from-tx with negative amount
      expect(transactionsRepository.update).toHaveBeenCalledWith(
        "from-tx",
        expect.objectContaining({ amount: -600 }),
      );
    });

    it("does not update payeeName when custom payeeName is set", async () => {
      accountsService.findOne.mockImplementation((_userId: string, accountId: string) => {
        if (accountId === "new-to-account")
          return Promise.resolve({ id: "new-to-account", name: "Investment", currencyCode: "USD" });
        return Promise.resolve(mockFromAccount);
      });

      mockFindOne
        .mockResolvedValueOnce(fromTransaction)
        .mockResolvedValueOnce(toTransaction)
        .mockResolvedValueOnce(fromTransaction)
        .mockResolvedValueOnce(toTransaction);

      await service.updateTransfer(
        "user-1",
        "from-tx",
        { toAccountId: "new-to-account", payeeName: "Custom Name" },
        mockFindOne,
      );

      expect(transactionsRepository.update).toHaveBeenCalledWith(
        "from-tx",
        expect.objectContaining({ payeeName: "Custom Name" }),
      );
    });

    it("triggers net worth recalc for all affected accounts", async () => {
      const newToAccount = { id: "new-to-account", name: "Investment", currencyCode: "USD" };
      accountsService.findOne.mockImplementation((_userId: string, accountId: string) => {
        if (accountId === "new-to-account") return Promise.resolve(newToAccount);
        return Promise.resolve(mockFromAccount);
      });

      mockFindOne
        .mockResolvedValueOnce(fromTransaction)
        .mockResolvedValueOnce(toTransaction)
        .mockResolvedValueOnce(fromTransaction)
        .mockResolvedValueOnce(toTransaction);

      await service.updateTransfer(
        "user-1",
        "from-tx",
        { toAccountId: "new-to-account" },
        mockFindOne,
      );

      jest.advanceTimersByTime(2000);

      // Old and new accounts should all get recalculated
      expect(netWorthService.recalculateAccount).toHaveBeenCalledWith(
        "user-1",
        "from-account",
      );
      expect(netWorthService.recalculateAccount).toHaveBeenCalledWith(
        "user-1",
        "to-account",
      );
      expect(netWorthService.recalculateAccount).toHaveBeenCalledWith(
        "user-1",
        "new-to-account",
      );
    });

    it("skips transactionsRepository.update when no fields changed", async () => {
      mockFindOne
        .mockResolvedValueOnce(fromTransaction)
        .mockResolvedValueOnce(toTransaction)
        .mockResolvedValueOnce(fromTransaction)
        .mockResolvedValueOnce(toTransaction);

      await service.updateTransfer("user-1", "from-tx", {}, mockFindOne);

      expect(transactionsRepository.update).not.toHaveBeenCalled();
      expect(accountsService.updateBalance).not.toHaveBeenCalled();
    });
  });
});
