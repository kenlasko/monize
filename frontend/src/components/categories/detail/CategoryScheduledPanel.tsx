'use client';

import { useTranslations } from 'next-intl';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import type { NextScheduledItem } from '@/lib/scheduled-utils';
import { UnknownAmount } from '@/components/ui/UnknownAmount';

interface CategoryScheduledPanelProps {
  /** Upcoming scheduled bills/deposits in this category's subtree, soonest first. */
  items: NextScheduledItem[];
  isLoading: boolean;
}

/**
 * What this category is already committed to: the next occurrence of each
 * scheduled bill or deposit filed in the category or its subcategories.
 * Amounts stay in each schedule's own currency -- a projection is not a total,
 * so nothing here is summed.
 */
export function CategoryScheduledPanel({ items, isLoading }: CategoryScheduledPanelProps) {
  const t = useTranslations('categoryDetail');
  const { formatDate } = useDateFormat();
  const { formatCurrency } = useNumberFormat();

  return (
    <section>
      <div className="mb-4">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {t('scheduledPanel.title')}
        </h2>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t('scheduledPanel.subtitle')}
        </p>
      </div>
      <div className="rounded-lg bg-white p-4 shadow dark:bg-gray-800 dark:shadow-gray-700/50">
        {isLoading ? (
          <div className="h-24 animate-pulse skeleton-shimmer rounded bg-gray-100 dark:bg-gray-700" />
        ) : items.length === 0 ? (
          <p className="py-4 text-center text-sm text-gray-500 dark:text-gray-400">
            {t('scheduledPanel.empty')}
          </p>
        ) : (
          <ul className="space-y-3">
            {items.map((item, index) => (
              <li
                key={`${item.date}-${item.payeeName ?? ''}-${index}`}
                className="flex items-baseline justify-between gap-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm text-gray-900 dark:text-gray-100">
                    {item.payeeName ?? t('scheduledPanel.noPayee')}
                  </p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {formatDate(item.date)}
                  </p>
                </div>
                <p
                  className={`whitespace-nowrap text-sm font-semibold ${
                    item.amount !== null && item.amount < 0
                      ? 'text-red-600 dark:text-red-400'
                      : 'text-green-600 dark:text-green-400'
                  }`}
                >
                  {/* An occurrence whose current amount could not be resolved is
                      shown as unavailable, never as its stale stored figure or a
                      measured zero (issue #1247). */}
                  {item.amount === null ? (
                    <UnknownAmount />
                  ) : (
                    formatCurrency(Math.abs(item.amount), item.currencyCode)
                  )}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
