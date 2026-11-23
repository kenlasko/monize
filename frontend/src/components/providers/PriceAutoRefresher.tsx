'use client';

import { useEffect } from 'react';
import { useAuthStore } from '@/store/authStore';
import { AUTO_PRICE_REFRESH_INTERVAL_MS } from '@/lib/price-auto-refresh';
import { createLogger } from '@/lib/logger';

const logger = createLogger('PriceAutoRefresher');

/** How often the clock is read; the refresh itself is at most once per interval. */
const CHECK_EVERY_MS = 30_000;

// The refresh and the investments API it calls load on first use: this is
// mounted on every page, the signed-out ones included, and a visit shorter
// than the interval never needs them.
const loadRefreshState = () => import('@/lib/price-refresh-state');

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
 * Whether one is due is `runAutomaticPriceRefresh`'s to decide: every refresh,
 * from here, a page or an unscoped Refresh button, restarts the interval.
 */
export function PriceAutoRefresher() {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const authHydrated = useAuthStore((state) => state._hasHydrated);
  const isDelegateView = useAuthStore((state) => !!state.actingAsUserId);

  useEffect(() => {
    if (!authHydrated || !isAuthenticated || isDelegateView) return;
    let stopped = false;
    const startedAt = Date.now();
    const check = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - startedAt < AUTO_PRICE_REFRESH_INTERVAL_MS) return;
      loadRefreshState()
        .then(({ runAutomaticPriceRefresh }) => {
          if (!stopped) void runAutomaticPriceRefresh();
        })
        // A chunk that will not load (the site was redeployed under the open
        // tab) is tried again at the next check.
        .catch((error) => logger.warn('Could not load the price refresh:', error));
    };
    const timer = window.setInterval(check, CHECK_EVERY_MS);
    document.addEventListener('visibilitychange', check);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', check);
    };
  }, [authHydrated, isAuthenticated, isDelegateView]);

  return null;
}
