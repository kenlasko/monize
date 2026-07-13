'use client';

import { Fragment, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { LoanPaymentEvent } from '@/lib/loan-history';
import { ScheduleRow } from '@/lib/loan-schedule';
import { LoanRateChange } from '@/types/loan-rate-change';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useChartDateFormat } from '@/hooks/useChartDateFormat';
import { LoanRateEditing } from './useLoanRateEditing';
import { ScheduleTableRow, DisplayRow } from './ScheduleTableRow';

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
  | { kind: 'group'; monthKey: string; aggregate: DisplayRow; children: DisplayRow[] };

const sumField = (rows: DisplayRow[], field: keyof DisplayRow): number =>
  rows.reduce((acc, row) => acc + Math.round(Number(row[field]) * 10000), 0) / 10000;

/** Whole days between two yyyy-MM-dd keys, timezone-safe. */
function daysBetween(aKey: string, bKey: string): number {
  const a = new Date(`${aKey}T00:00:00Z`).getTime();
  const b = new Date(`${bKey}T00:00:00Z`).getTime();
  return Math.round((b - a) / (1000 * 60 * 60 * 24));
}

/**
 * The set of historical payment dates that follow a gap -- a stretch longer
 * than ~1.8x the typical interval between payments, i.e. one or more expected
 * installments with no recorded payment (a payment holiday, or missing data).
 * The row on such a date is flagged so the schedule can highlight it. Needs at
 * least three payments to establish a median interval; returns empty otherwise.
 */
function datesFollowingAGap(dateKeys: string[]): Set<string> {
  const flagged = new Set<string>();
  const dates = [...dateKeys].sort();
  if (dates.length < 3) return flagged;
  const gaps: number[] = [];
  for (let i = 1; i < dates.length; i++) gaps.push(daysBetween(dates[i - 1], dates[i]));
  const sorted = [...gaps].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  if (!(median > 0)) return flagged;
  const threshold = median * 1.8;
  for (let i = 1; i < dates.length; i++) {
    if (daysBetween(dates[i - 1], dates[i]) > threshold) flagged.add(dates[i]);
  }
  return flagged;
}

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

  const changeByDate = useMemo(
    () => new Map(rateChanges.map((change) => [change.effectiveDate, change])),
    [rateChanges],
  );

  // Historical payment dates that follow a gap (missing installments), so the
  // schedule can flag "data missing here" on the row after the gap.
  const gapDates = useMemo(
    () => datesFollowingAGap(historyEvents.map((e) => e.date.split('T')[0])),
    [historyEvents],
  );

  const rows = useMemo((): DisplayRow[] => {
    const historical = historyEvents.map((event, index) => {
      const isOverpayment = event.type === 'OVERPAYMENT';
      return {
        paymentNumber: index + 1,
        date: event.date,
        payment: event.principal + event.interest,
        // A standalone overpayment is entirely extra principal, not a scheduled
        // installment, so surface its amount in the extra-principal column
        // rather than the regular principal column.
        principal: isOverpayment ? 0 : event.principal,
        interest: event.interest,
        extraPrincipal: isOverpayment ? event.principal : 0,
        balance: event.balance,
        isProjected: false,
        isOverpayment,
        annualRate: event.annualRate ?? null,
        precededByGap: gapDates.has(event.date.split('T')[0]),
        change: changeByDate.get(event.date),
      };
    });
    const projected = projectionRows.map((row, index) => {
      const previousRate = index > 0 ? projectionRows[index - 1].annualRate : row.annualRate;
      return {
        paymentNumber: historyEvents.length + row.paymentNumber,
        date: row.date,
        // Payment is the total cash that period. The schedule's `payment` is
        // principal + interest only, so add the overpayment to match the
        // historical rows (where an overpayment's amount is part of its
        // payment) -- otherwise the totals row mixes the two conventions.
        payment: row.payment + row.extraPrincipal,
        principal: row.principal,
        interest: row.interest,
        extraPrincipal: row.extraPrincipal,
        balance: row.balance,
        isProjected: true,
        annualRate: row.annualRate,
        change: changeByDate.get(row.date),
        ...(previousRate !== row.annualRate
          ? { rateChange: { from: previousRate, to: row.annualRate } }
          : {}),
      };
    });
    return [...historical, ...projected];
  }, [historyEvents, projectionRows, changeByDate, gapDates]);

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
          // The month follows a gap if its first payment does.
          precededByGap: monthRows[0].precededByGap,
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

  const headerClass =
    'px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider';
  // Faint arithmetic operators spelling out Payment = Interest + Principal
  // (+ Extra) across the money column headers.
  const operatorClass = 'text-gray-300 dark:text-gray-600 font-normal';

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden scroll-mt-4">
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
