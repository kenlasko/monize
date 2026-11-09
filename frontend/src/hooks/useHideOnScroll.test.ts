import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useHideOnScroll } from './useHideOnScroll';

const HEADER_HEIGHT = 64;

/**
 * Renders the hook with a mounted element of HEADER_HEIGHT so the offset has a
 * real height to clamp against.
 */
function renderWithHeader() {
  const el = document.createElement('header');
  Object.defineProperty(el, 'offsetHeight', {
    value: HEADER_HEIGHT,
    configurable: true,
  });
  const hook = renderHook(() => useHideOnScroll<HTMLElement>());
  act(() => {
    hook.result.current.ref.current = el;
  });
  return hook;
}

/**
 * Drives the window scroll position and flushes the rAF the hook schedules.
 */
function scrollTo(y: number) {
  act(() => {
    Object.defineProperty(window, 'scrollY', { value: y, configurable: true });
    window.dispatchEvent(new Event('scroll'));
    // The hook batches its read through requestAnimationFrame.
    vi.runOnlyPendingTimers();
  });
}

describe('useHideOnScroll', () => {
  it('tracks nothing while disabled, and starts visible when enabled again', () => {
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
    const el = document.createElement('header');
    Object.defineProperty(el, 'offsetHeight', { value: HEADER_HEIGHT, configurable: true });
    const hook = renderHook(({ enabled }) => useHideOnScroll<HTMLElement>(enabled), {
      initialProps: { enabled: true },
    });
    act(() => {
      hook.result.current.ref.current = el;
    });
    scrollTo(40);
    expect(hook.result.current.offset).toBe(40);

    hook.rerender({ enabled: false });
    expect(hook.result.current.offset).toBe(0);
    scrollTo(60);
    expect(hook.result.current.offset).toBe(0);

    hook.rerender({ enabled: true });
    expect(hook.result.current.offset).toBe(0);
  });

  beforeEach(() => {
    vi.useFakeTimers();
    // Make requestAnimationFrame run via the fake timer queue.
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      return setTimeout(() => cb(performance.now()), 0) as unknown as number;
    });
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('starts fully visible with a zero offset', () => {
    const { result } = renderWithHeader();
    expect(result.current.offset).toBe(0);
  });

  it('tracks the scroll delta 1:1 while partially scrolled', () => {
    const { result } = renderWithHeader();
    scrollTo(30);
    expect(result.current.offset).toBe(30);
  });

  it('clamps the offset at the element height once fully hidden', () => {
    const { result } = renderWithHeader();
    scrollTo(200);
    expect(result.current.offset).toBe(HEADER_HEIGHT);
  });

  it('reveals in lockstep when scrolling back up', () => {
    const { result } = renderWithHeader();
    scrollTo(200);
    expect(result.current.offset).toBe(HEADER_HEIGHT);
    // Scroll up by 40px: the header slides back down by exactly 40px.
    scrollTo(160);
    expect(result.current.offset).toBe(HEADER_HEIGHT - 40);
  });

  it('clamps the offset at zero when scrolled back to the top', () => {
    const { result } = renderWithHeader();
    scrollTo(200);
    scrollTo(0);
    expect(result.current.offset).toBe(0);
  });

  it('stays fully visible when no element height is available', () => {
    const { result } = renderHook(() => useHideOnScroll<HTMLElement>());
    scrollTo(200);
    expect(result.current.offset).toBe(0);
  });

  it('removes the scroll listener on unmount', () => {
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const { unmount } = renderWithHeader();
    unmount();
    expect(removeSpy).toHaveBeenCalledWith('scroll', expect.any(Function));
  });
});
