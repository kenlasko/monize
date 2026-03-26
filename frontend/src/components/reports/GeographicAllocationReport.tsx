'use client';

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Legend,
} from 'recharts';
import { investmentsApi } from '@/lib/investments';
import { HoldingWithMarketValue, Security } from '@/types/investment';
import { Account } from '@/types/account';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { createLogger } from '@/lib/logger';

const logger = createLogger('GeographicAllocationReport');

const EXCHANGE_TO_REGION: Record<string, { country: string; region: string }> = {
  NYSE: { country: 'United States', region: 'North America' },
  NASDAQ: { country: 'United States', region: 'North America' },
  NMS: { country: 'United States', region: 'North America' },
  NYQ: { country: 'United States', region: 'North America' },
  NYSEARCA: { country: 'United States', region: 'North America' },
  AMEX: { country: 'United States', region: 'North America' },
  BATS: { country: 'United States', region: 'North America' },
  TSX: { country: 'Canada', region: 'North America' },
  TSXV: { country: 'Canada', region: 'North America' },
  TOR: { country: 'Canada', region: 'North America' },
  NEO: { country: 'Canada', region: 'North America' },
  LSE: { country: 'United Kingdom', region: 'Europe' },
  LON: { country: 'United Kingdom', region: 'Europe' },
  FRA: { country: 'Germany', region: 'Europe' },
  XETRA: { country: 'Germany', region: 'Europe' },
  PAR: { country: 'France', region: 'Europe' },
  AMS: { country: 'Netherlands', region: 'Europe' },
  MIL: { country: 'Italy', region: 'Europe' },
  STO: { country: 'Sweden', region: 'Europe' },
  TYO: { country: 'Japan', region: 'Asia-Pacific' },
  HKG: { country: 'Hong Kong', region: 'Asia-Pacific' },
  SHA: { country: 'China', region: 'Asia-Pacific' },
  SHE: { country: 'China', region: 'Asia-Pacific' },
  ASX: { country: 'Australia', region: 'Asia-Pacific' },
  KRX: { country: 'South Korea', region: 'Asia-Pacific' },
  TAI: { country: 'Taiwan', region: 'Asia-Pacific' },
  SGX: { country: 'Singapore', region: 'Asia-Pacific' },
  BSE: { country: 'India', region: 'Asia-Pacific' },
  NSE: { country: 'India', region: 'Asia-Pacific' },
};

const REGION_COLOURS: Record<string, string> = {
  'North America': '#3b82f6',
  'Europe': '#22c55e',
  'Asia-Pacific': '#f97316',
  'Other': '#8b5cf6',
};

const COUNTRY_COLOURS = [
  '#3b82f6', '#22c55e', '#f97316', '#8b5cf6', '#ec4899',
  '#14b8a6', '#eab308', '#ef4444', '#06b6d4', '#a855f7',
];

interface ExchangeAllocation {
  exchange: string;
  country: string;
  region: string;
  count: number;
  marketValue: number;
  percentage: number;
}

interface RegionAllocation {
  region: string;
  marketValue: number;
  percentage: number;
  count: number;
  color: string;
}

function CustomTooltip({ active, payload, formatCurrencyFull }: {
  active?: boolean;
  payload?: Array<{ payload: RegionAllocation | ExchangeAllocation }>;
  formatCurrencyFull: (v: number) => string;
}) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  const label = 'region' in d && !('exchange' in d) ? (d as RegionAllocation).region : (d as ExchangeAllocation).exchange;
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
      <p className="font-medium text-gray-900 dark:text-gray-100">{label}</p>
      <p className="text-sm text-gray-600 dark:text-gray-400">
        {formatCurrencyFull(d.marketValue)} ({('percentage' in d ? d.percentage : 0).toFixed(1)}%)
      </p>
      <p className="text-sm text-gray-500 dark:text-gray-400">{d.count} holding{d.count !== 1 ? 's' : ''}</p>
    </div>
  );
}

export function GeographicAllocationReport() {
  const { formatCurrencyCompact: formatCurrency, formatCurrency: formatCurrencyFull, formatCurrencyAxis } = useNumberFormat();
  const { defaultCurrency, convertToDefault } = useExchangeRates();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [holdings, setHoldings] = useState<HoldingWithMarketValue[]>([]);
  const [securities, setSecurities] = useState<Security[]>([]);
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
  const [viewType, setViewType] = useState<'region' | 'exchange'>('region');
  const [isLoading, setIsLoading] = useState(true);
  const [showAccountFilter, setShowAccountFilter] = useState(false);
  const accountFilterRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (showAccountFilter && accountFilterRef.current && !accountFilterRef.current.contains(e.target as Node)) {
        setShowAccountFilter(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showAccountFilter]);

  // Fetch accounts and securities once on mount (static data)
  useEffect(() => {
    Promise.all([
      investmentsApi.getInvestmentAccounts(),
      investmentsApi.getSecurities(),
    ])
      .then(([accountsData, securitiesData]) => {
        setAccounts(accountsData);
        setSecurities(securitiesData);
      })
      .catch((error) => logger.error('Failed to load static data:', error));
  }, []);

  const loadData = useCallback(async () => {
    setIsLoading(true);
    try {
      const summaryData = await investmentsApi.getPortfolioSummary(
        selectedAccountIds.length > 0 ? selectedAccountIds : undefined,
      );
      setHoldings(summaryData.holdings);
    } catch (error) {
      logger.error('Failed to load data:', error);
    } finally {
      setIsLoading(false);
    }
  }, [selectedAccountIds]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const toggleAccountId = (id: string) => {
    setSelectedAccountIds((prev) =>
      prev.includes(id) ? prev.filter((a) => a !== id) : [...prev, id],
    );
  };

  const securityExchangeMap = useMemo(() => {
    const map = new Map<string, string>();
    securities.forEach((s) => {
      if (s.exchange) map.set(s.id, s.exchange);
    });
    return map;
  }, [securities]);

  const { exchangeData, regionData, totalValue } = useMemo(() => {
    const exchangeMap = new Map<string, { country: string; region: string; count: number; value: number }>();

    holdings.forEach((h) => {
      const exchange = securityExchangeMap.get(h.securityId) || 'Unknown';
      const info = EXCHANGE_TO_REGION[exchange] || { country: 'Other', region: 'Other' };
      const marketValue = convertToDefault(h.marketValue ?? 0, h.currencyCode);

      const existing = exchangeMap.get(exchange) || { country: info.country, region: info.region, count: 0, value: 0 };
      exchangeMap.set(exchange, {
        ...existing,
        count: existing.count + 1,
        value: existing.value + marketValue,
      });
    });

    const total = Array.from(exchangeMap.values()).reduce((sum, v) => sum + v.value, 0);

    const exchanges: ExchangeAllocation[] = Array.from(exchangeMap.entries())
      .map(([exchange, data]) => ({
        exchange,
        country: data.country,
        region: data.region,
        count: data.count,
        marketValue: data.value,
        percentage: total > 0 ? (data.value / total) * 100 : 0,
      }))
      .sort((a, b) => b.marketValue - a.marketValue);

    const regionMap = new Map<string, { value: number; count: number }>();
    exchanges.forEach((e) => {
      const existing = regionMap.get(e.region) || { value: 0, count: 0 };
      regionMap.set(e.region, {
        value: existing.value + e.marketValue,
        count: existing.count + e.count,
      });
    });

    const regions: RegionAllocation[] = Array.from(regionMap.entries())
      .map(([region, data]) => ({
        region,
        marketValue: data.value,
        percentage: total > 0 ? (data.value / total) * 100 : 0,
        count: data.count,
        color: REGION_COLOURS[region] || '#6b7280',
      }))
      .sort((a, b) => b.marketValue - a.marketValue);

    return { exchangeData: exchanges, regionData: regions, totalValue: total };
  }, [holdings, convertToDefault, securityExchangeMap]);

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <div className="animate-pulse space-y-4">
            <div className="h-8 bg-gray-200 dark:bg-gray-700 rounded w-1/3" />
            <div className="h-64 bg-gray-200 dark:bg-gray-700 rounded" />
          </div>
        </div>
      </div>
    );
  }

  if (holdings.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-8 text-center">
        <p className="text-gray-500 dark:text-gray-400">
          No investment holdings found. Add securities to see geographic allocation.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Filters & View Toggle */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex flex-wrap gap-3 items-center justify-between">
          <div className="flex flex-wrap gap-3">
            <div className="relative" ref={accountFilterRef}>
              <button
                onClick={() => setShowAccountFilter(!showAccountFilter)}
                className="px-4 py-2 text-sm font-medium rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
              >
                Accounts{selectedAccountIds.length > 0 ? ` (${selectedAccountIds.length})` : ''}
              </button>
              {showAccountFilter && (
                <div className="absolute top-full left-0 mt-1 w-64 bg-white dark:bg-gray-800 rounded-lg shadow-lg dark:shadow-gray-700/50 border border-gray-200 dark:border-gray-700 z-10 max-h-60 overflow-y-auto">
                  <div className="p-2">
                    {accounts.filter((a) => a.accountSubType !== 'INVESTMENT_CASH').length === 0 ? (
                      <p className="text-sm text-gray-500 dark:text-gray-400 p-2">No investment accounts</p>
                    ) : (
                      accounts.filter((a) => a.accountSubType !== 'INVESTMENT_CASH').map((acct) => (
                        <label
                          key={acct.id}
                          className="flex items-center gap-2 p-2 hover:bg-gray-50 dark:hover:bg-gray-700 rounded cursor-pointer"
                        >
                          <input
                            type="checkbox"
                            checked={selectedAccountIds.includes(acct.id)}
                            onChange={() => toggleAccountId(acct.id)}
                            className="rounded border-gray-300 dark:border-gray-600"
                          />
                          <span className="text-sm text-gray-700 dark:text-gray-300 truncate">
                            {acct.name}
                          </span>
                        </label>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>
            {selectedAccountIds.length > 0 && (
              <button
                onClick={() => setSelectedAccountIds([])}
                className="px-4 py-2 text-sm font-medium rounded-lg text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
              >
                Clear Filters
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setViewType('region')}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                viewType === 'region'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
              }`}
            >
              By Region
            </button>
            <button
              onClick={() => setViewType('exchange')}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                viewType === 'exchange'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
              }`}
            >
              By Exchange
            </button>
          </div>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 sm:gap-4">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-4">
          <p className="text-xs sm:text-sm text-gray-500 dark:text-gray-400">Total Portfolio</p>
          <p className="text-lg sm:text-xl font-bold text-gray-900 dark:text-gray-100">
            {formatCurrency(totalValue, defaultCurrency)}
          </p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-4">
          <p className="text-xs sm:text-sm text-gray-500 dark:text-gray-400">Regions</p>
          <p className="text-lg sm:text-xl font-bold text-gray-900 dark:text-gray-100">
            {regionData.length}
          </p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-4">
          <p className="text-xs sm:text-sm text-gray-500 dark:text-gray-400">Exchanges</p>
          <p className="text-lg sm:text-xl font-bold text-gray-900 dark:text-gray-100">
            {exchangeData.length}
          </p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-4">
          <p className="text-xs sm:text-sm text-gray-500 dark:text-gray-400">Top Region</p>
          <p className="text-lg sm:text-xl font-bold text-gray-900 dark:text-gray-100">
            {regionData[0]?.region || '-'}
          </p>
        </div>
      </div>

      {/* Chart */}
      {viewType === 'region' ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
            Regional Allocation
          </h3>
          <div style={{ width: '100%', height: 350 }}>
            <ResponsiveContainer minWidth={0}>
              <PieChart>
                <Pie
                  data={regionData}
                  dataKey="marketValue"
                  nameKey="region"
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={120}
                  paddingAngle={2}
                >
                  {regionData.map((entry) => (
                    <Cell key={entry.region} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip content={<CustomTooltip formatCurrencyFull={(v) => formatCurrencyFull(v, defaultCurrency)} />} />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>
      ) : (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
            Exchange Allocation
          </h3>
          <div style={{ width: '100%', height: Math.max(300, exchangeData.length * 40 + 60) }}>
            <ResponsiveContainer minWidth={0}>
              <BarChart
                data={exchangeData}
                layout="vertical"
                margin={{ top: 5, right: 10, left: 0, bottom: 5 }}
              >
                <XAxis
                  type="number"
                  tickFormatter={(v: number) => formatCurrencyAxis(v)}
                  tick={{ fill: 'currentColor', fontSize: 11 }}
                />
                <YAxis
                  type="category"
                  dataKey="exchange"
                  width={100}
                  tick={{ fill: 'currentColor', fontSize: 11 }}
                />
                <Tooltip content={<CustomTooltip formatCurrencyFull={(v) => formatCurrencyFull(v, defaultCurrency)} />} />
                <Bar dataKey="marketValue" fill="#3b82f6" radius={[0, 4, 4, 0]}>
                  {exchangeData.map((entry, index) => (
                    <Cell key={entry.exchange} fill={COUNTRY_COLOURS[index % COUNTRY_COLOURS.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Data Table */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
            <thead className="bg-gray-50 dark:bg-gray-900/50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  {viewType === 'region' ? 'Region' : 'Exchange'}
                </th>
                {viewType === 'exchange' && (
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    Country
                  </th>
                )}
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  Holdings
                </th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  Market Value
                </th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  % of Portfolio
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
              {viewType === 'region'
                ? regionData.map((item) => (
                    <tr key={item.region} className="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                      <td className="px-4 py-3 text-sm font-medium text-gray-900 dark:text-gray-100">
                        <div className="flex items-center gap-2">
                          <div
                            className="w-3 h-3 rounded-full flex-shrink-0"
                            style={{ backgroundColor: item.color }}
                          />
                          {item.region}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-sm text-right text-gray-600 dark:text-gray-400">
                        {item.count}
                      </td>
                      <td className="px-4 py-3 text-sm text-right font-medium text-gray-900 dark:text-gray-100">
                        {formatCurrencyFull(item.marketValue, defaultCurrency)}
                      </td>
                      <td className="px-4 py-3 text-sm text-right text-gray-600 dark:text-gray-400">
                        {item.percentage.toFixed(1)}%
                      </td>
                    </tr>
                  ))
                : exchangeData.map((item, idx) => (
                    <tr key={item.exchange} className="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                      <td className="px-4 py-3 text-sm font-medium text-gray-900 dark:text-gray-100">
                        <div className="flex items-center gap-2">
                          <div
                            className="w-3 h-3 rounded-full flex-shrink-0"
                            style={{ backgroundColor: COUNTRY_COLOURS[idx % COUNTRY_COLOURS.length] }}
                          />
                          {item.exchange}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-400">
                        {item.country}
                      </td>
                      <td className="px-4 py-3 text-sm text-right text-gray-600 dark:text-gray-400">
                        {item.count}
                      </td>
                      <td className="px-4 py-3 text-sm text-right font-medium text-gray-900 dark:text-gray-100">
                        {formatCurrencyFull(item.marketValue, defaultCurrency)}
                      </td>
                      <td className="px-4 py-3 text-sm text-right text-gray-600 dark:text-gray-400">
                        {item.percentage.toFixed(1)}%
                      </td>
                    </tr>
                  ))}
            </tbody>
            <tfoot className="bg-gray-50 dark:bg-gray-900/50">
              <tr>
                <td className="px-4 py-3 text-sm font-bold text-gray-900 dark:text-gray-100">
                  Total
                </td>
                {viewType === 'exchange' && <td />}
                <td className="px-4 py-3 text-sm text-right font-bold text-gray-900 dark:text-gray-100">
                  {holdings.length}
                </td>
                <td className="px-4 py-3 text-sm text-right font-bold text-gray-900 dark:text-gray-100">
                  {formatCurrencyFull(totalValue, defaultCurrency)}
                </td>
                <td className="px-4 py-3 text-sm text-right font-bold text-gray-900 dark:text-gray-100">
                  100%
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  );
}
