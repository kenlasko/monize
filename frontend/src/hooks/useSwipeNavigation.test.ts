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
import { useAuthStore } from '@/store/authStore';
import { NAV_LINKS, AI_LINKS, TOOLS_LINKS, ADMIN_LINKS } from '@/lib/nav-links';
import { SWIPE_PAGINATE_ATTR } from './swipe-gesture';
import type { User } from '@/types/auth';

// Swipe is scoped to the current page's drawer group, so the chain a main page
// offers is the main chain alone: Dashboard plus the main pages. The AI, Tools
// and Admin groups are their own chains. Derived from the nav arrays so a new
// route updates the expectation in one place.
const MAIN_CHAIN_COUNT = 1 + NAV_LINKS.length;

function makeUser(role: 'admin' | 'user'): User {
  return { id: 'u1', email: 'u@example.com', role } as User;
}

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

    // Default identity: a signed-in non-admin, non-delegate user, so the swipe
    // chain is the base set unless a test opts into admin/delegate.
    useAuthStore.getState().setDelegation(null, [], null, null);
    useAuthStore.getState().setUser(makeUser('user'));
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

    it('returns the main chain (dashboard + main pages)', () => {
      const { result } = renderHook(() => useSwipeNavigation());
      expect(result.current.totalPages).toBe(MAIN_CHAIN_COUNT);
    });

    it('scopes an AI page to the AI chain only', () => {
      mockPathname = '/ai';
      const { result } = renderHook(() => useSwipeNavigation());
      expect(result.current.isSwipePage).toBe(true);
      // The AI chain is exactly the AI pages -- not the main or tools ones.
      expect(result.current.totalPages).toBe(AI_LINKS.length);
    });

    it('scopes a Tools page to the Tools chain only', () => {
      mockPathname = '/securities';
      const { result } = renderHook(() => useSwipeNavigation());
      expect(result.current.isSwipePage).toBe(true);
      expect(result.current.totalPages).toBe(TOOLS_LINKS.length);
    });

    it('does not cross from the last main page into the AI chain', () => {
      // The last main page's swipe chain stays the main chain, so its right
      // edge has nowhere to go -- it never reaches the AI group.
      mockPathname = NAV_LINKS[NAV_LINKS.length - 1].href;
      const { result } = renderHook(() => useSwipeNavigation());
      expect(result.current.totalPages).toBe(MAIN_CHAIN_COUNT);
      expect(result.current.currentIndex).toBe(MAIN_CHAIN_COUNT - 1);
    });

    it('includes the admin chain only for a non-delegate admin', () => {
      mockPathname = '/admin/users';
      const nonAdmin = renderHook(() => useSwipeNavigation());
      expect(nonAdmin.result.current.isSwipePage).toBe(false);
      // Unmount before switching identity so the Zustand write has no mounted
      // subscriber to re-render outside act().
      nonAdmin.unmount();

      useAuthStore.getState().setUser(makeUser('admin'));
      const admin = renderHook(() => useSwipeNavigation());
      expect(admin.result.current.isSwipePage).toBe(true);
      // The admin chain is exactly the admin pages, scoped to that group.
      expect(admin.result.current.totalPages).toBe(ADMIN_LINKS.length);
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
      // Last page of the base chain (last Tools entry) for a non-admin user.
      mockPathname = TOOLS_LINKS[TOOLS_LINKS.length - 1].href;
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

      expect(mockPush).toHaveBeenCalledWith('/bills');
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
      expect(contentDiv.style.transform).toBe('translateX(0px)');
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
      expect(contentDiv.style.transform).toBe('translateX(0px)');
    });

    it('animates from left when sessionStorage has from-left', () => {
      sessionStorage.setItem('swipe-enter', 'from-left');
      mockPathname = '/accounts';

      renderSwipeHookWithEnterAnimation('/accounts');

      expect(sessionStorage.getItem('swipe-enter')).toBeNull();
      expect(contentDiv.style.transform).toBe('translateX(0px)');
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

  describe('pagination zone cedes the view swipe', () => {
    it('does not navigate when the swipe starts inside a pagination zone', () => {
      mockPathname = '/transactions'; // a swipe page that can go both ways
      vi.useFakeTimers();
      renderSwipeHook();

      // A register that pages itself, marked so the view swipe yields to it.
      const zone = document.createElement('div');
      zone.setAttribute(SWIPE_PAGINATE_ATTR, 'true');
      contentDiv.appendChild(zone);

      const start = new TouchEvent('touchstart', {
        bubbles: true,
        touches: [{ clientX: 300, clientY: 200, identifier: 0 } as Touch],
        changedTouches: [{ clientX: 300, clientY: 200, identifier: 0 } as Touch],
      });
      Object.defineProperty(start, 'target', { value: zone });

      act(() => {
        contentDiv.dispatchEvent(start);
        // A decisive horizontal move that would otherwise commit a view change.
        contentDiv.dispatchEvent(createTouchEvent('touchmove', 150, 202));
        contentDiv.dispatchEvent(createTouchEvent('touchend', 150, 202));
      });
      act(() => {
        vi.advanceTimersByTime(300);
      });

      // The view swipe ceded, so no view navigation happened.
      expect(mockPush).not.toHaveBeenCalled();
      expect(contentDiv.style.willChange).toBe('');
      contentDiv.removeChild(zone);
      vi.useRealTimers();
    });
  });

  describe('delegate (acting-as) view', () => {
    afterEach(() => {
      // The hook is still mounted (RTL cleanup runs after this); resetting
      // the store triggers a re-render, so wrap it in act().
      act(() => {
        useAuthStore.getState().setDelegation(null, [], null, null);
      });
    });

    it('disables swipe when a delegate has no granted sections', () => {
      mockPathname = '/dashboard';
      act(() => {
        useAuthStore.getState().setDelegation('owner-1', [], null, null);
      });

      const { result } = renderHook(() => useSwipeNavigation());

      // Only the Dashboard is reachable -> nothing to swipe to.
      expect(result.current.isSwipePage).toBe(false);
      expect(result.current.totalPages).toBe(1);
    });

    it('swipes only across the delegate-granted sections', () => {
      mockPathname = '/dashboard';
      act(() => {
        useAuthStore.getState().setDelegation('owner-1', [], null, {
          bills: true,
          investments: false,
          budgets: true,
          reports: false,
          ai: false,
          warranties: false,
        });
      });

      const { result } = renderHook(() => useSwipeNavigation());

      // Dashboard + Bills + Budgets only.
      expect(result.current.totalPages).toBe(3);
      expect(result.current.isSwipePage).toBe(true);
      expect(result.current.currentIndex).toBe(0);
    });

    it('includes Accounts when the delegate can read any account', () => {
      mockPathname = '/accounts';
      act(() => {
        useAuthStore.getState().setDelegation('owner-1', [], null, {
          bills: true,
          investments: false,
          budgets: false,
          reports: false,
          ai: false,
          warranties: false,
          accounts: true,
        });
      });

      const { result } = renderHook(() => useSwipeNavigation());

      // Dashboard + Accounts + Bills.
      expect(result.current.totalPages).toBe(3);
      expect(result.current.isSwipePage).toBe(true);
      expect(result.current.currentIndex).toBeGreaterThanOrEqual(0);
    });

    it('excludes Accounts when the delegate has no account access', () => {
      mockPathname = '/accounts';
      act(() => {
        useAuthStore.getState().setDelegation('owner-1', [], null, {
          bills: true,
          investments: false,
          budgets: false,
          reports: false,
          ai: false,
          warranties: false,
        });
      });

      const { result } = renderHook(() => useSwipeNavigation());

      expect(result.current.isSwipePage).toBe(false);
      expect(result.current.currentIndex).toBe(-1);
    });

    it('includes Transactions when the delegate has transactional access', () => {
      mockPathname = '/transactions';
      act(() => {
        useAuthStore.getState().setDelegation('owner-1', [], null, {
          bills: true,
          investments: false,
          budgets: false,
          reports: false,
          ai: false,
          warranties: false,
          transactions: true,
        });
      });

      const { result } = renderHook(() => useSwipeNavigation());

      // Dashboard + Transactions + Bills.
      expect(result.current.totalPages).toBe(3);
      expect(result.current.isSwipePage).toBe(true);
      expect(result.current.currentIndex).toBeGreaterThanOrEqual(0);
    });

    it('does not treat a non-granted section as a swipe page', () => {
      mockPathname = '/investments';
      act(() => {
        useAuthStore.getState().setDelegation('owner-1', [], null, {
          bills: true,
          investments: false,
          budgets: false,
          reports: false,
          ai: false,
          warranties: false,
        });
      });

      const { result } = renderHook(() => useSwipeNavigation());

      expect(result.current.currentIndex).toBe(-1);
      expect(result.current.isSwipePage).toBe(false);
    });

    it('keeps swipe navigation enabled for a normal (non-delegate) user', () => {
      mockPathname = '/dashboard';
      const { result } = renderHook(() => useSwipeNavigation());
      expect(result.current.isSwipePage).toBe(true);
      expect(result.current.totalPages).toBe(MAIN_CHAIN_COUNT);
    });
  });
});
