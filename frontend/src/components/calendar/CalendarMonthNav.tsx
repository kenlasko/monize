'use client';

import { useCallback, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronLeftIcon, ChevronRightIcon } from '@heroicons/react/24/outline';
import { CalendarMonthPicker } from '@/components/calendar/CalendarMonthPicker';
import { HOVER_ROW_ON_PAGE } from '@/components/ui/Card';
import { useDateFormat } from '@/hooks/useDateFormat';
import { monthOf, shiftMonth } from '@/lib/calendar-month';

interface CalendarMonthNavProps {
  /** `YYYY-MM`. */
  month: string;
  onMonthChange: (month: string) => void;
  /** The server's financial today; the Today button goes to its month. */
  today: string;
  /** Id for the month heading, so a grid can be named by its month. */
  monthLabelId?: string;
}

const NAV_BUTTON =
  `p-1 sm:p-1.5 rounded-md text-gray-600 dark:text-gray-300 ${HOVER_ROW_ON_PAGE} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500`;

const TODAY_BUTTON =
  'ml-0.5 sm:ml-1 px-2 sm:px-3 py-1 text-sm font-medium rounded-md border transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ' +
  `border-gray-300 text-gray-600 dark:border-gray-600 dark:text-gray-400 ${HOVER_ROW_ON_PAGE}`;

/**
 * A month calendar's navigation: the arrows, the month (a button that opens
 * `CalendarMonthPicker`, where a month can be typed or picked) and Today.
 *
 * One component so every month calendar names its month the same way, in the
 * reader's month format, and jumps to a distant month the same way.
 */
export function CalendarMonthNav({ month, onMonthChange, today, monthLabelId }: CalendarMonthNavProps) {
  const t = useTranslations('calendar');
  const common = useTranslations('common');
  const { formatMonth } = useDateFormat();

  const monthButtonRef = useRef<HTMLButtonElement>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const jumpTo = useCallback(
    (next: string) => {
      onMonthChange(next);
      setPickerOpen(false);
    },
    [onMonthChange],
  );

  return (
    <div className="flex items-center gap-0.5 sm:gap-1">
      <button
        type="button"
        className={NAV_BUTTON}
        // The same two words the date picker's own month arrows carry:
        // one catalog entry, so every surface says it the same way.
        aria-label={common('dateInput.previousMonth')}
        onClick={() => onMonthChange(shiftMonth(month, -1))}
      >
        <ChevronLeftIcon className="w-5 h-5" />
      </button>
      {/* The month is a control, not a caption: stepping from June 2026 to
          March 1998 is 339 clicks on the arrows beside it. The heading stays
          the grid's accessible name, so the button lives inside it rather
          than replacing it. Below `sm` it takes only its text's width and
          the arrows and Today close up on it, so the view switch, the month
          and Today share one line on a phone. */}
      <h2
        id={monthLabelId}
        className="text-base font-semibold text-gray-900 dark:text-gray-100"
      >
        <button
          ref={monthButtonRef}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={pickerOpen}
          onClick={() => setPickerOpen((open) => !open)}
          title={t('monthPicker.title')}
          className={`sm:min-w-[9rem] rounded-md px-1 sm:px-2 py-1 text-center ${HOVER_ROW_ON_PAGE} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500`}
        >
          {formatMonth(month)}
        </button>
      </h2>
      {pickerOpen && (
        <CalendarMonthPicker
          month={month}
          onSelect={jumpTo}
          onClose={() => setPickerOpen(false)}
          anchorRef={monthButtonRef}
        />
      )}
      <button
        type="button"
        className={NAV_BUTTON}
        aria-label={common('dateInput.nextMonth')}
        onClick={() => onMonthChange(shiftMonth(month, 1))}
      >
        <ChevronRightIcon className="w-5 h-5" />
      </button>
      <button
        type="button"
        className={TODAY_BUTTON}
        onClick={() => onMonthChange(monthOf(today))}
      >
        {common('calendar.today')}
      </button>
    </div>
  );
}
