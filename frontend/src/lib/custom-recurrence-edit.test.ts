import { describe, it, expect } from 'vitest';
import {
  customDateOnOrAfter,
  customRecurrenceErrorKey,
  defaultCustomRecurrence,
  orphanedOverrideDates,
  sameCustomRecurrence,
} from './custom-recurrence-edit';
import type { CustomRecurrence } from './custom-recurrence';

const monWedFri: CustomRecurrence = { unit: 'WEEK', interval: 1, weekdays: [1, 3, 5], weekStartsOn: 1 };

describe('defaultCustomRecurrence', () => {
  it('starts from the start date\'s weekday, day of the month or date of the year', () => {
    // 2026-11-11 is a Wednesday.
    expect(defaultCustomRecurrence('WEEK', '2026-11-11', 0)).toEqual({
      unit: 'WEEK',
      interval: 1,
      weekdays: [3],
      weekStartsOn: 0,
    });
    expect(defaultCustomRecurrence('WEEK', '2026-11-15', 1).weekdays).toEqual([7]);
    expect(defaultCustomRecurrence('MONTH', '2026-11-11', 1)).toEqual({ unit: 'MONTH', interval: 1, monthDays: [11] });
    expect(defaultCustomRecurrence('YEAR', '2026-11-11T00:00:00Z', 1)).toEqual({
      unit: 'YEAR',
      interval: 1,
      dates: ['11-11'],
    });
  });
});

describe('customDateOnOrAfter', () => {
  it('answers the date itself when it is on the pattern, else the next rule date', () => {
    expect(customDateOnOrAfter('2026-11-11', monWedFri)).toBe('2026-11-11');
    expect(customDateOnOrAfter('2026-11-12', monWedFri)).toBe('2026-11-13');
  });

  it('counts the interval from the period start, not the date asked about', () => {
    const everyOtherTue: CustomRecurrence = { unit: 'WEEK', interval: 2, weekdays: [2], weekStartsOn: 1 };
    expect(customDateOnOrAfter('2026-11-12', everyOtherTue, '2026-11-11')).toBe('2026-11-24');
    expect(customDateOnOrAfter('2026-11-12', everyOtherTue, '2026-11-18')).toBe('2026-11-17');
  });

  it('answers null while the rule or the date is incomplete', () => {
    expect(customDateOnOrAfter('2026-11-12', { unit: 'WEEK', interval: 1, weekdays: [] })).toBeNull();
    expect(customDateOnOrAfter('', monWedFri)).toBeNull();
    expect(customDateOnOrAfter('2026-1', monWedFri)).toBeNull();
    expect(customDateOnOrAfter(undefined, monWedFri)).toBeNull();
  });
});

describe('orphanedOverrideDates', () => {
  const overrides = (...dates: string[]) => dates.map((originalDate) => ({ originalDate }));

  it('names the edited occurrences the new rule no longer reaches', () => {
    // Monthly on the 1st moving to Mon/Wed/Fri: 1 Dec 2026 is a Tuesday,
    // 1 Jan 2027 a Friday.
    expect(
      orphanedOverrideDates(
        { frequency: 'CUSTOM', nextDueDate: '2026-11-01', startDate: '2026-01-01', customRecurrence: monWedFri },
        overrides('2027-01-01T00:00:00Z', '2026-12-01'),
      ),
    ).toEqual(['2026-12-01']);
  });

  it('walks a fixed frequency too, from the due date and the start date\'s day', () => {
    expect(
      orphanedOverrideDates(
        { frequency: 'MONTHLY', nextDueDate: '2027-01-31', startDate: '2026-01-31' },
        overrides('2027-02-28', '2027-03-31', '2027-03-28'),
      ),
    ).toEqual(['2027-03-28']);
  });

  it('counts an override before the first slot as unreachable', () => {
    expect(
      orphanedOverrideDates(
        { frequency: 'CUSTOM', nextDueDate: '2026-11-12', startDate: '2026-11-12', customRecurrence: monWedFri },
        overrides('2026-11-12'),
      ),
    ).toEqual(['2026-11-12']);
  });

  it('keeps only the one slot of a one-time schedule', () => {
    expect(
      orphanedOverrideDates({ frequency: 'ONCE', nextDueDate: '2026-11-12' }, overrides('2026-11-12', '2026-12-12')),
    ).toEqual(['2026-12-12']);
  });

  it('names nothing while the rule is incomplete or there is nothing edited', () => {
    expect(
      orphanedOverrideDates(
        { frequency: 'CUSTOM', nextDueDate: '2026-11-12', customRecurrence: { unit: 'WEEK', interval: 1, weekdays: [] } },
        overrides('2026-11-13'),
      ),
    ).toEqual([]);
    expect(orphanedOverrideDates({ frequency: 'MONTHLY', nextDueDate: '2026-11-12' }, [])).toEqual([]);
  });
});

describe('customRecurrenceErrorKey', () => {
  it('names the missing days per unit, the interval, or nothing', () => {
    expect(customRecurrenceErrorKey(monWedFri)).toBeNull();
    expect(customRecurrenceErrorKey({ unit: 'WEEK', interval: 1, weekdays: [] })).toBe(
      'customRecurrence.errors.noDays.WEEK',
    );
    expect(customRecurrenceErrorKey({ unit: 'MONTH', interval: 1, monthDays: [] })).toBe(
      'customRecurrence.errors.noDays.MONTH',
    );
    expect(customRecurrenceErrorKey({ unit: 'YEAR', interval: 1, dates: [] })).toBe(
      'customRecurrence.errors.noDays.YEAR',
    );
    expect(customRecurrenceErrorKey({ unit: 'WEEK', interval: 0, weekdays: [1] })).toBe(
      'customRecurrence.errors.interval',
    );
    expect(customRecurrenceErrorKey(null)).toBe('customRecurrence.errors.invalid');
  });
});

describe('sameCustomRecurrence', () => {
  it('compares canonical forms, so order and duplicates do not count as a change', () => {
    expect(sameCustomRecurrence(monWedFri, { unit: 'WEEK', interval: 1, weekdays: [5, 3, 1, 1] })).toBe(true);
    expect(sameCustomRecurrence(monWedFri, { ...monWedFri, interval: 2 })).toBe(false);
    expect(sameCustomRecurrence(null, undefined)).toBe(true);
    expect(sameCustomRecurrence(null, monWedFri)).toBe(false);
  });
});
