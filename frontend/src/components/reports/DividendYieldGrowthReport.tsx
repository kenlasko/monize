'use client';

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { subYears } from 'date-fns';
import { investmentsApi } from '@/lib/investments';
import { InvestmentTransaction, HoldingWithMarketValue } from '@/types/investment';
import { Account } from '@/types/account';
import { parseLocalDate } from '@/lib/utils';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { gainLossColor } from '@/lib/format';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { ExportDropdown } from '@/components/ui/ExportDropdown';
import { ReportAccountMultiSelect } from '@/components/reports/ReportAccountMultiSelect';
import { RefreshPricesButton } from '@/components/reports/RefreshPricesButton';
import { SortableHeader } from '@/components/ui/SortableHeader';
import { useSortableTable, compareValues } from '@/hooks/useSortableTable';
import { createLogger } from '@/lib/logger';

const logger = createLogger('DividendYieldGrowthReport');

type YieldSortField = 'symbol' | 'dividends' | 'marketValue' | 'yield' | 'frequency';
type GrowthSortField = 'year' | 'amount' | 'growth';
type FrequencySortField = 'frequency' | 'count' | 'totalDividends';

const MAX_PAGES = 50;

interface SecurityYield {
  symbol: string;
  name: string;
  trailing12mDividends: number;
  marketValue: number;
  yield: number;
  frequency: string;
}

interface AnnualDividend {
  year: string;
  amount: number;
  growth: number | null;
}

interface FrequencyBucket {
  frequency: string;
  count: number;
  totalDividends: number;
}

function detectFrequency(dates: Date[]): string {
  if (dates.length < 2) return 'Unknown';
  const sorted = [...dates].sort((a, b) => a.getTime() - b.getTime());
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    gaps.push((sorted[i].getTime() - sorted[i - 1].getTime()) / (1000 * 60 * 60 * 24));
  }
  const avgGap = gaps.reduce((s, g) => s + g, 0) / gaps.length;
  if (avgGap <= 45) return 'Monthly';
  if (avgGap <= 120) return 'Quarterly';
  if (avgGap <= 210) return 'Semi-Annual';
  return 'Annual';
}

export function DividendYieldGrowthReport() {
  const { formatCurrency: formatCurrencyFull, formatCurrencyAxis, formatSignedPercent } = useNumberFormat();
  const { defaultCurrency, convertToDefault } = useExchangeRates();
  const chartRef = useRef<HTMLDivElement>(null);
  const [transactions, setTransactions] = useState<InvestmentTransaction[]>([]);
  const [holdings, setHoldings] = useState<HoldingWithMarketValue[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
  const [reloadKey, setReloadKey] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  // Only the first load shows the full skeleton. Later reloads (e.g. changing
  // the account filter) keep the existing content -- and the account dropdown --
  // mounted so they update in place instead of unmounting the whole report.
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  const [viewType, setViewType] = useState<'yield' | 'growth' | 'frequency'>('yield');
  const isSingleAccount = selectedAccountIds.length === 1;
  const yieldSort = useSortableTable<YieldSortField>(
    'reports.dividend-yield-growth.yield.sort',
    { field: 'yield', direction: 'desc' },
  );
  const growthSort = useSortableTable<GrowthSortField>(
    'reports.dividend-yield-growth.growth.sort',
    { field: 'year', direction: 'asc' },
  );
  const frequencySort = useSortableTable<FrequencySortField>(
    'reports.dividend-yield-growth.frequency.sort',
    { field: 'totalDividends', direction: 'desc' },
  );

  const accountCurrencyMap = useMemo(() => {
    const map = new Map<string, string>();
    accounts.forEach((a) => map.set(a.id, a.currencyCode));
    return map;
  }, [accounts]);

  const selectedAccount = isSingleAccount
    ? accounts.find((a) => a.id === selectedAccountIds[0])
    : undefined;
  const displayCurrency = selectedAccount?.currencyCode || defaultCurrency;

  const getTxAmount = useCallback((tx: InvestmentTransaction): number => {
    const amount = Math.abs(tx.totalAmount);
    if (isSingleAccount) return amount;
    const txCurrency = accountCurrencyMap.get(tx.accountId) || defaultCurrency;
    return convertToDefault(amount, txCurrency);
  }, [isSingleAccount, accountCurrencyMap, defaultCurrency, convertToDefault]);

  const fmtValue = useCallback((value: number): string => {
    const isForeign = displayCurrency !== defaultCurrency;
    if (isForeign) return `${formatCurrencyFull(value, displayCurrency)} ${displayCurrency}`;
    return formatCurrencyFull(value);
  }, [displayCurrency, defaultCurrency, formatCurrencyFull]);

  // Fetch accounts once on mount (they don't change with filters)
  useEffect(() => {
    investmentsApi.getInvestmentAccounts()
      .then(setAccounts)
      .catch((error) => logger.error('Failed to load accounts:', error));
  }, []);

  useEffect(() => {
    const loadData = async () => {
      setIsLoading(true);
      try {
        const accountIds = selectedAccountIds.length > 0 ? selectedAccountIds.join(',') : undefined;

        const fetchAllPages = async (action: string): Promise<InvestmentTransaction[]> => {
          const results: InvestmentTransaction[] = [];
          let page = 1;
          let hasMore = true;
          while (hasMore && page <= MAX_PAGES) {
            const result = await investmentsApi.getTransactions({
              accountIds,
              action,
              limit: 200,
              page,
            });
            results.push(...result.data);
            hasMore = result.pagination.hasMore;
            page++;
          }
          return results;
        };

        const [summaryData, dividendTx, reinvestTx] = await Promise.all([
          investmentsApi.getPortfolioSummary(
            selectedAccountIds.length > 0 ? selectedAccountIds : undefined,
          ),
          fetchAllPages('DIVIDEND'),
          fetchAllPages('REINVEST'),
        ]);

        setTransactions([...dividendTx, ...reinvestTx]);
        setHoldings(summaryData.holdings);
      } catch (error) {
        logger.error('Failed to load data:', error);
      } finally {
        setIsLoading(false);
        setHasLoadedOnce(true);
      }
    };
    loadData();
  }, [selectedAccountIds, reloadKey]);

  // Trailing 12-month portfolio yield
  const trailing12mTotal = useMemo(() => {
    const cutoff = subYears(new Date(), 1);
    return transactions
      .filter((tx) => parseLocalDate(tx.transactionDate) >= cutoff)
      .reduce((sum, tx) => sum + getTxAmount(tx), 0);
  }, [transactions, getTxAmount]);

  const totalPortfolioValue = useMemo(
    () => holdings.reduce((sum, h) => sum + convertToDefault(h.marketValue ?? 0, h.currencyCode), 0),
    [holdings, convertToDefault],
  );

  const portfolioYield = totalPortfolioValue > 0 ? (trailing12mTotal / totalPortfolioValue) * 100 : 0;

  // Per-security yield
  const securityYields = useMemo((): SecurityYield[] => {
    const cutoff = subYears(new Date(), 1);
    const recentTx = transactions.filter((tx) => parseLocalDate(tx.transactionDate) >= cutoff);

    // Aggregate dividends by security (skip transactions without a security)
    const dividendMap = new Map<string, { total: number; dates: Date[] }>();
    recentTx.forEach((tx) => {
      if (!tx.securityId) return;
      let existing = dividendMap.get(tx.securityId);
      if (!existing) {
        existing = { total: 0, dates: [] };
        dividendMap.set(tx.securityId, existing);
      }
      existing.total += getTxAmount(tx);
      existing.dates.push(parseLocalDate(tx.transactionDate));
    });

    // Aggregate market value across all accounts holding each security
    const holdingMap = new Map<string, { symbol: string; name: string; marketValue: number }>();
    holdings.forEach((h) => {
      const mv = convertToDefault(h.marketValue ?? 0, h.currencyCode);
      const existing = holdingMap.get(h.securityId);
      if (existing) {
        existing.marketValue += mv;
      } else {
        holdingMap.set(h.securityId, { symbol: h.symbol, name: h.name, marketValue: mv });
      }
    });

    const results: SecurityYield[] = [];
    dividendMap.forEach((data, secId) => {
      const holding = holdingMap.get(secId);
      if (!holding) return;
      results.push({
        symbol: holding.symbol,
        name: holding.name,
        trailing12mDividends: data.total,
        marketValue: holding.marketValue,
        yield: holding.marketValue > 0 ? (data.total / holding.marketValue) * 100 : 0,
        frequency: detectFrequency(data.dates),
      });
    });

    return results;
  }, [transactions, holdings, getTxAmount, convertToDefault]);

  const sortedSecurityYields = useMemo(() => {
    const sorted = [...securityYields];
    sorted.sort((a, b) => {
      let comparison = 0;
      switch (yieldSort.sortField) {
        case 'symbol':
          comparison = compareValues(a.symbol, b.symbol);
          break;
        case 'dividends':
          comparison = compareValues(a.trailing12mDividends, b.trailing12mDividends);
          break;
        case 'marketValue':
          comparison = compareValues(a.marketValue, b.marketValue);
          break;
        case 'yield':
          comparison = compareValues(a.yield, b.yield);
          break;
        case 'frequency':
          comparison = compareValues(a.frequency, b.frequency);
          break;
      }
      return yieldSort.sortDirection === 'asc' ? comparison : -comparison;
    });
    return sorted;
  }, [securityYields, yieldSort.sortField, yieldSort.sortDirection]);

  // Year-over-year growth
  const annualData = useMemo((): AnnualDividend[] => {
    const yearMap = new Map<string, number>();
    transactions.forEach((tx) => {
      const year = tx.transactionDate.substring(0, 4);
      yearMap.set(year, (yearMap.get(year) || 0) + getTxAmount(tx));
    });

    const years = Array.from(yearMap.keys()).sort();
    return years.map((year, idx) => {
      const amount = yearMap.get(year) || 0;
      const prevAmount = idx > 0 ? yearMap.get(years[idx - 1]) || 0 : null;
      const growth = prevAmount !== null && prevAmount > 0
        ? ((amount - prevAmount) / prevAmount) * 100
        : null;
      return { year, amount, growth };
    });
  }, [transactions, getTxAmount]);

  // Frequency analysis
  const frequencyData = useMemo((): FrequencyBucket[] => {
    const freqMap = new Map<string, { count: number; total: number }>();
    securityYields.forEach((sy) => {
      const existing = freqMap.get(sy.frequency) || { count: 0, total: 0 };
      freqMap.set(sy.frequency, {
        count: existing.count + 1,
        total: existing.total + sy.trailing12mDividends,
      });
    });
    return Array.from(freqMap.entries())
      .map(([frequency, data]) => ({
        frequency,
        count: data.count,
        totalDividends: data.total,
      }))
      ;
  }, [securityYields]);

  const sortedAnnualData = useMemo(() => {
    const sorted = [...annualData];
    sorted.sort((a, b) => {
      let comparison = 0;
      switch (growthSort.sortField) {
        case 'year':
          comparison = compareValues(a.year, b.year);
          break;
        case 'amount':
          comparison = compareValues(a.amount, b.amount);
          break;
        case 'growth':
          comparison = compareValues(a.growth, b.growth);
          break;
      }
      return growthSort.sortDirection === 'asc' ? comparison : -comparison;
    });
    return sorted;
  }, [annualData, growthSort.sortField, growthSort.sortDirection]);

  const sortedFrequencyData = useMemo(() => {
    const sorted = [...frequencyData];
    sorted.sort((a, b) => {
      let comparison = 0;
      switch (frequencySort.sortField) {
        case 'frequency':
          comparison = compareValues(a.frequency, b.frequency);
          break;
        case 'count':
          comparison = compareValues(a.count, b.count);
          break;
        case 'totalDividends':
          comparison = compareValues(a.totalDividends, b.totalDividends);
          break;
      }
      return frequencySort.sortDirection === 'asc' ? comparison : -comparison;
    });
    return sorted;
  }, [frequencyData, frequencySort.sortField, frequencySort.sortDirection]);

  const handleExportPdf = async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');

    let tableData: { headers: string[]; rows: (string | number)[][] } | undefined;
    let chartContainer: HTMLElement | null = null;

    if (viewType === 'yield') {
      tableData = {
        headers: ['Security', '12M Dividends', 'Market Value', 'Yield', 'Frequency'],
        rows: securityYields.map((sy) => [
          `${sy.symbol} - ${sy.name}`,
          fmtValue(sy.trailing12mDividends),
          fmtValue(sy.marketValue),
          `${sy.yield.toFixed(2)}%`,
          sy.frequency,
        ]),
      };
    } else if (viewType === 'growth') {
      chartContainer = chartRef.current;
      tableData = {
        headers: ['Year', 'Dividend Income', 'YoY Growth'],
        rows: annualData.map((row) => [
          row.year,
          fmtValue(row.amount),
          row.growth !== null ? formatSignedPercent(row.growth, 1) : '-',
        ]),
      };
    } else {
      chartContainer = chartRef.current;
      tableData = {
        headers: ['Frequency', 'Securities', 'Total Dividends'],
        rows: frequencyData.map((row) => [
          row.frequency,
          String(row.count),
          fmtValue(row.totalDividends),
        ]),
      };
    }

    const viewLabel = viewType === 'yield' ? 'Per-Security Yield' : viewType === 'growth' ? 'Year-over-Year' : 'Frequency';
    await exportToPdf({
      title: 'Dividend Yield & Growth',
      subtitle: viewLabel,
      summaryCards: [
        { label: 'Portfolio Yield', value: `${portfolioYield.toFixed(2)}%`, color: '#16a34a' },
        { label: 'Trailing 12M', value: fmtValue(trailing12mTotal), color: '#2563eb' },
        { label: 'Portfolio Value', value: fmtValue(totalPortfolioValue), color: '#9333ea' },
        { label: 'Dividend Payers', value: String(securityYields.length), color: '#111827' },
      ],
      chartContainer,
      tableData,
      filename: 'dividend-yield-growth',
    });
  };

  if (isLoading && !hasLoadedOnce) {
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
        <div className="bg-green-50 dark:bg-green-900/20 rounded-lg p-4">
          <div className="text-sm text-green-600 dark:text-green-400">Portfolio Yield</div>
          <div className="text-xl font-bold text-green-700 dark:text-green-300">
            {portfolioYield.toFixed(2)}%
          </div>
        </div>
        <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-4">
          <div className="text-sm text-blue-600 dark:text-blue-400">Trailing 12M Dividends</div>
          <div className="text-xl font-bold text-blue-700 dark:text-blue-300">
            {fmtValue(trailing12mTotal)}
          </div>
        </div>
        <div className="bg-purple-50 dark:bg-purple-900/20 rounded-lg p-4">
          <div className="text-sm text-purple-600 dark:text-purple-400">Portfolio Value</div>
          <div className="text-xl font-bold text-purple-700 dark:text-purple-300">
            {fmtValue(totalPortfolioValue)}
          </div>
        </div>
        <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-4">
          <div className="text-sm text-gray-600 dark:text-gray-400">Dividend Payers</div>
          <div className="text-xl font-bold text-gray-900 dark:text-gray-100">
            {securityYields.length}
          </div>
        </div>
      </div>

      {/* Controls */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex flex-wrap gap-4 items-center justify-between">
          <ReportAccountMultiSelect
            accounts={accounts}
            value={selectedAccountIds}
            onChange={setSelectedAccountIds}
          />
          <div className="flex gap-2 items-center">
            <button
              onClick={() => setViewType('yield')}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                viewType === 'yield' ? 'bg-blue-600 text-white' : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
              }`}
            >
              Per-Security Yield
            </button>
            <button
              onClick={() => setViewType('growth')}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                viewType === 'growth' ? 'bg-blue-600 text-white' : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
              }`}
            >
              Year-over-Year
            </button>
            <button
              onClick={() => setViewType('frequency')}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                viewType === 'frequency' ? 'bg-blue-600 text-white' : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
              }`}
            >
              Frequency
            </button>
          </div>
          <div className="ml-auto flex gap-2 items-center">
            <RefreshPricesButton onRefreshComplete={() => setReloadKey((k) => k + 1)} />
            <ExportDropdown onExportPdf={handleExportPdf} />
          </div>
        </div>
      </div>

      {transactions.length === 0 ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <p className="text-gray-500 dark:text-gray-400 text-center py-8">
            No dividend transactions found. Record dividend transactions to see yield and growth analysis.
          </p>
        </div>
      ) : viewType === 'yield' ? (
        /* Per-Security Yield Table */
        <div ref={chartRef} className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              Per-Security Dividend Yield (Trailing 12 Months)
            </h3>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
              <thead className="bg-gray-50 dark:bg-gray-900/50">
                <tr>
                  <SortableHeader<YieldSortField>
                    field="symbol"
                    sortField={yieldSort.sortField}
                    sortDirection={yieldSort.sortDirection}
                    onSort={yieldSort.handleSort}
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                  >
                    Security
                  </SortableHeader>
                  <SortableHeader<YieldSortField>
                    field="dividends"
                    sortField={yieldSort.sortField}
                    sortDirection={yieldSort.sortDirection}
                    onSort={yieldSort.handleSort}
                    align="right"
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                  >
                    12M Dividends
                  </SortableHeader>
                  <SortableHeader<YieldSortField>
                    field="marketValue"
                    sortField={yieldSort.sortField}
                    sortDirection={yieldSort.sortDirection}
                    onSort={yieldSort.handleSort}
                    align="right"
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                  >
                    Market Value
                  </SortableHeader>
                  <SortableHeader<YieldSortField>
                    field="yield"
                    sortField={yieldSort.sortField}
                    sortDirection={yieldSort.sortDirection}
                    onSort={yieldSort.handleSort}
                    align="right"
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                  >
                    Yield
                  </SortableHeader>
                  <SortableHeader<YieldSortField>
                    field="frequency"
                    sortField={yieldSort.sortField}
                    sortDirection={yieldSort.sortDirection}
                    onSort={yieldSort.handleSort}
                    align="right"
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                  >
                    Frequency
                  </SortableHeader>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                {sortedSecurityYields.map((sy) => (
                  <tr key={sy.symbol} className="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-900 dark:text-gray-100">{sy.symbol}</div>
                      <div className="text-sm text-gray-500 dark:text-gray-400">{sy.name}</div>
                    </td>
                    <td className="px-4 py-3 text-right text-sm text-green-600 dark:text-green-400">
                      {fmtValue(sy.trailing12mDividends)}
                    </td>
                    <td className="px-4 py-3 text-right text-sm text-gray-600 dark:text-gray-400">
                      {fmtValue(sy.marketValue)}
                    </td>
                    <td className="px-4 py-3 text-right text-sm font-medium text-gray-900 dark:text-gray-100">
                      {sy.yield.toFixed(2)}%
                    </td>
                    <td className="px-4 py-3 text-right text-sm text-gray-500 dark:text-gray-400">
                      {sy.frequency}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : viewType === 'growth' ? (
        /* Year-over-Year Growth */
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 px-2 py-4 sm:p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
            Annual Dividend Income
          </h3>
          {annualData.length > 0 ? (
            <>
              <div className="h-80">
                <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                  <BarChart data={annualData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                    <XAxis dataKey="year" tick={{ fontSize: 11 }} />
                    <YAxis tickFormatter={formatCurrencyAxis} />
                    <Tooltip
                      content={({ active, payload, label }) => {
                        if (!active || !payload?.length) return null;
                        const d = payload[0].payload as AnnualDividend;
                        return (
                          <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
                            <p className="font-medium text-gray-900 dark:text-gray-100">{label}</p>
                            <p className="text-sm text-green-600 dark:text-green-400">
                              Dividends: {fmtValue(d.amount)}
                            </p>
                            {d.growth !== null && (
                              <p className={`text-sm ${gainLossColor(d.growth)}`}>
                                Growth: {formatSignedPercent(d.growth, 1)}
                              </p>
                            )}
                          </div>
                        );
                      }}
                    />
                    <Bar dataKey="amount" fill="#22c55e" name="Dividends" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              {/* Growth Table */}
              <div className="mt-6 overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                  <thead className="bg-gray-50 dark:bg-gray-900/50">
                    <tr>
                      <SortableHeader<GrowthSortField>
                        field="year"
                        sortField={growthSort.sortField}
                        sortDirection={growthSort.sortDirection}
                        onSort={growthSort.handleSort}
                        className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                      >
                        Year
                      </SortableHeader>
                      <SortableHeader<GrowthSortField>
                        field="amount"
                        sortField={growthSort.sortField}
                        sortDirection={growthSort.sortDirection}
                        onSort={growthSort.handleSort}
                        align="right"
                        className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                      >
                        Dividend Income
                      </SortableHeader>
                      <SortableHeader<GrowthSortField>
                        field="growth"
                        sortField={growthSort.sortField}
                        sortDirection={growthSort.sortDirection}
                        onSort={growthSort.handleSort}
                        align="right"
                        className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                      >
                        YoY Growth
                      </SortableHeader>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                    {sortedAnnualData.map((row) => (
                      <tr key={row.year} className="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                        <td className="px-4 py-3 text-sm font-medium text-gray-900 dark:text-gray-100">{row.year}</td>
                        <td className="px-4 py-3 text-sm text-right text-green-600 dark:text-green-400">{fmtValue(row.amount)}</td>
                        <td className={`px-4 py-3 text-sm text-right ${row.growth !== null ? (row.growth >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400') : 'text-gray-400'}`}>
                          {row.growth !== null ? formatSignedPercent(row.growth, 1) : '-'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <p className="text-gray-500 dark:text-gray-400 text-center py-8">No annual data available.</p>
          )}
        </div>
      ) : (
        /* Frequency Analysis */
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 px-2 py-4 sm:p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
            Dividend Frequency Analysis
          </h3>
          {frequencyData.length > 0 ? (
            <>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                  <BarChart data={frequencyData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                    <XAxis dataKey="frequency" tick={{ fontSize: 11 }} />
                    <YAxis tickFormatter={formatCurrencyAxis} />
                    <Tooltip
                      content={({ active, payload, label }) => {
                        if (!active || !payload?.length) return null;
                        const d = payload[0].payload as FrequencyBucket;
                        return (
                          <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
                            <p className="font-medium text-gray-900 dark:text-gray-100">{label}</p>
                            <p className="text-sm text-gray-600 dark:text-gray-400">{d.count} securities</p>
                            <p className="text-sm text-green-600 dark:text-green-400">Total: {fmtValue(d.totalDividends)}</p>
                          </div>
                        );
                      }}
                    />
                    <Bar dataKey="totalDividends" fill="#8b5cf6" name="Total Dividends" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className="mt-6 overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                  <thead className="bg-gray-50 dark:bg-gray-900/50">
                    <tr>
                      <SortableHeader<FrequencySortField>
                        field="frequency"
                        sortField={frequencySort.sortField}
                        sortDirection={frequencySort.sortDirection}
                        onSort={frequencySort.handleSort}
                        className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                      >
                        Frequency
                      </SortableHeader>
                      <SortableHeader<FrequencySortField>
                        field="count"
                        sortField={frequencySort.sortField}
                        sortDirection={frequencySort.sortDirection}
                        onSort={frequencySort.handleSort}
                        align="right"
                        className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                      >
                        Securities
                      </SortableHeader>
                      <SortableHeader<FrequencySortField>
                        field="totalDividends"
                        sortField={frequencySort.sortField}
                        sortDirection={frequencySort.sortDirection}
                        onSort={frequencySort.handleSort}
                        align="right"
                        className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                      >
                        Total Dividends
                      </SortableHeader>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                    {sortedFrequencyData.map((row) => (
                      <tr key={row.frequency} className="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                        <td className="px-4 py-3 text-sm font-medium text-gray-900 dark:text-gray-100">{row.frequency}</td>
                        <td className="px-4 py-3 text-sm text-right text-gray-600 dark:text-gray-400">{row.count}</td>
                        <td className="px-4 py-3 text-sm text-right text-green-600 dark:text-green-400">{fmtValue(row.totalDividends)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <p className="text-gray-500 dark:text-gray-400 text-center py-8">No frequency data available.</p>
          )}
        </div>
      )}
    </div>
  );
}
