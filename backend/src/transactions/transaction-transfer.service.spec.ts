import { Test, TestingModule } from "@nestjs/testing";
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { DataSource } from "typeorm";
import { TransactionTransferService } from "./transaction-transfer.service";
import { Transaction, TransactionStatus } from "./entities/transaction.entity";
import { TransactionSplit } from "./entities/transaction-split.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { Category } from "../categories/entities/category.entity";
import { AccountsService } from "../accounts/accounts.service";
import { PayeesService } from "../payees/payees.service";
import { NetWorthService } from "../net-worth/net-worth.service";
import { ActionHistoryService } from "../action-history/action-history.service";
import { CrossOwnerAccessService } from "../delegation/cross-owner-access.service";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import { RuleConditionLeaf } from "../transaction-rules/rule-condition.types";
import { TransactionRulesApplierService } from "../transaction-rules/transaction-rules-applier.service";
import {
  PlannableRule,
  planRuleEffects,
} from "../transaction-rules/rule-effects";
import {
  buildRuleFacts,
  RuleFactsInput,
} from "../transaction-rules/rule-facts";
import { isTransactionInFuture } from "../common/date-utils";
import { withSystemContext } from "../common/db/with-context";
import {
  createScopedDbMocks,
  DataSourceMock,
} from "../test-helpers/scoped-db-testing";
import { ConflictException } from "@nestjs/common";
import { lockTransactionRow, lockTransactionRows } from "../common/db/locks";
import type { LockedTransactionRow } from "../common/db/locks";
import { lockedTransactionRow } from "../test-helpers/locks-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

// Passthrough spy: cross-owner writes must enter the audited system context;
// same-owner writes must not.
jest.mock("../common/db/with-context", () => {
  const actual = jest.requireActual("../common/db/with-context");
  return { ...actual, withSystemContext: jest.fn(actual.withSystemContext) };
});

const mockedWithSystemContext = withSystemContext as jest.MockedFunction<
  typeof withSystemContext
>;

// Both legs are locked inside the write transaction and the update refuses if
// either changed under it (audit P4-003). The double below derives the locked
// legs from the rows this spec's `findOne` callback has returned, so a spec only
// states the committed rows when it means them to differ.
jest.mock("../common/db/locks", () =>
  jest.requireActual("../test-helpers/locks-testing").locksMockModule(),
);

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
  let userPreferenceRepository: Record<string, jest.Mock>;
  let accountsService: Record<string, jest.Mock>;
  let payeesService: Record<string, jest.Mock>;
  let netWorthService: Record<string, jest.Mock>;
  // The withScopedDb EntityManager, under the legacy `mockQueryRunner.manager`
  // shape so the pre-RLS manager assertions still read naturally.
  let mockQueryRunner: Record<string, any>;
  let exchangeRateService: Record<string, jest.Mock>;
  let rulesApplier: Record<string, jest.Mock>;
  let mockDataSource: DataSourceMock;

  const mockFindOne = jest.fn();
  let crossOwnerAccess: Record<string, jest.Mock>;
  let actionHistoryService: Record<string, jest.Mock>;

  const mockFromAccount = {
    id: "from-account",
    name: "Checking",
    currencyCode: "USD",
    userId: "user-1",
  };

  const mockToAccount = {
    id: "to-account",
    name: "Savings",
    currencyCode: "USD",
    userId: "user-1",
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

    userPreferenceRepository = {
      findOne: jest.fn().mockResolvedValue({
        userId: "user-1",
        lockReconciledTransactions: false,
      }),
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

    // Default: both accounts owned by user-1, mirroring the old owner-scoped
    // findOne. Cross-owner tests override per account id.
    crossOwnerAccess = {
      // The in-transaction re-check (A26-M04): the grant still held.
      assertAccessStillHeld: jest.fn().mockResolvedValue(undefined),
      accountAccessFor: jest
        .fn()
        .mockImplementation(async (realUserId: string, accountId: string) => {
          const account =
            accountId === "from-account"
              ? mockFromAccount
              : accountId === "to-account"
                ? mockToAccount
                : {
                    id: accountId,
                    name: "Unknown",
                    currencyCode: "USD",
                    userId: "user-1",
                  };
          return {
            account,
            ownerUserId: account.userId,
            via: account.userId === realUserId ? "own" : "delegation",
          };
        }),
    };

    actionHistoryService = { record: jest.fn().mockResolvedValue(null) };

    mockedWithSystemContext.mockClear();
    mockFindOne.mockReset();

    /**
     * Serve the locked leg readers from whatever this spec's `findOne` callback
     * has returned.
     *
     * Reading the mock's recorded results consumes nothing, unlike calling it
     * again and eating a queued `mockResolvedValueOnce`. A spec that wants the
     * committed legs to differ from the caller's view -- the concurrency case
     * `updateTransfer` now refuses -- overrides `lockTransactionRows` itself.
     */
    const resolveLocked = async (
      ids: readonly string[],
    ): Promise<Map<string, LockedTransactionRow>> => {
      const byId = new Map<string, Record<string, unknown>>();
      // The own leg comes back through the caller's `findOne`; the counterpart
      // through the repository. Both are rows this spec described.
      for (const mock of [
        mockFindOne.mock,
        transactionsRepository.findOne.mock,
      ]) {
        for (const result of mock.results) {
          if (result.type !== "return") continue;
          try {
            const row = (await result.value) as Record<string, unknown> | null;
            if (row?.id) byId.set(String(row.id), row);
          } catch {
            continue;
          }
        }
      }
      // The lock replaced the counterpart read, so on some paths nothing has
      // been read yet. Consulting the repository mock now is exactly right:
      // whatever the spec set up IS the committed counterpart.
      for (const id of ids) {
        if (byId.has(id)) continue;
        const row = (await transactionsRepository.findOne({
          where: { id },
        })) as Record<string, unknown> | null;
        if (row?.id) byId.set(String(row.id), row);
      }
      const found = new Map<string, LockedTransactionRow>();
      for (const id of ids) {
        const row = byId.get(id);
        if (!row) continue;
        found.set(
          id,
          lockedTransactionRow({
            id: String(row.id),
            accountId: String(row.accountId ?? ""),
            amount: Number(row.amount ?? 0),
            transactionDate: row.transactionDate as string,
            status: (row.status as string | null) ?? null,
            isSplit: Boolean(row.isSplit),
            linkedTransactionId:
              (row.linkedTransactionId as string | null) ?? null,
          }),
        );
      }
      return found;
    };

    (lockTransactionRows as jest.Mock).mockImplementation(
      async (_m: unknown, ids: readonly string[]) => resolveLocked(ids),
    );
    // The cross-owner removal locks each leg on its own, because the two legs
    // have different owners and the ownership predicate differs per row.
    (lockTransactionRow as jest.Mock).mockImplementation(
      async (_m: unknown, id: string) =>
        (await resolveLocked([id])).get(id) ?? null,
    );

    const tenantMocks = createScopedDbMocks([
      [Transaction, transactionsRepository],
      [TransactionSplit, splitsRepository],
      [Category, categoriesRepository],
      // The strict reconciled lock reads the caller's preference when either
      // locked leg is RECONCILED. Default: off, which is what every existing
      // user has and what these per-leg reconciliation tests describe.
      [UserPreference, userPreferenceRepository],
    ]);
    mockDataSource = tenantMocks.dataSource;

    const manager = tenantMocks.manager;
    manager.create.mockImplementation((_Entity: any, data: any) =>
      transactionsRepository.create(data),
    );
    manager.save.mockImplementation((data: any) =>
      transactionsRepository.save(data),
    );
    manager.update.mockImplementation((_Entity: any, id: any, data: any) =>
      transactionsRepository.update(id, data),
    );
    // Both legs are deleted conditionally and each reversal is gated on what the
    // database actually removed (audit P4-003), so the double reports a count.
    manager.delete.mockResolvedValue({ affected: 1 });
    manager.findOne.mockImplementation((_Entity: any, opts: any) =>
      transactionsRepository.findOne(opts),
    );
    manager.find.mockImplementation((_Entity: any, opts: any) =>
      splitsRepository.find(opts),
    );
    manager.remove.mockImplementation((data: any) => {
      const item = Array.isArray(data) ? data[0] : data;
      if (item && "transactionId" in item && !("accountId" in item)) {
        return splitsRepository.remove(data);
      }
      return transactionsRepository.remove(data);
    });
    manager.query.mockResolvedValue([]);

    mockQueryRunner = { manager };

    // Transfers resolve a cross-currency rate server-side rather than defaulting
    // to 1 (audit P5-002). Same-currency transfers never reach these.
    exchangeRateService = {
      getRateForDate: jest.fn().mockResolvedValue(null),
      getLatestRate: jest.fn().mockResolvedValue(null),
    };

    // No rules by default: nothing is applied and the preview has no effects,
    // which is what every spec below assumed before rules existed.
    rulesApplier = {
      applyToNewTransfer: jest.fn().mockResolvedValue([]),
      previewForRow: jest.fn().mockResolvedValue(null),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionTransferService,
        { provide: AccountsService, useValue: accountsService },
        { provide: PayeesService, useValue: payeesService },
        { provide: NetWorthService, useValue: netWorthService },
        { provide: DataSource, useValue: mockDataSource },
        { provide: ActionHistoryService, useValue: actionHistoryService },
        { provide: CrossOwnerAccessService, useValue: crossOwnerAccess },
        { provide: ExchangeRateService, useValue: exchangeRateService },
        { provide: TransactionRulesApplierService, useValue: rulesApplier },
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
    it("refuses a future-dated transfer into a closed account before writing", async () => {
      crossOwnerAccess.accountAccessFor.mockImplementation(
        (_u: string, id: string) =>
          Promise.resolve({
            account:
              id === "to-account"
                ? { ...mockToAccount, isClosed: true }
                : mockFromAccount,
          }),
      );

      await expect(
        service.createTransfer(
          "user-1",
          { ...baseTransferDto, transactionDate: "2999-01-15" },
          mockFindOne,
        ),
      ).rejects.toThrow(/closed account/);

      expect(transactionsRepository.save).not.toHaveBeenCalled();
    });

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
      );
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "to-account",
        500,
      );

      expect(result.fromTransaction.id).toBe("from-tx-id");
      expect(result.toTransaction.id).toBe("to-tx-id");
    });

    it("does not move either balance when the transfer is created VOID (P5-001)", async () => {
      // A VOID row is a record of something that did not happen. Both legs are
      // still written, but neither may touch a balance -- exactly as an
      // ordinary VOID transaction skips its balance update.
      //
      // Before this fix the pair posted -500 and +500 while both rows said
      // VOID, and recalculateCurrentBalance (which excludes VOID rows) then
      // silently reversed it the next time anything triggered a recompute:
      // money appeared to move and then unmove.
      mockFindOne
        .mockResolvedValueOnce({ id: "from-tx-id", amount: -500 })
        .mockResolvedValueOnce({ id: "to-tx-id", amount: 500 });

      await service.createTransfer(
        "user-1",
        { ...baseTransferDto, status: TransactionStatus.VOID },
        mockFindOne,
      );

      // Both ledger rows exist and are linked.
      expect(transactionsRepository.create).toHaveBeenCalledTimes(2);
      expect(transactionsRepository.create.mock.calls[0][0].status).toBe(
        TransactionStatus.VOID,
      );
      expect(transactionsRepository.create.mock.calls[1][0].status).toBe(
        TransactionStatus.VOID,
      );

      // Neither balance moved, by either mechanism.
      expect(accountsService.updateBalance).not.toHaveBeenCalled();
      expect(accountsService.recalculateCurrentBalance).not.toHaveBeenCalled();
    });

    it("still moves balances for a non-VOID status", async () => {
      // The guard must not swallow the ordinary case.
      mockFindOne
        .mockResolvedValueOnce({ id: "from-tx-id", amount: -500 })
        .mockResolvedValueOnce({ id: "to-tx-id", amount: 500 });

      await service.createTransfer(
        "user-1",
        { ...baseTransferDto, status: TransactionStatus.RECONCILED },
        mockFindOne,
      );

      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "from-account",
        -500,
      );
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "to-account",
        500,
      );
    });

    it("writes both legs with the effective user's id and no system context on the same-owner path", async () => {
      mockFindOne
        .mockResolvedValueOnce({ id: "from-tx-id", amount: -500 })
        .mockResolvedValueOnce({ id: "to-tx-id", amount: 500 });

      await service.createTransfer("user-1", baseTransferDto, mockFindOne, {
        effectiveUserId: "user-1",
        realUserId: "user-1",
      });

      const [fromCreate, toCreate] = transactionsRepository.create.mock.calls;
      expect(fromCreate[0].userId).toBe("user-1");
      expect(toCreate[0].userId).toBe("user-1");
      expect(mockedWithSystemContext).not.toHaveBeenCalled();
      // Exactly today's single history record, under the effective user.
      expect(actionHistoryService.record).toHaveBeenCalledTimes(1);
      expect(actionHistoryService.record).toHaveBeenCalledWith(
        "user-1",
        expect.objectContaining({
          descriptionKey: "createdTransfer",
          descriptionParams: {
            // The English string is the fallback; the structured pair beside it
            // is what the reader's client formats in their own number locale
            // (issue #1316).
            amount: expect.any(String),
            amountValue: expect.any(Number),
            amountCurrency: expect.any(String),
            from: "Checking",
            to: "Savings",
          },
        }),
      );
      // Result legs loaded through the same owner-scoped findOne as before.
      expect(mockFindOne).toHaveBeenNthCalledWith(1, "user-1", "from-tx-id");
      expect(mockFindOne).toHaveBeenNthCalledWith(2, "user-1", "to-tx-id");
    });

    describe("cross-owner", () => {
      const foreignToAccount = {
        id: "to-account",
        name: "Owner Savings",
        currencyCode: "USD",
        userId: "owner-2",
      };

      beforeEach(() => {
        crossOwnerAccess.accountAccessFor.mockImplementation(
          async (realUserId: string, accountId: string) => {
            const account =
              accountId === "from-account" ? mockFromAccount : foreignToAccount;
            return {
              account,
              ownerUserId: account.userId,
              via: account.userId === realUserId ? "own" : "delegation",
            };
          },
        );
        transactionsRepository.save
          .mockReset()
          .mockResolvedValueOnce({ id: "from-tx-id" })
          .mockResolvedValueOnce({ id: "to-tx-id" });
        mockFindOne
          .mockResolvedValueOnce({ id: "from-tx-id", amount: -500 })
          .mockResolvedValueOnce({ id: "to-tx-id", amount: 500 });
      });

      const crossDto = {
        ...baseTransferDto,
        categoryId: "cat-1",
        payeeId: "payee-1",
      };
      const actor = { effectiveUserId: "user-1", realUserId: "user-1" };

      it("writes each leg with its account owner's user id inside a system-context transaction", async () => {
        await service.createTransfer("user-1", crossDto, mockFindOne, actor);

        const [fromCreate, toCreate] = transactionsRepository.create.mock.calls;
        expect(fromCreate[0].userId).toBe("user-1");
        expect(toCreate[0].userId).toBe("owner-2");
        expect(mockedWithSystemContext).toHaveBeenCalled();

        // Balances still update both accounts.
        expect(accountsService.updateBalance).toHaveBeenCalledWith(
          "from-account",
          -500,
        );
        expect(accountsService.updateBalance).toHaveBeenCalledWith(
          "to-account",
          500,
        );
      });

      it("authorizes both accounts for the REAL user with the create op", async () => {
        await service.createTransfer("user-1", crossDto, mockFindOne, {
          effectiveUserId: "user-1",
          realUserId: "real-9",
        });
        expect(crossOwnerAccess.accountAccessFor).toHaveBeenCalledWith(
          "real-9",
          "from-account",
          "create",
        );
        expect(crossOwnerAccess.accountAccessFor).toHaveBeenCalledWith(
          "real-9",
          "to-account",
          "create",
        );
      });

      it("applies category and payee to effective-user legs only", async () => {
        await service.createTransfer("user-1", crossDto, mockFindOne, actor);

        const [fromCreate, toCreate] = transactionsRepository.create.mock.calls;
        expect(fromCreate[0].categoryId).toBe("cat-1");
        expect(fromCreate[0].payeeId).toBe("payee-1");
        expect(toCreate[0].categoryId).toBeNull();
        expect(toCreate[0].payeeId).toBeNull();
      });

      it("loads each result leg as its owner and recalcs net worth per owner", async () => {
        await service.createTransfer("user-1", crossDto, mockFindOne, actor);

        expect(mockFindOne).toHaveBeenNthCalledWith(1, "user-1", "from-tx-id");
        expect(mockFindOne).toHaveBeenNthCalledWith(2, "owner-2", "to-tx-id");
        expect(netWorthService.triggerDebouncedRecalc).toHaveBeenCalledWith(
          "from-account",
          "user-1",
        );
        expect(netWorthService.triggerDebouncedRecalc).toHaveBeenCalledWith(
          "to-account",
          "owner-2",
        );
      });

      it("records history per owner, masking the foreign account name in the counterpart's entry", async () => {
        await service.createTransfer("user-1", crossDto, mockFindOne, actor);

        expect(actionHistoryService.record).toHaveBeenCalledTimes(2);
        // Actor's own entry names both accounts.
        expect(actionHistoryService.record).toHaveBeenCalledWith(
          "user-1",
          expect.objectContaining({
            entityId: "from-tx-id",
            descriptionParams: expect.objectContaining({
              from: "Checking",
              to: "Owner Savings",
            }),
          }),
        );
        // Counterpart owner's entry masks the actor's account name.
        expect(actionHistoryService.record).toHaveBeenCalledWith(
          "owner-2",
          expect.objectContaining({
            entityId: "to-tx-id",
            descriptionParams: expect.objectContaining({
              from: "Shared account",
              to: "Owner Savings",
            }),
          }),
        );
      });
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
      // A bank's actual settlement figure legitimately differs from spot by
      // fees, so an explicit destination amount is honoured for a genuine
      // cross-currency pair. The destination account really is CAD -- the
      // currency is read from the account now, not from the request.
      accountsService.findOne.mockImplementation((_u: string, id: string) =>
        Promise.resolve(
          id === "to-account"
            ? { ...mockToAccount, currencyCode: "CAD" }
            : mockFromAccount,
        ),
      );
      crossOwnerAccess.accountAccessFor.mockImplementation(
        (_u: string, id: string) =>
          Promise.resolve({
            account:
              id === "to-account"
                ? { ...mockToAccount, currencyCode: "CAD" }
                : mockFromAccount,
          }),
      );

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
      );
    });

    it("calculates toAmount from exchangeRate when toAmount not provided", async () => {
      const cadTo = { ...mockToAccount, currencyCode: "CAD" };
      accountsService.findOne.mockImplementation((_u: string, id: string) =>
        Promise.resolve(id === "to-account" ? cadTo : mockFromAccount),
      );
      crossOwnerAccess.accountAccessFor.mockImplementation(
        (_u: string, id: string) =>
          Promise.resolve({
            account: id === "to-account" ? cadTo : mockFromAccount,
          }),
      );

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
      expect(toCreateCall.currencyCode).toBe("CAD");
    });

    describe("currency and FX are server-authoritative (P5-002)", () => {
      const asCad = () => {
        const cadTo = { ...mockToAccount, currencyCode: "CAD" };
        accountsService.findOne.mockImplementation((_u: string, id: string) =>
          Promise.resolve(id === "to-account" ? cadTo : mockFromAccount),
        );
        crossOwnerAccess.accountAccessFor.mockImplementation(
          (_u: string, id: string) =>
            Promise.resolve({
              account: id === "to-account" ? cadTo : mockFromAccount,
            }),
        );
        return cadTo;
      };

      const expectLegsSaved = () => {
        transactionsRepository.save
          .mockReset()
          .mockResolvedValueOnce({ id: "from-tx-id" })
          .mockResolvedValueOnce({ id: "to-tx-id" });
        mockFindOne
          .mockResolvedValueOnce({ id: "from-tx-id" })
          .mockResolvedValueOnce({ id: "to-tx-id" });
      };

      it("rejects a same-currency transfer whose destination amount differs", async () => {
        // The audit's scenario B. Both accounts are USD, amount 100,
        // toAmount 80: the source lost 100, the destination gained 80, and 20
        // simply left the system. An explicit destination amount used to
        // override the calculation with no conservation check at all.
        //
        // There is no rate and no fee that can make a same-currency transfer
        // unequal, so this is a rejection rather than an override.
        await expect(
          service.createTransfer(
            "user-1",
            { ...baseTransferDto, amount: 100, toAmount: 80 },
            mockFindOne,
          ),
        ).rejects.toThrow(/same amount on both sides/);

        expect(transactionsRepository.save).not.toHaveBeenCalled();
        expect(accountsService.updateBalance).not.toHaveBeenCalled();
      });

      it("rejects a same-currency transfer with a rate other than 1", async () => {
        await expect(
          service.createTransfer(
            "user-1",
            { ...baseTransferDto, exchangeRate: 1.35 },
            mockFindOne,
          ),
        ).rejects.toThrow(/cannot have an exchange rate other than 1/);
      });

      it("rejects a request naming a currency the account does not use", async () => {
        // The destination row used to be labelled with whatever the request
        // said, contaminating every later conversion that read it.
        asCad();
        await expect(
          service.createTransfer(
            "user-1",
            { ...baseTransferDto, toCurrencyCode: "GBP" },
            mockFindOne,
          ),
        ).rejects.toThrow(/must match the account currency/);
      });

      it("resolves the market rate for the transfer date when none is supplied", async () => {
        // This is the scheduled-transfer path (audit scenario A): a schedule
        // carries only its source currency, so it supplies no target currency,
        // no rate and no destination amount. The pair used to post 1:1 -- 100
        // USD landing as 100 CAD -- with the destination row labelled USD.
        asCad();
        exchangeRateService.getRateForDate.mockResolvedValue(1.35);
        expectLegsSaved();

        await service.createTransfer(
          "user-1",
          { ...baseTransferDto, amount: 100 },
          mockFindOne,
        );

        expect(exchangeRateService.getRateForDate).toHaveBeenCalledWith(
          "USD",
          "CAD",
          "2026-01-15",
        );
        const toLeg = transactionsRepository.create.mock.calls[1][0];
        expect(toLeg.amount).toBe(135);
        expect(toLeg.currencyCode).toBe("CAD");
        expect(toLeg.exchangeRate).toBe(1.35);
      });

      it("resolves through the one rate ladder, with no dead getLatestRate chase", async () => {
        // getRateForDate itself falls back to the latest stored rate (its
        // documented step 3), so the transfer service asks it once through
        // resolveFxRateOrNull and must NOT chase a null with its own
        // getLatestRate call -- that trailing call could never return anything
        // the first did not, and four copies of the ladder is how resolvers
        // drift.
        asCad();
        exchangeRateService.getRateForDate.mockResolvedValue(1.4);
        expectLegsSaved();

        await service.createTransfer(
          "user-1",
          { ...baseTransferDto, amount: 100 },
          mockFindOne,
        );

        expect(transactionsRepository.create.mock.calls[1][0].amount).toBe(140);
        expect(exchangeRateService.getLatestRate).not.toHaveBeenCalled();
      });

      it("posts a zero cross-currency transfer without demanding a rate", async () => {
        // Zero moves nothing on either side, so it needs no rate ("zero needs
        // no rate"): a zero-amount scheduled placeholder between two
        // currencies used to be refused with transferRateUnavailable for a
        // pair nobody needed resolved.
        asCad();
        exchangeRateService.getRateForDate.mockResolvedValue(null);
        exchangeRateService.getLatestRate.mockResolvedValue(null);
        expectLegsSaved();

        await service.createTransfer(
          "user-1",
          { ...baseTransferDto, amount: 0 },
          mockFindOne,
        );

        expect(transactionsRepository.create.mock.calls[1][0].amount).toBe(0);
        expect(exchangeRateService.getRateForDate).not.toHaveBeenCalled();
      });

      it("refuses a cross-currency transfer with no determinable rate", async () => {
        // Refusing is the point: posting at 1:1 would overstate the destination
        // by the whole FX difference and look entirely normal.
        asCad();
        exchangeRateService.getRateForDate.mockResolvedValue(null);
        exchangeRateService.getLatestRate.mockResolvedValue(null);

        await expect(
          service.createTransfer(
            "user-1",
            { ...baseTransferDto, amount: 100 },
            mockFindOne,
          ),
        ).rejects.toThrow(/Could not determine an exchange rate/);

        expect(accountsService.updateBalance).not.toHaveBeenCalled();
      });

      it("ignores a non-positive supplied rate and resolves one instead", async () => {
        // The DTO allowed @Min(0), so zero reached the service and produced a
        // destination amount of 0 with the transfer still posted.
        asCad();
        exchangeRateService.getRateForDate.mockResolvedValue(1.35);
        expectLegsSaved();

        await service.createTransfer(
          "user-1",
          { ...baseTransferDto, amount: 100, exchangeRate: 0 },
          mockFindOne,
        );

        expect(transactionsRepository.create.mock.calls[1][0].amount).toBe(135);
      });

      it("rejects a non-zero source with a zero destination (FR-003)", async () => {
        // 100 out, 0 in destroys 100 of value and stores a rate of 0. Both DTO
        // fields allow zero and the explicit-settlement branch returned before
        // checking anything.
        asCad();
        await expect(
          service.createTransfer(
            "user-1",
            { ...baseTransferDto, amount: 100, toAmount: 0 },
            mockFindOne,
          ),
        ).rejects.toThrow(/non-zero amount on both sides/);
        expect(accountsService.updateBalance).not.toHaveBeenCalled();
      });

      it("rejects a zero source with a non-zero destination (FR-003)", async () => {
        // 0 out, 100 in creates 100 from nothing, and the implied rate came out
        // as 1 only because the divisor was zero.
        asCad();
        await expect(
          service.createTransfer(
            "user-1",
            { ...baseTransferDto, amount: 0, toAmount: 100 },
            mockFindOne,
          ),
        ).rejects.toThrow(/non-zero amount on both sides/);
        expect(accountsService.updateBalance).not.toHaveBeenCalled();
      });

      it("allows zero on both sides", async () => {
        // A zero transfer moves nothing and has no rate to imply. Permitted
        // because the DTO permits a zero amount; what is forbidden is the pair
        // disagreeing about whether anything moved.
        asCad();
        expectLegsSaved();

        await service.createTransfer(
          "user-1",
          { ...baseTransferDto, amount: 0, toAmount: 0 },
          mockFindOne,
        );

        const toLeg = transactionsRepository.create.mock.calls[1][0];
        expect(toLeg.amount).toBe(0);
        expect(toLeg.exchangeRate).toBe(1);
      });

      it("stores the implied rate when an explicit settlement amount is given", async () => {
        // The destination row still records how the two sides relate, so a
        // later reader is not left guessing.
        asCad();
        expectLegsSaved();

        await service.createTransfer(
          "user-1",
          { ...baseTransferDto, amount: 100, toAmount: 132 },
          mockFindOne,
        );

        const toLeg = transactionsRepository.create.mock.calls[1][0];
        expect(toLeg.amount).toBe(132);
        expect(toLeg.exchangeRate).toBe(1.32);
      });
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

    it("persists a blank payeeName as null when not provided (issue #1214)", async () => {
      // No stamped "Transfer to/from <account>": the label is resolved at
      // read time from the linked leg's account, so it follows renames and
      // the reader's language.
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
      expect(fromCreateCall.payeeName).toBeNull();
      expect(toCreateCall.payeeName).toBeNull();
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

  describe("stale-snapshot refusal", () => {
    it("returns 409 when a leg changed between the read and the write", async () => {
      // The regression guard for P4-003 on transfers. The four balance
      // adjustments reverse the OLD leg amounts and re-apply the new ones, so a
      // concurrent edit makes those old values describe a version this write is
      // not replacing -- two updates each reversing the same pair corrupt both
      // accounts. A 409 the client can retry is the honest answer.
      // Both legs are same-currency (USD, from their accounts), so the FX
      // resolution the update runs before taking the lock is trivial and needs
      // no rate lookup -- the flow reaches the concurrency (`unchanged`) check,
      // which is what this test exercises. `currencyCode`/`account` are required
      // because a real row always carries them and the resolver reads them.
      const fromTx = {
        id: "from-tx",
        userId: "user-1",
        accountId: "from-account",
        amount: -200,
        currencyCode: "USD",
        account: mockFromAccount,
        isTransfer: true,
        linkedTransactionId: "to-tx",
        exchangeRate: 1,
        transactionDate: "2026-01-15",
      };
      const toTx = {
        id: "to-tx",
        userId: "user-1",
        accountId: "to-account",
        amount: 200,
        currencyCode: "USD",
        account: mockToAccount,
        isTransfer: true,
        linkedTransactionId: "from-tx",
        exchangeRate: 1,
        transactionDate: "2026-01-15",
      };
      mockFindOne.mockImplementation(async (_u: string, id: string) =>
        id === "from-tx" ? fromTx : toTx,
      );
      splitsRepository.findOne.mockResolvedValue(null);

      // The committed from-leg is already -300: another request got there first.
      (lockTransactionRows as jest.Mock).mockResolvedValue(
        new Map([
          [
            "from-tx",
            lockedTransactionRow({
              id: "from-tx",
              accountId: "from-account",
              amount: -300,
              transactionDate: "2026-01-15",
            }),
          ],
          [
            "to-tx",
            lockedTransactionRow({
              id: "to-tx",
              accountId: "to-account",
              amount: 300,
              transactionDate: "2026-01-15",
            }),
          ],
        ]),
      );

      await expect(
        service.updateTransfer(
          "user-1",
          "from-tx",
          { amount: 250 },
          mockFindOne,
        ),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(accountsService.updateBalance).not.toHaveBeenCalled();
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
      );
      // Reverse to transaction balance
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "to-account",
        -500,
      );
      // Both transactions removed
      // Conditional DELETEs, with each reversal gated on the row the database
      // actually removed (audit P4-003).
      expect(mockQueryRunner.manager.delete).toHaveBeenCalledWith(Transaction, {
        id: "to-tx",
        userId: "user-1",
      });
      expect(mockQueryRunner.manager.delete).toHaveBeenCalledWith(Transaction, {
        id: "from-tx",
        userId: "user-1",
      });
    });

    it("reverses no balance when deleting a VOID pair (RR3-003)", async () => {
      // A VOID row contributed nothing, so deleting it must reverse nothing.
      // Every reversal site in this service's delete family fired on any
      // past-dated row regardless of status, while `bulkDelete` had the guard --
      // which is what proved the intended behaviour. Deleting a voided 100 USD ->
      // 90 EUR pair credited the source 100 and debited the destination 90 out of
      // nothing.
      const fromTx = {
        id: "from-tx",
        isTransfer: true,
        linkedTransactionId: "to-tx",
        accountId: "from-account",
        amount: -100,
        status: TransactionStatus.VOID,
        transactionDate: "2026-01-15",
      };
      const toTx = {
        id: "to-tx",
        accountId: "to-account",
        amount: 90,
        status: TransactionStatus.VOID,
        transactionDate: "2026-01-15",
      };

      mockFindOne.mockResolvedValue(fromTx);
      splitsRepository.findOne.mockResolvedValue(null);
      transactionsRepository.findOne.mockResolvedValue(toTx);

      await service.removeTransfer("user-1", "from-tx", mockFindOne);

      expect(accountsService.updateBalance).not.toHaveBeenCalled();
      // The rows still go: the record of an event that did not happen is deleted.
      // Deletion is a conditional DELETE gated on what the database removed
      // (removeLockedTransactionLeg -> m.delete), not manager.remove(entity).
      expect(mockQueryRunner.manager.delete).toHaveBeenCalledWith(Transaction, {
        id: "to-tx",
        userId: "user-1",
      });
      expect(mockQueryRunner.manager.delete).toHaveBeenCalledWith(Transaction, {
        id: "from-tx",
        userId: "user-1",
      });
    });

    it("reverses only the included leg when one side of a pair is VOID", async () => {
      // Cross-owner statuses are per-ledger, so a pair can be half VOID. Each row
      // is reversed on its own inclusion, not the pair's.
      const fromTx = {
        id: "from-tx",
        isTransfer: true,
        linkedTransactionId: "to-tx",
        accountId: "from-account",
        amount: -100,
        status: TransactionStatus.VOID,
        transactionDate: "2026-01-15",
      };
      const toTx = {
        id: "to-tx",
        accountId: "to-account",
        amount: 90,
        status: TransactionStatus.UNRECONCILED,
        transactionDate: "2026-01-15",
      };

      mockFindOne.mockResolvedValue(fromTx);
      splitsRepository.findOne.mockResolvedValue(null);
      transactionsRepository.findOne.mockResolvedValue(toTx);

      await service.removeTransfer("user-1", "from-tx", mockFindOne);

      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "to-account",
        -90,
      );
      expect(accountsService.updateBalance).not.toHaveBeenCalledWith(
        "from-account",
        expect.anything(),
      );
      expect(accountsService.updateBalance).toHaveBeenCalledTimes(1);
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
      );
      // One conditional DELETE, for the own leg only.
      expect(mockQueryRunner.manager.delete).toHaveBeenCalledTimes(1);
      expect(mockQueryRunner.manager.delete).toHaveBeenCalledWith(Transaction, {
        id: "tx-1",
        userId: "user-1",
      });
    });

    it("delegates to removeTransferFromSplit when transaction is part of a split", async () => {
      const tx = {
        id: "linked-from-split",
        userId: "user-1",
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

      // Should remove the parent transaction and all related splits. Both ledger
      // rows go through the conditional delete (audit FV4-002); only the split
      // rows, which carry no balance, still use `remove`.
      expect(splitsRepository.remove).toHaveBeenCalled();
      expect(mockQueryRunner.manager.delete).toHaveBeenCalledWith(Transaction, {
        id: "parent-tx",
        userId: "user-1",
      });
      expect(mockQueryRunner.manager.delete).toHaveBeenCalledWith(Transaction, {
        id: "linked-from-split",
        userId: "user-1",
      });
      expect(transactionsRepository.remove).not.toHaveBeenCalled();
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
        userId: "user-1",
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
        "user-1",
        "account-3",
      );
      expect(accountsService.recalculateCurrentBalance).toHaveBeenCalledWith(
        "user-1",
        "account-1",
      );
      expect(accountsService.recalculateCurrentBalance).toHaveBeenCalledWith(
        "user-1",
        "account-2",
      );
    });
  });

  describe("updateTransfer", () => {
    // `currency_code` is NOT NULL on transactions, so a real row always carries
    // it. Leaving it off made the derived-currency comparison see `undefined`
    // and treat every edit as a re-denomination.
    const fromTransaction = {
      id: "from-tx",
      accountId: "from-account",
      amount: -500,
      currencyCode: "USD",
      isTransfer: true,
      linkedTransactionId: "to-tx",
      exchangeRate: 1,
      account: mockFromAccount,
    } as unknown as Transaction;

    const toTransaction = {
      id: "to-tx",
      accountId: "to-account",
      amount: 500,
      currencyCode: "USD",
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

    describe("VOID transitions (P5-001)", () => {
      // `accountsOrAmountsChanged` did not include `status`, so a status-only
      // edit wrote VOID onto both rows and left both balances carrying the
      // money. The ledger then said no transfer had occurred while the accounts
      // still reflected one, and the next recalculation moved 500 without any
      // user action.
      it("reverses both balances exactly once when voiding an active transfer", async () => {
        const activeFrom = {
          ...fromTransaction,
          status: TransactionStatus.UNRECONCILED,
        } as unknown as Transaction;
        const activeTo = {
          ...toTransaction,
          status: TransactionStatus.UNRECONCILED,
        } as unknown as Transaction;

        mockFindOne
          .mockResolvedValueOnce(activeFrom)
          .mockResolvedValueOnce(activeTo)
          .mockResolvedValueOnce({
            ...activeFrom,
            status: TransactionStatus.VOID,
          })
          .mockResolvedValueOnce({
            ...activeTo,
            status: TransactionStatus.VOID,
          });

        await service.updateTransfer(
          "user-1",
          "from-tx",
          { status: TransactionStatus.VOID },
          mockFindOne,
        );

        // The old pair is reversed...
        expect(accountsService.updateBalance).toHaveBeenCalledWith(
          "from-account",
          500,
        );
        expect(accountsService.updateBalance).toHaveBeenCalledWith(
          "to-account",
          -500,
        );
        // ...and NOT re-applied, because the pair is now excluded. Exactly one
        // adjustment per account: a second pair would net to zero and leave the
        // void with no effect at all.
        expect(accountsService.updateBalance).toHaveBeenCalledTimes(2);
      });

      it("re-applies both balances exactly once when unvoiding a transfer", async () => {
        const voidFrom = {
          ...fromTransaction,
          status: TransactionStatus.VOID,
        } as unknown as Transaction;
        const voidTo = {
          ...toTransaction,
          status: TransactionStatus.VOID,
        } as unknown as Transaction;

        mockFindOne
          .mockResolvedValueOnce(voidFrom)
          .mockResolvedValueOnce(voidTo)
          .mockResolvedValueOnce({
            ...voidFrom,
            status: TransactionStatus.UNRECONCILED,
          })
          .mockResolvedValueOnce({
            ...voidTo,
            status: TransactionStatus.UNRECONCILED,
          });

        await service.updateTransfer(
          "user-1",
          "from-tx",
          { status: TransactionStatus.UNRECONCILED },
          mockFindOne,
        );

        // No reversal: a VOID pair contributed nothing to reverse, and
        // reversing it would have created the money the void withheld.
        expect(accountsService.updateBalance).toHaveBeenCalledWith(
          "from-account",
          -500,
        );
        expect(accountsService.updateBalance).toHaveBeenCalledWith(
          "to-account",
          500,
        );
        expect(accountsService.updateBalance).toHaveBeenCalledTimes(2);
      });

      it("does not touch balances when editing a transfer that stays VOID", async () => {
        const voidFrom = {
          ...fromTransaction,
          status: TransactionStatus.VOID,
        } as unknown as Transaction;
        const voidTo = {
          ...toTransaction,
          status: TransactionStatus.VOID,
        } as unknown as Transaction;

        mockFindOne
          .mockResolvedValueOnce(voidFrom)
          .mockResolvedValueOnce(voidTo)
          .mockResolvedValueOnce({ ...voidFrom, amount: -750 })
          .mockResolvedValueOnce({ ...voidTo, amount: 750 });

        await service.updateTransfer(
          "user-1",
          "from-tx",
          { amount: 750 },
          mockFindOne,
        );

        // Changing the amount of a void transfer changes no balance: it was
        // excluded before and is excluded after.
        expect(accountsService.updateBalance).not.toHaveBeenCalled();
      });
    });

    describe("per-leg reconciliation on same-owner edit (P6-RECHECK-004)", () => {
      // CLEARED / RECONCILED record whether THIS account's statement has
      // recognised THIS leg, and the two statements arrive separately. The edit
      // form shows one status control for the transfer and used to write it onto
      // both rows, so opening the form on one leg and saving rewrote the other
      // account's reconciliation state. A non-VOID status change now stays on
      // the leg the user opened; VOID still pairs because it moves both balances.
      it("writes a reconciliation status only to the edited leg, leaving the counterpart untouched", async () => {
        const activeFrom = {
          ...fromTransaction,
          status: TransactionStatus.UNRECONCILED,
        } as unknown as Transaction;
        const reconciledTo = {
          ...toTransaction,
          status: TransactionStatus.RECONCILED,
        } as unknown as Transaction;

        mockFindOne
          .mockResolvedValueOnce(activeFrom)
          .mockResolvedValueOnce(reconciledTo)
          .mockResolvedValueOnce({
            ...activeFrom,
            status: TransactionStatus.CLEARED,
          })
          .mockResolvedValueOnce(reconciledTo);

        // A description rides along so the counterpart IS updated (description
        // mirrors to both legs) -- this distinguishes "status stripped from the
        // counterpart update" from "counterpart never updated".
        await service.updateTransfer(
          "user-1",
          "from-tx",
          { status: TransactionStatus.CLEARED, description: "groceries" },
          mockFindOne,
        );

        const updateCalls = transactionsRepository.update.mock.calls;
        const fromUpdate = updateCalls.find((c) => c[0] === "from-tx")?.[1];
        const toUpdate = updateCalls.find((c) => c[0] === "to-tx")?.[1];

        // The edited leg takes the new status...
        expect(fromUpdate).toMatchObject({ status: TransactionStatus.CLEARED });
        // ...and the counterpart is written (its description mirrors) but its
        // RECONCILED state is never rewritten. On the old behaviour toUpdate
        // carried status: CLEARED and clobbered it.
        expect(toUpdate).toMatchObject({ description: "groceries" });
        expect(toUpdate.status).toBeUndefined();
        // A non-VOID status change moves no balance.
        expect(accountsService.updateBalance).not.toHaveBeenCalled();
      });

      it("issues no counterpart update at all for a status-only edit", async () => {
        const activeFrom = {
          ...fromTransaction,
          status: TransactionStatus.UNRECONCILED,
        } as unknown as Transaction;
        const reconciledTo = {
          ...toTransaction,
          status: TransactionStatus.RECONCILED,
        } as unknown as Transaction;

        mockFindOne
          .mockResolvedValueOnce(activeFrom)
          .mockResolvedValueOnce(reconciledTo)
          .mockResolvedValueOnce({
            ...activeFrom,
            status: TransactionStatus.CLEARED,
          })
          .mockResolvedValueOnce(reconciledTo);

        await service.updateTransfer(
          "user-1",
          "from-tx",
          { status: TransactionStatus.CLEARED },
          mockFindOne,
        );

        // With status the only changed field, stripping it leaves the
        // counterpart's update data empty, so `Object.keys(...).length > 0` is
        // false and no write is issued for the counterpart at all.
        const updateCalls = transactionsRepository.update.mock.calls;
        expect(updateCalls.some((c) => c[0] === "to-tx")).toBe(false);
        expect(updateCalls.find((c) => c[0] === "from-tx")?.[1]).toMatchObject({
          status: TransactionStatus.CLEARED,
        });
      });

      it("strips the status from the from-leg when the user opened the to-leg", async () => {
        const reconciledFrom = {
          ...fromTransaction,
          status: TransactionStatus.RECONCILED,
        } as unknown as Transaction;
        const activeTo = {
          ...toTransaction,
          status: TransactionStatus.UNRECONCILED,
        } as unknown as Transaction;

        // The user opened the TO leg, so findOne returns it first and its
        // counterpart second.
        mockFindOne
          .mockResolvedValueOnce(activeTo)
          .mockResolvedValueOnce(reconciledFrom)
          .mockResolvedValueOnce(reconciledFrom)
          .mockResolvedValueOnce({
            ...activeTo,
            status: TransactionStatus.CLEARED,
          });

        await service.updateTransfer(
          "user-1",
          "to-tx",
          { status: TransactionStatus.CLEARED },
          mockFindOne,
        );

        const updateCalls = transactionsRepository.update.mock.calls;
        const fromUpdate = updateCalls.find((c) => c[0] === "from-tx")?.[1];
        const toUpdate = updateCalls.find((c) => c[0] === "to-tx")?.[1];

        expect(toUpdate).toMatchObject({ status: TransactionStatus.CLEARED });
        expect(fromUpdate?.status).toBeUndefined();
      });

      it("still pairs the status across both legs when the transition crosses VOID", async () => {
        const activeFrom = {
          ...fromTransaction,
          status: TransactionStatus.UNRECONCILED,
        } as unknown as Transaction;
        const activeTo = {
          ...toTransaction,
          status: TransactionStatus.UNRECONCILED,
        } as unknown as Transaction;

        mockFindOne
          .mockResolvedValueOnce(activeFrom)
          .mockResolvedValueOnce(activeTo)
          .mockResolvedValueOnce({
            ...activeFrom,
            status: TransactionStatus.VOID,
          })
          .mockResolvedValueOnce({
            ...activeTo,
            status: TransactionStatus.VOID,
          });

        await service.updateTransfer(
          "user-1",
          "from-tx",
          { status: TransactionStatus.VOID },
          mockFindOne,
        );

        const updateCalls = transactionsRepository.update.mock.calls;
        const fromUpdate = updateCalls.find((c) => c[0] === "from-tx")?.[1];
        const toUpdate = updateCalls.find((c) => c[0] === "to-tx")?.[1];

        // VOID moves both balances, so the status belongs to both legs.
        expect(fromUpdate).toMatchObject({ status: TransactionStatus.VOID });
        expect(toUpdate).toMatchObject({ status: TransactionStatus.VOID });
      });

      it("pairs the submitted status onto both legs when un-voiding directly to CLEARED, matching the bulk path", async () => {
        const voidFrom = {
          ...fromTransaction,
          status: TransactionStatus.VOID,
        } as unknown as Transaction;
        const voidTo = {
          ...toTransaction,
          status: TransactionStatus.VOID,
        } as unknown as Transaction;

        // Un-void the FROM leg straight to CLEARED (VOID -> CLEARED). Leaving
        // VOID crosses the boundary, so the status is NOT stripped and both legs
        // reactivate carrying the submitted CLEARED -- identical to a bulk
        // un-void through `expandTransferCounterparts`. A non-UNRECONCILED
        // target is the case that distinguishes "pair the submitted status" from
        // "reset the counterpart to UNRECONCILED"; this pins the former.
        mockFindOne
          .mockResolvedValueOnce(voidFrom)
          .mockResolvedValueOnce(voidTo)
          .mockResolvedValueOnce({
            ...voidFrom,
            status: TransactionStatus.CLEARED,
          })
          .mockResolvedValueOnce({
            ...voidTo,
            status: TransactionStatus.CLEARED,
          });

        await service.updateTransfer(
          "user-1",
          "from-tx",
          { status: TransactionStatus.CLEARED },
          mockFindOne,
        );

        const updateCalls = transactionsRepository.update.mock.calls;
        const fromUpdate = updateCalls.find((c) => c[0] === "from-tx")?.[1];
        const toUpdate = updateCalls.find((c) => c[0] === "to-tx")?.[1];

        // Both legs leave VOID together and both carry CLEARED -- the counterpart
        // is neither stripped nor reset to UNRECONCILED.
        expect(fromUpdate).toMatchObject({ status: TransactionStatus.CLEARED });
        expect(toUpdate).toMatchObject({ status: TransactionStatus.CLEARED });
      });
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
      );
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "to-account",
        -500,
      );
      // New balances applied
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "from-account",
        -750,
      );
      expect(accountsService.updateBalance).toHaveBeenCalledWith(
        "to-account",
        750,
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

    describe("split transfer leg", () => {
      // A transfer split's counterpart in the target account. Its
      // linkedTransactionId points at the split PARENT (amount = sum of splits),
      // not a mirror leg.
      // `currencyCode` is NOT NULL on transactions and `findOne` loads the
      // `account` relation, so a fixture without either is a row the service
      // could never read -- and the currency is what decides whether the split
      // mirror is a copy or a conversion.
      const splitParent = {
        id: "parent-tx",
        accountId: "from-account",
        amount: -1000,
        currencyCode: "USD",
        account: { id: "from-account", currencyCode: "USD" },
        isSplit: true,
        transactionDate: "2020-01-01",
      } as unknown as Transaction;

      const counterpartLeg = {
        id: "leg-tx",
        accountId: "to-account",
        amount: 500,
        currencyCode: "USD",
        account: { id: "to-account", currencyCode: "USD" },
        exchangeRate: 1,
        isTransfer: true,
        linkedTransactionId: "parent-tx",
        transactionDate: "2020-01-01",
      } as unknown as Transaction;

      const parentSplit = {
        id: "split-1",
        transactionId: "parent-tx",
        transferAccountId: "to-account",
        amount: -500,
        linkedTransactionId: "leg-tx",
      } as unknown as TransactionSplit;

      it("edits only the leg's metadata and never rewrites the split parent's amount", async () => {
        splitsRepository.findOne.mockResolvedValue(parentSplit);
        mockFindOne
          .mockResolvedValueOnce(counterpartLeg) // transaction being edited
          .mockResolvedValueOnce(splitParent) // parent lookup
          .mockResolvedValueOnce(counterpartLeg); // refreshed leg

        // Mirrors the form payload: amount resent unchanged, accounts unchanged.
        await service.updateTransfer(
          "user-1",
          "leg-tx",
          {
            amount: 500,
            fromAccountId: "from-account",
            toAccountId: "to-account",
            description: "New note",
            fromCurrencyCode: "USD",
            toCurrencyCode: "USD",
          } as any,
          mockFindOne,
        );

        // The leg gets its own note...
        expect(transactionsRepository.update).toHaveBeenCalledWith(
          "leg-tx",
          expect.objectContaining({ description: "New note" }),
        );
        // ...and the note mirrors back to the source split's memo.
        expect(transactionsRepository.update).toHaveBeenCalledWith(
          "split-1",
          expect.objectContaining({ memo: "New note" }),
        );
        // The parent split's amount is never rewritten.
        expect(transactionsRepository.update).not.toHaveBeenCalledWith(
          "parent-tx",
          expect.anything(),
        );
        // No amount change => no balance movement.
        expect(accountsService.updateBalance).not.toHaveBeenCalled();
      });

      it("syncs a leg amount change into the split row, parent total, and both balances", async () => {
        splitsRepository.findOne.mockResolvedValue(parentSplit);
        splitsRepository.find.mockResolvedValue([
          { id: "split-1", amount: -500 },
          { id: "split-2", amount: -500 },
        ]);
        mockFindOne
          .mockResolvedValueOnce(counterpartLeg)
          .mockResolvedValueOnce(splitParent)
          .mockResolvedValueOnce({ ...counterpartLeg, amount: 600 });

        await service.updateTransfer(
          "user-1",
          "leg-tx",
          {
            amount: 600,
            fromAccountId: "from-account",
            toAccountId: "to-account",
          } as any,
          mockFindOne,
        );

        // Leg amount updated, matching split mirrored to -600.
        expect(transactionsRepository.update).toHaveBeenCalledWith(
          "leg-tx",
          expect.objectContaining({ amount: 600 }),
        );
        expect(transactionsRepository.update).toHaveBeenCalledWith(
          "split-1",
          expect.objectContaining({ amount: -600 }),
        );
        // Parent total = sum of splits = -600 + -500 = -1100.
        expect(transactionsRepository.update).toHaveBeenCalledWith(
          "parent-tx",
          expect.objectContaining({ amount: -1100 }),
        );
        // Target account gains the +100 delta; source account absorbs -100.
        expect(accountsService.updateBalance).toHaveBeenCalledWith(
          "to-account",
          100,
        );
        expect(accountsService.updateBalance).toHaveBeenCalledWith(
          "from-account",
          -100,
        );
      });

      // FR-006: a cross-currency split transfer. The parent is a PLN
      // transaction; the leg lives in a EUR account and was posted at
      // 0.2320000000 EUR per PLN, so a -1,000 PLN split produced a +232 EUR leg.
      const crossParent = {
        id: "parent-tx",
        accountId: "pln-account",
        amount: -1000,
        currencyCode: "PLN",
        account: { id: "pln-account", currencyCode: "PLN" },
        isSplit: true,
        transactionDate: "2020-01-01",
      } as unknown as Transaction;

      const crossLeg = {
        id: "leg-tx",
        accountId: "eur-account",
        amount: 232,
        currencyCode: "EUR",
        account: { id: "eur-account", currencyCode: "EUR" },
        exchangeRate: 0.232,
        isTransfer: true,
        linkedTransactionId: "parent-tx",
        transactionDate: "2020-01-01",
      } as unknown as Transaction;

      const crossSplit = {
        id: "split-1",
        transactionId: "parent-tx",
        transferAccountId: "eur-account",
        amount: -1000,
        linkedTransactionId: "leg-tx",
      } as unknown as TransactionSplit;

      it("converts a cross-currency leg amount back into the parent's currency", async () => {
        splitsRepository.findOne.mockResolvedValue(crossSplit);
        splitsRepository.find.mockResolvedValue([
          { id: "split-1", amount: -1000 },
        ]);
        mockFindOne
          .mockResolvedValueOnce(crossLeg)
          .mockResolvedValueOnce(crossParent)
          .mockResolvedValueOnce({ ...crossLeg, amount: 250 });

        await service.updateTransfer(
          "user-1",
          "leg-tx",
          { amount: 250 } as any,
          mockFindOne,
        );

        // The leg receives what the user typed, in its own currency.
        expect(transactionsRepository.update).toHaveBeenCalledWith(
          "leg-tx",
          expect.objectContaining({ amount: 250 }),
        );
        // The split row is in PLN: 250 EUR / 0.232 = 1,077.5862 PLN out.
        // Copying -250 across would have cut the PLN parent from 1,000 to 250.
        expect(transactionsRepository.update).toHaveBeenCalledWith(
          "split-1",
          expect.objectContaining({ amount: -1077.5862 }),
        );
        expect(transactionsRepository.update).toHaveBeenCalledWith(
          "parent-tx",
          expect.objectContaining({ amount: -1077.5862 }),
        );
        // Each account moves in its own currency: +18 EUR received, 77.5862 PLN
        // more sent.
        expect(accountsService.updateBalance).toHaveBeenCalledWith(
          "eur-account",
          18,
        );
        expect(accountsService.updateBalance).toHaveBeenCalledWith(
          "pln-account",
          -77.5862,
        );
      });

      it("resolves the rate for the date when the leg carries none, and records it", async () => {
        splitsRepository.findOne.mockResolvedValue(crossSplit);
        splitsRepository.find.mockResolvedValue([
          { id: "split-1", amount: -1000 },
        ]);
        // A leg imported before the rate column was populated.
        const rateless = { ...crossLeg, exchangeRate: null };
        mockFindOne
          .mockResolvedValueOnce(rateless)
          .mockResolvedValueOnce(crossParent)
          .mockResolvedValueOnce({ ...rateless, amount: 250 });
        exchangeRateService.getRateForDate.mockResolvedValue(0.25);

        await service.updateTransfer(
          "user-1",
          "leg-tx",
          { amount: 250 } as any,
          mockFindOne,
        );

        expect(exchangeRateService.getRateForDate).toHaveBeenCalledWith(
          "PLN",
          "EUR",
          "2020-01-01",
        );
        // 250 / 0.25 = 1,000 PLN, and the rate is written onto the leg so the
        // row can answer this question itself next time.
        expect(transactionsRepository.update).toHaveBeenCalledWith(
          "leg-tx",
          expect.objectContaining({ amount: 250, exchangeRate: 0.25 }),
        );
        expect(transactionsRepository.update).toHaveBeenCalledWith(
          "split-1",
          expect.objectContaining({ amount: -1000 }),
        );
      });

      it("refuses a cross-currency leg amount change when no rate can be found", async () => {
        splitsRepository.findOne.mockResolvedValue(crossSplit);
        const rateless = { ...crossLeg, exchangeRate: null };
        mockFindOne
          .mockResolvedValueOnce(rateless)
          .mockResolvedValueOnce(crossParent);
        exchangeRateService.getRateForDate.mockResolvedValue(null);
        exchangeRateService.getLatestRate.mockResolvedValue(null);

        await expect(
          service.updateTransfer(
            "user-1",
            "leg-tx",
            { amount: 250 } as any,
            mockFindOne,
          ),
        ).rejects.toThrow(BadRequestException);

        // Refused before writing: no leg amount, no split amount, no balance.
        expect(transactionsRepository.update).not.toHaveBeenCalled();
        expect(accountsService.updateBalance).not.toHaveBeenCalled();
      });

      it("refuses to void a split transfer leg on its own (RR2-002)", async () => {
        // Balance handling here was gated on the amount or date changing and never
        // looked at either row's VOID state, so a status-only void wrote VOID and
        // left the target balance carrying the money. Applying it to this leg alone
        // would also leave the parent's split row and total recording money that
        // left the source and never arrived, so it is refused and pointed at the
        // parent -- which `applyParentStatusToTransferCounterparts` propagates from.
        splitsRepository.findOne.mockResolvedValue(parentSplit);
        mockFindOne
          .mockResolvedValueOnce(counterpartLeg)
          .mockResolvedValueOnce(splitParent);

        await expect(
          service.updateTransfer(
            "user-1",
            "leg-tx",
            { status: TransactionStatus.VOID } as any,
            mockFindOne,
          ),
        ).rejects.toThrow(BadRequestException);

        // Refused before writing: no row, no balance.
        expect(transactionsRepository.update).not.toHaveBeenCalled();
        expect(accountsService.updateBalance).not.toHaveBeenCalled();
      });

      it("still allows a per-ledger reconciliation status change", async () => {
        // Only the VOID boundary is shared. CLEARED/RECONCILED are genuinely
        // per-ledger, exactly as they are across an ownership boundary, so the
        // refusal above must not swallow them.
        splitsRepository.findOne.mockResolvedValue(parentSplit);
        mockFindOne
          .mockResolvedValueOnce(counterpartLeg)
          .mockResolvedValueOnce(splitParent)
          .mockResolvedValueOnce(counterpartLeg);

        await service.updateTransfer(
          "user-1",
          "leg-tx",
          { status: TransactionStatus.CLEARED } as any,
          mockFindOne,
        );

        expect(transactionsRepository.update).toHaveBeenCalledWith(
          "leg-tx",
          expect.objectContaining({ status: TransactionStatus.CLEARED }),
        );
        expect(accountsService.updateBalance).not.toHaveBeenCalled();
      });

      it("moves no balance when the leg and its parent are already VOID (RR2-002)", async () => {
        // Editing an already-void split transfer's amount incremented the target
        // balance by the delta and moved the source by the parent delta, though
        // neither row contributes to either balance.
        const voidLeg = {
          ...counterpartLeg,
          status: TransactionStatus.VOID,
        } as unknown as Transaction;
        const voidParent = {
          ...splitParent,
          status: TransactionStatus.VOID,
        } as unknown as Transaction;

        splitsRepository.findOne.mockResolvedValue(parentSplit);
        splitsRepository.find.mockResolvedValue([
          { id: "split-1", amount: -500 },
        ]);
        mockFindOne
          .mockResolvedValueOnce(voidLeg)
          .mockResolvedValueOnce(voidParent)
          .mockResolvedValueOnce({ ...voidLeg, amount: 600 });

        await service.updateTransfer(
          "user-1",
          "leg-tx",
          { amount: 600, status: TransactionStatus.VOID } as any,
          mockFindOne,
        );

        // The record still updates: leg amount, split mirror and parent total.
        expect(transactionsRepository.update).toHaveBeenCalledWith(
          "leg-tx",
          expect.objectContaining({ amount: 600 }),
        );
        expect(transactionsRepository.update).toHaveBeenCalledWith(
          "split-1",
          expect.objectContaining({ amount: -600 }),
        );
        expect(transactionsRepository.update).toHaveBeenCalledWith(
          "parent-tx",
          expect.objectContaining({ amount: -600 }),
        );
        // No money moves, on either side.
        expect(accountsService.updateBalance).not.toHaveBeenCalled();
      });

      it("rejects moving a split transfer leg to a different account", async () => {
        splitsRepository.findOne.mockResolvedValue(parentSplit);
        mockFindOne
          .mockResolvedValueOnce(counterpartLeg)
          .mockResolvedValueOnce(splitParent);

        await expect(
          service.updateTransfer(
            "user-1",
            "leg-tx",
            { toAccountId: "other-account" } as any,
            mockFindOne,
          ),
        ).rejects.toThrow(BadRequestException);

        expect(transactionsRepository.update).not.toHaveBeenCalled();
      });
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

      const createdAtCalls = mockQueryRunner.manager.query.mock.calls.filter(
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

    it("rejects currency codes that are not the accounts' own (P5-002)", async () => {
      // Both accounts are USD. This test previously asserted that EUR and GBP
      // were stored as given, under the name "updates the source and
      // destination currency codes when provided" -- it documented the defect
      // as intended behaviour. A transfer's currency codes are facts about its
      // accounts, and a row labelled with something else contaminates every
      // later conversion that reads it.
      mockFindOne
        .mockResolvedValueOnce(fromTransaction)
        .mockResolvedValueOnce(toTransaction);

      await expect(
        service.updateTransfer(
          "user-1",
          "from-tx",
          { fromCurrencyCode: "EUR", toCurrencyCode: "GBP" },
          mockFindOne,
        ),
      ).rejects.toThrow(/must match the account currency/);
    });

    it("updates account IDs without writing payee names (issue #1214)", async () => {
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

      // A leg with no stored payee gets no payee write: blank stays blank and
      // the display resolves the label from the new linked account. Here the
      // from-leg has nothing else to change either, so no update reaches it.
      const fromCall = transactionsRepository.update.mock.calls.find(
        (c: any[]) => c[0] === "from-tx",
      );
      if (fromCall) {
        expect(fromCall[1]).not.toHaveProperty("payeeName");
      }

      // to-tx should get new accountId
      expect(transactionsRepository.update).toHaveBeenCalledWith(
        "to-tx",
        expect.objectContaining({
          accountId: "new-to-account",
        }),
      );
    });

    describe("the resolved destination tuple is persisted together", () => {
      // A EUR destination for a USD source, posted at 0.90: 100 USD -> 90 EUR.
      const eurTo = { ...mockToAccount, currencyCode: "EUR" };
      const usdFromTx = {
        ...fromTransaction,
        amount: -100,
      } as unknown as Transaction;
      const eurToTx = {
        ...toTransaction,
        amount: 90,
        currencyCode: "EUR",
        exchangeRate: 0.9,
        account: eurTo,
      } as unknown as Transaction;

      it("writes the new destination amount when only the account moves (RR2-003)", async () => {
        // Moving the destination leg to a GBP account with no explicit rate or
        // amount wrote the account, the currency and the resolved rate, and left
        // the old EUR *number* on the row: 90 GBP at 0.80 against a 100 USD
        // source, with the balance already moved by 80. The account, currency,
        // rate and amount are one resolved tuple.
        const gbpAccount = {
          id: "gbp-account",
          name: "London",
          currencyCode: "GBP",
        };
        accountsService.findOne.mockImplementation((_u: string, id: string) =>
          Promise.resolve(
            id === "gbp-account"
              ? gbpAccount
              : id === "to-account"
                ? eurTo
                : mockFromAccount,
          ),
        );
        exchangeRateService.getRateForDate.mockResolvedValue(0.8);

        mockFindOne
          .mockResolvedValueOnce(usdFromTx)
          .mockResolvedValueOnce(eurToTx)
          .mockResolvedValueOnce(usdFromTx)
          .mockResolvedValueOnce(eurToTx);

        await service.updateTransfer(
          "user-1",
          "from-tx",
          { toAccountId: "gbp-account" },
          mockFindOne,
        );

        // 100 USD at 0.80 is 80 GBP -- and that is what the row says.
        expect(transactionsRepository.update).toHaveBeenCalledWith(
          "to-tx",
          expect.objectContaining({
            accountId: "gbp-account",
            currencyCode: "GBP",
            exchangeRate: 0.8,
            amount: 80,
          }),
        );
        // The balance moved by the same 80 the row carries, so a later full
        // recompute is a no-op rather than a silent 10 GBP correction.
        expect(accountsService.updateBalance).toHaveBeenCalledWith(
          "to-account",
          -90,
        );
        expect(accountsService.updateBalance).toHaveBeenCalledWith(
          "gbp-account",
          80,
        );
      });

      it("does not reuse the stored 1 of a zero-amount transfer as the rate", async () => {
        accountsService.findOne.mockImplementation((_u: string, id: string) =>
          Promise.resolve(id === "to-account" ? eurTo : mockFromAccount),
        );
        exchangeRateService.getRateForDate.mockResolvedValue(0.9);
        const zeroFrom = { ...usdFromTx, amount: -0 } as unknown as Transaction;
        const zeroTo = {
          ...eurToTx,
          amount: 0,
          exchangeRate: 1,
        } as unknown as Transaction;
        mockFindOne
          .mockResolvedValueOnce(zeroTo)
          .mockResolvedValueOnce(zeroFrom)
          .mockResolvedValueOnce(zeroTo)
          .mockResolvedValueOnce(zeroFrom);

        // A form resends the stored rate with the new amount.
        // By the destination leg's id: a zero amount carries no sign to tell
        // the legs apart.
        await service.updateTransfer(
          "user-1",
          "to-tx",
          { amount: 500, exchangeRate: 1 },
          mockFindOne,
        );

        expect(transactionsRepository.update).toHaveBeenCalledWith(
          "to-tx",
          expect.objectContaining({ exchangeRate: 0.9, amount: 450 }),
        );
      });

      it("resolves a rate for a full form resend of a zero-amount transfer (echoed rate and toAmount)", async () => {
        accountsService.findOne.mockImplementation((_u: string, id: string) =>
          Promise.resolve(id === "to-account" ? eurTo : mockFromAccount),
        );
        exchangeRateService.getRateForDate.mockResolvedValue(0.9);
        const zeroFrom = { ...usdFromTx, amount: -0 } as unknown as Transaction;
        const zeroTo = {
          ...eurToTx,
          amount: 0,
          exchangeRate: 1,
        } as unknown as Transaction;
        mockFindOne
          .mockResolvedValueOnce(zeroTo)
          .mockResolvedValueOnce(zeroFrom)
          .mockResolvedValueOnce(zeroTo)
          .mockResolvedValueOnce(zeroFrom);

        await service.updateTransfer(
          "user-1",
          "to-tx",
          { amount: 500, exchangeRate: 1, toAmount: 0 },
          mockFindOne,
        );

        expect(transactionsRepository.update).toHaveBeenCalledWith(
          "to-tx",
          expect.objectContaining({ exchangeRate: 0.9, amount: 450 }),
        );
      });

      it("refuses moving a leg into a closed account", async () => {
        accountsService.findOne.mockImplementation((_u: string, id: string) =>
          Promise.resolve(
            id === "closed-account"
              ? { id, currencyCode: "USD", isClosed: true }
              : id === "to-account"
                ? eurTo
                : mockFromAccount,
          ),
        );
        mockFindOne
          .mockResolvedValueOnce(usdFromTx)
          .mockResolvedValueOnce(eurToTx);

        await expect(
          service.updateTransfer(
            "user-1",
            "from-tx",
            { fromAccountId: "closed-account" },
            mockFindOne,
          ),
        ).rejects.toThrow(/closed account/);

        expect(transactionsRepository.update).not.toHaveBeenCalled();
      });

      it("leaves the settlement alone on a description-only edit (RR2-004)", async () => {
        // FX was resolved on every edit, and the FR-007 fix then wrote a resolved
        // rate whenever it differed from the row's. So changing a description
        // re-resolved today's 0.80 and stored it beside an unchanged 90 EUR: an
        // internally inconsistent pair produced by an edit that touched no money.
        accountsService.findOne.mockImplementation((_u: string, id: string) =>
          Promise.resolve(id === "to-account" ? eurTo : mockFromAccount),
        );
        exchangeRateService.getRateForDate.mockResolvedValue(0.8);

        mockFindOne
          .mockResolvedValueOnce(usdFromTx)
          .mockResolvedValueOnce(eurToTx)
          .mockResolvedValueOnce(usdFromTx)
          .mockResolvedValueOnce(eurToTx);

        await service.updateTransfer(
          "user-1",
          "from-tx",
          { description: "note" },
          mockFindOne,
        );

        expect(transactionsRepository.update).toHaveBeenCalledWith("to-tx", {
          description: "note",
        });
        expect(accountsService.updateBalance).not.toHaveBeenCalled();
      });

      it("succeeds on a description-only edit when no rate can be resolved", async () => {
        // The other half of the same defect: the unconditional resolver refused a
        // presentation-only edit outright when the pair had no current rate, even
        // though the transfer already held a perfectly good settlement.
        accountsService.findOne.mockImplementation((_u: string, id: string) =>
          Promise.resolve(id === "to-account" ? eurTo : mockFromAccount),
        );
        exchangeRateService.getRateForDate.mockResolvedValue(null);
        exchangeRateService.getLatestRate.mockResolvedValue(null);

        mockFindOne
          .mockResolvedValueOnce(usdFromTx)
          .mockResolvedValueOnce(eurToTx)
          .mockResolvedValueOnce(usdFromTx)
          .mockResolvedValueOnce(eurToTx);

        await expect(
          service.updateTransfer(
            "user-1",
            "from-tx",
            { referenceNumber: "chq-8812" },
            mockFindOne,
          ),
        ).resolves.toBeDefined();

        expect(transactionsRepository.update).toHaveBeenCalledWith("to-tx", {
          referenceNumber: "chq-8812",
        });
      });

      it("still rejects a supplied currency that does not match its account", async () => {
        // Skipping resolution must not skip validation: a mismatched code cannot
        // ride in on a presentation-only edit.
        accountsService.findOne.mockImplementation((_u: string, id: string) =>
          Promise.resolve(id === "to-account" ? eurTo : mockFromAccount),
        );

        mockFindOne
          .mockResolvedValueOnce(usdFromTx)
          .mockResolvedValueOnce(eurToTx);

        await expect(
          service.updateTransfer(
            "user-1",
            "from-tx",
            { description: "note", toCurrencyCode: "GBP" },
            mockFindOne,
          ),
        ).rejects.toThrow(/must match the account currency/);
      });

      it("leaves the settlement alone for a full-form payload of unchanged values (RR3-002)", async () => {
        // The form resends the current accounts, amount and rate on every save.
        // Keying repricing off field *presence* meant this idempotent payload
        // re-resolved today's 0.80 rate, restated the 90 EUR destination as 80,
        // and moved the balance with it -- from an edit that only changed a note.
        // Presence is what the client sent; a difference is what the user changed.
        accountsService.findOne.mockImplementation((_u: string, id: string) =>
          Promise.resolve(id === "to-account" ? eurTo : mockFromAccount),
        );
        exchangeRateService.getRateForDate.mockResolvedValue(0.8);

        mockFindOne
          .mockResolvedValueOnce(usdFromTx)
          .mockResolvedValueOnce(eurToTx)
          .mockResolvedValueOnce(usdFromTx)
          .mockResolvedValueOnce(eurToTx);

        await service.updateTransfer(
          "user-1",
          "from-tx",
          {
            fromAccountId: "from-account",
            toAccountId: "to-account",
            amount: 100,
            toAmount: 90,
            exchangeRate: 0.9,
            description: "updated note",
          } as any,
          mockFindOne,
        );

        // Only the note is written; the settlement is untouched on both rows.
        expect(transactionsRepository.update).toHaveBeenCalledWith("to-tx", {
          description: "updated note",
        });
        expect(transactionsRepository.update).toHaveBeenCalledWith("from-tx", {
          description: "updated note",
        });
        // And no balance churn: an idempotent payload moves nothing.
        expect(accountsService.updateBalance).not.toHaveBeenCalled();
      });

      it("re-prices when the user supplies a rate, writing rate and amount together", async () => {
        // The control: an explicit financial change does re-price, and both tuple
        // members move.
        accountsService.findOne.mockImplementation((_u: string, id: string) =>
          Promise.resolve(id === "to-account" ? eurTo : mockFromAccount),
        );

        mockFindOne
          .mockResolvedValueOnce(usdFromTx)
          .mockResolvedValueOnce(eurToTx)
          .mockResolvedValueOnce(usdFromTx)
          .mockResolvedValueOnce(eurToTx);

        await service.updateTransfer(
          "user-1",
          "from-tx",
          { exchangeRate: 0.8 },
          mockFindOne,
        );

        expect(transactionsRepository.update).toHaveBeenCalledWith(
          "to-tx",
          expect.objectContaining({ exchangeRate: 0.8, amount: 80 }),
        );
      });
    });

    it("handles cross-currency exchange rate update", async () => {
      // Genuinely cross-currency: the destination account is CAD. The rate is
      // applied to derive the destination amount, as before -- but the pair now
      // has to actually differ in currency for a rate to be meaningful, so the
      // fixture says so instead of leaving both accounts USD.
      const cadTo = { ...mockToAccount, currencyCode: "CAD" };
      const cadToTransaction = {
        ...toTransaction,
        account: cadTo,
      } as unknown as Transaction;
      accountsService.findOne.mockImplementation((_u: string, id: string) =>
        Promise.resolve(id === "to-account" ? cadTo : mockFromAccount),
      );

      mockFindOne
        .mockResolvedValueOnce(fromTransaction)
        .mockResolvedValueOnce(cadToTransaction)
        .mockResolvedValueOnce(fromTransaction)
        .mockResolvedValueOnce(cadToTransaction);

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
      );
    });

    it("uses explicit toAmount over calculated amount for a cross-currency pair", async () => {
      // An explicit settlement amount is a bank's real figure, which can differ
      // from spot by fees -- legitimate only when the currencies actually
      // differ. Both accounts were USD here, which made 500 out and 680 in: 180
      // created from nothing (audit P5-002 scenario B). The same-currency case
      // is now its own test below.
      const cadTo = { ...mockToAccount, currencyCode: "CAD" };
      const cadToTransaction = {
        ...toTransaction,
        account: cadTo,
      } as unknown as Transaction;
      accountsService.findOne.mockImplementation((_u: string, id: string) =>
        Promise.resolve(id === "to-account" ? cadTo : mockFromAccount),
      );

      mockFindOne
        .mockResolvedValueOnce(fromTransaction)
        .mockResolvedValueOnce(cadToTransaction)
        .mockResolvedValueOnce(fromTransaction)
        .mockResolvedValueOnce(cadToTransaction);

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

    it("rejects an explicit toAmount that breaks a same-currency transfer", async () => {
      mockFindOne
        .mockResolvedValueOnce(fromTransaction)
        .mockResolvedValueOnce(toTransaction);

      await expect(
        service.updateTransfer(
          "user-1",
          "from-tx",
          { toAmount: 680 },
          mockFindOne,
        ),
      ).rejects.toThrow(/same amount on both sides/);
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

    it("persists a cleared payeeName as null on both legs (issue #1214)", async () => {
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

      // No restamped "Transfer to/from <account>": blank is the persisted
      // state and the label is resolved at read time from the linked leg.
      expect(transactionsRepository.update).toHaveBeenCalledWith(
        "from-tx",
        expect.objectContaining({
          payeeId: null,
          payeeName: null,
        }),
      );
      expect(transactionsRepository.update).toHaveBeenCalledWith(
        "to-tx",
        expect.objectContaining({
          payeeId: null,
          payeeName: null,
        }),
      );
    });

    it("persists an empty-string payeeName as null on both legs (issue #1214)", async () => {
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
        expect.objectContaining({ payeeName: null }),
      );
      expect(transactionsRepository.update).toHaveBeenCalledWith(
        "to-tx",
        expect.objectContaining({ payeeName: null }),
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

    it("clears a legacy auto-generated payeeName when destination account changes and frontend re-sends the old value (issue #1214)", async () => {
      // Simulates the frontend behavior: when editing a legacy stamped
      // transfer, the form re-sends payeeName (the old auto-generated value).
      // The row is healed to null rather than restamped -- the display then
      // resolves the label from the linked leg's current account name.
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
        expect.objectContaining({ payeeName: null }),
      );
    });

    it("heals a legacy stamped payee to null on an ordinary edit (issue #1214)", async () => {
      // A pre-#1214 row still carries "Transfer to <account>" in payee_name
      // (e.g. restored from a backup taken before migration 161). Any edit
      // that reaches the leg clears the stamp -- the display resolves the
      // identical label from the linked account, so nothing changes on
      // screen, but the row stops going stale on the next rename.
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
        .mockResolvedValueOnce(toWithAutoPayee);

      await service.updateTransfer(
        "user-1",
        "from-tx",
        { description: "note" },
        mockFindOne,
      );

      expect(transactionsRepository.update).toHaveBeenCalledWith(
        "from-tx",
        expect.objectContaining({ payeeName: null }),
      );
      expect(transactionsRepository.update).toHaveBeenCalledWith(
        "to-tx",
        expect.objectContaining({ payeeName: null }),
      );
    });

    it("leaves a stale stamp (renamed account) untouched -- indistinguishable from a custom payee", async () => {
      const fromWithStaleStamp = {
        ...fromTransaction,
        payeeId: null,
        // Stamped against a name the destination account no longer has.
        payeeName: "Transfer to Old Savings",
      } as unknown as Transaction;

      mockFindOne
        .mockResolvedValueOnce(fromWithStaleStamp)
        .mockResolvedValueOnce(toTransaction)
        .mockResolvedValueOnce(fromWithStaleStamp)
        .mockResolvedValueOnce(toTransaction);

      await service.updateTransfer(
        "user-1",
        "from-tx",
        { description: "note" },
        mockFindOne,
      );

      const fromCall = transactionsRepository.update.mock.calls.find(
        (c: any[]) => c[0] === "from-tx",
      );
      expect(fromCall[1]).not.toHaveProperty("payeeName");
    });

    it("clears a legacy auto-generated payeeName on the to-side when source account changes", async () => {
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
        expect.objectContaining({ payeeName: null }),
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
        expect(mockQueryRunner.manager.delete).toHaveBeenCalledWith(
          Transaction,
          { id: "to-tx", userId: "user-1" },
        );
        expect(mockQueryRunner.manager.delete).toHaveBeenCalledWith(
          Transaction,
          { id: "from-tx", userId: "user-1" },
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
          "user-1",
          "from-account",
        );
        expect(accountsService.recalculateCurrentBalance).toHaveBeenCalledWith(
          "user-1",
          "to-account",
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
          "user-1",
          "from-account",
        );
        expect(accountsService.recalculateCurrentBalance).toHaveBeenCalledWith(
          "user-1",
          "to-account",
        );
        expect(accountsService.updateBalance).not.toHaveBeenCalled();
      });
    });
  });

  describe("transaction atomicity", () => {
    it("createTransfer runs its writes in a single tenant transaction", async () => {
      transactionsRepository.save
        .mockReset()
        .mockResolvedValueOnce({ id: "from-tx-id" })
        .mockResolvedValueOnce({ id: "to-tx-id" });

      mockFindOne
        .mockResolvedValueOnce({ id: "from-tx-id" })
        .mockResolvedValueOnce({ id: "to-tx-id" });

      await service.createTransfer("user-1", baseTransferDto, mockFindOne);

      // All the writes are grouped into a single tenant transaction.
      expect(mockDataSource.transaction).toHaveBeenCalledTimes(1);
    });

    it("createTransfer propagates write errors so the tenant transaction rolls back", async () => {
      transactionsRepository.save
        .mockReset()
        .mockRejectedValue(new Error("DB error"));

      await expect(
        service.createTransfer("user-1", baseTransferDto, mockFindOne),
      ).rejects.toThrow("DB error");

      // One withScopedDb groups every write; the rejection above is what makes
      // the surrounding transaction roll back.
      expect(mockDataSource.transaction).toHaveBeenCalledTimes(1);
    });

    it("removeTransfer runs its writes in a single tenant transaction", async () => {
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

      // The split-parent lookup is its own short read transaction (as the
      // pre-RLS autocommit read was); every write lands in one withScopedDb.
      expect(mockDataSource.transaction).toHaveBeenCalledTimes(2);
    });

    it("removeTransfer propagates write errors so the tenant transaction rolls back", async () => {
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

      // Lookup + write block; the rejection above is what makes the
      // surrounding write transaction roll back.
      expect(mockDataSource.transaction).toHaveBeenCalledTimes(2);
    });

    it("updateTransfer runs its writes in a single tenant transaction", async () => {
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

      // The split-parent lookup is its own short read transaction (as the
      // pre-RLS autocommit read was); every write lands in one withScopedDb.
      expect(mockDataSource.transaction).toHaveBeenCalledTimes(2);
    });

    it("updateTransfer propagates write errors so the tenant transaction rolls back", async () => {
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

      // Lookup + write block; the rejection above is what makes the
      // surrounding write transaction roll back.
      expect(mockDataSource.transaction).toHaveBeenCalledTimes(2);
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

  describe("transaction rules on a new transfer (design 6.3)", () => {
    it("runs the rules on the leg transaction's manager, after the link and before the balances", async () => {
      mockFindOne
        .mockResolvedValueOnce({ id: "from-tx-id", amount: -500 })
        .mockResolvedValueOnce({ id: "to-tx-id", amount: 500 });

      await service.createTransfer("user-1", baseTransferDto, mockFindOne);

      expect(rulesApplier.applyToNewTransfer).toHaveBeenCalledTimes(1);
      expect(rulesApplier.applyToNewTransfer).toHaveBeenCalledWith(
        mockQueryRunner.manager,
        {
          fromLegId: "from-tx-id",
          toLegId: "to-tx-id",
          fromOwnerId: "user-1",
          toOwnerId: "user-1",
        },
      );
      const rulesAt =
        rulesApplier.applyToNewTransfer.mock.invocationCallOrder[0];
      const lastLinkAt = Math.max(
        ...transactionsRepository.update.mock.invocationCallOrder,
      );
      expect(rulesAt).toBeGreaterThan(lastLinkAt);
      expect(rulesAt).toBeLessThan(
        Math.min(...accountsService.updateBalance.mock.invocationCallOrder),
      );
    });

    it("runs the rules for a VOID transfer too (they never move a balance)", async () => {
      mockFindOne
        .mockResolvedValueOnce({ id: "from-tx-id", amount: -500 })
        .mockResolvedValueOnce({ id: "to-tx-id", amount: 500 });

      await service.createTransfer(
        "user-1",
        { ...baseTransferDto, status: TransactionStatus.VOID },
        mockFindOne,
      );

      expect(rulesApplier.applyToNewTransfer).toHaveBeenCalledTimes(1);
      expect(accountsService.updateBalance).not.toHaveBeenCalled();
    });

    it("joins the caller's manager when one is passed (scheduled posting)", async () => {
      const prepared = await service.prepareTransfer("user-1", baseTransferDto);
      const callerManager = mockQueryRunner.manager;

      await service.writeTransferLegs(prepared, callerManager);

      expect(rulesApplier.applyToNewTransfer.mock.calls[0][0]).toBe(
        callerManager,
      );
    });

    it("hands the applier each leg's owner on a cross-owner transfer", async () => {
      crossOwnerAccess.accountAccessFor.mockImplementation(
        async (_real: string, accountId: string) => ({
          account:
            accountId === "from-account"
              ? mockFromAccount
              : { ...mockToAccount, userId: "owner-2" },
        }),
      );
      mockFindOne
        .mockResolvedValueOnce({ id: "from-tx-id", amount: -500 })
        .mockResolvedValueOnce({ id: "to-tx-id", amount: 500 });

      await service.createTransfer("user-1", baseTransferDto, mockFindOne, {
        effectiveUserId: "user-1",
        realUserId: "user-1",
      });

      expect(rulesApplier.applyToNewTransfer).toHaveBeenCalledWith(
        mockQueryRunner.manager,
        {
          fromLegId: "from-tx-id",
          toLegId: "to-tx-id",
          fromOwnerId: "user-1",
          toOwnerId: "owner-2",
        },
      );
    });

    it("moves no balance and completes nothing when the rule step fails (the transaction rolls back)", async () => {
      rulesApplier.applyToNewTransfer.mockRejectedValue(new Error("rule boom"));

      await expect(
        service.createTransfer("user-1", baseTransferDto, mockFindOne),
      ).rejects.toThrow("rule boom");

      expect(accountsService.updateBalance).not.toHaveBeenCalled();
      expect(actionHistoryService.record).not.toHaveBeenCalled();
    });

    it("previewCreateTransfer carries the planner's ruleEffects, and omits the key when nothing matches", async () => {
      const plan = { changes: { addTagIds: ["t1"] }, labels: {} };
      rulesApplier.previewForRow.mockResolvedValue(plan);

      const withRules = await service.previewCreateTransfer("user-1", {
        fromAccountId: "from-account",
        toAccountId: "to-account",
        amount: 100,
        transactionDate: "2026-01-15",
        payeeName: "Rent",
      });

      expect(withRules.ruleEffects).toBe(plan);
      expect(rulesApplier.previewForRow).toHaveBeenCalledWith(
        mockQueryRunner.manager,
        "user-1",
        expect.objectContaining({
          accountId: "from-account",
          amount: -100,
          isTransfer: true,
          fromAccountId: "from-account",
          toAccountId: "to-account",
          payeeText: "Rent",
          tagIds: [],
          hasSplits: false,
          // A new row: no reference number, the stored calendar date, the
          // default status and no attachment (design 10.3).
          referenceNumber: null,
          transactionDate: "2026-01-15",
          status: TransactionStatus.UNRECONCILED,
          hasAttachment: false,
        }),
      );

      rulesApplier.previewForRow.mockResolvedValue(null);
      const without = await service.previewCreateTransfer("user-1", {
        fromAccountId: "from-account",
        toAccountId: "to-account",
        amount: 100,
        transactionDate: "2026-01-15",
      });
      expect("ruleEffects" in without).toBe(false);
    });
  });

  describe("previewCreateTransfer and createTransfer plan the same effects on the X3 facts", () => {
    const TAG = {
      ref: "00000000-0000-4000-8000-000000000001",
      day: "00000000-0000-4000-8000-000000000002",
      weekday: "00000000-0000-4000-8000-000000000003",
      status: "00000000-0000-4000-8000-000000000004",
      unreconciled: "00000000-0000-4000-8000-000000000005",
      noattachment: "00000000-0000-4000-8000-000000000006",
    };
    const tagRule = (
      id: string,
      condition: RuleConditionLeaf,
    ): PlannableRule => ({
      id,
      enabled: true,
      stopProcessing: false,
      condition: { all: [condition] },
      actions: [{ type: "add_tags", tagIds: [TAG[id as keyof typeof TAG]] }],
    });
    const rules: PlannableRule[] = [
      tagRule("ref", { field: "referenceNumber", op: "eq", value: "CHQ-1" }),
      tagRule("day", { field: "dayOfMonth", op: "eq", value: 15 }),
      tagRule("weekday", { field: "weekday", op: "eq", value: "THU" }),
      tagRule("status", { field: "status", op: "eq", value: "CLEARED" }),
      tagRule("unreconciled", {
        field: "status",
        op: "eq",
        value: "UNRECONCILED",
      }),
      tagRule("noattachment", {
        field: "hasAttachment",
        op: "eq",
        value: false,
      }),
    ];

    it.each([
      [
        "a reference number, a CLEARED status and a Thursday the 15th",
        { referenceNumber: "CHQ-1", status: TransactionStatus.CLEARED },
        [TAG.ref, TAG.day, TAG.weekday, TAG.status, TAG.noattachment],
      ],
      [
        "no reference number and no status (the default)",
        {},
        [TAG.day, TAG.weekday, TAG.unreconciled, TAG.noattachment],
      ],
    ])("for %s", async (_label, extra, expected) => {
      let preview: string[] | undefined;
      let commit: string[] | undefined;
      rulesApplier.previewForRow.mockImplementation(
        async (_m: unknown, _user: string, input: RuleFactsInput) => {
          preview = planRuleEffects(
            buildRuleFacts(input),
            rules,
          ).changes.addTagIds.slice();
          return null;
        },
      );
      // The commit plans over the outgoing leg as stored: the first row
      // writeTransferLegs creates, with the database's defaults applied.
      rulesApplier.applyToNewTransfer.mockImplementation(async () => {
        const stored = transactionsRepository.create.mock.calls[0][0];
        commit = planRuleEffects(
          buildRuleFacts({
            accountId: stored.accountId,
            currencyCode: stored.currencyCode,
            amount: stored.amount,
            isTransfer: true,
            fromAccountId: "from-account",
            toAccountId: "to-account",
            payeeId: stored.payeeId ?? null,
            payeeText: stored.payeeName ?? null,
            categoryId: stored.categoryId ?? null,
            description: stored.description ?? null,
            tagIds: [],
            hasSplits: false,
            referenceNumber: stored.referenceNumber ?? null,
            transactionDate: stored.transactionDate,
            status: stored.status ?? TransactionStatus.UNRECONCILED,
            hasAttachment: false,
          }),
          rules,
        ).changes.addTagIds.slice();
        return [];
      });
      mockFindOne
        .mockResolvedValueOnce({ id: "from-tx-id", amount: -500 })
        .mockResolvedValueOnce({ id: "to-tx-id", amount: 500 });
      const dto = { ...baseTransferDto, ...extra };

      await service.previewCreateTransfer("user-1", dto);
      await service.createTransfer("user-1", dto, mockFindOne);

      expect(preview).toEqual(expected);
      expect(commit).toEqual(preview);
    });
  });

  describe("previewCreateTransfer", () => {
    // A rate other than 1 only means something across currencies, so these use a
    // CAD destination account. The preview resolves the rate through the same
    // path the commit does, so it cannot show a figure the commit will not post.
    const withCadDestination = () => {
      const cadTo = { ...mockToAccount, currencyCode: "CAD" };
      accountsService.findOne.mockImplementation((_u: string, id: string) =>
        Promise.resolve(id === "to-account" ? cadTo : mockFromAccount),
      );
    };

    it("resolves accounts, derives currencies, and computes toAmount from exchangeRate", async () => {
      withCadDestination();
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
        toCurrencyCode: "CAD",
        amount: 100,
        toAmount: 125,
        exchangeRate: 1.25,
        transactionDate: "2026-01-15",
        description: null,
        payeeName: null,
      });
    });

    it("previews the same destination amount the commit would post", async () => {
      // With no rate supplied, the preview resolves one rather than showing the
      // source amount unchanged. A preview reading 100 CAD for 100 USD is the
      // divergence audit P5-005 describes: the user approves one figure and the
      // commit stores another.
      withCadDestination();
      exchangeRateService.getRateForDate.mockResolvedValue(1.4);

      const preview = await service.previewCreateTransfer("user-1", {
        fromAccountId: "from-account",
        toAccountId: "to-account",
        amount: 100,
        transactionDate: "2026-01-15",
      });

      expect(preview.toAmount).toBe(140);
      expect(preview.exchangeRate).toBe(1.4);
    });

    it("uses an explicit toAmount over the exchange rate and strips html from description", async () => {
      withCadDestination();
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

    it("defaults category to null when no categoryId is given", async () => {
      const preview = await service.previewCreateTransfer("user-1", {
        fromAccountId: "from-account",
        toAccountId: "to-account",
        amount: 100,
        transactionDate: "2026-01-15",
      });
      expect(preview.categoryId).toBeNull();
      expect(preview.categoryName).toBeNull();
      expect(categoriesRepository.findOne).not.toHaveBeenCalled();
    });

    it("resolves an owned categoryId to its id and name", async () => {
      categoriesRepository.findOne.mockResolvedValue({
        id: "cat-1",
        name: "Savings Goal",
        userId: "user-1",
      });
      const preview = await service.previewCreateTransfer("user-1", {
        fromAccountId: "from-account",
        toAccountId: "to-account",
        amount: 100,
        transactionDate: "2026-01-15",
        categoryId: "cat-1",
      });
      expect(categoriesRepository.findOne).toHaveBeenCalledWith({
        where: { id: "cat-1", userId: "user-1" },
      });
      expect(preview.categoryId).toBe("cat-1");
      expect(preview.categoryName).toBe("Savings Goal");
    });

    it("rejects a categoryId the user does not own", async () => {
      categoriesRepository.findOne.mockResolvedValue(null);
      await expect(
        service.previewCreateTransfer("user-1", {
          fromAccountId: "from-account",
          toAccountId: "to-account",
          amount: 100,
          transactionDate: "2026-01-15",
          categoryId: "cat-x",
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

    it("resolves the rate for a zero-amount cross-currency transfer instead of scaling by its stored 1", async () => {
      // Stored at rate 1 because zero needs no rate; 500 USD must not become
      // 500 EUR in the preview the AI action signs.
      accountsService.findOne.mockImplementation((_u: string, id: string) =>
        Promise.resolve({
          id,
          currencyCode: id === "to-account" ? "EUR" : "USD",
        }),
      );
      exchangeRateService.getRateForDate.mockResolvedValue(0.9);
      const findOne = jest.fn(async (_uid: string, id: string) =>
        id === "from-tx"
          ? { ...fromLeg, amount: -0 }
          : { ...toLeg, amount: 0, currencyCode: "EUR", exchangeRate: 1 },
      );

      const preview = await service.previewUpdateTransfer(
        "user-1",
        "to-tx",
        { amount: 500 },
        findOne as any,
      );

      expect(preview).toMatchObject({
        amount: 500,
        toAmount: 450,
        exchangeRate: 0.9,
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

    it("keeps the existing from-leg category when categoryId is omitted", async () => {
      const findOne = jest.fn(async (_uid: string, id: string) =>
        id === "from-tx"
          ? {
              ...fromLeg,
              categoryId: "cat-existing",
              category: { name: "Existing" },
            }
          : toLeg,
      );
      const preview = await service.previewUpdateTransfer(
        "user-1",
        "from-tx",
        { amount: 200 },
        findOne as any,
      );
      expect(preview.categoryId).toBe("cat-existing");
      expect(preview.categoryName).toBe("Existing");
      expect(categoriesRepository.findOne).not.toHaveBeenCalled();
    });

    it("resolves and validates a new category, returning its name", async () => {
      categoriesRepository.findOne.mockResolvedValue({
        id: "cat-1",
        name: "Investments: IKE",
      });
      const findOne = jest.fn(async (_uid: string, id: string) =>
        id === "from-tx" ? fromLeg : toLeg,
      );
      const preview = await service.previewUpdateTransfer(
        "user-1",
        "from-tx",
        { categoryId: "cat-1" },
        findOne as any,
      );
      expect(categoriesRepository.findOne).toHaveBeenCalledWith({
        where: { id: "cat-1", userId: "user-1" },
      });
      expect(preview.categoryId).toBe("cat-1");
      expect(preview.categoryName).toBe("Investments: IKE");
    });

    it("clears the category when categoryId is null", async () => {
      const findOne = jest.fn(async (_uid: string, id: string) =>
        id === "from-tx"
          ? {
              ...fromLeg,
              categoryId: "cat-existing",
              category: { name: "Existing" },
            }
          : toLeg,
      );
      const preview = await service.previewUpdateTransfer(
        "user-1",
        "from-tx",
        { categoryId: null },
        findOne as any,
      );
      expect(preview.categoryId).toBeNull();
      expect(preview.categoryName).toBeNull();
      expect(categoriesRepository.findOne).not.toHaveBeenCalled();
    });

    it("rejects a category that does not belong to the user", async () => {
      categoriesRepository.findOne.mockResolvedValue(null);
      const findOne = jest.fn(async (_uid: string, id: string) =>
        id === "from-tx" ? fromLeg : toLeg,
      );
      await expect(
        service.previewUpdateTransfer(
          "user-1",
          "from-tx",
          { categoryId: "cat-x" },
          findOne as any,
        ),
      ).rejects.toThrow(BadRequestException);
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

  describe("cross-owner update / remove / linked (frozen-link spec)", () => {
    const actor = { effectiveUserId: "user-1", realUserId: "user-1" };
    const foreignAccount = {
      id: "to-account",
      name: "Owner Savings",
      currencyCode: "USD",
      userId: "owner-2",
    };

    let ownLeg: any;
    let foreignLeg: any;

    beforeEach(() => {
      ownLeg = {
        id: "own-leg",
        userId: "user-1",
        accountId: "from-account",
        amount: -500,
        exchangeRate: 1,
        transactionDate: "2026-01-15",
        currencyCode: "USD",
        isTransfer: true,
        linkedTransactionId: "foreign-leg",
        payeeId: null,
        payeeName: "Transfer to Owner Savings",
        account: mockFromAccount,
      };
      foreignLeg = {
        id: "foreign-leg",
        userId: "owner-2",
        accountId: "to-account",
        amount: 500,
        exchangeRate: 1,
        transactionDate: "2026-01-15",
        currencyCode: "USD",
        isTransfer: true,
        linkedTransactionId: "own-leg",
        payeeId: null,
        payeeName: "Transfer from Checking",
        account: foreignAccount,
      };

      // Owner-scoped findOne: the effective user reaches only their own leg.
      mockFindOne.mockImplementation(async (userId: string, id: string) => {
        if (userId === "user-1" && id === "own-leg") return ownLeg;
        if (userId === "owner-2" && id === "foreign-leg") return foreignLeg;
        throw new NotFoundException("Transaction not found");
      });

      // loadLegById's unscoped read.
      transactionsRepository.findOne.mockImplementation(async (opts: any) =>
        opts?.where?.id === "foreign-leg" ? foreignLeg : null,
      );

      mockedWithSystemContext.mockClear();
    });

    const connect = () =>
      crossOwnerAccess.accountAccessFor.mockResolvedValue({
        account: foreignAccount,
        ownerUserId: "owner-2",
        via: "delegation",
      });

    const freeze = () =>
      crossOwnerAccess.accountAccessFor.mockRejectedValue(
        new NotFoundException("Account not found"),
      );

    const denyOp = () =>
      crossOwnerAccess.accountAccessFor.mockRejectedValue(
        new ForbiddenException("not granted"),
      );

    describe("updateTransfer (connected)", () => {
      beforeEach(connect);

      it("moves only the effective user's balance when only their status changes (FR-001)", async () => {
        // Status is per-ledger and stays off the foreign leg -- but it is not
        // presentational for this leg's own balance. `amountsChanged` omitted
        // status entirely, so voiding your own side of a delegated transfer wrote
        // VOID and left the balance carrying the money. The next recompute then
        // changed the account with no user action behind it.
        await service.updateTransfer(
          "user-1",
          "own-leg",
          { status: TransactionStatus.VOID },
          mockFindOne,
          actor,
        );

        // The own leg's -500 contribution is removed: +500 back to its account.
        expect(accountsService.updateBalance).toHaveBeenCalledWith(
          "from-account",
          500,
        );
        // The foreign leg keeps its owner's status, so its balance is untouched.
        expect(accountsService.updateBalance).not.toHaveBeenCalledWith(
          "to-account",
          expect.anything(),
        );
        expect(accountsService.updateBalance).toHaveBeenCalledTimes(1);
      });

      it("restores the balance when the effective user unvoids their leg", async () => {
        ownLeg.status = TransactionStatus.VOID;

        await service.updateTransfer(
          "user-1",
          "own-leg",
          { status: TransactionStatus.UNRECONCILED },
          mockFindOne,
          actor,
        );

        expect(accountsService.updateBalance).toHaveBeenCalledWith(
          "from-account",
          -500,
        );
        expect(accountsService.updateBalance).toHaveBeenCalledTimes(1);
      });

      // RR2-001: cross-owner status is per-ledger, so the two legs can sit in any
      // of the four VOID combinations. The FR-001 fix used the acting leg's state
      // to decide both ledgers, which is right in two of the four and silently
      // wrong in the other two.
      describe("structural edits with asymmetric VOID states (RR2-001)", () => {
        it("moves the foreign balance when only the acting leg is VOID", async () => {
          ownLeg.status = TransactionStatus.VOID;
          // The foreign leg is active and does contribute +500 to its account.

          await service.updateTransfer(
            "user-1",
            "own-leg",
            { amount: 600 },
            mockFindOne,
            actor,
          );

          // Both persisted rows follow the new amount. The legacy stamped
          // payee on each leg is healed to null (issue #1214) -- the label
          // resolves at read time from the linked leg's account.
          expect(transactionsRepository.update).toHaveBeenCalledWith(
            "own-leg",
            {
              amount: -600,
              payeeName: null,
            },
          );
          expect(transactionsRepository.update).toHaveBeenCalledWith(
            "foreign-leg",
            { amount: 600, payeeName: null },
          );
          // The acting leg is excluded, so its account never moves.
          expect(accountsService.updateBalance).not.toHaveBeenCalledWith(
            "from-account",
            expect.anything(),
          );
          // The foreign leg is included, so its old contribution is reversed and
          // the new one applied. Leaving it at +500 beside a +600 active row put
          // the balance 100 behind its own ledger, and the next full recompute
          // moved the account with no user action behind it.
          expect(accountsService.updateBalance).toHaveBeenCalledWith(
            "to-account",
            -500,
          );
          expect(accountsService.updateBalance).toHaveBeenCalledWith(
            "to-account",
            600,
          );
        });

        it("leaves the foreign balance alone when only the foreign leg is VOID", async () => {
          foreignLeg.status = TransactionStatus.VOID;

          await service.updateTransfer(
            "user-1",
            "own-leg",
            { amount: 600 },
            mockFindOne,
            actor,
          );

          // The acting leg is included: reversed and re-applied.
          expect(accountsService.updateBalance).toHaveBeenCalledWith(
            "from-account",
            500,
          );
          expect(accountsService.updateBalance).toHaveBeenCalledWith(
            "from-account",
            -600,
          );
          // The foreign row is excluded, so moving its account would create money
          // the void withheld.
          expect(accountsService.updateBalance).not.toHaveBeenCalledWith(
            "to-account",
            expect.anything(),
          );
        });

        it("moves nothing when both legs are VOID", async () => {
          ownLeg.status = TransactionStatus.VOID;
          foreignLeg.status = TransactionStatus.VOID;

          await service.updateTransfer(
            "user-1",
            "own-leg",
            { amount: 600 },
            mockFindOne,
            actor,
          );

          expect(transactionsRepository.update).toHaveBeenCalledWith(
            "own-leg",
            {
              amount: -600,
              payeeName: null,
            },
          );
          expect(accountsService.updateBalance).not.toHaveBeenCalled();
        });
      });

      it("rejects an unconserved same-currency edit (FR-004)", async () => {
        // This path computed `newToAmount` for itself, so every rule
        // resolveTransferFx enforces was reachable again through a delegated
        // transfer: 100 out and 80 in between two USD accounts destroyed 20.
        await expect(
          service.updateTransfer(
            "user-1",
            "own-leg",
            { amount: 100, toAmount: 80 },
            mockFindOne,
            actor,
          ),
        ).rejects.toThrow(/same amount on both sides/);

        expect(accountsService.updateBalance).not.toHaveBeenCalled();
      });

      it("mirrors the amount across both legs and rebalances both accounts under system context", async () => {
        await service.updateTransfer(
          "user-1",
          "own-leg",
          { amount: 600 },
          mockFindOne,
          actor,
        );

        expect(mockedWithSystemContext).toHaveBeenCalled();
        expect(transactionsRepository.update).toHaveBeenCalledWith("own-leg", {
          amount: -600,
          payeeName: null,
        });
        expect(transactionsRepository.update).toHaveBeenCalledWith(
          "foreign-leg",
          { amount: 600, payeeName: null },
        );
        // Old amounts reversed, new applied.
        expect(accountsService.updateBalance).toHaveBeenCalledWith(
          "from-account",
          500,
        );
        expect(accountsService.updateBalance).toHaveBeenCalledWith(
          "to-account",
          -500,
        );
        expect(accountsService.updateBalance).toHaveBeenCalledWith(
          "from-account",
          -600,
        );
        expect(accountsService.updateBalance).toHaveBeenCalledWith(
          "to-account",
          600,
        );
        expect(netWorthService.triggerDebouncedRecalc).toHaveBeenCalledWith(
          "from-account",
          "user-1",
        );
        expect(netWorthService.triggerDebouncedRecalc).toHaveBeenCalledWith(
          "to-account",
          "owner-2",
        );
      });

      it("requires the edit grant for the REAL user on the counterpart account", async () => {
        await service.updateTransfer(
          "user-1",
          "own-leg",
          { description: "note" },
          mockFindOne,
          { effectiveUserId: "user-1", realUserId: "real-9" },
        );
        expect(crossOwnerAccess.accountAccessFor).toHaveBeenCalledWith(
          "real-9",
          "to-account",
          "edit",
        );
      });

      it("keeps status, category and payee off the foreign leg", async () => {
        await service.updateTransfer(
          "user-1",
          "own-leg",
          {
            status: "CLEARED" as any,
            categoryId: "cat-1",
            payeeId: "payee-1",
            description: "shared note",
          },
          mockFindOne,
          actor,
        );

        expect(transactionsRepository.update).toHaveBeenCalledWith("own-leg", {
          status: "CLEARED",
          categoryId: "cat-1",
          payeeId: "payee-1",
          description: "shared note",
        });
        // The foreign leg mirrors only the shared fields.
        expect(transactionsRepository.update).toHaveBeenCalledWith(
          "foreign-leg",
          { description: "shared note" },
        );
      });

      it("rejects account moves with crossOwnerAccountMoveLocked", async () => {
        await expect(
          service.updateTransfer(
            "user-1",
            "own-leg",
            { toAccountId: "somewhere-else" },
            mockFindOne,
            actor,
          ),
        ).rejects.toThrow(/cannot be moved/);
        expect(transactionsRepository.update).not.toHaveBeenCalled();
      });

      it("loads each result leg as its owner", async () => {
        const result = await service.updateTransfer(
          "user-1",
          "own-leg",
          { description: "x" },
          mockFindOne,
          actor,
        );
        expect(result.fromTransaction.id).toBe("own-leg");
        expect(result.toTransaction.id).toBe("foreign-leg");
        expect(mockFindOne).toHaveBeenCalledWith("owner-2", "foreign-leg");
      });
    });

    describe("updateTransfer (frozen)", () => {
      beforeEach(freeze);

      it("moves the own balance when the frozen leg is voided (FR-001)", async () => {
        // The frozen path treats status as an own-leg presentational field, which
        // is right for the counterpart and wrong for the balance: VOID excludes
        // the row from recalculateCurrentBalance and every report, so writing it
        // without moving the balance leaves the two disagreeing.
        await service.updateTransfer(
          "user-1",
          "own-leg",
          { status: TransactionStatus.VOID },
          mockFindOne,
          actor,
        );

        expect(accountsService.updateBalance).toHaveBeenCalledWith(
          "from-account",
          500,
        );
        expect(accountsService.updateBalance).toHaveBeenCalledTimes(1);
      });

      it("does not move the balance for a non-VOID status change", async () => {
        await service.updateTransfer(
          "user-1",
          "own-leg",
          { status: TransactionStatus.CLEARED },
          mockFindOne,
          actor,
        );

        expect(accountsService.updateBalance).not.toHaveBeenCalled();
      });

      it("allows presentational own-leg edits without touching the counterpart or balances", async () => {
        const result = await service.updateTransfer(
          "user-1",
          "own-leg",
          {
            description: "mine",
            status: "CLEARED" as any,
            categoryId: "cat-1",
          },
          mockFindOne,
          actor,
        );

        expect(transactionsRepository.update).toHaveBeenCalledTimes(1);
        expect(transactionsRepository.update).toHaveBeenCalledWith("own-leg", {
          description: "mine",
          status: "CLEARED",
          categoryId: "cat-1",
        });
        expect(accountsService.updateBalance).not.toHaveBeenCalled();
        // Own leg returned in both slots -- nothing mirrored.
        expect(result.fromTransaction.id).toBe("own-leg");
        expect(result.toTransaction.id).toBe("own-leg");
      });

      it("accepts resent-but-unchanged structural fields", async () => {
        await expect(
          service.updateTransfer(
            "user-1",
            "own-leg",
            {
              amount: 500,
              transactionDate: "2026-01-15",
              fromAccountId: "from-account",
              toAccountId: "to-account",
              description: "still fine",
            },
            mockFindOne,
            actor,
          ),
        ).resolves.toBeDefined();
      });

      it.each([
        [{ amount: 999 }],
        [{ transactionDate: "2026-02-01" }],
        [{ toAccountId: "elsewhere" }],
        [{ exchangeRate: 2 }],
        [{ toAmount: 750 }],
      ])(
        "rejects the structural change %j with crossOwnerTransferLocked",
        async (dto) => {
          await expect(
            service.updateTransfer(
              "user-1",
              "own-leg",
              dto as any,
              mockFindOne,
              actor,
            ),
          ).rejects.toThrow(/locked/);
          expect(transactionsRepository.update).not.toHaveBeenCalled();
          expect(accountsService.updateBalance).not.toHaveBeenCalled();
        },
      );

      it("propagates 403 when the counterpart is readable but edit is not granted", async () => {
        denyOp();
        await expect(
          service.updateTransfer(
            "user-1",
            "own-leg",
            { description: "x" },
            mockFindOne,
            actor,
          ),
        ).rejects.toThrow(ForbiddenException);
      });
    });

    describe("removeTransfer (cross-owner)", () => {
      it("connected: removes both legs and reverses both balances under system context", async () => {
        connect();

        await service.removeTransfer("user-1", "own-leg", mockFindOne, actor);

        expect(crossOwnerAccess.accountAccessFor).toHaveBeenCalledWith(
          "user-1",
          "to-account",
          "delete",
        );
        // Each leg is deleted conditionally, keyed on its own owner, and only the
        // winner of that delete reverses a balance (audit FV4-002).
        expect(mockQueryRunner.manager.delete).toHaveBeenCalledWith(
          Transaction,
          { id: "foreign-leg", userId: "owner-2" },
        );
        expect(mockQueryRunner.manager.delete).toHaveBeenCalledWith(
          Transaction,
          { id: "own-leg", userId: "user-1" },
        );
        expect(transactionsRepository.remove).not.toHaveBeenCalled();
        expect(accountsService.updateBalance).toHaveBeenCalledWith(
          "to-account",
          -500,
        );
        expect(accountsService.updateBalance).toHaveBeenCalledWith(
          "from-account",
          500,
        );
        expect(netWorthService.triggerDebouncedRecalc).toHaveBeenCalledWith(
          "to-account",
          "owner-2",
        );
      });

      it("frozen: removes the own leg only and reverses only the own balance", async () => {
        freeze();

        await service.removeTransfer("user-1", "own-leg", mockFindOne, actor);

        expect(mockQueryRunner.manager.delete).toHaveBeenCalledTimes(1);
        expect(mockQueryRunner.manager.delete).toHaveBeenCalledWith(
          Transaction,
          { id: "own-leg", userId: "user-1" },
        );
        expect(transactionsRepository.remove).not.toHaveBeenCalled();
        expect(accountsService.updateBalance).toHaveBeenCalledTimes(1);
        expect(accountsService.updateBalance).toHaveBeenCalledWith(
          "from-account",
          500,
        );
      });

      it("propagates 403 when the counterpart is readable but delete is not granted", async () => {
        denyOp();
        await expect(
          service.removeTransfer("user-1", "own-leg", mockFindOne, actor),
        ).rejects.toThrow(ForbiddenException);
        expect(transactionsRepository.remove).not.toHaveBeenCalled();
      });
    });

    describe("getLinkedTransaction (cross-owner)", () => {
      it("returns the counterpart when the real user can read its account", async () => {
        connect();
        const result = await service.getLinkedTransaction(
          "user-1",
          "own-leg",
          mockFindOne,
          actor,
        );
        expect(result).toBe(foreignLeg);
        expect(crossOwnerAccess.accountAccessFor).toHaveBeenCalledWith(
          "user-1",
          "to-account",
          "read",
        );
      });

      it("returns null when the counterpart account is unreadable", async () => {
        freeze();
        const result = await service.getLinkedTransaction(
          "user-1",
          "own-leg",
          mockFindOne,
          actor,
        );
        expect(result).toBeNull();
      });
    });
  });
});
