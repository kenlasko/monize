import { sumMoney } from '@/lib/format';
import type {
  MonthlyBreakdownCategoryRow,
  MonthlyBreakdownFigures,
  MonthlyBreakdownTransferRow,
  MonthlyCategoryBreakdownParams,
  MonthlyCategoryBreakdownResponse,
} from '@/types/built-in-reports';

/** A breakdown row as a fixture writes it: the server's totals left for {@link serveBreakdown}. */
export type BreakdownFixtureRow = Omit<MonthlyBreakdownCategoryRow, 'sectionKey' | 'total' | 'average'> &
  Partial<Pick<MonthlyBreakdownCategoryRow, 'sectionKey' | 'total' | 'average'>>;

export type BreakdownFixtureTransfer = Omit<MonthlyBreakdownTransferRow, 'total' | 'average'> &
  Partial<Pick<MonthlyBreakdownTransferRow, 'total' | 'average'>>;

/** A breakdown answer as a fixture writes it: monthly cells, the totals left for {@link serveBreakdown}. */
export interface BreakdownFixture {
  months: string[];
  data: BreakdownFixtureRow[];
  transfers?: BreakdownFixtureTransfer[];
  currency: string;
  missingCurrencies: string[];
  excludedCount: number;
  period?: 'month' | 'year';
  sections?: MonthlyCategoryBreakdownResponse['sections'];
  summary?: MonthlyCategoryBreakdownResponse['summary'];
}

const OTHER_INCOME = '__other_income__';
const OTHER_EXPENSE = '__other_expense__';

/**
 * A fixture answered the way the server answers it (issue #2413): folded into
 * years when `params.period` asks for them, cut at `params.endDate`, and given
 * the row, section, group, balance, transfer and overall figures the endpoint
 * sends. Fixtures write whole cents, which add exactly, so a test of the page's
 * layout and drill-downs need not restate every total; a test of a figure the
 * page must take from the server writes `summary` itself, and nothing here
 * replaces it.
 */
export function serveBreakdown(
  fixture: BreakdownFixture | null | undefined,
  params?: MonthlyCategoryBreakdownParams,
): MonthlyCategoryBreakdownResponse | null | undefined {
  if (!fixture) return fixture as null | undefined;
  if (fixture.summary && fixture.sections && fixture.period) {
    return fixture as MonthlyCategoryBreakdownResponse;
  }
  const period = params?.period ?? 'month';
  const endKey = params?.endDate
    ? period === 'year'
      ? params.endDate.slice(0, 4)
      : params.endDate.slice(0, 7)
    : null;
  const columnOf = (month: string) => (period === 'year' ? month.slice(0, 4) : month);
  const keep = (column: string) => endKey === null || column <= endKey;
  const fold = (values: Record<string, number>) => {
    const parts = new Map<string, number[]>();
    for (const [month, value] of Object.entries(values)) {
      const column = columnOf(month);
      if (!keep(column)) continue;
      parts.set(column, [...(parts.get(column) ?? []), value]);
    }
    return Object.fromEntries([...parts].map(([column, list]) => [column, sumMoney(list)]));
  };
  const months = [...new Set(fixture.months.map(columnOf))].filter(keep).sort();
  const count = months.length;
  const figures = (byColumn: Record<string, number[]>): MonthlyBreakdownFigures => {
    const valuesByMonth = Object.fromEntries(months.map((m) => [m, sumMoney(byColumn[m] ?? [])]));
    const total = sumMoney(Object.values(valuesByMonth));
    return { valuesByMonth, total, average: count > 0 ? sumMoney([total / count], 2) : 0 };
  };
  const lineOf = (values: Record<string, number>) => {
    const total = sumMoney(months.map((m) => values[m] ?? 0));
    return { total, average: count > 0 ? sumMoney([total / count], 2) : 0 };
  };

  const sectionCells = new Map<string, { isIncome: boolean; cells: Record<string, number[]> }>();
  const data = fixture.data.map((row) => {
    const valuesByMonth = fold(row.valuesByMonth);
    const sectionKey =
      row.sectionKey ??
      (row.parentId && row.parentName
        ? row.parentId
        : row.categoryId ?? (row.isIncome ? OTHER_INCOME : OTHER_EXPENSE));
    const sectionIsIncome =
      row.parentId && row.parentName ? (row.parentIsIncome ?? row.isIncome) : row.isIncome;
    const section = sectionCells.get(sectionKey) ?? { isIncome: sectionIsIncome, cells: {} };
    for (const [m, value] of Object.entries(valuesByMonth)) {
      const inSection = row.isIncome === section.isIncome ? value : -value;
      section.cells[m] = [...(section.cells[m] ?? []), inSection];
    }
    sectionCells.set(sectionKey, section);
    return { ...row, valuesByMonth, sectionKey, ...lineOf(valuesByMonth) };
  });
  const transferCells: Record<string, number[]> = {};
  const transfers = (fixture.transfers ?? []).map((row) => {
    const valuesByMonth = fold(row.valuesByMonth);
    // A parent's roll-up repeats its rows' legs: never in the group total.
    for (const [m, value] of Object.entries(row.isSubtotal ? {} : valuesByMonth)) {
      transferCells[m] = [...(transferCells[m] ?? []), value];
    }
    return { ...row, valuesByMonth, ...lineOf(valuesByMonth) };
  });

  const sections = [...sectionCells].map(([key, section]) => ({
    key,
    isIncome: section.isIncome,
    ...figures(section.cells),
  }));
  const groupCells = (isIncome: boolean) => {
    const cells: Record<string, number[]> = {};
    for (const section of sections.filter((s) => s.isIncome === isIncome)) {
      for (const m of months) cells[m] = [...(cells[m] ?? []), section.valuesByMonth[m]];
    }
    return cells;
  };
  const income = figures(groupCells(true));
  const expenses = figures(groupCells(false));
  const balanceCells = Object.fromEntries(
    months.map((m) => [m, [income.valuesByMonth[m], -expenses.valuesByMonth[m]]]),
  );
  const balance = figures(balanceCells);
  const transferLine = figures(transferCells);
  const overall = figures(
    Object.fromEntries(months.map((m) => [m, [balance.valuesByMonth[m], transferLine.valuesByMonth[m]]])),
  );

  return {
    ...fixture,
    period,
    months,
    data,
    transfers,
    sections,
    summary: fixture.summary ?? { income, expenses, balance, transfers: transferLine, overall },
  };
}
