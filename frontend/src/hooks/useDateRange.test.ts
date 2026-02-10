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

  it('resolves 1m range', () => {
    const { result } = renderHook(() => useDateRange({ defaultRange: '1m' }));
    expect(result.current.resolvedRange.start).toBe('2024-12-15');
    expect(result.current.resolvedRange.end).toBe('2025-01-15');
  });

  it('resolves 1y range', () => {
    const { result } = renderHook(() => useDateRange({ defaultRange: '1y' }));
    expect(result.current.resolvedRange.start).toBe('2024-01-15');
  });

  it('resolves ytd range', () => {
    const { result } = renderHook(() => useDateRange({ defaultRange: 'ytd' }));
    expect(result.current.resolvedRange.start).toBe('2025-01-01');
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

  it('month alignment snaps to start/end of month', () => {
    const { result } = renderHook(() =>
      useDateRange({ defaultRange: '1m', alignment: 'month' })
    );
    expect(result.current.resolvedRange.start).toBe('2025-01-01');
    expect(result.current.resolvedRange.end).toBe('2025-01-31');
  });
});
