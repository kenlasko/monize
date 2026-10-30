import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { TransactionReconciliationService } from "./transaction-reconciliation.service";
import { RECONCILED_THROUGH_SQL } from "./stale-reconciliation";
import { Transaction, TransactionStatus } from "./entities/transaction.entity";
import { TransactionSplit } from "./entities/transaction-split.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { AccountsService } from "../accounts/accounts.service";
import { TransactionSplitService } from "./transaction-split.service";
import { isTransactionInFuture } from "../common/date-utils";
import {
  createScopedDbMocks,
  DataSourceMock,
} from "../test-helpers/scoped-db-testing";
import { lockTransactionRow } from "../common/db/locks";
import {
  lockedTransactionRow,
  stubLockedTransactions,
} from "../test-helpers/locks-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

// The status a guard refuses on and the status a balance delta is derived from
// are the same value, read under the write's own lock. A spec says what the
// committed row holds; see test-helpers/locks-testing.
jest.mock("../common/db/locks", () =>
  jest.requireActual("../test-helpers/locks-testing").locksMockModule(),
);

jest.mock("../common/date-utils", () => ({
  ...jest.requireActual("../common/date-utils"),
  isTransactionInFuture: jest.fn().mockReturnValue(false),
}));

const mockedIsTransactionInFuture =
  isTransactionInFuture as jest.MockedFunction<typeof isTransactionInFuture>;

describe("TransactionReconciliationService", () => {
  let service: TransactionReconciliationService;
  let transactionsRepository: Record<string, jest.Mock>;
  let accountsService: Record<string, jest.Mock>;
  let splitService: Record<string, jest.Mock>;
  let splitsRepository: Record<string, jest.Mock>;
  let userPreferenceRepository: Record<string, jest.Mock>;
  let managerQuery: jest.Mock;
  let dataSource: DataSourceMock;

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

  /**
   * Build a transaction AND stage it as the row the service locks.
   *
   * The service takes an id and re-reads the row inside its own transaction, so
   * a spec has to say what the committed row holds. Doing it here rather than at
   * each call site keeps every existing scenario describing the same thing: the
   * committed row is the one the test built.
   */
  const stageTransaction = (
    overrides: Partial<Transaction> = {},
  ): Transaction => {
    const transaction = makeTransaction(overrides);
    stubLockedTransactions(
      {
        lockTransactionRow: lockTransactionRow as jest.Mock,
        lockTransactionRows: jest.fn(),
      },
      [
        lockedTransactionRow({
          id: transaction.id,
          accountId: transaction.accountId,
          amount: Number(transaction.amount),
          transactionDate: String(transaction.transactionDate),
          status: transaction.status,
          isSplit: transaction.isSplit,
        }),
      ],
    );
    return transaction;
  };

  beforeEach(async () => {
    mockedIsTransactionInFuture.mockReturnValue(false);

    transactionsRepository = {
      update: jest.fn().mockResolvedValue(undefined),
      createQueryBuilder: jest.fn(),
    };

    // The withScopedDb status writes go through the manager's entity-level update;
    // forward them to the repository mock (dropping the entity arg) so the
    // existing two-arg `transactionsRepository.update` assertions still hold.
    // The VOID-crossing guard asks whether the row is a split-transfer
    // counterpart leg; none of these fixtures is, so the lookup finds nothing.
    splitsRepository = { findOne: jest.fn().mockResolvedValue(null) };
    userPreferenceRepository = {
      findOne: jest
        .fn()
        .mockResolvedValue({ userId, lockReconciledTransactions: false }),
    };
    const tenantMocks = createScopedDbMocks([
      [Transaction, transactionsRepository],
      [TransactionSplit, splitsRepository],
      // The strict reconciled lock reads the caller's preference whenever a
      // locked row is RECONCILED. Default: the lock is off, so these tests
      // describe the prompt-and-allow behaviour every existing user has.
      [UserPreference, userPreferenceRepository],
    ]);
    dataSource = tenantMocks.dataSource;
    tenantMocks.manager.update.mockImplementation((_entity, id, payload) =>
      transactionsRepository.update(id, payload),
    );
    // The VOID-crossing guard's second question -- is this row the cash leg of
    // an investment transaction -- is a raw EXISTS through manager.query.
    // Default: no owning investment row.
    managerQuery = tenantMocks.manager.query;
    managerQuery.mockResolvedValue([]);

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

    splitService = {
      // The real method returns the accounts it moved (recheck RR4-003).
      applyParentStatusToTransferCounterparts: jest
        .fn()
        .mockResolvedValue(new Set<string>()),
      // Takes the holdings advisory lock for the parent's embedded investment
      // rows; the real method resolves to nothing.
      lockEmbeddedInvestmentScopes: jest.fn().mockResolvedValue(undefined),
      // The post-commit bond price recompute (INV-BOND-005).
      recomputeBondPricesAfterWrite: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionReconciliationService,
        { provide: AccountsService, useValue: accountsService },
        { provide: TransactionSplitService, useValue: splitService },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    service = module.get<TransactionReconciliationService>(
      TransactionReconciliationService,
    );
  });

  describe("updateStatus", () => {
    it("updates status from UNRECONCILED to CLEARED without balance change", async () => {
      const transaction = stageTransaction({
        status: TransactionStatus.UNRECONCILED,
      });
      const updatedTx = makeTransaction({
        status: TransactionStatus.CLEARED,
      });
      mockFindOne.mockResolvedValue(updatedTx);

      const result = await service.updateStatus(
        userId,
        transaction.id,
        TransactionStatus.CLEARED,
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
      const transaction = stageTransaction({
        status: TransactionStatus.VOID,
        amount: 250,
      });
      const updatedTx = makeTransaction({
        status: TransactionStatus.CLEARED,
        amount: 250,
      });
      mockFindOne.mockResolvedValue(updatedTx);

      await service.updateStatus(
        userId,
        transaction.id,
        TransactionStatus.CLEARED,
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
      const transaction = stageTransaction({
        status: TransactionStatus.CLEARED,
        amount: 300,
      });
      const updatedTx = makeTransaction({
        status: TransactionStatus.VOID,
        amount: 300,
      });
      mockFindOne.mockResolvedValue(updatedTx);

      await service.updateStatus(
        userId,
        transaction.id,
        TransactionStatus.VOID,
        mockTriggerNetWorthRecalc,
        mockFindOne,
      );

      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        accountId,
        -300,
      );
      expect(mockTriggerNetWorthRecalc).toHaveBeenCalledWith(accountId, userId);
    });

    it("carries a VOID across to the mirror transfer leg with its own balance (P5-001)", async () => {
      // PATCH /transactions/:id/status was the one door left into the
      // divergent-pair state every other route refuses: voiding one leg
      // restored its account and left the counterpart ACTIVE holding the
      // money. The mirror leg crosses the boundary with it, adjusted by its
      // OWN amount, read under its own lock.
      stubLockedTransactions(
        {
          lockTransactionRow: lockTransactionRow as jest.Mock,
          lockTransactionRows: jest.fn(),
        },
        [
          lockedTransactionRow({
            id: "leg-1",
            accountId,
            amount: -100,
            transactionDate: "2026-01-15",
            status: TransactionStatus.CLEARED,
            isSplit: false,
            linkedTransactionId: "leg-2",
          }),
          lockedTransactionRow({
            id: "leg-2",
            accountId: "account-2",
            amount: 100,
            transactionDate: "2026-01-15",
            status: TransactionStatus.CLEARED,
            isSplit: false,
            linkedTransactionId: "leg-1",
          }),
        ],
      );
      mockFindOne.mockResolvedValue(
        makeTransaction({ status: TransactionStatus.VOID }),
      );

      await service.updateStatus(
        userId,
        "leg-1",
        TransactionStatus.VOID,
        mockTriggerNetWorthRecalc,
        mockFindOne,
      );

      expect(transactionsRepository.update).toHaveBeenCalledWith("leg-2", {
        status: TransactionStatus.VOID,
      });
      // Own leg reversed by its own -100; the counterpart by its own +100.
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        accountId,
        100,
      );
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "account-2",
        -100,
      );
      expect(mockTriggerNetWorthRecalc).toHaveBeenCalledWith(
        "account-2",
        userId,
      );
    });

    it("refuses to void a split-transfer counterpart leg on its own", async () => {
      // The pairing belongs to the split parent, which has a propagation path;
      // voiding the leg alone leaves the parent's split row recording money
      // that never arrived. Same refusal as updateSplitTransferLeg's.
      const transaction = stageTransaction({
        status: TransactionStatus.CLEARED,
        amount: 100,
      });
      splitsRepository.findOne.mockResolvedValue({ id: "split-1" });

      await expect(
        service.updateStatus(
          userId,
          transaction.id,
          TransactionStatus.VOID,
          mockTriggerNetWorthRecalc,
          mockFindOne,
        ),
      ).rejects.toThrow(/split transaction/);

      expect(accountsService.updateBalance).not.toHaveBeenCalled();
      expect(transactionsRepository.update).not.toHaveBeenCalled();
    });

    it("refuses to void an investment cash leg on its own", async () => {
      // The investment row owns the pair's VOID boundary
      // (InvestmentTransactionsService.updateStatus is the propagation path);
      // voiding the cash leg alone would leave the trade's shares counted
      // while its cash claims not to have moved.
      const transaction = stageTransaction({
        status: TransactionStatus.CLEARED,
        amount: -1509.99,
      });
      managerQuery.mockImplementation(async (sql: string) =>
        String(sql).includes("investment_transactions")
          ? [{ id: "inv-tx-1" }]
          : [],
      );

      await expect(
        service.updateStatus(
          userId,
          transaction.id,
          TransactionStatus.VOID,
          mockTriggerNetWorthRecalc,
          mockFindOne,
        ),
      ).rejects.toThrow(/investment transaction/);

      // Refusal precedes the write: nothing stored, no balance moved.
      expect(transactionsRepository.update).not.toHaveBeenCalled();
      expect(accountsService.updateBalance).not.toHaveBeenCalled();
    });

    it("allows reconciliation cycling on an investment cash leg (guard only fires on crossings)", async () => {
      // The cash sleeve is reconciled against a bank statement independently
      // of the brokerage, so CLEARED -> RECONCILED stays per-ledger even
      // though the row IS an investment cash leg.
      const transaction = stageTransaction({
        status: TransactionStatus.CLEARED,
        amount: -1509.99,
      });
      managerQuery.mockImplementation(async (sql: string) =>
        String(sql).includes("investment_transactions")
          ? [{ id: "inv-tx-1" }]
          : [],
      );
      mockFindOne.mockResolvedValue(
        makeTransaction({ status: TransactionStatus.RECONCILED }),
      );

      await service.updateStatus(
        userId,
        transaction.id,
        TransactionStatus.RECONCILED,
        mockTriggerNetWorthRecalc,
        mockFindOne,
      );

      expect(transactionsRepository.update).toHaveBeenCalledWith(
        "tx-1",
        expect.objectContaining({ status: TransactionStatus.RECONCILED }),
      );
      expect(accountsService.updateBalance).not.toHaveBeenCalled();
    });

    it("propagates a VOID on a split parent to its children's counterparts (FR-002)", async () => {
      const transaction = stageTransaction({
        status: TransactionStatus.CLEARED,
        amount: 100,
        isSplit: true,
      });
      mockFindOne.mockResolvedValue(
        makeTransaction({ status: TransactionStatus.VOID, isSplit: true }),
      );

      splitService.applyParentStatusToTransferCounterparts.mockImplementationOnce(
        async (
          _m: unknown,
          _id: string,
          _u: string,
          _s: unknown,
          touched: Set<string>,
        ) => {
          touched.add("sec-1");
          return new Set<string>();
        },
      );

      await service.updateStatus(
        userId,
        transaction.id,
        TransactionStatus.VOID,
        mockTriggerNetWorthRecalc,
        mockFindOne,
      );

      expect(
        splitService.applyParentStatusToTransferCounterparts,
      ).toHaveBeenCalledWith(
        expect.anything(),
        transaction.id,
        userId,
        TransactionStatus.VOID,
        expect.any(Set),
      );
      // Dispatched after the commit, with the securities the pass reported
      // (INV-BOND-005, INV-CACHE-001).
      expect(splitService.recomputeBondPricesAfterWrite).toHaveBeenCalledWith(
        userId,
        new Set(["sec-1"]),
      );
    });

    /**
     * Advisory locks are taken before row locks (`common/db/locks.ts`). The
     * parent's embedded investment rows are rebuilt under the holdings
     * advisory lock, and this path took it only there -- after the parent's
     * balance write had row-locked `accounts`, the opposite order from an
     * investment write (40P01).
     *
     * The `lockTransactionRow` half is the second round of the same defect:
     * moving the advisory lock above the balance write but below the parent's
     * own `FOR UPDATE` still leaves it after a row lock, and
     * `InvestmentTransactionsService.update()` takes the advisory lock first
     * and then row-locks the very same parent -- advisory A vs. row P against
     * row P vs. advisory A, which is 40P01 for both.
     */
    it("locks the embedded investment scopes before the parent's row lock and balance write", async () => {
      const transaction = stageTransaction({
        status: TransactionStatus.CLEARED,
        amount: 100,
        isSplit: true,
      });
      mockFindOne.mockResolvedValue(
        makeTransaction({ status: TransactionStatus.VOID, isSplit: true }),
      );

      // The module mock is shared across this file's tests, so its recorded
      // invocation order carries earlier cases' calls; the ordering assertion
      // below is about this run only.
      (lockTransactionRow as jest.Mock).mockClear();

      await service.updateStatus(
        userId,
        transaction.id,
        TransactionStatus.VOID,
        mockTriggerNetWorthRecalc,
        mockFindOne,
      );

      expect(splitService.lockEmbeddedInvestmentScopes).toHaveBeenCalledWith(
        expect.anything(),
        userId,
        [transaction.id],
      );
      expect(accountsService.updateBalance).toHaveBeenCalled();
      expect(
        splitService.lockEmbeddedInvestmentScopes.mock.invocationCallOrder[0],
      ).toBeLessThan(accountsService.updateBalance.mock.invocationCallOrder[0]);
      expect(lockTransactionRow).toHaveBeenCalled();
      expect(
        splitService.lockEmbeddedInvestmentScopes.mock.invocationCallOrder[0],
      ).toBeLessThan(
        (lockTransactionRow as jest.Mock).mock.invocationCallOrder[0],
      );
    });

    it("does not change balance when staying VOID", async () => {
      const transaction = stageTransaction({
        status: TransactionStatus.VOID,
      });
      mockFindOne.mockResolvedValue(
        makeTransaction({ status: TransactionStatus.VOID }),
      );

      await service.updateStatus(
        userId,
        transaction.id,
        TransactionStatus.VOID,
        mockTriggerNetWorthRecalc,
        mockFindOne,
      );

      expect(accountsService.updateBalance).not.toHaveBeenCalled();
      expect(mockTriggerNetWorthRecalc).not.toHaveBeenCalled();
    });

    it("does not trigger net worth recalc when VOID status does not change", async () => {
      const transaction = stageTransaction({
        status: TransactionStatus.UNRECONCILED,
      });
      mockFindOne.mockResolvedValue(
        makeTransaction({ status: TransactionStatus.CLEARED }),
      );

      await service.updateStatus(
        userId,
        transaction.id,
        TransactionStatus.CLEARED,
        mockTriggerNetWorthRecalc,
        mockFindOne,
      );

      expect(mockTriggerNetWorthRecalc).not.toHaveBeenCalled();
    });

    it("sets reconciledDate when transitioning to RECONCILED", async () => {
      const now = new Date(2026, 1, 10);
      jest.useFakeTimers({ now });

      const transaction = stageTransaction({
        status: TransactionStatus.CLEARED,
      });
      mockFindOne.mockResolvedValue(
        makeTransaction({ status: TransactionStatus.RECONCILED }),
      );

      await service.updateStatus(
        userId,
        transaction.id,
        TransactionStatus.RECONCILED,
        mockTriggerNetWorthRecalc,
        mockFindOne,
      );

      // One UPDATE, not two: the status and the reconciled date are the same
      // transition, applied together under the row lock.
      expect(transactionsRepository.update).toHaveBeenCalledWith("tx-1", {
        status: TransactionStatus.RECONCILED,
        reconciledDate: "2026-02-10",
      });

      jest.useRealTimers();
    });

    it("does not set reconciledDate when already RECONCILED", async () => {
      const transaction = stageTransaction({
        status: TransactionStatus.RECONCILED,
        reconciledDate: "2026-01-01",
      });
      mockFindOne.mockResolvedValue(transaction);

      await service.updateStatus(
        userId,
        transaction.id,
        TransactionStatus.RECONCILED,
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
      const transaction = stageTransaction({
        status: TransactionStatus.UNRECONCILED,
      });
      mockFindOne.mockResolvedValue(
        makeTransaction({ status: TransactionStatus.VOID }),
      );

      await service.updateStatus(
        userId,
        transaction.id,
        TransactionStatus.VOID,
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
      const transaction = stageTransaction({
        status: TransactionStatus.UNRECONCILED,
        amount: -75.5,
      });
      mockFindOne.mockResolvedValue(
        makeTransaction({ status: TransactionStatus.VOID, amount: -75.5 }),
      );

      await service.updateStatus(
        userId,
        transaction.id,
        TransactionStatus.VOID,
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

      const transaction = stageTransaction();
      const result = await service.updateStatus(
        userId,
        transaction.id,
        TransactionStatus.CLEARED,
        mockTriggerNetWorthRecalc,
        mockFindOne,
      );

      expect(result).toBe(updatedTx);
    });

    it("commits the status change and balance update in a single transaction", async () => {
      const transaction = stageTransaction({
        status: TransactionStatus.VOID,
        amount: 250,
      });
      mockFindOne.mockResolvedValue(
        makeTransaction({ status: TransactionStatus.CLEARED, amount: 250 }),
      );

      await service.updateStatus(
        userId,
        transaction.id,
        TransactionStatus.CLEARED,
        mockTriggerNetWorthRecalc,
        mockFindOne,
      );

      // A single withScopedDb groups the status write and the balance update.
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    });

    it("rolls back and does not commit when the balance update fails", async () => {
      const transaction = stageTransaction({
        status: TransactionStatus.VOID,
        amount: 250,
      });
      accountsService.updateBalance.mockRejectedValueOnce(
        new Error("balance update failed"),
      );

      await expect(
        service.updateStatus(
          userId,
          transaction.id,
          TransactionStatus.CLEARED,
          mockTriggerNetWorthRecalc,
          mockFindOne,
        ),
      ).rejects.toThrow("balance update failed");

      // Net worth recalc and the final read must not run on a failed write
      expect(mockTriggerNetWorthRecalc).not.toHaveBeenCalled();
      expect(mockFindOne).not.toHaveBeenCalled();
    });
  });

  describe("markCleared", () => {
    it("marks an UNRECONCILED transaction as CLEARED", async () => {
      const transaction = stageTransaction({
        status: TransactionStatus.UNRECONCILED,
      });
      const updatedTx = makeTransaction({
        status: TransactionStatus.CLEARED,
      });
      mockFindOne.mockResolvedValue(updatedTx);

      const result = await service.markCleared(
        userId,
        transaction.id,
        true,
        mockTriggerNetWorthRecalc,
        mockFindOne,
      );

      expect(transactionsRepository.update).toHaveBeenCalledWith("tx-1", {
        status: TransactionStatus.CLEARED,
      });
      expect(result).toEqual(updatedTx);
    });

    it("marks a CLEARED transaction as UNRECONCILED when isCleared is false", async () => {
      const transaction = stageTransaction({
        status: TransactionStatus.CLEARED,
      });
      const updatedTx = makeTransaction({
        status: TransactionStatus.UNRECONCILED,
      });
      mockFindOne.mockResolvedValue(updatedTx);

      const result = await service.markCleared(
        userId,
        transaction.id,
        false,
        mockTriggerNetWorthRecalc,
        mockFindOne,
      );

      expect(transactionsRepository.update).toHaveBeenCalledWith("tx-1", {
        status: TransactionStatus.UNRECONCILED,
      });
      expect(result).toEqual(updatedTx);
    });

    it("throws when transaction is RECONCILED", async () => {
      const transaction = stageTransaction({
        status: TransactionStatus.RECONCILED,
      });

      await expect(
        service.markCleared(
          userId,
          transaction.id,
          true,
          mockTriggerNetWorthRecalc,
          mockFindOne,
        ),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.markCleared(
          userId,
          transaction.id,
          true,
          mockTriggerNetWorthRecalc,
          mockFindOne,
        ),
      ).rejects.toThrow(
        "Cannot change cleared status of reconciled or void transactions",
      );
    });

    it("throws when transaction is VOID", async () => {
      const transaction = stageTransaction({
        status: TransactionStatus.VOID,
      });

      await expect(
        service.markCleared(
          userId,
          transaction.id,
          false,
          mockTriggerNetWorthRecalc,
          mockFindOne,
        ),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.markCleared(
          userId,
          transaction.id,
          false,
          mockTriggerNetWorthRecalc,
          mockFindOne,
        ),
      ).rejects.toThrow(
        "Cannot change cleared status of reconciled or void transactions",
      );
    });

    it("does not call updateStatus when validation fails", async () => {
      const transaction = stageTransaction({
        status: TransactionStatus.RECONCILED,
      });

      await expect(
        service.markCleared(
          userId,
          transaction.id,
          true,
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

      const transaction = stageTransaction({
        status: TransactionStatus.UNRECONCILED,
      });
      const updatedTx = makeTransaction({
        status: TransactionStatus.RECONCILED,
        reconciledDate: "2026-01-20",
      });
      mockFindOne.mockResolvedValue(updatedTx);

      const result = await service.reconcile(
        userId,
        transaction.id,
        mockTriggerNetWorthRecalc,
        mockFindOne,
      );

      // One UPDATE, not two: the status and the reconciled date are the same
      // transition, applied together under the row lock.
      expect(transactionsRepository.update).toHaveBeenCalledWith("tx-1", {
        status: TransactionStatus.RECONCILED,
        reconciledDate: "2026-01-20",
      });
      expect(result).toEqual(updatedTx);

      jest.useRealTimers();
    });

    it("reconciles a CLEARED transaction", async () => {
      jest.useFakeTimers({ now: new Date(2026, 0, 20) });

      const transaction = stageTransaction({
        status: TransactionStatus.CLEARED,
      });
      const updatedTx = makeTransaction({
        status: TransactionStatus.RECONCILED,
      });
      mockFindOne.mockResolvedValue(updatedTx);

      const result = await service.reconcile(
        userId,
        transaction.id,
        mockTriggerNetWorthRecalc,
        mockFindOne,
      );

      // One UPDATE, not two: the status and the reconciled date are the same
      // transition, applied together under the row lock.
      expect(transactionsRepository.update).toHaveBeenCalledWith("tx-1", {
        status: TransactionStatus.RECONCILED,
        reconciledDate: "2026-01-20",
      });
      expect(result).toEqual(updatedTx);

      jest.useRealTimers();
    });

    it("throws when transaction is already RECONCILED", async () => {
      const transaction = stageTransaction({
        status: TransactionStatus.RECONCILED,
      });

      await expect(
        service.reconcile(
          userId,
          transaction.id,
          mockTriggerNetWorthRecalc,
          mockFindOne,
        ),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.reconcile(
          userId,
          transaction.id,
          mockTriggerNetWorthRecalc,
          mockFindOne,
        ),
      ).rejects.toThrow("Transaction is already reconciled");
    });

    it("throws when transaction is VOID", async () => {
      const transaction = stageTransaction({
        status: TransactionStatus.VOID,
      });

      await expect(
        service.reconcile(
          userId,
          transaction.id,
          mockTriggerNetWorthRecalc,
          mockFindOne,
        ),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.reconcile(
          userId,
          transaction.id,
          mockTriggerNetWorthRecalc,
          mockFindOne,
        ),
      ).rejects.toThrow("Cannot reconcile a void transaction");
    });

    it("does not call repository when validation fails", async () => {
      const transaction = stageTransaction({
        status: TransactionStatus.RECONCILED,
      });

      await expect(
        service.reconcile(
          userId,
          transaction.id,
          mockTriggerNetWorthRecalc,
          mockFindOne,
        ),
      ).rejects.toThrow(BadRequestException);

      expect(transactionsRepository.update).not.toHaveBeenCalled();
    });
  });

  describe("the strict reconciled lock", () => {
    const lockOn = () =>
      userPreferenceRepository.findOne.mockResolvedValue({
        userId,
        lockReconciledTransactions: true,
      });

    it("refuses to unreconcile a reconciled row while the lock is on", async () => {
      // Unreconciling is the click a user reaching for "edit anyway" finds
      // first. Leaving it open would make the lock one extra step rather than
      // a lock, so it is refused alongside edits and deletes and the way
      // through is the Settings toggle.
      lockOn();
      const transaction = stageTransaction({
        status: TransactionStatus.RECONCILED,
        reconciledDate: "2026-01-15",
      });

      await expect(
        service.unreconcile(userId, transaction.id, mockFindOne),
      ).rejects.toThrow(ConflictException);
    });

    it("writes nothing when it refuses", async () => {
      // A refusal that had already written would be the exact failure
      // docs/financial-calculation-contract.md section 7 names: an error on
      // screen beside the change in the database.
      lockOn();
      const transaction = stageTransaction({
        status: TransactionStatus.RECONCILED,
        reconciledDate: "2026-01-15",
      });

      await expect(
        service.unreconcile(userId, transaction.id, mockFindOne),
      ).rejects.toThrow(ConflictException);
      expect(transactionsRepository.update).not.toHaveBeenCalled();
      expect(accountsService.updateBalance).not.toHaveBeenCalled();
    });

    it("leaves a row that is not reconciled alone", async () => {
      // The lock is about reconciled rows. Clearing an unreconciled one is
      // ordinary work and must not be caught by it.
      lockOn();
      const transaction = stageTransaction({
        status: TransactionStatus.UNRECONCILED,
      });
      mockFindOne.mockResolvedValue(
        makeTransaction({ status: TransactionStatus.CLEARED }),
      );

      await expect(
        service.markCleared(
          userId,
          transaction.id,
          true,
          mockTriggerNetWorthRecalc,
          mockFindOne,
        ),
      ).resolves.toBeDefined();
      expect(transactionsRepository.update).toHaveBeenCalledWith("tx-1", {
        status: TransactionStatus.CLEARED,
      });
    });

    /**
     * The undo window: with the lock on, the row the user reconciled seconds
     * ago can still be taken back -- and only taken back.
     *
     * The freshness question is asked of the database, so a spec says what the
     * database answers. The default (`[]`) is a row older than the window,
     * which is what every case above describes.
     */
    const undoWindow = (open: boolean) =>
      managerQuery.mockImplementation(async (sql: string) =>
        sql.includes("within_undo_window")
          ? [{ within_undo_window: open }]
          : [],
      );

    it("allows the undo of a reconcile made moments ago", async () => {
      // The click that made it reconciled is not settled history, and with the
      // lock on the very next click used to be refused -- so a misclick on the
      // register's status cell was permanent and the way out was disabling the
      // lock for the whole ledger.
      lockOn();
      undoWindow(true);
      const transaction = stageTransaction({
        status: TransactionStatus.RECONCILED,
        reconciledDate: "2026-01-15",
      });
      mockFindOne.mockResolvedValue(
        makeTransaction({ status: TransactionStatus.UNRECONCILED }),
      );

      await expect(
        service.updateStatus(
          userId,
          transaction.id,
          TransactionStatus.UNRECONCILED,
          mockTriggerNetWorthRecalc,
          mockFindOne,
        ),
      ).resolves.toBeDefined();
      // The status cycle writes the status alone; `reconciled_date` is cleared
      // by the `unreconcile` endpoint (below) rather than by this path, which
      // is how it behaves for a user with the lock off too.
      expect(transactionsRepository.update).toHaveBeenCalledWith("tx-1", {
        status: TransactionStatus.UNRECONCILED,
      });
    });

    // `unreconcile` lands on CLEARED rather than UNRECONCILED. Both are the way
    // back off a reconciled row, so the window takes both.
    it("allows the unreconcile endpoint inside the window too", async () => {
      lockOn();
      undoWindow(true);
      const transaction = stageTransaction({
        status: TransactionStatus.RECONCILED,
        reconciledDate: "2026-01-15",
      });
      mockFindOne.mockResolvedValue(
        makeTransaction({
          status: TransactionStatus.CLEARED,
          reconciledDate: null,
        }),
      );

      await expect(
        service.unreconcile(userId, transaction.id, mockFindOne),
      ).resolves.toBeDefined();
    });

    it("refuses the same undo once the window has closed", async () => {
      lockOn();
      undoWindow(false);
      const transaction = stageTransaction({
        status: TransactionStatus.RECONCILED,
        reconciledDate: "2026-01-15",
      });

      await expect(
        service.updateStatus(
          userId,
          transaction.id,
          TransactionStatus.UNRECONCILED,
          mockTriggerNetWorthRecalc,
          mockFindOne,
        ),
      ).rejects.toThrow(ConflictException);
      expect(transactionsRepository.update).not.toHaveBeenCalled();
    });

    // The window exists so a misclick can be taken back. Voiding moves money,
    // so it stays refused -- otherwise the window is a ten-second door into
    // every alteration the lock is there to prevent.
    it("refuses a void inside the window, and writes nothing", async () => {
      lockOn();
      undoWindow(true);
      const transaction = stageTransaction({
        status: TransactionStatus.RECONCILED,
        reconciledDate: "2026-01-15",
      });

      await expect(
        service.updateStatus(
          userId,
          transaction.id,
          TransactionStatus.VOID,
          mockTriggerNetWorthRecalc,
          mockFindOne,
        ),
      ).rejects.toThrow(ConflictException);
      expect(transactionsRepository.update).not.toHaveBeenCalled();
      expect(accountsService.updateBalance).not.toHaveBeenCalled();
    });

    it("does not ask about the window when the lock is off", async () => {
      undoWindow(true);
      const transaction = stageTransaction({
        status: TransactionStatus.RECONCILED,
        reconciledDate: "2026-01-15",
      });
      mockFindOne.mockResolvedValue(
        makeTransaction({ status: TransactionStatus.UNRECONCILED }),
      );

      await service.updateStatus(
        userId,
        transaction.id,
        TransactionStatus.UNRECONCILED,
        mockTriggerNetWorthRecalc,
        mockFindOne,
      );
      expect(
        managerQuery.mock.calls.filter(([sql]: [string]) =>
          sql.includes("within_undo_window"),
        ),
      ).toHaveLength(0);
    });

    it("does not ask about the window for a row that is not reconciled", async () => {
      lockOn();
      undoWindow(true);
      const transaction = stageTransaction({
        status: TransactionStatus.CLEARED,
      });
      mockFindOne.mockResolvedValue(
        makeTransaction({ status: TransactionStatus.UNRECONCILED }),
      );

      await service.updateStatus(
        userId,
        transaction.id,
        TransactionStatus.UNRECONCILED,
        mockTriggerNetWorthRecalc,
        mockFindOne,
      );
      expect(
        managerQuery.mock.calls.filter(([sql]: [string]) =>
          sql.includes("within_undo_window"),
        ),
      ).toHaveLength(0);
    });

    it("allows the same unreconcile with the lock off", async () => {
      const transaction = stageTransaction({
        status: TransactionStatus.RECONCILED,
        reconciledDate: "2026-01-15",
      });
      mockFindOne.mockResolvedValue(
        makeTransaction({
          status: TransactionStatus.CLEARED,
          reconciledDate: null,
        }),
      );

      await expect(
        service.unreconcile(userId, transaction.id, mockFindOne),
      ).resolves.toBeDefined();
    });
  });

  describe("unreconcile", () => {
    it("sets status to CLEARED and clears reconciledDate", async () => {
      const transaction = stageTransaction({
        status: TransactionStatus.RECONCILED,
        reconciledDate: "2026-01-15",
      });
      const updatedTx = makeTransaction({
        status: TransactionStatus.CLEARED,
        reconciledDate: null,
      });
      mockFindOne.mockResolvedValue(updatedTx);

      const result = await service.unreconcile(
        userId,
        transaction.id,
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
      const transaction = stageTransaction({
        status: TransactionStatus.UNRECONCILED,
      });

      await expect(
        service.unreconcile(userId, transaction.id, mockFindOne),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.unreconcile(userId, transaction.id, mockFindOne),
      ).rejects.toThrow("Transaction is not reconciled");
    });

    it("throws when transaction is not RECONCILED (CLEARED)", async () => {
      const transaction = stageTransaction({
        status: TransactionStatus.CLEARED,
      });

      await expect(
        service.unreconcile(userId, transaction.id, mockFindOne),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.unreconcile(userId, transaction.id, mockFindOne),
      ).rejects.toThrow("Transaction is not reconciled");
    });

    it("throws when transaction is not RECONCILED (VOID)", async () => {
      const transaction = stageTransaction({
        status: TransactionStatus.VOID,
      });

      await expect(
        service.unreconcile(userId, transaction.id, mockFindOne),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.unreconcile(userId, transaction.id, mockFindOne),
      ).rejects.toThrow("Transaction is not reconciled");
    });

    it("does not call repository when validation fails", async () => {
      const transaction = stageTransaction({
        status: TransactionStatus.CLEARED,
      });

      await expect(
        service.unreconcile(userId, transaction.id, mockFindOne),
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

    it("reads the last reconciled date through RECONCILED_THROUGH_SQL, capped at each row's statement", async () => {
      managerQuery.mockResolvedValue([{ last_reconciled_date: "2026-02-15" }]);

      const result = await service.getReconciliationData(
        userId,
        accountId,
        "2026-02-28",
        500,
      );

      expect(result.lastReconciledDate).toBe("2026-02-15");
      const sql: string = managerQuery.mock.calls[0][0];
      expect(sql).toContain(`MAX(${RECONCILED_THROUGH_SQL})`);
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

  describe("getStaleUnreconciled", () => {
    it("measures missed rows from RECONCILED_THROUGH_SQL, not the newest reconciled row's own date", async () => {
      managerQuery.mockResolvedValue([
        {
          account_id: accountId,
          account_name: "Checking",
          currency_code: "USD",
          count: "3",
          oldest_date: "2026-01-02",
          last_reconciled_date: "2026-02-15",
          missed_count: "1",
        },
      ]);

      const result = await service.getStaleUnreconciled(userId);

      const sql: string = managerQuery.mock.calls[0][0];
      expect(sql).toContain(
        `MAX(${RECONCILED_THROUGH_SQL}) AS last_reconciled_date`,
      );
      expect(sql).not.toContain("MAX(transaction_date)");
      expect(result.accounts).toEqual([
        expect.objectContaining({
          lastReconciledDate: "2026-02-15",
          count: 3,
          missedCount: 1,
          overdueCount: 2,
        }),
      ]);
      expect(result.totalCount).toBe(3);
    });
  });

  describe("compare-and-set against the committed status", () => {
    /**
     * The regression guard for the class of bug the id-taking signature exists to
     * prevent. Each of these hands the service a scenario where the caller's view
     * of the status is stale, and asserts the *committed* status decides.
     */
    it("refuses to unreconcile a row another request has voided", async () => {
      // Caller believed RECONCILED; the committed row is VOID. Before the locked
      // re-read, `wasVoid` came from the snapshot and said false, so no balance
      // adjustment ran -- while the status went VOID -> CLEARED, putting the
      // amount back in the ledger with nothing putting it back in the balance.
      stageTransaction({ status: TransactionStatus.VOID, amount: 250 });

      await expect(
        service.unreconcile(userId, "tx-1", mockFindOne),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(transactionsRepository.update).not.toHaveBeenCalled();
      expect(accountsService.updateBalance).not.toHaveBeenCalled();
    });

    it("refuses to change cleared status on a row another request has voided", async () => {
      stageTransaction({ status: TransactionStatus.VOID, amount: 250 });

      await expect(
        service.markCleared(
          userId,
          "tx-1",
          true,
          mockTriggerNetWorthRecalc,
          mockFindOne,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(transactionsRepository.update).not.toHaveBeenCalled();
      expect(accountsService.updateBalance).not.toHaveBeenCalled();
    });

    it("derives the un-void balance delta from the locked row's amount", async () => {
      // The amount that goes back into the balance is the committed one, not one
      // the caller read before another request edited it.
      stageTransaction({ status: TransactionStatus.VOID, amount: 250 });
      mockFindOne.mockResolvedValue(makeTransaction());

      await service.updateStatus(
        userId,
        "tx-1",
        TransactionStatus.CLEARED,
        mockTriggerNetWorthRecalc,
        mockFindOne,
      );

      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        accountId,
        250,
      );
    });

    it("throws NotFound when the row is gone by the time it is locked", async () => {
      stubLockedTransactions(
        {
          lockTransactionRow: lockTransactionRow as jest.Mock,
          lockTransactionRows: jest.fn(),
        },
        [],
      );

      await expect(
        service.updateStatus(
          userId,
          "tx-1",
          TransactionStatus.CLEARED,
          mockTriggerNetWorthRecalc,
          mockFindOne,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
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
        // The VOID exclusion is a refusal, so the rows are locked in ascending
        // id order and re-checked against the status this statement is about to
        // overwrite.
        orderBy: jest.fn().mockReturnThis(),
        setLock: jest.fn().mockReturnThis(),
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

      const transaction = stageTransaction({
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
        userId,
        transaction.id,
        TransactionStatus.VOID,
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

      const transaction = stageTransaction({
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
        userId,
        transaction.id,
        TransactionStatus.CLEARED,
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

      const transaction = stageTransaction({
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
        userId,
        transaction.id,
        TransactionStatus.VOID,
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
