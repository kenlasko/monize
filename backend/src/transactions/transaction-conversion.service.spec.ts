import { Test } from "@nestjs/testing";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { DataSource } from "typeorm";
import { TransactionConversionService } from "./transaction-conversion.service";
import { TransactionsService } from "./transactions.service";
import { TransactionSplitService } from "./transaction-split.service";
import {
  PreparedTransfer,
  TransactionTransferService,
} from "./transaction-transfer.service";
import { Transaction, TransactionStatus } from "./entities/transaction.entity";
import { TransactionSplit } from "./entities/transaction-split.entity";
import { TransactionTag } from "../tags/entities/transaction-tag.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { AccountsService } from "../accounts/accounts.service";
import { NetWorthService } from "../net-worth/net-worth.service";
import { TagsService } from "../tags/tags.service";
import { ActionHistoryService } from "../action-history/action-history.service";
import { isTransactionInFuture } from "../common/date-utils";
import {
  createScopedDbMocks,
  DataSourceMock,
} from "../test-helpers/scoped-db-testing";
import { lockTransactionRow, lockTransactionRows } from "../common/db/locks";
import {
  lockedTransactionRow,
  stubLockedTransactions,
} from "../test-helpers/locks-testing";
import { transferLegColumns } from "./transfer-leg-columns";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);
jest.mock("../common/db/locks", () =>
  jest.requireActual("../test-helpers/locks-testing").locksMockModule(),
);
jest.mock("../common/date-utils", () => ({
  ...jest.requireActual("../common/date-utils"),
  isTransactionInFuture: jest.fn().mockReturnValue(false),
}));

const mockedIsFuture = isTransactionInFuture as jest.MockedFunction<
  typeof isTransactionInFuture
>;
const locks = {
  lockTransactionRow: lockTransactionRow as jest.Mock,
  lockTransactionRows: lockTransactionRows as jest.Mock,
};

const USER = "user-1";
const ROW = "row-1";
const COUNTERPART = "counterpart-1";
const CHEQUING = "acc-chequing";
const SAVINGS = "acc-savings";

function row(over: Partial<Transaction> = {}): Transaction {
  return {
    id: ROW,
    userId: USER,
    accountId: CHEQUING,
    transactionDate: "2026-01-15",
    amount: -50,
    currencyCode: "USD",
    exchangeRate: 1,
    description: "Weekly shop",
    referenceNumber: null,
    status: TransactionStatus.UNRECONCILED,
    isTransfer: false,
    isSplit: false,
    linkedTransactionId: null,
    payeeId: null,
    payeeName: "Grocer",
    categoryId: "cat-1",
    ...over,
  } as Transaction;
}

const transferDto = {
  fromAccountId: CHEQUING,
  toAccountId: SAVINGS,
  transactionDate: "2026-01-15",
  amount: 50,
};

function prepared(over: Partial<PreparedTransfer> = {}): PreparedTransfer {
  return {
    effectiveUserId: USER,
    realUserId: USER,
    dto: transferDto,
    fromAccount: { id: CHEQUING, userId: USER, currencyCode: "USD" },
    toAccount: { id: SAVINGS, userId: USER, currencyCode: "USD" },
    fromOwnerId: USER,
    toOwnerId: USER,
    hasForeignLeg: false,
    toAmount: 50,
    sourceCurrency: "USD",
    destinationCurrency: "USD",
    effectiveExchangeRate: 1,
    fromPayeeName: null,
    toPayeeName: null,
    ...over,
  } as PreparedTransfer;
}

describe("TransactionConversionService", () => {
  let service: TransactionConversionService;
  let dataSource: DataSourceMock;
  let manager: Record<string, jest.Mock>;
  let transactionsService: Record<string, jest.Mock>;
  let splitService: Record<string, jest.Mock>;
  let transferService: Record<string, jest.Mock>;
  let accountsService: Record<string, jest.Mock>;
  let netWorthService: Record<string, jest.Mock>;
  let tagsService: Record<string, jest.Mock>;
  let actionHistoryService: Record<string, jest.Mock>;
  let splitsRepository: Record<string, jest.Mock>;
  let preferencesRepository: Record<string, jest.Mock>;

  beforeEach(async () => {
    mockedIsFuture.mockReturnValue(false);
    splitsRepository = { findOne: jest.fn().mockResolvedValue(null) };
    preferencesRepository = {
      findOne: jest
        .fn()
        .mockResolvedValue({ userId: USER, lockReconciledTransactions: false }),
    };
    ({ manager, dataSource } = createScopedDbMocks([
      [TransactionSplit, splitsRepository],
      [UserPreference, preferencesRepository],
    ]));
    manager.create.mockImplementation((_entity, data) => ({ ...data }));
    manager.save.mockImplementation(async (entity) => ({
      ...entity,
      id: COUNTERPART,
    }));
    manager.update.mockResolvedValue({ affected: 1 });
    manager.delete.mockResolvedValue({ affected: 1 });
    manager.find.mockResolvedValue([]);
    // A raw read answers rows: none unless a test says otherwise (the kept
    // leg's category type, read under the lock).
    manager.query.mockResolvedValue([]);

    transactionsService = {
      findOne: jest.fn(),
      snapshotTransaction: jest.fn((tx: Transaction) => ({
        id: tx.id,
        amount: tx.amount,
        isTransfer: tx.isTransfer,
        linkedTransactionId: tx.linkedTransactionId,
      })),
      update: jest.fn(),
    };
    splitService = {
      lockEmbeddedInvestmentScopes: jest.fn().mockResolvedValue(undefined),
      deleteSplitSideEffects: jest.fn().mockResolvedValue(new Set<string>()),
      recomputeBondPricesAfterWrite: jest.fn().mockResolvedValue(undefined),
      prewarmSplitTransferRates: jest.fn().mockResolvedValue(undefined),
    };
    transferService = {
      prepareTransfer: jest.fn().mockResolvedValue(prepared()),
    };
    accountsService = {
      updateBalance: jest.fn().mockResolvedValue(undefined),
      recalculateCurrentBalance: jest.fn().mockResolvedValue(undefined),
    };
    netWorthService = { triggerDebouncedRecalc: jest.fn() };
    tagsService = {
      setTransactionTags: jest.fn().mockResolvedValue(undefined),
      addTransactionTags: jest.fn().mockResolvedValue(undefined),
    };
    actionHistoryService = { record: jest.fn().mockResolvedValue(null) };

    const module = await Test.createTestingModule({
      providers: [
        TransactionConversionService,
        { provide: TransactionsService, useValue: transactionsService },
        { provide: TransactionSplitService, useValue: splitService },
        { provide: TransactionTransferService, useValue: transferService },
        { provide: AccountsService, useValue: accountsService },
        { provide: NetWorthService, useValue: netWorthService },
        { provide: TagsService, useValue: tagsService },
        { provide: ActionHistoryService, useValue: actionHistoryService },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();
    service = module.get(TransactionConversionService);
  });

  /** The row as `findOne` returns it before the lock and as it reads under it. */
  function arrangeRow(over: Partial<Transaction> = {}) {
    const current = row(over);
    transactionsService.findOne.mockImplementation(
      async (_userId: string, id: string) => {
        if (id === ROW) return current;
        if (id === COUNTERPART)
          return row({
            id: COUNTERPART,
            accountId: SAVINGS,
            amount: 50,
            isTransfer: true,
            linkedTransactionId: ROW,
          });
        throw new NotFoundException();
      },
    );
    manager.findOne.mockImplementation(async (entity: unknown) =>
      entity === Transaction ? current : null,
    );
    stubLockedTransactions(locks, [
      lockedTransactionRow({
        id: ROW,
        accountId: current.accountId,
        amount: Number(current.amount),
        transactionDate: current.transactionDate,
        status: current.status,
        isSplit: current.isSplit,
        linkedTransactionId: current.linkedTransactionId,
      }),
    ]);
    return current;
  }

  const updateOf = (id: string) =>
    manager.update.mock.calls
      .filter(([, where]) => where?.id === id)
      .map(([, , data]) => data);

  describe("convertToTransfer", () => {
    it("rewrites the row as the source leg from the create's column set and posts both balances", async () => {
      arrangeRow();

      const result = await service.convertToTransfer(USER, ROW, transferDto);

      const legs = transferLegColumns(prepared());
      expect(updateOf(ROW)[0]).toEqual({
        ...legs.from,
        isSplit: false,
        linkedTransactionId: null,
        originalAmount: null,
        originalCurrencyCode: null,
      });
      expect(manager.create).toHaveBeenCalledWith(Transaction, legs.to);
      expect(updateOf(COUNTERPART)).toEqual([{ linkedTransactionId: ROW }]);
      expect(updateOf(ROW)[1]).toEqual({ linkedTransactionId: COUNTERPART });
      // The reversal of the expense, then the two legs: three atomic deltas.
      expect(accountsService.updateBalance.mock.calls).toEqual([
        [CHEQUING, 50],
        [CHEQUING, -50],
        [SAVINGS, 50],
      ]);
      expect(accountsService.recalculateCurrentBalance).not.toHaveBeenCalled();
      expect(result.fromTransaction.id).toBe(ROW);
      expect(result.toTransaction.id).toBe(COUNTERPART);
      // Derived state after the commit, for both accounts.
      expect(netWorthService.triggerDebouncedRecalc.mock.calls).toEqual(
        expect.arrayContaining([
          [CHEQUING, USER],
          [SAVINGS, USER],
        ]),
      );
      expect(actionHistoryService.record).toHaveBeenCalledWith(
        USER,
        expect.objectContaining({
          action: "update",
          entityId: ROW,
          descriptionKey: "convertedToTransfer",
          beforeData: expect.objectContaining({ isTransfer: false }),
        }),
      );
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    });

    it("makes the row the destination leg when its account is the transfer's destination", async () => {
      arrangeRow();
      const toChequing = {
        ...transferDto,
        fromAccountId: SAVINGS,
        toAccountId: CHEQUING,
      };
      transferService.prepareTransfer.mockResolvedValue(
        prepared({
          dto: toChequing,
          fromAccount: { id: SAVINGS, userId: USER, currencyCode: "USD" },
          toAccount: { id: CHEQUING, userId: USER, currencyCode: "USD" },
        } as Partial<PreparedTransfer>),
      );

      const result = await service.convertToTransfer(USER, ROW, toChequing);

      expect(updateOf(ROW)[0]).toEqual(
        expect.objectContaining({ accountId: CHEQUING, amount: 50 }),
      );
      expect(manager.create).toHaveBeenCalledWith(
        Transaction,
        expect.objectContaining({ accountId: SAVINGS, amount: -50 }),
      );
      expect(accountsService.updateBalance.mock.calls).toEqual([
        [CHEQUING, 50],
        [SAVINGS, -50],
        [CHEQUING, 50],
      ]);
      expect(result.toTransaction.id).toBe(ROW);
    });

    it("keeps the row's own status when the body names none, and takes the body's when it does", async () => {
      arrangeRow({ status: TransactionStatus.CLEARED });

      await service.convertToTransfer(USER, ROW, transferDto);

      expect(updateOf(ROW)[0]).toEqual(
        expect.objectContaining({ status: TransactionStatus.CLEARED }),
      );
      expect(manager.create).toHaveBeenCalledWith(
        Transaction,
        expect.objectContaining({ status: TransactionStatus.CLEARED }),
      );

      jest.clearAllMocks();
      arrangeRow({ status: TransactionStatus.CLEARED });
      const reconciled = {
        ...transferDto,
        status: TransactionStatus.RECONCILED,
      };
      transferService.prepareTransfer.mockResolvedValue(
        prepared({ dto: reconciled } as Partial<PreparedTransfer>),
      );
      await service.convertToTransfer(USER, ROW, reconciled);
      expect(updateOf(ROW)[0]).toEqual(
        expect.objectContaining({ status: TransactionStatus.RECONCILED }),
      );
    });

    it("drops the externalId only when the row moves to another account", async () => {
      arrangeRow();
      await service.convertToTransfer(USER, ROW, transferDto);
      expect(updateOf(ROW)[0]).not.toHaveProperty("externalId");

      jest.clearAllMocks();
      // The row sits in a third account; the transfer is chequing -> savings,
      // so the row becomes the source leg and moves into chequing.
      arrangeRow({ accountId: "acc-other" });
      await service.convertToTransfer(USER, ROW, transferDto);
      expect(updateOf(ROW)[0]).toEqual(
        expect.objectContaining({ accountId: CHEQUING, externalId: null }),
      );
      expect(accountsService.updateBalance.mock.calls).toEqual([
        ["acc-other", 50],
        [CHEQUING, -50],
        [SAVINGS, 50],
      ]);
    });

    it("removes a split parent's lines and side effects first and invalidates their accounts", async () => {
      arrangeRow({ isSplit: true, categoryId: null });
      splitService.deleteSplitSideEffects.mockResolvedValue(
        new Set(["acc-brokerage"]),
      );

      await service.convertToTransfer(USER, ROW, transferDto);

      expect(splitService.deleteSplitSideEffects).toHaveBeenCalledWith(
        ROW,
        USER,
        expect.objectContaining({ touchedSecurityIds: expect.any(Set) }),
      );
      expect(manager.delete).toHaveBeenCalledWith(TransactionSplit, {
        transactionId: ROW,
      });
      expect(updateOf(ROW)[0]).toEqual(
        expect.objectContaining({ isSplit: false, isTransfer: true }),
      );
      expect(netWorthService.triggerDebouncedRecalc).toHaveBeenCalledWith(
        "acc-brokerage",
        USER,
      );
    });

    it("moves no balance for a VOID row becoming a VOID transfer", async () => {
      arrangeRow({ status: TransactionStatus.VOID });
      const voidDto = { ...transferDto, status: TransactionStatus.VOID };
      transferService.prepareTransfer.mockResolvedValue(
        prepared({ dto: voidDto } as Partial<PreparedTransfer>),
      );

      await service.convertToTransfer(USER, ROW, voidDto);

      expect(accountsService.updateBalance).not.toHaveBeenCalled();
      expect(accountsService.recalculateCurrentBalance).not.toHaveBeenCalled();
    });

    it("recomputes every touched account instead of posting deltas when a date is in the future", async () => {
      arrangeRow();
      mockedIsFuture.mockReturnValue(true);

      await service.convertToTransfer(USER, ROW, transferDto);

      expect(accountsService.updateBalance).not.toHaveBeenCalled();
      expect(accountsService.recalculateCurrentBalance.mock.calls).toEqual([
        [USER, CHEQUING],
        [USER, SAVINGS],
      ]);
    });

    it("replaces both legs' tags with the body's list, else mirrors the row's tags onto the new leg", async () => {
      arrangeRow();
      await service.convertToTransfer(USER, ROW, {
        ...transferDto,
        tagIds: ["tag-1"],
      });
      expect(tagsService.setTransactionTags.mock.calls).toEqual([
        [ROW, ["tag-1"], USER],
        [COUNTERPART, ["tag-1"], USER],
      ]);
      expect(tagsService.addTransactionTags).not.toHaveBeenCalled();

      jest.clearAllMocks();
      arrangeRow();
      manager.find.mockImplementation(async (entity: unknown) =>
        entity === TransactionTag
          ? [{ transactionId: ROW, tagId: "tag-9" }]
          : [],
      );
      await service.convertToTransfer(USER, ROW, transferDto);
      expect(tagsService.setTransactionTags).not.toHaveBeenCalled();
      expect(tagsService.addTransactionTags).toHaveBeenCalledWith(
        manager,
        USER,
        [COUNTERPART],
        ["tag-9"],
      );
    });

    it("refuses a row that is already a transfer leg before opening a transaction", async () => {
      arrangeRow({ isTransfer: true, linkedTransactionId: COUNTERPART });

      await expect(
        service.convertToTransfer(USER, ROW, transferDto),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(transferService.prepareTransfer).not.toHaveBeenCalled();
    });

    it("refuses when the locked row has become a transfer leg since it was read", async () => {
      arrangeRow();
      manager.findOne.mockResolvedValue(
        row({ isTransfer: true, linkedTransactionId: "other" }),
      );

      await expect(
        service.convertToTransfer(USER, ROW, transferDto),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(manager.update).not.toHaveBeenCalled();
      expect(accountsService.updateBalance).not.toHaveBeenCalled();
    });

    it("refuses a transfer that names another owner's account", async () => {
      arrangeRow();
      transferService.prepareTransfer.mockResolvedValue(
        prepared({ hasForeignLeg: true }),
      );

      await expect(
        service.convertToTransfer(USER, ROW, transferDto),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it("refuses a reconciled row under the strict lock, writing nothing", async () => {
      arrangeRow({ status: TransactionStatus.RECONCILED });
      preferencesRepository.findOne.mockResolvedValue({
        userId: USER,
        lockReconciledTransactions: true,
      });

      await expect(
        service.convertToTransfer(USER, ROW, transferDto),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(manager.update).not.toHaveBeenCalled();
      expect(manager.save).not.toHaveBeenCalled();
    });

    it("reports a row that vanished under the lock as not found", async () => {
      arrangeRow();
      stubLockedTransactions(locks, []);

      await expect(
        service.convertToTransfer(USER, ROW, transferDto),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("convertToTransaction", () => {
    const body = {
      accountId: CHEQUING,
      amount: -50,
      categoryId: "cat-1",
    };

    function arrangeLeg(
      legOver: Partial<Transaction> = {},
      counterpartStatus: TransactionStatus = TransactionStatus.UNRECONCILED,
    ) {
      const leg = arrangeRow({
        isTransfer: true,
        linkedTransactionId: COUNTERPART,
        categoryId: null,
        ...legOver,
      });
      stubLockedTransactions(locks, [
        lockedTransactionRow({
          id: ROW,
          accountId: CHEQUING,
          amount: -50,
          linkedTransactionId: COUNTERPART,
        }),
        lockedTransactionRow({
          id: COUNTERPART,
          accountId: SAVINGS,
          amount: 50,
          status: counterpartStatus,
          linkedTransactionId: ROW,
        }),
      ]);
      transactionsService.update.mockResolvedValue(
        row({ ...legOver, isTransfer: false, linkedTransactionId: null }),
      );
      return leg;
    }

    it("clears a Transfer category the kept leg held, in the statement that detaches it (INV-CATEGORY-001)", async () => {
      arrangeLeg({ categoryId: "cat-transfer" });
      manager.query.mockImplementation(async (sql: string) =>
        sql.includes("category_type") ? [{ categoryType: "transfer" }] : [],
      );

      await service.convertToTransaction(USER, ROW, {});

      expect(updateOf(ROW)).toEqual([
        {
          isTransfer: false,
          linkedTransactionId: null,
          exchangeRate: 1,
          amountIsProvisional: false,
          categoryId: null,
        },
      ]);
    });

    it("keeps an Income or Expense category the kept leg held", async () => {
      arrangeLeg({ categoryId: "cat-1" });
      manager.query.mockImplementation(async (sql: string) =>
        sql.includes("category_type") ? [{ categoryType: "expense" }] : [],
      );

      await service.convertToTransaction(USER, ROW, {});

      expect(updateOf(ROW)[0]).not.toHaveProperty("categoryId");
    });

    it("removes and reverses the counterpart, detaches the leg and applies the body in one transaction", async () => {
      arrangeLeg();

      const result = await service.convertToTransaction(USER, ROW, body);

      expect(manager.delete).toHaveBeenCalledWith(Transaction, {
        id: COUNTERPART,
        userId: USER,
      });
      expect(accountsService.updateBalance).toHaveBeenCalledWith(SAVINGS, -50);
      // Detached with the pair's rate gone: a plain row has no rate of its own.
      // A provisional amount is a transfer leg's (design P3 of
      // docs/specs/provisional-amounts.md): the flag goes in the same
      // write that ends the row's life as a leg.
      expect(updateOf(ROW)).toEqual([
        {
          isTransfer: false,
          linkedTransactionId: null,
          exchangeRate: 1,
          amountIsProvisional: false,
        },
      ]);
      expect(transactionsService.update).toHaveBeenCalledWith(
        USER,
        ROW,
        body,
        expect.objectContaining({
          recordHistory: false,
          deferDerivedRecompute: expect.objectContaining({
            accountIds: expect.any(Set),
            securityIds: expect.any(Set),
          }),
        }),
      );
      expect(dataSource.transaction).toHaveBeenCalledTimes(2); // the split lookup, then the write
      expect(netWorthService.triggerDebouncedRecalc).toHaveBeenCalledWith(
        SAVINGS,
        USER,
      );
      expect(actionHistoryService.record).toHaveBeenCalledWith(
        USER,
        expect.objectContaining({
          descriptionKey: "convertedToTransaction",
          beforeData: expect.objectContaining({ isTransfer: true }),
        }),
      );
      expect(result.isTransfer).toBe(false);
    });

    it("dispatches what the nested update moved only after its own transaction", async () => {
      arrangeLeg();
      let dispatchedInsideTransaction = false;
      transactionsService.update.mockImplementation(
        async (
          _userId: string,
          _id: string,
          _dto: unknown,
          options: {
            deferDerivedRecompute: {
              accountIds: Set<string>;
              securityIds: Set<string>;
            };
          },
        ) => {
          // Inside the conversion's transaction: nothing may be queued yet.
          dispatchedInsideTransaction =
            netWorthService.triggerDebouncedRecalc.mock.calls.length > 0 ||
            splitService.recomputeBondPricesAfterWrite.mock.calls.length > 0;
          options.deferDerivedRecompute.accountIds.add(CHEQUING);
          options.deferDerivedRecompute.securityIds.add("sec-1");
          return row({ isTransfer: false, linkedTransactionId: null });
        },
      );

      await service.convertToTransaction(USER, ROW, body);

      expect(dispatchedInsideTransaction).toBe(false);
      expect(netWorthService.triggerDebouncedRecalc.mock.calls).toEqual(
        expect.arrayContaining([
          [SAVINGS, USER],
          [CHEQUING, USER],
        ]),
      );
      expect(splitService.recomputeBondPricesAfterWrite).toHaveBeenCalledWith(
        USER,
        new Set(["sec-1"]),
      );
    });

    it("prewarms split-line rates before the locks and passes the splits through", async () => {
      arrangeLeg();
      const withSplits = {
        ...body,
        splits: [{ amount: -50, transferAccountId: "acc-eur" }],
      };

      await service.convertToTransaction(USER, ROW, withSplits as never);

      expect(splitService.prewarmSplitTransferRates).toHaveBeenCalledWith(
        USER,
        withSplits.splits,
        CHEQUING,
        "2026-01-15",
      );
      expect(transactionsService.update).toHaveBeenCalledWith(
        USER,
        ROW,
        withSplits,
        expect.objectContaining({ recordHistory: false }),
      );
    });

    it("refuses a reconciled counterpart under the strict lock, writing nothing", async () => {
      arrangeLeg({}, TransactionStatus.RECONCILED);
      preferencesRepository.findOne.mockResolvedValue({
        userId: USER,
        lockReconciledTransactions: true,
      });

      await expect(
        service.convertToTransaction(USER, ROW, body),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(manager.delete).not.toHaveBeenCalled();
      expect(manager.update).not.toHaveBeenCalled();
      expect(transactionsService.update).not.toHaveBeenCalled();
    });

    it("allows a reconciled counterpart when the lock is off", async () => {
      arrangeLeg({}, TransactionStatus.RECONCILED);

      await service.convertToTransaction(USER, ROW, body);

      expect(manager.delete).toHaveBeenCalledTimes(1);
    });

    it("converts a one-sided leg with nothing to delete", async () => {
      arrangeLeg({ linkedTransactionId: null });
      stubLockedTransactions(locks, [
        lockedTransactionRow({ id: ROW, accountId: CHEQUING, amount: -50 }),
      ]);

      await service.convertToTransaction(USER, ROW, body);

      expect(manager.delete).not.toHaveBeenCalled();
      expect(accountsService.updateBalance).not.toHaveBeenCalled();
      expect(transactionsService.update).toHaveBeenCalled();
    });

    it("refuses a row that is not a transfer", async () => {
      arrangeRow();

      await expect(
        service.convertToTransaction(USER, ROW, body),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(transactionsService.update).not.toHaveBeenCalled();
    });

    it("refuses a split-transfer leg, whose pairing belongs to the parent", async () => {
      arrangeLeg();
      splitsRepository.findOne.mockResolvedValue({
        id: "split-1",
        transactionId: "parent-1",
      });

      await expect(
        service.convertToTransaction(USER, ROW, body),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(manager.delete).not.toHaveBeenCalled();
    });

    it("refuses a leg whose counterpart is another owner's row", async () => {
      arrangeLeg();
      transactionsService.findOne.mockImplementation(
        async (_userId: string, id: string) => {
          if (id === ROW)
            return row({ isTransfer: true, linkedTransactionId: COUNTERPART });
          throw new NotFoundException();
        },
      );

      await expect(
        service.convertToTransaction(USER, ROW, body),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(manager.delete).not.toHaveBeenCalled();
    });

    it("refuses with 409 when the counterpart vanished between the read and the lock", async () => {
      arrangeLeg();
      stubLockedTransactions(locks, [
        lockedTransactionRow({
          id: ROW,
          accountId: CHEQUING,
          amount: -50,
          linkedTransactionId: COUNTERPART,
        }),
      ]);

      await expect(
        service.convertToTransaction(USER, ROW, body),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(manager.update).not.toHaveBeenCalled();
    });
  });
});
