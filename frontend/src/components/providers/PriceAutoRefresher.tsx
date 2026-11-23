'use client';

import { useEffect } from 'react';
import { useAuthStore } from '@/store/authStore';
import { AUTO_PRICE_REFRESH_INTERVAL_MS } from '@/lib/price-auto-refresh';
import {
  isAutomaticPriceRefreshDue,
  runAutomaticPriceRefresh,
} from '@/lib/price-refresh-state';

/** How often the clock is read; the refresh itself is at most once per interval. */
const CHECK_EVERY_MS = 30_000;

/**
 * Keeps security prices current while the site is open: every
 * `AUTO_PRICE_REFRESH_INTERVAL_MS` (15 minutes) it refreshes the quotes of the
 * securities whose market is trading (`lib/price-auto-refresh.ts`; a coin's
 * always is), on whatever page the reader is on. The surfaces that show prices
 * reload in the background when a quote was written (`useOnAutoPriceRefresh`);
 * nothing here shows a toast or a spinner.
 *
 * Mounted beside `CurrencyRegistryLoader`. It waits for the auth store to
 * hydrate, does nothing signed out or in a delegate's view (the refresh is the
 * owner's), and only refreshes while the tab is visible: a hidden tab asks
 * nothing, and coming back to it after the interval refreshes at once.
 *
 * The first refresh is one interval after the site opens, not at once. The
 * Dashboard and Investments pages ask for their own as soon as their first
 * figures are in (`triggerAutoRefresh`), and a refresh landing while a page's
 * first valuation is still running would value the same history twice (#1888).
 * Every refresh, from here, a page or a Refresh button, restarts the interval.
 */
export function PriceAutoRefresher() {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const authHydrated = useAuthStore((state) => state._hasHydrated);
  const isDelegateView = useAuthStore((state) => !!state.actingAsUserId);

  useEffect(() => {
    if (!authHydrated || !isAuthenticated || isDelegateView) return;
    const startedAt = Date.now();
    const check = () => {
      if (document.visibilityState !== 'visible') return;
      const now = Date.now();
      if (now - startedAt < AUTO_PRICE_REFRESH_INTERVAL_MS) return;
      if (!isAutomaticPriceRefreshDue(now)) return;
      void runAutomaticPriceRefresh();
    };
    const timer = window.setInterval(check, CHECK_EVERY_MS);
    document.addEventListener('visibilitychange', check);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', check);
    };
  }, [authHydrated, isAuthenticated, isDelegateView]);

  return null;
}
