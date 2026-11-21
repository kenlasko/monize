'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { Skeleton } from '@/components/ui/LoadingSkeleton';
import { format } from 'date-fns';
import { investmentsApi } from '@/lib/investments';
import { investmentReportsApi } from '@/lib/investment-reports';
import {
  rowAmountCurrency,
  rowCommissionCurrency,
  rowConversionBasis,
  rowPriceCurrency,
} from '@/lib/investment-row-currency';
import {
  InvestmentTransaction,
  InvestmentAction,
  InvestmentConvertedAggregate,
  InvestmentTransactionSummary,
} from '@/types/investment';
import { Account } from '@/types/account';
import { parseLocalDate } from '@/lib/utils';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { useDateRange } from '@/hooks/useDateRange';
import { useReportData } from '@/hooks/useReportData';
import { usePersistedAccountFilter } from '@/hooks/usePersistedAccountFilter';
import { DateRangeSelector } from '@/components/ui/DateRangeSelector';
import { ReportToolbarActions } from '@/components/reports/ReportToolbarActions';
import { MultiSelect } from '@/components/ui/MultiSelect';
import { ReportAccountMultiSelect } from '@/components/reports/ReportAccountMultiSelect';
import { ReportError } from '@/components/reports/ReportError';
import { exportToCsv, exportCsvSections } from '@/lib/csv-export';
import { SortableHeader } from '@/components/ui/SortableHeader';
import { CAPTION_CLASS, CellLabel, PHONE_HEADER_CLASS, TH_CLASS } from '@/components/ui/Table';
import { PartialTotal } from '@/components/ui/PartialTotal';
import { UnknownAmount } from '@/components/ui/UnknownAmount';
import type { ConvertedTotal } from '@/lib/currency-total';
import { priceDecimals, TRADE_PRICE_DISPLAY_DECIMALS } from '@/lib/security-detail';
import { useSortableTable, compareValues } from '@/hooks/useSortableTable';
import { createLogger } from '@/lib/logger';
import { useTranslations } from 'next-intl';
import { useMainAccountName } from '@/hooks/useMainAccountName';
import {
  ACTION_COLORS,
  DATE_CELL,
  MONEY_CELL,
  type InvestmentTxSortField,
  type SortColumn,
  type SortColumnsByField,
} from '@/components/reports/InvestmentTransactionHistoryReportParts';
import { EmptyState } from '@/components/ui/EmptyState';
import { CARD_CLASS } from '@/components/ui/Card';

const logger = createLogger('InvestmentTransactionHistoryReport');

const MAX_PAGES = 50;

const ACCOUNTS_STORAGE_KEY = 'monize-reports-investment-transactions-accounts';

/** What the table lists: the pages that were fetched, and whether that was all. */
interface TransactionPage {
  transactions: InvestmentTransaction[];
  /** True when the fetch stopped at `MAX_PAGES` with more still to come. */
  truncated: boolean;
}

/**
 * One column of the CSV / PDF. `formatted` is the PDF's rendering; the CSV
 * writes raw numbers, which is what makes them numbers in a spreadsheet.
 */
interface ExportColumn {
  label: string;
  value: (tx: InvestmentTransaction, formatted: boolean) => string | number;
}

/**
 * The server's aggregate as the shape `PartialTotal` reads.
 *
 * The subtotal is what goes on screen; `missingPairs` are `"USD->PLN"`, and the
 * marker names the source side, which is the currency the reader has to find a
 * rate for.
 */
function asConvertedTotal(aggregate: InvestmentConvertedAggregate): ConvertedTotal {
  return {
    value: aggregate.knownSubtotal,
    missingCurrencies: [...new Set(aggregate.missingPairs.map((pair) => pair.split('->')[0]))],
    excludedCount: aggregate.excludedCount,
  };
}

export function InvestmentTransactionHistoryReport() {
  const t = useTranslations('reports');
  const tCommon = useTranslations('common');
  const mainAccountName = useMainAccountName();
  const { formatCurrency: formatCurrencyFull, formatShareQuantity } = useNumberFormat();
  // The on-screen date goes through the reader's preference. The CSV's date
  // deliberately does not (see the `date` column's `csvValue`): a machine reads
  // that one, and ISO is what every unconverted sibling export writes.
  const { formatDate } = useDateFormat();
  // Only for the reader's own currency, which decides whether a row's figure
  // needs its ISO code spelled beside it. Nothing here converts: the one
  // conversion is the server's, at each row's own transaction date.
  const { defaultCurrency } = useExchangeRates();
  const [accounts, setAccounts] = useState<Account[]>([]);
  // Persisted so the report opens on the accounts the user last chose.
  const [selectedAccountIds, setSelectedAccountIds] = usePersistedAccountFilter(
    ACCOUNTS_STORAGE_KEY,
    accounts,
  );
  const [selectedActions, setSelectedActions] = useState<string[]>([]);

  const actionLabels = useMemo<Record<InvestmentAction, string>>(() => ({
    BUY: t('investmentTransactions.actionBuy'),
    SELL: t('investmentTransactions.actionSell'),
    DIVIDEND: t('investmentTransactions.actionDividend'),
    INTEREST: t('investmentTransactions.actionInterest'),
    CAPITAL_GAIN: t('investmentTransactions.actionCapitalGain'),
    SPLIT: t('investmentTransactions.actionSplit'),
    TRANSFER_IN: t('investmentTransactions.actionTransferIn'),
    TRANSFER_OUT: t('investmentTransactions.actionTransferOut'),
    REINVEST: t('investmentTransactions.actionReinvest'),
    ADD_SHARES: t('investmentTransactions.actionAddShares'),
    REMOVE_SHARES: t('investmentTransactions.actionRemoveShares'),
    REINVEST_INTEREST: t('investmentTransactions.actionReinvestInterest'),
    REINVEST_CAPITAL_GAIN_SHORT: t('investmentTransactions.actionReinvestCapitalGainShort'),
    REINVEST_CAPITAL_GAIN_LONG: t('investmentTransactions.actionReinvestCapitalGainLong'),
    CAPITAL_GAIN_SHORT: t('investmentTransactions.actionCapitalGainShort'),
    CAPITAL_GAIN_LONG: t('investmentTransactions.actionCapitalGainLong'),
    REDEEM: t('investmentTransactions.actionRedeem'),
    RETURN_OF_CAPITAL: t('investmentTransactions.actionReturnOfCapital'),
  }), [t]);

  const actionOptions = useMemo(
    () =>
      (Object.keys(actionLabels) as InvestmentAction[]).map((action) => ({
        value: action,
        label: actionLabels[action],
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t],
  );
  const { dateRange, setDateRange, resolvedRange, isValid } = useDateRange({ defaultRange: '1y', alignment: 'month' });
  const { start: rangeStart, end: rangeEnd } = resolvedRange;
  const isSingleAccount = selectedAccountIds.length === 1;
  const { sortField, sortDirection, handleSort } = useSortableTable<InvestmentTxSortField>(
    'reports.investment-transactions.sort',
    { field: 'date', direction: 'desc' },
  );

  const selectedAccount = isSingleAccount
    ? accounts.find((a) => a.id === selectedAccountIds[0])
    : undefined;

  /**
   * A row's own money, in a row's own currency. The ISO code is appended when
   * that currency is not the reader's, because two currencies can share a
   * symbol and the row is the only place the difference is stated.
   *
   * `null` in, `null` out: the caller renders `UnknownAmount` rather than
   * labelling the figure with a currency nobody established.
   */
  const fmtRowMoney = useCallback(
    (value: number, currency: string | null): string | null => {
      if (currency === null) return null;
      if (currency === defaultCurrency) return formatCurrencyFull(value, currency);
      return `${formatCurrencyFull(value, currency)} ${currency}`;
    },
    [formatCurrencyFull, defaultCurrency],
  );

  /**
   * A per-share price, at the decimals the stored figure actually carries.
   *
   * A price derived from an executed total is a quotient -- 141 shares for
   * 820.91 went at 5.822057 -- and the reader's currency decimals round that
   * back to the two-decimal figure this report is here to stop reporting.
   */
  const fmtRowPrice = useCallback(
    (value: number, currency: string | null): string | null => {
      if (currency === null) return null;
      const decimals = priceDecimals([value], TRADE_PRICE_DISPLAY_DECIMALS);
      const text = formatCurrencyFull(value, currency, decimals);
      return currency === defaultCurrency ? text : `${text} ${currency}`;
    },
    [formatCurrencyFull, defaultCurrency],
  );

  // Fetch accounts once on mount
  useEffect(() => {
    investmentsApi.getInvestmentAccounts()
      .then(setAccounts)
      .catch((error) => logger.error('Failed to load accounts:', error));
  }, []);

  const { data: response, isLoading, error, reload } = useReportData<TransactionPage | null>(
    async () => {
      if (!isValid) return null;
      const allTransactions: InvestmentTransaction[] = [];
      let page = 1;
      let hasMore = true;
      while (hasMore && page <= MAX_PAGES) {
        const result = await investmentsApi.getTransactions({
          accountIds: selectedAccountIds.length > 0 ? selectedAccountIds.join(',') : undefined,
          startDate: rangeStart || undefined,
          endDate: rangeEnd,
          limit: 200,
          page,
        });
        allTransactions.push(...result.data);
        hasMore = result.pagination.hasMore;
        page++;
      }
      // `hasMore` still set after the last allowed page means the table below is
      // showing part of the answer. The KPIs do not come from here, so they stay
      // whole; the table says what it is missing.
      return { transactions: allTransactions, truncated: hasMore };
    },
    [selectedAccountIds, rangeStart, rangeEnd, isValid],
  );

  /**
   * The KPIs, computed by the server over the WHOLE filtered set.
   *
   * Not derived from the rows above for two independent reasons: those rows are
   * capped at `MAX_PAGES`, and each carries an amount in its own security's
   * currency, which only the server can convert at the rate that stood on the
   * trade's own date.
   */
  const {
    data: summary,
    isLoading: isSummaryLoading,
    error: summaryError,
    reload: reloadSummary,
  } = useReportData<InvestmentTransactionSummary | null>(
    async () => {
      if (!isValid) return null;
      return investmentReportsApi.getTransactionSummary({
        accountIds: selectedAccountIds,
        startDate: rangeStart || undefined,
        endDate: rangeEnd,
        actions: selectedActions,
      });
    },
    [selectedAccountIds, rangeStart, rangeEnd, selectedActions, isValid],
  );

  const reloadAll = useCallback(() => {
    reload();
    reloadSummary();
  }, [reload, reloadSummary]);

  // Only the first load shows the full skeleton. Later reloads (e.g. changing
  // the account filter) keep the existing content -- and the account dropdown --
  // mounted so they update in place instead of unmounting the whole report.
  const transactions = useMemo<InvestmentTransaction[]>(
    () => response?.transactions ?? [],
    [response],
  );
  const isTruncated = response?.truncated === true;

  // Action filtering happens client-side so toggling actions never re-fetches.
  const filteredTransactions = useMemo(() => {
    if (selectedActions.length === 0) return transactions;
    const set = new Set(selectedActions);
    return transactions.filter((tx) => set.has(tx.action));
  }, [transactions, selectedActions]);

  // Every KPI reads the server's one answer. The client-side cross-currency sum
  // that used to stand here added a EUR 1,000 trade to a USD 1,000 trade and
  // captioned the result in the reader's own currency (issue #1394).
  const actionSummaries = useMemo(() => summary?.byAction ?? [], [summary]);
  const reportingCurrency = summary?.currencyCode ?? defaultCurrency;

  /**
   * What a KPI shows when the server has not answered: a marker, never a number.
   *
   * The counts have no client-side substitute. The rows above are capped at
   * `MAX_PAGES` and filtered by whatever the reader selected, so their length is
   * a different measurement wearing the server's caption, and `0` securities is
   * a claim nobody made. A failed summary does not reach here at all -- it is
   * the report's error screen, below -- so this is the one honest state left:
   * the request has not answered yet.
   */
  const unknownKpi = tCommon('unknownAmount.marker');

  /**
   * The one line under the KPIs naming the rate each row was converted at.
   *
   * Nothing to say when no row needed converting at all -- every amount is
   * already in the reader's currency, so neither count is above zero and a
   * sentence about rates would invent a question nobody asked.
   */
  const conversionNote = useMemo<string | null>(() => {
    if (!summary) return null;
    const own = summary.transactionRateCount;
    const market = summary.marketRateCount;
    const onward = summary.onwardMarketCount;
    if (own === 0 && market === 0) return null;
    if (own === 0) return t('investmentTransactions.convertedAtMarketRate', { count: market });
    const base =
      market === 0
        ? t('investmentTransactions.convertedAtOwnRate')
        : t('investmentTransactions.convertedAtOwnRateWithMarket', { count: market });
    return onward > 0
      ? `${base} ${t('investmentTransactions.convertedOnward', { count: onward })}`
      : base;
  }, [summary, t]);

  /** The KPI's own figure, in the reporting currency the server named. */
  const fmtReportingMoney = useCallback(
    (value: number): string => formatCurrencyFull(value, reportingCurrency),
    [formatCurrencyFull, reportingCurrency],
  );

  /**
   * True when the table's amounts span more than one currency, so a sort by
   * Price or Total cannot compare the raw numbers. The rows are grouped by
   * currency instead, and the report says so rather than doing it silently.
   */
  const sortsWithinCurrency = useMemo(() => {
    const currencies = new Set<string>();
    let hasUnknown = false;
    for (const tx of filteredTransactions) {
      const currency = rowAmountCurrency(tx);
      if (currency === null) hasUnknown = true;
      else currencies.add(currency);
    }
    return currencies.size > 1 || (hasUnknown && currencies.size > 0);
  }, [filteredTransactions]);

  const accountNameMap = useMemo(() => {
    const map = new Map<string, string>();
    accounts.forEach((a) => map.set(a.id, a.name));
    return map;
  }, [accounts]);

  const sortedTransactions = useMemo(() => {
    const sorted = [...filteredTransactions];
    sorted.sort((a, b) => {
      let comparison = 0;
      switch (sortField) {
        case 'date':
          comparison = compareValues(a.transactionDate, b.transactionDate);
          break;
        case 'action':
          comparison = compareValues(a.action, b.action);
          break;
        case 'security':
          comparison = compareValues(a.security?.symbol || '', b.security?.symbol || '');
          break;
        case 'account':
          comparison = compareValues(
            accountNameMap.get(a.accountId) || '',
            accountNameMap.get(b.accountId) || '',
          );
          break;
        case 'quantity':
          comparison = compareValues(
            a.quantity != null ? Math.abs(a.quantity) : null,
            b.quantity != null ? Math.abs(b.quantity) : null,
          );
          break;
        // Both money columns sort by (currency, value). Comparing the raw
        // numbers would rank a 100 EUR price above a 90 USD one on arithmetic
        // that means nothing across currencies; grouping first keeps every
        // comparison inside one unit, and the caption under the table says so.
        case 'price':
          comparison =
            compareValues(rowPriceCurrency(a), rowPriceCurrency(b)) ||
            compareValues(a.price, b.price);
          break;
        case 'total':
          comparison =
            compareValues(rowAmountCurrency(a), rowAmountCurrency(b)) ||
            compareValues(Math.abs(a.totalAmount), Math.abs(b.totalAmount));
          break;
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });
    return sorted;
  }, [filteredTransactions, sortField, sortDirection, accountNameMap]);

  // The seven sortable columns, keyed by field so the record is exhaustive and
  // each entry must name its own key (see `SortColumnsByField`). One entry
  // carries a column's label, its sort field, its tier-only header classes and
  // its export cell, so the two header rows, the phone captions and both halves
  // of the export cannot fall out of step with each other.
  const columns = useMemo<SortColumnsByField>(() => ({
    date: {
      field: 'date',
      label: t('investmentTransactions.colDate'),
      csvValue: (tx) => format(parseLocalDate(tx.transactionDate), 'yyyy-MM-dd'),
    },
    action: {
      field: 'action',
      label: t('investmentTransactions.colAction'),
      csvValue: (tx) => actionLabels[tx.action],
    },
    security: {
      field: 'security',
      label: t('investmentTransactions.colSecurity'),
      csvValue: (tx) => tx.security?.symbol || '-',
    },
    account: {
      field: 'account',
      label: t('investmentTransactions.colAccount'),
      // Unchanged from `sm` up: header and cell alike stay hidden until `md`,
      // as they are today. The two halves live on this one entry so a change
      // of tier cannot move only one of them; below `sm` the cell is a visible
      // grid item and the phone strip carries the sort chip.
      headerClass: 'hidden md:table-cell',
      cellClass: 'sm:hidden md:table-cell',
      csvValue: (tx) => accountNameMap.get(tx.accountId) || '-',
    },
    quantity: {
      field: 'quantity',
      label: t('investmentTransactions.colQuantity'),
      align: 'right',
      // Formatted for the PDF, a plain number for the CSV -- the same split the
      // price and total entries below make, and the reason is the same: one is
      // read by a person, the other summed by a spreadsheet.
      csvValue: (tx, formatted) =>
        tx.quantity != null
          ? formatted
            ? formatShareQuantity(Math.abs(Number(tx.quantity)))
            : Math.abs(Number(tx.quantity))
          : '',
    },
    price: {
      field: 'price',
      label: t('investmentTransactions.colPrice'),
      align: 'right',
      csvValue: (tx, formatted) =>
        tx.price != null
          ? formatted
            ? (fmtRowPrice(tx.price, rowPriceCurrency(tx)) ?? tCommon('unknownAmount.marker'))
            : tx.price
          : '',
    },
    total: {
      field: 'total',
      label: t('investmentTransactions.colTotal'),
      align: 'right',
      csvValue: (tx, formatted) =>
        formatted
          ? (fmtRowMoney(Math.abs(tx.totalAmount), rowAmountCurrency(tx)) ??
            tCommon('unknownAmount.marker'))
          : Math.abs(tx.totalAmount),
    },
  }), [t, tCommon, actionLabels, accountNameMap, fmtRowMoney, fmtRowPrice, formatShareQuantity]);

  /**
   * The export's own columns, for the CSV and the PDF alike.
   *
   * Every figure is written beside the currency it is in, in its OWN column, so
   * a spreadsheet can group by unit instead of adding two currencies together --
   * which is what the export invited when it wrote bare numbers under one
   * heading (issue #1394). The table and the export read the same row through
   * the same three `row*Currency` helpers, so a column hidden on screen cannot
   * change what the file says.
   *
   * There is deliberately no per-row CONVERTED column here. The conversion the
   * KPIs use happens on the server, at the rate that stood on each row's own
   * date, and the client never sees that rate; a converted figure written here
   * would be a second answer to a question the server has already answered.
   * The converted view is the summary section below instead.
   */
  const exportColumns = useMemo<ExportColumn[]>(
    () => [
      { label: t('investmentTransactions.colDate'), value: columns.date.csvValue },
      { label: t('investmentTransactions.colAction'), value: columns.action.csvValue },
      { label: t('investmentTransactions.colSecurity'), value: columns.security.csvValue },
      { label: t('investmentTransactions.colAccount'), value: columns.account.csvValue },
      { label: t('investmentTransactions.colQuantity'), value: columns.quantity.csvValue },
      {
        label: t('investmentTransactions.colPriceCurrency'),
        value: (tx: InvestmentTransaction) => rowPriceCurrency(tx) ?? '',
      },
      { label: t('investmentTransactions.colPrice'), value: columns.price.csvValue },
      {
        label: t('investmentTransactions.colAmountCurrency'),
        value: (tx: InvestmentTransaction) => rowAmountCurrency(tx) ?? '',
      },
      { label: t('investmentTransactions.colTotal'), value: columns.total.csvValue },
      {
        label: t('investmentTransactions.colCommissionCurrency'),
        value: (tx: InvestmentTransaction) => rowCommissionCurrency(tx) ?? '',
      },
      {
        // Which rate the converted figures above the table were struck at for
        // this row: its own settlement rate, or the market rate on its date.
        label: t('investmentTransactions.colConversionBasis'),
        value: (tx: InvestmentTransaction) =>
          rowConversionBasis(tx) === 'transaction'
            ? t('investmentTransactions.basisTransaction')
            : t('investmentTransactions.basisMarket'),
      },
      {
        label: t('investmentTransactions.colCommission'),
        value: (tx: InvestmentTransaction, formatted: boolean) =>
          tx.commission == null
            ? ''
            : formatted
              ? (fmtRowMoney(tx.commission, rowCommissionCurrency(tx)) ??
                tCommon('unknownAmount.marker'))
              : tx.commission,
      },
    ],
    [t, tCommon, columns, fmtRowMoney],
  );

  // Their order, rendered by BOTH header rows and matched by the cells' DOM
  // order. The export has its own wider list above, built from these same
  // accessors. DERIVED from the record rather than re-listed:
  // a hand-written list beside an exhaustive record is not exhaustive, so a
  // field added to the union would compile and still ship with no sort control
  // in either header. The record's declaration order is the column order.
  const sortColumns: readonly SortColumn[] = useMemo(() => Object.values(columns), [columns]);

  const getExportData = useCallback((formatted: boolean) => {
    // Both halves from the one ordered list: the headings from each column's
    // label and the cells from its own accessor, so a reorder cannot put a
    // heading over another column's figures.
    const headers = exportColumns.map((col) => col.label);
    const rows: (string | number)[][] = sortedTransactions.map((tx) =>
      exportColumns.map((col) => col.value(tx, formatted)),
    );
    return { headers, rows };
  }, [sortedTransactions, exportColumns]);

  /**
   * The converted half of the export: the reporting currency, what converted,
   * what did not and why. One section rather than per-row columns, because the
   * conversion is the server's and is stated once at the level it was made.
   */
  const getSummarySection = useCallback(() => {
    if (!summary) return null;
    const complete = summary.fxComplete !== false;
    return {
      title: t('investmentTransactions.csvSummaryTitle'),
      headers: [
        t('investmentTransactions.csvMeasure'),
        t('investmentTransactions.csvValue'),
      ],
      rows: [
        [t('investmentTransactions.csvReportingCurrency'), summary.currencyCode],
        [t('investmentTransactions.totalTransactions'), summary.transactionCount],
        [
          t('investmentTransactions.totalVolume'),
          complete && summary.total !== null ? summary.total : '',
        ],
        [t('investmentTransactions.csvKnownSubtotal'), summary.knownSubtotal],
        [
          t('investmentTransactions.csvFxComplete'),
          complete
            ? t('investmentTransactions.csvComplete')
            : t('investmentTransactions.csvPartial'),
        ],
        [t('investmentTransactions.csvMissingPairs'), summary.missingPairs.join(' ')],
        [t('investmentTransactions.securitiesTraded'), summary.securitiesTraded],
      ] as (string | number)[][],
    };
  }, [summary, t]);

  const handleExportCsv = useCallback(() => {
    const { headers, rows } = getExportData(false);
    const summarySection = getSummarySection();
    if (!summarySection) {
      exportToCsv('investment-transactions', headers, rows);
      return;
    }
    exportCsvSections('investment-transactions', [
      { title: t('investmentTransactions.pdfTitle'), headers, rows },
      summarySection,
    ]);
  }, [getExportData, getSummarySection, t]);

  const handleExportPdf = useCallback(async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    const { headers, rows } = getExportData(true);
    const accountLabel = selectedAccount
      ? mainAccountName(selectedAccount.name)
      : t('investmentTransactions.allAccounts');
    // Every figure here is the server's, over the whole filtered set. A partial
    // one is marked and captioned as a subtotal rather than printed as a total.
    const volumePartial = summary ? summary.fxComplete === false : false;
    const volumeText = summary
      ? `${fmtReportingMoney(volumePartial ? summary.knownSubtotal : (summary.total ?? summary.knownSubtotal))}${
          volumePartial ? ` ${tCommon('partialTotal.srSuffix')}` : ''
        }`
      : tCommon('unknownAmount.marker');
    // The server's count or nothing: the rows on screen are capped and filtered,
    // so their length under this caption would be a different measurement.
    const transactionCount = summary ? String(summary.transactionCount) : unknownKpi;
    // A withheld total is relabelled here too: the caption changes, rather than
    // a subtotal being printed under one that says "total".
    const volumeLabel = volumePartial
      ? t('investmentTransactions.knownVolume')
      : t('investmentTransactions.totalVolume');
    await exportToPdf({
      title: t('investmentTransactions.pdfTitle'),
      subtitle: `${accountLabel} | ${transactionCount} | ${volumeLabel}: ${volumeText}`,
      summaryCards: [
        { label: t('investmentTransactions.totalTransactions'), value: transactionCount, color: '#111827' },
        { label: volumeLabel, value: volumeText, color: '#111827' },
        { label: t('investmentTransactions.actionTypes'), value: summary ? String(actionSummaries.length) : unknownKpi, color: '#111827' },
        { label: t('investmentTransactions.securitiesTraded'), value: summary ? String(summary.securitiesTraded) : unknownKpi, color: '#111827' },
      ],
      tableData: { headers, rows },
      filename: 'investment-transactions',
    });
  }, [getExportData, selectedAccount, summary, unknownKpi, fmtReportingMoney, actionSummaries, t, tCommon, mainAccountName]);

  // A failed summary is a failed report, the way every sibling report treats a
  // secondary request that fails: one retryable error screen over the whole
  // thing. It is not a missing exchange rate, and the rows the client happens to
  // hold are not the answer to any of the four KPIs.
  if (error || summaryError) {
    return <ReportError onRetry={reloadAll} />;
  }

  // Neither request has an answer to show yet. The summary is gated here too:
  // without it the KPI block has nothing but markers, and a card reading the
  // capped client rows in its place is the defect this gate closes.
  if ((isLoading && response === null) || (isSummaryLoading && summary === null)) {
    return (
      <div className={`${CARD_CLASS} p-6`}>
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
        <div className={`${CARD_CLASS} ui-rep-tile p-4`}>
          <div className="text-sm text-gray-500 dark:text-gray-400">{t('investmentTransactions.totalTransactions')}</div>
          <div className="text-xl font-bold text-gray-900 dark:text-gray-100">
            {summary ? summary.transactionCount : unknownKpi}
          </div>
        </div>
        <div className={`${CARD_CLASS} ui-rep-tile p-4`}>
          <div className="text-sm text-gray-500 dark:text-gray-400">
            {summary && summary.fxComplete === false
              ? t('investmentTransactions.knownVolume')
              : t('investmentTransactions.totalVolume')}
          </div>
          <div className="text-xl font-bold text-gray-900 dark:text-gray-100">
            {/* A withheld total is relabelled, not left under a "Total" caption:
                the subtotal shows with the marker naming the pairs that stopped
                it. Until the server answers there is no figure at all -- and no
                cause to name either: a request that has not answered is not a
                missing exchange rate, so this is the bare marker rather than
                `UnknownAmount`, whose every reason would send the reader to a
                screen that can fix nothing. */}
            {summary ? (
              <PartialTotal total={asConvertedTotal(summary)} displayCurrency={summary.currencyCode}>
                {fmtReportingMoney(
                  summary.fxComplete === false
                    ? summary.knownSubtotal
                    : (summary.total ?? summary.knownSubtotal),
                )}
              </PartialTotal>
            ) : (
              unknownKpi
            )}
          </div>
        </div>
        <div className={`${CARD_CLASS} ui-rep-tile p-4`}>
          <div className="text-sm text-gray-500 dark:text-gray-400">{t('investmentTransactions.actionTypes')}</div>
          <div className="text-xl font-bold text-gray-900 dark:text-gray-100">
            {summary ? actionSummaries.length : unknownKpi}
          </div>
        </div>
        <div className={`${CARD_CLASS} ui-rep-tile p-4`}>
          <div className="text-sm text-gray-500 dark:text-gray-400">{t('investmentTransactions.securitiesTraded')}</div>
          <div className="text-xl font-bold text-gray-900 dark:text-gray-100">
            {summary ? summary.securitiesTraded : unknownKpi}
          </div>
        </div>
      </div>

      {/* Which rate answered. One sale used to read one figure here and another
          in the realized-gains report, with nothing on either saying why: these
          KPIs converted every row at the market rate on its trade date while
          the gains report multiplied by the rate the trade actually settled at.
          The row's own rate wins on both surfaces now, and this line says how
          many rows had none (INV-FX-002). */}
      {conversionNote && (
        <p className="text-xs text-gray-500 dark:text-gray-400">{conversionNote}</p>
      )}

      {/* Controls */}
      <div className={`${CARD_CLASS} p-4`}>
        {/* One control per line on a phone, the desktop row from `sm` up. The
            two pickers are `w-48` each: side by side they are wider than a
            phone, and the pair was pushed off the right of the screen rather
            than wrapped, because the box holding them did not wrap. */}
        <div className="flex flex-wrap gap-3 items-center">
          <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:items-center">
            <ReportAccountMultiSelect
              accounts={accounts}
              value={selectedAccountIds}
              onChange={setSelectedAccountIds}
              className="w-full sm:w-48"
            />
            <div className="w-full sm:w-48">
              <MultiSelect
                ariaLabel={t('investmentTransactions.filterByAction')}
                placeholder={t('investmentTransactions.allActionsPlaceholder')}
                showSearch={false}
                options={actionOptions}
                value={selectedActions}
                onChange={setSelectedActions}
              />
            </div>
          </div>
          <DateRangeSelector
            ranges={['6m', '1y', '2y', 'all']}
            value={dateRange}
            onChange={setDateRange}
          />
          <ReportToolbarActions
            onRefreshComplete={reloadAll}
            onExportCsv={handleExportCsv}
            onExportPdf={handleExportPdf}
            disabled={isLoading || isSummaryLoading || !!error || !!summaryError || filteredTransactions.length === 0}
          />
        </div>
      </div>

      {/* Action Summary */}
      {actionSummaries.length > 0 && (
        <div className={`${CARD_CLASS} p-6`}>
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
            {t('investmentTransactions.activitySummary')}
          </h3>
          <div className="flex flex-wrap gap-3">
            {actionSummaries.map((summary) => (
              <div
                key={summary.action}
                className="flex items-center gap-2 px-3 py-2 rounded-lg bg-gray-50 dark:bg-gray-700/50"
              >
                <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${ACTION_COLORS[summary.action]}`}>
                  {actionLabels[summary.action]}
                </span>
                <span className="text-sm text-gray-900 dark:text-gray-100 font-medium">
                  {summary.count}
                </span>
                <span className="text-sm text-gray-500 dark:text-gray-400">
                  (
                  <PartialTotal
                    total={asConvertedTotal(summary)}
                    displayCurrency={reportingCurrency}
                  >
                    {fmtReportingMoney(
                      summary.fxComplete === false
                        ? summary.knownSubtotal
                        : (summary.total ?? summary.knownSubtotal),
                    )}
                  </PartialTotal>
                  )
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Transaction List */}
      {filteredTransactions.length === 0 ? (
        <div className={`${CARD_CLASS} p-6`}>
          <EmptyState title={t('investmentTransactions.noTransactions')} />
        </div>
      ) : (
        <div className={`${CARD_CLASS} overflow-hidden`}>
          <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {t('investmentTransactions.transactionHistory', { count: filteredTransactions.length })}
            </h3>
            {/* The table is capped; the figures above are not. Saying so is what
                keeps a listing of part of the data from reading as all of it. */}
            {isTruncated && (
              <p className="mt-1 text-sm text-amber-600 dark:text-amber-400" data-testid="truncated-notice">
                {t('investmentTransactions.truncatedNotice', {
                  shown: filteredTransactions.length,
                })}
              </p>
            )}
            {/* Amounts in different currencies are not comparable numbers, so
                the money sorts group by currency and the reader is told. */}
            {sortsWithinCurrency && (sortField === 'price' || sortField === 'total') && (
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400" data-testid="sort-currency-notice">
                {t('investmentTransactions.sortWithinCurrency')}
              </p>
            )}
          </div>
          {/* Below `sm` the table becomes a block and each row wraps into a
              two-column grid of EQUAL `minmax(0,1fr)` tracks (for the reason
              `MONEY_CELL` measures), so all SEVEN columns fit a phone on FOUR
              lines, with no horizontal scroll for any amount inside the budget
              that constant states -- which is every ordinary figure and, in the
              doubled-ISO form a single foreign account produces, seven figures
              at 320px. Eight figures of that form is the one measured case
              where the scroll reopens (294px in a 288px wrapper), and the fix
              for it would be width, never a truncated amount:

                1  security (symbol + name) | total
                2  account                  | price
                3  action pill (both tracks)
                4  quantity                 | date

              Four lines because seven cells over two tracks cannot be fewer,
              and two tracks is what this box holds. Measured before: the table
              is 773-868px inside a 288px wrapper at 320px (and inside 358px at
              390px), so on a phone today the quantity, the price and the total
              -- the three figures the row is read for -- sit entirely behind a
              sideways scroll, the security name is squeezed to a 102-145px
              column that wraps a 40-character name to three lines, and the
              action pill wraps to 52-116px of its own, for a 93-141px row that
              is mostly invisible.

              THE ACCOUNT COLUMN IS THE ONE PLACE THIS CARD SHOWS MORE THAN THE
              TIER TABLE. Its header and its cell are `hidden md:table-cell`
              today, so no phone and no TABLET has ever seen it -- while
              `account` is one of the seven persisted sort fields, offered by a
              column header nobody below 768px can reach. Below `sm` the cell is
              a visible grid item; from `sm` up it resolves to exactly today's
              `hidden md:table-cell` (measured at 700px: still hidden, and the
              whole >= 640px rendering is pixel-identical to today), and the
              phone strip carries its sort chip. It reads as a DESCRIPTOR of the
              identity, so it takes the identity's track on line 2, and it KEEPS
              its caption -- an account name is not self-describing beside a
              ticker: `RRSP` under `VWCE.DE` could be read as either.

              The action pill is its OWN column, not a badge inside the identity
              cell, so it cannot join the security's line. It spans BOTH tracks
              on line 3, which is a measurement rather than a taste: across the
              20 locales that define these keys the longest label per locale
              runs 41-50 characters, topping out at `Reinwestycja
              krótkoterminowych zysków kapitałowych` (pl) and
              `Реінвестування короткострокового приросту капіталу` (uk), and in
              one 122px track
              they stack 52-116px tall against 36px across the pair -- 235px
              rows instead of 251-283px at 320px, in every locale. Spanning also
              fills what would otherwise be an empty grid slot, and it lets
              Quantity take the left track on line 4, where the widest caption
              with no break opportunity in the catalogue (`Количество`, ru,
              73px) degrades into the 12px column gap rather than into the
              wrapper's scroll. It carries no caption, being self-describing.

              Rule 3's phone-only `max-sm:inline-block max-sm:max-w-full` on the
              pill is deliberately NOT applied here, and the control says why:
              that rule is about an INLINE pill splitting into two ragged
              background fragments, and this pill's own base classes make it
              `inline-flex` -- an atomic inline-level box that cannot split.
              Measured on the replica at 320px in `ru` and `pl`: one fragment
              with the phone-only pair, one fragment with it removed, and two
              only when the pill is forced to plain `inline`. `max-w-full` would
              be equally inert: the spanning cell gives the pill 256px at 320px
              against a 174px longest word (`Langetermijnkapitaalwinst`, nl).
              The `<td>` still carries `min-w-0`, which is the containment that
              does bind on a grid item.

              Neither text column is clamped -- a clamp would cut the tail of a
              name no other surface shows in full -- and containment does not
              need one: each sits in a `minmax(0,1fr)` track with `min-w-0`, and
              `break-words` breaks a word too long for the track.
              `sm:break-normal` hands today's wrapping back from `sm` up.

              All 100 catalogue strings for the five captioned columns -- the 20
              locales that DEFINE these keys, the pseudo-locale included; the two
              lean regional variants (`en-GB`, `en-US`) inherit `en`'s strings
              per key -- were rendered into the 122px a track gets at 320px, at
              `CellLabel`'s own type. NONE overflows and NONE needs a second
              line, in either track, at either width: the widest is
              `[XX-Quantity-XX]` at 95px, which breaks at its hyphens anyway.

              Measured cost at 320px, with a 40-character security name, a
              39-character account name, the longest action label and the
              seven-figure doubled-ISO worst case in every figure cell: a 235px
              row against the 125px the same content measures on the 800px
              desktop row -- but that 125px is reached only by hiding the account
              entirely and pushing three columns behind the scroll, and the same
              row is already 93-141px and unreadable today. No FIGURE cell
              exceeds one caption line plus one value line (29px) in any locale;
              the two cells above that are the security (68px) and the account
              (61px), the two unbounded text columns, by design.

              From `sm` up it is the ordinary table. A Chromium replica renders
              it pixel-identically to today at 700px AND 800px in
              `pl`/`ru`/`id`/`de`/`xx` once the one deliberate difference is
              neutralised -- `whitespace-nowrap` on the three figure cells, for
              the reason `MONEY_CELL` gives.

              Two costs of restyling one tree, both deliberate. Changing the
              display roles drops the table semantics below `sm`, which is why
              the roles are restated explicitly and every bare figure and date
              carries a `CellLabel` naming its column -- the symbol, its name and
              the pill need none, being words that describe themselves. And the
              phone reading order differs from the DOM order, which is the
              desktop column order the grid placement overrides visually. Both
              are properties of the mechanism, not of this table. */}
          <div className="overflow-x-auto">
            <table role="table" className="block min-w-full divide-y divide-gray-200 dark:divide-gray-700 sm:table">
              <thead role="rowgroup" className="block bg-gray-50 dark:bg-gray-900/50 sm:table-header-group">
                {/* Phone sort strip: the same seven controls, wrapped. */}
                <tr role="row" className="flex flex-wrap gap-x-2 gap-y-1 px-4 py-2 sm:hidden">
                  {sortColumns.map((col) => (
                    <SortableHeader<InvestmentTxSortField>
                      key={col.field}
                      field={col.field}
                      sortField={sortField}
                      sortDirection={sortDirection}
                      onSort={handleSort}
                      className={PHONE_HEADER_CLASS}
                    >
                      {col.label}
                    </SortableHeader>
                  ))}
                </tr>
                <tr role="row" className="hidden sm:table-row">
                  {sortColumns.map((col) => (
                    <SortableHeader<InvestmentTxSortField>
                      key={col.field}
                      field={col.field}
                      sortField={sortField}
                      sortDirection={sortDirection}
                      onSort={handleSort}
                      align={col.align}
                      className={col.headerClass ? `${TH_CLASS} ${col.headerClass}` : TH_CLASS}
                    >
                      {col.label}
                    </SortableHeader>
                  ))}
                </tr>
              </thead>
              <tbody role="rowgroup" className="block divide-y divide-gray-200 dark:divide-gray-700 sm:table-row-group">
                {sortedTransactions.map((tx) => (
                  <tr
                    key={tx.id}
                    role="row"
                    className="grid grid-cols-2 items-start gap-x-3 gap-y-1.5 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-700/50 sm:table-row"
                  >
                    <td
                      role="cell"
                      className={`col-start-2 row-start-4 text-gray-900 dark:text-gray-100 ${DATE_CELL}`}
                    >
                      <CellLabel className={CAPTION_CLASS}>{columns.date.label}</CellLabel>
                      {formatDate(tx.transactionDate)}
                    </td>
                    <td
                      role="cell"
                      className="col-start-1 col-span-2 row-start-3 min-w-0 p-0 sm:table-cell sm:px-4 sm:py-3"
                    >
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${ACTION_COLORS[tx.action]}`}>
                        {actionLabels[tx.action]}
                      </span>
                    </td>
                    <td
                      role="cell"
                      className="col-start-1 row-start-1 min-w-0 break-words p-0 sm:table-cell sm:break-normal sm:px-4 sm:py-3"
                    >
                      <div className="font-medium text-sm text-gray-900 dark:text-gray-100">
                        {tx.security?.symbol || '-'}
                      </div>
                      {tx.security?.name && (
                        <div className="text-xs text-gray-500 dark:text-gray-400">
                          {tx.security.name}
                        </div>
                      )}
                    </td>
                    {/* The one cell the card shows and the tier table does not:
                        below `sm` a visible grid item, from `sm` up exactly
                        today's `hidden md:table-cell`. */}
                    <td
                      role="cell"
                      className={`col-start-1 row-start-2 min-w-0 break-words p-0 text-xs text-gray-500 dark:text-gray-400 sm:break-normal sm:px-4 sm:py-3 sm:text-sm ${columns.account.cellClass ?? ''}`}
                    >
                      <CellLabel className={CAPTION_CLASS}>{columns.account.label}</CellLabel>
                      {accountNameMap.get(tx.accountId) || '-'}
                    </td>
                    <td
                      role="cell"
                      className={`col-start-1 row-start-4 text-gray-900 dark:text-gray-100 ${MONEY_CELL}`}
                    >
                      <CellLabel className={CAPTION_CLASS}>{columns.quantity.label}</CellLabel>
                      {tx.quantity != null ? formatShareQuantity(Math.abs(Number(tx.quantity))) : '-'}
                    </td>
                    <td
                      role="cell"
                      className={`col-start-2 row-start-2 text-gray-900 dark:text-gray-100 ${MONEY_CELL}`}
                    >
                      <CellLabel className={CAPTION_CLASS}>{columns.price.label}</CellLabel>
                      {tx.price == null
                        ? '-'
                        : (fmtRowMoney(tx.price, rowPriceCurrency(tx)) ?? (
                            <UnknownAmount reason="unknownCurrency" />
                          ))}
                    </td>
                    {/* The total takes the right of line 1 beside the security:
                        it is the figure the row is read for. */}
                    <td
                      role="cell"
                      className={`col-start-2 row-start-1 font-medium text-gray-900 dark:text-gray-100 ${MONEY_CELL}`}
                    >
                      <CellLabel className={CAPTION_CLASS}>{columns.total.label}</CellLabel>
                      {fmtRowMoney(Math.abs(tx.totalAmount), rowAmountCurrency(tx)) ?? (
                        <UnknownAmount reason="unknownCurrency" />
                      )}
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
