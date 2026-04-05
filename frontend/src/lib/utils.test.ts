import { describe, it, expect, vi } from 'vitest';
import { cn, parseLocalDate, formatDate, resolveTimezone, isoToDatetimeLocal, datetimeLocalToIso } from './utils';

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
