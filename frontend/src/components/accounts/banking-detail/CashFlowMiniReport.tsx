'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useChartDateFormat } from '@/hooks/useChartDateFormat';
import type { MonthlyTotal } from '@/types/transaction';

interface CashFlowMiniReportProps {
  monthly: MonthlyTotal[];
  currencyCode: string;
  isLoading: boolean;
}

/**
 * Trailing-12-month net cash-flow bars for an account. Each month's net total
 * is drawn from a centre line -- inflows to the right (green), outflows to the
 * left (red).
 */
export function CashFlowMiniReport({ monthly, currencyCode, isLoading }: CashFlowMiniReportProps) {
  const t = useTranslations('accountDetail-banking');
  const { formatCurrency } = useNumberFormat();
  const formatChartDate = useChartDateFormat();
  // A `YYYY-MM` key as a short month in the reader's language ("Jan 26").
  const monthLabel = (month: string): string =>
    /^\d{4}-\d{2}$/.test(month) ? formatChartDate(`${month}-01`, 'MMM yy') : month;

  const { rows, max } = useMemo(() => {
    const ranked = [...monthly].sort((a, b) => a.month.localeCompare(b.month));
    const m = ranked.reduce(
      (acc, r) => Math.max(acc, r.total === null ? 0 : Math.abs(Number(r.total))),
      0,
    );
    return { rows: ranked, max: m };
  }, [monthly]);

  return (
    <section>
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-1">
        {t('cashFlow.title')}
      </h2>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">{t('cashFlow.subtitle')}</p>
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        {isLoading ? (
          <div className="h-40 rounded bg-gray-100 dark:bg-gray-700 animate-pulse" />
        ) : rows.length === 0 || max === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-4">
            {t('cashFlow.empty')}
          </p>
        ) : (
          <ul className="space-y-2">
            {rows.map((r) => {
              const known = r.total !== null;
              const total = known ? Number(r.total) : 0;
              const width = (Math.abs(total) / max) * 50; // half-width from centre
              return (
                <li key={r.month} className="flex items-center gap-2 text-xs">
                  <span className="w-12 shrink-0 text-gray-500 dark:text-gray-400">
                    {monthLabel(r.month)}
                  </span>
                  <div className="relative flex-1 h-4">
                    <div className="absolute inset-y-0 left-1/2 w-px bg-gray-300 dark:bg-gray-600" />
                    {known && (
                      <div
                        className={`absolute inset-y-0.5 rounded ${
                          total < 0
                            ? 'bg-red-400 dark:bg-red-500'
                            : 'bg-green-400 dark:bg-green-500'
                        }`}
                        style={
                          total < 0
                            ? { right: '50%', width: `${width}%` }
                            : { left: '50%', width: `${width}%` }
                        }
                      />
                    )}
                  </div>
                  <span
                    className={`w-24 shrink-0 text-right tabular-nums ${
                      total < 0
                        ? 'text-red-600 dark:text-red-400'
                        : 'text-green-600 dark:text-green-400'
                    }`}
                  >
                    {known ? formatCurrency(total, r.currency ?? currencyCode) : '-'}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
