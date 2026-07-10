'use client';

import { Fragment, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { LoanPaymentEvent } from '@/lib/loan-history';
import { ScheduleRow } from '@/lib/loan-schedule';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useDateFormat } from '@/hooks/useDateFormat';

const COLLAPSED_ROW_COUNT = 24;

interface AmortizationScheduleTableProps {
  historyEvents: LoanPaymentEvent[];
  projectionRows: ScheduleRow[];
  currencyCode: string;
}

interface DisplayRow {
  paymentNumber: number;
  date: string;
  payment: number;
  principal: number;
  interest: number;
  extraPrincipal: number;
  balance: number;
  isProjected: boolean;
  /** Set on the first projected row of a new rate segment */
  rateChange?: { from: number; to: number };
}

/**
 * Installment schedule for the loan detail page: historical payments followed
 * by the projected rows, with a separator at the transition. Shows an extra
 * principal column whenever the projection contains overpayments (i.e. a
 * simulator scenario is active).
 */
export function AmortizationScheduleTable({
  historyEvents,
  projectionRows,
  currencyCode,
}: AmortizationScheduleTableProps) {
  const t = useTranslations('accounts');
  const { formatCurrency } = useNumberFormat();
  const { formatDate } = useDateFormat();
  const [showAllRows, setShowAllRows] = useState(false);

  const rows = useMemo((): DisplayRow[] => {
    const historical = historyEvents.map((event, index) => ({
      paymentNumber: index + 1,
      date: event.date,
      payment: event.principal + event.interest,
      principal: event.principal,
      interest: event.interest,
      extraPrincipal: 0,
      balance: event.balance,
      isProjected: false,
    }));
    const projected = projectionRows.map((row, index) => {
      const previousRate = index > 0 ? projectionRows[index - 1].annualRate : row.annualRate;
      return {
        paymentNumber: historyEvents.length + row.paymentNumber,
        date: row.date,
        payment: row.payment,
        principal: row.principal,
        interest: row.interest,
        extraPrincipal: row.extraPrincipal,
        balance: row.balance,
        isProjected: true,
        ...(previousRate !== row.annualRate
          ? { rateChange: { from: previousRate, to: row.annualRate } }
          : {}),
      };
    });
    return [...historical, ...projected];
  }, [historyEvents, projectionRows]);

  const showExtraColumn = useMemo(
    () => projectionRows.some((row) => row.extraPrincipal > 0),
    [projectionRows],
  );

  const displayedRows = showAllRows ? rows : rows.slice(0, COLLAPSED_ROW_COUNT);
  const columnCount = showExtraColumn ? 7 : 6;

  const headerClass =
    'px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider';

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {t('loanDetail.schedule.title')}
        </h3>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          {t('loanDetail.schedule.subtitle', {
            historical: historyEvents.length,
            projected: projectionRows.length,
          })}
        </p>
      </div>

      {rows.length === 0 ? (
        <p className="px-6 py-8 text-gray-500 dark:text-gray-400 text-center">
          {t('loanDetail.schedule.noPayments')}
        </p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
              <thead className="bg-gray-50 dark:bg-gray-900/50">
                <tr>
                  <th className={`${headerClass} text-left`}>{t('loanDetail.schedule.colNumber')}</th>
                  <th className={`${headerClass} text-left`}>{t('loanDetail.schedule.colDate')}</th>
                  <th className={`${headerClass} text-right`}>{t('loanDetail.schedule.colPayment')}</th>
                  <th className={`${headerClass} text-right`}>{t('loanDetail.schedule.colPrincipal')}</th>
                  <th className={`${headerClass} text-right`}>{t('loanDetail.schedule.colInterest')}</th>
                  {showExtraColumn && (
                    <th className={`${headerClass} text-right`}>{t('loanDetail.schedule.colExtra')}</th>
                  )}
                  <th className={`${headerClass} text-right`}>{t('loanDetail.schedule.colBalance')}</th>
                </tr>
              </thead>
              <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                {displayedRows.map((row, idx) => {
                  const prevRow = idx > 0 ? displayedRows[idx - 1] : null;
                  const showSeparator = row.isProjected && prevRow && !prevRow.isProjected;
                  return (
                    <Fragment key={row.paymentNumber}>
                      {showSeparator && (
                        <tr className="bg-gray-100 dark:bg-gray-700">
                          <td
                            colSpan={columnCount}
                            className="px-4 py-2 text-center text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider"
                          >
                            {t('loanDetail.schedule.projectedFuturePayments')}
                          </td>
                        </tr>
                      )}
                      <tr
                        className={`hover:bg-gray-50 dark:hover:bg-gray-700/50 ${
                          row.isProjected ? 'bg-blue-50/50 dark:bg-blue-900/10' : ''
                        }`}
                      >
                        <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                          {row.paymentNumber}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-900 dark:text-gray-100">
                          {formatDate(row.date)}
                          {row.isProjected && (
                            <span className="ml-1.5 text-xs text-blue-500 dark:text-blue-400">*</span>
                          )}
                          {row.rateChange && (
                            <span className="ml-1.5 inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300">
                              {t('loanDetail.schedule.rateChangeBadge', {
                                from: row.rateChange.from,
                                to: row.rateChange.to,
                              })}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-sm text-right text-gray-900 dark:text-gray-100">
                          {formatCurrency(row.payment, currencyCode)}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-sm text-right text-green-600 dark:text-green-400">
                          {formatCurrency(row.principal, currencyCode)}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-sm text-right text-orange-600 dark:text-orange-400">
                          {formatCurrency(row.interest, currencyCode)}
                        </td>
                        {showExtraColumn && (
                          <td className="px-4 py-3 whitespace-nowrap text-sm text-right text-blue-600 dark:text-blue-400">
                            {row.extraPrincipal > 0 ? formatCurrency(row.extraPrincipal, currencyCode) : '—'}
                          </td>
                        )}
                        <td className="px-4 py-3 whitespace-nowrap text-sm text-right font-medium text-gray-900 dark:text-gray-100">
                          {formatCurrency(row.balance, currencyCode)}
                        </td>
                      </tr>
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>

          {rows.length > COLLAPSED_ROW_COUNT && (
            <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700">
              <button
                onClick={() => setShowAllRows(!showAllRows)}
                className="text-blue-600 dark:text-blue-400 text-sm font-medium hover:underline"
              >
                {showAllRows
                  ? t('loanDetail.schedule.showLess')
                  : t('loanDetail.schedule.showAll', { count: rows.length })}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
