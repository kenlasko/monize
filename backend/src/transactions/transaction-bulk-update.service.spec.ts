import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, ConflictException } from "@nestjs/common";
import { TransactionBulkUpdateService } from "./transaction-bulk-update.service";
import { buildTransactionSearchWhere } from "./transaction-search.util";
import {
  parseTransactionSearch,
  SearchFormats,
} from "./transaction-search-query.util";
import { Transaction, TransactionStatus } from "./entities/transaction.entity";
import { Category } from "../categories/entities/category.entity";
import { Payee } from "../payees/entities/payee.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { AccountsService } from "../accounts/accounts.service";
import { NetWorthService } from "../net-worth/net-worth.service";
import { TagsService } from "../tags/tags.service";
import { TransactionSplitService } from "./transaction-split.service";
import { ActionHistoryService } from "../action-history/action-history.service";
import { BulkUpdateDto, BulkDeleteDto } from "./dto/bulk-update.dto";
import { Brackets, DataSource } from "typeorm";
import { lockTransactionRows } from "../common/db/locks";
import {
  lockedTransactionRow,
  stubLockedTransactions,
} from "../test-helpers/locks-testing";
import {
  createScopedDbMocks,
  DataSourceMock,
} from "../test-helpers/scoped-db-testing";

/**
 * The condition and parameters the search helper adds for `raw`, at the
 * split grain every call site uses (advanced-search plan, question 5).
 */
function expectedSearch(
  raw: string,
  aliases: { transaction: string; splits: string; paramPrefix?: string },
  formats: SearchFormats = {},
): [string, Record<string, unknown>] {
  const clause = buildTransactionSearchWhere(
    parseTransactionSearch(raw, formats).terms,
    { paramPrefix: "srch", ...aliases, grain: "split" },
  );
  if (!clause) throw new Error(`no search clause for ${raw}`);
  return [clause.sql, clause.params];
}

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

// Balance deltas are derived from rows locked inside the write transaction, not
// from the pre-read: a row a concurrent request already deleted must not get a
// reversal (audit P4-003). The double below feeds those readers from the same
// fixtures the pre-read returns.
jest.mock("../common/db/locks", () =>
  jest.requireActual("../test-helpers/locks-testing").locksMockModule(),
);

jest.mock("../common/date-utils", () => ({
  ...jest.requireActual("../common/date-utils"),
  isTransactionInFuture: jest.fn().mockReturnValue(false),
  todayYMD: jest.fn(jest.requireActual("../common/date-utils").todayYMD),
}));

describe("TransactionBulkUpdateService", () => {
  let service: TransactionBulkUpdateService;
  let transactionsRepository: Record<string, jest.Mock>;
  let categoriesRepository: Record<string, jest.Mock>;
  let payeesRepository: Record<string, jest.Mock>;
  let userPreferenceRepository: Record<string, jest.Mock>;
  let accountsService: Record<string, jest.Mock>;
  let netWorthService: Record<string, jest.Mock>;
  let tagsService: Record<string, jest.Mock>;
  let splitService: Record<string, jest.Mock>;
  let actionHistoryService: Record<string, jest.Mock>;
  let mockDataSource: DataSourceMock;
  let mockManagerCreateQueryBuilder: jest.Mock;
  let mockManagerGetRepository: jest.Mock;
  let mockManagerFind: jest.Mock;
  let mockManagerQuery: jest.Mock;

  const userId = "user-1";

  /**
   * Every transaction a test builds, by id.
   *
   * The locked readers are served from this, so a test that builds its fixtures
   * with `makeTransaction` automatically has them as the *committed* rows the
   * write transaction locks -- which is what the pre-transaction read used to be
   * trusted for. A test that wants the rows to disagree calls `stageLocked`.
   */
  let builtTransactions: Map<string, Transaction>;

  const makeTransaction = (
    overrides: Partial<Transaction> = {},
  ): Transaction => {
    const built = {
      id: "tx-1",
      userId,
      accountId: "account-1",
      amount: 100,
      status: TransactionStatus.UNRECONCILED,
      transactionDate: "2026-01-15",
      currencyCode: "CAD",
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
    builtTransactions.set(built.id, built);
    stageLocked([...builtTransactions.values()]);
    return built;
  };

  /**
   * Stage `transactions` as the rows the write transaction locks.
   *
   * Both bulk paths derive their balance deltas from these, not from the read
   * that happened before the transaction opened -- a row another request deleted
   * in the meantime is simply absent and gets no reversal.
   */
  const stageLocked = (transactions: Transaction[]): void => {
    stubLockedTransactions(
      {
        lockTransactionRow: jest.fn(),
        lockTransactionRows: lockTransactionRows as jest.Mock,
      },
      transactions.map((t) =>
        lockedTransactionRow({
          id: t.id,
          accountId: t.accountId,
          amount: Number(t.amount),
          transactionDate: String(t.transactionDate),
          status: t.status,
          isSplit: t.isSplit,
          linkedTransactionId: t.linkedTransactionId ?? null,
        }),
      ),
    );
  };

  const createMockQueryBuilder = (
    overrides: Record<string, jest.Mock> = {},
  ) => ({
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    setParameter: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue([]),
    getRawMany: jest.fn().mockResolvedValue([]),
    execute: jest.fn().mockResolvedValue({ affected: 0 }),
    ...overrides,
  });

  beforeEach(async () => {
    builtTransactions = new Map();
    transactionsRepository = {
      createQueryBuilder: jest.fn().mockImplementation(() =>
        createMockQueryBuilder({
          getMany: jest.fn().mockResolvedValue([]),
        }),
      ),
    };

    categoriesRepository = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
    };

    payeesRepository = {
      findOne: jest.fn().mockResolvedValue(null),
    };

    userPreferenceRepository = {
      findOne: jest.fn().mockResolvedValue(null),
    };

    accountsService = {
      updateBalance: jest.fn().mockResolvedValue(undefined),
      recalculateCurrentBalance: jest.fn().mockResolvedValue(undefined),
    };

    netWorthService = {
      recalculateAccount: jest.fn().mockResolvedValue(undefined),
      triggerDebouncedRecalc: jest.fn(),
    };

    splitService = {
      // The real method returns the accounts it moved, so its callers can invalidate
      // their net-worth snapshots (recheck RR4-003). A mock returning `undefined`
      // describes a contract the service no longer has.
      applyParentStatusToTransferCounterparts: jest
        .fn()
        .mockResolvedValue(new Set<string>()),
      // Split-line recategorization: default "no lines changed", the shape the
      // real method returns for a batch with no matching category-kind lines.
      bulkRecategorizeCategorySplits: jest.fn().mockResolvedValue([]),
      // Takes the holdings advisory lock for the parents' embedded investment
      // rows; the real method resolves to nothing.
      lockEmbeddedInvestmentScopes: jest.fn().mockResolvedValue(undefined),
      // Returns the accounts its cleanup moved, like the real method.
      deleteSplitSideEffects: jest.fn().mockResolvedValue(new Set<string>()),
      // The post-commit bond price recompute (INV-BOND-005).
      recomputeBondPricesAfterWrite: jest.fn().mockResolvedValue(undefined),
    };

    tagsService = {
      setTransactionTags: jest.fn().mockResolvedValue(undefined),
      setTransactionTagsBulk: jest.fn().mockResolvedValue(undefined),
      setSplitTagsBulk: jest.fn().mockResolvedValue(undefined),
    };

    actionHistoryService = {
      record: jest.fn().mockResolvedValue(null),
    };

    // withScopedDb EntityManager with createQueryBuilder and entity-routed
    // getRepository.
    mockManagerCreateQueryBuilder = jest.fn();
    mockManagerFind = jest.fn().mockResolvedValue([]);
    // Entities with their own mock repositories route to them; anything else
    // (notably Transaction) falls back to a generic empty query builder.
    const routedRepos = new Map<unknown, Record<string, jest.Mock>>([
      [Transaction, transactionsRepository],
      [Category, categoriesRepository],
      [Payee, payeesRepository],
      [UserPreference, userPreferenceRepository],
    ]);
    mockManagerGetRepository = jest.fn().mockImplementation((entity: any) => {
      const routed = routedRepos.get(entity);
      if (routed) return routed;
      return {
        createQueryBuilder: jest.fn().mockReturnValue(
          createMockQueryBuilder({
            getMany: jest.fn().mockResolvedValue([]),
          }),
        ),
      };
    });

    const tenantMocks = createScopedDbMocks();
    mockDataSource = tenantMocks.dataSource;
    const manager = tenantMocks.manager;
    manager.createQueryBuilder = mockManagerCreateQueryBuilder;
    manager.getRepository = mockManagerGetRepository;
    // syncLinkedTransfers looks up owning splits to tell split-transfer
    // legs apart from plain transfer legs. Default: none (plain transfers).
    manager.find = mockManagerFind;
    // readParentSnapshot's raw SELECTs (undo snapshot + tag snapshot). Tests
    // that need rows route by SQL substring via mockImplementation.
    mockManagerQuery = manager.query;
    mockManagerQuery.mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionBulkUpdateService,
        { provide: AccountsService, useValue: accountsService },
        { provide: NetWorthService, useValue: netWorthService },
        { provide: TagsService, useValue: tagsService },
        { provide: TransactionSplitService, useValue: splitService },
        { provide: ActionHistoryService, useValue: actionHistoryService },
        { provide: DataSource, useValue: mockDataSource },
        { provide: TransactionSplitService, useValue: splitService },
      ],
    }).compile();

    service = module.get<TransactionBulkUpdateService>(
      TransactionBulkUpdateService,
    );
  });

  describe("bulkUpdate", () => {
    it("throws BadRequestException when no update fields are provided", async () => {
      const dto: BulkUpdateDto = {
        mode: "ids",
        transactionIds: ["tx-1"],
      };

      await expect(service.bulkUpdate(userId, dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("returns zero updated when no transactions match (ids mode)", async () => {
      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([]),
      });
      transactionsRepository.createQueryBuilder.mockReturnValue(resolveQb);

      const dto: BulkUpdateDto = {
        mode: "ids",
        transactionIds: ["nonexistent"],
        description: "test",
      };

      const result = await service.bulkUpdate(userId, dto);

      expect(result).toEqual({ updated: 0, skipped: 0, skippedReasons: [] });
    });

    it("updates transactions by explicit IDs", async () => {
      const tx1 = makeTransaction({ id: "tx-1" });
      const tx2 = makeTransaction({ id: "tx-2" });

      // First call: resolve IDs
      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1" }, { id: "tx-2" }]),
      });
      // Second call: exclusions
      const exclusionsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([tx1, tx2]),
      });

      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(exclusionsQb);

      // Batch update goes through queryRunner.manager.createQueryBuilder()
      const updateQb = createMockQueryBuilder({
        execute: jest.fn().mockResolvedValue({ affected: 2 }),
      });
      mockManagerCreateQueryBuilder.mockReturnValueOnce(updateQb);

      const dto: BulkUpdateDto = {
        mode: "ids",
        transactionIds: ["tx-1", "tx-2"],
        description: "Bulk updated",
      };

      const result = await service.bulkUpdate(userId, dto);

      expect(result.updated).toBe(2);
      expect(result.skipped).toBe(0);
      expect(updateQb.set).toHaveBeenCalledWith(
        expect.objectContaining({ description: "Bulk updated" }),
      );
    });

    it("includes reconciled transactions in bulk updates", async () => {
      const tx1 = makeTransaction({ id: "tx-1" });
      const tx2 = makeTransaction({
        id: "tx-2",
        status: TransactionStatus.RECONCILED,
      });

      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1" }, { id: "tx-2" }]),
      });
      const exclusionsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([tx1, tx2]),
      });

      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(exclusionsQb);

      // Batch update via queryRunner.manager
      const updateQb = createMockQueryBuilder({
        execute: jest.fn().mockResolvedValue({ affected: 2 }),
      });
      mockManagerCreateQueryBuilder.mockReturnValueOnce(updateQb);

      const dto: BulkUpdateDto = {
        mode: "ids",
        transactionIds: ["tx-1", "tx-2"],
        description: "test",
      };

      const result = await service.bulkUpdate(userId, dto);

      expect(result.updated).toBe(2);
      expect(result.skipped).toBe(0);
    });

    it("includes transfers when updating payee and syncs linked transactions", async () => {
      const tx1 = makeTransaction({ id: "tx-1" });
      const tx2 = makeTransaction({
        id: "tx-2",
        isTransfer: true,
        linkedTransactionId: "tx-2-linked",
      });

      // IDOR validation: payeeId is non-null so payeesRepository.findOne must return a match
      payeesRepository.findOne.mockResolvedValue({ id: "payee-1", userId });

      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1" }, { id: "tx-2" }]),
      });
      const exclusionsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([tx1, tx2]),
      });

      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(exclusionsQb);

      // Batch update via queryRunner.manager
      const updateQb = createMockQueryBuilder({
        execute: jest.fn().mockResolvedValue({ affected: 2 }),
      });
      // Sync: getRepository returns a repo with createQueryBuilder for finding linked IDs
      const syncFindQb = createMockQueryBuilder({
        getMany: jest
          .fn()
          .mockResolvedValue([{ linkedTransactionId: "tx-2-linked" }]),
      });
      // Cross-owner filter: the linked leg belongs to the same user.
      const ownLinkedQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-2-linked" }]),
      });
      const syncUpdateQb = createMockQueryBuilder({
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      });
      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(syncFindQb)
        .mockReturnValue(ownLinkedQb);
      mockManagerCreateQueryBuilder
        .mockReturnValueOnce(updateQb)
        .mockReturnValueOnce(syncUpdateQb);

      const dto: BulkUpdateDto = {
        mode: "ids",
        transactionIds: ["tx-1", "tx-2"],
        payeeId: "payee-1",
        payeeName: "Store",
      };

      const result = await service.bulkUpdate(userId, dto);

      // Both transactions should be updated (transfers are no longer skipped)
      expect(result.updated).toBe(2);
      expect(result.skipped).toBe(0);
      // Linked transaction should also be updated
      expect(syncUpdateQb.execute).toHaveBeenCalled();
    });

    it("classifies the transfer legs once when payee and tags both sync to mirrors", async () => {
      const tx2 = makeTransaction({
        id: "tx-2",
        isTransfer: true,
        linkedTransactionId: "tx-2-linked",
      });
      payeesRepository.findOne.mockResolvedValue({ id: "payee-1", userId });
      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(
          createMockQueryBuilder({
            getMany: jest.fn().mockResolvedValue([{ id: "tx-2" }]),
          }),
        )
        .mockReturnValueOnce(
          createMockQueryBuilder({
            getMany: jest.fn().mockResolvedValue([tx2]),
          }),
        )
        .mockReturnValue(
          createMockQueryBuilder({
            getMany: jest
              .fn()
              .mockResolvedValue([
                { id: "tx-2", linkedTransactionId: "tx-2-linked" },
              ]),
          }),
        );
      mockManagerCreateQueryBuilder.mockReturnValue(
        createMockQueryBuilder({
          execute: jest.fn().mockResolvedValue({ affected: 1 }),
        }),
      );
      mockManagerFind.mockClear();

      await service.bulkUpdate(userId, {
        mode: "ids",
        transactionIds: ["tx-2"],
        payeeId: "payee-1",
        tagIds: ["tag-a"],
      });

      // The owning-split lookup is the second query of one classification.
      expect(mockManagerFind).toHaveBeenCalledTimes(1);
    });

    it("recategorizes split lines instead of skipping split parents when updating category", async () => {
      const tx1 = makeTransaction({ id: "tx-1" });
      const tx2 = makeTransaction({ id: "tx-2", isSplit: true });

      // IDOR validation: categoryId is non-null so categoriesRepository.findOne must return a match
      categoriesRepository.findOne.mockResolvedValue({ id: "cat-1", userId });

      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1" }, { id: "tx-2" }]),
      });
      const classifyQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([tx1, tx2]),
      });

      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(classifyQb);

      // Batch update via queryRunner.manager
      const updateQb = createMockQueryBuilder({
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      });
      mockManagerCreateQueryBuilder.mockReturnValueOnce(updateQb);

      splitService.bulkRecategorizeCategorySplits.mockResolvedValue([
        {
          splitId: "split-1",
          transactionId: "tx-2",
          previousCategoryId: "old-a",
        },
        {
          splitId: "split-2",
          transactionId: "tx-2",
          previousCategoryId: "old-b",
        },
      ]);

      const dto: BulkUpdateDto = {
        mode: "ids",
        transactionIds: ["tx-1", "tx-2"],
        categoryId: "cat-1",
      };

      const result = await service.bulkUpdate(userId, dto);

      // The split parent received writes (its lines), so it counts as updated;
      // the changed lines are a sibling count, never folded into `updated` (I5).
      expect(result.updated).toBe(2);
      expect(result.skipped).toBe(0);
      expect(result.skippedReasons).toEqual([]);
      expect(result.splitLinesUpdated).toBe(2);

      // ids mode carries no category filter, so the restriction is undefined
      // (all category-kind lines).
      expect(splitService.bulkRecategorizeCategorySplits).toHaveBeenCalledWith(
        userId,
        ["tx-2"],
        "cat-1",
        undefined,
      );

      // I1: the parent-level categoryId UPDATE excludes the split parent --
      // its category_id stays NULL.
      expect(mockManagerCreateQueryBuilder).toHaveBeenCalledTimes(1);
      expect(updateQb.where).toHaveBeenCalledWith("id IN (:...ids)", {
        ids: ["tx-1"],
      });
    });

    it("applies category null clears to split lines too", async () => {
      const tx1 = makeTransaction({ id: "tx-1" });
      const tx2 = makeTransaction({ id: "tx-2", isSplit: true });

      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1" }, { id: "tx-2" }]),
      });
      const classifyQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([tx1, tx2]),
      });
      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(classifyQb);

      const updateQb = createMockQueryBuilder({
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      });
      mockManagerCreateQueryBuilder.mockReturnValueOnce(updateQb);

      splitService.bulkRecategorizeCategorySplits.mockResolvedValue([
        {
          splitId: "split-1",
          transactionId: "tx-2",
          previousCategoryId: "old-a",
        },
      ]);

      const dto: BulkUpdateDto = {
        mode: "ids",
        transactionIds: ["tx-1", "tx-2"],
        categoryId: null,
      };

      const result = await service.bulkUpdate(userId, dto);

      // Decision 3 (split-bulk-update.md): clearing treats split lines
      // uniformly -- matching lines get a NULL category.
      expect(splitService.bulkRecategorizeCategorySplits).toHaveBeenCalledWith(
        userId,
        ["tx-2"],
        null,
        undefined,
      );
      expect(result.updated).toBe(2);
      expect(result.splitLinesUpdated).toBe(1);
      expect(updateQb.where).toHaveBeenCalledWith("id IN (:...ids)", {
        ids: ["tx-1"],
      });
    });

    it("skips a split parent with no matching lines in a category-only run, but not when a parent field also applies", async () => {
      const tx1 = makeTransaction({ id: "tx-1" });
      const tx2 = makeTransaction({ id: "tx-2", isSplit: true });

      categoriesRepository.findOne.mockResolvedValue({ id: "cat-1", userId });

      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1" }, { id: "tx-2" }]),
      });
      const classifyQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([tx1, tx2]),
      });
      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(classifyQb);

      const updateQb = createMockQueryBuilder({
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      });
      mockManagerCreateQueryBuilder.mockReturnValueOnce(updateQb);

      // No line of the split parent matched the category update.
      splitService.bulkRecategorizeCategorySplits.mockResolvedValue([]);

      const result = await service.bulkUpdate(userId, {
        mode: "ids",
        transactionIds: ["tx-1", "tx-2"],
        categoryId: "cat-1",
      });

      // Truth table A row 2/3: category-only and zero changed lines -> the
      // split parent received nothing and is skipped with the One reason.
      expect(result.updated).toBe(1);
      expect(result.skipped).toBe(1);
      expect(result.skippedReasons).toEqual([
        "1 split transaction was skipped because none of its split lines matched the category update",
      ]);
      // Zero changed lines: the sibling count is omitted, not 0.
      expect(result).not.toHaveProperty("splitLinesUpdated");
      expect(updateQb.where).toHaveBeenCalledWith("id IN (:...ids)", {
        ids: ["tx-1"],
      });
    });

    it("updates a no-matching-lines split parent anyway when the run also sets a parent field", async () => {
      const tx1 = makeTransaction({ id: "tx-1" });
      const tx2 = makeTransaction({ id: "tx-2", isSplit: true });

      categoriesRepository.findOne.mockResolvedValue({ id: "cat-1", userId });

      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1" }, { id: "tx-2" }]),
      });
      const classifyQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([tx1, tx2]),
      });
      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(classifyQb);

      const fullUpdateQb = createMockQueryBuilder({
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      });
      const splitParentQb = createMockQueryBuilder({
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      });
      mockManagerCreateQueryBuilder
        .mockReturnValueOnce(fullUpdateQb)
        .mockReturnValueOnce(splitParentQb);

      splitService.bulkRecategorizeCategorySplits.mockResolvedValue([]);

      const result = await service.bulkUpdate(userId, {
        mode: "ids",
        transactionIds: ["tx-1", "tx-2"],
        categoryId: "cat-1",
        payeeName: "New Payee",
      });

      // Truth table A row 4: parent fields applied, so the split parent is
      // updated and no skip reason is produced.
      expect(result.updated).toBe(2);
      expect(result.skipped).toBe(0);
      expect(result.skippedReasons).toEqual([]);
      expect(result).not.toHaveProperty("splitLinesUpdated");

      // Two parent UPDATEs: the non-split row gets every field, the split
      // parent gets the fields minus categoryId (I1).
      expect(mockManagerCreateQueryBuilder).toHaveBeenCalledTimes(2);
      expect(fullUpdateQb.set).toHaveBeenCalledWith({
        payeeName: "New Payee",
        categoryId: "cat-1",
      });
      expect(fullUpdateQb.where).toHaveBeenCalledWith("id IN (:...ids)", {
        ids: ["tx-1"],
      });
      expect(splitParentQb.set).toHaveBeenCalledWith({
        payeeName: "New Payee",
      });
      expect(splitParentQb.where).toHaveBeenCalledWith("id IN (:...ids)", {
        ids: ["tx-2"],
      });
    });

    it("restricts split-line recategorization to the descendant-expanded filter categories", async () => {
      const tx2 = makeTransaction({ id: "tx-2", isSplit: true });

      categoriesRepository.findOne.mockResolvedValue({ id: "cat-1", userId });
      // getAllCategoryIdsWithChildren reads the user's category tree.
      categoriesRepository.find.mockResolvedValue([
        { id: "cat-1", parentId: null },
        { id: "cat-1-child", parentId: "cat-1" },
      ]);

      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-2" }]),
      });
      const classifyQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([tx2]),
      });
      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(classifyQb);

      splitService.bulkRecategorizeCategorySplits.mockResolvedValue([
        {
          splitId: "split-1",
          transactionId: "tx-2",
          previousCategoryId: "cat-1-child",
        },
      ]);

      const result = await service.bulkUpdate(userId, {
        mode: "filter",
        filters: { categoryIds: ["cat-1"] },
        categoryId: "cat-1",
      });

      // Filter mode with a real category id: only lines whose category is in
      // the descendant-expanded set change, matching the selection semantics.
      expect(splitService.bulkRecategorizeCategorySplits).toHaveBeenCalledWith(
        userId,
        ["tx-2"],
        "cat-1",
        ["cat-1", "cat-1-child"],
      );
      expect(result.updated).toBe(1);
      expect(result.splitLinesUpdated).toBe(1);
    });

    it("passes no restriction when the category filter holds only pseudo-ids", async () => {
      const tx2 = makeTransaction({ id: "tx-2", isSplit: true });

      categoriesRepository.findOne.mockResolvedValue({ id: "cat-1", userId });

      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-2" }]),
      });
      const classifyQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([tx2]),
      });
      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(classifyQb);

      splitService.bulkRecategorizeCategorySplits.mockResolvedValue([
        { splitId: "split-1", transactionId: "tx-2", previousCategoryId: null },
      ]);

      await service.bulkUpdate(userId, {
        mode: "filter",
        filters: { categoryIds: ["uncategorized", "transfer"] },
        categoryId: "cat-1",
      });

      // "uncategorized"/"transfer" are pseudo-ids, not real categories: after
      // stripping them the restriction set is empty, which means unrestricted.
      expect(splitService.bulkRecategorizeCategorySplits).toHaveBeenCalledWith(
        userId,
        ["tx-2"],
        "cat-1",
        undefined,
      );
    });

    it("honors the active category filter in ids mode via categoryFilterIds", async () => {
      // Regression (user-reported): rows hand-picked under an active category
      // filter arrive as mode "ids", and the restriction must key off the
      // filter itself -- carried as categoryFilterIds -- never off the
      // selection mode. Without it, an unrelated split line was recategorized.
      const tx2 = makeTransaction({ id: "tx-2", isSplit: true });

      categoriesRepository.findOne.mockResolvedValue({ id: "cat-1", userId });
      categoriesRepository.find.mockResolvedValue([
        { id: "cat-1", parentId: null },
        { id: "cat-1-child", parentId: "cat-1" },
      ]);

      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-2" }]),
      });
      const classifyQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([tx2]),
      });
      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(classifyQb);

      splitService.bulkRecategorizeCategorySplits.mockResolvedValue([
        {
          splitId: "split-1",
          transactionId: "tx-2",
          previousCategoryId: "cat-1-child",
        },
      ]);

      await service.bulkUpdate(userId, {
        mode: "ids",
        transactionIds: ["tx-2"],
        categoryFilterIds: ["cat-1"],
        categoryId: "cat-1",
      });

      expect(splitService.bulkRecategorizeCategorySplits).toHaveBeenCalledWith(
        userId,
        ["tx-2"],
        "cat-1",
        ["cat-1", "cat-1-child"],
      );
    });

    it("prefers categoryFilterIds over the selection filters in filter mode", async () => {
      const tx2 = makeTransaction({ id: "tx-2", isSplit: true });

      categoriesRepository.findOne.mockResolvedValue({ id: "cat-1", userId });
      categoriesRepository.find.mockResolvedValue([
        { id: "cat-a", parentId: null },
        { id: "cat-b", parentId: null },
      ]);

      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-2" }]),
      });
      const classifyQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([tx2]),
      });
      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(classifyQb);

      splitService.bulkRecategorizeCategorySplits.mockResolvedValue([
        { splitId: "split-1", transactionId: "tx-2", previousCategoryId: null },
      ]);

      await service.bulkUpdate(userId, {
        mode: "filter",
        filters: { categoryIds: ["cat-b"] },
        categoryFilterIds: ["cat-a"],
        categoryId: "cat-1",
      });

      // One source for the restriction: the explicit categoryFilterIds field.
      expect(splitService.bulkRecategorizeCategorySplits).toHaveBeenCalledWith(
        userId,
        ["tx-2"],
        "cat-1",
        ["cat-a"],
      );
    });

    it("records the bulk_update undo snapshot with split lines and no parent categoryId on split parents", async () => {
      const tx1 = makeTransaction({ id: "tx-1" });
      const tx2 = makeTransaction({ id: "tx-2", isSplit: true });

      categoriesRepository.findOne.mockResolvedValue({ id: "cat-1", userId });

      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1" }, { id: "tx-2" }]),
      });
      const classifyQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([tx1, tx2]),
      });
      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(classifyQb);

      const updateQb = createMockQueryBuilder({
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      });
      mockManagerCreateQueryBuilder.mockReturnValueOnce(updateQb);

      // The pre-write snapshot SELECT returns driver-shaped rows.
      mockManagerQuery.mockImplementation((sql: string) =>
        Promise.resolve(
          typeof sql === "string" && sql.includes("FROM transactions")
            ? [
                { id: "tx-1", account_id: "account-1", category_id: "old-cat" },
                { id: "tx-2", account_id: "account-1", category_id: null },
              ]
            : [],
        ),
      );

      splitService.bulkRecategorizeCategorySplits.mockResolvedValue([
        {
          splitId: "split-1",
          transactionId: "tx-2",
          previousCategoryId: "old-split-cat",
        },
      ]);

      await service.bulkUpdate(userId, {
        mode: "ids",
        transactionIds: ["tx-1", "tx-2"],
        categoryId: "cat-1",
      });

      // Exact payload: undo restores the before side, redo replays the after
      // side, and neither side may carry a parent categoryId for a split
      // parent (I1) -- its change rides along as splits: [{ id, categoryId }].
      expect(actionHistoryService.record).toHaveBeenCalledTimes(1);
      expect(actionHistoryService.record).toHaveBeenCalledWith(userId, {
        entityType: "bulk_transaction",
        entityId: null,
        action: "bulk_update",
        beforeData: {
          transactions: [
            { id: "tx-1", accountId: "account-1", categoryId: "old-cat" },
            {
              id: "tx-2",
              accountId: "account-1",
              splits: [{ id: "split-1", categoryId: "old-split-cat" }],
            },
          ],
        },
        afterData: {
          transactions: [
            { id: "tx-1", accountId: "account-1", categoryId: "cat-1" },
            {
              id: "tx-2",
              accountId: "account-1",
              splits: [{ id: "split-1", categoryId: "cat-1" }],
            },
          ],
        },
        description: "Bulk updated 2 transactions",
        descriptionKey: "bulkUpdatedTransactions",
        descriptionParams: { count: 2 },
      });
      const [, entry] = actionHistoryService.record.mock.calls[0];
      expect(entry.beforeData.transactions[1]).not.toHaveProperty("categoryId");
      expect(entry.afterData.transactions[1]).not.toHaveProperty("categoryId");
    });

    it("skips a split transfer leg asked to cross the VOID boundary", async () => {
      // `expandTransferCounterparts` deliberately refuses to drag a split PARENT
      // into a status change -- that would void unrelated category children -- so
      // voiding the leg alone left the parent's split row and total still
      // recording money that left the source and never arrived. The single-edit
      // path refuses this; the bulk path applied it.
      const tx1 = makeTransaction({
        id: "tx-1",
        isTransfer: true,
        linkedTransactionId: "parent-tx",
        status: TransactionStatus.UNRECONCILED,
      });

      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1" }]),
      });
      const exclusionsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([tx1]),
      });
      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(exclusionsQb);
      // The selected leg is owned by a split row, so it is a split-transfer leg.
      mockManagerFind.mockResolvedValue([
        { id: "split-1", linkedTransactionId: "tx-1" },
      ]);

      const result = await service.bulkUpdate(userId, {
        mode: "ids",
        transactionIds: ["tx-1"],
        status: TransactionStatus.VOID,
      } as BulkUpdateDto);

      expect(result.updated).toBe(0);
      expect(result.skipped).toBe(1);
      expect(result.skippedReasons).toEqual(
        expect.arrayContaining([
          expect.stringContaining("1 split transfer was skipped"),
        ]),
      );
      // Nothing written and no balance moved.
      expect(accountsService.updateBalance).not.toHaveBeenCalled();
    });

    it("skips an investment cash leg asked to cross the VOID boundary and still updates the rest", async () => {
      // The investment row owns the pair's VOID boundary
      // (InvestmentTransactionsService.updateStatus is the propagation path).
      // A bulk void reaching the cash leg directly would restore the cash
      // balance while the trade's shares stayed counted -- the same divergent
      // pair the single-edit route refuses, reached through the bulk path.
      const cashLeg = makeTransaction({
        id: "tx-1",
        status: TransactionStatus.UNRECONCILED,
      });
      const plain = makeTransaction({
        id: "tx-2",
        status: TransactionStatus.UNRECONCILED,
      });

      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1" }, { id: "tx-2" }]),
      });
      const classifyQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([cashLeg, plain]),
      });
      // Post-classify status pipeline over the surviving row only.
      const transferLegsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([]),
      });
      const splitParentsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([]),
      });
      const balanceQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([]),
      });
      const accountIdsQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([]),
      });
      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(classifyQb)
        // The status lock set is discovered from the selection first (A26-M09).
        .mockReturnValueOnce(classifyQb)
        .mockReturnValueOnce(transferLegsQb)
        .mockReturnValueOnce(splitParentsQb)
        .mockReturnValueOnce(balanceQb)
        .mockReturnValue(accountIdsQb);

      // tx-1 is the cash side of an investment transaction; tx-2 is not.
      mockManagerQuery.mockImplementation(async (sql: string) =>
        String(sql).includes("investment_transactions")
          ? [{ transaction_id: "tx-1" }]
          : [],
      );

      const updateQb = createMockQueryBuilder({
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      });
      mockManagerCreateQueryBuilder.mockReturnValue(updateQb);

      const result = await service.bulkUpdate(userId, {
        mode: "ids",
        transactionIds: ["tx-1", "tx-2"],
        status: TransactionStatus.VOID,
      } as BulkUpdateDto);

      expect(result.updated).toBe(1);
      expect(result.skipped).toBe(1);
      expect(result.skippedReasons).toEqual(
        expect.arrayContaining([
          expect.stringContaining("1 investment cash transaction was skipped"),
        ]),
      );
      // The status UPDATE runs against the surviving row only.
      expect(updateQb.where).toHaveBeenCalledWith("id IN (:...ids)", {
        ids: ["tx-2"],
      });
    });

    it("propagates a bulk VOID on a split parent to its transfer counterparts (RR3-001)", async () => {
      // `expandTransferCounterparts` cannot reach these: a split parent is
      // `isSplit = true, isTransfer = false`, so it finds nothing. The batch then
      // voided the parent, restored its source balance, and left every
      // child-created leg active holding the money -- money created across
      // accounts by a bulk edit. The single-update route already went through
      // `applyParentStatusToTransferCounterparts`; this one did not.
      const parent = makeTransaction({
        id: "parent-tx",
        isSplit: true,
        isTransfer: false,
        status: TransactionStatus.UNRECONCILED,
      });

      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "parent-tx" }]),
      });
      const exclusionsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([parent]),
      });
      // No transfer legs in the selection (the parent is not one)...
      const transferLegsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([]),
      });
      const balanceQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([]),
      });
      // ...but it IS a split parent, and it is crossing into VOID.
      const splitParentsQb = createMockQueryBuilder({
        getMany: jest
          .fn()
          .mockResolvedValue([
            { id: "parent-tx", status: TransactionStatus.UNRECONCILED },
          ]),
      });
      const accountIdsQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([]),
      });
      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(exclusionsQb)
        // The status lock set is discovered from the selection first (A26-M09).
        .mockReturnValueOnce(exclusionsQb)
        .mockReturnValueOnce(transferLegsQb)
        .mockReturnValueOnce(splitParentsQb)
        .mockReturnValueOnce(balanceQb)
        .mockReturnValue(accountIdsQb);

      const updateQb = createMockQueryBuilder({
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      });
      mockManagerCreateQueryBuilder.mockReturnValue(updateQb);

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

      await service.bulkUpdate(userId, {
        mode: "ids",
        transactionIds: ["parent-tx"],
        status: TransactionStatus.VOID,
      } as BulkUpdateDto);

      // The shared helper the single-update path uses, inside this batch's
      // transaction -- not a second copy of the propagation rule.
      expect(
        splitService.applyParentStatusToTransferCounterparts,
      ).toHaveBeenCalledWith(
        expect.anything(),
        "parent-tx",
        userId,
        TransactionStatus.VOID,
        expect.any(Set),
      );
      // After the commit, the securities of the embedded rows that crossed the
      // boundary are repriced (INV-BOND-005, INV-CACHE-001).
      expect(splitService.recomputeBondPricesAfterWrite).toHaveBeenCalledWith(
        userId,
        new Set(["sec-1"]),
      );
    });

    it("refuses with 409 when the locked expansion names a row the lock set did not cover (A26-M09)", async () => {
      // A leg added under the parent after the structural discovery read would
      // be written without its row lock; the batch refuses instead.
      const parent = makeTransaction({
        id: "parent-tx",
        isSplit: true,
        isTransfer: false,
        status: TransactionStatus.UNRECONCILED,
      });
      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "parent-tx" }]),
      });
      const exclusionsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([parent]),
      });
      const transferLegsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([]),
      });
      const splitParentsQb = createMockQueryBuilder({
        getMany: jest
          .fn()
          .mockResolvedValue([
            { id: "parent-tx", status: TransactionStatus.UNRECONCILED },
          ]),
      });
      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(exclusionsQb)
        .mockReturnValueOnce(exclusionsQb)
        .mockReturnValueOnce(transferLegsQb)
        .mockReturnValueOnce(splitParentsQb);
      // Discovery saw no legs; under the lock the parent has one.
      mockManagerFind
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: "s-1", linkedTransactionId: "new-leg" }]);
      const updateQb = createMockQueryBuilder({
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      });
      mockManagerCreateQueryBuilder.mockReturnValue(updateQb);

      await expect(
        service.bulkUpdate(userId, {
          mode: "ids",
          transactionIds: ["parent-tx"],
          status: TransactionStatus.VOID,
        } as BulkUpdateDto),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(accountsService.updateBalance).not.toHaveBeenCalled();
      expect(updateQb.execute).not.toHaveBeenCalled();
    });

    it("invalidates the counterpart account's net worth, not just the parent's (RR4-003)", async () => {
      // The propagation helper moved the target account's live balance and told
      // nobody, so the batch invalidated only the accounts in `statusIds` -- the
      // parent's. The target came out with a corrected balance beside a stale
      // net-worth snapshot, and it stayed stale until an unrelated write.
      const parent = makeTransaction({
        id: "parent-tx",
        isSplit: true,
        isTransfer: false,
        status: TransactionStatus.UNRECONCILED,
      });

      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "parent-tx" }]),
      });
      const exclusionsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([parent]),
      });
      const transferLegsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([]),
      });
      const balanceQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([]),
      });
      const splitParentsQb = createMockQueryBuilder({
        getMany: jest
          .fn()
          .mockResolvedValue([
            { id: "parent-tx", status: TransactionStatus.UNRECONCILED },
          ]),
      });
      // The net-worth query only knows the selected rows' accounts.
      const accountIdsQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([{ accountId: "acc-parent" }]),
      });
      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(exclusionsQb)
        // The status lock set is discovered from the selection first (A26-M09).
        .mockReturnValueOnce(exclusionsQb)
        .mockReturnValueOnce(transferLegsQb)
        .mockReturnValueOnce(splitParentsQb)
        .mockReturnValueOnce(balanceQb)
        .mockReturnValue(accountIdsQb);

      const updateQb = createMockQueryBuilder({
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      });
      mockManagerCreateQueryBuilder.mockReturnValue(updateQb);

      // The helper reports the target account it moved.
      splitService.applyParentStatusToTransferCounterparts.mockResolvedValue(
        new Set(["acc-target"]),
      );

      // The module mock is shared across this file's tests, so its recorded
      // invocation order carries earlier cases' calls; the ordering assertion
      // below is about this run only.
      (lockTransactionRows as jest.Mock).mockClear();

      await service.bulkUpdate(userId, {
        mode: "ids",
        transactionIds: ["parent-tx"],
        status: TransactionStatus.VOID,
      } as BulkUpdateDto);

      expect(netWorthService.triggerDebouncedRecalc).toHaveBeenCalledWith(
        "acc-parent",
        userId,
      );
      expect(netWorthService.triggerDebouncedRecalc).toHaveBeenCalledWith(
        "acc-target",
        userId,
      );

      // Advisory locks are taken before row locks (`common/db/locks.ts`). The
      // parents' embedded investment rows are rebuilt under the holdings
      // advisory lock, and the batch took it only there -- after the balance
      // pass had row-locked `accounts`, the opposite order from an investment
      // write (40P01).
      //
      // `lockTransactionRows` is the second round of the same defect: the
      // advisory lock moved above the balance pass but stayed below the batch's
      // `FOR UPDATE` over the parents, while
      // `InvestmentTransactionsService.update()` takes the advisory lock first
      // and then row-locks the same parent -- each path holding the other's
      // next lock, 40P01 for both.
      expect(splitService.lockEmbeddedInvestmentScopes).toHaveBeenCalledWith(
        expect.anything(),
        userId,
        ["parent-tx"],
      );
      expect(
        splitService.lockEmbeddedInvestmentScopes.mock.invocationCallOrder[0],
      ).toBeLessThan(balanceQb.getRawMany.mock.invocationCallOrder[0]);
      expect(lockTransactionRows).toHaveBeenCalled();
      expect(
        splitService.lockEmbeddedInvestmentScopes.mock.invocationCallOrder[0],
      ).toBeLessThan(
        (lockTransactionRows as jest.Mock).mock.invocationCallOrder[0],
      );
    });

    it("does not propagate a split parent status that stays on one side of VOID", async () => {
      // A control: PENDING -> CLEARED on a split parent must not touch the
      // counterparts, whose reconciliation state is their own ledger's.
      const parent = makeTransaction({
        id: "parent-tx",
        isSplit: true,
        isTransfer: false,
        status: TransactionStatus.UNRECONCILED,
      });

      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "parent-tx" }]),
      });
      const exclusionsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([parent]),
      });
      const transferLegsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([]),
      });
      const balanceQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([]),
      });
      const splitParentsQb = createMockQueryBuilder({
        getMany: jest
          .fn()
          .mockResolvedValue([
            { id: "parent-tx", status: TransactionStatus.UNRECONCILED },
          ]),
      });
      const accountIdsQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([]),
      });
      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(exclusionsQb)
        // The status lock set is discovered from the selection first (A26-M09).
        .mockReturnValueOnce(exclusionsQb)
        .mockReturnValueOnce(transferLegsQb)
        .mockReturnValueOnce(splitParentsQb)
        .mockReturnValueOnce(balanceQb)
        .mockReturnValue(accountIdsQb);

      const updateQb = createMockQueryBuilder({
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      });
      mockManagerCreateQueryBuilder.mockReturnValue(updateQb);

      await service.bulkUpdate(userId, {
        mode: "ids",
        transactionIds: ["parent-tx"],
        status: TransactionStatus.CLEARED,
      } as BulkUpdateDto);

      expect(
        splitService.applyParentStatusToTransferCounterparts,
      ).not.toHaveBeenCalled();
    });

    it("still applies a per-ledger reconciliation status to a split transfer leg", async () => {
      // Only the VOID boundary is shared; CLEARED is per-ledger and must not be
      // caught by the skip above.
      const tx1 = makeTransaction({
        id: "tx-1",
        isTransfer: true,
        linkedTransactionId: "parent-tx",
        status: TransactionStatus.UNRECONCILED,
      });

      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1" }]),
      });
      const exclusionsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([tx1]),
      });
      const expandQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([]),
      });
      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(exclusionsQb)
        // The status lock set is discovered from the selection first (A26-M09).
        .mockReturnValueOnce(exclusionsQb)
        .mockReturnValue(expandQb);
      mockManagerFind.mockResolvedValue([
        { id: "split-1", linkedTransactionId: "tx-1" },
      ]);

      const updateQb = createMockQueryBuilder({
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      });
      mockManagerCreateQueryBuilder.mockReturnValue(updateQb);

      const result = await service.bulkUpdate(userId, {
        mode: "ids",
        transactionIds: ["tx-1"],
        status: TransactionStatus.CLEARED,
      } as BulkUpdateDto);

      expect(result.skipped).toBe(0);
      expect(result.updated).toBe(1);
    });

    it("includes transfers when updating category (does not skip)", async () => {
      const tx1 = makeTransaction({ id: "tx-1" });
      const tx2 = makeTransaction({
        id: "tx-2",
        isTransfer: true,
        linkedTransactionId: "tx-2-linked",
      });

      categoriesRepository.findOne.mockResolvedValue({ id: "cat-1", userId });

      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1" }, { id: "tx-2" }]),
      });
      const exclusionsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([tx1, tx2]),
      });

      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(exclusionsQb);

      const updateQb = createMockQueryBuilder({
        execute: jest.fn().mockResolvedValue({ affected: 2 }),
      });
      mockManagerCreateQueryBuilder.mockReturnValueOnce(updateQb);

      const dto: BulkUpdateDto = {
        mode: "ids",
        transactionIds: ["tx-1", "tx-2"],
        categoryId: "cat-1",
      };

      const result = await service.bulkUpdate(userId, dto);

      expect(result.updated).toBe(2);
      expect(result.skipped).toBe(0);
    });

    it("does not sync category to linked transfers", async () => {
      const tx1 = makeTransaction({
        id: "tx-1",
        isTransfer: true,
        linkedTransactionId: "tx-1-linked",
      });

      categoriesRepository.findOne.mockResolvedValue({ id: "cat-1", userId });

      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1" }]),
      });
      const exclusionsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([tx1]),
      });

      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(exclusionsQb);

      const updateQb = createMockQueryBuilder({
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      });
      mockManagerCreateQueryBuilder.mockReturnValueOnce(updateQb);

      const dto: BulkUpdateDto = {
        mode: "ids",
        transactionIds: ["tx-1"],
        categoryId: "cat-1",
      };

      const result = await service.bulkUpdate(userId, dto);

      expect(result.updated).toBe(1);
      // Only one createQueryBuilder call for the main update; no sync update call
      expect(mockManagerCreateQueryBuilder).toHaveBeenCalledTimes(1);
    });

    it("syncs description to linked transfers", async () => {
      const tx1 = makeTransaction({
        id: "tx-1",
        isTransfer: true,
        linkedTransactionId: "tx-1-linked",
      });

      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1" }]),
      });
      const exclusionsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([tx1]),
      });

      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(exclusionsQb);

      const updateQb = createMockQueryBuilder({
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      });
      const syncFindQb = createMockQueryBuilder({
        getMany: jest
          .fn()
          .mockResolvedValue([{ linkedTransactionId: "tx-1-linked" }]),
      });
      // Cross-owner filter: the linked leg belongs to the same user.
      const ownLinkedQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1-linked" }]),
      });
      const syncUpdateQb = createMockQueryBuilder({
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      });
      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(syncFindQb)
        .mockReturnValue(ownLinkedQb);
      mockManagerCreateQueryBuilder
        .mockReturnValueOnce(updateQb)
        .mockReturnValueOnce(syncUpdateQb);

      const dto: BulkUpdateDto = {
        mode: "ids",
        transactionIds: ["tx-1"],
        description: "Updated description",
      };

      const result = await service.bulkUpdate(userId, dto);

      expect(result.updated).toBe(1);
      // The sync update should have been called for the linked transaction
      expect(syncUpdateQb.execute).toHaveBeenCalled();
    });

    it("mirrors description to the owning split's memo (not the parent) for split-transfer legs", async () => {
      // tx-1 is the counterpart leg of a SPLIT transfer: its
      // linkedTransactionId points at the split PARENT, and a split row owns
      // it. The description must land on the split memo, never on the parent.
      const tx1 = makeTransaction({
        id: "tx-1",
        isTransfer: true,
        linkedTransactionId: "parent-tx",
      });

      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1" }]),
      });
      const exclusionsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([tx1]),
      });
      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(exclusionsQb);

      const updateQb = createMockQueryBuilder({
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      });
      const syncFindQb = createMockQueryBuilder({
        getMany: jest
          .fn()
          .mockResolvedValue([
            { id: "tx-1", linkedTransactionId: "parent-tx" },
          ]),
      });
      const memoUpdateQb = createMockQueryBuilder({
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      });
      transactionsRepository.createQueryBuilder.mockReturnValue(syncFindQb);
      // The owning-split lookup identifies tx-1 as a split-transfer leg.
      mockManagerFind.mockResolvedValue([
        { id: "split-1", linkedTransactionId: "tx-1" },
      ]);
      mockManagerCreateQueryBuilder
        .mockReturnValueOnce(updateQb)
        .mockReturnValueOnce(memoUpdateQb);

      const dto: BulkUpdateDto = {
        mode: "ids",
        transactionIds: ["tx-1"],
        description: "Y",
      };

      const result = await service.bulkUpdate(userId, dto);

      expect(result.updated).toBe(1);
      // Exactly two manager updates: the main field update and the split-memo
      // mirror. No third update writing syncFields to the parent transaction.
      expect(mockManagerCreateQueryBuilder).toHaveBeenCalledTimes(2);
      expect(memoUpdateQb.set).toHaveBeenCalledWith({ memo: "Y" });
      expect(memoUpdateQb.where).toHaveBeenCalledWith("id IN (:...ids)", {
        ids: ["split-1"],
      });
    });

    it("does not sync when no transfers have linked IDs", async () => {
      const tx1 = makeTransaction({
        id: "tx-1",
        isTransfer: true,
        linkedTransactionId: null,
      });

      payeesRepository.findOne.mockResolvedValue({ id: "payee-1", userId });

      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1" }]),
      });
      const exclusionsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([tx1]),
      });

      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(exclusionsQb);

      const updateQb = createMockQueryBuilder({
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      });
      // Sync finds no linked IDs (the transfer has no linked transaction)
      const syncFindQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([]),
      });
      transactionsRepository.createQueryBuilder.mockReturnValue(syncFindQb);
      mockManagerCreateQueryBuilder.mockReturnValueOnce(updateQb);

      const dto: BulkUpdateDto = {
        mode: "ids",
        transactionIds: ["tx-1"],
        payeeId: "payee-1",
        payeeName: "Store",
      };

      const result = await service.bulkUpdate(userId, dto);

      expect(result.updated).toBe(1);
      // Only one createQueryBuilder call for main update; no sync update needed
      expect(mockManagerCreateQueryBuilder).toHaveBeenCalledTimes(1);
    });

    it("adjusts balances when changing status to VOID", async () => {
      const tx1 = makeTransaction({
        id: "tx-1",
        accountId: "acc-1",
        amount: 50,
      });
      const tx2 = makeTransaction({
        id: "tx-2",
        accountId: "acc-1",
        amount: -30,
      });

      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1" }, { id: "tx-2" }]),
      });
      const exclusionsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([tx1, tx2]),
      });
      // Net worth recalc query (after commit, uses transactionsRepository)
      const accountIdsQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([{ accountId: "acc-1" }]),
      });

      // Balance deltas query goes through queryRunner.manager.getRepository(Transaction).createQueryBuilder()
      const balanceQb = createMockQueryBuilder({
        getRawMany: jest
          .fn()
          .mockResolvedValue([{ accountId: "acc-1", totalAmount: "20" }]),
      });

      // A status change first looks for transfer legs among the selection so a
      // counterpart can be voided with it (audit P5-001); none here.
      const transferLegsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([]),
      });

      // ...then for selected split PARENTS, whose child-created transfer legs
      // have to cross the VOID boundary with them (recheck RR3-001); none here.
      const splitParentsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([]),
      });

      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(exclusionsQb)
        // The status lock set is discovered from the selection first (A26-M09).
        .mockReturnValueOnce(exclusionsQb)
        .mockReturnValueOnce(transferLegsQb)
        .mockReturnValueOnce(splitParentsQb)
        .mockReturnValueOnce(balanceQb)
        .mockReturnValueOnce(accountIdsQb);

      // Batch update goes through queryRunner.manager.createQueryBuilder()
      const updateQb = createMockQueryBuilder({
        execute: jest.fn().mockResolvedValue({ affected: 2 }),
      });
      mockManagerCreateQueryBuilder.mockReturnValueOnce(updateQb);

      const dto: BulkUpdateDto = {
        mode: "ids",
        transactionIds: ["tx-1", "tx-2"],
        status: TransactionStatus.VOID,
      };

      const result = await service.bulkUpdate(userId, dto);

      expect(result.updated).toBe(2);
      expect(accountsService.updateBalance).toHaveBeenCalledWith("acc-1", -20);
      expect(netWorthService.triggerDebouncedRecalc).toHaveBeenCalledWith(
        "acc-1",
        userId,
      );
    });

    it("adjusts balances when changing status from VOID to non-VOID", async () => {
      const tx1 = makeTransaction({
        id: "tx-1",
        accountId: "acc-1",
        amount: 100,
        status: TransactionStatus.VOID,
      });

      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1" }]),
      });
      const exclusionsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([tx1]),
      });
      // Net worth recalc query (after commit)
      const accountIdsQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([{ accountId: "acc-1" }]),
      });

      // Balance deltas via queryRunner.manager.getRepository
      const balanceQb = createMockQueryBuilder({
        getRawMany: jest
          .fn()
          .mockResolvedValue([{ accountId: "acc-1", totalAmount: "100" }]),
      });

      // A status change first looks for transfer legs among the selection so a
      // counterpart can be voided with it (audit P5-001); none here.
      const transferLegsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([]),
      });

      // ...then the split-parent discovery for the undo snapshot; none here.
      const splitParentsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([]),
      });

      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(exclusionsQb)
        // The status lock set is discovered from the selection first (A26-M09).
        .mockReturnValueOnce(exclusionsQb)
        .mockReturnValueOnce(transferLegsQb)
        .mockReturnValueOnce(splitParentsQb)
        .mockReturnValueOnce(balanceQb)
        .mockReturnValueOnce(accountIdsQb);

      // Batch update via queryRunner.manager.createQueryBuilder
      const updateQb = createMockQueryBuilder({
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      });
      mockManagerCreateQueryBuilder.mockReturnValueOnce(updateQb);

      const dto: BulkUpdateDto = {
        mode: "ids",
        transactionIds: ["tx-1"],
        status: TransactionStatus.CLEARED,
      };

      const result = await service.bulkUpdate(userId, dto);

      expect(result.updated).toBe(1);
      expect(accountsService.updateBalance).toHaveBeenCalledWith("acc-1", 100);
    });

    it("only updates specified fields (partial update)", async () => {
      const tx = makeTransaction({ id: "tx-1" });

      // IDOR validation: categoryId is non-null
      categoriesRepository.findOne.mockResolvedValue({ id: "cat-1", userId });

      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1" }]),
      });
      const exclusionsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([tx]),
      });

      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(exclusionsQb);

      // Batch update via queryRunner.manager.createQueryBuilder
      const updateQb = createMockQueryBuilder({
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      });
      mockManagerCreateQueryBuilder.mockReturnValueOnce(updateQb);

      const dto: BulkUpdateDto = {
        mode: "ids",
        transactionIds: ["tx-1"],
        categoryId: "cat-1",
      };

      await service.bulkUpdate(userId, dto);

      const setArg = updateQb.set.mock.calls[0][0];
      expect(setArg).toEqual({ categoryId: "cat-1" });
      expect(setArg).not.toHaveProperty("description");
      expect(setArg).not.toHaveProperty("payeeId");
      expect(setArg).not.toHaveProperty("status");
    });

    it("clears fields when null is provided", async () => {
      const tx = makeTransaction({ id: "tx-1" });

      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1" }]),
      });
      const exclusionsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([tx]),
      });

      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(exclusionsQb);

      // Batch update via queryRunner.manager.createQueryBuilder
      const updateQb = createMockQueryBuilder({
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      });
      mockManagerCreateQueryBuilder.mockReturnValueOnce(updateQb);

      const dto: BulkUpdateDto = {
        mode: "ids",
        transactionIds: ["tx-1"],
        categoryId: null,
        description: null,
      };

      await service.bulkUpdate(userId, dto);

      const setArg = updateQb.set.mock.calls[0][0];
      expect(setArg).toEqual({ categoryId: null, description: null });
    });

    it("updates tags on eligible transactions when tagIds is provided", async () => {
      const tx1 = makeTransaction({ id: "tx-1" });
      const tx2 = makeTransaction({ id: "tx-2" });

      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1" }, { id: "tx-2" }]),
      });
      const exclusionsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([tx1, tx2]),
      });

      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(exclusionsQb);

      const dto: BulkUpdateDto = {
        mode: "ids",
        transactionIds: ["tx-1", "tx-2"],
        tagIds: ["tag-a", "tag-b"],
      };

      await service.bulkUpdate(userId, dto);

      // Tags are applied to all eligible transactions in a single bulk call
      expect(tagsService.setTransactionTagsBulk).toHaveBeenCalledTimes(1);
      expect(tagsService.setTransactionTagsBulk).toHaveBeenCalledWith(
        ["tx-1", "tx-2"],
        ["tag-a", "tag-b"],
        userId,
      );
    });

    it("clears tags when tagIds is empty array", async () => {
      const tx = makeTransaction({ id: "tx-1" });

      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1" }]),
      });
      const exclusionsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([tx]),
      });

      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(exclusionsQb);

      const dto: BulkUpdateDto = {
        mode: "ids",
        transactionIds: ["tx-1"],
        tagIds: [],
      };

      await service.bulkUpdate(userId, dto);

      expect(tagsService.setTransactionTagsBulk).toHaveBeenCalledWith(
        ["tx-1"],
        [],
        userId,
      );
    });

    it("mirrors bulk tags onto the owning split for split-transfer legs", async () => {
      const tx1 = makeTransaction({
        id: "tx-1",
        isTransfer: true,
        linkedTransactionId: "parent-tx",
      });

      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1" }]),
      });
      const exclusionsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([tx1]),
      });
      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(exclusionsQb);

      // classifyTransferLegs: the batch's one transfer leg...
      const syncFindQb = createMockQueryBuilder({
        getMany: jest
          .fn()
          .mockResolvedValue([
            { id: "tx-1", linkedTransactionId: "parent-tx" },
          ]),
      });
      transactionsRepository.createQueryBuilder.mockReturnValue(syncFindQb);
      // ...is owned by a split row, so it is a split-transfer leg.
      mockManagerFind.mockResolvedValue([
        { id: "split-1", linkedTransactionId: "tx-1" },
      ]);

      const dto: BulkUpdateDto = {
        mode: "ids",
        transactionIds: ["tx-1"],
        tagIds: ["tag-a"],
      };

      await service.bulkUpdate(userId, dto);

      // The leg itself gets the tags via the normal bulk call...
      expect(tagsService.setTransactionTagsBulk).toHaveBeenCalledTimes(1);
      expect(tagsService.setTransactionTagsBulk).toHaveBeenCalledWith(
        ["tx-1"],
        ["tag-a"],
        userId,
      );
      // ...and the owning split mirrors them; the parent is never tagged.
      expect(tagsService.setSplitTagsBulk).toHaveBeenCalledWith(
        ["split-1"],
        ["tag-a"],
        userId,
      );
    });

    it("syncs bulk tags to the mirror leg of a plain transfer", async () => {
      const tx1 = makeTransaction({
        id: "tx-1",
        isTransfer: true,
        linkedTransactionId: "tx-1-linked",
      });

      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1" }]),
      });
      const exclusionsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([tx1]),
      });
      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(exclusionsQb);

      const syncFindQb = createMockQueryBuilder({
        getMany: jest
          .fn()
          .mockResolvedValue([
            { id: "tx-1", linkedTransactionId: "tx-1-linked" },
          ]),
      });
      // Cross-owner filter: the mirror leg belongs to the same user.
      const ownLinkedQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1-linked" }]),
      });
      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(syncFindQb)
        .mockReturnValue(ownLinkedQb);
      // No owning split: a plain transfer leg.
      mockManagerFind.mockResolvedValue([]);

      const dto: BulkUpdateDto = {
        mode: "ids",
        transactionIds: ["tx-1"],
        tagIds: ["tag-a"],
      };

      await service.bulkUpdate(userId, dto);

      // Batch call plus a second call covering the mirror leg.
      expect(tagsService.setTransactionTagsBulk).toHaveBeenCalledTimes(2);
      expect(tagsService.setTransactionTagsBulk).toHaveBeenCalledWith(
        ["tx-1-linked"],
        ["tag-a"],
        userId,
      );
      expect(tagsService.setSplitTagsBulk).not.toHaveBeenCalled();
    });

    it("never writes bulk tags onto a cross-owner counterpart leg", async () => {
      const tx1 = makeTransaction({
        id: "tx-1",
        isTransfer: true,
        linkedTransactionId: "foreign-linked",
      });

      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1" }]),
      });
      const exclusionsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([tx1]),
      });
      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(exclusionsQb);

      const syncFindQb = createMockQueryBuilder({
        getMany: jest
          .fn()
          .mockResolvedValue([
            { id: "tx-1", linkedTransactionId: "foreign-linked" },
          ]),
      });
      // Ownership filter: the linked row belongs to another user, so the
      // same-user probe finds nothing to sync.
      const ownLinkedQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([]),
      });
      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(syncFindQb)
        .mockReturnValue(ownLinkedQb);
      mockManagerFind.mockResolvedValue([]);

      await service.bulkUpdate(userId, {
        mode: "ids",
        transactionIds: ["tx-1"],
        tagIds: ["tag-a"],
      });

      // Only the batch's own rows are tagged; the foreign counterpart is not.
      expect(tagsService.setTransactionTagsBulk).toHaveBeenCalledTimes(1);
      expect(tagsService.setTransactionTagsBulk).toHaveBeenCalledWith(
        ["tx-1"],
        ["tag-a"],
        userId,
      );
    });

    it("applies filters in filter mode", async () => {
      const tx = makeTransaction({ id: "tx-1" });

      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1" }]),
      });
      const exclusionsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([tx]),
      });

      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(exclusionsQb);

      // Batch update via queryRunner.manager.createQueryBuilder
      const updateQb = createMockQueryBuilder({
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      });
      mockManagerCreateQueryBuilder.mockReturnValueOnce(updateQb);

      const dto: BulkUpdateDto = {
        mode: "filter",
        filters: {
          accountIds: ["acc-1"],
          startDate: "2026-01-01",
          endDate: "2026-01-31",
        },
        description: "filtered update",
      };

      const result = await service.bulkUpdate(userId, dto);

      expect(result.updated).toBe(1);
      expect(resolveQb.andWhere).toHaveBeenCalled();
    });

    it("skips a lone split parent whose lines all miss, with the One reason and no parent UPDATE", async () => {
      const tx = makeTransaction({
        id: "tx-1",
        isSplit: true,
      });

      // IDOR validation: categoryId is non-null
      categoriesRepository.findOne.mockResolvedValue({
        id: "cat-1",
        userId,
      });

      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1" }]),
      });
      const classifyQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([tx]),
      });

      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(classifyQb);

      // Default split-service mock: no lines matched.
      const dto: BulkUpdateDto = {
        mode: "ids",
        transactionIds: ["tx-1"],
        categoryId: "cat-1",
      };

      const result = await service.bulkUpdate(userId, dto);

      expect(result.updated).toBe(0);
      expect(result.skipped).toBe(1);
      expect(result.skippedReasons).toEqual([
        "1 split transaction was skipped because none of its split lines matched the category update",
      ]);
      // Category-only over an all-splits batch: no parent-row UPDATE at all
      // (I1), and nothing was updated so no undo entry is recorded.
      expect(mockManagerCreateQueryBuilder).not.toHaveBeenCalled();
      expect(actionHistoryService.record).not.toHaveBeenCalled();
    });

    it("excludes future-dated transactions from balance updates when changing status to VOID", async () => {
      const pastTx = makeTransaction({
        id: "tx-1",
        accountId: "acc-1",
        amount: 50,
        transactionDate: "2026-01-15",
      });
      const futureTx = makeTransaction({
        id: "tx-2",
        accountId: "acc-1",
        amount: 200,
        transactionDate: "2027-06-15",
      });

      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1" }, { id: "tx-2" }]),
      });
      const exclusionsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([pastTx, futureTx]),
      });
      // Net worth recalc query (after commit)
      const accountIdsQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([{ accountId: "acc-1" }]),
      });

      // Balance deltas query via queryRunner.manager.getRepository
      const balanceQb = createMockQueryBuilder({
        getRawMany: jest
          .fn()
          .mockResolvedValue([{ accountId: "acc-1", totalAmount: "50" }]),
      });

      // A status change first looks for transfer legs among the selection so a
      // counterpart can be voided with it (audit P5-001); none here.
      const transferLegsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([]),
      });

      // ...then the split-parent discovery for the undo snapshot; none here.
      const splitParentsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([]),
      });

      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(exclusionsQb)
        // The status lock set is discovered from the selection first (A26-M09).
        .mockReturnValueOnce(exclusionsQb)
        .mockReturnValueOnce(transferLegsQb)
        .mockReturnValueOnce(splitParentsQb)
        .mockReturnValueOnce(balanceQb)
        .mockReturnValueOnce(accountIdsQb);

      // Batch update via queryRunner.manager.createQueryBuilder
      const updateQb = createMockQueryBuilder({
        execute: jest.fn().mockResolvedValue({ affected: 2 }),
      });
      mockManagerCreateQueryBuilder.mockReturnValueOnce(updateQb);

      const dto: BulkUpdateDto = {
        mode: "ids",
        transactionIds: ["tx-1", "tx-2"],
        status: TransactionStatus.VOID,
      };

      const result = await service.bulkUpdate(userId, dto);

      expect(result.updated).toBe(2);
      // The balance query should include the today filter via andWhere
      expect(balanceQb.andWhere).toHaveBeenCalledWith(
        "transaction.transactionDate <= :today",
        expect.objectContaining({ today: expect.any(String) }),
      );
      // Only the past transaction's amount (50) should be used for balance update
      expect(accountsService.updateBalance).toHaveBeenCalledWith("acc-1", -50);
    });

    it("excludes future-dated transactions from balance updates when unvoiding", async () => {
      const pastTx = makeTransaction({
        id: "tx-1",
        accountId: "acc-1",
        amount: 100,
        status: TransactionStatus.VOID,
        transactionDate: "2026-01-15",
      });
      const futureTx = makeTransaction({
        id: "tx-2",
        accountId: "acc-1",
        amount: 300,
        status: TransactionStatus.VOID,
        transactionDate: "2027-06-15",
      });

      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1" }, { id: "tx-2" }]),
      });
      const exclusionsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([pastTx, futureTx]),
      });
      // Net worth recalc query (after commit)
      const accountIdsQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([{ accountId: "acc-1" }]),
      });

      // Balance deltas via queryRunner.manager.getRepository
      const balanceQb = createMockQueryBuilder({
        getRawMany: jest
          .fn()
          .mockResolvedValue([{ accountId: "acc-1", totalAmount: "100" }]),
      });

      // A status change first looks for transfer legs among the selection so a
      // counterpart can be voided with it (audit P5-001); none here.
      const transferLegsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([]),
      });

      // ...then the split-parent discovery for the undo snapshot; none here.
      const splitParentsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([]),
      });

      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(exclusionsQb)
        // The status lock set is discovered from the selection first (A26-M09).
        .mockReturnValueOnce(exclusionsQb)
        .mockReturnValueOnce(transferLegsQb)
        .mockReturnValueOnce(splitParentsQb)
        .mockReturnValueOnce(balanceQb)
        .mockReturnValueOnce(accountIdsQb);

      // Batch update via queryRunner.manager.createQueryBuilder
      const updateQb = createMockQueryBuilder({
        execute: jest.fn().mockResolvedValue({ affected: 2 }),
      });
      mockManagerCreateQueryBuilder.mockReturnValueOnce(updateQb);

      const dto: BulkUpdateDto = {
        mode: "ids",
        transactionIds: ["tx-1", "tx-2"],
        status: TransactionStatus.CLEARED,
      };

      const result = await service.bulkUpdate(userId, dto);

      expect(result.updated).toBe(2);
      expect(balanceQb.andWhere).toHaveBeenCalledWith(
        "transaction.transactionDate <= :today",
        expect.objectContaining({ today: expect.any(String) }),
      );
      // Only the past transaction's amount (100) should be added back
      expect(accountsService.updateBalance).toHaveBeenCalledWith("acc-1", 100);
    });
  });

  describe("bulkDelete", () => {
    it("returns zero deleted when no transactions match", async () => {
      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([]),
      });
      transactionsRepository.createQueryBuilder.mockReturnValue(resolveQb);

      const dto: BulkDeleteDto = {
        mode: "ids",
        transactionIds: ["nonexistent"],
      };

      const result = await service.bulkDelete(userId, dto);

      expect(result).toEqual({ deleted: 0 });
    });

    it("deletes transactions by explicit IDs", async () => {
      const tx1 = makeTransaction({ id: "tx-1" });
      const tx2 = makeTransaction({ id: "tx-2" });

      // First call: resolve IDs
      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1" }, { id: "tx-2" }]),
      });
      // Second call: load transaction details
      const detailsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([tx1, tx2]),
        leftJoinAndSelect: jest.fn().mockReturnThis(),
      });

      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(detailsQb);

      // Delete query via queryRunner.manager.createQueryBuilder()
      const deleteQb = createMockQueryBuilder({
        delete: jest.fn().mockReturnThis(),
        from: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 2 }),
      });
      mockManagerCreateQueryBuilder.mockReturnValueOnce(deleteQb);

      const dto: BulkDeleteDto = {
        mode: "ids",
        transactionIds: ["tx-1", "tx-2"],
      };

      const result = await service.bulkDelete(userId, dto);

      expect(result.deleted).toBe(2);
      expect(mockDataSource.transaction).toHaveBeenCalled();
    });

    it("refuses the whole delete when a selected row is an investment cash leg, before any write", async () => {
      const tx1 = makeTransaction({ id: "tx-1" });
      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1" }]),
      });
      const detailsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([tx1]),
        leftJoinAndSelect: jest.fn().mockReturnThis(),
      });
      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(detailsQb);
      mockManagerQuery.mockImplementation(async (sql: string) =>
        String(sql).includes("investment_transactions")
          ? [{ transaction_id: "tx-1" }]
          : [],
      );

      await expect(
        service.bulkDelete(userId, { mode: "ids", transactionIds: ["tx-1"] }),
      ).rejects.toThrow(BadRequestException);

      expect(accountsService.updateBalance).not.toHaveBeenCalled();
      expect(mockManagerCreateQueryBuilder).not.toHaveBeenCalled();
    });

    it("adjusts balances for non-VOID, non-future transactions", async () => {
      const tx1 = makeTransaction({
        id: "tx-1",
        accountId: "acc-1",
        amount: 100,
      });

      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1" }]),
      });
      const detailsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([tx1]),
        leftJoinAndSelect: jest.fn().mockReturnThis(),
      });

      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(detailsQb);

      const deleteQb = createMockQueryBuilder({
        delete: jest.fn().mockReturnThis(),
        from: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      });
      mockManagerCreateQueryBuilder.mockReturnValueOnce(deleteQb);

      const dto: BulkDeleteDto = {
        mode: "ids",
        transactionIds: ["tx-1"],
      };

      await service.bulkDelete(userId, dto);

      expect(accountsService.updateBalance).toHaveBeenCalledWith("acc-1", -100);
    });

    it("does not reverse a row a concurrent request already deleted", async () => {
      // The regression guard for P4-003's double-delete: opening 100.00 and one
      // -10.00 row removed twice left the stored balance 10.00 above the ledger,
      // because both requests reversed an amount only one of them removed. The
      // reversal now comes from the locked row set, so a row that is gone by
      // then contributes nothing.
      const tx1 = makeTransaction({
        id: "tx-1",
        accountId: "acc-1",
        amount: 100,
      });

      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1" }]),
      });
      const detailsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([tx1]),
        leftJoinAndSelect: jest.fn().mockReturnThis(),
      });
      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(detailsQb);

      const deleteQb = createMockQueryBuilder({
        delete: jest.fn().mockReturnThis(),
        from: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 0 }),
      });
      mockManagerCreateQueryBuilder.mockReturnValueOnce(deleteQb);

      // The pre-read found it; the lock did not.
      stageLocked([]);

      const result = await service.bulkDelete(userId, {
        mode: "ids",
        transactionIds: ["tx-1"],
      });

      expect(accountsService.updateBalance).not.toHaveBeenCalled();
      // And the count reports what the database removed, not what the pre-read
      // hoped to remove.
      expect(result.deleted).toBe(0);
    });

    it("recalculates net worth for a linked account reached only through a transfer leg (P5-012)", async () => {
      // Deleting one leg of a transfer also deletes the counterpart and
      // reverses both live balances -- but the recalculation set used to be
      // built from the selected rows alone, so the destination account's
      // monthly net-worth snapshot kept the deleted amount. The dashboard and
      // the history chart then disagreed with the live balance until some
      // unrelated write happened to touch that account.
      //
      // Under the locked-delete path the counterpart's amount and account come
      // from the locked row set rather than a separate load, so staging both
      // legs with makeTransaction is what feeds the reversal and the fan-out.
      const sourceLeg = makeTransaction({
        id: "tx-1",
        accountId: "acc-1",
        amount: -100,
        isTransfer: true,
        linkedTransactionId: "tx-2",
      });
      makeTransaction({
        id: "tx-2",
        accountId: "acc-2",
        amount: 100,
      });

      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1" }]),
      });
      const detailsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([sourceLeg]),
        leftJoinAndSelect: jest.fn().mockReturnThis(),
      });

      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(detailsQb);

      // The linked delete and the primary delete both go through the manager.
      const deleteQb = createMockQueryBuilder({
        delete: jest.fn().mockReturnThis(),
        from: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      });
      mockManagerCreateQueryBuilder.mockReturnValue(deleteQb);

      const dto: BulkDeleteDto = {
        mode: "ids",
        transactionIds: ["tx-1"],
      };

      await service.bulkDelete(userId, dto);

      // Both live balances reversed...
      expect(accountsService.updateBalance).toHaveBeenCalledWith("acc-1", 100);
      expect(accountsService.updateBalance).toHaveBeenCalledWith("acc-2", -100);
      // ...and both accounts' snapshots invalidated, including the one reached
      // only through the linked row.
      expect(netWorthService.triggerDebouncedRecalc).toHaveBeenCalledWith(
        "acc-1",
        userId,
      );
      expect(netWorthService.triggerDebouncedRecalc).toHaveBeenCalledWith(
        "acc-2",
        userId,
      );
    });

    it("does not adjust balance for VOID transactions", async () => {
      const tx1 = makeTransaction({
        id: "tx-1",
        accountId: "acc-1",
        amount: 100,
        status: TransactionStatus.VOID,
      });

      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1" }]),
      });
      const detailsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([tx1]),
        leftJoinAndSelect: jest.fn().mockReturnThis(),
      });

      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(detailsQb);

      const deleteQb = createMockQueryBuilder({
        delete: jest.fn().mockReturnThis(),
        from: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      });
      mockManagerCreateQueryBuilder.mockReturnValueOnce(deleteQb);

      await service.bulkDelete(userId, {
        mode: "ids",
        transactionIds: ["tx-1"],
      });

      expect(accountsService.updateBalance).not.toHaveBeenCalled();
    });

    it("deletes linked transfer counterparts", async () => {
      const tx1 = makeTransaction({
        id: "tx-1",
        isTransfer: true,
        linkedTransactionId: "tx-1-linked",
      });

      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1" }]),
      });
      const detailsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([tx1]),
        leftJoinAndSelect: jest.fn().mockReturnThis(),
      });

      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(detailsQb);

      // Load linked transaction details for balance adjustment
      const linkedTx = makeTransaction({
        id: "tx-1-linked",
        accountId: "acc-2",
        amount: -100,
      });
      mockManagerCreateQueryBuilder.mockImplementation(() =>
        createMockQueryBuilder({
          delete: jest.fn().mockReturnThis(),
          from: jest.fn().mockReturnThis(),
          execute: jest.fn().mockResolvedValue({ affected: 1 }),
          getMany: jest.fn().mockResolvedValue([linkedTx]),
        }),
      );

      await service.bulkDelete(userId, {
        mode: "ids",
        transactionIds: ["tx-1"],
      });

      // Should have called createQueryBuilder multiple times:
      // 1. Load linked transaction details
      // 2. Delete linked transactions
      // 3. Delete primary transactions
      expect(mockManagerCreateQueryBuilder).toHaveBeenCalled();
      expect(mockDataSource.transaction).toHaveBeenCalled();
    });

    it("triggers net worth recalc for affected accounts", async () => {
      const tx1 = makeTransaction({
        id: "tx-1",
        accountId: "acc-1",
      });

      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1" }]),
      });
      const detailsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([tx1]),
        leftJoinAndSelect: jest.fn().mockReturnThis(),
      });

      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(detailsQb);

      const deleteQb = createMockQueryBuilder({
        delete: jest.fn().mockReturnThis(),
        from: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      });
      mockManagerCreateQueryBuilder.mockReturnValueOnce(deleteQb);

      await service.bulkDelete(userId, {
        mode: "ids",
        transactionIds: ["tx-1"],
      });

      expect(netWorthService.triggerDebouncedRecalc).toHaveBeenCalledWith(
        "acc-1",
        userId,
      );
    });

    it("rolls back transaction on error", async () => {
      const tx1 = makeTransaction({ id: "tx-1" });

      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1" }]),
      });
      const detailsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([tx1]),
        leftJoinAndSelect: jest.fn().mockReturnThis(),
      });

      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(detailsQb);

      const deleteQb = createMockQueryBuilder({
        delete: jest.fn().mockReturnThis(),
        from: jest.fn().mockReturnThis(),
        execute: jest.fn().mockRejectedValue(new Error("DB error")),
      });
      mockManagerCreateQueryBuilder.mockReturnValueOnce(deleteQb);

      await expect(
        service.bulkDelete(userId, {
          mode: "ids",
          transactionIds: ["tx-1"],
        }),
      ).rejects.toThrow("DB error");

      expect(mockDataSource.transaction).toHaveBeenCalled();
    });

    it("returns zero deleted when loaded transactions are empty", async () => {
      // resolveTransactionIds returns IDs, but the detail query returns nothing
      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1" }]),
      });
      const detailsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([]),
        leftJoinAndSelect: jest.fn().mockReturnThis(),
      });

      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(detailsQb);

      const result = await service.bulkDelete(userId, {
        mode: "ids",
        transactionIds: ["tx-1"],
      });

      expect(result).toEqual({ deleted: 0 });
      // Only the two read transactions (id resolve + detail load) ran: the
      // delete block is skipped entirely when nothing loads.
      expect(mockDataSource.transaction).toHaveBeenCalledTimes(2);
    });

    it("deletes linked transactions from split transfers", async () => {
      const splitTx = makeTransaction({
        id: "tx-1",
        accountId: "acc-1",
        amount: -50,
        isSplit: true,
      });
      makeTransaction({
        id: "split-linked-1",
        accountId: "acc-2",
        amount: 50,
        isTransfer: true,
        linkedTransactionId: "tx-1",
      });

      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1" }]),
      });
      const detailsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([splitTx]),
      });
      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(detailsQb);

      // The parent's split rows are read under the parent's lock; the leg
      // lookup (by linkedTransactionId) finds none for a selected parent.
      mockManagerFind.mockImplementation(
        async (_entity: unknown, opts: { where: Record<string, unknown> }) =>
          "transactionId" in opts.where
            ? [{ transactionId: "tx-1", linkedTransactionId: "split-linked-1" }]
            : [],
      );
      const deletes: unknown[] = [];
      mockManagerCreateQueryBuilder.mockImplementation(() => {
        const qb = createMockQueryBuilder({
          delete: jest.fn().mockReturnThis(),
          from: jest.fn().mockReturnThis(),
          execute: jest.fn().mockResolvedValue({ affected: 1 }),
        });
        qb.where = jest.fn().mockImplementation((_sql, params) => {
          deletes.push(params.ids);
          return qb;
        });
        return qb;
      });

      await service.bulkDelete(userId, {
        mode: "ids",
        transactionIds: ["tx-1"],
      });

      // Each row reverses exactly its own amount: the parent's -50 and the
      // leg's +50, never a blanket "something moved".
      expect(accountsService.updateBalance).toHaveBeenCalledWith("acc-1", 50);
      expect(accountsService.updateBalance).toHaveBeenCalledWith("acc-2", -50);
      expect(accountsService.updateBalance).toHaveBeenCalledTimes(2);
      expect(deletes).toEqual([["split-linked-1"], ["tx-1"]]);
    });

    it("expands a selected split-transfer leg to its parent and every sibling leg (A26-H05)", async () => {
      // A -100 split to B (-60 line, +60 leg) and C (-40 line, +40 leg); the
      // user selects B's leg only.
      makeTransaction({
        id: "parent",
        accountId: "acc-a",
        amount: -100,
        isSplit: true,
      });
      const bLeg = makeTransaction({
        id: "leg-b",
        accountId: "acc-b",
        amount: 60,
        isTransfer: true,
        linkedTransactionId: "parent",
      });
      makeTransaction({
        id: "leg-c",
        accountId: "acc-c",
        amount: 40,
        isTransfer: true,
        linkedTransactionId: "parent",
      });

      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "leg-b" }]),
      });
      const detailsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([bLeg]),
      });
      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(detailsQb);

      mockManagerFind.mockImplementation(
        async (_entity: unknown, opts: { where: Record<string, unknown> }) =>
          "transactionId" in opts.where
            ? [
                { transactionId: "parent", linkedTransactionId: "leg-b" },
                { transactionId: "parent", linkedTransactionId: "leg-c" },
              ]
            : [{ transactionId: "parent" }],
      );
      const deletes: unknown[] = [];
      mockManagerCreateQueryBuilder.mockImplementation(() => {
        const qb = createMockQueryBuilder({
          delete: jest.fn().mockReturnThis(),
          from: jest.fn().mockReturnThis(),
          execute: jest.fn().mockResolvedValue({ affected: 1 }),
        });
        qb.where = jest.fn().mockImplementation((_sql, params) => {
          deletes.push([...params.ids].sort());
          return qb;
        });
        return qb;
      });
      (lockTransactionRows as jest.Mock).mockClear();

      const result = await service.bulkDelete(userId, {
        mode: "ids",
        transactionIds: ["leg-b"],
      });

      expect(result).toEqual({ deleted: 1 });
      expect(accountsService.updateBalance).toHaveBeenCalledWith("acc-a", 100);
      expect(accountsService.updateBalance).toHaveBeenCalledWith("acc-b", -60);
      expect(accountsService.updateBalance).toHaveBeenCalledWith("acc-c", -40);
      expect(deletes).toEqual([["leg-c", "parent"], ["leg-b"]]);
      // By role: the split parent is locked on its own before any leg.
      const lockCalls = (lockTransactionRows as jest.Mock).mock.calls;
      expect(lockCalls[0][1]).toEqual(["parent"]);
      expect([...lockCalls[1][1]].sort()).toEqual(["leg-b", "leg-c"]);
      expect(netWorthService.triggerDebouncedRecalc).toHaveBeenCalledWith(
        "acc-c",
        userId,
      );
    });

    it("counts a selected split-transfer leg the split cleanup already removed", async () => {
      // A -100 split to B (-60 line, +60 leg) and C (-40 line, +40 leg); the
      // user selects B's leg only.
      makeTransaction({
        id: "parent",
        accountId: "acc-a",
        amount: -100,
        isSplit: true,
      });
      const bLeg = makeTransaction({
        id: "leg-b",
        accountId: "acc-b",
        amount: 60,
        isTransfer: true,
        linkedTransactionId: "parent",
      });
      makeTransaction({
        id: "leg-c",
        accountId: "acc-c",
        amount: 40,
        isTransfer: true,
        linkedTransactionId: "parent",
      });

      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "leg-b" }]),
      });
      const detailsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([bLeg]),
      });
      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(detailsQb);

      mockManagerFind.mockImplementation(
        async (_entity: unknown, opts: { where: Record<string, unknown> }) =>
          "transactionId" in opts.where
            ? [
                {
                  transactionId: "parent",
                  linkedTransactionId: "leg-b",
                  transferAccountId: "acc-b",
                },
                {
                  transactionId: "parent",
                  linkedTransactionId: "leg-c",
                  transferAccountId: "acc-c",
                },
              ]
            : [{ transactionId: "parent" }],
      );
      const deletes: unknown[] = [];
      mockManagerCreateQueryBuilder.mockImplementation(() => {
        const qb = createMockQueryBuilder({
          delete: jest.fn().mockReturnThis(),
          from: jest.fn().mockReturnThis(),
          // The cleanup removed leg-b already: the primary DELETE of
          // ["leg-b"] finds nothing.
          execute: jest.fn().mockImplementation(async () => ({
            affected:
              deletes[deletes.length - 1]?.toString() === "leg-b" ? 0 : 1,
          })),
        });
        qb.where = jest.fn().mockImplementation((_sql, params) => {
          deletes.push([...params.ids].sort());
          return qb;
        });
        return qb;
      });
      (lockTransactionRows as jest.Mock).mockClear();

      const result = await service.bulkDelete(userId, {
        mode: "ids",
        transactionIds: ["leg-b"],
      });

      expect(result).toEqual({ deleted: 1 });
    });

    it("does not adjust balance for future-dated transactions", async () => {
      const dateUtils = jest.requireMock("../common/date-utils");
      dateUtils.isTransactionInFuture.mockReturnValueOnce(true);

      const futureTx = makeTransaction({
        id: "tx-1",
        accountId: "acc-1",
        amount: 200,
        transactionDate: "2099-01-01",
      });

      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1" }]),
      });
      const detailsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([futureTx]),
        leftJoinAndSelect: jest.fn().mockReturnThis(),
      });

      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(detailsQb);

      const deleteQb = createMockQueryBuilder({
        delete: jest.fn().mockReturnThis(),
        from: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      });
      mockManagerCreateQueryBuilder.mockReturnValueOnce(deleteQb);

      await service.bulkDelete(userId, {
        mode: "ids",
        transactionIds: ["tx-1"],
      });

      expect(accountsService.updateBalance).not.toHaveBeenCalled();
    });

    it("does not include linked transfers already in the deletion set", async () => {
      // Both sides of a transfer are being deleted together
      const tx1 = makeTransaction({
        id: "tx-1",
        isTransfer: true,
        linkedTransactionId: "tx-2",
        accountId: "acc-1",
        amount: 100,
      });
      const tx2 = makeTransaction({
        id: "tx-2",
        isTransfer: true,
        linkedTransactionId: "tx-1",
        accountId: "acc-2",
        amount: -100,
      });

      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1" }, { id: "tx-2" }]),
      });
      const detailsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([tx1, tx2]),
        leftJoinAndSelect: jest.fn().mockReturnThis(),
      });

      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(detailsQb);

      // No linked transactions to load because both are already in the set
      const deleteQb = createMockQueryBuilder({
        delete: jest.fn().mockReturnThis(),
        from: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 2 }),
      });
      mockManagerCreateQueryBuilder.mockReturnValueOnce(deleteQb);

      await service.bulkDelete(userId, {
        mode: "ids",
        transactionIds: ["tx-1", "tx-2"],
      });

      // Only one delete call (no separate linked deletion since both are primary)
      expect(mockManagerCreateQueryBuilder).toHaveBeenCalledTimes(1);
      expect(mockDataSource.transaction).toHaveBeenCalled();
    });
  });

  describe("bulk command consistency", () => {
    const resolveAndClassify = (rows: Transaction[]) => {
      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue(rows.map((r) => ({ id: r.id }))),
      });
      const classifyQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue(rows),
      });
      return { resolveQb, classifyQb };
    };

    it("takes 'today' for the VOID balance pass from todayYMD, the request's day", async () => {
      const tx = makeTransaction({ id: "tx-1" });
      const { resolveQb, classifyQb } = resolveAndClassify([tx]);
      const emptyQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([]),
      });
      const balanceQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([]),
      });
      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(classifyQb)
        .mockReturnValueOnce(classifyQb)
        .mockReturnValueOnce(emptyQb)
        .mockReturnValueOnce(emptyQb)
        .mockReturnValueOnce(balanceQb)
        .mockReturnValue(emptyQb);
      mockManagerCreateQueryBuilder.mockReturnValue(
        createMockQueryBuilder({
          execute: jest.fn().mockResolvedValue({ affected: 1 }),
        }),
      );
      jest
        .requireMock("../common/date-utils")
        .todayYMD.mockReturnValueOnce("2031-05-05");

      await service.bulkUpdate(userId, {
        mode: "ids",
        transactionIds: ["tx-1"],
        status: TransactionStatus.VOID,
      } as BulkUpdateDto);

      expect(balanceQb.andWhere).toHaveBeenCalledWith(
        "transaction.transactionDate <= :today",
        { today: "2031-05-05" },
      );
    });

    it("refuses before any write when a mirror leg the description sync writes is reconciled", async () => {
      const tx = makeTransaction({
        id: "tx-1",
        isTransfer: true,
        linkedTransactionId: "mirror",
      });
      const { resolveQb, classifyQb } = resolveAndClassify([tx]);
      const transfersQb = createMockQueryBuilder({
        getMany: jest
          .fn()
          .mockResolvedValue([{ id: "tx-1", linkedTransactionId: "mirror" }]),
      });
      const ownQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "mirror" }]),
      });
      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(classifyQb)
        .mockReturnValueOnce(transfersQb)
        .mockReturnValue(ownQb);
      userPreferenceRepository.findOne.mockResolvedValue({
        userId,
        lockReconciledTransactions: true,
      });
      // Only the mirror is reconciled; the selected leg is not.
      mockManagerQuery.mockImplementation(
        async (_sql: string, params: unknown[]) =>
          (params[0] as string[]).includes("mirror")
            ? [{ status: TransactionStatus.RECONCILED }]
            : [],
      );

      await expect(
        service.bulkUpdate(userId, {
          mode: "ids",
          transactionIds: ["tx-1"],
          description: "Y",
        } as BulkUpdateDto),
      ).rejects.toThrow(ConflictException);
      expect(mockManagerCreateQueryBuilder).not.toHaveBeenCalled();
    });

    it("refuses a guarded leg that crosses the VOID boundary on the locked row", async () => {
      // The pre-read saw tx-1 already VOID (so "voiding" it crosses nothing and
      // it was not skipped); a concurrent un-void committed before the lock.
      const preRead = makeTransaction({
        id: "tx-1",
        status: TransactionStatus.VOID,
      });
      stageLocked([preRead]);
      stubLockedTransactions(
        {
          lockTransactionRow: jest.fn(),
          lockTransactionRows: lockTransactionRows as jest.Mock,
        },
        [
          lockedTransactionRow({
            id: "tx-1",
            status: TransactionStatus.UNRECONCILED,
          }),
        ],
      );
      const { resolveQb, classifyQb } = resolveAndClassify([preRead]);
      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(classifyQb)
        .mockReturnValue(classifyQb);
      mockManagerQuery.mockImplementation(async (sql: string) =>
        String(sql).includes("investment_transactions")
          ? [{ transaction_id: "tx-1" }]
          : [],
      );

      await expect(
        service.bulkUpdate(userId, {
          mode: "ids",
          transactionIds: ["tx-1"],
          status: TransactionStatus.VOID,
        } as BulkUpdateDto),
      ).rejects.toThrow(ConflictException);
      expect(mockManagerCreateQueryBuilder).not.toHaveBeenCalled();
      expect(accountsService.updateBalance).not.toHaveBeenCalled();
    });

    it("bulk delete runs the split side effects once per split parent and does not reverse its transfer legs twice", async () => {
      const splitTx = makeTransaction({
        id: "tx-1",
        accountId: "acc-1",
        amount: -50,
        isSplit: true,
      });
      makeTransaction({
        id: "leg-1",
        accountId: "acc-2",
        amount: 50,
        isTransfer: true,
        linkedTransactionId: "tx-1",
      });
      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1" }]),
      });
      const detailsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([splitTx]),
      });
      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(detailsQb);
      mockManagerFind.mockImplementation(
        async (_entity: unknown, opts: { where: Record<string, unknown> }) =>
          "transactionId" in opts.where
            ? [
                {
                  transactionId: "tx-1",
                  linkedTransactionId: "leg-1",
                  transferAccountId: "acc-2",
                },
              ]
            : [],
      );
      mockManagerCreateQueryBuilder.mockReturnValue(
        createMockQueryBuilder({
          delete: jest.fn().mockReturnThis(),
          from: jest.fn().mockReturnThis(),
          execute: jest.fn().mockResolvedValue({ affected: 1 }),
        }),
      );
      splitService.deleteSplitSideEffects.mockResolvedValue(new Set(["acc-2"]));

      await service.bulkDelete(userId, {
        mode: "ids",
        transactionIds: ["tx-1"],
      });

      expect(splitService.deleteSplitSideEffects).toHaveBeenCalledTimes(1);
      expect(splitService.deleteSplitSideEffects).toHaveBeenCalledWith(
        "tx-1",
        userId,
        { touchedSecurityIds: expect.any(Set) },
      );
      // The helper reversed the leg; only the parent's own amount moves here.
      expect(accountsService.updateBalance).toHaveBeenCalledTimes(1);
      expect(accountsService.updateBalance).toHaveBeenCalledWith("acc-1", 50);
      expect(netWorthService.triggerDebouncedRecalc).toHaveBeenCalledWith(
        "acc-2",
        userId,
      );
      expect(splitService.recomputeBondPricesAfterWrite).toHaveBeenCalled();
    });
  });

  describe("bulkUpdate - validation", () => {
    it("throws NotFoundException when categoryId does not belong to user", async () => {
      categoriesRepository.findOne.mockResolvedValue(null);

      const dto: BulkUpdateDto = {
        mode: "ids",
        transactionIds: ["tx-1"],
        categoryId: "invalid-cat",
      };

      await expect(service.bulkUpdate(userId, dto)).rejects.toThrow(
        "Category not found",
      );
    });

    it("throws NotFoundException when payeeId does not belong to user", async () => {
      payeesRepository.findOne.mockResolvedValue(null);

      const dto: BulkUpdateDto = {
        mode: "ids",
        transactionIds: ["tx-1"],
        payeeId: "invalid-payee",
      };

      await expect(service.bulkUpdate(userId, dto)).rejects.toThrow(
        "Payee not found",
      );
    });

    it("does not stamp a reconciliation state onto the counterpart's ledger", async () => {
      // VOID-membership is shared (the two legs are one movement of money);
      // reconciliation states are per-ledger. Ungated, a bulk CLEARED while
      // working a checking statement re-wrote the savings counterpart's
      // reconciliation state -- an account whose statement was never touched.
      const sourceLeg = makeTransaction({
        id: "tx-1",
        accountId: "acc-1",
        amount: -100,
        isTransfer: true,
        linkedTransactionId: "tx-2",
        status: TransactionStatus.UNRECONCILED,
      });

      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1" }]),
      });
      const exclusionsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([sourceLeg]),
      });
      // The transfer-leg lookup: the leg is NOT crossing the VOID boundary
      // (UNRECONCILED -> CLEARED), so no counterpart is pulled in.
      const transferLegsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([
          {
            id: "tx-1",
            linkedTransactionId: "tx-2",
            status: TransactionStatus.UNRECONCILED,
          },
        ]),
      });
      const splitParentsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([]),
      });
      const balanceQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([]),
      });
      const accountIdsQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([{ accountId: "acc-1" }]),
      });

      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(exclusionsQb)
        // The status lock set is discovered from the selection first (A26-M09).
        .mockReturnValueOnce(exclusionsQb)
        .mockReturnValueOnce(transferLegsQb)
        .mockReturnValueOnce(splitParentsQb)
        .mockReturnValueOnce(balanceQb)
        .mockReturnValueOnce(accountIdsQb);

      mockManagerFind.mockResolvedValue([]);

      const updateQb = createMockQueryBuilder({
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      });
      mockManagerCreateQueryBuilder.mockReturnValue(updateQb);

      await service.bulkUpdate(userId, {
        mode: "ids",
        transactionIds: ["tx-1"],
        status: TransactionStatus.CLEARED,
      });

      // The status UPDATE covers only the selected leg.
      const idsPassed = (
        updateQb.where.mock.calls.map((c: unknown[]) => c[1]) as Array<{
          ids?: string[];
        }>
      ).find((params) => Array.isArray(params?.ids))?.ids;
      expect(idsPassed).toEqual(["tx-1"]);
    });

    it("voids a transfer counterpart along with the selected leg (P5-001)", async () => {
      // Selecting one leg and voiding it used to leave the counterpart active:
      // the source's balance was restored and the destination kept the money,
      // so the pair created 100 out of nothing. Both legs must change together.
      const sourceLeg = makeTransaction({
        id: "tx-1",
        accountId: "acc-1",
        amount: -100,
        isTransfer: true,
        linkedTransactionId: "tx-2",
      });

      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1" }]),
      });
      const exclusionsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([sourceLeg]),
      });
      // The transfer-leg lookup that finds the counterpart to pull in.
      const transferLegsQb = createMockQueryBuilder({
        getMany: jest
          .fn()
          .mockResolvedValue([{ id: "tx-1", linkedTransactionId: "tx-2" }]),
      });
      // Ownership filter on the counterpart: same user, so it is included.
      const sameUserQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-2" }]),
      });
      // Balance deltas across the expanded set.
      const balanceQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([
          { accountId: "acc-1", totalAmount: "-100" },
          { accountId: "acc-2", totalAmount: "100" },
        ]),
      });
      const accountIdsQb = createMockQueryBuilder({
        getRawMany: jest
          .fn()
          .mockResolvedValue([{ accountId: "acc-1" }, { accountId: "acc-2" }]),
      });

      // Split-parent discovery for the undo snapshot; none here.
      const splitParentsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([]),
      });

      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(exclusionsQb)
        // The status lock set is discovered from the selection first (A26-M09).
        .mockReturnValueOnce(exclusionsQb)
        .mockReturnValueOnce(transferLegsQb)
        .mockReturnValueOnce(sameUserQb)
        .mockReturnValueOnce(splitParentsQb)
        .mockReturnValueOnce(balanceQb)
        .mockReturnValueOnce(accountIdsQb);

      // No owning split rows: this is a plain transfer, so the counterpart is a
      // mirror leg rather than a split parent.
      mockManagerFind.mockResolvedValue([]);

      const updateQb = createMockQueryBuilder({
        execute: jest.fn().mockResolvedValue({ affected: 2 }),
      });
      mockManagerCreateQueryBuilder.mockReturnValue(updateQb);

      const dto: BulkUpdateDto = {
        mode: "ids",
        transactionIds: ["tx-1"],
        status: TransactionStatus.VOID,
      };

      await service.bulkUpdate(userId, dto);

      // The status UPDATE covers both legs, not just the selected one.
      const statusUpdate = updateQb.where.mock.calls.find(
        (call: unknown[]) =>
          typeof call[0] === "string" && call[0].includes("id IN"),
      );
      expect(statusUpdate).toBeDefined();
      const idsPassed = (
        updateQb.where.mock.calls.map((c: unknown[]) => c[1]) as Array<{
          ids?: string[];
        }>
      ).flatMap((p) => p?.ids ?? []);
      expect(idsPassed).toContain("tx-1");
      expect(idsPassed).toContain("tx-2");

      // Both accounts' balances adjusted, so no money is created.
      expect(accountsService.updateBalance).toHaveBeenCalledWith("acc-1", 100);
      expect(accountsService.updateBalance).toHaveBeenCalledWith("acc-2", -100);
    });

    it("returns empty when transactionIds is empty array in ids mode", async () => {
      const dto: BulkUpdateDto = {
        mode: "ids",
        transactionIds: [],
        description: "test",
      };

      const result = await service.bulkUpdate(userId, dto);

      expect(result).toEqual({ updated: 0, skipped: 0, skippedReasons: [] });
    });

    it("rolls back transaction on error in bulkUpdate", async () => {
      const tx = makeTransaction({ id: "tx-1" });

      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1" }]),
      });
      const exclusionsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([tx]),
      });

      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(exclusionsQb);

      // Make the batch update fail
      const updateQb = createMockQueryBuilder({
        execute: jest.fn().mockRejectedValue(new Error("Update failed")),
      });
      mockManagerCreateQueryBuilder.mockReturnValueOnce(updateQb);

      const dto: BulkUpdateDto = {
        mode: "ids",
        transactionIds: ["tx-1"],
        description: "fail",
      };

      await expect(service.bulkUpdate(userId, dto)).rejects.toThrow(
        "Update failed",
      );

      expect(mockDataSource.transaction).toHaveBeenCalled();
    });

    it("pluralizes the skip reason when several split parents have no matching lines", async () => {
      const tx1 = makeTransaction({ id: "tx-1", isSplit: true });
      const tx2 = makeTransaction({ id: "tx-2", isSplit: true });
      const tx3 = makeTransaction({ id: "tx-3" });

      categoriesRepository.findOne.mockResolvedValue({ id: "cat-1", userId });

      const resolveQb = createMockQueryBuilder({
        getMany: jest
          .fn()
          .mockResolvedValue([{ id: "tx-1" }, { id: "tx-2" }, { id: "tx-3" }]),
      });
      const classifyQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([tx1, tx2, tx3]),
      });

      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(classifyQb);

      const updateQb = createMockQueryBuilder({
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      });
      mockManagerCreateQueryBuilder.mockReturnValueOnce(updateQb);

      // Default split-service mock: no lines matched on either split parent.
      const dto: BulkUpdateDto = {
        mode: "ids",
        transactionIds: ["tx-1", "tx-2", "tx-3"],
        categoryId: "cat-1",
      };

      const result = await service.bulkUpdate(userId, dto);

      expect(result.updated).toBe(1);
      expect(result.skipped).toBe(2);
      expect(result.skippedReasons).toEqual([
        "2 split transactions were skipped because none of their split lines matched the category update",
      ]);
      expect(result).not.toHaveProperty("splitLinesUpdated");
      // The parent categoryId UPDATE still targets only the non-split row.
      expect(updateQb.where).toHaveBeenCalledWith("id IN (:...ids)", {
        ids: ["tx-3"],
      });
    });
  });

  describe("bulkUpdate - filter mode", () => {
    it("applies categoryIds filter with regular categories", async () => {
      const tx = makeTransaction({ id: "tx-1" });

      // getAllCategoryIdsWithChildren uses categoriesRepository.find
      categoriesRepository.find.mockResolvedValue([
        { id: "cat-1", parentId: null },
        { id: "cat-1-child", parentId: "cat-1" },
      ]);

      const innerMockWhereBuilder = {
        where: jest.fn().mockReturnThis(),
        orWhere: jest.fn().mockReturnThis(),
      };

      const mockWhereBuilder = {
        where: jest.fn().mockImplementation(function (arg) {
          if (arg instanceof Brackets) {
            (arg as any).whereFactory(innerMockWhereBuilder);
          }
          return mockWhereBuilder;
        }),
        orWhere: jest.fn().mockReturnThis(),
      };

      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1" }]),
        leftJoin: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockImplementation(function (arg) {
          if (arg instanceof Brackets) {
            (arg as any).whereFactory(mockWhereBuilder);
          }
          return resolveQb;
        }),
      });
      const exclusionsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([tx]),
      });

      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(exclusionsQb);

      const updateQb = createMockQueryBuilder({
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      });
      mockManagerCreateQueryBuilder.mockReturnValueOnce(updateQb);

      const dto: BulkUpdateDto = {
        mode: "filter",
        filters: {
          categoryIds: ["cat-1"],
        },
        description: "test",
      };

      const result = await service.bulkUpdate(userId, dto);

      expect(result.updated).toBe(1);
      expect(resolveQb.leftJoin).toHaveBeenCalledWith(
        "transaction.splits",
        "filterSplits",
      );
      // Only regular categories, so first condition uses "where" not "orWhere"
      expect(mockWhereBuilder.where).toHaveBeenCalled();
      expect(innerMockWhereBuilder.where).toHaveBeenCalledWith(
        "transaction.categoryId IN (:...filterCategoryIds)",
        expect.objectContaining({ filterCategoryIds: expect.any(Array) }),
      );
    });

    it("applies payeeIds filter", async () => {
      const tx = makeTransaction({ id: "tx-1" });

      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1" }]),
      });
      const exclusionsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([tx]),
      });

      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(exclusionsQb);

      const updateQb = createMockQueryBuilder({
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      });
      mockManagerCreateQueryBuilder.mockReturnValueOnce(updateQb);

      const dto: BulkUpdateDto = {
        mode: "filter",
        filters: {
          payeeIds: ["payee-1"],
        },
        description: "test",
      };

      const result = await service.bulkUpdate(userId, dto);

      expect(result.updated).toBe(1);
      expect(resolveQb.andWhere).toHaveBeenCalledWith(
        "transaction.payeeId IN (:...payeeIds)",
        { payeeIds: ["payee-1"] },
      );
    });

    it("applies search filter without categoryIds", async () => {
      const tx = makeTransaction({ id: "tx-1" });

      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1" }]),
        leftJoin: jest.fn().mockReturnThis(),
      });
      const exclusionsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([tx]),
      });

      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(exclusionsQb);

      const updateQb = createMockQueryBuilder({
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      });
      mockManagerCreateQueryBuilder.mockReturnValueOnce(updateQb);

      const dto: BulkUpdateDto = {
        mode: "filter",
        filters: {
          search: "groceries",
        },
        description: "test",
      };

      const result = await service.bulkUpdate(userId, dto);

      expect(result.updated).toBe(1);
      // Should join searchSplits when no categoryIds
      expect(resolveQb.leftJoin).toHaveBeenCalledWith(
        "transaction.splits",
        "searchSplits",
      );
      expect(resolveQb.andWhere).toHaveBeenCalledWith(
        ...expectedSearch("groceries", {
          transaction: "transaction",
          splits: "searchSplits",
        }),
      );
    });

    it("applies search filter with categoryIds (uses filterSplits alias)", async () => {
      const tx = makeTransaction({ id: "tx-1" });

      categoriesRepository.find.mockResolvedValue([
        { id: "cat-1", parentId: null },
      ]);

      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1" }]),
        leftJoin: jest.fn().mockReturnThis(),
      });
      const exclusionsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([tx]),
      });

      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(exclusionsQb);

      const updateQb = createMockQueryBuilder({
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      });
      mockManagerCreateQueryBuilder.mockReturnValueOnce(updateQb);

      const dto: BulkUpdateDto = {
        mode: "filter",
        filters: {
          categoryIds: ["cat-1"],
          search: "food",
        },
        description: "test",
      };

      const result = await service.bulkUpdate(userId, dto);

      expect(result.updated).toBe(1);
      // Search should use filterSplits alias (already joined by category filter)
      expect(resolveQb.andWhere).toHaveBeenCalledWith(
        ...expectedSearch("food", {
          transaction: "transaction",
          splits: "filterSplits",
        }),
      );
    });

    it("joins its own split alias when the category filter holds only pseudo-ids", async () => {
      // The category filter joins `filterSplits` only for real category ids,
      // so a search beside `uncategorized` alone must not name that alias.
      const tx = makeTransaction({ id: "tx-1" });

      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1" }]),
        leftJoin: jest.fn().mockReturnThis(),
      });
      const exclusionsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([tx]),
      });

      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(exclusionsQb);

      const updateQb = createMockQueryBuilder({
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      });
      mockManagerCreateQueryBuilder.mockReturnValueOnce(updateQb);

      const dto: BulkUpdateDto = {
        mode: "filter",
        filters: {
          categoryIds: ["uncategorized"],
          search: "food",
        },
        description: "test",
      };

      await service.bulkUpdate(userId, dto);

      expect(resolveQb.leftJoin).not.toHaveBeenCalledWith(
        "transaction.splits",
        "filterSplits",
      );
      expect(resolveQb.leftJoin).toHaveBeenCalledWith(
        "transaction.splits",
        "searchSplits",
      );
      expect(resolveQb.andWhere).toHaveBeenCalledWith(
        ...expectedSearch("food", {
          transaction: "transaction",
          splits: "searchSplits",
        }),
      );
    });

    it("applies uncategorized category filter", async () => {
      const tx = makeTransaction({ id: "tx-1" });

      const mockWhereBuilder = {
        where: jest.fn().mockReturnThis(),
        orWhere: jest.fn().mockReturnThis(),
      };

      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1" }]),
        leftJoin: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockImplementation(function (arg) {
          if (arg instanceof Brackets) {
            (arg as any).whereFactory(mockWhereBuilder);
          }
          return resolveQb;
        }),
      });
      const exclusionsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([tx]),
      });

      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(exclusionsQb);

      const updateQb = createMockQueryBuilder({
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      });
      mockManagerCreateQueryBuilder.mockReturnValueOnce(updateQb);

      const dto: BulkUpdateDto = {
        mode: "filter",
        filters: {
          categoryIds: ["uncategorized"],
        },
        description: "test",
      };

      const result = await service.bulkUpdate(userId, dto);

      expect(result.updated).toBe(1);
      expect(resolveQb.leftJoin).toHaveBeenCalledWith(
        "transaction.account",
        "filterAccount",
      );
      // The Brackets callback should have invoked where (first condition uses "where")
      expect(mockWhereBuilder.where).toHaveBeenCalledWith(
        expect.stringContaining("transaction.categoryId IS NULL"),
      );
      // This is a WRITE path: "select all uncategorized" must not reach the cash
      // legs a trade owns, and the securities sleeve is not ordinary cash
      // either. Membership is provenance, never the account's type (issue
      // #1257) -- so neither predicate may drift back to accountType here.
      const [uncategorizedClause] = mockWhereBuilder.where.mock.calls[0];
      expect(uncategorizedClause).toContain(
        "filterAccount.accountSubType != 'INVESTMENT_BROKERAGE'",
      );
      expect(uncategorizedClause).toContain(
        "NOT EXISTS (SELECT 1 FROM investment_transactions it WHERE it.transaction_id = transaction.id)",
      );
      expect(uncategorizedClause).not.toContain("accountType");
    });

    it("applies transfer category filter", async () => {
      const tx = makeTransaction({ id: "tx-1" });

      const mockWhereBuilder = {
        where: jest.fn().mockReturnThis(),
        orWhere: jest.fn().mockReturnThis(),
      };

      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1" }]),
        andWhere: jest.fn().mockImplementation(function (arg) {
          if (arg instanceof Brackets) {
            (arg as any).whereFactory(mockWhereBuilder);
          }
          return resolveQb;
        }),
      });
      const exclusionsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([tx]),
      });

      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(exclusionsQb);

      const updateQb = createMockQueryBuilder({
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      });
      mockManagerCreateQueryBuilder.mockReturnValueOnce(updateQb);

      const dto: BulkUpdateDto = {
        mode: "filter",
        filters: {
          categoryIds: ["transfer"],
        },
        description: "test",
      };

      const result = await service.bulkUpdate(userId, dto);

      expect(result.updated).toBe(1);
      expect(mockWhereBuilder.where).toHaveBeenCalledWith(
        "transaction.isTransfer = true",
      );
    });

    it("applies combined uncategorized + transfer + regular category filters", async () => {
      const tx = makeTransaction({ id: "tx-1" });

      categoriesRepository.find.mockResolvedValue([
        { id: "cat-1", parentId: null },
      ]);

      const innerMockWhereBuilder = {
        where: jest.fn().mockReturnThis(),
        orWhere: jest.fn().mockReturnThis(),
      };

      const mockWhereBuilder = {
        where: jest.fn().mockReturnThis(),
        orWhere: jest.fn().mockImplementation(function (arg) {
          if (arg instanceof Brackets) {
            (arg as any).whereFactory(innerMockWhereBuilder);
          }
          return mockWhereBuilder;
        }),
      };

      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1" }]),
        leftJoin: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockImplementation(function (arg) {
          if (arg instanceof Brackets) {
            (arg as any).whereFactory(mockWhereBuilder);
          }
          return resolveQb;
        }),
      });
      const exclusionsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([tx]),
      });

      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(exclusionsQb);

      const updateQb = createMockQueryBuilder({
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      });
      mockManagerCreateQueryBuilder.mockReturnValueOnce(updateQb);

      const dto: BulkUpdateDto = {
        mode: "filter",
        filters: {
          categoryIds: ["uncategorized", "transfer", "cat-1"],
        },
        description: "test",
      };

      const result = await service.bulkUpdate(userId, dto);

      expect(result.updated).toBe(1);
      expect(resolveQb.leftJoin).toHaveBeenCalledWith(
        "transaction.account",
        "filterAccount",
      );
      expect(resolveQb.leftJoin).toHaveBeenCalledWith(
        "transaction.splits",
        "filterSplits",
      );
      // First condition uses "where", subsequent use "orWhere"
      expect(mockWhereBuilder.where).toHaveBeenCalledWith(
        expect.stringContaining("transaction.categoryId IS NULL"),
      );
      expect(mockWhereBuilder.orWhere).toHaveBeenCalledWith(
        "transaction.isTransfer = true",
      );
      // Inner brackets for regular category IDs
      expect(innerMockWhereBuilder.where).toHaveBeenCalledWith(
        "transaction.categoryId IN (:...filterCategoryIds)",
        expect.objectContaining({ filterCategoryIds: expect.any(Array) }),
      );
      expect(innerMockWhereBuilder.orWhere).toHaveBeenCalledWith(
        "filterSplits.categoryId IN (:...filterCategoryIds)",
        expect.objectContaining({ filterCategoryIds: expect.any(Array) }),
      );
    });

    it("escapes special characters in search filter", async () => {
      const tx = makeTransaction({ id: "tx-1" });

      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1" }]),
        leftJoin: jest.fn().mockReturnThis(),
      });
      const exclusionsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([tx]),
      });

      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(exclusionsQb);

      const updateQb = createMockQueryBuilder({
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      });
      mockManagerCreateQueryBuilder.mockReturnValueOnce(updateQb);

      const dto: BulkUpdateDto = {
        mode: "filter",
        filters: {
          search: "100% off_sale\\deal",
        },
        description: "test",
      };

      await service.bulkUpdate(userId, dto);

      const expected = expectedSearch("100% off_sale\\deal", {
        transaction: "transaction",
        splits: "searchSplits",
      });
      expect(resolveQb.andWhere).toHaveBeenCalledWith(...expected);
      // Two words now; each escaped once, inside the builder.
      expect(Object.values(expected[1])).toEqual([
        "%100\\%%",
        "%off\\_sale\\\\deal%",
      ]);
    });

    it("skips balance delta rows with zero amount", async () => {
      const tx = makeTransaction({
        id: "tx-1",
        accountId: "acc-1",
        amount: 0,
      });

      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1" }]),
      });
      const exclusionsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([tx]),
      });
      const accountIdsQb = createMockQueryBuilder({
        getRawMany: jest.fn().mockResolvedValue([{ accountId: "acc-1" }]),
      });

      // Balance deltas query returns zero totalAmount
      const balanceQb = createMockQueryBuilder({
        getRawMany: jest
          .fn()
          .mockResolvedValue([{ accountId: "acc-1", totalAmount: "0" }]),
      });

      // A status change first looks for transfer legs among the selection so a
      // counterpart can be voided with it (audit P5-001); none here.
      const transferLegsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([]),
      });

      // ...then the split-parent discovery for the undo snapshot; none here.
      const splitParentsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([]),
      });

      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(exclusionsQb)
        // The status lock set is discovered from the selection first (A26-M09).
        .mockReturnValueOnce(exclusionsQb)
        .mockReturnValueOnce(transferLegsQb)
        .mockReturnValueOnce(splitParentsQb)
        .mockReturnValueOnce(balanceQb)
        .mockReturnValueOnce(accountIdsQb);

      const updateQb = createMockQueryBuilder({
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      });
      mockManagerCreateQueryBuilder.mockReturnValueOnce(updateQb);

      const dto: BulkUpdateDto = {
        mode: "ids",
        transactionIds: ["tx-1"],
        status: TransactionStatus.VOID,
      };

      await service.bulkUpdate(userId, dto);

      // updateBalance should NOT be called when amount is 0
      expect(accountsService.updateBalance).not.toHaveBeenCalled();
    });

    it("excludes ids in filter mode via excludedIds", async () => {
      const tx = makeTransaction({ id: "tx-2" });

      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-2" }]),
      });
      const exclusionsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([tx]),
      });

      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(exclusionsQb);

      const updateQb = createMockQueryBuilder({
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      });
      mockManagerCreateQueryBuilder.mockReturnValueOnce(updateQb);

      const dto: BulkUpdateDto = {
        mode: "filter",
        filters: { payeeIds: ["payee-1"] },
        excludedIds: ["tx-1", "tx-3"],
        description: "test",
      };

      const result = await service.bulkUpdate(userId, dto);

      expect(result.updated).toBe(1);
      expect(resolveQb.andWhere).toHaveBeenCalledWith(
        "transaction.id NOT IN (:...excludedIds)",
        { excludedIds: ["tx-1", "tx-3"] },
      );
    });

    it("does not add NOT IN clause when excludedIds is empty", async () => {
      const tx = makeTransaction({ id: "tx-1" });

      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1" }]),
      });
      const exclusionsQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([tx]),
      });

      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(exclusionsQb);

      const updateQb = createMockQueryBuilder({
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      });
      mockManagerCreateQueryBuilder.mockReturnValueOnce(updateQb);

      const dto: BulkUpdateDto = {
        mode: "filter",
        filters: { payeeIds: ["payee-1"] },
        excludedIds: [],
        description: "test",
      };

      await service.bulkUpdate(userId, dto);

      expect(resolveQb.andWhere).not.toHaveBeenCalledWith(
        "transaction.id NOT IN (:...excludedIds)",
        expect.anything(),
      );
    });

    it("applies amount bounds and split-aware tag filters", async () => {
      const tx = makeTransaction({ id: "tx-1" });

      const innerTagBuilder = {
        where: jest.fn().mockReturnThis(),
        orWhere: jest.fn().mockReturnThis(),
      };
      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([{ id: "tx-1" }]),
        andWhere: jest.fn().mockImplementation(function (arg) {
          if (arg instanceof Brackets) {
            (arg as any).whereFactory(innerTagBuilder);
          }
          return resolveQb;
        }),
      });
      const classifyQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([tx]),
      });

      transactionsRepository.createQueryBuilder
        .mockReturnValueOnce(resolveQb)
        .mockReturnValueOnce(classifyQb);

      const updateQb = createMockQueryBuilder({
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      });
      mockManagerCreateQueryBuilder.mockReturnValueOnce(updateQb);

      // amountFrom 0 on purpose: falsy but defined, so the bound must still
      // apply (the guard is `!== undefined`, not truthiness).
      const dto: BulkUpdateDto = {
        mode: "filter",
        filters: { amountFrom: 0, amountTo: 250.5, tagIds: ["tag-1"] },
        description: "test",
      };

      const result = await service.bulkUpdate(userId, dto);

      expect(result.updated).toBe(1);
      expect(resolveQb.andWhere).toHaveBeenCalledWith(
        "transaction.amount >= :amountFrom",
        { amountFrom: 0 },
      );
      expect(resolveQb.andWhere).toHaveBeenCalledWith(
        "transaction.amount <= :amountTo",
        { amountTo: 250.5 },
      );
      // Split-aware tag match: a tag on the parent or on any split line.
      expect(resolveQb.leftJoin).toHaveBeenCalledWith(
        "transaction.tags",
        "filterTags",
      );
      expect(resolveQb.leftJoin).toHaveBeenCalledWith(
        "transaction.splits",
        "tagSplits",
      );
      expect(resolveQb.leftJoin).toHaveBeenCalledWith(
        "tagSplits.tags",
        "filterSplitTags",
      );
      expect(innerTagBuilder.where).toHaveBeenCalledWith(
        "filterTags.id IN (:...filterTagIds)",
        { filterTagIds: ["tag-1"] },
      );
      expect(innerTagBuilder.orWhere).toHaveBeenCalledWith(
        "filterSplitTags.id IN (:...filterTagIds)",
        { filterTagIds: ["tag-1"] },
      );
    });

    it("applies amount and tag filters through the shared applyFilters in bulkDelete", async () => {
      const resolveQb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue([]),
      });
      transactionsRepository.createQueryBuilder.mockReturnValueOnce(resolveQb);

      const dto: BulkDeleteDto = {
        mode: "filter",
        filters: { amountFrom: 0, amountTo: 100, tagIds: ["tag-1"] },
      };

      const result = await service.bulkDelete(userId, dto);

      expect(result).toEqual({ deleted: 0 });
      expect(resolveQb.andWhere).toHaveBeenCalledWith(
        "transaction.amount >= :amountFrom",
        { amountFrom: 0 },
      );
      expect(resolveQb.andWhere).toHaveBeenCalledWith(
        "transaction.amount <= :amountTo",
        { amountTo: 100 },
      );
      expect(resolveQb.leftJoin).toHaveBeenCalledWith(
        "transaction.tags",
        "filterTags",
      );
      expect(resolveQb.leftJoin).toHaveBeenCalledWith(
        "transaction.splits",
        "tagSplits",
      );
      expect(resolveQb.leftJoin).toHaveBeenCalledWith(
        "tagSplits.tags",
        "filterSplitTags",
      );
    });
  });
});
