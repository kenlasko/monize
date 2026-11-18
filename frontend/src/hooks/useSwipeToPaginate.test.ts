import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, renderHook, act } from '@/test/render';
import { createElement } from 'react';
import { useSwipeToPaginate } from './useSwipeToPaginate';

const onPageChange = vi.fn();

// Renders the hook onto a real element, the way a real caller does -- React
// attaches the ref before the effect runs, so the listeners bind. Returns the
// element to dispatch touch events on.
function Harness({ page, totalPages }: { page: number; totalPages: number }) {
  const { swipeRef, paginates } = useSwipeToPaginate({ page, totalPages, onPageChange });
  return createElement('div', {
    ref: swipeRef,
    'data-testid': 'zone',
    'data-paginates': String(paginates),
  });
}

function createTouchEvent(
  type: 'touchstart' | 'touchmove' | 'touchend' | 'touchcancel',
  clientX: number,
  clientY: number,
): TouchEvent {
  const touchData = { clientX, clientY, identifier: 0 } as Touch;
  const init: TouchEventInit = { bubbles: true, cancelable: type === 'touchmove' };
  if (type === 'touchend' || type === 'touchcancel') {
    init.changedTouches = [touchData];
    init.touches = [];
  } else {
    init.touches = [touchData];
    init.changedTouches = [touchData];
  }
  return new TouchEvent(type, init);
}

// A second finger landing while the first is still down.
function createSecondFingerTouchStart(first: [number, number], second: [number, number]): TouchEvent {
  const one = { clientX: first[0], clientY: first[1], identifier: 0 } as Touch;
  const two = { clientX: second[0], clientY: second[1], identifier: 1 } as Touch;
  return new TouchEvent('touchstart', { bubbles: true, touches: [one, two], changedTouches: [two] });
}

describe('useSwipeToPaginate', () => {
  let originalInnerWidth: number;

  beforeEach(() => {
    vi.clearAllMocks();
    originalInnerWidth = window.innerWidth;
    // offsetWidth is 0 in jsdom, so the hook falls back to innerWidth for its
    // commit threshold -- 25% of 400 = 100px.
    Object.defineProperty(window, 'innerWidth', { value: 400, writable: true, configurable: true });
    document.body.style.overflow = '';
  });

  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', { value: originalInnerWidth, writable: true, configurable: true });
  });

  function renderZone(page: number, totalPages: number) {
    const { getByTestId } = render(createElement(Harness, { page, totalPages }));
    return getByTestId('zone') as HTMLDivElement;
  }

  it('reports paginates=false for a single page and true for more', () => {
    const one = renderHook(() => useSwipeToPaginate({ page: 1, totalPages: 1, onPageChange }));
    expect(one.result.current.paginates).toBe(false);
    one.unmount();
    const many = renderHook(() => useSwipeToPaginate({ page: 1, totalPages: 3, onPageChange }));
    expect(many.result.current.paginates).toBe(true);
  });

  it('turns to the next page on a swipe left past the commit threshold', () => {
    vi.useFakeTimers();
    const zone = renderZone(2, 5); // middle page: can go both ways
    act(() => {
      zone.dispatchEvent(createTouchEvent('touchstart', 300, 200));
      zone.dispatchEvent(createTouchEvent('touchmove', 150, 202)); // 150px left > 100
      zone.dispatchEvent(createTouchEvent('touchend', 150, 202));
    });
    act(() => {
      vi.advanceTimersByTime(300); // past the animation timeout
    });
    expect(onPageChange).toHaveBeenCalledWith(3);
    vi.useRealTimers();
  });

  it('turns to the previous page on a swipe right past the commit threshold', () => {
    vi.useFakeTimers();
    const zone = renderZone(2, 5);
    act(() => {
      zone.dispatchEvent(createTouchEvent('touchstart', 100, 200));
      zone.dispatchEvent(createTouchEvent('touchmove', 250, 202)); // 150px right
      zone.dispatchEvent(createTouchEvent('touchend', 250, 202));
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(onPageChange).toHaveBeenCalledWith(1);
    vi.useRealTimers();
  });

  it('does not turn back before the first page', () => {
    vi.useFakeTimers();
    const zone = renderZone(1, 5); // first page: nothing to the right
    act(() => {
      zone.dispatchEvent(createTouchEvent('touchstart', 100, 200));
      zone.dispatchEvent(createTouchEvent('touchmove', 250, 202));
      zone.dispatchEvent(createTouchEvent('touchend', 250, 202));
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(onPageChange).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('does not turn forward past the last page', () => {
    vi.useFakeTimers();
    const zone = renderZone(5, 5); // last page: nothing to the left
    act(() => {
      zone.dispatchEvent(createTouchEvent('touchstart', 300, 200));
      zone.dispatchEvent(createTouchEvent('touchmove', 150, 202));
      zone.dispatchEvent(createTouchEvent('touchend', 150, 202));
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(onPageChange).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('snaps back and does not turn on a short swipe below the threshold', () => {
    vi.useFakeTimers();
    const zone = renderZone(2, 5);
    act(() => {
      zone.dispatchEvent(createTouchEvent('touchstart', 200, 200));
      zone.dispatchEvent(createTouchEvent('touchmove', 185, 202)); // 15px, well below 100
    });
    act(() => {
      vi.advanceTimersByTime(2000); // kill velocity
    });
    act(() => {
      zone.dispatchEvent(createTouchEvent('touchend', 185, 202));
    });
    expect(zone.style.transform).toBe('translateX(0px)');
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(onPageChange).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('ignores a vertical scroll', () => {
    const zone = renderZone(2, 5);
    act(() => {
      zone.dispatchEvent(createTouchEvent('touchstart', 200, 200));
      zone.dispatchEvent(createTouchEvent('touchmove', 203, 260)); // mostly vertical
    });
    expect(zone.style.transform).toBe('');
    expect(onPageChange).not.toHaveBeenCalled();
  });

  it('does not attach a swipe on a single-page list', () => {
    vi.useFakeTimers();
    const zone = renderZone(1, 1);
    expect(zone.getAttribute('data-paginates')).toBe('false');
    act(() => {
      zone.dispatchEvent(createTouchEvent('touchstart', 300, 200));
      zone.dispatchEvent(createTouchEvent('touchmove', 150, 202));
      zone.dispatchEvent(createTouchEvent('touchend', 150, 202));
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(onPageChange).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  // Issue #2273: a drag that never received its touchend left the list
  // sitting part way across its box.
  it('slides back to rest when the touch is cancelled mid-swipe', () => {
    vi.useFakeTimers();
    const zone = renderZone(2, 5);
    act(() => {
      zone.dispatchEvent(createTouchEvent('touchstart', 300, 200));
      zone.dispatchEvent(createTouchEvent('touchmove', 200, 202));
    });
    expect(zone.style.transform).toBe('translateX(-100px)');
    act(() => {
      zone.dispatchEvent(createTouchEvent('touchcancel', 200, 202));
    });
    expect(zone.style.transform).toBe('translateX(0px)');
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(zone.style.transform).toBe('');
    expect(zone.style.transition).toBe('');
    expect(onPageChange).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('abandons the swipe when a second finger lands', () => {
    vi.useFakeTimers();
    const zone = renderZone(2, 5);
    act(() => {
      zone.dispatchEvent(createTouchEvent('touchstart', 300, 200));
      zone.dispatchEvent(createTouchEvent('touchmove', 150, 202));
      zone.dispatchEvent(createSecondFingerTouchStart([150, 202], [100, 300]));
    });
    expect(zone.style.transform).toBe('translateX(0px)');
    act(() => {
      zone.dispatchEvent(createTouchEvent('touchend', 150, 202));
      vi.advanceTimersByTime(300);
    });
    expect(zone.style.transform).toBe('');
    expect(onPageChange).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('clears the drag when the list stops paginating mid-swipe', () => {
    const onPage = vi.fn();
    function Toggle({ totalPages }: { totalPages: number }) {
      const { swipeRef } = useSwipeToPaginate({ page: 1, totalPages, onPageChange: onPage });
      return createElement('div', { ref: swipeRef, 'data-testid': 'zone' });
    }
    const { getByTestId, rerender } = render(createElement(Toggle, { totalPages: 3 }));
    const zone = getByTestId('zone') as HTMLDivElement;
    act(() => {
      zone.dispatchEvent(createTouchEvent('touchstart', 300, 200));
      zone.dispatchEvent(createTouchEvent('touchmove', 200, 202));
    });
    expect(zone.style.transform).toBe('translateX(-100px)');
    rerender(createElement(Toggle, { totalPages: 1 }));
    expect(zone.style.transform).toBe('');
  });
});
