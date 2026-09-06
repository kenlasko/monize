'use client';

import { useTranslations } from 'next-intl';
import { CellLabel } from '@/components/ui/Table';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useDateFormat } from '@/hooks/useDateFormat';
import { RateCell } from './RateCell';
import { LoanRateEditing } from './useLoanRateEditing';
import type { DisplayRow } from '@/lib/loan-schedule-rows';

export type { DisplayRow } from '@/lib/loan-schedule-rows';

interface ScheduleTableRowProps {
  row: DisplayRow;
  currencyCode: string;
  showExtraColumn: boolean;
  /** When provided, a projected row's rate is inline-editable. */
  editing?: LoanRateEditing;
  /** An indented per-date detail row inside an expanded month group. */
  isChild?: boolean;
  /**
   * When set, this row is a month aggregate: the Date cell shows the month
   * label and an expand/collapse toggle for its detail rows instead of a date.
   */
  monthGroup?: {
    label: string;
    expanded: boolean;
    count: number;
    onToggle: () => void;
  };
}

// Shared chrome for the second-line money cells: no padding on phones (the row
// supplies it and the wrapped grid spaces the cells), the table cell's own
// padding from `sm` up. Slightly smaller type on phones so a four-figure
// installment still fits a quarter-width column without wrapping mid-number
// (a locale that groups thousands with a space would otherwise break there).
const MONEY_CELL =
  'p-0 text-xs text-right whitespace-nowrap sm:table-cell sm:px-4 sm:py-3 sm:text-sm';

/**
 * One Loan Schedule row: a historical payment, a month aggregate (with an
 * expand toggle), an indented per-date detail row, or a projected installment.
 * Historical and aggregate rows show their rate read-only (it is observed from
 * the interest charged); only projected rows expose the inline rate editor.
 *
 * The row is a normal table row from `sm` up. Below `sm` it becomes a
 * four-column grid so the eight columns wrap onto two lines and fit a phone
 * without a horizontal scroll: the date (with the payment number folded in) and
 * the balance share the first line, and payment/interest/principal (+ extra) /
 * rate fill the second. The `col-start`/`row-start` placements are inert once
 * the row is `table-row` again, so they never touch the desktop layout.
 */
export function ScheduleTableRow({
  row,
  currencyCode,
  showExtraColumn,
  editing,
  isChild = false,
  monthGroup,
}: ScheduleTableRowProps) {
  const t = useTranslations('accounts');
  const { formatCurrency } = useNumberFormat();
  const { formatDate } = useDateFormat();

  // With an extra-principal column the second line holds four money cells, so
  // the rate drops to a third line; without it the rate takes the fourth slot.
  const rateCellPlacement = showExtraColumn
    ? 'col-start-1 row-start-3'
    : 'col-start-4 row-start-2';

  return (
    <tr
      role="row"
      className={`grid grid-cols-4 items-start gap-x-3 gap-y-1.5 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-700/50 sm:table-row sm:p-0 ${
        row.isProjected ? 'bg-blue-50/50 dark:bg-blue-900/10' : ''
      } ${isChild ? 'bg-gray-50/60 dark:bg-gray-900/20' : ''}`}
    >
      <td role="cell" className="hidden px-4 py-3 text-sm text-gray-500 dark:text-gray-400 sm:table-cell">
        {isChild ? '' : row.paymentNumber}
      </td>
      <td
        className={`col-span-2 row-start-1 p-0 text-sm whitespace-normal text-gray-900 dark:text-gray-100 sm:table-cell sm:whitespace-nowrap sm:px-4 sm:py-3 ${
          isChild ? 'sm:pl-10' : ''
        }`}
      >
        {monthGroup ? (
          <button
            type="button"
            onClick={monthGroup.onToggle}
            aria-expanded={monthGroup.expanded}
            aria-label={t('loanDetail.schedule.toggleMonth', { month: monthGroup.label })}
            className="inline-flex items-center gap-1.5 text-gray-900 dark:text-gray-100 hover:text-blue-600 dark:hover:text-blue-400"
          >
            <span className="text-xs text-gray-400">{monthGroup.expanded ? '▾' : '▸'}</span>
            {monthGroup.label}
            <span className="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300">
              {t('loanDetail.schedule.monthEntries', { count: monthGroup.count })}
            </span>
          </button>
        ) : (
          <>
            {!isChild && (
              <span className="mr-2 tabular-nums text-gray-400 dark:text-gray-500 sm:hidden">
                {row.paymentNumber}
              </span>
            )}
            {formatDate(row.date)}
            {row.isProjected && (
              <span className="ml-1.5 text-xs text-blue-500 dark:text-blue-400">*</span>
            )}
            {row.isOverpayment && (
              <span className="ml-1.5 inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">
                {t('loanDetail.schedule.overpaymentBadge')}
              </span>
            )}
            {row.rateChange && (
              <span className="ml-1.5 inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300">
                {t('loanDetail.schedule.rateChangeBadge', {
                  from: row.rateChange.from,
                  to: row.rateChange.to,
                })}
              </span>
            )}
          </>
        )}
      </td>
      <td role="cell" className={`col-start-1 row-start-2 text-gray-900 dark:text-gray-100 ${MONEY_CELL}`}>
        <CellLabel className="sm:hidden">{t('loanDetail.schedule.colPayment')}</CellLabel>
        {formatCurrency(row.payment, currencyCode)}
      </td>
      <td role="cell" className={`col-start-2 row-start-2 text-orange-600 dark:text-orange-400 ${MONEY_CELL}`}>
        <CellLabel className="sm:hidden">{t('loanDetail.schedule.colInterest')}</CellLabel>
        {formatCurrency(row.interest, currencyCode)}
      </td>
      <td role="cell" className={`col-start-3 row-start-2 text-green-600 dark:text-green-400 ${MONEY_CELL}`}>
        <CellLabel className="sm:hidden">{t('loanDetail.schedule.colPrincipal')}</CellLabel>
        {formatCurrency(row.principal, currencyCode)}
      </td>
      {showExtraColumn && (
        <td role="cell" className={`col-start-4 row-start-2 text-blue-600 dark:text-blue-400 ${MONEY_CELL}`}>
          <CellLabel className="sm:hidden">{t('loanDetail.schedule.colExtra')}</CellLabel>
          {row.extraPrincipal > 0 ? formatCurrency(row.extraPrincipal, currencyCode) : '—'}
        </td>
      )}
      <td role="cell" className={`${rateCellPlacement} ${MONEY_CELL}`}>
        <CellLabel className="sm:hidden">{t('loanDetail.schedule.colRate')}</CellLabel>
        <RateCell
          annualRate={row.annualRate}
          onEdit={
            editing && row.annualRate != null
              ? () => editing.openAddWith(row.date, row.annualRate as number)
              : undefined
          }
          editLabel={t('loanDetail.schedule.editRateLabel', {
            date: formatDate(row.date),
          })}
        />
      </td>
      {/* Balance takes the right half of the first line (not a quarter): it is
          the widest figure -- a six-figure balance clips in a quarter column. */}
      <td role="cell" className="col-start-3 col-span-2 row-start-1 p-0 text-sm text-right whitespace-nowrap font-medium text-gray-900 dark:text-gray-100 sm:table-cell sm:px-4 sm:py-3">
        <CellLabel className="sm:hidden">{t('loanDetail.schedule.colBalance')}</CellLabel>
        {formatCurrency(row.balance, currencyCode)}
      </td>
    </tr>
  );
}
