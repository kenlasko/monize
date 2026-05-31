'use client';

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
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
  Legend,
  ReferenceLine,
  Cell,
} from 'recharts';
import { format, eachMonthOfInterval } from 'date-fns';
import { investmentsApi } from '@/lib/investments';
import { InvestmentTransaction, CapitalGainEntry } from '@/types/investment';
import { Account } from '@/types/account';
import { parseLocalDate } from '@/lib/utils';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { useDateRange } from '@/hooks/useDateRange';
import { DateRangeSelector } from '@/components/ui/DateRangeSelector';
import { ExportDropdown } from '@/components/ui/ExportDropdown';
import { MultiSelect } from '@/components/ui/MultiSelect';
import { RefreshPricesButton } from '@/components/reports/RefreshPricesButton';
import { SortableHeader } from '@/components/ui/SortableHeader';
import { useSortableTable, compareValues } from '@/hooks/useSortableTable';
import { exportToCsv } from '@/lib/csv-export';

type SeriesKey = 'dividends' | 'interest' | 'capitalGains';
type MonthlyIncomeSortField = 'month' | 'startValue' | 'endValue' | 'dividends' | 'interest' | 'capitalGains' | 'total';
type DailyIncomeSortField = 'date' | 'startValue' | 'endValue' | 'dividends' | 'interest' | 'capitalGains' | 'total';
type SecurityIncomeSortField = 'symbol' | 'dividends' | 'interest' | 'capitalGains' | 'total';

interface MonthlyIncome {
  month: string;
  label: string;
  startValue: number;
  endValue: number;
  dividends: number;
  interest: number;
  capitalGains: number;
  total: number;
}

interface SecurityIncome {
  symbol: string;
  name: string;
  dividends: number;
  interest: number;
  capitalGains: number;
  total: number;
}

interface DailyIncome {
  date: string;
  label: string;
  startValue: number;
  endValue: number;
  dividends: number;
  interest: number;
  capitalGains: number;
  total: number;
}

const SERIES_COLORS: Record<SeriesKey, { positive: string; negative: string; label: string }> = {
  dividends: { positive: '#22c55e', negative: '#22c55e', label: 'Dividends' },
  interest: { positive: '#3b82f6', negative: '#3b82f6', label: 'Interest' },
  capitalGains: { positive: '#8b5cf6', negative: '#ef4444', label: 'Capital Gains' },
};

export function DividendIncomeReport() {
  const { formatCurrency: formatCurrencyFull, formatCurrencyAxis } = useNumberFormat();
  const { defaultCurrency, convertToDefault } = useExchangeRates();
  const chartRef = useRef<HTMLDivElement>(null);
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
  // Debounced mirror of selectedAccountIds. The data-load effect keys off
  // this, not the raw selection, so rapid toggles in the MultiSelect (e.g.
  // ticking three accounts in a row) don't fire one fetch per click.
  const [appliedAccountIds, setAppliedAccountIds] = useState<string[]>([]);
  const accountDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (accountDebounceRef.current) clearTimeout(accountDebounceRef.current);
  }, []);
  const [selectedSecurityId, setSelectedSecurityId] = useState<string>('');
  // When exactly one account is selected we keep its native currency; with no
  // selection (all accounts) or several selected accounts we may have mixed
  // currencies, so we convert into the user's default currency.
  const isSingleAccount = selectedAccountIds.length === 1;
  const { dateRange, setDateRange, resolvedRange, isValid } = useDateRange({ defaultRange: '1y', alignment: 'month' });
  const [viewType, setViewType] = useState<'monthly' | 'daily' | 'bySecurity'>('monthly');
  const [monthlyDisplay, setMonthlyDisplay] = useState<'chart' | 'table'>('chart');
  const [hideInactiveDays, setHideInactiveDays] = useState(false);
  const [visibleSeries, setVisibleSeries] = useState<Record<SeriesKey, boolean>>({
    dividends: true,
    interest: true,
    capitalGains: true,
  });
  const monthlySort = useSortableTable<MonthlyIncomeSortField>(
    'reports.dividend-income.monthly.sort',
    { field: 'month', direction: 'asc' },
  );
  const dailySort = useSortableTable<DailyIncomeSortField>(
    'reports.dividend-income.daily.sort',
    { field: 'date', direction: 'asc' },
  );
  const securitySort = useSortableTable<SecurityIncomeSortField>(
    'reports.dividend-income.security.sort',
    { field: 'total', direction: 'desc' },
  );

  const { start: rangeStart, end: rangeEnd } = resolvedRange;
  // Capital gains require a window; fall back to a wide window when the user
  // picks "All Time" so the backend still has bounds to enumerate.
  const cgStart = rangeStart || '1970-01-01';
  const accountIdsParam = appliedAccountIds.length > 0
    ? appliedAccountIds.join(',')
    : undefined;

  // Primary data load: dividend / interest / CAPITAL_GAIN transactions, the
  // monthly capital gains, and the account list. `reloadAll` is wired to the
  // RefreshPricesButton so a manual price refresh re-fetches everything
  // (including the daily view's lazy capital gains below).
  const {
    data: response,
    isLoading,
    error,
    reload: reloadPrimary,
  } = useReportData(
    async () => {
      if (!isValid) return null;

      const accountsPromise = investmentsApi.getInvestmentAccounts();
      const capitalGainsPromise = investmentsApi.getCapitalGains({
        accountIds: accountIdsParam,
        startDate: cgStart,
        endDate: rangeEnd,
      });

      // Paginate through all transactions (API limit is 200 per page). Run the
      // pagination loop concurrently with the accounts and capital gains
      // requests instead of awaiting it first -- otherwise the three fetches
      // serialize and the slowest path is the sum of all of them.
      const transactionsPromise = (async () => {
        let allTransactions: InvestmentTransaction[] = [];
        let page = 1;
        let hasMore = true;
        while (hasMore) {
          const result = await investmentsApi.getTransactions({
            accountIds: accountIdsParam,
            startDate: rangeStart || undefined,
            endDate: rangeEnd,
            limit: 200,
            page,
          });
          allTransactions = allTransactions.concat(result.data);
          hasMore = result.pagination.hasMore;
          page++;
        }
        return allTransactions;
      })();

      const [allTransactions, accountsData, capitalGainsData] = await Promise.all([
        transactionsPromise,
        accountsPromise,
        capitalGainsPromise,
      ]);

      // Dividend / Interest / CAPITAL_GAIN income comes from the plain
      // transaction list; SELL realized + unrealized capital gains come from
      // the monthly capital gains endpoint.
      const incomeTransactions = allTransactions.filter(
        (tx) =>
          tx.action === 'DIVIDEND' ||
          tx.action === 'INTEREST' ||
          tx.action === 'CAPITAL_GAIN',
      );

      return {
        transactions: incomeTransactions,
        capitalGains: capitalGainsData,
        accounts: accountsData,
      };
    },
    [appliedAccountIds, rangeStart, rangeEnd, isValid],
  );

  const transactions = useMemo<InvestmentTransaction[]>(
    () => response?.transactions ?? [],
    [response],
  );
  const capitalGains = useMemo<CapitalGainEntry[]>(
    () => response?.capitalGains ?? [],
    [response],
  );
  const accounts = useMemo<Account[]>(
    () => response?.accounts ?? [],
    [response],
  );

  // Lazy-load daily capital gains only when the user switches to the daily view.
  const { data: dailyResponse, reload: reloadDaily } = useReportData(
    () =>
      viewType === 'daily' && isValid
        ? investmentsApi.getCapitalGains({
            accountIds: accountIdsParam,
            startDate: cgStart,
            endDate: rangeEnd,
            granularity: 'day',
          })
        : Promise.resolve(null),
    [viewType, appliedAccountIds, rangeStart, rangeEnd, isValid],
  );

  const dailyCapitalGains = useMemo<CapitalGainEntry[]>(
    () => dailyResponse ?? [],
    [dailyResponse],
  );

  const reloadAll = useCallback(() => {
    reloadPrimary();
    reloadDaily();
  }, [reloadPrimary, reloadDaily]);

  // Build account currency lookup
  const accountCurrencyMap = useMemo(() => {
    const map = new Map<string, string>();
    accounts.forEach((a) => map.set(a.id, a.currencyCode));
    return map;
  }, [accounts]);

  // Securities present in the currently-loaded (account-filtered) data.
  // Transactions and capital gains are already narrowed by the backend when an
  // account is selected, so deriving the list from them naturally hides
  // securities from other accounts.
  const availableSecurities = useMemo(() => {
    const map = new Map<string, { id: string; symbol: string; name: string }>();
    for (const tx of transactions) {
      if (!tx.securityId || !tx.security) continue;
      if (!map.has(tx.securityId)) {
        map.set(tx.securityId, {
          id: tx.securityId,
          symbol: tx.security.symbol,
          name: tx.security.name,
        });
      }
    }
    for (const entry of [...capitalGains, ...dailyCapitalGains]) {
      if (!map.has(entry.securityId)) {
        map.set(entry.securityId, {
          id: entry.securityId,
          symbol: entry.symbol || 'Unknown',
          name: entry.securityName || 'Unknown Security',
        });
      }
    }
    return Array.from(map.values()).sort((a, b) => a.symbol.localeCompare(b.symbol));
  }, [transactions, capitalGains, dailyCapitalGains]);

  // Clear the security filter when the account changes or when the selected
  // security drops out of the available set (e.g. switching to an account
  // that doesn't hold it).
  useEffect(() => {
    if (
      selectedSecurityId &&
      !availableSecurities.some((s) => s.id === selectedSecurityId)
    ) {
      setSelectedSecurityId('');
    }
  }, [selectedSecurityId, availableSecurities]);

  const filteredTransactions = useMemo(() => {
    if (!selectedSecurityId) return transactions;
    return transactions.filter((tx) => tx.securityId === selectedSecurityId);
  }, [transactions, selectedSecurityId]);

  const filteredCapitalGains = useMemo(() => {
    if (!selectedSecurityId) return capitalGains;
    return capitalGains.filter((e) => e.securityId === selectedSecurityId);
  }, [capitalGains, selectedSecurityId]);

  const filteredDailyCapitalGains = useMemo(() => {
    if (!selectedSecurityId) return dailyCapitalGains;
    return dailyCapitalGains.filter((e) => e.securityId === selectedSecurityId);
  }, [dailyCapitalGains, selectedSecurityId]);

  // When a single account is selected, show in native currency; otherwise convert to default
  const selectedAccount = isSingleAccount
    ? accounts.find((a) => a.id === selectedAccountIds[0])
    : undefined;
  const displayCurrency = selectedAccount?.currencyCode || defaultCurrency;
  const isForeign = displayCurrency !== defaultCurrency;

  const getTxAmount = useCallback((tx: InvestmentTransaction): number => {
    const amount = Math.abs(tx.totalAmount);
    if (isSingleAccount) {
      // Single account selected: native currency, no conversion needed
      return amount;
    }
    // All accounts or multiple selected: convert to default currency
    const txCurrency = accountCurrencyMap.get(tx.accountId) || defaultCurrency;
    return convertToDefault(amount, txCurrency);
  }, [isSingleAccount, accountCurrencyMap, defaultCurrency, convertToDefault]);

  // Backend already returns each capital gain entry in the holding account's
  // currency. Convert to the default currency for multi-account views; pass
  // through when a single account is selected.
  const convertCapitalGain = useCallback((entry: CapitalGainEntry): number => {
    if (isSingleAccount) return entry.totalCapitalGain;
    return convertToDefault(entry.totalCapitalGain, entry.accountCurrencyCode || defaultCurrency);
  }, [isSingleAccount, defaultCurrency, convertToDefault]);

  // Same conversion as convertCapitalGain but applied to an arbitrary amount
  // denominated in the entry's account currency (e.g. start/end market values).
  const convertFromAccountCurrency = useCallback(
    (amount: number, accountCurrencyCode: string | null): number => {
      if (isSingleAccount) return amount;
      return convertToDefault(amount, accountCurrencyCode || defaultCurrency);
    },
    [isSingleAccount, defaultCurrency, convertToDefault],
  );

  const fmtValue = useCallback((value: number): string => {
    if (isForeign) {
      return `${formatCurrencyFull(value, displayCurrency)} ${displayCurrency}`;
    }
    return formatCurrencyFull(value);
  }, [isForeign, displayCurrency, formatCurrencyFull]);

  const monthlyData = useMemo((): MonthlyIncome[] => {
    const { start, end } = resolvedRange;
    if (!start && dateRange !== 'all') return [];

    const startDate = start ? parseLocalDate(start) : null;
    const endDate = parseLocalDate(end);

    // Get all months in range
    const months = startDate
      ? eachMonthOfInterval({ start: startDate, end: endDate })
      : [];

    // Initialize month buckets
    const monthMap = new Map<string, MonthlyIncome>();
    months.forEach((month) => {
      const key = format(month, 'yyyy-MM');
      monthMap.set(key, {
        month: key,
        label: format(month, 'MMM yyyy'),
        startValue: 0,
        endValue: 0,
        dividends: 0,
        interest: 0,
        capitalGains: 0,
        total: 0,
      });
    });

    const getOrCreateBucket = (txDate: Date): MonthlyIncome => {
      const monthKey = format(txDate, 'yyyy-MM');
      let bucket = monthMap.get(monthKey);
      if (!bucket) {
        bucket = {
          month: monthKey,
          label: format(txDate, 'MMM yyyy'),
          startValue: 0,
          endValue: 0,
          dividends: 0,
          interest: 0,
          capitalGains: 0,
          total: 0,
        };
        monthMap.set(monthKey, bucket);
      }
      return bucket;
    };

    filteredTransactions.forEach((tx) => {
      const bucket = getOrCreateBucket(parseLocalDate(tx.transactionDate));
      const contribution = getTxAmount(tx);
      switch (tx.action) {
        case 'DIVIDEND':
          bucket.dividends += contribution;
          break;
        case 'INTEREST':
          bucket.interest += contribution;
          break;
        case 'CAPITAL_GAIN':
          bucket.capitalGains += contribution;
          break;
      }
      bucket.total += contribution;
    });

    filteredCapitalGains.forEach((entry) => {
      // entry.month is YYYY-MM; create a date in the middle of the month so
      // local-timezone parsing puts it in the right bucket.
      const monthDate = parseLocalDate(`${entry.month}-15`);
      const bucket = getOrCreateBucket(monthDate);
      const gain = convertCapitalGain(entry);
      bucket.capitalGains += gain;
      bucket.total += gain;
      // Start/end market values sum across securities to give a portfolio
      // mark-to-market snapshot at each month boundary.
      bucket.startValue += convertFromAccountCurrency(
        entry.startValue,
        entry.accountCurrencyCode,
      );
      bucket.endValue += convertFromAccountCurrency(
        entry.endValue,
        entry.accountCurrencyCode,
      );
    });

    return Array.from(monthMap.values()).sort((a, b) => a.month.localeCompare(b.month));
  }, [filteredTransactions, filteredCapitalGains, dateRange, resolvedRange, getTxAmount, convertCapitalGain, convertFromAccountCurrency]);

  // Daily view: mirrors monthlyData but at daily granularity, combining
  // transaction-level income (DIVIDEND, INTEREST, CAPITAL_GAIN) with the
  // daily capital gains from the backend (realized + unrealized per day).
  const dailyData = useMemo((): DailyIncome[] => {
    const dayMap = new Map<string, DailyIncome>();

    const getOrCreateBucket = (dateKey: string, txDate: Date): DailyIncome => {
      let bucket = dayMap.get(dateKey);
      if (!bucket) {
        bucket = {
          date: dateKey,
          label: format(txDate, 'MMM d, yyyy'),
          startValue: 0,
          endValue: 0,
          dividends: 0,
          interest: 0,
          capitalGains: 0,
          total: 0,
        };
        dayMap.set(dateKey, bucket);
      }
      return bucket;
    };

    filteredTransactions.forEach((tx) => {
      const txDate = parseLocalDate(tx.transactionDate);
      const bucket = getOrCreateBucket(tx.transactionDate, txDate);
      const contribution = getTxAmount(tx);
      switch (tx.action) {
        case 'DIVIDEND':
          bucket.dividends += contribution;
          break;
        case 'INTEREST':
          bucket.interest += contribution;
          break;
        case 'CAPITAL_GAIN':
          bucket.capitalGains += contribution;
          break;
      }
      bucket.total += contribution;
    });

    filteredDailyCapitalGains.forEach((entry) => {
      // Daily entries use YYYY-MM-DD in the month field. Skip anything that
      // doesn't match (e.g. an older backend echoing monthly entries) so
      // parseLocalDate / format() don't blow up on a partial date.
      if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.month)) return;
      const txDate = parseLocalDate(entry.month);
      const bucket = getOrCreateBucket(entry.month, txDate);
      const gain = convertCapitalGain(entry);
      bucket.capitalGains += gain;
      bucket.total += gain;
      bucket.startValue += convertFromAccountCurrency(entry.startValue, entry.accountCurrencyCode);
      bucket.endValue += convertFromAccountCurrency(entry.endValue, entry.accountCurrencyCode);
    });

    return Array.from(dayMap.values()).sort((a, b) => a.date.localeCompare(b.date));
  }, [filteredTransactions, filteredDailyCapitalGains, getTxAmount, convertCapitalGain, convertFromAccountCurrency]);

  // When hideInactiveDays is enabled, drop rows with no income and no price
  // movement. On weekends/holidays the market is closed, so capital gains are
  // zero (start and end values are identical) and there are no dividend or
  // interest transactions. Start/End value alone is not a useful signal — the
  // portfolio still has a value sitting on those non-trading days.
  const displayedDailyData = useMemo(
    () =>
      hideInactiveDays
        ? dailyData.filter(
            (row) =>
              row.dividends !== 0 ||
              row.interest !== 0 ||
              row.capitalGains !== 0,
          )
        : dailyData,
    [dailyData, hideInactiveDays],
  );

  // Only stack series where every value is non-negative; once losses appear
  // we render bars side-by-side so negatives can drop below the zero line
  // instead of being hidden inside a stack. Memoized so the per-render array
  // scans don't run on every keystroke/interaction.
  const hasNegativeCapitalGains = useMemo(
    () => monthlyData.some((m) => m.capitalGains < 0),
    [monthlyData],
  );
  const dailyHasNegativeCapitalGains = useMemo(
    () => displayedDailyData.some((d) => d.capitalGains < 0),
    [displayedDailyData],
  );

  // Account filter options for the MultiSelect, memoized so the filter/sort/map
  // chain (and the new array of option objects) is not rebuilt every render.
  const accountOptions = useMemo(
    () =>
      accounts
        .filter((a) => a.accountSubType !== 'INVESTMENT_BROKERAGE')
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((account) => ({
          value: account.id,
          label: account.name.replace(/ - (Brokerage|Cash)$/, ''),
        })),
    [accounts],
  );

  const securityData = useMemo((): SecurityIncome[] => {
    const securityMap = new Map<string, SecurityIncome>();

    const getOrCreateBucket = (symbol: string, name: string): SecurityIncome => {
      let bucket = securityMap.get(symbol);
      if (!bucket) {
        bucket = { symbol, name, dividends: 0, interest: 0, capitalGains: 0, total: 0 };
        securityMap.set(symbol, bucket);
      }
      return bucket;
    };

    filteredTransactions.forEach((tx) => {
      const symbol = tx.security?.symbol || 'Unknown';
      const name = tx.security?.name || 'Unknown Security';
      const bucket = getOrCreateBucket(symbol, name);
      const contribution = getTxAmount(tx);
      switch (tx.action) {
        case 'DIVIDEND':
          bucket.dividends += contribution;
          break;
        case 'INTEREST':
          bucket.interest += contribution;
          break;
        case 'CAPITAL_GAIN':
          bucket.capitalGains += contribution;
          break;
      }
      bucket.total += contribution;
    });

    filteredCapitalGains.forEach((entry) => {
      const symbol = entry.symbol || 'Unknown';
      const name = entry.securityName || 'Unknown Security';
      const bucket = getOrCreateBucket(symbol, name);
      const gain = convertCapitalGain(entry);
      bucket.capitalGains += gain;
      bucket.total += gain;
    });

    return Array.from(securityMap.values());
  }, [filteredTransactions, filteredCapitalGains, getTxAmount, convertCapitalGain]);

  const sortedMonthlyData = useMemo(() => {
    const sorted = [...monthlyData];
    sorted.sort((a, b) => {
      let comparison = 0;
      switch (monthlySort.sortField) {
        case 'month':
          comparison = compareValues(a.month, b.month);
          break;
        case 'startValue':
          comparison = compareValues(a.startValue, b.startValue);
          break;
        case 'endValue':
          comparison = compareValues(a.endValue, b.endValue);
          break;
        case 'dividends':
          comparison = compareValues(a.dividends, b.dividends);
          break;
        case 'interest':
          comparison = compareValues(a.interest, b.interest);
          break;
        case 'capitalGains':
          comparison = compareValues(a.capitalGains, b.capitalGains);
          break;
        case 'total':
          comparison = compareValues(
            (visibleSeries.dividends ? a.dividends : 0) +
              (visibleSeries.interest ? a.interest : 0) +
              (visibleSeries.capitalGains ? a.capitalGains : 0),
            (visibleSeries.dividends ? b.dividends : 0) +
              (visibleSeries.interest ? b.interest : 0) +
              (visibleSeries.capitalGains ? b.capitalGains : 0),
          );
          break;
      }
      return monthlySort.sortDirection === 'asc' ? comparison : -comparison;
    });
    return sorted;
  }, [monthlyData, monthlySort.sortField, monthlySort.sortDirection, visibleSeries]);

  const sortedDailyData = useMemo(() => {
    const sorted = [...displayedDailyData];
    sorted.sort((a, b) => {
      let comparison = 0;
      switch (dailySort.sortField) {
        case 'date':
          comparison = compareValues(a.date, b.date);
          break;
        case 'startValue':
          comparison = compareValues(a.startValue, b.startValue);
          break;
        case 'endValue':
          comparison = compareValues(a.endValue, b.endValue);
          break;
        case 'dividends':
          comparison = compareValues(a.dividends, b.dividends);
          break;
        case 'interest':
          comparison = compareValues(a.interest, b.interest);
          break;
        case 'capitalGains':
          comparison = compareValues(a.capitalGains, b.capitalGains);
          break;
        case 'total':
          comparison = compareValues(
            (visibleSeries.dividends ? a.dividends : 0) +
              (visibleSeries.interest ? a.interest : 0) +
              (visibleSeries.capitalGains ? a.capitalGains : 0),
            (visibleSeries.dividends ? b.dividends : 0) +
              (visibleSeries.interest ? b.interest : 0) +
              (visibleSeries.capitalGains ? b.capitalGains : 0),
          );
          break;
      }
      return dailySort.sortDirection === 'asc' ? comparison : -comparison;
    });
    return sorted;
  }, [displayedDailyData, dailySort.sortField, dailySort.sortDirection, visibleSeries]);

  const sortedSecurityData = useMemo(() => {
    const sorted = [...securityData];
    sorted.sort((a, b) => {
      let comparison = 0;
      switch (securitySort.sortField) {
        case 'symbol':
          comparison = compareValues(a.symbol, b.symbol);
          break;
        case 'dividends':
          comparison = compareValues(a.dividends, b.dividends);
          break;
        case 'interest':
          comparison = compareValues(a.interest, b.interest);
          break;
        case 'capitalGains':
          comparison = compareValues(a.capitalGains, b.capitalGains);
          break;
        case 'total':
          comparison = compareValues(a.total, b.total);
          break;
      }
      return securitySort.sortDirection === 'asc' ? comparison : -comparison;
    });
    return sorted;
  }, [securityData, securitySort.sortField, securitySort.sortDirection]);

  const totals = useMemo(() => {
    const dividends = filteredTransactions
      .filter((t) => t.action === 'DIVIDEND')
      .reduce((sum, t) => sum + getTxAmount(t), 0);
    const interest = filteredTransactions
      .filter((t) => t.action === 'INTEREST')
      .reduce((sum, t) => sum + getTxAmount(t), 0);
    const manualCapitalGains = filteredTransactions
      .filter((t) => t.action === 'CAPITAL_GAIN')
      .reduce((sum, t) => sum + getTxAmount(t), 0);
    const periodCapitalGains = filteredCapitalGains.reduce(
      (sum, entry) => sum + convertCapitalGain(entry),
      0,
    );
    const totalGains = manualCapitalGains + periodCapitalGains;
    return {
      dividends,
      interest,
      capitalGains: totalGains,
      total: dividends + interest + totalGains,
    };
  }, [filteredTransactions, filteredCapitalGains, getTxAmount, convertCapitalGain]);

  // CSV is only offered when the user is looking at a table. Raw numeric
  // values (no currency formatting) are written so spreadsheets can sum and
  // filter them; the currency code goes into a dedicated column.
  const isTableView =
    viewType === 'bySecurity' ||
    (viewType === 'monthly' && monthlyDisplay === 'table') ||
    (viewType === 'daily' && monthlyDisplay === 'table');

  const round4 = (n: number) => Math.round(n * 10000) / 10000;

  const handleExportCsv = () => {
    const accountLabel = selectedAccount
      ? selectedAccount.name.replace(/ - (Brokerage|Cash)$/, '')
      : 'all-accounts';
    const filenameBase = 'gains-dividends-interest';
    const scope = accountLabel.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const currencyCode = displayCurrency;

    if (viewType === 'bySecurity') {
      const headers = [
        'Symbol',
        'Security',
        'Dividends',
        'Interest',
        'Capital Gains',
        'Total',
        'Currency',
      ];
      const rows = securityData.map((s) => [
        s.symbol,
        s.name,
        round4(s.dividends),
        round4(s.interest),
        round4(s.capitalGains),
        round4(s.total),
        currencyCode,
      ]);
      exportToCsv(`${filenameBase}-by-security-${scope}`, headers, rows);
      return;
    }

    if (viewType === 'daily') {
      const headers: string[] = ['Date', 'Start Value', 'End Value'];
      if (visibleSeries.dividends) headers.push('Dividends');
      if (visibleSeries.interest) headers.push('Interest');
      if (visibleSeries.capitalGains) headers.push('Capital Gains');
      headers.push('Total', 'Currency');
      const rows = displayedDailyData.map((row) => {
        const out: (string | number)[] = [row.date, round4(row.startValue), round4(row.endValue)];
        let total = 0;
        if (visibleSeries.dividends) {
          out.push(round4(row.dividends));
          total += row.dividends;
        }
        if (visibleSeries.interest) {
          out.push(round4(row.interest));
          total += row.interest;
        }
        if (visibleSeries.capitalGains) {
          out.push(round4(row.capitalGains));
          total += row.capitalGains;
        }
        out.push(round4(total), currencyCode);
        return out;
      });
      exportToCsv(`${filenameBase}-daily-${scope}`, headers, rows);
      return;
    }

    // Monthly table export. Respect the series visibility toggles so the CSV
    // matches what the user sees; the Total column reflects only the visible
    // series (same logic as the rendered table).
    const headers: string[] = ['Month', 'Start Value', 'End Value'];
    if (visibleSeries.dividends) headers.push('Dividends');
    if (visibleSeries.interest) headers.push('Interest');
    if (visibleSeries.capitalGains) headers.push('Capital Gains');
    headers.push('Total', 'Currency');
    const rows = monthlyData.map((row) => {
      const out: (string | number)[] = [
        row.month,
        round4(row.startValue),
        round4(row.endValue),
      ];
      let total = 0;
      if (visibleSeries.dividends) {
        out.push(round4(row.dividends));
        total += row.dividends;
      }
      if (visibleSeries.interest) {
        out.push(round4(row.interest));
        total += row.interest;
      }
      if (visibleSeries.capitalGains) {
        out.push(round4(row.capitalGains));
        total += row.capitalGains;
      }
      out.push(round4(total), currencyCode);
      return out;
    });
    exportToCsv(`${filenameBase}-monthly-${scope}`, headers, rows);
  };

  const handleExportPdf = async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    const accountLabel = selectedAccount
      ? selectedAccount.name.replace(/ - (Brokerage|Cash)$/, '')
      : 'All Accounts';

    // Build a PDF table that mirrors what's on screen when the user is in a
    // table view; fall back to chart capture for the chart view.
    let tableData: {
      headers: string[];
      rows: (string | number)[][];
      totalRow?: (string | number)[];
    } | undefined;

    if (viewType === 'bySecurity') {
      tableData = {
        headers: ['Symbol', 'Security', 'Dividends', 'Interest', 'Capital Gains', 'Total'],
        rows: securityData.map((s) => [
          s.symbol,
          s.name,
          fmtValue(s.dividends),
          fmtValue(s.interest),
          fmtValue(s.capitalGains),
          fmtValue(s.total),
        ]),
        totalRow: [
          'Total',
          '',
          fmtValue(totals.dividends),
          fmtValue(totals.interest),
          fmtValue(totals.capitalGains),
          fmtValue(totals.total),
        ],
      };
    } else if (viewType === 'daily' && monthlyDisplay === 'table') {
      const headers: string[] = ['Date', 'Start Value', 'End Value'];
      if (visibleSeries.dividends) headers.push('Dividends');
      if (visibleSeries.interest) headers.push('Interest');
      if (visibleSeries.capitalGains) headers.push('Capital Gains');
      headers.push('Total');
      const rows = displayedDailyData.map((row) => {
        const out: (string | number)[] = [row.label, fmtValue(row.startValue), fmtValue(row.endValue)];
        let rowTotal = 0;
        if (visibleSeries.dividends) {
          out.push(fmtValue(row.dividends));
          rowTotal += row.dividends;
        }
        if (visibleSeries.interest) {
          out.push(fmtValue(row.interest));
          rowTotal += row.interest;
        }
        if (visibleSeries.capitalGains) {
          out.push(fmtValue(row.capitalGains));
          rowTotal += row.capitalGains;
        }
        out.push(fmtValue(rowTotal));
        return out;
      });
      const dailyTotals = displayedDailyData.reduce(
        (acc, row) => ({
          dividends: acc.dividends + row.dividends,
          interest: acc.interest + row.interest,
          capitalGains: acc.capitalGains + row.capitalGains,
        }),
        { dividends: 0, interest: 0, capitalGains: 0 },
      );
      const totalRow: (string | number)[] = ['Total', '', ''];
      let grandTotal = 0;
      if (visibleSeries.dividends) {
        totalRow.push(fmtValue(dailyTotals.dividends));
        grandTotal += dailyTotals.dividends;
      }
      if (visibleSeries.interest) {
        totalRow.push(fmtValue(dailyTotals.interest));
        grandTotal += dailyTotals.interest;
      }
      if (visibleSeries.capitalGains) {
        totalRow.push(fmtValue(dailyTotals.capitalGains));
        grandTotal += dailyTotals.capitalGains;
      }
      totalRow.push(fmtValue(grandTotal));
      tableData = { headers, rows, totalRow };
    } else if (viewType === 'monthly' && monthlyDisplay === 'table') {
      const headers: string[] = ['Month', 'Start Value', 'End Value'];
      if (visibleSeries.dividends) headers.push('Dividends');
      if (visibleSeries.interest) headers.push('Interest');
      if (visibleSeries.capitalGains) headers.push('Capital Gains');
      headers.push('Total');
      const rows = monthlyData.map((row) => {
        const out: (string | number)[] = [
          row.label,
          fmtValue(row.startValue),
          fmtValue(row.endValue),
        ];
        let rowTotal = 0;
        if (visibleSeries.dividends) {
          out.push(fmtValue(row.dividends));
          rowTotal += row.dividends;
        }
        if (visibleSeries.interest) {
          out.push(fmtValue(row.interest));
          rowTotal += row.interest;
        }
        if (visibleSeries.capitalGains) {
          out.push(fmtValue(row.capitalGains));
          rowTotal += row.capitalGains;
        }
        out.push(fmtValue(rowTotal));
        return out;
      });
      // Column totals across the whole window, respecting hidden series so the
      // footer sum matches the visible columns. Start/End values are point-in-
      // time snapshots so a column sum would be meaningless — leave them blank.
      const totalRow: (string | number)[] = ['Total', '', ''];
      let grandTotal = 0;
      if (visibleSeries.dividends) {
        totalRow.push(fmtValue(totals.dividends));
        grandTotal += totals.dividends;
      }
      if (visibleSeries.interest) {
        totalRow.push(fmtValue(totals.interest));
        grandTotal += totals.interest;
      }
      if (visibleSeries.capitalGains) {
        totalRow.push(fmtValue(totals.capitalGains));
        grandTotal += totals.capitalGains;
      }
      totalRow.push(fmtValue(grandTotal));
      tableData = { headers, rows, totalRow };
    }

    await exportToPdf({
      title: 'Gains, Dividends & Interest',
      subtitle: accountLabel,
      summaryCards: [
        { label: 'Dividends', value: fmtValue(totals.dividends), color: '#16a34a' },
        { label: 'Interest', value: fmtValue(totals.interest), color: '#2563eb' },
        { label: 'Capital Gains', value: fmtValue(totals.capitalGains), color: totals.capitalGains < 0 ? '#dc2626' : '#9333ea' },
        { label: 'Total Income', value: fmtValue(totals.total), color: '#111827' },
      ],
      chartContainer: tableData ? undefined : chartRef.current,
      tableData,
      filename: 'gains-dividends-interest',
    });
  };

  const toggleSeries = (key: SeriesKey) => {
    setVisibleSeries((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const CustomTooltip = ({ active, payload, label }: { active?: boolean; payload?: Array<{ name: string; value: number; color: string; dataKey?: string }>; label?: string }) => {
    if (active && payload && payload.length) {
      // Recharts can pass a Cell-coloured payload entry; surface signed values
      // and use the original series colour rather than the per-bar Cell colour.
      return (
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
          <p className="font-medium text-gray-900 dark:text-gray-100 mb-1">{label}</p>
          {payload.map((entry, index) => {
            const seriesKey = entry.dataKey as SeriesKey | undefined;
            const colour = seriesKey
              ? entry.value < 0
                ? SERIES_COLORS[seriesKey].negative
                : SERIES_COLORS[seriesKey].positive
              : entry.color;
            return (
              <p key={index} className="text-sm" style={{ color: colour }}>
                {entry.name}: {fmtValue(entry.value)}
              </p>
            );
          })}
        </div>
      );
    }
    return null;
  };

  if (error) {
    return <ReportError onRetry={reloadAll} />;
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

  const stackId = hasNegativeCapitalGains ? undefined : 'a';
  const dailyStackId = dailyHasNegativeCapitalGains ? undefined : 'a';

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-green-50 dark:bg-green-900/20 rounded-lg p-4">
          <div className="text-sm text-green-600 dark:text-green-400">Dividends</div>
          <div className="text-xl font-bold text-green-700 dark:text-green-300">
            {fmtValue(totals.dividends)}
          </div>
        </div>
        <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-4">
          <div className="text-sm text-blue-600 dark:text-blue-400">Interest</div>
          <div className="text-xl font-bold text-blue-700 dark:text-blue-300">
            {fmtValue(totals.interest)}
          </div>
        </div>
        <div className={`rounded-lg p-4 ${totals.capitalGains < 0 ? 'bg-red-50 dark:bg-red-900/20' : 'bg-purple-50 dark:bg-purple-900/20'}`}>
          <div className={`text-sm ${totals.capitalGains < 0 ? 'text-red-600 dark:text-red-400' : 'text-purple-600 dark:text-purple-400'}`}>Capital Gains</div>
          <div className={`text-xl font-bold ${totals.capitalGains < 0 ? 'text-red-700 dark:text-red-300' : 'text-purple-700 dark:text-purple-300'}`}>
            {fmtValue(totals.capitalGains)}
          </div>
        </div>
        <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-4">
          <div className="text-sm text-gray-600 dark:text-gray-400">Total Income</div>
          <div className="text-xl font-bold text-gray-900 dark:text-gray-100">
            {fmtValue(totals.total)}
          </div>
        </div>
      </div>

      {/* Controls */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex flex-wrap gap-3 items-center">
          <div className="w-48">
            <MultiSelect
              ariaLabel="Filter by account"
              placeholder="All Accounts"
              options={accountOptions}
              value={selectedAccountIds}
              onChange={(values) => {
                setSelectedAccountIds(values);
                // Reset security filter when the account selection changes so
                // stale selections can't hide all rows.
                setSelectedSecurityId('');
                // Debounce the actual reload so rapid checkbox toggles (the
                // typical multi-account selection flow) collapse into a single
                // fetch once the user pauses.
                if (accountDebounceRef.current) {
                  clearTimeout(accountDebounceRef.current);
                }
                accountDebounceRef.current = setTimeout(() => {
                  setAppliedAccountIds(values);
                  accountDebounceRef.current = null;
                }, 350);
              }}
            />
          </div>
          <select
            value={selectedSecurityId}
            onChange={(e) => setSelectedSecurityId(e.target.value)}
            className="max-w-48 rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 text-sm"
            aria-label="Filter by security"
            disabled={availableSecurities.length === 0}
          >
            <option value="">All Securities</option>
            {availableSecurities.map((security) => (
              <option key={security.id} value={security.id}>
                {security.symbol}
                {security.name ? ` — ${security.name}` : ''}
              </option>
            ))}
          </select>
          <DateRangeSelector
            ranges={['6m', '1y', '2y', 'all']}
            value={dateRange}
            onChange={setDateRange}
          />
          <div className="ml-auto shrink-0 flex gap-2 items-center">
            <button
              onClick={() => setViewType('monthly')}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                viewType === 'monthly'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
              }`}
            >
              Monthly
            </button>
            <button
              onClick={() => setViewType('daily')}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                viewType === 'daily'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
              }`}
            >
              Daily
            </button>
            <button
              onClick={() => setViewType('bySecurity')}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                viewType === 'bySecurity'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
              }`}
            >
              By Security
            </button>
            <RefreshPricesButton onRefreshComplete={reloadAll} />
            <ExportDropdown
              onExportPdf={handleExportPdf}
              onExportCsv={isTableView ? handleExportCsv : undefined}
            />
          </div>
        </div>
        {/* Monthly/Daily view sub-controls: chart/table switch + series toggles */}
        {(viewType === 'monthly' || viewType === 'daily') && (
          <div className="flex flex-wrap gap-4 mt-3 items-center">
            <div
              className="inline-flex rounded-md border border-gray-200 dark:border-gray-600 overflow-hidden text-sm"
              role="group"
              aria-label="Monthly display mode"
            >
              <button
                onClick={() => setMonthlyDisplay('chart')}
                className={`px-3 py-1 font-medium transition-colors ${
                  monthlyDisplay === 'chart'
                    ? 'bg-blue-600 text-white'
                    : 'bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300'
                }`}
              >
                Chart
              </button>
              <button
                onClick={() => setMonthlyDisplay('table')}
                className={`px-3 py-1 font-medium transition-colors ${
                  monthlyDisplay === 'table'
                    ? 'bg-blue-600 text-white'
                    : 'bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300'
                }`}
              >
                Table
              </button>
            </div>
            <div className="flex flex-wrap gap-2 items-center">
              <span className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
                Show:
              </span>
              {(Object.keys(SERIES_COLORS) as SeriesKey[]).map((key) => {
                const active = visibleSeries[key];
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => toggleSeries(key)}
                    aria-pressed={active}
                    className={`px-3 py-1 text-sm font-medium rounded-md border transition-colors ${
                      active
                        ? 'text-white border-transparent'
                        : 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 border-gray-200 dark:border-gray-600'
                    }`}
                    style={
                      active
                        ? { backgroundColor: SERIES_COLORS[key].positive }
                        : undefined
                    }
                  >
                    {SERIES_COLORS[key].label}
                  </button>
                );
              })}
            </div>
            {viewType === 'daily' && (
              <button
                type="button"
                role="switch"
                aria-checked={hideInactiveDays}
                onClick={() => setHideInactiveDays((v) => !v)}
                className="ml-auto flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400"
              >
                <span
                  className={`relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 ${
                    hideInactiveDays ? 'bg-blue-600' : 'bg-gray-200 dark:bg-gray-600'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform duration-200 ${
                      hideInactiveDays ? 'translate-x-4' : 'translate-x-0'
                    }`}
                  />
                </span>
                Hide inactive days
              </button>
            )}
          </div>
        )}
      </div>

      {filteredTransactions.length === 0 && filteredCapitalGains.length === 0 && filteredDailyCapitalGains.length === 0 ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <p className="text-gray-500 dark:text-gray-400 text-center py-8">
            No dividends, interest, or capital gain activity found for this period.
          </p>
        </div>
      ) : viewType === 'monthly' && monthlyDisplay === 'chart' ? (
        /* Monthly Chart */
        <div ref={chartRef} className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 px-2 py-4 sm:p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
            Monthly Gains, Dividends & Interest
          </h3>
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%" minWidth={0}>
              <BarChart data={monthlyData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                <YAxis tickFormatter={formatCurrencyAxis} />
                <Tooltip content={<CustomTooltip />} />
                <Legend />
                <ReferenceLine y={0} stroke="#9ca3af" />
                {visibleSeries.dividends && (
                  <Bar
                    dataKey="dividends"
                    stackId={stackId}
                    fill={SERIES_COLORS.dividends.positive}
                    name="Dividends"
                  />
                )}
                {visibleSeries.interest && (
                  <Bar
                    dataKey="interest"
                    stackId={stackId}
                    fill={SERIES_COLORS.interest.positive}
                    name="Interest"
                  />
                )}
                {visibleSeries.capitalGains && (
                  <Bar
                    dataKey="capitalGains"
                    stackId={stackId}
                    fill={SERIES_COLORS.capitalGains.positive}
                    name="Capital Gains"
                  >
                    {monthlyData.map((entry) => (
                      <Cell
                        key={entry.month}
                        fill={
                          entry.capitalGains < 0
                            ? SERIES_COLORS.capitalGains.negative
                            : SERIES_COLORS.capitalGains.positive
                        }
                      />
                    ))}
                  </Bar>
                )}
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      ) : viewType === 'monthly' ? (
        /* Monthly Table */
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              Monthly Gains, Dividends & Interest
            </h3>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
              <thead className="bg-gray-50 dark:bg-gray-900/50">
                <tr>
                  <SortableHeader<MonthlyIncomeSortField>
                    field="month"
                    sortField={monthlySort.sortField}
                    sortDirection={monthlySort.sortDirection}
                    onSort={monthlySort.handleSort}
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                  >
                    Month
                  </SortableHeader>
                  <SortableHeader<MonthlyIncomeSortField>
                    field="startValue"
                    sortField={monthlySort.sortField}
                    sortDirection={monthlySort.sortDirection}
                    onSort={monthlySort.handleSort}
                    align="right"
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                  >
                    Start Value
                  </SortableHeader>
                  <SortableHeader<MonthlyIncomeSortField>
                    field="endValue"
                    sortField={monthlySort.sortField}
                    sortDirection={monthlySort.sortDirection}
                    onSort={monthlySort.handleSort}
                    align="right"
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                  >
                    End Value
                  </SortableHeader>
                  {visibleSeries.dividends && (
                    <SortableHeader<MonthlyIncomeSortField>
                      field="dividends"
                      sortField={monthlySort.sortField}
                      sortDirection={monthlySort.sortDirection}
                      onSort={monthlySort.handleSort}
                      align="right"
                      className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                    >
                      Dividends
                    </SortableHeader>
                  )}
                  {visibleSeries.interest && (
                    <SortableHeader<MonthlyIncomeSortField>
                      field="interest"
                      sortField={monthlySort.sortField}
                      sortDirection={monthlySort.sortDirection}
                      onSort={monthlySort.handleSort}
                      align="right"
                      className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                    >
                      Interest
                    </SortableHeader>
                  )}
                  {visibleSeries.capitalGains && (
                    <SortableHeader<MonthlyIncomeSortField>
                      field="capitalGains"
                      sortField={monthlySort.sortField}
                      sortDirection={monthlySort.sortDirection}
                      onSort={monthlySort.handleSort}
                      align="right"
                      className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                    >
                      Capital Gains
                    </SortableHeader>
                  )}
                  <SortableHeader<MonthlyIncomeSortField>
                    field="total"
                    sortField={monthlySort.sortField}
                    sortDirection={monthlySort.sortDirection}
                    onSort={monthlySort.handleSort}
                    align="right"
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                  >
                    Total
                  </SortableHeader>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                {sortedMonthlyData.map((row) => {
                  const rowTotal =
                    (visibleSeries.dividends ? row.dividends : 0) +
                    (visibleSeries.interest ? row.interest : 0) +
                    (visibleSeries.capitalGains ? row.capitalGains : 0);
                  return (
                    <tr key={row.month} className="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                      <td className="px-4 py-3 text-sm font-medium text-gray-900 dark:text-gray-100">
                        {row.label}
                      </td>
                      <td className="px-4 py-3 text-right text-sm text-gray-700 dark:text-gray-300">
                        {row.startValue !== 0 ? fmtValue(row.startValue) : '-'}
                      </td>
                      <td className="px-4 py-3 text-right text-sm text-gray-700 dark:text-gray-300">
                        {row.endValue !== 0 ? fmtValue(row.endValue) : '-'}
                      </td>
                      {visibleSeries.dividends && (
                        <td className="px-4 py-3 text-right text-sm text-green-600 dark:text-green-400">
                          {row.dividends !== 0 ? fmtValue(row.dividends) : '-'}
                        </td>
                      )}
                      {visibleSeries.interest && (
                        <td className="px-4 py-3 text-right text-sm text-blue-600 dark:text-blue-400">
                          {row.interest !== 0 ? fmtValue(row.interest) : '-'}
                        </td>
                      )}
                      {visibleSeries.capitalGains && (
                        <td
                          className={`px-4 py-3 text-right text-sm ${
                            row.capitalGains < 0
                              ? 'text-red-600 dark:text-red-400'
                              : 'text-purple-600 dark:text-purple-400'
                          }`}
                        >
                          {row.capitalGains !== 0 ? fmtValue(row.capitalGains) : '-'}
                        </td>
                      )}
                      <td
                        className={`px-4 py-3 text-right text-sm font-medium ${
                          rowTotal < 0
                            ? 'text-red-600 dark:text-red-400'
                            : 'text-gray-900 dark:text-gray-100'
                        }`}
                      >
                        {rowTotal !== 0 ? fmtValue(rowTotal) : '-'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : viewType === 'daily' && monthlyDisplay === 'chart' ? (
        /* Daily Chart */
        <div ref={chartRef} className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 px-2 py-4 sm:p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
            Daily Gains, Dividends & Interest
          </h3>
          {displayedDailyData.length === 0 ? (
            <p className="text-gray-500 dark:text-gray-400 text-center py-8">
              No daily transaction data for this period.
            </p>
          ) : (
            <div className="h-80">
              <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                <BarChart data={displayedDailyData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                  <YAxis tickFormatter={formatCurrencyAxis} />
                  <Tooltip content={<CustomTooltip />} />
                  <Legend />
                  <ReferenceLine y={0} stroke="#9ca3af" />
                  {visibleSeries.dividends && (
                    <Bar
                      dataKey="dividends"
                      stackId={dailyStackId}
                      fill={SERIES_COLORS.dividends.positive}
                      name="Dividends"
                    />
                  )}
                  {visibleSeries.interest && (
                    <Bar
                      dataKey="interest"
                      stackId={dailyStackId}
                      fill={SERIES_COLORS.interest.positive}
                      name="Interest"
                    />
                  )}
                  {visibleSeries.capitalGains && (
                    <Bar
                      dataKey="capitalGains"
                      stackId={dailyStackId}
                      fill={SERIES_COLORS.capitalGains.positive}
                      name="Capital Gains"
                    >
                      {displayedDailyData.map((entry) => (
                        <Cell
                          key={entry.date}
                          fill={
                            entry.capitalGains < 0
                              ? SERIES_COLORS.capitalGains.negative
                              : SERIES_COLORS.capitalGains.positive
                          }
                        />
                      ))}
                    </Bar>
                  )}
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      ) : viewType === 'daily' ? (
        /* Daily Table */
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              Daily Gains, Dividends & Interest
            </h3>
          </div>
          {displayedDailyData.length === 0 ? (
            <p className="text-gray-500 dark:text-gray-400 text-center py-8">
              No daily transaction data for this period.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                <thead className="bg-gray-50 dark:bg-gray-900/50">
                  <tr>
                    <SortableHeader<DailyIncomeSortField>
                      field="date"
                      sortField={dailySort.sortField}
                      sortDirection={dailySort.sortDirection}
                      onSort={dailySort.handleSort}
                      className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                    >
                      Date
                    </SortableHeader>
                    <SortableHeader<DailyIncomeSortField>
                      field="startValue"
                      sortField={dailySort.sortField}
                      sortDirection={dailySort.sortDirection}
                      onSort={dailySort.handleSort}
                      align="right"
                      className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                    >
                      Start Value
                    </SortableHeader>
                    <SortableHeader<DailyIncomeSortField>
                      field="endValue"
                      sortField={dailySort.sortField}
                      sortDirection={dailySort.sortDirection}
                      onSort={dailySort.handleSort}
                      align="right"
                      className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                    >
                      End Value
                    </SortableHeader>
                    {visibleSeries.dividends && (
                      <SortableHeader<DailyIncomeSortField>
                        field="dividends"
                        sortField={dailySort.sortField}
                        sortDirection={dailySort.sortDirection}
                        onSort={dailySort.handleSort}
                        align="right"
                        className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                      >
                        Dividends
                      </SortableHeader>
                    )}
                    {visibleSeries.interest && (
                      <SortableHeader<DailyIncomeSortField>
                        field="interest"
                        sortField={dailySort.sortField}
                        sortDirection={dailySort.sortDirection}
                        onSort={dailySort.handleSort}
                        align="right"
                        className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                      >
                        Interest
                      </SortableHeader>
                    )}
                    {visibleSeries.capitalGains && (
                      <SortableHeader<DailyIncomeSortField>
                        field="capitalGains"
                        sortField={dailySort.sortField}
                        sortDirection={dailySort.sortDirection}
                        onSort={dailySort.handleSort}
                        align="right"
                        className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                      >
                        Capital Gains
                      </SortableHeader>
                    )}
                    <SortableHeader<DailyIncomeSortField>
                      field="total"
                      sortField={dailySort.sortField}
                      sortDirection={dailySort.sortDirection}
                      onSort={dailySort.handleSort}
                      align="right"
                      className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                    >
                      Total
                    </SortableHeader>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                  {sortedDailyData.map((row) => {
                    const rowTotal =
                      (visibleSeries.dividends ? row.dividends : 0) +
                      (visibleSeries.interest ? row.interest : 0) +
                      (visibleSeries.capitalGains ? row.capitalGains : 0);
                    return (
                      <tr key={row.date} className="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                        <td className="px-4 py-3 text-sm font-medium text-gray-900 dark:text-gray-100">
                          {row.label}
                        </td>
                        <td className="px-4 py-3 text-right text-sm text-gray-700 dark:text-gray-300">
                          {row.startValue !== 0 ? fmtValue(row.startValue) : '-'}
                        </td>
                        <td className="px-4 py-3 text-right text-sm text-gray-700 dark:text-gray-300">
                          {row.endValue !== 0 ? fmtValue(row.endValue) : '-'}
                        </td>
                        {visibleSeries.dividends && (
                          <td className="px-4 py-3 text-right text-sm text-green-600 dark:text-green-400">
                            {row.dividends !== 0 ? fmtValue(row.dividends) : '-'}
                          </td>
                        )}
                        {visibleSeries.interest && (
                          <td className="px-4 py-3 text-right text-sm text-blue-600 dark:text-blue-400">
                            {row.interest !== 0 ? fmtValue(row.interest) : '-'}
                          </td>
                        )}
                        {visibleSeries.capitalGains && (
                          <td
                            className={`px-4 py-3 text-right text-sm ${
                              row.capitalGains < 0
                                ? 'text-red-600 dark:text-red-400'
                                : 'text-purple-600 dark:text-purple-400'
                            }`}
                          >
                            {row.capitalGains !== 0 ? fmtValue(row.capitalGains) : '-'}
                          </td>
                        )}
                        <td
                          className={`px-4 py-3 text-right text-sm font-medium ${
                            rowTotal < 0
                              ? 'text-red-600 dark:text-red-400'
                              : 'text-gray-900 dark:text-gray-100'
                          }`}
                        >
                          {rowTotal !== 0 ? fmtValue(rowTotal) : '-'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : (
        /* By Security Table */
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              Income by Security
            </h3>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
              <thead className="bg-gray-50 dark:bg-gray-900/50">
                <tr>
                  <SortableHeader<SecurityIncomeSortField>
                    field="symbol"
                    sortField={securitySort.sortField}
                    sortDirection={securitySort.sortDirection}
                    onSort={securitySort.handleSort}
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                  >
                    Security
                  </SortableHeader>
                  <SortableHeader<SecurityIncomeSortField>
                    field="dividends"
                    sortField={securitySort.sortField}
                    sortDirection={securitySort.sortDirection}
                    onSort={securitySort.handleSort}
                    align="right"
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                  >
                    Dividends
                  </SortableHeader>
                  <SortableHeader<SecurityIncomeSortField>
                    field="interest"
                    sortField={securitySort.sortField}
                    sortDirection={securitySort.sortDirection}
                    onSort={securitySort.handleSort}
                    align="right"
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                  >
                    Interest
                  </SortableHeader>
                  <SortableHeader<SecurityIncomeSortField>
                    field="capitalGains"
                    sortField={securitySort.sortField}
                    sortDirection={securitySort.sortDirection}
                    onSort={securitySort.handleSort}
                    align="right"
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                  >
                    Capital Gains
                  </SortableHeader>
                  <SortableHeader<SecurityIncomeSortField>
                    field="total"
                    sortField={securitySort.sortField}
                    sortDirection={securitySort.sortDirection}
                    onSort={securitySort.handleSort}
                    align="right"
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                  >
                    Total
                  </SortableHeader>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                {sortedSecurityData.map((security) => (
                  <tr key={security.symbol} className="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-900 dark:text-gray-100">
                        {security.symbol}
                      </div>
                      <div className="text-sm text-gray-500 dark:text-gray-400">
                        {security.name}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right text-sm text-green-600 dark:text-green-400">
                      {security.dividends > 0 ? fmtValue(security.dividends) : '-'}
                    </td>
                    <td className="px-4 py-3 text-right text-sm text-blue-600 dark:text-blue-400">
                      {security.interest > 0 ? fmtValue(security.interest) : '-'}
                    </td>
                    <td
                      className={`px-4 py-3 text-right text-sm ${
                        security.capitalGains < 0
                          ? 'text-red-600 dark:text-red-400'
                          : 'text-purple-600 dark:text-purple-400'
                      }`}
                    >
                      {security.capitalGains !== 0 ? fmtValue(security.capitalGains) : '-'}
                    </td>
                    <td
                      className={`px-4 py-3 text-right text-sm font-medium ${
                        security.total < 0
                          ? 'text-red-600 dark:text-red-400'
                          : 'text-gray-900 dark:text-gray-100'
                      }`}
                    >
                      {fmtValue(security.total)}
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
