'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
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
import { investmentsApi } from '@/lib/investments';
import { Security, SecurityPrice, InvestmentTransaction, HoldingWithMarketValue } from '@/types/investment';
import { Account } from '@/types/account';
import { parseLocalDate } from '@/lib/utils';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { ExportDropdown } from '@/components/ui/ExportDropdown';
import { RefreshPricesButton } from '@/components/reports/RefreshPricesButton';
import { SortableHeader } from '@/components/ui/SortableHeader';
import { useSortableTable, compareValues } from '@/hooks/useSortableTable';
import { createLogger } from '@/lib/logger';
import { aggregateHoldingsBySecurity } from '@/lib/aggregate-holdings';

const logger = createLogger('SecurityPerformanceReport');

const MAX_PAGES = 50;

type TradeSortField = 'date' | 'account' | 'action' | 'shares' | 'price' | 'total';
type DividendSortField = 'date' | 'account' | 'type' | 'amount';

interface PriceChartPoint {
  date: string;
  label: string;
  close: number;
  buyMarker?: number;
  sellMarker?: number;
}

export function SecurityPerformanceReport() {
  const { formatCurrency: formatCurrencyFull, formatCurrencyAxis, formatSignedPercent } = useNumberFormat();
  const { defaultCurrency } = useExchangeRates();
  const chartRef = useRef<HTMLDivElement>(null);
  const [securities, setSecurities] = useState<Security[]>([]);
  const [selectedSecurityId, setSelectedSecurityId] = useState<string>('');
  const [prices, setPrices] = useState<SecurityPrice[]>([]);
  const [transactions, setTransactions] = useState<InvestmentTransaction[]>([]);
  const [holdings, setHoldings] = useState<HoldingWithMarketValue[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [viewType, setViewType] = useState<'chart' | 'transactions' | 'dividends'>('chart');
  const tradeSort = useSortableTable<TradeSortField>(
    'reports.security-performance.trades.sort',
    { field: 'date', direction: 'desc' },
  );
  const dividendSort = useSortableTable<DividendSortField>(
    'reports.security-performance.dividends.sort',
    { field: 'date', direction: 'desc' },
  );

  // Load securities on mount
  useEffect(() => {
    const load = async () => {
      try {
        const [secs, summary, accts] = await Promise.all([
          investmentsApi.getSecurities(),
          investmentsApi.getPortfolioSummary(),
          investmentsApi.getInvestmentAccounts(),
        ]);
        setSecurities(secs.filter((s) => s.isActive));
        setHoldings(summary.holdings);
        setAccounts(accts);
      } catch (error) {
        logger.error('Failed to load securities:', error);
      } finally {
        setIsLoading(false);
      }
    };
    load();
  }, [reloadKey]);

  const selectedSecurity = securities.find((s) => s.id === selectedSecurityId);

  const accountNameById = useMemo(() => {
    const map = new Map<string, string>();
    accounts.forEach((a) => map.set(a.id, a.name.replace(/ - (Brokerage|Cash)$/, '')));
    return map;
  }, [accounts]);

  // Load detail when security selected
  useEffect(() => {
    if (!selectedSecurityId) {
      setPrices([]);
      setTransactions([]);
      return;
    }

    const symbol = securities.find((s) => s.id === selectedSecurityId)?.symbol;
    if (!symbol) return;

    const loadDetail = async () => {
      setIsLoadingDetail(true);
      try {
        const allTx: InvestmentTransaction[] = [];

        const [priceData, firstPage] = await Promise.all([
          investmentsApi.getSecurityPrices(selectedSecurityId, 1095),
          investmentsApi.getTransactions({ symbol, limit: 200 }),
        ]);
        setPrices(priceData);

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
        setTransactions(allTx);
      } catch (error) {
        logger.error('Failed to load security detail:', error);
      } finally {
        setIsLoadingDetail(false);
      }
    };
    loadDetail();
  }, [selectedSecurityId, securities, reloadKey]);
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
        return {
          date: p.priceDate,
          label: format(parseLocalDate(p.priceDate), 'MMM d, yyyy'),
          close: Number(p.closePrice),
          buyMarker: txInfo?.buys ? Number(p.closePrice) : undefined,
          sellMarker: txInfo?.sells ? Number(p.closePrice) : undefined,
        };
      });
  }, [prices, transactions]);

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
      { label: 'Current Value', value: formatCurrencyFull(stats.currentValue, displayCurrency), color: '#111827' },
      { label: 'Cost Basis', value: formatCurrencyFull(stats.costBasis, displayCurrency), color: '#111827' },
      { label: 'Total Return', value: `${stats.totalReturn >= 0 ? '+' : ''}${formatCurrencyFull(stats.totalReturn, displayCurrency)} (${formatSignedPercent(stats.totalReturnPercent)})`, color: stats.totalReturn >= 0 ? '#16a34a' : '#dc2626' },
      { label: 'Annualized Return', value: stats.annualizedReturn !== null ? formatSignedPercent(stats.annualizedReturn) : '-', color: stats.annualizedReturn !== null ? (stats.annualizedReturn >= 0 ? '#16a34a' : '#dc2626') : '#9ca3af' },
    ] : undefined;

    let chartContainer: HTMLElement | null = null;
    let tableData: { headers: string[]; rows: (string | number)[][]; totalRow?: (string | number)[] } | undefined;

    if (viewType === 'chart') {
      chartContainer = chartRef.current;
    } else if (viewType === 'transactions') {
      tableData = {
        headers: ['Date', 'Account', 'Action', 'Shares', 'Price', 'Total'],
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
        headers: ['Date', 'Account', 'Type', 'Amount'],
        rows: dividendTx.map((tx) => [
          format(parseLocalDate(tx.transactionDate), 'MMM d, yyyy'),
          accountNameById.get(tx.accountId) || '-',
          tx.action,
          formatCurrencyFull(Math.abs(tx.totalAmount), displayCurrency),
        ]),
        totalRow: ['Total Dividends', '', '', formatCurrencyFull(totalDividends, displayCurrency)],
      };
    }

    await exportToPdf({
      title: 'Security Performance',
      subtitle: secLabel,
      summaryCards,
      chartContainer,
      tableData,
      filename: `security-performance-${selectedSecurity?.symbol?.toLowerCase() || 'report'}`,
    });
  };

  if (isLoading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 dark:bg-gray-700 rounded w-1/3" />
          <div className="h-64 bg-gray-200 dark:bg-gray-700 rounded" />
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
              <option value="">Select a security...</option>
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
            {selectedSecurityId && (
              <>
                <button
                  onClick={() => setViewType('chart')}
                  className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                    viewType === 'chart' ? 'bg-blue-600 text-white' : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
                  }`}
                >
                  Price Chart
                </button>
                <button
                  onClick={() => setViewType('transactions')}
                  className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                    viewType === 'transactions' ? 'bg-blue-600 text-white' : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
                  }`}
                >
                  Transactions
                </button>
                <button
                  onClick={() => setViewType('dividends')}
                  className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                    viewType === 'dividends' ? 'bg-blue-600 text-white' : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
                  }`}
                >
                  Dividends
                </button>
              </>
            )}
            <RefreshPricesButton onRefreshComplete={() => setReloadKey((k) => k + 1)} />
            {selectedSecurityId && <ExportDropdown onExportPdf={handleExportPdf} />}
          </div>
        </div>
      </div>

      {!selectedSecurityId ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-8 text-center">
          <p className="text-gray-500 dark:text-gray-400">
            Select a security above to view its performance details.
          </p>
        </div>
      ) : isLoadingDetail ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <div className="animate-pulse space-y-4">
            <div className="h-8 bg-gray-200 dark:bg-gray-700 rounded w-1/3" />
            <div className="h-64 bg-gray-200 dark:bg-gray-700 rounded" />
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
                    <div className="text-xs text-gray-400 dark:text-gray-500 uppercase">Exchange</div>
                    <div className="text-sm font-medium text-gray-700 dark:text-gray-300">{selectedSecurity.exchange}</div>
                  </div>
                )}
                {selectedSecurity.securityType && (
                  <div>
                    <div className="text-xs text-gray-400 dark:text-gray-500 uppercase">Type</div>
                    <div className="text-sm font-medium text-gray-700 dark:text-gray-300">{selectedSecurity.securityType}</div>
                  </div>
                )}
                {selectedSecurity.currencyCode && (
                  <div>
                    <div className="text-xs text-gray-400 dark:text-gray-500 uppercase">Currency</div>
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
                <div className="text-sm text-gray-500 dark:text-gray-400">Current Value</div>
                <div className="text-xl font-bold text-gray-900 dark:text-gray-100">
                  {formatCurrencyFull(stats.currentValue, displayCurrency)}
                </div>
                <div className="text-xs text-gray-400 dark:text-gray-500 mt-1">
                  {stats.quantity} shares @ {formatCurrencyFull(stats.currentPrice ?? 0, displayCurrency)}
                  {stats.accountCount > 1 && (
                    <span className="ml-1">across {stats.accountCount} accounts</span>
                  )}
                </div>
              </div>
              <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
                <div className="text-sm text-gray-500 dark:text-gray-400">Cost Basis</div>
                <div className="text-xl font-bold text-gray-900 dark:text-gray-100">
                  {formatCurrencyFull(stats.costBasis, displayCurrency)}
                </div>
                <div className="text-xs text-gray-400 dark:text-gray-500 mt-1">
                  Avg cost: {formatCurrencyFull(stats.averageCost, displayCurrency)}
                </div>
              </div>
              <div className={`rounded-lg shadow p-4 ${stats.totalReturn >= 0 ? 'bg-green-50 dark:bg-green-900/20' : 'bg-red-50 dark:bg-red-900/20'}`}>
                <div className={`text-sm ${stats.totalReturn >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                  Total Return
                </div>
                <div className={`text-xl font-bold ${stats.totalReturn >= 0 ? 'text-green-700 dark:text-green-300' : 'text-red-700 dark:text-red-300'}`}>
                  {stats.totalReturn >= 0 ? '+' : ''}{formatCurrencyFull(stats.totalReturn, displayCurrency)}
                </div>
                <div className={`text-xs mt-1 ${stats.totalReturn >= 0 ? 'text-green-500 dark:text-green-400' : 'text-red-500 dark:text-red-400'}`}>
                  {formatSignedPercent(stats.totalReturnPercent)}
                </div>
              </div>
              <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
                <div className="text-sm text-gray-500 dark:text-gray-400">Annualized Return</div>
                <div className={`text-xl font-bold ${stats.annualizedReturn !== null ? (stats.annualizedReturn >= 0 ? 'text-green-700 dark:text-green-300' : 'text-red-700 dark:text-red-300') : 'text-gray-400'}`}>
                  {stats.annualizedReturn !== null
                    ? formatSignedPercent(stats.annualizedReturn)
                    : '-'}
                </div>
                {stats.annualizedReturn === null && (
                  <div className="text-xs text-gray-400 dark:text-gray-500 mt-1">Needs 1+ year of data</div>
                )}
              </div>
            </div>
          )}

          {viewType === 'chart' ? (
            /* Price Chart */
            <div ref={chartRef} className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 px-2 py-4 sm:p-6">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
                Price History - {selectedSecurity?.symbol}
              </h3>
              {chartData.length > 0 ? (
                <div className="h-80">
                  <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                    <AreaChart data={chartData}>
                      <defs>
                        <linearGradient id="priceGradient" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                          <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                      <XAxis
                        dataKey="label"
                        tick={{ fontSize: 11 }}
                        interval="preserveStartEnd"
                        tickCount={8}
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
                                Close: {formatCurrencyFull(d.close, displayCurrency)}
                              </p>
                              {d.buyMarker && <p className="text-sm text-green-600 dark:text-green-400">Buy transaction</p>}
                              {d.sellMarker && <p className="text-sm text-red-600 dark:text-red-400">Sell transaction</p>}
                            </div>
                          );
                        }}
                      />
                      <Area
                        type="monotone"
                        dataKey="close"
                        stroke="#3b82f6"
                        fill="url(#priceGradient)"
                        strokeWidth={2}
                      />
                      {/* Buy markers */}
                      <Area
                        type="monotone"
                        dataKey="buyMarker"
                        stroke="none"
                        fill="none"
                        dot={{ r: 6, fill: '#22c55e', stroke: '#fff', strokeWidth: 2 }}
                        activeDot={false}
                        connectNulls={false}
                      />
                      {/* Sell markers */}
                      <Area
                        type="monotone"
                        dataKey="sellMarker"
                        stroke="none"
                        fill="none"
                        dot={{ r: 6, fill: '#ef4444', stroke: '#fff', strokeWidth: 2 }}
                        activeDot={false}
                        connectNulls={false}
                      />
                      {stats && stats.averageCost > 0 && (
                        <ReferenceLine
                          y={stats.averageCost}
                          stroke="#f97316"
                          strokeDasharray="4 4"
                          label={{ value: 'Avg Cost', position: 'right', fill: '#f97316', fontSize: 11 }}
                        />
                      )}
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <p className="text-gray-500 dark:text-gray-400 text-center py-8">No price history available.</p>
              )}
            </div>
          ) : viewType === 'transactions' ? (
            /* Transaction History */
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
              <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
                <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                  Transaction History - {selectedSecurity?.symbol}
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
                          Date
                        </SortableHeader>
                        <SortableHeader<TradeSortField>
                          field="account"
                          sortField={tradeSort.sortField}
                          sortDirection={tradeSort.sortDirection}
                          onSort={tradeSort.handleSort}
                          className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                        >
                          Account
                        </SortableHeader>
                        <SortableHeader<TradeSortField>
                          field="action"
                          sortField={tradeSort.sortField}
                          sortDirection={tradeSort.sortDirection}
                          onSort={tradeSort.handleSort}
                          className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                        >
                          Action
                        </SortableHeader>
                        <SortableHeader<TradeSortField>
                          field="shares"
                          sortField={tradeSort.sortField}
                          sortDirection={tradeSort.sortDirection}
                          onSort={tradeSort.handleSort}
                          align="right"
                          className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                        >
                          Shares
                        </SortableHeader>
                        <SortableHeader<TradeSortField>
                          field="price"
                          sortField={tradeSort.sortField}
                          sortDirection={tradeSort.sortDirection}
                          onSort={tradeSort.handleSort}
                          align="right"
                          className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                        >
                          Price
                        </SortableHeader>
                        <SortableHeader<TradeSortField>
                          field="total"
                          sortField={tradeSort.sortField}
                          sortDirection={tradeSort.sortDirection}
                          onSort={tradeSort.handleSort}
                          align="right"
                          className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                        >
                          Total
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
                <div className="p-6 text-center text-gray-500 dark:text-gray-400">No transactions found.</div>
              )}
            </div>
          ) : (
            /* Dividend History */
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
              <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
                <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                  Dividend History - {selectedSecurity?.symbol}
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
                          Date
                        </SortableHeader>
                        <SortableHeader<DividendSortField>
                          field="account"
                          sortField={dividendSort.sortField}
                          sortDirection={dividendSort.sortDirection}
                          onSort={dividendSort.handleSort}
                          className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                        >
                          Account
                        </SortableHeader>
                        <SortableHeader<DividendSortField>
                          field="type"
                          sortField={dividendSort.sortField}
                          sortDirection={dividendSort.sortDirection}
                          onSort={dividendSort.handleSort}
                          className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                        >
                          Type
                        </SortableHeader>
                        <SortableHeader<DividendSortField>
                          field="amount"
                          sortField={dividendSort.sortField}
                          sortDirection={dividendSort.sortDirection}
                          onSort={dividendSort.handleSort}
                          align="right"
                          className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                        >
                          Amount
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
                          Total Dividends
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
                <div className="p-6 text-center text-gray-500 dark:text-gray-400">No dividend history found.</div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
