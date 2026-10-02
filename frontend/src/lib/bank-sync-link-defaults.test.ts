import { describe, it, expect } from 'vitest';
import { daysBetweenYmd, mayDuplicate } from './bank-sync-link-defaults';

describe('daysBetweenYmd', () => {
  it('counts calendar days', () => {
    expect(daysBetweenYmd('2026-07-03', '2026-09-30')).toBe(89);
    expect(daysBetweenYmd('2026-09-30', '2026-09-30')).toBe(0);
    expect(daysBetweenYmd('2026-09-30', '2026-07-03')).toBe(-89);
  });

  it('is not moved by a daylight-saving change or a leap day', () => {
    expect(daysBetweenYmd('2026-03-01', '2026-04-01')).toBe(31);
    expect(daysBetweenYmd('2024-02-28', '2024-03-01')).toBe(2);
    expect(daysBetweenYmd('2026-10-24', '2026-10-26')).toBe(2);
  });

  it.each([
    ['', '2026-01-01'],
    ['2026-01-01', 'soon'],
    ['2026-1-1', '2026-01-02'],
  ])('is null when %p or %p is not a date', (from, to) => {
    expect(daysBetweenYmd(from, to)).toBeNull();
  });
});

describe('mayDuplicate', () => {
  it('warns for a date on or before the newest transaction', () => {
    expect(mayDuplicate('2026-09-10', '2026-09-10')).toBe(true);
    expect(mayDuplicate('2026-01-01', '2026-09-10')).toBe(true);
  });

  it('does not warn for a date after it', () => {
    expect(mayDuplicate('2026-09-11', '2026-09-10')).toBe(false);
  });

  it('does not warn when the date is left empty for the server to choose', () => {
    expect(mayDuplicate('', '2026-09-10')).toBe(false);
  });

  it('does not warn for an empty account or an unknown newest transaction', () => {
    expect(mayDuplicate('2026-01-01', null)).toBe(false);
    expect(mayDuplicate('2026-01-01', undefined)).toBe(false);
  });
});
