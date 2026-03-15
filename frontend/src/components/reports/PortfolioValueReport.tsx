'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { format } from 'date-fns';
import { netWorthApi } from '@/lib/net-worth';
import { investmentsApi } from '@/lib/investments';
import { PortfolioSummary } from '@/types/investment';
import { Account } from '@/types/account';
import { parseLocalDate } from '@/lib/utils';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { useDateRange } from '@/hooks/useDateRange';
import { DateRangeSelector } from '@/components/ui/DateRangeSelector';
import { createLogger } from '@/lib/logger';

const logger = createLogger('PortfolioValueReport');

const DAILY_RANGES = new Set(['1w', '1m', '3m', 'ytd', '1y']);

function CustomTooltip({ active, payload, fmtFull }: {
  active?: boolean;
  payload?: Array<{ value: number; payload: { name: string } }>;
  fmtFull: (v: number) => string;
}) {
  if (!active || !payload?.length) return null;
  const data = payload[0]?.payload;
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
      <p className="font-medium text-gray-900 dark:text-gray-100 mb-1">{data?.name}</p>
      <p className="text-sm text-emerald-600 dark:text-emerald-400">
        Portfolio: {fmtFull(payload[0].value)}
      </p>
    </div>
  );
}

export function PortfolioValueReport() {
  const { formatCurrencyCompact, formatCurrencyAxis, formatCurrency: formatCurrencyFull } = useNumberFormat();
  const { defaultCurrency } = useExchangeRates();
  const [chartPoints, setChartPoints] = useState<Array<{ name: string; Value: number }>>([]);
  const [portfolio, setPortfolio] = useState<PortfolioSummary | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>('');
  const [isLoading, setIsLoading] = useState(true);
  const { dateRange, setDateRange, resolvedRange, isValid } = useDateRange({ defaultRange: '2y', alignment: 'month' });

  const useDaily = DAILY_RANGES.has(dateRange);

  const selectedAccount = accounts.find((a) => a.id === selectedAccountId);
  const foreignCurrency = selectedAccount?.currencyCode && selectedAccount.currencyCode !== defaultCurrency
    ? selectedAccount.currencyCode
    : null;

  const fmtVal = useCallback((value: number) => {
    if (foreignCurrency) return `${formatCurrencyCompact(value, foreignCurrency)} ${foreignCurrency}`;
    return formatCurrencyCompact(value);
  }, [foreignCurrency, formatCurrencyCompact]);

  const fmtFull = useCallback((value: number) => {
    if (foreignCurrency) return `${formatCurrencyFull(value, foreignCurrency)} ${foreignCurrency}`;
    return formatCurrencyFull(value);
  }, [foreignCurrency, formatCurrencyFull]);

  const fmtAxis = useCallback((value: number) => {
    if (foreignCurrency) return formatCurrencyAxis(value, foreignCurrency);
    return formatCurrencyAxis(value);
  }, [foreignCurrency, formatCurrencyAxis]);

  useEffect(() => {
    if (!isValid) return;
    const loadData = async () => {
      setIsLoading(true);
      try {
        const { start, end } = resolvedRange;
        const accountIds = selectedAccountId ? [selectedAccountId] : undefined;

        const params = {
          startDate: start,
          endDate: end,
          accountIds: accountIds?.join(','),
          displayCurrency: foreignCurrency || undefined,
        };

        const [investmentResult, portfolioResult, accountsResult] = await Promise.all([
          useDaily
            ? netWorthApi.getInvestmentsDaily(params)
            : netWorthApi.getInvestmentsMonthly(params),
          investmentsApi.getPortfolioSummary(accountIds),
          investmentsApi.getInvestmentAccounts(),
        ]);

        if (useDaily) {
          const dailyData = investmentResult as Array<{ date: string; value: number }>;
          setChartPoints(dailyData.map((d) => ({
            name: format(parseLocalDate(d.date), 'MMM d, yyyy'),
            Value: d.value,
          })));
        } else {
          const monthlyData = investmentResult as Array<{ month: string; value: number }>;
          setChartPoints(monthlyData.map((d) => ({
            name: format(parseLocalDate(d.month), 'MMM yyyy'),
            Value: d.value,
          })));
        }

        setPortfolio(portfolioResult);
        setAccounts(accountsResult);
      } catch (error) {
        logger.error('Failed to load portfolio data:', error);
      } finally {
        setIsLoading(false);
      }
    };
    loadData();
  }, [selectedAccountId, resolvedRange, isValid, foreignCurrency, useDaily]);

  const summary = useMemo(() => {
    if (chartPoints.length === 0) return { current: 0, initial: 0, change: 0, changePercent: 0, high: 0, low: 0 };
    const current = chartPoints[chartPoints.length - 1]?.Value || 0;
    const initial = chartPoints[0]?.Value || 0;
    const change = current - initial;
    const changePercent = initial !== 0 ? (change / Math.abs(initial)) * 100 : 0;
    const values = chartPoints.map((d) => d.Value);
    const high = Math.max(...values);
    const low = Math.min(...values);
    return { current, initial, change, changePercent, high, low };
  }, [chartPoints]);

  const xAxisTicks = useMemo(() => {
    if (chartPoints.length <= 36) return undefined;
    if (useDaily) {
      const step = Math.ceil(chartPoints.length / 7);
      return chartPoints.filter((_, i) => i % step === 0).map(d => d.name);
    }
    return chartPoints
      .filter((d) => d.name.startsWith('Jan '))
      .map((d) => d.name);
  }, [chartPoints, useDaily]);

  const yAxisDomain = useMemo(() => {
    if (chartPoints.length === 0) return [0, 'auto'] as [number, 'auto'];

    const values = chartPoints.map((d) => d.Value);
    const minValue = Math.min(...values);
    const maxValue = Math.max(...values);
    const range = maxValue - minValue;

    if (minValue > 0 && minValue > range * 0.2) {
      const padding = range * 0.1;
      const rawMin = minValue - padding;
      const magnitude = Math.pow(10, Math.floor(Math.log10(Math.abs(rawMin))));
      const niceMin = Math.floor(rawMin / magnitude) * magnitude;
      return [niceMin, 'auto'] as [number, 'auto'];
    }

    return [Math.min(0, minValue), 'auto'] as [number, 'auto'];
  }, [chartPoints]);

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
          <div className="text-sm text-gray-500 dark:text-gray-400">Current Value</div>
          <div className="text-xl font-bold text-gray-900 dark:text-gray-100">
            {fmtVal(summary.current)}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">Period Change</div>
          <div className={`text-xl font-bold ${summary.change >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
            {summary.change >= 0 ? '+' : ''}{fmtVal(summary.change)}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">Period Return</div>
          <div className={`text-xl font-bold ${summary.changePercent >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
            {summary.changePercent >= 0 ? '+' : ''}{summary.changePercent.toFixed(1)}%
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">Period High / Low</div>
          <div className="text-sm font-bold text-gray-900 dark:text-gray-100">
            <span className="text-green-600 dark:text-green-400">{fmtVal(summary.high)}</span>
            {' / '}
            <span className="text-red-600 dark:text-red-400">{fmtVal(summary.low)}</span>
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
              ranges={['1w', '1m', '3m', 'ytd', '1y', '2y', '5y', 'all']}
              value={dateRange}
              onChange={setDateRange}
              activeColour="bg-emerald-600"
            />
          </div>
        </div>
      </div>

      {/* Chart */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 px-2 py-4 sm:p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          Portfolio Value Over Time
        </h3>
        {chartPoints.length === 0 ? (
          <p className="text-gray-500 dark:text-gray-400 text-center py-8">
            No investment data for this period.
          </p>
        ) : (
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartPoints} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="colorPortfolioValue" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#10b981" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis
                  dataKey="name"
                  tick={{ fontSize: 12 }}
                  {...(xAxisTicks ? { ticks: xAxisTicks } : {})}
                  tickFormatter={(value: string) => {
                    if (useDaily) {
                      const parts = value.split(', ');
                      return parts[0] || value;
                    }
                    if (chartPoints.length > 36) {
                      return value.split(' ')[1] || value;
                    } else if (chartPoints.length > 18) {
                      const parts = value.split(' ');
                      return parts.length === 2 ? `${parts[0]} '${parts[1].slice(2)}` : value;
                    }
                    return value.split(' ')[0];
                  }}
                />
                <YAxis
                  domain={yAxisDomain}
                  tickFormatter={fmtAxis}
                  tick={{ fontSize: 12 }}
                />
                <Tooltip content={<CustomTooltip fmtFull={fmtFull} />} />
                <Area
                  type="monotone"
                  dataKey="Value"
                  stroke="#10b981"
                  strokeWidth={2}
                  fillOpacity={1}
                  fill="url(#colorPortfolioValue)"
                  name="Portfolio Value"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* Portfolio Breakdown */}
      {portfolio && portfolio.holdingsByAccount.length > 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              Current Portfolio Breakdown
            </h3>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
              <thead className="bg-gray-50 dark:bg-gray-900/50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                    Account
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                    Holdings
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                    Cash
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                    Total
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                    Gain/Loss
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                {portfolio.holdingsByAccount.map((acct) => (
                  <tr key={acct.accountId} className="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                    <td className="px-4 py-3 font-medium text-gray-900 dark:text-gray-100">
                      {acct.accountName}
                    </td>
                    <td className="px-4 py-3 text-right text-sm text-gray-900 dark:text-gray-100">
                      {fmtFull(acct.totalMarketValue)}
                    </td>
                    <td className="px-4 py-3 text-right text-sm text-gray-900 dark:text-gray-100">
                      {fmtFull(acct.cashBalance)}
                    </td>
                    <td className="px-4 py-3 text-right text-sm font-medium text-gray-900 dark:text-gray-100">
                      {fmtFull(acct.totalMarketValue + acct.cashBalance)}
                    </td>
                    <td className={`px-4 py-3 text-right text-sm font-medium ${acct.totalGainLoss >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                      {acct.totalGainLoss >= 0 ? '+' : ''}{fmtFull(acct.totalGainLoss)}
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
