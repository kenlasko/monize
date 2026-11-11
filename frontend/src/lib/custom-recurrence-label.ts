/**
 * Words for a Custom rule (docs/specs/custom-recurrence.md section 6).
 *
 * Weekday and month names, list joining and ordinals come from `Intl` in the
 * reader's UI language, so no day or month name is ever written into a
 * catalog; the sentence around them is a translated template the caller's
 * `scheduledTransactions` translator supplies (`customRecurrence.*`).
 */
import {
  CustomRecurrence,
  CustomRecurrenceUnit,
  LAST_DAY_OF_MONTH,
  normalizeCustomRecurrence,
} from './custom-recurrence';

/** The `scheduledTransactions` translator, as far as these helpers call it. */
export type CustomRecurrenceTranslator = (key: string, values?: Record<string, string | number>) => string;

/** A locale `Intl` accepts, falling back to English for the pseudo-locale or a malformed tag. */
function intlLocale(locale: string | undefined): string {
  if (!locale || locale === 'xx') return 'en';
  try {
    return Intl.getCanonicalLocales(locale)[0] ?? 'en';
  } catch {
    return 'en';
  }
}

/** 2024-01-01 was a Monday, so ISO weekday `n` falls on 2024-01-0n. */
function isoWeekdayDate(iso: number): Date {
  return new Date(Date.UTC(2024, 0, iso));
}

/** The name of ISO weekday `iso` (1 = Monday ... 7 = Sunday). */
export function weekdayName(iso: number, locale: string | undefined, style: 'short' | 'long' = 'short'): string {
  return new Intl.DateTimeFormat(intlLocale(locale), { weekday: style, timeZone: 'UTC' }).format(isoWeekdayDate(iso));
}

/** The name of month `month` (1 = January). */
export function monthName(month: number, locale: string | undefined, style: 'short' | 'long' = 'long'): string {
  return new Intl.DateTimeFormat(intlLocale(locale), { month: style, timeZone: 'UTC' }).format(
    new Date(Date.UTC(2024, month - 1, 1)),
  );
}

/** A `MM-DD` as the reader writes a day of the year without its year ("Mar 15"). */
export function formatMonthDay(mmdd: string, locale: string | undefined): string {
  const [mm, dd] = mmdd.split('-').map(Number);
  // 2024 is a leap year, so 02-29 formats.
  return new Intl.DateTimeFormat(intlLocale(locale), { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(2024, mm - 1, dd)),
  );
}

/** Items joined as the reader's language joins a list ("Mon, Wed and Fri"). */
export function formatList(items: readonly string[], locale: string | undefined): string {
  if (typeof Intl.ListFormat !== 'function') return items.join(', ');
  return new Intl.ListFormat(intlLocale(locale), { style: 'long', type: 'conjunction' }).format(items);
}

/**
 * ISO weekdays in the order a week starting on `weekStartsOn` (0 = Sunday ...
 * 6 = Saturday) lists them.
 */
export function orderedIsoWeekdays(weekStartsOn: number | undefined): number[] {
  const startIso = (weekStartsOn ?? 1) === 0 ? 7 : (weekStartsOn ?? 1);
  return Array.from({ length: 7 }, (_, i) => ((startIso - 1 + i) % 7) + 1);
}

/** The template key of a unit's summary sentence. */
export function summaryKey(unit: CustomRecurrenceUnit): string {
  return `customRecurrence.summary.${unit}`;
}

/** The localized items the summary lists, in the order a reader expects them. */
function summaryItems(rule: CustomRecurrence, locale: string | undefined, t: CustomRecurrenceTranslator): string[] {
  if (rule.unit === 'WEEK') {
    const chosen = new Set(rule.weekdays);
    return orderedIsoWeekdays(rule.weekStartsOn)
      .filter((d) => chosen.has(d))
      .map((d) => weekdayName(d, locale));
  }
  if (rule.unit === 'MONTH') {
    return (rule.monthDays ?? []).map((d) =>
      d === LAST_DAY_OF_MONTH ? t('customRecurrence.lastDay') : t('customRecurrence.dayOfMonth', { day: d }),
    );
  }
  return (rule.dates ?? []).map((d) => formatMonthDay(d, locale));
}

/**
 * The plain-language summary of a rule ("Every week on Mon, Wed and Fri",
 * "Every 3 months on the 15th"), or `null` for a rule that is not valid --
 * the caller decides what an incomplete rule reads as.
 */
export function describeCustomRecurrence(
  raw: CustomRecurrence | null | undefined,
  locale: string | undefined,
  t: CustomRecurrenceTranslator,
): string | null {
  const result = normalizeCustomRecurrence(raw);
  if (!result.ok) return null;
  const rule = result.rule;
  return t(summaryKey(rule.unit), {
    interval: rule.interval,
    days: formatList(summaryItems(rule, locale, t), locale),
  });
}
