import { describe, it, expect } from 'vitest';
import {
  CustomRecurrence,
  customDateOnOrAfter,
  customOccurrencesPerYear,
  nextCustomDate,
  normalizeCustomRecurrence,
} from './custom-recurrence';

/**
 * The Custom frequency's stepper. The matrix is docs/specs/custom-recurrence.md
 * section 7, the same table `backend/src/common/custom-recurrence.spec.ts`
 * walks, so both layers put a rule's slots on the same days.
 */

const week = (interval: number, weekdays: number[], weekStartsOn = 1): CustomRecurrence => ({
  unit: 'WEEK',
  interval,
  weekdays,
  weekStartsOn,
});
const month = (interval: number, monthDays: number[]): CustomRecurrence => ({ unit: 'MONTH', interval, monthDays });
const year = (interval: number, dates: string[]): CustomRecurrence => ({ unit: 'YEAR', interval, dates });

describe('nextCustomDate: the spec section 7 matrix', () => {
  it.each([
    ['WEEK 1 [1,3,5] from Wednesday', week(1, [1, 3, 5]), undefined, '2026-11-11', '2026-11-13'],
    ['WEEK 1 [1,3,5] from Friday', week(1, [1, 3, 5]), undefined, '2026-11-13', '2026-11-16'],
    ['WEEK 2 [2,4] start 2026-11-11, weekStartsOn 1', week(2, [2, 4], 1), '2026-11-11', '2026-11-12', '2026-11-24'],
    ['MONTH 1 [5,20,-1]', month(1, [5, 20, -1]), undefined, '2026-11-20', '2026-11-30'],
    ['MONTH 1 [30,31] into February', month(1, [30, 31]), undefined, '2027-01-31', '2027-02-28'],
    ['MONTH 1 [30,31] out of February', month(1, [30, 31]), undefined, '2027-02-28', '2027-03-30'],
    ['MONTH 3 [15] start 2026-11-15', month(3, [15]), '2026-11-15', '2026-11-15', '2027-02-15'],
    ['YEAR 1 [02-29] in a common year', year(1, ['02-29']), undefined, '2026-03-01', '2027-02-28'],
    ['YEAR 1 [02-29] into a leap year', year(1, ['02-29']), undefined, '2027-02-28', '2028-02-29'],
    ['YEAR 2 [06-01] start 2026-01-10', year(2, ['06-01']), '2026-01-10', '2026-06-01', '2028-06-01'],
  ] as [string, CustomRecurrence, string | undefined, string, string][])(
    '%s: %s after %s',
    (_name, rule, startDate, fromDate, expected) => {
      expect(nextCustomDate(fromDate, rule, startDate)).toBe(expected);
    },
  );

  it('resumes the pattern from a date moved off it', () => {
    // A Tuesday, which the rule does not hold: the next slot is Wednesday.
    expect(nextCustomDate('2026-11-10', week(1, [1, 3, 5]))).toBe('2026-11-11');
  });

  it('keeps the last day apart from the 31st, and merges them where they meet', () => {
    expect(nextCustomDate('2026-04-29', month(1, [31]))).toBe('2026-04-30');
    expect(nextCustomDate('2026-04-30', month(1, [31, -1]))).toBe('2026-05-31');
  });

  it('throws without a valid rule, so no walker repeats one date', () => {
    expect(() => nextCustomDate('2026-11-11', null)).toThrow(/CUSTOM/);
    expect(() => nextCustomDate('2026-11-11', week(1, []))).toThrow(/weekdays/);
  });
});

describe('customDateOnOrAfter', () => {
  it('answers the date itself when it is on the pattern, else the next rule date', () => {
    expect(customDateOnOrAfter('2026-11-11', week(1, [3]))).toBe('2026-11-11');
    expect(customDateOnOrAfter('2026-11-12', week(1, [1, 3, 5]))).toBe('2026-11-13');
    expect(customDateOnOrAfter('2026-11-21', month(1, [5, 20]))).toBe('2026-12-05');
  });

  it('counts the interval from the start date, not the date asked about', () => {
    const everyOtherTue = week(2, [2]);
    expect(customDateOnOrAfter('2026-11-12', everyOtherTue, '2026-11-11')).toBe('2026-11-24');
    expect(customDateOnOrAfter('2026-11-12', everyOtherTue, '2026-11-18')).toBe('2026-11-17');
    expect(customDateOnOrAfter('2026-11-24', week(2, [2, 4]), '2026-11-11')).toBe('2026-11-24');
  });

  it('throws without a valid rule, like the stepper', () => {
    expect(() => customDateOnOrAfter('2026-11-11', null)).toThrow(/CUSTOM/);
  });
});

describe('normalizeCustomRecurrence', () => {
  it('sorts and de-duplicates, putting the last day last', () => {
    expect(normalizeCustomRecurrence({ unit: 'MONTH', interval: 1, monthDays: [-1, 20, 5, 20] })).toEqual({
      ok: true,
      rule: { unit: 'MONTH', interval: 1, monthDays: [5, 20, -1] },
    });
    expect(normalizeCustomRecurrence({ unit: 'WEEK', interval: 1, weekdays: [5, 1, 3, 1] })).toEqual({
      ok: true,
      rule: { unit: 'WEEK', interval: 1, weekdays: [1, 3, 5], weekStartsOn: 1 },
    });
    expect(normalizeCustomRecurrence({ unit: 'YEAR', interval: 2, dates: ['10-01', '02-01', '02-01'] })).toEqual({
      ok: true,
      rule: { unit: 'YEAR', interval: 2, dates: ['02-01', '10-01'] },
    });
  });

  it('defaults the interval to 1 and the week start to Monday', () => {
    expect(normalizeCustomRecurrence({ unit: 'WEEK', weekdays: [2] })).toEqual({
      ok: true,
      rule: { unit: 'WEEK', interval: 1, weekdays: [2], weekStartsOn: 1 },
    });
  });

  it('keeps 29 February', () => {
    expect(normalizeCustomRecurrence(year(1, ['02-29'])).ok).toBe(true);
  });

  it.each([
    ['null', null, 'notAnObject'],
    ['an array', [], 'notAnObject'],
    ['an unknown unit', { unit: 'DAY', interval: 1 }, 'unit'],
    ['interval 0', { unit: 'WEEK', interval: 0, weekdays: [1] }, 'interval'],
    ['interval 13', { unit: 'WEEK', interval: 13, weekdays: [1] }, 'interval'],
    ['a fractional interval', { unit: 'MONTH', interval: 1.5, monthDays: [1] }, 'interval'],
    ['no weekday', { unit: 'WEEK', interval: 1, weekdays: [] }, 'weekdays'],
    ['weekday 8', { unit: 'WEEK', interval: 1, weekdays: [8] }, 'weekdays'],
    ['weekday 0', { unit: 'WEEK', interval: 1, weekdays: [0] }, 'weekdays'],
    ['week start 7', { unit: 'WEEK', interval: 1, weekdays: [1], weekStartsOn: 7 }, 'weekStartsOn'],
    ['no day of the month', { unit: 'MONTH', interval: 1, monthDays: [] }, 'monthDays'],
    ['day 32', { unit: 'MONTH', interval: 1, monthDays: [32] }, 'monthDays'],
    ['day -2', { unit: 'MONTH', interval: 1, monthDays: [-2] }, 'monthDays'],
    ['no date', { unit: 'YEAR', interval: 1, dates: [] }, 'dates'],
    ['30 February', { unit: 'YEAR', interval: 1, dates: ['02-30'] }, 'dates'],
    ['a date without padding', { unit: 'YEAR', interval: 1, dates: ['2-1'] }, 'dates'],
    ['another unit\'s field', { unit: 'WEEK', interval: 1, weekdays: [1], monthDays: [1] }, 'extraField'],
  ])('refuses %s', (_name, raw, error) => {
    expect(normalizeCustomRecurrence(raw)).toEqual({ ok: false, error });
  });
});

describe('cadence figures', () => {
  it('counts occurrences per year from the rule', () => {
    expect(customOccurrencesPerYear(week(1, [1, 3, 5]))).toBeCloseTo((3 * 365.25) / 7, 6);
    expect(customOccurrencesPerYear(week(2, [1]))).toBeCloseTo(365.25 / 14, 6);
    expect(customOccurrencesPerYear(month(1, [5, 20, -1]))).toBe(36);
    expect(customOccurrencesPerYear(year(2, ['02-01', '06-01']))).toBe(1);
    expect(customOccurrencesPerYear(null)).toBe(0);
  });

  it('counts days that land on one date as one occurrence', () => {
    // The 31st and the last day are one date in every month.
    expect(customOccurrencesPerYear(month(1, [31, -1]))).toBe(12);
    // 29, 30 and 31: one date in February, two in a 30-day month, three in a
    // 31-day month, so 1 + 4 * 2 + 7 * 3 a year, leap year or not.
    expect(customOccurrencesPerYear(month(1, [29, 30, 31]))).toBe(30);
    expect(customOccurrencesPerYear(month(3, [31, -1]))).toBe(4);
    // 28 and 29 February are one date in three years of four.
    expect(customOccurrencesPerYear(year(1, ['02-28', '02-29']))).toBe(1.25);
  });
});
