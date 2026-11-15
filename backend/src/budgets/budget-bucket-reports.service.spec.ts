import { Test } from "@nestjs/testing";
import { DataSource } from "typeorm";
import {
  createScopedDbMocks,
  DataSourceMock,
} from "../test-helpers/scoped-db-testing";
import { BudgetBucketReportsService } from "./budget-bucket-reports.service";
import { BudgetsService } from "./budgets.service";
import { Budget } from "./entities/budget.entity";
import {
  BudgetBucket,
  BudgetBucketTargetType,
} from "./entities/budget-bucket.entity";
import { BudgetCategory } from "./entities/budget-category.entity";
import { BudgetPeriod, PeriodStatus } from "./entities/budget-period.entity";
import { BudgetPeriodBucket } from "./entities/budget-period-bucket.entity";
import { Currency } from "../currencies/entities/currency.entity";
import * as dateUtils from "./budget-date.utils";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

type RepoMock = Record<"findOne" | "find", jest.Mock>;
type SummaryResult = Awaited<ReturnType<BudgetsService["getSummary"]>>;

describe("BudgetBucketReportsService", () => {
  let service: BudgetBucketReportsService;
  let budgetsService: { getSummary: jest.Mock<Promise<SummaryResult>> };
  let periods: RepoMock;
  let periodBuckets: RepoMock;
  let currencies: RepoMock;
  let dataSource: DataSourceMock;

  const bucket = (over: Partial<BudgetBucket>): BudgetBucket =>
    ({
      id: "b-fixed",
      budgetId: "budget-1",
      name: "Fixed",
      targetType: BudgetBucketTargetType.PERCENT,
      targetValue: 50,
      carryOver: false,
      carryCap: null,
      sortOrder: 0,
      ...over,
    }) as BudgetBucket;

  const lineRow = (over: Record<string, unknown>) => ({
    budgetCategoryId: "bc",
    categoryId: "c",
    categoryName: "Cat",
    budgeted: 0,
    spent: 0,
    remaining: 0,
    percentUsed: 0,
    isIncome: false,
    percentage: null,
    ...over,
  });

  const summary = (over: Partial<Budget> = {}): SummaryResult => {
    const budget = {
      id: "budget-1",
      currencyCode: "CAD",
      baseIncome: 5000,
      incomeLinked: false,
      buckets: [
        bucket({}),
        bucket({
          id: "b-save",
          name: "Savings",
          targetValue: 20,
          carryOver: true,
        }),
      ],
      categories: [
        { id: "bc-1", bucketId: "b-fixed" },
        { id: "bc-2", bucketId: "b-fixed" },
        { id: "bc-3", bucketId: "b-save" },
        { id: "bc-4", bucketId: null },
        { id: "bc-inc", bucketId: null },
      ] as BudgetCategory[],
      ...over,
    } as unknown as Budget;
    return {
      budget,
      periodStart: "2026-11-01",
      periodEnd: "2026-11-30",
      incomeLinked: budget.incomeLinked,
      actualIncome: null,
      categoryBreakdown: [
        lineRow({ budgetCategoryId: "bc-1", budgeted: 1500, spent: 1400 }),
        lineRow({ budgetCategoryId: "bc-2", budgeted: 900, spent: 1000 }),
        lineRow({ budgetCategoryId: "bc-3", budgeted: 400, spent: 400 }),
        lineRow({ budgetCategoryId: "bc-4", budgeted: 120, spent: 80 }),
        lineRow({
          budgetCategoryId: "bc-inc",
          budgeted: 4800,
          spent: 5200,
          isIncome: true,
        }),
      ],
    } as unknown as SummaryResult;
  };

  beforeEach(async () => {
    budgetsService = { getSummary: jest.fn().mockResolvedValue(summary()) };
    periods = { findOne: jest.fn().mockResolvedValue(null), find: jest.fn() };
    periodBuckets = {
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
    };
    currencies = { findOne: jest.fn(), find: jest.fn().mockResolvedValue([]) };
    ({ dataSource } = createScopedDbMocks([
      [BudgetPeriod, periods],
      [BudgetPeriodBucket, periodBuckets],
      [Currency, currencies],
    ]));
    const module = await Test.createTestingModule({
      providers: [
        BudgetBucketReportsService,
        { provide: BudgetsService, useValue: budgetsService },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();
    service = module.get(BudgetBucketReportsService);
  });

  afterEach(() => jest.restoreAllMocks());

  it("builds the 6.5 shape from the summary, with carriedIn 0 before any period row", async () => {
    const r = await service.getBucketStatus("user-1", "budget-1");

    expect(budgetsService.getSummary).toHaveBeenCalledWith(
      "user-1",
      "budget-1",
    );
    expect(r).toMatchObject({
      periodStart: "2026-11-01",
      periodEnd: "2026-11-30",
      currencyCode: "CAD",
      income: 5000,
      incomeSource: "BASE_INCOME",
      totalAllocated: 3500,
      knownAllocated: 3500,
      unallocated: 1500,
      unassigned: { planned: 120, spent: 80, lineCount: 1 },
    });
    expect(r.buckets[0]).toEqual({
      bucketId: "b-fixed",
      name: "Fixed",
      targetType: "PERCENT",
      targetValue: 50,
      carryOver: false,
      carryCap: null,
      allocated: 2500,
      carriedIn: 0,
      planned: 2400,
      spent: 2400,
      available: 100,
      percentUsed: 96,
      lineCount: 2,
    });
    expect(r.buckets[0]).not.toHaveProperty("carryOut");
    expect(r.buckets[1]).toMatchObject({
      allocated: 1000,
      spent: 400,
      available: 600,
      percentUsed: 40,
    });
  });

  it("labels the figures with the summary's period, not a second clock read", async () => {
    // At midnight on a month boundary a second read of the clock names the
    // next month while the summary's figures are this month's.
    jest.spyOn(dateUtils, "getCurrentMonthPeriodDates").mockReturnValue({
      periodStart: "2026-12-01",
      periodEnd: "2026-12-31",
    });

    const r = await service.getBucketStatus("user-1", "budget-1");

    expect(r.periodStart).toBe("2026-11-01");
    expect(r.periodEnd).toBe("2026-11-30");
  });

  it("reads carry_in from the open period's bucket rows", async () => {
    periods.findOne.mockResolvedValue({ id: "period-1" });
    periodBuckets.find.mockResolvedValue([
      { bucketId: "b-save", carryIn: 250 },
      { bucketId: null, carryIn: 99 },
    ]);

    const r = await service.getBucketStatus("user-1", "budget-1");

    expect(periods.findOne).toHaveBeenCalledWith({
      where: { budgetId: "budget-1", status: PeriodStatus.OPEN },
    });
    expect(periodBuckets.find).toHaveBeenCalledTimes(1);
    expect(periodBuckets.find.mock.calls[0][0].where.budgetPeriodId).toBe(
      "period-1",
    );
    expect(r.buckets[1]).toMatchObject({
      carriedIn: 250,
      available: 850,
      percentUsed: 32,
    });
    expect(r.buckets[0].carriedIn).toBe(0);
  });

  it("uses the summary's actual income for an income-linked budget", async () => {
    const s = summary({ incomeLinked: true, baseIncome: 9999 });
    s.actualIncome = 4000;
    budgetsService.getSummary.mockResolvedValue(s);

    const r = await service.getBucketStatus("user-1", "budget-1");

    expect(r.incomeSource).toBe("ACTUAL");
    expect(r.buckets[0].allocated).toBe(2000);
  });

  it("sums the income lines' budgeted amounts when there is no base income", async () => {
    budgetsService.getSummary.mockResolvedValue(summary({ baseIncome: null }));

    const r = await service.getBucketStatus("user-1", "budget-1");

    expect(r.income).toBe(4800);
    expect(r.incomeSource).toBe("INCOME_LINES");
  });

  it("reports unknown income as null with the partial sum", async () => {
    const s = summary({
      baseIncome: null,
      buckets: [
        bucket({}),
        bucket({
          id: "b-every",
          name: "Everyday",
          targetType: BudgetBucketTargetType.AMOUNT,
          targetValue: 1200,
        }),
      ],
    });
    s.categoryBreakdown = s.categoryBreakdown.filter((r) => !r.isIncome);
    budgetsService.getSummary.mockResolvedValue(s);

    const r = await service.getBucketStatus("user-1", "budget-1");

    expect(r.income).toBeNull();
    expect(r.totalAllocated).toBeNull();
    expect(r.knownAllocated).toBe(1200);
    expect(r.unallocated).toBeNull();
    expect(r.buckets[0].allocated).toBeNull();
    expect(r.buckets[0].spent).toBe(2400);
  });

  it("returns an empty bucket list for a budget without buckets and skips the carry read", async () => {
    budgetsService.getSummary.mockResolvedValue(summary({ buckets: [] }));
    periods.findOne.mockResolvedValue({ id: "period-1" });

    const r = await service.getBucketStatus("user-1", "budget-1");

    expect(r.buckets).toEqual([]);
    expect(r.totalAllocated).toBe(0);
    expect(r.unassigned.lineCount).toBe(4);
    expect(periodBuckets.find).not.toHaveBeenCalled();
  });

  it("rounds at the currency's own places when it has more than four", async () => {
    const s = summary({ currencyCode: "BTC", baseIncome: 1 });
    budgetsService.getSummary.mockResolvedValue(s);
    currencies.find.mockResolvedValue([{ code: "BTC", decimalPlaces: 8 }]);

    const r = await service.getBucketStatus("user-1", "budget-1");

    expect(r.currencyCode).toBe("BTC");
    expect(r.buckets[0].allocated).toBe(0.5);
  });
});
