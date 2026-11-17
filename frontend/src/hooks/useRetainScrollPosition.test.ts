import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@/test/render';
import { useRetainScrollPosition } from './useRetainScrollPosition';
import { clearRetainedScroll, rememberScroll, retainedScroll } from '@/lib/scroll-retention';

let scrollY = 0;
let maxScroll = 10_000;

function scrollTo(_x: number, y: number) {
  scrollY = Math.min(y, maxScroll);
}

async function scrollWindow(y: number) {
  scrollY = y;
  window.dispatchEvent(new Event('scroll'));
  // The recorder waits a frame.
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
  });
}

describe('useRetainScrollPosition', () => {
  beforeEach(() => {
    clearRetainedScroll();
    scrollY = 0;
    maxScroll = 10_000;
    window.history.pushState({}, '', '/accounts');
    Object.defineProperty(window, 'scrollY', { configurable: true, get: () => scrollY });
    vi.spyOn(window, 'scrollTo').mockImplementation(scrollTo as typeof window.scrollTo);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.history.pushState({}, '', '/');
  });

  it('records the place under the page it belongs to', async () => {
    renderHook(() => useRetainScrollPosition(true));
    await scrollWindow(420);
    expect(retainedScroll('/accounts')).toEqual({ top: 420, contentKey: '' });
  });

  it('records nothing while the page is still loading', async () => {
    renderHook(() => useRetainScrollPosition(false));
    await scrollWindow(0);
    expect(retainedScroll('/accounts')).toBeUndefined();
  });

  it('does not file a scroll after a navigation away under this page', async () => {
    renderHook(() => useRetainScrollPosition(true));
    await scrollWindow(300);
    window.history.pushState({}, '', '/transactions');
    await scrollWindow(0);
    expect(retainedScroll('/accounts')?.top).toBe(300);
    expect(retainedScroll('/transactions')).toBeUndefined();
  });

  it('restores a place only over the content it was measured against', async () => {
    window.history.pushState({}, '', '/transactions?accountId=a');
    const first = renderHook(() => useRetainScrollPosition(true));
    await scrollWindow(900);
    expect(retainedScroll('/transactions')).toEqual({ top: 900, contentKey: '?accountId=a' });
    first.unmount();

    // Another account's list starts at the top.
    window.history.pushState({}, '', '/transactions?accountId=b');
    scrollY = 900;
    renderHook(() => useRetainScrollPosition(true));
    expect(window.scrollTo).toHaveBeenLastCalledWith(0, 0);
  });

  it('finds its place under the content key a page passes, whatever the query says', async () => {
    window.history.pushState({}, '', '/transactions?accountIds=x');
    const first = renderHook(() => useRetainScrollPosition(true, 'register-x'));
    await scrollWindow(2000);
    first.unmount();

    // The tab pushes the bare path; the page puts its filters back later.
    window.history.pushState({}, '', '/transactions');
    scrollY = 0;
    renderHook(() => useRetainScrollPosition(true, 'register-x'));
    expect(scrollY).toBe(2000);
  });

  it('restores the place once the content is ready, not before', () => {
    rememberScroll('/accounts', 640, '');
    const { rerender } = renderHook(({ ready }) => useRetainScrollPosition(ready), {
      initialProps: { ready: false },
    });
    expect(window.scrollTo).not.toHaveBeenCalled();
    rerender({ ready: true });
    expect(window.scrollTo).toHaveBeenCalledWith(0, 640);
    expect(scrollY).toBe(640);
  });

  it('leaves a page with no place kept where it is', () => {
    renderHook(() => useRetainScrollPosition(true));
    expect(window.scrollTo).not.toHaveBeenCalled();
  });

  it('restores once per visit, not on every reload of the list', () => {
    rememberScroll('/accounts', 640, '');
    const { rerender } = renderHook(({ ready }) => useRetainScrollPosition(ready), {
      initialProps: { ready: true },
    });
    rerender({ ready: false });
    rerender({ ready: true });
    expect(window.scrollTo).toHaveBeenCalledTimes(1);
  });

  it('gives way to the reader when the page is not yet tall enough', () => {
    rememberScroll('/accounts', 2000, '');
    maxScroll = 500;
    renderHook(() => useRetainScrollPosition(true));
    expect(scrollY).toBe(500);
    // The reader scrolls before the page has grown: the restore stops trying.
    window.dispatchEvent(new Event('wheel'));
    maxScroll = 5000;
    expect(scrollY).toBe(500);
  });
});

describe('useRetainScrollPosition in a development re-run of effects', () => {
  beforeEach(() => {
    clearRetainedScroll();
    scrollY = 0;
    maxScroll = 500;
    window.history.pushState({}, '', '/accounts');
    Object.defineProperty(window, 'scrollY', { configurable: true, get: () => scrollY });
    vi.spyOn(window, 'scrollTo').mockImplementation(scrollTo as typeof window.scrollTo);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.history.pushState({}, '', '/');
  });

  it('resumes a restore that was torn down before it reached the place', () => {
    rememberScroll('/accounts', 2000, '');
    const { rerender } = renderHook(({ ready }) => useRetainScrollPosition(ready), {
      initialProps: { ready: true },
    });
    // The page was too short; the list reloads and comes back taller.
    rerender({ ready: false });
    maxScroll = 5000;
    rerender({ ready: true });
    expect(scrollY).toBe(2000);
  });
});
