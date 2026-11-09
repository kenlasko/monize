import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useHighlightParam, useScrollIntoViewWhen } from './useHighlightTarget';

let mockSearchParams = new URLSearchParams();
vi.mock('next/navigation', () => ({
  useSearchParams: () => mockSearchParams,
}));

describe('useHighlightParam', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockSearchParams = new URLSearchParams();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns null when no highlight param is present', () => {
    const { result } = renderHook(() => useHighlightParam());
    expect(result.current).toBeNull();
  });

  it('reads the id from ?highlight and clears it after the delay', () => {
    mockSearchParams = new URLSearchParams('highlight=abc-123');
    const { result } = renderHook(() => useHighlightParam());
    expect(result.current).toBe('abc-123');

    act(() => {
      vi.advanceTimersByTime(6000);
    });
    expect(result.current).toBeNull();
  });

  it('flashes a different row when a link arrives while the page is open', () => {
    mockSearchParams = new URLSearchParams('highlight=first');
    const { result, rerender } = renderHook(() => useHighlightParam());
    act(() => {
      vi.advanceTimersByTime(6000);
    });
    expect(result.current).toBeNull();

    mockSearchParams = new URLSearchParams('highlight=second');
    rerender();
    expect(result.current).toBe('second');
  });

  it('does not flash again when only the rest of the query string changes', () => {
    mockSearchParams = new URLSearchParams('highlight=first');
    const { result, rerender } = renderHook(() => useHighlightParam());
    act(() => {
      vi.advanceTimersByTime(6000);
    });

    mockSearchParams = new URLSearchParams('highlight=first&page=2');
    rerender();
    expect(result.current).toBeNull();
  });

  it('supports a custom param name', () => {
    mockSearchParams = new URLSearchParams('focus=xyz');
    const { result } = renderHook(() => useHighlightParam('focus'));
    expect(result.current).toBe('xyz');
  });
});

describe('useScrollIntoViewWhen', () => {
  it('scrolls the element into view only when active', () => {
    const scroll = vi.fn();
    const { result, rerender } = renderHook(
      ({ active }: { active: boolean }) => useScrollIntoViewWhen<HTMLDivElement>(active),
      { initialProps: { active: false } },
    );
    // Attach a fake element to the returned ref.
    result.current.current = { scrollIntoView: scroll } as unknown as HTMLDivElement;

    expect(scroll).not.toHaveBeenCalled();
    rerender({ active: true });
    expect(scroll).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
  });
});
