import { describe, it, expect } from 'vitest';
import { ScheduledTransaction } from '@/types/scheduled-transaction';
import {
  buildScheduledCalendarDays,
  occurrencesInWindow,
} from './scheduled-calendar';

const schedule = (over: Partial<ScheduledTransaction> = {}) =>
  ({
    id: 'st-1',
    name: 'Rent',
    amount: -1200,
    currencyCode: 'CAD',
    frequency: 'MONTHLY',
    nextDueDate: '2026-03-05',
    isActive: true,
    futureOverrides: [],
    ...over,
  }) as ScheduledTransaction;

const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

describe('occurrencesInWindow', () => {
  it('walks a repeating schedule across the window', () => {
    const dates = occurrencesInWindow(
      schedule(),
      new Date(2026, 2, 1),
      new Date(2026, 5, 30),
    );
    expect(dates.map(iso)).toEqual([
      '2026-03-05',
      '2026-04-05',
      '2026-05-05',
      '2026-06-05',
    ]);
  });

  it('walks a Custom schedule by its rule, its periods counted from the start date', () => {
    // Every other week on Tuesday and Thursday, from the week of Wed 4 March.
    const dates = occurrencesInWindow(
      schedule({
        frequency: 'CUSTOM',
        nextDueDate: '2026-03-05',
        startDate: '2026-03-04',
        customRecurrence: { unit: 'WEEK', interval: 2, weekdays: [2, 4], weekStartsOn: 1 },
      }),
      new Date(2026, 2, 1),
      new Date(2026, 2, 31),
    );
    expect(dates.map(iso)).toEqual(['2026-03-05', '2026-03-17', '2026-03-19', '2026-03-31']);
  });

  it('stops after the single date of a one-time schedule', () => {
    const dates = occurrencesInWindow(
      schedule({ frequency: 'ONCE' }),
      new Date(2026, 2, 1),
      new Date(2026, 5, 30),
    );
    expect(dates.map(iso)).toEqual(['2026-03-05']);
  });

  it('places a moved occurrence on the day it was moved to', () => {
    const dates = occurrencesInWindow(
      schedule({
        frequency: 'ONCE',
        futureOverrides: [
          { originalDate: '2026-03-05', overrideDate: '2026-03-19' },
        ] as ScheduledTransaction['futureOverrides'],
      }),
      new Date(2026, 2, 1),
      new Date(2026, 2, 31),
    );
    expect(dates.map(iso)).toEqual(['2026-03-19']);
  });

  it('falls back to nextOverride when futureOverrides is not populated', () => {
    const dates = occurrencesInWindow(
      schedule({
        frequency: 'ONCE',
        futureOverrides: undefined,
        nextOverride: { overrideDate: '2026-03-19' },
      } as Partial<ScheduledTransaction>),
      new Date(2026, 2, 1),
      new Date(2026, 2, 31),
    );
    expect(dates.map(iso)).toEqual(['2026-03-19']);
  });

  it('returns nothing for a schedule with no due date', () => {
    expect(
      occurrencesInWindow(
        schedule({ nextDueDate: undefined }),
        new Date(2026, 2, 1),
        new Date(2026, 2, 31),
      ),
    ).toEqual([]);
  });
});

describe('buildScheduledCalendarDays', () => {
  it('covers whole weeks and marks the days borrowed from the neighbouring months', () => {
    const days = buildScheduledCalendarDays([], new Date(2026, 2, 15));
    expect(days.length % 7).toBe(0);
    expect(days[0].date.getDay()).toBe(0);
    expect(days[days.length - 1].date.getDay()).toBe(6);
    // 1 March 2026 is a Sunday, so the grid opens on the month itself.
    expect(days[0].isCurrentMonth).toBe(true);
    expect(days[days.length - 1].isCurrentMonth).toBe(false);
  });

  it('places each occurrence on its day', () => {
    const days = buildScheduledCalendarDays([schedule()], new Date(2026, 2, 15));
    const withBills = days.filter((d) => d.bills.length > 0);
    expect(withBills.map((d) => iso(d.date))).toEqual(['2026-03-05']);
    expect(withBills[0].bills[0].name).toBe('Rent');
  });

  it('leaves an inactive schedule off the grid', () => {
    const days = buildScheduledCalendarDays(
      [schedule({ isActive: false })],
      new Date(2026, 2, 15),
    );
    expect(days.every((d) => d.bills.length === 0)).toBe(true);
  });

  it('finds an occurrence generated outside the grid but moved into it', () => {
    // Generated on 5 April, moved back to 30 March: scanning only the grid's own
    // span would miss it entirely.
    const days = buildScheduledCalendarDays(
      [
        schedule({
          nextDueDate: '2026-04-05',
          frequency: 'ONCE',
          futureOverrides: [
            { originalDate: '2026-04-05', overrideDate: '2026-03-30' },
          ] as ScheduledTransaction['futureOverrides'],
        }),
      ],
      new Date(2026, 2, 15),
    );
    const withBills = days.filter((d) => d.bills.length > 0);
    expect(withBills.map((d) => iso(d.date))).toEqual(['2026-03-30']);
  });
});
