'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { Skeleton } from '@/components/ui/LoadingSkeleton';
import { format } from 'date-fns';
import { investmentsApi } from '@/lib/investments';
import { InvestmentTransaction, InvestmentAction } from '@/types/investment';
import { Account } from '@/types/account';
import { parseLocalDate } from '@/lib/utils';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { useDateRange } from '@/hooks/useDateRange';
import { useReportData } from '@/hooks/useReportData';
import { usePersistedAccountFilter } from '@/hooks/usePersistedAccountFilter';
import { DateRangeSelector } from '@/components/ui/DateRangeSelector';
import { ExportDropdown } from '@/components/ui/ExportDropdown';
import { MultiSelect } from '@/components/ui/MultiSelect';
import { ReportAccountMultiSelect } from '@/components/reports/ReportAccountMultiSelect';
import { RefreshPricesButton } from '@/components/reports/RefreshPricesButton';
import { ReportError } from '@/components/reports/ReportError';
import { exportToCsv } from '@/lib/csv-export';
import { SortableHeader } from '@/components/ui/SortableHeader';
import { CellLabel } from '@/components/ui/Table';
import { PartialTotal } from '@/components/ui/PartialTotal';
import { useSortableTable, compareValues } from '@/hooks/useSortableTable';
import { createLogger } from '@/lib/logger';
import { useTranslations } from 'next-intl';
import { useMainAccountName } from '@/hooks/useMainAccountName';
import {
  ACTION_COLORS,
  CAPTION_CLASS,
  DATE_CELL,
  HEADER_CLASS,
  MONEY_CELL,
  PHONE_HEADER_CLASS,
  type InvestmentTxSortField,
  type SortColumn,
  type SortColumnsByField,
} from '@/components/reports/InvestmentTransactionHistoryReportParts';

const logger = createLogger('InvestmentTransactionHistoryReport');

const MAX_PAGES = 50;

interface ActionSummary {
  action: InvestmentAction;
  count: number;
  totalAmount: number;
  missingCurrencies: string[];
  excludedCount: number;
}

const ACCOUNTS_STORAGE_KEY = 'monize-reports-investment-transactions-accounts';

export function InvestmentTransactionHistoryReport() {
  const t = useTranslations('reports');
  const tCommon = useTranslations('common');
  const mainAccountName = useMainAccountName();
  const { formatCurrency: formatCurrencyFull } = useNumberFormat();
  const { defaultCurrency, convertToDefault } = useExchangeRates();
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

  const accountCurrencyMap = useMemo(() => {
    const map = new Map<string, string>();
    accounts.forEach((a) => map.set(a.id, a.currencyCode));
    return map;
  }, [accounts]);

  const selectedAccount = isSingleAccount
    ? accounts.find((a) => a.id === selectedAccountIds[0])
    : undefined;
  const displayCurrency = selectedAccount?.currencyCode || defaultCurrency;
  const isForeign = displayCurrency !== defaultCurrency;

  const getTxAmount = useCallback((tx: InvestmentTransaction): number | null => {
    const amount = Math.abs(tx.totalAmount);
    if (isSingleAccount) return amount;
    const txCurrency = accountCurrencyMap.get(tx.accountId) || defaultCurrency;
    return convertToDefault(amount, txCurrency);
  }, [isSingleAccount, accountCurrencyMap, defaultCurrency, convertToDefault]);

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

  const { data: response, isLoading, error, reload } = useReportData(
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
      return allTransactions;
    },
    [selectedAccountIds, rangeStart, rangeEnd, isValid],
  );

  // Only the first load shows the full skeleton. Later reloads (e.g. changing
  // the account filter) keep the existing content -- and the account dropdown --
  // mounted so they update in place instead of unmounting the whole report.
  const transactions = useMemo<InvestmentTransaction[]>(() => response ?? [], [response]);

  // Action filtering happens client-side so toggling actions never re-fetches.
  const filteredTransactions = useMemo(() => {
    if (selectedActions.length === 0) return transactions;
    const set = new Set(selectedActions);
    return transactions.filter((tx) => set.has(tx.action));
  }, [transactions, selectedActions]);

  const actionSummaries = useMemo((): ActionSummary[] => {
    const map = new Map<InvestmentAction, ActionSummary>();

    filteredTransactions.forEach((tx) => {
      let entry = map.get(tx.action);
      if (!entry) {
        entry = { action: tx.action, count: 0, totalAmount: 0, missingCurrencies: [], excludedCount: 0 };
        map.set(tx.action, entry);
      }
      entry.count += 1;
      const amount = getTxAmount(tx);
      // The row is still counted -- the transaction happened -- but an
      // unconvertible amount does not join a total in another currency; its
      // currency is named so the action's volume reads as a subtotal.
      if (amount !== null) {
        entry.totalAmount += amount;
      } else {
        const currency = accountCurrencyMap.get(tx.accountId) || defaultCurrency;
        if (!entry.missingCurrencies.includes(currency)) entry.missingCurrencies.push(currency);
        entry.excludedCount += 1;
      }
    });

    return Array.from(map.values()).sort((a, b) => b.totalAmount - a.totalAmount);
  }, [filteredTransactions, getTxAmount, accountCurrencyMap, defaultCurrency]);

  const totalAmount = useMemo(
    () =>
      filteredTransactions.reduce((sum, tx) => {
        const amount = getTxAmount(tx);
        return amount === null ? sum : sum + amount;
      }, 0),
    [filteredTransactions, getTxAmount],
  );

  // Transactions counted but left out of the volume total because their currency
  // has no rate, so the total volume is a subtotal whenever this is non-empty.
  const volumeGaps = useMemo(() => {
    const missing = new Set<string>();
    let excludedCount = 0;
    for (const tx of filteredTransactions) {
      if (getTxAmount(tx) === null) {
        missing.add(accountCurrencyMap.get(tx.accountId) || defaultCurrency);
        excludedCount += 1;
      }
    }
    return { missingCurrencies: [...missing], excludedCount };
  }, [filteredTransactions, getTxAmount, accountCurrencyMap, defaultCurrency]);

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
        case 'price':
          comparison = compareValues(a.price, b.price);
          break;
        case 'total':
          comparison = compareValues(getTxAmount(a), getTxAmount(b));
          break;
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });
    return sorted;
  }, [filteredTransactions, sortField, sortDirection, accountNameMap, getTxAmount]);

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
      csvValue: (tx) => (tx.quantity != null ? Math.abs(tx.quantity) : ''),
    },
    price: {
      field: 'price',
      label: t('investmentTransactions.colPrice'),
      align: 'right',
      csvValue: (tx, formatted) =>
        tx.price != null ? (formatted ? fmtValue(tx.price) : tx.price) : '',
    },
    total: {
      field: 'total',
      label: t('investmentTransactions.colTotal'),
      align: 'right',
      csvValue: (tx, formatted) =>
        formatted ? fmtValue(Math.abs(tx.totalAmount)) : Math.abs(tx.totalAmount),
    },
  }), [t, actionLabels, accountNameMap, fmtValue]);

  // Their order, rendered by BOTH header rows, matched by the cells' DOM order
  // and by the export's columns. DERIVED from the record rather than re-listed:
  // a hand-written list beside an exhaustive record is not exhaustive, so a
  // field added to the union would compile and still ship with no sort control
  // in either header. The record's declaration order is the column order.
  const sortColumns: readonly SortColumn[] = useMemo(() => Object.values(columns), [columns]);

  const getExportData = useCallback((formatted: boolean) => {
    // Both halves from the one ordered record: the headings from each column's
    // label and the cells from its own `csvValue`, so a reorder cannot put a
    // heading over another column's figures.
    const headers = sortColumns.map((col) => col.label);
    const rows: (string | number)[][] = sortedTransactions.map((tx) =>
      sortColumns.map((col) => col.csvValue(tx, formatted)),
    );
    return { headers, rows };
  }, [sortedTransactions, sortColumns]);

  const handleExportCsv = useCallback(() => {
    const { headers, rows } = getExportData(false);
    exportToCsv('investment-transactions', headers, rows);
  }, [getExportData]);

  const handleExportPdf = useCallback(async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    const { headers, rows } = getExportData(true);
    const accountLabel = selectedAccount
      ? mainAccountName(selectedAccount.name)
      : t('investmentTransactions.allAccounts');
    const uniqueSecurities = new Set(filteredTransactions.filter((tx) => tx.security).map((tx) => tx.security!.symbol)).size;
    // A transaction with no rate is counted but left out of the volume, so the
    // PDF marks it partial rather than printing a subtotal as the whole.
    const volumeSuffix = volumeGaps.excludedCount > 0 ? ` ${tCommon('partialTotal.srSuffix')}` : '';
    await exportToPdf({
      title: t('investmentTransactions.pdfTitle'),
      subtitle: `${accountLabel} | ${filteredTransactions.length} transactions | Total volume: ${fmtValue(totalAmount)}${volumeSuffix}`,
      summaryCards: [
        { label: t('investmentTransactions.totalTransactions'), value: String(filteredTransactions.length), color: '#111827' },
        { label: t('investmentTransactions.totalVolume'), value: `${fmtValue(totalAmount)}${volumeSuffix}`, color: '#111827' },
        { label: t('investmentTransactions.actionTypes'), value: String(actionSummaries.length), color: '#111827' },
        { label: t('investmentTransactions.securitiesTraded'), value: String(uniqueSecurities), color: '#111827' },
      ],
      tableData: { headers, rows },
      filename: 'investment-transactions',
    });
  }, [getExportData, selectedAccount, filteredTransactions, fmtValue, totalAmount, actionSummaries, t, tCommon, volumeGaps.excludedCount, mainAccountName]);

  if (error) {
    return <ReportError onRetry={reload} />;
  }

  if (isLoading && response === null) {
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
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">{t('investmentTransactions.totalTransactions')}</div>
          <div className="text-xl font-bold text-gray-900 dark:text-gray-100">
            {filteredTransactions.length}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">{t('investmentTransactions.totalVolume')}</div>
          <div className="text-xl font-bold text-gray-900 dark:text-gray-100">
            <PartialTotal total={{ value: totalAmount, ...volumeGaps }} displayCurrency={displayCurrency}>
              {fmtValue(totalAmount)}
            </PartialTotal>
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">{t('investmentTransactions.actionTypes')}</div>
          <div className="text-xl font-bold text-gray-900 dark:text-gray-100">
            {actionSummaries.length}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">{t('investmentTransactions.securitiesTraded')}</div>
          <div className="text-xl font-bold text-gray-900 dark:text-gray-100">
            {new Set(filteredTransactions.filter((tx) => tx.security).map((tx) => tx.security!.symbol)).size}
          </div>
        </div>
      </div>

      {/* Controls */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex flex-wrap gap-3 items-center">
          <div className="flex gap-3 items-center">
            <ReportAccountMultiSelect
              accounts={accounts}
              value={selectedAccountIds}
              onChange={setSelectedAccountIds}
            />
            <div className="w-48">
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
          <div className="ml-auto shrink-0 flex gap-2 items-center">
            <RefreshPricesButton onRefreshComplete={reload} />
            <ExportDropdown onExportCsv={handleExportCsv} onExportPdf={handleExportPdf} disabled={filteredTransactions.length === 0} />
          </div>
        </div>
      </div>

      {/* Action Summary */}
      {actionSummaries.length > 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
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
                    total={{ value: summary.totalAmount, missingCurrencies: summary.missingCurrencies, excludedCount: summary.excludedCount }}
                    displayCurrency={displayCurrency}
                  >
                    {fmtValue(summary.totalAmount)}
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
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <p className="text-gray-500 dark:text-gray-400 text-center py-8">
            {t('investmentTransactions.noTransactions')}
          </p>
        </div>
      ) : (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {t('investmentTransactions.transactionHistory', { count: filteredTransactions.length })}
            </h3>
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
                      className={col.headerClass ? `${HEADER_CLASS} ${col.headerClass}` : HEADER_CLASS}
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
                      {format(parseLocalDate(tx.transactionDate), 'MMM d, yyyy')}
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
                      {tx.quantity != null ? Math.abs(tx.quantity).toFixed(4) : '-'}
                    </td>
                    <td
                      role="cell"
                      className={`col-start-2 row-start-2 text-gray-900 dark:text-gray-100 ${MONEY_CELL}`}
                    >
                      <CellLabel className={CAPTION_CLASS}>{columns.price.label}</CellLabel>
                      {tx.price != null ? fmtValue(tx.price) : '-'}
                    </td>
                    {/* The total takes the right of line 1 beside the security:
                        it is the figure the row is read for. */}
                    <td
                      role="cell"
                      className={`col-start-2 row-start-1 font-medium text-gray-900 dark:text-gray-100 ${MONEY_CELL}`}
                    >
                      <CellLabel className={CAPTION_CLASS}>{columns.total.label}</CellLabel>
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
