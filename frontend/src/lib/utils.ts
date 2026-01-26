import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
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
