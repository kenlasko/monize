'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { Card } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/LoadingSkeleton';
import { Th, Td, TABLE_CLASS, TABLE_BODY_CLASS } from '@/components/ui/Table';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import type { FundingReportControls } from '@/hooks/useFundingReportControls';
import { monthlyFundsSummary } from '@/lib/monthly-funds-summary';
import type { BreakdownPeriod } from '@/lib/breakdown-period';

interface MonthlyTaggedBalanceSummaryProps {
  controls: FundingReportControls;
  /**
   * The columns the report's own table shows, in order: `YYYY-MM` months, or
   * `YYYY` years when `period` is 'year'.
   */
  months: readonly string[];
  /** The report's column width. Defaults to monthly. */
  period?: BreakdownPeriod;
}

const DASH = '—';

/**
 * The per-month Balance block under the Monthly Breakdown table
 * (`docs/specs/report-tag-key-breakdown.md` section 11.5): Income, Tagged
 * inflows, Expenses, Tagged outflows (only when a shown month has some),
 * Balance and Balance %, from the Income vs Expenses answer for the same window
 * and accounts, per month or per year as the table above is. The category rows above it never include a transfer. Renders
 * nothing unless the funding view is on.
 */
export function MonthlyTaggedBalanceSummary({
  controls,
  months,
  period = 'month',
}: MonthlyTaggedBalanceSummaryProps) {
  const t = useTranslations('reports');
  const { formatMonth } = useDateFormat();
  const { formatCurrency, formatPercent } = useNumberFormat();
  const { filter, funding } = controls;

  const summary = useMemo(
    () =>
      funding.response
        ? monthlyFundsSummary(funding.response, filter.tagValue, months)
        : null,
    [funding.response, filter.tagValue, months],
  );

  if (!filter.include) return null;

  const currency = funding.response?.currency;
  const money = (value: number | null) =>
    value === null ? DASH : formatCurrency(value, currency);
  // Balance is a subtotal under a gap: marked, never a bare figure.
  const balance = (value: number | null) =>
    value === null ? DASH : `${formatCurrency(value, currency)}${summary?.complete === false ? '*' : ''}`;
  const percent = (value: number | null) => (value === null ? DASH : formatPercent(value, 2));

  return (
    <Card padding="sm" data-testid="monthly-tagged-balance">
      <h3 className="mb-3 text-sm font-semibold text-gray-900 dark:text-gray-100">
        {period === 'year'
          ? t('tagBreakdown.yearlySummaryTitle', { value: filter.tagValue })
          : t('tagBreakdown.monthlySummaryTitle', { value: filter.tagValue })}
      </h3>
      {funding.status === 'error' ? (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">
          {t('tagBreakdown.fundsLoadFailed')}
        </p>
      ) : funding.status !== 'ready' || !summary ? (
        <Skeleton className="h-24 w-full" />
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className={TABLE_CLASS}>
              <thead>
                <tr>
                  <Th>{DASH}</Th>
                  {summary.columns.map((c) => (
                    <Th key={c.month} align="right">
                      {period === 'year' ? c.month : formatMonth(c.month)}
                    </Th>
                  ))}
                </tr>
              </thead>
              <tbody className={TABLE_BODY_CLASS}>
                <tr>
                  <Td>{t('tagBreakdown.fundsIncome')}</Td>
                  {summary.columns.map((c) => (
                    <Td key={c.month} align="right" className="text-green-600 dark:text-green-400">
                      {money(c.income)}
                    </Td>
                  ))}
                </tr>
                <tr>
                  <Td>{t('tagBreakdown.inflows')}</Td>
                  {summary.columns.map((c) => (
                    <Td key={c.month} align="right" className="text-indigo-600 dark:text-indigo-400">
                      {money(c.taggedInflows)}
                    </Td>
                  ))}
                </tr>
                <tr>
                  <Td>{t('tagBreakdown.fundsExpenses')}</Td>
                  {summary.columns.map((c) => (
                    <Td key={c.month} align="right" className="text-red-600 dark:text-red-400">
                      {money(c.expenses)}
                    </Td>
                  ))}
                </tr>
                {summary.showOutflows && (
                  <tr>
                    <Td>{t('tagBreakdown.outflows')}</Td>
                    {summary.columns.map((c) => (
                      <Td key={c.month} align="right" className="text-indigo-600 dark:text-indigo-400">
                        {money(c.taggedOutflows)}
                      </Td>
                    ))}
                  </tr>
                )}
                <tr className="font-semibold">
                  <Td>{t('tagBreakdown.balance')}</Td>
                  {summary.columns.map((c) => (
                    <Td key={c.month} align="right">
                      {balance(c.balance)}
                    </Td>
                  ))}
                </tr>
                <tr>
                  <Td>{t('tagBreakdown.balancePercent')}</Td>
                  {summary.columns.map((c) => (
                    <Td key={c.month} align="right">
                      {percent(c.balancePercent)}
                    </Td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
          {!summary.complete && (
            <p className="mt-3 text-sm text-amber-700 dark:text-amber-400">
              {summary.missingCurrencies.length > 0
                ? t('tagBreakdown.fundsPartialNote', {
                    currencies: summary.missingCurrencies.join(', '),
                  })
                : t('tagBreakdown.fundsPartialNoteGeneric')}
            </p>
          )}
        </>
      )}
    </Card>
  );
}
