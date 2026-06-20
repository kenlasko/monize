import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { BadRequestException } from "@nestjs/common";
import { DataSource } from "typeorm";
import { TransactionTransferService } from "./transaction-transfer.service";
import { Transaction, TransactionStatus } from "./entities/transaction.entity";
import { TransactionSplit } from "./entities/transaction-split.entity";
import { Category } from "../categories/entities/category.entity";
import { AccountsService } from "../accounts/accounts.service";
import { PayeesService } from "../payees/payees.service";
import { NetWorthService } from "../net-worth/net-worth.service";
import { ActionHistoryService } from "../action-history/action-history.service";
import { isTransactionInFuture } from "../common/date-utils";

jest.mock("../common/date-utils", () => ({
  isTransactionInFuture: jest.fn().mockReturnValue(false),
}));

const mockedIsTransactionInFuture =
  isTransactionInFuture as jest.MockedFunction<typeof isTransactionInFuture>;

describe("TransactionTransferService", () => {
  let service: TransactionTransferService;
  let transactionsRepository: Record<string, jest.Mock>;
  let splitsRepository: Record<string, jest.Mock>;
  let categoriesRepository: Record<string, jest.Mock>;
  let accountsService: Record<string, jest.Mock>;
  let payeesService: Record<string, jest.Mock>;
  let netWorthService: Record<string, jest.Mock>;
  let mockQueryRunner: Record<string, any>;
  let mockDataSource: Record<string, jest.Mock>;

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
    mockedIsTransactionInFuture.mockReturnValue(false);

    transactionsRepository = {
      create: jest
        .fn()
        .mockImplementation((data) => ({ ...data, id: `tx-${Date.now()}` })),
      save: jest
        .fn()
        .mockResolvedValueOnce({
          id: "from-tx-id",
          ...baseTransferDto,
          amount: -500,
        })
        .mockResolvedValueOnce({
          id: "to-tx-id",
          ...baseTransferDto,
          amount: 500,
        }),
      update: jest.fn().mockResolvedValue(undefined),
      findOne: jest.fn(),
      remove: jest.fn().mockResolvedValue(undefined),
    };

    splitsRepository = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      remove: jest.fn().mockResolvedValue(undefined),
    };

    categoriesRepository = {
      // Default: any category id resolves to an owned category.
      findOne: jest.fn().mockResolvedValue({ id: "cat-1", userId: "user-1" }),
    };

    accountsService = {
      findOne: jest
        .fn()
        .mockImplementation((_userId: string, accountId: string) => {
          if (accountId === "from-account")
            return Promise.resolve(mockFromAccount);
          if (accountId === "to-account") return Promise.resolve(mockToAccount);
          return Promise.resolve({
            id: accountId,
            name: "Unknown",
            currencyCode: "USD",
          });
        }),
      updateBalance: jest.fn().mockResolvedValue(undefined),
      recalculateCurrentBalance: jest.fn().mockResolvedValue(undefined),
    };

    // Default: no payee matches a custom label (free-text / will-be-created
    // paths). Tests that exercise the match path override resolveByName.
    payeesService = {
      resolveByName: jest.fn().mockResolvedValue(null),
      findOrCreate: jest.fn(),
    };

    netWorthService = {
      recalculateAccount: jest.fn().mockResolvedValue(undefined),
      triggerDebouncedRecalc: jest.fn(),
    };

    mockFindOne.mockReset();

    mockQueryRunner = {
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      query: jest.fn().mockResolvedValue([]),
      manager: {
        create: jest
          .fn()
          .mockImplementation((_Entity: any, data: any) =>
            transactionsRepository.create(data),
          ),
        save: jest
          .fn()
          .mockImplementation((data: any) => transactionsRepository.save(data)),
        update: jest
          .fn()
          .mockImplementation((_Entity: any, id: any, data: any) =>
            transactionsRepository.update(id, data),
          ),
        findOne: jest
          .fn()
          .mockImplementation((_Entity: any, opts: any) =>
            transactionsRepository.findOne(opts),
          ),
        find: jest
          .fn()
          .mockImplementation((_Entity: any, opts: any) =>
            splitsRepository.find(opts),
          ),
        remove: jest.fn().mockImplementation((data: any) => {
          const item = Array.isArray(data) ? data[0] : data;
          if (item && "transactionId" in item && !("accountId" in item)) {
            return splitsRepository.remove(data);
          }
          return transactionsRepository.remove(data);
        }),
      },
    };

    mockDataSource = {
      createQueryRunner: jest.fn().mockReturnValue(mockQueryRunner),
    };

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
        {
          provide: getRepositoryToken(Category),
          useValue: categoriesRepository,
        },
        { provide: AccountsService, useValue: accountsService },
        { provide: PayeesService, useValue: payeesService },
        { provide: NetWorthService, useValue: netWorthService },
        { provide: DataSource, useValue: mockDataSource },
        {
          provide: ActionHistoryService,
          useValue: { record: jest.fn().mockResolvedValue(null) },
        },
      ],
    }).compile();

    service = module.get<TransactionTransferService>(
      TransactionTransferService,
    );
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
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "from-account",
        -500,
        expect.anything(),
      );
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "to-account",
        500,
        expect.anything(),
      );

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

    it("throws when amount is negative", async () => {
      const negDto = { ...baseTransferDto, amount: -100 };
      await expect(
        service.createTransfer("user-1", negDto, mockFindOne),
      ).rejects.toThrow("Transfer amount must not be negative");
    });

    it("allows zero amount transfer", async () => {
      transactionsRepository.save
        .mockReset()
        .mockResolvedValueOnce({ id: "from-tx-id" })
        .mockResolvedValueOnce({ id: "to-tx-id" });

      mockFindOne
        .mockResolvedValueOnce({ id: "from-tx-id" })
        .mockResolvedValueOnce({ id: "to-tx-id" });

      const zeroDto = { ...baseTransferDto, amount: 0 };
      const result = await service.createTransfer(
        "user-1",
        zeroDto,
        mockFindOne,
      );
      expect(result).toBeDefined();
      expect(result.fromTransaction).toBeDefined();
      expect(result.toTransaction).toBeDefined();
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
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "to-account",
        680,
        expect.anything(),
      );
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

      expect(netWorthService.triggerDebouncedRecalc).toHaveBeenCalledWith(
        "from-account",
        "user-1",
      );
      expect(netWorthService.triggerDebouncedRecalc).toHaveBeenCalledWith(
        "to-account",
        "user-1",
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

  describe("category on transfers", () => {
    const fromTx = {
      id: "from-tx",
      accountId: "from-account",
      amount: -500,
      isTransfer: true,
      linkedTransactionId: "to-tx",
      exchangeRate: 1,
      account: mockFromAccount,
    } as unknown as Transaction;

    const toTx = {
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

    it("stores the category on both legs when creating", async () => {
      mockFindOne
        .mockResolvedValueOnce({ id: "from-tx-id", amount: -500 })
        .mockResolvedValueOnce({ id: "to-tx-id", amount: 500 });

      await service.createTransfer(
        "user-1",
        { ...baseTransferDto, categoryId: "cat-1" },
        mockFindOne,
      );

      expect(transactionsRepository.create.mock.calls[0][0].categoryId).toBe(
        "cat-1",
      );
      expect(transactionsRepository.create.mock.calls[1][0].categoryId).toBe(
        "cat-1",
      );
    });

    it("defaults the category to null when none is given", async () => {
      mockFindOne
        .mockResolvedValueOnce({ id: "from-tx-id", amount: -500 })
        .mockResolvedValueOnce({ id: "to-tx-id", amount: 500 });

      await service.createTransfer("user-1", baseTransferDto, mockFindOne);

      expect(
        transactionsRepository.create.mock.calls[0][0].categoryId,
      ).toBeNull();
      expect(
        transactionsRepository.create.mock.calls[1][0].categoryId,
      ).toBeNull();
    });

    it("rejects a category the user does not own", async () => {
      categoriesRepository.findOne.mockResolvedValue(null);

      await expect(
        service.createTransfer(
          "user-1",
          { ...baseTransferDto, categoryId: "cat-x" },
          mockFindOne,
        ),
      ).rejects.toThrow(BadRequestException);
      expect(transactionsRepository.create).not.toHaveBeenCalled();
    });

    it("sets the category on both legs when updating", async () => {
      mockFindOne
        .mockResolvedValueOnce(fromTx)
        .mockResolvedValueOnce(toTx)
        .mockResolvedValueOnce(fromTx)
        .mockResolvedValueOnce(toTx);

      await service.updateTransfer(
        "user-1",
        "from-tx",
        { categoryId: "cat-1" },
        mockFindOne,
      );

      const updateCalls = transactionsRepository.update.mock.calls;
      const fromUpdate = updateCalls.find((c) => c[0] === "from-tx")?.[1];
      const toUpdate = updateCalls.find((c) => c[0] === "to-tx")?.[1];
      expect(fromUpdate.categoryId).toBe("cat-1");
      expect(toUpdate.categoryId).toBe("cat-1");
    });

    it("clears the category on both legs when updating with null", async () => {
      mockFindOne
        .mockResolvedValueOnce({ ...fromTx, categoryId: "cat-1" })
        .mockResolvedValueOnce({ ...toTx, categoryId: "cat-1" })
        .mockResolvedValueOnce(fromTx)
        .mockResolvedValueOnce(toTx);

      await service.updateTransfer(
        "user-1",
        "from-tx",
        { categoryId: null },
        mockFindOne,
      );

      const updateCalls = transactionsRepository.update.mock.calls;
      const fromUpdate = updateCalls.find((c) => c[0] === "from-tx")?.[1];
      const toUpdate = updateCalls.find((c) => c[0] === "to-tx")?.[1];
      expect(fromUpdate.categoryId).toBeNull();
      expect(toUpdate.categoryId).toBeNull();
    });

    it("does not reject when no category is provided on update", async () => {
      mockFindOne
        .mockResolvedValueOnce(fromTx)
        .mockResolvedValueOnce(toTx)
        .mockResolvedValueOnce(fromTx)
        .mockResolvedValueOnce(toTx);

      await service.updateTransfer(
        "user-1",
        "from-tx",
        { description: "note" },
        mockFindOne,
      );

      expect(categoriesRepository.findOne).not.toHaveBeenCalled();
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
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "from-account",
        500,
        expect.anything(),
      );
      // Reverse to transaction balance
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "to-account",
        -500,
        expect.anything(),
      );
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

      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "from-account",
        500,
        expect.anything(),
      );
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

      expect(netWorthService.triggerDebouncedRecalc).toHaveBeenCalledWith(
        "from-account",
        "user-1",
      );
      expect(netWorthService.triggerDebouncedRecalc).toHaveBeenCalledWith(
        "to-account",
        "user-1",
      );
    });

    it("recalculates balances instead of adjusting them when removing a future-dated split-linked transfer", async () => {
      mockedIsTransactionInFuture.mockReturnValue(true);

      const tx = {
        id: "linked-from-split",
        isTransfer: true,
        linkedTransactionId: "parent-tx",
        accountId: "account-2",
        amount: 50,
        transactionDate: "2099-01-01",
      };

      const targetSplit = {
        id: "target-split",
        transactionId: "parent-tx",
        linkedTransactionId: "linked-from-split",
      };
      // A second split links to a different leg, exercising the linked-leg
      // future recalc branch (line 627).
      const otherSplit = {
        id: "other-split",
        transactionId: "parent-tx",
        linkedTransactionId: "other-leg",
      };

      mockFindOne.mockResolvedValue(tx);
      splitsRepository.findOne.mockResolvedValue(targetSplit);
      transactionsRepository.findOne.mockImplementation((opts: any) => {
        const id = opts?.where?.id;
        if (id === "parent-tx")
          return Promise.resolve({
            id: "parent-tx",
            accountId: "account-1",
            amount: -100,
            transactionDate: "2099-01-01",
          });
        if (id === "other-leg")
          return Promise.resolve({
            id: "other-leg",
            accountId: "account-3",
            amount: 25,
            transactionDate: "2099-01-01",
          });
        return Promise.resolve(null);
      });
      splitsRepository.find.mockResolvedValue([targetSplit, otherSplit]);

      await service.removeTransfer("user-1", "linked-from-split", mockFindOne);

      // Future-dated: balances are recalculated, never adjusted.
      expect(accountsService.updateBalance).not.toHaveBeenCalled();
      expect(accountsService.recalculateCurrentBalance).toHaveBeenCalledWith(
        "account-3",
        expect.anything(),
      );
      expect(accountsService.recalculateCurrentBalance).toHaveBeenCalledWith(
        "account-1",
        expect.anything(),
      );
      expect(accountsService.recalculateCurrentBalance).toHaveBeenCalledWith(
        "account-2",
        expect.anything(),
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
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "from-account",
        500,
        expect.anything(),
      );
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "to-account",
        -500,
        expect.anything(),
      );
      // New balances applied
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "from-account",
        -750,
        expect.anything(),
      );
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "to-account",
        750,
        expect.anything(),
      );

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

    it("rewrites created_at on both legs via raw query when createdAt is provided", async () => {
      mockFindOne
        .mockResolvedValueOnce(fromTransaction)
        .mockResolvedValueOnce(toTransaction)
        .mockResolvedValueOnce(fromTransaction)
        .mockResolvedValueOnce(toTransaction);

      await service.updateTransfer(
        "user-1",
        "from-tx",
        { createdAt: "2026-01-10T12:34:56.000Z" } as any,
        mockFindOne,
      );

      const createdAtCalls = mockQueryRunner.query.mock.calls.filter(
        (c: any[]) =>
          typeof c[0] === "string" && c[0].includes("SET created_at"),
      );
      expect(createdAtCalls).toHaveLength(2);
      expect(createdAtCalls[0][1]).toEqual([
        expect.stringContaining("2026-01-10 12:34:56"),
        "from-tx",
      ]);
      expect(createdAtCalls[1][1][1]).toBe("to-tx");
    });

    it("updates the source and destination currency codes when provided", async () => {
      mockFindOne
        .mockResolvedValueOnce(fromTransaction)
        .mockResolvedValueOnce(toTransaction)
        .mockResolvedValueOnce(fromTransaction)
        .mockResolvedValueOnce(toTransaction);

      await service.updateTransfer(
        "user-1",
        "from-tx",
        { fromCurrencyCode: "EUR", toCurrencyCode: "GBP" },
        mockFindOne,
      );

      expect(transactionsRepository.update).toHaveBeenCalledWith(
        "from-tx",
        expect.objectContaining({ currencyCode: "EUR" }),
      );
      expect(transactionsRepository.update).toHaveBeenCalledWith(
        "to-tx",
        expect.objectContaining({ currencyCode: "GBP" }),
      );
    });

    it("updates account IDs and adjusts payee names", async () => {
      const newToAccount = {
        id: "new-to-account",
        name: "Investment",
        currencyCode: "USD",
      };
      accountsService.findOne.mockImplementation(
        (_userId: string, accountId: string) => {
          if (accountId === "new-to-account")
            return Promise.resolve(newToAccount);
          if (accountId === "from-account")
            return Promise.resolve(mockFromAccount);
          return Promise.resolve(mockToAccount);
        },
      );

      mockFindOne
        .mockResolvedValueOnce(fromTransaction)
        .mockResolvedValueOnce(toTransaction)
        .mockResolvedValueOnce({ ...fromTransaction })
        .mockResolvedValueOnce({
          ...toTransaction,
          accountId: "new-to-account",
        });

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

      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "to-account",
        675,
        expect.anything(),
      );
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

    it("regenerates default payeeName for both transactions when payeeName is explicitly cleared with null", async () => {
      mockFindOne
        .mockResolvedValueOnce(fromTransaction)
        .mockResolvedValueOnce(toTransaction)
        .mockResolvedValueOnce(fromTransaction)
        .mockResolvedValueOnce(toTransaction);

      await service.updateTransfer(
        "user-1",
        "from-tx",
        { payeeId: null, payeeName: null },
        mockFindOne,
      );

      // Default payee names regenerated from account names
      expect(transactionsRepository.update).toHaveBeenCalledWith(
        "from-tx",
        expect.objectContaining({
          payeeId: null,
          payeeName: "Transfer to Savings",
        }),
      );
      expect(transactionsRepository.update).toHaveBeenCalledWith(
        "to-tx",
        expect.objectContaining({
          payeeId: null,
          payeeName: "Transfer from Checking",
        }),
      );
    });

    it("regenerates default payeeName when payeeName is cleared with empty string", async () => {
      mockFindOne
        .mockResolvedValueOnce(fromTransaction)
        .mockResolvedValueOnce(toTransaction)
        .mockResolvedValueOnce(fromTransaction)
        .mockResolvedValueOnce(toTransaction);

      await service.updateTransfer(
        "user-1",
        "from-tx",
        { payeeName: "" },
        mockFindOne,
      );

      expect(transactionsRepository.update).toHaveBeenCalledWith(
        "from-tx",
        expect.objectContaining({ payeeName: "Transfer to Savings" }),
      );
      expect(transactionsRepository.update).toHaveBeenCalledWith(
        "to-tx",
        expect.objectContaining({ payeeName: "Transfer from Checking" }),
      );
    });

    it("does not modify description when only clearing the payee", async () => {
      mockFindOne
        .mockResolvedValueOnce(fromTransaction)
        .mockResolvedValueOnce(toTransaction)
        .mockResolvedValueOnce(fromTransaction)
        .mockResolvedValueOnce(toTransaction);

      await service.updateTransfer(
        "user-1",
        "from-tx",
        { payeeId: null, payeeName: null },
        mockFindOne,
      );

      const fromCall = transactionsRepository.update.mock.calls.find(
        (c: any[]) => c[0] === "from-tx",
      );
      expect(fromCall[1]).not.toHaveProperty("description");
    });

    it("regenerates auto-generated payeeName when destination account changes and frontend re-sends the old auto-generated value", async () => {
      // Simulates the frontend behavior: when editing a transfer, the form
      // always re-sends payeeName (the previous auto-generated value), so
      // payeeName !== undefined but should still be regenerated.
      const newToAccount = {
        id: "new-to-account",
        name: "Investment",
        currencyCode: "USD",
      };
      accountsService.findOne.mockImplementation(
        (_userId: string, accountId: string) => {
          if (accountId === "new-to-account")
            return Promise.resolve(newToAccount);
          if (accountId === "from-account")
            return Promise.resolve(mockFromAccount);
          return Promise.resolve(mockToAccount);
        },
      );

      const fromWithAutoPayee = {
        ...fromTransaction,
        payeeId: null,
        payeeName: "Transfer to Savings",
      } as unknown as Transaction;
      const toWithAutoPayee = {
        ...toTransaction,
        payeeId: null,
        payeeName: "Transfer from Checking",
      } as unknown as Transaction;

      mockFindOne
        .mockResolvedValueOnce(fromWithAutoPayee)
        .mockResolvedValueOnce(toWithAutoPayee)
        .mockResolvedValueOnce(fromWithAutoPayee)
        .mockResolvedValueOnce({
          ...toWithAutoPayee,
          accountId: "new-to-account",
        });

      await service.updateTransfer(
        "user-1",
        "from-tx",
        {
          toAccountId: "new-to-account",
          payeeId: null,
          payeeName: "Transfer to Savings",
        },
        mockFindOne,
      );

      expect(transactionsRepository.update).toHaveBeenCalledWith(
        "from-tx",
        expect.objectContaining({ payeeName: "Transfer to Investment" }),
      );
    });

    it("regenerates auto-generated payeeName on the to-side when source account changes", async () => {
      const newFromAccount = {
        id: "new-from-account",
        name: "Brokerage",
        currencyCode: "USD",
      };
      accountsService.findOne.mockImplementation(
        (_userId: string, accountId: string) => {
          if (accountId === "new-from-account")
            return Promise.resolve(newFromAccount);
          if (accountId === "to-account") return Promise.resolve(mockToAccount);
          return Promise.resolve(mockFromAccount);
        },
      );

      const fromWithAutoPayee = {
        ...fromTransaction,
        payeeId: null,
        payeeName: "Transfer to Savings",
      } as unknown as Transaction;
      const toWithAutoPayee = {
        ...toTransaction,
        payeeId: null,
        payeeName: "Transfer from Checking",
      } as unknown as Transaction;

      mockFindOne
        .mockResolvedValueOnce(fromWithAutoPayee)
        .mockResolvedValueOnce(toWithAutoPayee)
        .mockResolvedValueOnce({
          ...fromWithAutoPayee,
          accountId: "new-from-account",
        })
        .mockResolvedValueOnce(toWithAutoPayee);

      await service.updateTransfer(
        "user-1",
        "from-tx",
        {
          fromAccountId: "new-from-account",
          payeeId: null,
          payeeName: "Transfer from Checking",
        },
        mockFindOne,
      );

      expect(transactionsRepository.update).toHaveBeenCalledWith(
        "to-tx",
        expect.objectContaining({ payeeName: "Transfer from Brokerage" }),
      );
    });

    it("does not regenerate payeeName when destination account changes but payee was user-set (payeeId present)", async () => {
      const newToAccount = {
        id: "new-to-account",
        name: "Investment",
        currencyCode: "USD",
      };
      accountsService.findOne.mockImplementation(
        (_userId: string, accountId: string) => {
          if (accountId === "new-to-account")
            return Promise.resolve(newToAccount);
          if (accountId === "from-account")
            return Promise.resolve(mockFromAccount);
          return Promise.resolve(mockToAccount);
        },
      );

      const fromWithLinkedPayee = {
        ...fromTransaction,
        payeeId: "payee-1",
        payeeName: "Transfer to Savings",
      } as unknown as Transaction;

      mockFindOne
        .mockResolvedValueOnce(fromWithLinkedPayee)
        .mockResolvedValueOnce(toTransaction)
        .mockResolvedValueOnce(fromWithLinkedPayee)
        .mockResolvedValueOnce({
          ...toTransaction,
          accountId: "new-to-account",
        });

      await service.updateTransfer(
        "user-1",
        "from-tx",
        {
          toAccountId: "new-to-account",
          payeeId: "payee-1",
          payeeName: "Transfer to Savings",
        },
        mockFindOne,
      );

      const fromCall = transactionsRepository.update.mock.calls.find(
        (c: any[]) => c[0] === "from-tx",
      );
      expect(fromCall[1].payeeName).toBe("Transfer to Savings");
    });

    it("does not update payeeName when custom payeeName is set", async () => {
      accountsService.findOne.mockImplementation(
        (_userId: string, accountId: string) => {
          if (accountId === "new-to-account")
            return Promise.resolve({
              id: "new-to-account",
              name: "Investment",
              currencyCode: "USD",
            });
          return Promise.resolve(mockFromAccount);
        },
      );

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
      const newToAccount = {
        id: "new-to-account",
        name: "Investment",
        currencyCode: "USD",
      };
      accountsService.findOne.mockImplementation(
        (_userId: string, accountId: string) => {
          if (accountId === "new-to-account")
            return Promise.resolve(newToAccount);
          return Promise.resolve(mockFromAccount);
        },
      );

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

      // Old and new accounts should all get recalculated
      expect(netWorthService.triggerDebouncedRecalc).toHaveBeenCalledWith(
        "from-account",
        "user-1",
      );
      expect(netWorthService.triggerDebouncedRecalc).toHaveBeenCalledWith(
        "to-account",
        "user-1",
      );
      expect(netWorthService.triggerDebouncedRecalc).toHaveBeenCalledWith(
        "new-to-account",
        "user-1",
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

  describe("future-dated transfers", () => {
    const futureDate = "2099-12-31";
    const currentDate = "2026-01-15";

    describe("createTransfer", () => {
      it("does not call updateBalance when creating a future-dated transfer", async () => {
        mockedIsTransactionInFuture.mockReturnValue(true);

        const dto = { ...baseTransferDto, transactionDate: futureDate };

        transactionsRepository.save
          .mockReset()
          .mockResolvedValueOnce({ id: "from-tx-id", ...dto, amount: -500 })
          .mockResolvedValueOnce({ id: "to-tx-id", ...dto, amount: 500 });

        mockFindOne
          .mockResolvedValueOnce({ id: "from-tx-id", amount: -500 })
          .mockResolvedValueOnce({ id: "to-tx-id", amount: 500 });

        await service.createTransfer("user-1", dto, mockFindOne);

        expect(accountsService.updateBalance).not.toHaveBeenCalled();
      });
    });

    describe("removeTransfer", () => {
      it("does not call updateBalance when removing a future-dated transfer", async () => {
        mockedIsTransactionInFuture.mockReturnValue(true);

        const fromTx = {
          id: "from-tx",
          isTransfer: true,
          linkedTransactionId: "to-tx",
          accountId: "from-account",
          amount: -500,
          transactionDate: futureDate,
        };
        const toTx = {
          id: "to-tx",
          accountId: "to-account",
          amount: 500,
          transactionDate: futureDate,
        };

        mockFindOne.mockResolvedValue(fromTx);
        splitsRepository.findOne.mockResolvedValue(null);
        transactionsRepository.findOne.mockResolvedValue(toTx);

        await service.removeTransfer("user-1", "from-tx", mockFindOne);

        expect(accountsService.updateBalance).not.toHaveBeenCalled();
        expect(transactionsRepository.remove).toHaveBeenCalledWith(toTx);
        expect(transactionsRepository.remove).toHaveBeenCalledWith(fromTx);
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
        transactionDate: currentDate,
      } as unknown as Transaction;

      const toTransaction = {
        id: "to-tx",
        accountId: "to-account",
        amount: 500,
        isTransfer: true,
        linkedTransactionId: "from-tx",
        exchangeRate: 1,
        account: mockToAccount,
        transactionDate: currentDate,
      } as unknown as Transaction;

      const futureFromTransaction = {
        ...fromTransaction,
        transactionDate: futureDate,
      } as unknown as Transaction;

      const futureToTransaction = {
        ...toTransaction,
        transactionDate: futureDate,
      } as unknown as Transaction;

      it("applies new balances when updating from future to current date", async () => {
        // Old date is future, new date is current
        mockedIsTransactionInFuture.mockImplementation(
          (date: string) => date === futureDate,
        );

        mockFindOne
          .mockResolvedValueOnce(futureFromTransaction)
          .mockResolvedValueOnce(futureToTransaction)
          .mockResolvedValueOnce({ ...fromTransaction })
          .mockResolvedValueOnce({ ...toTransaction });

        await service.updateTransfer(
          "user-1",
          "from-tx",
          { transactionDate: currentDate },
          mockFindOne,
        );

        // When any future date is involved, recalculate from scratch
        expect(accountsService.recalculateCurrentBalance).toHaveBeenCalledWith(
          "from-account",
          expect.anything(),
        );
        expect(accountsService.recalculateCurrentBalance).toHaveBeenCalledWith(
          "to-account",
          expect.anything(),
        );
        expect(accountsService.updateBalance).not.toHaveBeenCalled();
      });

      it("reverses old balances when updating from current to future date", async () => {
        // Old date is current, new date is future
        mockedIsTransactionInFuture.mockImplementation(
          (date: string) => date === futureDate,
        );

        mockFindOne
          .mockResolvedValueOnce(fromTransaction)
          .mockResolvedValueOnce(toTransaction)
          .mockResolvedValueOnce({ ...futureFromTransaction })
          .mockResolvedValueOnce({ ...futureToTransaction });

        await service.updateTransfer(
          "user-1",
          "from-tx",
          { transactionDate: futureDate },
          mockFindOne,
        );

        // When any future date is involved, recalculate from scratch
        expect(accountsService.recalculateCurrentBalance).toHaveBeenCalledWith(
          "from-account",
          expect.anything(),
        );
        expect(accountsService.recalculateCurrentBalance).toHaveBeenCalledWith(
          "to-account",
          expect.anything(),
        );
        expect(accountsService.updateBalance).not.toHaveBeenCalled();
      });
    });
  });

  describe("transaction atomicity", () => {
    it("createTransfer commits transaction on success and releases queryRunner", async () => {
      transactionsRepository.save
        .mockReset()
        .mockResolvedValueOnce({ id: "from-tx-id" })
        .mockResolvedValueOnce({ id: "to-tx-id" });

      mockFindOne
        .mockResolvedValueOnce({ id: "from-tx-id" })
        .mockResolvedValueOnce({ id: "to-tx-id" });

      await service.createTransfer("user-1", baseTransferDto, mockFindOne);

      expect(mockQueryRunner.connect).toHaveBeenCalled();
      expect(mockQueryRunner.startTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.rollbackTransaction).not.toHaveBeenCalled();
      expect(mockQueryRunner.release).toHaveBeenCalled();
    });

    it("createTransfer rolls back on error and releases queryRunner", async () => {
      transactionsRepository.save
        .mockReset()
        .mockRejectedValue(new Error("DB error"));

      await expect(
        service.createTransfer("user-1", baseTransferDto, mockFindOne),
      ).rejects.toThrow("DB error");

      expect(mockQueryRunner.startTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.commitTransaction).not.toHaveBeenCalled();
      expect(mockQueryRunner.release).toHaveBeenCalled();
    });

    it("removeTransfer commits transaction on success and releases queryRunner", async () => {
      const fromTx = {
        id: "from-tx",
        isTransfer: true,
        linkedTransactionId: null,
        accountId: "from-account",
        amount: -500,
      };

      mockFindOne.mockResolvedValue(fromTx);
      splitsRepository.findOne.mockResolvedValue(null);

      await service.removeTransfer("user-1", "from-tx", mockFindOne);

      expect(mockQueryRunner.connect).toHaveBeenCalled();
      expect(mockQueryRunner.startTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.rollbackTransaction).not.toHaveBeenCalled();
      expect(mockQueryRunner.release).toHaveBeenCalled();
    });

    it("removeTransfer rolls back on error and releases queryRunner", async () => {
      const fromTx = {
        id: "from-tx",
        isTransfer: true,
        linkedTransactionId: null,
        accountId: "from-account",
        amount: -500,
      };

      mockFindOne.mockResolvedValue(fromTx);
      splitsRepository.findOne.mockResolvedValue(null);
      accountsService.updateBalance.mockRejectedValueOnce(
        new Error("Balance error"),
      );

      await expect(
        service.removeTransfer("user-1", "from-tx", mockFindOne),
      ).rejects.toThrow("Balance error");

      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.commitTransaction).not.toHaveBeenCalled();
      expect(mockQueryRunner.release).toHaveBeenCalled();
    });

    it("updateTransfer commits transaction on success and releases queryRunner", async () => {
      const fromTx = {
        id: "from-tx",
        accountId: "from-account",
        amount: -500,
        isTransfer: true,
        linkedTransactionId: "to-tx",
        exchangeRate: 1,
        account: mockFromAccount,
        transactionDate: "2026-01-15",
      } as unknown as Transaction;

      const toTx = {
        id: "to-tx",
        accountId: "to-account",
        amount: 500,
        isTransfer: true,
        linkedTransactionId: "from-tx",
        exchangeRate: 1,
        account: mockToAccount,
        transactionDate: "2026-01-15",
      } as unknown as Transaction;

      mockFindOne
        .mockResolvedValueOnce(fromTx)
        .mockResolvedValueOnce(toTx)
        .mockResolvedValueOnce({ ...fromTx, amount: -600 })
        .mockResolvedValueOnce({ ...toTx, amount: 600 });

      await service.updateTransfer(
        "user-1",
        "from-tx",
        { amount: 600 },
        mockFindOne,
      );

      expect(mockQueryRunner.connect).toHaveBeenCalled();
      expect(mockQueryRunner.startTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.rollbackTransaction).not.toHaveBeenCalled();
      expect(mockQueryRunner.release).toHaveBeenCalled();
    });

    it("updateTransfer rolls back on error and releases queryRunner", async () => {
      const fromTx = {
        id: "from-tx",
        accountId: "from-account",
        amount: -500,
        isTransfer: true,
        linkedTransactionId: "to-tx",
        exchangeRate: 1,
        account: mockFromAccount,
        transactionDate: "2026-01-15",
      } as unknown as Transaction;

      const toTx = {
        id: "to-tx",
        accountId: "to-account",
        amount: 500,
        isTransfer: true,
        linkedTransactionId: "from-tx",
        exchangeRate: 1,
        account: mockToAccount,
        transactionDate: "2026-01-15",
      } as unknown as Transaction;

      mockFindOne.mockResolvedValueOnce(fromTx).mockResolvedValueOnce(toTx);

      accountsService.updateBalance.mockRejectedValueOnce(
        new Error("DB error"),
      );

      await expect(
        service.updateTransfer(
          "user-1",
          "from-tx",
          { amount: 600 },
          mockFindOne,
        ),
      ).rejects.toThrow("DB error");

      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.commitTransaction).not.toHaveBeenCalled();
      expect(mockQueryRunner.release).toHaveBeenCalled();
    });
  });

  describe("isTransfer", () => {
    it("returns true for a transfer leg", () => {
      expect(service.isTransfer({ isTransfer: true } as any)).toBe(true);
    });
    it("returns false for a normal transaction", () => {
      expect(service.isTransfer({ isTransfer: false } as any)).toBe(false);
    });
  });

  describe("previewCreateTransfer", () => {
    it("resolves accounts, derives currencies, and computes toAmount from exchangeRate", async () => {
      const preview = await service.previewCreateTransfer("user-1", {
        fromAccountId: "from-account",
        toAccountId: "to-account",
        amount: 100,
        transactionDate: "2026-01-15",
        exchangeRate: 1.25,
      });
      expect(preview).toMatchObject({
        fromAccountId: "from-account",
        fromAccountName: "Checking",
        fromCurrencyCode: "USD",
        toAccountId: "to-account",
        toAccountName: "Savings",
        toCurrencyCode: "USD",
        amount: 100,
        toAmount: 125,
        exchangeRate: 1.25,
        transactionDate: "2026-01-15",
        description: null,
        payeeName: null,
      });
    });

    it("uses an explicit toAmount over the exchange rate and strips html from description", async () => {
      const preview = await service.previewCreateTransfer("user-1", {
        fromAccountId: "from-account",
        toAccountId: "to-account",
        amount: 100,
        transactionDate: "2026-01-15",
        exchangeRate: 2,
        toAmount: 90,
        description: "Wire <b>x</b>",
      });
      expect(preview.toAmount).toBe(90);
      // stripHtml escapes angle brackets rather than emitting raw markup.
      expect(preview.description).not.toContain("<");
    });

    it("sets a custom payeeName, sanitized", async () => {
      const preview = await service.previewCreateTransfer("user-1", {
        fromAccountId: "from-account",
        toAccountId: "to-account",
        amount: 100,
        transactionDate: "2026-01-15",
        payeeName: "Rent <b>split</b>",
      });
      expect(preview.payeeName).toBeTruthy();
      expect(preview.payeeName).not.toContain("<");
    });

    it("defaults payeeName to null when omitted", async () => {
      const preview = await service.previewCreateTransfer("user-1", {
        fromAccountId: "from-account",
        toAccountId: "to-account",
        amount: 100,
        transactionDate: "2026-01-15",
      });
      expect(preview.payeeName).toBeNull();
      expect(preview.payeeId).toBeNull();
      expect(preview.payeeMatched).toBe(false);
      expect(preview.payeeWillBeCreated).toBe(false);
    });

    it("links payeeId and adopts the canonical name when the label matches an existing payee", async () => {
      payeesService.resolveByName.mockResolvedValue({
        id: "payee-1",
        name: "Buon Gusto Restaurant",
        defaultCategoryId: "cat-1",
      });
      const preview = await service.previewCreateTransfer("user-1", {
        fromAccountId: "from-account",
        toAccountId: "to-account",
        amount: 100,
        transactionDate: "2026-01-15",
        payeeName: "Buon Gusto",
      });
      expect(payeesService.resolveByName).toHaveBeenCalledWith(
        "user-1",
        "Buon Gusto",
      );
      expect(preview.payeeId).toBe("payee-1");
      expect(preview.payeeName).toBe("Buon Gusto Restaurant");
      expect(preview.payeeMatched).toBe(true);
      expect(preview.payeeWillBeCreated).toBe(false);
    });

    it("flags an unmatched label for creation by default", async () => {
      const preview = await service.previewCreateTransfer("user-1", {
        fromAccountId: "from-account",
        toAccountId: "to-account",
        amount: 100,
        transactionDate: "2026-01-15",
        payeeName: "Brand New Label",
      });
      expect(preview.payeeId).toBeNull();
      expect(preview.payeeMatched).toBe(false);
      expect(preview.payeeWillBeCreated).toBe(true);
      expect(preview.payeeName).toBe("Brand New Label");
    });

    it("keeps an unmatched label as free text when createPayeeIfMissing is false", async () => {
      const preview = await service.previewCreateTransfer("user-1", {
        fromAccountId: "from-account",
        toAccountId: "to-account",
        amount: 100,
        transactionDate: "2026-01-15",
        payeeName: "Brand New Label",
        createPayeeIfMissing: false,
      });
      expect(preview.payeeId).toBeNull();
      expect(preview.payeeMatched).toBe(false);
      expect(preview.payeeWillBeCreated).toBe(false);
      expect(preview.payeeName).toBe("Brand New Label");
    });

    it("rejects same source and destination account", async () => {
      await expect(
        service.previewCreateTransfer("user-1", {
          fromAccountId: "from-account",
          toAccountId: "from-account",
          amount: 100,
          transactionDate: "2026-01-15",
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects a negative amount", async () => {
      await expect(
        service.previewCreateTransfer("user-1", {
          fromAccountId: "from-account",
          toAccountId: "to-account",
          amount: -1,
          transactionDate: "2026-01-15",
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("previewUpdateTransfer", () => {
    const fromLeg = {
      id: "from-tx",
      accountId: "from-account",
      account: { name: "Checking" },
      amount: -100,
      currencyCode: "USD",
      exchangeRate: 1,
      transactionDate: "2026-01-15",
      description: "old",
      payeeName: "Transfer to Savings",
      isTransfer: true,
      linkedTransactionId: "to-tx",
    };
    const toLeg = {
      id: "to-tx",
      accountId: "to-account",
      account: { name: "Savings" },
      amount: 100,
      currencyCode: "USD",
      exchangeRate: 1,
      transactionDate: "2026-01-15",
      description: "old",
      payeeName: "Transfer from Checking",
      isTransfer: true,
      linkedTransactionId: "from-tx",
    };

    it("determines canonical from/to legs and returns the resulting state", async () => {
      const findOne = jest.fn(async (_uid: string, id: string) =>
        id === "from-tx" ? fromLeg : toLeg,
      );
      const preview = await service.previewUpdateTransfer(
        "user-1",
        "from-tx",
        { amount: 200 },
        findOne as any,
      );
      expect(preview).toMatchObject({
        transactionId: "from-tx",
        fromAccountId: "from-account",
        fromAccountName: "Checking",
        toAccountId: "to-account",
        toAccountName: "Savings",
        amount: 200,
        toAmount: 200,
      });
    });

    it("keeps the existing from-leg payee link untouched when omitted", async () => {
      const findOne = jest.fn(async (_uid: string, id: string) =>
        id === "from-tx" ? { ...fromLeg, payeeId: "existing-payee" } : toLeg,
      );
      const preview = await service.previewUpdateTransfer(
        "user-1",
        "from-tx",
        { amount: 200 },
        findOne as any,
      );
      expect(preview.payeeName).toBe("Transfer to Savings");
      expect(preview.payeeId).toBe("existing-payee");
      expect(preview.payeeMatched).toBe(true);
      expect(preview.payeeWillBeCreated).toBe(false);
      expect(payeesService.resolveByName).not.toHaveBeenCalled();
    });

    it("sets a custom payeeName, sanitized, and flags creation for an unmatched label", async () => {
      const findOne = jest.fn(async (_uid: string, id: string) =>
        id === "from-tx" ? fromLeg : toLeg,
      );
      const preview = await service.previewUpdateTransfer(
        "user-1",
        "from-tx",
        { payeeName: "Shared rent <i>x</i>" },
        findOne as any,
      );
      expect(preview.payeeName).toBeTruthy();
      expect(preview.payeeName).not.toContain("<");
      expect(preview.payeeId).toBeNull();
      expect(preview.payeeMatched).toBe(false);
      expect(preview.payeeWillBeCreated).toBe(true);
    });

    it("links payeeId when a new label matches an existing payee", async () => {
      payeesService.resolveByName.mockResolvedValue({
        id: "payee-9",
        name: "Landlord LLC",
        defaultCategoryId: null,
      });
      const findOne = jest.fn(async (_uid: string, id: string) =>
        id === "from-tx" ? fromLeg : toLeg,
      );
      const preview = await service.previewUpdateTransfer(
        "user-1",
        "from-tx",
        { payeeName: "Landlord" },
        findOne as any,
      );
      expect(preview.payeeId).toBe("payee-9");
      expect(preview.payeeName).toBe("Landlord LLC");
      expect(preview.payeeMatched).toBe(true);
      expect(preview.payeeWillBeCreated).toBe(false);
    });

    it("keeps an unmatched new label as free text when createPayeeIfMissing is false", async () => {
      const findOne = jest.fn(async (_uid: string, id: string) =>
        id === "from-tx" ? fromLeg : toLeg,
      );
      const preview = await service.previewUpdateTransfer(
        "user-1",
        "from-tx",
        { payeeName: "Freeform", createPayeeIfMissing: false },
        findOne as any,
      );
      expect(preview.payeeId).toBeNull();
      expect(preview.payeeMatched).toBe(false);
      expect(preview.payeeWillBeCreated).toBe(false);
      expect(preview.payeeName).toBe("Freeform");
    });

    it("throws notATransfer when the target is not a transfer", async () => {
      const findOne = jest.fn(async () => ({
        id: "x",
        isTransfer: false,
        linkedTransactionId: null,
      }));
      await expect(
        service.previewUpdateTransfer("user-1", "x", {}, findOne as any),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
