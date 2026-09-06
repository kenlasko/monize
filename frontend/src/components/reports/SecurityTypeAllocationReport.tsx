'use client';

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Skeleton } from '@/components/ui/LoadingSkeleton';
import { useReportData } from '@/hooks/useReportData';
import { usePersistedAccountFilter } from '@/hooks/usePersistedAccountFilter';
import { ReportError } from '@/components/reports/ReportError';
import {
  PieChart,
  Pie,
  Cell,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import { chartColors, CHART_SERIES, chartSeriesColor } from '@/lib/chart-colors';
import { investmentsApi } from '@/lib/investments';
import { HoldingWithMarketValue } from '@/types/investment';
import { Account } from '@/types/account';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { ExportDropdown } from '@/components/ui/ExportDropdown';
import { ReportAccountMultiSelect } from '@/components/reports/ReportAccountMultiSelect';
import { resolvePdfColor } from '@/components/reports/resolve-pdf-color';
import { RefreshPricesButton } from '@/components/reports/RefreshPricesButton';
import { SortableHeader } from '@/components/ui/SortableHeader';
import { CellLabel } from '@/components/ui/Table';
import { PartialTotal } from '@/components/ui/PartialTotal';
import { useSortableTable, compareValues } from '@/hooks/useSortableTable';
import { createLogger } from '@/lib/logger';
import { aggregateHoldingsBySecurity, AggregatedHolding } from '@/lib/aggregate-holdings';

const logger = createLogger('SecurityTypeAllocationReport');

// Holdings are keyed off the brokerage sub-account, so offer those (the
// sibling cash account is excluded from the picker).
type SecurityTypeSortField = 'label' | 'totalValue' | 'percentage' | 'count';

/**
 * One column of the data table. The four are declared once, as a record over
 * the sort field union, and rendered by BOTH header rows -- the column header
 * row (from `sm` up) and the phone sort strip -- so the two can never list
 * different fields, and a new union member fails `tsc` rather than stranding a
 * phone with no control for it.
 */
interface SortColumn {
  field: SecurityTypeSortField;
  label: string;
  /** Money, percent and count columns are right-aligned on desktop. */
  align?: 'right';
}

/**
 * The record the two header rows are built from, each key tied to its entry's
 * own `field`. A plain `Record<SecurityTypeSortField, SortColumn>` forces an
 * entry to EXIST for every union member but lets it name a different one, so
 * `count: { field: 'percentage', label: colHoldings }` would type-check: two
 * controls keyed `percentage` (a duplicate React key), "Holdings" sorting by
 * share, and "Holdings" unsortable -- none of which a test comparing header
 * LABELS can see, because the labels stay right. Here it is a compile error.
 */
type SortColumnsByField = {
  [K in SecurityTypeSortField]: SortColumn & { field: K };
};

// Today's header cell, unchanged.
const HEADER_CLASS =
  'px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider';

// The same sort controls in the phone strip: a wrapped row of compact chips.
// Column alignment means nothing there -- the column header row is hidden and
// each data row is a grid -- so every control is left-aligned and self-naming.
// The border and card background are what say "tappable": there is no hover on a
// touch screen, and without them the strip reads as one more row of captions.
const PHONE_HEADER_CLASS =
  'rounded border border-gray-200 bg-white px-2 py-1.5 text-xs font-medium text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400 uppercase';

// Where each column sits on the phone grid for an ASSET TYPE row and for the
// totals footer, written once: those two shapes are 1x1 over the same four
// columns, so the footer takes the type row's placement verbatim and a reader
// finds the share in the same corner of both. Line 1 is the identity beside the
// total (the figure the row is read for), line 2 the share beside the holdings
// count. Inert from `sm` up.
const CELL_PLACEMENT: Record<SecurityTypeSortField, string> = {
  label: 'col-start-1 row-start-1',
  totalValue: 'col-start-2 row-start-1',
  percentage: 'col-start-1 row-start-2',
  count: 'col-start-2 row-start-2',
};

// A CHILD holding row needs its own placement, and the reason is its identity
// rather than its figures: a type label is bounded (five known labels, or an
// unknown type's raw enum name) where a holding's is `SYMBOL - Security Name`
// plus an optional `(N accounts)` marker, unbounded and routinely past 40
// characters. Sharing the type row's two tracks leaves it 90px at 320px, and
// both treatments that fit it there lose something: a 3-line clamp cut the
// account marker off in EVERY locale (0 of 2 markers painted) and a free wrap ran
// the row to 152-172px. So the identity takes the whole of line 1 (256px at
// 320px, 326px at 390px) and the three figures fall to lines 2 and 3, each in the
// COLUMN its type-row counterpart uses -- share left, value and quantity right --
// so the two shapes read alike down the card. Measured 126px per child row at
// 320px against a 57px desktop row with the same content, with the marker
// painted in every locale at both widths.
const CHILD_CELL_PLACEMENT: Record<SecurityTypeSortField, string> = {
  label: 'col-start-1 col-span-2 row-start-1',
  percentage: 'col-start-1 row-start-2',
  totalValue: 'col-start-2 row-start-2',
  count: 'col-start-2 row-start-3',
};

// A figure cell inside a wrapped card: no padding of its own below `sm` (the row
// supplies it and the grid does the spacing), the table cell's own padding from
// `sm` up, smaller type on phones. `whitespace-nowrap` is the one property here
// that is NOT phone-only, and the single respect in which the `sm`-and-up cell
// differs from today's: a locale grouping thousands with a space could break a
// figure in the middle of a number otherwise, at any width.
//
// Width budget, measured on a hand-written CSS replica in Chromium at the
// insets this table really gets -- the report page's `px-4` and the row's own
// `px-4`, the card contributing none -- so 256px of track at 320px and 326px at
// 390px, and two equal `minmax(0,1fr)` tracks with the row's `gap-x-3` give
// each figure cell a measured 122px and 157px. The formatter is the 2dp
// `formatCurrencyFull`, not the compact one the summary cards use, and that is
// what decides the line count; the unit is part of the budget and is not always
// a symbol, since `narrowSymbol` falls back to the three-letter ISO code where
// a currency has none, so the widest is `CHF`. The budget is measured against
// the FOOTER's grand total, larger than any row value by construction and
// wearing `font-bold` on top of it: bold at `text-xs`, `123 456,78 CHF` is
// 107px and `2 913 579,10 CHF` is 119px -- six AND seven figures fit the 122px
// track at 320px, and up to eleven fit the 157px track at 390px. Eight figures
// (128px) are the first past 122px, so an eight-figure portfolio total reopens
// the wrapper's sideways scroll at 320px, and only there. That is deliberate,
// because every alternative is worse: right alignment is not a containment
// device (a nowrap figure longer than its track overflows past the END edge
// whatever `text-align` says), `overflow-hidden` would silently cut a figure,
// and dropping `whitespace-nowrap` would let a space-grouping locale break a
// number in half. A cut or broken figure is worse than a scroll.
//
// Four figure cells on ONE line was measured and does NOT fit: four equal tracks
// are 55px at 320px, putting 298px of table in a 288px wrapper with 64px of
// overflow on the bold grand total and an 11px name box -- and still 46px of
// overflow at 390px. So two per line.
const FIGURE_CELL =
  'p-0 text-right text-xs whitespace-nowrap sm:table-cell sm:px-4 sm:py-3 sm:text-sm';

/** The same figure cell on a child row, whose desktop padding is `py-2`. */
const CHILD_FIGURE_CELL =
  'p-0 text-right text-xs whitespace-nowrap sm:table-cell sm:px-4 sm:py-2 sm:text-sm';

/**
 * The identity cell of a type row and of the totals footer: the same box in
 * both, and one of the two cells that keep `text-sm` on phones (a label is
 * prose, and the figures' `text-xs` would cost the clamp a character a line).
 */
const IDENTITY_CELL =
  `${CELL_PLACEMENT.label} min-w-0 p-0 text-sm sm:table-cell sm:px-4 sm:py-3`;

/**
 * The child holding's identity cell. `pl-10` is preserved exactly from `sm` up
 * (`sm:pl-10` after `sm:px-4`); below `sm` the indent is `pl-8`, 32px, chosen by
 * measurement rather than by copying the desktop figure. The type row's own
 * label starts 20px into the row (a 12px dot plus its 8px gap), so a 16px indent
 * would put the child's first glyph to the LEFT of it and read as not nested at
 * all, while 32px places it 12px clear. The desktop 40px would work too, but
 * this cell also carries the row's tint and no colour dot, so 32px says "inside"
 * without spending more of the identity's width than the cue needs.
 *
 * There is no clamp here, deliberately and twice over: it keeps the
 * `(N accounts)` marker on screen (a 3-line clamp cut it in every locale) and
 * it keeps the `sm`-and-up DOM byte-identical, since a clamped span would have
 * to become `display: block` at `sm` -- what Tailwind's `line-clamp-none`
 * resolves to -- and push that inline marker onto its own desktop line.
 * Containment does not need the clip the sibling reports rely on: this cell is
 * a GRID item with `min-w-0`, not a flex item, so a wrapping box contributes no
 * minimum width, and `break-words` handles the one case a wrap cannot, a single
 * unbreakable token -- measured with a 52-character one at 320px, the wrapper
 * still scrolls no wider than its client box.
 */
const CHILD_IDENTITY_CELL =
  `${CHILD_CELL_PLACEMENT.label} min-w-0 p-0 pl-8 text-sm break-words sm:table-cell sm:px-4 sm:py-2 sm:pl-10 sm:break-normal`;

/** Every caption in a wrapped cell is phone-only. */
const CAPTION_CLASS = 'sm:hidden';

const TYPE_COLOURS: Record<string, string> = {
  STOCK: CHART_SERIES[0],
  ETF: CHART_SERIES[1],
  MUTUAL_FUND: CHART_SERIES[8],
  BOND: CHART_SERIES[4],
  CASH: chartColors.axis,
};

const TYPE_LABELS: Record<string, string> = {
  STOCK: 'Stocks',
  ETF: 'ETFs',
  MUTUAL_FUND: 'Mutual Funds',
  BOND: 'Bonds',
  CASH: 'Cash',
};

interface TypeAllocation {
  type: string;
  label: string;
  totalValue: number;
  percentage: number;
  count: number;
  color: string;
  holdings: AggregatedHolding[];
}

function getColor(type: string, index: number): string {
  return TYPE_COLOURS[type] || chartSeriesColor(index);
}

function CustomTooltip({ active, payload, formatCurrencyFull, getHoldingsLabel }: {
  active?: boolean;
  payload?: Array<{ payload: TypeAllocation }>;
  formatCurrencyFull: (v: number) => string;
  getHoldingsLabel: (count: number) => string;
}) {
  const { formatPercent } = useNumberFormat();
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
      <p className="font-medium text-gray-900 dark:text-gray-100">{d.label}</p>
      <p className="text-sm text-gray-600 dark:text-gray-400">{formatCurrencyFull(d.totalValue)} ({formatPercent(d.percentage, 1)})</p>
      <p className="text-sm text-gray-500 dark:text-gray-400">{getHoldingsLabel(d.count)}</p>
    </div>
  );
}

const ACCOUNTS_STORAGE_KEY = 'monize-reports-security-type-allocation-accounts';

export function SecurityTypeAllocationReport() {
  const t = useTranslations('reports');
  const tCommon = useTranslations('common');
  const { formatCurrencyCompact: formatCurrency, formatCurrency: formatCurrencyFull, formatPercent } = useNumberFormat();
  const { defaultCurrency, convertToDefault } = useExchangeRates();
  const [accounts, setAccounts] = useState<Account[]>([]);
  // Persisted so the report opens on the accounts the user last chose.
  const [selectedAccountIds, setSelectedAccountIds] = usePersistedAccountFilter(
    ACCOUNTS_STORAGE_KEY,
    accounts,
  );
  const [expandedType, setExpandedType] = useState<string | null>(null);
  const chartRef = useRef<HTMLDivElement>(null);
  const { sortField, sortDirection, handleSort } = useSortableTable<SecurityTypeSortField>(
    'reports.security-type-allocation.sort',
    { field: 'totalValue', direction: 'desc' },
  );

  // Fetch accounts once on mount
  useEffect(() => {
    investmentsApi.getInvestmentAccounts()
      .then(setAccounts)
      .catch((error) => logger.error('Failed to load accounts:', error));
  }, []);

  // `reload` (a stable callback) is wired to the RefreshPricesButton so a
  // manual price refresh re-fetches the holdings.
  const { data: summaryData, isLoading, error, reload: loadData } = useReportData(
    () =>
      investmentsApi.getPortfolioSummary(
        selectedAccountIds.length > 0 ? selectedAccountIds : undefined,
      ),
    [selectedAccountIds],
  );

  const holdings = useMemo<HoldingWithMarketValue[]>(
    () => summaryData?.holdings ?? [],
    [summaryData],
  );

  const allocationData = useMemo((): TypeAllocation[] => {
    // Aggregate holdings by security first so the same symbol held across
    // multiple accounts appears as a single row under its security type.
    const aggregated = aggregateHoldingsBySecurity(holdings);

    const typeMap = new Map<string, { totalValue: number; holdings: AggregatedHolding[] }>();
    aggregated.forEach((h) => {
      const type = h.securityType || 'OTHER';
      // An unpriced holding and an unconvertible one both leave the allocation:
      // `?? 0` folded the first in as a zero, re-weighting every other type.
      if (h.marketValue === null || h.marketValue === undefined) return;
      const converted = convertToDefault(h.marketValue, h.currencyCode);
      if (converted === null) return;

      let existing = typeMap.get(type);
      if (!existing) {
        existing = { totalValue: 0, holdings: [] };
        typeMap.set(type, existing);
      }
      existing.totalValue += converted;
      existing.holdings.push(h);
    });

    const totalValue = Array.from(typeMap.values()).reduce((sum, v) => sum + v.totalValue, 0);
    let colorIndex = 0;

    return Array.from(typeMap.entries())
      .map(([type, data]) => ({
        type,
        label: TYPE_LABELS[type] || type,
        totalValue: data.totalValue,
        percentage: totalValue > 0 ? (data.totalValue / totalValue) * 100 : 0,
        count: data.holdings.length,
        color: getColor(type, colorIndex++),
        holdings: [...data.holdings].sort((a, b) => {
          // An unpriced or unconvertible holding has an unknown value, not a
          // zero: it sorts after every known one rather than as the smallest.
          const value = (h: (typeof data.holdings)[number]) =>
            h.marketValue === null || h.marketValue === undefined
              ? null
              : convertToDefault(h.marketValue, h.currencyCode);
          const va = value(a);
          const vb = value(b);
          if (va === null && vb === null) return 0;
          if (va === null) return 1;
          if (vb === null) return -1;
          return vb - va;
        }),
      }))
      .sort((a, b) => b.totalValue - a.totalValue);
  }, [holdings, convertToDefault]);

  const totalPortfolioValue = useMemo(
    () => allocationData.reduce((sum, a) => sum + a.totalValue, 0),
    [allocationData],
  );

  // The footer, the summary card and the PDF all report this one number, and
  // each of the three used to sum it for itself.
  const totalHoldingsCount = useMemo(
    () => allocationData.reduce((sum, a) => sum + a.count, 0),
    [allocationData],
  );

  // Holdings the allocation had to leave out (mirrors its exclusion rule): an
  // unpriced holding, or one with no rate to the display currency. Non-empty
  // means the total and every percentage are over a subset of the portfolio.
  const allocationGaps = useMemo(() => {
    const missing = new Set<string>();
    let excludedCount = 0;
    // Iterate the same by-security aggregation the total is built from: a
    // position summed to a null market value drops as one aggregated holding,
    // so counting raw lots here would disagree with what actually left the total.
    for (const h of aggregateHoldingsBySecurity(holdings)) {
      if (h.marketValue === null || h.marketValue === undefined) {
        excludedCount += 1;
        continue;
      }
      if (convertToDefault(h.marketValue, h.currencyCode) === null) {
        missing.add(h.currencyCode);
        excludedCount += 1;
      }
    }
    return { missingCurrencies: [...missing], excludedCount };
  }, [holdings, convertToDefault]);

  const sortedAllocationData = useMemo(() => {
    const sorted = [...allocationData];
    sorted.sort((a, b) => {
      let comparison = 0;
      switch (sortField) {
        case 'label':
          comparison = compareValues(a.label, b.label);
          break;
        case 'totalValue':
          comparison = compareValues(a.totalValue, b.totalValue);
          break;
        case 'percentage':
          comparison = compareValues(a.percentage, b.percentage);
          break;
        case 'count':
          comparison = compareValues(a.count, b.count);
          break;
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });
    return sorted;
  }, [allocationData, sortField, sortDirection]);

  // Exhaustive over the sort field union, so a new field is a compile error
  // rather than a column with no control in either header -- and each entry
  // must name its own key (see `SortColumnsByField`). These are also the phone
  // captions, so a value reads under exactly the label its column header uses.
  const columns: SortColumnsByField = {
    label: { field: 'label', label: t('securityTypeAllocation.colAssetType') },
    totalValue: { field: 'totalValue', label: t('securityTypeAllocation.colTotalValue'), align: 'right' },
    percentage: { field: 'percentage', label: t('securityTypeAllocation.colPortfolioPct'), align: 'right' },
    count: { field: 'count', label: t('securityTypeAllocation.colHoldings'), align: 'right' },
  };

  // The column order, rendered by BOTH header rows and matched by the cells'
  // DOM order. DERIVED from the record rather than re-listed: a hand-written
  // list beside an exhaustive record is not exhaustive, so a field added to the
  // union would compile (the record forces an entry) and still ship with no
  // sort control in either header. The record's declaration order IS the column
  // order, and it is today's; where a card PLACES each column is
  // `CELL_PLACEMENT` and `CHILD_CELL_PLACEMENT`, separate decisions.
  const sortColumns: readonly SortColumn[] = Object.values(columns);

  const handleExportPdf = async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    const headers = [
      t('securityTypeAllocation.pdfColAssetType'),
      t('securityTypeAllocation.pdfColTotalValue'),
      t('securityTypeAllocation.pdfColPortfolioPct'),
      t('securityTypeAllocation.pdfColHoldings'),
    ];
    const rows = allocationData.map(item => [
      item.label,
      formatCurrencyFull(item.totalValue, defaultCurrency),
      formatPercent(item.percentage, 1),
      String(item.count),
    ]);
    await exportToPdf({
      title: t('securityTypeAllocation.pdfTitle'),
      summaryCards: [
        { label: t('securityTypeAllocation.pdfTotalPortfolio'), value: `${formatCurrency(totalPortfolioValue, defaultCurrency)}${allocationGaps.excludedCount > 0 ? ` ${tCommon('partialTotal.srSuffix')}` : ''}`, color: '#111827' },
        { label: t('securityTypeAllocation.pdfAssetTypes'), value: String(allocationData.length), color: '#111827' },
        { label: t('securityTypeAllocation.pdfTotalHoldings'), value: String(totalHoldingsCount), color: '#111827' },
        { label: t('securityTypeAllocation.pdfLargestType'), value: allocationData[0]?.label || '-', color: '#111827' },
      ],
      chartContainer: chartRef.current,
      chartLegend: allocationData.map((item) => ({
        color: resolvePdfColor(item.color),
        label: `${item.label} - ${formatCurrencyFull(item.totalValue, defaultCurrency)} (${formatPercent(item.percentage, 1)})`,
      })),
      tableData: { headers, rows },
      filename: 'security-type-allocation',
    });
  };

  if (error) {
    return <ReportError onRetry={loadData} />;
  }

  if (isLoading && !summaryData) {
    return (
      <div className="space-y-6">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <div className="space-y-4">
            <Skeleton className="h-8 w-1/3" />
            <Skeleton className="h-64 w-full" />
          </div>
        </div>
      </div>
    );
  }

  if (allocationData.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-8 text-center">
        <p className="text-gray-500 dark:text-gray-400">
          {t('securityTypeAllocation.noData')}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Account Filter */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex flex-wrap gap-3 items-center justify-between">
          <div className="flex flex-wrap gap-3 items-center">
            <ReportAccountMultiSelect
              accounts={accounts}
              value={selectedAccountIds}
              onChange={setSelectedAccountIds}
              mode="portfolio"
            />
          </div>
          <div className="flex gap-2 items-center">
            <RefreshPricesButton onRefreshComplete={loadData} />
            <ExportDropdown onExportPdf={handleExportPdf} />
          </div>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 sm:gap-4">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-4">
          <p className="text-xs sm:text-sm text-gray-500 dark:text-gray-400">{t('securityTypeAllocation.totalPortfolio')}</p>
          <p className="text-lg sm:text-xl font-bold text-gray-900 dark:text-gray-100">
            <PartialTotal
              total={{ value: totalPortfolioValue, ...allocationGaps }}
              displayCurrency={defaultCurrency}
            >
              {formatCurrency(totalPortfolioValue, defaultCurrency)}
            </PartialTotal>
          </p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-4">
          <p className="text-xs sm:text-sm text-gray-500 dark:text-gray-400">{t('securityTypeAllocation.assetTypes')}</p>
          <p className="text-lg sm:text-xl font-bold text-gray-900 dark:text-gray-100">
            {allocationData.length}
          </p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-4">
          <p className="text-xs sm:text-sm text-gray-500 dark:text-gray-400">{t('securityTypeAllocation.totalHoldings')}</p>
          <p className="text-lg sm:text-xl font-bold text-gray-900 dark:text-gray-100">
            {totalHoldingsCount}
          </p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-4">
          <p className="text-xs sm:text-sm text-gray-500 dark:text-gray-400">{t('securityTypeAllocation.largestType')}</p>
          <p className="text-lg sm:text-xl font-bold text-gray-900 dark:text-gray-100">
            {allocationData[0]?.label || '-'}
          </p>
        </div>
      </div>

      {/* Pie Chart */}
      <div ref={chartRef} className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          {t('securityTypeAllocation.assetTypeAllocation')}
        </h3>
        <div style={{ width: '100%', height: 350 }}>
          <ResponsiveContainer minWidth={0}>
            <PieChart>
              <Pie
                data={allocationData}
                dataKey="totalValue"
                nameKey="label"
                cx="50%"
                cy="50%"
                innerRadius={60}
                outerRadius={120}
                paddingAngle={2}
              >
                {allocationData.map((entry) => (
                  <Cell key={entry.type} fill={entry.color} />
                ))}
              </Pie>
              <Tooltip content={<CustomTooltip formatCurrencyFull={(v) => formatCurrencyFull(v, defaultCurrency)} getHoldingsLabel={(count) => t('securityTypeAllocation.tooltipHoldings', { count })} />} />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Data Table

          Below `sm` the table becomes a block and each row wraps into a
          two-column grid so all four columns fit a phone without a horizontal
          scroll. An ASSET TYPE row and the totals footer take two lines -- the
          identity beside the total, then the share beside the holdings count --
          and a CHILD holding row takes three, because its identity is unbounded
          where a type label is not (see `CHILD_CELL_PLACEMENT`). Nothing is
          dropped: every row carries all four columns at every width, and the
          rows stay what they are today, a type row clickable and toggling its
          holdings, a child row not. From `sm` up it is the ordinary table. The
          sort controls survive as their own phone-only header row, because the
          column header row that carries them on desktop is hidden there.

          Measured before and after on a hand-written CSS replica in Chromium at
          this table's real insets (the report page's `px-4`; the card adds none
          of its own), with one type EXPANDED so the child rows are in every
          figure: today the table is 745px wide in `pl`, 762px in `ru`, 785px in
          `de` and 779px in the pseudo-locale, inside a 288px wrapper at 320px
          and a 358px one at 390px -- a sideways scroll in every locale at both
          widths. Wrapped, the wrapper's `scrollWidth` equals its `clientWidth`
          at both widths in `pl`, `ru`, `id`, `de` and `xx`, no cell overflowing.

          Two properties of restyling one tree, both deliberate. Changing the
          `display` drops the implicit table semantics below `sm`, so the
          explicit ARIA roles below put them back; the phone sort strip is the
          header row a phone reader gets, and its four controls sit in the data
          cells' own DOM order, so the column association survives there. Every
          row exposes all four cells at every width, so none needs an
          `aria-colindex`, and the `CellLabel` captions are REDUNDANT with that
          association rather than a substitute for it: the grid paints the cells
          out of DOM order, so a sighted phone reader needs the name beside the
          value. The second property is an
          ACCEPTED, UNMITIGATED trade-off the roles do not answer -- they restore
          semantics, not reading order. The DOM keeps the desktop column order
          while a child row paints its share before its value, so a screen-reader
          user hears the column order rather than the painted one: the WCAG 1.3.2
          tension mechanism A carries. The captions limit the cost, since every
          value names its own column. */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
        <div className="overflow-x-auto">
          <table role="table" className="block min-w-full divide-y divide-gray-200 dark:divide-gray-700 sm:table">
            <thead role="rowgroup" className="block bg-gray-50 dark:bg-gray-900/50 sm:table-header-group">
              {/* Phone sort strip: the same four controls, wrapped. */}
              <tr role="row" className="flex flex-wrap gap-x-2 gap-y-1 px-2 py-2 sm:hidden">
                {sortColumns.map((col) => (
                  <SortableHeader<SecurityTypeSortField>
                    key={col.field}
                    field={col.field}
                    sortField={sortField}
                    sortDirection={sortDirection}
                    onSort={handleSort}
                    className={PHONE_HEADER_CLASS}
                  >
                    {col.label}
                  </SortableHeader>
                ))}
              </tr>
              <tr role="row" className="hidden sm:table-row">
                {sortColumns.map((col) => (
                  <SortableHeader<SecurityTypeSortField>
                    key={col.field}
                    field={col.field}
                    sortField={sortField}
                    sortDirection={sortDirection}
                    onSort={handleSort}
                    align={col.align}
                    className={HEADER_CLASS}
                  >
                    {col.label}
                  </SortableHeader>
                ))}
              </tr>
            </thead>
            <tbody role="rowgroup" className="block divide-y divide-gray-200 dark:divide-gray-700 sm:table-row-group">
              {sortedAllocationData.map((item) => (
                <React.Fragment key={item.type}>
                  <tr
                    role="row"
                    /* Deliberately NO `aria-expanded`, though this row is the
                       expand control and `role="row"` would take it: a `<tr>` is
                       not focusable and this one carries a bare `onClick` with no
                       key handler, so the state would announce a control a
                       keyboard cannot operate -- a stated dead end rather than
                       the silent one there is now. The two are one repair and it
                       is a behaviour change: make the row operable through the
                       repo's row-click convention (`useLongPress({ onClick })`),
                       then state the expansion. Reported, not done here. */
                    className="grid grid-cols-2 items-start gap-x-3 gap-y-1.5 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-700/50 cursor-pointer sm:table-row sm:p-0"
                    onClick={() => setExpandedType(expandedType === item.type ? null : item.type)}
                  >
                    {/* The identity; the `<tr>` around it stays the click target
                        at every width. A type label is bounded in practice (five
                        known labels, or an unknown security type's raw enum
                        name), but it still sits in a `minmax(0,1fr)` track with
                        `min-w-0` and a clamp: it shares its line with the dot
                        AND the chevron, 44px of the 122px track at 320px between
                        them, so the name box is a measured 78px and a raw enum
                        like `STRUCTURED_PRODUCT_NOTE` needs three lines.
                        `break-words` is what makes that legible rather than
                        clipped -- a 23-character token does not fit 78px, and
                        without it the clamp's `overflow: hidden` cuts it
                        mid-glyph with no ellipsis, which every width and
                        overflow measurement reports as fine. Both are phone-only;
                        from `sm` up the name box is 418px and the cell wraps
                        exactly as it does today.

                        The clamp is load-bearing for containment too, and the two
                        jobs are easy to separate by accident: this span is a flex
                        item WITHOUT its own `min-w-0`, so its automatic minimum
                        size would be the unbroken token's width, which
                        `break-words` does not shrink -- what zeroes it is
                        `line-clamp-3`'s own `overflow: hidden`. The chevron
                        keeps its rotation class and its place beside the label
                        at every width -- it is the only thing on the card that
                        says the row opens -- and `flex-shrink-0` is new and
                        phone-driven: at 78px of label the flex line is tight
                        enough to squeeze the 16px glyph, inert on a desktop. */}
                    <td role="cell" className={`${IDENTITY_CELL} font-medium text-gray-900 dark:text-gray-100`}>
                      <div className="flex items-center gap-2">
                        <div
                          className="w-3 h-3 rounded-full flex-shrink-0"
                          style={{ backgroundColor: item.color }}
                        />
                        <span className="line-clamp-3 break-words sm:line-clamp-none sm:break-normal" title={item.label}>{item.label}</span>
                        <svg
                          className={`w-4 h-4 text-gray-400 transition-transform flex-shrink-0 ${expandedType === item.type ? 'rotate-180' : ''}`}
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                        </svg>
                      </div>
                    </td>
                    {/* The total is the headline: the right of line 1, beside the
                        type, because it is what the row is read for. */}
                    <td role="cell" className={`${CELL_PLACEMENT.totalValue} font-medium text-gray-900 dark:text-gray-100 ${FIGURE_CELL}`}>
                      <CellLabel className={CAPTION_CLASS}>{columns.totalValue.label}</CellLabel>
                      {formatCurrencyFull(item.totalValue, defaultCurrency)}
                    </td>
                    {/* The share opens line 2. Its value is bounded (`100.0%`) but
                        its CAPTION is not (`[XX-% of Portfolio-XX]` is 22
                        characters), so it takes a full `minmax(0,1fr)` track. */}
                    <td role="cell" className={`${CELL_PLACEMENT.percentage} text-gray-600 dark:text-gray-400 ${FIGURE_CELL}`}>
                      <CellLabel className={CAPTION_CLASS}>{columns.percentage.label}</CellLabel>
                      {formatPercent(item.percentage, 1)}
                    </td>
                    <td role="cell" className={`${CELL_PLACEMENT.count} text-gray-600 dark:text-gray-400 ${FIGURE_CELL}`}>
                      <CellLabel className={CAPTION_CLASS}>{columns.count.label}</CellLabel>
                      {item.count}
                    </td>
                  </tr>
                  {expandedType === item.type && item.holdings.map((h) => {
                    // One decision, read by both the value cell and the share
                    // beside it: the two used to recompute it separately, and a
                    // rule applied twice can disagree with itself. An unpriced
                    // holding and an unconvertible one are both UNKNOWN -- never
                    // a zero, never the unconverted number under the display
                    // currency's name. (Today `allocationData` drops such a
                    // holding before it can become a child row at all: reported
                    // as a pre-existing dead branch, not changed here.)
                    const value =
                      h.marketValue === null || h.marketValue === undefined
                        ? null
                        : convertToDefault(h.marketValue, h.currencyCode);
                    return (
                    <tr
                      key={h.securityId}
                      role="row"
                      className="grid grid-cols-2 items-start gap-x-3 gap-y-1.5 px-4 py-2 bg-gray-50/50 dark:bg-gray-900/20 sm:table-row sm:p-0"
                    >
                      {/* The identity takes the whole of line 1, and the
                          `(N accounts)` marker stays inline after the name as it
                          is today -- exactly why this cell has no clamp: at 320px
                          a three-line clamp painted NONE of the markers. */}
                      <td role="cell" className={`${CHILD_IDENTITY_CELL} text-gray-600 dark:text-gray-400`}>
                        {h.symbol} - {h.name}
                        {h.accountBreakdowns.length > 1 && (
                          <span className="ml-2 text-xs text-gray-400 dark:text-gray-500">
                            ({t('securityTypeAllocation.holdingsCount', { count: h.accountBreakdowns.length })})
                          </span>
                        )}
                      </td>
                      {/* The cells stay in COLUMN order in the DOM -- value then
                          share -- because from `sm` up a cell's order IS the
                          column it lands in; only the placement paints the share
                          to its left. The unknown marker and the dash are
                          captioned like any other value below. */}
                      <td role="cell" className={`${CHILD_CELL_PLACEMENT.totalValue} text-gray-600 dark:text-gray-400 ${CHILD_FIGURE_CELL}`}>
                        <CellLabel className={CAPTION_CLASS}>{columns.totalValue.label}</CellLabel>
                        {value === null
                          ? t('securityTypeAllocation.unavailable')
                          : formatCurrencyFull(value, defaultCurrency)}
                      </td>
                      <td role="cell" className={`${CHILD_CELL_PLACEMENT.percentage} text-gray-500 dark:text-gray-500 ${CHILD_FIGURE_CELL}`}>
                        <CellLabel className={CAPTION_CLASS}>{columns.percentage.label}</CellLabel>
                        {value === null || totalPortfolioValue <= 0
                          ? '-'
                          : formatPercent((value / totalPortfolioValue) * 100, 1)}
                      </td>
                      {/* A caption names the COLUMN its cell is in, not the kind
                          of the value, so this one is as true as the Holdings
                          header above it on a desktop and no truer: the column
                          holds a count of holdings on a type row and a count of
                          SHARES here. That conflation is pre-existing and
                          reported; bare, the cell would add a new one, since at
                          `col-start-2 row-start-3` it sits directly under this
                          row's money figure in the same track. */}
                      <td role="cell" className={`${CHILD_CELL_PLACEMENT.count} text-gray-500 dark:text-gray-500 ${CHILD_FIGURE_CELL}`}>
                        <CellLabel className={CAPTION_CLASS}>{columns.count.label}</CellLabel>
                        {h.quantity}
                      </td>
                    </tr>
                    );
                  })}
                </React.Fragment>
              ))}
            </tbody>
            <tfoot role="rowgroup" className="block bg-gray-50 dark:bg-gray-900/50 sm:table-footer-group">
              {/* The totals are the largest figures on the table, so this row
                  wraps exactly the way a TYPE row does -- same two tracks, same
                  placement, each figure captioned -- with "Total" standing in for
                  the type. Every column has a total, so no cell leaves the DOM
                  below `sm`: four cells at every width. */}
              <tr role="row" className="grid grid-cols-2 items-start gap-x-3 gap-y-1.5 px-4 py-3 sm:table-row sm:p-0">
                <td role="cell" className={`${IDENTITY_CELL} font-bold text-gray-900 dark:text-gray-100`}>
                  {/* The same clamped span the type rows use, not a bare label:
                      this track's containment argument IS the clamp's `overflow:
                      hidden` (see the type row), so a cell outside it is one long
                      token from reopening the sideways scroll, with nothing to
                      show it until a locale grows one. */}
                  <span className="line-clamp-3 break-words sm:line-clamp-none sm:break-normal" title={t('securityTypeAllocation.total')}>
                    {t('securityTypeAllocation.total')}
                  </span>
                </td>
                <td role="cell" className={`${CELL_PLACEMENT.totalValue} font-bold text-gray-900 dark:text-gray-100 ${FIGURE_CELL}`}>
                  <CellLabel className={CAPTION_CLASS}>{columns.totalValue.label}</CellLabel>
                  {formatCurrencyFull(totalPortfolioValue, defaultCurrency)}
                </td>
                <td role="cell" className={`${CELL_PLACEMENT.percentage} font-bold text-gray-900 dark:text-gray-100 ${FIGURE_CELL}`}>
                  <CellLabel className={CAPTION_CLASS}>{columns.percentage.label}</CellLabel>
                  100%
                </td>
                <td role="cell" className={`${CELL_PLACEMENT.count} font-bold text-gray-900 dark:text-gray-100 ${FIGURE_CELL}`}>
                  <CellLabel className={CAPTION_CLASS}>{columns.count.label}</CellLabel>
                  {totalHoldingsCount}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  );
}
