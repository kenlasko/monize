'use client';

import React, { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDownIcon } from '@heroicons/react/24/outline';
import { Skeleton } from '@/components/ui/LoadingSkeleton';
import { CARD_CLASS, HOVER_ROW_ON_CARD } from '@/components/ui/Card';
import { SortableHeader } from '@/components/ui/SortableHeader';
import { INTERACTIVE_ROW_FOCUS_CLASS, activateOnKey } from '@/components/ui/interactive-row';
import {
  CAPTION_CLASS,
  CellLabel,
  PHONE_HEADER_CLASS,
  TABLE_BODY_CLASS,
  TABLE_CLASS,
  type SortColumn,
  type SortColumnsByField,
} from '@/components/ui/Table';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { gainLossColor } from '@/lib/format';
import type { UseSecurityPeriodResultsValue } from '@/hooks/useSecurityPeriodResults';
import {
  symbolsWhere,
  type HoldingsSortField,
  type PerformanceHoldingRow,
} from './investment-performance-rows';

const HEADER_CLASS =
  'px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase';
const FIGURE_CELL =
  'p-0 text-right text-xs whitespace-nowrap sm:table-cell sm:px-4 sm:py-3 sm:text-sm';
const CHILD_FIGURE_CELL =
  'p-0 text-right text-xs whitespace-nowrap sm:table-cell sm:px-4 sm:py-2 sm:text-sm';

const CELL_PLACEMENT: Record<HoldingsSortField, string> = {
  symbol: 'col-start-1 row-start-1',
  quantity: 'col-start-1 row-start-2',
  averageCost: 'col-start-2 row-start-2',
  currentPrice: 'col-start-1 row-start-3',
  marketValue: 'col-start-2 row-start-1',
  gainLoss: 'col-start-2 row-start-3',
  gainLossPercent: 'col-start-1 row-start-4',
  priceChangePercent: 'col-start-2 row-start-4',
};

interface InvestmentPerformanceHoldingsTableProps {
  /** Already in the order the sort state names. */
  rows: PerformanceHoldingRow[];
  columns: SortColumnsByField<HoldingsSortField, SortColumn<HoldingsSortField>>;
  sortField: HoldingsSortField;
  sortDirection: 'asc' | 'desc';
  onSort: (field: HoldingsSortField) => void;
  accountNameById: ReadonlyMap<string, string>;
  /** The window's figures, with the state of the request behind them. */
  period: UseSecurityPeriodResultsValue;
}

/**
 * The holdings table: today's positions beside what each earned over the
 * report's window.
 *
 * Gain/Loss and Return are the server's per-security split of the period's
 * invested result, in the currency the response names; % Change is the
 * security's quoted close over the same window, in its own currency
 * (`docs/specs/investment-performance-report-period.md`). A figure the server
 * withheld reads "N/A" and the cause is stated once under the table; a
 * request in flight shows a placeholder, never a zero.
 */
export function InvestmentPerformanceHoldingsTable({
  rows,
  columns,
  sortField,
  sortDirection,
  onSort,
  accountNameById,
  period,
}: InvestmentPerformanceHoldingsTableProps) {
  const t = useTranslations('reports');
  const { formatCurrency, formatShareQuantity, formatSignedPercent } = useNumberFormat();
  const { defaultCurrency } = useExchangeRates();
  const [expandedSecurityId, setExpandedSecurityId] = useState<string | null>(null);
  const sortColumns = Object.values(columns);
  const loading = period.status === 'loading';
  const periodCurrency = period.results?.currency ?? defaultCurrency;

  const fmtHolding = (value: number | null, currencyCode: string) => {
    if (value === null) return t('investmentPerformance.na');
    if (currencyCode && currencyCode !== defaultCurrency) {
      return `${formatCurrency(value, currencyCode)} ${currencyCode}`;
    }
    return formatCurrency(value);
  };

  const periodFigure = (text: string | null) => {
    if (loading) {
      return <Skeleton className="ml-auto inline-block h-4 w-16 align-middle" />;
    }
    return text ?? t('investmentPerformance.na');
  };
  const periodMoney = (value: number | null | undefined) => {
    if (value == null) return null;
    const amount = `${value >= 0 ? '+' : ''}${formatCurrency(value, periodCurrency)}`;
    return periodCurrency !== defaultCurrency ? `${amount} ${periodCurrency}` : amount;
  };
  const percent = (value: number | null | undefined) =>
    value == null ? null : formatSignedPercent(value);
  const colourOf = (value: number | null | undefined) =>
    value == null ? 'text-gray-500 dark:text-gray-400' : gainLossColor(value);

  const unattributed = period.results?.unattributedPnl ?? null;
  // A measured window whose rows naming no security did not convert: the
  // line stays, as unknown, so the rows are not read as the whole gain.
  const unattributedUnknown =
    period.status === 'ready' &&
    (period.results?.reasons.length ?? 0) === 0 &&
    period.results?.unattributedPnl === null;

  // The causes, said once under the table and naming the securities: a
  // withheld figure is only honest if the reader learns which and why.
  const notices: string[] = [];
  if (period.status === 'error') {
    notices.push(t('investmentPerformance.periodLoadFailed'));
  } else if (!loading) {
    const unpriced = symbolsWhere(
      rows,
      (p) => p.investmentPnl === null && p.investedReasons.includes('incompletePrices'),
    );
    if (unpriced.length > 0) {
      notices.push(t('investmentPerformance.periodUnpriced', { symbols: unpriced.join(', ') }));
    }
    const unconverted = symbolsWhere(
      rows,
      (p) =>
        p.investmentPnl === null &&
        !p.investedReasons.includes('incompletePrices') &&
        p.investedReasons.includes('missingRatePairs'),
    );
    if (unconverted.length > 0) {
      notices.push(t('investmentPerformance.periodNoRate', { symbols: unconverted.join(', ') }));
    }
    const noBase = symbolsWhere(
      rows,
      (p) => p.investmentPnl !== null && p.investmentReturnPercent === null,
    );
    if (noBase.length > 0) {
      notices.push(t('investmentPerformance.returnNoBase', { symbols: noBase.join(', ') }));
    }
    if (unattributedUnknown) {
      notices.push(t('investmentPerformance.unattributedNoRate'));
    }
    const split = symbolsWhere(rows, (p) => p.priceChangeReason === 'splitInWindow');
    if (split.length > 0) {
      notices.push(t('investmentPerformance.priceChangeSplit', { symbols: split.join(', ') }));
    }
    const noClose = symbolsWhere(
      rows,
      (p) => p.priceChangeReason === 'noStartClose' || p.priceChangeReason === 'noEndClose',
    );
    if (noClose.length > 0) {
      notices.push(t('investmentPerformance.priceChangeNoClose', { symbols: noClose.join(', ') }));
    }
  }

  return (
    <div className={`${CARD_CLASS} overflow-hidden`}>
      <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {t('investmentPerformance.holdingsDetail')}
        </h3>
        <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
          {t('investmentPerformance.holdingsDetailSubtitle')}
        </p>
      </div>
      <div className="overflow-x-auto">
        <table role="table" className={`block ${TABLE_CLASS} sm:table`}>
          <thead role="rowgroup" className="block bg-gray-50 dark:bg-gray-900/50 sm:table-header-group">
            <tr role="row" className="flex flex-wrap gap-x-2 gap-y-1 px-2 py-2 sm:hidden">
              {sortColumns.map((column) => (
                <SortableHeader<HoldingsSortField>
                  key={column.field}
                  field={column.field}
                  sortField={sortField}
                  sortDirection={sortDirection}
                  onSort={onSort}
                  className={PHONE_HEADER_CLASS}
                >
                  {column.label}
                </SortableHeader>
              ))}
            </tr>
            <tr role="row" className="hidden sm:table-row">
              {sortColumns.map((column) => (
                <SortableHeader<HoldingsSortField>
                  key={column.field}
                  field={column.field}
                  sortField={sortField}
                  sortDirection={sortDirection}
                  onSort={onSort}
                  align={column.align}
                  className={HEADER_CLASS}
                >
                  {column.label}
                </SortableHeader>
              ))}
            </tr>
          </thead>
          <tbody role="rowgroup" className={`block ${TABLE_BODY_CLASS} sm:table-row-group`}>
            {rows.map((holding) => {
              const isExpandable = holding.accountBreakdowns.length > 1;
              const isExpanded = expandedSecurityId === holding.securityId;
              const p = holding.period;
              return (
                <React.Fragment key={holding.securityId}>
                  <tr
                    role="row"
                    tabIndex={isExpandable ? 0 : undefined}
                    aria-expanded={isExpandable ? isExpanded : undefined}
                    className={`grid grid-cols-2 items-start gap-x-3 gap-y-1.5 px-4 py-3 ${HOVER_ROW_ON_CARD} sm:table-row sm:p-0 ${isExpandable ? `cursor-pointer ${INTERACTIVE_ROW_FOCUS_CLASS}` : ''}`}
                    onClick={isExpandable ? () => setExpandedSecurityId(isExpanded ? null : holding.securityId) : undefined}
                    onKeyDown={isExpandable ? activateOnKey(() => setExpandedSecurityId(isExpanded ? null : holding.securityId)) : undefined}
                  >
                    <td role="cell" className={`${CELL_PLACEMENT.symbol} min-w-0 p-0 sm:table-cell sm:px-4 sm:py-3`}>
                      <div className="flex items-center gap-2">
                        <div className="min-w-0">
                          <div className="font-medium text-gray-900 dark:text-gray-100">
                            {holding.symbol ?? t('investmentPerformance.unknownSecurity')}
                          </div>
                          <div className="break-words text-sm text-gray-500 dark:text-gray-400 sm:break-normal">
                            {holding.name}
                            {isExpandable && (
                              <span className="ml-2 text-xs text-gray-400 dark:text-gray-500">
                                {t('investmentPerformance.accountCount', { count: holding.accountBreakdowns.length })}
                              </span>
                            )}
                            {holding.closed && (
                              <span className="ml-2 text-xs text-gray-400 dark:text-gray-500">
                                {t('investmentPerformance.soldInPeriod')}
                              </span>
                            )}
                          </div>
                        </div>
                        {isExpandable && (
                          <ChevronDownIcon className={`w-4 h-4 text-gray-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`} aria-hidden="true" />
                        )}
                      </div>
                    </td>
                    <td role="cell" className={`${CELL_PLACEMENT.quantity} text-gray-900 dark:text-gray-100 ${FIGURE_CELL}`}>
                      <CellLabel className={CAPTION_CLASS}>{columns.quantity.label}</CellLabel>
                      {formatShareQuantity(holding.quantity)}
                    </td>
                    <td role="cell" className={`${CELL_PLACEMENT.averageCost} text-gray-900 dark:text-gray-100 ${FIGURE_CELL}`}>
                      <CellLabel className={CAPTION_CLASS}>{columns.averageCost.label}</CellLabel>
                      {fmtHolding(holding.averageCost, holding.currencyCode)}
                    </td>
                    <td role="cell" className={`${CELL_PLACEMENT.currentPrice} text-gray-900 dark:text-gray-100 ${FIGURE_CELL}`}>
                      <CellLabel className={CAPTION_CLASS}>{columns.currentPrice.label}</CellLabel>
                      {fmtHolding(holding.currentPrice, holding.currencyCode)}
                    </td>
                    <td role="cell" className={`${CELL_PLACEMENT.marketValue} font-medium text-gray-900 dark:text-gray-100 ${FIGURE_CELL}`}>
                      <CellLabel className={CAPTION_CLASS}>{columns.marketValue.label}</CellLabel>
                      {fmtHolding(holding.marketValue, holding.currencyCode)}
                    </td>
                    <td role="cell" className={`${CELL_PLACEMENT.gainLoss} ${colourOf(p?.investmentPnl)} ${FIGURE_CELL}`}>
                      <CellLabel className={CAPTION_CLASS}>{columns.gainLoss.label}</CellLabel>
                      {periodFigure(periodMoney(p?.investmentPnl))}
                    </td>
                    <td role="cell" className={`${CELL_PLACEMENT.gainLossPercent} font-medium ${colourOf(p?.investmentReturnPercent)} ${FIGURE_CELL}`}>
                      <CellLabel className={CAPTION_CLASS}>{columns.gainLossPercent.label}</CellLabel>
                      {periodFigure(percent(p?.investmentReturnPercent))}
                    </td>
                    <td role="cell" className={`${CELL_PLACEMENT.priceChangePercent} ${colourOf(p?.priceChangePercent)} ${FIGURE_CELL}`}>
                      <CellLabel className={CAPTION_CLASS}>{columns.priceChangePercent.label}</CellLabel>
                      {periodFigure(percent(p?.priceChangePercent))}
                    </td>
                  </tr>
                  {isExpanded && holding.accountBreakdowns.map((sub) => (
                    <tr
                      key={sub.id}
                      role="row"
                      className="grid grid-cols-2 items-start gap-x-3 gap-y-1.5 bg-gray-50/70 px-4 py-2 dark:bg-gray-900/20 sm:table-row sm:p-0"
                    >
                      <td role="cell" className={`${CELL_PLACEMENT.symbol} min-w-0 p-0 text-sm text-gray-600 dark:text-gray-400 sm:table-cell sm:px-4 sm:py-2 sm:pl-10`}>
                        {accountNameById.get(sub.accountId) || t('investmentPerformance.unknownAccount')}
                      </td>
                      <td role="cell" className={`${CELL_PLACEMENT.quantity} text-gray-600 dark:text-gray-400 ${CHILD_FIGURE_CELL}`}>
                        <CellLabel className={CAPTION_CLASS}>{columns.quantity.label}</CellLabel>
                        {formatShareQuantity(sub.quantity)}
                      </td>
                      <td role="cell" className={`${CELL_PLACEMENT.averageCost} text-gray-600 dark:text-gray-400 ${CHILD_FIGURE_CELL}`}>
                        <CellLabel className={CAPTION_CLASS}>{columns.averageCost.label}</CellLabel>
                        {fmtHolding(sub.averageCost, sub.currencyCode)}
                      </td>
                      <td role="cell" className={`${CELL_PLACEMENT.currentPrice} text-gray-600 dark:text-gray-400 ${CHILD_FIGURE_CELL}`}>
                        <CellLabel className={CAPTION_CLASS}>{columns.currentPrice.label}</CellLabel>
                        {fmtHolding(sub.currentPrice, sub.currencyCode)}
                      </td>
                      <td role="cell" className={`${CELL_PLACEMENT.marketValue} text-gray-600 dark:text-gray-400 ${CHILD_FIGURE_CELL}`}>
                        <CellLabel className={CAPTION_CLASS}>{columns.marketValue.label}</CellLabel>
                        {fmtHolding(sub.marketValue, sub.currencyCode)}
                      </td>
                      {/* The period is measured per security, not per account:
                          an all-time figure under a period caption is what this
                          table used to show. */}
                      <td role="cell" className={`${CELL_PLACEMENT.gainLoss} ${CHILD_FIGURE_CELL}`} />
                      <td role="cell" className={`${CELL_PLACEMENT.gainLossPercent} ${CHILD_FIGURE_CELL}`} />
                      <td role="cell" className={`${CELL_PLACEMENT.priceChangePercent} ${CHILD_FIGURE_CELL}`} />
                    </tr>
                  ))}
                </React.Fragment>
              );
            })}
            {((unattributed !== null && unattributed !== 0) || unattributedUnknown) && (
              <tr
                role="row"
                data-testid="unattributed-row"
                className="grid grid-cols-2 items-start gap-x-3 gap-y-1.5 px-4 py-3 sm:table-row sm:p-0"
              >
                <td role="cell" className={`${CELL_PLACEMENT.symbol} min-w-0 p-0 text-sm text-gray-600 dark:text-gray-400 sm:table-cell sm:px-4 sm:py-3`}>
                  {t('investmentPerformance.unattributedIncome')}
                </td>
                <td role="cell" className={`${CELL_PLACEMENT.quantity} ${FIGURE_CELL}`} />
                <td role="cell" className={`${CELL_PLACEMENT.averageCost} ${FIGURE_CELL}`} />
                <td role="cell" className={`${CELL_PLACEMENT.currentPrice} ${FIGURE_CELL}`} />
                <td role="cell" className={`${CELL_PLACEMENT.marketValue} ${FIGURE_CELL}`} />
                <td role="cell" className={`${CELL_PLACEMENT.gainLoss} ${colourOf(unattributed)} ${FIGURE_CELL}`}>
                  <CellLabel className={CAPTION_CLASS}>{columns.gainLoss.label}</CellLabel>
                  {periodMoney(unattributed) ?? t('investmentPerformance.na')}
                </td>
                <td role="cell" className={`${CELL_PLACEMENT.gainLossPercent} ${FIGURE_CELL}`} />
                <td role="cell" className={`${CELL_PLACEMENT.priceChangePercent} ${FIGURE_CELL}`} />
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {notices.length > 0 && (
        <div className="space-y-1 border-t border-gray-200 px-6 py-3 text-xs text-amber-700 dark:border-gray-700 dark:text-amber-300" data-testid="period-notices">
          {notices.map((notice) => (
            <p key={notice}>{notice}</p>
          ))}
        </div>
      )}
    </div>
  );
}
