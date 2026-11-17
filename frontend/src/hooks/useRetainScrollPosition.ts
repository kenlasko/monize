'use client';

import { useEffect, useRef } from 'react';
import { currentScrollKey, rememberScroll, retainedScroll } from '@/lib/scroll-retention';

/** How long a restore keeps trying while the page grows to the height it needs. */
const RESTORE_WINDOW_MS = 1500;

/**
 * Brings the reader back to where they were on this page when they return to
 * it, by Back or by its tab, rather than to the top. `ready` is true once the
 * page draws the content the place was measured against (its list, not its
 * spinner); nothing is recorded or restored before that, so a loading screen
 * never overwrites the place with zero.
 *
 * `useScrollToTopOnNavigation` leaves a page alone when it has a place kept
 * here, so the two never fight. A restore that lands before the page is tall
 * enough (a chart still loading below the list) keeps trying as the page
 * grows, for a moment, and gives way the instant the reader scrolls, taps or
 * presses a key.
 */
export function useRetainScrollPosition(ready: boolean): void {
  const readyRef = useRef(ready);
  useEffect(() => {
    readyRef.current = ready;
  });

  // Record the place as the reader scrolls, while this page is the one in the
  // address bar: a scroll that fires after a navigation away belongs to the
  // next page and must not be filed under this one.
  useEffect(() => {
    const pathname = window.location.pathname;
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (!readyRef.current || window.location.pathname !== pathname) return;
        rememberScroll(currentScrollKey(), window.scrollY);
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  // Restore once per visit, the first time the content is ready.
  const restored = useRef(false);
  useEffect(() => {
    if (!ready || restored.current) return;
    restored.current = true;
    const target = retainedScroll(currentScrollKey());
    if (target === undefined) return;

    window.scrollTo(0, target);
    if (window.scrollY >= target - 1) return;

    // The page is not yet tall enough: try again as it grows.
    let done = false;
    const stop = () => {
      if (done) return;
      done = true;
      observer?.disconnect();
      clearTimeout(timeout);
      for (const type of USER_INPUT_EVENTS) window.removeEventListener(type, stop);
    };
    const retry = () => {
      if (done) return;
      window.scrollTo(0, target);
      if (window.scrollY >= target - 1) stop();
    };
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(retry);
    observer?.observe(document.body);
    const timeout = setTimeout(stop, RESTORE_WINDOW_MS);
    for (const type of USER_INPUT_EVENTS) {
      window.addEventListener(type, stop, { passive: true, once: true });
    }
    return stop;
  }, [ready]);
}

const USER_INPUT_EVENTS = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;
