import { describe, it, expect } from 'vitest';
import { resolveRangePreset } from './date-range';

// Fixed reference date so presets resolve deterministically.
const NOW = new Date('2026-07-07T12:00:00Z');

describe('resolveRangePreset', () => {
  it('always ends at today', () => {
    expect(resolveRangePreset('3m', { now: NOW }).end).toBe('2026-07-07');
    expect(resolveRangePreset('all', { now: NOW }).end).toBe('2026-07-07');
  });

  it('resolves ytd to Jan 1 of the current year', () => {
    expect(resolveRangePreset('ytd', { now: NOW }).start).toBe('2026-01-01');
  });

  it('resolves all to an empty start (no lower bound)', () => {
    expect(resolveRangePreset('all', { now: NOW }).start).toBe('');
  });

  it('resolves 3m to 90 days before now', () => {
    expect(resolveRangePreset('3m', { now: NOW }).start).toBe('2026-04-08');
  });

  it('resolves 1y to one year before now', () => {
    expect(resolveRangePreset('1y', { now: NOW }).start).toBe('2025-07-07');
  });

  it('snaps 6m start to the month start under month alignment', () => {
    expect(resolveRangePreset('6m', { now: NOW, alignment: 'month' }).start).toBe('2026-02-01');
    // Day alignment keeps the exact calendar offset.
    expect(resolveRangePreset('6m', { now: NOW, alignment: 'day' }).start).toBe('2026-01-07');
  });

  it('resolves 10y to ten years, the 120th month back under month alignment', () => {
    expect(resolveRangePreset('10y', { now: NOW }).start).toBe('2016-07-07');
    // Ten years of months including the current one.
    expect(resolveRangePreset('10y', { now: NOW, alignment: 'month' }).start).toBe('2016-08-01');
  });

  it('passes through custom start/end', () => {
    const r = resolveRangePreset('custom', {
      now: NOW,
      startDate: '2024-01-01',
      endDate: '2024-06-30',
    });
    expect(r).toEqual({ start: '2024-01-01', end: '2024-06-30' });
  });

  it('falls back to a 3-month window for unknown presets', () => {
    expect(resolveRangePreset('bogus', { now: NOW }).start).toBe('2026-04-07');
  });

  it("anchors every preset on the user's day, not on `now`'s", () => {
    // 20:00Z on Dec 31 is already Jan 1 for a user at UTC+14.
    const browserNow = new Date('2026-12-31T20:00:00Z');
    expect(resolveRangePreset('ytd', { now: browserNow, today: '2027-01-01' })).toEqual({
      start: '2027-01-01',
      end: '2027-01-01',
    });
    expect(resolveRangePreset('mtd', { now: browserNow, today: '2027-01-01' }).start).toBe('2027-01-01');
    expect(resolveRangePreset('1m', { now: browserNow, today: '2027-01-01' }).start).toBe('2026-12-02');
  });
});
