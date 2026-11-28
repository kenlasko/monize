'use client';

import { CARD_CLASS } from '@/components/ui/Card';
import { useState, useMemo, useCallback, memo } from 'react';
import { useTranslations } from 'next-intl';
import { AccountHoldings, HoldingWithMarketValue } from '@/types/investment';
import { ChevronDownIcon, ChevronRightIcon } from '@heroicons/react/24/outline';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { gainLossColor } from '@/lib/format';
import { PartialTotal } from '@/components/ui/PartialTotal';
import { portfolioPartialTotal } from '@/lib/net-worth-completeness';
import { Skeleton } from '@/components/ui/LoadingSkeleton';
import {
  CAPTION_CLASS,
  CellLabel,
  PHONE_HEADER_CLASS,
  type SortColumn as TableSortColumn,
  type SortColumnsByField as TableSortColumnsByField,
} from '@/components/ui/Table';
import { SortableHeader } from '@/components/ui/SortableHeader';
import { useSortableTable } from '@/hooks/useSortableTable';
import { ColumnChooserMenu, type ColumnChooserItem } from '@/components/ui/ColumnChooserMenu';
import { useHiddenColumns } from '@/hooks/useHiddenColumns';
import { useColumnHeaderActions } from '@/hooks/useColumnHeaderActions';
import {
  holdingsPhonePlacement,
  type HoldingsColumn,
  type HoldingsPhonePlacement,
} from '@/lib/holdings-phone-grid';
import {
  DEFAULT_HOLDINGS_SORT,
  holdingGainLossInAccountCurrency,
  holdingMarketValueInAccountCurrency,
  holdingMarketValueInDefaultCurrency,
  resolveHoldingsSort,
  sortAccountsByName,
  sortHoldings,
  type HoldingsSortField,
} from '@/lib/holdings-sort';

// A wrapped figure cell: no padding on phones (the card's grid spaces the
// cells), the table cell's own padding and right alignment from `sm` up. The
// figures never wrap, so a locale grouping thousands with a space keeps each on
// one line; the per-row caption gives itself back `whitespace-normal`.
const FIGURE_CELL =
  'p-0 text-right text-xs whitespace-nowrap sm:table-cell sm:px-4 sm:py-3 sm:text-sm';

// The column header cells from `sm` up: Symbol on the left, the figures right.
const SYMBOL_HEADER_CLASS =
  'px-2 sm:px-6 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider';
const FIGURE_HEADER_CLASS =
  'px-1.5 sm:px-4 py-2 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider';

/**
 * One column of the holdings table, declared once over the sort field union
 * and rendered by BOTH header rows -- the column header row from `sm` up and
 * the phone sort strip -- so a new column cannot ship with no control in
 * either, and each entry must name its own key.
 */
type SortColumn = TableSortColumn<HoldingsSortField, 'right'>;
type SortColumnsByField = TableSortColumnsByField<HoldingsSortField, SortColumn>;

interface GroupedHoldingsListProps {
  holdingsByAccount: AccountHoldings[];
  isLoading: boolean;
  /**
   * The portfolio's value, or `null` while it is not known: no summary yet, a failed
   * one, or a total the server withheld because a price or rate is missing. A share of
   * a known subtotal is not a share of the portfolio, so "% Port" reads unknown then.
   */
  totalPortfolioValue: number | null;
  /**
   * Required: the symbol and the cash row render as links whatever is passed,
   * so a caller that left these out drew links that did nothing (issue #2255).
   */
  onSecurityClick: (securityId: string) => void;
  onCashClick: (cashAccountId: string) => void;
}

export function GroupedHoldingsList({
  holdingsByAccount,
  isLoading,
  totalPortfolioValue,
  onSecurityClick,
  onCashClick,
}: GroupedHoldingsListProps) {
  const t = useTranslations('investments');
  const { formatCurrency: formatCurrencyBase, formatCurrencyPrecise, formatSignedPercent, formatPercent: formatPlainPercent, formatQuantity } = useNumberFormat();
  const { getRate, defaultCurrency } = useExchangeRates();

  // The stored `investmentHoldings` set (one per table kind), so the
  // Investments page and the investment detail view follow the same choice. A
  // hidden column is absent from the DOM at every width, the phone card
  // included, never hidden by a class.
  const {
    hidden: hiddenColumns,
    isVisible,
    hide: hideColumn,
    show: showColumn,
    showAll: showAllColumns,
    hideable,
  } = useHiddenColumns('investmentHoldings');
  // Exhaustive over the sort field union; its declaration order is the
  // column order, and the labels are also the phone captions.
  const columns = useMemo<SortColumnsByField>(
    () => ({
      symbol: { field: 'symbol', label: t('groupedHoldings.symbolColumn') },
      shares: { field: 'shares', label: t('groupedHoldings.sharesColumn'), align: 'right' },
      avgCost: { field: 'avgCost', label: t('groupedHoldings.avgCostColumn'), align: 'right' },
      price: { field: 'price', label: t('groupedHoldings.priceColumn'), align: 'right' },
      costBasis: { field: 'costBasis', label: t('groupedHoldings.costBasisColumn'), align: 'right' },
      mktValue: { field: 'mktValue', label: t('groupedHoldings.mktValueColumn'), align: 'right' },
      gainLoss: { field: 'gainLoss', label: t('groupedHoldings.gainLossColumn'), align: 'right' },
      portfolioPercent: {
        field: 'portfolioPercent',
        label: t('groupedHoldings.portfolioPercentColumn'),
        align: 'right',
      },
    }),
    [t],
  );
  const hideableColumns = useMemo<ColumnChooserItem<HoldingsColumn>[]>(
    () => hideable.map((id) => ({ id, label: columns[id].label })),
    [hideable, columns],
  );
  // A hidden column has no header at any width and no chip on a phone.
  const visibleColumns = Object.values(columns).filter(
    (col) => col.field === 'symbol' || isVisible(col.field),
  );

  // Every column sorts, largest position first by default. The stored choice
  // is this browser's; the applied one falls back while its column is hidden.
  const { sortField, sortDirection, setSort } = useSortableTable<HoldingsSortField>(
    'investments.holdings.sort',
    DEFAULT_HOLDINGS_SORT,
  );
  const sort = resolveHoldingsSort({ field: sortField, direction: sortDirection }, hiddenColumns);
  // Toggles against the sort on screen rather than the stored one, so a click
  // on the column the fallback chose reverses what the reader sees.
  const handleSort = useCallback(
    (field: HoldingsSortField) =>
      setSort(
        sort.field === field
          ? { field, direction: sort.direction === 'asc' ? 'desc' : 'asc' }
          : { field, direction: 'asc' },
      ),
    [setSort, sort.field, sort.direction],
  );

  // A plain click on a figure header sorts; a long-press or right-click opens
  // the "Hide column" sheet. Symbol is structural, so it sorts on its own click.
  const { headerHandlers, sheet: columnHeaderSheet } = useColumnHeaderActions({
    columns: hideableColumns,
    onHide: hideColumn,
    onHeaderClick: handleSort,
  });

  const sortedAccounts = useMemo(
    () => sortAccountsByName(holdingsByAccount),
    [holdingsByAccount],
  );
  // Where each visible figure sits in a row's phone card; a reference stable
  // while the set is, so the memoised holding row is not re-rendered by it.
  const placement = useMemo(() => holdingsPhonePlacement(hiddenColumns), [hiddenColumns]);
  // The account-total label spans Symbol and the per-share columns, which have
  // no account figure, so it narrows as they are hidden.
  const totalLabelSpan =
    1 + (['shares', 'avgCost', 'price'] as const).filter((id) => isVisible(id)).length;

  const [expandedAccounts, setExpandedAccounts] = useState<Set<string>>(
    new Set(holdingsByAccount.map((a) => a.accountId)),
  );

  const toggleAccount = (accountId: string) => {
    setExpandedAccounts((prev) => {
      const next = new Set(prev);
      if (next.has(accountId)) {
        next.delete(accountId);
      } else {
        next.add(accountId);
      }
      return next;
    });
  };

  const formatMoney = (value: number | null) => {
    if (value === null) return '-';
    return formatCurrencyBase(value);
  };

  const formatPrice = (value: number | null, currencyCode?: string) => {
    if (value === null) return '-';
    // Per-share prices display at 4dp, expanding further only when a sub-penny
    // value would otherwise read as 0.0000.
    return formatCurrencyPrecise(value, currencyCode, 4);
  };

  const formatPercent = (value: number | null, showSign = true) => {
    if (value === null) return '-';
    // Unsigned goes through the hook's percent formatter rather than a
    // hand-concatenated '%': the symbol's placement and spacing are the
    // locale's to decide (fr-FR writes "12,30 %").
    return showSign ? formatSignedPercent(value) : formatPlainPercent(value, 2);
  };

  const getGainLossColor = (value: number | null) => {
    if (value === null) return 'text-gray-500 dark:text-gray-400';
    return gainLossColor(value);
  };

  // A share of a known subtotal is not a share of the portfolio, and a value
  // whose pair has no rate cannot join the numerator: both read unknown ('-')
  // rather than a definitive-looking percentage of the wrong denominator
  // (review #1133). getRate returns null for an unresolved pair, so the missing
  // conversion surfaces here rather than being silently dropped.
  const getPortfolioPercent = (value: number | null, currencyCode?: string): string => {
    if (value === null || totalPortfolioValue === null || totalPortfolioValue === 0) return '-';
    let converted = value;
    if (currencyCode && currencyCode !== defaultCurrency) {
      const rate = getRate(currencyCode, defaultCurrency);
      if (rate === null) return '-';
      converted = value * rate;
    }
    return formatPlainPercent((converted / totalPortfolioValue) * 100, 1);
  };

  // The "~ default currency" approximation under an account's total: unknown --
  // and unrendered -- when the pair has no rate (getRate returns null) or when
  // the account's own valuation is incomplete (the total being approximated is a
  // subtotal the marker beside it just called partial). The summary card
  // suppresses its ~ line the same way.
  const accountDefaultApprox = (
    account: AccountHoldings,
    accountTotalValue: number,
  ): number | null => {
    if (account.valuationComplete === false) return null;
    const rate = getRate(account.currencyCode, defaultCurrency);
    if (rate === null) return null;
    return accountTotalValue * rate;
  };

  if (isLoading) {
    return (
      <div className={`${CARD_CLASS} p-3 sm:p-6`}>
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          {t('groupedHoldings.title')}
        </h3>
        <div className="space-y-4">
          {[1, 2].map((i) => (
            <div key={i}>
              <Skeleton className="h-6 w-1/3 mb-3" />
              <div className="space-y-2">
                {[1, 2, 3].map((j) => (
                  <div key={j} className="flex justify-between">
                    <Skeleton className="h-4 w-1/4" />
                    <Skeleton className="h-4 w-1/4" />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  const totalHoldings = holdingsByAccount.reduce(
    (sum, a) => sum + a.holdings.length,
    0,
  );

  const hasCash = holdingsByAccount.some((a) => a.cashBalance !== 0);

  if (totalHoldings === 0 && !hasCash) {
    return (
      <div className={`${CARD_CLASS} p-3 sm:p-6`}>
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          {t('groupedHoldings.title')}
        </h3>
        <p className="text-gray-500 dark:text-gray-400">
          {t('groupedHoldings.noHoldings')}
        </p>
      </div>
    );
  }

  return (
    <div className={`${CARD_CLASS} overflow-hidden`}>
      <div className="p-3 sm:p-6 pb-3 sm:pb-4 border-b border-gray-200 dark:border-gray-700">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {t('groupedHoldings.title')}
            </h3>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
              {t('groupedHoldings.accountSummary', { accounts: holdingsByAccount.length, accountsPlural: holdingsByAccount.length !== 1 ? 's' : '', positions: totalHoldings, positionsPlural: totalHoldings !== 1 ? 's' : '' })}
            </p>
          </div>
          <ColumnChooserMenu
            columns={hideableColumns}
            hidden={hiddenColumns}
            onHide={hideColumn}
            onShow={showColumn}
            onShowAll={showAllColumns}
          />
        </div>
      </div>

      <div className="divide-y divide-gray-200 dark:divide-gray-700">
        {sortedAccounts.map((account) => {
          const isExpanded = expandedAccounts.has(account.accountId);
          const accountTotalValue = account.totalMarketValue + account.cashBalance;
          const acctDisplayCurrency = account.currencyCode !== defaultCurrency
            ? account.currencyCode
            : null;
          const defaultApprox = acctDisplayCurrency
            ? accountDefaultApprox(account, accountTotalValue)
            : null;
          // The account's gain is over the holdings that have a value, so it is
          // a partial figure whenever this account's own valuation is (A26-M38).
          const accountGainPartial = portfolioPartialTotal(account.totalGainLoss, account);
          const accountGainIsPartial = accountGainPartial.excludedCount > 0;
          const fmtAcct = (value: number | null) => {
            if (value === null) return '-';
            if (acctDisplayCurrency) return `${formatCurrencyBase(value, acctDisplayCurrency)} ${acctDisplayCurrency}`;
            return formatMoney(value);
          };

          return (
            <div key={account.accountId}>
              {/* Account Header */}
              <button
                onClick={() => toggleAccount(account.accountId)}
                className="ui-acct-head w-full px-3 sm:px-6 py-3 sm:py-4 flex items-center justify-between hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors"
              >
                <div className="flex items-center gap-3" data-initial={account.accountName.trim().slice(0, 2)}>
                  {isExpanded ? (
                    <ChevronDownIcon className="h-5 w-5 text-gray-400" />
                  ) : (
                    <ChevronRightIcon className="h-5 w-5 text-gray-400" />
                  )}
                  <div className="text-left">
                    <div className="font-semibold text-gray-900 dark:text-gray-100">
                      {account.accountName}
                    </div>
                    <div className="text-sm text-gray-500 dark:text-gray-400">
                      {account.cashBalance !== 0
                        ? t('groupedHoldings.positionsWithCash', { count: account.holdings.length, plural: account.holdings.length !== 1 ? 's' : '' })
                        : t('groupedHoldings.positions', { count: account.holdings.length, plural: account.holdings.length !== 1 ? 's' : '' })}
                    </div>
                    {/* This account's totals are in its OWN currency, a different
                        conversion from the portfolio's, so the global state cannot
                        speak for them (recheck RR4-002 / RR3-005). */}
                    {account.valuationComplete === false && (
                      <div className="text-xs text-amber-700 dark:text-amber-300">
                        {t('groupedHoldings.accountIncomplete', {
                          currency: account.currencyCode,
                        })}
                      </div>
                    )}
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-semibold text-gray-900 dark:text-gray-100">
                    {fmtAcct(accountTotalValue)}
                  </div>
                  {defaultApprox !== null && (
                    <div className="text-xs text-gray-400 dark:text-gray-500">
                      {'\u2248 '}{formatCurrencyBase(defaultApprox, defaultCurrency)} {defaultCurrency}
                    </div>
                  )}
                  <div data-sign={signOf(account.totalGainLoss)} className={`ui-gain text-sm ${getGainLossColor(account.totalGainLoss)}`}>
                    <PartialTotal total={accountGainPartial} displayCurrency={account.currencyCode}>
                      {fmtAcct(account.totalGainLoss)} ({formatPercent(account.totalGainLossPercent)})
                    </PartialTotal>
                  </div>
                  {accountGainIsPartial && (
                    <div className="text-xs text-amber-700 dark:text-amber-300">
                      {t('groupedHoldings.gainPartialCaption')}
                    </div>
                  )}
                </div>
              </button>

              {/* Account Holdings Table. Below `sm` the table becomes a block
                  and each row wraps into a grid card so its figures fit a
                  phone without a horizontal scroll (placed by
                  `holdingsPhonePlacement`, so a hidden column leaves no gap);
                  from `sm` up it is the ordinary table. Explicit roles put back the table semantics
                  that restyling `display` strips (inert from `sm` up). */}
              {isExpanded && (
                <div className="overflow-x-auto">
                  <table role="table" className="block min-w-full sm:table">
                    <thead role="rowgroup" className="block bg-gray-50 dark:bg-gray-700/50 sm:table-header-group">
                      {/* Phone sort strip: the column header row is hidden
                          below `sm`, so its sort controls come back here as
                          chips, one per visible column. */}
                      <tr role="row" className="flex flex-wrap gap-x-2 gap-y-1 px-2 py-2 sm:hidden">
                        {visibleColumns.map((col) => (
                          <SortableHeader<HoldingsSortField>
                            key={col.field}
                            field={col.field}
                            sortField={sort.field}
                            sortDirection={sort.direction}
                            onSort={handleSort}
                            className={PHONE_HEADER_CLASS}
                          >
                            {col.label}
                          </SortableHeader>
                        ))}
                      </tr>
                      <tr role="row" className="hidden sm:table-row">
                        {visibleColumns.map((col) => (
                          <SortableHeader<HoldingsSortField>
                            key={col.field}
                            field={col.field}
                            sortField={sort.field}
                            sortDirection={sort.direction}
                            onSort={handleSort}
                            align={col.align}
                            className={col.align === 'right' ? FIGURE_HEADER_CLASS : SYMBOL_HEADER_CLASS}
                            pressHandlers={headerHandlers(col.field)}
                          >
                            {col.label}
                          </SortableHeader>
                        ))}
                      </tr>
                    </thead>
                    <tbody role="rowgroup" className="block divide-y divide-gray-100 dark:divide-gray-700/50 sm:table-row-group">
                      {sortHoldings(account.holdings, sort, account.currencyCode, defaultCurrency).map((holding) => (
                        <HoldingRow
                          key={holding.id}
                          holding={holding}
                          hidden={hiddenColumns}
                          placement={placement.row}
                          defaultCurrency={defaultCurrency}
                          accountCurrency={account.currencyCode}
                          formatMoney={formatMoney}
                          formatCurrencyWithCode={formatCurrencyBase}
                          formatPrice={formatPrice}
                          formatQuantity={formatQuantity}
                          formatPercent={formatPercent}
                          getGainLossColor={getGainLossColor}
                          getPortfolioPercent={getPortfolioPercent}
                          onSecurityClick={onSecurityClick}
                        />
                      ))}

                      {/* Cash Row */}
                      {account.cashBalance !== 0 && (
                        <tr role="row" className="grid grid-cols-4 items-start gap-x-3 gap-y-1.5 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-700/20 sm:table-row sm:p-0">
                          <td role="cell" className="col-span-2 row-start-1 p-0 whitespace-nowrap sm:table-cell sm:px-6 sm:py-3">
                            <button
                              onClick={() => account.cashAccountId && onCashClick(account.cashAccountId)}
                              className="flex items-center gap-2 text-left hover:underline focus:outline-none focus:underline"
                              title={t('groupedHoldings.cashClickTitle')}
                            >
                              <svg className="h-4 w-4 text-green-600 dark:text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                              </svg>
                              <div>
                                <div className="font-medium text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300">{t('groupedHoldings.cashLabel')}</div>
                                <div className="text-xs text-gray-500 dark:text-gray-400">{t('groupedHoldings.availableBalance')}</div>
                              </div>
                            </button>
                          </td>
                          {isVisible('shares') && (
                            <td role="cell" className={`${placement.row.shares} text-gray-400 dark:text-gray-500 ${FIGURE_CELL}`}>
                              <CellLabel className={CAPTION_CLASS}>{t('groupedHoldings.sharesColumn')}</CellLabel>
                              -
                            </td>
                          )}
                          {isVisible('avgCost') && (
                            <td role="cell" className={`${placement.row.avgCost} text-gray-400 dark:text-gray-500 ${FIGURE_CELL}`}>
                              <CellLabel className={CAPTION_CLASS}>{t('groupedHoldings.avgCostColumn')}</CellLabel>
                              -
                            </td>
                          )}
                          {isVisible('price') && (
                            <td role="cell" className={`${placement.row.price} text-gray-400 dark:text-gray-500 ${FIGURE_CELL}`}>
                              <CellLabel className={CAPTION_CLASS}>{t('groupedHoldings.priceColumn')}</CellLabel>
                              -
                            </td>
                          )}
                          {isVisible('costBasis') && (
                            <td role="cell" className={`${placement.row.costBasis} text-gray-500 dark:text-gray-400 ${FIGURE_CELL}`}>
                              <CellLabel className={CAPTION_CLASS}>{t('groupedHoldings.costBasisColumn')}</CellLabel>
                              {fmtAcct(account.cashBalance)}
                            </td>
                          )}
                          {isVisible('mktValue') && (
                            <td role="cell" className={`${placement.row.mktValue} font-medium text-gray-900 dark:text-gray-100 ${FIGURE_CELL}`}>
                              <CellLabel className={CAPTION_CLASS}>{t('groupedHoldings.mktValueColumn')}</CellLabel>
                              {fmtAcct(account.cashBalance)}
                            </td>
                          )}
                          {isVisible('gainLoss') && (
                            <td role="cell" className={`${placement.row.gainLoss} text-gray-400 dark:text-gray-500 ${FIGURE_CELL}`}>
                              <CellLabel className={CAPTION_CLASS}>{t('groupedHoldings.gainLossColumn')}</CellLabel>
                              -
                            </td>
                          )}
                          {isVisible('portfolioPercent') && (
                            <td role="cell" className={`${placement.row.portfolioPercent} text-gray-500 dark:text-gray-400 ${FIGURE_CELL}`}>
                              <CellLabel className={CAPTION_CLASS}>{t('groupedHoldings.portfolioPercentColumn')}</CellLabel>
                              {getPortfolioPercent(account.cashBalance, acctDisplayCurrency || account.currencyCode)}
                            </td>
                          )}
                        </tr>
                      )}

                      {/* Account Summary Row */}
                      <tr role="row" className="ui-holding-total grid grid-cols-4 items-start gap-x-3 gap-y-1.5 px-4 py-3 bg-gray-50 dark:bg-gray-700/30 font-medium sm:table-row sm:p-0">
                        {/* colSpan drives the desktop table (the label spans
                            Symbol and the visible per-share columns); the grid
                            placement drives the phone card. */}
                        <td role="cell" colSpan={totalLabelSpan} className="col-span-2 row-start-1 p-0 text-sm text-gray-700 dark:text-gray-300 sm:table-cell sm:px-6 sm:py-3">
                          {t('groupedHoldings.accountTotal')}
                        </td>
                        {isVisible('costBasis') && (
                          <td role="cell" className={`${placement.total.costBasis} text-gray-900 dark:text-gray-100 ${FIGURE_CELL}`}>
                            <CellLabel className={CAPTION_CLASS}>{t('groupedHoldings.costBasisColumn')}</CellLabel>
                            {fmtAcct(account.totalCostBasis + account.cashBalance)}
                          </td>
                        )}
                        {isVisible('mktValue') && (
                          <td role="cell" className={`${placement.total.mktValue} text-gray-900 dark:text-gray-100 ${FIGURE_CELL}`}>
                            <CellLabel className={CAPTION_CLASS}>{t('groupedHoldings.mktValueColumn')}</CellLabel>
                            <div>{fmtAcct(accountTotalValue)}</div>
                            {defaultApprox !== null && (
                              <div className="text-xs font-normal text-gray-400 dark:text-gray-500">
                                {'\u2248 '}{formatCurrencyBase(defaultApprox, defaultCurrency)} {defaultCurrency}
                              </div>
                            )}
                          </td>
                        )}
                        {isVisible('gainLoss') && (
                          <td role="cell" className={`${placement.total.gainLoss} ${FIGURE_CELL}`}>
                            <CellLabel className={CAPTION_CLASS}>{t('groupedHoldings.gainLossColumn')}</CellLabel>
                            <div data-sign={signOf(account.totalGainLoss)} className={`ui-gain text-sm ${getGainLossColor(account.totalGainLoss)}`}>
                              <PartialTotal total={accountGainPartial} displayCurrency={account.currencyCode}>
                                {fmtAcct(account.totalGainLoss)}
                              </PartialTotal>
                            </div>
                            <div className={`text-xs ${getGainLossColor(account.totalGainLossPercent)}`}>
                              <PartialTotal total={accountGainPartial} displayCurrency={account.currencyCode}>
                                {formatPercent(account.totalGainLossPercent)}
                              </PartialTotal>
                            </div>
                          </td>
                        )}
                        {isVisible('portfolioPercent') && (
                          <td role="cell" className={`${placement.total.portfolioPercent} text-gray-500 dark:text-gray-400 ${FIGURE_CELL}`}>
                            <CellLabel className={CAPTION_CLASS}>{t('groupedHoldings.portfolioPercentColumn')}</CellLabel>
                            {getPortfolioPercent(accountTotalValue, acctDisplayCurrency || account.currencyCode)}
                          </td>
                        )}
                      </tr>
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {columnHeaderSheet}
    </div>
  );
}

/** The direction a signed figure points, for the Folio style's mark. */
const signOf = (value: number | null | undefined) =>
  value == null || value === 0 ? undefined : value > 0 ? 'up' : 'down';

interface HoldingRowProps {
  holding: HoldingWithMarketValue;
  /**
   * The hidden columns (`useHiddenColumns('investmentHoldings').hidden`, a
   * reference stable while the preference is unchanged, so this memoised row
   * is not re-rendered by a fresh callback). A hidden column's cell is absent
   * from the DOM at every width.
   */
  hidden: ReadonlySet<string>;
  /** Each visible figure's place in the phone card (`holdingsPhonePlacement(...).row`). */
  placement: HoldingsPhonePlacement['row'];
  defaultCurrency: string;
  accountCurrency: string;
  formatMoney: (value: number | null) => string;
  formatCurrencyWithCode: (value: number, currencyCode: string) => string;
  formatPrice: (value: number | null, currencyCode?: string) => string;
  formatQuantity: (value: number) => string;
  formatPercent: (value: number | null, showSign?: boolean) => string;
  getGainLossColor: (value: number | null) => string;
  getPortfolioPercent: (value: number | null, currencyCode?: string) => string;
  onSecurityClick: (securityId: string) => void;
}

const HoldingRow = memo(function HoldingRow({
  holding,
  hidden,
  placement,
  defaultCurrency,
  accountCurrency,
  formatMoney,
  formatCurrencyWithCode,
  formatPrice,
  formatQuantity,
  formatPercent,
  getGainLossColor,
  getPortfolioPercent,
  onSecurityClick,
}: HoldingRowProps) {
  const t = useTranslations('investments');
  const isVisible = (id: HoldingsColumn) => !hidden.has(id);
  const isForeign = holding.currencyCode && holding.currencyCode !== defaultCurrency;
  const isForeignToAccount =
    holding.currencyCode && holding.currencyCode !== accountCurrency;

  const fmtVal = (value: number | null) => {
    if (value === null) return '-';
    if (isForeign) return `${formatCurrencyWithCode(value, holding.currencyCode)} ${holding.currencyCode}`;
    return formatMoney(value);
  };

  const fmtPrice = (value: number | null) => {
    if (value === null) return '-';
    if (isForeign) return `${formatPrice(value, holding.currencyCode)} ${holding.currencyCode}`;
    return formatPrice(value);
  };

  // Both account-currency figures come from the backend, from the SAME
  // valuation that produced the account and portfolio totals: the cost basis at
  // the historical rates on each BUY, the market value at the server's live
  // snapshot. Re-converting `marketValue` here with the client's own `getRate`
  // was a SECOND FX for one snapshot -- the rows then disagreed with the total
  // beneath them by the drift between the two rate tables. The account currency
  // equals the security's when they match (1:1 by definition), otherwise the
  // server's `marketValueAccountCurrency`, which is `null` when the pair had no
  // rate: unknown, so the ≈ sub-line stays absent, never an implicit 1:1
  // (review #1133).
  const marketValueAcct = holdingMarketValueInAccountCurrency(holding, accountCurrency);
  // Unknown basis or unknown market value makes the gain unknown, not equal to
  // the market value. Both sides are the server's, so their difference shares
  // one snapshot too.
  const gainLossAcct = holdingGainLossInAccountCurrency(holding, accountCurrency);

  // The market value in the reporting currency the portfolio total is in, for
  // the share of the portfolio: the security's own value when it already is
  // that currency, otherwise the server's converted figure from the same
  // snapshot as the total, never a client-side re-conversion. `null` when the
  // pair is unresolved -- an unknown share, not a wrong-denominator percent.
  const marketValueInDefault = holdingMarketValueInDefaultCurrency(holding, defaultCurrency);

  const fmtAcctConverted = (value: number | null) => {
    if (value === null || !isForeignToAccount) return null;
    return `\u2248 ${formatCurrencyWithCode(value, accountCurrency)} ${accountCurrency}`;
  };

  return (
    <tr
      role="row"
      className="ui-holding-row grid grid-cols-4 items-start gap-x-3 gap-y-1.5 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-700/20 sm:table-row sm:p-0"
    >
      <td role="cell" className="col-span-2 row-start-1 p-0 sm:table-cell sm:whitespace-nowrap sm:px-6 sm:py-3">
        <button
          onClick={() => onSecurityClick(holding.securityId)}
          data-initial={holding.symbol.slice(0, 3)}
          className="ui-ticker text-left hover:underline focus:outline-none focus:underline"
          title={t('groupedHoldings.symbolClickTitle')}
        >
          <div className="font-medium text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300">
            {holding.symbol}
          </div>
          {/* The name wraps unclamped on a phone (it is the row's identity) and
              keeps its desktop clamp from `sm` up. */}
          <div
            className="text-xs text-gray-500 dark:text-gray-400 break-words sm:truncate sm:max-w-[320px]"
            title={holding.name}
          >
            {holding.name}
          </div>
        </button>
      </td>
      {isVisible('shares') && (
        <td role="cell" className={`${placement.shares} text-gray-900 dark:text-gray-100 ${FIGURE_CELL}`}>
          <CellLabel className={CAPTION_CLASS}>{t('groupedHoldings.sharesColumn')}</CellLabel>
          {formatQuantity(holding.quantity)}
        </td>
      )}
      {isVisible('avgCost') && (
        <td role="cell" className={`${placement.avgCost} text-gray-900 dark:text-gray-100 ${FIGURE_CELL}`}>
          <CellLabel className={CAPTION_CLASS}>{t('groupedHoldings.avgCostColumn')}</CellLabel>
          {fmtPrice(holding.averageCost)}
        </td>
      )}
      {isVisible('price') && (
        <td role="cell" className={`${placement.price} text-gray-900 dark:text-gray-100 ${FIGURE_CELL}`}>
          <CellLabel className={CAPTION_CLASS}>{t('groupedHoldings.priceColumn')}</CellLabel>
          {fmtPrice(holding.currentPrice)}
        </td>
      )}
      {isVisible('costBasis') && (
        <td role="cell" className={`${placement.costBasis} text-gray-900 dark:text-gray-100 ${FIGURE_CELL}`}>
          <CellLabel className={CAPTION_CLASS}>{t('groupedHoldings.costBasisColumn')}</CellLabel>
          <div>{fmtVal(holding.costBasis)}</div>
          {isForeignToAccount && (
            <div className="text-xs font-normal text-gray-400 dark:text-gray-500">
              {fmtAcctConverted(holding.costBasisAccountCurrency)}
            </div>
          )}
        </td>
      )}
      {isVisible('mktValue') && (
        <td role="cell" className={`${placement.mktValue} font-medium text-gray-900 dark:text-gray-100 ${FIGURE_CELL}`}>
          <CellLabel className={CAPTION_CLASS}>{t('groupedHoldings.mktValueColumn')}</CellLabel>
          <div>{fmtVal(holding.marketValue)}</div>
          {isForeignToAccount && (
            <div className="text-xs font-normal text-gray-400 dark:text-gray-500">
              {fmtAcctConverted(marketValueAcct)}
            </div>
          )}
        </td>
      )}
      {isVisible('gainLoss') && (
        <td role="cell" className={`${placement.gainLoss} ${FIGURE_CELL}`}>
          <CellLabel className={CAPTION_CLASS}>{t('groupedHoldings.gainLossColumn')}</CellLabel>
          <div data-sign={signOf(holding.gainLoss)} className={`ui-gain text-sm font-medium ${getGainLossColor(holding.gainLoss)}`}>
            {fmtVal(holding.gainLoss)}
          </div>
          {isForeignToAccount && (
            <div className="text-xs font-normal text-gray-400 dark:text-gray-500">
              {fmtAcctConverted(gainLossAcct)}
            </div>
          )}
          <div data-sign={signOf(holding.gainLossPercent)} className={`ui-gain text-xs ${getGainLossColor(holding.gainLossPercent)}`}>
            {formatPercent(holding.gainLossPercent)}
          </div>
        </td>
      )}
      {isVisible('portfolioPercent') && (
        <td role="cell" className={`${placement.portfolioPercent} text-gray-500 dark:text-gray-400 ${FIGURE_CELL}`}>
          <CellLabel className={CAPTION_CLASS}>{t('groupedHoldings.portfolioPercentColumn')}</CellLabel>
          {/* The value is already in the reporting currency, so no code is passed
              -- getPortfolioPercent must not re-convert it against a second rate. */}
          {getPortfolioPercent(marketValueInDefault)}
        </td>
      )}
    </tr>
  );
});
