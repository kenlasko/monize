'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import type { GroupedTotal } from '@/types/transaction';

interface SpendingBreakdownProps {
  totals: GroupedTotal[];
  currencyCode: string;
  isLoading: boolean;
  /** Maximum rows to show. */
  limit?: number;
}

/**
 * Spending on this card for the current cycle, grouped by category. Only
 * charges (negative totals) are shown, largest first, with a proportional bar.
 */
export function SpendingBreakdown({ totals, currencyCode, isLoading, limit = 8 }: SpendingBreakdownProps) {
  const t = useTranslations('accountDetail-creditCard');
  const { formatCurrency } = useNumberFormat();

  const rows = useMemo(() => {
    const spend = totals
      .map((g) => ({ name: g.name, amount: Math.max(0, -Number(g.total) || 0) }))
      .filter((g) => g.amount > 0)
      .sort((a, b) => b.amount - a.amount)
      .slice(0, limit);
    const max = spend.reduce((m, g) => Math.max(m, g.amount), 0);
    return { spend, max };
  }, [totals, limit]);

  return (
    <section>
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
        {t('spending.title')}
      </h2>
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        {isLoading ? (
          <div className="h-24 rounded bg-gray-100 dark:bg-gray-700 animate-pulse" />
        ) : rows.spend.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-4">
            {t('spending.empty')}
          </p>
        ) : (
          <ul className="space-y-3">
            {rows.spend.map((g, i) => (
              <li key={`${g.name ?? 'uncategorised'}-${i}`}>
                <div className="flex items-center justify-between text-sm mb-1">
                  <span className="text-gray-700 dark:text-gray-200 truncate">
                    {g.name ?? t('spending.uncategorised')}
                  </span>
                  <span className="font-medium text-gray-900 dark:text-gray-100 tabular-nums">
                    {formatCurrency(g.amount, currencyCode)}
                  </span>
                </div>
                <div className="h-2 rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-blue-500 dark:bg-blue-400"
                    style={{ width: `${rows.max > 0 ? (g.amount / rows.max) * 100 : 0}%` }}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
