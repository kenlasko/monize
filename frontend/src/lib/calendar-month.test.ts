import { describe, it, expect } from 'vitest';
import {
  CALENDAR_MONTH_PAGES,
  calendarDaysBetween,
  classifyCalendarDay,
  dayOfWeek,
  daysInMonth,
  isCalendarDate,
  isCalendarMonth,
  monthFromPageNumber,
  monthGridDays,
  monthOf,
  monthPageNumber,
  rotateWeekdayLabels,
  shiftDate,
  shiftMonth,
  type WeekStart,
} from './calendar-month';

const WEEK_STARTS: WeekStart[] = [0, 1, 2, 3, 4, 5, 6];

/** `common.weekdaysMin` as every locale stores it: Sunday first. */
const WEEKDAYS_MIN = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

describe('daysInMonth', () => {
  it.each([
    [2024, 2, 29],
    [2000, 2, 29],
    [2100, 2, 28],
    [2025, 1, 31],
    [2025, 4, 30],
    [2025, 12, 31],
  ])('gives %i-%i %i days', (year, month, expected) => {
    expect(daysInMonth(year, month)).toBe(expected);
  });
});

describe('isCalendarDate', () => {
  it.each(['2026-06-15', '2024-02-29', '2000-02-29', '2100-02-28', '2025-01-31', '1970-01-01', '2099-12-31'])(
    'accepts %s',
    (date) => {
      expect(isCalendarDate(date)).toBe(true);
    },
  );

  // The pattern alone would take 2100-02-29: 2100 is divisible by 4 and is not
  // a leap year, and a Date built from the string normalizes it to 1 March
  // instead of rejecting it, so the string is the only place to catch it.
  it.each(['2100-02-29', '2025-02-30', '2025-04-31', '2025-13-01', '2025-00-10', '2025-06-32', '2025-6-1', '2025-06', '', 'yesterday'])(
    'rejects %s',
    (date) => {
      expect(isCalendarDate(date)).toBe(false);
    },
  );
});

describe('isCalendarMonth', () => {
  it.each(['2026-06', '2024-02', '2099-12'])('accepts %s', (month) => {
    expect(isCalendarMonth(month)).toBe(true);
  });

  it.each(['2026-13', '2026-00', '2026-6', '2026-06-15', ''])('rejects %s', (month) => {
    expect(isCalendarMonth(month)).toBe(false);
  });
});

describe('dayOfWeek', () => {
  it.each([
    ['2026-06-15', 1],
    ['2024-02-29', 4],
    ['2000-02-29', 2],
    ['2100-02-28', 0],
    ['2025-01-31', 5],
    ['2025-12-31', 3],
    ['1970-01-01', 4],
    ['2099-12-31', 4],
  ])('reads %s as weekday %i', (date, expected) => {
    expect(dayOfWeek(date)).toBe(expected);
  });

  it('rejects a date that does not exist', () => {
    expect(() => dayOfWeek('2100-02-29')).toThrow(/calendar date/);
  });
});

describe('monthGridDays', () => {
  it.each(WEEK_STARTS)('covers the whole month in whole weeks starting on %i', (weekStartsOn) => {
    for (const month of ['2024-02', '2025-01', '2025-12', '2026-06', '2100-02']) {
      const days = monthGridDays(month, weekStartsOn);

      expect(days.length % 7).toBe(0);
      expect(dayOfWeek(days[0])).toBe(weekStartsOn);
      expect(days[0] <= `${month}-01`).toBe(true);
      expect(days[days.length - 1] >= `${month}-28`).toBe(true);

      // Contiguous and unique: a grid that repeats or skips a day puts two
      // days' transactions on one cell.
      expect(new Set(days).size).toBe(days.length);
      const inMonth = days.filter((day) => day.startsWith(`${month}-`));
      const [year, monthNumber] = month.split('-').map(Number);
      expect(inMonth.length).toBe(daysInMonth(year, monthNumber));
    }
  });

  it('includes the leap day in February 2024', () => {
    expect(monthGridDays('2024-02', 0)).toContain('2024-02-29');
  });

  it('stops at the 28th in February 2100, which is not a leap year', () => {
    const days = monthGridDays('2100-02', 0);
    expect(days).toContain('2100-02-28');
    expect(days).not.toContain('2100-02-29');
  });

  it('borrows the adjacent months at both ends', () => {
    // 2026-06-01 is a Monday; a Sunday-start grid borrows 31 May and runs to
    // Saturday 4 July.
    const days = monthGridDays('2026-06', 0);
    expect(days[0]).toBe('2026-05-31');
    expect(days[days.length - 1]).toBe('2026-07-04');
    expect(days).toHaveLength(35);
  });

  it('needs six weeks when the month starts late and is long', () => {
    // 2025-08-01 is a Friday; 31 days from Friday spill into a sixth row.
    const days = monthGridDays('2025-08', 0);
    expect(days).toHaveLength(42);
    expect(days[0]).toBe('2025-07-27');
    expect(days[days.length - 1]).toBe('2025-09-06');
  });

  it('is five weeks for a January that starts midweek', () => {
    const days = monthGridDays('2025-01', 0);
    expect(days).toHaveLength(35);
    expect(days[0]).toBe('2024-12-29');
    expect(days[days.length - 1]).toBe('2025-02-01');
  });

  it('is four weeks for a non-leap February aligned to the week start', () => {
    // 2021-02-01 is a Monday: four whole weeks already cover the month, so a
    // Monday-start grid borrows nothing at either end.
    const days = monthGridDays('2021-02', 1);
    expect(days).toHaveLength(28);
    expect(days[0]).toBe('2021-02-01');
    expect(days[days.length - 1]).toBe('2021-02-28');
  });

  it('crosses the year end', () => {
    const days = monthGridDays('2025-12', 0);
    expect(days).toContain('2025-12-31');
    expect(days).toContain('2026-01-01');
  });

  it('rejects a month it cannot draw', () => {
    expect(() => monthGridDays('2026-13', 0)).toThrow(/calendar month/);
    expect(() => monthGridDays('2026-06-15', 0)).toThrow(/calendar month/);
  });
});

describe('rotateWeekdayLabels', () => {
  it('leaves a Sunday-start week alone', () => {
    expect(rotateWeekdayLabels(WEEKDAYS_MIN, 0)).toEqual(WEEKDAYS_MIN);
  });

  it('puts Monday first for a Monday-start week', () => {
    expect(rotateWeekdayLabels(WEEKDAYS_MIN, 1)).toEqual(['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']);
  });

  it.each(WEEK_STARTS)('agrees with the grid for week start %i', (weekStartsOn) => {
    const labels = rotateWeekdayLabels(WEEKDAYS_MIN, weekStartsOn);
    const days = monthGridDays('2026-06', weekStartsOn);

    // The column a day lands in must be the column its own weekday labels.
    days.slice(0, 7).forEach((day, column) => {
      expect(labels[column]).toBe(WEEKDAYS_MIN[dayOfWeek(day)]);
    });
  });
});

describe('shiftMonth', () => {
  it.each([
    ['2026-06', 1, '2026-07'],
    ['2026-06', -1, '2026-05'],
    ['2025-12', 1, '2026-01'],
    ['2026-01', -1, '2025-12'],
    ['2025-01', 13, '2026-02'],
    ['2025-01', -13, '2023-12'],
    ['2026-06', 0, '2026-06'],
  ])('%s shifted by %i is %s', (month, delta, expected) => {
    expect(shiftMonth(month, delta)).toBe(expected);
  });

  it('does not clamp a day, because it carries none', () => {
    // Month arithmetic on a date is where 31 January plus a month becomes
    // either 28 February or 3 March depending on the library; a month string
    // has no day to lose.
    expect(shiftMonth(monthOf('2025-01-31'), 1)).toBe('2025-02');
  });
});

describe('month page numbers', () => {
  it.each([
    ['0001-01', 1],
    ['0001-12', 12],
    ['0002-01', 13],
    ['2026-06', 24306],
    ['9999-12', CALENDAR_MONTH_PAGES],
  ])('%s is page %i', (month, page) => {
    expect(monthPageNumber(month)).toBe(page);
    expect(monthFromPageNumber(page)).toBe(month);
  });

  it('numbers adjacent months adjacently, which is what a swipe steps by', () => {
    // The gesture adds or subtracts one. Were the numbering not contiguous
    // across a year end, a swipe in December would land somewhere else entirely.
    expect(monthFromPageNumber(monthPageNumber('2025-12') + 1)).toBe('2026-01');
    expect(monthFromPageNumber(monthPageNumber('2026-01') - 1)).toBe('2025-12');
  });

  it('round-trips every month of a leap year and its neighbours', () => {
    for (const year of [2023, 2024, 2025]) {
      for (let monthNumber = 1; monthNumber <= 12; monthNumber += 1) {
        const month = `${year}-${String(monthNumber).padStart(2, '0')}`;
        expect(monthFromPageNumber(monthPageNumber(month))).toBe(month);
      }
    }
  });

  it('agrees with shiftMonth, so the two ways to move a month cannot diverge', () => {
    expect(monthFromPageNumber(monthPageNumber('2026-06') + 1)).toBe(shiftMonth('2026-06', 1));
    expect(monthFromPageNumber(monthPageNumber('2026-06') - 1)).toBe(shiftMonth('2026-06', -1));
  });

  it('refuses a page outside the range rather than inventing a month', () => {
    expect(() => monthFromPageNumber(0)).toThrow(/month page/);
    expect(() => monthFromPageNumber(CALENDAR_MONTH_PAGES + 1)).toThrow(/month page/);
    expect(() => monthFromPageNumber(1.5)).toThrow(/month page/);
  });

  it('refuses anything that is not a calendar month', () => {
    expect(() => monthPageNumber('2026-13')).toThrow(/calendar month/);
    expect(() => monthPageNumber('2026-06-15')).toThrow(/calendar month/);
  });
});

describe('monthOf', () => {
  it.each([
    ['2026-06-15', '2026-06'],
    ['2024-02-29', '2024-02'],
    ['2025-12-31', '2025-12'],
  ])('%s belongs to %s', (date, expected) => {
    expect(monthOf(date)).toBe(expected);
  });

  it('rejects a date that does not exist', () => {
    expect(() => monthOf('2100-02-29')).toThrow(/calendar date/);
  });
});

describe('classifyCalendarDay', () => {
  const today = '2026-06-15';

  it.each([
    ['2026-06-14', 'past'],
    ['2026-06-15', 'today'],
    ['2026-06-16', 'future'],
    ['2025-12-31', 'past'],
    ['2026-07-01', 'future'],
  ])('%s is %s', (date, expected) => {
    expect(classifyCalendarDay(date, today)).toBe(expected);
  });

  it('takes today as an argument, so the browser clock cannot decide it', () => {
    // Design I2: the server's day decides actual-versus-projected. Passing a
    // different "today" must move the boundary with it.
    expect(classifyCalendarDay('2026-06-16', '2026-06-20')).toBe('past');
    expect(classifyCalendarDay('2026-06-16', '2026-06-10')).toBe('future');
  });

  it('rejects a date that does not exist on either side', () => {
    expect(() => classifyCalendarDay('2100-02-29', today)).toThrow(/calendar date/);
    expect(() => classifyCalendarDay(today, '2100-02-29')).toThrow(/calendar date/);
  });
});

describe('shiftDate', () => {
  it('steps a day in either direction', () => {
    expect(shiftDate('2026-06-10', 1)).toBe('2026-06-11');
    expect(shiftDate('2026-06-10', -1)).toBe('2026-06-09');
    expect(shiftDate('2026-06-10', 0)).toBe('2026-06-10');
  });

  it('rolls the month and the year', () => {
    expect(shiftDate('2026-01-31', 1)).toBe('2026-02-01');
    expect(shiftDate('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftDate('2026-12-31', 1)).toBe('2027-01-01');
    expect(shiftDate('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('counts the leap day in and out', () => {
    expect(shiftDate('2024-02-28', 1)).toBe('2024-02-29');
    expect(shiftDate('2024-03-01', -1)).toBe('2024-02-29');
    // 2100 is divisible by 4 and is not a leap year.
    expect(shiftDate('2100-02-28', 1)).toBe('2100-03-01');
  });

  it('steps a whole year without drifting', () => {
    expect(shiftDate('2026-06-10', 365)).toBe('2027-06-10');
    expect(shiftDate('2024-01-01', 366)).toBe('2025-01-01');
  });

  it('refuses a date that is not one', () => {
    expect(() => shiftDate('2026-02-30', 1)).toThrow();
  });
});

describe('calendarDaysBetween', () => {
  it('counts one day as one day', () => {
    expect(calendarDaysBetween('2026-06-10', '2026-06-10')).toBe(1);
  });

  it('counts inclusively, both ends', () => {
    expect(calendarDaysBetween('2026-06-14', '2026-06-18')).toBe(5);
  });

  it('counts across a month and a year end', () => {
    expect(calendarDaysBetween('2026-01-30', '2026-02-02')).toBe(4);
    expect(calendarDaysBetween('2026-12-30', '2027-01-02')).toBe(4);
  });

  it('counts the leap day', () => {
    expect(calendarDaysBetween('2024-02-28', '2024-03-01')).toBe(3);
    expect(calendarDaysBetween('2026-02-28', '2026-03-01')).toBe(2);
  });

  it('reports a backwards range as negative, so a caller cannot read it as one day', () => {
    expect(calendarDaysBetween('2026-06-18', '2026-06-14')).toBe(-5);
    expect(calendarDaysBetween('2026-06-11', '2026-06-10')).toBe(-2);
  });
});
