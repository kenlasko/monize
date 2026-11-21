'use client';

import { useTranslations } from 'next-intl';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { UnknownAmount } from '@/components/ui/UnknownAmount';
import { HOVER_ROW_ON_PAGE } from '@/components/ui/Card';
import { useChartDateFormat } from '@/hooks/useChartDateFormat';
import { chartColors } from '@/lib/chart-colors';
import { NegativeBalanceLegend } from './UpcomingBillsListStandard';
import {
  stripBarHeight,
  type UpcomingBillsListProps,
  type UpcomingStrip,
  type UpcomingStripItem,
} from './upcoming-bills-view';

const BAR_MAX_PX = 52;
const BAR_UNSCALED_PX = 20;

function barHeight(item: UpcomingStripItem, scaleMax: number | null): number {
  return stripBarHeight(item, scaleMax, BAR_MAX_PX, BAR_UNSCALED_PX);
}

/**
 * The fourteen days as a bar strip: money in rises above the line, bills hang
 * below it, a transfer is an outline. Decorative beside the list under it,
 * which carries every figure, so the strip is one image with a summary name.
 */
function InOutStrip({ strip }: { strip: UpcomingStrip }) {
  const t = useTranslations('dashboard');
  const formatChartDate = useChartDateFormat();
  // Nothing coming in: the half above the line keeps only a sliver.
  const anyIn = strip.days.some((day) => day.items.some((i) => i.kind === 'deposit'));
  return (
    <div role="img" aria-label={t('upcomingBills.stripLabel')} className="mt-3 mb-1 grid grid-cols-14 gap-px">
      {strip.days.map((day) => {
        const ins = day.items.filter((i) => i.kind === 'deposit');
        const outs = day.items.filter((i) => i.kind !== 'deposit');
        return (
          <div key={day.date} className="flex min-w-0 flex-col items-center">
            <div className={`flex items-end gap-0.5 ${anyIn ? 'h-14' : 'h-2'}`}>
              {ins.map((item) => (
                <span
                  key={item.id}
                  className="block w-2"
                  style={{ height: barHeight(item, strip.scaleMax), backgroundColor: chartColors.income }}
                />
              ))}
            </div>
            <div className="flex h-14 w-full items-start justify-center gap-0.5 border-t border-gray-300 dark:border-gray-600">
              {outs.map((item) =>
                item.kind === 'bill' ? (
                  <span
                    key={item.id}
                    className="block w-2"
                    style={{ height: barHeight(item, strip.scaleMax), backgroundColor: chartColors.expense }}
                  />
                ) : (
                  <span
                    key={item.id}
                    className="block w-2 border border-gray-400 dark:border-gray-500"
                    style={{ height: barHeight(item, strip.scaleMax) }}
                  />
                ),
              )}
            </div>
            <span
              className={`mt-1 text-[11px] tabular-nums ${
                day.isToday ? 'text-blue-600 dark:text-blue-400' : 'text-gray-500 dark:text-gray-400'
              }`}
            >
              {day.isToday ? t('upcomingBills.today') : formatChartDate(day.date, 'd')}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Upcoming Bills in the Folio style: the in/out strip over a ruled list,
 * one line per occurrence, its day printed once at the head of the day.
 */
export function UpcomingBillsListFolio({ rows, hiddenCount, strip, onOpen, onShowAll }: UpcomingBillsListProps) {
  const t = useTranslations('dashboard');
  const formatChartDate = useChartDateFormat();
  return (
    <>
      <InOutStrip strip={strip} />
      <ul className="border-b border-gray-200 dark:border-gray-700">
        {rows.map((row, index) => {
          const firstOfDay = index === 0 || rows[index - 1].dueDate !== row.dueDate;
          return (
            <li key={row.id} className="border-t border-gray-200 dark:border-gray-700">
              <button
                type="button"
                onClick={() => onOpen(row.id)}
                title={t('upcomingBills.postTransaction')}
                className={`flex w-full items-baseline gap-4 py-2.5 text-left ${HOVER_ROW_ON_PAGE} focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500`}
              >
                <span
                  className={`w-16 flex-shrink-0 text-[13px] ${
                    row.overdue
                      ? 'text-red-600 dark:text-red-400'
                      : index === 0
                        ? 'text-blue-600 dark:text-blue-400'
                        : 'text-gray-500 dark:text-gray-400'
                  }`}
                >
                  {firstOfDay && (row.overdue ? row.dueLabel : formatChartDate(row.dueDate, 'EEE d'))}
                </span>
                <span className="min-w-0 flex-1 font-medium text-gray-900 dark:text-gray-100">
                  {row.name}
                  {row.payee && (
                    <span className="font-normal text-gray-500 dark:text-gray-400">
                      {' '}
                      {t('upcomingBills.metaPayee', { payee: row.payee })}
                    </span>
                  )}
                  {row.manual && (
                    <span className="font-normal text-gray-500 max-sm:hidden dark:text-gray-400">
                      {' '}
                      {t('upcomingBills.metaManual')}
                    </span>
                  )}
                </span>
                {row.overdraws && (
                  <ExclamationTriangleIcon
                    role="img"
                    aria-label={t('upcomingBills.negativeBalanceWarning')}
                    aria-hidden={false}
                    className="h-4 w-4 flex-shrink-0 self-center text-amber-500 dark:text-amber-400"
                  />
                )}
                <span className={`whitespace-nowrap text-right ${row.amountClass}`}>
                  {row.amountText ?? <UnknownAmount />}
                  {row.estimated && (
                    <span className="block text-xs text-gray-500 dark:text-gray-400">
                      {t('upcomingBills.estimated')}
                    </span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <NegativeBalanceLegend rows={rows} />
      {hiddenCount > 0 && (
        <div className="pt-3 text-[13px]">
          <button
            type="button"
            onClick={onShowAll}
            className="text-blue-600 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-blue-400"
          >
            {t('upcomingBills.moreItems', { count: hiddenCount })}
          </button>
        </div>
      )}
    </>
  );
}
