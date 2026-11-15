import { Test } from "@nestjs/testing";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { DataSource } from "typeorm";
import {
  createScopedDbMocks,
  DataSourceMock,
} from "../test-helpers/scoped-db-testing";
import { BudgetBucketsService } from "./budget-buckets.service";
import { Budget } from "./entities/budget.entity";
import {
  BudgetBucket,
  BudgetBucketTargetType,
} from "./entities/budget-bucket.entity";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

type RepoMock = Record<
  "findOne" | "find" | "save" | "create" | "remove",
  jest.Mock
>;

describe("BudgetBucketsService", () => {
  let service: BudgetBucketsService;
  let budgets: RepoMock;
  let buckets: RepoMock;
  let dataSource: DataSourceMock;

  const bucket = (over: Partial<BudgetBucket> = {}): BudgetBucket =>
    ({
      id: "b-1",
      budgetId: "budget-1",
      name: "Needs",
      targetType: BudgetBucketTargetType.PERCENT,
      targetValue: 50,
      carryOver: false,
      carryCap: null,
      sortOrder: 0,
      ...over,
    }) as BudgetBucket;

  const baseDto = {
    name: "Wants",
    targetType: BudgetBucketTargetType.PERCENT,
    targetValue: 30,
  };

  beforeEach(async () => {
    budgets = {
      findOne: jest
        .fn()
        .mockResolvedValue({ id: "budget-1", userId: "user-1" }),
      find: jest.fn(),
      save: jest.fn(),
      create: jest.fn(),
      remove: jest.fn(),
    };
    buckets = {
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn().mockImplementation((d) => ({ ...d, id: d.id ?? "new" })),
      create: jest.fn().mockImplementation((d) => d),
      remove: jest.fn(),
    };
    ({ dataSource } = createScopedDbMocks([
      [Budget, budgets],
      [BudgetBucket, buckets],
    ]));
    const module = await Test.createTestingModule({
      providers: [
        BudgetBucketsService,
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();
    service = module.get(BudgetBucketsService);
  });

  describe("findAll", () => {
    it("lists the buckets ordered by sort order then name", async () => {
      buckets.find.mockResolvedValue([
        bucket({ id: "c", name: "B", sortOrder: 1 }),
        bucket({ id: "b", name: "B", sortOrder: 0 }),
        bucket({ id: "a", name: "A", sortOrder: 0 }),
      ]);
      const result = await service.findAll("user-1", "budget-1");
      expect(result.map((b) => b.id)).toEqual(["a", "b", "c"]);
      expect(budgets.findOne).toHaveBeenCalledWith({
        where: { id: "budget-1", userId: "user-1" },
      });
    });

    it("404s a budget the caller does not own", async () => {
      budgets.findOne.mockResolvedValue(null);
      await expect(service.findAll("user-1", "budget-1")).rejects.toThrow(
        NotFoundException,
      );
      expect(buckets.find).not.toHaveBeenCalled();
    });
  });

  describe("create", () => {
    it("writes a trimmed bucket in one transaction, locking the budget", async () => {
      buckets.find.mockResolvedValue([bucket({ sortOrder: 3 })]);
      const result = await service.create("user-1", "budget-1", {
        ...baseDto,
        name: "  Wants  ",
      });
      expect(result).toMatchObject({
        budgetId: "budget-1",
        name: "Wants",
        carryOver: false,
        carryCap: null,
        sortOrder: 4,
      });
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(budgets.findOne).toHaveBeenCalledWith({
        where: { id: "budget-1", userId: "user-1" },
        lock: { mode: "pessimistic_write" },
      });
    });

    it("honours sortOrder, carryOver and carryCap", async () => {
      const result = await service.create("user-1", "budget-1", {
        ...baseDto,
        targetType: BudgetBucketTargetType.AMOUNT,
        targetValue: 250.5,
        carryOver: true,
        carryCap: 100,
        sortOrder: 7,
      });
      expect(result).toMatchObject({
        targetValue: 250.5,
        carryOver: true,
        carryCap: 100,
        sortOrder: 7,
      });
    });

    it("refuses the 13th bucket", async () => {
      buckets.find.mockResolvedValue(
        Array.from({ length: 12 }, (_, i) =>
          bucket({ id: `b${i}`, name: `N${i}` }),
        ),
      );
      await expect(
        service.create("user-1", "budget-1", baseDto),
      ).rejects.toThrow(/at most 12/);
      expect(buckets.save).not.toHaveBeenCalled();
    });

    it("accepts the 12th bucket", async () => {
      buckets.find.mockResolvedValue(
        Array.from({ length: 11 }, (_, i) =>
          bucket({ id: `b${i}`, name: `N${i}` }),
        ),
      );
      await expect(
        service.create("user-1", "budget-1", baseDto),
      ).resolves.toBeDefined();
    });

    it.each(["needs", "  NEEDS ", "Needs"])(
      "refuses a duplicate name (%p) ignoring case and space",
      async (name) => {
        buckets.find.mockResolvedValue([bucket()]);
        await expect(
          service.create("user-1", "budget-1", { ...baseDto, name }),
        ).rejects.toThrow(/already has a bucket/);
        expect(buckets.save).not.toHaveBeenCalled();
      },
    );

    it.each(["", "   ", "x".repeat(51)])(
      "refuses a name that is not 1-50 characters after trimming (%p)",
      async (name) => {
        await expect(
          service.create("user-1", "budget-1", { ...baseDto, name }),
        ).rejects.toThrow(BadRequestException);
        expect(buckets.save).not.toHaveBeenCalled();
      },
    );

    it("accepts a 50 character name padded with spaces", async () => {
      const result = await service.create("user-1", "budget-1", {
        ...baseDto,
        name: ` ${"x".repeat(50)} `,
      });
      expect(result.name).toHaveLength(50);
    });

    it.each([100.01, 150, 12.345, 0, -5])(
      "refuses a PERCENT target of %p",
      async (targetValue) => {
        await expect(
          service.create("user-1", "budget-1", { ...baseDto, targetValue }),
        ).rejects.toThrow(BadRequestException);
        expect(buckets.save).not.toHaveBeenCalled();
      },
    );

    it.each([100, 0.01, 33.33])("accepts a PERCENT target of %p", async (v) => {
      await expect(
        service.create("user-1", "budget-1", { ...baseDto, targetValue: v }),
      ).resolves.toBeDefined();
    });

    it("allows an AMOUNT above 100 and with more than two decimals", async () => {
      await expect(
        service.create("user-1", "budget-1", {
          ...baseDto,
          targetType: BudgetBucketTargetType.AMOUNT,
          targetValue: 1234.5678,
        }),
      ).resolves.toBeDefined();
    });

    it("refuses an AMOUNT target of zero", async () => {
      await expect(
        service.create("user-1", "budget-1", {
          ...baseDto,
          targetType: BudgetBucketTargetType.AMOUNT,
          targetValue: 0,
        }),
      ).rejects.toThrow(/greater than zero/);
    });

    it("refuses carryCap without carryOver", async () => {
      await expect(
        service.create("user-1", "budget-1", { ...baseDto, carryCap: 50 }),
      ).rejects.toThrow(/carry cap needs carry-over/);
      await expect(
        service.create("user-1", "budget-1", {
          ...baseDto,
          carryOver: false,
          carryCap: 50,
        }),
      ).rejects.toThrow(BadRequestException);
      expect(buckets.save).not.toHaveBeenCalled();
    });

    it("404s a budget that is not the caller's, writing nothing", async () => {
      budgets.findOne.mockResolvedValue(null);
      await expect(
        service.create("user-1", "budget-1", baseDto),
      ).rejects.toThrow(NotFoundException);
      expect(buckets.save).not.toHaveBeenCalled();
    });
  });

  describe("update", () => {
    beforeEach(() => {
      buckets.find.mockResolvedValue([
        bucket(),
        bucket({ id: "b-2", name: "Wants", sortOrder: 1 }),
      ]);
    });

    it("applies a subset and leaves the rest", async () => {
      const result = await service.update("user-1", "budget-1", "b-1", {
        targetValue: 40,
      });
      expect(result).toMatchObject({ name: "Needs", targetValue: 40 });
      expect(budgets.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ lock: { mode: "pessimistic_write" } }),
      );
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    });

    it("404s an unknown bucket and writes nothing", async () => {
      await expect(
        service.update("user-1", "budget-1", "nope", { targetValue: 40 }),
      ).rejects.toThrow(NotFoundException);
      expect(buckets.save).not.toHaveBeenCalled();
    });

    it("404s a budget that is not the caller's", async () => {
      budgets.findOne.mockResolvedValue(null);
      await expect(
        service.update("user-1", "budget-1", "b-1", { sortOrder: 2 }),
      ).rejects.toThrow(NotFoundException);
    });

    it("lets a bucket keep its own name in a different case", async () => {
      const result = await service.update("user-1", "budget-1", "b-1", {
        name: " NEEDS ",
      });
      expect(result.name).toBe("NEEDS");
    });

    it("refuses another bucket's name", async () => {
      await expect(
        service.update("user-1", "budget-1", "b-1", { name: "wants" }),
      ).rejects.toThrow(/already has a bucket/);
      expect(buckets.save).not.toHaveBeenCalled();
    });

    it("refuses a name that is blank or too long", async () => {
      await expect(
        service.update("user-1", "budget-1", "b-1", { name: "  " }),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.update("user-1", "budget-1", "b-1", { name: "x".repeat(51) }),
      ).rejects.toThrow(BadRequestException);
    });

    it("refuses a percent above 100", async () => {
      await expect(
        service.update("user-1", "budget-1", "b-1", { targetValue: 101 }),
      ).rejects.toThrow(/at most 100/);
      expect(buckets.save).not.toHaveBeenCalled();
    });

    it("validates the percent rule against the type the row would become", async () => {
      buckets.find.mockResolvedValue([
        bucket({
          targetType: BudgetBucketTargetType.AMOUNT,
          targetValue: 500,
        }),
      ]);
      await expect(
        service.update("user-1", "budget-1", "b-1", {
          targetType: BudgetBucketTargetType.PERCENT,
        }),
      ).rejects.toThrow(/at most 100/);
    });

    it("refuses a carryCap on a bucket that does not carry", async () => {
      await expect(
        service.update("user-1", "budget-1", "b-1", { carryCap: 10 }),
      ).rejects.toThrow(/carry cap needs carry-over/);
      await expect(
        service.update("user-1", "budget-1", "b-1", {
          carryOver: false,
          carryCap: 10,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("sets carryOver and carryCap together", async () => {
      const result = await service.update("user-1", "budget-1", "b-1", {
        carryOver: true,
        carryCap: 75,
      });
      expect(result).toMatchObject({ carryOver: true, carryCap: 75 });
    });

    it("turning carryOver off clears an existing carryCap", async () => {
      buckets.find.mockResolvedValue([
        bucket({ carryOver: true, carryCap: 75 }),
      ]);
      const result = await service.update("user-1", "budget-1", "b-1", {
        carryOver: false,
      });
      expect(result).toMatchObject({ carryOver: false, carryCap: null });
    });

    it("null carryCap clears the cap; an untouched cap survives", async () => {
      buckets.find.mockResolvedValue([
        bucket({ carryOver: true, carryCap: 75 }),
      ]);
      const cleared = await service.update("user-1", "budget-1", "b-1", {
        carryCap: null,
      });
      expect(cleared.carryCap).toBeNull();
      buckets.find.mockResolvedValue([
        bucket({ carryOver: true, carryCap: 75 }),
      ]);
      const kept = await service.update("user-1", "budget-1", "b-1", {
        sortOrder: 3,
      });
      expect(kept.carryCap).toBe(75);
    });
  });

  describe("remove", () => {
    it("removes the bucket", async () => {
      buckets.findOne.mockResolvedValue(bucket());
      await service.remove("user-1", "budget-1", "b-1");
      expect(buckets.findOne).toHaveBeenCalledWith({
        where: { id: "b-1", budgetId: "budget-1" },
      });
      expect(buckets.remove).toHaveBeenCalledWith(
        expect.objectContaining({ id: "b-1" }),
      );
    });

    it("404s an unknown bucket", async () => {
      buckets.findOne.mockResolvedValue(null);
      await expect(service.remove("user-1", "budget-1", "b-1")).rejects.toThrow(
        NotFoundException,
      );
      expect(buckets.remove).not.toHaveBeenCalled();
    });

    it("404s a budget that is not the caller's", async () => {
      budgets.findOne.mockResolvedValue(null);
      await expect(service.remove("user-1", "budget-1", "b-1")).rejects.toThrow(
        NotFoundException,
      );
      expect(buckets.remove).not.toHaveBeenCalled();
    });
  });
});
