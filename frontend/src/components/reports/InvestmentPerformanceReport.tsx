'use client';

import { useState, useMemo, useRef } from 'react';
import { Skeleton } from '@/components/ui/LoadingSkeleton';
import {
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
} from 'recharts';
import { investmentsApi } from '@/lib/investments';
import { PortfolioSummary } from '@/types/investment';
import { Account } from '@/types/account';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { CHART_COLOURS } from '@/lib/chart-colours';
import { gainLossColor } from '@/lib/format';
import { ReportToolbarActions } from '@/components/reports/ReportToolbarActions';
import { ReportAccountMultiSelect } from '@/components/reports/ReportAccountMultiSelect';
import { SecurityComparisonChart, SecurityComparisonChartHandle } from '@/components/reports/SecurityComparisonChart';
import { DateRangeSelector } from '@/components/ui/DateRangeSelector';
import { useDateRange } from '@/hooks/useDateRange';
import { usePortfolioRangeWindow } from '@/hooks/usePortfolioRangeWindow';
import { PORTFOLIO_CHART_RANGES } from '@/components/investments/portfolio-range-window';
import { previousCalendarDay } from '@/components/investments/portfolio-change-baseline';
import { withheldPeriodCause } from '@/components/investments/portfolio-period-result';
import { usePortfolioPeriodResult } from '@/hooks/usePortfolioPeriodResult';
import { useSecurityPeriodResults } from '@/hooks/useSecurityPeriodResults';
import { useDateFormat } from '@/hooks/useDateFormat';
import { type SortColumn, type SortColumnsByField } from '@/components/ui/Table';
import { useSortableTable } from '@/hooks/useSortableTable';
import { useReportData } from '@/hooks/useReportData';
import { usePersistedAccountFilter } from '@/hooks/usePersistedAccountFilter';
import { ReportError } from '@/components/reports/ReportError';
import { aggregateHoldingsBySecurity } from '@/lib/aggregate-holdings';
import { useTranslations } from 'next-intl';
import { useMainAccountName } from '@/hooks/useMainAccountName';
import { PartialTotal } from '@/components/ui/PartialTotal';
import { usePartialTotalNote } from '@/hooks/usePartialTotalNote';
import {
  partialTotalFor,
  portfolioPartialTotal,
  type PortfolioCompleteness,
} from '@/lib/net-worth-completeness';
import { EmptyState } from '@/components/ui/EmptyState';
import { SEGMENTED_GROUP_CLASS, segmentClass } from '@/components/ui/segmented-control';
import { InvestmentPerformanceHoldingsTable } from '@/components/reports/InvestmentPerformanceHoldingsTable';
import {
  buildPerformanceRows,
  sortPerformanceRows,
  type HoldingsSortField,
} from '@/components/reports/investment-performance-rows';

const ACCOUNTS_STORAGE_KEY = 'monize-reports-investment-performance-accounts';

// The comparison endpoint caps `securityIds` at 20 (`@ArrayMaxSize(20)` on
// `PerformanceComparisonQueryDto`): sending more returns 400 and the whole chart
// falls into its error state. A portfolio of 21+ securities plots only its 20
// largest holdings by market value, and a note says so.
const PERFORMANCE_CHART_MAX_SECURITIES = 20;

interface AllocationTooltipProps {
  active?: boolean;
  payload?: Array<{ payload: { name: string; value: number; percentage: number } }>;
  formatCurrencyFull: (value: number) => string;
  formatPlainPercent: (value: number, decimals?: number) => string;
}

function AllocationTooltip({ active, payload, formatCurrencyFull, formatPlainPercent }: AllocationTooltipProps) {
  if (active && payload && payload.length) {
    const data = payload[0].payload;
    return (
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
        <p className="font-medium text-gray-900 dark:text-gray-100">{data.name}</p>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          {formatCurrencyFull(data.value)} ({formatPlainPercent(data.percentage, 1)})
        </p>
      </div>
    );
  }
  return null;
}

export function InvestmentPerformanceReport() {
  const t = useTranslations('reports');
  const ti = useTranslations('investments');
  const { formatDate } = useDateFormat();
  const mainAccountName = useMainAccountName();
  const {
    formatCurrency: formatCurrencyFull,
    formatPercent: formatPlainPercent,
    formatShareQuantity,
    formatSignedPercent,
  } = useNumberFormat();
  const { defaultCurrency } = useExchangeRates();
  const chartRef = useRef<HTMLDivElement>(null);
  // The comparison chart owns its own fetched series, colours and chart DOM, so
  // its PDF export is delegated to this handle (matching SecurityPerformanceReport).
  const comparisonExportRef = useRef<SecurityComparisonChartHandle>(null);
  // Whether that chart (its own request) holds the current selection's answer.
  const [comparisonExportable, setComparisonExportable] = useState(false);
  // Persisted so the report opens on the accounts the user last chose.
  // Accounts arrive with the data below, so stale IDs are pruned there.
  const [selectedAccountIds, setSelectedAccountIds, pruneAccountFilter] =
    usePersistedAccountFilter(ACCOUNTS_STORAGE_KEY);
  const [reloadKey, setReloadKey] = useState(0);
  const [viewType, setViewType] = useState<'performance' | 'allocation'>('performance');
  // The report's window, persisted like the other report ranges. It governs
  // the chart, the Gain/Loss and Return cards and the table's period columns,
  // so it is shown in both views. The ranges and the days each one opens on
  // are the Investments page's (`usePortfolioRangeWindow`), so the same
  // caption names the same window on both screens
  // (`docs/specs/investment-performance-report-period.md`).
  const { dateRange: perfRange, setDateRange: setPerfRange, resolvedRange: perfResolvedRange } =
    useDateRange({
      defaultRange: '1y',
      storageKey: 'reports.investment-performance.range',
    });
  const perfWindow = usePortfolioRangeWindow({ range: perfRange, base: perfResolvedRange });
  // The window's figures are a day's move for 1D, from the prior close; the
  // series a value chart falls back to is widened to a week, which a return
  // line would rebase a week earlier than the column beside it. The chart is
  // drawn over the same two closes instead.
  const chartStart = perfRange === '1d' ? previousCalendarDay(perfWindow.end) : perfWindow.start;
  const isSingleAccount = selectedAccountIds.length === 1;
  const { sortField, sortDirection, handleSort } = useSortableTable<HoldingsSortField>(
    'reports.investment-performance.holdings.sort',
    { field: 'marketValue', direction: 'desc' },
  );

  const columns: SortColumnsByField<
    HoldingsSortField,
    SortColumn<HoldingsSortField>
  > = {
    symbol: { field: 'symbol', label: t('investmentPerformance.colSecurity') },
    quantity: { field: 'quantity', label: t('investmentPerformance.colShares'), align: 'right' },
    averageCost: { field: 'averageCost', label: t('investmentPerformance.colAvgCost'), align: 'right' },
    currentPrice: { field: 'currentPrice', label: t('investmentPerformance.colCurrentPrice'), align: 'right' },
    marketValue: { field: 'marketValue', label: t('investmentPerformance.colMarketValue'), align: 'right' },
    gainLoss: { field: 'gainLoss', label: t('investmentPerformance.colGainLoss'), align: 'right' },
    gainLossPercent: { field: 'gainLossPercent', label: t('investmentPerformance.colReturn'), align: 'right' },
    priceChangePercent: { field: 'priceChangePercent', label: t('investmentPerformance.colPriceChange'), align: 'right' },
  };

  const { data: response, isLoading, error, reload } = useReportData(
    async () => {
      const [portfolioData, accountsData] = await Promise.all([
        investmentsApi.getPortfolioSummary(selectedAccountIds.length > 0 ? selectedAccountIds : undefined),
        investmentsApi.getInvestmentAccounts(),
      ]);
      return { portfolio: portfolioData, accounts: accountsData };
    },
    [selectedAccountIds, reloadKey],
  );

  const portfolio = useMemo<PortfolioSummary | null>(
    () => response?.portfolio ?? null,
    [response],
  );
  const accounts = useMemo<Account[]>(() => response?.accounts ?? [], [response]);
  // Accounts load alongside the portfolio, so the persisted filter can only be
  // pruned of deleted accounts here, once the list is known.
  pruneAccountFilter(accounts);

  const formatPercent = (value: number) => formatSignedPercent(value);

  // When a single account is selected, show summary values in that account's native currency
  // (per-account totals are in native currency; top-level totals are converted to default)
  const selectedAccount = isSingleAccount
    ? accounts.find((a) => a.id === selectedAccountIds[0])
    : undefined;
  const summaryCurrency = selectedAccount?.currencyCode || defaultCurrency;
  const isForeignSummary = summaryCurrency !== defaultCurrency;

  // The window's figures, asked exactly as the Investments page asks: the same
  // accounts, and one account's own currency when one is selected. Nothing is
  // asked until the accounts are known, or a single account's request would
  // first go out in the wrong currency.
  const periodRequest = {
    range: perfRange,
    startDate: perfWindow.start,
    periodStartDate: perfWindow.periodStart,
    endDate: perfWindow.end,
    accountIds: selectedAccountIds.length > 0 ? selectedAccountIds.join(',') : undefined,
    displayCurrency: selectedAccount?.currencyCode,
    reloadKey,
    skip: response === null,
  };
  // The cards: the Investments page's own figure for the window.
  const { periodResult, failed: periodFailed } = usePortfolioPeriodResult({
    ...periodRequest,
    hasSeries: true,
  });
  // The rows: the same figure split by security.
  const securityPeriod = useSecurityPeriodResults(periodRequest);

  // Derive native-currency summary from holdingsByAccount when a single account is selected
  const summaryValues = useMemo(() => {
    if (!portfolio) return null;
    if (isSingleAccount && portfolio.holdingsByAccount.length > 0) {
      // Use per-account totals (native currency) instead of converted top-level totals
      let totalMarketValue = 0;
      let totalCashBalance = 0;
      let totalCostBasis = 0;
      let unpricedHoldingsCount = 0;
      for (const acct of portfolio.holdingsByAccount) {
        totalMarketValue += acct.totalMarketValue;
        totalCashBalance += acct.cashBalance;
        totalCostBasis += acct.totalCostBasis;
        unpricedHoldingsCount += acct.unpricedHoldingsCount ?? 0;
      }
      const totalPortfolioValue = totalMarketValue + totalCashBalance;
      // Completeness from the SAME accounts that supplied the figures: their
      // totals are in the account's own currency, a different conversion from
      // the summary's.
      const completeness: PortfolioCompleteness = {
        valuationComplete: portfolio.holdingsByAccount.every((a) => a.valuationComplete !== false),
        fxComplete: portfolio.holdingsByAccount.every((a) => a.fxComplete !== false),
        pricesComplete: portfolio.holdingsByAccount.every((a) => a.pricesComplete !== false),
        missingRatePairs: [...new Set(portfolio.holdingsByAccount.flatMap((a) => a.missingRatePairs ?? []))],
        unpricedHoldingsCount,
      };
      return { totalPortfolioValue, totalCostBasis, completeness };
    }
    // All accounts: use the backend-converted totals (already in default currency)
    return {
      totalPortfolioValue: portfolio.totalPortfolioValue,
      totalCostBasis: portfolio.totalCostBasis,
      completeness: portfolio as PortfolioCompleteness,
    };
  }, [portfolio, isSingleAccount]);

  const { noteFor } = usePartialTotalNote();
  // The value leaves out what could not be priced or converted; the cost basis
  // counts every holding and is short only of a cost with no rate.
  const valuePartial = summaryValues
    ? portfolioPartialTotal(summaryValues.totalPortfolioValue, summaryValues.completeness)
    : null;
  const costPartial = summaryValues
    ? partialTotalFor(
        summaryValues.totalCostBasis,
        summaryValues.completeness.fxComplete,
        summaryValues.completeness.missingRatePairs,
      )
    : null;

  const fmtSummary = (value: number) => {
    if (isForeignSummary) {
      return `${formatCurrencyFull(value, summaryCurrency)} ${summaryCurrency}`;
    }
    return formatCurrencyFull(value);
  };

  // The window's gain and return, as the Investments page's "Portfolio
  // performance" card prints them. Withheld is "N/A" with its cause, never a
  // zero and never the all-time figure in its place.
  const periodPnl = periodResult?.investmentPnl ?? null;
  const periodReturn = periodResult?.investmentReturnPercent ?? null;
  const periodCause =
    periodResult && periodPnl === null
      ? withheldPeriodCause([periodResult.investedReasons ?? []])
      : null;
  const periodNote = periodFailed
    ? t('investmentPerformance.periodLoadFailed')
    : periodCause
      ? ti(`portfolioPerformance.reasons.${periodCause}` as Parameters<typeof ti>[0])
      : undefined;
  const measuredFrom = periodResult?.startPriceDate
    ? t('investmentPerformance.measuredFromClose', { date: formatDate(periodResult.startPriceDate) })
    : undefined;
  const fmtPeriod = (value: number) => {
    const currency = periodResult?.currency ?? summaryCurrency;
    const amount = `${value >= 0 ? '+' : ''}${formatCurrencyFull(value, currency)}`;
    return currency !== defaultCurrency ? `${amount} ${currency}` : amount;
  };

  const fmtHolding = (value: number | null, currencyCode: string) => {
    if (value === null) return t('investmentPerformance.na');
    if (currencyCode && currencyCode !== defaultCurrency) {
      return `${formatCurrencyFull(value, currencyCode)} ${currencyCode}`;
    }
    return formatCurrencyFull(value);
  };

  const accountNameById = useMemo(() => {
    const map = new Map<string, string>();
    accounts.forEach((a) => map.set(a.id, mainAccountName(a.name)));
    return map;
  }, [accounts, mainAccountName]);

  // Today's holdings beside the window's figures, plus every position the
  // window measured that has since been sold.
  const holdingRows = useMemo(
    () =>
      portfolio
        ? sortPerformanceRows(
            buildPerformanceRows(portfolio.holdings, securityPeriod.results),
            sortField,
            sortDirection,
          )
        : [],
    [portfolio, securityPeriod.results, sortField, sortDirection],
  );

  const allocationData = useMemo(() => {
    if (!portfolio) return [];
    return portfolio.allocation.map((item, index) => ({
      ...item,
      color: item.color || CHART_COLOURS[index % CHART_COLOURS.length],
    }));
  }, [portfolio]);

  // Every distinct security the selected accounts currently hold. Deduped so a
  // security held in two accounts is one line, not two identical ones, and in a
  // stable order (holdings order) independent of the table's user-chosen sort.
  // `getPortfolioSummary` is already fetched with `selectedAccountIds`, so this
  // is the selected scope's holdings -- the account filter reaches the chart
  // through the data, not a second request key.
  const heldSecurityIds = useMemo(() => {
    if (!portfolio) return [];
    return [...new Set(portfolio.holdings.map((h) => h.securityId))];
  }, [portfolio]);

  // The securities actually plotted: capped at the backend's 20 so a 21+
  // security portfolio does not 400 the whole chart. When capped, the survivors
  // are the 20 largest holdings by market value (aggregated across accounts, so
  // a security split over two accounts is weighed by its combined value), kept
  // in the same stable order as `heldSecurityIds`.
  const performanceSecurityIds = useMemo(() => {
    if (heldSecurityIds.length <= PERFORMANCE_CHART_MAX_SECURITIES) {
      return heldSecurityIds;
    }
    const topIds = new Set(
      [...aggregateHoldingsBySecurity(portfolio!.holdings)]
        .sort((a, b) => (b.marketValue ?? 0) - (a.marketValue ?? 0))
        .slice(0, PERFORMANCE_CHART_MAX_SECURITIES)
        .map((h) => h.securityId),
    );
    return heldSecurityIds.filter((id) => topIds.has(id));
  }, [heldSecurityIds, portfolio]);

  // True when more securities are held than the chart can plot, so the note
  // telling the reader only the largest are shown renders.
  const isPerformanceChartCapped =
    heldSecurityIds.length > performanceSecurityIds.length;

  const fmtSecurityPeriod = (value: number) => {
    const currency = securityPeriod.results?.currency ?? defaultCurrency;
    const amount = `${value >= 0 ? '+' : ''}${formatCurrencyFull(value, currency)}`;
    return currency !== defaultCurrency ? `${amount} ${currency}` : amount;
  };

  const handleExportPdf = async () => {
    // The Performance view plots percent return with the chart's own colours and
    // series legend; only the chart handle can draw that legend correctly, so it
    // owns the export (the report's holdings-value legend would match nothing).
    if (viewType === 'performance') {
      await comparisonExportRef.current?.exportPdf();
      return;
    }

    const { exportToPdf } = await import('@/lib/pdf-export');

    const cards = summaryValues ? [
      { label: t('investmentPerformance.totalValue'), value: fmtSummary(summaryValues.totalPortfolioValue), color: '#111827', note: valuePartial ? noteFor(valuePartial) : undefined },
      { label: t('investmentPerformance.costBasis'), value: fmtSummary(summaryValues.totalCostBasis), color: '#111827', note: costPartial ? noteFor(costPartial) : undefined },
      { label: t('investmentPerformance.periodGainLoss'), value: periodPnl === null ? t('investmentPerformance.na') : fmtPeriod(periodPnl), color: periodPnl === null ? '#6b7280' : periodPnl >= 0 ? '#16a34a' : '#dc2626', note: periodNote ?? measuredFrom },
      { label: t('investmentPerformance.return'), value: periodReturn === null ? t('investmentPerformance.na') : formatPercent(periodReturn), color: periodReturn === null ? '#6b7280' : periodReturn >= 0 ? '#16a34a' : '#dc2626', note: periodNote ?? measuredFrom },
    ] : undefined;

    const headers = Object.values(columns).map((column) => column.label);
    const na = t('investmentPerformance.na');
    const periodPercent = (value: number | null | undefined) =>
      value == null ? na : formatPercent(value);
    const rows = holdingRows.map((h) => [
      t('investmentPerformance.pdfSecurity', {
        symbol: h.symbol ?? t('investmentPerformance.unknownSecurity'),
        name: h.name ?? '',
      }),
      formatShareQuantity(h.quantity),
      fmtHolding(h.averageCost, h.currencyCode),
      fmtHolding(h.currentPrice, h.currencyCode),
      fmtHolding(h.marketValue, h.currencyCode),
      h.period?.investmentPnl == null ? na : fmtSecurityPeriod(h.period.investmentPnl),
      periodPercent(h.period?.investmentReturnPercent),
      periodPercent(h.period?.priceChangePercent),
    ]);

    // The Allocation donut's legend, from the same data the donut draws.
    const legendItems = allocationData.map((item) => ({
      color: item.color,
      label: `${item.name} - ${formatCurrencyFull(item.value)}`,
    }));

    await exportToPdf({
      title: t('investmentPerformance.pdfTitle'),
      summaryCards: cards,
      chartContainer: chartRef.current,
      chartLegend: legendItems.length > 0 ? legendItems : undefined,
      tableData: rows.length > 0 ? { headers, rows } : undefined,
      filename: 'investment-performance',
    });
  };

  if (error) {
    return <ReportError onRetry={reload} />;
  }

  if (isLoading && response === null) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        <div className="space-y-4">
          <Skeleton className="h-8 w-1/3" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }

  if (!portfolio || !summaryValues || portfolio.holdings.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        <EmptyState title={t('investmentPerformance.noHoldings')} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Portfolio Summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">{t('investmentPerformance.totalValue')}</div>
          <div className="text-xl font-bold text-gray-900 dark:text-gray-100">
            <PartialTotal total={valuePartial!} displayCurrency={summaryCurrency}>
              {fmtSummary(summaryValues.totalPortfolioValue)}
            </PartialTotal>
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">{t('investmentPerformance.costBasis')}</div>
          <div className="text-xl font-bold text-gray-900 dark:text-gray-100">
            <PartialTotal total={costPartial!} displayCurrency={summaryCurrency}>
              {fmtSummary(summaryValues.totalCostBasis)}
            </PartialTotal>
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4" data-testid="period-gain-card">
          <div className="text-sm text-gray-500 dark:text-gray-400">{t('investmentPerformance.periodGainLoss')}</div>
          <div className={`text-xl font-bold ${periodPnl === null ? 'text-gray-500 dark:text-gray-400' : gainLossColor(periodPnl)}`}>
            {periodResult === null && !periodFailed ? (
              <Skeleton className="h-7 w-24" />
            ) : periodPnl === null ? (
              t('investmentPerformance.na')
            ) : (
              fmtPeriod(periodPnl)
            )}
          </div>
          {(periodNote ?? measuredFrom) && (
            <div className={`text-xs ${periodNote ? 'text-amber-700 dark:text-amber-300' : 'text-gray-500 dark:text-gray-400'}`}>
              {periodNote ?? measuredFrom}
            </div>
          )}
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4" data-testid="period-return-card">
          <div className="text-sm text-gray-500 dark:text-gray-400">{t('investmentPerformance.return')}</div>
          <div className={`text-xl font-bold ${periodReturn === null ? 'text-gray-500 dark:text-gray-400' : gainLossColor(periodReturn)}`}>
            {periodResult === null && !periodFailed ? (
              <Skeleton className="h-7 w-20" />
            ) : periodReturn === null ? (
              t('investmentPerformance.na')
            ) : (
              formatPercent(periodReturn)
            )}
          </div>
          {(periodNote ?? measuredFrom) && (
            <div className={`text-xs ${periodNote ? 'text-amber-700 dark:text-amber-300' : 'text-gray-500 dark:text-gray-400'}`}>
              {periodNote ?? measuredFrom}
            </div>
          )}
        </div>
      </div>

      {/* Controls */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex flex-wrap gap-4 items-center justify-between">
          <div className="flex flex-wrap gap-2">
            <ReportAccountMultiSelect
              accounts={accounts}
              value={selectedAccountIds}
              onChange={setSelectedAccountIds}
            />
          </div>
          <div className={SEGMENTED_GROUP_CLASS} role="group" aria-label={t('reportPage.viewLabel')}>
            <button
              type="button"
              onClick={() => setViewType('performance')}
              aria-pressed={viewType === 'performance'}
              className={segmentClass(viewType === 'performance')}
            >
              {t('investmentPerformance.viewHoldings')}
            </button>
            <button
              type="button"
              onClick={() => setViewType('allocation')}
              aria-pressed={viewType === 'allocation'}
              className={segmentClass(viewType === 'allocation')}
            >
              {t('investmentPerformance.viewAllocation')}
            </button>
          </div>
        </div>
        {/* The chart's window and the export belong to the toolbar, not to the
            chart: the range selector used to sit loose above the chart, outside
            the card every other control is in, and the export shared a row it
            was pushed off the right of on a phone. Stacked below `sm`, so the
            export is a full-width line under the window it exports; one row
            from `sm` up, export at the trailing edge whether or not the
            allocation view has hidden the window. */}
        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <DateRangeSelector
            ranges={PORTFOLIO_CHART_RANGES}
            // Only `all` needs translating; the rest are locale-neutral
            // abbreviations `formatLabel` handles.
            labels={{ all: t('investmentPerformance.rangeAll') }}
            value={perfRange}
            onChange={setPerfRange}
            activeColour="bg-blue-600"
            size="sm"
          />
          <ReportToolbarActions
            onRefreshComplete={() => setReloadKey((k) => k + 1)}
            onExportPdf={handleExportPdf}
            // Both requests feed the export; the chart's only its own view.
            disabled={isLoading || !!error || (viewType === 'performance' && !comparisonExportable)}
          />
        </div>
      </div>

      <div ref={chartRef}>
      {viewType === 'performance' ? (
        <>
          {/* Historical performance: one cumulative-return line per held
              security over the selected window. Replaces the point-in-time
              holdings donut, which now lives under Allocation; the composition
              question and the "how have these performed" question are answered
              on their own tabs. The chart owns its own fetch, keyed on the held
              securities and the window, and renders the server's percent-return
              series with its null/exclusion handling intact. */}
          <SecurityComparisonChart
            securityIds={performanceSecurityIds}
            indexCodes={[]}
            startDate={chartStart}
            endDate={perfWindow.end}
            subtitle={t('investmentPerformance.chartSubtitle')}
            reloadKey={reloadKey}
            exportRef={comparisonExportRef}
            onExportableChange={setComparisonExportable}
          />
          {isPerformanceChartCapped && (
            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
              {t('investmentPerformance.chartLimitedNote', {
                shown: performanceSecurityIds.length,
                total: heldSecurityIds.length,
              })}
            </p>
          )}

          <InvestmentPerformanceHoldingsTable
            rows={holdingRows}
            columns={columns}
            sortField={sortField}
            sortDirection={sortDirection}
            onSort={handleSort}
            accountNameById={accountNameById}
            period={securityPeriod}
          />
        </>
      ) : (
        /* Asset Allocation View */
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 px-2 py-4 sm:p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
            {t('investmentPerformance.assetAllocation')}
          </h3>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="h-80">
              <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                <PieChart>
                  <Pie
                    data={allocationData}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={120}
                    paddingAngle={2}
                    dataKey="value"
                    nameKey="name"
                  >
                    {allocationData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip
                    content={
                      <AllocationTooltip
                        formatCurrencyFull={formatCurrencyFull}
                        formatPlainPercent={formatPlainPercent}
                      />
                    }
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="space-y-2">
              {allocationData.map((item, index) => (
                <div
                  key={index}
                  className="flex items-center justify-between p-3 rounded-lg bg-gray-50 dark:bg-gray-700/50"
                >
                  <div className="flex items-center gap-3">
                    <div
                      className="w-4 h-4 rounded"
                      style={{ backgroundColor: item.color }}
                    />
                    <div>
                      <div className="font-medium text-gray-900 dark:text-gray-100">
                        {item.name}
                      </div>
                      {item.symbol && (
                        <div className="text-sm text-gray-500 dark:text-gray-400">
                          {item.symbol}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-medium text-gray-900 dark:text-gray-100">
                      {formatCurrencyFull(item.value)}
                    </div>
                    <div className="text-sm text-gray-500 dark:text-gray-400">
                      {formatPlainPercent(item.percentage, 1)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      </div>
    </div>
  );
}
