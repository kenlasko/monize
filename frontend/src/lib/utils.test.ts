import { describe, it, expect } from 'vitest';
import {
  cn,
  parseLocalDate,
  formatDate,
  formatMonth,
  resolveTimezone,
  isoToDatetimeLocal,
  datetimeLocalToIso,
  formatDatetimeLocal,
  parseDatetimeFromFormat,
  formatTime,
  parseTime,
  getLocalDateString,
  getDateStringInTimezone,
  parseDateFromFormat,
  formatChartDate,
} from './utils';

describe('cn', () => {
  it('merges class names', () => {
    expect(cn('foo', 'bar')).toBe('foo bar');
  });

  it('handles conditional classes', () => {
    expect(cn('base', false && 'hidden', 'visible')).toBe('base visible');
  });

  it('resolves Tailwind conflicts (last wins)', () => {
    const result = cn('px-4', 'px-6');
    expect(result).toBe('px-6');
  });

  it('handles undefined and null', () => {
    expect(cn('base', undefined, null, 'extra')).toBe('base extra');
  });

  it('handles empty input', () => {
    expect(cn()).toBe('');
  });
});

describe('parseLocalDate', () => {
  it('parses YYYY-MM-DD without timezone shift', () => {
    const date = parseLocalDate('2026-01-24');
    expect(date.getFullYear()).toBe(2026);
    expect(date.getMonth()).toBe(0); // January = 0
    expect(date.getDate()).toBe(24);
  });

  it('handles different months', () => {
    const date = parseLocalDate('2026-12-31');
    expect(date.getMonth()).toBe(11); // December = 11
    expect(date.getDate()).toBe(31);
  });

  it('handles first day of year', () => {
    const date = parseLocalDate('2026-01-01');
    expect(date.getDate()).toBe(1);
    expect(date.getMonth()).toBe(0);
  });
});

describe('formatDate', () => {
  it('formats YYYY-MM-DD', () => {
    expect(formatDate('2026-01-24', 'YYYY-MM-DD')).toBe('2026-01-24');
  });

  it('formats MM/DD/YYYY', () => {
    expect(formatDate('2026-01-24', 'MM/DD/YYYY')).toBe('01/24/2026');
  });

  it('formats DD/MM/YYYY', () => {
    expect(formatDate('2026-01-24', 'DD/MM/YYYY')).toBe('24/01/2026');
  });

  it('formats DD-MMM-YYYY', () => {
    expect(formatDate('2026-01-24', 'DD-MMM-YYYY')).toBe('24-Jan-2026');
  });

  it('accepts Date objects', () => {
    const date = new Date(2026, 0, 24); // Jan 24, 2026
    expect(formatDate(date, 'YYYY-MM-DD')).toBe('2026-01-24');
  });

  it('pads single-digit months and days', () => {
    expect(formatDate('2026-03-05', 'MM/DD/YYYY')).toBe('03/05/2026');
  });

  it('uses browser locale for default format', () => {
    // Just verify it returns a string without throwing
    const result = formatDate('2026-01-24');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('falls back to browser locale for unknown format', () => {
    const result = formatDate('2026-01-24', 'unknown-format');
    expect(typeof result).toBe('string');
  });
});

describe('formatMonth', () => {
  it('formats YYYY-MM-DD as year-month', () => {
    expect(formatMonth('2026-01', 'YYYY-MM-DD')).toBe('2026-01');
  });

  it('formats MM/DD/YYYY as month/year', () => {
    expect(formatMonth('2026-01', 'MM/DD/YYYY')).toBe('01/2026');
  });

  it('formats DD/MM/YYYY as month/year', () => {
    expect(formatMonth('2026-01', 'DD/MM/YYYY')).toBe('01/2026');
  });

  it('formats DD-MMM-YYYY as month-name-year', () => {
    expect(formatMonth('2026-01', 'DD-MMM-YYYY')).toBe('Jan-2026');
  });

  it('pads single-digit months', () => {
    expect(formatMonth('2026-03', 'YYYY-MM-DD')).toBe('2026-03');
  });

  it('uses browser locale for the default format', () => {
    const result = formatMonth('2026-01');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('falls back to browser locale for unknown format', () => {
    const result = formatMonth('2026-01', 'unknown-format');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });
});

describe('formatChartDate', () => {
  it('localizes the short month name (en)', () => {
    expect(formatChartDate('2026-01-15', 'MMM', 'en-US')).toBe('Jan');
  });

  it('localizes the short month name in another language (de)', () => {
    // German abbreviates January as "Jan" too, but March differs ("Mär").
    expect(formatChartDate('2026-03-15', 'MMM', 'de')).toBe('Mär');
  });

  it('localizes the full month with year (fr)', () => {
    // French uses lowercase month names and day-month-year ordering.
    expect(formatChartDate('2026-01-15', 'MMMM yyyy', 'fr')).toBe('janvier 2026');
  });

  it('parses string dates as local time without shifting', () => {
    // A naive new Date('2026-01-01') is UTC midnight and can roll back a day
    // in negative-offset zones; formatChartDate parses parts directly.
    expect(formatChartDate('2026-01-01', 'MMM yyyy', 'en-US')).toBe('Jan 2026');
  });

  it('formats Date inputs (intraday timestamps) with time', () => {
    const d = new Date(2026, 0, 5, 14, 30);
    expect(formatChartDate(d, 'HH:mm', 'en-GB')).toBe('14:30');
  });

  it('formats year-only markers', () => {
    expect(formatChartDate('2026-06-15', 'yyyy', 'en-US')).toBe('2026');
  });

  it('falls back to the runtime default locale when none is given', () => {
    const result = formatChartDate('2026-01-15', 'MMM');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });
});

describe('resolveTimezone', () => {
  it('returns the preference when it is a specific timezone', () => {
    expect(resolveTimezone('America/Toronto')).toBe('America/Toronto');
  });

  it('returns the preference for UTC', () => {
    expect(resolveTimezone('UTC')).toBe('UTC');
  });

  it('falls back to browser timezone when preference is "browser"', () => {
    const result = resolveTimezone('browser');
    // Should return a valid IANA timezone string (not "browser")
    expect(result).not.toBe('browser');
    expect(result.length).toBeGreaterThan(0);
  });

  it('falls back to browser timezone when preference is undefined', () => {
    const result = resolveTimezone(undefined);
    expect(result).not.toBe('browser');
    expect(result.length).toBeGreaterThan(0);
  });
});

describe('isoToDatetimeLocal', () => {
  it('converts a UTC timestamp to the target timezone', () => {
    // 2026-07-15 20:30 UTC = 2026-07-15 16:30 EDT (America/Toronto, UTC-4 in summer)
    const result = isoToDatetimeLocal('2026-07-15T20:30:00.000Z', 'America/Toronto');
    expect(result).toBe('2026-07-15T16:30');
  });

  it('handles date boundary crossings', () => {
    // 2026-01-15 03:00 UTC = 2026-01-14 22:00 EST (America/Toronto, UTC-5 in winter)
    const result = isoToDatetimeLocal('2026-01-15T03:00:00.000Z', 'America/Toronto');
    expect(result).toBe('2026-01-14T22:00');
  });

  it('returns UTC time when timezone is UTC', () => {
    const result = isoToDatetimeLocal('2026-07-15T20:30:00.000Z', 'UTC');
    expect(result).toBe('2026-07-15T20:30');
  });

  it('handles timestamps without Z suffix by treating them as UTC', () => {
    const withZ = isoToDatetimeLocal('2026-07-15T20:30:00.000Z', 'America/Toronto');
    const withoutZ = isoToDatetimeLocal('2026-07-15 20:30:00', 'America/Toronto');
    expect(withoutZ).toBe(withZ);
  });

  it('handles timestamps with fractional seconds', () => {
    const result = isoToDatetimeLocal('2026-04-04T21:14:45.86155Z', 'America/Toronto');
    // April = EDT (UTC-4), so 21:14 UTC = 17:14 EDT
    expect(result).toBe('2026-04-04T17:14');
  });

  it('handles midnight UTC', () => {
    const result = isoToDatetimeLocal('2026-07-15T00:00:00.000Z', 'America/Toronto');
    // 00:00 UTC = 20:00 EDT previous day
    expect(result).toBe('2026-07-14T20:00');
  });
});

describe('datetimeLocalToIso', () => {
  it('converts a datetime-local value back to UTC ISO string', () => {
    // 16:30 in America/Toronto (EDT, UTC-4 in summer) = 20:30 UTC
    const result = datetimeLocalToIso('2026-07-15T16:30', 'America/Toronto');
    const date = new Date(result);
    expect(date.getUTCFullYear()).toBe(2026);
    expect(date.getUTCMonth()).toBe(6); // July = 6
    expect(date.getUTCDate()).toBe(15);
    expect(date.getUTCHours()).toBe(20);
    expect(date.getUTCMinutes()).toBe(30);
  });

  it('returns a valid ISO string with Z suffix', () => {
    const result = datetimeLocalToIso('2026-07-15T16:30', 'America/Toronto');
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/);
  });

  it('handles UTC timezone', () => {
    const result = datetimeLocalToIso('2026-07-15T20:30', 'UTC');
    const date = new Date(result);
    expect(date.getUTCHours()).toBe(20);
    expect(date.getUTCMinutes()).toBe(30);
  });

  it('round-trips with isoToDatetimeLocal', () => {
    const original = '2026-07-15T20:30:00.000Z';
    const tz = 'America/Toronto';
    const local = isoToDatetimeLocal(original, tz);
    const roundTripped = datetimeLocalToIso(local, tz);
    const originalDate = new Date(original);
    const roundTrippedDate = new Date(roundTripped);
    // Should match to the minute (seconds/ms lost in datetime-local format)
    expect(roundTrippedDate.getUTCFullYear()).toBe(originalDate.getUTCFullYear());
    expect(roundTrippedDate.getUTCMonth()).toBe(originalDate.getUTCMonth());
    expect(roundTrippedDate.getUTCDate()).toBe(originalDate.getUTCDate());
    expect(roundTrippedDate.getUTCHours()).toBe(originalDate.getUTCHours());
    expect(roundTrippedDate.getUTCMinutes()).toBe(originalDate.getUTCMinutes());
  });
});

describe('formatTime', () => {
  it('returns 24h time unchanged when format is 24h', () => {
    expect(formatTime('14:30', '24h')).toBe('14:30');
  });

  it('converts afternoon to 12h', () => {
    expect(formatTime('14:30', '12h')).toBe('2:30 PM');
  });

  it('converts midnight to 12:00 AM', () => {
    expect(formatTime('00:00', '12h')).toBe('12:00 AM');
  });

  it('converts noon to 12:00 PM', () => {
    expect(formatTime('12:00', '12h')).toBe('12:00 PM');
  });

  it('converts morning time', () => {
    expect(formatTime('09:05', '12h')).toBe('9:05 AM');
  });

  it('returns empty string for empty input', () => {
    expect(formatTime('', '12h')).toBe('');
  });
});

describe('parseTime', () => {
  it('parses 24h time', () => {
    expect(parseTime('14:30')).toBe('14:30');
  });

  it('pads single-digit 24h hours', () => {
    expect(parseTime('9:05')).toBe('09:05');
  });

  it('parses 12h PM time', () => {
    expect(parseTime('2:30 PM')).toBe('14:30');
  });

  it('parses 12h AM time', () => {
    expect(parseTime('9:05 AM')).toBe('09:05');
  });

  it('parses 12:00 AM as midnight', () => {
    expect(parseTime('12:00 AM')).toBe('00:00');
  });

  it('parses 12:30 PM as 12:30', () => {
    expect(parseTime('12:30 PM')).toBe('12:30');
  });

  it('is case-insensitive', () => {
    expect(parseTime('2:30 pm')).toBe('14:30');
  });

  it('returns null for invalid input', () => {
    expect(parseTime('not-a-time')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(parseTime('')).toBeNull();
  });

  it('returns null for hour > 23 in 24h format', () => {
    expect(parseTime('24:00')).toBeNull();
  });

  it('returns null for hour 0 in 12h format', () => {
    expect(parseTime('0:30 AM')).toBeNull();
  });

  it('returns null for hour > 12 in 12h format', () => {
    expect(parseTime('13:30 PM')).toBeNull();
  });
});

describe('formatDatetimeLocal', () => {
  it('formats with YYYY-MM-DD in 24h', () => {
    expect(formatDatetimeLocal('2026-01-15T19:30', 'YYYY-MM-DD')).toBe('2026-01-15 19:30');
  });

  it('formats with MM/DD/YYYY in 24h', () => {
    expect(formatDatetimeLocal('2026-01-15T19:30', 'MM/DD/YYYY')).toBe('01/15/2026 19:30');
  });

  it('formats with DD/MM/YYYY in 24h', () => {
    expect(formatDatetimeLocal('2026-01-15T19:30', 'DD/MM/YYYY')).toBe('15/01/2026 19:30');
  });

  it('formats with DD-MMM-YYYY in 24h', () => {
    expect(formatDatetimeLocal('2026-01-15T19:30', 'DD-MMM-YYYY')).toBe('15-Jan-2026 19:30');
  });

  it('formats in 12h mode', () => {
    expect(formatDatetimeLocal('2026-01-15T19:30', 'MM/DD/YYYY', '12h')).toBe('01/15/2026 7:30 PM');
  });

  it('formats midnight in 12h mode', () => {
    expect(formatDatetimeLocal('2026-01-15T00:00', 'YYYY-MM-DD', '12h')).toBe('2026-01-15 12:00 AM');
  });

  it('returns empty string for empty input', () => {
    expect(formatDatetimeLocal('', 'YYYY-MM-DD')).toBe('');
  });

  it('returns just the date when no time part', () => {
    expect(formatDatetimeLocal('2026-01-15', 'YYYY-MM-DD')).toBe('2026-01-15');
  });
});

describe('parseDatetimeFromFormat', () => {
  it('parses MM/DD/YYYY HH:mm (24h)', () => {
    expect(parseDatetimeFromFormat('01/15/2026 19:30', 'MM/DD/YYYY')).toBe('2026-01-15T19:30');
  });

  it('parses DD/MM/YYYY HH:mm (24h)', () => {
    expect(parseDatetimeFromFormat('15/01/2026 19:30', 'DD/MM/YYYY')).toBe('2026-01-15T19:30');
  });

  it('parses YYYY-MM-DD HH:mm (24h)', () => {
    expect(parseDatetimeFromFormat('2026-01-15 19:30', 'YYYY-MM-DD')).toBe('2026-01-15T19:30');
  });

  it('parses DD-MMM-YYYY HH:mm (24h)', () => {
    expect(parseDatetimeFromFormat('15-Jan-2026 19:30', 'DD-MMM-YYYY')).toBe('2026-01-15T19:30');
  });

  it('pads single-digit hours', () => {
    expect(parseDatetimeFromFormat('01/15/2026 9:05', 'MM/DD/YYYY')).toBe('2026-01-15T09:05');
  });

  it('parses 12h AM/PM time', () => {
    expect(parseDatetimeFromFormat('01/15/2026 7:30 PM', 'MM/DD/YYYY')).toBe('2026-01-15T19:30');
  });

  it('parses 12h midnight', () => {
    expect(parseDatetimeFromFormat('01/15/2026 12:00 AM', 'MM/DD/YYYY')).toBe('2026-01-15T00:00');
  });

  it('parses 12h noon', () => {
    expect(parseDatetimeFromFormat('01/15/2026 12:30 PM', 'MM/DD/YYYY')).toBe('2026-01-15T12:30');
  });

  it('returns null for invalid input', () => {
    expect(parseDatetimeFromFormat('not-a-date', 'MM/DD/YYYY')).toBeNull();
  });

  it('returns null for missing time', () => {
    expect(parseDatetimeFromFormat('01/15/2026', 'MM/DD/YYYY')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(parseDatetimeFromFormat('', 'MM/DD/YYYY')).toBeNull();
  });

  it('returns null when AM/PM time is invalid (hour > 12)', () => {
    expect(parseDatetimeFromFormat('01/15/2026 13:30 PM', 'MM/DD/YYYY')).toBeNull();
  });

  it('returns null when AM/PM date part is invalid', () => {
    expect(parseDatetimeFromFormat('99/99/2026 2:30 PM', 'MM/DD/YYYY')).toBeNull();
  });

  it('returns null when 24h time part is invalid (hour > 23)', () => {
    expect(parseDatetimeFromFormat('01/15/2026 25:00', 'MM/DD/YYYY')).toBeNull();
  });
});

describe('getLocalDateString', () => {
  it('returns YYYY-MM-DD for the given date', () => {
    expect(getLocalDateString(new Date(2026, 0, 5))).toBe('2026-01-05');
  });

  it('pads single-digit months and days', () => {
    expect(getLocalDateString(new Date(2026, 8, 9))).toBe('2026-09-09');
  });

  it('uses current date when called with no argument', () => {
    const result = getLocalDateString();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('getDateStringInTimezone', () => {
  // 2026-07-17 20:00 UTC is already 2026-07-18 in Australia/Sydney (UTC+10)
  // but still 2026-07-17 in US/Eastern (UTC-4), so the calendar date depends
  // entirely on the timezone argument, not the machine running the test.
  const instant = new Date('2026-07-17T20:00:00Z');

  it('returns the calendar date as it reads in the given timezone', () => {
    expect(getDateStringInTimezone('Australia/Sydney', instant)).toBe(
      '2026-07-18',
    );
    expect(getDateStringInTimezone('America/New_York', instant)).toBe(
      '2026-07-17',
    );
    expect(getDateStringInTimezone('UTC', instant)).toBe('2026-07-17');
  });

  it('uses current date when called with no explicit date', () => {
    expect(getDateStringInTimezone('UTC')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('parseDateFromFormat', () => {
  it('parses YYYY-MM-DD', () => {
    expect(parseDateFromFormat('2026-01-15', 'YYYY-MM-DD')).toBe('2026-01-15');
  });

  it('parses MM/DD/YYYY', () => {
    expect(parseDateFromFormat('01/15/2026', 'MM/DD/YYYY')).toBe('2026-01-15');
  });

  it('parses DD/MM/YYYY', () => {
    expect(parseDateFromFormat('15/01/2026', 'DD/MM/YYYY')).toBe('2026-01-15');
  });

  it('parses DD-MMM-YYYY', () => {
    expect(parseDateFromFormat('15-Jan-2026', 'DD-MMM-YYYY')).toBe('2026-01-15');
    expect(parseDateFromFormat('15-jan-2026', 'DD-MMM-YYYY')).toBe('2026-01-15');
  });

  it('returns null for empty input', () => {
    expect(parseDateFromFormat('', 'YYYY-MM-DD')).toBeNull();
  });

  it('returns null for invalid month abbreviation', () => {
    expect(parseDateFromFormat('15-XYZ-2026', 'DD-MMM-YYYY')).toBeNull();
  });

  it('returns null for invalid format', () => {
    expect(parseDateFromFormat('not-a-date', 'YYYY-MM-DD')).toBeNull();
  });

  it('returns null for impossible dates (Feb 30)', () => {
    expect(parseDateFromFormat('2026-02-30', 'YYYY-MM-DD')).toBeNull();
  });

  it('returns null for month 0', () => {
    expect(parseDateFromFormat('2026-00-15', 'YYYY-MM-DD')).toBeNull();
  });

  it('returns null for month > 12', () => {
    expect(parseDateFromFormat('2026-13-15', 'YYYY-MM-DD')).toBeNull();
  });

  it('returns null for day 0', () => {
    expect(parseDateFromFormat('2026-01-00', 'YYYY-MM-DD')).toBeNull();
  });

  it('falls back to YYYY-MM-DD for unknown formats', () => {
    expect(parseDateFromFormat('2026-01-15', 'browser')).toBe('2026-01-15');
    expect(parseDateFromFormat('not-iso', 'browser')).toBeNull();
  });
});
