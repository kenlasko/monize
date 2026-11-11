import { describe, it, expect } from 'vitest';
import {
  customRecurrenceErrorKey,
  defaultCustomRecurrence,
  isOnCustomPattern,
  orphanedOverrideDates,
  sameCustomRecurrence,
  savedNextDueDate,
  StoredSchedule,
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

describe('savedNextDueDate: the date the server stores', () => {
  const storedCustom: StoredSchedule = {
    frequency: 'CUSTOM',
    nextDueDate: '2026-11-13',
    startDate: '2026-11-11',
    customRecurrence: monWedFri,
  };

  it('snaps a new schedule onto the pattern, periods counted from the typed date', () => {
    expect(savedNextDueDate({ frequency: 'CUSTOM', nextDueDate: '2026-11-11', customRecurrence: monWedFri })).toBe(
      '2026-11-11',
    );
    expect(savedNextDueDate({ frequency: 'CUSTOM', nextDueDate: '2026-11-12', customRecurrence: monWedFri })).toBe(
      '2026-11-13',
    );
  });

  it('keeps a typed date off the pattern while the rule is unchanged, as the server does', () => {
    // Thursday 12 November is not a Mon/Wed/Fri, and the server stores it as typed.
    const edited = { frequency: 'CUSTOM' as const, nextDueDate: '2026-11-12', customRecurrence: monWedFri };
    expect(savedNextDueDate(edited, storedCustom)).toBe('2026-11-12');
    // The same rule in another order is the same rule.
    expect(
      savedNextDueDate({ ...edited, customRecurrence: { ...monWedFri, weekdays: [5, 3, 1] } }, storedCustom),
    ).toBe('2026-11-12');
  });

  it('snaps on an update that changes the rule, periods counted from the stored start date', () => {
    const everyOtherTue: CustomRecurrence = { unit: 'WEEK', interval: 2, weekdays: [2], weekStartsOn: 1 };
    expect(
      savedNextDueDate({ frequency: 'CUSTOM', nextDueDate: '2026-11-12', customRecurrence: everyOtherTue }, storedCustom),
    ).toBe('2026-11-24');
  });

  it('snaps on an update that moves a fixed frequency to Custom', () => {
    expect(
      savedNextDueDate(
        { frequency: 'CUSTOM', nextDueDate: '2026-11-12', customRecurrence: monWedFri },
        { frequency: 'MONTHLY', nextDueDate: '2026-11-12', startDate: '2026-01-12', customRecurrence: null },
      ),
    ).toBe('2026-11-13');
  });

  it('stores a fixed frequency\'s date as typed, and nothing while the edit is incomplete', () => {
    expect(savedNextDueDate({ frequency: 'MONTHLY', nextDueDate: '2026-11-12' }, storedCustom)).toBe('2026-11-12');
    expect(
      savedNextDueDate({ frequency: 'CUSTOM', nextDueDate: '2026-11-12', customRecurrence: { ...monWedFri, weekdays: [] } }),
    ).toBeNull();
    expect(savedNextDueDate({ frequency: 'CUSTOM', nextDueDate: '2026-1', customRecurrence: monWedFri })).toBeNull();
    expect(savedNextDueDate({ frequency: 'CUSTOM', nextDueDate: undefined, customRecurrence: monWedFri })).toBeNull();
  });
});

describe('isOnCustomPattern', () => {
  it('tells a slot from a day that is not one, counting periods from the start', () => {
    const rule: CustomRecurrence = { unit: 'WEEK', interval: 2, weekdays: [2, 4], weekStartsOn: 1 };
    expect(isOnCustomPattern('2026-11-24', rule, '2026-11-11')).toBe(true);
    expect(isOnCustomPattern('2026-11-17', rule, '2026-11-11')).toBe(false);
    expect(isOnCustomPattern('2026-11-18', rule, '2026-11-11')).toBe(false);
    expect(isOnCustomPattern('2026-11-18', null)).toBe(false);
  });
});

describe('orphanedOverrideDates: what the server deletes', () => {
  const overrides = (...dates: string[]) => dates.map((originalDate) => ({ originalDate }));
  const monthlyOnThe1st: StoredSchedule = {
    frequency: 'MONTHLY',
    nextDueDate: '2026-11-01',
    startDate: '2026-01-01',
    customRecurrence: null,
  };

  it('names the edited occurrences the new rule no longer reaches', () => {
    // Monthly on the 1st moving to Mon/Wed/Fri: 1 Dec 2026 is a Tuesday,
    // 1 Jan 2027 a Friday.
    expect(
      orphanedOverrideDates(
        { frequency: 'CUSTOM', nextDueDate: '2026-11-01', customRecurrence: monWedFri },
        monthlyOnThe1st,
        overrides('2027-01-01T00:00:00Z', '2026-12-01'),
      ),
    ).toEqual(['2026-12-01']);
  });

  it('walks a fixed frequency too, from the due date and the start date\'s day', () => {
    expect(
      orphanedOverrideDates(
        { frequency: 'MONTHLY', nextDueDate: '2027-01-31' },
        { frequency: 'WEEKLY', nextDueDate: '2027-01-31', startDate: '2026-01-31' },
        overrides('2027-02-28', '2027-03-31', '2027-03-28'),
      ),
    ).toEqual(['2027-03-28']);
  });

  it('names nothing when neither the frequency nor the rule changes', () => {
    // An override off the pattern stays: the server prunes only on a pattern change.
    expect(
      orphanedOverrideDates(
        { frequency: 'CUSTOM', nextDueDate: '2026-11-13', customRecurrence: { ...monWedFri, weekdays: [5, 1, 3] } },
        { frequency: 'CUSTOM', nextDueDate: '2026-11-13', startDate: '2026-11-11', customRecurrence: monWedFri },
        overrides('2026-11-17'),
      ),
    ).toEqual([]);
  });

  it('counts an override between the stored due date and the snapped one', () => {
    // Thursday 12 November snaps to Friday 13th; the 12th is on or after the
    // stored due date, so the server deletes it.
    expect(
      orphanedOverrideDates(
        { frequency: 'CUSTOM', nextDueDate: '2026-11-12', customRecurrence: monWedFri },
        { ...monthlyOnThe1st, nextDueDate: '2026-11-12', startDate: '2026-01-12' },
        overrides('2026-11-12'),
      ),
    ).toEqual(['2026-11-12']);
  });

  it('leaves an override before both the stored and the saved due date, which the server keeps', () => {
    // Snapped to Friday 13 November; the 10th is before the stored cursor too.
    expect(
      orphanedOverrideDates(
        { frequency: 'CUSTOM', nextDueDate: '2026-11-12', customRecurrence: monWedFri },
        { ...monthlyOnThe1st, nextDueDate: '2026-11-12', startDate: '2026-01-12' },
        overrides('2026-11-10'),
      ),
    ).toEqual([]);
  });

  it('counts an override from a due date moved earlier than the stored one', () => {
    expect(
      orphanedOverrideDates(
        { frequency: 'WEEKLY', nextDueDate: '2026-11-02' },
        { ...monthlyOnThe1st, nextDueDate: '2026-12-01' },
        overrides('2026-11-03'),
      ),
    ).toEqual(['2026-11-03']);
  });

  it('keeps an override beyond the server\'s 2000-slot walk, naming only those within it', () => {
    // Weekly from Monday 2 November 2026: slot 2000 is in 2065. Both overrides
    // fall on a Thursday, which no weekly slot reaches.
    expect(
      orphanedOverrideDates(
        { frequency: 'WEEKLY', nextDueDate: '2026-11-02' },
        { ...monthlyOnThe1st, nextDueDate: '2026-11-02' },
        overrides('2060-01-01', '2070-01-02'),
      ),
    ).toEqual(['2060-01-01']);
  });

  it('keeps only the one slot of a one-time schedule', () => {
    expect(
      orphanedOverrideDates(
        { frequency: 'ONCE', nextDueDate: '2026-11-01' },
        monthlyOnThe1st,
        overrides('2026-11-01', '2026-12-01'),
      ),
    ).toEqual(['2026-12-01']);
  });

  it('names nothing while the rule is incomplete or there is nothing edited', () => {
    expect(
      orphanedOverrideDates(
        { frequency: 'CUSTOM', nextDueDate: '2026-11-12', customRecurrence: { unit: 'WEEK', interval: 1, weekdays: [] } },
        monthlyOnThe1st,
        overrides('2026-11-13'),
      ),
    ).toEqual([]);
    expect(orphanedOverrideDates({ frequency: 'WEEKLY', nextDueDate: '2026-11-12' }, monthlyOnThe1st, [])).toEqual([]);
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
