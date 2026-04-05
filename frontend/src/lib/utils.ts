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
 */
export function formatDate(date: Date | string, format: string = 'browser'): string {
  const d = typeof date === 'string' ? parseLocalDate(date) : date;

  if (format === 'browser') {
    // Use browser locale for formatting
    return d.toLocaleDateString(undefined, {
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

/**
 * Parse a user-typed date string in the given format back to YYYY-MM-DD.
 * Returns null if the input does not match the expected format.
 */
export function parseDateFromFormat(input: string, format: string): string | null {
  if (!input) return null;
  const trimmed = input.trim();

  switch (format) {
    case 'YYYY-MM-DD': {
      const m = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
      if (!m) return null;
      const [, y, mo, d] = m;
      return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
    }
    case 'MM/DD/YYYY': {
      const m = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (!m) return null;
      const [, mo, d, y] = m;
      return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
    }
    case 'DD/MM/YYYY': {
      const m = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (!m) return null;
      const [, d, mo, y] = m;
      return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
    }
    case 'DD-MMM-YYYY': {
      const m = trimmed.match(/^(\d{1,2})-(\w{3})-(\d{4})$/i);
      if (!m) return null;
      const monthIdx = MONTH_ABBREVS.indexOf(m[2].toLowerCase());
      if (monthIdx === -1) return null;
      return `${m[3]}-${String(monthIdx + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    }
    default: {
      // For 'browser' or unknown formats, try YYYY-MM-DD as a universal fallback
      const m = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
      if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
      return null;
    }
  }
}

/**
 * Format a datetime-local string (YYYY-MM-DDTHH:mm) using the user's date
 * format preference, appending the time portion.  e.g. "01/15/2024 19:00"
 */
export function formatDatetimeLocal(datetimeLocal: string, dateFormat: string): string {
  if (!datetimeLocal) return '';
  const [datePart, timePart] = datetimeLocal.split('T');
  const formatted = formatDate(datePart, dateFormat);
  return timePart ? `${formatted} ${timePart}` : formatted;
}

/**
 * Parse a user-typed datetime string back to a datetime-local value
 * (YYYY-MM-DDTHH:mm).  Accepts "{formatted-date} HH:mm".
 * Returns null if parsing fails.
 */
export function parseDatetimeFromFormat(input: string, dateFormat: string): string | null {
  if (!input) return null;
  const trimmed = input.trim();

  // Split on the last space to separate date and time portions
  const lastSpace = trimmed.lastIndexOf(' ');
  if (lastSpace === -1) return null;

  const datePart = trimmed.slice(0, lastSpace);
  const timePart = trimmed.slice(lastSpace + 1);

  // Validate time format HH:mm
  if (!/^\d{1,2}:\d{2}$/.test(timePart)) return null;

  const isoDate = parseDateFromFormat(datePart, dateFormat);
  if (!isoDate) return null;

  const [h, m] = timePart.split(':');
  const hh = h.padStart(2, '0');
  return `${isoDate}T${hh}:${m}`;
}
