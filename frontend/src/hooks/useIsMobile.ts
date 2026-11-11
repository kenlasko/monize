'use client';

import { useCallback, useSyncExternalStore } from 'react';

const MOBILE_QUERY = '(max-width: 639px)';
/** Below Tailwind's `lg`: where a side panel stops fitting beside its content. */
const BELOW_DESKTOP_QUERY = '(max-width: 1023px)';
/**
 * Tailwind's `lg` and up. Written as Tailwind writes it (`--breakpoint-lg:
 * 64rem`): a rem in a media query follows the browser's default font size, so
 * with a larger default a px query would show the wide-only controls over a
 * grid whose `lg:` classes have not applied yet.
 */
const LG_UP_QUERY = '(min-width: 64rem)';
/** Below Tailwind's `xl`: where the header's nav links give way to the tab bar. */
const TAB_BAR_QUERY = '(max-width: 1279px)';

function getServerSnapshot(): boolean {
  return false;
}

/**
 * Whether a media query matches, as React state.
 *
 * One subscription mechanism for every breakpoint question, so a surface asking
 * about `lg` and a surface asking about `sm` cannot drift into two different
 * ways of watching the viewport. Server-rendered as `false`: the desktop layout
 * is the one that degrades gracefully when the first client render corrects it.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (callback: () => void) => {
      const mql = window.matchMedia(query);
      mql.addEventListener('change', callback);
      return () => mql.removeEventListener('change', callback);
    },
    [query],
  );

  const getSnapshot = useCallback(() => window.matchMedia(query).matches, [query]);

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export function useIsMobile(): boolean {
  return useMediaQuery(MOBILE_QUERY);
}

/**
 * Whether the viewport is narrower than `lg`, where a panel that sits beside
 * the content on a desktop has to become a dialog over it instead.
 */
export function useIsBelowDesktop(): boolean {
  return useMediaQuery(BELOW_DESKTOP_QUERY);
}

/**
 * Whether the viewport is at least `lg`, asked of its own query rather than
 * as `!useIsBelowDesktop()`: the server snapshot is `false` for both, and a
 * wide-only control must not render before the client has measured.
 */
export function useIsLgUp(): boolean {
  return useMediaQuery(LG_UP_QUERY);
}

/** Whether the bottom tab bar is the app's navigation at this width. */
export function useHasMobileTabBar(): boolean {
  return useMediaQuery(TAB_BAR_QUERY);
}
