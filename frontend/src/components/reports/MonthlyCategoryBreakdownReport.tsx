'use client';

import {
  Fragment,
  useMemo,
  useRef,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ChevronDownIcon } from '@heroicons/react/24/outline';
import { Skeleton } from '@/components/ui/LoadingSkeleton';
import { builtInReportsApi } from '@/lib/built-in-reports';
import {
  MonthlyBreakdownCategoryRow,
  MonthlyBreakdownSection,
  MonthlyBreakdownTransferRow,
  MonthlyCategoryBreakdownResponse,
} from '@/types/built-in-reports';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useDateRange } from '@/hooks/useDateRange';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { useReportData } from '@/hooks/useReportData';
import { useIsMobile } from '@/hooks/useIsMobile';
import { DateRangeSelector } from '@/components/ui/DateRangeSelector';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { SortableHeader } from '@/components/ui/SortableHeader';
import { ReportError } from '@/components/reports/ReportError';
import { PartialDataNotice } from '@/components/reports/PartialDataNotice';
import { ProvisionalDataNotice } from '@/components/reports/ProvisionalDataNotice';
import { exportToCsv } from '@/lib/csv-export';
import { gainLossColor } from '@/lib/format';
import { ReportToolbarActions } from '@/components/reports/ReportToolbarActions';
import { FundingReportControls } from '@/components/reports/FundingReportControls';
import { MonthlyTaggedBalanceSummary } from '@/components/reports/MonthlyTaggedBalanceSummary';
import { useFundingReportControls } from '@/hooks/useFundingReportControls';
import { EmptyState } from '@/components/ui/EmptyState';
import { SEGMENTED_GROUP_CLASS, segmentClass } from '@/components/ui/segmented-control';
import {
  BREAKDOWN_PERIODS,
  alignPeriodStart,
  asBreakdownPeriod,
  breakdownRequestEnd,
  periodBounds,
  yearlyWindowStart,
  type BreakdownPeriod,
} from '@/lib/breakdown-period';
import { CARD_CLASS } from '@/components/ui/Card';

// The storage keys keep the report's original id so a reader's choices survive
// the rename to Monthly & Yearly Breakdown.
const RANGE_STORAGE_KEY = 'monize-reports-monthly-category-breakdown-range';
const YEARLY_RANGE_STORAGE_KEY =
  'monize-reports-monthly-category-breakdown-yearly-range';
const PERIOD_STORAGE_KEY = 'monize-reports-monthly-category-breakdown-period';
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
const INCLUDE_CURRENT_YEAR_STORAGE_KEY =
  'monize-reports-monthly-category-breakdown-include-current-year';
const NAME_OFFSET_STORAGE_KEY =
  'monize-reports-monthly-category-breakdown-name-offset';
const SUMMARY_ONLY_STORAGE_KEY =
  'monize-reports-monthly-category-breakdown-summary-only';
const COLLAPSED_GROUPS_STORAGE_KEY =
  'monize-reports-monthly-category-breakdown-collapsed-groups';

/**
 * The window presets per column width. A yearly preset of N years is N whole
 * calendar years before the current one, which "Include current year" adds
 * (`yearlyWindowStart`).
 */
const MONTHLY_RANGES = ['3m', '6m', '1y', 'ytd'] as const;
const YEARLY_RANGES = ['2y', '5y', '10y', 'all'] as const;

/** The three top-level groups a reader can fold down to their total row. */
type GroupId = 'income' | 'expense' | 'transfer';

/**
 * Phone-only collapse of the category column.
 *
 * A month-columnar report cannot fit a phone, and the sticky category column is
 * the width the months are missing. Dragging the column sideways slides it out
 * of view to the left *and* moves its right edge by the same amount, so the
 * months take exactly the width the names give up -- the two halves of the
 * gesture are one number (`--mcb-name-off`).
 *
 * The wrap width (`--mcb-name-full`) never changes while dragging, so the names
 * reflow at no point under the finger and the rows keep their height; only the
 * visible width (`--mcb-name-w`) and the shift move. Every rule reverts at `sm`,
 * where the column stays the plain sticky column it has always been.
 *
 * The width has to come from a clipping block *inside* the cell rather than
 * from the cell: an auto-layout table ignores `width` and `max-width` on a
 * `<td>` and sizes the column from its content, so a fixed-width name would
 * simply hold the column open. A `w-[var(--mcb-name-w)] overflow-hidden` block
 * contributes its own width and nothing of what it clips, which is exactly the
 * number the drag controls.
 */
const MOBILE_NAME_WIDTH = 116;
/**
 * The column never collapses past this: a fully vanished column leaves nothing
 * to grab to pull the names back, and the header keeps its sort indicator.
 */
const MOBILE_NAME_STUB = 28;
const MAX_NAME_OFFSET = MOBILE_NAME_WIDTH - MOBILE_NAME_STUB;
/** Horizontal travel before a press becomes a drag, so a tap still drills down. */
const NAME_DRAG_THRESHOLD = 4;
const NAME_CELL_CLASS = 'p-0 overflow-hidden touch-pan-y sm:touch-auto';
const NAME_CLIP_CLASS =
  'w-[var(--mcb-name-w)] overflow-hidden sm:w-auto sm:overflow-visible';
/** The header shares the column but also carries the sort indicator. */
const NAME_HEAD_CLIP_CLASS =
  'w-[calc(var(--mcb-name-w)_-_1.25rem)] overflow-hidden sm:w-auto sm:overflow-visible';
const NAME_INNER_CLASS =
  'w-[var(--mcb-name-full)] ml-[calc(-1*var(--mcb-name-off))] break-words sm:w-auto sm:ml-0 sm:break-normal';

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
// The name cell's indent for a Transfers group row, by its depth in the
// category tree (an account row and a top-level category sit at the first).
const TRANSFER_DEPTH_CLASS = ['pl-5', 'pl-9', 'pl-12', 'pl-16'];
const TRANSFER_GROUP_CLASS =
  'bg-blue-100 text-blue-900 dark:bg-blue-900/40 dark:text-blue-100';

const OTHER_INCOME_KEY = '__other_income__';
const OTHER_EXPENSE_KEY = '__other_expense__';
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
  /**
   * A top-level category with no subcategories in the report: drawn as one
   * line beside the parent sections rather than as a header, a row and a
   * subtotal that would all repeat the same name and figures.
   */
  isStandalone: boolean;
}

interface TransferRow {
  /** Unique within the group. */
  key: string;
  /** The account a per-account row drills into; null on a category row. */
  accountId: string | null;
  /** The Transfer categories a category row drills into; null on an account row. */
  categoryIds: string[] | null;
  direction: 'from' | 'to';
  displayName: string;
  /** How far a category row sits under its parent's roll-up. */
  depth: number;
  isSubtotal: boolean;
  values: Record<string, number>;
  total: number;
  avg: number;
}

type TransferLabel = (name: string) => string;

/**
 * The Transfers group's category rows in tree order, per direction: each
 * parent's roll-up, then what sits under it, a parent's own legs first
 * (docs/specs/transfer-categories.md section 7). The server sends every row and
 * every figure; this only orders and labels them.
 */
function transferCategoryRows(
  transfers: MonthlyBreakdownTransferRow[],
  months: string[],
  outLabel: TransferLabel,
  inLabel: TransferLabel,
): TransferRow[] {
  const rows = transfers.filter((tr) => tr.kind === 'category' && tr.categoryId);
  const names = new Map<string, { name: string; parentId: string | null }>();
  for (const tr of rows) {
    names.set(tr.categoryId!, { name: tr.categoryName ?? '', parentId: tr.parentId ?? null });
    if (tr.parentId && !names.has(tr.parentId)) {
      names.set(tr.parentId, { name: tr.parentName ?? '', parentId: null });
    }
  }
  const pathOf = (id: string): string[] => {
    const path: string[] = [];
    const seen = new Set<string>();
    let cursor: string | null = id;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const node = names.get(cursor);
      path.unshift(node?.name ?? '');
      cursor = node?.parentId ?? null;
    }
    return path;
  };
  // The ids under a roll-up: the parent's own and every row beneath it.
  const under = (parentId: string): string[] =>
    rows
      .filter((tr) => tr.categoryId === parentId || pathIds(tr.categoryId!).includes(parentId))
      .map((tr) => tr.categoryId!);
  const pathIds = (id: string): string[] => {
    const ids: string[] = [];
    const seen = new Set<string>();
    let cursor = names.get(id)?.parentId ?? null;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      ids.push(cursor);
      cursor = names.get(cursor)?.parentId ?? null;
    }
    return ids;
  };
  const hasRollUp = new Set(rows.filter((tr) => tr.isSubtotal).map((tr) => `${tr.direction}|${tr.categoryId}`));
  const built = rows.map((tr) => {
    const path = pathOf(tr.categoryId!);
    // A parent's own legs sit one step under its roll-up.
    const ownUnderRollUp = !tr.isSubtotal && hasRollUp.has(`${tr.direction}|${tr.categoryId}`);
    const values: Record<string, number> = {};
    for (const m of months) values[m] = tr.valuesByMonth[m] || 0;
    const name = tr.categoryName ?? '';
    return {
      // Direction, then the tree path (a parent before what is under it), then
      // a roll-up before the parent's own legs.
      sortKey: { direction: tr.direction === 'from' ? 0 : 1, path, rank: tr.isSubtotal ? 0 : 1 },
      row: {
        key: `${tr.isSubtotal ? 'subtotal' : 'category'}-${tr.direction}-${tr.categoryId}`,
        accountId: null,
        categoryIds: tr.isSubtotal ? Array.from(new Set(under(tr.categoryId!))) : [tr.categoryId!],
        direction: tr.direction,
        displayName: tr.direction === 'from' ? outLabel(name) : inLabel(name),
        depth: path.length - 1 + (ownUnderRollUp ? 1 : 0),
        isSubtotal: tr.isSubtotal === true,
        values,
        total: tr.total,
        avg: tr.average,
      } satisfies TransferRow,
    };
  });
  type Key = { direction: number; path: string[]; rank: number };
  const compare = (a: Key, b: Key): number => {
    if (a.direction !== b.direction) return a.direction - b.direction;
    for (let i = 0; i < Math.min(a.path.length, b.path.length); i += 1) {
      const order = a.path[i].localeCompare(b.path[i]);
      if (order !== 0) return order;
    }
    return a.path.length - b.path.length || a.rank - b.rank;
  };
  return built.sort((a, b) => compare(a.sortKey, b.sortKey)).map(({ row }) => row);
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

/**
 * A section's rows in the section's sign convention, sorted, beside the
 * section's own figures. Every figure is the server's (issue #2413): a row's
 * cells and its total and average are its own, negated where the row runs
 * against its section (a refund-heavy expense subcategory whose net is income
 * still subtracts from the expense subtotal), and the subtotals are the
 * section's, never the rows added up here.
 */
function processGroup(
  rows: MonthlyBreakdownCategoryRow[],
  months: string[],
  section: MonthlyBreakdownSection,
  sortColumn: string,
  sortDir: SortDir,
): Omit<
  Section,
  'title' | 'paletteClass' | 'isIncome' | 'isOther' | 'isStandalone'
> {
  const processed: ProcessedRow[] = rows
    .map((row) => {
      const against = row.isIncome !== section.isIncome;
      const inSection = (own: number) => (against && own !== 0 ? -own : own);
      const values: Record<string, number> = {};
      for (const m of months) values[m] = inSection(row.valuesByMonth[m] || 0);
      const total = inSection(row.total);
      const nonZeroCount = months.filter((m) => values[m] !== 0).length;
      return {
        categoryId: row.categoryId,
        displayName: row.categoryName,
        isIncome: section.isIncome,
        values,
        total,
        avg: inSection(row.average),
        // Shading only: how far a month sits from the row's usual month.
        nonZeroAvg: nonZeroCount > 0 ? total / nonZeroCount : 0,
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

  const allCategoryIds = processed
    .map((r) => r.categoryId)
    .filter((id): id is string => id != null);

  return {
    rows: processed,
    subtotals: section.valuesByMonth,
    subtotalSum: section.total,
    subtotalAvg: section.average,
    allCategoryIds,
  };
}

function transferSortKey(row: TransferRow, column: string): number | string {
  if (column === CATEGORY_COLUMN) return row.displayName;
  if (column === TOTAL_COLUMN) return row.total;
  if (column === AVG_COLUMN) return row.avg;
  return row.values[column] || 0;
}

// The signed transfer rows, ordered by the active sort. Values keep their
// backend sign ("from" rows positive, "to" rows negative); each row's total and
// average are the server's.
function processTransfers(
  transfers: MonthlyBreakdownTransferRow[],
  months: string[],
  fromLabel: (name: string) => string,
  toLabel: (name: string) => string,
  sortColumn: string,
  sortDir: SortDir,
): TransferRow[] {
  return transfers
    .filter((tr) => tr.kind !== 'category')
    .map((tr): TransferRow => {
      const values: Record<string, number> = {};
      for (const m of months) values[m] = tr.valuesByMonth[m] || 0;
      const name = tr.accountName ?? '';
      return {
        key: `${tr.direction}-${tr.accountId}`,
        accountId: tr.accountId,
        categoryIds: null,
        direction: tr.direction,
        displayName: tr.direction === 'from' ? fromLabel(name) : toLabel(name),
        depth: 0,
        isSubtotal: false,
        values,
        total: tr.total,
        avg: tr.average,
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

/** The answer for a window holding only the column in progress, left out: no columns. */
function emptyBreakdown(period: BreakdownPeriod): MonthlyCategoryBreakdownResponse {
  const none = { valuesByMonth: {}, total: 0, average: 0 };
  return {
    period,
    months: [],
    data: [],
    transfers: [],
    sections: [],
    summary: { income: none, expenses: none, balance: none, transfers: none, overall: none },
    currency: '',
    missingCurrencies: [],
    excludedCount: 0,
  };
}

export function MonthlyCategoryBreakdownReport() {
  const router = useRouter();
  const t = useTranslations('reports');
  const { formatCurrency, formatPercent } = useNumberFormat();
  const { formatMonth } = useDateFormat();
  const otherExpensesLabel = t('monthlyCategoryBreakdown.otherExpenses');
  const otherIncomeLabel = t('monthlyCategoryBreakdown.otherIncome');
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
  // Summary only hides the income, expense and transfer detail and keeps the
  // Summary block and the tagged balance below it.
  const [summaryOnly, setSummaryOnly] = useLocalStorage<boolean>(
    SUMMARY_ONLY_STORAGE_KEY,
    false,
  );
  // One column per calendar month or per calendar year. A stored value that is
  // not a known period reads as monthly.
  const [storedPeriod, setStoredPeriod] = useLocalStorage<BreakdownPeriod>(
    PERIOD_STORAGE_KEY,
    'month',
  );
  const period = asBreakdownPeriod(storedPeriod);
  const isYearly = period === 'year';
  const [includeCurrentYear, setIncludeCurrentYear] = useLocalStorage<boolean>(
    INCLUDE_CURRENT_YEAR_STORAGE_KEY,
    false,
  );
  const includeCurrentPeriod = isYearly ? includeCurrentYear : includeCurrentMonth;
  const setIncludeCurrentPeriod = isYearly
    ? setIncludeCurrentYear
    : setIncludeCurrentMonth;
  // Groups folded down to their total row. A stored value that is not a list
  // (a corrupted entry) folds nothing rather than hiding a group.
  const [storedCollapsedGroups, setCollapsedGroups] = useLocalStorage<
    GroupId[]
  >(COLLAPSED_GROUPS_STORAGE_KEY, []);
  const collapsedGroups = Array.isArray(storedCollapsedGroups)
    ? storedCollapsedGroups
    : [];
  const isCollapsed = (group: GroupId) => collapsedGroups.includes(group);
  const toggleGroup = (group: GroupId) =>
    setCollapsedGroups((prev) => {
      const current = Array.isArray(prev) ? prev : [];
      return current.includes(group)
        ? current.filter((g) => g !== group)
        : [...current, group];
    });

  // How far the category column is dragged out of view. Only a phone collapses
  // it; every width above `sm` reverts the rules and ignores the number.
  const isMobile = useIsMobile();
  const [storedNameOffset, setStoredNameOffset] = useLocalStorage<number>(
    NAME_OFFSET_STORAGE_KEY,
    0,
  );
  const nameOffset = isMobile
    ? Math.min(MAX_NAME_OFFSET, Math.max(0, storedNameOffset))
    : 0;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    startX: number;
    startOffset: number;
    offset: number;
    moved: boolean;
  } | null>(null);
  // A press that turned into a drag must not also fire the name's drill-down.
  const suppressClickRef = useRef(false);

  // The drag writes the custom properties straight onto the scroll container.
  // Routing every pointermove through React state would re-render the whole
  // matrix (and write localStorage) per frame; the final value is committed
  // once on release, which re-renders to the same numbers.
  const paintNameOffset = (offset: number) => {
    const el = scrollRef.current;
    if (!el) return;
    el.style.setProperty('--mcb-name-off', `${offset}px`);
    el.style.setProperty('--mcb-name-w', `${MOBILE_NAME_WIDTH - offset}px`);
  };

  const handleNamePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    // A drag whose click never arrived (the pointer was released outside the
    // cell) must not leave the flag armed to swallow the next unrelated click.
    suppressClickRef.current = false;
    if (!isMobile) return;
    if (!(e.target as HTMLElement).closest('[data-name-cell]')) return;
    dragRef.current = {
      startX: e.clientX,
      startOffset: nameOffset,
      offset: nameOffset,
      moved: false,
    };
  };

  const handleNamePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    if (!drag.moved) {
      // Below the threshold the press is still a tap; capture only once the
      // gesture is unmistakably horizontal, so a vertical scroll still scrolls.
      if (Math.abs(dx) < NAME_DRAG_THRESHOLD) return;
      drag.moved = true;
      // Not every environment implements pointer capture; the drag still works
      // without it, it just ends when the pointer leaves the container.
      e.currentTarget.setPointerCapture?.(e.pointerId);
    }
    // Dragging left (dx < 0) slides the names away and narrows the column.
    drag.offset = Math.min(MAX_NAME_OFFSET, Math.max(0, drag.startOffset - dx));
    paintNameOffset(drag.offset);
  };

  const handleNamePointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture?.(e.pointerId);
    }
    if (!drag.moved) return;
    suppressClickRef.current = true;
    setStoredNameOffset(drag.offset);
  };

  const handleNameClickCapture = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (!suppressClickRef.current) return;
    suppressClickRef.current = false;
    e.preventDefault();
    e.stopPropagation();
  };

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
  // Switching the column width drops a sort on a column the other width does
  // not have (a month key in a yearly table), rather than leaving every row
  // tied at zero under a header that is not there.
  const handlePeriodChange = (next: BreakdownPeriod) => {
    if (next === period) return;
    setStoredPeriod(next);
    if (
      sortColumn !== CATEGORY_COLUMN &&
      sortColumn !== TOTAL_COLUMN &&
      sortColumn !== AVG_COLUMN
    ) {
      setSortColumn(CATEGORY_COLUMN);
      setSortDir('asc');
    }
  };

  // Each width keeps its own window, since their presets differ.
  const monthlyRange = useDateRange({
    defaultRange: '6m',
    storageKey: RANGE_STORAGE_KEY,
  });
  const yearlyRange = useDateRange({
    defaultRange: '5y',
    storageKey: YEARLY_RANGE_STORAGE_KEY,
  });
  const {
    dateRange,
    setDateRange,
    startDate,
    setStartDate,
    endDate,
    setEndDate,
    resolvedRange,
    isValid,
  } = isYearly ? yearlyRange : monthlyRange;

  const { start: rangeStart, end: rangeEnd } = resolvedRange;

  // Every column is a whole calendar month or year. A preset resolves to a day
  // inside its leading column (e.g. "3m" = last 90 days), which would render a
  // partial leading column -- labelled "2026-03" or "2024" but silently
  // omitting transactions dated before the cut-off, so the same column shows
  // different figures depending on the preset. Snap the start down to the
  // first day of its column so every visible column is fully covered and
  // consistent across presets. An empty start ("all") stays empty.
  const reportStart = isYearly
    ? yearlyWindowStart(dateRange, rangeStart, new Date())
    : alignPeriodStart(rangeStart, period);

  // The window asked for: the column in progress is left out by ending it the
  // day before, so every server total is over the columns shown. `null` when
  // only the column in progress is in the window: nothing to ask for.
  const requestEnd = breakdownRequestEnd(
    rangeEnd,
    reportStart,
    period,
    includeCurrentPeriod,
    new Date(),
  );

  // Account filter, tag controls and the funding fetch (spec section 11.5).
  const funds = useFundingReportControls({
    reportKey: 'monthly-category-breakdown',
    startDate: reportStart || undefined,
    endDate: requestEnd ?? rangeEnd,
    enabled: isValid && requestEnd !== null,
    bucket: period,
  });
  const accountIds = funds.scope.selectedAccountIds;
  const selectedAccountIds = accountIds;

  const { data, isLoading, error, reload } = useReportData(
    () =>
      !isValid
        ? Promise.resolve(null)
        : requestEnd === null
          ? Promise.resolve(emptyBreakdown(period))
          : builtInReportsApi.getMonthlyCategoryBreakdown({
              startDate: reportStart || undefined,
              endDate: requestEnd,
              period,
              ...(accountIds.length > 0 ? { accountIds } : {}),
            }),
    [isValid, reportStart, requestEnd, period, funds.scope.accountIdsKey],
  );

  const currency = data?.currency;

  // The server answers in the period asked for, so from here on a "month" is
  // a column key: YYYY-MM, or YYYY in a yearly table. An answer for the other
  // width (a toggle while the new request is in flight) is not drawn under
  // this one's headers.
  const columns = data && data.period === period ? data : null;

  const model = useMemo(() => {
    if (!columns) return null;
    // The columns the server answered for: the in-progress one is already
    // out of the window unless the reader included it.
    const months = columns.months;
    const rows = columns.data;
    const sectionFigures = new Map(columns.sections.map((section) => [section.key, section]));

    // Rows draw under the section the server filed them in (`sectionKey`):
    // a category with a parent under its parent, a top-level category under
    // its own key, so a parent's direct spending sits beside its
    // subcategories and a category with none stands as a line of its own, and
    // the uncategorized row in the "Other income" / "Other expenses" bucket by
    // its type. The section's income flag and figures are the server's too.
    interface RawGroup {
      key: string;
      title: string;
      section: MonthlyBreakdownSection;
      list: MonthlyBreakdownCategoryRow[];
    }
    const titleOf = (key: string, row: MonthlyBreakdownCategoryRow): string =>
      key === OTHER_INCOME_KEY
        ? otherIncomeLabel
        : key === OTHER_EXPENSE_KEY
          ? otherExpensesLabel
          : row.parentId === key && row.parentName
            ? row.parentName
            : row.categoryName;
    const groups = new Map<string, RawGroup>();
    for (const row of rows) {
      const section = sectionFigures.get(row.sectionKey);
      if (!section) continue;
      // The groups are this memo's own objects, so a row is pushed into its
      // list rather than copying the list per row.
      const existing = groups.get(row.sectionKey);
      if (existing) {
        existing.list.push(row);
        // A parent's own row names the section as well as a child does.
        if (row.categoryId === row.sectionKey) existing.title = row.categoryName;
      } else {
        groups.set(row.sectionKey, {
          key: row.sectionKey,
          title: titleOf(row.sectionKey, row),
          section,
          list: [row],
        });
      }
    }

    // Build a Section from a raw group; palette is assigned later in display
    // order. Rows are sorted inside processGroup by the active column.
    const buildSection = (g: RawGroup): Section => {
      const group = processGroup(g.list, months, g.section, sortColumn, sortDir);
      return {
        title: g.title,
        paletteClass: '',
        isIncome: g.section.isIncome,
        isOther: isOtherKey(g.key),
        // Its only row is the category the section is keyed by: no
        // subcategory of it has activity in the report.
        isStandalone: g.list.length === 1 && g.list[0].categoryId === g.key,
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
      rawGroups.filter((g) => g.section.isIncome).map(buildSection),
    );
    const expenseSectionsRaw = sortSections(
      // income-flag-ok: the report's own two sections, income and expense
      rawGroups.filter((g) => !g.section.isIncome).map(buildSection),
    );

    // Assign the rotating palette across the combined display order (income
    // first, then expenses); "Other" buckets keep the neutral palette and a
    // standalone line has no header to colour, so neither takes a slot.
    let paletteCount = 0;
    const assignPalette = (s: Section): Section => {
      if (s.isStandalone) return s;
      const paletteClass = s.isOther
        ? OTHER_PALETTE
        : SECTION_PALETTE[paletteCount % SECTION_PALETTE.length];
      if (!s.isOther) paletteCount += 1;
      return { ...s, paletteClass };
    };
    const incomeSections = incomeSectionsRaw.map(assignPalette);
    const expenseSections = expenseSectionsRaw.map(assignPalette);
    const sections = [...incomeSections, ...expenseSections];

    // Transfers form their own group (signed: "from" positive, "to" negative):
    // the Transfer categories with their tree first, then every other leg by
    // account (docs/specs/transfer-categories.md section 7).
    const categoryTransferRows = transferCategoryRows(
      columns.transfers || [],
      months,
      (name) => t('monthlyCategoryBreakdown.transferCategoryOut', { name }),
      (name) => t('monthlyCategoryBreakdown.transferCategoryIn', { name }),
    );
    const accountTransferRows = processTransfers(
      columns.transfers || [],
      months,
      (name) => `${t('monthlyCategoryBreakdown.transferFrom')} ${name}`,
      (name) => `${t('monthlyCategoryBreakdown.transferTo')} ${name}`,
      sortColumn,
      sortDir,
    );
    const transferRows = [...categoryTransferRows, ...accountTransferRows];
    const { summary } = columns;
    const transfers = {
      rows: transferRows,
      monthly: summary.transfers.valuesByMonth,
      totalSum: summary.transfers.total,
      totalAvg: summary.transfers.average,
    };
    const hasTransfers = transfers.rows.length > 0;

    // The group totals, the balance (income less expenses) and the overall
    // line (the balance with the transfers, a Microsoft Money banking
    // summary's bottom line) are the server's, each folded from the sections'
    // aggregates and read once: added up here from the rounded subtotals they
    // sat a unit off (issue #2413).
    const monthlyIncome = summary.income.valuesByMonth;
    const monthlyExpenses = summary.expenses.valuesByMonth;
    const totalIncomeSum = summary.income.total;
    const totalExpensesSum = summary.expenses.total;
    const totalIncomeAvg = summary.income.average;
    const totalExpensesAvg = summary.expenses.average;
    const monthlyBalance = summary.balance.valuesByMonth;
    const balanceSum = summary.balance.total;
    const balanceAvg = summary.balance.average;
    const monthlyOverall = summary.overall.valuesByMonth;
    const overallSum = summary.overall.total;
    const overallAvg = summary.overall.average;

    // Category id collections for the summary drill-throughs.
    const incomeCategoryIds = incomeSections.flatMap((s) => s.allCategoryIds);
    const expenseCategoryIds = expenseSections.flatMap((s) => s.allCategoryIds);
    const allCategoryIds = [...incomeCategoryIds, ...expenseCategoryIds];
    // The group total drills into every transfer on the accounts its rows
    // name; a category row names none, so with one the report's own scope is
    // the set (empty: every account).
    const allTransferAccountIds = categoryTransferRows.length > 0
      ? selectedAccountIds
      : accountTransferRows.flatMap((r) => (r.accountId ? [r.accountId] : []));

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
    columns,
    selectedAccountIds,
    otherExpensesLabel,
    otherIncomeLabel,
    sortColumn,
    sortDir,
    t,
  ]);

  // The days one column covers, ending no later than the report's window, so
  // the transactions a cell opens are the ones its figure counts: the current
  // year (or month) ends today, and a custom window may end mid-column.
  const columnRange = (key: string): { start: string; end: string } => {
    const bounds = periodBounds(key, period);
    return {
      start: bounds.start,
      end: rangeEnd && rangeEnd < bounds.end ? rangeEnd : bounds.end,
    };
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

  // Drill into a single column (month or year) for the given categories.
  const drillDown = (month: string, categoryIds: string[]) => {
    const { start, end } = columnRange(month);
    navigateToTransactions(categoryIds, start, end);
  };

  // Drill into the full report date range for the given categories (used when
  // clicking a category/subcategory name rather than a single month cell).
  const drillDownRange = (categoryIds: string[]) => {
    navigateToTransactions(categoryIds, reportStart || undefined, rangeEnd || undefined);
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
      start: reportStart || undefined,
      end: rangeEnd || undefined,
    });
  };
  const drillTransfersMonth = (month: string, accountIds: string[]) => {
    const { start, end } = columnRange(month);
    pushTransactions({ categoryIds: ['transfer'], accountIds, start, end });
  };
  // A Transfers group row: its account's transfers, or its Transfer
  // categories' within the report's accounts.
  const drillTransferRow = (row: TransferRow, month?: string) => {
    if (!row.categoryIds) {
      if (month) drillTransfersMonth(month, [row.accountId!]);
      else drillTransfersRange([row.accountId!]);
      return;
    }
    const range = month
      ? columnRange(month)
      : { start: reportStart || undefined, end: rangeEnd || undefined };
    pushTransactions({ categoryIds: row.categoryIds, accountIds: selectedAccountIds, ...range });
  };

  // A column header: the localized month, or the year as it is.
  const columnLabel = (key: string): string =>
    isYearly ? key : formatMonth(key);
  const avgLabel = isYearly
    ? t('monthlyCategoryBreakdown.avgPerYear')
    : t('monthlyCategoryBreakdown.avgPerMonth');

  // Export the breakdown as a CSV matrix: one row per category (with its parent
  // group), then the income/expense/balance summary rows. Amounts carry the same
  // sign convention as the table (expenses negative, income positive).
  const handleExportCsv = () => {
    if (!model) return;
    // The server's figures, signed as the table shows them; a negation is
    // exact, so nothing is rounded again here.
    const signed = (isIncome: boolean, value: number) =>
      isIncome || value === 0 ? value : -value;
    const headers = [
      t('monthlyCategoryBreakdown.csvParentColumn'),
      t('monthlyCategoryBreakdown.category'),
      ...model.months.map((m) => columnLabel(m)),
      t('monthlyCategoryBreakdown.total'),
      avgLabel,
    ];
    const rows: (string | number)[][] = [];
    for (const section of model.sections) {
      for (const row of section.rows) {
        rows.push([
          // A standalone category has no parent to name.
          section.isStandalone ? '' : section.title,
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
      ...model.months.map((m) => signed(false, model.monthlyExpenses[m] || 0)),
      signed(false, model.totalExpensesSum),
      signed(false, model.totalExpensesAvg),
    ]);
    rows.push([
      '',
      t('monthlyCategoryBreakdown.totalIncome'),
      ...model.months.map((m) => model.monthlyIncome[m] || 0),
      model.totalIncomeSum,
      model.totalIncomeAvg,
    ]);
    // Transfer rows carry their own sign already ("from" positive, "to"
    // negative), so they are exported as-is. A parent's roll-up is left out,
    // as the server leaves it out of the group total: it shares its parent's
    // label, and the exported rows add up to Total transfers.
    for (const transfer of model.transfers.rows.filter((tr) => !tr.isSubtotal)) {
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
    exportToCsv(
      isYearly ? 'yearly-category-breakdown' : 'monthly-category-breakdown',
      headers,
      rows,
    );
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
      return `${sign}${formatPercent(pct, 1)}`;
    }
    return `${sign} ${formatCurrency(Math.abs(normalized), currency)}`;
  };

  /**
   * A cell in the category column: the clipping block plus the inner block that
   * carries the padding and slides with the drag. The cell's own padding lives
   * in `innerClassName` (and its desktop truncation with it), because padding
   * left on the `<td>` would hold the collapsed column open by its own width.
   */
  const renderNameCell = (
    className: string,
    innerClassName: string,
    children: ReactNode,
    title?: string,
  ) => (
    <td
      data-name-cell=""
      className={`${NAME_CELL_CLASS} ${className}`}
      title={title}
    >
      <div className={NAME_CLIP_CLASS}>
        <div className={`${NAME_INNER_CLASS} ${innerClassName}`}>{children}</div>
      </div>
    </td>
  );

  const includeCurrentLabel = isYearly
    ? t('monthlyCategoryBreakdown.includeCurrentYear')
    : t('monthlyCategoryBreakdown.includeCurrentMonth');

  const months = model?.months ?? [];
  const hasData =
    model != null &&
    months.length > 0 &&
    (model.sections.length > 0 || model.hasTransfers);
  const colSpan = months.length + 3;

  // One category's row: the name, a drillable cell per month, its total and
  // its average. A subcategory is indented under its section header; a
  // standalone category is a line of its own at the level of the headers.
  const renderCategoryRow = (
    row: ProcessedRow,
    section: Section,
    standalone: boolean,
  ) => {
    const sectionMonthTotal = (m: string) =>
      section.isIncome ? model!.monthlyIncome[m] : model!.monthlyExpenses[m];
    const sectionSum = section.isIncome
      ? model!.totalIncomeSum
      : model!.totalExpensesSum;
    const sectionAvg = section.isIncome
      ? model!.totalIncomeAvg
      : model!.totalExpensesAvg;
    return (
      <tr
        key={row.categoryId || row.displayName}
        data-standalone={standalone ? '' : undefined}
        className="group hover:bg-gray-50 dark:hover:bg-gray-700"
      >
        {renderNameCell(
          `sticky left-0 z-10 bg-white dark:bg-gray-800 group-hover:bg-gray-50 dark:group-hover:bg-gray-700 text-gray-900 dark:text-gray-100${standalone ? ' font-semibold' : ''}`,
          `${standalone ? 'px-2' : 'pl-5 pr-2'} py-1 sm:max-w-[220px]`,
          <button
            type="button"
            onClick={() => drillDownRange(rowDrillIds(row))}
            className="block w-full text-left hover:underline sm:truncate"
          >
            {row.displayName}
          </button>,
          row.displayName,
        )}
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
    );
  };

  // Render one parent section: its colored header, the alphabetically sorted
  // subcategory rows, and the section subtotal. A standalone category is its
  // single row alone.
  const renderSection = (section: Section, si: number) => {
    if (section.isStandalone) {
      return (
        <Fragment key={`section-${si}`}>
          {renderCategoryRow(section.rows[0], section, true)}
        </Fragment>
      );
    }
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
        {section.rows.map((row) => renderCategoryRow(row, section, false))}
        {/* Section subtotal */}
        <tr className="font-bold bg-gray-50 dark:bg-gray-900 border-t-2 border-gray-300 dark:border-gray-600">
          {renderNameCell(
            'sticky left-0 z-10 bg-gray-50 dark:bg-gray-900',
            'px-2 py-1 sm:truncate',
            <>
              {t('monthlyCategoryBreakdown.subtotal')}: {section.title}
            </>,
            `${t('monthlyCategoryBreakdown.subtotal')}: ${section.title}`,
          )}
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
        {renderNameCell(
          `sticky left-0 z-10 bg-gray-100 dark:bg-gray-900 ${accent}`,
          'px-2 py-1',
          label,
        )}
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

  // Full-width group header bar ("Income" / "Expenses" / "Transfers"). The
  // label folds the group down to its total row and back.
  const renderGroupHeader = (group: GroupId, label: string, barClass: string) => {
    const collapsed = isCollapsed(group);
    return (
      <tr>
        <td colSpan={colSpan} className={`px-2 py-1.5 font-bold text-sm ${barClass}`}>
          <div className="sticky left-0 z-10 inline-block">
            <button
              type="button"
              onClick={() => toggleGroup(group)}
              aria-expanded={!collapsed}
              className="inline-flex items-center gap-1 rounded text-left hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            >
              <ChevronDownIcon
                aria-hidden="true"
                className={`h-4 w-4 transition-transform motion-reduce:transition-none ${collapsed ? '-rotate-90' : ''}`}
              />
              {label}
            </button>
          </div>
        </td>
      </tr>
    );
  };

  // The transfers group: a header bar, one signed row per account/direction
  // ("from" positive, "to" negative), and the net total transfers row.
  const renderTransfers = () => {
    const tr = model!.transfers;
    const accent = 'text-blue-700 dark:text-blue-300';
    return (
      <Fragment>
        {renderGroupHeader(
          'transfer',
          t('monthlyCategoryBreakdown.transfers'),
          TRANSFER_GROUP_CLASS,
        )}
        {!isCollapsed('transfer') && tr.rows.map((row) => (
          <tr
            key={row.key}
            className={`group hover:bg-gray-50 dark:hover:bg-gray-700${row.isSubtotal ? ' font-semibold' : ''}`}
          >
            {renderNameCell(
              'sticky left-0 z-10 bg-white dark:bg-gray-800 group-hover:bg-gray-50 dark:group-hover:bg-gray-700 text-gray-900 dark:text-gray-100',
              `${TRANSFER_DEPTH_CLASS[Math.min(row.depth, TRANSFER_DEPTH_CLASS.length - 1)]} pr-2 py-1 sm:max-w-[220px]`,
              <button
                type="button"
                onClick={() => drillTransferRow(row)}
                className="block w-full text-left hover:underline sm:truncate"
              >
                {row.displayName}
              </button>,
              row.displayName,
            )}
            {months.map((m) => {
              const value = row.values[m] || 0;
              return (
                <td key={m} className="px-2 py-1 text-right">
                  {value !== 0 ? (
                    <button
                      type="button"
                      onClick={() => drillTransferRow(row, m)}
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
                onClick={() => drillTransferRow(row)}
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
          {renderNameCell(
            `sticky left-0 z-10 bg-gray-100 dark:bg-gray-900 ${accent}`,
            'px-2 py-1',
            <button
              type="button"
              onClick={() => drillTransfersRange(model!.allTransferAccountIds)}
              className="text-left hover:underline"
            >
              {t('monthlyCategoryBreakdown.totalTransfers')}
            </button>,
          )}
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
      {renderNameCell(
        `sticky left-0 z-10 bg-gray-100 dark:bg-gray-900 group-hover:bg-gray-200 dark:group-hover:bg-gray-800 ${accent}`,
        'px-2 py-1',
        drill ? (
          <button type="button" onClick={drill.range} className="text-left hover:underline">
            {label}
          </button>
        ) : (
          label
        ),
      )}
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
      {/* Controls -- always rendered so focus inside DateInput survives reloads */}
      <div className={`${CARD_CLASS} p-4`}>
        <div className="flex flex-wrap gap-4 items-center justify-between">
          <FundingReportControls controls={funds} />
          <div
            className={SEGMENTED_GROUP_CLASS}
            role="group"
            aria-label={t('monthlyCategoryBreakdown.periodLabel')}
          >
            {BREAKDOWN_PERIODS.map((p) => (
              <button
                key={p}
                type="button"
                aria-pressed={period === p}
                className={segmentClass(period === p)}
                onClick={() => handlePeriodChange(p)}
              >
                {p === 'year'
                  ? t('monthlyCategoryBreakdown.periodYearly')
                  : t('monthlyCategoryBreakdown.periodMonthly')}
              </button>
            ))}
          </div>
          <DateRangeSelector
            // Remount on a width change so the custom date fields belong to
            // the window they edit.
            key={period}
            ranges={isYearly ? YEARLY_RANGES : MONTHLY_RANGES}
            labels={{ all: t('monthlyCategoryBreakdown.rangeAll') }}
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
                checked={summaryOnly}
                onChange={setSummaryOnly}
                label={t('monthlyCategoryBreakdown.summaryOnly')}
                size="sm"
              />
              <span>{t('monthlyCategoryBreakdown.summaryOnly')}</span>
            </div>
            <div className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
              <ToggleSwitch
                checked={includeCurrentPeriod}
                onChange={setIncludeCurrentPeriod}
                label={includeCurrentLabel}
                size="sm"
              />
              <span>{includeCurrentLabel}</span>
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
          </div>
          {/* CSV only: this view is a matrix of figures, with nothing to render
              as a picture. */}
          <ReportToolbarActions onExportCsv={handleExportCsv} disabled={isLoading || !!error || !hasData} />
        </div>
      </div>

      {/* Every cell, subtotal and total below sums the rows that converted, so
          a currency with no rate is named once, here, rather than left to be
          read as zero. */}
      {data && (
        <PartialDataNotice
          missingCurrencies={data.missingCurrencies ?? []}
          excludedCount={data.excludedCount ?? 0}
          displayCurrency={currency ?? ''}
        />
      )}
      {/* The transfer rows can hold an imported estimate of a cross-currency
          leg; the figures include it and the note says so. */}
      {data && <ProvisionalDataNotice count={data.provisionalCount} />}

      {/* Table */}
      <div className={`${CARD_CLASS} px-2 py-4 sm:p-6`}>
        {error ? (
          <ReportError onRetry={reload} />
        ) : isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-8 w-1/3" />
            <Skeleton className="h-64 w-full" />
          </div>
        ) : !hasData ? (
          <EmptyState title={t('monthlyCategoryBreakdown.noData')} />
        ) : (
          <div
            ref={scrollRef}
            className="overflow-x-auto"
            style={
              {
                '--mcb-name-full': `${MOBILE_NAME_WIDTH}px`,
                '--mcb-name-off': `${nameOffset}px`,
                '--mcb-name-w': `${MOBILE_NAME_WIDTH - nameOffset}px`,
              } as CSSProperties
            }
            onPointerDown={handleNamePointerDown}
            onPointerMove={handleNamePointerMove}
            onPointerUp={handleNamePointerUp}
            onPointerCancel={handleNamePointerUp}
            onClickCapture={handleNameClickCapture}
          >
            <table className="min-w-full text-xs border-collapse">
              <thead>
                <tr className="text-gray-500 dark:text-gray-400">
                  <SortableHeader
                    field={CATEGORY_COLUMN}
                    sortField={sortColumn}
                    sortDirection={sortDir}
                    onSort={handleSort}
                    align="left"
                    className={`sticky left-0 z-10 bg-white dark:bg-gray-800 font-medium sm:px-2 sm:py-2 sm:min-w-[180px] ${NAME_CELL_CLASS}`}
                  >
                    <span className={`block ${NAME_HEAD_CLIP_CLASS}`}>
                      <span className={`block px-2 py-2 sm:p-0 ${NAME_INNER_CLASS}`}>
                        {t('monthlyCategoryBreakdown.category')}
                      </span>
                    </span>
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
                      {columnLabel(m)}
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
                    {avgLabel}
                  </SortableHeader>
                </tr>
              </thead>
              <tbody>
                {/* Income group: sections (alphabetical) then the income
                    total; folded, only the total. */}
                {!summaryOnly && model!.incomeSections.length > 0 && (
                  <Fragment>
                    {renderGroupHeader(
                      'income',
                      t('monthlyCategoryBreakdown.income'),
                      INCOME_GROUP_CLASS,
                    )}
                    {!isCollapsed('income') &&
                      model!.incomeSections.map((section, si) =>
                        renderSection(section, si),
                      )}
                    {renderGroupTotal(true)}
                  </Fragment>
                )}

                {/* Expense group: sections (alphabetical) then the expense
                    total; folded, only the total. */}
                {!summaryOnly && model!.expenseSections.length > 0 && (
                  <Fragment>
                    {renderGroupHeader(
                      'expense',
                      t('monthlyCategoryBreakdown.expenses'),
                      EXPENSE_GROUP_CLASS,
                    )}
                    {!isCollapsed('expense') &&
                      model!.expenseSections.map((section, si) =>
                        renderSection(section, model!.incomeSections.length + si),
                      )}
                    {renderGroupTotal(false)}
                  </Fragment>
                )}

                {/* Transfers group: FROM (positive) / TO (negative) per account */}
                {!summaryOnly && model!.hasTransfers && renderTransfers()}

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
                  {renderNameCell(
                    'sticky left-0 z-10 bg-gray-100 dark:bg-gray-900 group-hover:bg-gray-200 dark:group-hover:bg-gray-800',
                    'px-2 py-1',
                    <button
                      type="button"
                      onClick={() => drillDownRange(model!.allCategoryIds)}
                      className="text-left hover:underline"
                    >
                      {t('monthlyCategoryBreakdown.balance')}
                    </button>,
                  )}
                  {months.map((m) => {
                    const bal = model!.monthlyBalance[m] || 0;
                    return (
                      <td key={m} className={`px-2 py-1 text-right ${gainLossColor(bal)}`}>
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
                  <td className={`px-2 py-1 text-right ${gainLossColor(model!.balanceSum)}`}>
                    <button
                      type="button"
                      onClick={() => drillDownRange(model!.allCategoryIds)}
                      className="hover:underline"
                    >
                      {formatGrand(model!.balanceSum, null, formatCurrency, currency)}
                    </button>
                  </td>
                  <td className={`px-2 py-1 text-right ${gainLossColor(model!.balanceAvg)}`}>
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
                    {renderNameCell(
                      'sticky left-0 z-10 bg-gray-200 dark:bg-gray-800 group-hover:bg-gray-300 dark:group-hover:bg-gray-700',
                      'px-2 py-1',
                      t('monthlyCategoryBreakdown.overallTotal'),
                    )}
                    {months.map((m) => {
                      const ov = model!.monthlyOverall[m] || 0;
                      return (
                        <td key={m} className={`px-2 py-1 text-right ${gainLossColor(ov)}`}>
                          {formatGrand(ov, null, formatCurrency, currency)}
                        </td>
                      );
                    })}
                    <td className={`px-2 py-1 text-right ${gainLossColor(model!.overallSum)}`}>
                      {formatGrand(model!.overallSum, null, formatCurrency, currency)}
                    </td>
                    <td className={`px-2 py-1 text-right ${gainLossColor(model!.overallAvg)}`}>
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
                      {renderNameCell(
                        'sticky left-0 z-10 bg-gray-50 dark:bg-gray-900 group-hover:bg-gray-100 dark:group-hover:bg-gray-800',
                        'px-2 py-1 sm:truncate',
                        section.allCategoryIds.length > 0 ? (
                          <button
                            type="button"
                            onClick={() => drillDownRange(section.allCategoryIds)}
                            className="block w-full text-left hover:underline sm:truncate"
                          >
                            {section.title}
                          </button>
                        ) : (
                          section.title
                        ),
                        section.title,
                      )}
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
      <MonthlyTaggedBalanceSummary controls={funds} months={months} period={period} />
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
