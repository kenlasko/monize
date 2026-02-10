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

describe("TransactionsService", () => {
  let service: TransactionsService;
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
      ],
    }).compile();

    service = module.get<TransactionsService>(TransactionsService);
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
});
