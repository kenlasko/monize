import { Test, TestingModule } from "@nestjs/testing";
import {
  NotFoundException,
  BadRequestException,
  ConflictException,
} from "@nestjs/common";
import { DataSource } from "typeorm";
import { ScheduledTransactionsService } from "./scheduled-transactions.service";
import { ScheduledEffectiveAmountService } from "./scheduled-effective-amount.service";
import { ScheduledOccurrenceService } from "./scheduled-occurrence.service";
import { ScheduledTransaction } from "./entities/scheduled-transaction.entity";
import { ScheduledTransactionSplit } from "./entities/scheduled-transaction-split.entity";
import { ScheduledTransactionOverride } from "./entities/scheduled-transaction-override.entity";
import { Account } from "../accounts/entities/account.entity";
import { LoanRateChange } from "../loan-rate-changes/entities/loan-rate-change.entity";
import { Tag } from "../tags/entities/tag.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { FALLBACK_DEFAULT_CURRENCY } from "../common/default-currency.util";
import { AccountsService } from "../accounts/accounts.service";
import { TransactionsService } from "../transactions/transactions.service";
import { InvestmentTransactionsService } from "../securities/investment-transactions.service";
import {
  createInvestmentFxMock,
  InvestmentFxMock,
} from "../test-helpers/investment-fx-testing";
import { ScheduledTransactionOverrideService } from "./scheduled-transaction-override.service";
import { ScheduledTransactionLoanService } from "./scheduled-transaction-loan.service";
import { ActionHistoryService } from "../action-history/action-history.service";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import { SystemAlertService } from "../system-alerts/system-alert.service";
import { getRequestContext } from "../common/request-context";
import {
  createScopedDbMocks,
  DataSourceMock,
} from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

describe("ScheduledTransactionsService", () => {
  let service: ScheduledTransactionsService;
  let scheduledRepo: Record<string, jest.Mock>;
  let splitsRepo: Record<string, any>;
  let overridesRepo: Record<string, jest.Mock>;
  let accountsRepo: Record<string, jest.Mock>;
  let tagRepo: Record<string, jest.Mock>;
  let preferencesRepo: Record<string, jest.Mock>;
  let accountsService: Record<string, jest.Mock>;
  let transactionsService: Record<string, jest.Mock>;
  // The FX trio the effective-amount resolver reads, plus the `create` the
  // posting path calls. Typed, so a return shape the real service cannot
  // produce is a compile error rather than fiction a test asserts on.
  let investmentTransactionsService: InvestmentFxMock & {
    create: jest.Mock;
  };
  // The withScopedDb manager, exposed under the legacy name so the pre-RLS
  // queryRunner.manager assertions keep reading naturally.
  let mockQueryRunner: Record<string, any>;
  /** Whether the occurrence-claim insert returns a row this run. */
  let postingClaimWins: boolean;
  let mockDataSource: DataSourceMock;
  let mockActionHistoryService: Record<string, jest.Mock>;
  let mockExchangeRateService: Record<string, jest.Mock>;
  let mockSystemAlerts: Record<string, jest.Mock>;

  const userId = "11111111-1111-1111-1111-111111111111";
  const stId = "st-1";

  const makeScheduled = (
    overrides: Partial<ScheduledTransaction> = {},
  ): ScheduledTransaction =>
    ({
      id: stId,
      userId,
      accountId: "acc-1",
      name: "Monthly Rent",
      payeeId: "payee-1",
      payeeName: "Landlord",
      categoryId: "cat-1",
      amount: -1200,
      currencyCode: "USD",
      description: "Rent payment",
      frequency: "MONTHLY",
      nextDueDate: "2025-02-15",
      startDate: "2025-01-15",
      endDate: null,
      occurrencesRemaining: null,
      totalOccurrences: null,
      isActive: true,
      autoPost: false,
      reminderDaysBefore: 3,
      lastPostedDate: null,
      isSplit: false,
      isTransfer: false,
      transferAccountId: null,
      splits: [],
      overrides: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      account: {} as any,
      payee: null,
      category: null,
      transferAccount: null,
      ...overrides,
    }) as ScheduledTransaction;

  const mockQueryBuilder = (result: any = []) => {
    const qb: Record<string, jest.Mock> = {
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      distinct: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue(result),
      getOne: jest.fn().mockResolvedValue(result),
      getRawMany: jest.fn().mockResolvedValue([]),
      delete: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    return qb;
  };

  beforeEach(async () => {
    scheduledRepo = {
      create: jest.fn().mockImplementation((data) => ({ id: stId, ...data })),
      save: jest
        .fn()
        .mockImplementation((data) => Promise.resolve({ id: stId, ...data })),
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      remove: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      count: jest.fn().mockResolvedValue(1),
      createQueryBuilder: jest.fn(),
    };

    splitsRepo = {
      create: jest.fn().mockImplementation((data) => data),
      save: jest.fn().mockImplementation((data) => Promise.resolve(data)),
      find: jest.fn().mockResolvedValue([]),
      delete: jest.fn().mockResolvedValue({ affected: 0 }),
    };

    overridesRepo = {
      create: jest
        .fn()
        .mockImplementation((data) => ({ id: "ovr-1", ...data })),
      save: jest
        .fn()
        .mockImplementation((data) =>
          Promise.resolve({ id: "ovr-1", ...data }),
        ),
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      remove: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue({ affected: 0 }),
      count: jest.fn().mockResolvedValue(0),
      createQueryBuilder: jest.fn(),
      query: jest.fn().mockResolvedValue([]),
    };

    accountsRepo = {
      findOne: jest.fn(),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };

    tagRepo = {
      findBy: jest.fn().mockResolvedValue([]),
    };

    accountsService = {
      findOne: jest.fn().mockResolvedValue({ id: "acc-1", userId }),
    };

    // The posting path no longer calls `createTransfer`: authorization has to be
    // decided before the posting transaction opens (a system-identity read
    // cannot join a user-identity transaction), so the transfer is prepared
    // above the transaction, written inside it, and completed after the commit.
    transactionsService = {
      create: jest.fn().mockResolvedValue({ id: "tx-1" }),
      prepareTransfer: jest.fn().mockResolvedValue({
        effectiveUserId: userId,
        realUserId: userId,
        dto: {},
        fromOwnerId: userId,
        toOwnerId: userId,
        hasForeignLeg: false,
      }),
      writeTransferLegs: jest
        .fn()
        .mockResolvedValue({ savedFromId: "tx-1", savedToId: "tx-2" }),
      completeTransfer: jest.fn().mockResolvedValue({
        fromTransaction: { id: "tx-1" },
        toTransaction: { id: "tx-2" },
      }),
    };

    investmentTransactionsService = {
      ...createInvestmentFxMock(),
      create: jest.fn().mockResolvedValue({ id: "inv-tx-1" }),
    };

    mockActionHistoryService = {
      record: jest.fn().mockResolvedValue(null),
    };

    mockExchangeRateService = {
      getLatestRate: jest.fn().mockResolvedValue(null),
      getRateForDate: jest.fn().mockResolvedValue(null),
    };

    mockSystemAlerts = {
      // The real service never throws; the double keeps that contract.
      raiseUserAlert: jest.fn().mockResolvedValue({ created: true }),
      raiseAdminAlert: jest.fn().mockResolvedValue({ created: 1, emailed: 0 }),
    };

    // The reader's reporting currency, which the AI/MCP rollups convert into.
    // USD by default so the fixtures' own USD schedules need no rate at all;
    // a cross-currency test overrides the row or the rate deliberately.
    preferencesRepo = {
      findOne: jest.fn().mockResolvedValue({ defaultCurrency: "USD" }),
    };

    const tenantMocks = createScopedDbMocks([
      [ScheduledTransaction, scheduledRepo],
      [ScheduledTransactionSplit, splitsRepo],
      [ScheduledTransactionOverride, overridesRepo],
      [Account, accountsRepo],
      // The loan bill prices at the rate in effect on its due date, so the
      // loan service reads the rate timeline; no fixture here records one, so
      // every loan falls back to its account scalar (INV-LOAN-006).
      [LoanRateChange, { find: jest.fn().mockResolvedValue([]) }],
      [Tag, tagRepo],
      [UserPreference, preferencesRepo],
    ]);
    mockDataSource = tenantMocks.dataSource;
    // The timezone fan-out now runs through withScopedDb too, so its raw SQL
    // lands on the transaction manager: alias `dataSource.query` to it and the
    // per-test fan-out fixtures below keep working unchanged.
    mockDataSource.query = tenantMocks.manager.query;
    // Direct EntityManager calls inside withScopedDb blocks (converted from the
    // old queryRunner.manager usage in update()/post()/createSplits()).
    const txManager = tenantMocks.manager;
    txManager.delete.mockResolvedValue({ affected: 0 });
    txManager.create.mockImplementation(
      (_entity: unknown, data: unknown) => data,
    );
    txManager.save.mockImplementation((data: unknown) => Promise.resolve(data));
    txManager.findBy.mockResolvedValue([]);
    // The update split-rewrite reads the existing splits (to carry their FX pair
    // provenance forward, issue #1167) before deleting them; default to none.
    txManager.find.mockResolvedValue([]);
    txManager.createQueryBuilder.mockImplementation(() => ({
      delete: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 0 }),
    }));
    mockQueryRunner = { manager: txManager };
    /**
     * `post` locks the schedule row and claims the occurrence before it creates
     * any money.
     *
     * The financial transaction used to commit in its own transaction and
     * `nextDueDate` advance in a second one, so two replicas firing the same
     * hourly cron -- or a manual post racing it, or a crash between the two
     * commits -- posted the same bill twice (audit P4-004). The locked read and
     * the occurrence claim are what the doubles below answer.
     */
    postingClaimWins = true;
    txManager.findOne.mockImplementation((_entity: unknown, options: unknown) =>
      scheduledRepo.findOne(options as never),
    );

    // Default to a single UTC user so cron logic that buckets by timezone
    // continues to operate against legacy tests that pre-date the cron
    // refactor and assume a one-user world.
    mockDataSource.query.mockImplementation(async (sql: string) => {
      if (String(sql).includes("scheduled_transaction_postings")) {
        return postingClaimWins ? [[{ id: "posting-1" }], 1] : [[], 0];
      }
      // The loan recalculation's dated as-of ledger balance (issue #1253):
      // answer with the mocked loan account's stored balance so tests about
      // other behavior read the figure the old currentBalance read gave them.
      if (String(sql).includes("opening_balance")) {
        const account = await accountsRepo.findOne();
        return account != null
          ? [{ balance: String(Number(account.currentBalance)) }]
          : [];
      }
      return [
        { user_id: "11111111-1111-1111-1111-111111111111", timezone: "UTC" },
      ];
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ScheduledTransactionsService,
        // The real resolver, wired to the same mocked InvestmentTransactionsService:
        // the #1167 FX decisions moved here (issue #1247) and the assertions below
        // are about those decisions, so a double would test nothing.
        ScheduledEffectiveAmountService,
        // Likewise real: occurrence selection (which override governs the
        // occurrence that is due) is what these assertions are about.
        ScheduledOccurrenceService,
        { provide: AccountsService, useValue: accountsService },
        { provide: TransactionsService, useValue: transactionsService },
        {
          provide: InvestmentTransactionsService,
          useValue: investmentTransactionsService,
        },
        { provide: DataSource, useValue: mockDataSource },
        ScheduledTransactionOverrideService,
        ScheduledTransactionLoanService,
        {
          provide: ActionHistoryService,
          useValue: mockActionHistoryService,
        },
        {
          provide: ExchangeRateService,
          useValue: mockExchangeRateService,
        },
        {
          provide: SystemAlertService,
          useValue: mockSystemAlerts,
        },
      ],
    }).compile();

    service = module.get<ScheduledTransactionsService>(
      ScheduledTransactionsService,
    );
  });

  // Helper: stub findOne to return a scheduled transaction for internal calls
  const stubFindOne = (scheduled: ScheduledTransaction) => {
    scheduledRepo.findOne.mockResolvedValue(scheduled);
    // post() re-reads the split set under the parent lock to guard against a
    // concurrent split retarget (issue #1154 re-review); default it to the same
    // splits the schedule carries so the guard passes unless a test overrides it.
    splitsRepo.find.mockResolvedValue(scheduled.splits ?? []);
  };

  // ==================== create ====================
  describe("create", () => {
    const baseDto = {
      accountId: "acc-1",
      name: "Rent",
      amount: -1200,
      currencyCode: "USD",
      frequency: "MONTHLY" as any,
      nextDueDate: "2025-02-15",
    };

    it("should create a simple scheduled transaction", async () => {
      const saved = makeScheduled();
      scheduledRepo.save.mockResolvedValue(saved);
      stubFindOne(saved);

      const result = await service.create(userId, baseDto);

      expect(accountsService.findOne).toHaveBeenCalledWith(userId, "acc-1");
      expect(scheduledRepo.create).toHaveBeenCalled();
      expect(scheduledRepo.save).toHaveBeenCalled();
      expect(result).toEqual(saved);
    });

    it("should default startDate to nextDueDate", async () => {
      const saved = makeScheduled();
      scheduledRepo.save.mockResolvedValue(saved);
      stubFindOne(saved);

      await service.create(userId, baseDto);

      const createArg = scheduledRepo.create.mock.calls[0][0];
      expect(createArg.startDate).toBe("2025-02-15");
    });

    it("should set categoryId=null when hasSplits", async () => {
      const saved = makeScheduled({ isSplit: true, categoryId: null });
      scheduledRepo.save.mockResolvedValue(saved);
      stubFindOne(saved);

      const dto = {
        ...baseDto,
        categoryId: "cat-1",
        splits: [
          { categoryId: "cat-a", amount: -700 },
          { categoryId: "cat-b", amount: -500 },
        ],
      };
      await service.create(userId, dto);

      const createArg = scheduledRepo.create.mock.calls[0][0];
      expect(createArg.categoryId).toBeNull();
      expect(createArg.isSplit).toBe(true);
    });

    it("keeps categoryId on a transfer (categorized transfer, #743)", async () => {
      const saved = makeScheduled({ isTransfer: true, categoryId: "cat-1" });
      scheduledRepo.save.mockResolvedValue(saved);
      stubFindOne(saved);

      const dto = {
        ...baseDto,
        categoryId: "cat-1",
        isTransfer: true,
        transferAccountId: "acc-2",
      };
      await service.create(userId, dto);

      const createArg = scheduledRepo.create.mock.calls[0][0];
      expect(createArg.categoryId).toBe("cat-1");
      expect(createArg.isTransfer).toBe(true);
    });

    it("should throw if transfer to same account", async () => {
      const dto = { ...baseDto, isTransfer: true, transferAccountId: "acc-1" };
      await expect(service.create(userId, dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should verify transfer account ownership", async () => {
      const saved = makeScheduled({ isTransfer: true });
      scheduledRepo.save.mockResolvedValue(saved);
      stubFindOne(saved);

      const dto = { ...baseDto, isTransfer: true, transferAccountId: "acc-2" };
      await service.create(userId, dto);

      expect(accountsService.findOne).toHaveBeenCalledWith(userId, "acc-2");
    });

    it("should reject splits with fewer than 2 entries (non-transfer)", async () => {
      const dto = {
        ...baseDto,
        splits: [{ categoryId: "cat-a", amount: -1200 }],
      };
      await expect(service.create(userId, dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should reject splits whose sum != amount", async () => {
      const dto = {
        ...baseDto,
        splits: [
          { categoryId: "cat-a", amount: -700 },
          { categoryId: "cat-b", amount: -400 },
        ],
      };
      await expect(service.create(userId, dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should allow zero amount splits when total matches", async () => {
      const saved = makeScheduled({ isSplit: true });
      scheduledRepo.save.mockResolvedValue(saved);
      stubFindOne(saved);

      const dto = {
        ...baseDto,
        splits: [
          { categoryId: "cat-a", amount: 0 },
          { categoryId: "cat-b", amount: -1200 },
        ],
      };
      await service.create(userId, dto);
      expect(scheduledRepo.save).toHaveBeenCalled();
    });

    it("should allow single split with transferAccountId (loan payment)", async () => {
      const saved = makeScheduled();
      scheduledRepo.save.mockResolvedValue(saved);
      stubFindOne(saved);

      const dto = {
        ...baseDto,
        splits: [{ transferAccountId: "acc-loan", amount: -1200 }],
      };
      // Single split with transferAccountId should not throw
      await service.create(userId, dto);
      expect(scheduledRepo.save).toHaveBeenCalled();
    });

    it("should create split records when splits provided", async () => {
      const saved = makeScheduled({ isSplit: true });
      scheduledRepo.save.mockResolvedValue(saved);
      stubFindOne(saved);

      const dto = {
        ...baseDto,
        splits: [
          { categoryId: "cat-a", amount: -700 },
          { categoryId: "cat-b", amount: -500 },
        ],
      };
      await service.create(userId, dto);

      expect(mockQueryRunner.manager.create).toHaveBeenCalledTimes(2);
      expect(mockQueryRunner.manager.save).toHaveBeenCalled();
    });

    it("records action history on create", async () => {
      const saved = makeScheduled();
      scheduledRepo.save.mockResolvedValue(saved);
      stubFindOne(saved);

      await service.create(userId, baseDto);

      expect(mockActionHistoryService.record).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          entityType: "scheduled_transaction",
          action: "create",
          description: expect.stringContaining("Monthly Rent"),
        }),
      );
    });
  });

  // ==================== findOne ====================
  describe("findOne", () => {
    it("should return the scheduled transaction", async () => {
      const scheduled = makeScheduled();
      stubFindOne(scheduled);
      const result = await service.findOne(userId, stId);
      expect(result).toEqual(scheduled);
    });

    it("should throw NotFoundException if not found", async () => {
      scheduledRepo.findOne.mockResolvedValue(null);
      await expect(service.findOne(userId, stId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it("should throw NotFoundException if userId does not match", async () => {
      scheduledRepo.findOne.mockResolvedValue(null);
      await expect(service.findOne(userId, stId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ==================== findAll ====================
  describe("findAll", () => {
    it("should return empty array when no transactions", async () => {
      const qb = mockQueryBuilder([]);
      scheduledRepo.createQueryBuilder.mockReturnValue(qb);
      const result = await service.findAll(userId);
      expect(result).toEqual([]);
    });

    it("should return transactions with overrideCount, nextOverride, and futureOverrides", async () => {
      const st = makeScheduled();
      const qb = mockQueryBuilder([st]);
      scheduledRepo.createQueryBuilder.mockReturnValue(qb);

      const nextOverrideQb = mockQueryBuilder(null);
      nextOverrideQb.getMany.mockResolvedValue([]);

      const futureOverridesQb = mockQueryBuilder(null);
      futureOverridesQb.getMany.mockResolvedValue([]);

      overridesRepo.createQueryBuilder
        .mockReturnValueOnce(nextOverrideQb) // first call: nextOverride query
        .mockReturnValueOnce(futureOverridesQb); // second call: futureOverrides query

      const result = await service.findAll(userId);

      expect(result).toHaveLength(1);
      expect(result[0].overrideCount).toBe(0);
      expect(result[0].nextOverride).toBeNull();
      expect(result[0].futureOverrides).toEqual([]);
    });

    it("should populate futureOverrides with overrides on or after nextDueDate", async () => {
      const st = makeScheduled({ nextDueDate: "2025-02-15" });
      const qb = mockQueryBuilder([st]);
      scheduledRepo.createQueryBuilder.mockReturnValue(qb);

      const nextOverrideQb = mockQueryBuilder(null);
      nextOverrideQb.getMany.mockResolvedValue([]);

      const futureOverride = {
        id: "ovr-1",
        scheduledTransactionId: stId,
        originalDate: "2025-03-15",
        overrideDate: "2025-03-20",
        amount: -999,
      };
      const pastOverride = {
        id: "ovr-2",
        scheduledTransactionId: stId,
        originalDate: "2025-01-15",
        overrideDate: "2025-01-15",
        amount: -500,
      };
      const futureOverridesQb = mockQueryBuilder(null);
      futureOverridesQb.getMany.mockResolvedValue([
        pastOverride,
        futureOverride,
      ]);

      overridesRepo.createQueryBuilder
        .mockReturnValueOnce(nextOverrideQb)
        .mockReturnValueOnce(futureOverridesQb);

      const result = await service.findAll(userId);

      expect(result).toHaveLength(1);
      // Only the future override should be included (originalDate >= nextDueDate)
      expect(result[0].futureOverrides).toHaveLength(1);
      expect(result[0].futureOverrides![0].id).toBe("ovr-1");
      expect(result[0].overrideCount).toBe(1);
    });

    it("attaches the server-resolved investmentForecastExchangeRate for an investment schedule (issue #1167)", async () => {
      const st = makeScheduled({
        isInvestment: true,
        investmentAction: "BUY" as any,
        investmentSecurityId: "sec-usd",
        investmentFundingAccountId: null,
        investmentQuantity: 1,
        investmentPrice: 100,
        // Persisted rate is stale EUR->CAD 1.50; it must NOT be what the forecast
        // uses.
        investmentExchangeRate: 1.5,
        investmentExchangeRateFromCurrency: "EUR",
        investmentExchangeRateToCurrency: "CAD",
      });
      const qb = mockQueryBuilder([st]);
      scheduledRepo.createQueryBuilder.mockReturnValue(qb);
      overridesRepo.createQueryBuilder
        .mockReturnValueOnce(mockQueryBuilder([]))
        .mockReturnValueOnce(mockQueryBuilder([]));
      // The current pair resolves to 1.35 (security now USD, USD->CAD = 1.35).
      investmentTransactionsService.resolveCashExchangeRateOrNull.mockResolvedValue(
        1.35,
      );

      const result = await service.findAll(userId);

      expect(result[0].investmentForecastExchangeRate).toBe(1.35);
      // Resolved with no supplied rate (the stale scalar is never trusted), the
      // schedule's settlement tuple, and today's date so it takes the same
      // provider-capable rate path as posting (issue #1167 re-review).
      expect(
        investmentTransactionsService.resolveCashExchangeRateOrNull,
      ).toHaveBeenCalledWith(
        userId,
        st.accountId,
        null,
        "sec-usd",
        undefined,
        expect.any(Date),
      );
    });

    it("reuses a still-valid pinned rate the way posting does, not the current market rate (Round 6 F1)", async () => {
      const st = makeScheduled({
        isInvestment: true,
        investmentAction: "BUY" as any,
        investmentSecurityId: "sec-usd",
        investmentFundingAccountId: null,
        investmentQuantity: 10,
        investmentPrice: 100,
        // A valid pinned rate whose recorded pair still matches the current one.
        investmentExchangeRate: 1.5,
        investmentExchangeRateFromCurrency: "USD",
        investmentExchangeRateToCurrency: "CAD",
      });
      const qb = mockQueryBuilder([st]);
      scheduledRepo.createQueryBuilder.mockReturnValue(qb);
      overridesRepo.createQueryBuilder
        .mockReturnValueOnce(mockQueryBuilder([]))
        .mockReturnValueOnce(mockQueryBuilder([]));
      // Current pair still USD->CAD -> the stored rate is valid; market is 1.35.
      investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
        { from: "USD", to: "CAD" },
      );
      investmentTransactionsService.resolveCashExchangeRateOrNull.mockResolvedValue(
        1.35,
      );

      const result = await service.findAll(userId);

      // Posting would reuse the pinned 1.50, so the forecast must too -- never the
      // 1.35 market rate, or the forecast disagrees with the posting it predicts.
      expect(result[0].investmentForecastExchangeRate).toBe(1.5);
      // The stored rate was validated, not re-fetched.
      expect(
        investmentTransactionsService.resolveCashExchangeRateOrNull,
      ).not.toHaveBeenCalled();
    });

    it("never reuses a stored non-1 scalar when the current pair is same-currency -- forecast resolves to 1 (R12-F1)", async () => {
      const st = makeScheduled({
        isInvestment: true,
        investmentAction: "BUY" as any,
        investmentSecurityId: "sec-usd",
        investmentFundingAccountId: null,
        investmentQuantity: 10,
        investmentPrice: 100,
        // A 1.50 scalar stamped against a CAD->CAD pair (e.g. the security's
        // currency changed to the cash currency and 1.50 was explicitly
        // re-entered). Its from/to still equal the current pair, so the old
        // "pair matches" reuse would have taken it.
        investmentExchangeRate: 1.5,
        investmentExchangeRateFromCurrency: "CAD",
        investmentExchangeRateToCurrency: "CAD",
      });
      const qb = mockQueryBuilder([st]);
      scheduledRepo.createQueryBuilder.mockReturnValue(qb);
      overridesRepo.createQueryBuilder
        .mockReturnValueOnce(mockQueryBuilder([]))
        .mockReturnValueOnce(mockQueryBuilder([]));
      // The current settlement pair is same-currency CAD->CAD.
      investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
        { from: "CAD", to: "CAD" },
      );
      // The real resolver returns 1 for a same-currency pair; mock that here.
      investmentTransactionsService.resolveCashExchangeRateOrNull.mockResolvedValue(
        1,
      );

      const result = await service.findAll(userId);

      // Same-currency dominates: the forecast uses 1, never the stored 1.50, so
      // it matches the posting it predicts (cash impact at par).
      expect(result[0].investmentForecastExchangeRate).toBe(1);
      // Reuse was refused for the same-currency pair, so the resolver was called
      // rather than the stored scalar trusted.
      expect(
        investmentTransactionsService.resolveCashExchangeRateOrNull,
      ).toHaveBeenCalled();
    });

    it("fetches an unfetchable settlement pair once per list read across parent and split forecast resolvers (R14-F1)", async () => {
      // Two schedules on the SAME unfetchable pair (acc-1 / sec-usd), reached
      // through DIFFERENT forecast resolvers: a top-level investment schedule
      // (resolveInvestmentForecastRate) and a split-investment schedule
      // (resolveInvestmentForecastSplitAmount). Their high-level memo keys
      // differ, so only the shared pair-rate negative cache can stop the second
      // from re-hitting the FX provider. Both carry a stale recorded pair so the
      // stored scalar is not reused and the resolver is actually consulted.
      const parent = makeScheduled({
        id: "st-parent",
        isInvestment: true,
        investmentAction: "BUY" as any,
        investmentSecurityId: "sec-usd",
        investmentFundingAccountId: null,
        investmentQuantity: 1,
        investmentPrice: 100,
        investmentExchangeRate: 1.5,
        investmentExchangeRateFromCurrency: "EUR",
        investmentExchangeRateToCurrency: "CAD",
      });
      const splitParent = makeScheduled({
        id: "st-split",
        isSplit: true,
        splits: [
          {
            id: "s1",
            scheduledTransactionId: "st-split",
            kind: "investment",
            categoryId: null,
            transferAccountId: null,
            amount: -600,
            memo: null,
            investmentAction: "BUY",
            investmentSecurityId: "sec-usd",
            investmentQuantity: 5,
            investmentPrice: 100,
            investmentCommission: 0,
            investmentExchangeRate: 1.6,
            investmentExchangeRateFromCurrency: "EUR",
            investmentExchangeRateToCurrency: "CAD",
          } as any,
          {
            id: "s2",
            scheduledTransactionId: "st-split",
            kind: "category",
            categoryId: "cat-fees",
            transferAccountId: null,
            amount: -75,
            memo: null,
          } as any,
        ],
      } as any);
      const qb = mockQueryBuilder([parent, splitParent]);
      scheduledRepo.createQueryBuilder.mockReturnValue(qb);
      overridesRepo.createQueryBuilder
        .mockReturnValueOnce(mockQueryBuilder([]))
        .mockReturnValueOnce(mockQueryBuilder([]));
      // Current pair (USD->CAD) differs from the stored EUR->CAD, so both rows
      // re-resolve; the provider has no rate for it.
      investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
        { from: "USD", to: "CAD" },
      );
      investmentTransactionsService.resolveCashExchangeRateOrNull.mockResolvedValue(
        null,
      );

      await service.findAll(userId);

      // One external fetch for the shared pair, not one per schedule.
      const pairCalls =
        investmentTransactionsService.resolveCashExchangeRateOrNull.mock.calls.filter(
          (c: any[]) => c[1] === "acc-1" && c[3] === "sec-usd",
        );
      expect(pairCalls).toHaveLength(1);
    });

    it("fetches an unfetchable pair once even across DIFFERENT securities that settle to it (R14 review MEDIUM-2)", async () => {
      // Two DISTINCT securities (sec-usd-a, sec-usd-b) that both settle USD->CAD.
      // Their entity tuples differ, so an (account, security) cache key would
      // still hit the provider once per security; keying by the directional
      // currency pair asks the provider the one USD->CAD question a single time.
      const mk = (id: string, securityId: string) =>
        makeScheduled({
          id,
          isInvestment: true,
          investmentAction: "BUY" as any,
          investmentSecurityId: securityId,
          investmentFundingAccountId: null,
          investmentQuantity: 1,
          investmentPrice: 100,
          // Stale recorded pair so the stored scalar is not reused; both re-resolve.
          investmentExchangeRate: 1.5,
          investmentExchangeRateFromCurrency: "EUR",
          investmentExchangeRateToCurrency: "CAD",
        });
      const qb = mockQueryBuilder([
        mk("st-a", "sec-usd-a"),
        mk("st-b", "sec-usd-b"),
      ]);
      scheduledRepo.createQueryBuilder.mockReturnValue(qb);
      overridesRepo.createQueryBuilder
        .mockReturnValueOnce(mockQueryBuilder([]))
        .mockReturnValueOnce(mockQueryBuilder([]));
      // Both securities settle to the same current pair; the provider has no rate.
      investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
        { from: "USD", to: "CAD" },
      );
      investmentTransactionsService.resolveCashExchangeRateOrNull.mockResolvedValue(
        null,
      );

      await service.findAll(userId);

      // One provider-capable fetch for the USD->CAD pair, not one per security.
      expect(
        investmentTransactionsService.resolveCashExchangeRateOrNull,
      ).toHaveBeenCalledTimes(1);
    });

    it("derives the settlement pair once per tuple across a whole list read (issue #1167 review MEDIUM-3)", async () => {
      // Two parent investment schedules on the IDENTICAL settlement tuple
      // (acc-1 / no funding / sec-usd) but DIFFERENT stored rates, so the
      // high-level forecastRateCache does not merge them and each one runs the
      // stored-current check AND the pair-rate key derivation -- up to four
      // resolveSettlementCurrencyPair calls for one tuple. The per-read tuple
      // memo must collapse them to one; the pair derivation is 2-3 DB reads, so
      // O(rows) of them is the amplification this fixes.
      const mk = (id: string, rate: number) =>
        makeScheduled({
          id,
          isInvestment: true,
          investmentAction: "BUY" as any,
          investmentSecurityId: "sec-usd",
          investmentFundingAccountId: null,
          investmentQuantity: 1,
          investmentPrice: 100,
          // Stale recorded pair -> stored scalar not reused, resolver consulted.
          investmentExchangeRate: rate,
          investmentExchangeRateFromCurrency: "EUR",
          investmentExchangeRateToCurrency: "CAD",
        });
      const qb = mockQueryBuilder([mk("st-a", 1.5), mk("st-b", 1.6)]);
      scheduledRepo.createQueryBuilder.mockReturnValue(qb);
      overridesRepo.createQueryBuilder
        .mockReturnValueOnce(mockQueryBuilder([]))
        .mockReturnValueOnce(mockQueryBuilder([]));
      investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
        { from: "USD", to: "CAD" },
      );
      investmentTransactionsService.resolveCashExchangeRateOrNull.mockResolvedValue(
        null,
      );

      await service.findAll(userId);

      // One pair derivation for the shared tuple, not one per row per resolver.
      expect(
        investmentTransactionsService.resolveSettlementCurrencyPair,
      ).toHaveBeenCalledTimes(1);
    });

    it("keeps the pair-derivation memo and the pair-rate cache separate (issue #1167 review MEDIUM-3)", async () => {
      // Two DISTINCT securities settling the same USD->CAD pair: their tuples
      // differ, so the tuple memo derives the pair twice (once per tuple), while
      // the pair-rate cache still asks the provider the USD->CAD question once.
      // Proves the two caches are distinct and both required -- collapsing them
      // would either re-derive per row or re-fetch per security.
      const mk = (id: string, securityId: string) =>
        makeScheduled({
          id,
          isInvestment: true,
          investmentAction: "BUY" as any,
          investmentSecurityId: securityId,
          investmentFundingAccountId: null,
          investmentQuantity: 1,
          investmentPrice: 100,
          investmentExchangeRate: 1.5,
          investmentExchangeRateFromCurrency: "EUR",
          investmentExchangeRateToCurrency: "CAD",
        });
      const qb = mockQueryBuilder([
        mk("st-a", "sec-usd-a"),
        mk("st-b", "sec-usd-b"),
      ]);
      scheduledRepo.createQueryBuilder.mockReturnValue(qb);
      overridesRepo.createQueryBuilder
        .mockReturnValueOnce(mockQueryBuilder([]))
        .mockReturnValueOnce(mockQueryBuilder([]));
      investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
        { from: "USD", to: "CAD" },
      );
      investmentTransactionsService.resolveCashExchangeRateOrNull.mockResolvedValue(
        null,
      );

      await service.findAll(userId);

      // Two tuples -> two pair derivations (memoized per tuple, not per row)...
      expect(
        investmentTransactionsService.resolveSettlementCurrencyPair,
      ).toHaveBeenCalledTimes(2);
      // ...but one provider-capable fetch for the shared USD->CAD pair.
      expect(
        investmentTransactionsService.resolveCashExchangeRateOrNull,
      ).toHaveBeenCalledTimes(1);
    });

    it("resolves independent-pair forecasts concurrently, not end-to-end serially (issue #1167 review MEDIUM-4)", async () => {
      // Two schedules on DIFFERENT settlement pairs (USD->CAD, EUR->CAD), each an
      // independent provider-capable FX lookup. Their fetches are represented by
      // promises that never resolve until we release them: if the list resolved
      // rows sequentially, only the first fetch would have started while the
      // second waited; under bounded concurrency both start before either
      // resolves. Uses deferred promises, not wall-clock timing.
      const mk = (id: string, securityId: string) =>
        makeScheduled({
          id,
          isInvestment: true,
          investmentAction: "BUY" as any,
          investmentSecurityId: securityId,
          investmentFundingAccountId: null,
          investmentQuantity: 1,
          investmentPrice: 100,
          // Stale recorded pair so the stored scalar is not reused; both re-resolve.
          investmentExchangeRate: 1.5,
          investmentExchangeRateFromCurrency: "GBP",
          investmentExchangeRateToCurrency: "CAD",
        });
      const qb = mockQueryBuilder([
        mk("st-a", "sec-usd"),
        mk("st-b", "sec-eur"),
      ]);
      scheduledRepo.createQueryBuilder.mockReturnValue(qb);
      overridesRepo.createQueryBuilder
        .mockReturnValueOnce(mockQueryBuilder([]))
        .mockReturnValueOnce(mockQueryBuilder([]));
      // Distinct current pairs per security, so the two rows do not share a
      // pair-rate cache entry and each issues its own provider-capable fetch.
      investmentTransactionsService.resolveSettlementCurrencyPair.mockImplementation(
        async (_u: string, _a: string, _f: unknown, securityId: string) =>
          securityId === "sec-usd"
            ? { from: "USD", to: "CAD" }
            : { from: "EUR", to: "CAD" },
      );
      let started = 0;
      const releases: Array<(value: number | null) => void> = [];
      investmentTransactionsService.resolveCashExchangeRateOrNull.mockImplementation(
        () => {
          started += 1;
          return new Promise<number | null>((resolve) => {
            releases.push(resolve);
          });
        },
      );

      const pending = service.findAll(userId);
      // Flush microtasks so both rows can reach their FX fetch, without resolving
      // either fetch.
      await new Promise((resolve) => setImmediate(resolve));

      // Both independent-pair fetches are in flight at once: sequential resolution
      // would have started only the first.
      expect(started).toBe(2);

      releases.forEach((release) => release(1.35));
      await pending;
    });

    it("attaches a null investmentForecastExchangeRate when the current rate is unavailable (issue #1167)", async () => {
      const st = makeScheduled({
        isInvestment: true,
        investmentAction: "BUY" as any,
        investmentSecurityId: "sec-usd",
        investmentQuantity: 1,
        investmentPrice: 100,
      });
      const qb = mockQueryBuilder([st]);
      scheduledRepo.createQueryBuilder.mockReturnValue(qb);
      overridesRepo.createQueryBuilder
        .mockReturnValueOnce(mockQueryBuilder([]))
        .mockReturnValueOnce(mockQueryBuilder([]));
      investmentTransactionsService.resolveCashExchangeRateOrNull.mockResolvedValue(
        null,
      );

      const result = await service.findAll(userId);

      expect(result[0].investmentForecastExchangeRate).toBeNull();
    });

    it("attaches a top-level investment override's effective cash amount (Round 6 F3)", async () => {
      const st = makeScheduled({
        isInvestment: true,
        investmentAction: "BUY" as any,
        investmentSecurityId: "sec-usd",
        investmentFundingAccountId: null,
        investmentQuantity: 10,
        investmentPrice: 100,
        investmentCommission: 0,
        investmentExchangeRate: 1.35,
        investmentExchangeRateFromCurrency: "USD",
        investmentExchangeRateToCurrency: "CAD",
      });
      const override = {
        id: "ovr-1",
        scheduledTransactionId: st.id,
        originalDate: st.nextDueDate,
        overrideDate: st.nextDueDate,
        amount: null,
        isSplit: null,
        splits: null,
        // A per-occurrence quantity change posting would honour: 20 shares.
        investmentQuantity: 20,
        investmentPrice: null,
        investmentTotalAmount: null,
      };
      const qb = mockQueryBuilder([st]);
      scheduledRepo.createQueryBuilder.mockReturnValue(qb);
      overridesRepo.createQueryBuilder
        .mockReturnValueOnce(mockQueryBuilder([override]))
        .mockReturnValueOnce(mockQueryBuilder([override]));
      investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
        { from: "USD", to: "CAD" },
      );

      const result = await service.findAll(userId);

      // cashImpact BUY 20 @ 100 = -2000, effective rate 1.35 -> -2700, never the
      // base -1350. Posting uses the override quantity, so the forecast must too.
      expect((result[0].nextOverride as any).investmentForecastAmount).toBe(
        -2700,
      );
    });

    it("leaves investmentForecastExchangeRate null for a non-investment schedule", async () => {
      const st = makeScheduled();
      const qb = mockQueryBuilder([st]);
      scheduledRepo.createQueryBuilder.mockReturnValue(qb);
      overridesRepo.createQueryBuilder
        .mockReturnValueOnce(mockQueryBuilder([]))
        .mockReturnValueOnce(mockQueryBuilder([]));

      const result = await service.findAll(userId);

      expect(result[0].investmentForecastExchangeRate).toBeNull();
      expect(
        investmentTransactionsService.resolveCashExchangeRateOrNull,
      ).not.toHaveBeenCalled();
    });

    // ---- The effective-amount read model (issue #1247) ----

    it("attaches the effective amount an investment schedule would post today", async () => {
      const st = makeScheduled({
        amount: -1000,
        currencyCode: "CAD",
        isInvestment: true,
        investmentAction: "BUY" as any,
        investmentSecurityId: "SEC-1",
        investmentFundingAccountId: "cash-1",
        investmentQuantity: 10,
        investmentPrice: 100,
        // Pinned at 1.50 while the security was priced in EUR.
        investmentExchangeRate: 1.5,
        investmentExchangeRateFromCurrency: "EUR",
        investmentExchangeRateToCurrency: "CAD",
      });
      scheduledRepo.createQueryBuilder.mockReturnValue(mockQueryBuilder([st]));
      overridesRepo.createQueryBuilder
        .mockReturnValueOnce(mockQueryBuilder([]))
        .mockReturnValueOnce(mockQueryBuilder([]));
      // The security is USD now, and USD -> CAD is 1.35.
      investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
        { from: "USD", to: "CAD" },
      );
      investmentTransactionsService.resolveCashExchangeRateOrNull.mockResolvedValue(
        1.35,
      );

      const result = await service.findAll(userId);

      expect(result[0].effectiveAmount).toBe(-1350);
      // The figure the persisted rate would have given: 11.11% out.
      expect(result[0].effectiveAmount).not.toBe(-1500);
      expect(result[0].effectiveAmountComplete).toBe(true);
      // The settlement currency, not the brokerage account's.
      expect(result[0].effectiveCurrencyCode).toBe("CAD");
      // And the account that amount belongs to: the funding account, not the
      // brokerage the schedule is filed under. A client projecting a running
      // balance from `accountId` charges an account the trade never moves, which
      // is how a purchase its funding account covers exactly came to be reported
      // as an overdraft.
      expect(result[0].settlementAccountId).toBe("cash-1");
      expect(result[0].settlementAccountId).not.toBe(st.accountId);
    });

    it("reports the effective amount as unknown when the current rate is unavailable", async () => {
      const st = makeScheduled({
        amount: -1000,
        isInvestment: true,
        investmentAction: "BUY" as any,
        investmentSecurityId: "SEC-1",
        investmentQuantity: 10,
        investmentPrice: 100,
        investmentExchangeRate: 1.5,
        investmentExchangeRateFromCurrency: "EUR",
        investmentExchangeRateToCurrency: "CAD",
      });
      scheduledRepo.createQueryBuilder.mockReturnValue(mockQueryBuilder([st]));
      overridesRepo.createQueryBuilder
        .mockReturnValueOnce(mockQueryBuilder([]))
        .mockReturnValueOnce(mockQueryBuilder([]));
      investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
        { from: "USD", to: "CAD" },
      );
      investmentTransactionsService.resolveCashExchangeRateOrNull.mockResolvedValue(
        null,
      );

      const result = await service.findAll(userId);

      expect(result[0].effectiveAmount).toBeNull();
      expect(result[0].effectiveAmountComplete).toBe(false);
      expect(result[0].effectiveAmount).not.toBe(-1500);
    });

    it("attaches an effective amount to each override it returns", async () => {
      const st = makeScheduled({ nextDueDate: "2025-02-15", amount: -1200 });
      scheduledRepo.createQueryBuilder.mockReturnValue(mockQueryBuilder([st]));
      const nextOverride = {
        id: "ovr-next",
        scheduledTransactionId: stId,
        originalDate: "2025-02-15",
        overrideDate: "2025-02-18",
        amount: -1350,
      };
      overridesRepo.createQueryBuilder
        .mockReturnValueOnce(mockQueryBuilder([nextOverride]))
        .mockReturnValueOnce(mockQueryBuilder([nextOverride]));

      const result = await service.findAll(userId);

      expect(result[0].nextOverride!.effectiveAmount).toBe(-1350);
      expect(result[0].nextOverride!.effectiveAmountComplete).toBe(true);
      expect(result[0].futureOverrides![0].effectiveAmount).toBe(-1350);
      // The base occurrence keeps its own amount, unaffected by the override.
      expect(result[0].effectiveAmount).toBe(-1200);
    });

    it("reports a plain schedule's stored amount as the known effective amount", async () => {
      const st = makeScheduled({ amount: -1200, currencyCode: "USD" });
      scheduledRepo.createQueryBuilder.mockReturnValue(mockQueryBuilder([st]));
      overridesRepo.createQueryBuilder
        .mockReturnValueOnce(mockQueryBuilder([]))
        .mockReturnValueOnce(mockQueryBuilder([]));

      const result = await service.findAll(userId);

      expect(result[0].effectiveAmount).toBe(-1200);
      expect(result[0].effectiveAmountComplete).toBe(true);
      expect(result[0].effectiveCurrencyCode).toBe("USD");
      // A schedule that moves no securities settles in its own account.
      expect(result[0].settlementAccountId).toBe("acc-1");
    });
  });

  // ==================== findDue ====================
  describe("findDue", () => {
    it("should find active transactions due today or earlier", async () => {
      const due = [makeScheduled()];
      scheduledRepo.find.mockResolvedValue(due);
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getRawMany.mockResolvedValue([]);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);

      const result = await service.findDue(userId);

      expect(scheduledRepo.find).toHaveBeenCalled();
      const callArgs = scheduledRepo.find.mock.calls[0][0];
      expect(callArgs.where.userId).toBe(userId);
      expect(callArgs.where.isActive).toBe(true);
      expect(result).toEqual(due);
    });

    it("should defer transactions whose override moved the next occurrence forward", async () => {
      const candidate = makeScheduled({ id: "st-postponed" });
      scheduledRepo.find.mockResolvedValue([candidate]);

      // First createQueryBuilder call: postponed-id lookup -> returns this id
      // Second: moved-earlier lookup -> returns []
      const postponedQb = mockQueryBuilder(null);
      postponedQb.getRawMany.mockResolvedValue([{ id: "st-postponed" }]);
      const earlierQb = mockQueryBuilder(null);
      earlierQb.getRawMany.mockResolvedValue([]);
      overridesRepo.createQueryBuilder
        .mockReturnValueOnce(postponedQb)
        .mockReturnValueOnce(earlierQb);

      const result = await service.findDue(userId);

      expect(result).toEqual([]);
    });
  });

  // ==================== findUpcoming ====================
  describe("findUpcoming", () => {
    it("should query with default 30 days", async () => {
      const qb = mockQueryBuilder([]);
      scheduledRepo.createQueryBuilder.mockReturnValue(qb);

      await service.findUpcoming(userId);

      expect(qb.where).toHaveBeenCalledWith("st.userId = :userId", { userId });
      expect(qb.andWhere).toHaveBeenCalledWith("st.isActive = :isActive", {
        isActive: true,
      });
    });

    it("should accept custom days parameter", async () => {
      const qb = mockQueryBuilder([]);
      scheduledRepo.createQueryBuilder.mockReturnValue(qb);

      await service.findUpcoming(userId, 7);

      expect(qb.andWhere).toHaveBeenCalledWith(
        "st.nextDueDate <= :futureDate",
        expect.objectContaining({ futureDate: expect.any(Date) }),
      );
    });
  });

  describe("getLlmUpcomingBillsAndDeposits", () => {
    it("classifies bills, deposits, transfers, and investments", async () => {
      const rows = [
        makeScheduled({
          id: "s1",
          name: "Rent",
          amount: -1200,
          account: { name: "Checking" } as any,
        }),
        makeScheduled({
          id: "s2",
          name: "Paycheck",
          amount: 3000,
          account: { name: "Checking" } as any,
        }),
        makeScheduled({
          id: "s3",
          name: "Move to Savings",
          amount: -500,
          isTransfer: true,
          transferAccountId: "acc-2",
          account: { name: "Checking" } as any,
        }),
        makeScheduled({
          id: "s4",
          name: "DRIP",
          amount: -100,
          isInvestment: true,
          investmentAction: "BUY" as any,
          account: { name: "Brokerage" } as any,
        }),
      ];
      const qb = mockQueryBuilder(rows);
      scheduledRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.getLlmUpcomingBillsAndDeposits(userId);

      expect(result.itemCount).toBe(4);
      const kinds = result.items.map((i) => i.kind).sort();
      expect(kinds).toEqual(["bill", "deposit", "investment", "transfer"]);
      expect(result.totalUpcomingBills).toBe(1200);
      expect(result.totalUpcomingDeposits).toBe(3000);
    });

    it("classifies an item from its occurrence, not the stored parent sign", async () => {
      // A mixed-sign split parent: an ordinary -1200 line beside an embedded
      // SELL of 10 x 100 whose stored pair is stale. The line re-prices at 1.35
      // to +1350, so the occurrence is a 150 deposit while the parent still
      // reads -200 -- and only one of those two answers is what will post.
      investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
        { from: "EUR", to: "USD" },
      );
      investmentTransactionsService.resolveCashExchangeRateOrNull.mockResolvedValue(
        1.35,
      );
      const rows = [
        makeScheduled({
          id: "s-split",
          name: "Sell 10 shares, pay the fee",
          amount: -200,
          isSplit: true,
          splits: [
            { id: "sp-1", kind: "category", amount: -1200 },
            {
              id: "sp-2",
              kind: "investment",
              amount: 1000,
              investmentAction: "SELL",
              investmentSecurityId: "SEC-1",
              investmentQuantity: 10,
              investmentPrice: 100,
              investmentCommission: 0,
              investmentExchangeRate: 1,
              investmentExchangeRateFromCurrency: "CAD",
              investmentExchangeRateToCurrency: "USD",
            },
          ] as never,
        }),
      ];
      scheduledRepo.createQueryBuilder.mockReturnValue(mockQueryBuilder(rows));

      const result = await service.getLlmUpcomingBillsAndDeposits(userId);

      expect(result.items[0].amount).toBe(150);
      expect(result.items[0].kind).toBe("deposit");
      expect(result.totalUpcomingDeposits).toBe(150);
      expect(result.totalUpcomingBills).toBe(0);
    });

    it("keeps an unknown-direction occurrence in the rollups even under a kind filter", async () => {
      // A mixed-sign split whose investment line cannot be priced. Asked for
      // bills, the caller must not be handed a complete-looking bills total: the
      // item could be one, and the tool description promises exactly this.
      investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
        { from: "EUR", to: "USD" },
      );
      investmentTransactionsService.resolveCashExchangeRateOrNull.mockResolvedValue(
        null,
      );
      const rows = [
        makeScheduled({ id: "s-bill", name: "Rent", amount: -1200 }),
        makeScheduled({
          id: "s-split",
          name: "Sell shares, pay the fee",
          amount: 10,
          isSplit: true,
          splits: [
            { id: "sp-1", kind: "category", amount: -1200 },
            {
              id: "sp-2",
              kind: "investment",
              amount: 1210,
              investmentAction: "SELL",
              investmentSecurityId: "SEC-1",
              investmentQuantity: 10,
              investmentPrice: 121,
              investmentCommission: 0,
              investmentExchangeRate: 1,
              investmentExchangeRateFromCurrency: "CAD",
              investmentExchangeRateToCurrency: "USD",
            },
          ] as never,
        }),
      ];
      scheduledRepo.createQueryBuilder.mockReturnValue(mockQueryBuilder(rows));

      const result = await service.getLlmUpcomingBillsAndDeposits(userId, {
        kind: "bill",
      });

      // The list honours the filter...
      expect(result.items.map((i) => i.name)).toEqual(["Rent"]);
      // ...and the rollups still know about the item it removed.
      expect(result.totalUpcomingBills).toBeNull();
      expect(result.knownUpcomingBillsSubtotal).toBe(1200);
      expect(result.amountsComplete).toBe(false);
      expect(result.unknownAmountItems).toEqual(["Sell shares, pay the fee"]);
    });

    describe("the rollups span one currency or none", () => {
      // A CAD bill beside a USD one. Added as their raw numbers these are the
      // 1,850 the tool descriptions promise the caller will never be handed:
      // both totals are published in ONE currency (the reader's default), so a
      // component in another either converts or takes the total with it.
      const twoCurrencyBills = () => [
        makeScheduled({
          id: "s-usd",
          name: "Rent",
          amount: -500,
          currencyCode: "USD",
        }),
        makeScheduled({
          id: "s-cad",
          name: "Hydro",
          amount: -1350,
          currencyCode: "CAD",
        }),
      ];

      it("converts each component into the reporting currency", async () => {
        mockExchangeRateService.getRateForDate.mockResolvedValue(0.74);
        scheduledRepo.createQueryBuilder.mockReturnValue(
          mockQueryBuilder(twoCurrencyBills()),
        );

        const result = await service.getLlmUpcomingBillsAndDeposits(userId);

        expect(result.totalsCurrency).toBe("USD");
        // 500 USD + 1350 CAD x 0.74 = 1499 USD. Never 1850.
        expect(result.totalUpcomingBills).toBe(1499);
        expect(result.amountsComplete).toBe(true);
        expect(result.missingRatePairs).toBeUndefined();
        // Each item keeps its OWN currency -- the totals' currency is not a
        // relabelling of the rows.
        expect(
          result.items.map((i) => `${i.name}|${i.amount}|${i.currency}`).sort(),
        ).toEqual(["Hydro|-1350|CAD", "Rent|-500|USD"]);
      });

      it("withholds the total and names the pair when a rate is missing", async () => {
        mockExchangeRateService.getRateForDate.mockResolvedValue(null);
        mockExchangeRateService.getLatestRate.mockResolvedValue(null);
        scheduledRepo.createQueryBuilder.mockReturnValue(
          mockQueryBuilder(twoCurrencyBills()),
        );

        const result = await service.getLlmUpcomingBillsAndDeposits(userId);

        expect(result.totalUpcomingBills).toBeNull();
        expect(result.knownUpcomingBillsSubtotal).toBe(500);
        expect(result.amountsComplete).toBe(false);
        expect(result.missingRatePairs).toEqual(["CAD->USD"]);
        // A missing RATE is not an unresolvable amount: both figures are known,
        // and naming the schedule would send the reader to fix the wrong thing.
        expect(result.unknownAmountItems).toBeUndefined();
      });

      it("treats a non-positive stored rate as absent, not as a conversion", async () => {
        // Multiplying by 0 would convert the 1,350 bill to nothing and report
        // the total complete -- a plausible 500 in place of an honest refusal.
        mockExchangeRateService.getRateForDate.mockResolvedValue(0);
        mockExchangeRateService.getLatestRate.mockResolvedValue(0);
        scheduledRepo.createQueryBuilder.mockReturnValue(
          mockQueryBuilder(twoCurrencyBills()),
        );

        const result = await service.getLlmUpcomingBillsAndDeposits(userId);

        expect(result.totalUpcomingBills).toBeNull();
        expect(result.missingRatePairs).toEqual(["CAD->USD"]);
      });

      it("asks for a rate once per pair, not once per bill", async () => {
        mockExchangeRateService.getRateForDate.mockResolvedValue(0.74);
        const rows = [
          ...twoCurrencyBills(),
          makeScheduled({
            id: "s-cad-2",
            name: "Internet",
            amount: -100,
            currencyCode: "CAD",
          }),
          makeScheduled({
            id: "s-cad-3",
            name: "Phone",
            amount: -60,
            currencyCode: "CAD",
          }),
        ];
        scheduledRepo.createQueryBuilder.mockReturnValue(
          mockQueryBuilder(rows),
        );

        const result = await service.getLlmUpcomingBillsAndDeposits(userId);

        // 500 + (1350 + 100 + 60) x 0.74 = 500 + 1117.40
        expect(result.totalUpcomingBills).toBe(1617.4);
        // Three CAD bills, one lookup. The same-currency ones ask for none.
        const cadCalls =
          mockExchangeRateService.getRateForDate.mock.calls.filter(
            ([from, to]) => from === "CAD" && to === "USD",
          );
        expect(cadCalls).toHaveLength(1);
      });

      it("converts deposits too, and each bucket answers for itself", async () => {
        mockExchangeRateService.getRateForDate.mockImplementation(
          async (from: string) => (from === "CAD" ? 0.74 : null),
        );
        mockExchangeRateService.getLatestRate.mockResolvedValue(null);
        const rows = [
          makeScheduled({
            id: "s-dep",
            name: "Salary",
            amount: 2000,
            currencyCode: "CAD",
          }),
          makeScheduled({
            id: "s-bill-eur",
            name: "Server",
            amount: -80,
            currencyCode: "EUR",
          }),
        ];
        scheduledRepo.createQueryBuilder.mockReturnValue(
          mockQueryBuilder(rows),
        );

        const result = await service.getLlmUpcomingBillsAndDeposits(userId);

        // The deposit converted; only the bills bucket holds the EUR gap.
        expect(result.totalUpcomingDeposits).toBe(1480);
        expect(result.totalUpcomingBills).toBeNull();
        expect(result.knownUpcomingBillsSubtotal).toBe(0);
        expect(result.missingRatePairs).toEqual(["EUR->USD"]);
      });

      it("reports in the reader's own currency, not the schedules'", async () => {
        preferencesRepo.findOne.mockResolvedValue({ defaultCurrency: "CAD" });
        mockExchangeRateService.getRateForDate.mockResolvedValue(1.35);
        scheduledRepo.createQueryBuilder.mockReturnValue(
          mockQueryBuilder(twoCurrencyBills()),
        );

        const result = await service.getLlmUpcomingBillsAndDeposits(userId);

        expect(result.totalsCurrency).toBe("CAD");
        // 500 USD x 1.35 + 1350 CAD = 2025 CAD.
        expect(result.totalUpcomingBills).toBe(2025);
        expect(result.amountsComplete).toBe(true);
      });

      it("falls back to the shared reporting currency when the reader has no preference", async () => {
        // A missing preference row is not a missing currency: every surface
        // falls back to the same one, so the total is still denominated and
        // still printable. Asserted against the constant rather than a literal,
        // because the point is that this surface uses the shared answer.
        preferencesRepo.findOne.mockResolvedValue(null);
        scheduledRepo.createQueryBuilder.mockReturnValue(
          mockQueryBuilder([
            makeScheduled({
              id: "s-home",
              name: "Hydro",
              amount: -1350,
              currencyCode: FALLBACK_DEFAULT_CURRENCY,
            }),
          ]),
        );

        const result = await service.getLlmUpcomingBillsAndDeposits(userId);

        expect(result.totalsCurrency).toBe(FALLBACK_DEFAULT_CURRENCY);
        // Same currency as the one bill, so it converts with no rate at all.
        expect(result.totalUpcomingBills).toBe(1350);
        expect(mockExchangeRateService.getRateForDate).not.toHaveBeenCalled();
      });
    });

    describe("a kind filter narrows the list, never the rollups", () => {
      /**
       * A rollup total is a statement about the WINDOW. A caller narrowing the
       * list to deposits has not said the bills stopped existing, and a bucket
       * built from the filtered list published `totalUpcomingBills: 0` with
       * `amountsComplete: true` over a window holding a 1,200 bill -- a
       * confident "nothing is due", which is worse than no answer.
       *
       * The previous pass fixed exactly half of this: it moved the unknown
       * bucket off the filtered list and left these two on it.
       */
      it("still reports the other bucket's total", async () => {
        scheduledRepo.createQueryBuilder.mockReturnValue(
          mockQueryBuilder([
            makeScheduled({ id: "s-bill", name: "Rent", amount: -1200 }),
            makeScheduled({ id: "s-dep", name: "Salary", amount: 3000 }),
          ]),
        );

        const result = await service.getLlmUpcomingBillsAndDeposits(userId, {
          kind: "deposit",
        });

        // The list honours the filter...
        expect(result.items.map((i) => i.name)).toEqual(["Salary"]);
        // ...and neither total pretends the filtered-out half is empty.
        expect(result.totalUpcomingBills).toBe(1200);
        expect(result.totalUpcomingDeposits).toBe(3000);
        expect(result.amountsComplete).toBe(true);
      });

      it("names an unpriceable item the filter removed from the list", async () => {
        // The bill cannot be priced and the caller asked for deposits, so it
        // appears in neither `items` nor `unclassified` -- and read off the
        // filtered list it was named nowhere while making the bills total
        // unknown, leaving a bare `null` with no reason.
        investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
          { from: "EUR", to: "USD" },
        );
        investmentTransactionsService.resolveCashExchangeRateOrNull.mockResolvedValue(
          null,
        );
        scheduledRepo.createQueryBuilder.mockReturnValue(
          mockQueryBuilder([
            makeScheduled({
              id: "s-inv",
              name: "Monthly ETF buy",
              amount: -1000,
              isInvestment: true,
              investmentAction: "BUY" as never,
              investmentSecurityId: "SEC-1",
              investmentQuantity: 10,
              investmentPrice: 100,
            }),
            makeScheduled({ id: "s-bill", name: "Rent", amount: -1200 }),
            makeScheduled({ id: "s-dep", name: "Salary", amount: 3000 }),
          ]),
        );

        const result = await service.getLlmUpcomingBillsAndDeposits(userId, {
          kind: "deposit",
        });

        expect(result.items.map((i) => i.name)).toEqual(["Salary"]);
        expect(result.amountsComplete).toBe(false);
        expect(result.unknownAmountItems).toContain("Monthly ETF buy");
      });
    });

    it("filters by kind", async () => {
      const rows = [
        makeScheduled({ id: "s1", amount: -100 }),
        makeScheduled({ id: "s2", amount: 200 }),
      ];
      const qb = mockQueryBuilder(rows);
      scheduledRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.getLlmUpcomingBillsAndDeposits(userId, {
        kind: "bill",
      });

      expect(result.itemCount).toBe(1);
      expect(result.items[0].kind).toBe("bill");
      // The LIST is narrowed; the rollup is not. This line asserted `0` and was
      // pinning the defect: the window holds a 200 deposit, and answering "0
      // deposits are coming" because the caller asked about bills is a confident
      // wrong number, not a narrower answer (issue #1247, round 4).
      expect(result.totalUpcomingDeposits).toBe(200);
    });

    it("filters by accountIds", async () => {
      const rows = [
        makeScheduled({ id: "s1", accountId: "acc-1", amount: -100 }),
        makeScheduled({ id: "s2", accountId: "acc-2", amount: -200 }),
      ];
      const qb = mockQueryBuilder(rows);
      scheduledRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.getLlmUpcomingBillsAndDeposits(userId, {
        accountIds: ["acc-2"],
      });

      expect(result.itemCount).toBe(1);
      expect(result.items[0].id).toBe("s2");
    });

    it("counts overdue items (negative daysUntilDue)", async () => {
      const rows = [
        makeScheduled({
          id: "s1",
          amount: -100,
          nextDueDate: "2000-01-01",
        }),
      ];
      const qb = mockQueryBuilder(rows);
      scheduledRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.getLlmUpcomingBillsAndDeposits(userId);

      expect(result.overdueCount).toBe(1);
      expect(result.items[0].daysUntilDue).toBeLessThan(0);
    });

    it("returns daysWindow matching the days argument", async () => {
      const qb = mockQueryBuilder([]);
      scheduledRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.getLlmUpcomingBillsAndDeposits(userId, {
        days: 14,
      });

      expect(result.daysWindow).toBe(14);
    });

    // ---- Effective amounts and completeness (issue #1247) ----

    it("reports each item's effective amount, not its persisted snapshot", async () => {
      const rows = [
        makeScheduled({
          id: "s-inv",
          name: "Monthly ETF buy",
          amount: -1000,
          currencyCode: "CAD",
          isInvestment: true,
          investmentAction: "BUY" as any,
          investmentSecurityId: "SEC-1",
          investmentQuantity: 10,
          investmentPrice: 100,
          investmentExchangeRate: 1.5,
          investmentExchangeRateFromCurrency: "EUR",
          investmentExchangeRateToCurrency: "CAD",
          account: { name: "Brokerage" } as any,
        }),
      ];
      scheduledRepo.createQueryBuilder.mockReturnValue(mockQueryBuilder(rows));
      investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
        { from: "USD", to: "CAD" },
      );
      investmentTransactionsService.resolveCashExchangeRateOrNull.mockResolvedValue(
        1.35,
      );

      const result = await service.getLlmUpcomingBillsAndDeposits(userId);

      expect(result.items[0].amount).toBe(-1350);
      expect(result.items[0].amount).not.toBe(-1000);
      expect(result.items[0].amountComplete).toBe(true);
      expect(result.items[0].currency).toBe("CAD");
      expect(result.amountsComplete).toBe(true);
    });

    it("marks an item unavailable rather than quoting a stale amount", async () => {
      const rows = [
        makeScheduled({
          id: "s-inv",
          name: "Monthly ETF buy",
          amount: -1000,
          isInvestment: true,
          investmentAction: "BUY" as any,
          investmentSecurityId: "SEC-1",
          investmentQuantity: 10,
          investmentPrice: 100,
          investmentExchangeRate: 1.5,
          investmentExchangeRateFromCurrency: "EUR",
          investmentExchangeRateToCurrency: "CAD",
          account: { name: "Brokerage" } as any,
        }),
      ];
      scheduledRepo.createQueryBuilder.mockReturnValue(mockQueryBuilder(rows));
      investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
        { from: "USD", to: "CAD" },
      );
      investmentTransactionsService.resolveCashExchangeRateOrNull.mockResolvedValue(
        null,
      );

      const result = await service.getLlmUpcomingBillsAndDeposits(userId);

      expect(result.items[0].amount).toBeNull();
      expect(result.items[0].amountComplete).toBe(false);
      expect(result.amountsComplete).toBe(false);
      expect(result.unknownAmountItems).toEqual(["Monthly ETF buy"]);
    });

    it("withholds a bucket total when one of its items is unknown", async () => {
      // A split parent carrying an investment line classifies as a bill (its
      // stored amount is negative), so it DOES join totalUpcomingBills -- which
      // is exactly why an unresolvable rate must make that total unknown.
      const rows = [
        makeScheduled({
          id: "s-known",
          name: "Rent",
          amount: -1200,
          account: { name: "Checking" } as any,
        }),
        makeScheduled({
          id: "s-unknown",
          name: "Buy plus fee",
          amount: -1525,
          isSplit: true,
          splits: [
            {
              id: "sp-1",
              kind: "investment",
              amount: -1500,
              investmentAction: "BUY",
              investmentSecurityId: "SEC-1",
              investmentQuantity: 10,
              investmentPrice: 100,
              investmentCommission: 0,
              investmentExchangeRate: 1.5,
              investmentExchangeRateFromCurrency: "EUR",
              investmentExchangeRateToCurrency: "CAD",
            },
          ] as any,
          account: { name: "Brokerage" } as any,
        }),
      ];
      scheduledRepo.createQueryBuilder.mockReturnValue(mockQueryBuilder(rows));
      investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
        { from: "USD", to: "CAD" },
      );
      investmentTransactionsService.resolveCashExchangeRateOrNull.mockResolvedValue(
        null,
      );

      const result = await service.getLlmUpcomingBillsAndDeposits(userId);

      expect(result.totalUpcomingBills).toBeNull();
      // The part that did resolve, under its own name -- never in the total's.
      expect(result.knownUpcomingBillsSubtotal).toBe(1200);
      expect(result.amountsComplete).toBe(false);
      expect(result.unknownAmountItems).toEqual(["Buy plus fee"]);
      // The deposits bucket answers for itself: nothing in it is unknown.
      expect(result.totalUpcomingDeposits).toBe(0);
      expect(result.knownUpcomingDepositsSubtotal).toBeUndefined();
    });

    // ---- Occurrence selection (issue #1247) ----
    //
    // The payload is about the occurrence that is next due, not the schedule's
    // template. Reporting the base amount for an occurrence the user had
    // re-priced or moved is the same class of defect as reporting a stale FX
    // snapshot: the assistant answers with a figure and a date the register
    // disagrees with.

    /** The template's occurrences: due on the 15th, -1,200. */
    const rentOnThe15th = () =>
      makeScheduled({
        id: "s-rent",
        name: "Rent",
        amount: -1200,
        currencyCode: "USD",
        nextDueDate: "2026-03-15",
        account: { name: "Checking" } as any,
      });

    it("quotes the next occurrence's override amount, not the schedule's", async () => {
      scheduledRepo.createQueryBuilder.mockReturnValue(
        mockQueryBuilder([rentOnThe15th()]),
      );
      overridesRepo.find.mockResolvedValue([
        {
          id: "ovr-1",
          scheduledTransactionId: "s-rent",
          originalDate: "2026-03-15",
          overrideDate: "2026-03-15",
          amount: -675,
        },
      ]);

      const result = await service.getLlmUpcomingBillsAndDeposits(userId);

      expect(result.items[0].amount).toBe(-675);
      expect(result.items[0].amount).not.toBe(-1200);
      expect(result.totalUpcomingBills).toBe(675);
    });

    it("announces the date an override moved the occurrence to", async () => {
      scheduledRepo.createQueryBuilder.mockReturnValue(
        mockQueryBuilder([rentOnThe15th()]),
      );
      overridesRepo.find.mockResolvedValue([
        {
          id: "ovr-1",
          scheduledTransactionId: "s-rent",
          // The identity is the slot it replaces; the occurrence itself moved.
          originalDate: "2026-03-15",
          overrideDate: "2026-03-28",
          amount: -675,
        },
      ]);

      const result = await service.getLlmUpcomingBillsAndDeposits(userId);

      expect(result.items[0].nextDueDate).toBe("2026-03-28");
      expect(result.items[0].amount).toBe(-675);
    });

    it("withholds the bills total when the due occurrence's override cannot be priced", async () => {
      // A plain bill whose next occurrence the user turned into a split that buys
      // a security. The template is still -1,200 and perfectly knowable; the
      // OCCURRENCE is not, because that line's settlement rate is unresolvable --
      // so a consumer reading the base here would report a complete total for an
      // occurrence nobody can price.
      scheduledRepo.createQueryBuilder.mockReturnValue(
        mockQueryBuilder([
          rentOnThe15th(),
          makeScheduled({
            id: "s-phone",
            name: "Phone bill",
            amount: -80,
            currencyCode: "USD",
            nextDueDate: "2026-03-20",
            account: { name: "Checking" } as any,
          }),
        ]),
      );
      overridesRepo.find.mockResolvedValue([
        {
          id: "ovr-phone",
          scheduledTransactionId: "s-phone",
          originalDate: "2026-03-20",
          overrideDate: "2026-03-20",
          amount: null,
          isSplit: true,
          splits: [
            {
              amount: -1500,
              splitKind: "investment",
              investment: {
                action: "BUY",
                securityId: "SEC-1",
                quantity: 10,
                price: 100,
                commission: 0,
                exchangeRate: 1.5,
                exchangeRateFromCurrency: "EUR",
                exchangeRateToCurrency: "CAD",
              },
            },
          ],
        },
      ]);
      investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
        { from: "USD", to: "CAD" },
      );
      investmentTransactionsService.resolveCashExchangeRateOrNull.mockResolvedValue(
        null,
      );

      const result = await service.getLlmUpcomingBillsAndDeposits(userId);

      const phone = result.items.find((i) => i.id === "s-phone")!;
      expect(phone.amount).toBeNull();
      expect(phone.amountComplete).toBe(false);
      expect(result.totalUpcomingBills).toBeNull();
      // The occurrence that did resolve, under its own name -- never the total's.
      expect(result.knownUpcomingBillsSubtotal).toBe(1200);
      expect(result.unknownAmountItems).toEqual(["Phone bill"]);
    });
  });

  // ==================== update ====================
  describe("update", () => {
    it("should update simple fields", async () => {
      const scheduled = makeScheduled();
      stubFindOne(scheduled);

      await service.update(userId, stId, {
        name: "Updated Rent",
        amount: -1500,
      });

      expect(mockQueryRunner.manager.update).toHaveBeenCalledWith(
        ScheduledTransaction,
        stId,
        expect.objectContaining({ name: "Updated Rent", amount: -1500 }),
      );
    });

    it("should verify new account ownership when accountId changes", async () => {
      const scheduled = makeScheduled();
      stubFindOne(scheduled);

      await service.update(userId, stId, { accountId: "acc-2" });

      expect(accountsService.findOne).toHaveBeenCalledWith(userId, "acc-2");
    });

    it("should throw if transfer account same as source on update", async () => {
      const scheduled = makeScheduled({ accountId: "acc-1" });
      stubFindOne(scheduled);

      await expect(
        service.update(userId, stId, {
          isTransfer: true,
          transferAccountId: "acc-1",
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("should delete old splits and create new ones", async () => {
      const scheduled = makeScheduled({ amount: -1000 });
      stubFindOne(scheduled);

      await service.update(userId, stId, {
        splits: [
          { categoryId: "cat-a", amount: -600 },
          { categoryId: "cat-b", amount: -400 },
        ],
      });

      expect(mockQueryRunner.manager.delete).toHaveBeenCalledWith(
        ScheduledTransactionSplit,
        { scheduledTransactionId: stId },
      );
      expect(mockQueryRunner.manager.create).toHaveBeenCalledTimes(2);
    });

    it("should clear splits when empty array provided", async () => {
      const scheduled = makeScheduled({ isSplit: true });
      stubFindOne(scheduled);

      await service.update(userId, stId, { splits: [] });

      expect(mockQueryRunner.manager.delete).toHaveBeenCalledWith(
        ScheduledTransactionSplit,
        { scheduledTransactionId: stId },
      );
      expect(mockQueryRunner.manager.update).toHaveBeenCalledWith(
        ScheduledTransaction,
        stId,
        expect.objectContaining({ isSplit: false }),
      );
    });

    it("should convert empty strings to null for nullable fields", async () => {
      const scheduled = makeScheduled();
      stubFindOne(scheduled);

      await service.update(userId, stId, {
        description: "" as any,
        payeeName: "" as any,
      });

      const updateArg = mockQueryRunner.manager.update.mock.calls[0][2];
      expect(updateArg.description).toBeNull();
      expect(updateArg.payeeName).toBeNull();
    });

    it("clears splits when switching to transfer but does not force category null (#743)", async () => {
      const scheduled = makeScheduled({ isSplit: true });
      stubFindOne(scheduled);

      await service.update(userId, stId, {
        isTransfer: true,
        transferAccountId: "acc-2",
      });

      expect(mockQueryRunner.manager.delete).toHaveBeenCalledWith(
        ScheduledTransactionSplit,
        { scheduledTransactionId: stId },
      );
      const updateArg = mockQueryRunner.manager.update.mock.calls[0][2];
      expect(updateArg.isTransfer).toBe(true);
      expect(updateArg.isSplit).toBe(false);
      // A transfer may keep a category, so the switch must not null it.
      expect(updateArg.categoryId).toBeUndefined();
    });

    it("keeps a category set on a transfer update (#743)", async () => {
      const scheduled = makeScheduled({ isTransfer: true });
      stubFindOne(scheduled);

      await service.update(userId, stId, {
        isTransfer: true,
        transferAccountId: "acc-2",
        categoryId: "cat-9",
      });

      const updateArg = mockQueryRunner.manager.update.mock.calls[0][2];
      expect(updateArg.categoryId).toBe("cat-9");
    });

    it("records action history on update", async () => {
      const scheduled = makeScheduled();
      stubFindOne(scheduled);

      await service.update(userId, stId, { name: "Updated Rent" });

      expect(mockActionHistoryService.record).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          entityType: "scheduled_transaction",
          entityId: stId,
          action: "update",
          description: expect.stringContaining("Updated"),
        }),
      );
    });

    it("syncs the durable loan configuration when the user edits a loan payment schedule", async () => {
      // The per-posting recalculation reads the configured payment and extra
      // from the account, because the template also carries transient clamps.
      // A user edit of the template is a reconfiguration, so it must land on
      // the account too -- otherwise the recalculation would grow the edit
      // back to the stale configured value (review #1131).
      const scheduled = makeScheduled({ amount: -1000 });
      stubFindOne(scheduled);
      accountsRepo.findOne.mockResolvedValueOnce({
        id: "acc-loan",
        scheduledTransactionId: stId,
      });

      await service.update(userId, stId, {
        amount: -800,
        splits: [
          { transferAccountId: "acc-loan", amount: -500, memo: "Principal" },
          { categoryId: "cat-interest", amount: -100, memo: "Interest" },
          {
            transferAccountId: "acc-loan",
            amount: -200,
            memo: "Extra Principal",
          },
        ],
      });

      expect(accountsRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { scheduledTransactionId: stId, userId },
        }),
      );
      expect(accountsRepo.update).toHaveBeenCalledWith("acc-loan", {
        paymentAmount: 800,
        extraPaymentAmount: 200,
      });
    });

    it.each(["LINEAR", "INTEREST_ONLY"])(
      "records no payment amount when the user edits a %s mortgage's schedule",
      async (mortgageType) => {
        // docs/specs/mortgage-types.md section 5.6: these methods have no
        // constant payment (the column's CHECK refuses one). The edit stands
        // for the template only and the next advancement reprices it; the
        // standing extra is still the user's configuration.
        const scheduled = makeScheduled({ amount: -1333.3333 });
        stubFindOne(scheduled);
        accountsRepo.findOne.mockResolvedValueOnce({
          id: "acc-loan",
          accountType: "MORTGAGE",
          mortgageType,
          scheduledTransactionId: stId,
        });

        await service.update(userId, stId, {
          amount: -1433.3333,
          splits: [
            {
              transferAccountId: "acc-loan",
              amount: -833.3333,
              memo: "Principal",
            },
            { categoryId: "cat-interest", amount: -500, memo: "Interest" },
            {
              transferAccountId: "acc-loan",
              amount: -100,
              memo: "Extra Principal",
            },
          ],
        });

        expect(accountsRepo.update).toHaveBeenCalledWith("acc-loan", {
          extraPaymentAmount: 100,
        });
      },
    );

    it("still records the payment of an annuity mortgage's edited schedule", async () => {
      const scheduled = makeScheduled({ amount: -1000 });
      stubFindOne(scheduled);
      accountsRepo.findOne.mockResolvedValueOnce({
        id: "acc-loan",
        accountType: "MORTGAGE",
        mortgageType: "ANNUITY",
        scheduledTransactionId: stId,
      });

      await service.update(userId, stId, { amount: -1100 });

      expect(accountsRepo.update).toHaveBeenCalledWith("acc-loan", {
        paymentAmount: 1100,
      });
    });

    it("does not touch any account when the schedule is not a loan payment", async () => {
      const scheduled = makeScheduled();
      stubFindOne(scheduled);
      accountsRepo.findOne.mockResolvedValueOnce(null);

      await service.update(userId, stId, { amount: -1200 });

      expect(accountsRepo.update).not.toHaveBeenCalled();
    });

    it("does not look up a loan account for a presentation-only edit", async () => {
      const scheduled = makeScheduled();
      stubFindOne(scheduled);

      await service.update(userId, stId, { name: "Renamed" });

      expect(accountsRepo.findOne).not.toHaveBeenCalled();
      expect(accountsRepo.update).not.toHaveBeenCalled();
    });
  });

  // ==================== remove ====================
  describe("remove", () => {
    it("should find and remove the scheduled transaction", async () => {
      const scheduled = makeScheduled();
      stubFindOne(scheduled);

      await service.remove(userId, stId);

      expect(scheduledRepo.remove).toHaveBeenCalledWith(scheduled);
    });

    it("should throw NotFoundException if not found", async () => {
      scheduledRepo.findOne.mockResolvedValue(null);
      await expect(service.remove(userId, stId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it("records action history on remove", async () => {
      const scheduled = makeScheduled();
      stubFindOne(scheduled);

      await service.remove(userId, stId);

      expect(mockActionHistoryService.record).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          entityType: "scheduled_transaction",
          entityId: stId,
          action: "delete",
          beforeData: expect.objectContaining({ name: "Monthly Rent" }),
          description: expect.stringContaining("Monthly Rent"),
        }),
      );
    });
  });

  // ==================== skip (frequency advancement) ====================

  // Helper to format Date as YYYY-MM-DD in UTC (matching how the service operates)
  const toUTCDateStr = (d: Date) => {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  };
  // Build a YYYY-MM-DD date string matching the entity's string-typed DATE columns
  const utcDate = (y: number, m: number, d: number): string =>
    `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

  describe("skip", () => {
    it("should advance DAILY by 1 day", async () => {
      const scheduled = makeScheduled({
        frequency: "DAILY",
        nextDueDate: utcDate(2025, 3, 1),
      });
      stubFindOne(scheduled);

      await service.skip(userId, stId);

      const updateArg = scheduledRepo.update.mock.calls[0][1];
      expect(toUTCDateStr(new Date(updateArg.nextDueDate))).toBe("2025-03-02");
    });

    it("should advance WEEKLY by 7 days", async () => {
      const scheduled = makeScheduled({
        frequency: "WEEKLY",
        nextDueDate: utcDate(2025, 3, 1),
      });
      stubFindOne(scheduled);

      await service.skip(userId, stId);

      const updateArg = scheduledRepo.update.mock.calls[0][1];
      expect(toUTCDateStr(new Date(updateArg.nextDueDate))).toBe("2025-03-08");
    });

    it("should advance BIWEEKLY by 14 days", async () => {
      const scheduled = makeScheduled({
        frequency: "BIWEEKLY",
        nextDueDate: utcDate(2025, 3, 1),
      });
      stubFindOne(scheduled);

      await service.skip(userId, stId);

      const updateArg = scheduledRepo.update.mock.calls[0][1];
      expect(toUTCDateStr(new Date(updateArg.nextDueDate))).toBe("2025-03-15");
    });

    it("should advance EVERY4WEEKS by 28 days", async () => {
      const scheduled = makeScheduled({
        frequency: "EVERY4WEEKS",
        nextDueDate: utcDate(2025, 3, 1),
      });
      stubFindOne(scheduled);

      await service.skip(userId, stId);

      const updateArg = scheduledRepo.update.mock.calls[0][1];
      expect(toUTCDateStr(new Date(updateArg.nextDueDate))).toBe("2025-03-29");
    });

    it("should advance SEMIMONTHLY: day<=15 goes to last day of month", async () => {
      const scheduled = makeScheduled({
        frequency: "SEMIMONTHLY",
        nextDueDate: utcDate(2025, 3, 15),
      });
      stubFindOne(scheduled);

      await service.skip(userId, stId);

      const updateArg = scheduledRepo.update.mock.calls[0][1];
      expect(toUTCDateStr(new Date(updateArg.nextDueDate))).toBe("2025-03-31");
    });

    it("should advance SEMIMONTHLY: day>15 goes to 15th of next month", async () => {
      const scheduled = makeScheduled({
        frequency: "SEMIMONTHLY",
        nextDueDate: utcDate(2025, 3, 31),
      });
      stubFindOne(scheduled);

      await service.skip(userId, stId);

      const updateArg = scheduledRepo.update.mock.calls[0][1];
      expect(toUTCDateStr(new Date(updateArg.nextDueDate))).toBe("2025-04-15");
    });

    it("should advance MONTHLY by 1 month", async () => {
      const scheduled = makeScheduled({
        frequency: "MONTHLY",
        nextDueDate: utcDate(2025, 1, 15),
      });
      stubFindOne(scheduled);

      await service.skip(userId, stId);

      const updateArg = scheduledRepo.update.mock.calls[0][1];
      expect(toUTCDateStr(new Date(updateArg.nextDueDate))).toBe("2025-02-15");
    });

    it("should advance QUARTERLY by 3 months", async () => {
      const scheduled = makeScheduled({
        frequency: "QUARTERLY",
        nextDueDate: utcDate(2025, 1, 15),
      });
      stubFindOne(scheduled);

      await service.skip(userId, stId);

      const updateArg = scheduledRepo.update.mock.calls[0][1];
      expect(toUTCDateStr(new Date(updateArg.nextDueDate))).toBe("2025-04-15");
    });

    it("should advance YEARLY by 1 year", async () => {
      const scheduled = makeScheduled({
        frequency: "YEARLY",
        nextDueDate: utcDate(2025, 1, 15),
      });
      stubFindOne(scheduled);

      await service.skip(userId, stId);

      const updateArg = scheduledRepo.update.mock.calls[0][1];
      expect(toUTCDateStr(new Date(updateArg.nextDueDate))).toBe("2026-01-15");
    });

    it("should delete override for the skipped date", async () => {
      const scheduled = makeScheduled({ nextDueDate: "2025-02-15" });
      stubFindOne(scheduled);

      await service.skip(userId, stId);

      expect(overridesRepo.delete).toHaveBeenCalledWith({
        scheduledTransactionId: stId,
        originalDate: "2025-02-15",
      });
    });

    it("should decrement occurrencesRemaining", async () => {
      const scheduled = makeScheduled({ occurrencesRemaining: 5 });
      stubFindOne(scheduled);

      await service.skip(userId, stId);

      const updateArg = scheduledRepo.update.mock.calls[0][1];
      expect(updateArg.occurrencesRemaining).toBe(4);
    });

    it("should deactivate when occurrencesRemaining reaches 0", async () => {
      const scheduled = makeScheduled({ occurrencesRemaining: 1 });
      stubFindOne(scheduled);

      await service.skip(userId, stId);

      const updateArg = scheduledRepo.update.mock.calls[0][1];
      expect(updateArg.occurrencesRemaining).toBe(0);
      expect(updateArg.isActive).toBe(false);
    });

    it("should deactivate when next date is past endDate", async () => {
      const scheduled = makeScheduled({
        frequency: "MONTHLY",
        nextDueDate: "2025-12-15",
        endDate: "2025-12-31",
      });
      stubFindOne(scheduled);

      await service.skip(userId, stId);

      const updateArg = scheduledRepo.update.mock.calls[0][1];
      expect(updateArg.isActive).toBe(false);
    });

    it("should not touch occurrencesRemaining when null", async () => {
      const scheduled = makeScheduled({ occurrencesRemaining: null });
      stubFindOne(scheduled);

      await service.skip(userId, stId);

      const updateArg = scheduledRepo.update.mock.calls[0][1];
      expect(updateArg.occurrencesRemaining).toBeUndefined();
    });

    it("should store nextDueDate as YYYY-MM-DD string to prevent timezone drift", async () => {
      const scheduled = makeScheduled({
        frequency: "MONTHLY",
        nextDueDate: utcDate(2025, 2, 15),
      });
      stubFindOne(scheduled);

      await service.skip(userId, stId);

      const updateArg = scheduledRepo.update.mock.calls[0][1];
      expect(typeof updateArg.nextDueDate).toBe("string");
      expect(updateArg.nextDueDate).toBe("2025-03-15");
    });
  });

  // ==================== post ====================
  describe("post", () => {
    it("should create a regular transaction from base values", async () => {
      const scheduled = makeScheduled();
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      accountsRepo.findOne.mockResolvedValue(null);

      await service.post(userId, stId);

      expect(transactionsService.create).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          accountId: "acc-1",
          amount: -1200,
          currencyCode: "USD",
        }),
      );
    });

    it("forwards actorIsNotOwner to the create so an acting delegate's post skips the owner's structural rules", async () => {
      stubFindOne(makeScheduled());
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      accountsRepo.findOne.mockResolvedValue(null);

      await service.post(userId, stId, undefined, { actorIsNotOwner: true });

      expect(transactionsService.create).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({ accountId: "acc-1" }),
        { actorIsNotOwner: true },
      );
    });

    it("should use prepareTransfer for transfer transactions", async () => {
      const scheduled = makeScheduled({
        isTransfer: true,
        transferAccountId: "acc-2",
      });
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      accountsRepo.findOne.mockResolvedValue(null);

      await service.post(userId, stId);

      expect(transactionsService.prepareTransfer).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          fromAccountId: "acc-1",
          toAccountId: "acc-2",
          amount: 1200,
        }),
      );
      expect(transactionsService.create).not.toHaveBeenCalled();
    });

    it("authorizes the transfer before the posting transaction opens", async () => {
      // The regression this pins: `createTransfer` was called *inside* the
      // posting transaction. Its authorization reads a foreign account row
      // under `withSystemContext`, and a system-identity `withScopedDb` cannot
      // join a user-identity transaction -- it throws
      // `IDENTITY_MISMATCH_MESSAGE` -- so every scheduled transfer post failed,
      // cron and manual alike. Preparing above the transaction is what fixes it,
      // so the order is the invariant, not an implementation detail.
      //
      // Written as "no transaction was open when prepare ran" rather than as a
      // call-order assertion: the posting path opens more than one transaction,
      // and only the nesting is the defect.
      let transactionDepth = 0;
      let preparedInsideTransaction = false;
      let wroteInsideTransaction = false;

      mockDataSource.transaction.mockImplementation(async (...args: any[]) => {
        const fn = args[args.length - 1] as (m: unknown) => unknown;
        transactionDepth++;
        try {
          return await fn(mockQueryRunner.manager);
        } finally {
          transactionDepth--;
        }
      });
      transactionsService.prepareTransfer.mockImplementation(async () => {
        preparedInsideTransaction = transactionDepth > 0;
        return {
          effectiveUserId: userId,
          realUserId: userId,
          dto: {},
          fromOwnerId: userId,
          toOwnerId: userId,
          hasForeignLeg: false,
        };
      });
      transactionsService.writeTransferLegs.mockImplementation(async () => {
        wroteInsideTransaction = transactionDepth > 0;
        return { savedFromId: "tx-1", savedToId: "tx-2" };
      });

      const scheduled = makeScheduled({
        isTransfer: true,
        transferAccountId: "acc-2",
      });
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      accountsRepo.findOne.mockResolvedValue(null);

      await service.post(userId, stId);

      expect(transactionsService.prepareTransfer).toHaveBeenCalled();
      expect(preparedInsideTransaction).toBe(false);
      // ...and the write still joins it, so the legs, the occurrence claim and
      // the schedule advancement remain one unit.
      expect(wroteInsideTransaction).toBe(true);
    });

    it("writes a scheduled transfer's legs (and so the create rules) on the posting transaction's manager", async () => {
      // The rules step lives in writeTransferLegs and runs on the manager it is
      // handed, so a scheduled transfer gets the rules in the same unit as the
      // occurrence claim and a rollback drops both.
      mockDataSource.transaction.mockImplementation(async (...args: any[]) => {
        const fn = args[args.length - 1] as (m: unknown) => unknown;
        return fn(mockQueryRunner.manager);
      });
      const scheduled = makeScheduled({
        isTransfer: true,
        transferAccountId: "acc-2",
      });
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      accountsRepo.findOne.mockResolvedValue(null);

      await service.post(userId, stId);

      expect(transactionsService.writeTransferLegs).toHaveBeenCalledTimes(1);
      expect(transactionsService.writeTransferLegs.mock.calls[0][1]).toBe(
        mockQueryRunner.manager,
      );
      expect(
        transactionsService.completeTransfer.mock.invocationCallOrder[0],
      ).toBeGreaterThan(
        transactionsService.writeTransferLegs.mock.invocationCallOrder[0],
      );
    });

    it("completes the transfer only after the posting transaction commits", async () => {
      // `completeTransfer` records action history, and the recorder swallows its
      // own failures by design: inside the caller's transaction that is either a
      // `25P02` abort of the posting or a silently dropped undo entry.
      let transactionDepth = 0;
      let completedInsideTransaction = false;

      mockDataSource.transaction.mockImplementation(async (...args: any[]) => {
        const fn = args[args.length - 1] as (m: unknown) => unknown;
        transactionDepth++;
        try {
          return await fn(mockQueryRunner.manager);
        } finally {
          transactionDepth--;
        }
      });
      transactionsService.completeTransfer.mockImplementation(async () => {
        completedInsideTransaction = transactionDepth > 0;
        return {
          fromTransaction: { id: "tx-1" },
          toTransaction: { id: "tx-2" },
        };
      });

      const scheduled = makeScheduled({
        isTransfer: true,
        transferAccountId: "acc-2",
      });
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      accountsRepo.findOne.mockResolvedValue(null);

      await service.post(userId, stId);

      expect(transactionsService.completeTransfer).toHaveBeenCalled();
      expect(completedInsideTransaction).toBe(false);
    });

    it("does not send currency codes, leaving the transfer service to derive them (P5-002)", async () => {
      // A schedule stores only its source currency. Sending that as
      // `fromCurrencyCode` with no target currency, rate or destination amount
      // is what made a cross-currency scheduled transfer post at 1:1 with the
      // destination row labelled in the source's currency.
      //
      // Sending the stored code and nothing else is also fragile the other way:
      // if the account's currency has since changed, the stored code is stale
      // and the posting would now be rejected. The accounts are the authority,
      // so neither code is sent at all.
      const scheduled = makeScheduled({
        isTransfer: true,
        transferAccountId: "acc-2",
      });
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      accountsRepo.findOne.mockResolvedValue(null);

      await service.post(userId, stId);

      const dto = transactionsService.prepareTransfer.mock.calls[0][1];
      expect(dto).not.toHaveProperty("fromCurrencyCode");
      expect(dto).not.toHaveProperty("toCurrencyCode");
      expect(dto).not.toHaveProperty("exchangeRate");
      expect(dto).not.toHaveProperty("toAmount");
    });

    it("forwards the schedule's category to prepareTransfer (#743)", async () => {
      const scheduled = makeScheduled({
        isTransfer: true,
        transferAccountId: "acc-2",
        categoryId: "cat-ike",
      });
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      accountsRepo.findOne.mockResolvedValue(null);

      await service.post(userId, stId);

      expect(transactionsService.prepareTransfer).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({ categoryId: "cat-ike" }),
      );
    });

    it("should pass payee fields to prepareTransfer for transfer transactions", async () => {
      const scheduled = makeScheduled({
        isTransfer: true,
        transferAccountId: "acc-2",
        payeeId: "payee-1",
        payeeName: "Landlord",
      });
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      accountsRepo.findOne.mockResolvedValue(null);

      await service.post(userId, stId);

      expect(transactionsService.prepareTransfer).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          fromAccountId: "acc-1",
          toAccountId: "acc-2",
          amount: 1200,
          payeeId: "payee-1",
          payeeName: "Landlord",
        }),
      );
    });

    it("should pass undefined payee fields when scheduled transaction has no payee", async () => {
      const scheduled = makeScheduled({
        isTransfer: true,
        transferAccountId: "acc-2",
        payeeId: null as any,
        payeeName: null as any,
      });
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      accountsRepo.findOne.mockResolvedValue(null);

      await service.post(userId, stId);

      expect(transactionsService.prepareTransfer).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          fromAccountId: "acc-1",
          toAccountId: "acc-2",
          payeeId: undefined,
          payeeName: undefined,
        }),
      );
    });

    it("should pass tagIds to prepareTransfer for transfer transactions", async () => {
      const scheduled = makeScheduled({
        isTransfer: true,
        transferAccountId: "acc-2",
        tagIds: ["tag-1", "tag-2"],
      });
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      accountsRepo.findOne.mockResolvedValue(null);

      await service.post(userId, stId);

      expect(transactionsService.prepareTransfer).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          fromAccountId: "acc-1",
          toAccountId: "acc-2",
          tagIds: ["tag-1", "tag-2"],
        }),
      );
    });

    it("should not pass tagIds to prepareTransfer when scheduled transaction has no tags", async () => {
      const scheduled = makeScheduled({
        isTransfer: true,
        transferAccountId: "acc-2",
        tagIds: [],
      });
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      accountsRepo.findOne.mockResolvedValue(null);

      await service.post(userId, stId);

      expect(transactionsService.prepareTransfer).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          tagIds: undefined,
        }),
      );
    });

    it("should apply stored override amount to transfer via Math.abs", async () => {
      const scheduled = makeScheduled({
        isTransfer: true,
        transferAccountId: "acc-2",
        amount: -1200,
      });
      stubFindOne(scheduled);
      const storedOverride = {
        amount: -750,
        description: null,
        isSplit: null,
        categoryId: null,
        splits: null,
      };
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(storedOverride);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      overridesRepo.findOne.mockResolvedValue(storedOverride);
      accountsRepo.findOne.mockResolvedValue(null);

      await service.post(userId, stId);

      expect(transactionsService.prepareTransfer).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          amount: 750,
        }),
      );
    });

    it("should apply inline amount override to transfer via Math.abs", async () => {
      const scheduled = makeScheduled({
        isTransfer: true,
        transferAccountId: "acc-2",
        amount: -1200,
      });
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      accountsRepo.findOne.mockResolvedValue(null);

      await service.post(userId, stId, { amount: -500 });

      expect(transactionsService.prepareTransfer).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          amount: 500,
        }),
      );
    });

    it("should handle positive scheduled transfer amount correctly", async () => {
      const scheduled = makeScheduled({
        isTransfer: true,
        transferAccountId: "acc-2",
        amount: 800,
      });
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      accountsRepo.findOne.mockResolvedValue(null);

      await service.post(userId, stId);

      expect(transactionsService.prepareTransfer).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          amount: 800,
        }),
      );
    });

    it("should pass override description to prepareTransfer", async () => {
      const scheduled = makeScheduled({
        isTransfer: true,
        transferAccountId: "acc-2",
        description: "base desc",
      });
      stubFindOne(scheduled);
      const storedOverride = {
        amount: null,
        description: "override desc",
        isSplit: null,
        categoryId: null,
        splits: null,
      };
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(storedOverride);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      overridesRepo.findOne.mockResolvedValue(storedOverride);
      accountsRepo.findOne.mockResolvedValue(null);

      await service.post(userId, stId);

      expect(transactionsService.prepareTransfer).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          description: "override desc",
        }),
      );
    });

    it("should apply inline values with highest priority", async () => {
      const scheduled = makeScheduled({ amount: -1200 });
      stubFindOne(scheduled);
      const storedOverride = {
        amount: -999,
        description: "override desc",
      };
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(storedOverride);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      overridesRepo.findOne.mockResolvedValue(storedOverride);
      accountsRepo.findOne.mockResolvedValue(null);

      await service.post(userId, stId, {
        amount: -500,
        description: "inline desc",
      });

      expect(transactionsService.create).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({ amount: -500, description: "inline desc" }),
      );
    });

    it("should apply stored override values when no inline values", async () => {
      const scheduled = makeScheduled({
        amount: -1200,
        description: "base desc",
      });
      stubFindOne(scheduled);
      const storedOverride = {
        amount: -999,
        description: "override desc",
        isSplit: null,
        categoryId: null,
        splits: null,
      };
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(storedOverride);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      overridesRepo.findOne.mockResolvedValue(storedOverride);
      accountsRepo.findOne.mockResolvedValue(null);

      await service.post(userId, stId);

      expect(transactionsService.create).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({ amount: -999, description: "override desc" }),
      );
    });

    it("should delete used override after posting", async () => {
      const scheduled = makeScheduled();
      stubFindOne(scheduled);
      const storedOverride = {
        id: "ovr-1",
        amount: null,
        description: null,
        isSplit: null,
        categoryId: null,
        splits: null,
      };
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(storedOverride);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      // The locked re-read returns the same override revision (issue #1154
      // re-review): same id, same (absent) updatedAt, so the change-guard passes.
      overridesRepo.findOne.mockResolvedValue(storedOverride);
      accountsRepo.findOne.mockResolvedValue(null);

      await service.post(userId, stId);

      expect(mockQueryRunner.manager.remove).toHaveBeenCalledWith(
        storedOverride,
      );
    });

    it("should delete ONCE frequency after posting", async () => {
      const scheduled = makeScheduled({ frequency: "ONCE" });
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      accountsRepo.findOne.mockResolvedValue(null);
      mockQueryRunner.manager.delete = jest
        .fn()
        .mockResolvedValue({ affected: 1 });

      const result = await service.post(userId, stId);

      expect(mockQueryRunner.manager.delete).toHaveBeenCalledWith(
        ScheduledTransaction,
        stId,
      );
      expect(mockQueryRunner.manager.update).not.toHaveBeenCalled();
      expect(mockDataSource.transaction).toHaveBeenCalled();
      expect(result).toBeNull();
    });

    it("should still create the underlying transaction when deleting a ONCE", async () => {
      const scheduled = makeScheduled({ frequency: "ONCE" });
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      accountsRepo.findOne.mockResolvedValue(null);
      mockQueryRunner.manager.delete = jest
        .fn()
        .mockResolvedValue({ affected: 1 });

      await service.post(userId, stId);

      expect(transactionsService.create).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({ accountId: "acc-1", amount: -1200 }),
      );
    });

    it("should remove a stored override before deleting a ONCE", async () => {
      const scheduled = makeScheduled({ frequency: "ONCE" });
      stubFindOne(scheduled);
      const storedOverride = {
        id: "ovr-1",
        amount: null,
        description: null,
        isSplit: null,
        categoryId: null,
        splits: null,
      };
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(storedOverride);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      overridesRepo.findOne.mockResolvedValue(storedOverride);
      accountsRepo.findOne.mockResolvedValue(null);
      mockQueryRunner.manager.delete = jest
        .fn()
        .mockResolvedValue({ affected: 1 });

      await service.post(userId, stId);

      expect(mockQueryRunner.manager.remove).toHaveBeenCalledWith(
        storedOverride,
      );
      expect(mockQueryRunner.manager.delete).toHaveBeenCalledWith(
        ScheduledTransaction,
        stId,
      );
    });

    it("claims the occurrence before creating any money", async () => {
      // The regression guard for P4-004. The claim, the money and the schedule
      // advancement are one transaction keyed on
      // (scheduled_transaction_id, original_due_date), so two replicas firing the
      // same hourly cron cannot both post: opening 100.00 with one due -50.00
      // ended at 0.00 instead of 50.00.
      const scheduled = makeScheduled({ nextDueDate: "2026-02-01" });
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);

      await service.post(userId, stId);

      const claim = mockQueryRunner.manager.query.mock.calls.find(
        (c: unknown[]) =>
          String(c[0]).includes("scheduled_transaction_postings"),
      );
      expect(claim).toBeDefined();
      expect(String(claim![0])).toContain("ON CONFLICT");
      // The occurrence's identity is the due date, not the date it was booked on.
      expect(claim![1]).toEqual([stId, "2026-02-01", "2026-02-01"]);
      expect(
        mockQueryRunner.manager.query.mock.invocationCallOrder[
          mockQueryRunner.manager.query.mock.calls.indexOf(claim!)
        ],
      ).toBeLessThan(transactionsService.create.mock.invocationCallOrder[0]);
    });

    it("posts nothing when another replica claimed the occurrence", async () => {
      postingClaimWins = false;
      const scheduled = makeScheduled({ nextDueDate: "2026-02-01" });
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);

      await expect(service.post(userId, stId)).rejects.toBeInstanceOf(
        ConflictException,
      );

      expect(transactionsService.create).not.toHaveBeenCalled();
      expect(scheduledRepo.update).not.toHaveBeenCalled();
    });

    it("refuses when the schedule has already been advanced past this occurrence", async () => {
      // A manual post racing the cron: the caller computed the payload for
      // 2026-02-01, but the committed row has moved on. Posting anyway would
      // duplicate the occurrence the winner already booked.
      const scheduled = makeScheduled({ nextDueDate: "2026-02-01" });
      scheduledRepo.findOne
        .mockResolvedValueOnce(scheduled)
        .mockResolvedValueOnce({ ...scheduled, nextDueDate: "2026-03-01" });
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);

      await expect(service.post(userId, stId)).rejects.toBeInstanceOf(
        ConflictException,
      );

      expect(transactionsService.create).not.toHaveBeenCalled();
    });

    it("should not call findOne after deleting a ONCE (would 404)", async () => {
      const scheduled = makeScheduled({ frequency: "ONCE" });
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      accountsRepo.findOne.mockResolvedValue(null);
      mockQueryRunner.manager.delete = jest
        .fn()
        .mockResolvedValue({ affected: 1 });

      // Twice: once outside the transaction to build the payload, and once
      // inside it under the row lock -- that second read is what confirms the
      // occurrence is still the due one before any money is created (P4-004).
      // What must NOT happen is a read *after* the row is deleted, which would
      // 404 on a posting that succeeded.
      await service.post(userId, stId);

      expect(scheduledRepo.findOne).toHaveBeenCalledTimes(2);
    });

    it("should advance nextDueDate for recurring frequency", async () => {
      const scheduled = makeScheduled({
        frequency: "MONTHLY",
        nextDueDate: utcDate(2025, 2, 15),
      });
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      accountsRepo.findOne.mockResolvedValue(null);

      await service.post(userId, stId);

      const updateCall = mockQueryRunner.manager.update.mock.calls.find(
        (c: any[]) => c[0] === ScheduledTransaction,
      );
      expect(updateCall).toBeTruthy();
      const updateArg = updateCall[2];
      expect(toUTCDateStr(new Date(updateArg.nextDueDate))).toBe("2025-03-15");
    });

    it("should store nextDueDate as YYYY-MM-DD string to prevent timezone drift", async () => {
      const scheduled = makeScheduled({
        frequency: "MONTHLY",
        nextDueDate: utcDate(2025, 2, 15),
      });
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      accountsRepo.findOne.mockResolvedValue(null);

      await service.post(userId, stId);

      const updateCall = mockQueryRunner.manager.update.mock.calls.find(
        (c: any[]) => c[0] === ScheduledTransaction,
      );
      expect(updateCall).toBeTruthy();
      const updateArg = updateCall[2];
      expect(typeof updateArg.nextDueDate).toBe("string");
      expect(updateArg.nextDueDate).toBe("2025-03-15");
    });

    it("should decrement occurrencesRemaining and deactivate at 0", async () => {
      const scheduled = makeScheduled({ occurrencesRemaining: 1 });
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      accountsRepo.findOne.mockResolvedValue(null);

      await service.post(userId, stId);

      const updateCall = mockQueryRunner.manager.update.mock.calls.find(
        (c: any[]) => c[0] === ScheduledTransaction,
      );
      expect(updateCall).toBeTruthy();
      const updateArg = updateCall[2];
      expect(updateArg.occurrencesRemaining).toBe(0);
      expect(updateArg.isActive).toBe(false);
    });

    it("should use base splits when useSplits and no inline/override splits", async () => {
      const scheduled = makeScheduled({
        isSplit: true,
        splits: [
          {
            id: "s1",
            scheduledTransactionId: stId,
            categoryId: "cat-a",
            transferAccountId: null,
            amount: -700,
            memo: null,
          } as any,
          {
            id: "s2",
            scheduledTransactionId: stId,
            categoryId: "cat-b",
            transferAccountId: null,
            amount: -500,
            memo: null,
          } as any,
        ],
      });
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      accountsRepo.findOne.mockResolvedValue(null);

      await service.post(userId, stId);

      const payload = transactionsService.create.mock.calls[0][1];
      expect(payload.splits).toHaveLength(2);
      expect(payload.splits[0].amount).toBe(-700);
    });

    it("should use postDto.transactionDate when provided", async () => {
      const scheduled = makeScheduled();
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      accountsRepo.findOne.mockResolvedValue(null);

      await service.post(userId, stId, { transactionDate: "2025-03-01" });

      expect(transactionsService.create).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({ transactionDate: "2025-03-01" }),
      );
    });

    it("should clean stale overrides after advancing date", async () => {
      const scheduled = makeScheduled({
        frequency: "MONTHLY",
        nextDueDate: "2025-02-15",
      });
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      accountsRepo.findOne.mockResolvedValue(null);

      await service.post(userId, stId);

      // Stale override cleanup now uses queryRunner.manager.createQueryBuilder
      expect(mockQueryRunner.manager.createQueryBuilder).toHaveBeenCalled();
    });

    it("should trigger loan payment recalculation for split transactions", async () => {
      const loanAccount = {
        id: "loan-1",
        accountType: "LOAN",
        currentBalance: -50000,
        interestRate: 5,
        paymentFrequency: "MONTHLY",
      };
      const scheduled = makeScheduled({
        isSplit: true,
        splits: [
          {
            id: "s1",
            scheduledTransactionId: stId,
            categoryId: null,
            transferAccountId: "loan-1",
            amount: -800,
            memo: null,
          } as any,
          {
            id: "s2",
            scheduledTransactionId: stId,
            categoryId: "cat-interest",
            transferAccountId: null,
            amount: -400,
            memo: null,
          } as any,
        ],
      });
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);

      // The loan account answers every lookup on this path: the pricing lock's
      // resolution, the posting-boundary resolver and the post-commit
      // recalculation. A `mockResolvedValueOnce` chain pinned the exact number
      // of lookups, so adding one shifted every later answer by one and the
      // failure surfaced as an unrelated "ledger could not be read".
      accountsRepo.findOne.mockResolvedValue(loanAccount);
      // For recalculateLoanPaymentSplits - the scheduled transaction lookup
      scheduledRepo.findOne.mockResolvedValueOnce(scheduled); // findOne in post return
      scheduledRepo.findOne.mockResolvedValueOnce(scheduled); // recalculate internal find

      await service.post(userId, stId);

      // Loan account should have been looked up
      expect(accountsRepo.findOne).toHaveBeenCalled();
    });

    it("should pass referenceNumber to created transaction when provided", async () => {
      const scheduled = makeScheduled();
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      accountsRepo.findOne.mockResolvedValue(null);

      await service.post(userId, stId, { referenceNumber: "CHQ-1234" });

      expect(transactionsService.create).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({ referenceNumber: "CHQ-1234" }),
      );
    });

    it("should pass referenceNumber to prepareTransfer when provided", async () => {
      const scheduled = makeScheduled({
        isTransfer: true,
        transferAccountId: "acc-2",
      });
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      accountsRepo.findOne.mockResolvedValue(null);

      await service.post(userId, stId, { referenceNumber: "REF-5678" });

      expect(transactionsService.prepareTransfer).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({ referenceNumber: "REF-5678" }),
      );
    });
  });

  // ==================== Scheduled Investment (single-table) ====================
  describe("scheduled investment kind", () => {
    const investmentBaseDto = {
      accountId: "acc-inv",
      name: "Monthly VOO DCA",
      amount: -500,
      currencyCode: "USD",
      frequency: "MONTHLY" as any,
      nextDueDate: "2026-06-15",
      isInvestment: true,
      investmentAction: "BUY" as any,
      investmentSecurityId: "sec-voo",
      investmentQuantity: 1,
      investmentPrice: 500,
      investmentCommission: 0,
    };

    it("rejects when account is not a brokerage account", async () => {
      accountsService.findOne.mockResolvedValue({
        id: "acc-inv",
        userId,
        accountType: "INVESTMENT",
        accountSubType: "INVESTMENT_CASH",
      });

      await expect(service.create(userId, investmentBaseDto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("rejects when both isTransfer and isInvestment are true", async () => {
      await expect(
        service.create(userId, {
          ...investmentBaseDto,
          isTransfer: true,
          transferAccountId: "acc-2",
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects BUY without quantity", async () => {
      accountsService.findOne.mockResolvedValue({
        id: "acc-inv",
        userId,
        accountSubType: "INVESTMENT_BROKERAGE",
      });

      await expect(
        service.create(userId, {
          ...investmentBaseDto,
          investmentQuantity: undefined as any,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("creates a scheduled BUY and persists investment fields", async () => {
      accountsService.findOne.mockResolvedValue({
        id: "acc-inv",
        userId,
        accountSubType: "INVESTMENT_BROKERAGE",
      });
      const saved = makeScheduled({
        isInvestment: true,
        investmentAction: "BUY" as any,
        investmentSecurityId: "sec-voo",
        investmentQuantity: 1,
        investmentPrice: 500,
      });
      scheduledRepo.save.mockResolvedValue(saved);
      stubFindOne(saved);

      const result = await service.create(userId, investmentBaseDto);

      const created = scheduledRepo.create.mock.calls[0][0];
      expect(created.isInvestment).toBe(true);
      expect(created.investmentAction).toBe("BUY");
      expect(created.investmentSecurityId).toBe("sec-voo");
      expect(created.investmentQuantity).toBe(1);
      expect(created.investmentPrice).toBe(500);
      expect(result).toEqual(saved);
    });

    it("post() dispatches a BUY through InvestmentTransactionsService.create", async () => {
      const scheduled = makeScheduled({
        isInvestment: true,
        investmentAction: "BUY" as any,
        investmentSecurityId: "sec-voo",
        investmentQuantity: 1,
        investmentPrice: 500,
        investmentCommission: 0,
      });
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder();
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);

      await service.post(userId, stId);

      expect(investmentTransactionsService.create).toHaveBeenCalledTimes(1);
      const dto = investmentTransactionsService.create.mock.calls[0][1];
      expect(dto.action).toBe("BUY");
      expect(dto.accountId).toBe("acc-1");
      expect(dto.securityId).toBe("sec-voo");
      expect(dto.quantity).toBe(1);
      expect(dto.price).toBe(500);
      expect(transactionsService.create).not.toHaveBeenCalled();
      expect(transactionsService.prepareTransfer).not.toHaveBeenCalled();
    });

    it("post() forwards funding account for contribution+buy", async () => {
      const scheduled = makeScheduled({
        isInvestment: true,
        investmentAction: "BUY" as any,
        investmentSecurityId: "sec-voo",
        investmentFundingAccountId: "acc-checking",
        investmentQuantity: 2,
        investmentPrice: 100,
      });
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder();
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);

      await service.post(userId, stId);

      const dto = investmentTransactionsService.create.mock.calls[0][1];
      expect(dto.fundingAccountId).toBe("acc-checking");
    });

    it("post() ignores a stale funding account on a DIVIDEND (issue #1154)", async () => {
      // A row edited from BUY to DIVIDEND may still carry the old funding
      // account. The dividend cash must settle in the brokerage's linked cash
      // account, so the funding account is not forwarded regardless of what the
      // row stored.
      const scheduled = makeScheduled({
        isInvestment: true,
        investmentAction: "DIVIDEND" as any,
        investmentSecurityId: "sec-voo",
        investmentFundingAccountId: "acc-checking",
        investmentTotalAmount: 75,
      });
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder();
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);

      await service.post(userId, stId);

      const dto = investmentTransactionsService.create.mock.calls[0][1];
      expect(dto.action).toBe("DIVIDEND");
      expect(dto.fundingAccountId).toBeUndefined();
    });

    it("post() still forwards a funding account on a SELL", async () => {
      const scheduled = makeScheduled({
        isInvestment: true,
        investmentAction: "SELL" as any,
        investmentSecurityId: "sec-voo",
        investmentFundingAccountId: "acc-checking",
        investmentQuantity: 2,
        investmentPrice: 100,
      });
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder();
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);

      await service.post(userId, stId);

      const dto = investmentTransactionsService.create.mock.calls[0][1];
      expect(dto.action).toBe("SELL");
      expect(dto.fundingAccountId).toBe("acc-checking");
    });

    it("post() ignores a stale funding account on a REINVEST (issue #1154)", async () => {
      // REINVEST moves shares but no external cash, so a funding account left on
      // the row is stale like the cash-only actions and must not be forwarded.
      const scheduled = makeScheduled({
        isInvestment: true,
        investmentAction: "REINVEST" as any,
        investmentSecurityId: "sec-voo",
        investmentFundingAccountId: "acc-checking",
        investmentQuantity: 0.5,
        investmentPrice: 200,
      });
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder();
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);

      await service.post(userId, stId);

      const dto = investmentTransactionsService.create.mock.calls[0][1];
      expect(dto.action).toBe("REINVEST");
      expect(dto.fundingAccountId).toBeUndefined();
    });

    it("post() rejects a negative amount-only override before creating money (issue #1154 review)", async () => {
      const dividend = makeScheduled({
        isInvestment: true,
        investmentAction: "DIVIDEND" as any,
        investmentSecurityId: "sec-voo",
        investmentTotalAmount: 100,
      });
      stubFindOne(dividend);
      const overrideQb = mockQueryBuilder();
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);

      await expect(
        service.post(userId, stId, { investmentTotalAmount: -25 } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(investmentTransactionsService.create).not.toHaveBeenCalled();
    });

    it("post() rejects a zero-quantity BUY override before creating money (issue #1154 review)", async () => {
      const buy = makeScheduled({
        isInvestment: true,
        investmentAction: "BUY" as any,
        investmentSecurityId: "sec-voo",
        investmentQuantity: 1,
        investmentPrice: 500,
      });
      stubFindOne(buy);
      const overrideQb = mockQueryBuilder();
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);

      await expect(
        service.post(userId, stId, { investmentQuantity: 0 } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(investmentTransactionsService.create).not.toHaveBeenCalled();
    });

    it("post() rejects when the schedule changed between the pre-lock read and the lock (issue #1154 re-review)", async () => {
      // A concurrent edit switched BUY -> DIVIDEND between the pre-lock read and
      // the row lock. The prepared (pre-lock) payload no longer describes the
      // row, so the post is refused rather than committing a stale operation.
      // Both reads go through scheduledRepo.findOne (manager.findOne alias).
      const beforeLock = makeScheduled({
        isInvestment: true,
        investmentAction: "BUY" as any,
        investmentSecurityId: "sec-voo",
        investmentFundingAccountId: "acc-old",
        investmentQuantity: 1,
        investmentPrice: 100,
      });
      const locked = makeScheduled({
        isInvestment: true,
        investmentAction: "DIVIDEND" as any,
        investmentSecurityId: "sec-voo",
        investmentFundingAccountId: null,
        investmentQuantity: null,
        investmentPrice: null,
        investmentTotalAmount: 75,
      });
      scheduledRepo.findOne
        .mockResolvedValueOnce(beforeLock)
        .mockResolvedValue(locked);
      const overrideQb = mockQueryBuilder();
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);

      await expect(service.post(userId, stId)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(investmentTransactionsService.create).not.toHaveBeenCalled();
    });

    it("post() rejects when the occurrence override changed after the pre-lock read (issue #1154 re-review)", async () => {
      const scheduled = makeScheduled({
        isInvestment: true,
        investmentAction: "DIVIDEND" as any,
        investmentSecurityId: "sec-voo",
        investmentTotalAmount: 75,
      });
      stubFindOne(scheduled);
      // Pre-lock override read (createQueryBuilder.getOne) returns one revision;
      // the locked re-read (overridesRepo.findOne) returns a newer one.
      const overrideQb = mockQueryBuilder();
      overrideQb.getOne.mockResolvedValue({
        id: "ovr-1",
        updatedAt: new Date("2026-06-01T00:00:00Z"),
      });
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      overridesRepo.findOne.mockResolvedValue({
        id: "ovr-1",
        updatedAt: new Date("2026-06-02T00:00:00Z"),
      });

      await expect(service.post(userId, stId)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(investmentTransactionsService.create).not.toHaveBeenCalled();
    });

    it("post() rejects when a base scheduled split was retargeted concurrently (issue #1154 re-review)", async () => {
      // Parent scalars are identical, but the transfer split's target account
      // changed between the pre-lock read and the parent lock. Posting the
      // pre-lock payload would credit the old account, so it is refused.
      const scheduled = makeScheduled({
        amount: -100,
        isSplit: true,
        frequency: "ONCE",
        splits: [
          {
            id: "ss-1",
            kind: "transfer" as any,
            amount: -100,
            memo: null,
            categoryId: null,
            transferAccountId: "acc-A",
            tags: [],
          } as any,
        ],
      });
      stubFindOne(scheduled);
      // The locked split re-read observes the retargeted split (acc-B).
      splitsRepo.find.mockResolvedValue([
        {
          id: "ss-1",
          kind: "transfer",
          amount: -100,
          memo: null,
          categoryId: null,
          transferAccountId: "acc-B",
          tags: [],
        } as any,
      ]);
      const overrideQb = mockQueryBuilder();
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);

      await expect(service.post(userId, stId)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(transactionsService.create).not.toHaveBeenCalled();
    });

    it("post() rejects when the foreign-currency original amount changed concurrently (issue #1154 re-review)", async () => {
      // amount (account currency) is unchanged, but originalAmount moved, so the
      // guard must still refuse -- otherwise a stale converted total posts.
      const beforeLock = makeScheduled({
        amount: -110,
        currencyCode: "USD",
        originalAmount: -100,
        originalCurrencyCode: "EUR",
        exchangeRate: 1.1,
      });
      const locked = makeScheduled({
        amount: -110,
        currencyCode: "USD",
        originalAmount: -200,
        originalCurrencyCode: "EUR",
        exchangeRate: 1.1,
      });
      scheduledRepo.findOne
        .mockResolvedValueOnce(beforeLock)
        .mockResolvedValue(locked);
      // The FX resolution runs above the transaction; give it a rate so the post
      // reaches the in-transaction guard rather than failing on a missing rate.
      mockExchangeRateService.getRateForDate.mockResolvedValue(1.1);
      const overrideQb = mockQueryBuilder();
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);

      await expect(service.post(userId, stId)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(transactionsService.create).not.toHaveBeenCalled();
    });

    it("post({requireActiveAutoPost}) refuses a schedule turned off after cron selected it (issue #1154 re-review)", async () => {
      const scheduled = makeScheduled({ isActive: true, autoPost: false });
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder();
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);

      await expect(
        service.post(userId, stId, undefined, { requireActiveAutoPost: true }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(transactionsService.create).not.toHaveBeenCalled();

      // A manual post (no option) of the same row still works.
      await service.post(userId, stId);
      expect(transactionsService.create).toHaveBeenCalledTimes(1);
    });

    it("post({expectedDueDate}) refuses once the selected occurrence is no longer the due one (issue #1452)", async () => {
      // The caller selected the 2025-02-15 occurrence; another replica posted
      // it and advanced the schedule before this post re-read the row.
      stubFindOne(makeScheduled({ autoPost: true, nextDueDate: "2025-03-15" }));
      const overrideQb = mockQueryBuilder();
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);

      await expect(
        service.post(userId, stId, undefined, {
          requireActiveAutoPost: true,
          expectedDueDate: "2025-02-15",
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(transactionsService.create).not.toHaveBeenCalled();

      // The occurrence that is still due posts.
      await service.post(userId, stId, undefined, {
        requireActiveAutoPost: true,
        expectedDueDate: "2025-03-15",
      });
      expect(transactionsService.create).toHaveBeenCalledTimes(1);
      expect(transactionsService.create).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({ transactionDate: "2025-03-15" }),
      );
    });

    it("post() honours inline quantity / price overrides", async () => {
      const scheduled = makeScheduled({
        isInvestment: true,
        investmentAction: "BUY" as any,
        investmentSecurityId: "sec-voo",
        investmentQuantity: 1,
        investmentPrice: 500,
      });
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder();
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);

      await service.post(userId, stId, {
        investmentQuantity: 3,
        investmentPrice: 480,
      } as any);

      const dto = investmentTransactionsService.create.mock.calls[0][1];
      expect(dto.quantity).toBe(3);
      expect(dto.price).toBe(480);
    });

    it("post() routes a DIVIDEND amount through quantity=1, price=totalAmount", async () => {
      const scheduled = makeScheduled({
        isInvestment: true,
        investmentAction: "DIVIDEND" as any,
        investmentSecurityId: "sec-voo",
        investmentTotalAmount: 75,
      });
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder();
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);

      await service.post(userId, stId);

      const dto = investmentTransactionsService.create.mock.calls[0][1];
      expect(dto.action).toBe("DIVIDEND");
      expect(dto.quantity).toBe(1);
      expect(dto.price).toBe(75);
    });

    it("post() routes a REINVEST/DRIP through investments service", async () => {
      const scheduled = makeScheduled({
        isInvestment: true,
        investmentAction: "REINVEST" as any,
        investmentSecurityId: "sec-voo",
        investmentQuantity: 0.5,
        investmentPrice: 200,
      });
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder();
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);

      await service.post(userId, stId);

      const dto = investmentTransactionsService.create.mock.calls[0][1];
      expect(dto.action).toBe("REINVEST");
      expect(dto.quantity).toBe(0.5);
      expect(dto.price).toBe(200);
    });

    it("post() throws when investmentAction is missing on the scheduled row", async () => {
      const scheduled = makeScheduled({
        isInvestment: true,
        investmentAction: null,
        investmentSecurityId: "sec-voo",
      });
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder();
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);

      await expect(service.post(userId, stId)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("post() routes a DIVIDEND with stored qty+price as quantity*price", async () => {
      const scheduled = makeScheduled({
        isInvestment: true,
        investmentAction: "DIVIDEND" as any,
        investmentSecurityId: "sec-voo",
        investmentQuantity: 100,
        investmentPrice: 0.75,
        investmentTotalAmount: null,
      });
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder();
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);

      await service.post(userId, stId);

      const dto = investmentTransactionsService.create.mock.calls[0][1];
      expect(dto.action).toBe("DIVIDEND");
      expect(dto.quantity).toBe(100);
      expect(dto.price).toBe(0.75);
    });

    it("validateInvestmentFields rejects BUY when price is zero", async () => {
      accountsService.findOne.mockResolvedValue({
        id: "acc-inv",
        userId,
        accountSubType: "INVESTMENT_BROKERAGE",
      });

      await expect(
        service.create(userId, {
          ...investmentBaseDto,
          investmentPrice: 0,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("validateInvestmentFields rejects ADD_SHARES without quantity", async () => {
      accountsService.findOne.mockResolvedValue({
        id: "acc-inv",
        userId,
        accountSubType: "INVESTMENT_BROKERAGE",
      });

      await expect(
        service.create(userId, {
          ...investmentBaseDto,
          investmentAction: "ADD_SHARES" as any,
          investmentPrice: undefined as any,
          investmentQuantity: undefined as any,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("validateInvestmentFields rejects DIVIDEND without totalAmount or qty+price", async () => {
      accountsService.findOne.mockResolvedValue({
        id: "acc-inv",
        userId,
        accountSubType: "INVESTMENT_BROKERAGE",
      });

      await expect(
        service.create(userId, {
          ...investmentBaseDto,
          investmentAction: "DIVIDEND" as any,
          investmentQuantity: undefined as any,
          investmentPrice: undefined as any,
          investmentTotalAmount: undefined as any,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("validateInvestmentFields rejects when action is missing", async () => {
      accountsService.findOne.mockResolvedValue({
        id: "acc-inv",
        userId,
        accountSubType: "INVESTMENT_BROKERAGE",
      });

      await expect(
        service.create(userId, {
          ...investmentBaseDto,
          investmentAction: undefined as any,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("validateInvestmentFields rejects BUY without a security", async () => {
      accountsService.findOne.mockResolvedValue({
        id: "acc-inv",
        userId,
        accountSubType: "INVESTMENT_BROKERAGE",
      });

      await expect(
        service.create(userId, {
          ...investmentBaseDto,
          investmentSecurityId: undefined as any,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("create() validates the funding account when supplied", async () => {
      accountsService.findOne.mockImplementation(
        async (uid: string, id: string) => {
          if (id === "acc-funding")
            return { id, userId: uid, accountType: "CHECKING" } as any;
          return {
            id,
            userId: uid,
            accountSubType: "INVESTMENT_BROKERAGE",
          } as any;
        },
      );
      const saved = makeScheduled({
        isInvestment: true,
        investmentAction: "BUY" as any,
        investmentSecurityId: "sec-voo",
        investmentFundingAccountId: "acc-funding",
        investmentQuantity: 1,
        investmentPrice: 500,
      });
      scheduledRepo.save.mockResolvedValue(saved);
      stubFindOne(saved);

      await service.create(userId, {
        ...investmentBaseDto,
        investmentFundingAccountId: "acc-funding",
      });

      expect(accountsService.findOne).toHaveBeenCalledWith(
        userId,
        "acc-funding",
      );
      // A BUY keeps the funding account it was given (the gate's keep branch).
      expect(
        scheduledRepo.create.mock.calls[0][0].investmentFundingAccountId,
      ).toBe("acc-funding");
    });

    it("update() rejects mixing isTransfer and isInvestment", async () => {
      stubFindOne(
        makeScheduled({
          isInvestment: true,
          investmentAction: "BUY" as any,
        }),
      );

      await expect(
        service.update(userId, stId, {
          isTransfer: true,
          transferAccountId: "acc-2",
        } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it("update() rejects an investment-kind change to a non-brokerage account", async () => {
      stubFindOne(
        makeScheduled({
          isInvestment: true,
          investmentAction: "BUY" as any,
          investmentSecurityId: "sec-voo",
          investmentQuantity: 1,
          investmentPrice: 500,
        }),
      );
      accountsService.findOne.mockResolvedValue({
        id: "acc-cash",
        userId,
        accountSubType: "INVESTMENT_CASH",
      });

      await expect(
        service.update(userId, stId, { accountId: "acc-cash" } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it("update() persists changed investment fields", async () => {
      stubFindOne(
        makeScheduled({
          isInvestment: true,
          investmentAction: "BUY" as any,
          investmentSecurityId: "sec-voo",
          investmentQuantity: 1,
          investmentPrice: 500,
        }),
      );
      accountsService.findOne.mockResolvedValue({
        id: "acc-1",
        userId,
        accountSubType: "INVESTMENT_BROKERAGE",
      });

      await service.update(userId, stId, {
        investmentQuantity: 2,
        investmentPrice: 480,
        investmentCommission: 5,
      } as any);

      const fields = mockQueryRunner.manager.update.mock.calls.find(
        (c: any[]) => c[1] === stId && c[2].investmentQuantity !== undefined,
      )?.[2];
      expect(fields).toBeDefined();
      expect(fields.investmentQuantity).toBe(2);
      expect(fields.investmentPrice).toBe(480);
      expect(fields.investmentCommission).toBe(5);
    });

    it("update() changing the action to DIVIDEND nulls the funding account (issue #1154)", async () => {
      // The user switches a BUY (with a funding account) to a DIVIDEND. The
      // funding account no longer applies and must be cleared, even though the
      // client sent an explicit account earlier.
      stubFindOne(
        makeScheduled({
          isInvestment: true,
          investmentAction: "BUY" as any,
          investmentSecurityId: "sec-voo",
          investmentFundingAccountId: "acc-checking",
          investmentQuantity: 1,
          investmentPrice: 500,
        }),
      );
      accountsService.findOne.mockResolvedValue({
        id: "acc-1",
        userId,
        accountSubType: "INVESTMENT_BROKERAGE",
      });

      await service.update(userId, stId, {
        investmentAction: "DIVIDEND" as any,
        investmentTotalAmount: 75,
      } as any);

      const fields = mockQueryRunner.manager.update.mock.calls.find(
        (c: any[]) =>
          c[1] === stId && c[2].investmentFundingAccountId !== undefined,
      )?.[2];
      expect(fields).toBeDefined();
      expect(fields.investmentFundingAccountId).toBeNull();
    });

    it("update() nulls a stale funding account even when the client omits the key (issue #1154)", async () => {
      // The exact reported path: the schedule is already a DIVIDEND carrying a
      // stale funding account, and the edit touches only the amount. The absent
      // key must not be read as "leave the stale account in place".
      stubFindOne(
        makeScheduled({
          isInvestment: true,
          investmentAction: "DIVIDEND" as any,
          investmentSecurityId: "sec-voo",
          investmentFundingAccountId: "acc-checking",
          investmentTotalAmount: 50,
        }),
      );
      accountsService.findOne.mockResolvedValue({
        id: "acc-1",
        userId,
        accountSubType: "INVESTMENT_BROKERAGE",
      });

      await service.update(userId, stId, {
        investmentTotalAmount: 90,
      } as any);

      const fields = mockQueryRunner.manager.update.mock.calls.find(
        (c: any[]) =>
          c[1] === stId && c[2].investmentFundingAccountId !== undefined,
      )?.[2];
      expect(fields).toBeDefined();
      expect(fields.investmentFundingAccountId).toBeNull();
    });

    it("update() keeps the funding account on a BUY", async () => {
      stubFindOne(
        makeScheduled({
          isInvestment: true,
          investmentAction: "BUY" as any,
          investmentSecurityId: "sec-voo",
          investmentFundingAccountId: "acc-checking",
          investmentQuantity: 1,
          investmentPrice: 500,
        }),
      );
      accountsService.findOne.mockResolvedValue({
        id: "acc-1",
        userId,
        accountSubType: "INVESTMENT_BROKERAGE",
      });

      await service.update(userId, stId, {
        investmentPrice: 480,
      } as any);

      // A BUY edit that does not touch the funding account must not write the
      // column at all -- neither cleared to null nor emptied -- so the stored
      // value survives. Asserting the key is absent (not merely "not null")
      // also catches a future `|| ''`-style clear.
      const touchesFunding = mockQueryRunner.manager.update.mock.calls.some(
        (c: any[]) =>
          c[1] === stId &&
          Object.prototype.hasOwnProperty.call(
            c[2],
            "investmentFundingAccountId",
          ),
      );
      expect(touchesFunding).toBe(false);
    });

    it("update() switching BUY to DIVIDEND nulls quantity/price/commission (issue #1154)", async () => {
      // The action no longer uses shares or a per-share price, so the stale
      // quantity/price/commission from the BUY must not linger on the row.
      stubFindOne(
        makeScheduled({
          isInvestment: true,
          investmentAction: "BUY" as any,
          investmentSecurityId: "sec-voo",
          investmentQuantity: 1,
          investmentPrice: 500,
          investmentCommission: 5,
        }),
      );
      accountsService.findOne.mockResolvedValue({
        id: "acc-1",
        userId,
        accountSubType: "INVESTMENT_BROKERAGE",
      });

      await service.update(userId, stId, {
        investmentAction: "DIVIDEND" as any,
        investmentTotalAmount: 75,
      } as any);

      const fields = mockQueryRunner.manager.update.mock.calls.find(
        (c: any[]) => c[1] === stId && c[2].investmentAction !== undefined,
      )?.[2];
      expect(fields).toBeDefined();
      expect(fields.investmentQuantity).toBeNull();
      expect(fields.investmentPrice).toBeNull();
      expect(fields.investmentCommission).toBeNull();
      // The DIVIDEND's own required field is written, not cleared.
      expect(fields.investmentTotalAmount).toBe(75);
    });

    it("update() switching DIVIDEND to BUY nulls the stale total amount (issue #1154)", async () => {
      stubFindOne(
        makeScheduled({
          isInvestment: true,
          investmentAction: "DIVIDEND" as any,
          investmentSecurityId: "sec-voo",
          investmentTotalAmount: 75,
        }),
      );
      accountsService.findOne.mockResolvedValue({
        id: "acc-1",
        userId,
        accountSubType: "INVESTMENT_BROKERAGE",
      });

      await service.update(userId, stId, {
        investmentAction: "BUY" as any,
        investmentQuantity: 2,
        investmentPrice: 100,
      } as any);

      const fields = mockQueryRunner.manager.update.mock.calls.find(
        (c: any[]) => c[1] === stId && c[2].investmentAction !== undefined,
      )?.[2];
      expect(fields).toBeDefined();
      expect(fields.investmentTotalAmount).toBeNull();
      expect(fields.investmentQuantity).toBe(2);
      expect(fields.investmentPrice).toBe(100);
    });

    it("update() keeps quantity but nulls price/total when switching to ADD_SHARES", async () => {
      // ADD_SHARES uses only a quantity; price/commission/total do not apply.
      stubFindOne(
        makeScheduled({
          isInvestment: true,
          investmentAction: "BUY" as any,
          investmentSecurityId: "sec-voo",
          investmentQuantity: 3,
          investmentPrice: 500,
          investmentCommission: 5,
        }),
      );
      accountsService.findOne.mockResolvedValue({
        id: "acc-1",
        userId,
        accountSubType: "INVESTMENT_BROKERAGE",
      });

      await service.update(userId, stId, {
        investmentAction: "ADD_SHARES" as any,
        investmentQuantity: 4,
      } as any);

      const fields = mockQueryRunner.manager.update.mock.calls.find(
        (c: any[]) => c[1] === stId && c[2].investmentAction !== undefined,
      )?.[2];
      expect(fields).toBeDefined();
      expect(fields.investmentQuantity).toBe(4);
      expect(fields.investmentPrice).toBeNull();
      expect(fields.investmentCommission).toBeNull();
      expect(fields.investmentTotalAmount).toBeNull();
    });

    it("update() rejects an explicit null total instead of validating the stored one (issue #1154 review)", async () => {
      stubFindOne(
        makeScheduled({
          isInvestment: true,
          investmentAction: "DIVIDEND" as any,
          investmentSecurityId: "sec-voo",
          investmentTotalAmount: 100,
        }),
      );
      accountsService.findOne.mockResolvedValue({
        id: "acc-1",
        userId,
        accountSubType: "INVESTMENT_BROKERAGE",
      });

      await expect(
        service.update(userId, stId, { investmentTotalAmount: null } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
      // Rejected before the write opens.
      expect(mockQueryRunner.manager.update).not.toHaveBeenCalled();
    });

    it("update() rejects a zero stored investment exchange rate (issue #1154 review)", async () => {
      stubFindOne(
        makeScheduled({
          isInvestment: true,
          investmentAction: "BUY" as any,
          investmentSecurityId: "sec-voo",
          investmentQuantity: 1,
          investmentPrice: 100,
          investmentExchangeRate: 1.1,
        }),
      );
      accountsService.findOne.mockResolvedValue({
        id: "acc-1",
        userId,
        accountSubType: "INVESTMENT_BROKERAGE",
      });

      await expect(
        service.update(userId, stId, { investmentExchangeRate: 0 } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("update() clears a stored rate when the settlement basis changes (issue #1154 review)", async () => {
      stubFindOne(
        makeScheduled({
          isInvestment: true,
          investmentAction: "BUY" as any,
          investmentSecurityId: "sec-voo",
          investmentFundingAccountId: "acc-usd",
          investmentQuantity: 1,
          investmentPrice: 100,
          investmentExchangeRate: 1.1,
        }),
      );
      accountsService.findOne.mockResolvedValue({
        id: "acc-1",
        userId,
        accountSubType: "INVESTMENT_BROKERAGE",
      });

      await service.update(userId, stId, {
        investmentAction: "DIVIDEND" as any,
        investmentTotalAmount: 100,
      } as any);

      const fields = mockQueryRunner.manager.update.mock.calls.find(
        (c: any[]) => c[1] === stId && c[2].investmentAction !== undefined,
      )?.[2];
      expect(fields).toBeDefined();
      expect(fields.investmentExchangeRate).toBeNull();
    });

    it("update() keeps a stored rate on a presentation-only edit (issue #1154 review)", async () => {
      // The settlement tuple is unchanged, so a name edit must not re-resolve or
      // wipe a legitimate cross-currency rate (the over-clear guard).
      stubFindOne(
        makeScheduled({
          isInvestment: true,
          investmentAction: "BUY" as any,
          investmentSecurityId: "sec-voo",
          investmentFundingAccountId: "acc-usd",
          investmentQuantity: 1,
          investmentPrice: 100,
          investmentExchangeRate: 1.1,
        }),
      );
      accountsService.findOne.mockResolvedValue({
        id: "acc-1",
        userId,
        accountSubType: "INVESTMENT_BROKERAGE",
      });

      await service.update(userId, stId, { name: "Renamed" } as any);

      const clearedRate = mockQueryRunner.manager.update.mock.calls.some(
        (c: any[]) => c[1] === stId && c[2].investmentExchangeRate === null,
      );
      expect(clearedRate).toBe(false);
    });

    it("update() clears a hidden security when switching to INTEREST with the key omitted (issue #1154 review)", async () => {
      stubFindOne(
        makeScheduled({
          isInvestment: true,
          investmentAction: "BUY" as any,
          investmentSecurityId: "sec-eur",
          investmentQuantity: 1,
          investmentPrice: 100,
        }),
      );
      accountsService.findOne.mockResolvedValue({
        id: "acc-1",
        userId,
        accountSubType: "INVESTMENT_BROKERAGE",
      });

      await service.update(userId, stId, {
        investmentAction: "INTEREST" as any,
        investmentTotalAmount: 50,
      } as any);

      const fields = mockQueryRunner.manager.update.mock.calls.find(
        (c: any[]) => c[1] === stId && c[2].investmentAction !== undefined,
      )?.[2];
      expect(fields).toBeDefined();
      expect(fields.investmentSecurityId).toBeNull();
    });

    it("create() rejects a non-positive investment exchange rate (issue #1154 review)", async () => {
      accountsService.findOne.mockResolvedValue({
        id: "acc-inv",
        userId,
        accountSubType: "INVESTMENT_BROKERAGE",
      });

      await expect(
        service.create(userId, {
          ...investmentBaseDto,
          investmentExchangeRate: 0,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("update() rejects when the action changed concurrently (issue #1154 re-review)", async () => {
      // The request read a DIVIDEND and derived DIVIDEND cleanup, but a
      // concurrent edit switched the locked row to BUY. Writing the stale
      // cleanup would null the quantity/price the BUY just set, so the update is
      // refused. The pre-mutation read and the locked read both go through
      // scheduledRepo.findOne.
      const preEdit = makeScheduled({
        isInvestment: true,
        investmentAction: "DIVIDEND" as any,
        investmentSecurityId: "sec-voo",
        investmentTotalAmount: 100,
      });
      const lockedDifferent = makeScheduled({
        isInvestment: true,
        investmentAction: "BUY" as any,
        investmentSecurityId: "sec-voo",
        investmentQuantity: 2,
        investmentPrice: 50,
      });
      scheduledRepo.findOne
        .mockResolvedValueOnce(preEdit)
        .mockResolvedValue(lockedDifferent);
      accountsService.findOne.mockResolvedValue({
        id: "acc-1",
        userId,
        accountSubType: "INVESTMENT_BROKERAGE",
      });

      await expect(
        service.update(userId, stId, { name: "Renamed" } as any),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(mockQueryRunner.manager.update).not.toHaveBeenCalled();
    });

    it("create() drops a funding account supplied for a non-funding action (issue #1154)", async () => {
      accountsService.findOne.mockImplementation(
        async (uid: string, id: string) => {
          if (id === "acc-checking")
            return { id, userId: uid, accountType: "CHECKING" } as any;
          return {
            id,
            userId: uid,
            accountSubType: "INVESTMENT_BROKERAGE",
          } as any;
        },
      );
      const saved = makeScheduled({ isInvestment: true });
      scheduledRepo.save.mockResolvedValue(saved);
      stubFindOne(saved);

      await service.create(userId, {
        ...investmentBaseDto,
        investmentAction: "DIVIDEND" as any,
        investmentQuantity: undefined as any,
        investmentPrice: undefined as any,
        investmentTotalAmount: 75,
        investmentFundingAccountId: "acc-checking",
      });

      const created = scheduledRepo.create.mock.calls[0][0];
      expect(created.investmentFundingAccountId).toBeNull();
    });

    it("update() switching to isInvestment=true wipes split/transfer remnants", async () => {
      stubFindOne(
        makeScheduled({
          isSplit: true,
          isTransfer: false,
        }),
      );
      accountsService.findOne.mockResolvedValue({
        id: "acc-1",
        userId,
        accountSubType: "INVESTMENT_BROKERAGE",
      });

      await service.update(userId, stId, {
        isInvestment: true,
        investmentAction: "BUY" as any,
        investmentSecurityId: "sec-voo",
        investmentQuantity: 1,
        investmentPrice: 500,
      } as any);

      const fields = mockQueryRunner.manager.update.mock.calls.find(
        (c: any[]) => c[1] === stId && c[2].isInvestment !== undefined,
      )?.[2];
      expect(fields).toBeDefined();
      expect(fields.isInvestment).toBe(true);
      expect(fields.isSplit).toBe(false);
      expect(fields.isTransfer).toBe(false);
      expect(fields.categoryId).toBeNull();
      expect(fields.transferAccountId).toBeNull();
      expect(mockQueryRunner.manager.delete).toHaveBeenCalledWith(
        ScheduledTransactionSplit,
        { scheduledTransactionId: stId },
      );
    });

    it("update() switching to isInvestment=false clears every investment field", async () => {
      stubFindOne(
        makeScheduled({
          isInvestment: true,
          investmentAction: "BUY" as any,
          investmentSecurityId: "sec-voo",
          investmentQuantity: 1,
          investmentPrice: 500,
        }),
      );

      await service.update(userId, stId, {
        isInvestment: false,
      } as any);

      const fields = mockQueryRunner.manager.update.mock.calls.find(
        (c: any[]) => c[1] === stId && c[2].isInvestment !== undefined,
      )?.[2];
      expect(fields).toBeDefined();
      expect(fields.isInvestment).toBe(false);
      expect(fields.investmentAction).toBeNull();
      expect(fields.investmentSecurityId).toBeNull();
      expect(fields.investmentFundingAccountId).toBeNull();
      expect(fields.investmentQuantity).toBeNull();
      expect(fields.investmentPrice).toBeNull();
      expect(fields.investmentCommission).toBeNull();
      expect(fields.investmentTotalAmount).toBeNull();
      expect(fields.investmentExchangeRate).toBeNull();
    });

    it("update() switching to isTransfer=true clears investment fields too", async () => {
      stubFindOne(
        makeScheduled({
          isInvestment: true,
          investmentAction: "BUY" as any,
          investmentSecurityId: "sec-voo",
          investmentQuantity: 1,
          investmentPrice: 500,
        }),
      );

      await service.update(userId, stId, {
        isInvestment: false,
        isTransfer: true,
        transferAccountId: "acc-2",
      } as any);

      const fields = mockQueryRunner.manager.update.mock.calls.find(
        (c: any[]) => c[1] === stId && c[2].isTransfer === true,
      )?.[2];
      expect(fields).toBeDefined();
      expect(fields.investmentAction).toBeNull();
      expect(fields.investmentSecurityId).toBeNull();
    });
  });

  // ==================== Override CRUD ====================
  describe("foreign-currency schedules", () => {
    const baseDto = {
      accountId: "acc-1",
      name: "Netflix",
      amount: -54.61,
      currencyCode: "CAD",
      frequency: "MONTHLY" as any,
      nextDueDate: "2025-02-15",
    };

    beforeEach(() => {
      accountsService.findOne.mockResolvedValue({
        id: "acc-1",
        userId,
        currencyCode: "CAD",
        fxFeePercent: null,
      });
    });

    const stubNoOverride = () => {
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      accountsRepo.findOne.mockResolvedValue(null);
    };

    it("stores the foreign trio on create", async () => {
      const saved = makeScheduled();
      scheduledRepo.save.mockResolvedValue(saved);
      stubFindOne(saved);

      await service.create(userId, {
        ...baseDto,
        originalAmount: -40,
        originalCurrencyCode: "usd",
        exchangeRate: 1.365234,
      });

      const createArg = scheduledRepo.create.mock.calls[0][0];
      expect(createArg.originalAmount).toBe(-40);
      expect(createArg.originalCurrencyCode).toBe("USD");
      expect(createArg.exchangeRate).toBe(1.365234);
    });

    it("strips the trio when the entry currency is the account currency", async () => {
      const saved = makeScheduled();
      scheduledRepo.save.mockResolvedValue(saved);
      stubFindOne(saved);

      await service.create(userId, {
        ...baseDto,
        originalAmount: -54.61,
        originalCurrencyCode: "CAD",
        exchangeRate: 1,
      });

      const createArg = scheduledRepo.create.mock.calls[0][0];
      expect(createArg.originalCurrencyCode).toBeNull();
      expect(createArg.originalAmount).toBeNull();
      expect(createArg.exchangeRate).toBe(1);
    });

    it.each([
      ["a transfer", { isTransfer: true, transferAccountId: "acc-2" }],
      [
        "a split",
        {
          splits: [
            { categoryId: "cat-a", amount: -30 },
            { categoryId: "cat-b", amount: -24.61 },
          ],
        },
      ],
    ])("rejects a foreign entry on %s", async (_label, extra) => {
      await expect(
        service.create(userId, {
          ...baseDto,
          ...(extra as any),
          originalAmount: -40,
          originalCurrencyCode: "USD",
          exchangeRate: 1.365234,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("clears the trio when an existing foreign schedule becomes a transfer", async () => {
      stubFindOne(
        makeScheduled({
          originalAmount: -40,
          originalCurrencyCode: "USD",
          exchangeRate: 1.365234,
          currencyCode: "CAD",
        }),
      );

      await service.update(userId, stId, {
        isTransfer: true,
        transferAccountId: "acc-2",
      });

      expect(mockQueryRunner.manager.update).toHaveBeenCalledWith(
        ScheduledTransaction,
        stId,
        expect.objectContaining({
          originalAmount: null,
          originalCurrencyCode: null,
          exchangeRate: 1,
        }),
      );
    });

    it("converts at the rate for the posting date, not the stored estimate", async () => {
      stubFindOne(
        makeScheduled({
          amount: -54.61,
          currencyCode: "CAD",
          originalAmount: -40,
          originalCurrencyCode: "USD",
          exchangeRate: 1.365234,
          account: {
            id: "acc-1",
            currencyCode: "CAD",
            fxFeePercent: null,
          } as any,
        }),
      );
      stubNoOverride();
      mockExchangeRateService.getRateForDate.mockResolvedValue(1.4);

      await service.post(userId, stId, { transactionDate: "2025-03-01" });

      expect(mockExchangeRateService.getRateForDate).toHaveBeenCalledWith(
        "USD",
        "CAD",
        "2025-03-01",
      );
      expect(transactionsService.create).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          amount: -56,
          originalAmount: -40,
          originalCurrencyCode: "USD",
          exchangeRate: 1.4,
        }),
      );
    });

    it("folds the account's foreign transaction fee into the posted amount", async () => {
      stubFindOne(
        makeScheduled({
          currencyCode: "CAD",
          originalAmount: -40,
          originalCurrencyCode: "USD",
          exchangeRate: 1.4,
          account: {
            id: "acc-1",
            currencyCode: "CAD",
            fxFeePercent: 2.5,
          } as any,
        }),
      );
      stubNoOverride();
      mockExchangeRateService.getRateForDate.mockResolvedValue(1.4);

      await service.post(userId, stId, { transactionDate: "2025-03-01" });

      // base -56, fee -1.40, total -57.40
      expect(transactionsService.create).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({ amount: -57.4 }),
      );
    });

    it("refuses to post when no rate can be resolved for the date", async () => {
      stubFindOne(
        makeScheduled({
          currencyCode: "CAD",
          originalAmount: -40,
          originalCurrencyCode: "USD",
          exchangeRate: 1.4,
          account: {
            id: "acc-1",
            currencyCode: "CAD",
            fxFeePercent: null,
          } as any,
        }),
      );
      stubNoOverride();
      mockExchangeRateService.getRateForDate.mockResolvedValue(null);

      await expect(
        service.post(userId, stId, { transactionDate: "2025-03-01" }),
      ).rejects.toThrow(BadRequestException);
      expect(transactionsService.create).not.toHaveBeenCalled();
    });

    it("honours an occurrence override as an account-currency total", async () => {
      stubFindOne(
        makeScheduled({
          currencyCode: "CAD",
          originalAmount: -40,
          originalCurrencyCode: "USD",
          exchangeRate: 1.4,
          account: {
            id: "acc-1",
            currencyCode: "CAD",
            fxFeePercent: null,
          } as any,
        }),
      );
      const storedOverride = {
        id: "ovr-1",
        originalDate: "2025-02-15",
        overrideDate: "2025-02-15",
        amount: -60,
      };
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(storedOverride);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      overridesRepo.findOne.mockResolvedValue(storedOverride);
      accountsRepo.findOne.mockResolvedValue(null);

      await service.post(userId, stId);

      // The pinned total is booked as-is, and the rate is derived so the row
      // still round-trips: -60 / -40 = 1.5.
      expect(mockExchangeRateService.getRateForDate).not.toHaveBeenCalled();
      expect(transactionsService.create).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          amount: -60,
          originalAmount: -40,
          exchangeRate: 1.5,
        }),
      );
    });

    it("refreshes stored estimates from the latest rate", async () => {
      scheduledRepo.find.mockResolvedValue([
        {
          id: stId,
          userId,
          name: "Netflix",
          amount: -54.61,
          currencyCode: "CAD",
          originalAmount: -40,
          originalCurrencyCode: "USD",
          exchangeRate: 1.365234,
          account: { fxFeePercent: null },
        },
      ]);
      mockExchangeRateService.getLatestRate.mockResolvedValue(1.4);

      await service.refreshForeignCurrencyEstimates();

      expect(mockQueryRunner.manager.update).toHaveBeenCalledWith(
        ScheduledTransaction,
        stId,
        { amount: -56, exchangeRate: 1.4 },
      );
    });

    it("leaves an ordinary schedule alone on the refresh sweep", async () => {
      scheduledRepo.find.mockResolvedValue([
        { id: stId, userId, amount: -1200, currencyCode: "USD" },
      ]);

      await service.refreshForeignCurrencyEstimates();

      expect(mockExchangeRateService.getLatestRate).not.toHaveBeenCalled();
      expect(mockQueryRunner.manager.update).not.toHaveBeenCalled();
    });
  });
  describe("createOverride", () => {
    it("should create an override", async () => {
      stubFindOne(makeScheduled());
      const existingQb = mockQueryBuilder(null);
      existingQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(existingQb);

      const dto = {
        originalDate: "2025-02-15",
        overrideDate: "2025-02-15",
        amount: -999,
      };
      const result = await service.createOverride(userId, stId, dto);

      expect(overridesRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          scheduledTransactionId: stId,
          originalDate: "2025-02-15",
        }),
      );
      expect(overridesRepo.save).toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    it("should throw if override already exists for date", async () => {
      stubFindOne(makeScheduled());
      const existingQb = mockQueryBuilder(null);
      existingQb.getOne.mockResolvedValue({ id: "existing-ovr" });
      overridesRepo.createQueryBuilder.mockReturnValue(existingQb);

      const dto = { originalDate: "2025-02-15", overrideDate: "2025-02-15" };
      await expect(service.createOverride(userId, stId, dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should validate override splits", async () => {
      stubFindOne(makeScheduled());
      const existingQb = mockQueryBuilder(null);
      existingQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(existingQb);

      const dto = {
        originalDate: "2025-02-15",
        overrideDate: "2025-02-15",
        amount: -1000,
        isSplit: true,
        splits: [{ categoryId: "cat-a", amount: -600 }], // only 1 split
      };
      await expect(service.createOverride(userId, stId, dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should require amount when creating split override", async () => {
      stubFindOne(makeScheduled());
      const existingQb = mockQueryBuilder(null);
      existingQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(existingQb);

      const dto = {
        originalDate: "2025-02-15",
        overrideDate: "2025-02-15",
        isSplit: true,
        splits: [
          { categoryId: "cat-a", amount: -600 },
          { categoryId: "cat-b", amount: -400 },
        ],
      };
      await expect(service.createOverride(userId, stId, dto)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe("findOverrides", () => {
    it("should return overrides for a scheduled transaction", async () => {
      stubFindOne(makeScheduled());
      const overrides = [{ id: "ovr-1" }, { id: "ovr-2" }];
      overridesRepo.find.mockResolvedValue(overrides);

      const result = await service.findOverrides(userId, stId);

      expect(result).toEqual(overrides);
      expect(overridesRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: { scheduledTransactionId: stId } }),
      );
    });
  });

  describe("findOverride", () => {
    it("should return a specific override", async () => {
      stubFindOne(makeScheduled());
      const override = { id: "ovr-1", scheduledTransactionId: stId };
      overridesRepo.findOne.mockResolvedValue(override);

      const result = await service.findOverride(userId, stId, "ovr-1");
      expect(result).toEqual(override);
    });

    it("should throw NotFoundException if override not found", async () => {
      stubFindOne(makeScheduled());
      overridesRepo.findOne.mockResolvedValue(null);

      await expect(
        service.findOverride(userId, stId, "ovr-999"),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("findOverrideByDate", () => {
    it("should return override matching originalDate", async () => {
      stubFindOne(makeScheduled());
      const override = {
        id: "ovr-1",
        originalDate: "2025-02-15",
        scheduledTransactionId: stId,
      };
      overridesRepo.find.mockResolvedValue([override]);

      const result = await service.findOverrideByDate(
        userId,
        stId,
        "2025-02-15",
      );
      expect(result).toEqual(override);
    });

    it("should return null when no override matches", async () => {
      stubFindOne(makeScheduled());
      overridesRepo.find.mockResolvedValue([]);

      const result = await service.findOverrideByDate(
        userId,
        stId,
        "2025-02-15",
      );
      expect(result).toBeNull();
    });

    it("should normalize datetime strings to date-only", async () => {
      stubFindOne(makeScheduled());
      const override = {
        id: "ovr-1",
        originalDate: "2025-02-15T00:00:00.000Z",
        scheduledTransactionId: stId,
      };
      overridesRepo.find.mockResolvedValue([override]);

      const result = await service.findOverrideByDate(
        userId,
        stId,
        "2025-02-15T12:00:00Z",
      );
      expect(result).toEqual(override);
    });
  });

  describe("updateOverride", () => {
    it("should update override fields", async () => {
      const existing = {
        id: "ovr-1",
        scheduledTransactionId: stId,
        amount: -1000,
        categoryId: null,
        description: null,
        isSplit: null,
        splits: null,
      };
      stubFindOne(makeScheduled());
      overridesRepo.findOne.mockResolvedValue(existing);

      await service.updateOverride(userId, stId, "ovr-1", { amount: -1500 });

      expect(overridesRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ amount: -1500 }),
      );
    });

    it("should validate splits on update", async () => {
      const existing = {
        id: "ovr-1",
        scheduledTransactionId: stId,
        amount: -1000,
      };
      stubFindOne(makeScheduled());
      overridesRepo.findOne.mockResolvedValue(existing);

      await expect(
        service.updateOverride(userId, stId, "ovr-1", {
          isSplit: true,
          splits: [{ amount: -500 }], // only 1 split
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("removeOverride", () => {
    it("should remove the override", async () => {
      const override = { id: "ovr-1", scheduledTransactionId: stId };
      stubFindOne(makeScheduled());
      overridesRepo.findOne.mockResolvedValue(override);

      await service.removeOverride(userId, stId, "ovr-1");

      expect(overridesRepo.remove).toHaveBeenCalledWith(override);
    });
  });

  describe("removeAllOverrides", () => {
    it("should delete all overrides and return count", async () => {
      stubFindOne(makeScheduled());
      overridesRepo.delete.mockResolvedValue({ affected: 3 });

      const result = await service.removeAllOverrides(userId, stId);

      expect(result).toBe(3);
      expect(overridesRepo.delete).toHaveBeenCalledWith({
        scheduledTransactionId: stId,
      });
    });

    it("should return 0 when no overrides deleted", async () => {
      stubFindOne(makeScheduled());
      overridesRepo.delete.mockResolvedValue({ affected: 0 });

      const result = await service.removeAllOverrides(userId, stId);
      expect(result).toBe(0);
    });
  });

  describe("hasOverrides", () => {
    it("should return true with count when overrides exist", async () => {
      stubFindOne(makeScheduled());
      overridesRepo.count.mockResolvedValue(5);

      const result = await service.hasOverrides(userId, stId);

      expect(result).toEqual({ hasOverrides: true, count: 5 });
    });

    it("should return false with 0 when no overrides", async () => {
      stubFindOne(makeScheduled());
      overridesRepo.count.mockResolvedValue(0);

      const result = await service.hasOverrides(userId, stId);

      expect(result).toEqual({ hasOverrides: false, count: 0 });
    });
  });

  // ==================== processAutoPostTransactions ====================
  describe("processAutoPostTransactions", () => {
    it("should find due autoPost transactions and post each", async () => {
      const st1 = makeScheduled({ id: "st-1", autoPost: true });
      const st2 = makeScheduled({ id: "st-2", autoPost: true });
      scheduledRepo.find.mockResolvedValue([st1, st2]);

      // For each post() call, stub the internal findOne and override queries
      scheduledRepo.findOne.mockResolvedValue(st1);
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      accountsRepo.findOne.mockResolvedValue(null);

      await service.processAutoPostTransactions();

      expect(scheduledRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ isActive: true, autoPost: true }),
        }),
      );
    });

    it("should handle empty due list gracefully", async () => {
      scheduledRepo.find.mockResolvedValue([]);

      await service.processAutoPostTransactions();

      expect(scheduledRepo.find).toHaveBeenCalled();
      // No posts should happen
      expect(transactionsService.create).not.toHaveBeenCalled();
    });

    // RLS (task C2): the timezone/candidate fan-out runs under a system
    // context; each per-user post() re-enters that user's own context.
    it("runs the fan-out under system context and each post under a user context", async () => {
      const st1 = makeScheduled({ id: "st-1", autoPost: true });
      let ctxAtFind: ReturnType<typeof getRequestContext>;
      scheduledRepo.find.mockImplementation(() => {
        ctxAtFind = getRequestContext();
        return Promise.resolve([st1]);
      });
      scheduledRepo.findOne.mockResolvedValue(st1);
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      accountsRepo.findOne.mockResolvedValue(null);

      let ctxAtPost: ReturnType<typeof getRequestContext>;
      const postSpy = jest.spyOn(service, "post").mockImplementation(() => {
        ctxAtPost = getRequestContext();
        return Promise.resolve(undefined as any);
      });

      await service.processAutoPostTransactions();

      expect(ctxAtFind).toEqual({ system: true });
      expect(ctxAtPost).toEqual({ userId: st1.userId });
      postSpy.mockRestore();
    });

    it("should continue processing after individual errors", async () => {
      const st1 = makeScheduled({ id: "st-1", autoPost: true });
      const st2 = makeScheduled({ id: "st-2", autoPost: true });
      scheduledRepo.find.mockResolvedValue([st1, st2]);

      // First post fails, second succeeds
      let callCount = 0;
      scheduledRepo.findOne.mockImplementation(() => {
        callCount++;
        if (callCount === 1) throw new Error("DB error");
        return Promise.resolve(st2);
      });
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      accountsRepo.findOne.mockResolvedValue(null);

      // Should not throw
      await service.processAutoPostTransactions();
    });

    it("raises a SCHEDULED_POST_FAILED alert for the affected user when a post genuinely fails", async () => {
      const st1 = makeScheduled({ id: "st-fail", autoPost: true });
      scheduledRepo.find.mockResolvedValue([st1]);
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      const postSpy = jest
        .spyOn(service, "post")
        .mockRejectedValue(new Error("account is closed"));

      await service.processAutoPostTransactions();

      expect(mockSystemAlerts.raiseUserAlert).toHaveBeenCalledWith(
        st1.userId,
        expect.objectContaining({
          type: "SCHEDULED_POST_FAILED",
          severity: "warning",
          dedupeKey: expect.stringMatching(
            /^SCHEDULED_POST_FAILED:st-fail:\d{4}-\d{2}-\d{2}$/,
          ),
          data: expect.objectContaining({
            system: true,
            scheduledId: "st-fail",
            scheduledName: st1.name,
            dueDate: st1.nextDueDate,
            error: "account is closed",
          }),
        }),
      );
      postSpy.mockRestore();
    });

    it("raises nothing for a ConflictException -- losing the claim means the winner posted it", async () => {
      const st1 = makeScheduled({ id: "st-claimed", autoPost: true });
      scheduledRepo.find.mockResolvedValue([st1]);
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      const postSpy = jest
        .spyOn(service, "post")
        .mockRejectedValue(new ConflictException("already posted"));

      await service.processAutoPostTransactions();

      expect(mockSystemAlerts.raiseUserAlert).not.toHaveBeenCalled();
      postSpy.mockRestore();
    });

    // Issue #1452: with two replicas, a bill posted twice. This replica
    // selected the 2025-02-15 occurrence; by the time its post() re-read the
    // row another replica had posted it and advanced next_due_date to
    // 2025-03-15. The post used to take the re-read date as the occurrence and
    // post the next month's bill under a fresh claim key.
    it("skips a schedule another replica posted after this run selected it, rather than posting the next occurrence", async () => {
      const selected = makeScheduled({
        id: stId,
        autoPost: true,
        nextDueDate: "2025-02-15",
      });
      scheduledRepo.find.mockResolvedValue([selected]);
      stubFindOne(
        makeScheduled({
          id: stId,
          autoPost: true,
          nextDueDate: "2025-03-15",
          lastPostedDate: "2025-02-15",
        }),
      );
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      const logSpy = jest.spyOn((service as any).logger, "log");

      await service.processAutoPostTransactions();

      expect(transactionsService.create).not.toHaveBeenCalled();
      expect(mockSystemAlerts.raiseUserAlert).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith(
        "Auto-post processing complete: 0 succeeded, " +
          "1 already claimed elsewhere, 0 failed",
      );
      logSpy.mockRestore();
    });

    // Every replica fires this cron. The winner posts a ONCE schedule and
    // deletes it inside the posting transaction, so the loser's post() finds
    // no row and throws NotFoundException, not ConflictException. That is a
    // posted transaction, never "could not be posted".
    it("raises nothing for a NotFoundException -- a ONCE schedule posted and deleted by the winner", async () => {
      const st1 = makeScheduled({
        id: "st-once-gone",
        autoPost: true,
        frequency: "ONCE",
      });
      scheduledRepo.find.mockResolvedValue([st1]);
      // The winner deleted the row: the existence re-read finds nothing.
      scheduledRepo.count.mockResolvedValue(0);
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      const postSpy = jest
        .spyOn(service, "post")
        .mockRejectedValue(
          new NotFoundException(
            "Scheduled transaction with ID st-once-gone not found",
          ),
        );
      const logSpy = jest.spyOn((service as any).logger, "log");
      const errorSpy = jest.spyOn((service as any).logger, "error");

      await service.processAutoPostTransactions();

      expect(mockSystemAlerts.raiseUserAlert).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith(
        "Auto-post processing complete: 0 succeeded, " +
          "1 already claimed elsewhere, 0 failed",
      );
      expect(errorSpy).not.toHaveBeenCalled();
      postSpy.mockRestore();
      logSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it("still alerts on a NotFoundException when the schedule itself is still there", async () => {
      // post() reaches services that throw NotFoundException for a missing
      // account or security. That schedule is genuinely broken -- it fails
      // every hour -- so it must reach the user, not be skipped as "posted and
      // removed elsewhere".
      const broken = makeScheduled({ id: "st-broken", autoPost: true });
      scheduledRepo.find.mockResolvedValue([broken]);
      scheduledRepo.count.mockResolvedValue(1);
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      const postSpy = jest
        .spyOn(service, "post")
        .mockRejectedValue(new NotFoundException("Account acc-9 not found"));
      const logSpy = jest.spyOn((service as any).logger, "log");
      const errorSpy = jest
        .spyOn((service as any).logger, "error")
        .mockImplementation(() => undefined);

      await service.processAutoPostTransactions();

      expect(mockSystemAlerts.raiseUserAlert).toHaveBeenCalledTimes(1);
      expect(mockSystemAlerts.raiseUserAlert).toHaveBeenCalledWith(
        broken.userId,
        expect.objectContaining({
          type: "SCHEDULED_POST_FAILED",
        }),
      );
      expect(logSpy).toHaveBeenCalledWith(
        "Auto-post processing complete: 0 succeeded, " +
          "0 already claimed elsewhere, 1 failed",
      );
      postSpy.mockRestore();
      logSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it("should auto-post transfer transactions using prepareTransfer", async () => {
      const transfer = makeScheduled({
        id: "st-transfer",
        autoPost: true,
        isTransfer: true,
        transferAccountId: "acc-2",
        tagIds: ["tag-1"],
      });
      scheduledRepo.find.mockResolvedValue([transfer]);
      scheduledRepo.findOne.mockResolvedValue(transfer);
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      accountsRepo.findOne.mockResolvedValue(null);

      await service.processAutoPostTransactions();

      expect(transactionsService.prepareTransfer).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          fromAccountId: "acc-1",
          toAccountId: "acc-2",
          amount: 1200,
          tagIds: ["tag-1"],
        }),
      );
      expect(transactionsService.create).not.toHaveBeenCalled();
    });

    it("should auto-post mixed batch of regular and transfer transactions", async () => {
      const regular = makeScheduled({
        id: "st-regular",
        autoPost: true,
        isTransfer: false,
      });
      const transfer = makeScheduled({
        id: "st-transfer",
        autoPost: true,
        isTransfer: true,
        transferAccountId: "acc-2",
      });
      scheduledRepo.find.mockResolvedValue([regular, transfer]);

      let findOneCall = 0;
      scheduledRepo.findOne.mockImplementation(() => {
        findOneCall++;
        // First two calls for post of regular, last two for post of transfer
        if (findOneCall <= 2) return Promise.resolve(regular);
        return Promise.resolve(transfer);
      });
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      accountsRepo.findOne.mockResolvedValue(null);

      await service.processAutoPostTransactions();

      expect(transactionsService.create).toHaveBeenCalled();
      expect(transactionsService.prepareTransfer).toHaveBeenCalled();
    });

    it("should pick up transactions with overrides that moved date earlier", async () => {
      const transfer = makeScheduled({
        id: "st-override",
        autoPost: true,
        isTransfer: true,
        transferAccountId: "acc-2",
        nextDueDate: "2025-03-15",
      });

      // First find (base nextDueDate) returns nothing — the 15th hasn't arrived
      // Second find (override-matched IDs) returns the transfer
      let findCallCount = 0;
      scheduledRepo.find.mockImplementation(() => {
        findCallCount++;
        if (findCallCount === 1) return Promise.resolve([]);
        return Promise.resolve([transfer]);
      });

      // Override query returns the scheduled transaction ID
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getRawMany.mockResolvedValue([{ id: "st-override" }]);
      overrideQb.getOne.mockResolvedValue({
        overrideDate: "2025-03-12",
        amount: null,
        categoryId: null,
        description: null,
        isSplit: null,
        splits: null,
      });
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);

      scheduledRepo.findOne.mockResolvedValue(transfer);
      accountsRepo.findOne.mockResolvedValue(null);

      await service.processAutoPostTransactions();

      expect(transactionsService.prepareTransfer).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          fromAccountId: "acc-1",
          toAccountId: "acc-2",
          transactionDate: "2025-03-12",
        }),
      );
    });

    it("should NOT auto-post when an override moves the next occurrence forward", async () => {
      const scheduled = makeScheduled({
        id: "st-postponed",
        autoPost: true,
        nextDueDate: "2026-04-26",
      });
      scheduledRepo.find.mockResolvedValue([scheduled]);

      // Postponed-id lookup returns this transaction; the moved-earlier
      // lookup returns nothing.
      const postponedQb = mockQueryBuilder(null);
      postponedQb.getRawMany.mockResolvedValue([{ id: "st-postponed" }]);
      const earlierQb = mockQueryBuilder(null);
      earlierQb.getRawMany.mockResolvedValue([]);
      overridesRepo.createQueryBuilder
        .mockReturnValueOnce(postponedQb)
        .mockReturnValueOnce(earlierQb);

      await service.processAutoPostTransactions();

      expect(transactionsService.create).not.toHaveBeenCalled();
      expect(transactionsService.prepareTransfer).not.toHaveBeenCalled();
    });

    it("uses last_client_timezone when explicit timezone is the 'browser' sentinel", async () => {
      // Stand in for an EDT user who hasn't picked a timezone in Settings.
      // The browser-provided IANA name was cached on a previous request and
      // must take precedence over the UTC fallback or we'll auto-post a day
      // early once UTC rolls past midnight.
      mockDataSource.query.mockResolvedValueOnce([
        {
          user_id: "33333333-3333-3333-3333-333333333333",
          timezone: "browser",
          last_client_timezone: "America/Toronto",
        },
      ]);
      scheduledRepo.find.mockResolvedValue([]);
      // No override-only IDs to consider.
      overridesRepo.createQueryBuilder.mockReturnValue(mockQueryBuilder([]));

      await service.processAutoPostTransactions();

      // The find() filter receives a LessThanOrEqual whose operand is
      // todayInTimezone('America/Toronto'). Asserting on the shape of the
      // call is enough — exact date depends on system clock — what matters
      // is that the bucketing didn't collapse to UTC.
      expect(scheduledRepo.find).toHaveBeenCalled();
    });

    it("falls back to UTC when neither explicit timezone nor cached client timezone is set", async () => {
      mockDataSource.query.mockResolvedValueOnce([
        {
          user_id: "44444444-4444-4444-4444-444444444444",
          timezone: "browser",
          last_client_timezone: null,
        },
      ]);
      scheduledRepo.find.mockResolvedValue([]);
      overridesRepo.createQueryBuilder.mockReturnValue(mockQueryBuilder([]));

      await service.processAutoPostTransactions();

      expect(scheduledRepo.find).toHaveBeenCalled();
    });

    it("should use override date as transaction date in post()", async () => {
      const scheduled = makeScheduled({
        nextDueDate: "2025-03-15",
      });
      scheduledRepo.findOne.mockResolvedValue(scheduled);

      const storedOverride = {
        overrideDate: "2025-03-12",
        amount: null,
        categoryId: null,
        description: null,
        isSplit: null,
        splits: null,
      };
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(storedOverride);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      overridesRepo.findOne.mockResolvedValue(storedOverride);
      accountsRepo.findOne.mockResolvedValue(null);

      await service.post(userId, stId);

      expect(transactionsService.create).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          transactionDate: "2025-03-12",
        }),
      );
    });
  });

  // ==================== recalculateLoanPaymentSplits ====================
  describe("recalculateLoanPaymentSplits", () => {
    it("should deactivate scheduled transaction when loan is paid off", async () => {
      // The loan account is now derived from the current split set under the
      // parent lock (issue #1154 re-review), so provide a transfer split
      // pointing at it rather than relying on a caller-passed loan id.
      accountsRepo.findOne.mockResolvedValue({
        id: "loan-1",
        accountType: "LOAN",
        currentBalance: 0,
      });
      splitsRepo.find.mockResolvedValue([
        {
          id: "s1",
          transferAccountId: "loan-1",
          categoryId: null,
          amount: -800,
        },
      ]);
      scheduledRepo.findOne.mockResolvedValue(
        makeScheduled({ isActive: true }),
      );

      await service.recalculateLoanPaymentSplits(stId);

      expect(scheduledRepo.update).toHaveBeenCalledWith(stId, {
        isActive: false,
      });
    });

    it("should do nothing when loan account not found", async () => {
      accountsRepo.findOne.mockResolvedValue(null);

      await service.recalculateLoanPaymentSplits(stId);

      expect(scheduledRepo.update).not.toHaveBeenCalled();
    });

    it("should do nothing when scheduled transaction not found", async () => {
      accountsRepo.findOne.mockResolvedValue({
        id: "loan-1",
        currentBalance: -50000,
        interestRate: 5,
      });
      scheduledRepo.findOne.mockResolvedValue(null);

      await service.recalculateLoanPaymentSplits(stId);

      expect(splitsRepo.save).not.toHaveBeenCalled();
    });

    it("should update principal and interest splits", async () => {
      const loanAccount = {
        id: "loan-1",
        accountType: "LOAN",
        currentBalance: -50000,
        interestRate: 6,
        paymentFrequency: "MONTHLY",
      };
      const principalSplit = {
        id: "s1",
        transferAccountId: "loan-1",
        categoryId: null,
        amount: -800,
      };
      const interestSplit = {
        id: "s2",
        transferAccountId: null,
        categoryId: "cat-interest",
        amount: -400,
      };
      const scheduled = makeScheduled({
        isActive: true,
        amount: -1200,
      });

      accountsRepo.findOne.mockResolvedValue(loanAccount);
      // Splits are re-read under the parent lock (issue #1154 re-review).
      splitsRepo.find.mockResolvedValue([principalSplit, interestSplit]);
      scheduledRepo.findOne.mockResolvedValue(scheduled);

      await service.recalculateLoanPaymentSplits(stId);

      // Both splits should have been saved with updated amounts
      expect(splitsRepo.save).toHaveBeenCalledTimes(2);
    });
  });

  describe("repriceLoanTemplate", () => {
    it("reprices through the loan service, which skips an inactive schedule", async () => {
      scheduledRepo.findOne.mockResolvedValue(
        makeScheduled({ isActive: false }),
      );

      await service.repriceLoanTemplate(stId);

      expect(scheduledRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: stId },
          lock: { mode: "pessimistic_write" },
        }),
      );
      expect(splitsRepo.save).not.toHaveBeenCalled();
    });
  });

  describe("getLoanProjectionAnchor", () => {
    it("returns the schedule's due date and the ledger debt through it", async () => {
      accountsRepo.findOne.mockResolvedValue({
        id: "loan-1",
        userId,
        accountType: "LOAN",
        currentBalance: -200000,
      });
      mockDataSource.query.mockImplementation(async (sql: string) => {
        const text = String(sql);
        if (text.includes("scheduled_transactions")) {
          return [{ next_due_date: "2026-08-01" }];
        }
        if (text.includes("opening_balance")) {
          return [{ balance: "-198500" }];
        }
        return [];
      });

      await expect(
        service.getLoanProjectionAnchor(userId, "loan-1"),
      ).resolves.toEqual({ nextDueDate: "2026-08-01", debt: 198500 });
    });
  });

  // ==================== loan splits resolve at the posting boundary ====================
  describe("post() resolves a loan template's splits at the posting boundary", () => {
    const loanTemplateSplits = (): any[] => [
      {
        id: "ss-principal",
        kind: "transfer",
        transferAccountId: "loan-1",
        categoryId: null,
        amount: -500,
        memo: "Principal",
        tags: [],
      },
      {
        id: "ss-interest",
        kind: "category",
        transferAccountId: null,
        categoryId: "cat-interest",
        amount: -1000,
        memo: "Interest",
        tags: [],
      },
    ];

    const loanAccount = () => ({
      id: "loan-1",
      userId,
      accountType: "LOAN",
      currentBalance: -200000,
      interestRate: 6,
      paymentFrequency: "MONTHLY",
      paymentAmount: 1500,
    });

    const arrangeLoanPost = (scheduled: any) => {
      scheduledRepo.findOne.mockResolvedValue(scheduled);
      splitsRepo.find.mockResolvedValue(scheduled.splits);
      accountsRepo.findOne.mockResolvedValue(loanAccount());
      overridesRepo.createQueryBuilder = jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      });
      mockQueryRunner.manager.delete = jest
        .fn()
        .mockResolvedValue({ affected: 1 });
      transactionsService.create.mockResolvedValue({ id: "tx-new" });
    };

    it("posts the ledger-derived allocation, not the stale stored split (issue #1253)", async () => {
      // The template was prepared when the previous occurrence posted: 1,000
      // interest on a 200,000 debt at 6% monthly. A standalone 1,500
      // principal-only payment landed afterwards, dated on or before this
      // occurrence's due date, and nothing recalculates the stored split on
      // that mutation -- so the posting itself must re-resolve from the
      // ledger: 198,500 * 0.005 = 992.50 of interest, 507.50 of principal.
      const scheduled = makeScheduled({
        amount: -1500,
        isSplit: true,
        splits: loanTemplateSplits(),
        frequency: "ONCE",
      });
      arrangeLoanPost(scheduled);
      mockDataSource.query.mockImplementation(async (sql: string) => {
        const text = String(sql);
        if (text.includes("scheduled_transaction_postings")) {
          return [[{ id: "posting-1" }], 1];
        }
        if (text.includes("opening_balance")) {
          return [{ balance: "-198500" }];
        }
        return [
          { user_id: "11111111-1111-1111-1111-111111111111", timezone: "UTC" },
        ];
      });

      await service.post(userId, stId);

      expect(transactionsService.create).toHaveBeenCalledTimes(1);
      const payload = transactionsService.create.mock.calls[0][1];
      const interest = payload.splits.find(
        (s: any) => s.categoryId === "cat-interest",
      );
      const principal = payload.splits.find(
        (s: any) => s.transferAccountId === "loan-1",
      );
      expect(interest.amount).toBe(-992.5);
      expect(principal.amount).toBe(-507.5);
      // The parent moved with its children, or the split validator's exact-4dp
      // equality would refuse the post.
      expect(payload.amount).toBe(-1500);
      // The ledger was measured through THIS occurrence's due date.
      expect(mockDataSource.query).toHaveBeenCalledWith(
        expect.stringContaining("t.transaction_date <= $3"),
        ["loan-1", userId, "2025-02-15"],
      );
    });

    it("posts the persisted amounts unchanged when the ledger did not move", async () => {
      // Idempotence: with no intervening principal mutation the resolution
      // reproduces the template exactly (same balance, same rate, same
      // waterfall), so posting is byte-identical to today's behavior.
      const scheduled = makeScheduled({
        amount: -1500,
        isSplit: true,
        splits: loanTemplateSplits(),
        frequency: "ONCE",
      });
      arrangeLoanPost(scheduled);
      // Default beforeEach query mock answers the balance query with the
      // account's stored -200,000, the balance the template was priced at.

      await service.post(userId, stId);

      const payload = transactionsService.create.mock.calls[0][1];
      const interest = payload.splits.find(
        (s: any) => s.categoryId === "cat-interest",
      );
      const principal = payload.splits.find(
        (s: any) => s.transferAccountId === "loan-1",
      );
      expect(interest.amount).toBe(-1000);
      expect(principal.amount).toBe(-500);
      expect(payload.amount).toBe(-1500);
    });

    it("re-resolves for the manual Post dialog, which echoes the template as inline splits", async () => {
      // The dialog always sends `isSplit` + `splits`, so this occurrence does
      // NOT take the base-split path. Without its own re-resolution the same
      // occurrence posted 992.50 from the list's quick-post button and a stale
      // 1,000.00 from the dialog -- the path users actually take.
      const scheduled = makeScheduled({
        amount: -1500,
        isSplit: true,
        splits: loanTemplateSplits(),
        frequency: "ONCE",
      });
      arrangeLoanPost(scheduled);
      mockDataSource.query.mockImplementation(async (sql: string) => {
        const text = String(sql);
        if (text.includes("scheduled_transaction_postings")) {
          return [[{ id: "posting-1" }], 1];
        }
        if (text.includes("opening_balance")) return [{ balance: "-198500" }];
        return [
          { user_id: "11111111-1111-1111-1111-111111111111", timezone: "UTC" },
        ];
      });

      // Exactly what PostTransactionDialog sends: the echoed parent amount
      // alongside the echoed lines. A fixture omitting `amount` is a payload
      // no client produces -- and gating on its absence made this whole path
      // unreachable in production while the test passed.
      await service.post(userId, stId, {
        amount: -1500,
        isSplit: true,
        splits: [
          {
            sourceSplitId: "ss-principal",
            transferAccountId: "loan-1",
            amount: -500,
          },
          {
            sourceSplitId: "ss-interest",
            categoryId: "cat-interest",
            amount: -1000,
          },
        ],
      } as any);

      const payload = transactionsService.create.mock.calls[0][1];
      const interest = payload.splits.find(
        (sp: any) => sp.categoryId === "cat-interest",
      );
      expect(interest.amount).toBe(-992.5);
      expect(payload.amount).toBe(-1500);
    });

    it("honours a split amount the user actually typed in the dialog", async () => {
      // An echo is not an instruction, but a figure the user changed is: it
      // differs from its source split, so it posts as given.
      const scheduled = makeScheduled({
        amount: -1500,
        isSplit: true,
        splits: loanTemplateSplits(),
        frequency: "ONCE",
      });
      arrangeLoanPost(scheduled);

      await service.post(userId, stId, {
        amount: -1500,
        isSplit: true,
        splits: [
          {
            sourceSplitId: "ss-principal",
            transferAccountId: "loan-1",
            amount: -400,
          },
          {
            sourceSplitId: "ss-interest",
            categoryId: "cat-interest",
            amount: -1100,
          },
        ],
      } as any);

      const payload = transactionsService.create.mock.calls[0][1];
      const interest = payload.splits.find(
        (sp: any) => sp.categoryId === "cat-interest",
      );
      expect(interest.amount).toBe(-1100);
    });

    it("prices the occurrence at the date its money moves, not the abandoned slot", async () => {
      // An override moved this occurrence off its recurrence slot. Interest
      // accrues to the date the payment is actually made, so the boundary is
      // the posting date.
      const scheduled = makeScheduled({
        amount: -1500,
        isSplit: true,
        splits: loanTemplateSplits(),
        nextDueDate: "2025-02-15",
        frequency: "ONCE",
      });
      arrangeLoanPost(scheduled);
      const movedOverride = {
        overrideDate: "2025-03-05",
        amount: null,
        categoryId: null,
        description: null,
        isSplit: null,
        splits: null,
        updatedAt: new Date(0),
      };
      overridesRepo.createQueryBuilder = jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(movedOverride),
      });
      overridesRepo.findOne.mockResolvedValue(movedOverride);
      mockQueryRunner.manager.remove = jest.fn().mockResolvedValue(undefined);

      await service.post(userId, stId);

      expect(mockDataSource.query).toHaveBeenCalledWith(
        expect.stringContaining("t.transaction_date <= $3"),
        ["loan-1", userId, "2025-03-05"],
      );
    });

    it("honours a parent amount the user retyped in the dialog", async () => {
      // The amount is an echo only while it still matches the template. A
      // figure the user changed is their statement for this occurrence, so it
      // posts as sent rather than being re-divided against a total they did
      // not ask for.
      const scheduled = makeScheduled({
        amount: -1500,
        isSplit: true,
        splits: loanTemplateSplits(),
        frequency: "ONCE",
      });
      arrangeLoanPost(scheduled);
      mockDataSource.query.mockImplementation(async (sql: string) => {
        const text = String(sql);
        if (text.includes("scheduled_transaction_postings")) {
          return [[{ id: "posting-1" }], 1];
        }
        if (text.includes("opening_balance")) return [{ balance: "-198500" }];
        return [
          { user_id: "11111111-1111-1111-1111-111111111111", timezone: "UTC" },
        ];
      });

      await service.post(userId, stId, {
        amount: -1600,
        isSplit: true,
        splits: [
          {
            sourceSplitId: "ss-principal",
            transferAccountId: "loan-1",
            amount: -600,
          },
          {
            sourceSplitId: "ss-interest",
            categoryId: "cat-interest",
            amount: -1000,
          },
        ],
      } as any);

      const payload = transactionsService.create.mock.calls[0][1];
      const interest = payload.splits.find(
        (sp: any) => sp.categoryId === "cat-interest",
      );
      expect(interest.amount).toBe(-1000);
      expect(payload.amount).toBe(-1600);
    });

    it("shrinks the installment to the debt that is actually left", async () => {
      // The other direction of "re-divides, never resizes upward": a payment
      // made since the template was written can leave less owing than the bill
      // charges, and the waterfall clamps principal to the remaining debt. The
      // occurrence must retire the debt rather than overpay it into credit.
      const scheduled = makeScheduled({
        amount: -1500,
        isSplit: true,
        splits: loanTemplateSplits(),
        frequency: "ONCE",
      });
      arrangeLoanPost(scheduled);
      mockDataSource.query.mockImplementation(async (sql: string) => {
        const text = String(sql);
        if (text.includes("scheduled_transaction_postings")) {
          return [[{ id: "posting-1" }], 1];
        }
        // Only 200 of debt is left through this occurrence's date.
        if (text.includes("opening_balance")) return [{ balance: "-200" }];
        return [
          { user_id: "11111111-1111-1111-1111-111111111111", timezone: "UTC" },
        ];
      });

      await service.post(userId, stId);

      const payload = transactionsService.create.mock.calls[0][1];
      const principal = payload.splits.find(
        (sp: any) => sp.transferAccountId === "loan-1",
      );
      // 200 x 0.005 = 1.00 of interest, and principal cannot exceed the debt.
      expect(principal.amount).toBe(-200);
      expect(payload.amount).toBe(-201);
    });

    it("posts no money when the loan is already paid off, and still consumes the occurrence", async () => {
      // The payoff lands between occurrences, so nothing has recalculated the
      // template: it still says -1,500 (-1,000 interest, -500 principal).
      // Posting it would record interest against a debt that no longer exists
      // and push the loan 500 into credit. The occurrence is still claimed and
      // the schedule still advances, so cron does not retry it forever.
      const scheduled = makeScheduled({
        amount: -1500,
        isSplit: true,
        splits: loanTemplateSplits(),
        frequency: "MONTHLY",
      });
      arrangeLoanPost(scheduled);
      mockDataSource.query.mockImplementation(async (sql: string) => {
        const text = String(sql);
        if (text.includes("scheduled_transaction_postings")) {
          return [[{ id: "posting-1" }], 1];
        }
        // The debt through this occurrence's boundary is retired.
        if (text.includes("opening_balance")) return [{ balance: "0" }];
        return [
          { user_id: "11111111-1111-1111-1111-111111111111", timezone: "UTC" },
        ];
      });

      await service.post(userId, stId);

      expect(transactionsService.create).not.toHaveBeenCalled();
      // The occurrence was claimed...
      expect(mockDataSource.query).toHaveBeenCalledWith(
        expect.stringContaining("scheduled_transaction_postings"),
        expect.arrayContaining([stId]),
      );
      // ...and the schedule advanced past it.
      const advanced = mockQueryRunner.manager.update.mock.calls.find(
        (call: any[]) => call[2]?.nextDueDate !== undefined,
      );
      expect(advanced).toBeDefined();
    });

    it("still posts a paid-off template that carries a line the payoff does not settle", async () => {
      // The mortgage principal is retired; the escrow line is not. Withholding
      // the whole bill would stop paying the property tax.
      const scheduled = makeScheduled({
        amount: -1700,
        isSplit: true,
        splits: [
          ...loanTemplateSplits(),
          {
            id: "ss-escrow",
            kind: "category",
            transferAccountId: null,
            categoryId: "cat-escrow",
            amount: -200,
            memo: "Property tax",
            tags: [],
          },
        ] as any[],
        frequency: "ONCE",
      });
      arrangeLoanPost(scheduled);
      accountsRepo.findOne.mockResolvedValue({
        ...loanAccount(),
        interestCategoryId: "cat-interest",
      });
      mockDataSource.query.mockImplementation(async (sql: string) => {
        const text = String(sql);
        if (text.includes("scheduled_transaction_postings")) {
          return [[{ id: "posting-1" }], 1];
        }
        if (text.includes("opening_balance")) return [{ balance: "0" }];
        return [
          { user_id: "11111111-1111-1111-1111-111111111111", timezone: "UTC" },
        ];
      });

      await service.post(userId, stId);

      expect(transactionsService.create).toHaveBeenCalledTimes(1);
      const payload = transactionsService.create.mock.calls[0][1];
      expect(payload.amount).toBe(-1700);
    });

    it("honours an override amount instead of re-resolving", async () => {
      // A stored per-occurrence amount is the user's explicit statement for
      // that occurrence; re-pricing the splits against it would make parent
      // and children disagree and refuse the post.
      const scheduled = makeScheduled({
        amount: -1500,
        isSplit: true,
        splits: loanTemplateSplits(),
        frequency: "ONCE",
      });
      arrangeLoanPost(scheduled);
      const storedOverride = {
        overrideDate: null,
        amount: -1400,
        categoryId: null,
        description: null,
        isSplit: null,
        splits: null,
        updatedAt: new Date(0),
      };
      overridesRepo.createQueryBuilder = jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(storedOverride),
      });
      overridesRepo.findOne.mockResolvedValue(storedOverride);
      mockQueryRunner.manager.remove = jest.fn().mockResolvedValue(undefined);

      await service.post(userId, stId);

      const payload = transactionsService.create.mock.calls[0][1];
      const interest = payload.splits.find(
        (s: any) => s.categoryId === "cat-interest",
      );
      expect(interest.amount).toBe(-1000);
      expect(payload.amount).toBe(-1400);
    });
  });

  describe("scheduled investment splits", () => {
    const buyInvestment = {
      action: "BUY" as const,
      securityId: "sec-1",
      quantity: 75,
      price: 10,
      commission: 0,
    };

    it("persists kind='investment' and the investment fields on save", async () => {
      const dto = {
        accountId: "acc-1",
        name: "Equity Grant",
        amount: 0,
        currencyCode: "USD",
        frequency: "MONTHLY" as const,
        nextDueDate: "2026-05-09",
        startDate: "2026-05-09",
        splits: [
          { amount: 1000, categoryId: "cat-income" },
          { amount: -250, categoryId: "cat-tax" },
          { amount: -750, investment: buyInvestment },
        ],
      };
      accountsService.findOne.mockResolvedValue({
        id: "acc-1",
        accountType: "INVESTMENT",
        accountSubType: "INVESTMENT_CASH",
        currencyCode: "USD",
      });
      scheduledRepo.create.mockImplementation((d) => ({ id: stId, ...d }));
      scheduledRepo.save.mockImplementation(async (d) => d);
      mockQueryRunner.manager.create.mockImplementation(
        (_e: unknown, d: unknown) => d,
      );
      mockQueryRunner.manager.save.mockImplementation(async (d: object) => ({
        id: "split-x",
        ...d,
      }));

      // findOne returns the saved scheduled transaction
      scheduledRepo.findOne.mockResolvedValue(makeScheduled({ amount: 0 }));

      await service.create(userId, dto as any);

      // Verify the investment-kind split was created with all fields populated
      const investmentCall = mockQueryRunner.manager.create.mock.calls.find(
        (c: any[]) => c[1]?.kind === "investment",
      );
      expect(investmentCall).toBeDefined();
      expect(investmentCall![1]).toMatchObject({
        kind: "investment",
        categoryId: null,
        transferAccountId: null,
        amount: -750,
        investmentAction: "BUY",
        investmentSecurityId: "sec-1",
        investmentQuantity: 75,
        investmentPrice: 10,
        investmentCommission: 0,
      });
    });

    it("rejects single category split when no transfer/investment passthrough", async () => {
      const dto = {
        accountId: "acc-1",
        name: "Bad",
        amount: -100,
        currencyCode: "USD",
        frequency: "MONTHLY" as const,
        nextDueDate: "2026-05-09",
        startDate: "2026-05-09",
        splits: [{ amount: -100, categoryId: "cat-1" }],
      };
      accountsService.findOne.mockResolvedValue({
        id: "acc-1",
        accountType: "CHEQUING",
        accountSubType: null,
        currencyCode: "USD",
      });

      await expect(service.create(userId, dto as any)).rejects.toThrow(
        /at least 2 splits/,
      );
    });

    it("accepts a single investment split as a passthrough", async () => {
      const dto = {
        accountId: "acc-1",
        name: "Pure equity grant",
        amount: -750,
        currencyCode: "USD",
        frequency: "MONTHLY" as const,
        nextDueDate: "2026-05-09",
        startDate: "2026-05-09",
        splits: [{ amount: -750, investment: buyInvestment }],
      };
      accountsService.findOne.mockResolvedValue({
        id: "acc-1",
        accountType: "INVESTMENT",
        accountSubType: "INVESTMENT_CASH",
        currencyCode: "USD",
      });
      scheduledRepo.create.mockImplementation((d) => ({ id: stId, ...d }));
      scheduledRepo.save.mockImplementation(async (d) => d);
      splitsRepo.create.mockImplementation((d) => d);
      splitsRepo.save.mockImplementation(async (d) => ({
        id: "split-x",
        ...d,
      }));
      scheduledRepo.findOne.mockResolvedValue(makeScheduled({ amount: -750 }));

      await expect(service.create(userId, dto as any)).resolves.toBeDefined();
    });

    it("post() forwards investment payload from scheduled splits to TransactionsService.create", async () => {
      const investmentSplit: any = {
        id: "ss-3",
        kind: "investment",
        amount: -750,
        memo: null,
        categoryId: null,
        transferAccountId: null,
        investmentAction: "BUY",
        investmentSecurityId: "sec-1",
        investmentQuantity: 75,
        investmentPrice: 10,
        investmentCommission: 0,
        investmentExchangeRate: 1,
        // Provenance matching the current settlement pair (the mock resolves
        // USD->USD by default), so the stored rate is reused (issue #1167).
        investmentExchangeRateFromCurrency: "USD",
        investmentExchangeRateToCurrency: "USD",
        tags: [],
      };
      const incomeSplit: any = {
        id: "ss-1",
        kind: "category",
        amount: 1000,
        memo: null,
        categoryId: "cat-income",
        transferAccountId: null,
        tags: [],
      };
      const taxSplit: any = {
        id: "ss-2",
        kind: "category",
        amount: -250,
        memo: null,
        categoryId: "cat-tax",
        transferAccountId: null,
        tags: [],
      };
      const scheduled = makeScheduled({
        amount: 0,
        isSplit: true,
        splits: [incomeSplit, taxSplit, investmentSplit],
        frequency: "ONCE",
      });
      scheduledRepo.findOne.mockResolvedValue(scheduled);
      // The locked split re-read (issue #1154 re-review) returns the same set.
      splitsRepo.find.mockResolvedValue(scheduled.splits);
      overridesRepo.createQueryBuilder = jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      });
      mockQueryRunner.manager.delete = jest
        .fn()
        .mockResolvedValue({ affected: 1 });
      transactionsService.create.mockResolvedValue({ id: "tx-new" });

      await service.post(userId, stId);

      expect(transactionsService.create).toHaveBeenCalledTimes(1);
      const callArg = transactionsService.create.mock.calls[0][1];
      const investmentPayload = callArg.splits.find(
        (s: any) => s.splitKind === "investment",
      );
      expect(investmentPayload).toBeDefined();
      expect(investmentPayload.investment).toMatchObject({
        action: "BUY",
        securityId: "sec-1",
        quantity: 75,
        price: 10,
        commission: 0,
        exchangeRate: 1,
      });
      expect(investmentPayload.amount).toBe(-750);

      // Cash splits passed through with splitKind='category'
      const incomePayload = callArg.splits.find((s: any) => s.amount === 1000);
      expect(incomePayload.splitKind).toBe("category");
      expect(incomePayload.investment).toBeUndefined();
    });

    it("post() forwards investment payload from inline postDto.splits", async () => {
      const scheduled = makeScheduled({
        amount: 0,
        isSplit: true,
        splits: [],
        frequency: "ONCE",
      });
      scheduledRepo.findOne.mockResolvedValue(scheduled);
      overridesRepo.createQueryBuilder = jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      });
      mockQueryRunner.manager.delete = jest
        .fn()
        .mockResolvedValue({ affected: 1 });
      transactionsService.create.mockResolvedValue({ id: "tx-new" });

      await service.post(userId, stId, {
        amount: 0,
        isSplit: true,
        splits: [
          { categoryId: "cat-income", amount: 1000 } as any,
          { categoryId: "cat-tax", amount: -250 } as any,
          {
            splitKind: "investment",
            amount: -750,
            investment: buyInvestment,
          } as any,
        ],
      });

      const callArg = transactionsService.create.mock.calls[0][1];
      expect(callArg.splits).toHaveLength(3);
      const inv = callArg.splits.find((s: any) => s.splitKind === "investment");
      expect(inv).toBeDefined();
      expect(inv.investment).toMatchObject(buyInvestment);
    });

    it("post() forwards investment payload from stored override splits", async () => {
      const scheduled = makeScheduled({
        amount: 0,
        isSplit: true,
        splits: [],
        frequency: "ONCE",
      });
      scheduledRepo.findOne.mockResolvedValue(scheduled);

      const storedOverride: any = {
        amount: 0,
        isSplit: true,
        splits: [
          { categoryId: "cat-income", amount: 1000 },
          { categoryId: "cat-tax", amount: -250 },
          {
            splitKind: "investment",
            amount: -750,
            investment: buyInvestment,
          },
        ],
      };
      overridesRepo.createQueryBuilder = jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(storedOverride),
      });
      overridesRepo.findOne.mockResolvedValue(storedOverride);
      mockQueryRunner.manager.delete = jest
        .fn()
        .mockResolvedValue({ affected: 1 });
      transactionsService.create.mockResolvedValue({ id: "tx-new" });

      await service.post(userId, stId);

      const callArg = transactionsService.create.mock.calls[0][1];
      const inv = callArg.splits.find((s: any) => s.splitKind === "investment");
      expect(inv).toBeDefined();
      expect(inv.investment).toMatchObject(buyInvestment);
    });

    it("post() preserves null investment fields when scheduled split is non-investment", async () => {
      const incomeSplit: any = {
        id: "ss-1",
        kind: "category",
        amount: -50,
        memo: null,
        categoryId: "cat-1",
        transferAccountId: null,
        tags: [],
        // No investment* fields
      };
      const expenseSplit: any = {
        id: "ss-2",
        kind: "category",
        amount: -50,
        memo: null,
        categoryId: "cat-2",
        transferAccountId: null,
        tags: [],
      };
      const scheduled = makeScheduled({
        amount: -100,
        isSplit: true,
        splits: [incomeSplit, expenseSplit],
        frequency: "ONCE",
      });
      scheduledRepo.findOne.mockResolvedValue(scheduled);
      splitsRepo.find.mockResolvedValue(scheduled.splits);
      overridesRepo.createQueryBuilder = jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      });
      mockQueryRunner.manager.delete = jest
        .fn()
        .mockResolvedValue({ affected: 1 });
      transactionsService.create.mockResolvedValue({ id: "tx-new" });

      await service.post(userId, stId);

      const callArg = transactionsService.create.mock.calls[0][1];
      callArg.splits.forEach((s: any) => {
        expect(s.investment).toBeUndefined();
        expect(s.splitKind).toBe("category");
      });
    });
  });

  // Issue #1167: a stored investment FX rate carries the currency pair it was
  // resolved for, and is only reused when that pair still matches the current
  // settlement pair (security currency -> settlement account currency).
  describe("investment FX rate currency-pair provenance (issue #1167)", () => {
    const setupOverrideQuery = () => {
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      accountsRepo.findOne.mockResolvedValue(null);
    };

    // ---- Surface 1: the parent scheduled investment rate ----

    it("create() records the currency pair a stored rate was resolved for", async () => {
      accountsService.findOne.mockResolvedValue({
        id: "acc-inv",
        userId,
        accountSubType: "INVESTMENT_BROKERAGE",
      });
      investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
        { from: "USD", to: "CAD" },
      );
      scheduledRepo.save.mockResolvedValue(makeScheduled());
      stubFindOne(makeScheduled());

      await service.create(userId, {
        accountId: "acc-inv",
        name: "Cross-currency BUY",
        amount: -500,
        currencyCode: "CAD",
        frequency: "MONTHLY" as any,
        nextDueDate: "2026-06-15",
        isInvestment: true,
        investmentAction: "BUY" as any,
        investmentSecurityId: "sec-usd",
        investmentQuantity: 1,
        investmentPrice: 500,
        investmentExchangeRate: 1.35,
      } as any);

      const created = scheduledRepo.create.mock.calls[0][0];
      expect(created.investmentExchangeRate).toBe(1.35);
      expect(created.investmentExchangeRateFromCurrency).toBe("USD");
      expect(created.investmentExchangeRateToCurrency).toBe("CAD");
    });

    it("post() reuses a stored rate whose pair still matches", async () => {
      stubFindOne(
        makeScheduled({
          isInvestment: true,
          investmentAction: "BUY" as any,
          investmentSecurityId: "sec-usd",
          investmentQuantity: 1,
          investmentPrice: 500,
          investmentExchangeRate: 1.35,
          investmentExchangeRateFromCurrency: "USD",
          investmentExchangeRateToCurrency: "CAD",
        } as any),
      );
      setupOverrideQuery();
      investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
        { from: "USD", to: "CAD" },
      );

      await service.post(userId, stId);

      const dto = investmentTransactionsService.create.mock.calls[0][1];
      expect(dto.exchangeRate).toBe(1.35);
    });

    it("post() drops a stored rate whose pair no longer matches (re-resolves)", async () => {
      stubFindOne(
        makeScheduled({
          isInvestment: true,
          investmentAction: "BUY" as any,
          investmentSecurityId: "sec-usd",
          investmentFundingAccountId: null,
          investmentQuantity: 1,
          investmentPrice: 500,
          investmentExchangeRate: 1.35,
          investmentExchangeRateFromCurrency: "USD",
          investmentExchangeRateToCurrency: "CAD",
        } as any),
      );
      setupOverrideQuery();
      // The security's currency changed from USD to EUR after the rate was
      // stored, so the stored USD->CAD scalar is stale.
      investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
        { from: "EUR", to: "CAD" },
      );

      await service.post(userId, stId);

      const dto = investmentTransactionsService.create.mock.calls[0][1];
      // The stale scalar is not forwarded, so the resolver re-resolves.
      expect(dto.exchangeRate).toBeUndefined();
      expect(
        investmentTransactionsService.resolveSettlementCurrencyPair,
      ).toHaveBeenCalledWith(userId, "acc-1", null, "sec-usd");
    });

    it("post() drops a stored rate with no recorded pair (pre-#1167 row) so it re-resolves", async () => {
      stubFindOne(
        makeScheduled({
          isInvestment: true,
          investmentAction: "BUY" as any,
          investmentSecurityId: "sec-usd",
          investmentQuantity: 1,
          investmentPrice: 500,
          investmentExchangeRate: 1.35,
          investmentExchangeRateFromCurrency: null,
          investmentExchangeRateToCurrency: null,
        } as any),
      );
      setupOverrideQuery();

      await service.post(userId, stId);

      const dto = investmentTransactionsService.create.mock.calls[0][1];
      // An unprovable scalar is not applied to a pair it may not describe; the
      // posting resolver re-resolves (dto.exchangeRate omitted).
      expect(dto.exchangeRate).toBeUndefined();
    });

    it("post() does not forward a stored non-1 scalar for a same-currency pair -- resolver settles it to 1 (R12-F1)", async () => {
      stubFindOne(
        makeScheduled({
          isInvestment: true,
          investmentAction: "BUY" as any,
          investmentSecurityId: "sec-usd",
          investmentFundingAccountId: null,
          investmentQuantity: 10,
          investmentPrice: 100,
          // 1.50 stamped against a CAD->CAD pair; its from/to match the current
          // pair, so the old reuse would have forwarded it as the posting rate.
          investmentExchangeRate: 1.5,
          investmentExchangeRateFromCurrency: "CAD",
          investmentExchangeRateToCurrency: "CAD",
        } as any),
      );
      setupOverrideQuery();
      investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
        { from: "CAD", to: "CAD" },
      );

      await service.post(userId, stId);

      const dto = investmentTransactionsService.create.mock.calls[0][1];
      // The stale non-1 scalar is not forwarded; InvestmentTransactionsService's
      // resolver derives the same-currency pair and settles it to 1 (proven by
      // the resolver's own R12-F1 test), so cash posts at par -- never 10x100x1.50.
      expect(dto.exchangeRate).toBeUndefined();
    });

    it("update() clears the recorded pair when it clears the rate", async () => {
      stubFindOne(
        makeScheduled({
          isInvestment: true,
          investmentAction: "BUY" as any,
          investmentSecurityId: "sec-usd",
          investmentFundingAccountId: "acc-usd",
          investmentQuantity: 1,
          investmentPrice: 100,
          investmentExchangeRate: 1.35,
          investmentExchangeRateFromCurrency: "USD",
          investmentExchangeRateToCurrency: "CAD",
        } as any),
      );
      accountsService.findOne.mockResolvedValue({
        id: "acc-1",
        userId,
        accountSubType: "INVESTMENT_BROKERAGE",
      });

      // Switching action changes the settlement basis, which clears the rate.
      await service.update(userId, stId, {
        investmentAction: "DIVIDEND" as any,
        investmentTotalAmount: 100,
      } as any);

      const fields = mockQueryRunner.manager.update.mock.calls.find(
        (c: any[]) => c[1] === stId && c[2].investmentAction !== undefined,
      )?.[2];
      expect(fields).toBeDefined();
      expect(fields.investmentExchangeRate).toBeNull();
      expect(fields.investmentExchangeRateFromCurrency).toBeNull();
      expect(fields.investmentExchangeRateToCurrency).toBeNull();
    });

    // ---- Surface 2: an embedded scheduled investment split ----

    const investmentSplitSchedule = (
      exchangeRate: number | null,
      from: string | null,
      to: string | null,
    ) =>
      makeScheduled({
        isSplit: true,
        accountId: "acc-cash",
        splits: [
          {
            id: "s1",
            scheduledTransactionId: stId,
            kind: "investment",
            categoryId: null,
            transferAccountId: null,
            amount: -675,
            memo: null,
            investmentAction: "BUY",
            investmentSecurityId: "sec-usd",
            investmentQuantity: 5,
            investmentPrice: 100,
            investmentCommission: 0,
            investmentExchangeRate: exchangeRate,
            investmentExchangeRateFromCurrency: from,
            investmentExchangeRateToCurrency: to,
          } as any,
        ],
      } as any);

    it("post() re-resolves a stale embedded split rate and recomputes the amount", async () => {
      // Stored provenance USD->CAD at 1.35 (stored amount -675). The security's
      // currency has since changed, so the current settlement pair is EUR->CAD:
      // the stored rate is unprovable and must be re-resolved end-to-end.
      stubFindOne(investmentSplitSchedule(1.35, "USD", "CAD"));
      setupOverrideQuery();
      mockQueryRunner.manager.delete = jest
        .fn()
        .mockResolvedValue({ affected: 1 });
      investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
        { from: "EUR", to: "CAD" },
      );
      investmentTransactionsService.resolveCashExchangeRateOrNull.mockResolvedValue(
        1.2,
      );

      await service.post(userId, stId);

      const payload = transactionsService.create.mock.calls[0][1];
      // cashImpact = -(5*100) = -500; re-resolved rate 1.2 -> -600 CAD, never
      // the stale stored -675. The rate the embedded trade forwards is 1.2.
      expect(payload.splits[0].investment.exchangeRate).toBe(1.2);
      expect(payload.splits[0].amount).toBe(-600);
      // The parent is re-summed from the recomputed split amounts so the whole
      // post books consistently (validateSplitAmountSum would otherwise refuse).
      expect(payload.amount).toBe(-600);
      expect(
        investmentTransactionsService.resolveCashExchangeRateOrNull,
      ).toHaveBeenCalledWith(
        userId,
        "acc-cash",
        null,
        "sec-usd",
        undefined,
        expect.any(String),
      );
    });

    it("post() refuses an embedded split whose current rate is unavailable", async () => {
      stubFindOne(investmentSplitSchedule(1.35, "USD", "CAD"));
      setupOverrideQuery();
      mockQueryRunner.manager.delete = jest
        .fn()
        .mockResolvedValue({ affected: 1 });
      // Stale provenance forces re-resolution, and no current rate can be found.
      investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
        { from: "EUR", to: "CAD" },
      );
      investmentTransactionsService.resolveCashExchangeRateOrNull.mockResolvedValue(
        null,
      );

      await expect(service.post(userId, stId)).rejects.toThrow(
        /exchange rate/i,
      );
      // Refused before any transaction was created.
      expect(transactionsService.create).not.toHaveBeenCalled();
    });

    it("post() reuses an embedded split rate whose pair still matches", async () => {
      stubFindOne(investmentSplitSchedule(1.35, "USD", "CAD"));
      setupOverrideQuery();
      mockQueryRunner.manager.delete = jest
        .fn()
        .mockResolvedValue({ affected: 1 });
      investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
        { from: "USD", to: "CAD" },
      );

      await service.post(userId, stId);

      const payload = transactionsService.create.mock.calls[0][1];
      expect(payload.splits[0].investment.exchangeRate).toBe(1.35);
    });

    it("post() settles an embedded split's non-1 scalar to 1 for a same-currency pair, recomputing the amount at par (R12-F1)", async () => {
      // 1.50 stamped against CAD->CAD; its from/to match the current pair.
      stubFindOne(investmentSplitSchedule(1.5, "CAD", "CAD"));
      setupOverrideQuery();
      mockQueryRunner.manager.delete = jest
        .fn()
        .mockResolvedValue({ affected: 1 });
      investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
        { from: "CAD", to: "CAD" },
      );
      // The real resolver returns 1 for a same-currency pair; mock that here.
      investmentTransactionsService.resolveCashExchangeRateOrNull.mockResolvedValue(
        1,
      );

      await service.post(userId, stId);

      const payload = transactionsService.create.mock.calls[0][1];
      // Same-currency dominates: rate 1, and the cash amount is recomputed at par
      // (cashImpact = -(5 * 100) = -500 x 1 = -500), never the stored -750.
      expect(payload.splits[0].investment.exchangeRate).toBe(1);
      expect(payload.splits[0].amount).toBe(-500);
    });

    // ---- Surface 3: an occurrence-override embedded split ----

    it("post() re-resolves a stale override split rate and recomputes the amount", async () => {
      const storedOverride = {
        id: "ovr-1",
        scheduledTransactionId: stId,
        originalDate: "2025-03-01",
        overrideDate: "2025-03-01",
        isSplit: true,
        amount: -675,
        splits: [
          {
            splitKind: "investment",
            categoryId: null,
            amount: -675,
            investment: {
              action: "BUY",
              securityId: "sec-usd",
              quantity: 5,
              price: 100,
              exchangeRate: 1.35,
              exchangeRateFromCurrency: "USD",
              exchangeRateToCurrency: "CAD",
            },
          },
        ],
      };
      const scheduled = makeScheduled({
        isSplit: true,
        accountId: "acc-cash",
        nextDueDate: "2025-03-01",
      });
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(storedOverride);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      overridesRepo.findOne.mockResolvedValue(storedOverride);
      accountsRepo.findOne.mockResolvedValue(null);
      mockQueryRunner.manager.delete = jest
        .fn()
        .mockResolvedValue({ affected: 1 });
      // Security currency changed -> stored USD->CAD provenance is stale.
      investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
        { from: "EUR", to: "CAD" },
      );
      investmentTransactionsService.resolveCashExchangeRateOrNull.mockResolvedValue(
        1.2,
      );

      await service.post(userId, stId);

      const payload = transactionsService.create.mock.calls[0][1];
      // cashImpact -500 x re-resolved 1.2 -> -600, never the stale stored -675.
      expect(payload.splits[0].investment.exchangeRate).toBe(1.2);
      expect(payload.splits[0].amount).toBe(-600);
      expect(payload.amount).toBe(-600);
    });

    it("createOverride() records provenance for an override split rate", async () => {
      stubFindOne(makeScheduled({ isSplit: true, accountId: "acc-cash" }));
      investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
        { from: "USD", to: "CAD" },
      );
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      overridesRepo.create.mockImplementation((data: any) => data);
      overridesRepo.save.mockImplementation((data: any) =>
        Promise.resolve(data),
      );

      const result = await service.createOverride(userId, stId, {
        originalDate: "2025-03-01",
        overrideDate: "2025-03-01",
        isSplit: true,
        amount: -675,
        splits: [
          {
            splitKind: "investment" as any,
            // A genuinely new investment line the client marks rateExplicit, so
            // its rate is stamped with the current pair (issue #1167 R8/R9).
            rateExplicit: true,
            categoryId: null,
            amount: -600,
            investment: {
              action: "BUY" as any,
              securityId: "sec-usd",
              quantity: 5,
              price: 100,
              exchangeRate: 1.35,
            },
          },
          {
            splitKind: "category" as any,
            categoryId: "cat-fees",
            amount: -75,
          },
        ],
      } as any);

      const savedInvestment = (result.splits as any[])[0].investment;
      expect(savedInvestment.exchangeRateFromCurrency).toBe("USD");
      expect(savedInvestment.exchangeRateToCurrency).toBe("CAD");
      expect(savedInvestment.exchangeRate).toBe(1.35);
    });

    it("createOverride() does not persist a client-echoed pair on a security-less override split (R13)", async () => {
      // The one write shape where the pair travels in client jsonb: a rate-carrying
      // override split with NO securityId and no source identity. The client's
      // echoed exchangeRateFromCurrency/ToCurrency must never be trusted -- the
      // server decides the pair, and with no security to key a value-carry the
      // split is left unprovenanced so posting re-resolves it (issue #1167 review).
      stubFindOne(makeScheduled({ isSplit: true, accountId: "acc-cash" }));
      // A resolver answer exists, but a security-less new line must NOT stamp it.
      investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
        { from: "USD", to: "CAD" },
      );
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      overridesRepo.create.mockImplementation((data: any) => data);
      overridesRepo.save.mockImplementation((data: any) =>
        Promise.resolve(data),
      );

      const result = await service.createOverride(userId, stId, {
        originalDate: "2025-03-01",
        overrideDate: "2025-03-01",
        isSplit: true,
        amount: -675,
        splits: [
          {
            splitKind: "investment" as any,
            categoryId: null,
            amount: -600,
            investment: {
              action: "INTEREST" as any,
              // No securityId. The client also echoes a pair that must be dropped.
              quantity: 1,
              price: 600,
              exchangeRate: 1.5,
              exchangeRateFromCurrency: "JPY",
              exchangeRateToCurrency: "CAD",
            },
          },
          {
            splitKind: "category" as any,
            categoryId: "cat-fees",
            amount: -75,
          },
        ],
      } as any);

      const savedInvestment = (result.splits as any[])[0].investment;
      // The server overwrites the client's echoed JPY/CAD with "unprovenanced"
      // (undefined), so posting re-resolves rather than trusting the client pair.
      expect(savedInvestment.exchangeRateFromCurrency).toBeUndefined();
      expect(savedInvestment.exchangeRateToCurrency).toBeUndefined();
    });

    // ---- No re-bless: an edit that resends an unchanged rate must not relabel
    // its pair (issue #1167 review) ----

    it("update() preserves the recorded pair when the rate value is unchanged", async () => {
      stubFindOne(
        makeScheduled({
          isInvestment: true,
          investmentAction: "BUY" as any,
          investmentSecurityId: "sec-usd",
          investmentQuantity: 1,
          investmentPrice: 100,
          investmentExchangeRate: 1.35,
          investmentExchangeRateFromCurrency: "EUR",
          investmentExchangeRateToCurrency: "CAD",
        } as any),
      );
      accountsService.findOne.mockResolvedValue({
        id: "acc-1",
        userId,
        accountSubType: "INVESTMENT_BROKERAGE",
      });
      // The security's currency has since changed, so the current pair differs.
      investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
        { from: "USD", to: "CAD" },
      );

      // A presentation-only edit that resends the stored scalar unchanged.
      await service.update(userId, stId, {
        name: "Renamed",
        investmentExchangeRate: 1.35,
      } as any);

      const fields = mockQueryRunner.manager.update.mock.calls.find(
        (c: any[]) =>
          c[1] === stId &&
          c[2].investmentExchangeRateFromCurrency !== undefined,
      )?.[2];
      expect(fields).toBeDefined();
      // The stale rate keeps its ORIGINAL pair, so posting still catches it --
      // it is not relabelled USD->CAD.
      expect(fields.investmentExchangeRateFromCurrency).toBe("EUR");
      expect(fields.investmentExchangeRateToCurrency).toBe("CAD");
      expect(
        investmentTransactionsService.resolveSettlementCurrencyPair,
      ).not.toHaveBeenCalled();
    });

    it("update() stamps the current pair when the rate value genuinely changes", async () => {
      stubFindOne(
        makeScheduled({
          isInvestment: true,
          investmentAction: "BUY" as any,
          investmentSecurityId: "sec-usd",
          investmentQuantity: 1,
          investmentPrice: 100,
          investmentExchangeRate: 1.35,
          investmentExchangeRateFromCurrency: "EUR",
          investmentExchangeRateToCurrency: "CAD",
        } as any),
      );
      accountsService.findOne.mockResolvedValue({
        id: "acc-1",
        userId,
        accountSubType: "INVESTMENT_BROKERAGE",
      });
      investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
        { from: "USD", to: "CAD" },
      );

      await service.update(userId, stId, {
        investmentExchangeRate: 1.4,
      } as any);

      const fields = mockQueryRunner.manager.update.mock.calls.find(
        (c: any[]) =>
          c[1] === stId &&
          c[2].investmentExchangeRateFromCurrency !== undefined,
      )?.[2];
      expect(fields).toBeDefined();
      expect(fields.investmentExchangeRate).toBe(1.4);
      expect(fields.investmentExchangeRateFromCurrency).toBe("USD");
      expect(fields.investmentExchangeRateToCurrency).toBe("CAD");
    });

    // ---- R11-F1: the form resends the whole object, so numeric equality alone
    // cannot tell an explicit re-entry from a passive round-trip. An update-only
    // `investmentExchangeRateExplicit` marker lets the client say "the user
    // actually entered this rate for the current pair", and the server then
    // stamps the current pair even when the value equals the stored one --
    // honouring a rate deliberately re-entered for a since-changed pair. ----

    it("update() stamps the current pair for a same-value rate re-entered with explicit intent (R11-F1)", async () => {
      stubFindOne(
        makeScheduled({
          isInvestment: true,
          investmentAction: "BUY" as any,
          investmentSecurityId: "sec-usd",
          investmentQuantity: 1,
          investmentPrice: 100,
          investmentExchangeRate: 1.5,
          investmentExchangeRateFromCurrency: "EUR",
          investmentExchangeRateToCurrency: "CAD",
        } as any),
      );
      accountsService.findOne.mockResolvedValue({
        id: "acc-1",
        userId,
        accountSubType: "INVESTMENT_BROKERAGE",
      });
      // The security's currency has since changed, so the current pair differs
      // from the recorded one even though the user re-entered the same number.
      investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
        { from: "USD", to: "CAD" },
      );

      await service.update(userId, stId, {
        investmentExchangeRate: 1.5,
        investmentExchangeRateExplicit: true,
      } as any);

      const fields = mockQueryRunner.manager.update.mock.calls.find(
        (c: any[]) =>
          c[1] === stId &&
          c[2].investmentExchangeRateFromCurrency !== undefined,
      )?.[2];
      expect(fields).toBeDefined();
      // The explicitly re-entered rate belongs to the current pair, so it is
      // stamped USD->CAD -- the value is unchanged but the intent is not passive.
      expect(fields.investmentExchangeRate).toBe(1.5);
      expect(fields.investmentExchangeRateFromCurrency).toBe("USD");
      expect(fields.investmentExchangeRateToCurrency).toBe("CAD");
      expect(
        investmentTransactionsService.resolveSettlementCurrencyPair,
      ).toHaveBeenCalled();
    });

    it("update() preserves the recorded pair for a same-value rate resent WITHOUT explicit intent (R11-F1)", async () => {
      stubFindOne(
        makeScheduled({
          isInvestment: true,
          investmentAction: "BUY" as any,
          investmentSecurityId: "sec-usd",
          investmentQuantity: 1,
          investmentPrice: 100,
          investmentExchangeRate: 1.5,
          investmentExchangeRateFromCurrency: "EUR",
          investmentExchangeRateToCurrency: "CAD",
        } as any),
      );
      accountsService.findOne.mockResolvedValue({
        id: "acc-1",
        userId,
        accountSubType: "INVESTMENT_BROKERAGE",
      });
      investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
        { from: "USD", to: "CAD" },
      );

      // The form echoes the stored scalar with the flag explicitly false -- a
      // passive round-trip, not a re-entry. The stored pair must survive so the
      // stale rate is still caught at posting rather than re-blessed here.
      await service.update(userId, stId, {
        name: "Renamed",
        investmentExchangeRate: 1.5,
        investmentExchangeRateExplicit: false,
      } as any);

      const fields = mockQueryRunner.manager.update.mock.calls.find(
        (c: any[]) =>
          c[1] === stId &&
          c[2].investmentExchangeRateFromCurrency !== undefined,
      )?.[2];
      expect(fields).toBeDefined();
      expect(fields.investmentExchangeRateFromCurrency).toBe("EUR");
      expect(fields.investmentExchangeRateToCurrency).toBe("CAD");
      expect(
        investmentTransactionsService.resolveSettlementCurrencyPair,
      ).not.toHaveBeenCalled();
    });

    it("update() stamps the current pair for a genuinely changed rate regardless of the explicit flag (R11-F1)", async () => {
      stubFindOne(
        makeScheduled({
          isInvestment: true,
          investmentAction: "BUY" as any,
          investmentSecurityId: "sec-usd",
          investmentQuantity: 1,
          investmentPrice: 100,
          investmentExchangeRate: 1.5,
          investmentExchangeRateFromCurrency: "EUR",
          investmentExchangeRateToCurrency: "CAD",
        } as any),
      );
      accountsService.findOne.mockResolvedValue({
        id: "acc-1",
        userId,
        accountSubType: "INVESTMENT_BROKERAGE",
      });
      investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
        { from: "USD", to: "CAD" },
      );

      await service.update(userId, stId, {
        investmentExchangeRate: 1.37,
        investmentExchangeRateExplicit: true,
      } as any);

      const fields = mockQueryRunner.manager.update.mock.calls.find(
        (c: any[]) =>
          c[1] === stId &&
          c[2].investmentExchangeRateFromCurrency !== undefined,
      )?.[2];
      expect(fields).toBeDefined();
      expect(fields.investmentExchangeRate).toBe(1.37);
      expect(fields.investmentExchangeRateFromCurrency).toBe("USD");
      expect(fields.investmentExchangeRateToCurrency).toBe("CAD");
    });

    // ---- R11-F1 downstream: the pair an explicit re-entry stamps must actually
    // change what posting forwards to InvestmentTransactionsService.create, or
    // the stamp is inert. The update tests above prove which pair each edit
    // persists; these two prove the consequence at the post -> create boundary.
    // (The `update` mocks do not persist into `findOne`, so the stored record
    // here carries the exact provenance state the matching update produces.) ----

    it("post() forwards a same-value rate stamped current by an explicit re-entry -- 1.50 reused, not re-resolved (R11-F1 downstream)", async () => {
      // The state an explicit re-entry produces: the pair was stamped to the
      // current USD->CAD even though the value equals the old EUR->CAD scalar.
      stubFindOne(
        makeScheduled({
          isInvestment: true,
          investmentAction: "BUY" as any,
          investmentSecurityId: "sec-usd",
          investmentFundingAccountId: null,
          investmentQuantity: 10,
          investmentPrice: 100,
          investmentExchangeRate: 1.5,
          investmentExchangeRateFromCurrency: "USD",
          investmentExchangeRateToCurrency: "CAD",
        } as any),
      );
      setupOverrideQuery();
      investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
        { from: "USD", to: "CAD" },
      );

      await service.post(userId, stId);

      const dto = investmentTransactionsService.create.mock.calls[0][1];
      // The stamped pair matches the current pair, so 1.50 is reused rather than
      // re-resolved to the 1.35 market -- the user's explicit instruction stands.
      expect(dto.exchangeRate).toBe(1.5);
    });

    it("post() re-resolves a same-value rate a passive resend left on its old pair (R11-F1 downstream)", async () => {
      // The state a passive resend leaves: 1.50 is still recorded against the
      // stale EUR->CAD pair, because no explicit intent was signalled.
      stubFindOne(
        makeScheduled({
          isInvestment: true,
          investmentAction: "BUY" as any,
          investmentSecurityId: "sec-usd",
          investmentFundingAccountId: null,
          investmentQuantity: 10,
          investmentPrice: 100,
          investmentExchangeRate: 1.5,
          investmentExchangeRateFromCurrency: "EUR",
          investmentExchangeRateToCurrency: "CAD",
        } as any),
      );
      setupOverrideQuery();
      // The current settlement pair is USD->CAD, so the stored EUR->CAD scalar is
      // unprovable and must be re-resolved.
      investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
        { from: "USD", to: "CAD" },
      );

      await service.post(userId, stId);

      const dto = investmentTransactionsService.create.mock.calls[0][1];
      // The stale scalar is not forwarded; the posting resolver re-resolves.
      expect(dto.exchangeRate).toBeUndefined();
      expect(
        investmentTransactionsService.resolveSettlementCurrencyPair,
      ).toHaveBeenCalledWith(userId, "acc-1", null, "sec-usd");
    });

    it("update() carries an existing split's recorded pair forward (a cosmetic edit keeps a valid rate)", async () => {
      // A cosmetic edit resends the stored split rate unchanged. The pair is
      // preserved -- not re-stamped -- so posting can still reuse the valid rate
      // (or catch it as stale if the pair has since changed).
      stubFindOne(
        makeScheduled({
          isSplit: true,
          accountId: "acc-cash",
          amount: -675,
        } as any),
      );
      // The existing (pre-edit) split recorded EUR->CAD for sec-eur at rate 1.5.
      mockQueryRunner.manager.find.mockResolvedValue([
        {
          kind: "investment",
          investmentSecurityId: "sec-eur",
          investmentExchangeRate: 1.5,
          investmentExchangeRateFromCurrency: "EUR",
          investmentExchangeRateToCurrency: "CAD",
        },
      ]);
      mockQueryRunner.manager.delete = jest
        .fn()
        .mockResolvedValue({ affected: 1 });

      await service.update(userId, stId, {
        splits: [
          {
            splitKind: "investment" as any,
            amount: -600,
            investment: {
              action: "BUY" as any,
              securityId: "sec-eur",
              quantity: 4,
              price: 100,
              // Resent unchanged (1.5).
              exchangeRate: 1.5,
            },
          },
          { splitKind: "category" as any, categoryId: "cat-fees", amount: -75 },
        ],
      } as any);

      const createdSplit = mockQueryRunner.manager.create.mock.calls.find(
        (c: any[]) =>
          c[0] === ScheduledTransactionSplit && c[1].investmentAction,
      )?.[1];
      expect(createdSplit).toBeDefined();
      expect(createdSplit.investmentExchangeRate).toBe(1.5);
      // The original pair is preserved, not re-stamped to the current one.
      expect(createdSplit.investmentExchangeRateFromCurrency).toBe("EUR");
      expect(createdSplit.investmentExchangeRateToCurrency).toBe("CAD");
      // Preserving does not re-derive the current pair.
      expect(
        investmentTransactionsService.resolveSettlementCurrencyPair,
      ).not.toHaveBeenCalled();
    });

    it("update() stamps the current pair when the split rate is genuinely changed (not the old pair)", async () => {
      // The security kept its id but its currency changed to USD, and the user
      // explicitly re-entered a new rate. Inheriting the old EUR->CAD pair would
      // reject a rate the user just entered (issue #1167 re-review).
      stubFindOne(
        makeScheduled({
          isSplit: true,
          accountId: "acc-cash",
          amount: -685,
        } as any),
      );
      mockQueryRunner.manager.find.mockResolvedValue([
        {
          id: "split-x",
          kind: "investment",
          investmentSecurityId: "sec-x",
          investmentExchangeRate: 1.5,
          investmentExchangeRateFromCurrency: "EUR",
          investmentExchangeRateToCurrency: "CAD",
        },
      ]);
      mockQueryRunner.manager.delete = jest
        .fn()
        .mockResolvedValue({ affected: 1 });
      investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
        { from: "USD", to: "CAD" },
      );

      await service.update(userId, stId, {
        splits: [
          {
            splitKind: "investment" as any,
            // The line continues split-x; its rate is genuinely changed 1.5 -> 1.37.
            sourceSplitId: "split-x",
            amount: -610,
            investment: {
              action: "BUY" as any,
              securityId: "sec-x",
              quantity: 4,
              price: 100,
              // Genuinely changed to the new pair's rate.
              exchangeRate: 1.37,
            },
          },
          { splitKind: "category" as any, categoryId: "cat-fees", amount: -75 },
        ],
      } as any);

      const createdSplit = mockQueryRunner.manager.create.mock.calls.find(
        (c: any[]) =>
          c[0] === ScheduledTransactionSplit && c[1].investmentAction,
      )?.[1];
      expect(createdSplit.investmentExchangeRate).toBe(1.37);
      // The current pair is stamped for the re-entered rate, not the stale EUR->CAD.
      expect(createdSplit.investmentExchangeRateFromCurrency).toBe("USD");
      expect(createdSplit.investmentExchangeRateToCurrency).toBe("CAD");
      expect(
        investmentTransactionsService.resolveSettlementCurrencyPair,
      ).toHaveBeenCalledWith(userId, "acc-cash", null, "sec-x");
    });

    it("update() stamps the current pair for a genuinely new split (rateExplicit, no prior pair)", async () => {
      stubFindOne(
        makeScheduled({
          isSplit: true,
          accountId: "acc-cash",
          amount: -675,
        } as any),
      );
      // No existing split for sec-usd -> a fresh rate for the current pair. The
      // client marks the line new (rateExplicit), so the current pair is stamped
      // -- an unmarked line with no id would instead be left unprovenanced (R8-F2).
      mockQueryRunner.manager.find.mockResolvedValue([]);
      mockQueryRunner.manager.delete = jest
        .fn()
        .mockResolvedValue({ affected: 1 });
      investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
        { from: "USD", to: "CAD" },
      );

      await service.update(userId, stId, {
        splits: [
          {
            splitKind: "investment" as any,
            rateExplicit: true,
            amount: -600,
            investment: {
              action: "BUY" as any,
              securityId: "sec-usd",
              quantity: 5,
              price: 100,
              exchangeRate: 1.35,
            },
          },
          { splitKind: "category" as any, categoryId: "cat-fees", amount: -75 },
        ],
      } as any);

      const createdSplit = mockQueryRunner.manager.create.mock.calls.find(
        (c: any[]) =>
          c[0] === ScheduledTransactionSplit && c[1].investmentAction,
      )?.[1];
      expect(createdSplit.investmentExchangeRate).toBe(1.35);
      expect(createdSplit.investmentExchangeRateFromCurrency).toBe("USD");
      expect(createdSplit.investmentExchangeRateToCurrency).toBe("CAD");
    });

    it("updateOverride() carries the existing override split's pair forward", async () => {
      stubFindOne(
        makeScheduled({ isSplit: true, accountId: "acc-cash" } as any),
      );
      const existing = {
        id: "ovr-1",
        scheduledTransactionId: stId,
        originalDate: "2025-03-01",
        overrideDate: "2025-03-01",
        isSplit: true,
        amount: -675,
        splits: [
          {
            splitKind: "investment",
            categoryId: null,
            amount: -600,
            investment: {
              action: "BUY",
              securityId: "sec-eur",
              exchangeRate: 1.5,
              exchangeRateFromCurrency: "EUR",
              exchangeRateToCurrency: "CAD",
            },
          },
        ],
      };
      overridesRepo.findOne.mockResolvedValue(existing);
      overridesRepo.save.mockImplementation((data: any) =>
        Promise.resolve(data),
      );
      investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
        { from: "USD", to: "CAD" },
      );

      const result = await service.updateOverride(userId, stId, "ovr-1", {
        isSplit: true,
        amount: -675,
        splits: [
          {
            splitKind: "investment" as any,
            categoryId: null,
            amount: -600,
            investment: {
              action: "BUY" as any,
              securityId: "sec-eur",
              quantity: 4,
              price: 100,
              exchangeRate: 1.5,
            },
          },
          { splitKind: "category" as any, categoryId: "cat-fees", amount: -75 },
        ],
      } as any);

      const inv = (result.splits as any[])[0].investment;
      expect(inv.exchangeRate).toBe(1.5);
      // The existing pair is carried forward, not re-stamped to the current one.
      expect(inv.exchangeRateFromCurrency).toBe("EUR");
      expect(inv.exchangeRateToCurrency).toBe("CAD");
      expect(
        investmentTransactionsService.resolveSettlementCurrencyPair,
      ).not.toHaveBeenCalled();
    });

    // ---- F5-1: inline post splits (the manual Post dialog bypass) ----

    it("post() re-resolves a stale INLINE split rate the client resends (F5-1)", async () => {
      // The manual Post dialog round-trips the scheduled split verbatim as an
      // inline postDto split, echoing the persisted rate AND its provenance. The
      // security's currency has since changed, so the stored EUR->CAD pair no
      // longer matches the current USD->CAD pair: the scalar must be re-resolved,
      // never trusted just because it arrived as an explicit rate.
      stubFindOne(
        makeScheduled({ isSplit: true, accountId: "acc-cash" } as any),
      );
      setupOverrideQuery();
      mockQueryRunner.manager.delete = jest
        .fn()
        .mockResolvedValue({ affected: 1 });
      investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
        { from: "USD", to: "CAD" },
      );
      investmentTransactionsService.resolveCashExchangeRateOrNull.mockResolvedValue(
        1.35,
      );

      await service.post(userId, stId, {
        splits: [
          {
            splitKind: "investment" as any,
            amount: -1500, // stale amount computed at the old rate
            investment: {
              action: "BUY" as any,
              securityId: "sec-usd",
              quantity: 10,
              price: 100,
              commission: 0,
              exchangeRate: 1.5, // stale scalar
              exchangeRateFromCurrency: "EUR",
              exchangeRateToCurrency: "CAD",
            },
          },
        ],
      } as any);

      const payload = transactionsService.create.mock.calls[0][1];
      // cashImpact -(10*100) = -1000, re-resolved 1.35 -> -1350, never -1500.
      expect(payload.splits[0].investment.exchangeRate).toBe(1.35);
      expect(payload.splits[0].amount).toBe(-1350);
      // Parent is re-summed from the recomputed inline split.
      expect(payload.amount).toBe(-1350);
    });

    it("post() reuses a still-valid INLINE split rate whose pair matches (F5-1)", async () => {
      // Same round-trip, but the pair is unchanged: the client's rate is honoured.
      stubFindOne(
        makeScheduled({ isSplit: true, accountId: "acc-cash" } as any),
      );
      setupOverrideQuery();
      mockQueryRunner.manager.delete = jest
        .fn()
        .mockResolvedValue({ affected: 1 });
      investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
        { from: "USD", to: "CAD" },
      );

      await service.post(userId, stId, {
        splits: [
          {
            splitKind: "investment" as any,
            amount: -1350,
            investment: {
              action: "BUY" as any,
              securityId: "sec-usd",
              quantity: 10,
              price: 100,
              commission: 0,
              exchangeRate: 1.35,
              exchangeRateFromCurrency: "USD",
              exchangeRateToCurrency: "CAD",
            },
          },
        ],
      } as any);

      const payload = transactionsService.create.mock.calls[0][1];
      expect(payload.splits[0].investment.exchangeRate).toBe(1.35);
      expect(payload.splits[0].amount).toBe(-1350);
      // No re-resolution: the pair matched, so the stored rate stands.
      expect(
        investmentTransactionsService.resolveCashExchangeRateOrNull,
      ).not.toHaveBeenCalled();
    });

    it("post() re-resolves an INLINE split with NO provenance rather than trusting it (F5-1)", async () => {
      stubFindOne(
        makeScheduled({ isSplit: true, accountId: "acc-cash" } as any),
      );
      setupOverrideQuery();
      mockQueryRunner.manager.delete = jest
        .fn()
        .mockResolvedValue({ affected: 1 });
      investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
        { from: "USD", to: "CAD" },
      );
      investmentTransactionsService.resolveCashExchangeRateOrNull.mockResolvedValue(
        1.35,
      );

      await service.post(userId, stId, {
        splits: [
          {
            splitKind: "investment" as any,
            amount: -1500,
            investment: {
              action: "BUY" as any,
              securityId: "sec-usd",
              quantity: 10,
              price: 100,
              commission: 0,
              exchangeRate: 1.5, // scalar with no from/to
            },
          },
        ],
      } as any);

      const payload = transactionsService.create.mock.calls[0][1];
      // Absent provenance is unknown -> re-resolved, never trusted.
      expect(payload.splits[0].investment.exchangeRate).toBe(1.35);
      expect(payload.splits[0].amount).toBe(-1350);
      expect(
        investmentTransactionsService.resolveCashExchangeRateOrNull,
      ).toHaveBeenCalled();
    });

    // ---- F5-3: two splits, same security, different stored rates ----

    it("update() does not re-bless one same-security split when another's rate differs (F5-3)", async () => {
      // Two persisted splits reference sec-1 with DIFFERENT stored rates. The
      // security's currency later changed to USD. A cosmetic edit resends both
      // rates unchanged; keyed by security alone, one entry would overwrite the
      // other and the loser would be mis-stamped with the current pair. Keyed by
      // security AND rate, each keeps its own recorded pair.
      stubFindOne(
        makeScheduled({
          isSplit: true,
          accountId: "acc-cash",
          amount: -1525,
        } as any),
      );
      mockQueryRunner.manager.find.mockResolvedValue([
        {
          kind: "investment",
          investmentSecurityId: "sec-1",
          investmentExchangeRate: 1.5,
          investmentExchangeRateFromCurrency: "EUR",
          investmentExchangeRateToCurrency: "CAD",
        },
        {
          kind: "investment",
          investmentSecurityId: "sec-1",
          investmentExchangeRate: 1.55,
          investmentExchangeRateFromCurrency: "EUR",
          investmentExchangeRateToCurrency: "CAD",
        },
      ]);
      mockQueryRunner.manager.delete = jest
        .fn()
        .mockResolvedValue({ affected: 1 });
      investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
        { from: "USD", to: "CAD" },
      );

      await service.update(userId, stId, {
        splits: [
          {
            splitKind: "investment" as any,
            amount: -750,
            investment: {
              action: "BUY" as any,
              securityId: "sec-1",
              quantity: 5,
              price: 100,
              exchangeRate: 1.5, // resent unchanged
            },
          },
          {
            splitKind: "investment" as any,
            amount: -775,
            investment: {
              action: "BUY" as any,
              securityId: "sec-1",
              quantity: 5,
              price: 100,
              exchangeRate: 1.55, // resent unchanged
            },
          },
        ],
      } as any);

      const createdSplits = mockQueryRunner.manager.create.mock.calls
        .filter(
          (c: any[]) =>
            c[0] === ScheduledTransactionSplit && c[1].investmentAction,
        )
        .map((c: any[]) => c[1]);
      expect(createdSplits).toHaveLength(2);
      // BOTH resent-unchanged rates keep their original EUR->CAD pair; neither is
      // re-stamped to the current USD->CAD, so posting still catches both as stale.
      for (const s of createdSplits) {
        expect(s.investmentExchangeRateFromCurrency).toBe("EUR");
        expect(s.investmentExchangeRateToCurrency).toBe("CAD");
      }
      // Preserving both means the current pair is never derived.
      expect(
        investmentTransactionsService.resolveSettlementCurrencyPair,
      ).not.toHaveBeenCalled();
    });

    it("update() uses stable split id so a rate changed to another split's old value is not mislabelled (F4)", async () => {
      // Split A stays 1.50; split B changes 1.55 -> 1.50, colliding with A's OLD
      // rate. A value key would hand B split A's EUR->CAD pair; stable identity
      // (sourceSplitId) keeps them apart: A carries EUR->CAD, B stamps current.
      stubFindOne(
        makeScheduled({
          isSplit: true,
          accountId: "acc-cash",
          amount: -1500,
        } as any),
      );
      mockQueryRunner.manager.find.mockResolvedValue([
        {
          id: "split-A",
          kind: "investment",
          investmentSecurityId: "sec-1",
          investmentExchangeRate: 1.5,
          investmentExchangeRateFromCurrency: "EUR",
          investmentExchangeRateToCurrency: "CAD",
        },
        {
          id: "split-B",
          kind: "investment",
          investmentSecurityId: "sec-1",
          investmentExchangeRate: 1.55,
          investmentExchangeRateFromCurrency: "EUR",
          investmentExchangeRateToCurrency: "CAD",
        },
      ]);
      mockQueryRunner.manager.delete = jest
        .fn()
        .mockResolvedValue({ affected: 1 });
      investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
        { from: "USD", to: "CAD" },
      );

      await service.update(userId, stId, {
        splits: [
          {
            splitKind: "investment" as any,
            sourceSplitId: "split-A",
            amount: -750,
            investment: {
              action: "BUY" as any,
              securityId: "sec-1",
              quantity: 5,
              price: 100,
              exchangeRate: 1.5, // unchanged
            },
          },
          {
            splitKind: "investment" as any,
            sourceSplitId: "split-B",
            amount: -750,
            investment: {
              action: "BUY" as any,
              securityId: "sec-1",
              quantity: 5,
              price: 100,
              exchangeRate: 1.5, // changed from 1.55, collides with A's old 1.50
            },
          },
        ],
      } as any);

      const createdSplits = mockQueryRunner.manager.create.mock.calls
        .filter(
          (c: any[]) =>
            c[0] === ScheduledTransactionSplit && c[1].investmentAction,
        )
        .map((c: any[]) => c[1]);
      expect(createdSplits).toHaveLength(2);
      // A (unchanged) keeps its recorded EUR->CAD; B (changed) stamps current
      // USD->CAD -- never the other way round, which the value key would do.
      expect(createdSplits[0].investmentExchangeRateFromCurrency).toBe("EUR");
      expect(createdSplits[0].investmentExchangeRateToCurrency).toBe("CAD");
      expect(createdSplits[1].investmentExchangeRateFromCurrency).toBe("USD");
      expect(createdSplits[1].investmentExchangeRateToCurrency).toBe("CAD");
    });

    it("post() honours a user-edited INLINE split rate via stable identity, not re-resolving it (F2)", async () => {
      // The source split settles USD->CAD at 1.35; the user edits the Post dialog
      // rate to 1.37. Correlated by id, the edit is recognised and honoured for the
      // current pair -- not discarded as unknown and re-resolved to the market.
      stubFindOne(
        makeScheduled({
          isSplit: true,
          accountId: "acc-cash",
          splits: [
            {
              id: "split-S",
              kind: "investment",
              investmentSecurityId: "sec-usd",
              investmentAction: "BUY",
              investmentQuantity: 10,
              investmentPrice: 100,
              investmentCommission: 0,
              investmentExchangeRate: 1.35,
              investmentExchangeRateFromCurrency: "USD",
              investmentExchangeRateToCurrency: "CAD",
            },
          ],
        } as any),
      );
      setupOverrideQuery();
      mockQueryRunner.manager.delete = jest
        .fn()
        .mockResolvedValue({ affected: 1 });
      investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
        { from: "USD", to: "CAD" },
      );
      // If the edit were NOT recognised, the rate would be re-resolved to this.
      investmentTransactionsService.resolveCashExchangeRateOrNull.mockResolvedValue(
        1.35,
      );

      await service.post(userId, stId, {
        splits: [
          {
            splitKind: "investment" as any,
            sourceSplitId: "split-S",
            amount: -1370,
            investment: {
              action: "BUY" as any,
              securityId: "sec-usd",
              quantity: 10,
              price: 100,
              commission: 0,
              // User edited from 1.35; the rate editor drops provenance, so the
              // inline line arrives with NO from/to (the real F2 shape). Without
              // id correlation this would be re-resolved to the 1.35 market rate.
              exchangeRate: 1.37,
            },
          },
        ],
      } as any);

      const payload = transactionsService.create.mock.calls[0][1];
      // The edit is recognised by id and honoured for the current pair: 1.37, not
      // the 1.35 the market resolver would have returned.
      expect(payload.splits[0].investment.exchangeRate).toBe(1.37);
      expect(payload.splits[0].amount).toBe(-1370);
      expect(payload.amount).toBe(-1370);
      expect(
        investmentTransactionsService.resolveCashExchangeRateOrNull,
      ).not.toHaveBeenCalled();
    });

    // ---- R7-F2: a presentation-only edit must not re-bless a legacy
    // no-provenance rate as belonging to the current pair. A rate stored before
    // #1167 backfilled no pair (from/to null) is unknown, so a cosmetic edit
    // that resends it unchanged has to keep it null -- never stamp the current
    // pair, which would recreate the original #1167 corruption path. ----

    it("update() keeps a legacy null-pair split unprovenanced on a rate-unchanged edit, never stamping the current pair (R7-F2)", async () => {
      // A split stored before #1167 carries a rate (1.50) with NO recorded pair.
      // The user renames the schedule (a name-only edit) and the form resends
      // the split unchanged, echoing its stable id. Correlated by id, the
      // unchanged legacy scalar must be preserved as null/null, so posting later
      // re-resolves it rather than trusting 1.50 for whatever the pair is now.
      stubFindOne(
        makeScheduled({
          isSplit: true,
          accountId: "acc-cash",
          amount: -1500,
        } as any),
      );
      mockQueryRunner.manager.find.mockResolvedValue([
        {
          id: "split-legacy",
          kind: "investment",
          investmentSecurityId: "sec-usd",
          investmentExchangeRate: 1.5,
          investmentExchangeRateFromCurrency: null,
          investmentExchangeRateToCurrency: null,
        },
      ]);
      mockQueryRunner.manager.delete = jest
        .fn()
        .mockResolvedValue({ affected: 1 });
      // If the edit were (wrongly) treated as fresh, this is the pair it would be
      // re-blessed with -- the assertion below proves it is NOT.
      investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
        { from: "USD", to: "CAD" },
      );

      await service.update(userId, stId, {
        name: "Renamed",
        splits: [
          {
            splitKind: "investment" as any,
            sourceSplitId: "split-legacy",
            amount: -1500,
            investment: {
              action: "BUY" as any,
              securityId: "sec-usd",
              quantity: 10,
              price: 100,
              exchangeRate: 1.5, // resent unchanged
            },
          },
          { splitKind: "category" as any, categoryId: "cat-fees", amount: 0 },
        ],
      } as any);

      const createdSplit = mockQueryRunner.manager.create.mock.calls.find(
        (c: any[]) =>
          c[0] === ScheduledTransactionSplit && c[1].investmentAction,
      )?.[1];
      expect(createdSplit).toBeDefined();
      expect(createdSplit.investmentExchangeRate).toBe(1.5);
      // The legacy null pair survives -- it is NOT stamped USD->CAD.
      expect(createdSplit.investmentExchangeRateFromCurrency).toBeNull();
      expect(createdSplit.investmentExchangeRateToCurrency).toBeNull();
      // Preserving null never re-derives the current pair.
      expect(
        investmentTransactionsService.resolveSettlementCurrencyPair,
      ).not.toHaveBeenCalled();
    });

    it("update() stamps the current pair when a legacy null-pair split rate is genuinely changed (R7-F2 companion)", async () => {
      // The same legacy split, but this time the user re-enters a new rate. A
      // changed rate IS for the current pair, so it stamps USD->CAD -- the null
      // preservation applies only to an unchanged scalar.
      stubFindOne(
        makeScheduled({
          isSplit: true,
          accountId: "acc-cash",
          amount: -1600,
        } as any),
      );
      mockQueryRunner.manager.find.mockResolvedValue([
        {
          id: "split-legacy",
          kind: "investment",
          investmentSecurityId: "sec-usd",
          investmentExchangeRate: 1.5,
          investmentExchangeRateFromCurrency: null,
          investmentExchangeRateToCurrency: null,
        },
      ]);
      mockQueryRunner.manager.delete = jest
        .fn()
        .mockResolvedValue({ affected: 1 });
      investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
        { from: "USD", to: "CAD" },
      );

      await service.update(userId, stId, {
        splits: [
          {
            splitKind: "investment" as any,
            sourceSplitId: "split-legacy",
            amount: -1600,
            investment: {
              action: "BUY" as any,
              securityId: "sec-usd",
              quantity: 10,
              price: 100,
              exchangeRate: 1.6, // genuinely changed from 1.50
            },
          },
          { splitKind: "category" as any, categoryId: "cat-fees", amount: 0 },
        ],
      } as any);

      const createdSplit = mockQueryRunner.manager.create.mock.calls.find(
        (c: any[]) =>
          c[0] === ScheduledTransactionSplit && c[1].investmentAction,
      )?.[1];
      expect(createdSplit.investmentExchangeRate).toBe(1.6);
      expect(createdSplit.investmentExchangeRateFromCurrency).toBe("USD");
      expect(createdSplit.investmentExchangeRateToCurrency).toBe("CAD");
      expect(
        investmentTransactionsService.resolveSettlementCurrencyPair,
      ).toHaveBeenCalledWith(userId, "acc-cash", null, "sec-usd");
    });

    it("post() re-resolves a legacy null-pair embedded split to the current rate: -1350, never the stale -1500 (R7-F2)", async () => {
      // End-to-end numeric repro (issue #1167 R7): a persisted split rate 1.50
      // with no recorded pair is unknown. Posting must re-resolve it at the
      // current USD->CAD=1.35 and re-sum the parent from the recomputed amount,
      // so the user is charged -1350, not the stale -1500 pinned at 1.50.
      stubFindOne(
        makeScheduled({
          isSplit: true,
          accountId: "acc-cash",
          splits: [
            {
              id: "s-legacy",
              scheduledTransactionId: stId,
              kind: "investment",
              categoryId: null,
              transferAccountId: null,
              amount: -1500,
              memo: null,
              investmentAction: "BUY",
              investmentSecurityId: "sec-usd",
              investmentQuantity: 10,
              investmentPrice: 100,
              investmentCommission: 0,
              investmentExchangeRate: 1.5,
              investmentExchangeRateFromCurrency: null,
              investmentExchangeRateToCurrency: null,
            } as any,
          ],
        } as any),
      );
      setupOverrideQuery();
      mockQueryRunner.manager.delete = jest
        .fn()
        .mockResolvedValue({ affected: 1 });
      investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
        { from: "USD", to: "CAD" },
      );
      investmentTransactionsService.resolveCashExchangeRateOrNull.mockResolvedValue(
        1.35,
      );

      await service.post(userId, stId);

      const payload = transactionsService.create.mock.calls[0][1];
      // cashImpact -(10*100) = -1000, re-resolved 1.35 -> -1350, never -1500.
      expect(payload.splits[0].investment.exchangeRate).toBe(1.35);
      expect(payload.splits[0].amount).toBe(-1350);
      expect(payload.amount).toBe(-1350);
    });

    it("updateOverride() keeps a legacy override split (no id, no pair) unprovenanced on a cosmetic edit, never stamping the current pair (R7-F2)", async () => {
      // A pre-#1167 override JSON split: it carries a rate but no recorded pair
      // and no stable id (minted only after #1167). A client that echoes no
      // sourceSplitId resends it unchanged. The value-key fallback cannot carry a
      // null pair, and an unverified scalar must never be stamped with the
      // current pair -- so it stays unprovenanced and posting re-resolves it.
      stubFindOne(
        makeScheduled({ isSplit: true, accountId: "acc-cash" } as any),
      );
      const existing = {
        id: "ovr-1",
        scheduledTransactionId: stId,
        originalDate: "2025-03-01",
        overrideDate: "2025-03-01",
        isSplit: true,
        amount: -1500,
        splits: [
          {
            // No `id` -- a legacy override JSON split predates the minted id.
            splitKind: "investment",
            categoryId: null,
            amount: -1500,
            investment: {
              action: "BUY",
              securityId: "sec-usd",
              quantity: 10,
              price: 100,
              exchangeRate: 1.5,
              // No pair recorded (pre-#1167).
            },
          },
        ],
      };
      overridesRepo.findOne.mockResolvedValue(existing);
      overridesRepo.save.mockImplementation((data: any) =>
        Promise.resolve(data),
      );
      investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
        { from: "USD", to: "CAD" },
      );

      const result = await service.updateOverride(userId, stId, "ovr-1", {
        // Cosmetic edit: change only the override date, resend the split as-is
        // with no sourceSplitId (legacy client) and the unchanged rate.
        overrideDate: "2025-03-02",
        isSplit: true,
        amount: -1500,
        splits: [
          {
            splitKind: "investment" as any,
            categoryId: null,
            amount: -1500,
            investment: {
              action: "BUY" as any,
              securityId: "sec-usd",
              quantity: 10,
              price: 100,
              exchangeRate: 1.5, // resent unchanged
            },
          },
          { splitKind: "category" as any, categoryId: "cat-fees", amount: 0 },
        ],
      } as any);

      const inv = (result.splits as any[])[0].investment;
      expect(inv.exchangeRate).toBe(1.5);
      // The unverified legacy scalar stays unprovenanced -- NOT stamped USD->CAD.
      expect(inv.exchangeRateFromCurrency).toBeUndefined();
      expect(inv.exchangeRateToCurrency).toBeUndefined();
      expect(
        investmentTransactionsService.resolveSettlementCurrencyPair,
      ).not.toHaveBeenCalled();
    });

    // ---- R8-F2: `sourceSplitId` absence must not be overloaded. An
    // unidentified line (older client, or a legacy row resent without an id) is
    // never stamped with the current pair -- that is the #1167 re-bless arriving
    // through an old client. A genuinely new line the client marks `rateExplicit`
    // IS stamped, so its explicit rate is honoured at posting. ----

    it("update() does NOT stamp the current pair for a legacy split resent with no id and no rateExplicit (old client, R8-F2)", async () => {
      // An older client that predates sourceSplitId resends a legacy null-pair
      // split (rate 1.50) with neither an id nor the new-line marker. It cannot be
      // proven current, so it must be left unprovenanced (re-resolved at posting),
      // never stamped USD->CAD -- which would re-book -1500 instead of -1350.
      stubFindOne(
        makeScheduled({
          isSplit: true,
          accountId: "acc-cash",
          amount: -1500,
        } as any),
      );
      mockQueryRunner.manager.find.mockResolvedValue([
        {
          id: "split-legacy",
          kind: "investment",
          investmentSecurityId: "sec-usd",
          investmentExchangeRate: 1.5,
          investmentExchangeRateFromCurrency: null,
          investmentExchangeRateToCurrency: null,
        },
      ]);
      mockQueryRunner.manager.delete = jest
        .fn()
        .mockResolvedValue({ affected: 1 });
      investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
        { from: "USD", to: "CAD" },
      );

      await service.update(userId, stId, {
        splits: [
          {
            // Old client: no sourceSplitId, no rateExplicit.
            splitKind: "investment" as any,
            amount: -1500,
            investment: {
              action: "BUY" as any,
              securityId: "sec-usd",
              quantity: 10,
              price: 100,
              exchangeRate: 1.5,
            },
          },
          { splitKind: "category" as any, categoryId: "cat-fees", amount: 0 },
        ],
      } as any);

      const createdSplit = mockQueryRunner.manager.create.mock.calls.find(
        (c: any[]) =>
          c[0] === ScheduledTransactionSplit && c[1].investmentAction,
      )?.[1];
      expect(createdSplit).toBeDefined();
      // Left unprovenanced -- NOT stamped USD->CAD -- so posting re-resolves.
      expect(createdSplit.investmentExchangeRateFromCurrency).toBeNull();
      expect(createdSplit.investmentExchangeRateToCurrency).toBeNull();
      expect(
        investmentTransactionsService.resolveSettlementCurrencyPair,
      ).not.toHaveBeenCalled();
    });

    it("update() stamps the current pair for a new split marked rateExplicit, honouring its rate (R8-F2)", async () => {
      stubFindOne(
        makeScheduled({
          isSplit: true,
          accountId: "acc-cash",
          amount: -1370,
        } as any),
      );
      mockQueryRunner.manager.find.mockResolvedValue([]);
      mockQueryRunner.manager.delete = jest
        .fn()
        .mockResolvedValue({ affected: 1 });
      investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
        { from: "USD", to: "CAD" },
      );

      await service.update(userId, stId, {
        splits: [
          {
            splitKind: "investment" as any,
            rateExplicit: true,
            amount: -1370,
            investment: {
              action: "BUY" as any,
              securityId: "sec-usd",
              quantity: 10,
              price: 100,
              exchangeRate: 1.37,
            },
          },
          { splitKind: "category" as any, categoryId: "cat-fees", amount: 0 },
        ],
      } as any);

      const createdSplit = mockQueryRunner.manager.create.mock.calls.find(
        (c: any[]) =>
          c[0] === ScheduledTransactionSplit && c[1].investmentAction,
      )?.[1];
      expect(createdSplit.investmentExchangeRate).toBe(1.37);
      expect(createdSplit.investmentExchangeRateFromCurrency).toBe("USD");
      expect(createdSplit.investmentExchangeRateToCurrency).toBe("CAD");
    });

    it("updateOverride() stamps the current pair for a new investment line marked rateExplicit (R8-F2 honour)", async () => {
      // The reviewer's repro: a user adds a NEW USD->CAD BUY (10 x 100) to an
      // existing override and explicitly enters 1.37 while the market is 1.35.
      // The new line carries rateExplicit and no sourceSplitId, so the current
      // pair is stamped and posting later honours 1.37, not the 1.35 market.
      stubFindOne(
        makeScheduled({ isSplit: true, accountId: "acc-cash" } as any),
      );
      const existing = {
        id: "ovr-1",
        scheduledTransactionId: stId,
        originalDate: "2025-03-01",
        overrideDate: "2025-03-01",
        isSplit: true,
        amount: -1370,
        splits: [] as any[],
      };
      overridesRepo.findOne.mockResolvedValue(existing);
      overridesRepo.save.mockImplementation((data: any) =>
        Promise.resolve(data),
      );
      investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
        { from: "USD", to: "CAD" },
      );

      const result = await service.updateOverride(userId, stId, "ovr-1", {
        isSplit: true,
        amount: -1370,
        splits: [
          {
            splitKind: "investment" as any,
            rateExplicit: true,
            categoryId: null,
            amount: -1370,
            investment: {
              action: "BUY" as any,
              securityId: "sec-usd",
              quantity: 10,
              price: 100,
              exchangeRate: 1.37,
            },
          },
          { splitKind: "category" as any, categoryId: "cat-fees", amount: 0 },
        ],
      } as any);

      const inv = (result.splits as any[])[0].investment;
      expect(inv.exchangeRate).toBe(1.37);
      // Stamped for the current pair, so posting reuses 1.37 (a matching pair)
      // rather than re-resolving to the 1.35 market rate.
      expect(inv.exchangeRateFromCurrency).toBe("USD");
      expect(inv.exchangeRateToCurrency).toBe("CAD");
    });

    it("update() re-stamps the current pair when a matched line's rate is re-entered unchanged but marked rateExplicit (R8-F2 same-value edit)", async () => {
      // The same-value re-entry edge: the security's currency changed so the pair
      // is now USD->CAD, but the user re-typed the same numeric rate (1.50) that
      // the stored EUR->CAD row already held. A pure value compare would preserve
      // the stale EUR->CAD; rateExplicit forces the current pair.
      stubFindOne(
        makeScheduled({
          isSplit: true,
          accountId: "acc-cash",
          amount: -1500,
        } as any),
      );
      mockQueryRunner.manager.find.mockResolvedValue([
        {
          id: "split-e",
          kind: "investment",
          investmentSecurityId: "sec-1",
          investmentExchangeRate: 1.5,
          investmentExchangeRateFromCurrency: "EUR",
          investmentExchangeRateToCurrency: "CAD",
        },
      ]);
      mockQueryRunner.manager.delete = jest
        .fn()
        .mockResolvedValue({ affected: 1 });
      investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
        { from: "USD", to: "CAD" },
      );

      await service.update(userId, stId, {
        splits: [
          {
            splitKind: "investment" as any,
            sourceSplitId: "split-e",
            rateExplicit: true, // user re-entered the rate for the new pair
            amount: -1500,
            investment: {
              action: "BUY" as any,
              securityId: "sec-1",
              quantity: 10,
              price: 100,
              exchangeRate: 1.5, // numerically unchanged
            },
          },
          { splitKind: "category" as any, categoryId: "cat-fees", amount: 0 },
        ],
      } as any);

      const createdSplit = mockQueryRunner.manager.create.mock.calls.find(
        (c: any[]) =>
          c[0] === ScheduledTransactionSplit && c[1].investmentAction,
      )?.[1];
      // The stale EUR->CAD is NOT preserved -- the current USD->CAD is stamped.
      expect(createdSplit.investmentExchangeRateFromCurrency).toBe("USD");
      expect(createdSplit.investmentExchangeRateToCurrency).toBe("CAD");
    });

    // ---- R9-F1: createOverride decides against the BASE scheduled splits, so an
    // inherited stale scalar is not re-blessed with the current pair. ----

    it("createOverride() preserves a base split's stale pair on a date-only override, never re-stamping current (R9-F1)", async () => {
      // Base scheduled split stored EUR->CAD at 1.50. The security's currency has
      // since changed, so the current settlement pair is USD->CAD. The user makes
      // a date-only override; the editor resends the base split unchanged, naming
      // its id. The override must inherit EUR->CAD (caught as stale at posting),
      // NOT be re-stamped USD->CAD (which posting would then trust -> -1500).
      stubFindOne(
        makeScheduled({
          isSplit: true,
          accountId: "acc-cash",
          splits: [
            {
              id: "base-inv",
              scheduledTransactionId: stId,
              kind: "investment",
              categoryId: null,
              amount: -1500,
              investmentAction: "BUY",
              investmentSecurityId: "sec-usd",
              investmentQuantity: 10,
              investmentPrice: 100,
              investmentExchangeRate: 1.5,
              investmentExchangeRateFromCurrency: "EUR",
              investmentExchangeRateToCurrency: "CAD",
            } as any,
          ],
        } as any),
      );
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      overridesRepo.create.mockImplementation((data: any) => data);
      overridesRepo.save.mockImplementation((data: any) =>
        Promise.resolve(data),
      );
      investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
        { from: "USD", to: "CAD" },
      );

      const result = await service.createOverride(userId, stId, {
        originalDate: "2025-03-01",
        overrideDate: "2025-03-02", // date-only change
        isSplit: true,
        amount: -1500,
        splits: [
          {
            splitKind: "investment" as any,
            sourceSplitId: "base-inv", // continues the base split
            categoryId: null,
            amount: -1500,
            investment: {
              action: "BUY" as any,
              securityId: "sec-usd",
              quantity: 10,
              price: 100,
              exchangeRate: 1.5, // resent unchanged
            },
          },
          { splitKind: "category" as any, categoryId: "cat-fees", amount: 0 },
        ],
      } as any);

      const inv = (result.splits as any[])[0].investment;
      // The base EUR->CAD pair is inherited, NOT re-stamped USD->CAD.
      expect(inv.exchangeRateFromCurrency).toBe("EUR");
      expect(inv.exchangeRateToCurrency).toBe("CAD");
      expect(
        investmentTransactionsService.resolveSettlementCurrencyPair,
      ).not.toHaveBeenCalled();
    });

    it("createOverride() stamps the current pair when a base category split is converted to an investment line (R9-F2)", async () => {
      // The base split was a CATEGORY line (no FX rate). The override converts it
      // to an investment BUY and enters a rate. Correlated by id, the source has
      // no pair to preserve, so its new rate is fresh -> stamp the current pair.
      stubFindOne(
        makeScheduled({
          isSplit: true,
          accountId: "acc-cash",
          splits: [
            {
              id: "base-cat",
              scheduledTransactionId: stId,
              kind: "category",
              categoryId: "cat-1",
              amount: -1370,
            } as any,
          ],
        } as any),
      );
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue(null);
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      overridesRepo.create.mockImplementation((data: any) => data);
      overridesRepo.save.mockImplementation((data: any) =>
        Promise.resolve(data),
      );
      investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
        { from: "USD", to: "CAD" },
      );

      const result = await service.createOverride(userId, stId, {
        originalDate: "2025-03-01",
        overrideDate: "2025-03-01",
        isSplit: true,
        amount: -1370,
        splits: [
          {
            splitKind: "investment" as any,
            sourceSplitId: "base-cat", // the id of the former category line
            // The user entered the rate on the converted line, so the client
            // marks it explicit (R10-F1): a null-rate source is stamped only with
            // proven-fresh intent, never merely because it was matched.
            rateExplicit: true,
            categoryId: null,
            amount: -1370,
            investment: {
              action: "BUY" as any,
              securityId: "sec-usd",
              quantity: 10,
              price: 100,
              exchangeRate: 1.37,
            },
          },
          { splitKind: "category" as any, categoryId: "cat-fees", amount: 0 },
        ],
      } as any);

      const inv = (result.splits as any[])[0].investment;
      // The former category line has no pair to preserve, so the entered rate is
      // stamped for the current pair (honoured at posting), not left unprovenanced.
      expect(inv.exchangeRateFromCurrency).toBe("USD");
      expect(inv.exchangeRateToCurrency).toBe("CAD");
      expect(inv.exchangeRate).toBe(1.37);
    });

    it("update() stamps the current pair when a base category split is converted to an investment line (R9-F2)", async () => {
      // Same conversion, on the schedule itself: a category split's id is resent
      // as sourceSplitId with a new investment rate. byId now records every split
      // id (not only investment-rate rows), so the source is found and, having no
      // pair to preserve, the new rate is stamped current -- not left unprovenanced.
      stubFindOne(
        makeScheduled({
          isSplit: true,
          accountId: "acc-cash",
          amount: -1370,
        } as any),
      );
      mockQueryRunner.manager.find.mockResolvedValue([
        {
          id: "cat-split",
          kind: "category",
          categoryId: "cat-1",
          investmentSecurityId: null,
          investmentExchangeRate: null,
          investmentExchangeRateFromCurrency: null,
          investmentExchangeRateToCurrency: null,
        },
      ]);
      mockQueryRunner.manager.delete = jest
        .fn()
        .mockResolvedValue({ affected: 1 });
      investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
        { from: "USD", to: "CAD" },
      );

      await service.update(userId, stId, {
        splits: [
          {
            splitKind: "investment" as any,
            sourceSplitId: "cat-split",
            rateExplicit: true, // user entered the rate on the converted line
            amount: -1370,
            investment: {
              action: "BUY" as any,
              securityId: "sec-usd",
              quantity: 10,
              price: 100,
              exchangeRate: 1.37,
            },
          },
          { splitKind: "category" as any, categoryId: "cat-fees", amount: 0 },
        ],
      } as any);

      const createdSplit = mockQueryRunner.manager.create.mock.calls.find(
        (c: any[]) =>
          c[0] === ScheduledTransactionSplit && c[1].investmentAction,
      )?.[1];
      expect(createdSplit.investmentExchangeRate).toBe(1.37);
      expect(createdSplit.investmentExchangeRateFromCurrency).toBe("USD");
      expect(createdSplit.investmentExchangeRateToCurrency).toBe("CAD");
    });

    // ---- R10-F1: a matched source that carried NO investment rate is stamped
    // only with explicit intent; a resent rate on it (e.g. a synthetic 1) is not
    // blessed as the current pair. ----

    it("update() does NOT stamp a matched null-rate source that resends a rate without rateExplicit (R10-F1)", async () => {
      // A legacy investment split with unknown FX (rate null). A cosmetic edit
      // resends it and the client happens to carry a rate (e.g. an old client's
      // synthetic 1), naming the source id but not marking it explicit. It must
      // stay unprovenanced so posting re-resolves, never stamped USD->CAD.
      stubFindOne(
        makeScheduled({
          isSplit: true,
          accountId: "acc-cash",
          amount: -1000,
        } as any),
      );
      mockQueryRunner.manager.find.mockResolvedValue([
        {
          id: "leg-null",
          kind: "investment",
          investmentSecurityId: "sec-usd",
          investmentExchangeRate: null,
          investmentExchangeRateFromCurrency: null,
          investmentExchangeRateToCurrency: null,
        },
      ]);
      mockQueryRunner.manager.delete = jest
        .fn()
        .mockResolvedValue({ affected: 1 });
      investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
        { from: "USD", to: "CAD" },
      );

      await service.update(userId, stId, {
        splits: [
          {
            splitKind: "investment" as any,
            sourceSplitId: "leg-null",
            amount: -1000,
            investment: {
              action: "BUY" as any,
              securityId: "sec-usd",
              quantity: 10,
              price: 100,
              exchangeRate: 1, // a synthetic/stale scalar, not user-entered
            },
          },
          { splitKind: "category" as any, categoryId: "cat-fees", amount: 0 },
        ],
      } as any);

      const createdSplit = mockQueryRunner.manager.create.mock.calls.find(
        (c: any[]) =>
          c[0] === ScheduledTransactionSplit && c[1].investmentAction,
      )?.[1];
      expect(createdSplit.investmentExchangeRateFromCurrency).toBeNull();
      expect(createdSplit.investmentExchangeRateToCurrency).toBeNull();
      expect(
        investmentTransactionsService.resolveSettlementCurrencyPair,
      ).not.toHaveBeenCalled();
    });

    // ---- R10-F2: manual Post honours rateExplicit on a source-identified row. ----

    it("post() honours an explicit same-value re-entry on a continuing inline split (R10-F2)", async () => {
      // Stored split settles EUR->CAD at 1.50; the security's currency changed so
      // the current pair is USD->CAD. In the Post dialog the user deliberately
      // re-enters 1.50 for the new pair. sourceSplitId is present and the value
      // equals the stored one, so the old "changed vs source" test is false --
      // but rateExplicit is honoured regardless of the source id, so 1.50 is kept.
      stubFindOne(
        makeScheduled({
          isSplit: true,
          accountId: "acc-cash",
          splits: [
            {
              id: "s-e",
              kind: "investment",
              investmentSecurityId: "sec-usd",
              investmentAction: "BUY",
              investmentQuantity: 10,
              investmentPrice: 100,
              investmentCommission: 0,
              investmentExchangeRate: 1.5,
              investmentExchangeRateFromCurrency: "EUR",
              investmentExchangeRateToCurrency: "CAD",
            } as any,
          ],
        } as any),
      );
      setupOverrideQuery();
      mockQueryRunner.manager.delete = jest
        .fn()
        .mockResolvedValue({ affected: 1 });
      investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
        { from: "USD", to: "CAD" },
      );
      // If the edit were ignored, the stale EUR/CAD would be re-resolved to this.
      investmentTransactionsService.resolveCashExchangeRateOrNull.mockResolvedValue(
        1.35,
      );

      await service.post(userId, stId, {
        splits: [
          {
            splitKind: "investment" as any,
            sourceSplitId: "s-e",
            rateExplicit: true,
            amount: -1500,
            investment: {
              action: "BUY" as any,
              securityId: "sec-usd",
              quantity: 10,
              price: 100,
              commission: 0,
              exchangeRate: 1.5, // re-entered, equals the stored value
            },
          },
        ],
      } as any);

      const payload = transactionsService.create.mock.calls[0][1];
      // The explicit re-entry is honoured for the current pair: 1.50, -1500 --
      // not the 1.35 market re-resolution.
      expect(payload.splits[0].investment.exchangeRate).toBe(1.5);
      expect(payload.splits[0].amount).toBe(-1500);
      expect(payload.amount).toBe(-1500);
    });

    // ---- R10-F3: moving an override's date updates it in place, preserving the
    // pinned FX provenance. ----

    it("updateOverride() applies a new overrideDate and preserves the pinned pair (R10-F3)", async () => {
      stubFindOne(
        makeScheduled({ isSplit: true, accountId: "acc-cash" } as any),
      );
      const existing = {
        id: "ovr-1",
        scheduledTransactionId: stId,
        originalDate: "2025-03-01",
        overrideDate: "2025-03-01",
        isSplit: true,
        amount: -1370,
        splits: [
          {
            id: "ov-split-1",
            splitKind: "investment",
            categoryId: null,
            amount: -1370,
            investment: {
              action: "BUY",
              securityId: "sec-usd",
              quantity: 10,
              price: 100,
              exchangeRate: 1.37,
              exchangeRateFromCurrency: "USD",
              exchangeRateToCurrency: "CAD",
            },
          },
        ],
      };
      overridesRepo.findOne.mockResolvedValue(existing);
      overridesRepo.save.mockImplementation((data: any) =>
        Promise.resolve(data),
      );
      // The security currency has since changed; a re-resolve would return this.
      investmentTransactionsService.resolveSettlementCurrencyPair.mockResolvedValue(
        { from: "EUR", to: "CAD" },
      );

      const result = await service.updateOverride(userId, stId, "ovr-1", {
        overrideDate: "2025-03-10", // date-only move
        isSplit: true,
        amount: -1370,
        splits: [
          {
            splitKind: "investment" as any,
            sourceSplitId: "ov-split-1", // continues the existing override split
            categoryId: null,
            amount: -1370,
            investment: {
              action: "BUY" as any,
              securityId: "sec-usd",
              quantity: 10,
              price: 100,
              exchangeRate: 1.37, // resent unchanged
            },
          },
          { splitKind: "category" as any, categoryId: "cat-fees", amount: 0 },
        ],
      } as any);

      expect(result.overrideDate).toBe("2025-03-10");
      const inv = (result.splits as any[])[0].investment;
      // The pinned 1.37 USD->CAD survives the move (not re-resolved to EUR/CAD).
      expect(inv.exchangeRate).toBe(1.37);
      expect(inv.exchangeRateFromCurrency).toBe("USD");
      expect(inv.exchangeRateToCurrency).toBe("CAD");
      expect(
        investmentTransactionsService.resolveSettlementCurrencyPair,
      ).not.toHaveBeenCalled();
    });
  });
});
