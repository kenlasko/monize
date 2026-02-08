import { describe, it, expect } from 'vitest';
import { cn, parseLocalDate, formatDate } from './utils';

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
