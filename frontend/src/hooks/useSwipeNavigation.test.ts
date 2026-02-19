import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Track the latest router mock so tests can inspect it
const mockPush = vi.fn();
let mockPathname = '/dashboard';

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
    refresh: vi.fn(),
  }),
  usePathname: () => mockPathname,
  useSearchParams: () => new URLSearchParams(),
}));

import { useSwipeNavigation } from './useSwipeNavigation';

// Helper to create touch events
function createTouchEvent(
  type: 'touchstart' | 'touchmove' | 'touchend',
  clientX: number,
  clientY: number,
): TouchEvent {
  const touchData = { clientX, clientY, identifier: 0 } as Touch;
  const init: TouchEventInit = {
    bubbles: true,
    cancelable: type === 'touchmove',
  };
  if (type === 'touchend') {
    init.changedTouches = [touchData];
    init.touches = [];
  } else {
    init.touches = [touchData];
    init.changedTouches = [touchData];
  }
  return new TouchEvent(type, init);
}

describe('useSwipeNavigation', () => {
  let contentDiv: HTMLDivElement;
  let originalInnerWidth: number;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPathname = '/dashboard';
    contentDiv = document.createElement('div');
    document.body.appendChild(contentDiv);

    // Store original and set a known innerWidth
    originalInnerWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { value: 400, writable: true, configurable: true });

    // Reset body overflow (Modal detection)
    document.body.style.overflow = '';

    // Clear sessionStorage
    sessionStorage.clear();
  });

  afterEach(() => {
    document.body.removeChild(contentDiv);
    Object.defineProperty(window, 'innerWidth', { value: originalInnerWidth, writable: true, configurable: true });
  });

  // Helper to render hook with contentRef attached to our div
  function renderSwipeHook() {
    const hookResult = renderHook(() => useSwipeNavigation());
    // Attach contentRef to our DOM div
    Object.defineProperty(hookResult.result.current.contentRef, 'current', {
      value: contentDiv,
      writable: true,
    });
    // Re-render so the effect picks up the ref
    hookResult.rerender();
    return hookResult;
  }

  // Helper for enter animation tests: renders with a dummy pathname first so the
  // ref is connected before the useLayoutEffect runs with the target pathname.
  // This ensures the useLayoutEffect (which depends on [pathname]) re-runs when
  // the pathname changes to the target, at which point contentRef.current is set.
  function renderSwipeHookWithEnterAnimation(targetPathname: string) {
    // Start with a different pathname so we can trigger a pathname change later
    const dummyPathname = targetPathname === '/dashboard' ? '/transactions' : '/dashboard';
    mockPathname = dummyPathname;

    const hookResult = renderHook(() => useSwipeNavigation());
    // Attach contentRef to our DOM div
    Object.defineProperty(hookResult.result.current.contentRef, 'current', {
      value: contentDiv,
      writable: true,
    });

    // Now switch to the target pathname and re-render. This triggers the
    // useLayoutEffect because pathname changed, and contentRef.current is already set.
    mockPathname = targetPathname;
    hookResult.rerender();
    return hookResult;
  }

  describe('basic return values', () => {
    it('returns currentIndex for dashboard (index 0)', () => {
      mockPathname = '/dashboard';
      const { result } = renderHook(() => useSwipeNavigation());
      expect(result.current.currentIndex).toBe(0);
      expect(result.current.isSwipePage).toBe(true);
    });

    it('returns currentIndex for transactions (index 1)', () => {
      mockPathname = '/transactions';
      const { result } = renderHook(() => useSwipeNavigation());
      expect(result.current.currentIndex).toBe(1);
      expect(result.current.isSwipePage).toBe(true);
    });

    it('returns totalPages as 7', () => {
      const { result } = renderHook(() => useSwipeNavigation());
      expect(result.current.totalPages).toBe(7);
    });

    it('returns -1 and isSwipePage false for non-swipe pages', () => {
      mockPathname = '/settings';
      const { result } = renderHook(() => useSwipeNavigation());
      expect(result.current.currentIndex).toBe(-1);
      expect(result.current.isSwipePage).toBe(false);
    });

    it('returns a contentRef', () => {
      const { result } = renderHook(() => useSwipeNavigation());
      expect(result.current.contentRef).toBeDefined();
    });
  });

  describe('touch event handling', () => {
    it('handles touchstart by recording the initial position', () => {
      // Ensures the hook attaches touchstart listener without throwing
      renderSwipeHook();
      const ev = createTouchEvent('touchstart', 200, 300);
      act(() => {
        contentDiv.dispatchEvent(ev);
      });
      // No error thrown means the handler ran successfully
    });

    it('handles touchmove with small deltas (below decision threshold) without swiping', () => {
      renderSwipeHook();
      act(() => {
        contentDiv.dispatchEvent(createTouchEvent('touchstart', 200, 300));
        // Move less than 10px (DECISION_THRESHOLD) in both axes
        contentDiv.dispatchEvent(createTouchEvent('touchmove', 205, 303));
      });
      // No transform applied yet since decision threshold not met
      expect(contentDiv.style.transform).toBe('');
    });

    it('enters swiping phase on horizontal move beyond threshold', () => {
      mockPathname = '/transactions'; // index 1, can go both left and right
      renderSwipeHook();

      act(() => {
        contentDiv.dispatchEvent(createTouchEvent('touchstart', 200, 300));
        // Move >10px horizontally (swiping left to go next)
        contentDiv.dispatchEvent(createTouchEvent('touchmove', 170, 302));
      });

      // In swiping phase, transform should be applied
      expect(contentDiv.style.transform).toContain('translateX');
      expect(contentDiv.style.willChange).toBe('transform, opacity');
    });

    it('does not enter swiping phase on vertical scroll', () => {
      mockPathname = '/transactions';
      renderSwipeHook();

      act(() => {
        contentDiv.dispatchEvent(createTouchEvent('touchstart', 200, 300));
        // Move >10px vertically but <10px horizontally
        contentDiv.dispatchEvent(createTouchEvent('touchmove', 203, 320));
      });

      expect(contentDiv.style.transform).toBe('');
    });
  });

  describe('horizontal scroll detection (prevents swipe)', () => {
    it('prevents swiping when target element has horizontal scroll', () => {
      mockPathname = '/transactions';
      renderSwipeHook();

      // Create a child with horizontal scroll
      const scrollableChild = document.createElement('div');
      Object.defineProperty(scrollableChild, 'scrollWidth', { value: 500, configurable: true });
      Object.defineProperty(scrollableChild, 'clientWidth', { value: 300, configurable: true });
      // Mock getComputedStyle for this element
      const origGetComputedStyle = window.getComputedStyle;
      vi.spyOn(window, 'getComputedStyle').mockImplementation((el) => {
        if (el === scrollableChild) {
          return { overflowX: 'auto' } as CSSStyleDeclaration;
        }
        return origGetComputedStyle(el);
      });

      contentDiv.appendChild(scrollableChild);

      // Dispatch touch events targeting the scrollable child
      const touchStart = new TouchEvent('touchstart', {
        bubbles: true,
        touches: [{ clientX: 200, clientY: 300, identifier: 0, target: scrollableChild } as unknown as Touch],
        changedTouches: [{ clientX: 200, clientY: 300, identifier: 0, target: scrollableChild } as unknown as Touch],
      });
      Object.defineProperty(touchStart, 'target', { value: scrollableChild });

      act(() => {
        contentDiv.dispatchEvent(touchStart);
        // Move horizontally beyond threshold
        contentDiv.dispatchEvent(createTouchEvent('touchmove', 170, 302));
      });

      // Swipe should not have started — no willChange
      expect(contentDiv.style.willChange).toBe('');
      contentDiv.removeChild(scrollableChild);
    });
  });

  describe('modal open detection (prevents swipe)', () => {
    it('prevents swiping when a modal is open (body overflow hidden)', () => {
      mockPathname = '/transactions';
      renderSwipeHook();

      // Simulate modal open
      document.body.style.overflow = 'hidden';

      act(() => {
        contentDiv.dispatchEvent(createTouchEvent('touchstart', 200, 300));
        contentDiv.dispatchEvent(createTouchEvent('touchmove', 170, 302));
      });

      // Swipe should be prevented
      expect(contentDiv.style.willChange).toBe('');

      // Cleanup
      document.body.style.overflow = '';
    });
  });

  describe('swipe left/right navigation', () => {
    it('navigates to next page on swipe left that exceeds commit threshold', () => {
      mockPathname = '/dashboard'; // index 0
      vi.useFakeTimers();
      renderSwipeHook();

      act(() => {
        contentDiv.dispatchEvent(createTouchEvent('touchstart', 300, 200));
        // Move left beyond 25% of screen width (400 * 0.25 = 100px)
        contentDiv.dispatchEvent(createTouchEvent('touchmove', 150, 202));
        contentDiv.dispatchEvent(createTouchEvent('touchend', 150, 202));
      });

      // Advance timer past animation timeout
      act(() => {
        vi.advanceTimersByTime(300);
      });

      expect(mockPush).toHaveBeenCalledWith('/transactions');
      vi.useRealTimers();
    });

    it('navigates to previous page on swipe right that exceeds commit threshold', () => {
      mockPathname = '/transactions'; // index 1
      vi.useFakeTimers();
      renderSwipeHook();

      act(() => {
        contentDiv.dispatchEvent(createTouchEvent('touchstart', 100, 200));
        // Move right beyond 25% of screen width
        contentDiv.dispatchEvent(createTouchEvent('touchmove', 250, 202));
        contentDiv.dispatchEvent(createTouchEvent('touchend', 250, 202));
      });

      act(() => {
        vi.advanceTimersByTime(300);
      });

      expect(mockPush).toHaveBeenCalledWith('/dashboard');
      vi.useRealTimers();
    });

    it('does not navigate left from the first page', () => {
      mockPathname = '/dashboard'; // index 0, cannot go left
      vi.useFakeTimers();
      renderSwipeHook();

      act(() => {
        contentDiv.dispatchEvent(createTouchEvent('touchstart', 100, 200));
        // Swipe right (trying to go to index -1)
        contentDiv.dispatchEvent(createTouchEvent('touchmove', 250, 202));
        contentDiv.dispatchEvent(createTouchEvent('touchend', 250, 202));
      });

      act(() => {
        vi.advanceTimersByTime(300);
      });

      expect(mockPush).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it('does not navigate right from the last page', () => {
      mockPathname = '/reports'; // index 6, last page
      vi.useFakeTimers();
      renderSwipeHook();

      act(() => {
        contentDiv.dispatchEvent(createTouchEvent('touchstart', 300, 200));
        // Swipe left (trying to go to index 6)
        contentDiv.dispatchEvent(createTouchEvent('touchmove', 150, 202));
        contentDiv.dispatchEvent(createTouchEvent('touchend', 150, 202));
      });

      act(() => {
        vi.advanceTimersByTime(300);
      });

      expect(mockPush).not.toHaveBeenCalled();
      vi.useRealTimers();
    });
  });

  describe('velocity threshold (fast swipe commits)', () => {
    it('commits navigation for a fast short swipe', () => {
      mockPathname = '/transactions'; // index 1
      vi.useFakeTimers();
      renderSwipeHook();

      // Simulate a very fast swipe: small distance but high velocity
      // The hook checks velocity = absX / elapsed
      // We need absX/elapsed > 0.4 px/ms
      // With fakeTimers, Date.now() is controlled

      act(() => {
        contentDiv.dispatchEvent(createTouchEvent('touchstart', 200, 200));
        // Move horizontally beyond decision threshold to enter swiping
        contentDiv.dispatchEvent(createTouchEvent('touchmove', 170, 202));
      });

      // Advance only 50ms — so deltaX=50, velocity = 50/50 = 1.0 > 0.4
      act(() => {
        vi.advanceTimersByTime(50);
      });

      act(() => {
        contentDiv.dispatchEvent(createTouchEvent('touchend', 150, 202));
      });

      act(() => {
        vi.advanceTimersByTime(300);
      });

      expect(mockPush).toHaveBeenCalledWith('/accounts');
      vi.useRealTimers();
    });
  });

  describe('below-threshold swipe snaps back', () => {
    it('snaps back when swipe does not exceed commit threshold or velocity', () => {
      mockPathname = '/transactions'; // index 1
      vi.useFakeTimers();
      renderSwipeHook();

      act(() => {
        contentDiv.dispatchEvent(createTouchEvent('touchstart', 200, 200));
        // Move enough to enter swiping but not enough to commit
        // 25% of 400 = 100px. Move only 20px horizontally (well below threshold)
        contentDiv.dispatchEvent(createTouchEvent('touchmove', 185, 202));
      });

      // Advance time significantly to make velocity very low
      act(() => {
        vi.advanceTimersByTime(2000);
      });

      act(() => {
        contentDiv.dispatchEvent(createTouchEvent('touchend', 185, 202));
      });

      // Should snap back
      expect(contentDiv.style.transform).toBe('translateX(0)');
      expect(contentDiv.style.opacity).toBe('1');

      // Advance past animation
      act(() => {
        vi.advanceTimersByTime(300);
      });

      expect(mockPush).not.toHaveBeenCalled();
      vi.useRealTimers();
    });
  });

  describe('enter animation from left/right', () => {
    it('animates from right when sessionStorage has from-right', () => {
      sessionStorage.setItem('swipe-enter', 'from-right');
      mockPathname = '/transactions';

      renderSwipeHookWithEnterAnimation('/transactions');

      // The useLayoutEffect should have read and removed the session storage item
      expect(sessionStorage.getItem('swipe-enter')).toBeNull();
      // Content should end up animating to translateX(0)
      expect(contentDiv.style.transform).toBe('translateX(0)');
    });

    it('animates from left when sessionStorage has from-left', () => {
      sessionStorage.setItem('swipe-enter', 'from-left');
      mockPathname = '/accounts';

      renderSwipeHookWithEnterAnimation('/accounts');

      expect(sessionStorage.getItem('swipe-enter')).toBeNull();
      expect(contentDiv.style.transform).toBe('translateX(0)');
    });

    it('does nothing when sessionStorage has no swipe-enter', () => {
      mockPathname = '/dashboard';

      renderSwipeHook();

      // No animation styles applied
      expect(contentDiv.style.opacity).toBe('');
    });
  });

  describe('session storage for enter direction', () => {
    it('sets from-right in sessionStorage when swiping left (next page)', () => {
      mockPathname = '/dashboard';
      vi.useFakeTimers();
      renderSwipeHook();

      act(() => {
        contentDiv.dispatchEvent(createTouchEvent('touchstart', 300, 200));
        contentDiv.dispatchEvent(createTouchEvent('touchmove', 150, 202));
        contentDiv.dispatchEvent(createTouchEvent('touchend', 150, 202));
      });

      expect(sessionStorage.getItem('swipe-enter')).toBe('from-right');
      vi.useRealTimers();
    });

    it('sets from-left in sessionStorage when swiping right (previous page)', () => {
      mockPathname = '/transactions';
      vi.useFakeTimers();
      renderSwipeHook();

      act(() => {
        contentDiv.dispatchEvent(createTouchEvent('touchstart', 100, 200));
        contentDiv.dispatchEvent(createTouchEvent('touchmove', 250, 202));
        contentDiv.dispatchEvent(createTouchEvent('touchend', 250, 202));
      });

      expect(sessionStorage.getItem('swipe-enter')).toBe('from-left');
      vi.useRealTimers();
    });
  });

  describe('touchend edge cases', () => {
    it('resets state on touchend if not in swiping phase', () => {
      mockPathname = '/dashboard';
      renderSwipeHook();

      // Dispatch touchend without starting a swipe
      act(() => {
        contentDiv.dispatchEvent(createTouchEvent('touchend', 200, 300));
      });

      expect(mockPush).not.toHaveBeenCalled();
    });

    it('does not respond to touch events on non-swipe pages', () => {
      mockPathname = '/settings';
      const { result } = renderHook(() => useSwipeNavigation());

      // Even if we tried to dispatch events, the hook would not attach listeners
      expect(result.current.isSwipePage).toBe(false);
      expect(mockPush).not.toHaveBeenCalled();
    });
  });
});
