'use client';

import { useState, useMemo, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { useMainAccountName } from '@/hooks/useMainAccountName';
import { gainLossColor, sumMoney } from '@/lib/format';
import {
  baseInvestmentAction,
  incomeBaseKind,
  investmentIncomeAmount,
  investmentRowHasEffect,
} from '@/lib/investment-actions';
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
import { differenceInDays } from 'date-fns';
import { chartColors } from '@/lib/chart-colors';
import { investmentsApi } from '@/lib/investments';
import { Security, SecurityPrice, InvestmentTransaction, HoldingWithMarketValue } from '@/types/investment';
import { Account } from '@/types/account';
import { parseLocalDate, type ChartDatePattern } from '@/lib/utils';
import { useChartDateFormat } from '@/hooks/useChartDateFormat';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { ReportToolbarActions } from '@/components/reports/ReportToolbarActions';
import { SortableHeader } from '@/components/ui/SortableHeader';
import { CAPTION_CLASS, CellLabel, PHONE_HEADER_CLASS, TH_CLASS } from '@/components/ui/Table';
import type {
  SortColumn as TableSortColumn,
  SortColumnsByField as TableSortColumnsByField,
} from '@/components/ui/Table';
import { useSortableTable, compareValues } from '@/hooks/useSortableTable';
import { aggregateHoldingsBySecurity } from '@/lib/aggregate-holdings';
import { renderChartFlagDot, ChartFlagShadowFilter } from '@/components/investments/portfolio-chart-utils';
import { buildTimeAxisTicks } from '@/lib/chart-time-axis';
import { SecurityComparisonChart, SecurityComparisonChartHandle } from '@/components/reports/SecurityComparisonChart';
import { MultiSelect, MultiSelectOption } from '@/components/ui/MultiSelect';
import { DateRangeSelector } from '@/components/ui/DateRangeSelector';
import { useDateRange } from '@/hooks/useDateRange';
import { CHART_RANGES } from '@/lib/security-detail';
import { MarketIndex } from '@/types/investment';
import { EmptyState } from '@/components/ui/EmptyState';
import { SEGMENTED_GROUP_CLASS, segmentClass } from '@/components/ui/segmented-control';

const MAX_PAGES = 50;

/** Regions in the order the index picker groups them. */
const INDEX_REGIONS = ['NORTH_AMERICA', 'EUROPE', 'ASIA_PACIFIC'] as const;

/**
 * Marks a picker row as a region heading rather than an index. `MultiSelect`
 * puts a group's own value into the selection once every child is chosen, so
 * the two have to be told apart before the selection reaches the API.
 */
const INDEX_GROUP_PREFIX = 'region:';

type TradeSortField = 'date' | 'account' | 'action' | 'shares' | 'price' | 'total';
type DividendSortField = 'date' | 'account' | 'type' | 'amount';

/**
 * One sortable column of each history table. Declared once, as a record over the
 * sort-field union, and rendered by BOTH header rows -- the column header row
 * (from `sm` up) and the phone sort strip -- so the two can never list different
 * fields, and adding a member to a union fails `tsc` here rather than stranding
 * a phone with no control for it.
 */
type TradeSortColumn = TableSortColumn<TradeSortField, 'right'>;
type DividendSortColumn = TableSortColumn<DividendSortField, 'right'>;

// A money (or share-count) cell inside a wrapped row: no padding of its own
// below `sm` (the row supplies it and the grid does the spacing), this table's
// own `px-4 py-3 text-sm` from `sm` up, smaller type on phones. The colour and
// weight stay on each cell.
//
// `whitespace-nowrap` is the one property here that is NOT phone-only, and it is
// the single respect in which the `sm`-and-up cell differs from today's: a
// locale that groups thousands with a space (`1 234 567 zl`) could otherwise
// break a figure in the middle at any width. A number must not break; the
// caption inside takes `whitespace-normal` back for itself (`CellLabel`).
const MONEY_CELL = 'p-0 text-right text-xs whitespace-nowrap sm:table-cell sm:px-4 sm:py-3 sm:text-sm';

interface PriceChartPoint {
  date: string;
  ts: number;
  label: string;
  close: number;
  buyMarker?: number;
  sellMarker?: number;
}

/**
 * The dividend total, for the table footer and the PDF export alike.
 *
 * It accumulated with `sum + Math.abs(tx.totalAmount)` -- the expression root
 * `CLAUDE.md` gives as the WRONG example -- so the footer disagreed with the
 * sum of the figures printed above it in the last decimal place (five
 * plausible dividend amounts reach `389.46000000000004`). `sumMoney`
 * accumulates in integer ten-thousandths, the scale the amounts are stored at:
 * the same helper the other client-side money totals use, mirroring the
 * server's own.
 *
 * `Number(...)` is explicit rather than incidental. A `decimal(20,4)` crosses
 * the wire as a STRING however `InvestmentTransaction` declares it; the old
 * expression coerced it only because `Math.abs` does, so a later edit taking
 * the abs off for a signed total would have started concatenating strings.
 *
 * Each row's dividend is `investmentIncomeAmount`: a cash dividend's total, or
 * a reinvested one's share cost, since a reinvest created in the app stores no
 * total. Every row is a known amount, so this is a total and not a subtotal.
 */
function sumDividends(rows: InvestmentTransaction[]): number {
  return sumMoney(rows.map((tx) => investmentIncomeAmount(tx)));
}

export function SecurityPerformanceReport() {
  const t = useTranslations('reports');
  const tc = useTranslations('common');
  const ti = useTranslations('marketIndexes');
  const formatChartDate = useChartDateFormat();
  // Both history tables print a calendar date and a share count, so both go
  // through the preference seams -- `formatDate` for the date's arrangement and
  // separators, `formatShareQuantity` for the count's decimal mark and its 8dp
  // (a residual position is what that column exists to expose).
  const { formatDate } = useDateFormat();
  const mainAccountName = useMainAccountName();
  const {
    formatCurrency: formatCurrencyFull,
    formatCurrencyAxis,
    formatSignedPercent,
    formatShareQuantity,
  } = useNumberFormat();
  const { defaultCurrency } = useExchangeRates();
  const chartRef = useRef<HTMLDivElement>(null);
  // Export handle for the comparison chart, which owns its own data and DOM.
  const comparisonExportRef = useRef<SecurityComparisonChartHandle>(null);
  // The securities the user has picked in the multi-select. One selected shows
  // the single-security deep dive (stats, tabs, PDF); two or more switch to the
  // performance-comparison chart. Empty shows the initial prompt.
  const [selectedSecurityIds, setSelectedSecurityIds] = useState<string[]>([]);
  // Benchmarks overlaid on the chart. Selecting one switches to the
  // percent-return comparison: an index level and a share price cannot share a
  // currency axis, and giving each its own invites the reader to compare two
  // independently-scaled lines.
  const [selectedIndexCodes, setSelectedIndexCodes] = useState<string[]>([]);
  const [viewType, setViewType] = useState<'chart' | 'transactions' | 'dividends'>('chart');
  // The chart's window. Persisted per user, like the security detail page's.
  const { dateRange, setDateRange, startDate, setStartDate, endDate, setEndDate, resolvedRange } =
    useDateRange({
      defaultRange: '1y',
      storageKey: 'reports.security-performance.range',
    });
  // Bumped on a manual price refresh so the comparison chart re-fetches its
  // (separately loaded) per-security price history.
  const [allRefreshKey, setAllRefreshKey] = useState(0);
  // Whether the comparison chart (which owns its own request) holds the
  // current selection's answer; it reports it, the toolbar below reads it.
  const [comparisonExportable, setComparisonExportable] = useState(false);
  // The region rows in the index picker are grouping, not instruments:
  // `MultiSelect` adds a group's own value to the selection once all its
  // children are chosen, and sending `region:EUROPE` to the API would be
  // rejected as an unknown index code. The prefix is this component's own
  // construction (see `indexOptions`), so stripping it here needs no catalog.
  const activeIndexCodes = useMemo(
    () => selectedIndexCodes.filter((code) => !code.startsWith(INDEX_GROUP_PREFIX)),
    [selectedIndexCodes],
  );
  const hasIndexOverlay = activeIndexCodes.length > 0;
  // Two or more instruments on one chart, or one measured against a benchmark:
  // either way the honest axis is percent return rebased to the window start.
  const isComparison = selectedSecurityIds.length + activeIndexCodes.length > 1;
  const isSingle = selectedSecurityIds.length === 1 && !hasIndexOverlay;
  // The single selected security's id (empty in the prompt/comparison modes),
  // which drives the per-security detail fetch and panels below.
  const selectedSecurityId = isSingle ? selectedSecurityIds[0] : '';
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
      const [secs, summary, accts, indexes] = await Promise.all([
        investmentsApi.getSecurities(),
        investmentsApi.getPortfolioSummary(),
        investmentsApi.getInvestmentAccounts(),
        investmentsApi.getMarketIndexes(),
      ]);
      return {
        securities: secs.filter((s) => s.isActive),
        holdings: summary.holdings,
        accounts: accts,
        marketIndexes: indexes,
      };
    },
    [],
  );

  const securities = useMemo<Security[]>(() => baseData?.securities ?? [], [baseData]);
  const holdings = useMemo<HoldingWithMarketValue[]>(() => baseData?.holdings ?? [], [baseData]);
  const accounts = useMemo<Account[]>(() => baseData?.accounts ?? [], [baseData]);
  const marketIndexes = useMemo<MarketIndex[]>(
    () => baseData?.marketIndexes ?? [],
    [baseData],
  );

  const selectedSecurity = securities.find((s) => s.id === selectedSecurityId);

  // Searchable multi-select options, one per active security (symbol first so it
  // sorts and reads like the rest of the report).
  const securityOptions = useMemo<MultiSelectOption[]>(
    () =>
      securities
        .slice()
        .sort((a, b) => a.symbol.localeCompare(b.symbol))
        .map((sec) => ({ value: sec.id, label: `${sec.symbol} - ${sec.name}` })),
    [securities],
  );

  /** An index's localized name, falling back to what the catalog called it. */
  const indexLabel = (index: MarketIndex) => {
    const key = `names.${index.code}` as Parameters<typeof ti>[0];
    const localized = ti(key);
    return localized === key ? index.defaultName : localized;
  };

  /**
   * Benchmarks, grouped by region.
   *
   * **Every catalog entry is offered, including one we hold no prices for yet.**
   * Hiding those looked like courtesy and was a deadlock: an index's history is
   * fetched when it is first selected, so filtering on stored coverage meant a
   * fresh deployment showed an empty picker and nothing could ever fill it. The
   * comparison already answers an unpriced benchmark honestly -- it comes back
   * in `excluded` with a reason -- which is the right place for that to be
   * handled.
   */
  const indexOptions = useMemo<MultiSelectOption[]>(
    () =>
      INDEX_REGIONS.flatMap((region) => {
        const inRegion = marketIndexes
          .filter((index) => index.region === region)
          .sort((a, b) => a.defaultName.localeCompare(b.defaultName));
        if (inRegion.length === 0) return [];
        return [
          {
            value: `${INDEX_GROUP_PREFIX}${region}`,
            label: t(`securityPerformance.indexRegions.${region}` as Parameters<typeof t>[0]),
            children: inRegion.map((index) => ({
              value: index.code,
              label: indexLabel(index),
            })),
          },
        ];
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [marketIndexes, t, ti],
  );

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
    error: detailError,
    reload: reloadDetail,
  } = useReportData(
    async () => {
      if (!selectedSecurityId) return null;
      const symbol = securities.find((s) => s.id === selectedSecurityId)?.symbol;
      if (!symbol) return null;

      const allTx: InvestmentTransaction[] = [];

      const [priceData, firstPage] = await Promise.all([
        // The window, not a row cap: a limit shorter than the history drops its
        // oldest end, which is exactly the wrong half for a chart asking for
        // five years. An empty start is "all history", and the server bounds it.
        investmentsApi.getSecurityPrices(selectedSecurityId, {
          startDate: resolvedRange.start || undefined,
          endDate: resolvedRange.end || undefined,
        }),
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
    // The window is part of what the price fetch answers, so changing it has to
    // refetch. The transactions are deliberately not windowed -- see the note
    // beside the selector.
    [selectedSecurityId, securities, resolvedRange.start, resolvedRange.end],
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
    // An unpriced holding has an unknown value, not a value of 0 and a -100% return.
    const currentValue = selectedHolding.marketValue ?? null;
    const totalReturn = currentValue === null ? null : currentValue - costBasis;
    const totalReturnPercent =
      totalReturn === null ? null : costBasis > 0 ? (totalReturn / costBasis) * 100 : 0;

    // Find first buy date for annualized return
    const buyTx = transactions
      .filter((tx) => baseInvestmentAction(tx.action) === 'BUY' || tx.action === 'ADD_SHARES' || tx.action === 'TRANSFER_IN')
      .sort((a, b) => a.transactionDate.localeCompare(b.transactionDate));

    let annualizedReturn: number | null = null;
    // (value / cost)^(1/years) is only the holding's return for ONE acquisition and no
    // later buy, sale or income; without a money-weighted helper any other history omits it.
    const singleAcquisition = buyTx.length === 1 && transactions.length === 1;
    if (singleAcquisition && currentValue !== null && costBasis > 0) {
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
      symbol: selectedHolding.symbol,
      singleAcquisition,
    };
  }, [selectedHolding, transactions]);

  // Price chart with buy/sell markers
  const chartData = useMemo((): PriceChartPoint[] => {
    if (prices.length === 0) return [];

    const txByDate = new Map<string, { buys: boolean; sells: boolean }>();
    transactions.forEach((tx) => {
      const date = tx.transactionDate;
      const existing = txByDate.get(date) || { buys: false, sells: false };
      if (baseInvestmentAction(tx.action) === 'BUY' || tx.action === 'ADD_SHARES' || baseInvestmentAction(tx.action) === 'REINVEST') {
        existing.buys = true;
      }
      if (baseInvestmentAction(tx.action) === 'SELL' || tx.action === 'REMOVE_SHARES') {
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
    // Every dividend, paid in cash or reinvested. A reinvested interest or
    // capital-gain distribution is not a dividend, as its cash twin is not, and
    // a VOID row paid nothing.
    const list = transactions.filter(
      (tx) => incomeBaseKind(tx.action) === 'DIVIDEND' && investmentRowHasEffect(tx),
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
          comparison = compareValues(investmentIncomeAmount(a), investmentIncomeAmount(b));
          break;
      }
      return dividendSort.sortDirection === 'asc' ? comparison : -comparison;
    });
    return list;
  }, [transactions, dividendSort.sortField, dividendSort.sortDirection, accountNameById]);

  // Transaction history (non-dividend)
  const tradeTx = useMemo(() => {
    const list = transactions.filter(
      (tx) => !['DIVIDEND', 'INTEREST', 'CAPITAL_GAIN'].includes(baseInvestmentAction(tx.action)),
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

  // The trade table's six sortable columns, keyed by field so the record is
  // exhaustive: adding a member to `TradeSortField` is a compile error here
  // rather than a header with no control. Their declaration order is the column
  // (and cell DOM) order, rendered by BOTH the column header row and the phone
  // sort strip from the derived `Object.values`.
  const tradeColumns: TableSortColumnsByField<TradeSortField, TradeSortColumn> = {
    date: { field: 'date', label: t('securityPerformance.colDate') },
    account: { field: 'account', label: t('securityPerformance.colAccount') },
    action: { field: 'action', label: t('securityPerformance.colAction') },
    shares: { field: 'shares', label: t('securityPerformance.colShares'), align: 'right' },
    price: { field: 'price', label: t('securityPerformance.colPrice'), align: 'right' },
    total: { field: 'total', label: t('securityPerformance.colTotal'), align: 'right' },
  };
  const tradeSortColumns: readonly TradeSortColumn[] = Object.values(tradeColumns);

  // The dividend table's four sortable columns, same shape and same rule.
  const dividendColumns: TableSortColumnsByField<DividendSortField, DividendSortColumn> = {
    date: { field: 'date', label: t('securityPerformance.colDate') },
    account: { field: 'account', label: t('securityPerformance.colAccount') },
    type: { field: 'type', label: t('securityPerformance.colType') },
    amount: { field: 'amount', label: t('securityPerformance.colAmount'), align: 'right' },
  };
  const dividendSortColumns: readonly DividendSortColumn[] = Object.values(dividendColumns);

  // Every request feeding the export has to have answered without error: the
  // hook keeps the previous payload through a pending or failed reload, so a
  // document taken then would carry another selection's figures.
  const exportUnavailable =
    (!isSingle && !isComparison) ||
    isLoading ||
    !!error ||
    (isComparison ? !comparisonExportable : isLoadingDetail || !!detailError);

  const handleExportPdf = async () => {
    if (isComparison) {
      await comparisonExportRef.current?.exportPdf();
      return;
    }

    const { exportToPdf } = await import('@/lib/pdf-export');

    const secLabel = selectedSecurity
      ? `${selectedSecurity.symbol} - ${selectedSecurity.name}${selectedSecurity.exchange ? ` (${selectedSecurity.exchange})` : ''}`
      : undefined;

    const summaryCards = stats ? [
      { label: t('securityPerformance.pdfCurrentValue'), value: stats.currentValue !== null ? formatCurrencyFull(stats.currentValue, displayCurrency) : '-', color: '#111827' },
      { label: t('securityPerformance.pdfCostBasis'), value: formatCurrencyFull(stats.costBasis, displayCurrency), color: '#111827' },
      { label: t('securityPerformance.pdfTotalReturn'), value: stats.totalReturn !== null && stats.totalReturnPercent !== null ? `${stats.totalReturn >= 0 ? '+' : ''}${formatCurrencyFull(stats.totalReturn, displayCurrency)} (${formatSignedPercent(stats.totalReturnPercent)})` : '-', color: stats.totalReturn === null ? '#9ca3af' : stats.totalReturn >= 0 ? '#16a34a' : '#dc2626' },
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
          formatDate(tx.transactionDate),
          accountNameById.get(tx.accountId) || '-',
          tx.action,
          // The PDF is a reading surface, so its share count is formatted like
          // the table's -- `String(tx.quantity)` printed the raw `"10.0000"` the
          // wire carries, in nobody's number locale.
          tx.quantity != null ? formatShareQuantity(Number(tx.quantity)) : '-',
          tx.price != null ? formatCurrencyFull(tx.price, displayCurrency) : '-',
          formatCurrencyFull(Math.abs(tx.totalAmount), displayCurrency),
        ]),
      };
    } else {
      const totalDividends = sumDividends(dividendTx);
      tableData = {
        headers: [
          t('securityPerformance.pdfColDateTx'),
          t('securityPerformance.pdfColAccount'),
          t('securityPerformance.colType'),
          t('securityPerformance.colAmount'),
        ],
        rows: dividendTx.map((tx) => [
          formatDate(tx.transactionDate),
          accountNameById.get(tx.accountId) || '-',
          tx.action,
          formatCurrencyFull(investmentIncomeAmount(tx), displayCurrency),
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

  return (
    <div className="space-y-6">
      {/* Security and benchmark selectors, and the chart's window -- always
          rendered so focus inside DateInput survives reloads. The load and
          error states belong to the body below, not to the whole report. */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4 space-y-4">
        <div className="flex flex-wrap gap-4 items-center justify-between">
          <div className="flex w-full flex-wrap gap-2 items-center sm:w-auto">
            {/* From `sm` up, sized to their longest option rather than to the
                current selection: these two sit in the toolbar, and a control
                that stretches on every pick drags the range selector around
                under the cursor. On a phone there is no room for that -- the
                longest security name is wider than the screen -- so each takes
                the full line and the selected name truncates. */}
            <div className="w-full sm:w-auto sm:min-w-[250px]">
              <MultiSelect
                ariaLabel={t('securityPerformance.selectSecuritiesPlaceholder')}
                options={securityOptions}
                value={selectedSecurityIds}
                onChange={setSelectedSecurityIds}
                placeholder={t('securityPerformance.selectSecuritiesPlaceholder')}
                sizeToLongestOption
              />
            </div>
            <div className="w-full sm:w-auto sm:min-w-[250px]">
              <MultiSelect
                ariaLabel={t('securityPerformance.selectIndexesPlaceholder')}
                options={indexOptions}
                value={selectedIndexCodes}
                onChange={setSelectedIndexCodes}
                placeholder={t('securityPerformance.selectIndexesPlaceholder')}
                sizeToLongestOption
              />
            </div>
          </div>
          {isSingle && (
            <div
              className={`${SEGMENTED_GROUP_CLASS} flex-wrap`}
              role="group"
              aria-label={t('reportPage.viewLabel')}
            >
              <button
                type="button"
                onClick={() => setViewType('chart')}
                aria-pressed={viewType === 'chart'}
                className={segmentClass(viewType === 'chart')}
              >
                {t('securityPerformance.viewPriceChart')}
              </button>
              <button
                type="button"
                onClick={() => setViewType('transactions')}
                aria-pressed={viewType === 'transactions'}
                className={segmentClass(viewType === 'transactions')}
              >
                {t('securityPerformance.viewTransactions')}
              </button>
              <button
                type="button"
                onClick={() => setViewType('dividends')}
                aria-pressed={viewType === 'dividends'}
                className={segmentClass(viewType === 'dividends')}
              >
                {t('securityPerformance.viewDividends')}
              </button>
            </div>
          )}
          {/* The export is disabled rather than absent until a security is
              picked: a button that appears on selection moves the row under
              the reader's thumb on a phone. */}
          <ReportToolbarActions
            onRefreshComplete={() => { reloadBase(); reloadDetail(); setAllRefreshKey((k) => k + 1); }}
            onExportPdf={handleExportPdf}
            disabled={exportUnavailable}
          />
        </div>

        {/*
          The window governs the chart alone. The stats cards report the
          position as it stands now and the tables are history records; scoping
          either to a window would answer a question nobody asked -- a "cost
          basis over the last month" is not a cost basis. The note says so
          rather than leaving the reader to work it out.
        */}
        <div className="flex flex-wrap gap-3 items-center justify-between">
          <DateRangeSelector
            ranges={CHART_RANGES}
            value={dateRange}
            onChange={setDateRange}
            showCustom
            customStartDate={startDate}
            onCustomStartDateChange={setStartDate}
            customEndDate={endDate}
            onCustomEndDateChange={setEndDate}
            size="sm"
          />
          <p className="text-xs text-gray-400 dark:text-gray-500">
            {t('securityPerformance.timeframeChartOnlyNote')}
          </p>
        </div>
      </div>

      {error ? (
        <ReportError onRetry={reloadBase} />
      ) : isLoading ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <div className="space-y-4">
            <Skeleton className="h-8 w-1/3" />
            <Skeleton className="h-64 w-full" />
          </div>
        </div>
      ) : selectedSecurityIds.length + activeIndexCodes.length === 0 ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-8 text-center">
          <p className="text-gray-500 dark:text-gray-400">
            {t('securityPerformance.selectPrompt')}
          </p>
        </div>
      ) : isComparison ? (
        <SecurityComparisonChart
          securityIds={selectedSecurityIds}
          indexCodes={activeIndexCodes}
          startDate={resolvedRange.start}
          endDate={resolvedRange.end}
          reloadKey={allRefreshKey}
          exportRef={comparisonExportRef}
          onExportableChange={setComparisonExportable}
        />
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
                  {stats.currentValue !== null ? formatCurrencyFull(stats.currentValue, displayCurrency) : '-'}
                </div>
                <div className="text-xs text-gray-400 dark:text-gray-500 mt-1">
                  {stats.currentValue === null || stats.currentPrice === null || stats.currentPrice === undefined
                    ? t('securityPerformance.missingPrice', { symbol: stats.symbol })
                    : t('securityPerformance.sharesAtPrice', { shares: stats.quantity, price: formatCurrencyFull(stats.currentPrice, displayCurrency) })}
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
              <div className={`rounded-lg shadow p-4 ${stats.totalReturn === null ? 'bg-gray-50 dark:bg-gray-800' : stats.totalReturn >= 0 ? 'bg-green-50 dark:bg-green-900/20' : 'bg-red-50 dark:bg-red-900/20'}`}>
                <div className={`text-sm ${stats.totalReturn === null ? 'text-gray-500 dark:text-gray-400' : gainLossColor(stats.totalReturn)}`}>
                  {t('securityPerformance.totalReturn')}
                </div>
                {stats.totalReturn === null || stats.totalReturnPercent === null ? (
                  <div className="text-xl font-bold text-gray-400">-</div>
                ) : (
                  <>
                    <div className={`text-xl font-bold ${gainLossColor(stats.totalReturn)}`}>
                      {stats.totalReturn >= 0 ? '+' : ''}{formatCurrencyFull(stats.totalReturn, displayCurrency)}
                    </div>
                    <div className={`text-xs mt-1 ${gainLossColor(stats.totalReturn)}`}>
                      {formatSignedPercent(stats.totalReturnPercent)}
                    </div>
                  </>
                )}
              </div>
              <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
                <div className="text-sm text-gray-500 dark:text-gray-400">{t('securityPerformance.annualizedReturn')}</div>
                <div className={`text-xl font-bold ${stats.annualizedReturn !== null ? gainLossColor(stats.annualizedReturn) : 'text-gray-400'}`}>
                  {stats.annualizedReturn !== null
                    ? formatSignedPercent(stats.annualizedReturn)
                    : '-'}
                </div>
                {stats.annualizedReturn === null && (
                  <div className="text-xs text-gray-400 dark:text-gray-500 mt-1">{stats.currentValue === null ? t('securityPerformance.missingPrice', { symbol: stats.symbol }) : stats.singleAcquisition ? t('securityPerformance.needs1YearNote') : t('securityPerformance.annualizedNeedsSingleBuyNote')}</div>
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
                        dot={{ r: 6, fill: chartColors.income, stroke: chartColors.surface, strokeWidth: 2 }}
                        activeDot={false}
                        connectNulls={false}
                      />
                      {/* Sell markers */}
                      <Area
                        type="monotone"
                        dataKey="sellMarker"
                        stroke="none"
                        fill="none"
                        dot={{ r: 6, fill: chartColors.expense, stroke: chartColors.surface, strokeWidth: 2 }}
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
                <EmptyState title={t('securityPerformance.noPriceHistory')} />
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
                /* Below `sm` the table becomes a block and each row wraps into a
                   three-column, two-line grid card so all six columns fit a
                   phone without a horizontal scroll: line 1 is the date (the row
                   identity), the action pill and the total (the headline);
                   line 2 is the account, the share count and the price. Nothing
                   is dropped, and no figure is truncated -- a money value never
                   wraps (`MONEY_CELL`). From `sm` up it is the ordinary table,
                   resolving to today's output in every respect but one (each
                   cell restores its own `sm:px-4 sm:py-3 sm:text-sm`;
                   `MONEY_CELL`'s `whitespace-nowrap` is unprefixed, so it
                   applies at 640px+ too, where the base cell carried no
                   `white-space` class -- deliberate, and the constant says
                   why), and the sort controls survive
                   as their own phone-only header row because the column header
                   row that carries them on desktop is hidden there. Restyling
                   `display` strips the implicit table semantics below `sm`, so
                   the roles are restated and every bare figure carries a
                   `CellLabel` naming its column; the pill and the date name
                   themselves. */
                <div className="overflow-x-auto">
                  <table role="table" className="block min-w-full divide-y divide-gray-200 dark:divide-gray-700 sm:table">
                    <thead role="rowgroup" className="block bg-gray-50 dark:bg-gray-900/50 sm:table-header-group">
                      {/* Phone sort strip: the same six controls, wrapped. */}
                      <tr role="row" className="flex flex-wrap gap-x-2 gap-y-1 px-2 py-2 sm:hidden">
                        {tradeSortColumns.map((col) => (
                          <SortableHeader<TradeSortField>
                            key={col.field}
                            field={col.field}
                            sortField={tradeSort.sortField}
                            sortDirection={tradeSort.sortDirection}
                            onSort={tradeSort.handleSort}
                            className={PHONE_HEADER_CLASS}
                          >
                            {col.label}
                          </SortableHeader>
                        ))}
                      </tr>
                      <tr role="row" className="hidden sm:table-row">
                        {tradeSortColumns.map((col) => (
                          <SortableHeader<TradeSortField>
                            key={col.field}
                            field={col.field}
                            sortField={tradeSort.sortField}
                            sortDirection={tradeSort.sortDirection}
                            onSort={tradeSort.handleSort}
                            align={col.align}
                            className={TH_CLASS}
                          >
                            {col.label}
                          </SortableHeader>
                        ))}
                      </tr>
                    </thead>
                    <tbody role="rowgroup" className="block divide-y divide-gray-200 dark:divide-gray-700 sm:table-row-group">
                      {tradeTx.map((tx) => (
                        <tr
                          key={tx.id}
                          role="row"
                          className="grid grid-cols-3 items-start gap-x-3 gap-y-1.5 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-700/50 sm:table-row sm:p-0"
                        >
                          {/* Date: the row identity. A formatted date never wraps. */}
                          <td role="cell" className="col-start-1 row-start-1 p-0 text-xs whitespace-nowrap text-gray-900 dark:text-gray-100 sm:table-cell sm:px-4 sm:py-3 sm:text-sm">
                            {formatDate(tx.transactionDate)}
                          </td>
                          <td role="cell" className="col-start-1 row-start-2 p-0 text-xs break-words text-gray-600 dark:text-gray-400 sm:table-cell sm:px-4 sm:py-3 sm:text-sm sm:break-normal">
                            <CellLabel className={CAPTION_CLASS}>{tradeColumns.account.label}</CellLabel>
                            {accountNameById.get(tx.accountId) || '-'}
                          </td>
                          {/* Action: a self-describing pill, so no caption. */}
                          <td role="cell" className="col-start-2 row-start-1 p-0 text-sm sm:table-cell sm:px-4 sm:py-3">
                            <span className={`px-2 py-0.5 text-xs font-medium rounded ${
                              ['BUY', 'ADD_SHARES', 'TRANSFER_IN', 'REINVEST'].includes(baseInvestmentAction(tx.action))
                                ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                                : ['SELL', 'REMOVE_SHARES', 'TRANSFER_OUT'].includes(baseInvestmentAction(tx.action))
                                  ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                                  : 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300'
                            }`}>
                              {tx.action}
                            </span>
                          </td>
                          <td role="cell" className={`col-start-2 row-start-2 text-gray-600 dark:text-gray-400 ${MONEY_CELL}`}>
                            <CellLabel className={CAPTION_CLASS}>{tradeColumns.shares.label}</CellLabel>
                            {tx.quantity != null ? formatShareQuantity(Number(tx.quantity)) : '-'}
                          </td>
                          <td role="cell" className={`col-start-3 row-start-2 text-gray-600 dark:text-gray-400 ${MONEY_CELL}`}>
                            <CellLabel className={CAPTION_CLASS}>{tradeColumns.price.label}</CellLabel>
                            {tx.price != null ? formatCurrencyFull(tx.price, displayCurrency) : '-'}
                          </td>
                          {/* Total: the headline figure, beside the date. */}
                          <td role="cell" className={`col-start-3 row-start-1 font-medium text-gray-900 dark:text-gray-100 ${MONEY_CELL}`}>
                            <CellLabel className={CAPTION_CLASS}>{tradeColumns.total.label}</CellLabel>
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
                /* Below `sm` the table becomes a block and each row wraps into a
                   two-column, two-line grid card so all four columns fit a phone
                   without a horizontal scroll: line 1 is the date (identity) and
                   the amount (headline); line 2 is the account and the type pill.
                   Nothing is dropped, and the amount never wraps (`MONEY_CELL`).
                   From `sm` up it is the ordinary table, resolving to today's
                   output in every respect but one -- `MONEY_CELL`'s
                   `whitespace-nowrap` is unprefixed, so it applies at 640px+
                   too, where the base cell carried no `white-space` class
                   (deliberate; the constant says why) -- and the sort controls
                   survive as their own phone-only
                   header row. The footer wraps the same way -- "Total Dividends"
                   beside the total -- and keeps its desktop `colSpan={3}`, so its
                   cells carry `aria-colindex` (they do not map one-to-one to the
                   body columns). */
                <div className="overflow-x-auto">
                  <table role="table" className="block min-w-full divide-y divide-gray-200 dark:divide-gray-700 sm:table">
                    <thead role="rowgroup" className="block bg-gray-50 dark:bg-gray-900/50 sm:table-header-group">
                      {/* Phone sort strip: the same four controls, wrapped. */}
                      <tr role="row" className="flex flex-wrap gap-x-2 gap-y-1 px-2 py-2 sm:hidden">
                        {dividendSortColumns.map((col) => (
                          <SortableHeader<DividendSortField>
                            key={col.field}
                            field={col.field}
                            sortField={dividendSort.sortField}
                            sortDirection={dividendSort.sortDirection}
                            onSort={dividendSort.handleSort}
                            className={PHONE_HEADER_CLASS}
                          >
                            {col.label}
                          </SortableHeader>
                        ))}
                      </tr>
                      <tr role="row" className="hidden sm:table-row">
                        {dividendSortColumns.map((col) => (
                          <SortableHeader<DividendSortField>
                            key={col.field}
                            field={col.field}
                            sortField={dividendSort.sortField}
                            sortDirection={dividendSort.sortDirection}
                            onSort={dividendSort.handleSort}
                            align={col.align}
                            className={TH_CLASS}
                          >
                            {col.label}
                          </SortableHeader>
                        ))}
                      </tr>
                    </thead>
                    <tbody role="rowgroup" className="block divide-y divide-gray-200 dark:divide-gray-700 sm:table-row-group">
                      {dividendTx.map((tx) => (
                        <tr
                          key={tx.id}
                          role="row"
                          className="grid grid-cols-2 items-start gap-x-3 gap-y-1.5 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-700/50 sm:table-row sm:p-0"
                        >
                          {/* Date: the row identity. A formatted date never wraps. */}
                          <td role="cell" className="col-start-1 row-start-1 p-0 text-xs whitespace-nowrap text-gray-900 dark:text-gray-100 sm:table-cell sm:px-4 sm:py-3 sm:text-sm">
                            {formatDate(tx.transactionDate)}
                          </td>
                          <td role="cell" className="col-start-1 row-start-2 p-0 text-xs break-words text-gray-600 dark:text-gray-400 sm:table-cell sm:px-4 sm:py-3 sm:text-sm sm:break-normal">
                            <CellLabel className={CAPTION_CLASS}>{dividendColumns.account.label}</CellLabel>
                            {accountNameById.get(tx.accountId) || '-'}
                          </td>
                          {/* Type: a self-describing pill, so no caption. */}
                          <td role="cell" className="col-start-2 row-start-2 p-0 text-sm sm:table-cell sm:px-4 sm:py-3">
                            <span className="px-2 py-0.5 text-xs font-medium rounded bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
                              {tx.action}
                            </span>
                          </td>
                          {/* Amount: the headline figure, beside the date. */}
                          <td role="cell" className={`col-start-2 row-start-1 font-medium text-green-600 dark:text-green-400 ${MONEY_CELL}`}>
                            <CellLabel className={CAPTION_CLASS}>{dividendColumns.amount.label}</CellLabel>
                            {formatCurrencyFull(investmentIncomeAmount(tx), displayCurrency)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot role="rowgroup" className="block bg-gray-50 dark:bg-gray-900/50 sm:table-footer-group">
                      {/* "Total Dividends" stands in for the identity; the total
                          sits beside it. The label keeps its desktop `colSpan={3}`,
                          so both cells state `aria-colindex`. The total names
                          itself from that label, so it carries no caption.

                          `aria-colspan` restates that `colSpan` for the same
                          reason `role="cell"` restates the implicit role: below
                          `sm` the `display` is no longer `table-cell`, and the
                          span an assistive technology reads from the table's own
                          layout goes with it. The table declares no
                          `aria-colcount` -- neither does any converted sibling,
                          and one here alone would be a convention of one file. */}
                      <tr role="row" className="grid grid-cols-2 items-start gap-x-3 gap-y-1.5 px-4 py-3 sm:table-row sm:p-0">
                        <td role="cell" aria-colindex={1} aria-colspan={3} colSpan={3} className="col-start-1 row-start-1 p-0 text-sm font-bold text-gray-900 dark:text-gray-100 sm:table-cell sm:px-4 sm:py-3">
                          {t('securityPerformance.totalDividends')}
                        </td>
                        <td role="cell" aria-colindex={4} className={`col-start-2 row-start-1 font-bold text-green-600 dark:text-green-400 ${MONEY_CELL}`}>
                          {formatCurrencyFull(sumDividends(dividendTx), displayCurrency)}
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
