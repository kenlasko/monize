import { roundMoney, sumMoney } from "../common/round.util";
import { BudgetBucketTargetType } from "./entities/budget-bucket.entity";

/**
 * The one place the bucket arithmetic of docs/future-plans/bucket-budget.md
 * section 4 is written (INV-BUDGET-001). The live read
 * (`BudgetBucketReportsService`) and the period close
 * (`BudgetPeriodService.closePeriod`) both call it, through
 * `buildBudgetBucketFiguresInput`; no other
 * code adds, subtracts or divides bucket figures. Pure: no I/O, no dates.
 *
 * Every sum goes through `sumMoney` and every derived amount through
 * `roundMoney`, with the budget currency's money `decimals`. An unknown
 * allocation is `null`, never 0, and so is everything derived from it; a
 * subtotal is not a total, so `totalAllocated` is `null` when any allocation
 * is unknown while `knownAllocated` carries the partial sum.
 */

export type BudgetBucketIncomeSource =
  "ACTUAL" | "BASE_INCOME" | "INCOME_LINES" | "NONE";

export interface BudgetBucketFigureBucket {
  id: string;
  name: string;
  targetType: BudgetBucketTargetType | `${BudgetBucketTargetType}`;
  targetValue: number;
  carryOver: boolean;
  carryCap: number | null;
}

/** One budget line as the live summary reports it. */
export interface BudgetBucketFigureLine {
  bucketId: string | null;
  isIncome: boolean;
  budgeted: number;
  spent: number;
}

export interface BudgetBucketFiguresInput {
  buckets: readonly BudgetBucketFigureBucket[];
  lines: readonly BudgetBucketFigureLine[];
  incomeLinked: boolean;
  baseIncome: number | null;
  /** Sum of the income lines' budgeted amounts. */
  incomeLinesBudgeted: number;
  /** Income actually received in the period (used when `incomeLinked`). */
  actualIncome: number | null;
  /** `budget_period_buckets.carry_in` by bucket id; absent reads as 0. */
  carriedIn: ReadonlyMap<string, number>;
  /** The budget currency's money decimals (`moneyDecimalsFor`). */
  decimals: number;
}

export interface BudgetBucketFigure {
  bucketId: string;
  name: string;
  targetType: BudgetBucketFigureBucket["targetType"];
  targetValue: number;
  carryOver: boolean;
  carryCap: number | null;
  /** `null` when a PERCENT target meets an unknown income. */
  allocated: number | null;
  carriedIn: number;
  planned: number;
  spent: number;
  /** `null` when `allocated` is. */
  available: number | null;
  /** Two decimals; `null` when `allocated` is; 0 when the base is not > 0. */
  percentUsed: number | null;
  lineCount: number;
  /** What the period close carries forward (truth table C). */
  carryOut: number;
}

export interface BudgetBucketFigures {
  income: number | null;
  incomeSource: BudgetBucketIncomeSource;
  totalAllocated: number | null;
  knownAllocated: number;
  unallocated: number | null;
  buckets: BudgetBucketFigure[];
  unassigned: { planned: number; spent: number; lineCount: number };
}

/** One budget line's figures for a period, keyed by the line's id. */
export interface BudgetBucketLineRow {
  budgetCategoryId: string;
  isIncome: boolean;
  budgeted: number;
  spent: number;
}

/** What both callers hold before the figures are computed. */
export interface BudgetBucketInputSource {
  budget: {
    buckets?: readonly BudgetBucketFigureBucket[];
    /** The budget's lines, for each line's bucket. */
    categories?: readonly { id: string; bucketId?: string | null }[];
    incomeLinked: boolean;
    baseIncome: number | null;
  };
  /** The period's line figures: the live summary's rows, or the close's. */
  rows: readonly BudgetBucketLineRow[];
  /** The summary's `actualIncome`: income received, or null when not linked. */
  actualIncome: number | null;
  carriedIn: ReadonlyMap<string, number>;
  decimals: number;
}

/**
 * The one builder of `computeBudgetBucketFigures`' input. The live read
 * (`BudgetBucketReportsService`) passes the summary's rows; the period close
 * (`BudgetPeriodService.closePeriod`) passes the rows it is freezing. Both
 * reach the arithmetic through the same input, so a frozen snapshot is the
 * figure the live card showed for the same rows (INV-BUDGET-001).
 */
export function buildBudgetBucketFiguresInput(
  source: BudgetBucketInputSource,
): BudgetBucketFiguresInput {
  const { budget, decimals } = source;
  const bucketIdByLine = new Map<string, string | null>();
  for (const bc of budget.categories ?? []) {
    bucketIdByLine.set(bc.id, bc.bucketId ?? null);
  }
  const lines = source.rows.map((row) => ({
    bucketId: bucketIdByLine.get(row.budgetCategoryId) ?? null,
    isIncome: row.isIncome,
    budgeted: row.budgeted,
    spent: row.spent,
  }));
  return {
    buckets: budget.buckets ?? [],
    lines,
    incomeLinked: budget.incomeLinked,
    baseIncome: budget.baseIncome ?? null,
    incomeLinesBudgeted: sumMoney(
      lines.filter((l) => l.isIncome).map((l) => l.budgeted),
      decimals,
    ),
    actualIncome: source.actualIncome,
    carriedIn: source.carriedIn,
    decimals,
  };
}

const PERCENT_USED_DECIMALS = 2;

function resolveIncome(
  input: BudgetBucketFiguresInput,
): Pick<BudgetBucketFigures, "income" | "incomeSource"> {
  const { decimals } = input;
  const pick = (
    value: number | null,
    source: BudgetBucketIncomeSource,
  ): Pick<BudgetBucketFigures, "income" | "incomeSource"> =>
    value !== null && value > 0
      ? { income: roundMoney(value, decimals), incomeSource: source }
      : { income: null, incomeSource: "NONE" };

  if (input.incomeLinked) return pick(input.actualIncome, "ACTUAL");
  if (input.baseIncome !== null && input.baseIncome > 0) {
    return pick(input.baseIncome, "BASE_INCOME");
  }
  return pick(input.incomeLinesBudgeted, "INCOME_LINES");
}

function carryOutOf(
  bucket: BudgetBucketFigureBucket,
  allocated: number | null,
  available: number | null,
  decimals: number,
): number {
  if (!bucket.carryOver || allocated === null || available === null) return 0;
  const carried = Math.max(available, 0);
  return bucket.carryCap === null
    ? carried
    : roundMoney(Math.min(carried, bucket.carryCap), decimals);
}

export function computeBudgetBucketFigures(
  input: BudgetBucketFiguresInput,
): BudgetBucketFigures {
  const { decimals } = input;
  const { income, incomeSource } = resolveIncome(input);

  // Income lines are never members of a bucket, whatever their row carries.
  const expenseLines = input.lines.filter((line) => !line.isIncome);
  const bucketIds = new Set(input.buckets.map((b) => b.id));

  const buckets: BudgetBucketFigure[] = input.buckets.map((bucket) => {
    const members = expenseLines.filter((line) => line.bucketId === bucket.id);
    const planned = sumMoney(
      members.map((l) => l.budgeted),
      decimals,
    );
    const spent = sumMoney(
      members.map((l) => l.spent),
      decimals,
    );
    const allocated =
      bucket.targetType === BudgetBucketTargetType.AMOUNT
        ? roundMoney(bucket.targetValue, decimals)
        : income === null
          ? null
          : roundMoney((income * bucket.targetValue) / 100, decimals);
    const carriedIn = bucket.carryOver
      ? roundMoney(input.carriedIn.get(bucket.id) ?? 0, decimals)
      : 0;

    let available: number | null = null;
    let percentUsed: number | null = null;
    if (allocated !== null) {
      available = sumMoney([allocated, carriedIn, -spent], decimals);
      const base = sumMoney([allocated, carriedIn], decimals);
      percentUsed =
        base > 0 ? roundMoney((spent / base) * 100, PERCENT_USED_DECIMALS) : 0;
    }

    return {
      bucketId: bucket.id,
      name: bucket.name,
      targetType: bucket.targetType,
      targetValue: bucket.targetValue,
      carryOver: bucket.carryOver,
      carryCap: bucket.carryCap,
      allocated,
      carriedIn,
      planned,
      spent,
      available,
      percentUsed,
      lineCount: members.length,
      carryOut: carryOutOf(bucket, allocated, available, decimals),
    };
  });

  const known = buckets
    .map((b) => b.allocated)
    .filter((a): a is number => a !== null);
  const knownAllocated = sumMoney(known, decimals);
  const totalAllocated =
    known.length === buckets.length ? knownAllocated : null;
  const unallocated =
    income !== null && totalAllocated !== null
      ? sumMoney([income, -totalAllocated], decimals)
      : null;

  const loose = expenseLines.filter(
    (line) => line.bucketId === null || !bucketIds.has(line.bucketId),
  );

  return {
    income,
    incomeSource,
    totalAllocated,
    knownAllocated,
    unallocated,
    buckets,
    unassigned: {
      planned: sumMoney(
        loose.map((l) => l.budgeted),
        decimals,
      ),
      spent: sumMoney(
        loose.map((l) => l.spent),
        decimals,
      ),
      lineCount: loose.length,
    },
  };
}
