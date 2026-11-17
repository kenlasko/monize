'use client';

import { useEffect, useRef } from 'react';
import { rememberScroll, retainedScroll } from '@/lib/scroll-retention';

/** How long a restore keeps trying while the page grows to the height it needs. */
const RESTORE_WINDOW_MS = 1500;

const USER_INPUT_EVENTS = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;

/**
 * Brings the reader back to where they were on this page when they return to
 * it, by Back or by its tab, rather than to the top. `ready` is true once the
 * page draws the content the place was measured against (its list, not its
 * spinner); nothing is recorded or restored before that, so a loading screen
 * never overwrites the place with zero.
 *
 * `contentKey` names that content, so a place is restored only over the same
 * thing: by default the query string, and Transactions passes its register's
 * request key, since it rewrites its query after it draws. A return to other
 * content starts at the top.
 *
 * `useScrollToTopOnNavigation` leaves a page that kept a place alone, so the
 * two never fight. A restore that lands before the page is tall enough (a
 * chart still loading below the list) keeps trying as the page grows, for a
 * moment, and gives way the instant the reader scrolls, taps or presses a key.
 */
export function useRetainScrollPosition(ready: boolean, contentKey?: string): void {
  const readyRef = useRef(ready);
  const contentKeyRef = useRef(contentKey);
  useEffect(() => {
    readyRef.current = ready;
    contentKeyRef.current = contentKey;
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
        rememberScroll(pathname, window.scrollY, contentKeyRef.current ?? window.location.search);
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
    const kept = retainedScroll(window.location.pathname);
    if (kept === undefined) return;
    // Kept for other content: this visit starts at the top, which
    // `useScrollToTopOnNavigation` left to this hook.
    const target =
      kept.contentKey === (contentKeyRef.current ?? window.location.search) ? kept.top : 0;

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
    return () => {
      // Torn down before it reached the place (React's development re-run of
      // effects, or the list reloading): the next run resumes it.
      if (!done) restored.current = false;
      stop();
    };
  }, [ready]);
}
