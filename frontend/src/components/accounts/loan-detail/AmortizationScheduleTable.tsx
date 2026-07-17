'use client';

import { Fragment, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { LoanPaymentEvent } from '@/lib/loan-history';
import { ScheduleRow } from '@/lib/loan-schedule';
import { LoanRateChange } from '@/types/loan-rate-change';
import { exportToCsv } from '@/lib/csv-export';
import { sanitizeFilename } from '@/lib/export-filename';
import { buildScheduleDisplayRows, type DisplayRow } from '@/lib/loan-schedule-rows';
import { ExportIconButton } from '@/components/ui/ExportIconButton';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useChartDateFormat } from '@/hooks/useChartDateFormat';
import { LoanRateEditing } from './useLoanRateEditing';
import { ScheduleTableRow } from './ScheduleTableRow';

const COLLAPSED_PAST_ROWS = 5;
const COLLAPSED_FUTURE_ROWS = 5;

interface AmortizationScheduleTableProps {
  historyEvents: LoanPaymentEvent[];
  projectionRows: ScheduleRow[];
  currencyCode: string;
  /** Future rate changes; drives change-point edits on projected rows. */
  rateChanges?: LoanRateChange[];
  /** When provided, projected rows' rate is inline-editable and controls shown. */
  editing?: LoanRateEditing;
}

/** A month with a single entry renders as one row; a month with several
 *  (e.g. a regular installment plus an overpayment) collapses into an
 *  aggregate row that expands to its per-date detail. Projected rows are
 *  always single (one per period). */
type ScheduleUnit =
  | { kind: 'single'; row: DisplayRow }
  | { kind: 'group'; monthKey: string; aggregate: DisplayRow; children: DisplayRow[] }
  // A gap in payments: one or more expected installments with no recorded
  // payment. Rendered as an empty "no data" band before the row after the gap.
  | { kind: 'gap'; key: string };

const sumField = (rows: DisplayRow[], field: keyof DisplayRow): number =>
  rows.reduce((acc, row) => acc + Math.round(Number(row[field]) * 10000), 0) / 10000;

interface ColumnTotals {
  payment: number;
  interest: number;
  principal: number;
  extra: number;
}

/**
 * A summary row spanning the money columns: the whole-loan "Total" in the
 * footer and the "Paid to date" subtotal above the projected section share this
 * layout. `balance` is shown only when provided (the paid-to-date row carries
 * the balance so far; the grand total leaves it blank).
 */
function TotalsRow({
  label,
  totals,
  showExtraColumn,
  currencyCode,
  rowClassName,
  balance,
}: {
  label: string;
  totals: ColumnTotals;
  showExtraColumn: boolean;
  currencyCode: string;
  rowClassName: string;
  balance?: number;
}) {
  const { formatCurrency } = useNumberFormat();
  return (
    <tr className={rowClassName}>
      <td colSpan={2} className="px-4 py-3 text-left text-sm">
        {label}
      </td>
      <td className="px-4 py-3 whitespace-nowrap text-sm text-right">
        {formatCurrency(totals.payment, currencyCode)}
      </td>
      <td className="px-4 py-3 whitespace-nowrap text-sm text-right text-orange-600 dark:text-orange-400">
        {formatCurrency(totals.interest, currencyCode)}
      </td>
      <td className="px-4 py-3 whitespace-nowrap text-sm text-right text-green-600 dark:text-green-400">
        {formatCurrency(totals.principal, currencyCode)}
      </td>
      {showExtraColumn && (
        <td className="px-4 py-3 whitespace-nowrap text-sm text-right text-blue-600 dark:text-blue-400">
          {totals.extra > 0 ? formatCurrency(totals.extra, currencyCode) : '—'}
        </td>
      )}
      <td className="px-4 py-3" />
      <td className="px-4 py-3 whitespace-nowrap text-sm text-right">
        {balance !== undefined ? formatCurrency(balance, currencyCode) : null}
      </td>
    </tr>
  );
}

/**
 * Loan Schedule for the loan detail page: historical payments followed by the
 * projected rows, with a separator at the transition. Months with more than one
 * entry collapse into an aggregate row that expands to its per-date detail. A
 * totals row sums each money column across the whole loan. Shows an
 * extra-principal column whenever there are overpayments, and a per-row
 * interest rate (observed from the interest charged on historical rows,
 * inline-editable on projected rows when `editing` is supplied).
 */
export function AmortizationScheduleTable({
  historyEvents,
  projectionRows,
  currencyCode,
  rateChanges = [],
  editing,
}: AmortizationScheduleTableProps) {
  const t = useTranslations('accounts');
  const tc = useTranslations('common');
  const formatMonthLabel = useChartDateFormat();
  const [showAllRows, setShowAllRows] = useState(false);
  const [expandedMonths, setExpandedMonths] = useState<Set<string>>(new Set());

  const toggleMonth = (monthKey: string) =>
    setExpandedMonths((prev) => {
      const next = new Set(prev);
      if (next.has(monthKey)) next.delete(monthKey);
      else next.add(monthKey);
      return next;
    });

  const rows = useMemo(
    () => buildScheduleDisplayRows(historyEvents, projectionRows, rateChanges),
    [historyEvents, projectionRows, rateChanges],
  );

  // Collapse each historical month with more than one entry into an aggregate
  // row (expandable to its detail); every projected row stays on its own.
  const units = useMemo((): ScheduleUnit[] => {
    const byMonth = new Map<string, DisplayRow[]>();
    const projectedUnits: ScheduleUnit[] = [];
    for (const row of rows) {
      if (row.isProjected) {
        projectedUnits.push({ kind: 'single', row });
        continue;
      }
      const monthKey = row.date.slice(0, 7);
      const existing = byMonth.get(monthKey);
      if (existing) existing.push(row);
      else byMonth.set(monthKey, [row]);
    }
    const historicalUnits: ScheduleUnit[] = [];
    for (const [monthKey, monthRows] of byMonth) {
      // A gap before this month's first payment gets an empty "no data" band.
      if (monthRows[0].precededByGap) {
        historicalUnits.push({ kind: 'gap', key: `gap-${monthKey}` });
      }
      if (monthRows.length === 1) {
        historicalUnits.push({ kind: 'single', row: monthRows[0] });
        continue;
      }
      const last = monthRows[monthRows.length - 1];
      // The month's rate is the regular installment's observed rate, not the
      // blended figure an overpayment's interest would produce.
      const regular = monthRows.find((r) => !r.isOverpayment && r.annualRate != null);
      historicalUnits.push({
        kind: 'group',
        monthKey,
        children: monthRows,
        aggregate: {
          paymentNumber: monthRows[0].paymentNumber,
          date: `${monthKey}-01`,
          payment: sumField(monthRows, 'payment'),
          principal: sumField(monthRows, 'principal'),
          interest: sumField(monthRows, 'interest'),
          extraPrincipal: sumField(monthRows, 'extraPrincipal'),
          balance: last.balance,
          isProjected: false,
          annualRate: regular?.annualRate ?? null,
        },
      });
    }
    return [...historicalUnits, ...projectedUnits];
  }, [rows]);

  const showExtraColumn = useMemo(
    () =>
      historyEvents.some((event) => event.type === 'OVERPAYMENT') ||
      projectionRows.some((row) => row.extraPrincipal > 0),
    [historyEvents, projectionRows],
  );

  // Collapsed by default around "today": the last few months and the first few
  // projected rows, so upcoming installments are visible without expanding.
  // When there is no projection yet, show the most recent units instead of the
  // oldest. "Show all" expands to the full schedule.
  const displayedUnits = useMemo(() => {
    if (showAllRows) return units;
    const firstProjected = units.findIndex(
      (unit) => unit.kind === 'single' && unit.row.isProjected,
    );
    if (firstProjected === -1) {
      return units.slice(-(COLLAPSED_PAST_ROWS + COLLAPSED_FUTURE_ROWS));
    }
    const start = Math.max(0, firstProjected - COLLAPSED_PAST_ROWS);
    const end = Math.min(units.length, firstProjected + COLLAPSED_FUTURE_ROWS);
    return units.slice(start, end);
  }, [showAllRows, units]);
  const hasHiddenRows = displayedUnits.length < units.length;
  // Nr, Date, Payment, Principal, Interest, [Extra], Rate, Balance
  const columnCount = showExtraColumn ? 8 : 7;

  // Whole-loan column totals (every row, not just the visible window), summed
  // in integer ten-thousandths to avoid floating-point drift.
  const totals = useMemo(
    () => ({
      payment: sumField(rows, 'payment'),
      principal: sumField(rows, 'principal'),
      interest: sumField(rows, 'interest'),
      extra: sumField(rows, 'extraPrincipal'),
    }),
    [rows],
  );

  // Subtotal of everything paid so far, shown just above the projected section
  // so the transition to the forecast carries a running "paid to date" line.
  const paidTotals = useMemo(() => {
    const paid = rows.filter((row) => !row.isProjected);
    return {
      any: paid.length > 0,
      payment: sumField(paid, 'payment'),
      principal: sumField(paid, 'principal'),
      interest: sumField(paid, 'interest'),
      extra: sumField(paid, 'extraPrincipal'),
      balance: paid.length > 0 ? paid[paid.length - 1].balance : 0,
    };
  }, [rows]);

  // Every per-payment row (historical and projected), not the collapsed
  // month-group view, with raw numbers so the file is analysis-ready.
  const handleExportCsv = () => {
    const headers = [
      t('loanDetail.schedule.colNumber'),
      t('loanDetail.schedule.colDate'),
      t('loanDetail.schedule.colType'),
      t('loanDetail.schedule.colPayment'),
      t('loanDetail.schedule.colInterest'),
      t('loanDetail.schedule.colPrincipal'),
      ...(showExtraColumn ? [t('loanDetail.schedule.colExtra')] : []),
      t('loanDetail.schedule.colRate'),
      t('loanDetail.schedule.colBalance'),
    ];
    const data = rows.map((row) => [
      row.paymentNumber,
      row.date.split('T')[0],
      row.isProjected
        ? t('loanDetail.schedule.typeProjected')
        : t('loanDetail.schedule.typeHistorical'),
      row.payment,
      row.interest,
      row.principal,
      ...(showExtraColumn ? [row.extraPrincipal] : []),
      row.annualRate ?? '',
      row.balance,
    ]);
    exportToCsv(sanitizeFilename(t('loanDetail.schedule.title')), headers, data);
  };

  const headerClass =
    'px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider';
  // Faint arithmetic operators spelling out Payment = Interest + Principal
  // (+ Extra) across the money column headers.
  const operatorClass = 'text-gray-300 dark:text-gray-600 font-normal';

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden scroll-mt-4">
      <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700 flex items-start justify-between gap-2">
        <div>
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
        <ExportIconButton
          onExport={handleExportCsv}
          title={tc('csvDownload.downloadAsCsv', { filename: t('loanDetail.schedule.title') })}
          disabled={rows.length === 0}
        />
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
                  <th className={`${headerClass} text-right`}>
                    <span className={operatorClass}>= </span>
                    {t('loanDetail.schedule.colInterest')}
                  </th>
                  <th className={`${headerClass} text-right`}>
                    <span className={operatorClass}>+ </span>
                    {t('loanDetail.schedule.colPrincipal')}
                  </th>
                  {showExtraColumn && (
                    <th className={`${headerClass} text-right`}>
                      <span className={operatorClass}>+ </span>
                      {t('loanDetail.schedule.colExtra')}
                    </th>
                  )}
                  <th className={`${headerClass} text-right`}>{t('loanDetail.schedule.colRate')}</th>
                  <th className={`${headerClass} text-right`}>{t('loanDetail.schedule.colBalance')}</th>
                </tr>
              </thead>
              <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                {displayedUnits.map((unit, idx) => {
                  const prev = idx > 0 ? displayedUnits[idx - 1] : null;
                  const isProjectedUnit = unit.kind === 'single' && unit.row.isProjected;
                  const prevProjected =
                    prev !== null && prev.kind === 'single' && prev.row.isProjected;
                  const separator = isProjectedUnit && prev !== null && !prevProjected && (
                    <>
                      {paidTotals.any && (
                        <TotalsRow
                          label={t('loanDetail.schedule.paidToDate')}
                          totals={paidTotals}
                          showExtraColumn={showExtraColumn}
                          currencyCode={currencyCode}
                          rowClassName="bg-gray-50 dark:bg-gray-900/40 font-semibold text-gray-900 dark:text-gray-100"
                          balance={paidTotals.balance}
                        />
                      )}
                      <tr className="bg-gray-100 dark:bg-gray-700">
                        <td
                          colSpan={columnCount}
                          className="px-4 py-2 text-center text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider"
                        >
                          {t('loanDetail.schedule.projectedFuturePayments')}
                        </td>
                      </tr>
                    </>
                  );

                  if (unit.kind === 'gap') {
                    // Empty red band: expected installments here have no
                    // recorded payment (a payment holiday, or missing data).
                    return (
                      <tr
                        key={unit.key}
                        className="bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300"
                      >
                        <td
                          colSpan={columnCount}
                          className="px-4 py-2 text-center text-xs font-medium"
                        >
                          {t('loanDetail.schedule.gapRow')}
                        </td>
                      </tr>
                    );
                  }

                  if (unit.kind === 'single') {
                    return (
                      <Fragment key={`s-${unit.row.paymentNumber}`}>
                        {separator}
                        <ScheduleTableRow
                          row={unit.row}
                          currencyCode={currencyCode}
                          showExtraColumn={showExtraColumn}
                          editing={editing}
                        />
                      </Fragment>
                    );
                  }

                  const expanded = expandedMonths.has(unit.monthKey);
                  return (
                    <Fragment key={`g-${unit.monthKey}`}>
                      {separator}
                      <ScheduleTableRow
                        row={unit.aggregate}
                        currencyCode={currencyCode}
                        showExtraColumn={showExtraColumn}
                        monthGroup={{
                          label: formatMonthLabel(`${unit.monthKey}-01`, 'MMM yyyy'),
                          expanded,
                          count: unit.children.length,
                          onToggle: () => toggleMonth(unit.monthKey),
                        }}
                      />
                      {expanded &&
                        unit.children.map((child, ci) => (
                          <ScheduleTableRow
                            key={`c-${unit.monthKey}-${ci}`}
                            row={child}
                            currencyCode={currencyCode}
                            showExtraColumn={showExtraColumn}
                            isChild
                          />
                        ))}
                    </Fragment>
                  );
                })}
              </tbody>
              <tfoot className="bg-gray-50 dark:bg-gray-900/50 border-t-2 border-gray-200 dark:border-gray-700">
                <TotalsRow
                  label={t('loanDetail.schedule.total')}
                  totals={totals}
                  showExtraColumn={showExtraColumn}
                  currencyCode={currencyCode}
                  rowClassName="font-semibold text-gray-900 dark:text-gray-100"
                />
              </tfoot>
            </table>
          </div>

          {(hasHiddenRows || showAllRows) && (
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
