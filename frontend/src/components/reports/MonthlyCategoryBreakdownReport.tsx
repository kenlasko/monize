'use client';

import { Fragment, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Skeleton } from '@/components/ui/LoadingSkeleton';
import { builtInReportsApi } from '@/lib/built-in-reports';
import {
  MonthlyBreakdownCategoryRow,
  MonthlyBreakdownTransferRow,
} from '@/types/built-in-reports';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useDateRange } from '@/hooks/useDateRange';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { useReportData } from '@/hooks/useReportData';
import { DateRangeSelector } from '@/components/ui/DateRangeSelector';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { SortableHeader } from '@/components/ui/SortableHeader';
import { ReportError } from '@/components/reports/ReportError';
import { exportToCsv } from '@/lib/csv-export';

const RANGE_STORAGE_KEY = 'monize-reports-monthly-category-breakdown-range';
const PERCENTAGES_STORAGE_KEY =
  'monize-reports-monthly-category-breakdown-percentages';
const DEVIATIONS_STORAGE_KEY =
  'monize-reports-monthly-category-breakdown-deviations';
const SORT_COLUMN_STORAGE_KEY =
  'monize-reports-monthly-category-breakdown-sort-column';
const SORT_DIR_STORAGE_KEY =
  'monize-reports-monthly-category-breakdown-sort-dir';
const INCLUDE_CURRENT_MONTH_STORAGE_KEY =
  'monize-reports-monthly-category-breakdown-include-current-month';

// Deviation thresholds (fraction of the non-zero average) mirroring yaffa.
const DEVIATION_LEVEL_1 = 0.05;
const DEVIATION_LEVEL_2 = 0.1;
const DEVIATION_LEVEL_3 = 0.15;

// Minimum non-zero months before deviation highlighting kicks in.
const MIN_NON_ZERO_FOR_DEVIATION = 3;

/**
 * Rotating palette for section headers and subtotal rows. Each entry pairs a
 * header background/text class set with a subtotal accent border so adjacent
 * parent groups stay visually distinct (translated from yaffa's Bootstrap
 * s-section-N classes to Tailwind, dark-mode aware).
 */
const SECTION_PALETTE = [
  'bg-blue-50 text-blue-800 dark:bg-blue-900/30 dark:text-blue-200',
  'bg-orange-50 text-orange-800 dark:bg-orange-900/30 dark:text-orange-200',
  'bg-green-50 text-green-800 dark:bg-green-900/30 dark:text-green-200',
  'bg-teal-50 text-teal-800 dark:bg-teal-900/30 dark:text-teal-200',
  'bg-purple-50 text-purple-800 dark:bg-purple-900/30 dark:text-purple-200',
  'bg-pink-50 text-pink-800 dark:bg-pink-900/30 dark:text-pink-200',
  'bg-amber-50 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200',
  'bg-cyan-50 text-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-200',
];
const OTHER_PALETTE =
  'bg-gray-100 text-gray-700 dark:bg-gray-700/50 dark:text-gray-200';

// Top-level group header bars. Income is rendered first (green), expenses
// second (red), transfers last (blue) so the parts of the report are visually
// unmistakable.
const INCOME_GROUP_CLASS =
  'bg-green-100 text-green-900 dark:bg-green-900/40 dark:text-green-100';
const EXPENSE_GROUP_CLASS =
  'bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-100';
const TRANSFER_GROUP_CLASS =
  'bg-blue-100 text-blue-900 dark:bg-blue-900/40 dark:text-blue-100';

const OTHER_INCOME_KEY = '__other_income__';
const OTHER_EXPENSE_KEY = '__other_expense__';

// Synthetic category id the backend assigns to brokerage income (interest,
// dividends, capital gains) cash legs; kept in sync with the backend's
// INVESTMENT_INCOME_PSEUDO_CATEGORY. The label is localized here rather than
// server-side, mirroring how the report translates its other synthetic buckets.
const INVESTMENT_INCOME_CATEGORY_ID = 'investment-income';
const isOtherKey = (key: string): boolean =>
  key === OTHER_INCOME_KEY || key === OTHER_EXPENSE_KEY;

// Deviation cell background classes. "high" = above average, "low" = below.
const DEVIATION_CLASS: Record<string, string> = {
  'high-1': 'bg-red-50 dark:bg-red-900/20',
  'high-2': 'bg-red-100 dark:bg-red-900/40',
  'high-3': 'bg-red-200 dark:bg-red-900/60',
  'low-1': 'bg-green-50 dark:bg-green-900/20',
  'low-2': 'bg-green-100 dark:bg-green-900/40',
  'low-3': 'bg-green-200 dark:bg-green-900/60',
};

interface ProcessedRow {
  categoryId: string | null;
  displayName: string;
  isIncome: boolean;
  values: Record<string, number>;
  total: number;
  avg: number;
  nonZeroAvg: number;
  nonZeroCount: number;
}

interface Section {
  title: string;
  paletteClass: string;
  rows: ProcessedRow[];
  subtotals: Record<string, number>;
  subtotalSum: number;
  subtotalAvg: number;
  allCategoryIds: string[];
  isIncome: boolean;
  isOther: boolean;
}

interface TransferRow {
  accountId: string;
  direction: 'from' | 'to';
  displayName: string;
  values: Record<string, number>;
  total: number;
  avg: number;
}

// Sort state. A column is the category name, a YYYY-MM month, the total or the
// average; rows and sections are ordered by the same key.
type SortDir = 'asc' | 'desc';
const CATEGORY_COLUMN = 'category';
const TOTAL_COLUMN = 'total';
const AVG_COLUMN = 'avg';

function rowSortKey(row: ProcessedRow, column: string): number | string {
  if (column === CATEGORY_COLUMN) return row.displayName;
  if (column === TOTAL_COLUMN) return row.total;
  if (column === AVG_COLUMN) return row.avg;
  return row.values[column] || 0;
}

function sectionSortKey(section: Section, column: string): number | string {
  if (column === CATEGORY_COLUMN) return section.title;
  if (column === TOTAL_COLUMN) return section.subtotalSum;
  if (column === AVG_COLUMN) return section.subtotalAvg;
  return section.subtotals[column] || 0;
}

function compareKeys(
  a: number | string,
  b: number | string,
  dir: SortDir,
): number {
  const cmp =
    typeof a === 'string' && typeof b === 'string'
      ? a.localeCompare(b)
      : (a as number) - (b as number);
  return dir === 'asc' ? cmp : -cmp;
}

const SCALE = 10000;
function roundMoney(value: number): number {
  return Math.round(value * SCALE) / SCALE;
}
function sumMoney(values: number[]): number {
  const units = values.reduce(
    (acc, v) => acc + (Number.isFinite(v) ? Math.round(v * SCALE) : 0),
    0,
  );
  return units / SCALE;
}

function processGroup(
  rows: MonthlyBreakdownCategoryRow[],
  months: string[],
  monthCount: number,
  sectionIsIncome: boolean,
  sortColumn: string,
  sortDir: SortDir,
): Omit<Section, 'title' | 'paletteClass' | 'isIncome' | 'isOther'> {
  const processed: ProcessedRow[] = rows
    .map((row) => {
      // Re-express every month value in the section's sign convention so the
      // subtotal is correct even when a subcategory's net runs against the
      // section (e.g. a refund-heavy expense subcategory whose net is
      // positive must still subtract from the expense subtotal). The raw net
      // (deposits - withdrawals) is recovered from the row's own convention,
      // then re-signed for the section.
      const values: Record<string, number> = {};
      for (const m of months) {
        const own = row.valuesByMonth[m] || 0;
        const rawNet = row.isIncome ? own : -own;
        values[m] = roundMoney(sectionIsIncome ? rawNet : -rawNet);
      }
      const total = sumMoney(months.map((m) => values[m] || 0));
      const nonZeroCount = months.filter((m) => (values[m] || 0) !== 0).length;
      const avg = nonZeroCount > 0 ? total / monthCount : 0;
      const nonZeroAvg = nonZeroCount > 0 ? total / nonZeroCount : 0;
      return {
        categoryId: row.categoryId,
        displayName: row.categoryName,
        isIncome: sectionIsIncome,
        values,
        total: roundMoney(total),
        avg: roundMoney(avg),
        nonZeroAvg,
        nonZeroCount,
      };
    })
    .sort((a, b) => {
      const primary = compareKeys(
        rowSortKey(a, sortColumn),
        rowSortKey(b, sortColumn),
        sortDir,
      );
      // Tie-break alphabetically so equal values keep a stable order.
      return primary !== 0 ? primary : a.displayName.localeCompare(b.displayName);
    });

  const subtotals: Record<string, number> = {};
  for (const m of months) {
    subtotals[m] = sumMoney(processed.map((r) => r.values[m] || 0));
  }
  const subtotalSum = sumMoney(processed.map((r) => r.total));
  const subtotalAvg = roundMoney(subtotalSum / monthCount);
  const allCategoryIds = processed
    .map((r) => r.categoryId)
    .filter((id): id is string => id != null);

  return { rows: processed, subtotals, subtotalSum, subtotalAvg, allCategoryIds };
}

function transferSortKey(row: TransferRow, column: string): number | string {
  if (column === CATEGORY_COLUMN) return row.displayName;
  if (column === TOTAL_COLUMN) return row.total;
  if (column === AVG_COLUMN) return row.avg;
  return row.values[column] || 0;
}

// Process the signed transfer rows: re-key by month, compute totals/averages
// and order by the active sort. Values keep their backend sign ("from" rows
// positive, "to" rows negative) so they sum into a meaningful net.
function processTransfers(
  transfers: MonthlyBreakdownTransferRow[],
  months: string[],
  monthCount: number,
  fromLabel: (name: string) => string,
  toLabel: (name: string) => string,
  sortColumn: string,
  sortDir: SortDir,
): {
  rows: TransferRow[];
  monthly: Record<string, number>;
  totalSum: number;
  totalAvg: number;
} {
  const rows: TransferRow[] = transfers
    .map((tr) => {
      const values: Record<string, number> = {};
      for (const m of months) values[m] = roundMoney(tr.valuesByMonth[m] || 0);
      const total = sumMoney(months.map((m) => values[m] || 0));
      const nonZeroCount = months.filter((m) => (values[m] || 0) !== 0).length;
      const avg = nonZeroCount > 0 ? total / monthCount : 0;
      return {
        accountId: tr.accountId,
        direction: tr.direction,
        displayName:
          tr.direction === 'from'
            ? fromLabel(tr.accountName)
            : toLabel(tr.accountName),
        values,
        total: roundMoney(total),
        avg: roundMoney(avg),
      };
    })
    .sort((a, b) => {
      const primary = compareKeys(
        transferSortKey(a, sortColumn),
        transferSortKey(b, sortColumn),
        sortDir,
      );
      return primary !== 0 ? primary : a.displayName.localeCompare(b.displayName);
    });

  const monthly: Record<string, number> = {};
  for (const m of months) monthly[m] = sumMoney(rows.map((r) => r.values[m] || 0));
  const totalSum = sumMoney(rows.map((r) => r.total));
  const totalAvg = roundMoney(totalSum / monthCount);
  return { rows, monthly, totalSum, totalAvg };
}

function deviationClass(
  value: number,
  avg: number,
  nonZeroCount: number,
  isIncome: boolean,
): string {
  if (nonZeroCount < MIN_NON_ZERO_FOR_DEVIATION || value === 0 || avg === 0) {
    return '';
  }
  const deviation = (value - avg) / avg;
  // For expenses, above average is bad (red); for income, above is good (green).
  const above = isIncome ? 'low' : 'high';
  const below = isIncome ? 'high' : 'low';

  if (deviation > DEVIATION_LEVEL_3) return DEVIATION_CLASS[`${above}-3`];
  if (deviation > DEVIATION_LEVEL_2) return DEVIATION_CLASS[`${above}-2`];
  if (deviation > DEVIATION_LEVEL_1) return DEVIATION_CLASS[`${above}-1`];
  if (deviation < -DEVIATION_LEVEL_3) return DEVIATION_CLASS[`${below}-3`];
  if (deviation < -DEVIATION_LEVEL_2) return DEVIATION_CLASS[`${below}-2`];
  if (deviation < -DEVIATION_LEVEL_1) return DEVIATION_CLASS[`${below}-1`];
  return '';
}

export function MonthlyCategoryBreakdownReport() {
  const router = useRouter();
  const t = useTranslations('reports');
  const { formatCurrency } = useNumberFormat();
  const { formatMonth } = useDateFormat();
  const otherExpensesLabel = t('monthlyCategoryBreakdown.otherExpenses');
  const otherIncomeLabel = t('monthlyCategoryBreakdown.otherIncome');
  const investmentIncomeLabel = t('monthlyCategoryBreakdown.investmentIncome');
  const [showPercentages, setShowPercentages] = useLocalStorage<boolean>(
    PERCENTAGES_STORAGE_KEY,
    false,
  );
  // Deviation highlighting (coloured cells flagging above/below-average months)
  // is on by default; the toggle lets users mute it for a plain table.
  const [showDeviations, setShowDeviations] = useLocalStorage<boolean>(
    DEVIATIONS_STORAGE_KEY,
    true,
  );
  const [sortColumn, setSortColumn] = useLocalStorage<string>(
    SORT_COLUMN_STORAGE_KEY,
    CATEGORY_COLUMN,
  );
  const [sortDir, setSortDir] = useLocalStorage<SortDir>(
    SORT_DIR_STORAGE_KEY,
    'asc',
  );
  const [includeCurrentMonth, setIncludeCurrentMonth] =
    useLocalStorage<boolean>(INCLUDE_CURRENT_MONTH_STORAGE_KEY, false);

  // The current calendar month (YYYY-MM); the latest column is in progress and
  // excluded by default unless the user opts to include it.
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(
    now.getMonth() + 1,
  ).padStart(2, '0')}`;

  // Toggle the sort column/direction. Selecting a new column defaults to
  // ascending for the category name and descending for value columns.
  const handleSort = (column: string) => {
    if (sortColumn === column) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortColumn(column);
      setSortDir(column === CATEGORY_COLUMN ? 'asc' : 'desc');
    }
  };
  const {
    dateRange,
    setDateRange,
    startDate,
    setStartDate,
    endDate,
    setEndDate,
    resolvedRange,
    isValid,
  } = useDateRange({ defaultRange: '6m', storageKey: RANGE_STORAGE_KEY });

  const { start: rangeStart, end: rangeEnd } = resolvedRange;

  const { data, isLoading, error, reload } = useReportData(
    () =>
      isValid
        ? builtInReportsApi.getMonthlyCategoryBreakdown({
            startDate: rangeStart || undefined,
            endDate: rangeEnd,
          })
        : Promise.resolve(null),
    [isValid, rangeStart, rangeEnd],
  );

  const currency = data?.currency;

  const model = useMemo(() => {
    if (!data) return null;
    // Drop the in-progress (current) month unless the user opts in. The current
    // month is removed wherever it appears so the toggle always takes effect.
    const months = includeCurrentMonth
      ? data.months
      : data.months.filter((m) => m !== currentMonth);
    const monthCount = months.length || 1;
    // Localize the synthetic investment-income bucket's label; the backend ships
    // a stable English fallback that we replace with the translated string.
    const rows = data.data.map((row) =>
      row.categoryId === INVESTMENT_INCOME_CATEGORY_ID
        ? { ...row, categoryName: investmentIncomeLabel }
        : row,
    );

    // Group categories by parent. A category with a parent forms (or joins) a
    // section keyed by that parent; parentless categories collect into the
    // "Other income" / "Other expenses" buckets according to their own type.
    // The whole section is classified income or expense from the parent's flag
    // (falling back to the row's own flag when the parent is unknown).
    interface RawGroup {
      key: string;
      title: string;
      isIncome: boolean;
      list: MonthlyBreakdownCategoryRow[];
    }
    const groups = new Map<string, RawGroup>();
    const addRow = (
      key: string,
      title: string,
      isIncome: boolean,
      row: MonthlyBreakdownCategoryRow,
    ) => {
      const existing = groups.get(key);
      groups.set(
        key,
        existing
          ? { ...existing, list: [...existing.list, row] }
          : { key, title, isIncome, list: [row] },
      );
    };
    for (const row of rows) {
      if (row.parentId && row.parentName) {
        addRow(
          row.parentId,
          row.parentName,
          row.parentIsIncome ?? row.isIncome,
          row,
        );
      } else if (row.isIncome) {
        addRow(OTHER_INCOME_KEY, otherIncomeLabel, true, row);
      } else {
        addRow(OTHER_EXPENSE_KEY, otherExpensesLabel, false, row);
      }
    }

    // Build a Section from a raw group; palette is assigned later in display
    // order. Rows are sorted inside processGroup by the active column.
    const buildSection = (g: RawGroup): Section => {
      const group = processGroup(
        g.list,
        months,
        monthCount,
        g.isIncome,
        sortColumn,
        sortDir,
      );
      return {
        title: g.title,
        paletteClass: '',
        isIncome: g.isIncome,
        isOther: isOtherKey(g.key),
        ...group,
      };
    };

    // Sort sections within a group by the active column, "Other" pinned last.
    const sortSections = (secs: Section[]): Section[] =>
      [...secs].sort((a, b) => {
        if (a.isOther !== b.isOther) return a.isOther ? 1 : -1;
        const primary = compareKeys(
          sectionSortKey(a, sortColumn),
          sectionSortKey(b, sortColumn),
          sortDir,
        );
        return primary !== 0 ? primary : a.title.localeCompare(b.title);
      });

    const rawGroups = Array.from(groups.values());
    const incomeSectionsRaw = sortSections(
      rawGroups.filter((g) => g.isIncome).map(buildSection),
    );
    const expenseSectionsRaw = sortSections(
      rawGroups.filter((g) => !g.isIncome).map(buildSection),
    );

    // Assign the rotating palette across the combined display order (income
    // first, then expenses); "Other" buckets keep the neutral palette.
    let paletteCount = 0;
    const assignPalette = (s: Section): Section => {
      const paletteClass = s.isOther
        ? OTHER_PALETTE
        : SECTION_PALETTE[paletteCount % SECTION_PALETTE.length];
      if (!s.isOther) paletteCount += 1;
      return { ...s, paletteClass };
    };
    const incomeSections = incomeSectionsRaw.map(assignPalette);
    const expenseSections = expenseSectionsRaw.map(assignPalette);
    const sections = [...incomeSections, ...expenseSections];

    // Transfers form their own group (signed: "from" positive, "to" negative).
    const transfers = processTransfers(
      data.transfers || [],
      months,
      monthCount,
      (name) => `${t('monthlyCategoryBreakdown.transferFrom')} ${name}`,
      (name) => `${t('monthlyCategoryBreakdown.transferTo')} ${name}`,
      sortColumn,
      sortDir,
    );
    const hasTransfers = transfers.rows.length > 0;

    // Group totals are the sum of section subtotals (already positive
    // magnitudes in each section's own convention).
    const monthlyExpenses: Record<string, number> = {};
    const monthlyIncome: Record<string, number> = {};
    for (const m of months) {
      monthlyIncome[m] = sumMoney(incomeSections.map((s) => s.subtotals[m] || 0));
      monthlyExpenses[m] = sumMoney(
        expenseSections.map((s) => s.subtotals[m] || 0),
      );
    }
    const totalIncomeSum = sumMoney(incomeSections.map((s) => s.subtotalSum));
    const totalExpensesSum = sumMoney(expenseSections.map((s) => s.subtotalSum));
    const totalExpensesAvg = roundMoney(totalExpensesSum / monthCount);
    const totalIncomeAvg = roundMoney(totalIncomeSum / monthCount);

    // Balance is income minus expenses; the overall total folds transfers in
    // too (matching a Microsoft Money banking summary's bottom line).
    const monthlyBalance: Record<string, number> = {};
    const monthlyOverall: Record<string, number> = {};
    for (const m of months) {
      const bal = roundMoney((monthlyIncome[m] || 0) - (monthlyExpenses[m] || 0));
      monthlyBalance[m] = bal;
      monthlyOverall[m] = roundMoney(bal + (transfers.monthly[m] || 0));
    }
    const balanceSum = roundMoney(totalIncomeSum - totalExpensesSum);
    const balanceAvg = roundMoney(balanceSum / monthCount);
    const overallSum = roundMoney(balanceSum + transfers.totalSum);
    const overallAvg = roundMoney(overallSum / monthCount);

    // Category id collections for the summary drill-throughs.
    const incomeCategoryIds = incomeSections.flatMap((s) => s.allCategoryIds);
    const expenseCategoryIds = expenseSections.flatMap((s) => s.allCategoryIds);
    const allCategoryIds = [...incomeCategoryIds, ...expenseCategoryIds];
    const allTransferAccountIds = transfers.rows.map((r) => r.accountId);

    return {
      months,
      sections,
      incomeSections,
      expenseSections,
      transfers,
      hasTransfers,
      monthlyExpenses,
      monthlyIncome,
      totalExpensesSum,
      totalIncomeSum,
      totalExpensesAvg,
      totalIncomeAvg,
      monthlyBalance,
      balanceSum,
      balanceAvg,
      monthlyOverall,
      overallSum,
      overallAvg,
      incomeCategoryIds,
      expenseCategoryIds,
      allCategoryIds,
      allTransferAccountIds,
    };
  }, [
    data,
    otherExpensesLabel,
    otherIncomeLabel,
    investmentIncomeLabel,
    sortColumn,
    sortDir,
    includeCurrentMonth,
    currentMonth,
    t,
  ]);

  const lastDayOfMonth = (month: string): string => {
    const [year, mon] = month.split('-').map(Number);
    const lastDay = new Date(year, mon, 0).getDate();
    return `${year}-${String(mon).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  };

  // Navigate to the transactions page with the given filters. Empty filter
  // sets are omitted; transfers are selected via the special "transfer"
  // category id, optionally narrowed to specific accounts.
  const pushTransactions = (opts: {
    categoryIds?: string[];
    accountIds?: string[];
    start?: string;
    end?: string;
  }) => {
    const params = new URLSearchParams();
    const cats = opts.categoryIds ? Array.from(new Set(opts.categoryIds)) : [];
    const accs = opts.accountIds ? Array.from(new Set(opts.accountIds)) : [];
    if (cats.length) params.set('categoryIds', cats.join(','));
    if (accs.length) params.set('accountIds', accs.join(','));
    if (opts.start) params.set('startDate', opts.start);
    if (opts.end) params.set('endDate', opts.end);
    if (Array.from(params.keys()).length === 0) return;
    router.push(`/transactions?${params.toString()}`);
  };

  const navigateToTransactions = (
    categoryIds: string[],
    start: string | undefined,
    end: string | undefined,
  ) => {
    if (Array.from(new Set(categoryIds)).length === 0) return;
    pushTransactions({ categoryIds, start, end });
  };

  // Drill into a single month for the given categories.
  const drillDown = (month: string, categoryIds: string[]) => {
    navigateToTransactions(categoryIds, `${month}-01`, lastDayOfMonth(month));
  };

  // Drill into the full report date range for the given categories (used when
  // clicking a category/subcategory name rather than a single month cell).
  const drillDownRange = (categoryIds: string[]) => {
    navigateToTransactions(categoryIds, rangeStart || undefined, rangeEnd || undefined);
  };

  // Drill-down ids for a category row: its real category id, or the
  // "uncategorized" pseudo-filter (categoryId IS NULL) the transactions list
  // already understands -- mirroring the transfer-section drilldown. No extra
  // backend/DB work: the report already aggregates the uncategorized bucket.
  const rowDrillIds = (row: ProcessedRow): string[] =>
    row.categoryId ? [row.categoryId] : ['uncategorized'];

  // Drill into transfers (optionally for specific accounts) over the full
  // report range or a single month.
  const drillTransfersRange = (accountIds: string[]) => {
    pushTransactions({
      categoryIds: ['transfer'],
      accountIds,
      start: rangeStart || undefined,
      end: rangeEnd || undefined,
    });
  };
  const drillTransfersMonth = (month: string, accountIds: string[]) => {
    pushTransactions({
      categoryIds: ['transfer'],
      accountIds,
      start: `${month}-01`,
      end: lastDayOfMonth(month),
    });
  };

  // Export the breakdown as a CSV matrix: one row per category (with its parent
  // group), then the income/expense/balance summary rows. Amounts carry the same
  // sign convention as the table (expenses negative, income positive).
  const handleExportCsv = () => {
    if (!model) return;
    const signed = (isIncome: boolean, value: number) =>
      roundMoney(isIncome ? value : -value);
    const headers = [
      t('monthlyCategoryBreakdown.csvParentColumn'),
      t('monthlyCategoryBreakdown.category'),
      ...model.months.map((m) => formatMonth(m)),
      t('monthlyCategoryBreakdown.total'),
      t('monthlyCategoryBreakdown.avgPerMonth'),
    ];
    const rows: (string | number)[][] = [];
    for (const section of model.sections) {
      for (const row of section.rows) {
        rows.push([
          section.title,
          row.displayName,
          ...model.months.map((m) => signed(row.isIncome, row.values[m] || 0)),
          signed(row.isIncome, row.total),
          signed(row.isIncome, row.avg),
        ]);
      }
    }
    rows.push([
      '',
      t('monthlyCategoryBreakdown.totalExpenses'),
      ...model.months.map((m) => roundMoney(-(model.monthlyExpenses[m] || 0))),
      roundMoney(-model.totalExpensesSum),
      roundMoney(-model.totalExpensesAvg),
    ]);
    rows.push([
      '',
      t('monthlyCategoryBreakdown.totalIncome'),
      ...model.months.map((m) => roundMoney(model.monthlyIncome[m] || 0)),
      roundMoney(model.totalIncomeSum),
      roundMoney(model.totalIncomeAvg),
    ]);
    // Transfer rows carry their own sign already ("from" positive, "to"
    // negative), so they are exported as-is.
    for (const transfer of model.transfers.rows) {
      rows.push([
        t('monthlyCategoryBreakdown.transfers'),
        transfer.displayName,
        ...model.months.map((m) => transfer.values[m] || 0),
        transfer.total,
        transfer.avg,
      ]);
    }
    rows.push([
      '',
      t('monthlyCategoryBreakdown.balance'),
      ...model.months.map((m) => model.monthlyBalance[m] || 0),
      model.balanceSum,
      model.balanceAvg,
    ]);
    if (model.hasTransfers) {
      rows.push([
        '',
        t('monthlyCategoryBreakdown.totalTransfers'),
        ...model.months.map((m) => model.transfers.monthly[m] || 0),
        model.transfers.totalSum,
        model.transfers.totalAvg,
      ]);
      rows.push([
        '',
        t('monthlyCategoryBreakdown.overallTotal'),
        ...model.months.map((m) => model.monthlyOverall[m] || 0),
        model.overallSum,
        model.overallAvg,
      ]);
    }
    exportToCsv('monthly-category-breakdown', headers, rows);
  };

  // Render a single signed amount cell value (or a percentage in percent mode).
  const formatCell = (
    value: number,
    monthTotal: number,
    isIncome: boolean | null,
  ): string => {
    if (value === 0) return '—';
    const normalized = isIncome === null ? value : isIncome ? value : -value;
    const sign = normalized > 0 ? '+' : '-';
    if (showPercentages && monthTotal > 0) {
      const pct = (Math.abs(normalized) / monthTotal) * 100;
      return `${sign}${pct.toFixed(1)}%`;
    }
    return `${sign} ${formatCurrency(Math.abs(normalized), currency)}`;
  };

  if (error) {
    return <ReportError onRetry={reload} />;
  }

  if (isLoading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        <div className="space-y-4">
          <Skeleton className="h-8 w-1/3" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }

  const months = model?.months ?? [];
  const hasData =
    model != null &&
    months.length > 0 &&
    (model.sections.length > 0 || model.hasTransfers);
  const colSpan = months.length + 3;

  // Render one parent section: its colored header, the alphabetically sorted
  // subcategory rows, and the section subtotal.
  const renderSection = (section: Section, si: number) => {
    const sectionMonthTotal = (m: string) =>
      section.isIncome ? model!.monthlyIncome[m] : model!.monthlyExpenses[m];
    const sectionSum = section.isIncome
      ? model!.totalIncomeSum
      : model!.totalExpensesSum;
    const sectionAvg = section.isIncome
      ? model!.totalIncomeAvg
      : model!.totalExpensesAvg;
    return (
      <Fragment key={`section-${si}`}>
        {/* Section header. The colored bar spans the full table width while
            the label is pinned to the left so it stays visible when the table
            is scrolled horizontally. */}
        <tr>
          <td colSpan={colSpan} className={`p-0 font-semibold ${section.paletteClass}`}>
            <div className="sticky left-0 z-10 px-2 py-1.5 inline-block max-w-full">
              {section.allCategoryIds.length > 0 ? (
                <button
                  type="button"
                  onClick={() => drillDownRange(section.allCategoryIds)}
                  className="text-left hover:underline"
                >
                  {section.title}
                </button>
              ) : (
                section.title
              )}
            </div>
          </td>
        </tr>
        {/* Subcategory rows (sorted alphabetically) */}
        {section.rows.map((row) => (
          <tr key={row.categoryId || row.displayName} className="group hover:bg-gray-50 dark:hover:bg-gray-700">
            <td
              className="sticky left-0 z-10 bg-white dark:bg-gray-800 group-hover:bg-gray-50 dark:group-hover:bg-gray-700 pl-5 pr-2 py-1 text-gray-900 dark:text-gray-100 truncate max-w-[220px]"
              title={row.displayName}
            >
              <button
                type="button"
                onClick={() => drillDownRange(rowDrillIds(row))}
                className="block w-full text-left truncate hover:underline"
              >
                {row.displayName}
              </button>
            </td>
            {months.map((m) => {
              const value = row.values[m] || 0;
              const cls = showDeviations
                ? deviationClass(value, row.nonZeroAvg, row.nonZeroCount, row.isIncome)
                : '';
              return (
                <td key={m} className={`px-2 py-1 text-right ${cls}`}>
                  {value !== 0 ? (
                    <button
                      type="button"
                      onClick={() => drillDown(m, rowDrillIds(row))}
                      className="hover:underline"
                    >
                      {formatCell(value, sectionMonthTotal(m), row.isIncome)}
                    </button>
                  ) : (
                    <span className="text-gray-300 dark:text-gray-600">—</span>
                  )}
                </td>
              );
            })}
            <td className="px-2 py-1 text-right font-semibold text-gray-900 dark:text-gray-100">
              <button
                type="button"
                onClick={() => drillDownRange(rowDrillIds(row))}
                className="hover:underline"
              >
                {formatCell(row.total, sectionSum, row.isIncome)}
              </button>
            </td>
            <td className="px-2 py-1 text-right text-gray-700 dark:text-gray-300">
              {formatCell(row.avg, sectionAvg, row.isIncome)}
            </td>
          </tr>
        ))}
        {/* Section subtotal */}
        <tr className="font-bold bg-gray-50 dark:bg-gray-900 border-t-2 border-gray-300 dark:border-gray-600">
          <td className="sticky left-0 z-10 bg-gray-50 dark:bg-gray-900 px-2 py-1 truncate" title={`${t('monthlyCategoryBreakdown.subtotal')}: ${section.title}`}>
            {t('monthlyCategoryBreakdown.subtotal')}: {section.title}
          </td>
          {months.map((m) => {
            const value = section.subtotals[m] || 0;
            return (
              <td key={m} className="px-2 py-1 text-right">
                {value !== 0 ? (
                  <button
                    type="button"
                    onClick={() => drillDown(m, section.allCategoryIds)}
                    className="hover:underline"
                  >
                    {formatCell(value, sectionMonthTotal(m), section.isIncome)}
                  </button>
                ) : (
                  <span className="text-gray-300 dark:text-gray-600">—</span>
                )}
              </td>
            );
          })}
          <td className="px-2 py-1 text-right">
            {section.allCategoryIds.length > 0 ? (
              <button
                type="button"
                onClick={() => drillDownRange(section.allCategoryIds)}
                className="hover:underline"
              >
                {formatCell(section.subtotalSum, sectionSum, section.isIncome)}
              </button>
            ) : (
              formatCell(section.subtotalSum, sectionSum, section.isIncome)
            )}
          </td>
          <td className="px-2 py-1 text-right">
            {formatCell(section.subtotalAvg, sectionAvg, section.isIncome)}
          </td>
        </tr>
      </Fragment>
    );
  };

  // The bold per-month total for a whole income or expense group, shown at the
  // bottom of that group.
  const renderGroupTotal = (isIncome: boolean) => {
    const label = isIncome
      ? t('monthlyCategoryBreakdown.totalIncome')
      : t('monthlyCategoryBreakdown.totalExpenses');
    const monthly = isIncome ? model!.monthlyIncome : model!.monthlyExpenses;
    const sum = isIncome ? model!.totalIncomeSum : model!.totalExpensesSum;
    const avg = isIncome ? model!.totalIncomeAvg : model!.totalExpensesAvg;
    const accent = isIncome
      ? 'text-green-700 dark:text-green-300'
      : 'text-red-700 dark:text-red-300';
    return (
      <tr className="font-bold bg-gray-100 dark:bg-gray-900 border-t-2 border-gray-400 dark:border-gray-500">
        <td className={`sticky left-0 z-10 bg-gray-100 dark:bg-gray-900 px-2 py-1 ${accent}`}>
          {label}
        </td>
        {months.map((m) => (
          <td key={m} className={`px-2 py-1 text-right ${accent}`}>
            {formatGrand(monthly[m] || 0, isIncome, formatCurrency, currency)}
          </td>
        ))}
        <td className={`px-2 py-1 text-right ${accent}`}>
          <button
            type="button"
            onClick={() =>
              drillDownRange(
                isIncome
                  ? model!.incomeCategoryIds
                  : model!.expenseCategoryIds,
              )
            }
            className="hover:underline"
          >
            {formatGrand(sum, isIncome, formatCurrency, currency)}
          </button>
        </td>
        <td className={`px-2 py-1 text-right ${accent}`}>
          {formatGrand(avg, isIncome, formatCurrency, currency)}
        </td>
      </tr>
    );
  };

  // Full-width group header bar ("Income" / "Expenses").
  const renderGroupHeader = (isIncome: boolean) => (
    <tr>
      <td
        colSpan={colSpan}
        className={`px-2 py-1.5 font-bold text-sm ${isIncome ? INCOME_GROUP_CLASS : EXPENSE_GROUP_CLASS}`}
      >
        <div className="sticky left-0 z-10 inline-block">
          {isIncome
            ? t('monthlyCategoryBreakdown.income')
            : t('monthlyCategoryBreakdown.expenses')}
        </div>
      </td>
    </tr>
  );

  // The transfers group: a header bar, one signed row per account/direction
  // ("from" positive, "to" negative), and the net total transfers row.
  const renderTransfers = () => {
    const tr = model!.transfers;
    const accent = 'text-blue-700 dark:text-blue-300';
    return (
      <Fragment>
        <tr>
          <td colSpan={colSpan} className={`px-2 py-1.5 font-bold text-sm ${TRANSFER_GROUP_CLASS}`}>
            <div className="sticky left-0 z-10 inline-block">
              {t('monthlyCategoryBreakdown.transfers')}
            </div>
          </td>
        </tr>
        {tr.rows.map((row) => (
          <tr key={`${row.direction}-${row.accountId}`} className="group hover:bg-gray-50 dark:hover:bg-gray-700">
            <td className="sticky left-0 z-10 bg-white dark:bg-gray-800 group-hover:bg-gray-50 dark:group-hover:bg-gray-700 pl-5 pr-2 py-1 text-gray-900 dark:text-gray-100 truncate max-w-[220px]" title={row.displayName}>
              <button
                type="button"
                onClick={() => drillTransfersRange([row.accountId])}
                className="block w-full text-left truncate hover:underline"
              >
                {row.displayName}
              </button>
            </td>
            {months.map((m) => {
              const value = row.values[m] || 0;
              return (
                <td key={m} className="px-2 py-1 text-right">
                  {value !== 0 ? (
                    <button
                      type="button"
                      onClick={() => drillTransfersMonth(m, [row.accountId])}
                      className="hover:underline"
                    >
                      {formatGrand(value, null, formatCurrency, currency)}
                    </button>
                  ) : (
                    <span className="text-gray-300 dark:text-gray-600">—</span>
                  )}
                </td>
              );
            })}
            <td className="px-2 py-1 text-right font-semibold text-gray-900 dark:text-gray-100">
              <button
                type="button"
                onClick={() => drillTransfersRange([row.accountId])}
                className="hover:underline"
              >
                {formatGrand(row.total, null, formatCurrency, currency)}
              </button>
            </td>
            <td className="px-2 py-1 text-right text-gray-700 dark:text-gray-300">
              {formatGrand(row.avg, null, formatCurrency, currency)}
            </td>
          </tr>
        ))}
        <tr className="font-bold bg-gray-100 dark:bg-gray-900 border-t-2 border-gray-400 dark:border-gray-500">
          <td className={`sticky left-0 z-10 bg-gray-100 dark:bg-gray-900 px-2 py-1 ${accent}`}>
            <button
              type="button"
              onClick={() => drillTransfersRange(model!.allTransferAccountIds)}
              className="text-left hover:underline"
            >
              {t('monthlyCategoryBreakdown.totalTransfers')}
            </button>
          </td>
          {months.map((m) => {
            const value = tr.monthly[m] || 0;
            return (
              <td key={m} className={`px-2 py-1 text-right ${accent}`}>
                {value !== 0 ? (
                  <button
                    type="button"
                    onClick={() => drillTransfersMonth(m, model!.allTransferAccountIds)}
                    className="hover:underline"
                  >
                    {formatGrand(value, null, formatCurrency, currency)}
                  </button>
                ) : (
                  formatGrand(value, null, formatCurrency, currency)
                )}
              </td>
            );
          })}
          <td className={`px-2 py-1 text-right ${accent}`}>
            <button
              type="button"
              onClick={() => drillTransfersRange(model!.allTransferAccountIds)}
              className="hover:underline"
            >
              {formatGrand(tr.totalSum, null, formatCurrency, currency)}
            </button>
          </td>
          <td className={`px-2 py-1 text-right ${accent}`}>
            {formatGrand(tr.totalAvg, null, formatCurrency, currency)}
          </td>
        </tr>
      </Fragment>
    );
  };

  // A bold summary row spanning all months plus the total/average columns.
  // When `drill` is supplied the label and non-zero month cells become
  // click-throughs to the transactions page.
  const renderSummaryRow = (
    label: string,
    monthly: Record<string, number>,
    sum: number,
    avg: number,
    signMode: boolean | null,
    accent: string,
    drill?: { range: () => void; month: (m: string) => void },
  ) => (
    <tr className="group font-bold bg-gray-100 dark:bg-gray-900 hover:bg-gray-200 dark:hover:bg-gray-800">
      <td className={`sticky left-0 z-10 bg-gray-100 dark:bg-gray-900 group-hover:bg-gray-200 dark:group-hover:bg-gray-800 px-2 py-1 ${accent}`}>
        {drill ? (
          <button type="button" onClick={drill.range} className="text-left hover:underline">
            {label}
          </button>
        ) : (
          label
        )}
      </td>
      {months.map((m) => {
        const value = monthly[m] || 0;
        return (
          <td key={m} className={`px-2 py-1 text-right ${accent}`}>
            {drill && value !== 0 ? (
              <button
                type="button"
                onClick={() => drill.month(m)}
                className="hover:underline"
              >
                {formatGrand(value, signMode, formatCurrency, currency)}
              </button>
            ) : (
              formatGrand(value, signMode, formatCurrency, currency)
            )}
          </td>
        );
      })}
      <td className={`px-2 py-1 text-right ${accent}`}>
        {drill ? (
          <button type="button" onClick={drill.range} className="hover:underline">
            {formatGrand(sum, signMode, formatCurrency, currency)}
          </button>
        ) : (
          formatGrand(sum, signMode, formatCurrency, currency)
        )}
      </td>
      <td className={`px-2 py-1 text-right ${accent}`}>
        {formatGrand(avg, signMode, formatCurrency, currency)}
      </td>
    </tr>
  );

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex flex-wrap gap-4 items-center justify-between">
          <DateRangeSelector
            ranges={['3m', '6m', '1y', 'ytd']}
            value={dateRange}
            onChange={setDateRange}
            showCustom
            customStartDate={startDate}
            onCustomStartDateChange={setStartDate}
            customEndDate={endDate}
            onCustomEndDateChange={setEndDate}
          />
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
              <ToggleSwitch
                checked={includeCurrentMonth}
                onChange={setIncludeCurrentMonth}
                label={t('monthlyCategoryBreakdown.includeCurrentMonth')}
                size="sm"
              />
              <span>{t('monthlyCategoryBreakdown.includeCurrentMonth')}</span>
            </div>
            <div className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
              <ToggleSwitch
                checked={showPercentages}
                onChange={setShowPercentages}
                label={t('monthlyCategoryBreakdown.showPercentages')}
                size="sm"
              />
              <span>{t('monthlyCategoryBreakdown.showPercentages')}</span>
            </div>
            <div className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
              <ToggleSwitch
                checked={showDeviations}
                onChange={setShowDeviations}
                label={t('monthlyCategoryBreakdown.showDeviations')}
                size="sm"
              />
              <span>{t('monthlyCategoryBreakdown.showDeviations')}</span>
            </div>
            <button
              type="button"
              onClick={handleExportCsv}
              disabled={!hasData}
              className="px-3 py-1.5 text-sm font-medium rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              {t('monthlyCategoryBreakdown.exportCsv')}
            </button>
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 px-2 py-4 sm:p-6">
        {!hasData ? (
          <p className="text-gray-500 dark:text-gray-400 text-center py-8">
            {t('monthlyCategoryBreakdown.noData')}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-xs border-collapse">
              <thead>
                <tr className="text-gray-500 dark:text-gray-400">
                  <SortableHeader
                    field={CATEGORY_COLUMN}
                    sortField={sortColumn}
                    sortDirection={sortDir}
                    onSort={handleSort}
                    align="left"
                    className="sticky left-0 z-10 bg-white dark:bg-gray-800 px-2 py-2 font-medium min-w-[180px]"
                  >
                    {t('monthlyCategoryBreakdown.category')}
                  </SortableHeader>
                  {months.map((m) => (
                    <SortableHeader
                      key={m}
                      field={m}
                      sortField={sortColumn}
                      sortDirection={sortDir}
                      onSort={handleSort}
                      align="right"
                      className="px-2 py-2 font-medium whitespace-nowrap"
                    >
                      {formatMonth(m)}
                    </SortableHeader>
                  ))}
                  <SortableHeader
                    field={TOTAL_COLUMN}
                    sortField={sortColumn}
                    sortDirection={sortDir}
                    onSort={handleSort}
                    align="right"
                    className="px-2 py-2 font-medium"
                  >
                    {t('monthlyCategoryBreakdown.total')}
                  </SortableHeader>
                  <SortableHeader
                    field={AVG_COLUMN}
                    sortField={sortColumn}
                    sortDirection={sortDir}
                    onSort={handleSort}
                    align="right"
                    className="px-2 py-2 font-medium"
                  >
                    {t('monthlyCategoryBreakdown.avgPerMonth')}
                  </SortableHeader>
                </tr>
              </thead>
              <tbody>
                {/* Income group: sections (alphabetical) then the income total */}
                {model!.incomeSections.length > 0 && (
                  <Fragment>
                    {renderGroupHeader(true)}
                    {model!.incomeSections.map((section, si) =>
                      renderSection(section, si),
                    )}
                    {renderGroupTotal(true)}
                  </Fragment>
                )}

                {/* Expense group: sections (alphabetical) then the expense total */}
                {model!.expenseSections.length > 0 && (
                  <Fragment>
                    {renderGroupHeader(false)}
                    {model!.expenseSections.map((section, si) =>
                      renderSection(section, model!.incomeSections.length + si),
                    )}
                    {renderGroupTotal(false)}
                  </Fragment>
                )}

                {/* Transfers group: FROM (positive) / TO (negative) per account */}
                {model!.hasTransfers && renderTransfers()}

                {/* Summary: totals, balance, optional transfers/overall, and a
                    recap of every category section. */}
                <tr>
                  <td colSpan={colSpan} className="px-3 py-2 font-bold text-sm uppercase tracking-wide border-t-4 border-gray-500 dark:border-gray-400 bg-gray-800 text-white dark:bg-gray-200 dark:text-gray-900">
                    <div className="sticky left-0 z-10 inline-block">
                      {t('monthlyCategoryBreakdown.summary')}
                    </div>
                  </td>
                </tr>
                {renderSummaryRow(
                  t('monthlyCategoryBreakdown.totalIncome'),
                  model!.monthlyIncome,
                  model!.totalIncomeSum,
                  model!.totalIncomeAvg,
                  true,
                  'text-green-600 dark:text-green-400',
                  {
                    range: () => drillDownRange(model!.incomeCategoryIds),
                    month: (m) => drillDown(m, model!.incomeCategoryIds),
                  },
                )}
                {renderSummaryRow(
                  t('monthlyCategoryBreakdown.totalExpenses'),
                  model!.monthlyExpenses,
                  model!.totalExpensesSum,
                  model!.totalExpensesAvg,
                  false,
                  '',
                  {
                    range: () => drillDownRange(model!.expenseCategoryIds),
                    month: (m) => drillDown(m, model!.expenseCategoryIds),
                  },
                )}
                <tr className="group font-bold bg-gray-100 dark:bg-gray-900 hover:bg-gray-200 dark:hover:bg-gray-800 border-t-2 border-gray-400 dark:border-gray-500">
                  <td className="sticky left-0 z-10 bg-gray-100 dark:bg-gray-900 group-hover:bg-gray-200 dark:group-hover:bg-gray-800 px-2 py-1">
                    <button
                      type="button"
                      onClick={() => drillDownRange(model!.allCategoryIds)}
                      className="text-left hover:underline"
                    >
                      {t('monthlyCategoryBreakdown.balance')}
                    </button>
                  </td>
                  {months.map((m) => {
                    const bal = model!.monthlyBalance[m] || 0;
                    return (
                      <td key={m} className={`px-2 py-1 text-right ${bal >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                        {bal !== 0 ? (
                          <button
                            type="button"
                            onClick={() => drillDown(m, model!.allCategoryIds)}
                            className="hover:underline"
                          >
                            {formatGrand(bal, null, formatCurrency, currency)}
                          </button>
                        ) : (
                          formatGrand(bal, null, formatCurrency, currency)
                        )}
                      </td>
                    );
                  })}
                  <td className={`px-2 py-1 text-right ${model!.balanceSum >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                    <button
                      type="button"
                      onClick={() => drillDownRange(model!.allCategoryIds)}
                      className="hover:underline"
                    >
                      {formatGrand(model!.balanceSum, null, formatCurrency, currency)}
                    </button>
                  </td>
                  <td className={`px-2 py-1 text-right ${model!.balanceAvg >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                    {formatGrand(model!.balanceAvg, null, formatCurrency, currency)}
                  </td>
                </tr>
                {model!.hasTransfers &&
                  renderSummaryRow(
                    t('monthlyCategoryBreakdown.totalTransfers'),
                    model!.transfers.monthly,
                    model!.transfers.totalSum,
                    model!.transfers.totalAvg,
                    null,
                    'text-blue-700 dark:text-blue-300',
                    {
                      range: () => drillTransfersRange(model!.allTransferAccountIds),
                      month: (m) => drillTransfersMonth(m, model!.allTransferAccountIds),
                    },
                  )}
                {model!.hasTransfers && (
                  <tr className="group font-bold bg-gray-200 dark:bg-gray-800 hover:bg-gray-300 dark:hover:bg-gray-700 border-t-2 border-gray-400 dark:border-gray-500">
                    <td className="sticky left-0 z-10 bg-gray-200 dark:bg-gray-800 group-hover:bg-gray-300 dark:group-hover:bg-gray-700 px-2 py-1">
                      {t('monthlyCategoryBreakdown.overallTotal')}
                    </td>
                    {months.map((m) => {
                      const ov = model!.monthlyOverall[m] || 0;
                      return (
                        <td key={m} className={`px-2 py-1 text-right ${ov >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                          {formatGrand(ov, null, formatCurrency, currency)}
                        </td>
                      );
                    })}
                    <td className={`px-2 py-1 text-right ${model!.overallSum >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                      {formatGrand(model!.overallSum, null, formatCurrency, currency)}
                    </td>
                    <td className={`px-2 py-1 text-right ${model!.overallAvg >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                      {formatGrand(model!.overallAvg, null, formatCurrency, currency)}
                    </td>
                  </tr>
                )}

                {/* Spacer */}
                <tr>
                  <td colSpan={colSpan} className="h-2" />
                </tr>

                {/* Recap of every category section's subtotal */}
                {model!.sections.map((section, si) => {
                  const sectionMonthTotal = (m: string) =>
                    section.isIncome
                      ? model!.monthlyIncome[m]
                      : model!.monthlyExpenses[m];
                  const sectionSum = section.isIncome
                    ? model!.totalIncomeSum
                    : model!.totalExpensesSum;
                  const sectionAvg = section.isIncome
                    ? model!.totalIncomeAvg
                    : model!.totalExpensesAvg;
                  return (
                    <tr key={`recap-${si}`} className="group font-bold bg-gray-50 dark:bg-gray-900 hover:bg-gray-100 dark:hover:bg-gray-800">
                      <td className="sticky left-0 z-10 bg-gray-50 dark:bg-gray-900 group-hover:bg-gray-100 dark:group-hover:bg-gray-800 px-2 py-1 truncate" title={section.title}>
                        {section.allCategoryIds.length > 0 ? (
                          <button
                            type="button"
                            onClick={() => drillDownRange(section.allCategoryIds)}
                            className="block w-full text-left truncate hover:underline"
                          >
                            {section.title}
                          </button>
                        ) : (
                          section.title
                        )}
                      </td>
                      {months.map((m) => {
                        const value = section.subtotals[m] || 0;
                        return (
                          <td key={m} className="px-2 py-1 text-right">
                            {value !== 0 && section.allCategoryIds.length > 0 ? (
                              <button
                                type="button"
                                onClick={() => drillDown(m, section.allCategoryIds)}
                                className="hover:underline"
                              >
                                {formatCell(value, sectionMonthTotal(m), section.isIncome)}
                              </button>
                            ) : value !== 0 ? (
                              formatCell(value, sectionMonthTotal(m), section.isIncome)
                            ) : (
                              <span className="text-gray-300 dark:text-gray-600">—</span>
                            )}
                          </td>
                        );
                      })}
                      <td className="px-2 py-1 text-right">
                        {section.allCategoryIds.length > 0 ? (
                          <button
                            type="button"
                            onClick={() => drillDownRange(section.allCategoryIds)}
                            className="hover:underline"
                          >
                            {formatCell(section.subtotalSum, sectionSum, section.isIncome)}
                          </button>
                        ) : (
                          formatCell(section.subtotalSum, sectionSum, section.isIncome)
                        )}
                      </td>
                      <td className="px-2 py-1 text-right">
                        {formatCell(section.subtotalAvg, sectionAvg, section.isIncome)}
                      </td>
                    </tr>
                  );
                })}
                {model!.hasTransfers &&
                  renderSummaryRow(
                    t('monthlyCategoryBreakdown.transfers'),
                    model!.transfers.monthly,
                    model!.transfers.totalSum,
                    model!.transfers.totalAvg,
                    null,
                    'text-blue-700 dark:text-blue-300',
                    {
                      range: () => drillTransfersRange(model!.allTransferAccountIds),
                      month: (m) => drillTransfersMonth(m, model!.allTransferAccountIds),
                    },
                  )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Grand-summary cell formatter. `isIncome` of null renders the raw signed
 * value (used by the balance row); true/false force the sign for income or
 * expense rows respectively.
 */
function formatGrand(
  value: number,
  isIncome: boolean | null,
  formatCurrency: (amount: number, currencyCode?: string) => string,
  currency: string | undefined,
): string {
  if (value === 0) return '—';
  const normalized = isIncome === null ? value : isIncome ? value : -value;
  const sign = normalized > 0 ? '+' : '-';
  return `${sign} ${formatCurrency(Math.abs(normalized), currency)}`;
}
