'use client';

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import { retainedScroll } from '@/lib/scroll-retention';

// Browser Back/Forward fire `popstate` immediately before the route
// updates. If a popstate landed within this window of the path change we
// treat the navigation as Back/Forward and leave the browser's own scroll
// restoration alone. A timestamp (rather than a boolean flag) means a
// popstate that does not change the route -- e.g. closing a modal that
// pushed a history entry -- expires on its own and cannot suppress a later
// forward navigation.
const BACK_FORWARD_WINDOW_MS = 200;

/**
 * Scrolls the window to the top when navigating forward to a new route -- a
 * top-nav tab click or a swipe between pages -- so the page title and its
 * action buttons are always in view. Browser Back/Forward navigations are
 * left untouched so their previous scroll position is restored, and so is a
 * page that keeps the reader's place (`useRetainScrollPosition`) and has one:
 * that hook puts the reader back there, or at the top when the content
 * changed.
 */
export function useScrollToTopOnNavigation(): void {
  const pathname = usePathname();
  const previousPathname = useRef(pathname);
  const lastPopStateAt = useRef(0);

  useEffect(() => {
    const onPopState = () => {
      lastPopStateAt.current = Date.now();
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    if (pathname === previousPathname.current) return;
    previousPathname.current = pathname;

    const isBackForward =
      Date.now() - lastPopStateAt.current < BACK_FORWARD_WINDOW_MS;
    if (isBackForward) return;
    if (retainedScroll(pathname) !== undefined) return;

    window.scrollTo(0, 0);
  }, [pathname]);
}
