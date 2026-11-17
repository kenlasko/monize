import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

let mockPathname = '/dashboard';

vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
}));

import { useScrollToTopOnNavigation } from './useScrollToTopOnNavigation';
import { clearRetainedScroll, rememberScroll } from '@/lib/scroll-retention';

const scrollToMock = () => window.scrollTo as unknown as ReturnType<typeof vi.fn>;

describe('useScrollToTopOnNavigation', () => {
  let nowValue: number;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPathname = '/dashboard';
    nowValue = 10_000;
    vi.spyOn(Date, 'now').mockImplementation(() => nowValue);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not scroll on initial mount', () => {
    renderHook(() => useScrollToTopOnNavigation());
    expect(scrollToMock()).not.toHaveBeenCalled();
  });

  it('leaves a page that keeps the reader\'s place to restore it', () => {
    rememberScroll('/accounts', 640, '');
    const { rerender } = renderHook(() => useScrollToTopOnNavigation());
    act(() => {
      mockPathname = '/accounts';
      rerender();
    });
    expect(scrollToMock()).not.toHaveBeenCalled();
    clearRetainedScroll();
  });

  it('scrolls to the top on a forward navigation (pathname change)', () => {
    const { rerender } = renderHook(() => useScrollToTopOnNavigation());
    act(() => {
      mockPathname = '/transactions';
      rerender();
    });
    expect(scrollToMock()).toHaveBeenCalledWith(0, 0);
  });

  it('does not scroll when the pathname is unchanged', () => {
    const { rerender } = renderHook(() => useScrollToTopOnNavigation());
    act(() => {
      rerender();
    });
    expect(scrollToMock()).not.toHaveBeenCalled();
  });

  it('does not scroll on a Back/Forward navigation (recent popstate)', () => {
    const { rerender } = renderHook(() => useScrollToTopOnNavigation());
    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'));
      mockPathname = '/transactions';
      rerender();
    });
    expect(scrollToMock()).not.toHaveBeenCalled();
  });

  it('still scrolls on a forward navigation after a stale popstate', () => {
    const { rerender } = renderHook(() => useScrollToTopOnNavigation());
    // A popstate that did not change the route (e.g. closing a modal that
    // pushed a history entry) must not get "stuck" and suppress a later tab.
    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    // A genuine forward navigation well outside the Back/Forward window.
    nowValue += 5_000;
    act(() => {
      mockPathname = '/reports';
      rerender();
    });
    expect(scrollToMock()).toHaveBeenCalledWith(0, 0);
  });
});
