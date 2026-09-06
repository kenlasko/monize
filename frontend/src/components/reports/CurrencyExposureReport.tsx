'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { Skeleton } from '@/components/ui/LoadingSkeleton';
import {
  PieChart,
  Pie,
  Cell,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import { investmentsApi } from '@/lib/investments';
import { HoldingWithMarketValue } from '@/types/investment';
import { Account } from '@/types/account';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { ExportDropdown } from '@/components/ui/ExportDropdown';
import { ReportAccountMultiSelect } from '@/components/reports/ReportAccountMultiSelect';
import { RefreshPricesButton } from '@/components/reports/RefreshPricesButton';
import { SortableHeader } from '@/components/ui/SortableHeader';
import { CellLabel } from '@/components/ui/Table';
import { PartialTotal } from '@/components/ui/PartialTotal';
import { useSortableTable, compareValues } from '@/hooks/useSortableTable';
import { useReportData } from '@/hooks/useReportData';
import { usePersistedAccountFilter } from '@/hooks/usePersistedAccountFilter';
import { ReportError } from '@/components/reports/ReportError';
import { FX_RATE_DISPLAY_DECIMALS } from '@/lib/format';
import { CHART_SERIES } from '@/lib/chart-colors';
import { createLogger } from '@/lib/logger';
import { useTranslations } from 'next-intl';
import { resolvePdfColor } from '@/components/reports/resolve-pdf-color';

const logger = createLogger('CurrencyExposureReport');

// Holdings are keyed off the brokerage sub-account, so offer those (the
// sibling cash account is excluded from the picker).
type CurrencyExposureSortField = 'currency' | 'nativeValue' | 'rate' | 'convertedValue' | 'percentage' | 'count';

const CURRENCY_COLOURS: Record<string, string> = {
  CAD: CHART_SERIES[0],
  USD: CHART_SERIES[1],
  EUR: CHART_SERIES[2],
  GBP: CHART_SERIES[3],
  JPY: CHART_SERIES[4],
  CHF: CHART_SERIES[5],
  AUD: CHART_SERIES[6],
  HKD: CHART_SERIES[7],
};

const FALLBACK_COLOURS = [CHART_SERIES[8], CHART_SERIES[9]];

/**
 * One column of the data table. The six are declared once, as a record over
 * the sort field union, and rendered by BOTH header rows -- the column header
 * row (from `sm` up) and the phone sort strip -- so the two can never list
 * different fields, and adding a member to the union fails `tsc` rather than
 * stranding a phone with no control for it.
 *
 * The record's declaration order IS the column order, so `value` lives here
 * beside the label: the PDF export builds its headings AND its row cells from
 * the same ordered list, and reordering the record moves both together.
 * Deriving only the headings would relabel the exported columns while leaving
 * the values in the old order -- a silently mislabelled export.
 */
interface SortColumn {
  field: CurrencyExposureSortField;
  label: string;
  /** The cell's text, rendered on screen and written to the PDF. */
  value: (item: CurrencyAllocation) => string;
  /** Money, rate, percent and count columns are right-aligned on desktop. */
  align?: 'right';
}

/**
 * The record the two header rows are built from, keyed by sort field.
 *
 * The key is tied to the entry's own `field`, which a plain
 * `Record<CurrencyExposureSortField, SortColumn>` does not do: that forces an
 * entry to EXIST for every member of the union but lets it name a different
 * one, so `rate: { field: 'nativeValue', label: colRate }` type-checks. Both
 * header rows would then render two controls keyed `nativeValue` (a duplicate
 * React key), tapping "Rate" would sort by Native Value, and "Rate" would be
 * unsortable -- and a test comparing header LABELS cannot see any of it,
 * because the labels stay right. Here it is a compile error instead.
 */
type SortColumnsByField = {
  [K in CurrencyExposureSortField]: SortColumn & { field: K };
};

// Today's header cell, unchanged.
const HEADER_CLASS =
  'px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider';

// The same sort controls in the phone strip: a wrapped row of compact chips.
// Column alignment means nothing there -- the column header row is hidden and
// each data row is a grid -- so every control is left-aligned and self-naming.
// The border and card background are what say "tappable": there is no hover on
// a touch screen, and without them the strip reads as another row of the
// captions the cells below carry.
const PHONE_HEADER_CLASS =
  'rounded border border-gray-200 bg-white px-2 py-1.5 text-xs font-medium text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400 uppercase';

// A figure cell inside a wrapped card: no padding of its own below `sm` (the
// row supplies it and the grid does the spacing), the table cell's own padding
// from `sm` up. Smaller type on phones. The colour stays on each cell, because
// the two money cells, the rate and the two counts are coloured differently.
//
// `whitespace-nowrap` is the one property here that is NOT phone-only, and it
// is one of exactly two respects in which the `sm`-and-up cell differs from
// today's: a locale that groups thousands with a space could otherwise break a
// figure in the middle of a number, at any width. It also holds the 6dp rate
// on one line, which is the rule this report cannot bend -- a rate is not
// money and is never rounded, truncated or clipped to fit.
//
// FIGURE_CELL width budget, measured on a hand-written CSS replica in Chromium
// at the insets this table really gets -- the report page's `px-4` and the
// row's own `px-4`, the card contributing none -- so 256px of track at 320px
// and 326px at 390px. The row is `[4rem minmax(0,1fr) minmax(0,1fr)]`: a
// fixed 64px first track for the bounded identity (a 12px dot and a
// three-letter code, about 50px), and two equal money tracks of 96px at 320px
// and 131px at 390px. Fixed rather than `auto` so the money columns start at
// the same x in every row -- an `auto` track sized per row by the rate
// caption in one and by "Total" in the footer would step them sideways.
//
// The formatter is the 2dp `formatCurrencyFull`, not the compact one the
// sibling reports use. The unit is part of the budget and is not always a
// symbol: `narrowSymbol` falls back to the three-letter ISO code where a
// currency has none, so the widest unit is `CHF`, and `123 456,78 CHF` is
// 97px at `text-xs` -- one pixel over the 96px track at 320px, and well
// inside 131px at 390px. The maintainer asked for the native and the
// converted value on one line after the phone review of this branch; the
// six-figure ISO-code case at 320px is the accepted edge, and it overflows
// past the track's end by a pixel rather than being cut.
//
// The budget is measured against the FOOTER's grand total, not a row value:
// the total is by construction larger than any row, and it is `font-bold`,
// which costs about 11px more than the same digits in a data cell. Bold at
// `text-xs`: `123 456,78 CHF` 107px, `1 219 326,04 CHF` 119px -- six figures
// pass the 96px track at 320px by 11px and seven by 23px; both fit the 131px
// track at 390px, and eight (128px) is the first to pass it. A portfolio
// whose total reaches six figures therefore opens the wrapper's sideways
// scroll at 320px, and eight figures open it at 390px.
//
// That is a deliberate choice rather than an oversight, because the
// alternatives are worse: right alignment is not a containment device (a
// nowrap figure longer than its track overflows past the END edge whatever
// `text-align` says), `overflow-hidden` would silently cut a figure or a rate,
// and dropping `whitespace-nowrap` would let a locale that groups thousands
// with a space break a number in half. A cut or broken figure is worse than a
// scroll -- and this is the only shape in which the scroll can come back.
const FIGURE_CELL =
  'p-0 text-right text-xs whitespace-nowrap sm:table-cell sm:px-4 sm:py-3 sm:text-sm';

/** Every caption in a wrapped cell is phone-only. */
const CAPTION_CLASS = 'sm:hidden';

interface CurrencyAllocation {
  currency: string;
  nativeValue: number;
  convertedValue: number;
  percentage: number;
  count: number;
  color: string;
  rate: number | null;
}

/**
 * The rate column's text, decided once for the cell and the PDF export alike.
 *
 * Three states, and they must stay distinguishable: the reporting currency
 * converts 1:1 BY DEFINITION, which is a known rate; a resolved rate prints at
 * `FX_RATE_DISPLAY_DECIMALS`, because a rate is not money and is never rounded
 * to four decimals; and a rate that could not be resolved is unknown, marked
 * `-` and never rendered as a measured 1.
 */
const rateDisplay = (item: CurrencyAllocation, defaultCurrency: string) =>
  item.currency === defaultCurrency
    ? (1).toFixed(FX_RATE_DISPLAY_DECIMALS)
    : item.rate !== null
      ? item.rate.toFixed(FX_RATE_DISPLAY_DECIMALS)
      : '-';

function CustomTooltip({ active, payload, formatCurrencyFull, defaultCurrency, labelNative, labelConverted }: {
  active?: boolean;
  payload?: Array<{ payload: CurrencyAllocation }>;
  formatCurrencyFull: (v: number, c?: string) => string;
  defaultCurrency: string;
  labelNative: string;
  labelConverted: string;
}) {
  const { formatPercent } = useNumberFormat();
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
      <p className="font-medium text-gray-900 dark:text-gray-100">{d.currency}</p>
      <p className="text-sm text-gray-600 dark:text-gray-400">
        {labelNative} {formatCurrencyFull(d.nativeValue, d.currency)}
      </p>
      <p className="text-sm text-gray-600 dark:text-gray-400">
        {labelConverted} {formatCurrencyFull(d.convertedValue, defaultCurrency)}
      </p>
      <p className="text-sm text-gray-500 dark:text-gray-400">
        {formatPercent(d.percentage, 1)} of portfolio ({d.count} holding{d.count !== 1 ? 's' : ''})
      </p>
    </div>
  );
}

const ACCOUNTS_STORAGE_KEY = 'monize-reports-currency-exposure-accounts';

export function CurrencyExposureReport() {
  const t = useTranslations('reports');
  const tCommon = useTranslations('common');
  const { formatCurrencyCompact: formatCurrency, formatCurrency: formatCurrencyFull, formatPercent } = useNumberFormat();
  const { defaultCurrency, convertToDefault, getRate } = useExchangeRates();
  const [accounts, setAccounts] = useState<Account[]>([]);
  // Persisted so the report opens on the accounts the user last chose.
  const [selectedAccountIds, setSelectedAccountIds] = usePersistedAccountFilter(
    ACCOUNTS_STORAGE_KEY,
    accounts,
  );
  const chartRef = useRef<HTMLDivElement>(null);
  const { sortField, sortDirection, handleSort } = useSortableTable<CurrencyExposureSortField>(
    'reports.currency-exposure.sort',
    { field: 'convertedValue', direction: 'desc' },
  );

  // Fetch accounts once on mount
  useEffect(() => {
    investmentsApi.getInvestmentAccounts()
      .then(setAccounts)
      .catch((error) => logger.error('Failed to load accounts:', error));
  }, []);

  const { data: response, isLoading, error, reload } = useReportData(
    () =>
      investmentsApi.getPortfolioSummary(
        selectedAccountIds.length > 0 ? selectedAccountIds : undefined,
      ),
    [selectedAccountIds],
  );

  // Only the first load shows the full skeleton. Later reloads (e.g. changing
  // the account filter) keep the existing content -- and the account dropdown --
  // mounted so they update in place instead of unmounting the whole report.
  const holdings = useMemo<HoldingWithMarketValue[]>(
    () => response?.holdings ?? [],
    [response],
  );

  const allocationData = useMemo((): CurrencyAllocation[] => {
    const currencyMap = new Map<string, { nativeValue: number; convertedValue: number; count: number }>();

    holdings.forEach((h) => {
      const currency = h.currencyCode;
      // Two unknowns to keep out of an exposure breakdown: a holding the server
      // could not price, and a currency with no rate into the display one. `?? 0`
      // used to fold the first in as a zero, which re-weighted every currency's
      // share of the portfolio.
      if (h.marketValue === null || h.marketValue === undefined) return;
      const nativeValue = h.marketValue;
      const convertedValue = convertToDefault(nativeValue, currency);
      if (convertedValue === null) return;

      const existing = currencyMap.get(currency) || { nativeValue: 0, convertedValue: 0, count: 0 };
      currencyMap.set(currency, {
        nativeValue: existing.nativeValue + nativeValue,
        convertedValue: existing.convertedValue + convertedValue,
        count: existing.count + 1,
      });
    });

    const totalConverted = Array.from(currencyMap.values()).reduce((sum, v) => sum + v.convertedValue, 0);
    let colorIndex = 0;

    return Array.from(currencyMap.entries())
      .map(([currency, data]) => ({
        currency,
        nativeValue: data.nativeValue,
        convertedValue: data.convertedValue,
        percentage: totalConverted > 0 ? (data.convertedValue / totalConverted) * 100 : 0,
        count: data.count,
        color: CURRENCY_COLOURS[currency] || FALLBACK_COLOURS[colorIndex++ % FALLBACK_COLOURS.length],
        rate: getRate(currency),
      }))
      .sort((a, b) => b.convertedValue - a.convertedValue);
  }, [holdings, convertToDefault, getRate]);

  const totalPortfolioValue = useMemo(
    () => allocationData.reduce((sum, a) => sum + a.convertedValue, 0),
    [allocationData],
  );

  // Holdings allocationData had to leave out (mirrors its exclusion rules): an
  // unpriced holding, and -- worse for an exposure report -- a currency with no
  // rate, which is an exposure the user has that simply cannot be shown. Tracked
  // so the total is marked and the excluded currencies are named.
  const exposureGaps = useMemo(() => {
    const missing = new Set<string>();
    let excludedCount = 0;
    for (const h of holdings) {
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
        case 'currency':
          comparison = compareValues(a.currency, b.currency);
          break;
        case 'nativeValue':
          comparison = compareValues(a.nativeValue, b.nativeValue);
          break;
        case 'rate':
          comparison = compareValues(a.rate, b.rate);
          break;
        case 'convertedValue':
          comparison = compareValues(a.convertedValue, b.convertedValue);
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

  const foreignCurrencyExposure = useMemo(
    () => allocationData.filter((a) => a.currency !== defaultCurrency).reduce((sum, a) => sum + a.convertedValue, 0),
    [allocationData, defaultCurrency],
  );

  // Exhaustive over the sort field union, so a new field is a compile error
  // rather than a column with no control in either header -- and each entry
  // must name its own key (see `SortColumnsByField`). Two of the labels take
  // `defaultCurrency` as an ICU argument, so the phone captions below pass the
  // same argument and read exactly as the column header does.
  const columns: SortColumnsByField = {
    currency: { field: 'currency', label: t('currencyExposure.colCurrency'), value: (item) => item.currency },
    nativeValue: { field: 'nativeValue', label: t('currencyExposure.colNativeValue'), align: 'right', value: (item) => formatCurrencyFull(item.nativeValue, item.currency) },
    rate: { field: 'rate', label: t('currencyExposure.colRate', { defaultCurrency }), align: 'right', value: (item) => rateDisplay(item, defaultCurrency) },
    convertedValue: { field: 'convertedValue', label: t('currencyExposure.colConvertedValue', { defaultCurrency }), align: 'right', value: (item) => formatCurrencyFull(item.convertedValue, defaultCurrency) },
    percentage: { field: 'percentage', label: t('currencyExposure.colPortfolioPct'), align: 'right', value: (item) => formatPercent(item.percentage, 1) },
    count: { field: 'count', label: t('currencyExposure.colHoldings'), align: 'right', value: (item) => String(item.count) },
  };

  // Their order, rendered by BOTH header rows and matched by the cells' DOM
  // order. DERIVED from the record rather than re-listed: a hand-written list
  // beside an exhaustive record is not exhaustive, so a field added to the
  // union would compile (the record forces an entry) and still ship with no
  // sort control in either header -- exactly the stranding the record exists to
  // prevent. The record's declaration order is the column order.
  const sortColumns: readonly SortColumn[] = Object.values(columns);

  // A column's 1-based position, derived from that same order rather than
  // written down a second time. The footer needs it (see its comment): below
  // `sm` it drops the two columns that have no total from the DOM entirely.
  const colIndexOf = (field: CurrencyExposureSortField) =>
    sortColumns.findIndex((col) => col.field === field) + 1;

  const handleExportPdf = async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    // The PDF's headings AND its row cells come from the same ordered record
    // the table renders, so the export cannot drift from the screen it exports
    // -- and reordering the record moves the two together. Each value function
    // is locale-aware (percentage through formatPercent, rate through
    // rateDisplay at FX_RATE_DISPLAY_DECIMALS), so the export matches the screen.
    const headers = sortColumns.map((col) => col.label);
    const rows = allocationData.map((item) => sortColumns.map((col) => col.value(item)));
    const accountLabel = selectedAccountIds.length > 0
      ? accounts.filter((a) => selectedAccountIds.includes(a.id)).map((a) => a.name).join(', ')
      : 'All Accounts';
    const legendItems = allocationData.map((item) => ({
      color: resolvePdfColor(item.color),
      label: `${item.currency} - ${formatCurrencyFull(item.convertedValue, defaultCurrency)} (${formatPercent(item.percentage, 1)})`,
    }));
    await exportToPdf({
      title: t('page.names.currency-exposure' as Parameters<typeof t>[0]),
      subtitle: accountLabel,
      chartContainer: chartRef.current,
      chartLegend: legendItems.length > 0 ? legendItems : undefined,
      tableData: { headers, rows },
      filename: 'currency-exposure',
    });
  };

  if (error) {
    return <ReportError onRetry={reload} />;
  }

  if (isLoading && response === null) {
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
          {t('currencyExposure.empty')}
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
            <RefreshPricesButton onRefreshComplete={reload} />
            <ExportDropdown onExportPdf={handleExportPdf} />
          </div>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 sm:gap-4">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-4">
          <p className="text-xs sm:text-sm text-gray-500 dark:text-gray-400">{t('currencyExposure.totalPortfolio')}</p>
          <p className="text-lg sm:text-xl font-bold text-gray-900 dark:text-gray-100">
            <PartialTotal
              total={{ value: totalPortfolioValue, missingCurrencies: exposureGaps.missingCurrencies, excludedCount: exposureGaps.excludedCount }}
              displayCurrency={defaultCurrency}
            >
              {formatCurrency(totalPortfolioValue, defaultCurrency)}
            </PartialTotal>
          </p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-4">
          <p className="text-xs sm:text-sm text-gray-500 dark:text-gray-400">{t('currencyExposure.currencies')}</p>
          <p className="text-lg sm:text-xl font-bold text-gray-900 dark:text-gray-100">
            {allocationData.length}
          </p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-4">
          <p className="text-xs sm:text-sm text-gray-500 dark:text-gray-400">{t('currencyExposure.homeCurrency', { defaultCurrency })}</p>
          <p className="text-lg sm:text-xl font-bold text-gray-900 dark:text-gray-100">
            {formatPercent(
              totalPortfolioValue > 0
                ? (1 - foreignCurrencyExposure / totalPortfolioValue) * 100
                : 0,
              1,
            )}
          </p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-4">
          <p className="text-xs sm:text-sm text-gray-500 dark:text-gray-400">{t('currencyExposure.foreignExposure')}</p>
          <p className="text-lg sm:text-xl font-bold text-gray-900 dark:text-gray-100">
            {formatCurrency(foreignCurrencyExposure, defaultCurrency)}
          </p>
        </div>
      </div>

      {exposureGaps.missingCurrencies.length > 0 && (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          {tCommon('partialTotal.explanation', {
            count: exposureGaps.excludedCount,
            displayCurrency: defaultCurrency,
            currencies: exposureGaps.missingCurrencies.join(', '),
          })}
        </p>
      )}

      {/* Pie Chart */}
      <div ref={chartRef} className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          {t('currencyExposure.currencyAllocation')}
        </h3>
        <div style={{ width: '100%', height: 350 }}>
          <ResponsiveContainer minWidth={0}>
            <PieChart>
              <Pie
                data={allocationData}
                dataKey="convertedValue"
                nameKey="currency"
                cx="50%"
                cy="50%"
                innerRadius={60}
                outerRadius={120}
                paddingAngle={2}
              >
                {allocationData.map((entry) => (
                  <Cell key={entry.currency} fill={entry.color} />
                ))}
              </Pie>
              <Tooltip content={<CustomTooltip formatCurrencyFull={formatCurrencyFull} defaultCurrency={defaultCurrency} labelNative={t('currencyExposure.tooltipNative')} labelConverted={t('currencyExposure.tooltipConverted')} />} />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Data Table

          Below `sm` the table becomes a block and each row wraps into a
          three-track grid so all six columns fit a phone without a horizontal
          scroll, on two lines: the currency, its native value and its value in
          the reporting currency -- the figure the row is read for -- share
          line 1; the rate, the portfolio share and the holdings count share
          line 2, each under the cell it relates to (the rate under the
          currency it prices, the share under the native value, the count
          under the converted value). Two lines rather than three is the
          maintainer's call from the phone review of this branch, made against
          the measurement `FIGURE_CELL` records: the identity is bounded, so it
          takes a fixed 64px track and the two money tracks keep 96px at 320px
          -- one pixel short of a six-figure ISO-code amount there, and enough
          for every symbol currency. Nothing is dropped -- the card carries all six columns --
          and the row stays what it is today: hovering, but NOT clickable. From
          `sm` up it is the ordinary table. The sort controls survive as their
          own phone-only header row, because the column header row that carries
          them on desktop is hidden there.

          Measured before and after on a hand-written CSS replica in Chromium,
          at this table's real insets (the report page's `px-4`; the card adds
          none of its own): today the table is 743px wide in `pl` and 794px in
          the pseudo-locale, inside a 288px wrapper at 320px and a 358px one at
          390px -- a sideways scroll in every locale at both widths. Wrapped,
          the wrapper's `scrollWidth` equals its `clientWidth` at both widths in
          `pl`, `ru`, `id`, `de` and `xx`, with no cell overflowing its track.

          Two properties of restyling one tree, both deliberate. Changing the
          `display` would drop the implicit table semantics below `sm`, so the
          explicit ARIA roles below put them back -- the phone sort strip is the
          header row a phone reader gets, and its six controls sit in the data
          cells' own DOM order, so the column association survives there. (The
          footer row is the one place it would not: it drops two cells from the
          DOM below `sm`, and states an `aria-colindex` on each of its own --
          see its comment.) The `CellLabel` captions are therefore REDUNDANT
          with that association rather than a substitute for it, and
          deliberately so: the grid places the cells out of DOM order visually,
          so a sighted phone reader has no header row to look up and needs the
          name beside the value.

          The second is an ACCEPTED, UNMITIGATED trade-off, and the roles are
          not what answers it: they restore the table semantics, and have no
          effect on reading order. The DOM keeps the desktop column order
          (currency, native value, rate, converted value, share, holdings)
          while the grid shows the converted value third and the rate fourth,
          so a screen-reader user hears the headline figure fourth -- the WCAG 1.3.2 tension
          mechanism A carries. What limits the cost is the captions: every
          value names its own column, so each one is self-describing in
          whatever order it is heard. Both are properties of the mechanism, not
          of this table. */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
        <div className="overflow-x-auto">
          {/* Explicit roles: restyling `display` below `sm` strips the implicit
              table semantics, and these put them back (inert from `sm` up). */}
          <table role="table" className="block min-w-full divide-y divide-gray-200 dark:divide-gray-700 sm:table">
            <thead role="rowgroup" className="block bg-gray-50 dark:bg-gray-900/50 sm:table-header-group">
              {/* Phone sort strip: the same six controls, wrapped. */}
              <tr role="row" className="flex flex-wrap gap-x-2 gap-y-1 px-2 py-2 sm:hidden">
                {sortColumns.map((col) => (
                  <SortableHeader<CurrencyExposureSortField>
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
                  <SortableHeader<CurrencyExposureSortField>
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
                <tr
                  key={item.currency}
                  role="row"
                  className="grid grid-cols-[4rem_minmax(0,1fr)_minmax(0,1fr)] items-start gap-x-3 gap-y-1.5 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-700/50 sm:table-row sm:p-0"
                >
                  {/* The identity, and the one BOUNDED one in the report: a
                      colour dot and a three-letter ISO code, 60px at its
                      widest. It needs no floor, no clamp and no `title` -- the
                      rules those answer are for an unbounded name -- so the
                      inner markup is exactly today's. Measured rendered track:
                      122px at 320px and 157px at 390px. */}
                  <td role="cell" className="col-start-1 row-start-1 p-0 text-sm font-medium text-gray-900 dark:text-gray-100 sm:table-cell sm:px-4 sm:py-3">
                    <div className="flex items-center gap-2">
                      <div
                        className="w-3 h-3 rounded-full flex-shrink-0"
                        style={{ backgroundColor: item.color }}
                      />
                      {columns.currency.value(item)}
                    </div>
                  </td>
                  <td role="cell" className={`col-start-2 row-start-1 text-gray-600 dark:text-gray-400 ${FIGURE_CELL}`}>
                    <CellLabel className={CAPTION_CLASS}>{columns.nativeValue.label}</CellLabel>
                    {columns.nativeValue.value(item)}
                  </td>
                  {/* The rate is not money: six decimals, never rounded and
                      never clipped, so it keeps `whitespace-nowrap` like the
                      figures. It sits under the currency it prices, in the
                      fixed 64px identity track (`1.234567` is about 48px at
                      `text-xs`), left-aligned there so it lines up under the
                      code rather than ragged-right against it; from `sm` up
                      it is the right-aligned column cell it is today. `-` is
                      the marker for a rate that could not be resolved, and
                      stays exactly that -- an unknown rate is not a measured
                      1. The decision is `rateDisplay`, shared with the PDF
                      export. */}
                  <td role="cell" className={`col-start-1 row-start-2 max-sm:text-left text-gray-500 dark:text-gray-400 ${FIGURE_CELL}`}>
                    <CellLabel className={CAPTION_CLASS}>{columns.rate.label}</CellLabel>
                    {columns.rate.value(item)}
                  </td>
                  {/* The value in the reporting currency is the headline: it
                      takes the right of line 1, beside the native value it
                      converts, because it is what the row is read for. */}
                  <td role="cell" className={`col-start-3 row-start-1 font-medium text-gray-900 dark:text-gray-100 ${FIGURE_CELL}`}>
                    <CellLabel className={CAPTION_CLASS}>{columns.convertedValue.label}</CellLabel>
                    {columns.convertedValue.value(item)}
                  </td>
                  {/* Both remaining values are bounded (`100.0%` and a holdings
                      count), but their CAPTIONS are not -- `[XX-% of
                      Portfolio-XX]` is 22 characters -- so they take the two
                      money tracks on line 2, under the native and converted
                      values, rather than an `auto` pair sized by its captions.
                      Captions wrap; values never do. */}
                  <td role="cell" className={`col-start-2 row-start-2 text-gray-600 dark:text-gray-400 ${FIGURE_CELL}`}>
                    <CellLabel className={CAPTION_CLASS}>{columns.percentage.label}</CellLabel>
                    {columns.percentage.value(item)}
                  </td>
                  <td role="cell" className={`col-start-3 row-start-2 text-gray-600 dark:text-gray-400 ${FIGURE_CELL}`}>
                    <CellLabel className={CAPTION_CLASS}>{columns.count.label}</CellLabel>
                    {columns.count.value(item)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot role="rowgroup" className="block bg-gray-50 dark:bg-gray-900/50 sm:table-footer-group">
              {/* The totals are the largest figures on the table, so this row
                  wraps exactly the way a data row does -- the same three tracks
                  and the same placement, each figure captioned -- with "Total"
                  standing in for the currency in the identity track. The
                  native value and the rate have no total, so their two blank
                  cells are `hidden` below `sm` and claim no grid slot; the
                  placement stays the data row's verbatim anyway, so a reader
                  finds each total in the column and on the line the rows
                  above put it. From `sm` up the blanks are the same empty
                  table cells as today.

                  Because those two cells leave the DOM below `sm`, this row
                  exposes four cells where the header exposes six columns, and
                  a screen reader placing a cell by its position would announce
                  the grand total under "Native Value". So every cell here
                  states its own `aria-colindex` -- which is exactly the case
                  the attribute exists for, a row whose columns are not all
                  present -- taken from the column record's order rather than
                  written down again. It is correct and inert from `sm` up,
                  where all six are present. */}
              <tr role="row" className="grid grid-cols-[4rem_minmax(0,1fr)_minmax(0,1fr)] items-start gap-x-3 gap-y-1.5 px-4 py-3 sm:table-row sm:p-0">
                <td role="cell" aria-colindex={colIndexOf('currency')} className="col-start-1 row-start-1 p-0 text-sm font-bold text-gray-900 dark:text-gray-100 sm:table-cell sm:px-4 sm:py-3">
                  {t('currencyExposure.total')}
                </td>
                <td role="cell" aria-colindex={colIndexOf('nativeValue')} className="hidden sm:table-cell" />
                <td role="cell" aria-colindex={colIndexOf('rate')} className="hidden sm:table-cell" />
                <td role="cell" aria-colindex={colIndexOf('convertedValue')} className={`col-start-3 row-start-1 font-bold text-gray-900 dark:text-gray-100 ${FIGURE_CELL}`}>
                  <CellLabel className={CAPTION_CLASS}>{columns.convertedValue.label}</CellLabel>
                  {formatCurrencyFull(totalPortfolioValue, defaultCurrency)}
                </td>
                <td role="cell" aria-colindex={colIndexOf('percentage')} className={`col-start-2 row-start-2 font-bold text-gray-900 dark:text-gray-100 ${FIGURE_CELL}`}>
                  <CellLabel className={CAPTION_CLASS}>{columns.percentage.label}</CellLabel>
                  100%
                </td>
                <td role="cell" aria-colindex={colIndexOf('count')} className={`col-start-3 row-start-2 font-bold text-gray-900 dark:text-gray-100 ${FIGURE_CELL}`}>
                  <CellLabel className={CAPTION_CLASS}>{columns.count.label}</CellLabel>
                  {allocationData.reduce((sum, a) => sum + a.count, 0)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  );
}
