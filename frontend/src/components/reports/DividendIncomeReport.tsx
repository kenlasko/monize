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
  Legend,
  ReferenceLine,
  Cell,
} from 'recharts';
import { format, eachMonthOfInterval } from 'date-fns';
import { investmentsApi } from '@/lib/investments';
import { InvestmentTransaction, CapitalGainEntry } from '@/types/investment';
import { Account } from '@/types/account';
import { parseLocalDate } from '@/lib/utils';
import { incomeBaseKind, investmentIncomeAmount, investmentRowHasEffect } from '@/lib/investment-actions';
import { convertRowAmount } from '@/lib/investment-row-currency';
import { useChartDateFormat } from '@/hooks/useChartDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { useDateRange } from '@/hooks/useDateRange';
import { DateRangeSelector } from '@/components/ui/DateRangeSelector';
import { ReportToolbarActions } from '@/components/reports/ReportToolbarActions';
import { MultiSelect } from '@/components/ui/MultiSelect';
import { SortableHeader } from '@/components/ui/SortableHeader';
import {
  CAPTION_CLASS,
  CellLabel,
  PHONE_HEADER_CLASS,
  type SortColumn,
  type SortColumnsByField,
} from '@/components/ui/Table';
import { useSortableTable, compareValues } from '@/hooks/useSortableTable';
import { exportToCsv } from '@/lib/csv-export';
import { roundMoney, balanceColor } from '@/lib/format';
import { chartColors, CHART_SERIES } from '@/lib/chart-colors';
import { useTranslations } from 'next-intl';
import { useMainAccountName } from '@/hooks/useMainAccountName';
import { EmptyState } from '@/components/ui/EmptyState';
import { SEGMENTED_GROUP_CLASS, segmentClass } from '@/components/ui/segmented-control';
import { ChartViewToggle } from '@/components/ui/ChartViewToggle';
import { CHART_GRID_PROPS, CHART_TOOLTIP_CLASS } from '@/lib/chart-style';

type SeriesKey = 'dividends' | 'interest' | 'capitalGains';
type MonthlyIncomeSortField = 'month' | 'startValue' | 'endValue' | 'dividends' | 'interest' | 'capitalGains' | 'total';
type DailyIncomeSortField = 'date' | 'startValue' | 'endValue' | 'dividends' | 'interest' | 'capitalGains' | 'total';
type SecurityIncomeSortField = 'symbol' | 'dividends' | 'interest' | 'capitalGains' | 'total';

/**
 * `startValue`/`endValue`/`capitalGains`/`total` are `null` when any entry
 * folded into the bucket carried an unknown (unconvertible) value: a sum with
 * an unknown component is unknown, never the partial sum under the same name.
 * `dividends`/`interest` come from transaction rows and stay known.
 */
interface MonthlyIncome {
  month: string;
  label: string;
  startValue: number | null;
  endValue: number | null;
  dividends: number | null;
  interest: number | null;
  capitalGains: number | null;
  total: number | null;
}

interface SecurityIncome {
  symbol: string;
  name: string;
  dividends: number | null;
  interest: number | null;
  capitalGains: number | null;
  total: number | null;
}

interface DailyIncome {
  date: string;
  label: string;
  startValue: number | null;
  endValue: number | null;
  dividends: number | null;
  interest: number | null;
  capitalGains: number | null;
  total: number | null;
}

const SERIES_COLORS: Record<SeriesKey, { positive: string; negative: string }> = {
  dividends: { positive: chartColors.income, negative: chartColors.income },
  interest: { positive: chartColors.primary, negative: chartColors.primary },
  capitalGains: { positive: CHART_SERIES[4], negative: chartColors.expense },
};

interface DividendIncomeTooltipProps {
  active?: boolean;
  payload?: Array<{ name: string; value: number; color: string; dataKey?: string }>;
  label?: string;
  fmtValue: (value: number | null) => string;
}

function DividendIncomeTooltip({ active, payload, label, fmtValue }: DividendIncomeTooltipProps) {
  if (active && payload && payload.length) {
    // Recharts can pass a Cell-coloured payload entry; surface signed values
    // and use the original series colour rather than the per-bar Cell colour.
    return (
      <div className={CHART_TOOLTIP_CLASS}>
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
}

const ACCOUNTS_STORAGE_KEY = 'monize-reports-dividend-income-accounts';

// Today's header cell, unchanged. Kept local -- PHONE_HEADER_CLASS/CAPTION_CLASS/
// CellLabel are shared, but a table's own header stays per-report because track
// budgets differ.
const HEADER_CLASS =
  'px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase';
// A money cell inside a wrapped row: no padding of its own below `sm` (the grid
// spaces it), this table's own `px-4 py-3 text-sm` from `sm` up, smaller type on
// phones. `whitespace-nowrap` is the one property that is not phone-only -- a
// number must never break; the caption inside takes it back (`CellLabel`).
const FIGURE_CELL =
  'p-0 text-right text-xs whitespace-nowrap sm:table-cell sm:px-4 sm:py-3 sm:text-sm';

export function DividendIncomeReport() {
  const t = useTranslations('reports');
  const formatChartDate = useChartDateFormat();
  const mainAccountName = useMainAccountName();
  const { formatCurrency: formatCurrencyFull, formatCurrencyAxis } = useNumberFormat();
  const { defaultCurrency } = useExchangeRates();
  const chartRef = useRef<HTMLDivElement>(null);
  // Persisted so the report opens on the accounts the user last chose.
  // Accounts arrive with the data below, so stale IDs are pruned there.
  const [selectedAccountIds, setSelectedAccountIds, pruneAccountFilter] =
    usePersistedAccountFilter(ACCOUNTS_STORAGE_KEY);
  // Debounced mirror of selectedAccountIds. The data-load effect keys off
  // this, not the raw selection, so rapid toggles in the MultiSelect (e.g.
  // ticking three accounts in a row) don't fire one fetch per click. Seeded
  // from the persisted selection so the first fetch already honours it.
  const [appliedAccountIds, setAppliedAccountIds] = useState<string[]>(selectedAccountIds);
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

  // The by-security table's five sortable columns, keyed by field so the record
  // is exhaustive: adding a member to `SecurityIncomeSortField` is a compile
  // error here rather than a header with no control. Declaration order is the
  // column (and cell DOM) order, rendered by BOTH the column header row and the
  // phone sort strip from the derived `Object.values`.
  const securityColumns: SortColumnsByField<
    SecurityIncomeSortField,
    SortColumn<SecurityIncomeSortField>
  > = {
    symbol: { field: 'symbol', label: t('dividendIncome.colSecurity') },
    dividends: { field: 'dividends', label: t('dividendIncome.colDividends'), align: 'right' },
    interest: { field: 'interest', label: t('dividendIncome.colInterest'), align: 'right' },
    capitalGains: { field: 'capitalGains', label: t('dividendIncome.colCapitalGains'), align: 'right' },
    total: { field: 'total', label: t('dividendIncome.colTotal'), align: 'right' },
  };
  const securitySortColumns = Object.values(securityColumns);

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
      // transaction list, paid in cash or reinvested in shares; SELL realized +
      // unrealized capital gains come from the monthly capital gains endpoint,
      // which counts a reinvestment's shares as a purchase, so their value is
      // not also a capital gain here.
      // A VOID row is listed by the endpoint as a record; it paid nothing.
      const incomeTransactions = allTransactions.filter(
        (tx) => incomeBaseKind(tx.action) !== null && investmentRowHasEffect(tx),
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
  // Accounts only exist once the data loads, so the persisted filter is pruned
  // here. A prune lands in localStorage immediately and so takes effect on the
  // next visit; the debounced mirror above keeps this session's fetches stable.
  pruneAccountFilter(accounts);

  // Lazy-load daily capital gains only when the user switches to the daily view.
  const {
    data: dailyResponse,
    isLoading: isDailyLoading,
    error: dailyError,
    reload: reloadDaily,
  } = useReportData(
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
  // that doesn't hold it). Adjusted during render, not in an effect, so the
  // stale filter never paints.
  if (
    selectedSecurityId &&
    !availableSecurities.some((s) => s.id === selectedSecurityId)
  ) {
    setSelectedSecurityId('');
  }

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

  // A row's income is in the row's own (security) currency, not the account's.
  // It reaches the display currency through the row's settlement rate where it
  // has one, the rate its cash leg was booked at, and the market rate beyond.
  // A reinvest created in the app stores no total; its income is the cost its
  // shares were bought at.
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

  // Backend returns each capital gain entry in the holding account's currency,
  // and the same figures in the reporting currency at the rate for the entry's
  // own period (`inReportingCurrency`). A single account reads its native
  // figures; several read the reporting-currency ones, never a past month at
  // today's rate (issue #2106).
  const convertCapitalGain = useCallback((entry: CapitalGainEntry): number | null => {
    // A null gain is unknown (no rate between the security's currency and the
    // account's); it must not survive conversion as a 0.
    if (entry.totalCapitalGain === null) return null;
    if (isSingleAccount) return entry.totalCapitalGain;
    return entry.inReportingCurrency?.totalCapitalGain ?? null;
  }, [isSingleAccount]);

  // The same reading for an entry's start or end market value.
  const convertFromAccountCurrency = useCallback(
    (entry: CapitalGainEntry, field: 'startValue' | 'endValue'): number | null => {
      if (entry[field] === null) return null;
      if (isSingleAccount) return entry[field];
      return entry.inReportingCurrency?.[field] ?? null;
    },
    [isSingleAccount],
  );

  // A sum with an unknown component is unknown. Used everywhere a nullable
  // entry value folds into a bucket, so `+=` cannot coerce null to 0.
  const addOrUnknown = (a: number | null, b: number | null): number | null =>
    a === null || b === null ? null : a + b;

  /**
   * The one place this report decides unknown-versus-zero, so a cell renders
   * `{fmtValue(x)}` and never a branch of its own.
   *
   * `null` is "the server could not work this out" and draws the em dash; every
   * other number, `0` included, is a measured figure and is formatted. The
   * tables used to ask `x !== 0 ? fmtValue(x) : '-'`, which had it exactly
   * backwards for a real zero: an account that opened the month at nothing, or
   * a day that paid no dividend, is a KNOWN 0.00 and was drawn as the unknown
   * marker -- so a start value nobody could compute and a start value of zero
   * read the same, in the report whose whole subject is which of those it is.
   * The test is `null`, never `!== 0`, `> 0` or truthiness (`Number(null)` is
   * `0`, which is how the two get folded together).
   */
  const fmtValue = useCallback((value: number | null): string => {
    if (value === null) return '\u2014';
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
        label: formatChartDate(month, 'MMM yyyy'),
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
          label: formatChartDate(txDate, 'MMM yyyy'),
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
      switch (incomeBaseKind(tx.action)) {
        case 'DIVIDEND':
          bucket.dividends = addOrUnknown(bucket.dividends, contribution);
          break;
        case 'INTEREST':
          bucket.interest = addOrUnknown(bucket.interest, contribution);
          break;
        case 'CAPITAL_GAIN':
          bucket.capitalGains = addOrUnknown(bucket.capitalGains, contribution);
          break;
      }
      bucket.total = addOrUnknown(bucket.total, contribution);
    });

    filteredCapitalGains.forEach((entry) => {
      // entry.month is YYYY-MM; create a date in the middle of the month so
      // local-timezone parsing puts it in the right bucket.
      const monthDate = parseLocalDate(`${entry.month}-15`);
      const bucket = getOrCreateBucket(monthDate);
      const gain = convertCapitalGain(entry);
      bucket.capitalGains = addOrUnknown(bucket.capitalGains, gain);
      bucket.total = addOrUnknown(bucket.total, gain);
      // Start/end market values sum across securities to give a portfolio
      // mark-to-market snapshot at each month boundary.
      bucket.startValue = addOrUnknown(
        bucket.startValue,
        convertFromAccountCurrency(entry, 'startValue'),
      );
      bucket.endValue = addOrUnknown(
        bucket.endValue,
        convertFromAccountCurrency(entry, 'endValue'),
      );
    });

    return Array.from(monthMap.values()).sort((a, b) => a.month.localeCompare(b.month));
  }, [filteredTransactions, filteredCapitalGains, dateRange, resolvedRange, getTxAmount, convertCapitalGain, convertFromAccountCurrency, formatChartDate]);

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
          label: formatChartDate(txDate, 'MMM d, yyyy'),
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
      switch (incomeBaseKind(tx.action)) {
        case 'DIVIDEND':
          bucket.dividends = addOrUnknown(bucket.dividends, contribution);
          break;
        case 'INTEREST':
          bucket.interest = addOrUnknown(bucket.interest, contribution);
          break;
        case 'CAPITAL_GAIN':
          bucket.capitalGains = addOrUnknown(bucket.capitalGains, contribution);
          break;
      }
      bucket.total = addOrUnknown(bucket.total, contribution);
    });

    filteredDailyCapitalGains.forEach((entry) => {
      // Daily entries use YYYY-MM-DD in the month field. Skip anything that
      // doesn't match (e.g. an older backend echoing monthly entries) so
      // parseLocalDate / format() don't blow up on a partial date.
      if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.month)) return;
      const txDate = parseLocalDate(entry.month);
      const bucket = getOrCreateBucket(entry.month, txDate);
      const gain = convertCapitalGain(entry);
      bucket.capitalGains = addOrUnknown(bucket.capitalGains, gain);
      bucket.total = addOrUnknown(bucket.total, gain);
      bucket.startValue = addOrUnknown(
        bucket.startValue,
        convertFromAccountCurrency(entry, 'startValue'),
      );
      bucket.endValue = addOrUnknown(
        bucket.endValue,
        convertFromAccountCurrency(entry, 'endValue'),
      );
    });

    return Array.from(dayMap.values()).sort((a, b) => a.date.localeCompare(b.date));
  }, [filteredTransactions, filteredDailyCapitalGains, getTxAmount, convertCapitalGain, convertFromAccountCurrency, formatChartDate]);

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
    () => monthlyData.some((m) => m.capitalGains !== null && m.capitalGains < 0),
    [monthlyData],
  );
  const dailyHasNegativeCapitalGains = useMemo(
    () => displayedDailyData.some((d) => d.capitalGains !== null && d.capitalGains < 0),
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
          label: mainAccountName(account.name),
        })),
    [accounts, mainAccountName],
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
      switch (incomeBaseKind(tx.action)) {
        case 'DIVIDEND':
          bucket.dividends = addOrUnknown(bucket.dividends, contribution);
          break;
        case 'INTEREST':
          bucket.interest = addOrUnknown(bucket.interest, contribution);
          break;
        case 'CAPITAL_GAIN':
          bucket.capitalGains = addOrUnknown(bucket.capitalGains, contribution);
          break;
      }
      bucket.total = addOrUnknown(bucket.total, contribution);
    });

    filteredCapitalGains.forEach((entry) => {
      const symbol = entry.symbol || 'Unknown';
      const name = entry.securityName || 'Unknown Security';
      const bucket = getOrCreateBucket(symbol, name);
      const gain = convertCapitalGain(entry);
      bucket.capitalGains = addOrUnknown(bucket.capitalGains, gain);
      bucket.total = addOrUnknown(bucket.total, gain);
    });

    return Array.from(securityMap.values());
  }, [filteredTransactions, filteredCapitalGains, getTxAmount, convertCapitalGain]);

  // The row total restricted to the visible series. Unknown-aware: with the
  // capital-gains series visible, a row whose gains are unknown has an unknown
  // total (sorted last by compareValues, rendered as the unknown marker).
  const visibleTotal = useCallback(
    (
      dividends: number | null,
      interest: number | null,
      capitalGains: number | null,
    ): number | null => {
      // Sum only the visible series, and let a single unknown component make the
      // visible total unknown rather than a silent subtotal.
      let sum: number | null = 0;
      if (visibleSeries.dividends) sum = addOrUnknown(sum, dividends);
      if (visibleSeries.interest) sum = addOrUnknown(sum, interest);
      if (visibleSeries.capitalGains) sum = addOrUnknown(sum, capitalGains);
      return sum;
    },
    [visibleSeries],
  );

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
            visibleTotal(a.dividends, a.interest, a.capitalGains),
            visibleTotal(b.dividends, b.interest, b.capitalGains),
          );
          break;
      }
      return monthlySort.sortDirection === 'asc' ? comparison : -comparison;
    });
    return sorted;
  }, [monthlyData, monthlySort.sortField, monthlySort.sortDirection, visibleTotal]);

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
            visibleTotal(a.dividends, a.interest, a.capitalGains),
            visibleTotal(b.dividends, b.interest, b.capitalGains),
          );
          break;
      }
      return dailySort.sortDirection === 'asc' ? comparison : -comparison;
    });
    return sorted;
  }, [displayedDailyData, dailySort.sortField, dailySort.sortDirection, visibleTotal]);

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
    // A headline figure goes unknown (null), not silently short, when any of its
    // components could not be converted -- one missing rate makes the whole
    // figure unknown, the same rule the monthly and daily buckets follow.
    const dividends = filteredTransactions
      .filter((t) => incomeBaseKind(t.action) === 'DIVIDEND')
      .reduce<number | null>((sum, t) => addOrUnknown(sum, getTxAmount(t)), 0);
    const interest = filteredTransactions
      .filter((t) => incomeBaseKind(t.action) === 'INTEREST')
      .reduce<number | null>((sum, t) => addOrUnknown(sum, getTxAmount(t)), 0);
    const manualCapitalGains = filteredTransactions
      .filter((t) => incomeBaseKind(t.action) === 'CAPITAL_GAIN')
      .reduce<number | null>((sum, t) => addOrUnknown(sum, getTxAmount(t)), 0);
    const periodCapitalGains = filteredCapitalGains.reduce<number | null>(
      (sum, entry) => addOrUnknown(sum, convertCapitalGain(entry)),
      0,
    );
    const totalGains = addOrUnknown(manualCapitalGains, periodCapitalGains);
    return {
      dividends,
      interest,
      capitalGains: totalGains,
      total: addOrUnknown(addOrUnknown(dividends, interest), totalGains),
    };
  }, [filteredTransactions, filteredCapitalGains, getTxAmount, convertCapitalGain]);

  // CSV is only offered when the user is looking at a table. Raw numeric
  // values (no currency formatting) are written so spreadsheets can sum and
  // filter them; the currency code goes into a dedicated column.
  const isTableView =
    viewType === 'bySecurity' ||
    (viewType === 'monthly' && monthlyDisplay === 'table') ||
    (viewType === 'daily' && monthlyDisplay === 'table');

  // '' (an empty cell), not 0, for an unknown value: a spreadsheet summing the
  // column must not absorb an unknown as a zero.
  const csvMoney = (n: number | null): number | '' =>
    n === null ? '' : roundMoney(n);

  const handleExportCsv = () => {
    const accountLabel = selectedAccount
      ? mainAccountName(selectedAccount.name)
      : 'all-accounts';
    const filenameBase = 'gains-dividends-interest';
    const scope = accountLabel.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const currencyCode = displayCurrency;

    if (viewType === 'bySecurity') {
      const headers = [
        t('dividendIncome.colSymbol'),
        t('dividendIncome.colSecurity'),
        t('dividendIncome.colDividends'),
        t('dividendIncome.colInterest'),
        t('dividendIncome.colCapitalGains'),
        t('dividendIncome.colTotal'),
        t('dividendIncome.colCurrency'),
      ];
      const rows = securityData.map((s) => [
        s.symbol,
        s.name,
        csvMoney(s.dividends),
        csvMoney(s.interest),
        csvMoney(s.capitalGains),
        csvMoney(s.total),
        currencyCode,
      ]);
      exportToCsv(`${filenameBase}-by-security-${scope}`, headers, rows);
      return;
    }

    if (viewType === 'daily') {
      const headers: string[] = [t('dividendIncome.colDate'), t('dividendIncome.colStartValueDaily'), t('dividendIncome.colEndValueDaily')];
      if (visibleSeries.dividends) headers.push(t('dividendIncome.colDividends'));
      if (visibleSeries.interest) headers.push(t('dividendIncome.colInterest'));
      if (visibleSeries.capitalGains) headers.push(t('dividendIncome.colCapitalGains'));
      headers.push(t('dividendIncome.colTotal'), t('dividendIncome.colCurrency'));
      const rows = displayedDailyData.map((row) => {
        const out: (string | number)[] = [row.date, csvMoney(row.startValue), csvMoney(row.endValue)];
        if (visibleSeries.dividends) out.push(csvMoney(row.dividends));
        if (visibleSeries.interest) out.push(csvMoney(row.interest));
        if (visibleSeries.capitalGains) out.push(csvMoney(row.capitalGains));
        out.push(
          csvMoney(visibleTotal(row.dividends, row.interest, row.capitalGains)),
          currencyCode,
        );
        return out;
      });
      exportToCsv(`${filenameBase}-daily-${scope}`, headers, rows);
      return;
    }

    // Monthly table export. Respect the series visibility toggles so the CSV
    // matches what the user sees; the Total column reflects only the visible
    // series (same logic as the rendered table).
    const headers: string[] = [t('dividendIncome.colMonth'), t('dividendIncome.colStartValue'), t('dividendIncome.colEndValue')];
    if (visibleSeries.dividends) headers.push(t('dividendIncome.colDividends'));
    if (visibleSeries.interest) headers.push(t('dividendIncome.colInterest'));
    if (visibleSeries.capitalGains) headers.push(t('dividendIncome.colCapitalGains'));
    headers.push(t('dividendIncome.colTotal'), t('dividendIncome.colCurrency'));
    const rows = monthlyData.map((row) => {
      const out: (string | number)[] = [
        row.month,
        csvMoney(row.startValue),
        csvMoney(row.endValue),
      ];
      if (visibleSeries.dividends) out.push(csvMoney(row.dividends));
      if (visibleSeries.interest) out.push(csvMoney(row.interest));
      if (visibleSeries.capitalGains) out.push(csvMoney(row.capitalGains));
      out.push(
        csvMoney(visibleTotal(row.dividends, row.interest, row.capitalGains)),
        currencyCode,
      );
      return out;
    });
    exportToCsv(`${filenameBase}-monthly-${scope}`, headers, rows);
  };

  const handleExportPdf = async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    const accountLabel = selectedAccount
      ? mainAccountName(selectedAccount.name)
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
        headers: [t('dividendIncome.colSymbol'), t('dividendIncome.colSecurity'), t('dividendIncome.colDividends'), t('dividendIncome.colInterest'), t('dividendIncome.colCapitalGains'), t('dividendIncome.colTotal')],
        rows: securityData.map((s) => [
          s.symbol,
          s.name,
          fmtValue(s.dividends),
          fmtValue(s.interest),
          fmtValue(s.capitalGains),
          fmtValue(s.total),
        ]),
        totalRow: [
          t('dividendIncome.colTotal'),
          '',
          fmtValue(totals.dividends),
          fmtValue(totals.interest),
          fmtValue(totals.capitalGains),
          fmtValue(totals.total),
        ],
      };
    } else if (viewType === 'daily' && monthlyDisplay === 'table') {
      const headers: string[] = [t('dividendIncome.colDate'), t('dividendIncome.colStartValueDaily'), t('dividendIncome.colEndValueDaily')];
      if (visibleSeries.dividends) headers.push(t('dividendIncome.colDividends'));
      if (visibleSeries.interest) headers.push(t('dividendIncome.colInterest'));
      if (visibleSeries.capitalGains) headers.push(t('dividendIncome.colCapitalGains'));
      headers.push(t('dividendIncome.colTotal'));
      const rows = displayedDailyData.map((row) => {
        const out: (string | number)[] = [row.label, fmtValue(row.startValue), fmtValue(row.endValue)];
        if (visibleSeries.dividends) out.push(fmtValue(row.dividends));
        if (visibleSeries.interest) out.push(fmtValue(row.interest));
        if (visibleSeries.capitalGains) out.push(fmtValue(row.capitalGains));
        out.push(
          fmtValue(visibleTotal(row.dividends, row.interest, row.capitalGains)),
        );
        return out;
      });
      const dailyTotals = displayedDailyData.reduce(
        (acc, row) => ({
          dividends: addOrUnknown(acc.dividends, row.dividends),
          interest: addOrUnknown(acc.interest, row.interest),
          capitalGains: addOrUnknown(acc.capitalGains, row.capitalGains),
        }),
        {
          dividends: 0 as number | null,
          interest: 0 as number | null,
          capitalGains: 0 as number | null,
        },
      );
      const totalRow: (string | number)[] = [t('dividendIncome.colTotal'), '', ''];
      if (visibleSeries.dividends) totalRow.push(fmtValue(dailyTotals.dividends));
      if (visibleSeries.interest) totalRow.push(fmtValue(dailyTotals.interest));
      if (visibleSeries.capitalGains) totalRow.push(fmtValue(dailyTotals.capitalGains));
      totalRow.push(
        fmtValue(
          visibleTotal(
            dailyTotals.dividends,
            dailyTotals.interest,
            dailyTotals.capitalGains,
          ),
        ),
      );
      tableData = { headers, rows, totalRow };
    } else if (viewType === 'monthly' && monthlyDisplay === 'table') {
      const headers: string[] = [t('dividendIncome.colMonth'), t('dividendIncome.colStartValue'), t('dividendIncome.colEndValue')];
      if (visibleSeries.dividends) headers.push(t('dividendIncome.colDividends'));
      if (visibleSeries.interest) headers.push(t('dividendIncome.colInterest'));
      if (visibleSeries.capitalGains) headers.push(t('dividendIncome.colCapitalGains'));
      headers.push(t('dividendIncome.colTotal'));
      const rows = monthlyData.map((row) => {
        const out: (string | number)[] = [
          row.label,
          fmtValue(row.startValue),
          fmtValue(row.endValue),
        ];
        if (visibleSeries.dividends) out.push(fmtValue(row.dividends));
        if (visibleSeries.interest) out.push(fmtValue(row.interest));
        if (visibleSeries.capitalGains) out.push(fmtValue(row.capitalGains));
        out.push(
          fmtValue(visibleTotal(row.dividends, row.interest, row.capitalGains)),
        );
        return out;
      });
      // Column totals across the whole window, respecting hidden series so the
      // footer sum matches the visible columns. Start/End values are point-in-
      // time snapshots so a column sum would be meaningless — leave them blank.
      const totalRow: (string | number)[] = [t('dividendIncome.colTotal'), '', ''];
      if (visibleSeries.dividends) totalRow.push(fmtValue(totals.dividends));
      if (visibleSeries.interest) totalRow.push(fmtValue(totals.interest));
      if (visibleSeries.capitalGains) totalRow.push(fmtValue(totals.capitalGains));
      totalRow.push(
        fmtValue(
          visibleTotal(totals.dividends, totals.interest, totals.capitalGains),
        ),
      );
      tableData = { headers, rows, totalRow };
    }

    await exportToPdf({
      title: t('dividendIncome.pdfTitle'),
      subtitle: accountLabel,
      summaryCards: [
        { label: t('dividendIncome.summaryDividends'), value: fmtValue(totals.dividends), color: '#16a34a' },
        { label: t('dividendIncome.summaryInterest'), value: fmtValue(totals.interest), color: '#2563eb' },
        { label: t('dividendIncome.summaryCapitalGains'), value: fmtValue(totals.capitalGains), color: totals.capitalGains !== null && totals.capitalGains < 0 ? '#dc2626' : '#9333ea' },
        { label: t('dividendIncome.summaryTotalIncome'), value: fmtValue(totals.total), color: '#111827' },
      ],
      chartContainer: tableData ? undefined : chartRef.current,
      tableData,
      filename: 'gains-dividends-interest',
    });
  };

  const toggleSeries = (key: SeriesKey) => {
    setVisibleSeries((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const seriesLabels: Record<SeriesKey, string> = {
    dividends: t('dividendIncome.seriesDividends'),
    interest: t('dividendIncome.seriesInterest'),
    capitalGains: t('dividendIncome.seriesCapitalGains'),
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
          <div className="text-sm text-green-600 dark:text-green-400">{t('dividendIncome.summaryDividends')}</div>
          <div className="text-xl font-bold text-green-700 dark:text-green-300">
            {fmtValue(totals.dividends)}
          </div>
        </div>
        <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-4">
          <div className="text-sm text-blue-600 dark:text-blue-400">{t('dividendIncome.summaryInterest')}</div>
          <div className="text-xl font-bold text-blue-700 dark:text-blue-300">
            {fmtValue(totals.interest)}
          </div>
        </div>
        <div className={`rounded-lg p-4 ${totals.capitalGains !== null && totals.capitalGains < 0 ? 'bg-red-50 dark:bg-red-900/20' : 'bg-purple-50 dark:bg-purple-900/20'}`}>
          <div className={`text-sm ${totals.capitalGains !== null && totals.capitalGains < 0 ? 'text-red-600 dark:text-red-400' : 'text-purple-600 dark:text-purple-400'}`}>{t('dividendIncome.summaryCapitalGains')}</div>
          <div className={`text-xl font-bold ${totals.capitalGains !== null && totals.capitalGains < 0 ? 'text-red-700 dark:text-red-300' : 'text-purple-700 dark:text-purple-300'}`}>
            {fmtValue(totals.capitalGains)}
          </div>
        </div>
        <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-4">
          <div className="text-sm text-gray-600 dark:text-gray-400">{t('dividendIncome.summaryTotalIncome')}</div>
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
              ariaLabel={t('dividendIncome.filterByAccountLabel')}
              placeholder={t('dividendIncome.allAccountsPlaceholder')}
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
            aria-label={t('dividendIncome.filterBySecurityLabel')}
            disabled={availableSecurities.length === 0}
          >
            <option value="">{t('dividendIncome.allSecurities')}</option>
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
          {/* The three view buttons wrap onto their own line on a phone: this
              group used to hold the refresh and the export too, unwrapped, and
              the export was pushed past the right edge of the card. */}
          <div
            className={`${SEGMENTED_GROUP_CLASS} flex-wrap sm:ml-auto sm:shrink-0`}
            role="group"
            aria-label={t('reportPage.viewLabel')}
          >
            <button
              type="button"
              onClick={() => setViewType('monthly')}
              aria-pressed={viewType === 'monthly'}
              className={segmentClass(viewType === 'monthly')}
            >
              {t('dividendIncome.viewMonthly')}
            </button>
            <button
              type="button"
              onClick={() => setViewType('daily')}
              aria-pressed={viewType === 'daily'}
              className={segmentClass(viewType === 'daily')}
            >
              {t('dividendIncome.viewDaily')}
            </button>
            <button
              type="button"
              onClick={() => setViewType('bySecurity')}
              aria-pressed={viewType === 'bySecurity'}
              className={segmentClass(viewType === 'bySecurity')}
            >
              {t('dividendIncome.viewBySecurity')}
            </button>
          </div>
        </div>
        {/* The chart/table switch and the series toggles are selectors too, so
            the actions row sits BELOW them rather than in the row above: on a
            phone the refresh and the export are the last thing in the card.
            The row is always rendered, because the actions are -- the
            sub-controls inside it belong to the monthly and daily views. */}
        <div className="mt-3 flex flex-wrap gap-4 items-center">
          {(viewType === 'monthly' || viewType === 'daily') && (
            <>
              <div role="group" aria-label={t('dividendIncome.monthlyDisplayModeLabel')}>
                <ChartViewToggle
                  value={monthlyDisplay === 'chart' ? 'bar' : 'table'}
                  onChange={(v) => setMonthlyDisplay(v === 'table' ? 'table' : 'chart')}
                  options={['bar', 'table']}
                />
              </div>
              <div className="flex flex-wrap gap-2 items-center">
                <span className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  {t('dividendIncome.showLabel')}
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
                      {seriesLabels[key]}
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
                  className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 sm:ml-auto"
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
                  {t('dividendIncome.hideInactiveDays')}
                </button>
              )}
            </>
          )}
          <ReportToolbarActions
            onRefreshComplete={reloadAll}
            onExportPdf={handleExportPdf}
            onExportCsv={isTableView ? handleExportCsv : undefined}
            // Both requests feed the export; the daily one only its own view.
            disabled={
              isLoading || !!error || (viewType === 'daily' && (isDailyLoading || !!dailyError))
            }
          />
        </div>
      </div>

      {filteredTransactions.length === 0 && filteredCapitalGains.length === 0 && filteredDailyCapitalGains.length === 0 ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <EmptyState title={t('dividendIncome.empty')} />
        </div>
      ) : viewType === 'monthly' && monthlyDisplay === 'chart' ? (
        /* Monthly Chart */
        <div ref={chartRef} className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 px-2 py-4 sm:p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
            {t('dividendIncome.monthlyChartTitle')}
          </h3>
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%" minWidth={0}>
              <BarChart data={monthlyData}>
                <CartesianGrid {...CHART_GRID_PROPS} />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                <YAxis tickFormatter={formatCurrencyAxis} />
                <Tooltip content={<DividendIncomeTooltip fmtValue={fmtValue} />} />
                <Legend />
                <ReferenceLine y={0} stroke={chartColors.axis} />
                {visibleSeries.dividends && (
                  <Bar
                    dataKey="dividends"
                    stackId={stackId}
                    fill={SERIES_COLORS.dividends.positive}
                    name={seriesLabels.dividends}
                  />
                )}
                {visibleSeries.interest && (
                  <Bar
                    dataKey="interest"
                    stackId={stackId}
                    fill={SERIES_COLORS.interest.positive}
                    name={seriesLabels.interest}
                  />
                )}
                {visibleSeries.capitalGains && (
                  <Bar
                    dataKey="capitalGains"
                    stackId={stackId}
                    fill={SERIES_COLORS.capitalGains.positive}
                    name={seriesLabels.capitalGains}
                  >
                    {monthlyData.map((entry) => (
                      <Cell
                        key={entry.month}
                        fill={
                          entry.capitalGains !== null && entry.capitalGains < 0
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
        /* Deliberately NOT phone-wrapped, and this is the reason: the column
           count is decided at runtime. `visibleSeries` toggles the dividends,
           interest and capital-gains columns independently, so the row is
           anywhere from four to seven cells wide -- and the phone card is a
           `grid grid-cols-N` with per-cell `col-start`/`row-start`, which is a
           fixed N by construction. Converting it means either a class computed
           from the toggles (four grids to measure, and Tailwind emits only the
           classes it can see in the source) or a wrapper that re-derives the
           placements per combination. Neither is a conversion; both are a
           different component. Until then the phone gets the horizontal scroll,
           which is honest. Same for the daily table below. */
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {t('dividendIncome.monthlyTableTitle')}
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
                    {t('dividendIncome.colMonth')}
                  </SortableHeader>
                  <SortableHeader<MonthlyIncomeSortField>
                    field="startValue"
                    sortField={monthlySort.sortField}
                    sortDirection={monthlySort.sortDirection}
                    onSort={monthlySort.handleSort}
                    align="right"
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                  >
                    {t('dividendIncome.colStartValue')}
                  </SortableHeader>
                  <SortableHeader<MonthlyIncomeSortField>
                    field="endValue"
                    sortField={monthlySort.sortField}
                    sortDirection={monthlySort.sortDirection}
                    onSort={monthlySort.handleSort}
                    align="right"
                    className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                  >
                    {t('dividendIncome.colEndValue')}
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
                      {t('dividendIncome.colDividends')}
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
                      {t('dividendIncome.colInterest')}
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
                      {t('dividendIncome.colCapitalGains')}
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
                    {t('dividendIncome.colTotal')}
                  </SortableHeader>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                {sortedMonthlyData.map((row) => {
                  const rowTotal = visibleTotal(
                    row.dividends,
                    row.interest,
                    row.capitalGains,
                  );
                  return (
                    <tr key={row.month} className="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                      <td className="px-4 py-3 text-sm font-medium text-gray-900 dark:text-gray-100">
                        {row.label}
                      </td>
                      <td className="px-4 py-3 text-right text-sm text-gray-700 dark:text-gray-300">
                        {fmtValue(row.startValue)}
                      </td>
                      <td className="px-4 py-3 text-right text-sm text-gray-700 dark:text-gray-300">
                        {fmtValue(row.endValue)}
                      </td>
                      {visibleSeries.dividends && (
                        <td className="px-4 py-3 text-right text-sm text-green-600 dark:text-green-400">
                          {fmtValue(row.dividends)}
                        </td>
                      )}
                      {visibleSeries.interest && (
                        <td className="px-4 py-3 text-right text-sm text-blue-600 dark:text-blue-400">
                          {fmtValue(row.interest)}
                        </td>
                      )}
                      {visibleSeries.capitalGains && (
                        <td
                          className={`px-4 py-3 text-right text-sm ${
                            row.capitalGains !== null && row.capitalGains < 0
                              ? 'text-red-600 dark:text-red-400'
                              : 'text-purple-600 dark:text-purple-400'
                          }`}
                        >
                          {fmtValue(row.capitalGains)}
                        </td>
                      )}
                      <td
                        className={`px-4 py-3 text-right text-sm font-medium ${rowTotal === null ? 'text-gray-900 dark:text-gray-100' : balanceColor(rowTotal)}`}
                      >
                        {fmtValue(rowTotal)}
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
            {t('dividendIncome.dailyChartTitle')}
          </h3>
          {displayedDailyData.length === 0 ? (
            <EmptyState title={t('dividendIncome.noDailyData')} />
          ) : (
            <div className="h-80">
              <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                <BarChart data={displayedDailyData}>
                  <CartesianGrid {...CHART_GRID_PROPS} />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                  <YAxis tickFormatter={formatCurrencyAxis} />
                  <Tooltip content={<DividendIncomeTooltip fmtValue={fmtValue} />} />
                  <Legend />
                  <ReferenceLine y={0} stroke={chartColors.axis} />
                  {visibleSeries.dividends && (
                    <Bar
                      dataKey="dividends"
                      stackId={dailyStackId}
                      fill={SERIES_COLORS.dividends.positive}
                      name={seriesLabels.dividends}
                    />
                  )}
                  {visibleSeries.interest && (
                    <Bar
                      dataKey="interest"
                      stackId={dailyStackId}
                      fill={SERIES_COLORS.interest.positive}
                      name={seriesLabels.interest}
                    />
                  )}
                  {visibleSeries.capitalGains && (
                    <Bar
                      dataKey="capitalGains"
                      stackId={dailyStackId}
                      fill={SERIES_COLORS.capitalGains.positive}
                      name={seriesLabels.capitalGains}
                    >
                      {displayedDailyData.map((entry) => (
                        <Cell
                          key={entry.date}
                          fill={
                            entry.capitalGains !== null && entry.capitalGains < 0
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
        /* Not phone-wrapped either, for the same runtime-variable column count
           as the monthly table above. */
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {t('dividendIncome.dailyTableTitle')}
            </h3>
          </div>
          {displayedDailyData.length === 0 ? (
            <EmptyState title={t('dividendIncome.noDailyData')} />
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
                      {t('dividendIncome.colDate')}
                    </SortableHeader>
                    <SortableHeader<DailyIncomeSortField>
                      field="startValue"
                      sortField={dailySort.sortField}
                      sortDirection={dailySort.sortDirection}
                      onSort={dailySort.handleSort}
                      align="right"
                      className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                    >
                      {t('dividendIncome.colStartValueDaily')}
                    </SortableHeader>
                    <SortableHeader<DailyIncomeSortField>
                      field="endValue"
                      sortField={dailySort.sortField}
                      sortDirection={dailySort.sortDirection}
                      onSort={dailySort.handleSort}
                      align="right"
                      className="px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase"
                    >
                      {t('dividendIncome.colEndValueDaily')}
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
                        {t('dividendIncome.colDividends')}
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
                        {t('dividendIncome.colInterest')}
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
                        {t('dividendIncome.colCapitalGains')}
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
                      {t('dividendIncome.colTotal')}
                    </SortableHeader>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                  {sortedDailyData.map((row) => {
                    const rowTotal = visibleTotal(
                      row.dividends,
                      row.interest,
                      row.capitalGains,
                    );
                    return (
                      <tr key={row.date} className="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                        <td className="px-4 py-3 text-sm font-medium text-gray-900 dark:text-gray-100">
                          {row.label}
                        </td>
                        <td className="px-4 py-3 text-right text-sm text-gray-700 dark:text-gray-300">
                          {fmtValue(row.startValue)}
                        </td>
                        <td className="px-4 py-3 text-right text-sm text-gray-700 dark:text-gray-300">
                          {fmtValue(row.endValue)}
                        </td>
                        {visibleSeries.dividends && (
                          <td className="px-4 py-3 text-right text-sm text-green-600 dark:text-green-400">
                            {fmtValue(row.dividends)}
                          </td>
                        )}
                        {visibleSeries.interest && (
                          <td className="px-4 py-3 text-right text-sm text-blue-600 dark:text-blue-400">
                            {fmtValue(row.interest)}
                          </td>
                        )}
                        {visibleSeries.capitalGains && (
                          <td
                            className={`px-4 py-3 text-right text-sm ${
                              row.capitalGains !== null && row.capitalGains < 0
                                ? 'text-red-600 dark:text-red-400'
                                : 'text-purple-600 dark:text-purple-400'
                            }`}
                          >
                            {fmtValue(row.capitalGains)}
                          </td>
                        )}
                        <td
                          className={`px-4 py-3 text-right text-sm font-medium ${rowTotal === null ? 'text-gray-900 dark:text-gray-100' : balanceColor(rowTotal)}`}
                        >
                          {fmtValue(rowTotal)}
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
              {t('dividendIncome.incomeBySecurityTitle')}
            </h3>
          </div>
          {/* Below `sm` the table becomes a block and each row wraps into a
              two-column, three-line grid card so all five columns fit a phone
              without a horizontal scroll: line 1 is the security identity and
              its Dividends; line 2 is Interest and Capital Gains; line 3 is the
              Total, spanning both tracks as the row's headline. Nothing is
              dropped, and no figure is truncated -- a money value never wraps
              (`FIGURE_CELL`). From `sm` up it is the ordinary table, resolving
              to today's output in every respect but one (each cell restores its
              own `sm:px-4 sm:py-3 sm:text-sm`; the identity cell keeps its 16px
              symbol by carrying no `sm:text-*`; `FIGURE_CELL`'s
              `whitespace-nowrap` is unprefixed, so it applies at 640px+ too,
              where the base cell carried no `white-space` class -- deliberate,
              and the constant says why), and the sort controls survive
              as their own phone-only header row because the column header row
              that carries them on desktop is hidden there. Restyling `display`
              strips the implicit table semantics below `sm`, so the roles are
              restated and every bare figure carries a `CellLabel` naming its
              column; the symbol names itself. */}
          <div className="overflow-x-auto">
            <table role="table" className="block min-w-full divide-y divide-gray-200 dark:divide-gray-700 sm:table">
              <thead role="rowgroup" className="block bg-gray-50 dark:bg-gray-900/50 sm:table-header-group">
                {/* Phone sort strip: the same five controls, wrapped. */}
                <tr role="row" className="flex flex-wrap gap-x-2 gap-y-1 px-2 py-2 sm:hidden">
                  {securitySortColumns.map((column) => (
                    <SortableHeader<SecurityIncomeSortField>
                      key={column.field}
                      field={column.field}
                      sortField={securitySort.sortField}
                      sortDirection={securitySort.sortDirection}
                      onSort={securitySort.handleSort}
                      className={PHONE_HEADER_CLASS}
                    >
                      {column.label}
                    </SortableHeader>
                  ))}
                </tr>
                <tr role="row" className="hidden sm:table-row">
                  {securitySortColumns.map((column) => (
                    <SortableHeader<SecurityIncomeSortField>
                      key={column.field}
                      field={column.field}
                      sortField={securitySort.sortField}
                      sortDirection={securitySort.sortDirection}
                      onSort={securitySort.handleSort}
                      align={column.align}
                      className={HEADER_CLASS}
                    >
                      {column.label}
                    </SortableHeader>
                  ))}
                </tr>
              </thead>
              <tbody role="rowgroup" className="block divide-y divide-gray-200 dark:divide-gray-700 sm:table-row-group">
                {sortedSecurityData.map((security) => (
                  <tr
                    key={security.symbol}
                    role="row"
                    className="grid grid-cols-2 items-start gap-x-3 gap-y-1.5 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-700/50 sm:table-row sm:p-0"
                  >
                    {/* Security: the row identity, wrapping unclamped. No caption. */}
                    <td role="cell" className="col-start-1 row-start-1 min-w-0 p-0 sm:table-cell sm:px-4 sm:py-3">
                      <div className="font-medium text-gray-900 dark:text-gray-100">
                        {security.symbol}
                      </div>
                      <div className="break-words text-sm text-gray-500 dark:text-gray-400 sm:break-normal">
                        {security.name}
                      </div>
                    </td>
                    <td role="cell" className={`col-start-2 row-start-1 text-green-600 dark:text-green-400 ${FIGURE_CELL}`}>
                      <CellLabel className={CAPTION_CLASS}>{securityColumns.dividends.label}</CellLabel>
                      {security.dividends === null
                        ? fmtValue(null)
                        : security.dividends > 0
                          ? fmtValue(security.dividends)
                          : '-'}
                    </td>
                    <td role="cell" className={`col-start-1 row-start-2 text-blue-600 dark:text-blue-400 ${FIGURE_CELL}`}>
                      <CellLabel className={CAPTION_CLASS}>{securityColumns.interest.label}</CellLabel>
                      {security.interest === null
                        ? fmtValue(null)
                        : security.interest > 0
                          ? fmtValue(security.interest)
                          : '-'}
                    </td>
                    <td
                      role="cell"
                      className={`col-start-2 row-start-2 ${
                        security.capitalGains !== null && security.capitalGains < 0
                          ? 'text-red-600 dark:text-red-400'
                          : 'text-purple-600 dark:text-purple-400'
                      } ${FIGURE_CELL}`}
                    >
                      <CellLabel className={CAPTION_CLASS}>{securityColumns.capitalGains.label}</CellLabel>
                      {fmtValue(security.capitalGains)}
                    </td>
                    <td
                      role="cell"
                      className={`col-start-1 col-span-2 row-start-3 font-medium ${security.total === null ? 'text-gray-900 dark:text-gray-100' : balanceColor(security.total)} ${FIGURE_CELL}`}
                    >
                      <CellLabel className={CAPTION_CLASS}>{securityColumns.total.label}</CellLabel>
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
