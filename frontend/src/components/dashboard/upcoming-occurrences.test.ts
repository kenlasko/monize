import { describe, it, expect } from 'vitest';
import type { ScheduledTransaction } from '@/types/scheduled-transaction';
import { buildUpcomingStrip, upcomingOccurrences, UPCOMING_STRIP_DAYS } from './upcoming-occurrences';

const today = new Date(2026, 10, 20);

const schedule = (over: Partial<ScheduledTransaction>): ScheduledTransaction =>
  ({
    id: 'x',
    name: 'Bill',
    isActive: true,
    autoPost: true,
    amount: -10,
    currencyCode: 'USD',
    nextDueDate: '2026-11-21',
    reminderDaysBefore: 3,
    nextOverride: null,
    isTransfer: false,
    ...over,
  }) as ScheduledTransaction;

describe('upcomingOccurrences', () => {
  it('orders by due date, manual first on a shared day, and drops inactive schedules', () => {
    const list = upcomingOccurrences(
      [
        schedule({ id: 'late', nextDueDate: '2026-12-20' }),
        schedule({ id: 'auto', nextDueDate: '2026-11-21' }),
        schedule({ id: 'manual', nextDueDate: '2026-11-21', autoPost: false }),
        schedule({ id: 'off', isActive: false }),
      ],
      today,
      true,
    );
    expect(list.map((s) => s.id)).toEqual(['manual', 'auto', 'late']);
  });

  it('keeps only what is overdue or inside its reminder window when not showing all', () => {
    const list = upcomingOccurrences(
      [schedule({ id: 'soon' }), schedule({ id: 'late', nextDueDate: '2026-12-20' })],
      today,
      false,
    );
    expect(list.map((s) => s.id)).toEqual(['soon']);
  });
});

describe('buildUpcomingStrip', () => {
  it('places each occurrence on its due day across two weeks from today', () => {
    const strip = buildUpcomingStrip(
      [
        schedule({ id: 'a', nextDueDate: '2026-11-21', amount: -120 }),
        schedule({ id: 'b', nextDueDate: '2026-11-22', amount: 2250 }),
        schedule({ id: 'gone', nextDueDate: '2026-11-19' }),
        schedule({ id: 'far', nextDueDate: '2026-12-25' }),
      ],
      today,
    );
    expect(strip.days).toHaveLength(UPCOMING_STRIP_DAYS);
    expect(strip.days[0]).toMatchObject({ date: '2026-11-20', isToday: true, items: [] });
    expect(strip.days[1].items).toEqual([{ id: 'a', name: 'Bill', kind: 'bill', magnitude: 120 }]);
    expect(strip.days[2].items[0]).toMatchObject({ id: 'b', kind: 'deposit', magnitude: 2250 });
    expect(strip.days.flatMap((d) => d.items).map((i) => i.id)).toEqual(['a', 'b']);
    expect(strip.scaleMax).toBe(2250);
  });

  it('draws no scale across two currencies, which are not comparable without a rate', () => {
    const strip = buildUpcomingStrip(
      [
        schedule({ id: 'a', amount: -120 }),
        schedule({ id: 'b', amount: -90, currencyCode: 'EUR' }),
      ],
      today,
    );
    expect(strip.scaleMax).toBeNull();
  });
});
