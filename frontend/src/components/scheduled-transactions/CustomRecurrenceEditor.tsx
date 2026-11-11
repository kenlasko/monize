'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { Button } from '@/components/ui/Button';
import { NumericInput } from '@/components/ui/NumericInput';
import { Select } from '@/components/ui/Select';
import { SEGMENTED_GROUP_CLASS, segmentClass } from '@/components/ui/segmented-control';
import {
  CUSTOM_INTERVAL_MAX,
  CUSTOM_RECURRENCE_UNITS,
  CustomRecurrence,
  CustomRecurrenceUnit,
  LAST_DAY_OF_MONTH,
} from '@/lib/custom-recurrence';
import {
  describeCustomRecurrence,
  formatMonthDay,
  monthName,
  orderedIsoWeekdays,
  weekdayName,
} from '@/lib/custom-recurrence-label';
import { customRecurrenceErrorKey } from '@/lib/custom-recurrence-edit';

/**
 * The Custom frequency's editor (docs/specs/custom-recurrence.md section 1):
 * Weekly / Monthly / Yearly, an "Every N" box, the day picker for the unit and
 * a live summary. It holds no rule of its own: the form owns the rule, and the
 * hook beside it (`useCustomRecurrenceField`) remembers each unit's choices
 * while the user switches between them.
 */
export interface CustomRecurrenceEditorProps {
  rule: CustomRecurrence;
  onChange: (rule: CustomRecurrence) => void;
  onUnitChange: (unit: CustomRecurrenceUnit) => void;
  /** The reader's week start (0 = Sunday), which orders the weekday buttons. */
  weekStartsOn: number;
  /** Distinguishes the ids of the four modes' copies. */
  idPrefix: string;
}

const DAYS_OF_MONTH = Array.from({ length: 31 }, (_, i) => i + 1);
const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);

/** Days in `month` of a leap year: the widest a yearly date may be. */
function leapMonthLength(month: number): number {
  return new Date(Date.UTC(2024, month, 0)).getUTCDate();
}

function mmdd(month: number, day: number): string {
  return `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** A pressable day: filled when chosen, outlined when not. */
function chipClass(pressed: boolean): string {
  return `py-1 rounded-md text-sm text-center border transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
    pressed
      ? 'bg-blue-600 text-white border-blue-600 dark:bg-blue-500 dark:border-blue-500'
      : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 border-gray-300 dark:border-gray-600 hover:border-blue-400 dark:hover:border-blue-400'
  }`;
}

/**
 * The days of the month wrap seven to a row, like a week, with Last day
 * filling the rest of the fifth: a fixed chip width in a box seven chips wide
 * (2.25rem each, 0.25rem gaps). Not a calendar month, which is `MonthGrid`.
 */
const MONTH_DAYS_BOX_CLASS = 'flex flex-wrap gap-1 w-full max-w-[17.25rem]';
const MONTH_DAY_CHIP_WIDTH = 'w-9';
const LAST_DAY_CHIP_WIDTH = 'w-[9.75rem]';

function toggle(values: readonly number[] | undefined, value: number): number[] {
  const current = values ?? [];
  return current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
}

export function CustomRecurrenceEditor({
  rule,
  onChange,
  onUnitChange,
  weekStartsOn,
  idPrefix,
}: CustomRecurrenceEditorProps) {
  const t = useTranslations('scheduledTransactions');
  const locale = useLocale();
  const [pickMonth, setPickMonth] = useState(1);
  const [pickDay, setPickDay] = useState(1);
  const maxPickDay = leapMonthLength(pickMonth);
  const day = Math.min(pickDay, maxPickDay);

  const errorKey = customRecurrenceErrorKey(rule);
  const summary = errorKey ? null : describeCustomRecurrence(rule, locale, t);
  const interval = rule.interval > 0 ? rule.interval : undefined;
  const pickedDate = mmdd(pickMonth, day);
  const dates = [...(rule.dates ?? [])].sort();

  return (
    <div
      role="group"
      aria-labelledby={`${idPrefix}-custom-title`}
      className="rounded-md border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 p-3 sm:p-4 space-y-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span id={`${idPrefix}-custom-title`} className="text-sm font-medium text-gray-700 dark:text-gray-300">
          {t('customRecurrence.title')}
        </span>
        <div className={SEGMENTED_GROUP_CLASS} role="group" aria-label={t('customRecurrence.unitLabel')}>
          {CUSTOM_RECURRENCE_UNITS.map((unit) => (
            <button
              key={unit}
              type="button"
              aria-pressed={rule.unit === unit}
              onClick={() => {
                if (rule.unit !== unit) onUnitChange(unit);
              }}
              className={segmentClass(rule.unit === unit)}
            >
              {t(`customRecurrence.units.${unit}`)}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
        <span>{t('customRecurrence.every')}</span>
        <div className="w-16">
          <NumericInput
            id={`${idPrefix}-custom-interval`}
            aria-label={t('customRecurrence.intervalLabel')}
            decimalPlaces={0}
            min={1}
            max={CUSTOM_INTERVAL_MAX}
            value={interval}
            onChange={(next) => onChange({ ...rule, interval: next ?? 0 })}
          />
        </div>
        <span>{t(`customRecurrence.unitSuffix.${rule.unit}`, { interval: interval ?? 1 })}</span>
      </div>

      {rule.unit === 'WEEK' && (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('customRecurrence.weekdaysLabel')}>
          {orderedIsoWeekdays(weekStartsOn).map((weekday) => {
            const pressed = (rule.weekdays ?? []).includes(weekday);
            return (
              <button
                key={weekday}
                type="button"
                aria-pressed={pressed}
                aria-label={weekdayName(weekday, locale, 'long')}
                onClick={() => onChange({ ...rule, weekdays: toggle(rule.weekdays, weekday) })}
                className={`${chipClass(pressed)} px-2 min-w-12`}
              >
                {weekdayName(weekday, locale)}
              </button>
            );
          })}
        </div>
      )}

      {rule.unit === 'MONTH' && (
        <div className="space-y-2">
          <div className={MONTH_DAYS_BOX_CLASS} role="group" aria-label={t('customRecurrence.monthDaysLabel')}>
            {DAYS_OF_MONTH.map((d) => {
              const pressed = (rule.monthDays ?? []).includes(d);
              return (
                <button
                  key={d}
                  type="button"
                  aria-pressed={pressed}
                  onClick={() => onChange({ ...rule, monthDays: toggle(rule.monthDays, d) })}
                  className={`${chipClass(pressed)} ${MONTH_DAY_CHIP_WIDTH}`}
                >
                  {d}
                </button>
              );
            })}
            <button
              type="button"
              aria-pressed={(rule.monthDays ?? []).includes(LAST_DAY_OF_MONTH)}
              onClick={() => onChange({ ...rule, monthDays: toggle(rule.monthDays, LAST_DAY_OF_MONTH) })}
              className={`${chipClass((rule.monthDays ?? []).includes(LAST_DAY_OF_MONTH))} ${LAST_DAY_CHIP_WIDTH}`}
            >
              {t('customRecurrence.lastDayChip')}
            </button>
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400">{t('customRecurrence.monthHint')}</p>
        </div>
      )}

      {rule.unit === 'YEAR' && (
        <div className="space-y-2">
          {dates.length > 0 && (
            <ul className="flex flex-wrap gap-1.5" aria-label={t('customRecurrence.datesLabel')}>
              {dates.map((date) => (
                <li
                  key={date}
                  className="inline-flex items-center gap-1 rounded-md border border-blue-600 bg-blue-600 pl-2 pr-1 py-0.5 text-sm text-white dark:border-blue-500 dark:bg-blue-500"
                >
                  <span>{formatMonthDay(date, locale)}</span>
                  <button
                    type="button"
                    aria-label={t('customRecurrence.removeDate', { date: formatMonthDay(date, locale) })}
                    onClick={() => onChange({ ...rule, dates: dates.filter((d) => d !== date) })}
                    className="rounded p-0.5 hover:bg-blue-700 dark:hover:bg-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                  >
                    <XMarkIcon className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap items-end gap-2">
            <div className="w-40">
              <Select
                id={`${idPrefix}-custom-month`}
                label={t('customRecurrence.monthLabel')}
                value={String(pickMonth)}
                onChange={(e) => setPickMonth(Number(e.target.value))}
                options={MONTHS.map((m) => ({ value: String(m), label: monthName(m, locale) }))}
              />
            </div>
            <div className="w-20">
              <Select
                id={`${idPrefix}-custom-day`}
                label={t('customRecurrence.dayLabel')}
                value={String(day)}
                onChange={(e) => setPickDay(Number(e.target.value))}
                options={Array.from({ length: maxPickDay }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))}
              />
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="py-2"
              disabled={dates.includes(pickedDate)}
              onClick={() => onChange({ ...rule, dates: [...dates, pickedDate].sort() })}
            >
              {t('customRecurrence.addDate')}
            </Button>
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400">{t('customRecurrence.yearHint')}</p>
        </div>
      )}

      {errorKey ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {t(errorKey)}
        </p>
      ) : (
        <p aria-live="polite" className="text-sm font-medium text-gray-900 dark:text-gray-100">
          {summary}
        </p>
      )}
    </div>
  );
}
