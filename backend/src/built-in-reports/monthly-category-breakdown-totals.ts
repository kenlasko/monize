import { FxAggregate } from "../common/fx-aggregate";
import { reportFigure } from "../common/report-figure";

/**
 * The Monthly & Yearly Breakdown's totals, worked out from the cells'
 * aggregates (`docs/specs/report-rounding-and-aggregation.md` rules 2, 4 and
 * 8, issue #2413). The page used to add its rounded cells into every row
 * total, section subtotal, group total, balance and overall line, so a row of
 * three 0.005 months read 0.03 where its months come to 0.015, read 0.02.
 * Here every figure is the single rounding of the exact sum of the cells it
 * holds, and every average divides that sum before it is read.
 */

/** The section the uncategorized income row collects into. */
export const OTHER_INCOME_SECTION = "__other_income__";
/** The section the uncategorized expense row collects into. */
export const OTHER_EXPENSE_SECTION = "__other_expense__";

/** What a row's section is decided from. */
export interface SectionedRow {
  categoryId: string | null;
  parentId: string | null;
  parentName: string | null;
  parentIsIncome: boolean | null;
  isIncome: boolean;
}

/**
 * The section a row draws under: its parent's, when it has a named parent; its
 * own, for a top-level category (so a parent's direct spending sits beside its
 * subcategories and a category with none stands alone); and the "Other income"
 * or "Other expenses" bucket by its type for the uncategorized row.
 */
export function sectionKeyOf(row: SectionedRow): string {
  if (row.parentId && row.parentName) return row.parentId;
  if (row.categoryId) return row.categoryId;
  return row.isIncome ? OTHER_INCOME_SECTION : OTHER_EXPENSE_SECTION;
}

/** Whether the section a row opens is income: the parent's flag where it has one. */
export function sectionIsIncomeOf(row: SectionedRow): boolean {
  return row.parentId && row.parentName
    ? (row.parentIsIncome ?? row.isIncome)
    : row.isIncome;
}

/** A line of figures: one per column, the window's total and its average. */
export interface BreakdownFigures {
  valuesByMonth: Record<string, number>;
  total: number;
  /** The total over the columns shown, divided before it is read. */
  average: number;
}

/** A category row's money: deposits less withdrawals, per column. */
export interface BreakdownRowNet {
  row: SectionedRow;
  netByColumn: ReadonlyMap<string, FxAggregate>;
}

/** A transfer row's signed flow per column ("from" positive, "to" negative). */
export type BreakdownTransferFlows = ReadonlyMap<string, FxAggregate>;

export interface BreakdownTotals {
  /** Each category row's total and average, in its own sign convention. */
  rows: { total: number; average: number }[];
  /** Each transfer row's total and average, signed as its cells are. */
  transfers: { total: number; average: number }[];
  sections: (BreakdownFigures & { key: string; isIncome: boolean })[];
  summary: {
    /** The income sections' figures, money in positive. */
    income: BreakdownFigures;
    /** The expense sections' figures, money out positive. */
    expenses: BreakdownFigures;
    /** Income less expenses. */
    balance: BreakdownFigures;
    /** The transfer rows' net. */
    transfers: BreakdownFigures;
    /** The balance with the transfers folded in. */
    overall: BreakdownFigures;
  };
}

/** One aggregate per column. */
type ColumnSums = Map<string, FxAggregate>;

/** `parts` folded into `sums` column by column, negated when asked. */
function addColumns(
  sums: ColumnSums,
  parts: ReadonlyMap<string, FxAggregate>,
  negate = false,
): void {
  for (const [column, part] of parts) {
    const sum = sums.get(column) ?? new FxAggregate();
    if (negate) sum.mergeNegated(part);
    else sum.merge(part);
    sums.set(column, sum);
  }
}

/** `sums` read once per column, its total and its average over `columns`. */
function figuresOf(
  sums: ColumnSums,
  columns: readonly string[],
  places: number,
): BreakdownFigures {
  const valuesByMonth: Record<string, number> = {};
  for (const column of columns) {
    valuesByMonth[column] = sums.get(column)?.knownSubtotalAt(places) ?? 0;
  }
  const whole = FxAggregate.sum(
    columns.flatMap((column) => {
      const sum = sums.get(column);
      return sum ? [sum] : [];
    }),
  );
  return {
    valuesByMonth,
    total: whole.knownSubtotalAt(places),
    average: averageOf(whole, columns.length, places),
  };
}

function averageOf(whole: FxAggregate, columns: number, places: number) {
  return columns > 0
    ? reportFigure(whole.unroundedSubtotal / columns, places)
    : 0;
}

/** A row's total and average over `columns`, from its own cells. */
function rowFigures(
  cells: ReadonlyMap<string, FxAggregate>,
  columns: readonly string[],
  places: number,
  negate: boolean,
): { total: number; average: number } {
  const whole = new FxAggregate();
  for (const column of columns) {
    const cell = cells.get(column);
    if (!cell) continue;
    if (negate) whole.mergeNegated(cell);
    else whole.merge(cell);
  }
  return {
    total: whole.knownSubtotalAt(places),
    average: averageOf(whole, columns.length, places),
  };
}

/** A transfer row's total and average over `columns`, signed as its cells. */
export function breakdownRowFigures(
  flows: BreakdownTransferFlows,
  columns: readonly string[],
  places: number,
): { total: number; average: number } {
  return rowFigures(flows, columns, places, false);
}

/**
 * Every total of the breakdown over `columns` (the column keys the response
 * lists, months or years). A row's figures are in its own convention, as its
 * cells are: money in positive for an income row, money out positive for an
 * expense row. A section's are in the section's convention, so a refund-heavy
 * expense subcategory still subtracts from its expense section. The groups,
 * the balance, the transfers and the overall line fold the sections' and the
 * transfer rows' aggregates, never their readings.
 */
export function breakdownTotals(
  categoryRows: readonly BreakdownRowNet[],
  transferRows: readonly BreakdownTransferFlows[],
  columns: readonly string[],
  places: number,
): BreakdownTotals {
  const sections = new Map<string, { isIncome: boolean; sums: ColumnSums }>();
  const income: ColumnSums = new Map();
  const expenses: ColumnSums = new Map();

  const rows = categoryRows.map(({ row, netByColumn }) => {
    const key = sectionKeyOf(row);
    const section = sections.get(key) ?? {
      isIncome: sectionIsIncomeOf(row),
      sums: new Map(),
    };
    // Deposits less withdrawals is money in, so an expense section reads it
    // negated: positive is what it cost. A row and a section carry the side
    // they are listed on, which the service derived from the category's type.
    // income-flag-ok: a section's listed side, not a category's type
    addColumns(section.sums, netByColumn, !section.isIncome);
    sections.set(key, section);
    // income-flag-ok: a row's listed side, not a category's type
    return rowFigures(netByColumn, columns, places, !row.isIncome);
  });

  for (const section of sections.values()) {
    addColumns(section.isIncome ? income : expenses, section.sums);
  }

  const balance: ColumnSums = new Map();
  addColumns(balance, income);
  addColumns(balance, expenses, true);

  const transferSum: ColumnSums = new Map();
  const transfers = transferRows.map((flows) => {
    addColumns(transferSum, flows);
    return rowFigures(flows, columns, places, false);
  });

  const overall: ColumnSums = new Map();
  addColumns(overall, balance);
  addColumns(overall, transferSum);

  return {
    rows,
    transfers,
    sections: [...sections].map(([key, section]) => ({
      key,
      isIncome: section.isIncome,
      ...figuresOf(section.sums, columns, places),
    })),
    summary: {
      income: figuresOf(income, columns, places),
      expenses: figuresOf(expenses, columns, places),
      balance: figuresOf(balance, columns, places),
      transfers: figuresOf(transferSum, columns, places),
      overall: figuresOf(overall, columns, places),
    },
  };
}
