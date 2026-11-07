import { describe, it, expect } from 'vitest';
import { greetingPeriod } from './greeting';

describe('greetingPeriod', () => {
  it.each([
    ['2026-11-06T00:00:00Z', 'morning'],
    ['2026-11-06T11:59:00Z', 'morning'],
    ['2026-11-06T12:00:00Z', 'afternoon'],
    ['2026-11-06T17:59:00Z', 'afternoon'],
    ['2026-11-06T18:00:00Z', 'evening'],
    ['2026-11-06T23:59:00Z', 'evening'],
  ])('reads %s in UTC as the %s', (iso, period) => {
    expect(greetingPeriod(new Date(iso), 'UTC')).toBe(period);
  });

  it('reads the hour in the timezone preference, not the device clock', () => {
    // 16:00 UTC is 11:00 in Toronto (EST) on this date.
    const now = new Date('2026-11-06T16:00:00Z');
    expect(greetingPeriod(now, 'UTC')).toBe('afternoon');
    expect(greetingPeriod(now, 'America/Toronto')).toBe('morning');
  });
});
