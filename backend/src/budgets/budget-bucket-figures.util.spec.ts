import {
  BudgetBucketFigureBucket,
  BudgetBucketFigureLine,
  BudgetBucketFiguresInput,
  computeBudgetBucketFigures,
} from "./budget-bucket-figures.util";
import { BudgetBucketTargetType } from "./entities/budget-bucket.entity";

const D = 4;

const bucket = (
  over: Partial<BudgetBucketFigureBucket> = {},
): BudgetBucketFigureBucket => ({
  id: "b1",
  name: "Bucket",
  targetType: BudgetBucketTargetType.PERCENT,
  targetValue: 20,
  carryOver: false,
  carryCap: null,
  ...over,
});

const line = (
  over: Partial<BudgetBucketFigureLine> = {},
): BudgetBucketFigureLine => ({
  bucketId: "b1",
  isIncome: false,
  budgeted: 0,
  spent: 0,
  ...over,
});

const input = (
  over: Partial<BudgetBucketFiguresInput> = {},
): BudgetBucketFiguresInput => ({
  buckets: [],
  lines: [],
  incomeLinked: false,
  baseIncome: 5000,
  incomeLinesBudgeted: 0,
  actualIncome: null,
  carriedIn: new Map(),
  decimals: D,
  ...over,
});

describe("computeBudgetBucketFigures", () => {
  describe("truth table A: bucket income", () => {
    it.each([
      [true, 5000, 9999, 4200, 4200, "ACTUAL"],
      [true, 5000, 9999, 0, null, "NONE"],
      [false, 5000, 1, 7, 5000, "BASE_INCOME"],
      [false, null, 4800, 7, 4800, "INCOME_LINES"],
      [false, 0, 4800, 7, 4800, "INCOME_LINES"],
      [false, null, 0, 7, null, "NONE"],
      [false, 0, 0, 7, null, "NONE"],
    ])(
      "linked=%s base=%s lines=%s actual=%s -> %s (%s)",
      (
        incomeLinked,
        baseIncome,
        incomeLinesBudgeted,
        actualIncome,
        income,
        src,
      ) => {
        const r = computeBudgetBucketFigures(
          input({
            incomeLinked,
            baseIncome,
            incomeLinesBudgeted,
            actualIncome,
          }),
        );
        expect(r.income).toBe(income);
        expect(r.incomeSource).toBe(src);
      },
    );

    it("reads a null actual income of a linked budget as NONE", () => {
      const r = computeBudgetBucketFigures(
        input({ incomeLinked: true, actualIncome: null }),
      );
      expect(r.income).toBeNull();
      expect(r.incomeSource).toBe("NONE");
    });
  });

  describe("truth table B: allocation and availability", () => {
    it("PERCENT 20 of 5000 with carry in 250 and spent 400", () => {
      const r = computeBudgetBucketFigures(
        input({
          buckets: [bucket({ carryOver: true })],
          lines: [line({ spent: 400 })],
          carriedIn: new Map([["b1", 250]]),
        }),
      );
      const b = r.buckets[0];
      expect(b.allocated).toBe(1000);
      expect(b.carriedIn).toBe(250);
      expect(b.available).toBe(850);
      expect(b.percentUsed).toBe(32);
    });

    it("PERCENT 20 of unknown income is null all the way down, never 0", () => {
      const r = computeBudgetBucketFigures(
        input({
          baseIncome: null,
          buckets: [bucket()],
          lines: [line({ spent: 400 })],
        }),
      );
      const b = r.buckets[0];
      expect(b.allocated).toBeNull();
      expect(b.available).toBeNull();
      expect(b.percentUsed).toBeNull();
      expect(b.spent).toBe(400);
      expect(b.carryOut).toBe(0);
    });

    it.each([5000, null])(
      "AMOUNT 1200 is 1200 whatever the income (%s)",
      (baseIncome) => {
        const r = computeBudgetBucketFigures(
          input({
            baseIncome,
            buckets: [
              bucket({
                targetType: BudgetBucketTargetType.AMOUNT,
                targetValue: 1200,
              }),
            ],
            lines: [line({ spent: 1350 })],
          }),
        );
        const b = r.buckets[0];
        expect(b.allocated).toBe(1200);
        expect(b.available).toBe(-150);
        expect(b.percentUsed).toBe(112.5);
      },
    );

    it("ignores carriedIn when the bucket has carry-over off", () => {
      const r = computeBudgetBucketFigures(
        input({
          buckets: [bucket({ carryOver: false })],
          lines: [line({ spent: 400 })],
          carriedIn: new Map([["b1", 250]]),
        }),
      );
      expect(r.buckets[0].carriedIn).toBe(0);
      expect(r.buckets[0].available).toBe(600);
      expect(r.buckets[0].percentUsed).toBe(40);
    });

    it("reads a bucket with no carry row as carriedIn 0", () => {
      const r = computeBudgetBucketFigures(
        input({ buckets: [bucket({ carryOver: true })] }),
      );
      expect(r.buckets[0].carriedIn).toBe(0);
    });

    it("percentUsed is 0 when allocated plus carriedIn is not greater than 0", () => {
      const r = computeBudgetBucketFigures(
        input({
          buckets: [
            bucket({
              targetType: BudgetBucketTargetType.AMOUNT,
              targetValue: 0.00001,
            }),
          ],
          decimals: 4,
          lines: [line({ spent: 10 })],
        }),
      );
      expect(r.buckets[0].allocated).toBe(0);
      expect(r.buckets[0].percentUsed).toBe(0);
      expect(r.buckets[0].available).toBe(-10);
    });

    it("keeps a negative spent (refunds exceed spending)", () => {
      const r = computeBudgetBucketFigures(
        input({
          buckets: [bucket()],
          lines: [line({ spent: -50 }), line({ spent: 20 })],
        }),
      );
      const b = r.buckets[0];
      expect(b.spent).toBe(-30);
      expect(b.available).toBe(1030);
      expect(b.percentUsed).toBe(-3);
    });
  });

  describe("truth table C: carry at close", () => {
    const carry = (
      over: Partial<BudgetBucketFigureBucket>,
      spent: number,
      baseIncome: number | null = 5000,
    ) =>
      computeBudgetBucketFigures(
        input({
          baseIncome,
          buckets: [bucket(over)],
          lines: [line({ spent })],
        }),
      ).buckets[0];

    it("carry off: 0", () => {
      expect(carry({ carryOver: false }, 150).carryOut).toBe(0);
    });
    it("carry on, allocated null: 0", () => {
      const b = carry({ carryOver: true }, 150, null);
      expect(b.allocated).toBeNull();
      expect(b.carryOut).toBe(0);
    });
    it("carry on, available 850, no cap: 850", () => {
      expect(carry({ carryOver: true }, 150).carryOut).toBe(850);
    });
    it("carry on, available 850, cap 500: 500", () => {
      const b = carry({ carryOver: true, carryCap: 500 }, 150);
      expect(b.available).toBe(850);
      expect(b.carryOut).toBe(500);
    });
    it("carry on, available -150: 0", () => {
      const b = carry({ carryOver: true, carryCap: 500 }, 1150);
      expect(b.available).toBe(-150);
      expect(b.carryOut).toBe(0);
    });
    it("carry on, available 0: 0", () => {
      const b = carry({ carryOver: true }, 1000);
      expect(b.available).toBe(0);
      expect(b.carryOut).toBe(0);
    });
    it("a cap above the available leaves the available", () => {
      expect(carry({ carryOver: true, carryCap: 900 }, 150).carryOut).toBe(850);
    });
  });

  describe("section 8 examples", () => {
    const buckets = [
      bucket({
        id: "fixed",
        name: "Fixed costs",
        targetValue: 50,
      }),
      bucket({
        id: "everyday",
        name: "Everyday",
        targetType: BudgetBucketTargetType.AMOUNT,
        targetValue: 1200,
      }),
      bucket({
        id: "savings",
        name: "Savings",
        targetValue: 20,
        carryOver: true,
      }),
    ];
    const lines = [
      line({ bucketId: "fixed", budgeted: 2300, spent: 1400 }),
      line({ bucketId: "fixed", budgeted: 100, spent: 1000 }),
      line({ bucketId: "everyday", budgeted: 1200, spent: 1350 }),
      line({ bucketId: "savings", budgeted: 400, spent: 400 }),
    ];

    it("computes the table to the cent", () => {
      const r = computeBudgetBucketFigures(
        input({
          buckets,
          lines,
          carriedIn: new Map([["savings", 250]]),
        }),
      );
      const [fixed, everyday, savings] = r.buckets;
      expect(fixed).toMatchObject({
        allocated: 2500,
        carriedIn: 0,
        spent: 2400,
        available: 100,
        percentUsed: 96,
        carryOut: 0,
        planned: 2400,
        lineCount: 2,
      });
      expect(everyday).toMatchObject({
        allocated: 1200,
        carriedIn: 0,
        spent: 1350,
        available: -150,
        percentUsed: 112.5,
        carryOut: 0,
      });
      expect(savings).toMatchObject({
        allocated: 1000,
        carriedIn: 250,
        spent: 400,
        available: 850,
        percentUsed: 32,
        carryOut: 850,
      });
      expect(r.totalAllocated).toBe(4700);
      expect(r.knownAllocated).toBe(4700);
      expect(r.unallocated).toBe(300);
      expect(r.income).toBe(5000);
      expect(r.incomeSource).toBe("BASE_INCOME");
    });

    it("caps the Savings carry at 500", () => {
      const capped = [buckets[0], buckets[1], { ...buckets[2], carryCap: 500 }];
      const r = computeBudgetBucketFigures(
        input({
          buckets: capped,
          lines,
          carriedIn: new Map([["savings", 250]]),
        }),
      );
      expect(r.buckets[2].carryOut).toBe(500);
      expect(r.buckets[2].available).toBe(850);
    });

    it("rounds income 3333.33 at PERCENT 33.33 to 1110.9989 at four decimals", () => {
      const r = computeBudgetBucketFigures(
        input({
          baseIncome: 3333.33,
          buckets: [bucket({ targetValue: 33.33 })],
        }),
      );
      expect(r.buckets[0].allocated).toBe(1110.9989);
    });

    it("rounds at the currency's decimals", () => {
      const r = computeBudgetBucketFigures(
        input({
          baseIncome: 3333.33,
          decimals: 2,
          buckets: [bucket({ targetValue: 33.33 })],
        }),
      );
      expect(r.buckets[0].allocated).toBe(1111);
    });

    it("unknown income: percent buckets null, total null, known 1200, unallocated null", () => {
      const r = computeBudgetBucketFigures(
        input({
          baseIncome: null,
          buckets,
          lines,
          carriedIn: new Map([["savings", 250]]),
        }),
      );
      expect(r.income).toBeNull();
      expect(r.incomeSource).toBe("NONE");
      expect(r.buckets[0].allocated).toBeNull();
      expect(r.buckets[1].allocated).toBe(1200);
      expect(r.buckets[2].allocated).toBeNull();
      expect(r.totalAllocated).toBeNull();
      expect(r.knownAllocated).toBe(1200);
      expect(r.unallocated).toBeNull();
      expect(r.buckets[2].carryOut).toBe(0);
    });
  });

  describe("sums and membership", () => {
    it("sums ten lines of 0.1 to exactly 1", () => {
      const r = computeBudgetBucketFigures(
        input({
          buckets: [bucket()],
          lines: Array.from({ length: 10 }, () =>
            line({ budgeted: 0.1, spent: 0.1 }),
          ),
        }),
      );
      expect(r.buckets[0].planned).toBe(1);
      expect(r.buckets[0].spent).toBe(1);
      expect(r.buckets[0].lineCount).toBe(10);
    });

    it("counts lines with no bucket as unassigned", () => {
      const r = computeBudgetBucketFigures(
        input({
          buckets: [bucket()],
          lines: [
            line({ budgeted: 100, spent: 40 }),
            line({ bucketId: null, budgeted: 120, spent: 80 }),
          ],
        }),
      );
      expect(r.unassigned).toEqual({ planned: 120, spent: 80, lineCount: 1 });
      expect(r.buckets[0].lineCount).toBe(1);
    });

    it("counts a line naming an unknown bucket as unassigned", () => {
      const r = computeBudgetBucketFigures(
        input({
          buckets: [bucket()],
          lines: [line({ bucketId: "gone", budgeted: 5, spent: 3 })],
        }),
      );
      expect(r.unassigned).toEqual({ planned: 5, spent: 3, lineCount: 1 });
    });

    it("never counts an income line in a bucket or in unassigned", () => {
      const r = computeBudgetBucketFigures(
        input({
          buckets: [bucket()],
          lines: [
            line({ isIncome: true, budgeted: 5000, spent: 5200 }),
            line({ isIncome: true, bucketId: null, spent: 10 }),
            line({ budgeted: 100, spent: 60 }),
          ],
        }),
      );
      expect(r.buckets[0]).toMatchObject({
        planned: 100,
        spent: 60,
        lineCount: 1,
      });
      expect(r.unassigned).toEqual({ planned: 0, spent: 0, lineCount: 0 });
    });

    it("an empty bucket list is a valid answer", () => {
      const r = computeBudgetBucketFigures(input());
      expect(r.buckets).toEqual([]);
      expect(r.totalAllocated).toBe(0);
      expect(r.knownAllocated).toBe(0);
      expect(r.unallocated).toBe(5000);
    });

    it("reports a negative unallocated when buckets over-allocate income", () => {
      const r = computeBudgetBucketFigures(
        input({
          buckets: [
            bucket({ targetValue: 70 }),
            bucket({ id: "b2", targetValue: 50 }),
          ],
        }),
      );
      expect(r.totalAllocated).toBe(6000);
      expect(r.unallocated).toBe(-1000);
    });
  });
});
