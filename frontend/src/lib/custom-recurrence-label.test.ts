import { describe, it, expect } from 'vitest';
import { createTranslator } from 'next-intl';
import enScheduledTransactions from '@/i18n/messages/en/scheduledTransactions.json';
import {
  CustomRecurrenceTranslator,
  describeCustomRecurrence,
  formatList,
  formatMonthDay,
  monthName,
  orderedIsoWeekdays,
  weekdayName,
} from './custom-recurrence-label';

/** The real English templates, so a broken ICU message fails here. */
function translatorFor(locale: string): CustomRecurrenceTranslator {
  const t = createTranslator({
    locale,
    namespace: 'scheduledTransactions',
    messages: { scheduledTransactions: enScheduledTransactions } as Parameters<typeof createTranslator>[0]['messages'],
  });
  return (key, values) => (t as unknown as CustomRecurrenceTranslator)(key, values);
}

const en = translatorFor('en');

describe('describeCustomRecurrence', () => {
  it('lists weekdays with the language\'s own list joining', () => {
    const rule = { unit: 'WEEK' as const, interval: 1, weekdays: [5, 1, 3], weekStartsOn: 1 };
    expect(describeCustomRecurrence(rule, 'en', en)).toBe('Every week on Mon, Wed, and Fri');
    expect(describeCustomRecurrence(rule, 'en-GB', translatorFor('en-GB'))).toBe('Every week on Mon, Wed and Fri');
  });

  it('starts the weekday list on the rule\'s week start', () => {
    const rule = { unit: 'WEEK' as const, interval: 1, weekdays: [1, 7], weekStartsOn: 0 };
    expect(describeCustomRecurrence(rule, 'en', en)).toBe('Every week on Sun and Mon');
  });

  it('counts the interval', () => {
    expect(describeCustomRecurrence({ unit: 'WEEK', interval: 2, weekdays: [2] }, 'en', en)).toBe(
      'Every 2 weeks on Tue',
    );
    expect(describeCustomRecurrence({ unit: 'MONTH', interval: 3, monthDays: [15] }, 'en', en)).toBe(
      'Every 3 months on the 15th',
    );
    expect(describeCustomRecurrence({ unit: 'YEAR', interval: 2, dates: ['06-01'] }, 'en', en)).toBe(
      'Every 2 years on Jun 1',
    );
  });

  it('writes days of the month as ordinals, the last day last', () => {
    expect(
      describeCustomRecurrence({ unit: 'MONTH', interval: 1, monthDays: [-1, 1, 2, 3, 22] }, 'en', en),
    ).toBe('Every month on the 1st, 2nd, 3rd, 22nd, and last day');
  });

  it('writes yearly dates in the reader\'s language, 29 February included', () => {
    expect(describeCustomRecurrence({ unit: 'YEAR', interval: 1, dates: ['10-01', '02-29'] }, 'en', en)).toBe(
      'Every year on Feb 29 and Oct 1',
    );
    expect(describeCustomRecurrence({ unit: 'YEAR', interval: 1, dates: ['03-15'] }, 'de', en)).toBe(
      'Every year on 15. März',
    );
  });

  it('answers null for a rule that cannot be saved, so the caller chooses the fallback', () => {
    expect(describeCustomRecurrence(null, 'en', en)).toBeNull();
    expect(describeCustomRecurrence({ unit: 'WEEK', interval: 1, weekdays: [] }, 'en', en)).toBeNull();
  });
});

describe('Intl helpers', () => {
  it('names weekdays and months by ISO number', () => {
    expect(weekdayName(1, 'en')).toBe('Mon');
    expect(weekdayName(7, 'en', 'long')).toBe('Sunday');
    expect(monthName(3, 'en')).toBe('March');
    expect(formatMonthDay('12-25', 'en')).toBe('Dec 25');
  });

  it('falls back to English for the pseudo-locale and a malformed tag', () => {
    expect(weekdayName(1, 'xx')).toBe('Mon');
    expect(weekdayName(1, 'not a locale')).toBe('Mon');
    expect(formatList(['a', 'b'], undefined)).toBe('a and b');
  });

  it('orders a week from any start day', () => {
    expect(orderedIsoWeekdays(1)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(orderedIsoWeekdays(0)).toEqual([7, 1, 2, 3, 4, 5, 6]);
    expect(orderedIsoWeekdays(6)).toEqual([6, 7, 1, 2, 3, 4, 5]);
    expect(orderedIsoWeekdays(undefined)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});
