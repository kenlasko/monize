'use client';

import { useState, useEffect, useMemo } from 'react';
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
import { parseLocalDate } from '@/lib/utils';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { createLogger } from '@/lib/logger';

const logger = createLogger('SecurityPerformanceReport');

const MAX_PAGES = 50;

interface PriceChartPoint {
  date: string;
  label: string;
  close: number;
  buyMarker?: number;
  sellMarker?: number;
}

export function SecurityPerformanceReport() {
  const { formatCurrency: formatCurrencyFull, formatCurrencyAxis } = useNumberFormat();
  const { defaultCurrency } = useExchangeRates();
  const [securities, setSecurities] = useState<Security[]>([]);
  const [selectedSecurityId, setSelectedSecurityId] = useState<string>('');
  const [prices, setPrices] = useState<SecurityPrice[]>([]);
  const [transactions, setTransactions] = useState<InvestmentTransaction[]>([]);
  const [holdings, setHoldings] = useState<HoldingWithMarketValue[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [viewType, setViewType] = useState<'chart' | 'transactions' | 'dividends'>('chart');

  // Load securities on mount
  useEffect(() => {
    const load = async () => {
      try {
        const [secs, summary] = await Promise.all([
          investmentsApi.getSecurities(),
          investmentsApi.getPortfolioSummary(),
        ]);
        setSecurities(secs.filter((s) => s.isActive));
        setHoldings(summary.holdings);
      } catch (error) {
        logger.error('Failed to load securities:', error);
      } finally {
        setIsLoading(false);
      }
    };
    load();
  }, []);

  const selectedSecurity = securities.find((s) => s.id === selectedSecurityId);

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
  }, [selectedSecurityId, securities]);
  const selectedHolding = holdings.find((h) => h.securityId === selectedSecurityId);

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
  const dividendTx = useMemo(
    () => transactions
      .filter((tx) => tx.action === 'DIVIDEND' || tx.action === 'REINVEST')
      .sort((a, b) => b.transactionDate.localeCompare(a.transactionDate)),
    [transactions],
  );

  // Transaction history (non-dividend)
  const tradeTx = useMemo(
    () => transactions
      .filter((tx) => tx.action !== 'DIVIDEND' && tx.action !== 'INTEREST' && tx.action !== 'CAPITAL_GAIN')
      .sort((a, b) => b.transactionDate.localeCompare(a.transactionDate)),
    [transactions],
  );

  const displayCurrency = selectedSecurity?.currencyCode || defaultCurrency;

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
          {selectedSecurityId && (
            <div className="flex gap-2">
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
            </div>
          )}
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
                  {stats.totalReturnPercent >= 0 ? '+' : ''}{stats.totalReturnPercent.toFixed(2)}%
                </div>
              </div>
              <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
                <div className="text-sm text-gray-500 dark:text-gray-400">Annualized Return</div>
                <div className={`text-xl font-bold ${stats.annualizedReturn !== null ? (stats.annualizedReturn >= 0 ? 'text-green-700 dark:text-green-300' : 'text-red-700 dark:text-red-300') : 'text-gray-400'}`}>
                  {stats.annualizedReturn !== null
                    ? `${stats.annualizedReturn >= 0 ? '+' : ''}${stats.annualizedReturn.toFixed(2)}%`
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
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 px-2 py-4 sm:p-6">
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
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Date</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Action</th>
                        <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Shares</th>
                        <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Price</th>
                        <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Total</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                      {tradeTx.map((tx) => (
                        <tr key={tx.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                          <td className="px-4 py-3 text-sm text-gray-900 dark:text-gray-100">
                            {format(parseLocalDate(tx.transactionDate), 'MMM d, yyyy')}
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
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Date</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Type</th>
                        <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">Amount</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                      {dividendTx.map((tx) => (
                        <tr key={tx.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                          <td className="px-4 py-3 text-sm text-gray-900 dark:text-gray-100">
                            {format(parseLocalDate(tx.transactionDate), 'MMM d, yyyy')}
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
                        <td className="px-4 py-3 text-sm font-bold text-gray-900 dark:text-gray-100" colSpan={2}>
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
