import { BadRequestException, NotFoundException } from "@nestjs/common";
import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { TransactionsModule } from "@/transactions/transactions.module";
import { BudgetsModule } from "@/budgets/budgets.module";
import { BudgetsService } from "@/budgets/budgets.service";
import { BudgetPeriodService } from "@/budgets/budget-period.service";
import { BudgetBucketsService } from "@/budgets/budget-buckets.service";
import { BudgetBucketReportsService } from "@/budgets/budget-bucket-reports.service";
import { BudgetGeneratorService } from "@/budgets/budget-generator.service";
import {
  Budget,
  BudgetStrategy,
  BudgetType,
} from "@/budgets/entities/budget.entity";
import { BudgetCategory } from "@/budgets/entities/budget-category.entity";
import { BudgetBucketTargetType } from "@/budgets/entities/budget-bucket.entity";
import { ApplyGeneratedBudgetDto } from "@/budgets/dto/apply-generated-budget.dto";
import { UpdateBudgetCategoryDto } from "@/budgets/dto/update-budget-category.dto";
import {
  getCurrentMonthPeriodDates,
  getFollowingMonthPeriodDates,
  getMonthPeriodDates,
  getPreviousMonthPeriodDates,
  PeriodDateRange,
} from "@/budgets/budget-date.utils";
import {
  Transaction,
  TransactionStatus,
} from "@/transactions/entities/transaction.entity";
import { withUserContext } from "@/common/db/with-context";
import {
  cleanTables,
  createEnforcedIntegrationModule,
  createTestUserDirect,
  EnforcedIntegrationHarness,
} from "../helpers/integration-setup";
import {
  createTestAccount,
  createTestCategory,
} from "../helpers/test-factories";

/**
 * Bucket budgets against PostgreSQL with row-level security enforced: the
 * services run as the unprivileged runtime role, fixtures are seeded through
 * the owner connection (docs/future-plans/bucket-budget.md, task Q1).
 *
 * - INV-BUDGET-002 (truth table D): a line's bucket is one of its own budget's,
 *   on every writing route (line add, line update, bulk update, wizard apply);
 *   each refusal leaves the row as it was in the database.
 * - INV-BUDGET-003 (truth table C, section 8): a close freezes one row per
 *   bucket, the next period's carry_in is that close's carry_out, a cap holds,
 *   and a later bucket edit or deletion does not rewrite a CLOSED row.
 * - The live read (`getBucketStatus`) shows the carried-in figure and the same
 *   section 8 numbers the close then freezes.
 */
describe("bucket budgets (integration)", () => {
  let harness: EnforcedIntegrationHarness;
  let module: TestingModule;
  let db: DataSource;
  let budgets: BudgetsService;
  let periods: BudgetPeriodService;
  let buckets: BudgetBucketsService;
  let bucketReports: BudgetBucketReportsService;
  let generator: BudgetGeneratorService;

  let aliceId: string;
  let bobId: string;
  let chequingId: string;
  let rentId: string;
  let groceriesId: string;
  let savingsCatId: string;
  let miscId: string;
  let salaryId: string;

  const current = getCurrentMonthPeriodDates();
  const previous = getPreviousMonthPeriodDates();
  const twoBack = monthBefore(previous);

  function monthBefore(range: PeriodDateRange): PeriodDateRange {
    const [y, m] = range.periodStart.split("-").map(Number);
    const d = new Date(Date.UTC(y, m - 2, 1));
    return getMonthPeriodDates(d.getUTCFullYear(), d.getUTCMonth());
  }

  beforeAll(async () => {
    harness = await createEnforcedIntegrationModule([
      TransactionsModule,
      BudgetsModule,
    ]);
    module = harness.module;
    db = harness.owner;
    budgets = module.get(BudgetsService);
    periods = module.get(BudgetPeriodService);
    buckets = module.get(BudgetBucketsService);
    bucketReports = module.get(BudgetBucketReportsService, { strict: false });
    generator = module.get(BudgetGeneratorService);
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await cleanTables(db, [
      "budget_period_buckets",
      "budget_period_categories",
      "budget_periods",
      "budget_categories",
      "budget_buckets",
      "budgets",
      "transaction_splits",
      "transactions",
      "accounts",
      "categories",
      "payees",
      "users",
    ]);
    aliceId = (await createTestUserDirect(db, { firstName: "Alice" })).id;
    bobId = (await createTestUserDirect(db, { firstName: "Bob" })).id;
    chequingId = (await createTestAccount(db, aliceId, { name: "Chequing" }))
      .id;
    const category = async (name: string, isIncome = false) =>
      (await createTestCategory(db, aliceId, { name, isIncome })).id;
    rentId = await category("Rent");
    groceriesId = await category("Groceries");
    savingsCatId = await category("Savings deposits");
    miscId = await category("Misc");
    salaryId = await category("Salary", true);
  });

  // ---- fixtures -----------------------------------------------------------

  /** Design section 8: USD (the pattern suite's), base income 5000, not linked. */
  const seedBudget = (userId: string, name: string): Promise<Budget> =>
    db.manager.save(
      db.manager.create(Budget, {
        userId,
        name,
        budgetType: BudgetType.MONTHLY,
        periodStart: twoBack.periodStart,
        currencyCode: "USD",
        baseIncome: 5000,
        incomeLinked: false,
        strategy: BudgetStrategy.BUCKET,
      } as Partial<Budget>),
    );

  /** Through the real CRUD service, as the budget's owner. */
  const createBucket = async (
    userId: string,
    budgetId: string,
    name: string,
    targetType: BudgetBucketTargetType,
    targetValue: number,
    carry: { carryOver?: boolean; carryCap?: number } = {},
  ): Promise<string> =>
    (
      await withUserContext(userId, () =>
        buckets.create(userId, budgetId, {
          name,
          targetType,
          targetValue,
          ...carry,
        }),
      )
    ).id;

  const seedLine = async (
    budgetId: string,
    categoryId: string,
    amount: number,
    bucketId: string | null,
    isIncome = false,
  ): Promise<string> =>
    (
      await db.manager.save(
        db.manager.create(BudgetCategory, {
          budgetId,
          categoryId,
          amount,
          isIncome,
          isTransfer: false,
          bucketId,
        } as Partial<BudgetCategory>),
      )
    ).id;

  const spend = (
    categoryId: string,
    range: PeriodDateRange,
    amount: number,
  ): Promise<Transaction> =>
    db.manager.save(
      db.manager.create(Transaction, {
        userId: aliceId,
        accountId: chequingId,
        transactionDate: range.periodStart,
        amount: -amount,
        currencyCode: "USD",
        status: TransactionStatus.UNRECONCILED,
        isSplit: false,
        isTransfer: false,
        categoryId,
      } as Partial<Transaction>),
    );

  interface SectionEight {
    budgetId: string;
    fixedId: string;
    everydayId: string;
    savingsId: string;
    savingsLineId: string;
  }

  /**
   * Fixed costs PERCENT 50 (carry off), Everyday AMOUNT 1200 (carry off),
   * Savings PERCENT 20 (carry on, `savingsCap` when given), one line each, an
   * unassigned Misc line and an income line.
   */
  const seedSectionEight = async (
    savingsCap?: number,
  ): Promise<SectionEight> => {
    const budgetId = (await seedBudget(aliceId, "Household")).id;
    const P = BudgetBucketTargetType.PERCENT;
    const fixedId = await createBucket(aliceId, budgetId, "Fixed costs", P, 50);
    const everydayId = await createBucket(
      aliceId,
      budgetId,
      "Everyday",
      BudgetBucketTargetType.AMOUNT,
      1200,
    );
    const savingsId = await createBucket(aliceId, budgetId, "Savings", P, 20, {
      carryOver: true,
      ...(savingsCap !== undefined ? { carryCap: savingsCap } : {}),
    });
    await seedLine(budgetId, rentId, 2400, fixedId);
    await seedLine(budgetId, groceriesId, 1200, everydayId);
    const savingsLineId = await seedLine(
      budgetId,
      savingsCatId,
      1000,
      savingsId,
    );
    await seedLine(budgetId, miscId, 120, null);
    await seedLine(budgetId, salaryId, 5000, null, true);
    return { budgetId, fixedId, everydayId, savingsId, savingsLineId };
  };

  /** The first period, created by the real creation path with its carry map. */
  const openFirstPeriod = (
    budgetId: string,
    range: PeriodDateRange,
    carry?: Map<string, number>,
  ) =>
    withUserContext(aliceId, async () => {
      const budget = await budgets.findOne(aliceId, budgetId);
      return periods.createPeriodForBudget(
        budget,
        undefined,
        undefined,
        range,
        carry,
      );
    });

  const close = (budgetId: string) =>
    withUserContext(aliceId, () => periods.closePeriod(aliceId, budgetId));

  interface PeriodBucketRow {
    period_start: string;
    status: string;
    bucket_id: string | null;
    bucket_name: string;
    target_type: string;
    target_value: string;
    income_basis: string | null;
    allocated_amount: string | null;
    carry_in: string;
    actual_amount: string;
    carry_out: string;
  }

  const periodBucketRows = (budgetId: string): Promise<PeriodBucketRow[]> =>
    db.query(
      `SELECT TO_CHAR(p.period_start, 'YYYY-MM-DD') AS period_start, p.status,
              pb.bucket_id, pb.bucket_name, pb.target_type, pb.target_value,
              pb.income_basis, pb.allocated_amount, pb.carry_in,
              pb.actual_amount, pb.carry_out
         FROM budget_period_buckets pb
         JOIN budget_periods p ON p.id = pb.budget_period_id
        WHERE p.budget_id = $1
        ORDER BY p.period_start, pb.bucket_name`,
      [budgetId],
    );

  const rowsOf = async (budgetId: string, range: PeriodDateRange) =>
    (await periodBucketRows(budgetId)).filter(
      (r) => r.period_start === range.periodStart,
    );

  /** The frozen columns of a row, for a literal comparison. */
  const frozen = (r: PeriodBucketRow) => ({
    name: r.bucket_name,
    target: `${r.target_type} ${r.target_value}`,
    income: r.income_basis,
    allocated: r.allocated_amount,
    carryIn: r.carry_in,
    actual: r.actual_amount,
    carryOut: r.carry_out,
  });

  const n = (v: number) => v.toFixed(8);

  // ---- INV-BUDGET-002 -----------------------------------------------------

  describe("INV-BUDGET-002: a line takes only a bucket of its own budget", () => {
    let budgetId: string;
    let fixedId: string;
    let everydayId: string;
    let otherBudgetBucketId: string;
    let bobBucketId: string;
    let rentLineId: string;
    let groceriesLineId: string;
    let salaryLineId: string;

    beforeEach(async () => {
      budgetId = (await seedBudget(aliceId, "Household")).id;
      const P = BudgetBucketTargetType.PERCENT;
      fixedId = await createBucket(aliceId, budgetId, "Fixed costs", P, 50);
      everydayId = await createBucket(aliceId, budgetId, "Everyday", P, 30);
      const otherBudget = (await seedBudget(aliceId, "Cottage")).id;
      otherBudgetBucketId = await createBucket(
        aliceId,
        otherBudget,
        "Cottage costs",
        P,
        40,
      );
      const bobBudget = (await seedBudget(bobId, "Bob's")).id;
      bobBucketId = await createBucket(bobId, bobBudget, "Bob's bucket", P, 40);

      rentLineId = await seedLine(budgetId, rentId, 2400, fixedId);
      groceriesLineId = await seedLine(budgetId, groceriesId, 600, null);
      salaryLineId = await seedLine(budgetId, salaryId, 5000, null, true);
    });

    const asAlice = <T>(fn: () => Promise<T>) => withUserContext(aliceId, fn);

    const lineRow = async (id: string) => {
      const [row]: Array<{
        bucket_id: string | null;
        amount: string;
        is_income: boolean;
      }> = await db.query(
        "SELECT bucket_id, amount, is_income FROM budget_categories WHERE id = $1",
        [id],
      );
      return row;
    };

    const linesFor = async (categoryId: string) =>
      (
        await db.query(
          "SELECT bucket_id FROM budget_categories WHERE budget_id = $1 AND category_id = $2",
          [budgetId, categoryId],
        )
      ).length as number;

    it("the harness enforces row-level security on both bucket tables", async () => {
      const rls: Array<{ relname: string; relrowsecurity: boolean }> =
        await db.query(
          `SELECT relname, relrowsecurity FROM pg_class
            WHERE relname IN ('budget_buckets', 'budget_period_buckets')
            ORDER BY relname`,
        );
      expect(rls).toEqual([
        { relname: "budget_buckets", relrowsecurity: true },
        { relname: "budget_period_buckets", relrowsecurity: true },
      ]);
    });

    it("addCategory refuses a foreign bucket or a bucketed income line and writes no line", async () => {
      const add = (dto: {
        categoryId: string;
        bucketId: string | null;
        isIncome?: boolean;
      }) =>
        asAlice(() =>
          budgets.addCategory(aliceId, budgetId, { amount: 50, ...dto }),
        );

      await expect(
        add({ categoryId: miscId, bucketId: otherBudgetBucketId }),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        add({ categoryId: miscId, bucketId: bobBucketId }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(await linesFor(miscId)).toBe(0);

      const bonusId = (
        await createTestCategory(db, aliceId, { name: "Bonus", isIncome: true })
      ).id;
      await expect(
        add({ categoryId: bonusId, bucketId: fixedId, isIncome: true }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(await linesFor(bonusId)).toBe(0);

      // An income line with no bucket, and an expense line with an own bucket.
      const bonus = await add({
        categoryId: bonusId,
        bucketId: null,
        isIncome: true,
      });
      expect((await lineRow(bonus.id)).bucket_id).toBeNull();
      const misc = await add({ categoryId: miscId, bucketId: everydayId });
      expect((await lineRow(misc.id)).bucket_id).toBe(everydayId);
    });

    it("updateCategory refuses a foreign bucket or a bucketed income line and leaves the row unchanged", async () => {
      const update = (id: string, dto: UpdateBudgetCategoryDto) =>
        asAlice(() => budgets.updateCategory(aliceId, budgetId, id, dto));

      for (const foreign of [otherBudgetBucketId, bobBucketId]) {
        await expect(
          update(rentLineId, { bucketId: foreign, amount: 999 }),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(await lineRow(rentLineId)).toEqual({
          bucket_id: fixedId,
          amount: n(2400),
          is_income: false,
        });
      }

      // An income line cannot take a bucket, even its own budget's.
      await expect(
        update(salaryLineId, { bucketId: fixedId }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect((await lineRow(salaryLineId)).bucket_id).toBeNull();

      // Nor can a bucketed line become an income line while keeping it.
      await expect(
        update(rentLineId, { isIncome: true }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(await lineRow(rentLineId)).toEqual({
        bucket_id: fixedId,
        amount: n(2400),
        is_income: false,
      });

      // Field absent: unchanged. A bucket of the same budget: set. null: cleared.
      await update(rentLineId, { amount: 2500 });
      expect((await lineRow(rentLineId)).bucket_id).toBe(fixedId);
      await update(rentLineId, { bucketId: everydayId });
      expect((await lineRow(rentLineId)).bucket_id).toBe(everydayId);
      await update(rentLineId, { bucketId: null });
      expect((await lineRow(rentLineId)).bucket_id).toBeNull();
    });

    it("bulkUpdateCategories refuses the whole batch and writes none of it", async () => {
      const bulk = (
        items: Array<{ id: string; amount: number; bucketId?: string | null }>,
      ) =>
        asAlice(() => budgets.bulkUpdateCategories(aliceId, budgetId, items));
      const unchanged = async () => {
        expect(await lineRow(rentLineId)).toEqual({
          bucket_id: fixedId,
          amount: n(2400),
          is_income: false,
        });
        expect(await lineRow(groceriesLineId)).toEqual({
          bucket_id: null,
          amount: n(600),
          is_income: false,
        });
        expect(await lineRow(salaryLineId)).toEqual({
          bucket_id: null,
          amount: n(5000),
          is_income: true,
        });
      };

      // A valid item first, so a partial write would show on it.
      for (const foreign of [otherBudgetBucketId, bobBucketId]) {
        await expect(
          bulk([
            { id: rentLineId, amount: 2600, bucketId: everydayId },
            { id: groceriesLineId, amount: 700, bucketId: foreign },
          ]),
        ).rejects.toBeInstanceOf(NotFoundException);
        await unchanged();
      }
      await expect(
        bulk([
          { id: rentLineId, amount: 2600, bucketId: everydayId },
          { id: salaryLineId, amount: 5100, bucketId: fixedId },
        ]),
      ).rejects.toBeInstanceOf(BadRequestException);
      await unchanged();

      await bulk([
        { id: rentLineId, amount: 2600, bucketId: null },
        { id: groceriesLineId, amount: 700, bucketId: everydayId },
        { id: salaryLineId, amount: 5100 },
      ]);
      expect((await lineRow(rentLineId)).bucket_id).toBeNull();
      expect(await lineRow(groceriesLineId)).toEqual({
        bucket_id: everydayId,
        amount: n(700),
        is_income: false,
      });
      expect((await lineRow(salaryLineId)).bucket_id).toBeNull();
    });
  });

  // ---- INV-BUDGET-003 -----------------------------------------------------

  describe("INV-BUDGET-003: a close freezes the buckets and carries once", () => {
    it("two closes carry Savings forward: carry_in of each period is the closed one's carry_out", async () => {
      const s = await seedSectionEight();
      await openFirstPeriod(s.budgetId, twoBack);
      await spend(rentId, twoBack, 2400);
      await spend(groceriesId, twoBack, 1350);
      await spend(savingsCatId, twoBack, 400);

      await close(s.budgetId);

      expect((await rowsOf(s.budgetId, twoBack)).map(frozen)).toEqual([
        {
          name: "Everyday",
          target: `AMOUNT ${n(1200)}`,
          income: n(5000),
          allocated: n(1200),
          carryIn: n(0),
          actual: n(1350),
          carryOut: n(0),
        },
        {
          name: "Fixed costs",
          target: `PERCENT ${n(50)}`,
          income: n(5000),
          allocated: n(2500),
          carryIn: n(0),
          actual: n(2400),
          carryOut: n(0),
        },
        {
          name: "Savings",
          target: `PERCENT ${n(20)}`,
          income: n(5000),
          allocated: n(1000),
          carryIn: n(0),
          actual: n(400),
          carryOut: n(600),
        },
      ]);
      const [firstClosed] = await rowsOf(s.budgetId, twoBack);
      expect(firstClosed.status).toBe("CLOSED");

      // Only the bucket with a positive carry has a row in the new period.
      const opened = await rowsOf(s.budgetId, previous);
      expect(opened).toHaveLength(1);
      expect(opened[0]).toMatchObject({
        status: "OPEN",
        bucket_id: s.savingsId,
        bucket_name: "Savings",
        carry_in: n(600),
        allocated_amount: null,
        actual_amount: n(0),
        carry_out: n(0),
      });

      // Second period: 1000 + 600 carried in - 350 spent = 1250 carried on.
      await spend(rentId, previous, 2500);
      await spend(groceriesId, previous, 1000);
      await spend(savingsCatId, previous, 350);
      await close(s.budgetId);

      expect((await rowsOf(s.budgetId, previous)).map(frozen)).toEqual([
        {
          name: "Everyday",
          target: `AMOUNT ${n(1200)}`,
          income: n(5000),
          allocated: n(1200),
          carryIn: n(0),
          actual: n(1000),
          carryOut: n(0),
        },
        {
          name: "Fixed costs",
          target: `PERCENT ${n(50)}`,
          income: n(5000),
          allocated: n(2500),
          carryIn: n(0),
          actual: n(2500),
          carryOut: n(0),
        },
        {
          name: "Savings",
          target: `PERCENT ${n(20)}`,
          income: n(5000),
          allocated: n(1000),
          carryIn: n(600),
          actual: n(350),
          carryOut: n(1250),
        },
      ]);
      const third = await rowsOf(s.budgetId, current);
      expect(third.map((r) => [r.status, r.bucket_id, r.carry_in])).toEqual([
        ["OPEN", s.savingsId, n(1250)],
      ]);
    });

    it("a carry cap holds at each close (section 8: 250 in, 400 spent, cap 500)", async () => {
      const s = await seedSectionEight(500);
      await openFirstPeriod(s.budgetId, twoBack, new Map([[s.savingsId, 250]]));
      await spend(rentId, twoBack, 2400);
      await spend(groceriesId, twoBack, 1350);
      await spend(savingsCatId, twoBack, 400);

      await close(s.budgetId);

      // available 1000 + 250 - 400 = 850, capped at 500.
      const savings = (await rowsOf(s.budgetId, twoBack)).find(
        (r) => r.bucket_name === "Savings",
      )!;
      expect(frozen(savings)).toEqual({
        name: "Savings",
        target: `PERCENT ${n(20)}`,
        income: n(5000),
        allocated: n(1000),
        carryIn: n(250),
        actual: n(400),
        carryOut: n(500),
      });
      const opened = await rowsOf(s.budgetId, previous);
      expect(opened.map((r) => [r.bucket_id, r.carry_in])).toEqual([
        [s.savingsId, n(500)],
      ]);

      // 1000 + 500 - 350 = 1150 available, capped at 500 again.
      await spend(savingsCatId, previous, 350);
      await close(s.budgetId);
      const second = (await rowsOf(s.budgetId, previous)).find(
        (r) => r.bucket_name === "Savings",
      )!;
      expect([second.carry_in, second.actual_amount, second.carry_out]).toEqual(
        [n(500), n(350), n(500)],
      );
      expect(
        (await rowsOf(s.budgetId, current)).map((r) => [
          r.bucket_id,
          r.carry_in,
        ]),
      ).toEqual([[s.savingsId, n(500)]]);
    });

    it("a later rename or retarget of a bucket does not change the closed period's row", async () => {
      const s = await seedSectionEight();
      await openFirstPeriod(s.budgetId, twoBack);
      await spend(savingsCatId, twoBack, 400);
      await close(s.budgetId);
      const closedBefore = await rowsOf(s.budgetId, twoBack);

      await withUserContext(aliceId, () =>
        buckets.update(aliceId, s.budgetId, s.savingsId, {
          name: "Rainy day",
          targetType: BudgetBucketTargetType.AMOUNT,
          targetValue: 300,
          carryCap: 100,
        }),
      );

      expect(await rowsOf(s.budgetId, twoBack)).toEqual(closedBefore);
      const savingsBefore = closedBefore.find(
        (r) => r.bucket_id === s.savingsId,
      )!;
      expect(frozen(savingsBefore)).toMatchObject({
        name: "Savings",
        target: `PERCENT ${n(20)}`,
        allocated: n(1000),
        carryOut: n(600),
      });

      // The next close freezes the bucket as it is then: AMOUNT 300, 600 in,
      // nothing spent, 900 available, capped at 100.
      await close(s.budgetId);
      expect(await rowsOf(s.budgetId, twoBack)).toEqual(closedBefore);
      const next = (await rowsOf(s.budgetId, previous)).find(
        (r) => r.bucket_id === s.savingsId,
      )!;
      expect(frozen(next)).toEqual({
        name: "Rainy day",
        target: `AMOUNT ${n(300)}`,
        income: n(5000),
        allocated: n(300),
        carryIn: n(600),
        actual: n(0),
        carryOut: n(100),
      });
    });
  });

  // ---- deletion -----------------------------------------------------------

  describe("deleting a bucket", () => {
    it("unassigns its lines and nulls bucket_id on its snapshot rows, which keep their name and figures", async () => {
      const s = await seedSectionEight();
      await openFirstPeriod(s.budgetId, twoBack);
      await spend(savingsCatId, twoBack, 400);
      await close(s.budgetId);
      const closedBefore = await rowsOf(s.budgetId, twoBack);

      await withUserContext(aliceId, () =>
        buckets.remove(aliceId, s.budgetId, s.savingsId),
      );

      const [line] = await db.query(
        "SELECT bucket_id FROM budget_categories WHERE id = $1",
        [s.savingsLineId],
      );
      expect(line.bucket_id).toBeNull();
      expect(
        (
          await db.query("SELECT 1 FROM budget_buckets WHERE budget_id = $1", [
            s.budgetId,
          ])
        ).length,
      ).toBe(2);

      const closedAfter = await rowsOf(s.budgetId, twoBack);
      expect(closedAfter).toEqual(
        closedBefore.map((r) =>
          r.bucket_name === "Savings" ? { ...r, bucket_id: null } : r,
        ),
      );
      expect(
        frozen(closedAfter.find((r) => r.bucket_name === "Savings")!),
      ).toEqual({
        name: "Savings",
        target: `PERCENT ${n(20)}`,
        income: n(5000),
        allocated: n(1000),
        carryIn: n(0),
        actual: n(400),
        carryOut: n(600),
      });

      // The open period's carry-in row is orphaned the same way, and the next
      // close leaves it as it is and writes no Savings row of its own.
      const [orphan] = await rowsOf(s.budgetId, previous);
      expect([orphan.bucket_id, orphan.bucket_name, orphan.carry_in]).toEqual([
        null,
        "Savings",
        n(600),
      ]);
      await close(s.budgetId);
      expect(
        (await rowsOf(s.budgetId, previous)).map((r) => [
          r.bucket_name,
          r.bucket_id,
          r.carry_in,
          r.allocated_amount,
          r.carry_out,
        ]),
      ).toEqual([
        ["Everyday", s.everydayId, n(0), n(1200), n(0)],
        ["Fixed costs", s.fixedId, n(0), n(2500), n(0)],
        ["Savings", null, n(600), null, n(0)],
      ]);
      expect(await rowsOf(s.budgetId, current)).toEqual([]);
    });
  });

  // ---- wizard apply -------------------------------------------------------

  describe("wizard apply", () => {
    const request = (
      overrides: Partial<ApplyGeneratedBudgetDto> = {},
    ): ApplyGeneratedBudgetDto => ({
      name: "From the wizard",
      budgetType: BudgetType.MONTHLY,
      periodStart: current.periodStart,
      baseIncome: 5000,
      strategy: BudgetStrategy.BUCKET,
      currencyCode: "USD",
      buckets: [
        {
          key: "fixed",
          name: "Fixed costs",
          targetType: BudgetBucketTargetType.PERCENT,
          targetValue: 50,
        },
        {
          key: "save",
          name: "Savings",
          targetType: BudgetBucketTargetType.PERCENT,
          targetValue: 20,
          carryOver: true,
        },
      ],
      categories: [
        { categoryId: rentId, amount: 2400, bucketKey: "fixed" },
        { categoryId: savingsCatId, amount: 1000, bucketKey: "save" },
        { categoryId: miscId, amount: 120 },
        { categoryId: salaryId, amount: 5000, isIncome: true },
      ],
      ...overrides,
    });

    const counts = async () => {
      const [row]: Array<{ budgets: number; buckets: number; lines: number }> =
        await db.query(
          `SELECT (SELECT COUNT(*) FROM budgets)::int AS budgets,
                  (SELECT COUNT(*) FROM budget_buckets)::int AS buckets,
                  (SELECT COUNT(*) FROM budget_categories)::int AS lines`,
        );
      return row;
    };
    const nothing = { budgets: 0, buckets: 0, lines: 0 };
    const apply = (dto: ApplyGeneratedBudgetDto) =>
      withUserContext(aliceId, () => generator.apply(aliceId, dto));

    it("refuses an unknown bucketKey and writes no budget, bucket or line", async () => {
      const dto = request();
      await expect(
        apply({
          ...dto,
          categories: [
            ...dto.categories,
            { categoryId: groceriesId, amount: 600, bucketKey: "nope" },
          ],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(await counts()).toEqual(nothing);
    });

    it("refuses a bucketKey on an income line and writes nothing", async () => {
      const dto = request();
      await expect(
        apply({
          ...dto,
          categories: dto.categories.map((c) =>
            c.isIncome ? { ...c, bucketKey: "save" } : c,
          ),
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(await counts()).toEqual(nothing);
    });

    it("refuses a duplicate bucket name and writes nothing", async () => {
      const dto = request();
      await expect(
        apply({
          ...dto,
          buckets: [
            ...(dto.buckets ?? []),
            {
              key: "save2",
              name: " savings ",
              targetType: BudgetBucketTargetType.AMOUNT,
              targetValue: 100,
            },
          ],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(await counts()).toEqual(nothing);
    });

    it("rolls back the budget and its buckets when a line write fails in the database", async () => {
      // A transfer line to an account that does not exist passes every check
      // the service makes and fails on the foreign key, after the budget and
      // bucket rows were written in the same transaction.
      const dto = request();
      await expect(
        apply({
          ...dto,
          categories: [
            ...dto.categories,
            {
              transferAccountId: "00000000-0000-4000-8000-000000000001",
              amount: 100,
              bucketKey: "save",
            },
          ],
        }),
      ).rejects.toThrow(/foreign key/i);
      expect(await counts()).toEqual(nothing);
    });

    it("writes the budget, its buckets and its lines, each line on its new bucket", async () => {
      const budget = await apply(request());

      expect(await counts()).toEqual({ budgets: 1, buckets: 2, lines: 4 });
      const rows: Array<{ category_id: string; bucket_name: string | null }> =
        await db.query(
          `SELECT bc.category_id, b.name AS bucket_name
             FROM budget_categories bc
             LEFT JOIN budget_buckets b ON b.id = bc.bucket_id
            WHERE bc.budget_id = $1`,
          [budget.id],
        );
      const byCategory = new Map(
        rows.map((r) => [r.category_id, r.bucket_name]),
      );
      expect(Object.fromEntries(byCategory)).toEqual({
        [rentId]: "Fixed costs",
        [savingsCatId]: "Savings",
        [miscId]: null,
        [salaryId]: null,
      });
      const [{ count }] = await db.query(
        `SELECT COUNT(*)::int AS count FROM budget_buckets WHERE budget_id = $1`,
        [budget.id],
      );
      expect(count).toBe(2);
    });
  });

  // ---- live read ----------------------------------------------------------

  describe("getBucketStatus", () => {
    it("reports the carried-in figure and the section 8 numbers, which the close then freezes", async () => {
      const s = await seedSectionEight();
      // Last month leaves Savings 1000 - 750 = 250 to carry into this month.
      await openFirstPeriod(s.budgetId, previous);
      await spend(savingsCatId, previous, 750);
      await close(s.budgetId);

      await spend(rentId, current, 2400);
      await spend(groceriesId, current, 1350);
      await spend(savingsCatId, current, 400);
      await spend(miscId, current, 80);

      const status = await withUserContext(aliceId, () =>
        bucketReports.getBucketStatus(aliceId, s.budgetId),
      );

      expect(status).toMatchObject({
        periodStart: current.periodStart,
        periodEnd: current.periodEnd,
        currencyCode: "USD",
        income: 5000,
        incomeSource: "BASE_INCOME",
        totalAllocated: 4700,
        knownAllocated: 4700,
        unallocated: 300,
        unassigned: { planned: 120, spent: 80, lineCount: 1 },
      });
      const pick = (name: string) => {
        const b = status.buckets.find((x) => x.name === name)!;
        return [
          b.allocated,
          b.carriedIn,
          b.planned,
          b.spent,
          b.available,
          b.percentUsed,
          b.lineCount,
        ];
      };
      // allocated, carriedIn, planned, spent, available, percentUsed, lines
      expect(pick("Fixed costs")).toEqual([2500, 0, 2400, 2400, 100, 96, 1]);
      expect(pick("Everyday")).toEqual([1200, 0, 1200, 1350, -150, 112.5, 1]);
      expect(pick("Savings")).toEqual([1000, 250, 1000, 400, 850, 32, 1]);

      // Closing this period freezes the same figures, and Savings' available
      // 850 is what the following period receives.
      await close(s.budgetId);
      const following = getFollowingMonthPeriodDates(current.periodEnd);
      const savings = (await rowsOf(s.budgetId, current)).find(
        (r) => r.bucket_id === s.savingsId,
      )!;
      expect(frozen(savings)).toEqual({
        name: "Savings",
        target: `PERCENT ${n(20)}`,
        income: n(5000),
        allocated: n(1000),
        carryIn: n(250),
        actual: n(400),
        carryOut: n(850),
      });
      expect(
        (await rowsOf(s.budgetId, following)).map((r) => [
          r.bucket_id,
          r.carry_in,
        ]),
      ).toEqual([[s.savingsId, n(850)]]);
    });
  });
});
