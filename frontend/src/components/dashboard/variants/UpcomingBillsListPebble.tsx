'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { UnknownAmount } from '@/components/ui/UnknownAmount';
import { HOVER_ROW_ON_CARD } from '@/components/ui/Card';
import { Modal } from '@/components/ui/Modal';
import { useChartDateFormat } from '@/hooks/useChartDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { InfoTooltip } from '@/components/ui/InfoTooltip';
import { SCHEDULED_KIND_AMOUNT_CLASSES, type ScheduledKind } from '@/lib/scheduled-kind';
import { NegativeBalanceLegend } from './UpcomingBillsListStandard';
import type { UpcomingBillsListProps, UpcomingStrip, UpcomingStripDay, UpcomingStripItem } from './upcoming-bills-view';

/** The signed, formatted amount a strip item shows, `unknownLabel` when it cannot be worked out. */
function stripItemAmountText(
  item: UpcomingStripItem,
  formatCurrency: (value: number, currencyCode?: string) => string,
  unknownLabel: string,
): string {
  if (item.magnitude === null) return unknownLabel;
  const sign = item.kind === 'bill' ? '-' : item.kind === 'deposit' ? '+' : '';
  return `${sign}${formatCurrency(item.magnitude, item.currencyCode)}`;
}

/** The dot a kind is marked with: filled red out, filled green in, a ring for a transfer. */
export function KindDot({ kind }: { kind: ScheduledKind }) {
  const tone =
    kind === 'bill'
      ? 'bg-red-600 dark:bg-red-400'
      : kind === 'deposit'
        ? 'bg-green-600 dark:bg-green-400'
        : 'border-2 border-gray-500 dark:border-gray-400';
  return <span aria-hidden="true" className={`block h-2 w-2 flex-shrink-0 rounded-full ${tone}`} />;
}

/**
 * A strip occurrence's dot, saying on hover, focus or tap what it is: name,
 * payee, kind and amount. It is an `InfoTooltip` with the dot as its trigger,
 * through the portal because the chips scroll sideways on a narrow screen and
 * would clip a popover drawn inside them.
 */
export function StripDot({ item }: { item: UpcomingStripItem }) {
  const t = useTranslations('dashboard');
  const tCommon = useTranslations('common');
  const { formatCurrency } = useNumberFormat();
  const amount = stripItemAmountText(item, formatCurrency, tCommon('unknownAmount.srLabel'));
  const text = [
    item.name,
    item.payee && t('upcomingBills.metaPayee', { payee: item.payee }),
    t('upcomingBills.metaWhen', { when: t(`upcomingBills.typeBadge.${item.kind}`) }),
    t('upcomingBills.metaWhen', { when: amount }),
  ]
    .filter(Boolean)
    .join(' ');
  return <InfoTooltip text={text} placement="top" usePortal trigger={<KindDot kind={item.kind} />} />;
}

/** What the day popup lists: every bill and deposit due that day, or that there is none. */
function DayOccurrencesList({ items }: { items: UpcomingStripItem[] }) {
  const t = useTranslations('dashboard');
  const tCommon = useTranslations('common');
  const { formatCurrency } = useNumberFormat();
  if (items.length === 0) {
    return <p className="text-sm text-gray-500 dark:text-gray-400">{t('upcomingBills.dayEmpty')}</p>;
  }
  return (
    <ul className="divide-y divide-gray-100 dark:divide-gray-700">
      {items.map((item) => (
        <li key={item.id} className="flex items-center gap-3 py-2.5">
          <KindDot kind={item.kind} />
          <span className="min-w-0 flex-1">
            <span className="block font-semibold text-gray-900 dark:text-gray-100">{item.name}</span>
            <span className="block text-xs text-gray-500 dark:text-gray-400">
              {[item.payee, t(`upcomingBills.typeBadge.${item.kind}`)].filter(Boolean).join(' · ')}
            </span>
          </span>
          <span className={`whitespace-nowrap text-right font-semibold ${SCHEDULED_KIND_AMOUNT_CLASSES[item.kind]}`}>
            {stripItemAmountText(item, formatCurrency, tCommon('unknownAmount.srLabel'))}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * One day chip: its weekday, day number and a dot per occurrence. Clicking
 * the date -- not a dot, too small a target to read on its own -- opens
 * every bill and deposit due that day. Shared by the dashboard widget and
 * the Bills page outlook band, which draw the same chip.
 */
export function DayChip({ day }: { day: UpcomingStripDay }) {
  const formatChartDate = useChartDateFormat();
  const [open, setOpen] = useState(false);
  const fullDate = formatChartDate(day.date, 'EEEE MMMM d');
  return (
    <li
      aria-current={day.isToday ? 'date' : undefined}
      className={`rounded-[14px] pt-2 pb-2.5 ${
        day.isToday
          ? 'bg-gray-900 text-gray-50 dark:bg-gray-100 dark:text-gray-900'
          : 'bg-gray-50 text-gray-900 dark:bg-gray-900 dark:text-gray-100'
      }`}
    >
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={fullDate}
        className="block w-full rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
      >
        <span
          aria-hidden="true"
          className={`block ${day.isToday ? 'text-gray-400 dark:text-gray-500' : 'text-gray-500 dark:text-gray-400'}`}
        >
          {formatChartDate(day.date, 'EEEEE')}
        </span>
        <span className="block text-[15px] font-bold">{formatChartDate(day.date, 'd')}</span>
      </button>
      <span className="flex h-2 justify-center gap-[3px]">
        {day.items.map((item) => (
          <StripDot key={item.id} item={item} />
        ))}
      </span>
      <Modal isOpen={open} onClose={() => setOpen(false)} title={fullDate} padding="md">
        <DayOccurrencesList items={day.items} />
      </Modal>
    </li>
  );
}

/** Fourteen day chips, today inverted, a dot per occurrence. */
function DayChips({ strip }: { strip: UpcomingStrip }) {
  const t = useTranslations('dashboard');
  return (
    <div className="-mx-1 overflow-x-auto px-1 pb-1">
      <ol aria-label={t('upcomingBills.stripLabel')} className="grid min-w-[560px] grid-cols-14 gap-1 text-center text-xs">
        {strip.days.map((day) => (
          <DayChip key={day.date} day={day} />
        ))}
      </ol>
    </div>
  );
}

/**
 * Upcoming Bills in the Pebble style: the next two weeks as day chips, then a
 * plain list, each occurrence marked with its kind's dot.
 */
export function UpcomingBillsListPebble({ rows, hiddenCount, strip, onOpen, onShowAll }: UpcomingBillsListProps) {
  const t = useTranslations('dashboard');
  const formatChartDate = useChartDateFormat();
  return (
    <>
      <DayChips strip={strip} />
      <ul className="mt-2.5">
        {rows.map((row, index) => (
          <li key={row.id} className={index > 0 ? 'border-t border-gray-100 dark:border-gray-700' : ''}>
            <button
              type="button"
              onClick={() => onOpen(row.id)}
              title={t('upcomingBills.postTransaction')}
              className="flex min-h-12 w-full items-center gap-3 rounded-xl text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            >
              <KindDot kind={row.kind} />
              <span className="min-w-0 flex-1">
                <span className="font-semibold text-gray-900 dark:text-gray-100">{row.name}</span>{' '}
                <span className="text-gray-500 dark:text-gray-400">
                  {row.payee && t('upcomingBills.metaPayee', { payee: row.payee })}{' '}
                  {t('upcomingBills.metaWhen', {
                    when: row.overdue ? row.dueLabel : formatChartDate(row.dueDate, 'EEEE'),
                  })}
                </span>
              </span>
              {row.overdraws && (
                <ExclamationTriangleIcon
                  role="img"
                  aria-label={t('upcomingBills.negativeBalanceWarning')}
                  aria-hidden={false}
                  className="h-4 w-4 flex-shrink-0 text-amber-500 dark:text-amber-400"
                />
              )}
              <span className={`whitespace-nowrap text-right font-semibold ${row.amountClass}`}>
                {row.amountText ?? <UnknownAmount />}
                {row.estimated && (
                  <span className="block text-xs font-normal text-gray-500 dark:text-gray-400">
                    {t('upcomingBills.estimated')}
                  </span>
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <NegativeBalanceLegend rows={rows} />
      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={onShowAll}
          className={`mt-2 min-h-11 w-full rounded-full text-center text-sm font-semibold text-gray-500 dark:text-gray-400 ${HOVER_ROW_ON_CARD} focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500`}
        >
          {t('upcomingBills.moreItems', { count: hiddenCount })}
        </button>
      )}
    </>
  );
}
