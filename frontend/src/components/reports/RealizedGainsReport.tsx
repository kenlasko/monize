'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { gainLossColor } from '@/lib/format';
import { Skeleton } from '@/components/ui/LoadingSkeleton';
import { useReportData } from '@/hooks/useReportData';
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
import { Account } from '@/types/account';
import { parseLocalDate } from '@/lib/utils';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { useDateRange } from '@/hooks/useDateRange';
import { DateRangeSelector } from '@/components/ui/DateRangeSelector';
import { ExportDropdown } from '@/components/ui/ExportDropdown';
import { ReportAccountMultiSelect } from '@/components/reports/ReportAccountMultiSelect';
import { RefreshPricesButton } from '@/components/reports/RefreshPricesButton';
import { exportToCsv } from '@/lib/csv-export';
import { SortableHeader } from '@/components/ui/SortableHeader';
import { useSortableTable, compareValues } from '@/hooks/useSortableTable';
import { createLogger } from '@/lib/logger';

const logger = createLogger('RealizedGainsReport');

type SecurityGainsSortField = 'symbol' | 'transactionCount' | 'totalProceeds' | 'totalCostBasis' | 'realizedGain';
type SellTransactionsSortField = 'date' | 'symbol' | 'quantity' | 'price' | 'proceeds';

function CustomTooltip({ active, payload, fmtValue }: {
  active?: boolean;
  payload?: Array<{ value: number; payload: { symbol: string } }>;
  fmtValue: (v: number) => string;
}) {
  if (!active || !payload?.length) return null;
  const data = payload[0];
  const value = data.value;
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
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
}

export function RealizedGainsReport() {
  const t = useTranslations('reports');
  const { formatCurrency: formatCurrencyFull, formatCurrencyAxis } = useNumberFormat();
  const { defaultCurrency, convertToDefault } = useExchangeRates();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
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

  const selectedAccount = isSingleAccount
    ? accounts.find((a) => a.id === selectedAccountIds[0])
    : undefined;
  const displayCurrency = selectedAccount?.currencyCode || defaultCurrency;
  const isForeign = displayCurrency !== defaultCurrency;

  // Backend returns each figure in the holding account's currency. Convert to
  // the default currency when viewing All Accounts or several accounts;
  // otherwise (a single account) pass through in its native currency.
  const toDisplay = useCallback((amount: number, accountCurrencyCode: string | null): number => {
    if (isSingleAccount) return amount;
    return convertToDefault(amount, accountCurrencyCode || defaultCurrency);
  }, [isSingleAccount, defaultCurrency, convertToDefault]);

  const fmtValue = useCallback((value: number): string => {
    if (isForeign) {
      return `${formatCurrencyFull(value, displayCurrency)} ${displayCurrency}`;
    }
    return formatCurrencyFull(value);
  }, [isForeign, displayCurrency, formatCurrencyFull]);

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
        };
        map.set(symbol, bucket);
      }

      bucket.totalProceeds += toDisplay(entry.proceeds, entry.accountCurrencyCode);
      bucket.totalCostBasis += toDisplay(entry.costBasis, entry.accountCurrencyCode);
      bucket.realizedGain += toDisplay(entry.realizedGain, entry.accountCurrencyCode);
      bucket.transactionCount += 1;
    });

    return Array.from(map.values());
  }, [entries, toDisplay]);

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
      .filter((sg) => sg.realizedGain !== 0)
      .map((sg) => ({
        symbol: sg.symbol,
        gain: Math.round(sg.realizedGain * 100) / 100,
      }));
  }, [securityGains]);

  const totals = useMemo(() => {
    let totalProceeds = 0, totalCostBasis = 0, totalGain = 0, totalTransactions = 0, gainers = 0, losers = 0;
    for (const sg of securityGains) {
      totalProceeds += sg.totalProceeds;
      totalCostBasis += sg.totalCostBasis;
      totalGain += sg.realizedGain;
      totalTransactions += sg.transactionCount;
      if (sg.realizedGain > 0) gainers++;
      else if (sg.realizedGain < 0) losers++;
    }
    return { totalProceeds, totalCostBasis, totalGain, totalTransactions, gainers, losers };
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
        case 'price':
          comparison = compareValues(a.price, b.price);
          break;
        case 'proceeds':
          comparison = compareValues(
            toDisplay(a.proceeds, a.accountCurrencyCode),
            toDisplay(b.proceeds, b.accountCurrencyCode),
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
      const proceeds = toDisplay(entry.proceeds, entry.accountCurrencyCode);
      const costBasis = toDisplay(entry.costBasis, entry.accountCurrencyCode);
      const gain = toDisplay(entry.realizedGain, entry.accountCurrencyCode);
      const returnPct = costBasis !== 0 ? ((gain / costBasis) * 100).toFixed(2) + '%' : '-';
      return [
        entry.symbol || 'N/A',
        format(parseLocalDate(entry.transactionDate), 'yyyy-MM-dd'),
        entry.quantity,
        proceeds,
        costBasis,
        gain,
        returnPct,
      ];
    });
    return { headers, rows };
  }, [sortedEntries, toDisplay, t]);

  const handleExportCsv = useCallback(() => {
    const { headers, rows } = getExportData();
    exportToCsv('realized-gains', headers, rows);
  }, [getExportData]);

  const handleExportPdf = useCallback(async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    const { headers, rows } = getExportData();
    const totalRow: (string | number)[] = [t('realizedGains.total'), '', '', totals.totalProceeds, totals.totalCostBasis, totals.totalGain, ''];
    await exportToPdf({
      title: t('realizedGains.pdfTitle'),
      subtitle: t('realizedGains.pdfSubtitle', { count: securityGains.length, gain: fmtValue(totals.totalGain) }),
      summaryCards: [
        { label: t('realizedGains.totalProceeds'), value: fmtValue(totals.totalProceeds), color: '#111827' },
        { label: t('realizedGains.costBasis'), value: fmtValue(totals.totalCostBasis), color: '#111827' },
        { label: t('realizedGains.realizedGainLoss'), value: `${totals.totalGain >= 0 ? '+' : ''}${fmtValue(totals.totalGain)}`, color: totals.totalGain >= 0 ? '#16a34a' : '#dc2626' },
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
          <div className={`text-xl font-bold ${gainLossColor(totals.totalGain)}`}>
            {totals.totalGain >= 0 ? '+' : ''}{fmtValue(totals.totalGain)}
          </div>
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

      {/* Controls */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex flex-wrap gap-3 items-center">
          <ReportAccountMultiSelect
            accounts={accounts}
            value={selectedAccountIds}
            onChange={setSelectedAccountIds}
          />
          <DateRangeSelector
            ranges={['6m', '1y', '2y', 'all']}
            value={dateRange}
            onChange={setDateRange}
          />
          <div className="ml-auto shrink-0 flex gap-2 items-center">
            <RefreshPricesButton onRefreshComplete={reload} />
            <button
              onClick={() => setViewType('chart')}
              title={t('realizedGains.viewChart')}
              className={`p-2 rounded-md transition-colors ${
                viewType === 'chart'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
              }`}
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
              </svg>
            </button>
            <button
              onClick={() => setViewType('table')}
              title={t('realizedGains.viewTable')}
              className={`p-2 rounded-md transition-colors ${
                viewType === 'table'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
              }`}
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M3 14h18M3 6h18M3 18h18" />
              </svg>
            </button>
            <ExportDropdown onExportCsv={handleExportCsv} onExportPdf={handleExportPdf} disabled={entries.length === 0} />
          </div>
        </div>
      </div>

      {entries.length === 0 ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <p className="text-gray-500 dark:text-gray-400 text-center py-8">
            {t('realizedGains.noTransactions')}
          </p>
        </div>
      ) : viewType === 'chart' ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 px-2 py-4 sm:p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
            {t('realizedGains.bySecurityTitle')}
          </h3>
          {chartData.length === 0 ? (
            <p className="text-gray-500 dark:text-gray-400 text-center py-8">
              {t('realizedGains.noGainsLosses')}
            </p>
          ) : (
            <div className="h-80">
              <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                <BarChart data={chartData} layout="vertical" margin={{ left: 0, right: 10 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} />
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
            <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
              <thead className="bg-gray-50 dark:bg-gray-900/50">
                <tr>
                  <SortableHeader<SecurityGainsSortField>
                    field="symbol"
                    sortField={securityGainsSort.sortField}
                    sortDirection={securityGainsSort.sortDirection}
                    onSort={securityGainsSort.handleSort}
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                  >
                    {t('realizedGains.colSecurity')}
                  </SortableHeader>
                  <SortableHeader<SecurityGainsSortField>
                    field="transactionCount"
                    sortField={securityGainsSort.sortField}
                    sortDirection={securityGainsSort.sortDirection}
                    onSort={securityGainsSort.handleSort}
                    align="right"
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                  >
                    {t('realizedGains.colTrades')}
                  </SortableHeader>
                  <SortableHeader<SecurityGainsSortField>
                    field="totalProceeds"
                    sortField={securityGainsSort.sortField}
                    sortDirection={securityGainsSort.sortDirection}
                    onSort={securityGainsSort.handleSort}
                    align="right"
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                  >
                    {t('realizedGains.colProceeds')}
                  </SortableHeader>
                  <SortableHeader<SecurityGainsSortField>
                    field="totalCostBasis"
                    sortField={securityGainsSort.sortField}
                    sortDirection={securityGainsSort.sortDirection}
                    onSort={securityGainsSort.handleSort}
                    align="right"
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                  >
                    {t('realizedGains.colCostBasis')}
                  </SortableHeader>
                  <SortableHeader<SecurityGainsSortField>
                    field="realizedGain"
                    sortField={securityGainsSort.sortField}
                    sortDirection={securityGainsSort.sortDirection}
                    onSort={securityGainsSort.handleSort}
                    align="right"
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                  >
                    {t('realizedGains.colGainLoss')}
                  </SortableHeader>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                {sortedSecurityGains.map((sg) => (
                  <tr key={sg.symbol} className="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-900 dark:text-gray-100">
                        {sg.symbol}
                      </div>
                      <div className="text-sm text-gray-500 dark:text-gray-400">
                        {sg.name}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right text-sm text-gray-900 dark:text-gray-100">
                      {sg.transactionCount}
                    </td>
                    <td className="px-4 py-3 text-right text-sm text-gray-900 dark:text-gray-100">
                      {fmtValue(sg.totalProceeds)}
                    </td>
                    <td className="px-4 py-3 text-right text-sm text-gray-900 dark:text-gray-100">
                      {fmtValue(sg.totalCostBasis)}
                    </td>
                    <td className={`px-4 py-3 text-right text-sm font-medium ${gainLossColor(sg.realizedGain)}`}>
                      {sg.realizedGain >= 0 ? '+' : ''}{fmtValue(sg.realizedGain)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-gray-50 dark:bg-gray-900/50">
                <tr>
                  <td className="px-4 py-3 font-semibold text-gray-900 dark:text-gray-100">
                    {t('realizedGains.total')}
                  </td>
                  <td className="px-4 py-3 text-right text-sm font-semibold text-gray-900 dark:text-gray-100">
                    {totals.totalTransactions}
                  </td>
                  <td className="px-4 py-3 text-right text-sm font-semibold text-gray-900 dark:text-gray-100">
                    {fmtValue(totals.totalProceeds)}
                  </td>
                  <td className="px-4 py-3 text-right text-sm font-semibold text-gray-900 dark:text-gray-100">
                    {fmtValue(totals.totalCostBasis)}
                  </td>
                  <td className={`px-4 py-3 text-right text-sm font-bold ${gainLossColor(totals.totalGain)}`}>
                    {totals.totalGain >= 0 ? '+' : ''}{fmtValue(totals.totalGain)}
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
            <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
              <thead className="bg-gray-50 dark:bg-gray-900/50">
                <tr>
                  <SortableHeader<SellTransactionsSortField>
                    field="date"
                    sortField={sellTransactionsSort.sortField}
                    sortDirection={sellTransactionsSort.sortDirection}
                    onSort={sellTransactionsSort.handleSort}
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                  >
                    {t('realizedGains.colDate')}
                  </SortableHeader>
                  <SortableHeader<SellTransactionsSortField>
                    field="symbol"
                    sortField={sellTransactionsSort.sortField}
                    sortDirection={sellTransactionsSort.sortDirection}
                    onSort={sellTransactionsSort.handleSort}
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                  >
                    {t('realizedGains.colSecurity')}
                  </SortableHeader>
                  <SortableHeader<SellTransactionsSortField>
                    field="quantity"
                    sortField={sellTransactionsSort.sortField}
                    sortDirection={sellTransactionsSort.sortDirection}
                    onSort={sellTransactionsSort.handleSort}
                    align="right"
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                  >
                    {t('realizedGains.colShares')}
                  </SortableHeader>
                  <SortableHeader<SellTransactionsSortField>
                    field="price"
                    sortField={sellTransactionsSort.sortField}
                    sortDirection={sellTransactionsSort.sortDirection}
                    onSort={sellTransactionsSort.handleSort}
                    align="right"
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                  >
                    {t('realizedGains.colPrice')}
                  </SortableHeader>
                  <SortableHeader<SellTransactionsSortField>
                    field="proceeds"
                    sortField={sellTransactionsSort.sortField}
                    sortDirection={sellTransactionsSort.sortDirection}
                    onSort={sellTransactionsSort.handleSort}
                    align="right"
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                  >
                    {t('realizedGains.colProceeds')}
                  </SortableHeader>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                {sortedEntries.map((entry) => (
                  <tr key={entry.transactionId} className="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                    <td className="px-4 py-3 text-sm text-gray-900 dark:text-gray-100">
                      {format(parseLocalDate(entry.transactionDate), 'MMM d, yyyy')}
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-sm text-gray-900 dark:text-gray-100">
                        {entry.symbol || 'N/A'}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right text-sm text-gray-900 dark:text-gray-100">
                      {entry.quantity.toFixed(4)}
                    </td>
                    <td className="px-4 py-3 text-right text-sm text-gray-900 dark:text-gray-100">
                      {fmtValue(entry.price)}
                    </td>
                    <td className="px-4 py-3 text-right text-sm font-medium text-gray-900 dark:text-gray-100">
                      {fmtValue(toDisplay(entry.proceeds, entry.accountCurrencyCode))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
