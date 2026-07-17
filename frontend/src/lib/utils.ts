import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Shared base classes for text inputs, selects, and comboboxes */
export const inputBaseClasses = [
  'block w-full rounded-md border-gray-300 shadow-sm',
  'focus:border-blue-500 focus:ring-blue-500',
  'disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-500',
  'dark:bg-gray-800 dark:border-gray-600 dark:text-gray-100 dark:placeholder-gray-400',
  'dark:focus:border-blue-400 dark:focus:ring-blue-400',
  'dark:disabled:bg-gray-700 dark:disabled:text-gray-400',
].join(' ');

/** Shared error-state classes for inputs */
export const inputErrorClasses = 'border-red-300 focus:border-red-500 focus:ring-red-500 dark:border-red-500';

/**
 * Get today's date as a YYYY-MM-DD string using local timezone.
 * Avoids the timezone bug where `new Date().toISOString().split('T')[0]`
 * returns tomorrow's date for users in negative-UTC-offset timezones
 * (e.g., 8pm EST on March 4 → toISOString() returns '2026-03-05').
 */
export function getLocalDateString(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Get a date as a YYYY-MM-DD string in the given IANA timezone.
 * The sv-SE locale always formats as YYYY-MM-DD, so this yields the calendar
 * date as it reads in that timezone -- which may differ from both UTC and the
 * browser's own local date (e.g. a US/Eastern browser rendering an
 * Australia/Sydney date). Pair with `resolveTimezone()` to honour the user's
 * timezone preference.
 */
export function getDateStringInTimezone(
  timezone: string,
  date: Date = new Date(),
): string {
  return date.toLocaleDateString('sv-SE', { timeZone: timezone });
}

/**
 * Parse a date string (YYYY-MM-DD) into a Date object without timezone conversion.
 * This prevents the date from shifting when displayed in local time.
 *
 * When JavaScript's `new Date('2026-01-24')` is called, it interprets the string as
 * UTC midnight, which then gets shifted to the previous day in local timezones that
 * are behind UTC. This function parses the date parts directly to avoid that issue.
 */
export function parseLocalDate(dateStr: string): Date {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(year, month - 1, day);
}

/**
 * Format a date according to the specified format or browser locale.
 * @param date - Date object or date string (YYYY-MM-DD)
 * @param format - Date format string or 'browser' for locale-based formatting
 * @param locale - Optional BCP 47 locale used only when format is 'browser';
 *                 falls back to the browser locale when omitted.
 */
export function formatDate(date: Date | string, format: string = 'browser', locale?: string): string {
  const d = typeof date === 'string' ? parseLocalDate(date) : date;

  if (format === 'browser') {
    // Use the supplied locale (typically the user's UI language) when given,
    // otherwise hand off to the browser default.
    return d.toLocaleDateString(locale, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  }

  const year = d.getFullYear();
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const monthPadded = month.toString().padStart(2, '0');
  const dayPadded = day.toString().padStart(2, '0');

  // Get month name for formats that need it
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthName = monthNames[d.getMonth()];

  switch (format) {
    case 'YYYY-MM-DD':
      return `${year}-${monthPadded}-${dayPadded}`;
    case 'MM/DD/YYYY':
      return `${monthPadded}/${dayPadded}/${year}`;
    case 'DD/MM/YYYY':
      return `${dayPadded}/${monthPadded}/${year}`;
    case 'DD-MMM-YYYY':
      return `${dayPadded}-${monthName}-${year}`;
    default:
      // Fall back to browser locale
      return d.toLocaleDateString();
  }
}

/**
 * Format a year-month value (YYYY-MM) according to the user's date format,
 * dropping the day component. Used for month column headers where only the
 * month and year are meaningful, so headers follow the same ordering and
 * separators as full dates rendered elsewhere.
 * @param month - Year-month string in YYYY-MM form
 * @param format - Date format string or 'browser' for locale-based formatting
 * @param locale - Optional BCP 47 locale used only when format is 'browser'
 */
export function formatMonth(month: string, format: string = 'browser', locale?: string): string {
  const [yearStr, monStr] = month.split('-');
  const year = Number(yearStr);
  const monthIndex = Number(monStr) - 1;
  const monthPadded = monStr.padStart(2, '0');

  const browserFormat = () =>
    new Date(year, monthIndex, 1).toLocaleDateString(locale, {
      year: 'numeric',
      month: '2-digit',
    });

  if (format === 'browser') {
    return browserFormat();
  }

  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  switch (format) {
    case 'YYYY-MM-DD':
      return `${year}-${monthPadded}`;
    case 'MM/DD/YYYY':
    case 'DD/MM/YYYY':
      return `${monthPadded}/${year}`;
    case 'DD-MMM-YYYY':
      return `${monthNames[monthIndex]}-${year}`;
    default:
      return browserFormat();
  }
}

/**
 * date-fns-style tokens used for month markers and date labels on charts,
 * mapped to locale-aware `Intl.DateTimeFormat` output. Charts historically
 * formatted these with date-fns `format()`, which is English-only here (no
 * locale was ever supplied), so month names like "Jan" never followed the
 * user's UI language. Using Intl localizes both the month name and the
 * locale-appropriate ordering/separators.
 */
export type ChartDatePattern =
  | 'MMM' // Jan
  | 'MMM yy' // Jan 25
  | 'MMM yyyy' // Jan 2025
  | 'MMMM yyyy' // January 2025
  | 'MMM d' // Jan 5
  | 'MMM d, yyyy' // Jan 5, 2025
  | 'MMM d HH:mm' // Jan 5, 14:30
  | 'HH:mm' // 14:30
  | 'yyyy'; // 2025

const CHART_DATE_OPTIONS: Record<ChartDatePattern, Intl.DateTimeFormatOptions> = {
  MMM: { month: 'short' },
  'MMM yy': { month: 'short', year: '2-digit' },
  'MMM yyyy': { month: 'short', year: 'numeric' },
  'MMMM yyyy': { month: 'long', year: 'numeric' },
  'MMM d': { month: 'short', day: 'numeric' },
  'MMM d, yyyy': { month: 'short', day: 'numeric', year: 'numeric' },
  'MMM d HH:mm': { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false },
  'HH:mm': { hour: '2-digit', minute: '2-digit', hour12: false },
  yyyy: { year: 'numeric' },
};

/**
 * Format a date for a chart axis tick, tooltip, or series label in the user's
 * locale. String inputs are parsed as local dates (YYYY-MM-DD) so they do not
 * shift across timezones; Date inputs (e.g. intraday timestamps) are formatted
 * as given.
 * @param date - Date object or local date string (YYYY-MM-DD)
 * @param pattern - One of the supported chart date patterns
 * @param locale - Optional BCP 47 locale (typically the user's UI language);
 *                 falls back to the runtime default when omitted.
 */
export function formatChartDate(
  date: Date | string,
  pattern: ChartDatePattern,
  locale?: string,
): string {
  const d = typeof date === 'string' ? parseLocalDate(date) : date;
  return new Intl.DateTimeFormat(locale, CHART_DATE_OPTIONS[pattern]).format(d);
}

/**
 * Resolve the user's timezone preference to an IANA timezone string.
 * 'browser' (or undefined) falls back to the browser's detected timezone.
 */
export function resolveTimezone(pref: string | undefined): string {
  if (!pref || pref === 'browser') {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  }
  return pref;
}

/**
 * Convert a UTC timestamp to a datetime-local input value (YYYY-MM-DDTHH:mm)
 * in the given IANA timezone.
 *
 * Uses toLocaleString with the sv-SE locale which always formats as
 * "YYYY-MM-DD HH:mm:ss", then converts the space to "T" and trims seconds.
 */
export function isoToDatetimeLocal(isoString: string, timezone: string): string {
  // Ensure the timestamp is always interpreted as UTC. Backend timestamps are
  // stored in UTC but may arrive without a Z suffix depending on serialization.
  const normalized = /[Z+-]/.test(isoString.slice(-6)) ? isoString : isoString + 'Z';
  const str = new Date(normalized).toLocaleString('sv-SE', { timeZone: timezone });
  // "2024-01-14 19:00:00" → "2024-01-14T19:00"
  return str.replace(' ', 'T').slice(0, 16);
}

/**
 * Convert a datetime-local input value (YYYY-MM-DDTHH:mm) interpreted in the
 * given IANA timezone back to an ISO UTC string.
 *
 * There is no native JS API to parse a date string INTO a timezone, so we
 * format the same UTC-guess instant in both the target timezone and UTC,
 * compute the offset, and adjust.
 */
export function datetimeLocalToIso(datetimeLocal: string, timezone: string): string {
  const [datePart, timePart] = datetimeLocal.split('T');
  const [year, month, day] = datePart.split('-').map(Number);
  const [hour, minute] = timePart.split(':').map(Number);

  // Treat the input as if it were UTC, then compute how far that instant's
  // wall-clock in the target timezone differs from UTC.
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const wallInTz = utcGuess.toLocaleString('sv-SE', { timeZone: timezone });
  const wallInUtc = utcGuess.toLocaleString('sv-SE', { timeZone: 'UTC' });
  const parse = (s: string) => {
    const [d, t] = s.split(' ');
    const [y, m, dy] = d.split('-').map(Number);
    const [h, mn, sc] = t.split(':').map(Number);
    return Date.UTC(y, m - 1, dy, h, mn, sc);
  };
  const offsetMs = parse(wallInTz) - parse(wallInUtc);
  return new Date(utcGuess.getTime() - offsetMs).toISOString();
}

const MONTH_ABBREVS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function buildValidatedIsoDate(year: string, month: string, day: string): string | null {
  const y = Number(year);
  const mo = Number(month);
  const d = Number(day);
  if (!Number.isInteger(y) || !Number.isInteger(mo) || !Number.isInteger(d)) return null;
  if (mo < 1 || mo > 12) return null;
  if (d < 1) return null;
  const daysInMonth = new Date(y, mo, 0).getDate();
  if (d > daysInMonth) return null;
  return `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Parse a user-typed date string in the given format back to YYYY-MM-DD.
 * Returns null if the input does not match the expected format or represents
 * an impossible date (e.g. month 0, February 30).
 */
export function parseDateFromFormat(input: string, format: string): string | null {
  if (!input) return null;
  const trimmed = input.trim();

  switch (format) {
    case 'YYYY-MM-DD': {
      const m = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
      if (!m) return null;
      return buildValidatedIsoDate(m[1], m[2], m[3]);
    }
    case 'MM/DD/YYYY': {
      const m = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (!m) return null;
      return buildValidatedIsoDate(m[3], m[1], m[2]);
    }
    case 'DD/MM/YYYY': {
      const m = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (!m) return null;
      return buildValidatedIsoDate(m[3], m[2], m[1]);
    }
    case 'DD-MMM-YYYY': {
      const m = trimmed.match(/^(\d{1,2})-(\w{3})-(\d{4})$/i);
      if (!m) return null;
      const monthIdx = MONTH_ABBREVS.indexOf(m[2].toLowerCase());
      if (monthIdx === -1) return null;
      return buildValidatedIsoDate(m[3], String(monthIdx + 1), m[1]);
    }
    default: {
      // For 'browser' or unknown formats, try YYYY-MM-DD as a universal fallback
      const m = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
      if (m) return buildValidatedIsoDate(m[1], m[2], m[3]);
      return null;
    }
  }
}

/**
 * Format a 24h time string (HH:mm) into the given time format.
 */
export function formatTime(time24: string, timeFormat: string): string {
  if (!time24) return '';
  if (timeFormat !== '12h') return time24;
  const [hStr, mStr] = time24.split(':');
  const h = Number(hStr);
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:${mStr} ${period}`;
}

/**
 * Parse a time string (24h "HH:mm" or 12h "H:mm AM/PM") back to 24h "HH:mm".
 * Returns null if parsing fails.
 */
export function parseTime(input: string): string | null {
  if (!input) return null;
  const trimmed = input.trim();

  // Try 24h format first: HH:mm
  const m24 = trimmed.match(/^(\d{1,2}):(\d{2})$/);
  if (m24) {
    const h = Number(m24[1]);
    if (h > 23) return null;
    return `${String(h).padStart(2, '0')}:${m24[2]}`;
  }

  // Try 12h format: H:mm AM/PM
  const m12 = trimmed.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (m12) {
    let h = Number(m12[1]);
    const period = m12[3].toUpperCase();
    if (h < 1 || h > 12) return null;
    if (period === 'AM' && h === 12) h = 0;
    else if (period === 'PM' && h !== 12) h += 12;
    return `${String(h).padStart(2, '0')}:${m12[2]}`;
  }

  return null;
}

/**
 * Format a datetime-local string (YYYY-MM-DDTHH:mm) using the user's date
 * and time format preferences.  e.g. "01/15/2024 2:30 PM"
 */
export function formatDatetimeLocal(datetimeLocal: string, dateFormat: string, timeFormat: string = '24h'): string {
  if (!datetimeLocal) return '';
  const [datePart, timePart] = datetimeLocal.split('T');
  const formatted = formatDate(datePart, dateFormat);
  return timePart ? `${formatted} ${formatTime(timePart, timeFormat)}` : formatted;
}

/**
 * Parse a user-typed datetime string back to a datetime-local value
 * (YYYY-MM-DDTHH:mm).  Accepts "{formatted-date} HH:mm" or
 * "{formatted-date} H:mm AM/PM".
 * Returns null if parsing fails.
 */
export function parseDatetimeFromFormat(input: string, dateFormat: string): string | null {
  if (!input) return null;
  const trimmed = input.trim();

  // Try splitting off AM/PM time first: "... H:mm AM" or "... H:mm PM"
  const ampmMatch = trimmed.match(/^(.+)\s+(\d{1,2}:\d{2}\s*(?:AM|PM))$/i);
  if (ampmMatch) {
    const datePart = ampmMatch[1];
    const time24 = parseTime(ampmMatch[2]);
    if (!time24) return null;
    const isoDate = parseDateFromFormat(datePart, dateFormat);
    if (!isoDate) return null;
    return `${isoDate}T${time24}`;
  }

  // Fall back to 24h: "... HH:mm"
  const lastSpace = trimmed.lastIndexOf(' ');
  if (lastSpace === -1) return null;

  const datePart = trimmed.slice(0, lastSpace);
  const timePart = trimmed.slice(lastSpace + 1);

  const time24 = parseTime(timePart);
  if (!time24) return null;

  const isoDate = parseDateFromFormat(datePart, dateFormat);
  if (!isoDate) return null;

  return `${isoDate}T${time24}`;
}
