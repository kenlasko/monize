'use client';

import { useTranslations } from 'next-intl';
import { CARD_CLASS } from '@/components/ui/Card';
import { MoneyFigure } from '@/components/ui/MoneyFigure';
import { UnknownAmount } from '@/components/ui/UnknownAmount';
import { useChartDateFormat } from '@/hooks/useChartDateFormat';
import { DayChip } from '@/components/dashboard/variants/UpcomingBillsListPebble';
import type { BillsOutlookProps } from './bills-outlook-view';


/**
 * The Pebble outlook band: an accent "next up" block for the nearest
 * occurrence (its amount set large, a pill to post it) beside fourteen day
 * chips, today inverted, a dot per occurrence.
 */
export function BillsOutlookPebble({ strip, next, onPost }: BillsOutlookProps) {
  const t = useTranslations('bills');
  const tSched = useTranslations('scheduledTransactions');
  const formatChartDate = useChartDateFormat();
  return (
    <div className="ui-bills-outlook mb-6 flex flex-col gap-3 lg:flex-row">
      {next && (
        <section
          aria-labelledby="bills-next-up"
          className="ui-block-accent ui-bills-nextup flex min-w-0 flex-col gap-1.5 rounded-[28px] bg-blue-300 p-6 text-gray-900 dark:bg-blue-400 lg:basis-[22rem] lg:flex-none"
        >
          <h2 id="bills-next-up" className="font-sans text-sm font-semibold tracking-normal sm:text-base">
            {t('outlook.nextUpOn', { date: formatChartDate(next.dueDate, 'EEEE MMMM d') })}
          </h2>
          <p className="ui-display-figure mt-1 text-2xl font-bold leading-tight tracking-tight">{next.name}</p>
          <p className="text-gray-900/75">{[next.payee, next.account].filter(Boolean).join(' · ')}</p>
          <p className="ui-display-figure mt-auto pt-4 text-5xl font-bold leading-none tracking-tight">
            {next.amount === null ? (
              <UnknownAmount />
            ) : (
              <MoneyFigure amount={Math.abs(next.amount)} currencyCode={next.currencyCode} display />
            )}
          </p>
          <div className="mt-3">
            <button
              type="button"
              onClick={() => onPost(next.transaction)}
              className="inline-flex h-11 items-center rounded-full bg-gray-900 px-5 font-semibold text-gray-50 hover:bg-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 focus-visible:ring-offset-2 focus-visible:ring-offset-blue-300 dark:focus-visible:ring-offset-blue-400"
            >
              {tSched('list.contextMenu.postTransaction')}
            </button>
          </div>
        </section>
      )}
      <section aria-labelledby="bills-days" className={`${CARD_CLASS} flex min-w-0 flex-1 flex-col p-5`}>
        <h2 id="bills-days" className="mb-3 text-base font-semibold text-gray-900 dark:text-gray-100">
          {t('outlook.title')}
        </h2>
        <div className="-mx-1 my-auto overflow-x-auto px-1 pb-1">
          <ol aria-label={t('outlook.daysLabel')} className="grid min-w-[560px] grid-cols-14 gap-1 text-center text-xs">
            {strip.days.map((day) => (
              <DayChip key={day.date} day={day} />
            ))}
          </ol>
        </div>
      </section>
    </div>
  );
}
