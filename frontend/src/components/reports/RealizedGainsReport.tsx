'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
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
import { investmentsApi } from '@/lib/investments';
import { InvestmentTransaction } from '@/types/investment';
import { Account } from '@/types/account';
import { parseLocalDate } from '@/lib/utils';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { useDateRange } from '@/hooks/useDateRange';
import { DateRangeSelector } from '@/components/ui/DateRangeSelector';
import { createLogger } from '@/lib/logger';

const logger = createLogger('RealizedGainsReport');

const MAX_PAGES = 50;

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
      <p className={`text-sm ${value >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
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
  const { formatCurrency: formatCurrencyFull, formatCurrencyAxis } = useNumberFormat();
  const { defaultCurrency, convertToDefault } = useExchangeRates();
  const [transactions, setTransactions] = useState<InvestmentTransaction[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>('');
  const { dateRange, setDateRange, resolvedRange, isValid } = useDateRange({ defaultRange: '1y', alignment: 'month' });
  const [isLoading, setIsLoading] = useState(true);
  const [viewType, setViewType] = useState<'chart' | 'table'>('chart');

  const accountCurrencyMap = useMemo(() => {
    const map = new Map<string, string>();
    accounts.forEach((a) => map.set(a.id, a.currencyCode));
    return map;
  }, [accounts]);

  const selectedAccount = accounts.find((a) => a.id === selectedAccountId);
  const displayCurrency = selectedAccount?.currencyCode || defaultCurrency;
  const isForeign = displayCurrency !== defaultCurrency;

  const getTxAmount = useCallback((amount: number, accountId: string): number => {
    if (selectedAccountId) return amount;
    const txCurrency = accountCurrencyMap.get(accountId) || defaultCurrency;
    return convertToDefault(amount, txCurrency);
  }, [selectedAccountId, accountCurrencyMap, defaultCurrency, convertToDefault]);

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

  useEffect(() => {
    if (!isValid) return;
    const loadData = async () => {
      setIsLoading(true);
      try {
        const { start, end } = resolvedRange;
        const allTransactions: InvestmentTransaction[] = [];
        let page = 1;
        let hasMore = true;
        while (hasMore && page <= MAX_PAGES) {
          const result = await investmentsApi.getTransactions({
            accountIds: selectedAccountId || undefined,
            startDate: start || undefined,
            endDate: end,
            action: 'SELL',
            limit: 200,
            page,
          });
          allTransactions.push(...result.data);
          hasMore = result.pagination.hasMore;
          page++;
        }

        setTransactions(allTransactions);
      } catch (error) {
        logger.error('Failed to load sell transactions:', error);
      } finally {
        setIsLoading(false);
      }
    };
    loadData();
  }, [selectedAccountId, resolvedRange, isValid]);

  const securityGains = useMemo((): SecurityGain[] => {
    const map = new Map<string, SecurityGain>();

    transactions.forEach((tx) => {
      const symbol = tx.security?.symbol || 'Unknown';
      const name = tx.security?.name || 'Unknown Security';

      let entry = map.get(symbol);
      if (!entry) {
        entry = {
          symbol,
          name,
          totalProceeds: 0,
          totalCostBasis: 0,
          realizedGain: 0,
          transactionCount: 0,
        };
        map.set(symbol, entry);
      }

      const proceeds = getTxAmount(Math.abs(tx.totalAmount), tx.accountId);
      const costBasis = tx.quantity && tx.price
        ? getTxAmount(Math.abs(tx.quantity) * Math.abs(tx.price), tx.accountId)
        : proceeds;

      entry.totalProceeds += proceeds;
      entry.totalCostBasis += costBasis;
      entry.realizedGain += proceeds - costBasis;
      entry.transactionCount += 1;
    });

    return Array.from(map.values()).sort((a, b) => b.realizedGain - a.realizedGain);
  }, [transactions, getTxAmount]);

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

  const sortedTransactions = useMemo(
    () => [...transactions].sort((a, b) => b.transactionDate.localeCompare(a.transactionDate)),
    [transactions],
  );

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
      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">Total Proceeds</div>
          <div className="text-xl font-bold text-gray-900 dark:text-gray-100">
            {fmtValue(totals.totalProceeds)}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">Cost Basis</div>
          <div className="text-xl font-bold text-gray-900 dark:text-gray-100">
            {fmtValue(totals.totalCostBasis)}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">Realized Gain/Loss</div>
          <div className={`text-xl font-bold ${totals.totalGain >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
            {totals.totalGain >= 0 ? '+' : ''}{fmtValue(totals.totalGain)}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">Securities Sold</div>
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
        <div className="flex flex-wrap gap-4 items-center justify-between">
          <div className="flex flex-wrap gap-2 items-center">
            <select
              value={selectedAccountId}
              onChange={(e) => setSelectedAccountId(e.target.value)}
              className="rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 text-sm"
            >
              <option value="">All Accounts</option>
              {accounts
                .filter((a) => a.accountSubType !== 'INVESTMENT_BROKERAGE')
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name.replace(/ - (Brokerage|Cash)$/, '')}
                  </option>
                ))}
            </select>
            <DateRangeSelector
              ranges={['6m', '1y', '2y', 'all']}
              value={dateRange}
              onChange={setDateRange}
            />
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setViewType('chart')}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                viewType === 'chart'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
              }`}
            >
              Chart
            </button>
            <button
              onClick={() => setViewType('table')}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                viewType === 'table'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
              }`}
            >
              Table
            </button>
          </div>
        </div>
      </div>

      {transactions.length === 0 ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <p className="text-gray-500 dark:text-gray-400 text-center py-8">
            No sell transactions found for this period.
          </p>
        </div>
      ) : viewType === 'chart' ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 px-2 py-4 sm:p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
            Realized Gains by Security
          </h3>
          {chartData.length === 0 ? (
            <p className="text-gray-500 dark:text-gray-400 text-center py-8">
              No gains or losses to display.
            </p>
          ) : (
            <div className="h-80">
              <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                <BarChart data={chartData} layout="vertical" margin={{ left: 0, right: 10 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis type="number" tickFormatter={formatCurrencyAxis} />
                  <YAxis type="category" dataKey="symbol" width={60} tick={{ fontSize: 12 }} />
                  <Tooltip content={<CustomTooltip fmtValue={fmtValue} />} />
                  <Bar
                    dataKey="gain"
                    name="Realized Gain"
                    fill="#22c55e"
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
              Realized Gains Detail
            </h3>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
              <thead className="bg-gray-50 dark:bg-gray-900/50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                    Security
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                    Trades
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                    Proceeds
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                    Cost Basis
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                    Gain/Loss
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                {securityGains.map((sg) => (
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
                    <td className={`px-4 py-3 text-right text-sm font-medium ${sg.realizedGain >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                      {sg.realizedGain >= 0 ? '+' : ''}{fmtValue(sg.realizedGain)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-gray-50 dark:bg-gray-900/50">
                <tr>
                  <td className="px-4 py-3 font-semibold text-gray-900 dark:text-gray-100">
                    Total
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
                  <td className={`px-4 py-3 text-right text-sm font-bold ${totals.totalGain >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                    {totals.totalGain >= 0 ? '+' : ''}{fmtValue(totals.totalGain)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* Individual Transactions */}
      {transactions.length > 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              Sell Transactions ({transactions.length})
            </h3>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
              <thead className="bg-gray-50 dark:bg-gray-900/50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                    Date
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                    Security
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                    Shares
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                    Price
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                    Total
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                {sortedTransactions.map((tx) => (
                  <tr key={tx.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                    <td className="px-4 py-3 text-sm text-gray-900 dark:text-gray-100">
                      {format(parseLocalDate(tx.transactionDate), 'MMM d, yyyy')}
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-sm text-gray-900 dark:text-gray-100">
                        {tx.security?.symbol || 'N/A'}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right text-sm text-gray-900 dark:text-gray-100">
                      {tx.quantity != null ? Math.abs(tx.quantity).toFixed(4) : '-'}
                    </td>
                    <td className="px-4 py-3 text-right text-sm text-gray-900 dark:text-gray-100">
                      {tx.price != null ? fmtValue(tx.price) : '-'}
                    </td>
                    <td className="px-4 py-3 text-right text-sm font-medium text-gray-900 dark:text-gray-100">
                      {fmtValue(Math.abs(tx.totalAmount))}
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
