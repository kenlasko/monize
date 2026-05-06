import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDateRange } from './useDateRange';

describe('useDateRange', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2025, 0, 15)); // Jan 15, 2025
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns default date range', () => {
    const { result } = renderHook(() => useDateRange({ defaultRange: '3m' }));
    expect(result.current.dateRange).toBe('3m');
    expect(result.current.isValid).toBe(true);
  });

  it('resolves 1d range as a one-week window with day-level end (intraday-fallback friendly)', () => {
    // '1d' is an intraday-only preset; resolvedRange is consumed by the
    // chart only when intraday fails and we fall back to daily snapshots.
    // A single day's snapshot is one point, so the hook widens to a week.
    const { result } = renderHook(() => useDateRange({ defaultRange: '1d' }));
    expect(result.current.resolvedRange.start).toBe('2025-01-08');
    expect(result.current.resolvedRange.end).toBe('2025-01-15');
  });

  it('resolves 1d range with month alignment still uses day-level dates', () => {
    const { result } = renderHook(() =>
      useDateRange({ defaultRange: '1d', alignment: 'month' }),
    );
    expect(result.current.resolvedRange.start).toBe('2025-01-08');
    expect(result.current.resolvedRange.end).toBe('2025-01-15');
  });

  it('resolves 1w range', () => {
    const { result } = renderHook(() => useDateRange({ defaultRange: '1w' }));
    expect(result.current.resolvedRange.start).toBe('2025-01-08');
    expect(result.current.resolvedRange.end).toBe('2025-01-15');
  });

  it('resolves 1w range with month alignment uses day-level dates', () => {
    const { result } = renderHook(() =>
      useDateRange({ defaultRange: '1w', alignment: 'month' })
    );
    // Short ranges always use day-level precision (today as end)
    expect(result.current.resolvedRange.start).toBe('2025-01-08');
    expect(result.current.resolvedRange.end).toBe('2025-01-15');
  });

  it('resolves 1m range as 30 days ago', () => {
    const { result } = renderHook(() => useDateRange({ defaultRange: '1m' }));
    expect(result.current.resolvedRange.start).toBe('2024-12-16');
    expect(result.current.resolvedRange.end).toBe('2025-01-15');
  });

  it('resolves 1m range with month alignment uses day-level dates', () => {
    const { result } = renderHook(() =>
      useDateRange({ defaultRange: '1m', alignment: 'month' })
    );
    // 1m always uses day-level: 30 days ago, end = today
    expect(result.current.resolvedRange.start).toBe('2024-12-16');
    expect(result.current.resolvedRange.end).toBe('2025-01-15');
  });

  it('resolves 3m range as 90 days ago', () => {
    const { result } = renderHook(() => useDateRange({ defaultRange: '3m' }));
    expect(result.current.resolvedRange.start).toBe('2024-10-17');
    expect(result.current.resolvedRange.end).toBe('2025-01-15');
  });

  it('resolves 3m range with month alignment uses day-level dates', () => {
    const { result } = renderHook(() =>
      useDateRange({ defaultRange: '3m', alignment: 'month' })
    );
    // 3m always uses day-level: 90 days ago, end = today
    expect(result.current.resolvedRange.start).toBe('2024-10-17');
    expect(result.current.resolvedRange.end).toBe('2025-01-15');
  });

  it('resolves 1y range', () => {
    const { result } = renderHook(() => useDateRange({ defaultRange: '1y' }));
    expect(result.current.resolvedRange.start).toBe('2024-01-15');
    expect(result.current.resolvedRange.end).toBe('2025-01-15');
  });

  it('resolves 1y range with month alignment uses day-level dates', () => {
    const { result } = renderHook(() =>
      useDateRange({ defaultRange: '1y', alignment: 'month' })
    );
    // 1y uses day-level: exactly 1 year ago, end = today
    expect(result.current.resolvedRange.start).toBe('2024-01-15');
    expect(result.current.resolvedRange.end).toBe('2025-01-15');
  });

  it('resolves ytd range', () => {
    const { result } = renderHook(() => useDateRange({ defaultRange: 'ytd' }));
    expect(result.current.resolvedRange.start).toBe('2025-01-01');
    expect(result.current.resolvedRange.end).toBe('2025-01-15');
  });

  it('resolves ytd range with month alignment uses day-level dates', () => {
    const { result } = renderHook(() =>
      useDateRange({ defaultRange: 'ytd', alignment: 'month' })
    );
    expect(result.current.resolvedRange.start).toBe('2025-01-01');
    expect(result.current.resolvedRange.end).toBe('2025-01-15');
  });

  it('resolves 2y range as a rolling 730 days regardless of alignment', () => {
    const { result } = renderHook(() =>
      useDateRange({ defaultRange: '2y', alignment: 'month' })
    );
    // 2025-01-15 minus 730 days = 2023-01-16 (2024 is a leap year).
    expect(result.current.resolvedRange.start).toBe('2023-01-16');
    expect(result.current.resolvedRange.end).toBe('2025-01-15');
  });

  it('resolves all range with empty start', () => {
    const { result } = renderHook(() => useDateRange({ defaultRange: 'all' }));
    expect(result.current.resolvedRange.start).toBe('');
  });

  it('custom range uses user-set dates', () => {
    const { result } = renderHook(() => useDateRange({ defaultRange: 'custom' }));
    expect(result.current.isValid).toBe(false); // no dates set

    act(() => {
      result.current.setStartDate('2025-01-01');
      result.current.setEndDate('2025-01-31');
    });
    expect(result.current.isValid).toBe(true);
    expect(result.current.resolvedRange.start).toBe('2025-01-01');
    expect(result.current.resolvedRange.end).toBe('2025-01-31');
  });

  it('setDateRange changes the active range', () => {
    const { result } = renderHook(() => useDateRange({ defaultRange: '3m' }));
    act(() => {
      result.current.setDateRange('6m');
    });
    expect(result.current.dateRange).toBe('6m');
  });
});
