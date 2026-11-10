'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { gainLossColor } from '@/lib/format';
import { Skeleton } from '@/components/ui/LoadingSkeleton';
import { useReportData } from '@/hooks/useReportData';
import { usePersistedAccountFilter } from '@/hooks/usePersistedAccountFilter';
import { ReportError } from '@/components/reports/ReportError';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { format } from 'date-fns';
import { chartColors } from '@/lib/chart-colors';
import { investmentsApi } from '@/lib/investments';
import { RealizedGainEntry } from '@/types/investment';
import { UnknownAmount } from '@/components/ui/UnknownAmount';
import { Account } from '@/types/account';
import { parseLocalDate } from '@/lib/utils';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { useDateRange } from '@/hooks/useDateRange';
import { DateRangeSelector } from '@/components/ui/DateRangeSelector';
import { ReportToolbarActions } from '@/components/reports/ReportToolbarActions';
import { ReportAccountMultiSelect } from '@/components/reports/ReportAccountMultiSelect';
import { exportToCsv } from '@/lib/csv-export';
import { SortableHeader } from '@/components/ui/SortableHeader';
import {
  CAPTION_CLASS,
  CellLabel,
  PHONE_HEADER_CLASS,
  type SortColumn,
  type SortColumnsByField,
} from '@/components/ui/Table';
import { useSortableTable, compareValues } from '@/hooks/useSortableTable';
import { useDateFormat } from '@/hooks/useDateFormat';
import { createLogger } from '@/lib/logger';
import { EmptyState } from '@/components/ui/EmptyState';
import { ChartViewToggle } from '@/components/ui/ChartViewToggle';
import { CHART_GRID_PROPS_HORIZONTAL_BARS, CHART_TOOLTIP_CLASS } from '@/lib/chart-style';

const logger = createLogger('RealizedGainsReport');

type SecurityGainsSortField = 'symbol' | 'transactionCount' | 'totalProceeds' | 'totalCostBasis' | 'realizedGain';
type SellTransactionsSortField = 'date' | 'symbol' | 'quantity' | 'price' | 'proceeds';

const HEADER_CLASS =
  'px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase';
const FIGURE_CELL =
  'p-0 text-right text-xs whitespace-nowrap sm:table-cell sm:px-4 sm:py-3 sm:text-sm';

function CustomTooltip({ active, payload, fmtValue }: {
  active?: boolean;
  payload?: Array<{ value: number; payload: { symbol: string } }>;
  fmtValue: (v: number) => string;
}) {
  if (!active || !payload?.length) return null;
  const data = payload[0];
  const value = data.value;
  return (
    <div className={CHART_TOOLTIP_CLASS}>
      <p className="font-medium text-gray-900 dark:text-gray-100">{data.payload.symbol}</p>
      <p className={`text-sm ${gainLossColor(value)}`}>
        {value >= 0 ? '+' : ''}{fmtValue(value)}
      </p>
    </div>
  );
}

interface SecurityGain {
  symbol: string;
  name: string;
  totalProceeds: number;
  totalCostBasis: number;
  realizedGain: number;
  transactionCount: number;
  /** Sales of unknown cost, left out of the figures above, which are then a subtotal. */
  unknownCount: number;
}

const ACCOUNTS_STORAGE_KEY = 'monize-reports-realized-gains-accounts';

export function RealizedGainsReport() {
  const t = useTranslations('reports');
  const tCommon = useTranslations('common');
  const {
    formatCurrency: formatCurrencyFull,
    formatCurrencyAxis,
    formatNumber,
    formatPercent,
    formatShareQuantity,
  } = useNumberFormat();
  const { formatDate } = useDateFormat();
  const { defaultCurrency } = useExchangeRates();
  const [accounts, setAccounts] = useState<Account[]>([]);
  // Persisted so the report opens on the accounts the user last chose.
  const [selectedAccountIds, setSelectedAccountIds] = usePersistedAccountFilter(
    ACCOUNTS_STORAGE_KEY,
    accounts,
  );
  const { dateRange, setDateRange, resolvedRange, isValid } = useDateRange({ defaultRange: '1y', alignment: 'month' });
  const [viewType, setViewType] = useState<'chart' | 'table'>('chart');
  const isSingleAccount = selectedAccountIds.length === 1;
  const securityGainsSort = useSortableTable<SecurityGainsSortField>(
    'reports.realized-gains.securities.sort',
    { field: 'realizedGain', direction: 'desc' },
  );
  const sellTransactionsSort = useSortableTable<SellTransactionsSortField>(
    'reports.realized-gains.sells.sort',
    { field: 'date', direction: 'desc' },
  );

  const securityGainColumns: SortColumnsByField<
    SecurityGainsSortField,
    SortColumn<SecurityGainsSortField>
  > = {
    symbol: { field: 'symbol', label: t('realizedGains.colSecurity') },
    transactionCount: { field: 'transactionCount', label: t('realizedGains.colTrades'), align: 'right' },
    totalProceeds: { field: 'totalProceeds', label: t('realizedGains.colProceeds'), align: 'right' },
    totalCostBasis: { field: 'totalCostBasis', label: t('realizedGains.colCostBasis'), align: 'right' },
    realizedGain: { field: 'realizedGain', label: t('realizedGains.colGainLoss'), align: 'right' },
  };
  const securityGainSortColumns = Object.values(securityGainColumns);

  const sellTransactionColumns: SortColumnsByField<
    SellTransactionsSortField,
    SortColumn<SellTransactionsSortField>
  > = {
    date: { field: 'date', label: t('realizedGains.colDate') },
    symbol: { field: 'symbol', label: t('realizedGains.colSecurity') },
    quantity: { field: 'quantity', label: t('realizedGains.colShares'), align: 'right' },
    price: { field: 'price', label: t('realizedGains.colPrice'), align: 'right' },
    proceeds: { field: 'proceeds', label: t('realizedGains.colProceeds'), align: 'right' },
  };
  const sellTransactionSortColumns = Object.values(sellTransactionColumns);

  const selectedAccount = isSingleAccount
    ? accounts.find((a) => a.id === selectedAccountIds[0])
    : undefined;
  const displayCurrency = selectedAccount?.currencyCode || defaultCurrency;
  const isForeign = displayCurrency !== defaultCurrency;

  // Backend returns each figure in the holding account's currency, and the
  // same disposal in the reporting currency (`inReportingCurrency`): the
  // proceeds at the sale's own rate and the basis at each purchase's. A single
  // account reads its native figures; All Accounts or several read the
  // reporting-currency ones, never both converted at today's rate (issue #2106).
  const toDisplay = useCallback(
    (entry: RealizedGainEntry, field: 'proceeds' | 'costBasis' | 'realizedGain'): number | null => {
      if (isSingleAccount) return entry[field];
      return entry.inReportingCurrency?.[field] ?? null;
    },
    [isSingleAccount],
  );

  const fmtValue = useCallback((value: number): string => {
    if (isForeign) {
      return `${formatCurrencyFull(value, displayCurrency)} ${displayCurrency}`;
    }
    return formatCurrencyFull(value);
  }, [isForeign, displayCurrency, formatCurrencyFull]);

  /**
   * A figure that is in the SECURITY's currency, not the account's: the unit
   * price and the commission on a realized-gain row are the raw transaction
   * values, while proceeds, basis and gain are converted into the holding
   * account's currency by the server.
   *
   * A null code renders unknown; the reader's currency is not the answer
   * (`docs/frontend/financial-figures.md`, issue #1394).
   */
  const fmtSecurityMoney = useCallback(
    (value: number, currencyCode: string | null): string => {
      if (!currencyCode) return tCommon('unknownAmount.marker');
      if (currencyCode === defaultCurrency) return formatCurrencyFull(value, currencyCode);
      return `${formatCurrencyFull(value, currencyCode)} ${currencyCode}`;
    },
    [formatCurrencyFull, defaultCurrency, tCommon],
  );

  // Fetch accounts once on mount
  useEffect(() => {
    investmentsApi.getInvestmentAccounts()
      .then(setAccounts)
      .catch((error) => logger.error('Failed to load accounts:', error));
  }, []);

  const { start: rangeStart, end: rangeEnd } = resolvedRange;

  // `reload` (a stable callback) is wired to the RefreshPricesButton so a
  // manual price refresh re-fetches.
  const { data: response, isLoading, error, reload } = useReportData(
    () =>
      isValid
        ? investmentsApi.getRealizedGains({
            accountIds: selectedAccountIds.length > 0 ? selectedAccountIds.join(',') : undefined,
            startDate: rangeStart || undefined,
            endDate: rangeEnd,
          })
        : Promise.resolve(null),
    [selectedAccountIds, rangeStart, rangeEnd, isValid],
  );

  const entries = useMemo<RealizedGainEntry[]>(() => response ?? [], [response]);

  const securityGains = useMemo((): SecurityGain[] => {
    const map = new Map<string, SecurityGain>();

    entries.forEach((entry) => {
      const symbol = entry.symbol || 'Unknown';
      const name = entry.securityName || 'Unknown Security';

      let bucket = map.get(symbol);
      if (!bucket) {
        bucket = {
          symbol,
          name,
          totalProceeds: 0,
          totalCostBasis: 0,
          realizedGain: 0,
          transactionCount: 0,
          unknownCount: 0,
        };
        map.set(symbol, bucket);
      }

      // Shares of unknown cost: the gain is unknown, never proceeds against 0.
      if (entry.costBasis === null || entry.realizedGain === null) {
        bucket.unknownCount += 1;
        return;
      }
      const proceeds = toDisplay(entry, 'proceeds');
      const costBasis = toDisplay(entry, 'costBasis');
      const realizedGain = toDisplay(entry, 'realizedGain');
      // A gain is proceeds minus basis: if either side cannot be converted the
      // gain is unknown, and adding the half that converted would report a
      // profit or loss that never happened.
      if (proceeds === null || costBasis === null || realizedGain === null) return;
      bucket.totalProceeds += proceeds;
      bucket.totalCostBasis += costBasis;
      bucket.realizedGain += realizedGain;
      bucket.transactionCount += 1;
    });

    return Array.from(map.values());
  }, [entries, toDisplay]);

  // Lots securityGains had to drop because a side could not be converted
  // (mirrors its exclusion rule), so the per-symbol and grand totals are
  // subtotals whenever this is non-empty.
  const gainsGaps = useMemo(() => {
    const missing = new Set<string>();
    let excludedCount = 0;
    for (const entry of entries) {
      if (entry.costBasis === null || entry.realizedGain === null) continue;
      const proceeds = toDisplay(entry, 'proceeds');
      const costBasis = toDisplay(entry, 'costBasis');
      const realizedGain = toDisplay(entry, 'realizedGain');
      if (proceeds === null || costBasis === null || realizedGain === null) {
        missing.add(entry.accountCurrencyCode || defaultCurrency);
        excludedCount += 1;
      }
    }
    return { missingCurrencies: [...missing], excludedCount };
  }, [entries, toDisplay, defaultCurrency]);

  const sortedSecurityGains = useMemo(() => {
    const sorted = [...securityGains];
    sorted.sort((a, b) => {
      let comparison = 0;
      switch (securityGainsSort.sortField) {
        case 'symbol':
          comparison = compareValues(a.symbol, b.symbol);
          break;
        case 'transactionCount':
          comparison = compareValues(a.transactionCount, b.transactionCount);
          break;
        case 'totalProceeds':
          comparison = compareValues(a.totalProceeds, b.totalProceeds);
          break;
        case 'totalCostBasis':
          comparison = compareValues(a.totalCostBasis, b.totalCostBasis);
          break;
        case 'realizedGain':
          comparison = compareValues(a.realizedGain, b.realizedGain);
          break;
      }
      return securityGainsSort.sortDirection === 'asc' ? comparison : -comparison;
    });
    return sorted;
  }, [securityGains, securityGainsSort.sortField, securityGainsSort.sortDirection]);

  const chartData = useMemo(() => {
    return securityGains
      .filter((sg) => sg.unknownCount === 0 && sg.realizedGain !== 0)
      .map((sg) => ({
        symbol: sg.symbol,
        gain: Math.round(sg.realizedGain * 100) / 100,
      }));
  }, [securityGains]);

  const totals = useMemo(() => {
    let totalProceeds = 0, totalCostBasis = 0, totalGain = 0, totalTransactions = 0, gainers = 0, losers = 0, unknownCount = 0;
    for (const sg of securityGains) {
      unknownCount += sg.unknownCount;
      totalProceeds += sg.totalProceeds;
      totalCostBasis += sg.totalCostBasis;
      totalGain += sg.realizedGain;
      totalTransactions += sg.transactionCount;
      if (sg.unknownCount > 0) continue;
      if (sg.realizedGain > 0) gainers++;
      else if (sg.realizedGain < 0) losers++;
    }
    return { totalProceeds, totalCostBasis, totalGain, totalTransactions, gainers, losers, unknownCount };
  }, [securityGains]);

  const sortedEntries = useMemo(() => {
    const sorted = [...entries];
    sorted.sort((a, b) => {
      let comparison = 0;
      switch (sellTransactionsSort.sortField) {
        case 'date':
          comparison = compareValues(a.transactionDate, b.transactionDate);
          break;
        case 'symbol':
          comparison = compareValues(a.symbol || '', b.symbol || '');
          break;
        case 'quantity':
          comparison = compareValues(a.quantity, b.quantity);
          break;
        // Unit prices are in each security's own currency, so they group by
        // currency before being compared: 100 EUR is not above 90 USD.
        case 'price':
          comparison =
            compareValues(a.securityCurrencyCode, b.securityCurrencyCode) ||
            compareValues(a.price, b.price);
          break;
        case 'proceeds':
          comparison = compareValues(
            toDisplay(a, 'proceeds'),
            toDisplay(b, 'proceeds'),
          );
          break;
      }
      return sellTransactionsSort.sortDirection === 'asc' ? comparison : -comparison;
    });
    return sorted;
  }, [entries, sellTransactionsSort.sortField, sellTransactionsSort.sortDirection, toDisplay]);

  const getExportData = useCallback(() => {
    const headers = [t('realizedGains.csvColSecurity'), t('realizedGains.csvColDateSold'), t('realizedGains.csvColQuantity'), t('realizedGains.csvColProceeds'), t('realizedGains.csvColCostBasis'), t('realizedGains.csvColGainLoss'), t('realizedGains.csvColReturn')];
    const rows: (string | number)[][] = sortedEntries.map((entry) => {
      const proceeds = toDisplay(entry, 'proceeds');
      const costBasis =
        entry.costBasis === null ? null : toDisplay(entry, 'costBasis');
      const gain =
        entry.realizedGain === null ? null : toDisplay(entry, 'realizedGain');
      const unknownCost = entry.costBasis === null || entry.realizedGain === null;
      // An export cell that cannot be converted says so; a spreadsheet reading a
      // blank or a native-currency figure in a display-currency column is worse
      // than one reading a marker.
      const unknown = unknownCost ? t('realizedGains.csvUnknownCost') : t('realizedGains.csvNoRate');
      const returnPct =
        costBasis !== null && gain !== null && costBasis !== 0
          ? formatPercent((gain / costBasis) * 100, 2)
          : '-';
      return [
        entry.symbol || 'N/A',
        format(parseLocalDate(entry.transactionDate), 'yyyy-MM-dd'),
        entry.quantity,
        proceeds ?? unknown,
        costBasis ?? unknown,
        gain ?? unknown,
        returnPct,
      ];
    });
    return { headers, rows };
  }, [sortedEntries, toDisplay, formatPercent, t]);

  const handleExportCsv = useCallback(() => {
    const { headers, rows } = getExportData();
    exportToCsv('realized-gains', headers, rows);
  }, [getExportData]);

  const handleExportPdf = useCallback(async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    const { headers, rows } = getExportData();
    const unknownGain = t('realizedGains.csvUnknownCost');
    const totalRow: (string | number)[] = [t('realizedGains.total'), '', '', totals.totalProceeds, totals.totalCostBasis, totals.unknownCount > 0 ? unknownGain : totals.totalGain, ''];
    await exportToPdf({
      title: t('realizedGains.pdfTitle'),
      subtitle: t('realizedGains.pdfSubtitle', { count: securityGains.length, gain: totals.unknownCount > 0 ? unknownGain : fmtValue(totals.totalGain) }),
      summaryCards: [
        { label: t('realizedGains.totalProceeds'), value: fmtValue(totals.totalProceeds), color: '#111827' },
        { label: t('realizedGains.costBasis'), value: fmtValue(totals.totalCostBasis), color: '#111827' },
        { label: t('realizedGains.realizedGainLoss'), value: totals.unknownCount > 0 ? unknownGain : `${totals.totalGain >= 0 ? '+' : ''}${fmtValue(totals.totalGain)}`, color: totals.unknownCount > 0 || totals.totalGain >= 0 ? '#16a34a' : '#dc2626' },
      ],
      tableData: { headers, rows, totalRow },
      filename: 'realized-gains',
    });
   
  }, [getExportData, securityGains.length, fmtValue, totals, t]);

  if (error) {
    return <ReportError onRetry={reload} />;
  }

  if (isLoading && !response) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        <div className="space-y-4">
          <Skeleton className="h-8 w-1/3" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">{t('realizedGains.totalProceeds')}</div>
          <div className="text-xl font-bold text-gray-900 dark:text-gray-100">
            {fmtValue(totals.totalProceeds)}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">{t('realizedGains.costBasis')}</div>
          <div className="text-xl font-bold text-gray-900 dark:text-gray-100">
            {fmtValue(totals.totalCostBasis)}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">{t('realizedGains.realizedGainLoss')}</div>
          {totals.unknownCount > 0 ? (
            <>
              <div className="text-xl font-bold text-gray-900 dark:text-gray-100">
                <UnknownAmount reasonText={t('realizedGains.unknownBasisReason')} />
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400">
                {t('realizedGains.knownPart', { amount: fmtValue(totals.totalGain) })}
              </div>
            </>
          ) : (
            <div className={`text-xl font-bold ${gainLossColor(totals.totalGain)}`}>
              {totals.totalGain >= 0 ? '+' : ''}{fmtValue(totals.totalGain)}
            </div>
          )}
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">{t('realizedGains.securitiesSold')}</div>
          <div className="text-xl font-bold text-gray-900 dark:text-gray-100">
            {securityGains.length}
            <span className="text-sm font-normal text-gray-500 dark:text-gray-400 ml-2">
              {totals.gainers > 0 && <span className="text-green-600 dark:text-green-400">{totals.gainers} gain</span>}
              {totals.gainers > 0 && totals.losers > 0 && ' / '}
              {totals.losers > 0 && <span className="text-red-600 dark:text-red-400">{totals.losers} loss</span>}
            </span>
          </div>
        </div>
      </div>

      {gainsGaps.missingCurrencies.length > 0 && (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          {tCommon('partialTotal.explanation', {
            count: gainsGaps.excludedCount,
            displayCurrency,
            currencies: gainsGaps.missingCurrencies.join(', '),
          })}
        </p>
      )}

      {totals.unknownCount > 0 && (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          {t('realizedGains.unknownCostNotice', { count: totals.unknownCount })}
        </p>
      )}

      {/* Controls */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex flex-wrap gap-3 items-center">
          {/* Full width on a phone, the toolbar's fixed width from `sm` up. */}
          <ReportAccountMultiSelect
            accounts={accounts}
            value={selectedAccountIds}
            onChange={setSelectedAccountIds}
            className="w-full sm:w-48"
          />
          <DateRangeSelector
            ranges={['6m', '1y', '2y', 'all']}
            value={dateRange}
            onChange={setDateRange}
          />
          {/* `ml-auto` only from `sm` up: on a phone every group is a row of
              its own, and pushing this one right left it hanging under two
              left-aligned rows. */}
          <ChartViewToggle
            value={viewType === 'chart' ? 'bar' : 'table'}
            onChange={(v) => setViewType(v === 'table' ? 'table' : 'chart')}
            options={['bar', 'table']}
            className="sm:ml-auto sm:shrink-0"
          />
          <ReportToolbarActions
            onRefreshComplete={reload}
            onExportCsv={handleExportCsv}
            onExportPdf={handleExportPdf}
            disabled={isLoading || !!error || entries.length === 0}
          />
        </div>
      </div>

      {entries.length === 0 ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <EmptyState title={t('realizedGains.noTransactions')} />
        </div>
      ) : viewType === 'chart' ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 px-2 py-4 sm:p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
            {t('realizedGains.bySecurityTitle')}
          </h3>
          {chartData.length === 0 ? (
            <EmptyState title={t('realizedGains.noGainsLosses')} />
          ) : (
            <div className="h-80">
              <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                <BarChart data={chartData} layout="vertical" margin={{ left: 0, right: 10 }}>
                  <CartesianGrid {...CHART_GRID_PROPS_HORIZONTAL_BARS} />
                  <XAxis type="number" tickFormatter={formatCurrencyAxis} />
                  <YAxis type="category" dataKey="symbol" width={60} tick={{ fontSize: 12 }} />
                  <Tooltip content={<CustomTooltip fmtValue={fmtValue} />} />
                  <Bar
                    dataKey="gain"
                    name={t('realizedGains.realizedGainLoss')}
                    fill={chartColors.income}
                    radius={[0, 4, 4, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      ) : (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {t('realizedGains.detailTitle')}
            </h3>
          </div>
          <div className="overflow-x-auto">
            <table role="table" className="block min-w-full divide-y divide-gray-200 dark:divide-gray-700 sm:table">
              <thead role="rowgroup" className="block bg-gray-50 dark:bg-gray-900/50 sm:table-header-group">
                <tr role="row" className="flex flex-wrap gap-x-2 gap-y-1 px-2 py-2 sm:hidden">
                  {securityGainSortColumns.map((column) => (
                    <SortableHeader<SecurityGainsSortField>
                      key={column.field}
                      field={column.field}
                      sortField={securityGainsSort.sortField}
                      sortDirection={securityGainsSort.sortDirection}
                      onSort={securityGainsSort.handleSort}
                      className={PHONE_HEADER_CLASS}
                    >
                      {column.label}
                    </SortableHeader>
                  ))}
                </tr>
                <tr role="row" className="hidden sm:table-row">
                  {securityGainSortColumns.map((column) => (
                    <SortableHeader<SecurityGainsSortField>
                      key={column.field}
                      field={column.field}
                      sortField={securityGainsSort.sortField}
                      sortDirection={securityGainsSort.sortDirection}
                      onSort={securityGainsSort.handleSort}
                      align={column.align}
                      className={HEADER_CLASS}
                    >
                      {column.label}
                    </SortableHeader>
                  ))}
                </tr>
              </thead>
              <tbody role="rowgroup" className="block divide-y divide-gray-200 dark:divide-gray-700 sm:table-row-group">
                {sortedSecurityGains.map((sg) => (
                  <tr
                    key={sg.symbol}
                    role="row"
                    className="grid grid-cols-2 items-start gap-x-3 gap-y-1.5 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-700/50 sm:table-row sm:p-0"
                  >
                    <td role="cell" className="col-start-1 row-start-1 min-w-0 p-0 sm:table-cell sm:px-4 sm:py-3">
                      <div className="font-medium text-gray-900 dark:text-gray-100">
                        {sg.symbol}
                      </div>
                      <div className="break-words text-sm text-gray-500 dark:text-gray-400 sm:break-normal">
                        {sg.name}
                      </div>
                    </td>
                    <td role="cell" className={`col-start-2 row-start-1 text-gray-900 dark:text-gray-100 ${FIGURE_CELL}`}>
                      <CellLabel className={CAPTION_CLASS}>{securityGainColumns.transactionCount.label}</CellLabel>
                      {formatNumber(sg.transactionCount, 0)}
                    </td>
                    <td role="cell" className={`col-start-1 row-start-2 text-gray-900 dark:text-gray-100 ${FIGURE_CELL}`}>
                      <CellLabel className={CAPTION_CLASS}>{securityGainColumns.totalProceeds.label}</CellLabel>
                      {fmtValue(sg.totalProceeds)}
                    </td>
                    <td role="cell" className={`col-start-2 row-start-2 text-gray-900 dark:text-gray-100 ${FIGURE_CELL}`}>
                      <CellLabel className={CAPTION_CLASS}>{securityGainColumns.totalCostBasis.label}</CellLabel>
                      {fmtValue(sg.totalCostBasis)}
                    </td>
                    <td role="cell" className={`col-start-1 col-span-2 row-start-3 font-medium ${gainLossColor(sg.realizedGain)} ${FIGURE_CELL}`}>
                      <CellLabel className={CAPTION_CLASS}>{securityGainColumns.realizedGain.label}</CellLabel>
                      {sg.unknownCount > 0 ? (
                        <>
                          <UnknownAmount reasonText={t('realizedGains.unknownBasisReason')} />
                          <span className="ml-2 text-xs font-normal text-gray-500 dark:text-gray-400">
                            {t('realizedGains.knownPart', { amount: fmtValue(sg.realizedGain) })}
                          </span>
                        </>
                      ) : (
                        <>{sg.realizedGain >= 0 ? '+' : ''}{fmtValue(sg.realizedGain)}</>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot role="rowgroup" className="block bg-gray-50 dark:bg-gray-900/50 sm:table-footer-group">
                <tr role="row" className="grid grid-cols-2 items-start gap-x-3 gap-y-1.5 px-4 py-3 sm:table-row sm:p-0">
                  <td role="cell" className="col-start-1 row-start-1 p-0 font-semibold text-gray-900 dark:text-gray-100 sm:table-cell sm:px-4 sm:py-3">
                    {t('realizedGains.total')}
                  </td>
                  <td role="cell" className={`col-start-2 row-start-1 font-semibold text-gray-900 dark:text-gray-100 ${FIGURE_CELL}`}>
                    <CellLabel className={CAPTION_CLASS}>{securityGainColumns.transactionCount.label}</CellLabel>
                    {formatNumber(totals.totalTransactions, 0)}
                  </td>
                  <td role="cell" className={`col-start-1 row-start-2 font-semibold text-gray-900 dark:text-gray-100 ${FIGURE_CELL}`}>
                    <CellLabel className={CAPTION_CLASS}>{securityGainColumns.totalProceeds.label}</CellLabel>
                    {fmtValue(totals.totalProceeds)}
                  </td>
                  <td role="cell" className={`col-start-2 row-start-2 font-semibold text-gray-900 dark:text-gray-100 ${FIGURE_CELL}`}>
                    <CellLabel className={CAPTION_CLASS}>{securityGainColumns.totalCostBasis.label}</CellLabel>
                    {fmtValue(totals.totalCostBasis)}
                  </td>
                  <td role="cell" className={`col-start-1 col-span-2 row-start-3 font-bold ${gainLossColor(totals.totalGain)} ${FIGURE_CELL}`}>
                    <CellLabel className={CAPTION_CLASS}>{securityGainColumns.realizedGain.label}</CellLabel>
                    {totals.unknownCount > 0 ? (
                      <>
                        <UnknownAmount reasonText={t('realizedGains.unknownBasisReason')} />
                        <span className="ml-2 text-xs font-normal text-gray-500 dark:text-gray-400">
                          {t('realizedGains.knownPart', { amount: fmtValue(totals.totalGain) })}
                        </span>
                      </>
                    ) : (
                      <>{totals.totalGain >= 0 ? '+' : ''}{fmtValue(totals.totalGain)}</>
                    )}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* Individual Transactions */}
      {entries.length > 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {t('realizedGains.sellTransactions', { count: entries.length })}
            </h3>
          </div>
          <div className="overflow-x-auto">
            <table role="table" className="block min-w-full divide-y divide-gray-200 dark:divide-gray-700 sm:table">
              <thead role="rowgroup" className="block bg-gray-50 dark:bg-gray-900/50 sm:table-header-group">
                <tr role="row" className="flex flex-wrap gap-x-2 gap-y-1 px-2 py-2 sm:hidden">
                  {sellTransactionSortColumns.map((column) => (
                    <SortableHeader<SellTransactionsSortField>
                      key={column.field}
                      field={column.field}
                      sortField={sellTransactionsSort.sortField}
                      sortDirection={sellTransactionsSort.sortDirection}
                      onSort={sellTransactionsSort.handleSort}
                      className={PHONE_HEADER_CLASS}
                    >
                      {column.label}
                    </SortableHeader>
                  ))}
                </tr>
                <tr role="row" className="hidden sm:table-row">
                  {sellTransactionSortColumns.map((column) => (
                    <SortableHeader<SellTransactionsSortField>
                      key={column.field}
                      field={column.field}
                      sortField={sellTransactionsSort.sortField}
                      sortDirection={sellTransactionsSort.sortDirection}
                      onSort={sellTransactionsSort.handleSort}
                      align={column.align}
                      className={HEADER_CLASS}
                    >
                      {column.label}
                    </SortableHeader>
                  ))}
                </tr>
              </thead>
              <tbody role="rowgroup" className="block divide-y divide-gray-200 dark:divide-gray-700 sm:table-row-group">
                {sortedEntries.map((entry) => {
                  // A return of capital realizes what it paid beyond the
                  // basis with no shares sold: no share count or price to show.
                  const isReturnOfCapital = entry.action === 'RETURN_OF_CAPITAL';
                  return (
                  <tr
                    key={entry.transactionId}
                    role="row"
                    className="grid grid-cols-2 items-start gap-x-3 gap-y-1.5 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-700/50 sm:table-row sm:p-0"
                  >
                    <td role="cell" className="col-start-1 row-start-1 p-0 text-sm text-gray-900 dark:text-gray-100 sm:table-cell sm:px-4 sm:py-3">
                      <CellLabel className={CAPTION_CLASS}>{sellTransactionColumns.date.label}</CellLabel>
                      {formatDate(entry.transactionDate)}
                    </td>
                    <td role="cell" className="col-start-2 row-start-1 min-w-0 p-0 sm:table-cell sm:px-4 sm:py-3">
                      <div className="font-medium text-sm text-gray-900 dark:text-gray-100">
                        {entry.symbol || 'N/A'}
                      </div>
                      {isReturnOfCapital && (
                        <div className="text-xs text-gray-500 dark:text-gray-400">
                          {t('realizedGains.returnOfCapitalRow')}
                        </div>
                      )}
                    </td>
                    <td role="cell" className={`col-start-1 row-start-2 text-gray-900 dark:text-gray-100 ${FIGURE_CELL}`}>
                      <CellLabel className={CAPTION_CLASS}>{sellTransactionColumns.quantity.label}</CellLabel>
                      {isReturnOfCapital ? '-' : formatShareQuantity(entry.quantity)}
                    </td>
                    <td role="cell" className={`col-start-2 row-start-2 text-gray-900 dark:text-gray-100 ${FIGURE_CELL}`}>
                      <CellLabel className={CAPTION_CLASS}>{sellTransactionColumns.price.label}</CellLabel>
                      {/* The unit price is the SECURITY's currency, unlike the
                          proceeds beside it (the account's, converted by the
                          server). Formatting it through `fmtValue` printed a
                          EUR price with the reader's symbol -- the same
                          mislabel as the transaction history's, issue #1394. */}
                      {isReturnOfCapital ? '-' : fmtSecurityMoney(entry.price, entry.securityCurrencyCode)}
                    </td>
                    <td role="cell" className={`col-start-1 col-span-2 row-start-3 font-medium text-gray-900 dark:text-gray-100 ${FIGURE_CELL}`}>
                      <CellLabel className={CAPTION_CLASS}>{sellTransactionColumns.proceeds.label}</CellLabel>
                      {(() => {
                        const proceeds = toDisplay(entry, 'proceeds');
                        return proceeds === null
                          ? t('realizedGains.csvNoRate')
                          : fmtValue(proceeds);
                      })()}
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
