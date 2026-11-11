import { describe, it, expect } from 'vitest';
import { advanceByFrequency, advanceSchedule, anchorDayOf, isOneTime, monthlyEquivalent } from './frequency';
import { FREQUENCY_VALUES, FrequencyType } from '@/types/scheduled-transaction';
import type { CustomRecurrence, CustomStepContext } from './custom-recurrence';

/** `YYYY-MM-DD` for a local-time Date, matching how the callers key dates. */
function ymd(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

const from = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
};

/** Mon, Wed, Fri every week: the rule a CUSTOM step needs to step at all. */
const MON_WED_FRI: CustomRecurrence = { unit: 'WEEK', interval: 1, weekdays: [1, 3, 5], weekStartsOn: 1 };
const CUSTOM_CONTEXT: CustomStepContext = { rule: MON_WED_FRI, startDate: '2026-05-10' };

const step = (iso: string, frequency: FrequencyType) =>
  ymd(advanceByFrequency(from(iso), frequency, undefined, frequency === 'CUSTOM' ? CUSTOM_CONTEXT : undefined));

describe('advanceByFrequency', () => {
  it.each([
    ['DAILY', '2026-05-10', '2026-05-11'],
    ['WEEKLY', '2026-05-10', '2026-05-17'],
    ['BIWEEKLY', '2026-05-10', '2026-05-24'],
    ['EVERY4WEEKS', '2026-05-10', '2026-06-07'],
    ['MONTHLY', '2026-05-10', '2026-06-10'],
    ['EVERY2MONTHS', '2026-05-10', '2026-07-10'],
    ['QUARTERLY', '2026-05-10', '2026-08-10'],
    ['EVERY4MONTHS', '2026-05-10', '2026-09-10'],
    ['SEMIANNUAL', '2026-05-10', '2026-11-10'],
    ['YEARLY', '2026-05-10', '2027-05-10'],
    ['EVERY2YEARS', '2026-05-10', '2028-05-10'],
  ] as [FrequencyType, string, string][])('steps %s from %s to %s', (frequency, start, expected) => {
    expect(step(start, frequency)).toBe(expected);
  });

  it('handles every frequency the type allows, and every one but ONCE moves forward', () => {
    // A recurring frequency that returns the same date is a calendar or a
    // forecast that projects one occurrence over and over -- the SEMIMONTHLY
    // defect this module was extracted to fix.
    for (const frequency of FREQUENCY_VALUES) {
      const custom = frequency === 'CUSTOM' ? CUSTOM_CONTEXT : undefined;
      expect(() => advanceByFrequency(from('2026-05-10'), frequency, undefined, custom)).not.toThrow();
      const stepped = step('2026-05-10', frequency);
      if (frequency === 'ONCE') {
        expect(stepped).toBe('2026-05-10');
      } else {
        expect(stepped > '2026-05-10').toBe(true);
      }
    }
  });

  describe('CUSTOM', () => {
    it('steps to the next rule date: Sunday 10 May 2026 to Monday the 11th, then Wednesday', () => {
      expect(step('2026-05-10', 'CUSTOM')).toBe('2026-05-11');
      expect(step('2026-05-11', 'CUSTOM')).toBe('2026-05-13');
    });

    it('throws without a rule, rather than repeating one date', () => {
      expect(() => advanceByFrequency(from('2026-05-10'), 'CUSTOM')).toThrow(/CUSTOM/);
    });

    it('keeps the time of day of the input', () => {
      const next = advanceByFrequency(new Date(2026, 4, 10, 9, 30), 'CUSTOM', undefined, CUSTOM_CONTEXT);
      expect([next.getHours(), next.getMinutes()]).toEqual([9, 30]);
    });
  });

  describe('advanceSchedule', () => {
    it('reads the anchor day from the start date', () => {
      const next = advanceSchedule(from('2027-02-28'), { frequency: 'MONTHLY', startDate: '2027-01-31' });
      expect(ymd(next)).toBe('2027-03-31');
    });

    it('reads the rule and the period anchor from the schedule', () => {
      const schedule = {
        frequency: 'CUSTOM' as const,
        startDate: '2026-11-11',
        customRecurrence: { unit: 'WEEK' as const, interval: 2, weekdays: [2, 4], weekStartsOn: 1 },
      };
      expect(ymd(advanceSchedule(from('2026-11-12'), schedule))).toBe('2026-11-24');
    });
  });

  it('never mutates the input date', () => {
    const input = from('2026-05-10');
    advanceByFrequency(input, 'YEARLY');
    expect(ymd(input)).toBe('2026-05-10');
  });

  it('returns an equal date for ONCE, so callers must stop themselves', () => {
    expect(step('2026-05-10', 'ONCE')).toBe('2026-05-10');
    expect(isOneTime('ONCE')).toBe(true);
    expect(isOneTime('MONTHLY')).toBe(false);
  });

  describe('month-end clamping', () => {
    it('clamps a 31st into a 30-day month instead of overflowing', () => {
      // setMonth alone would give 2026-07-01 here.
      expect(step('2026-05-31', 'MONTHLY')).toBe('2026-06-30');
    });

    it('clamps into February, leap and non-leap', () => {
      expect(step('2026-12-31', 'EVERY2MONTHS')).toBe('2027-02-28');
      expect(step('2023-12-31', 'EVERY2MONTHS')).toBe('2024-02-29');
      expect(step('2026-08-31', 'SEMIANNUAL')).toBe('2027-02-28');
    });

    it('clamps Feb 29 to Feb 28 a year later', () => {
      expect(step('2024-02-29', 'YEARLY')).toBe('2025-02-28');
    });
  });

  describe('anchor day', () => {
    const stepAnchored = (iso: string, frequency: FrequencyType, anchor: number) =>
      ymd(advanceByFrequency(from(iso), frequency, anchor));

    it('returns to the 31st after a short month', () => {
      expect(stepAnchored('2027-01-31', 'MONTHLY', 31)).toBe('2027-02-28');
      expect(stepAnchored('2027-02-28', 'MONTHLY', 31)).toBe('2027-03-31');
    });

    it('returns to Feb 29 on the next leap year', () => {
      expect(stepAnchored('2031-02-28', 'YEARLY', 29)).toBe('2032-02-29');
    });

    it('anchorDayOf: start day, clamped start day, or the moved day', () => {
      expect(anchorDayOf('2027-01-31', from('2027-02-28'))).toBe(31);
      expect(anchorDayOf('2028-02-29', from('2029-02-28'))).toBe(29);
      expect(anchorDayOf('2027-01-01', from('2027-03-28'))).toBe(28);
      expect(anchorDayOf('2027-01-31', from('2027-03-28'))).toBe(28);
      expect(anchorDayOf(null, from('2027-03-28'))).toBeUndefined();
    });
  });

  describe('the two frequencies PR #192 mis-mapped', () => {
    it('EVERY2MONTHS is two months, not two weeks', () => {
      expect(step('2026-05-10', 'EVERY2MONTHS')).toBe('2026-07-10');
      expect(step('2026-05-10', 'EVERY2MONTHS')).not.toBe(step('2026-05-10', 'BIWEEKLY'));
    });

    it('SEMIANNUAL is six months, not a year', () => {
      expect(step('2026-05-10', 'SEMIANNUAL')).toBe('2026-11-10');
      expect(step('2026-05-10', 'SEMIANNUAL')).not.toBe(step('2026-05-10', 'YEARLY'));
    });

    it('six EVERY2MONTHS steps and two SEMIANNUAL steps each cover a year', () => {
      let bimonthly = from('2026-01-15');
      for (let i = 0; i < 6; i++) bimonthly = advanceByFrequency(bimonthly, 'EVERY2MONTHS');
      expect(ymd(bimonthly)).toBe('2027-01-15');

      let semiannual = from('2026-01-15');
      for (let i = 0; i < 2; i++) semiannual = advanceByFrequency(semiannual, 'SEMIANNUAL');
      expect(ymd(semiannual)).toBe('2027-01-15');
    });
  });

  describe('SEMIMONTHLY', () => {
    it('goes from on-or-before the 15th to the end of the month', () => {
      expect(step('2026-05-01', 'SEMIMONTHLY')).toBe('2026-05-31');
      expect(step('2026-05-15', 'SEMIMONTHLY')).toBe('2026-05-31');
    });

    it('goes from the end of the month to the 15th of the next', () => {
      expect(step('2026-05-31', 'SEMIMONTHLY')).toBe('2026-06-15');
      expect(step('2025-02-28', 'SEMIMONTHLY')).toBe('2025-03-15');
    });

    it('always advances, so a calendar loop terminates', () => {
      // Regression: the bills calendar and the upcoming-bills report had no
      // SEMIMONTHLY case, so nextDate never moved and the same day repeated
      // until the iteration cap.
      let date = from('2026-01-10');
      for (let i = 0; i < 8; i++) {
        const next = advanceByFrequency(date, 'SEMIMONTHLY');
        expect(next.getTime()).toBeGreaterThan(date.getTime());
        date = next;
      }
    });
  });
});

describe('monthlyEquivalent', () => {
  it('leaves a monthly amount unchanged', () => {
    expect(monthlyEquivalent(100, 'MONTHLY')).toBe(100);
  });

  it.each([
    ['EVERY2MONTHS', 120, 60],
    ['QUARTERLY', 120, 40],
    ['SEMIANNUAL', 120, 20],
    ['YEARLY', 120, 10],
    ['SEMIMONTHLY', 100, 200],
  ] as [FrequencyType, number, number][])('spreads %s over a month', (frequency, amount, expected) => {
    expect(monthlyEquivalent(amount, frequency)).toBeCloseTo(expected, 6);
  });

  it('spreads a CUSTOM amount by the rule: three weekdays a week, or two days a month every 2 months', () => {
    expect(monthlyEquivalent(100, 'CUSTOM', MON_WED_FRI)).toBeCloseTo((100 * 3 * 365.25) / 7 / 12, 6);
    expect(monthlyEquivalent(100, 'CUSTOM', { unit: 'MONTH', interval: 2, monthDays: [1, 15] })).toBeCloseTo(100, 6);
  });

  it('counts a CUSTOM amount with no rule as no recurring cost, rather than guessing', () => {
    expect(monthlyEquivalent(100, 'CUSTOM', null)).toBe(0);
  });

  it('treats a one-time entry as no recurring monthly cost', () => {
    expect(monthlyEquivalent(500, 'ONCE')).toBe(0);
  });

  it('uses the real year length for the week-based frequencies', () => {
    expect(monthlyEquivalent(100, 'WEEKLY')).toBeCloseTo((100 * 365.25) / 7 / 12, 6);
    expect(monthlyEquivalent(100, 'BIWEEKLY')).toBeCloseTo((100 * 365.25) / 14 / 12, 6);
    expect(monthlyEquivalent(100, 'EVERY4WEEKS')).toBeCloseTo((100 * 365.25) / 28 / 12, 6);
  });

  it('covers every frequency, so a new one cannot silently count as zero', () => {
    for (const frequency of FREQUENCY_VALUES) {
      if (frequency === 'ONCE') continue;
      const rule = frequency === 'CUSTOM' ? MON_WED_FRI : undefined;
      expect(monthlyEquivalent(100, frequency, rule)).toBeGreaterThan(0);
    }
  });
});
