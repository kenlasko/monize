'use client';

import { format } from 'date-fns';
import { useTranslations } from 'next-intl';
import { ScheduledTransaction } from '@/types/scheduled-transaction';
import { SCHEDULED_KIND_CHIP_CLASSES, occurrenceKind } from '@/lib/scheduled-kind';
import { scheduleSpending } from '@/lib/scheduled-effective-amount';
import type { ScheduledCalendarDay } from '@/lib/scheduled-calendar';

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

/**
 * What a schedule's next occurrence IS, for the chip's colour.
 *
 * Classified from the occurrence rather than from the stored sign, so a
 * re-priced inflow is not painted red beside a green number. `occurrenceKind`
 * falls back to the schedule's sign when the occurrence cannot be priced, so an
 * unpriceable bill stays a bill rather than becoming a zero-amount reminder.
 */
function chipKind(st: ScheduledTransaction) {
  return occurrenceKind(scheduleSpending(st), st);
}

interface ScheduledCalendarGridProps {
  days: ScheduledCalendarDay[];
  /** Called with the schedule behind a chip the user clicked. */
  onSelect: (st: ScheduledTransaction) => void;
  /** How many chips a day shows before the rest become a "+N more" line. */
  maxChipsPerDay?: number;
  /** Tailwind min-height for a day cell; the widget's grid is shorter. */
  dayMinHeightClass?: string;
}

/**
 * The month grid shared by the Bills & Deposits calendar and the Upcoming Bills
 * widget. `buildScheduledCalendarDays` decides what falls on which day; this
 * draws it.
 */
export function ScheduledCalendarGrid({
  days,
  onSelect,
  maxChipsPerDay = 3,
  dayMinHeightClass = 'min-h-[100px]',
}: ScheduledCalendarGridProps) {
  const t = useTranslations('bills');
  return (
    <div className="ui-cal overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700">
      <div className="grid grid-cols-7">
        {WEEKDAYS.map((day) => (
          <div
            key={day}
            className="ui-cal-dow px-1 py-2 text-center text-xs sm:text-sm font-medium text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700"
          >
            {t(`calendar.days.${day}`)}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {days.map((day) => (
          <div
            key={day.date.toISOString()}
            data-today={day.isToday || undefined}
            data-outside={!day.isCurrentMonth || undefined}
            className={`ui-cal-cell ${dayMinHeightClass} p-1 border-b border-r border-gray-200 dark:border-gray-700 ${
              day.isCurrentMonth
                ? 'bg-white dark:bg-gray-800'
                : 'bg-gray-50 dark:bg-gray-900/50'
            }`}
          >
            <div
              className={`ui-cal-num text-sm font-medium mb-1 w-7 h-7 flex items-center justify-center rounded-full ${
                day.isToday
                  ? 'bg-blue-600 text-white'
                  : day.isCurrentMonth
                    ? 'text-gray-900 dark:text-gray-100'
                    : 'text-gray-400 dark:text-gray-600'
              }`}
            >
              {format(day.date, 'd')}
            </div>
            <div className="space-y-0.5">
              {day.bills.slice(0, maxChipsPerDay).map((bill, index) => (
                <button
                  key={`${bill.id}-${index}`}
                  type="button"
                  onClick={() => onSelect(bill)}
                  data-kind={chipKind(bill)}
                  className={`ui-cal-chip block w-full px-1 py-0.5 text-xs rounded truncate text-left transition-opacity motion-reduce:transition-none hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                    SCHEDULED_KIND_CHIP_CLASSES[chipKind(bill)]
                  }`}
                >
                  {bill.name}
                </button>
              ))}
              {day.bills.length > maxChipsPerDay && (
                <div className="text-xs text-gray-500 dark:text-gray-400 px-1">
                  {t('calendar.more', { count: day.bills.length - maxChipsPerDay })}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
