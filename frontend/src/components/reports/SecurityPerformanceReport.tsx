'use client';

import { useState, useMemo, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { useMainAccountName } from '@/hooks/useMainAccountName';
import { gainLossColor } from '@/lib/format';
import { Skeleton } from '@/components/ui/LoadingSkeleton';
import { useReportData } from '@/hooks/useReportData';
import { ReportError } from '@/components/reports/ReportError';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';
import { format, differenceInDays } from 'date-fns';
import { chartColors } from '@/lib/chart-colors';
import { investmentsApi } from '@/lib/investments';
import { Security, SecurityPrice, InvestmentTransaction, HoldingWithMarketValue } from '@/types/investment';
import { Account } from '@/types/account';
import { parseLocalDate, type ChartDatePattern } from '@/lib/utils';
import { useChartDateFormat } from '@/hooks/useChartDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { ExportDropdown } from '@/components/ui/ExportDropdown';
import { RefreshPricesButton } from '@/components/reports/RefreshPricesButton';
import { SortableHeader } from '@/components/ui/SortableHeader';
import { useSortableTable, compareValues } from '@/hooks/useSortableTable';
import { aggregateHoldingsBySecurity } from '@/lib/aggregate-holdings';
import { renderChartFlagDot, ChartFlagShadowFilter } from '@/components/investments/portfolio-chart-utils';
import { buildTimeAxisTicks } from '@/lib/chart-time-axis';
import { AllSecuritiesChart } from '@/components/reports/AllSecuritiesChart';

const MAX_PAGES = 50;

// Sentinel security-selector value for the all-securities performance
// comparison view (every security on one chart) vs. a single security's id.
const ALL_SECURITIES = '__all__';

type TradeSortField = 'date' | 'account' | 'action' | 'shares' | 'price' | 'total';
type DividendSortField = 'date' | 'account' | 'type' | 'amount';

interface PriceChartPoint {
  date: string;
  ts: number;
  label: string;
  close: number;
  buyMarker?: number;
  sellMarker?: number;
}

export function SecurityPerformanceReport() {
  const t = useTranslations('reports');
  const tc = useTranslations('common');
  const formatChartDate = useChartDateFormat();
  const mainAccountName = useMainAccountName();
  const { formatCurrency: formatCurrencyFull, formatCurrencyAxis, formatSignedPercent } = useNumberFormat();
  const { defaultCurrency } = useExchangeRates();
  const chartRef = useRef<HTMLDivElement>(null);
  const [selectedSecurityId, setSelectedSecurityId] = useState<string>('');
  const [viewType, setViewType] = useState<'chart' | 'transactions' | 'dividends'>('chart');
  // Bumped on a manual price refresh so the all-securities comparison chart
  // re-fetches its (separately loaded) per-security price history.
  const [allRefreshKey, setAllRefreshKey] = useState(0);
  const isAllView = selectedSecurityId === ALL_SECURITIES;
  // Avg-cost bubble the user has temporarily dismissed, keyed by value (mirrors
  // the high/low flag bubbles) so it re-shows when a different security's avg
  // cost differs.
  const [dismissedAvgCost, setDismissedAvgCost] = useState<number | null>(null);
  const tradeSort = useSortableTable<TradeSortField>(
    'reports.security-performance.trades.sort',
    { field: 'date', direction: 'desc' },
  );
  const dividendSort = useSortableTable<DividendSortField>(
    'reports.security-performance.dividends.sort',
    { field: 'date', direction: 'desc' },
  );

  // Load securities, holdings, and accounts on mount. `reload` (a stable
  // callback) is wired to the RefreshPricesButton so a manual price refresh
  // re-fetches the base data (alongside the per-security detail below).
  const { data: baseData, isLoading, error, reload: reloadBase } = useReportData(
    async () => {
      const [secs, summary, accts] = await Promise.all([
        investmentsApi.getSecurities(),
        investmentsApi.getPortfolioSummary(),
        investmentsApi.getInvestmentAccounts(),
      ]);
      return {
        securities: secs.filter((s) => s.isActive),
        holdings: summary.holdings,
        accounts: accts,
      };
    },
    [],
  );

  const securities = useMemo<Security[]>(() => baseData?.securities ?? [], [baseData]);
  const holdings = useMemo<HoldingWithMarketValue[]>(() => baseData?.holdings ?? [], [baseData]);
  const accounts = useMemo<Account[]>(() => baseData?.accounts ?? [], [baseData]);

  const selectedSecurity = securities.find((s) => s.id === selectedSecurityId);

  const accountNameById = useMemo(() => {
    const map = new Map<string, string>();
    accounts.forEach((a) => map.set(a.id, mainAccountName(a.name)));
    return map;
  }, [accounts, mainAccountName]);

  // Load per-security detail (price history + transactions) when a security is
  // selected. `reloadDetail` re-runs after a manual price refresh. The detail
  // fetch is secondary -- its failure leaves the price/transaction panels empty
  // (handled by their own "no data" messaging) rather than replacing the whole
  // report with an error.
  const {
    data: detailData,
    isLoading: isLoadingDetail,
    reload: reloadDetail,
  } = useReportData(
    async () => {
      if (!selectedSecurityId) return null;
      const symbol = securities.find((s) => s.id === selectedSecurityId)?.symbol;
      if (!symbol) return null;

      const allTx: InvestmentTransaction[] = [];

      const [priceData, firstPage] = await Promise.all([
        investmentsApi.getSecurityPrices(selectedSecurityId, 1095),
        investmentsApi.getTransactions({ symbol, limit: 200 }),
      ]);

      allTx.push(...firstPage.data);
      let page = 2;
      let hasMore = firstPage.pagination.hasMore;
      while (hasMore && page <= MAX_PAGES) {
        const nextPage = await investmentsApi.getTransactions({
          symbol,
          limit: 200,
          page,
        });
        allTx.push(...nextPage.data);
        hasMore = nextPage.pagination.hasMore;
        page++;
      }

      return { prices: priceData, transactions: allTx };
    },
    [selectedSecurityId, securities],
  );

  const prices = useMemo<SecurityPrice[]>(() => detailData?.prices ?? [], [detailData]);
  const transactions = useMemo<InvestmentTransaction[]>(
    () => detailData?.transactions ?? [],
    [detailData],
  );

  const selectedHolding = useMemo(() => {
    if (!selectedSecurityId) return null;
    const matches = holdings.filter((h) => h.securityId === selectedSecurityId);
    if (matches.length === 0) return null;
    const [aggregated] = aggregateHoldingsBySecurity(matches);
    return aggregated;
  }, [holdings, selectedSecurityId]);

  // Performance stats
  const stats = useMemo(() => {
    if (!selectedHolding) return null;

    const costBasis = selectedHolding.costBasis;
    const currentValue = selectedHolding.marketValue ?? 0;
    const totalReturn = currentValue - costBasis;
    const totalReturnPercent = costBasis > 0 ? (totalReturn / costBasis) * 100 : 0;

    // Find first buy date for annualized return
    const buyTx = transactions
      .filter((tx) => tx.action === 'BUY' || tx.action === 'ADD_SHARES' || tx.action === 'TRANSFER_IN')
      .sort((a, b) => a.transactionDate.localeCompare(b.transactionDate));

    let annualizedReturn: number | null = null;
    if (buyTx.length > 0 && costBasis > 0) {
      const firstBuyDate = parseLocalDate(buyTx[0].transactionDate);
      const daysDiff = differenceInDays(new Date(), firstBuyDate);
      if (daysDiff > 365) {
        const years = daysDiff / 365.25;
        annualizedReturn = (Math.pow(currentValue / costBasis, 1 / years) - 1) * 100;
      }
    }

    return {
      costBasis,
      currentValue,
      totalReturn,
      totalReturnPercent,
      annualizedReturn,
      quantity: selectedHolding.quantity,
      averageCost: selectedHolding.averageCost,
      currentPrice: selectedHolding.currentPrice,
      accountCount: selectedHolding.accountBreakdowns.length,
    };
  }, [selectedHolding, transactions]);

  // Price chart with buy/sell markers
  const chartData = useMemo((): PriceChartPoint[] => {
    if (prices.length === 0) return [];

    const txByDate = new Map<string, { buys: boolean; sells: boolean }>();
    transactions.forEach((tx) => {
      const date = tx.transactionDate;
      const existing = txByDate.get(date) || { buys: false, sells: false };
      if (tx.action === 'BUY' || tx.action === 'ADD_SHARES' || tx.action === 'REINVEST') {
        existing.buys = true;
      }
      if (tx.action === 'SELL' || tx.action === 'REMOVE_SHARES') {
        existing.sells = true;
      }
      txByDate.set(date, existing);
    });

    return prices
      .sort((a, b) => a.priceDate.localeCompare(b.priceDate))
      .map((p) => {
        const txInfo = txByDate.get(p.priceDate);
        const parsed = parseLocalDate(p.priceDate);
        return {
          date: p.priceDate,
          ts: parsed.getTime(),
          label: formatChartDate(parsed, 'MMM d, yyyy'),
          close: Number(p.closePrice),
          buyMarker: txInfo?.buys ? Number(p.closePrice) : undefined,
          sellMarker: txInfo?.sells ? Number(p.closePrice) : undefined,
        };
      });
  }, [prices, transactions, formatChartDate]);

  // Time-axis ticks: evenly spaced in real time (not by data index), so the
  // horizontal scale is consistent across the whole timeline. Without this the
  // categorical axis gives every price point equal width, stretching out
  // densely-sampled recent dates relative to sparse early history.
  const xAxis = useMemo(() => {
    if (chartData.length === 0) {
      return {
        ticks: [] as number[],
        domain: ['dataMin', 'dataMax'] as [string, string],
        tickFormat: 'MMM yyyy' as ChartDatePattern,
      };
    }
    const minTs = chartData[0].ts;
    const maxTs = chartData[chartData.length - 1].ts;
    const { ticks, stepMonths } = buildTimeAxisTicks(minTs, maxTs);
    return {
      ticks,
      domain: [minTs, maxTs] as [number, number],
      tickFormat: (stepMonths >= 12 ? 'yyyy' : 'MMM yyyy') as ChartDatePattern,
    };
  }, [chartData]);

  // Dividend history
  const dividendTx = useMemo(() => {
    const list = transactions.filter(
      (tx) => tx.action === 'DIVIDEND' || tx.action === 'REINVEST',
    );
    list.sort((a, b) => {
      let comparison = 0;
      switch (dividendSort.sortField) {
        case 'date':
          comparison = compareValues(a.transactionDate, b.transactionDate);
          break;
        case 'account':
          comparison = compareValues(
            accountNameById.get(a.accountId) || '',
            accountNameById.get(b.accountId) || '',
          );
          break;
        case 'type':
          comparison = compareValues(a.action, b.action);
          break;
        case 'amount':
          comparison = compareValues(Math.abs(a.totalAmount), Math.abs(b.totalAmount));
          break;
      }
      return dividendSort.sortDirection === 'asc' ? comparison : -comparison;
    });
    return list;
  }, [transactions, dividendSort.sortField, dividendSort.sortDirection, accountNameById]);

  // Transaction history (non-dividend)
  const tradeTx = useMemo(() => {
    const list = transactions.filter(
      (tx) => tx.action !== 'DIVIDEND' && tx.action !== 'INTEREST' && tx.action !== 'CAPITAL_GAIN',
    );
    list.sort((a, b) => {
      let comparison = 0;
      switch (tradeSort.sortField) {
        case 'date':
          comparison = compareValues(a.transactionDate, b.transactionDate);
          break;
        case 'account':
          comparison = compareValues(
            accountNameById.get(a.accountId) || '',
            accountNameById.get(b.accountId) || '',
          );
          break;
        case 'action':
          comparison = compareValues(a.action, b.action);
          break;
        case 'shares':
          comparison = compareValues(a.quantity, b.quantity);
          break;
        case 'price':
          comparison = compareValues(a.price, b.price);
          break;
        case 'total':
          comparison = compareValues(Math.abs(a.totalAmount), Math.abs(b.totalAmount));
          break;
      }
      return tradeSort.sortDirection === 'asc' ? comparison : -comparison;
    });
    return list;
  }, [transactions, tradeSort.sortField, tradeSort.sortDirection, accountNameById]);

  const displayCurrency = selectedSecurity?.currencyCode || defaultCurrency;

  const handleExportPdf = async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');

    const secLabel = selectedSecurity
      ? `${selectedSecurity.symbol} - ${selectedSecurity.name}${selectedSecurity.exchange ? ` (${selectedSecurity.exchange})` : ''}`
      : undefined;

    const summaryCards = stats ? [
      { label: t('securityPerformance.pdfCurrentValue'), value: formatCurrencyFull(stats.currentValue, displayCurrency), color: '#111827' },
      { label: t('securityPerformance.pdfCostBasis'), value: formatCurrencyFull(stats.costBasis, displayCurrency), color: '#111827' },
      { label: t('securityPerformance.pdfTotalReturn'), value: `${stats.totalReturn >= 0 ? '+' : ''}${formatCurrencyFull(stats.totalReturn, displayCurrency)} (${formatSignedPercent(stats.totalReturnPercent)})`, color: stats.totalReturn >= 0 ? '#16a34a' : '#dc2626' },
      { label: t('securityPerformance.pdfAnnualizedReturn'), value: stats.annualizedReturn !== null ? formatSignedPercent(stats.annualizedReturn) : '-', color: stats.annualizedReturn !== null ? (stats.annualizedReturn >= 0 ? '#16a34a' : '#dc2626') : '#9ca3af' },
    ] : undefined;

    let chartContainer: HTMLElement | null = null;
    let tableData: { headers: string[]; rows: (string | number)[][]; totalRow?: (string | number)[] } | undefined;

    if (viewType === 'chart') {
      chartContainer = chartRef.current;
    } else if (viewType === 'transactions') {
      tableData = {
        headers: [
          t('securityPerformance.pdfColDateTx'),
          t('securityPerformance.pdfColAccount'),
          t('securityPerformance.pdfColAction'),
          t('securityPerformance.pdfColShares'),
          t('securityPerformance.pdfColPrice'),
          t('securityPerformance.pdfColTotal'),
        ],
        rows: tradeTx.map((tx) => [
          format(parseLocalDate(tx.transactionDate), 'MMM d, yyyy'),
          accountNameById.get(tx.accountId) || '-',
          tx.action,
          tx.quantity != null ? String(tx.quantity) : '-',
          tx.price != null ? formatCurrencyFull(tx.price, displayCurrency) : '-',
          formatCurrencyFull(Math.abs(tx.totalAmount), displayCurrency),
        ]),
      };
    } else {
      const totalDividends = dividendTx.reduce((sum, tx) => sum + Math.abs(tx.totalAmount), 0);
      tableData = {
        headers: [
          t('securityPerformance.pdfColDateTx'),
          t('securityPerformance.pdfColAccount'),
          t('securityPerformance.colType'),
          t('securityPerformance.colAmount'),
        ],
        rows: dividendTx.map((tx) => [
          format(parseLocalDate(tx.transactionDate), 'MMM d, yyyy'),
          accountNameById.get(tx.accountId) || '-',
          tx.action,
          formatCurrencyFull(Math.abs(tx.totalAmount), displayCurrency),
        ]),
        totalRow: [t('securityPerformance.pdfTotalDividends'), '', '', formatCurrencyFull(totalDividends, displayCurrency)],
      };
    }

    await exportToPdf({
      title: t('securityPerformance.pdfTitle'),
      subtitle: secLabel,
      summaryCards,
      chartContainer,
      tableData,
      filename: `security-performance-${selectedSecurity?.symbol?.toLowerCase() || 'report'}`,
    });
  };

  if (error) {
    return <ReportError onRetry={reloadBase} />;
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

  return (
    <div className="space-y-6">
      {/* Security Selector */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex flex-wrap gap-4 items-center justify-between">
          <div className="flex gap-2 items-center">
            <select
              value={selectedSecurityId}
              onChange={(e) => setSelectedSecurityId(e.target.value)}
              className="rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 text-sm min-w-[250px]"
            >
              <option value="">{t('securityPerformance.selectSecurityPlaceholder')}</option>
              {securities.length > 0 && (
                <option value={ALL_SECURITIES}>
                  {t('securityPerformance.allSecuritiesOption')}
                </option>
              )}
              {securities
                .sort((a, b) => a.symbol.localeCompare(b.symbol))
                .map((sec) => (
                  <option key={sec.id} value={sec.id}>
                    {sec.symbol} - {sec.name}
                  </option>
                ))}
            </select>
          </div>
          <div className="flex gap-2 items-center">
            {selectedSecurityId && !isAllView && (
              <>
                <button
                  onClick={() => setViewType('chart')}
                  className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                    viewType === 'chart' ? 'bg-blue-600 text-white' : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
                  }`}
                >
                  {t('securityPerformance.viewPriceChart')}
                </button>
                <button
                  onClick={() => setViewType('transactions')}
                  className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                    viewType === 'transactions' ? 'bg-blue-600 text-white' : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
                  }`}
                >
                  {t('securityPerformance.viewTransactions')}
                </button>
                <button
                  onClick={() => setViewType('dividends')}
                  className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                    viewType === 'dividends' ? 'bg-blue-600 text-white' : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
                  }`}
                >
                  {t('securityPerformance.viewDividends')}
                </button>
              </>
            )}
            <RefreshPricesButton onRefreshComplete={() => { reloadBase(); reloadDetail(); setAllRefreshKey((k) => k + 1); }} />
            {selectedSecurityId && !isAllView && <ExportDropdown onExportPdf={handleExportPdf} />}
          </div>
        </div>
      </div>

      {!selectedSecurityId ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-8 text-center">
          <p className="text-gray-500 dark:text-gray-400">
            {t('securityPerformance.selectPrompt')}
          </p>
        </div>
      ) : isAllView ? (
        <AllSecuritiesChart securities={securities} reloadKey={allRefreshKey} />
      ) : isLoadingDetail ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <div className="space-y-4">
            <Skeleton className="h-8 w-1/3" />
            <Skeleton className="h-64 w-full" />
          </div>
        </div>
      ) : (
        <>
          {/* Security Info */}
          {selectedSecurity && (
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
              <div className="flex flex-wrap gap-6 items-center">
                <div>
                  <div className="text-xl font-bold text-gray-900 dark:text-gray-100">{selectedSecurity.symbol}</div>
                  <div className="text-sm text-gray-500 dark:text-gray-400">{selectedSecurity.name}</div>
                </div>
                {selectedSecurity.exchange && (
                  <div>
                    <div className="text-xs text-gray-400 dark:text-gray-500 uppercase">{t('securityPerformance.labelExchange')}</div>
                    <div className="text-sm font-medium text-gray-700 dark:text-gray-300">{selectedSecurity.exchange}</div>
                  </div>
                )}
                {selectedSecurity.securityType && (
                  <div>
                    <div className="text-xs text-gray-400 dark:text-gray-500 uppercase">{t('securityPerformance.labelType')}</div>
                    <div className="text-sm font-medium text-gray-700 dark:text-gray-300">{selectedSecurity.securityType}</div>
                  </div>
                )}
                {selectedSecurity.currencyCode && (
                  <div>
                    <div className="text-xs text-gray-400 dark:text-gray-500 uppercase">{t('securityPerformance.labelCurrency')}</div>
                    <div className="text-sm font-medium text-gray-700 dark:text-gray-300">{selectedSecurity.currencyCode}</div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Stats Cards */}
          {stats && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
                <div className="text-sm text-gray-500 dark:text-gray-400">{t('securityPerformance.currentValue')}</div>
                <div className="text-xl font-bold text-gray-900 dark:text-gray-100">
                  {formatCurrencyFull(stats.currentValue, displayCurrency)}
                </div>
                <div className="text-xs text-gray-400 dark:text-gray-500 mt-1">
                  {t('securityPerformance.sharesAtPrice', { shares: stats.quantity, price: formatCurrencyFull(stats.currentPrice ?? 0, displayCurrency) })}
                  {stats.accountCount > 1 && (
                    <span className="ml-1">{t('securityPerformance.acrossAccounts', { count: stats.accountCount })}</span>
                  )}
                </div>
              </div>
              <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
                <div className="text-sm text-gray-500 dark:text-gray-400">{t('securityPerformance.costBasis')}</div>
                <div className="text-xl font-bold text-gray-900 dark:text-gray-100">
                  {formatCurrencyFull(stats.costBasis, displayCurrency)}
                </div>
                <div className="text-xs text-gray-400 dark:text-gray-500 mt-1">
                  {t('securityPerformance.avgCostLabel', { amount: formatCurrencyFull(stats.averageCost, displayCurrency) })}
                </div>
              </div>
              <div className={`rounded-lg shadow p-4 ${stats.totalReturn >= 0 ? 'bg-green-50 dark:bg-green-900/20' : 'bg-red-50 dark:bg-red-900/20'}`}>
                <div className={`text-sm ${gainLossColor(stats.totalReturn)}`}>
                  {t('securityPerformance.totalReturn')}
                </div>
                <div className={`text-xl font-bold ${stats.totalReturn >= 0 ? 'text-green-700 dark:text-green-300' : 'text-red-700 dark:text-red-300'}`}>
                  {stats.totalReturn >= 0 ? '+' : ''}{formatCurrencyFull(stats.totalReturn, displayCurrency)}
                </div>
                <div className={`text-xs mt-1 ${stats.totalReturn >= 0 ? 'text-green-500 dark:text-green-400' : 'text-red-500 dark:text-red-400'}`}>
                  {formatSignedPercent(stats.totalReturnPercent)}
                </div>
              </div>
              <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
                <div className="text-sm text-gray-500 dark:text-gray-400">{t('securityPerformance.annualizedReturn')}</div>
                <div className={`text-xl font-bold ${stats.annualizedReturn !== null ? (stats.annualizedReturn >= 0 ? 'text-green-700 dark:text-green-300' : 'text-red-700 dark:text-red-300') : 'text-gray-400'}`}>
                  {stats.annualizedReturn !== null
                    ? formatSignedPercent(stats.annualizedReturn)
                    : '-'}
                </div>
                {stats.annualizedReturn === null && (
                  <div className="text-xs text-gray-400 dark:text-gray-500 mt-1">{t('securityPerformance.needs1YearNote')}</div>
                )}
              </div>
            </div>
          )}

          {viewType === 'chart' ? (
            /* Price Chart */
            <div ref={chartRef} className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 px-2 py-4 sm:p-6">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
                {t('securityPerformance.priceHistory', { symbol: selectedSecurity?.symbol ?? '' })}
              </h3>
              {chartData.length > 0 ? (
                <div className="h-80">
                  <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                    <AreaChart data={chartData}>
                      <defs>
                        <linearGradient id="priceGradient" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor={chartColors.primary} stopOpacity={0.3} />
                          <stop offset="95%" stopColor={chartColors.primary} stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <ChartFlagShadowFilter />
                      <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} />
                      <XAxis
                        dataKey="ts"
                        type="number"
                        scale="time"
                        domain={xAxis.domain}
                        ticks={xAxis.ticks}
                        tickFormatter={(ts: number) => formatChartDate(new Date(ts), xAxis.tickFormat)}
                        tick={{ fontSize: 11 }}
                      />
                      <YAxis
                        tickFormatter={(v: number) => formatCurrencyAxis(v, displayCurrency)}
                        domain={['auto', 'auto']}
                      />
                      <Tooltip
                        content={({ active, payload }) => {
                          if (!active || !payload?.length) return null;
                          const d = payload[0].payload as PriceChartPoint;
                          return (
                            <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
                              <p className="font-medium text-gray-900 dark:text-gray-100">{d.label}</p>
                              <p className="text-sm text-blue-600 dark:text-blue-400">
                                {t('securityPerformance.closePrice', { price: formatCurrencyFull(d.close, displayCurrency) })}
                              </p>
                              {d.buyMarker && <p className="text-sm text-green-600 dark:text-green-400">{t('securityPerformance.buyTransaction')}</p>}
                              {d.sellMarker && <p className="text-sm text-red-600 dark:text-red-400">{t('securityPerformance.sellTransaction')}</p>}
                            </div>
                          );
                        }}
                      />
                      <Area
                        type="monotone"
                        dataKey="close"
                        stroke={chartColors.primary}
                        fill="url(#priceGradient)"
                        strokeWidth={2}
                      />
                      {/* Buy markers */}
                      <Area
                        type="monotone"
                        dataKey="buyMarker"
                        stroke="none"
                        fill="none"
                        dot={{ r: 6, fill: chartColors.income, stroke: '#fff', strokeWidth: 2 }}
                        activeDot={false}
                        connectNulls={false}
                      />
                      {/* Sell markers */}
                      <Area
                        type="monotone"
                        dataKey="sellMarker"
                        stroke="none"
                        fill="none"
                        dot={{ r: 6, fill: chartColors.expense, stroke: '#fff', strokeWidth: 2 }}
                        activeDot={false}
                        connectNulls={false}
                      />
                      {stats && stats.averageCost > 0 && (
                        <ReferenceLine
                          y={stats.averageCost}
                          stroke={chartColors.warning}
                          strokeDasharray="4 4"
                          // extendDomain widens the y-axis so the avg-cost line is
                          // always visible, even when the cost basis sits outside the
                          // displayed price range. zIndex 700 lifts the line and its
                          // flag label above the buy/sell marker dots (zIndex 600).
                          ifOverflow="extendDomain"
                          zIndex={700}
                          {...(stats.averageCost === dismissedAvgCost
                            ? {}
                            : {
                                // The flag box hangs flush under the line (its top
                                // edge at the line). Positioned from the label's
                                // viewBox, which Recharts derives from the real axis
                                // scale -- so it stays attached to the line exactly.
                                label: (labelProps: {
                                  viewBox?: { x?: number; y?: number; width?: number };
                                }) => {
                                  const vb = labelProps.viewBox ?? {};
                                  const x = vb.x ?? 0;
                                  const y = vb.y ?? 0;
                                  const width = vb.width ?? 0;
                                  return renderChartFlagDot({
                                    cx: x + width,
                                    cy: y,
                                    index: 0,
                                    color: chartColors.warning,
                                    label: `${t('securityPerformance.avgCostRefLine')}: ${formatCurrencyFull(stats.averageCost, displayCurrency)}`,
                                    side: 'left',
                                    gap: 6,
                                    showDot: false,
                                    boxVerticalAlign: 'top',
                                    onDismiss: () => setDismissedAvgCost(stats.averageCost),
                                    dismissLabel: tc('chartFlag.dismiss'),
                                  });
                                },
                              })}
                        />
                      )}
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <p className="text-gray-500 dark:text-gray-400 text-center py-8">{t('securityPerformance.noPriceHistory')}</p>
              )}
            </div>
          ) : viewType === 'transactions' ? (
            /* Transaction History */
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
              <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
                <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                  {t('securityPerformance.transactionHistory', { symbol: selectedSecurity?.symbol ?? '' })}
                </h3>
              </div>
              {tradeTx.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                    <thead className="bg-gray-50 dark:bg-gray-900/50">
                      <tr>
                        <SortableHeader<TradeSortField>
                          field="date"
                          sortField={tradeSort.sortField}
                          sortDirection={tradeSort.sortDirection}
                          onSort={tradeSort.handleSort}
                          className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                        >
                          {t('securityPerformance.colDate')}
                        </SortableHeader>
                        <SortableHeader<TradeSortField>
                          field="account"
                          sortField={tradeSort.sortField}
                          sortDirection={tradeSort.sortDirection}
                          onSort={tradeSort.handleSort}
                          className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                        >
                          {t('securityPerformance.colAccount')}
                        </SortableHeader>
                        <SortableHeader<TradeSortField>
                          field="action"
                          sortField={tradeSort.sortField}
                          sortDirection={tradeSort.sortDirection}
                          onSort={tradeSort.handleSort}
                          className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                        >
                          {t('securityPerformance.colAction')}
                        </SortableHeader>
                        <SortableHeader<TradeSortField>
                          field="shares"
                          sortField={tradeSort.sortField}
                          sortDirection={tradeSort.sortDirection}
                          onSort={tradeSort.handleSort}
                          align="right"
                          className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                        >
                          {t('securityPerformance.colShares')}
                        </SortableHeader>
                        <SortableHeader<TradeSortField>
                          field="price"
                          sortField={tradeSort.sortField}
                          sortDirection={tradeSort.sortDirection}
                          onSort={tradeSort.handleSort}
                          align="right"
                          className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                        >
                          {t('securityPerformance.colPrice')}
                        </SortableHeader>
                        <SortableHeader<TradeSortField>
                          field="total"
                          sortField={tradeSort.sortField}
                          sortDirection={tradeSort.sortDirection}
                          onSort={tradeSort.handleSort}
                          align="right"
                          className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                        >
                          {t('securityPerformance.colTotal')}
                        </SortableHeader>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                      {tradeTx.map((tx) => (
                        <tr key={tx.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                          <td className="px-4 py-3 text-sm text-gray-900 dark:text-gray-100">
                            {format(parseLocalDate(tx.transactionDate), 'MMM d, yyyy')}
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-400">
                            {accountNameById.get(tx.accountId) || '-'}
                          </td>
                          <td className="px-4 py-3 text-sm">
                            <span className={`px-2 py-0.5 text-xs font-medium rounded ${
                              tx.action === 'BUY' || tx.action === 'ADD_SHARES' || tx.action === 'TRANSFER_IN' || tx.action === 'REINVEST'
                                ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                                : tx.action === 'SELL' || tx.action === 'REMOVE_SHARES' || tx.action === 'TRANSFER_OUT'
                                  ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                                  : 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300'
                            }`}>
                              {tx.action}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-sm text-right text-gray-600 dark:text-gray-400">
                            {tx.quantity ?? '-'}
                          </td>
                          <td className="px-4 py-3 text-sm text-right text-gray-600 dark:text-gray-400">
                            {tx.price != null ? formatCurrencyFull(tx.price, displayCurrency) : '-'}
                          </td>
                          <td className="px-4 py-3 text-sm text-right font-medium text-gray-900 dark:text-gray-100">
                            {formatCurrencyFull(Math.abs(tx.totalAmount), displayCurrency)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="p-6 text-center text-gray-500 dark:text-gray-400">{t('securityPerformance.noTransactions')}</div>
              )}
            </div>
          ) : (
            /* Dividend History */
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
              <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
                <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                  {t('securityPerformance.dividendHistory', { symbol: selectedSecurity?.symbol ?? '' })}
                </h3>
              </div>
              {dividendTx.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                    <thead className="bg-gray-50 dark:bg-gray-900/50">
                      <tr>
                        <SortableHeader<DividendSortField>
                          field="date"
                          sortField={dividendSort.sortField}
                          sortDirection={dividendSort.sortDirection}
                          onSort={dividendSort.handleSort}
                          className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                        >
                          {t('securityPerformance.colDate')}
                        </SortableHeader>
                        <SortableHeader<DividendSortField>
                          field="account"
                          sortField={dividendSort.sortField}
                          sortDirection={dividendSort.sortDirection}
                          onSort={dividendSort.handleSort}
                          className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                        >
                          {t('securityPerformance.colAccount')}
                        </SortableHeader>
                        <SortableHeader<DividendSortField>
                          field="type"
                          sortField={dividendSort.sortField}
                          sortDirection={dividendSort.sortDirection}
                          onSort={dividendSort.handleSort}
                          className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                        >
                          {t('securityPerformance.colType')}
                        </SortableHeader>
                        <SortableHeader<DividendSortField>
                          field="amount"
                          sortField={dividendSort.sortField}
                          sortDirection={dividendSort.sortDirection}
                          onSort={dividendSort.handleSort}
                          align="right"
                          className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                        >
                          {t('securityPerformance.colAmount')}
                        </SortableHeader>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                      {dividendTx.map((tx) => (
                        <tr key={tx.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                          <td className="px-4 py-3 text-sm text-gray-900 dark:text-gray-100">
                            {format(parseLocalDate(tx.transactionDate), 'MMM d, yyyy')}
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-400">
                            {accountNameById.get(tx.accountId) || '-'}
                          </td>
                          <td className="px-4 py-3 text-sm">
                            <span className="px-2 py-0.5 text-xs font-medium rounded bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
                              {tx.action}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-sm text-right font-medium text-green-600 dark:text-green-400">
                            {formatCurrencyFull(Math.abs(tx.totalAmount), displayCurrency)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot className="bg-gray-50 dark:bg-gray-900/50">
                      <tr>
                        <td className="px-4 py-3 text-sm font-bold text-gray-900 dark:text-gray-100" colSpan={3}>
                          {t('securityPerformance.totalDividends')}
                        </td>
                        <td className="px-4 py-3 text-sm text-right font-bold text-green-600 dark:text-green-400">
                          {formatCurrencyFull(
                            dividendTx.reduce((sum, tx) => sum + Math.abs(tx.totalAmount), 0),
                            displayCurrency,
                          )}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              ) : (
                <div className="p-6 text-center text-gray-500 dark:text-gray-400">{t('securityPerformance.noDividendHistory')}</div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
