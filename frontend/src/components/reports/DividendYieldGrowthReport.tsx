'use client';

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
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
import { subYears } from 'date-fns';
import { investmentsApi } from '@/lib/investments';
import { investmentIncomeAmount, investmentRowHasEffect } from '@/lib/investment-actions';
import { convertRowAmount, rowAmountCurrency } from '@/lib/investment-row-currency';
import { InvestmentTransaction, HoldingWithMarketValue } from '@/types/investment';
import { Account } from '@/types/account';
import { parseLocalDate } from '@/lib/utils';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { gainLossColor } from '@/lib/format';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { ReportToolbarActions } from '@/components/reports/ReportToolbarActions';
import { ReportAccountMultiSelect } from '@/components/reports/ReportAccountMultiSelect';
import { SortableHeader } from '@/components/ui/SortableHeader';
import { CAPTION_CLASS, CellLabel, PHONE_HEADER_CLASS } from '@/components/ui/Table';
import type {
  SortColumn as TableSortColumn,
  SortColumnsByField as TableSortColumnsByField,
} from '@/components/ui/Table';
import { PartialTotal } from '@/components/ui/PartialTotal';
import { useSortableTable, compareValues } from '@/hooks/useSortableTable';
import { createLogger } from '@/lib/logger';
import { chartColors, CHART_SERIES } from '@/lib/chart-colors';
import { useTranslations } from 'next-intl';
import { EmptyState } from '@/components/ui/EmptyState';
import { SEGMENTED_GROUP_CLASS, segmentClass } from '@/components/ui/segmented-control';
import { CHART_GRID_PROPS, CHART_TOOLTIP_CLASS } from '@/lib/chart-style';

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

/**
 * One sortable column of the per-security yield table, keyed by its own sort
 * field so the record is exhaustive over `YieldSortField` and each entry names
 * the field it stands for. Both header rows -- the column header row from `sm`
 * up and the phone sort strip below it -- render from the same record, so they
 * can never list different fields, and a new sort field is a compile error here
 * rather than a column stranded with no control on a phone.
 */
type YieldSortColumn = TableSortColumn<YieldSortField, 'right'>;
type YieldSortColumns = TableSortColumnsByField<YieldSortField, YieldSortColumn>;

// Today's header cell, unchanged.
const HEADER_CLASS =
  'px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase';

// A figure cell inside a wrapped card: no padding of its own below `sm` (the
// row supplies it and the grid does the spacing), this table's own `px-4 py-3`
// from `sm` up, and smaller type on phones so a figure fits a third of the
// width. `whitespace-nowrap` is the one property here that is NOT phone-only,
// and the single respect in which the `sm`-and-up cell differs from today's: a
// locale that groups thousands with a space (`1 234 567 zl`) could otherwise
// break a figure in the middle at any width. Right alignment is not a
// containment device -- a nowrap amount longer than its track overflows the end
// edge and reopens the wrapper's scroll -- but `overflow-hidden` here would
// silently cut a figure, which is worse than a crowded one or an honest scroll.
const MONEY_CELL =
  'p-0 text-right text-xs whitespace-nowrap sm:table-cell sm:px-4 sm:py-3 sm:text-sm';

const ACCOUNTS_STORAGE_KEY = 'monize-reports-dividend-yield-growth-accounts';

export function DividendYieldGrowthReport() {
  const t = useTranslations('reports');
  const { formatCurrency: formatCurrencyFull, formatCurrencyAxis, formatSignedPercent, formatPercent } = useNumberFormat();
  const { defaultCurrency, convert } = useExchangeRates();
  const chartRef = useRef<HTMLDivElement>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  // Persisted so the report opens on the accounts the user last chose.
  const [selectedAccountIds, setSelectedAccountIds] = usePersistedAccountFilter(
    ACCOUNTS_STORAGE_KEY,
    accounts,
  );
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

  /**
   * A transaction's dividend in the display currency, or `null` when it cannot
   * be converted. Yield is income over value, so an amount that cannot be
   * converted has to leave both sides of the ratio rather than being added at
   * face value. The dividend is in the row's own (security) currency and reaches
   * the display currency at the row's settlement rate where it has one. A
   * reinvest created in the app stores no total; the dividend it records is the
   * cost of the shares it bought.
   */
  const getTxAmount = useCallback(
    (tx: InvestmentTransaction): number | null =>
      convertRowAmount(
        tx,
        investmentIncomeAmount(tx),
        accountCurrencyMap.get(tx.accountId),
        displayCurrency,
      ),
    [accountCurrencyMap, displayCurrency],
  );

  /**
   * A holding's market value in the same display currency as the dividends, so
   * the yield divides one currency by itself.
   */
  const toDisplay = useCallback(
    (amount: number, currency: string): number | null => convert(amount, currency, displayCurrency),
    [convert, displayCurrency],
  );

  const fmtValue = useCallback((value: number): string => {
    const isForeign = displayCurrency !== defaultCurrency;
    if (isForeign) return `${formatCurrencyFull(value, displayCurrency)} ${displayCurrency}`;
    return formatCurrencyFull(value);
  }, [displayCurrency, defaultCurrency, formatCurrencyFull]);

  const detectFrequency = useCallback((dates: Date[]): string => {
    if (dates.length < 2) return t('dividendYieldGrowth.freqUnknown');
    const sorted = [...dates].sort((a, b) => a.getTime() - b.getTime());
    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      gaps.push((sorted[i].getTime() - sorted[i - 1].getTime()) / (1000 * 60 * 60 * 24));
    }
    const avgGap = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    if (avgGap <= 45) return t('dividendYieldGrowth.freqMonthly');
    if (avgGap <= 120) return t('dividendYieldGrowth.freqQuarterly');
    if (avgGap <= 210) return t('dividendYieldGrowth.freqSemiAnnual');
    return t('dividendYieldGrowth.freqAnnual');
     
  }, [t]);

  // Fetch accounts once on mount (they don't change with filters)
  useEffect(() => {
    investmentsApi.getInvestmentAccounts()
      .then(setAccounts)
      .catch((error) => logger.error('Failed to load accounts:', error));
  }, []);

  // `reload` (a stable callback) is wired to the RefreshPricesButton so a
  // manual price refresh re-fetches the dividend data.
  const { data: response, isLoading, error, reload } = useReportData(
    async () => {
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
        // Every action whose income is a dividend, paid in cash or reinvested.
        // The interest and capital-gain refinements of REINVEST are not
        // dividends, as their cash twins are not.
        fetchAllPages('DIVIDEND'),
        fetchAllPages('REINVEST'),
      ]);

      return {
        // A VOID row is listed by the endpoint as a record; it paid nothing.
        transactions: [...dividendTx, ...reinvestTx].filter(investmentRowHasEffect),
        holdings: summaryData.holdings,
      };
    },
    [selectedAccountIds],
  );

  const transactions = useMemo<InvestmentTransaction[]>(
    () => response?.transactions ?? [],
    [response],
  );
  const holdings = useMemo<HoldingWithMarketValue[]>(
    () => response?.holdings ?? [],
    [response],
  );

  // Trailing 12-month portfolio yield
  const trailing12mTotal = useMemo(() => {
    const cutoff = subYears(new Date(), 1);
    return transactions
      .filter((tx) => parseLocalDate(tx.transactionDate) >= cutoff)
      .reduce((sum, tx) => {
        const amount = getTxAmount(tx);
        return amount === null ? sum : sum + amount;
      }, 0);
  }, [transactions, getTxAmount]);

  const totalPortfolioValue = useMemo(
    () =>
      holdings.reduce((sum, h) => {
        // An unpriced holding and an unconvertible one both leave the
        // denominator: `?? 0` would shrink it and inflate the yield.
        if (h.marketValue === null || h.marketValue === undefined) return sum;
        const converted = toDisplay(h.marketValue, h.currencyCode);
        return converted === null ? sum : sum + converted;
      }, 0),
    [holdings, toDisplay],
  );

  const portfolioYield = totalPortfolioValue > 0 ? (trailing12mTotal / totalPortfolioValue) * 100 : 0;

  // Components the yield's two inputs had to drop (mirrors their exclusion
  // rules): an unpriced or unconvertible holding out of the value, and an
  // unconvertible dividend out of the trailing total. Non-empty means the value,
  // the trailing dividends and the yield derived from them are all subtotals.
  const valuationGaps = useMemo(() => {
    const missing = new Set<string>();
    let excludedCount = 0;
    for (const h of holdings) {
      if (h.marketValue === null || h.marketValue === undefined) {
        excludedCount += 1;
        continue;
      }
      if (toDisplay(h.marketValue, h.currencyCode) === null) {
        missing.add(h.currencyCode);
        excludedCount += 1;
      }
    }
    const cutoff = subYears(new Date(), 1);
    for (const tx of transactions) {
      if (parseLocalDate(tx.transactionDate) < cutoff) continue;
      if (getTxAmount(tx) === null) {
        // The row's own currency is what had no rate; one the row cannot name
        // is still an exclusion, but names no pair to add.
        const currency = rowAmountCurrency(tx);
        if (currency !== null) missing.add(currency);
        excludedCount += 1;
      }
    }
    return { missingCurrencies: [...missing], excludedCount };
  }, [holdings, transactions, getTxAmount, toDisplay]);

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
      const amount = getTxAmount(tx);
      if (amount === null) return;
      existing.total += amount;
      existing.dates.push(parseLocalDate(tx.transactionDate));
    });

    // Aggregate market value across all accounts holding each security
    const holdingMap = new Map<string, { symbol: string; name: string; marketValue: number }>();
    holdings.forEach((h) => {
      if (h.marketValue === null || h.marketValue === undefined) return;
      const mv = toDisplay(h.marketValue, h.currencyCode);
      if (mv === null) return;
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
     
  }, [transactions, holdings, getTxAmount, toDisplay, detectFrequency]);

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

  // The five sortable columns of the per-security yield table, keyed by field
  // so the record is exhaustive over `YieldSortField`. Both header rows render
  // one control per column, and the declaration order is the column order.
  const yieldColumns: YieldSortColumns = {
    symbol: { field: 'symbol', label: t('dividendYieldGrowth.colSecurity') },
    dividends: { field: 'dividends', label: t('dividendYieldGrowth.col12mDividends'), align: 'right' },
    marketValue: { field: 'marketValue', label: t('dividendYieldGrowth.colMarketValue'), align: 'right' },
    yield: { field: 'yield', label: t('dividendYieldGrowth.colYield'), align: 'right' },
    frequency: { field: 'frequency', label: t('dividendYieldGrowth.colFrequency'), align: 'right' },
  };
  // Their order, rendered by BOTH header rows and matched by the cells' DOM
  // order. Derived from the record rather than re-listed, so a field added to
  // the union cannot compile with no sort control in either header.
  const yieldSortColumns: readonly YieldSortColumn[] = Object.values(yieldColumns);

  // Year-over-year growth
  const annualData = useMemo((): AnnualDividend[] => {
    const yearMap = new Map<string, number>();
    transactions.forEach((tx) => {
      const year = tx.transactionDate.substring(0, 4);
      const amount = getTxAmount(tx);
      // An unconvertible amount is not a zero contribution to the year; it is
      // simply not part of the comparable series.
      if (amount === null) return;
      yearMap.set(year, (yearMap.get(year) || 0) + amount);
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
        headers: [t('dividendYieldGrowth.colSecurity'), t('dividendYieldGrowth.col12mDividends'), t('dividendYieldGrowth.colMarketValue'), t('dividendYieldGrowth.colYield'), t('dividendYieldGrowth.colFrequency')],
        rows: securityYields.map((sy) => [
          `${sy.symbol} - ${sy.name}`,
          fmtValue(sy.trailing12mDividends),
          fmtValue(sy.marketValue),
          formatPercent(sy.yield, 2),
          sy.frequency,
        ]),
      };
    } else if (viewType === 'growth') {
      chartContainer = chartRef.current;
      tableData = {
        headers: [t('dividendYieldGrowth.colYear'), t('dividendYieldGrowth.colDividendIncome'), t('dividendYieldGrowth.colYoYGrowth')],
        rows: annualData.map((row) => [
          row.year,
          fmtValue(row.amount),
          row.growth !== null ? formatSignedPercent(row.growth, 1) : '-',
        ]),
      };
    } else {
      chartContainer = chartRef.current;
      tableData = {
        headers: [t('dividendYieldGrowth.colFrequencyLabel'), t('dividendYieldGrowth.colSecurities'), t('dividendYieldGrowth.colTotalDividends')],
        rows: frequencyData.map((row) => [
          row.frequency,
          String(row.count),
          fmtValue(row.totalDividends),
        ]),
      };
    }

    const viewLabel = viewType === 'yield' ? t('dividendYieldGrowth.pdfSubtitleYield') : viewType === 'growth' ? t('dividendYieldGrowth.pdfSubtitleGrowth') : t('dividendYieldGrowth.pdfSubtitleFrequency');
    await exportToPdf({
      title: t('dividendYieldGrowth.pdfTitle'),
      subtitle: viewLabel,
      summaryCards: [
        { label: t('dividendYieldGrowth.portfolioYield'), value: formatPercent(portfolioYield, 2), color: '#16a34a' },
        { label: t('dividendYieldGrowth.trailing12mDividends'), value: fmtValue(trailing12mTotal), color: '#2563eb' },
        { label: t('dividendYieldGrowth.portfolioValue'), value: fmtValue(totalPortfolioValue), color: '#9333ea' },
        { label: t('dividendYieldGrowth.dividendPayers'), value: String(securityYields.length), color: '#111827' },
      ],
      chartContainer,
      tableData,
      filename: 'dividend-yield-growth',
    });
  };

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
        <div className="bg-green-50 dark:bg-green-900/20 rounded-lg p-4">
          <div className="text-sm text-green-600 dark:text-green-400">{t('dividendYieldGrowth.portfolioYield')}</div>
          <div className="text-xl font-bold text-green-700 dark:text-green-300">
            {/* The yield is the ratio of the two subtotals beside it, so it is
                a subtotal too, and it wears the marker the same way they do.
                The hand-rolled amber `*` this replaces was `aria-hidden` with
                no `sr-only` twin, so the one figure a screen reader was told
                nothing about was the derived one. */}
            <PartialTotal total={{ value: portfolioYield, ...valuationGaps }} displayCurrency={displayCurrency}>
              {formatPercent(portfolioYield, 2)}
            </PartialTotal>
          </div>
        </div>
        <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-4">
          <div className="text-sm text-blue-600 dark:text-blue-400">{t('dividendYieldGrowth.trailing12mDividends')}</div>
          <div className="text-xl font-bold text-blue-700 dark:text-blue-300">
            <PartialTotal total={{ value: trailing12mTotal, ...valuationGaps }} displayCurrency={displayCurrency}>
              {fmtValue(trailing12mTotal)}
            </PartialTotal>
          </div>
        </div>
        <div className="bg-purple-50 dark:bg-purple-900/20 rounded-lg p-4">
          <div className="text-sm text-purple-600 dark:text-purple-400">{t('dividendYieldGrowth.portfolioValue')}</div>
          <div className="text-xl font-bold text-purple-700 dark:text-purple-300">
            <PartialTotal total={{ value: totalPortfolioValue, ...valuationGaps }} displayCurrency={displayCurrency}>
              {fmtValue(totalPortfolioValue)}
            </PartialTotal>
          </div>
        </div>
        <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-4">
          <div className="text-sm text-gray-600 dark:text-gray-400">{t('dividendYieldGrowth.dividendPayers')}</div>
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
          <div
            className={`${SEGMENTED_GROUP_CLASS} flex-wrap`}
            role="group"
            aria-label={t('reportPage.viewLabel')}
          >
            <button
              type="button"
              onClick={() => setViewType('yield')}
              aria-pressed={viewType === 'yield'}
              className={segmentClass(viewType === 'yield')}
            >
              {t('dividendYieldGrowth.viewPerSecurity')}
            </button>
            <button
              type="button"
              onClick={() => setViewType('growth')}
              aria-pressed={viewType === 'growth'}
              className={segmentClass(viewType === 'growth')}
            >
              {t('dividendYieldGrowth.viewYearOverYear')}
            </button>
            <button
              type="button"
              onClick={() => setViewType('frequency')}
              aria-pressed={viewType === 'frequency'}
              className={segmentClass(viewType === 'frequency')}
            >
              {t('dividendYieldGrowth.viewFrequency')}
            </button>
          </div>
          <ReportToolbarActions
            onRefreshComplete={reload}
            onExportPdf={handleExportPdf}
            disabled={isLoading || !!error}
          />
        </div>
      </div>

      {transactions.length === 0 ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <EmptyState title={t('dividendYieldGrowth.empty')} />
        </div>
      ) : viewType === 'yield' ? (
        /* Per-Security Yield Table */
        <div ref={chartRef} className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {t('dividendYieldGrowth.perSecurityTitle')}
            </h3>
          </div>
          {/* Below `sm` the table becomes a block and each row wraps into a
              three-column, two-line grid so all five columns fit a phone
              without a horizontal scroll: the security identity (spanning two
              tracks) and the headline yield share line 1; the trailing-12-month
              dividends, the market value and the payout frequency share line 2,
              one track each. Each bare figure carries a `CellLabel` reusing the
              column's existing header key, since the column header row is
              replaced by a phone sort strip below `sm`. From `sm` up it is the
              ordinary table -- every cell restores this table's own `px-4 py-3`
              -- and the one deliberate difference above `sm` is
              `whitespace-nowrap` on the figures (see `MONEY_CELL`). Restyling
              `display` strips the implicit table semantics, so the ARIA roles
              are restated explicitly. */}
          <div className="overflow-x-auto">
            <table role="table" className="block min-w-full divide-y divide-gray-200 dark:divide-gray-700 sm:table">
              <thead role="rowgroup" className="block bg-gray-50 dark:bg-gray-900/50 sm:table-header-group">
                {/* Phone sort strip: the same five controls, wrapped. */}
                <tr role="row" className="flex flex-wrap gap-x-2 gap-y-1 px-2 py-2 sm:hidden">
                  {yieldSortColumns.map((col) => (
                    <SortableHeader<YieldSortField>
                      key={col.field}
                      field={col.field}
                      sortField={yieldSort.sortField}
                      sortDirection={yieldSort.sortDirection}
                      onSort={yieldSort.handleSort}
                      className={PHONE_HEADER_CLASS}
                    >
                      {col.label}
                    </SortableHeader>
                  ))}
                </tr>
                <tr role="row" className="hidden sm:table-row">
                  {yieldSortColumns.map((col) => (
                    <SortableHeader<YieldSortField>
                      key={col.field}
                      field={col.field}
                      sortField={yieldSort.sortField}
                      sortDirection={yieldSort.sortDirection}
                      onSort={yieldSort.handleSort}
                      align={col.align}
                      className={HEADER_CLASS}
                    >
                      {col.label}
                    </SortableHeader>
                  ))}
                </tr>
              </thead>
              <tbody role="rowgroup" className="block divide-y divide-gray-200 dark:divide-gray-700 sm:table-row-group">
                {sortedSecurityYields.map((sy) => (
                  <tr
                    key={sy.symbol}
                    role="row"
                    className="grid grid-cols-3 items-start gap-x-3 gap-y-1.5 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-700/50 sm:table-row sm:p-0"
                  >
                    {/* The identity: symbol over name. It spans two tracks on
                        line 1 beside the headline yield; the name wraps on a
                        phone and hands the wrap back from `sm` up. */}
                    <td role="cell" className="col-start-1 col-span-2 row-start-1 min-w-0 p-0 sm:table-cell sm:px-4 sm:py-3">
                      <div className="font-medium text-gray-900 dark:text-gray-100">{sy.symbol}</div>
                      <div className="text-sm text-gray-500 dark:text-gray-400 break-words sm:break-normal">{sy.name}</div>
                    </td>
                    <td role="cell" className={`col-start-1 row-start-2 text-green-600 dark:text-green-400 ${MONEY_CELL}`}>
                      <CellLabel className={CAPTION_CLASS}>{yieldColumns.dividends.label}</CellLabel>
                      {fmtValue(sy.trailing12mDividends)}
                    </td>
                    <td role="cell" className={`col-start-2 row-start-2 text-gray-600 dark:text-gray-400 ${MONEY_CELL}`}>
                      <CellLabel className={CAPTION_CLASS}>{yieldColumns.marketValue.label}</CellLabel>
                      {fmtValue(sy.marketValue)}
                    </td>
                    {/* Yield is the headline the report is read for: the right
                        of line 1, beside the security. */}
                    <td role="cell" className={`col-start-3 row-start-1 font-medium text-gray-900 dark:text-gray-100 ${MONEY_CELL}`}>
                      <CellLabel className={CAPTION_CLASS}>{yieldColumns.yield.label}</CellLabel>
                      {formatPercent(sy.yield, 2)}
                    </td>
                    {/* Frequency is a word, so it may wrap; captioned like the
                        figures, and right-aligned to match the desktop cell. */}
                    <td role="cell" className="col-start-3 row-start-2 p-0 text-right text-xs text-gray-500 dark:text-gray-400 sm:table-cell sm:px-4 sm:py-3 sm:text-sm">
                      <CellLabel className={CAPTION_CLASS}>{yieldColumns.frequency.label}</CellLabel>
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
            {t('dividendYieldGrowth.annualIncomeTitle')}
          </h3>
          {annualData.length > 0 ? (
            <>
              <div className="h-80">
                <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                  <BarChart data={annualData}>
                    <CartesianGrid {...CHART_GRID_PROPS} />
                    <XAxis dataKey="year" tick={{ fontSize: 11 }} />
                    <YAxis tickFormatter={formatCurrencyAxis} />
                    <Tooltip
                      content={({ active, payload, label }) => {
                        if (!active || !payload?.length) return null;
                        const d = payload[0].payload as AnnualDividend;
                        return (
                          <div className={CHART_TOOLTIP_CLASS}>
                            <p className="font-medium text-gray-900 dark:text-gray-100">{label}</p>
                            <p className="text-sm text-green-600 dark:text-green-400">
                              {t('dividendYieldGrowth.tooltipDividends')} {fmtValue(d.amount)}
                            </p>
                            {d.growth !== null && (
                              <p className={`text-sm ${gainLossColor(d.growth)}`}>
                                {t('dividendYieldGrowth.tooltipGrowth')} {formatSignedPercent(d.growth, 1)}
                              </p>
                            )}
                          </div>
                        );
                      }}
                    />
                    <Bar dataKey="amount" fill={chartColors.income} name={t('dividendYieldGrowth.barDividends')} radius={[4, 4, 0, 0]} />
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
                        {t('dividendYieldGrowth.colYear')}
                      </SortableHeader>
                      <SortableHeader<GrowthSortField>
                        field="amount"
                        sortField={growthSort.sortField}
                        sortDirection={growthSort.sortDirection}
                        onSort={growthSort.handleSort}
                        align="right"
                        className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                      >
                        {t('dividendYieldGrowth.colDividendIncome')}
                      </SortableHeader>
                      <SortableHeader<GrowthSortField>
                        field="growth"
                        sortField={growthSort.sortField}
                        sortDirection={growthSort.sortDirection}
                        onSort={growthSort.handleSort}
                        align="right"
                        className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                      >
                        {t('dividendYieldGrowth.colYoYGrowth')}
                      </SortableHeader>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                    {sortedAnnualData.map((row) => (
                      <tr key={row.year} className="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                        <td className="px-4 py-3 text-sm font-medium text-gray-900 dark:text-gray-100">{row.year}</td>
                        <td className="px-4 py-3 text-sm text-right text-green-600 dark:text-green-400">{fmtValue(row.amount)}</td>
                        <td className={`px-4 py-3 text-sm text-right ${row.growth !== null ? (gainLossColor(row.growth)) : 'text-gray-400'}`}>
                          {row.growth !== null ? formatSignedPercent(row.growth, 1) : '-'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <EmptyState title={t('dividendYieldGrowth.noAnnualData')} />
          )}
        </div>
      ) : (
        /* Frequency Analysis */
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 px-2 py-4 sm:p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
            {t('dividendYieldGrowth.frequencyTitle')}
          </h3>
          {frequencyData.length > 0 ? (
            <>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                  <BarChart data={frequencyData}>
                    <CartesianGrid {...CHART_GRID_PROPS} />
                    <XAxis dataKey="frequency" tick={{ fontSize: 11 }} />
                    <YAxis tickFormatter={formatCurrencyAxis} />
                    <Tooltip
                      content={({ active, payload, label }) => {
                        if (!active || !payload?.length) return null;
                        const d = payload[0].payload as FrequencyBucket;
                        return (
                          <div className={CHART_TOOLTIP_CLASS}>
                            <p className="font-medium text-gray-900 dark:text-gray-100">{label}</p>
                            <p className="text-sm text-gray-600 dark:text-gray-400">{t('dividendYieldGrowth.tooltipSecurities', { count: d.count })}</p>
                            <p className="text-sm text-green-600 dark:text-green-400">{t('dividendYieldGrowth.tooltipTotal')} {fmtValue(d.totalDividends)}</p>
                          </div>
                        );
                      }}
                    />
                    <Bar dataKey="totalDividends" fill={CHART_SERIES[4]} name={t('dividendYieldGrowth.barTotalDividends')} radius={[4, 4, 0, 0]} />
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
                        {t('dividendYieldGrowth.colFrequencyLabel')}
                      </SortableHeader>
                      <SortableHeader<FrequencySortField>
                        field="count"
                        sortField={frequencySort.sortField}
                        sortDirection={frequencySort.sortDirection}
                        onSort={frequencySort.handleSort}
                        align="right"
                        className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                      >
                        {t('dividendYieldGrowth.colSecurities')}
                      </SortableHeader>
                      <SortableHeader<FrequencySortField>
                        field="totalDividends"
                        sortField={frequencySort.sortField}
                        sortDirection={frequencySort.sortDirection}
                        onSort={frequencySort.handleSort}
                        align="right"
                        className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                      >
                        {t('dividendYieldGrowth.colTotalDividends')}
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
            <EmptyState title={t('dividendYieldGrowth.noFrequencyData')} />
          )}
        </div>
      )}
    </div>
  );
}
