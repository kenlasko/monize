'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { LoanRateChange } from '@/types/loan-rate-change';
import { Account } from '@/types/account';
import { chartColors } from '@/lib/chart-colors';
import { ChartTooltip } from '@/components/reports/ChartTooltip';
import { useChartDateFormat } from '@/hooks/useChartDateFormat';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { LoanRateControls } from './LoanRateControls';
import { LoanRateEditing } from './useLoanRateEditing';

interface RateHistorySidebarProps {
  account: Account;
  /** Recorded rate history (loan_rate_changes), oldest first or any order. */
  rateChanges: LoanRateChange[];
  /** Shared rate-timeline editing (add / edit / delete / detect). */
  editing: LoanRateEditing;
  /** Last payment date, to extend the final rate to the end of the chart. */
  endDate: string | null;
}

/**
 * The Rate History panel for the loan detail page: a step chart of the interest
 * rate over the loan's life on top, and the recorded rate changes below --
 * effective date, rate, source badge (initial / inferred), and the payment in
 * effect -- each editable, with "Detect from history" and "Add rate change".
 * Because the rate changes far less often than payments happen, this is a dozen
 * rows instead of hundreds. Sits beside the overpayment simulator on wide
 * screens and stacks below it on narrow ones.
 */
export function RateHistorySidebar({
  account,
  rateChanges,
  editing,
  endDate,
}: RateHistorySidebarProps) {
  const t = useTranslations('accounts');
  const formatChartDate = useChartDateFormat();
  const { formatDate } = useDateFormat();
  const { formatCurrency } = useNumberFormat();

  const sorted = useMemo(
    () => [...rateChanges].sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate)),
    [rateChanges],
  );

  const chartData = useMemo(() => {
    if (sorted.length === 0) return [];
    const rows = sorted.map((r) => ({ dateKey: r.effectiveDate, rate: r.annualRate }));
    // Hold the last recorded rate out to the end of the timeline so the final
    // step is visible rather than collapsing to a single point.
    const last = sorted[sorted.length - 1];
    if (endDate && endDate > last.effectiveDate) {
      rows.push({ dateKey: endDate, rate: last.annualRate });
    }
    return rows.map((r) => ({ ...r, label: formatChartDate(r.dateKey, 'MMM yyyy') }));
  }, [sorted, endDate, formatChartDate]);

  const sourceBadge = (change: LoanRateChange) => {
    if (change.source === 'inferred') {
      return (
        <span className="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
          {t('loanDetail.rateHistory.badgeInferred')}
        </span>
      );
    }
    if (change.source === 'initial') {
      return (
        <span className="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300">
          {t('loanDetail.rateHistory.badgeInitial')}
        </span>
      );
    }
    return null;
  };

  const paymentLabel = (change: LoanRateChange) =>
    change.newPaymentAmount != null
      ? formatCurrency(change.newPaymentAmount, account.currencyCode)
      : t('loanDetail.rateHistory.paymentUnchanged');

  return (
    <div
      id="rate-history"
      className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4 flex flex-col gap-4 scroll-mt-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
            {t('loanDetail.rateHistory.title')}
          </h3>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {t('loanDetail.rateHistory.description')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={editing.openDetect}
            isLoading={editing.isDetecting}
          >
            {t('loanDetail.rateHistory.detect')}
          </Button>
          {/* Add button + the add/edit/delete/scheduled-payment modals. */}
          <LoanRateControls editing={editing} />
        </div>
      </div>

      {sorted.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t('loanDetail.rateHistory.empty')}
        </p>
      ) : (
        <>
          <div className="h-48">
            <ResponsiveContainer width="100%" height="100%" minWidth={0}>
              <LineChart data={chartData} margin={{ top: 5, right: 12, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
                <YAxis
                  tick={{ fontSize: 12 }}
                  width={44}
                  domain={['auto', 'auto']}
                  tickFormatter={(v) => `${v}%`}
                />
                <Tooltip
                  content={<ChartTooltip formatValue={(value) => `${value.toFixed(2)}%`} />}
                />
                <Line
                  type="stepAfter"
                  dataKey="rate"
                  stroke={chartColors.primary}
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4 }}
                  name={t('loanDetail.rateHistory.title')}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>

          <ul className="divide-y divide-gray-200 dark:divide-gray-700">
            {sorted.map((change) => (
              <li
                key={change.id}
                className="py-2 flex flex-wrap items-center justify-between gap-2"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100 flex items-center gap-2">
                    <span>{formatDate(change.effectiveDate)}</span>
                    <span className="text-blue-600 dark:text-blue-400">
                      {t('loanDetail.rateHistory.rateValue', { rate: change.annualRate })}
                    </span>
                    {sourceBadge(change)}
                  </p>
                  <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
                    {t('loanDetail.rateHistory.paymentSummary', { payment: paymentLabel(change) })}
                    {change.note ? ` — ${change.note}` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button variant="ghost" size="sm" onClick={() => editing.openEdit(change)}>
                    {t('loanDetail.rateHistory.edit')}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => editing.requestDelete(change)}>
                    {t('loanDetail.rateHistory.delete')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      <ConfirmDialog
        isOpen={editing.showDetectConfirm}
        title={t('loanDetail.rateHistory.detectTitle')}
        message={t('loanDetail.rateHistory.detectMessage')}
        confirmLabel={t('loanDetail.rateHistory.detect')}
        cancelLabel={t('loanDetail.rateHistory.cancel')}
        onConfirm={editing.runDetect}
        onCancel={editing.cancelDetect}
      />
    </div>
  );
}
