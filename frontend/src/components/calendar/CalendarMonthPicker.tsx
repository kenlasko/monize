'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslations } from 'next-intl';
import { ChevronLeftIcon, ChevronRightIcon } from '@heroicons/react/24/outline';
import { useClickOutside } from '@/hooks/useClickOutside';
import { parseMonthInput } from '@/lib/month-input';
import { SEGMENT_BASE_CLASS } from '@/components/ui/segmented-control';
import { HOVER_ROW_ON_CARD } from '@/components/ui/Card';
import { inputBaseClasses } from '@/lib/utils';

interface CalendarMonthPickerProps {
  /** The month the calendar is on, `YYYY-MM`. */
  month: string;
  onSelect: (month: string) => void;
  onClose: () => void;
  /** The heading button the panel hangs under. */
  anchorRef: React.RefObject<HTMLElement | null>;
}

/** Enough room for the field, the year stepper and three rows of months. */
const PANEL_HEIGHT = 220;
const PANEL_WIDTH = 260;

const MONTH_BUTTON = `${SEGMENT_BASE_CLASS} w-full text-center`;
const MONTH_ON = 'bg-blue-600 text-white';
const MONTH_OFF = `text-gray-700 dark:text-gray-200 ${HOVER_ROW_ON_CARD}`;

const STEP_BUTTON =
  `p-1 rounded text-gray-600 dark:text-gray-300 ${HOVER_ROW_ON_CARD} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500`;

/**
 * Jump the calendar to another month: type one, or pick one.
 *
 * Twelve buttons and a year stepper reach next spring in one click and March
 * 1998 in eighty, which is why the field is first and focused: someone who
 * knows the month they want types it, and someone browsing clicks. The field
 * reads what a person would actually type (`parseMonthInput`) rather than one
 * canonical shape, and a year it cannot read is reported at the field instead
 * of quietly moving the calendar somewhere else.
 *
 * The month labels are the reader's own, taken from the same `common.monthsShort`
 * catalogue the date popover and the month grid draw, so the buttons and what
 * the field accepts are the same twelve words.
 */
export function CalendarMonthPicker({
  month,
  onSelect,
  onClose,
  anchorRef,
}: CalendarMonthPickerProps) {
  const t = useTranslations('calendar');
  const common = useTranslations('common');
  const monthLabels = common.raw('monthsShort') as string[];

  const panelRef = useRef<HTMLDivElement>(null);
  const fieldId = useId();
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const [draft, setDraft] = useState('');
  const [invalid, setInvalid] = useState(false);
  // The year the buttons below are for. It starts on the calendar's own month
  // and moves with the stepper, so picking a month is two clicks from any year
  // without the calendar jumping under the reader on the first of them.
  const [viewYear, setViewYear] = useState(() => Number(month.slice(0, 4)));

  useEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const gap = 4;
    let left = rect.left + rect.width / 2 - PANEL_WIDTH / 2;
    if (left + PANEL_WIDTH > window.innerWidth - 8) left = window.innerWidth - PANEL_WIDTH - 8;
    if (left < 8) left = 8;

    const spaceBelow = window.innerHeight - rect.bottom;
    let top = rect.bottom + gap;
    if (spaceBelow < PANEL_HEIGHT + gap + 8 && rect.top > spaceBelow) {
      top = Math.max(8, rect.top - PANEL_HEIGHT - gap);
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time position derived from the mounted anchor's DOM rect
    setPosition({ top, left });
  }, [anchorRef]);

  // The anchor counts as inside: the heading button is what opened the panel
  // and toggles it, and a mousedown-close that fired first would leave the
  // button's own click re-opening what the reader just asked to shut.
  useClickOutside([panelRef, anchorRef], onClose, { onEscape: onClose });

  const commitTyped = useCallback(() => {
    const parsed = parseMonthInput(draft, monthLabels, month);
    if (parsed === null) {
      setInvalid(true);
      return;
    }
    onSelect(parsed);
    onClose();
  }, [draft, monthLabels, month, onSelect, onClose]);

  const pick = useCallback(
    (monthNumber: number) => {
      onSelect(`${String(viewYear).padStart(4, '0')}-${String(monthNumber).padStart(2, '0')}`);
      onClose();
    },
    [viewYear, onSelect, onClose],
  );

  if (!position) return null;

  const selectedMonthNumber =
    viewYear === Number(month.slice(0, 4)) ? Number(month.slice(5, 7)) : null;

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={t('monthPicker.title')}
      className="fixed z-50 rounded-lg border border-gray-200 bg-white p-3 shadow-xl dark:border-gray-600 dark:bg-gray-800"
      style={{ top: position.top, left: position.left, width: PANEL_WIDTH }}
    >
      <label
        htmlFor={fieldId}
        className="block text-xs font-medium text-gray-700 dark:text-gray-300"
      >
        {t('monthPicker.typeLabel')}
      </label>
      <input
        id={fieldId}
        autoFocus
        type="text"
        inputMode="text"
        value={draft}
        placeholder={t('monthPicker.placeholder')}
        aria-invalid={invalid}
        aria-describedby={invalid ? `${fieldId}-error` : undefined}
        onChange={(event) => {
          setDraft(event.target.value);
          setInvalid(false);
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          commitTyped();
        }}
        className={`${inputBaseClasses} mt-1 py-1 text-sm`}
      />
      {invalid && (
        <p id={`${fieldId}-error`} role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">
          {t('monthPicker.unreadable')}
        </p>
      )}

      <div className="mt-3 flex items-center justify-between">
        <button
          type="button"
          className={STEP_BUTTON}
          aria-label={t('monthPicker.previousYear')}
          onClick={() => setViewYear((year) => year - 1)}
        >
          <ChevronLeftIcon className="w-4 h-4" />
        </button>
        <span
          className="text-sm font-semibold tabular-nums text-gray-900 dark:text-gray-100"
          aria-live="polite"
        >
          {viewYear}
        </span>
        <button
          type="button"
          className={STEP_BUTTON}
          aria-label={t('monthPicker.nextYear')}
          onClick={() => setViewYear((year) => year + 1)}
        >
          <ChevronRightIcon className="w-4 h-4" />
        </button>
      </div>

      <div className="mt-2 grid grid-cols-3 gap-1">
        {monthLabels.map((label, index) => {
          const monthNumber = index + 1;
          const isSelected = selectedMonthNumber === monthNumber;
          return (
            <button
              key={label}
              type="button"
              aria-pressed={isSelected}
              onClick={() => pick(monthNumber)}
              className={`${MONTH_BUTTON} ${isSelected ? MONTH_ON : MONTH_OFF}`}
            >
              {label}
            </button>
          );
        })}
      </div>
    </div>,
    document.body,
  );
}
