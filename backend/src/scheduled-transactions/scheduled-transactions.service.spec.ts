import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { NotFoundException, BadRequestException } from "@nestjs/common";
import { DataSource } from "typeorm";
import { ScheduledTransactionsService } from "./scheduled-transactions.service";
import { ScheduledTransaction } from "./entities/scheduled-transaction.entity";
import { ScheduledTransactionSplit } from "./entities/scheduled-transaction-split.entity";
import { ScheduledTransactionOverride } from "./entities/scheduled-transaction-override.entity";
import { Account } from "../accounts/entities/account.entity";
import { Tag } from "../tags/entities/tag.entity";
import { AccountsService } from "../accounts/accounts.service";
import { TransactionsService } from "../transactions/transactions.service";
import { InvestmentTransactionsService } from "../securities/investment-transactions.service";
import { ScheduledTransactionOverrideService } from "./scheduled-transaction-override.service";
import { ScheduledTransactionLoanService } from "./scheduled-transaction-loan.service";
import { ActionHistoryService } from "../action-history/action-history.service";

describe("ScheduledTransactionsService", () => {
  let service: ScheduledTransactionsService;
  let scheduledRepo: Record<string, jest.Mock>;
  let splitsRepo: Record<string, jest.Mock>;
  let overridesRepo: Record<string, jest.Mock>;
  let accountsRepo: Record<string, jest.Mock>;
  let tagRepo: Record<string, jest.Mock>;
  let accountsService: Record<string, jest.Mock>;
  let transactionsService: Record<string, jest.Mock>;
  let investmentTransactionsService: Record<string, jest.Mock>;
  let mockQueryRunner: Record<string, any>;
  let mockDataSource: Record<string, jest.Mock>;
  let mockActionHistoryService: Record<string, jest.Mock>;

  const userId = "user-1";
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
    };

    tagRepo = {
      findBy: jest.fn().mockResolvedValue([]),
    };

    accountsService = {
      findOne: jest.fn().mockResolvedValue({ id: "acc-1", userId }),
    };

    transactionsService = {
      create: jest.fn().mockResolvedValue({ id: "tx-1" }),
      createTransfer: jest
        .fn()
        .mockResolvedValue([{ id: "tx-1" }, { id: "tx-2" }]),
    };

    investmentTransactionsService = {
      create: jest.fn().mockResolvedValue({ id: "inv-tx-1" }),
    };

    mockActionHistoryService = {
      record: jest.fn().mockResolvedValue(null),
    };

    mockQueryRunner = {
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      manager: {
        remove: jest.fn(),
        update: jest.fn(),
        createQueryBuilder: jest.fn(() => ({
          delete: jest.fn().mockReturnThis(),
          from: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          andWhere: jest.fn().mockReturnThis(),
          execute: jest.fn().mockResolvedValue({ affected: 0 }),
        })),
      },
    };

    mockDataSource = {
      createQueryRunner: jest.fn().mockReturnValue(mockQueryRunner),
      // Default to a single UTC user so cron logic that buckets by timezone
      // continues to operate against legacy tests that pre-date the cron
      // refactor and assume a one-user world.
      query: jest
        .fn()
        .mockResolvedValue([{ user_id: "user-1", timezone: "UTC" }]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ScheduledTransactionsService,
        {
          provide: getRepositoryToken(ScheduledTransaction),
          useValue: scheduledRepo,
        },
        {
          provide: getRepositoryToken(ScheduledTransactionSplit),
          useValue: splitsRepo,
        },
        {
          provide: getRepositoryToken(ScheduledTransactionOverride),
          useValue: overridesRepo,
        },
        { provide: getRepositoryToken(Account), useValue: accountsRepo },
        { provide: getRepositoryToken(Tag), useValue: tagRepo },
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
      ],
    }).compile();

    service = module.get<ScheduledTransactionsService>(
      ScheduledTransactionsService,
    );
  });

  // Helper: stub findOne to return a scheduled transaction for internal calls
  const stubFindOne = (scheduled: ScheduledTransaction) => {
    scheduledRepo.findOne.mockResolvedValue(scheduled);
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

    it("should set categoryId=null when isTransfer", async () => {
      const saved = makeScheduled({ isTransfer: true, categoryId: null });
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
      expect(createArg.categoryId).toBeNull();
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

      expect(splitsRepo.create).toHaveBeenCalledTimes(2);
      expect(splitsRepo.save).toHaveBeenCalled();
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

  // ==================== update ====================
  describe("update", () => {
    it("should update simple fields", async () => {
      const scheduled = makeScheduled();
      stubFindOne(scheduled);

      await service.update(userId, stId, {
        name: "Updated Rent",
        amount: -1500,
      });

      expect(scheduledRepo.update).toHaveBeenCalledWith(
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

      expect(splitsRepo.delete).toHaveBeenCalledWith({
        scheduledTransactionId: stId,
      });
      expect(splitsRepo.create).toHaveBeenCalledTimes(2);
    });

    it("should clear splits when empty array provided", async () => {
      const scheduled = makeScheduled({ isSplit: true });
      stubFindOne(scheduled);

      await service.update(userId, stId, { splits: [] });

      expect(splitsRepo.delete).toHaveBeenCalledWith({
        scheduledTransactionId: stId,
      });
      expect(scheduledRepo.update).toHaveBeenCalledWith(
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

      const updateArg = scheduledRepo.update.mock.calls[0][1];
      expect(updateArg.description).toBeNull();
      expect(updateArg.payeeName).toBeNull();
    });

    it("should clear category and splits when switching to transfer", async () => {
      const scheduled = makeScheduled({ isSplit: true });
      stubFindOne(scheduled);

      await service.update(userId, stId, {
        isTransfer: true,
        transferAccountId: "acc-2",
      });

      expect(splitsRepo.delete).toHaveBeenCalledWith({
        scheduledTransactionId: stId,
      });
      const updateArg = scheduledRepo.update.mock.calls[0][1];
      expect(updateArg.isTransfer).toBe(true);
      expect(updateArg.isSplit).toBe(false);
      expect(updateArg.categoryId).toBeNull();
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

    it("should use createTransfer for transfer transactions", async () => {
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

      expect(transactionsService.createTransfer).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          fromAccountId: "acc-1",
          toAccountId: "acc-2",
          amount: 1200,
        }),
      );
      expect(transactionsService.create).not.toHaveBeenCalled();
    });

    it("should pass payee fields to createTransfer for transfer transactions", async () => {
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

      expect(transactionsService.createTransfer).toHaveBeenCalledWith(
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

      expect(transactionsService.createTransfer).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          fromAccountId: "acc-1",
          toAccountId: "acc-2",
          payeeId: undefined,
          payeeName: undefined,
        }),
      );
    });

    it("should pass tagIds to createTransfer for transfer transactions", async () => {
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

      expect(transactionsService.createTransfer).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          fromAccountId: "acc-1",
          toAccountId: "acc-2",
          tagIds: ["tag-1", "tag-2"],
        }),
      );
    });

    it("should not pass tagIds to createTransfer when scheduled transaction has no tags", async () => {
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

      expect(transactionsService.createTransfer).toHaveBeenCalledWith(
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
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue({
        amount: -750,
        description: null,
        isSplit: null,
        categoryId: null,
        splits: null,
      });
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      accountsRepo.findOne.mockResolvedValue(null);

      await service.post(userId, stId);

      expect(transactionsService.createTransfer).toHaveBeenCalledWith(
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

      expect(transactionsService.createTransfer).toHaveBeenCalledWith(
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

      expect(transactionsService.createTransfer).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          amount: 800,
        }),
      );
    });

    it("should pass override description to createTransfer", async () => {
      const scheduled = makeScheduled({
        isTransfer: true,
        transferAccountId: "acc-2",
        description: "base desc",
      });
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue({
        amount: null,
        description: "override desc",
        isSplit: null,
        categoryId: null,
        splits: null,
      });
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
      accountsRepo.findOne.mockResolvedValue(null);

      await service.post(userId, stId);

      expect(transactionsService.createTransfer).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          description: "override desc",
        }),
      );
    });

    it("should apply inline values with highest priority", async () => {
      const scheduled = makeScheduled({ amount: -1200 });
      stubFindOne(scheduled);
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue({
        amount: -999,
        description: "override desc",
      });
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
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
      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue({
        amount: -999,
        description: "override desc",
        isSplit: null,
        categoryId: null,
        splits: null,
      });
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
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
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
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

      // findOne is called once at the start of post() to load the entity.
      // It must NOT be called a second time after the row is deleted.
      await service.post(userId, stId);

      expect(scheduledRepo.findOne).toHaveBeenCalledTimes(1);
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

      // For findLoanAccountFromSplits
      accountsRepo.findOne.mockResolvedValueOnce(loanAccount);
      // For recalculateLoanPaymentSplits - the loan account lookup
      accountsRepo.findOne.mockResolvedValueOnce(loanAccount);
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

    it("should pass referenceNumber to createTransfer when provided", async () => {
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

      expect(transactionsService.createTransfer).toHaveBeenCalledWith(
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
      expect(transactionsService.createTransfer).not.toHaveBeenCalled();
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

      const fields = scheduledRepo.update.mock.calls.find(
        (c: any[]) => c[0] === stId && c[1].investmentQuantity !== undefined,
      )?.[1];
      expect(fields).toBeDefined();
      expect(fields.investmentQuantity).toBe(2);
      expect(fields.investmentPrice).toBe(480);
      expect(fields.investmentCommission).toBe(5);
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

      const fields = scheduledRepo.update.mock.calls.find(
        (c: any[]) => c[0] === stId && c[1].isInvestment !== undefined,
      )?.[1];
      expect(fields).toBeDefined();
      expect(fields.isInvestment).toBe(true);
      expect(fields.isSplit).toBe(false);
      expect(fields.isTransfer).toBe(false);
      expect(fields.categoryId).toBeNull();
      expect(fields.transferAccountId).toBeNull();
      expect(splitsRepo.delete).toHaveBeenCalledWith({
        scheduledTransactionId: stId,
      });
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

      const fields = scheduledRepo.update.mock.calls.find(
        (c: any[]) => c[0] === stId && c[1].isInvestment !== undefined,
      )?.[1];
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

      const fields = scheduledRepo.update.mock.calls.find(
        (c: any[]) => c[0] === stId && c[1].isTransfer === true,
      )?.[1];
      expect(fields).toBeDefined();
      expect(fields.investmentAction).toBeNull();
      expect(fields.investmentSecurityId).toBeNull();
    });
  });

  // ==================== Override CRUD ====================
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

    it("should auto-post transfer transactions using createTransfer", async () => {
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

      expect(transactionsService.createTransfer).toHaveBeenCalledWith(
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
      expect(transactionsService.createTransfer).toHaveBeenCalled();
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

      expect(transactionsService.createTransfer).toHaveBeenCalledWith(
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
      expect(transactionsService.createTransfer).not.toHaveBeenCalled();
    });

    it("uses last_client_timezone when explicit timezone is the 'browser' sentinel", async () => {
      // Stand in for an EDT user who hasn't picked a timezone in Settings.
      // The browser-provided IANA name was cached on a previous request and
      // must take precedence over the UTC fallback or we'll auto-post a day
      // early once UTC rolls past midnight.
      mockDataSource.query.mockResolvedValueOnce([
        {
          user_id: "user-tz",
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
          user_id: "user-utc",
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

      const overrideQb = mockQueryBuilder(null);
      overrideQb.getOne.mockResolvedValue({
        overrideDate: "2025-03-12",
        amount: null,
        categoryId: null,
        description: null,
        isSplit: null,
        splits: null,
      });
      overridesRepo.createQueryBuilder.mockReturnValue(overrideQb);
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
      accountsRepo.findOne.mockResolvedValue({
        id: "loan-1",
        currentBalance: 0,
      });
      scheduledRepo.findOne.mockResolvedValue(
        makeScheduled({ isActive: true, splits: [] }),
      );

      await service.recalculateLoanPaymentSplits(stId, "loan-1");

      expect(scheduledRepo.update).toHaveBeenCalledWith(stId, {
        isActive: false,
      });
    });

    it("should do nothing when loan account not found", async () => {
      accountsRepo.findOne.mockResolvedValue(null);

      await service.recalculateLoanPaymentSplits(stId, "loan-missing");

      expect(scheduledRepo.update).not.toHaveBeenCalled();
    });

    it("should do nothing when scheduled transaction not found", async () => {
      accountsRepo.findOne.mockResolvedValue({
        id: "loan-1",
        currentBalance: -50000,
        interestRate: 5,
      });
      scheduledRepo.findOne.mockResolvedValue(null);

      await service.recalculateLoanPaymentSplits(stId, "loan-1");

      expect(splitsRepo.save).not.toHaveBeenCalled();
    });

    it("should update principal and interest splits", async () => {
      const loanAccount = {
        id: "loan-1",
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
        splits: [principalSplit, interestSplit] as any,
      });

      accountsRepo.findOne.mockResolvedValue(loanAccount);
      scheduledRepo.findOne.mockResolvedValue(scheduled);

      await service.recalculateLoanPaymentSplits(stId, "loan-1");

      // Both splits should have been saved with updated amounts
      expect(splitsRepo.save).toHaveBeenCalledTimes(2);
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
      splitsRepo.create.mockImplementation((d) => d);
      splitsRepo.save.mockImplementation(async (d) => ({
        id: "split-x",
        ...d,
      }));

      // findOne returns the saved scheduled transaction
      scheduledRepo.findOne.mockResolvedValue(makeScheduled({ amount: 0 }));

      await service.create(userId, dto as any);

      // Verify the investment-kind split was created with all fields populated
      const investmentCall = splitsRepo.create.mock.calls.find(
        ([arg]) => arg.kind === "investment",
      );
      expect(investmentCall).toBeDefined();
      expect(investmentCall![0]).toMatchObject({
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
});
