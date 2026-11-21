'use client';

import { useTranslations } from 'next-intl';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { UnknownAmount } from '@/components/ui/UnknownAmount';
import { HOVER_ROW_ON_CARD } from '@/components/ui/Card';
import type { UpcomingBillsListProps } from './upcoming-bills-view';
import { activateOnKey } from '@/components/ui/interactive-row';

/** Upcoming Bills' list view in the Standard style: one bordered tile per occurrence. */
export function UpcomingBillsListStandard({ rows, hiddenCount, onOpen, onShowAll }: UpcomingBillsListProps) {
  const t = useTranslations('dashboard');
  return (
    <>
      <div className="space-y-2 sm:space-y-3">
        {rows.map((row) => (
          <div
            key={row.id}
            role="button"
            tabIndex={0}
            onClick={() => onOpen(row.id)}
            onKeyDown={activateOnKey(() => onOpen(row.id))}
            title={t('upcomingBills.postTransaction')}
            className={`flex items-center justify-between p-2 sm:p-3 rounded-lg border cursor-pointer hover:border-blue-400 dark:hover:border-blue-500 ${HOVER_ROW_ON_CARD} focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
              row.overdue
                ? 'border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/10'
                : 'border-gray-200 dark:border-gray-700'
            }`}
          >
            <div className="flex items-center gap-2 sm:gap-3 min-w-0">
              <span className={`px-2 py-1 text-xs font-medium rounded ${row.dueClass}`}>{row.dueLabel}</span>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="font-medium text-gray-900 dark:text-gray-100 truncate">{row.name}</span>
                  <span className="hidden sm:inline">{row.typeBadge}</span>
                  {row.manual && (
                    <span className="hidden sm:inline px-1.5 py-0.5 bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400 text-xs rounded">
                      {t('upcomingBills.manual')}
                    </span>
                  )}
                </div>
                {row.payee && <div className="text-xs text-gray-500 dark:text-gray-400">{row.payee}</div>}
              </div>
            </div>
            <div className="flex items-center gap-1 ml-2">
              {row.overdraws && (
                // Named for a screen reader; the legend under the list says
                // what the mark means, where a phone can read it too.
                <ExclamationTriangleIcon
                  role="img"
                  aria-label={t('upcomingBills.negativeBalanceWarning')}
                  aria-hidden={false}
                  className="w-4 h-4 flex-shrink-0 text-amber-500 dark:text-amber-400"
                />
              )}
              <div className={`font-semibold ${row.amountClass} whitespace-nowrap text-right`}>
                {row.amountText ?? <UnknownAmount />}
                {/* The history estimate, said as one (issue #2096). */}
                {row.estimated && (
                  <div className="text-xs font-normal text-gray-500 dark:text-gray-400">
                    {t('upcomingBills.estimated')}
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
      <NegativeBalanceLegend rows={rows} />
      {hiddenCount > 0 && (
        <button
          onClick={onShowAll}
          className="mt-2 w-full text-center text-sm text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-300"
        >
          {t('upcomingBills.moreItems', { count: hiddenCount })}
        </button>
      )}
    </>
  );
}

/** What the warning mark means, under any list that shows one. */
export function NegativeBalanceLegend({ rows }: { rows: UpcomingBillsListProps['rows'] }) {
  const t = useTranslations('dashboard');
  if (!rows.some((row) => row.overdraws)) return null;
  return (
    <p className="mt-2 flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
      <ExclamationTriangleIcon aria-hidden="true" className="w-4 h-4 flex-shrink-0 text-amber-500 dark:text-amber-400" />
      {t('upcomingBills.negativeBalanceLegend')}
    </p>
  );
}
