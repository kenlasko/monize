import { investmentsApi } from '@/lib/investments';
import { createLogger } from '@/lib/logger';
import {
  AUTO_PRICE_REFRESH_INTERVAL_MS,
  autoRefreshSecurityIds,
} from '@/lib/price-auto-refresh';
import { notifyAutoPriceRefresh } from '@/lib/autoPriceRefreshSignal';

/**
 * The one price refresh a tab runs at a time, when the last one ran, and the
 * automatic refresh itself. Shared by `usePriceRefresh` (the Refresh buttons)
 * and `PriceAutoRefresher` (the open site's 15-minute refresh), and free of
 * React and translations so the root layout can mount the second on every
 * page, the signed-out ones included.
 */

const logger = createLogger('PriceRefresh');

// Module-level state — persists across component mounts within the same SPA session
let lastRefreshTimestamp = 0;
let refreshInProgress = false;
// The automatic refresh still running, if any. The reader sees nothing of it,
// so a click made meanwhile waits for it rather than being dropped.
let automaticRefresh: Promise<void> | null = null;

export function getRefreshInProgress(): boolean {
  return refreshInProgress;
}

export function setRefreshInProgress(value: boolean): void {
  refreshInProgress = value;
  if (value) {
    lastRefreshTimestamp = Date.now();
  }
}

/** Records that a refresh just wrote, which restarts the automatic interval. */
export function markPricesRefreshed(): void {
  lastRefreshTimestamp = Date.now();
}

/** The automatic refresh still running, for a click to wait on; null when none is. */
export function pendingAutomaticRefresh(): Promise<void> | null {
  return automaticRefresh;
}

/** Resets the module-level state between tests. */
export function __resetPriceRefreshStateForTesting(): void {
  lastRefreshTimestamp = 0;
  refreshInProgress = false;
  automaticRefresh = null;
}

/**
 * Whether an automatic refresh would run at `nowMs`: no refresh is running,
 * and none ran or was attempted within `AUTO_PRICE_REFRESH_INTERVAL_MS`.
 */
export function isAutomaticPriceRefreshDue(nowMs: number = Date.now()): boolean {
  return (
    !refreshInProgress &&
    nowMs - lastRefreshTimestamp >= AUTO_PRICE_REFRESH_INTERVAL_MS
  );
}

/**
 * Refresh, without a word to the reader, the quotes of every security whose
 * market is trading now (`autoRefreshSecurityIds`: a coin always, anything
 * else while its session is open), at most once per
 * `AUTO_PRICE_REFRESH_INTERVAL_MS`. Run by a page once its first figures are
 * in (`usePriceRefresh`'s `triggerAutoRefresh`) and by `PriceAutoRefresher`
 * while the site stays open.
 *
 * No toast and no spinner: a refusal or a failure is logged, and the next
 * attempt is one interval later. When a quote was written it fires
 * `notifyAutoPriceRefresh`, and the surfaces showing prices reload in the
 * background (`useOnAutoPriceRefresh`). Never rejects.
 */
export function runAutomaticPriceRefresh(): Promise<void> {
  if (!isAutomaticPriceRefreshDue()) return automaticRefresh ?? Promise.resolve();
  // Stamped before the request, so an attempt that found no market open, or
  // failed, waits out the interval like one that refreshed.
  setRefreshInProgress(true);
  const run = async () => {
    let wrote = false;
    let lastUpdated: string | undefined;
    try {
      const securities = await investmentsApi.getSecurities(false);
      const securityIds = autoRefreshSecurityIds(securities, new Date());
      if (securityIds.length === 0) {
        logger.debug('Skipping auto-refresh: no market open');
        return;
      }
      const result = await investmentsApi.refreshSelectedPrices(securityIds);
      markPricesRefreshed();
      // `updated` is the server's count of rows it wrote: nothing written,
      // nothing on screen to reload (`docs/frontend/api-and-cache.md`).
      wrote = result.updated > 0;
      lastUpdated = result.lastUpdated || undefined;
    } catch (error) {
      logger.error('Automatic price refresh failed:', error);
    } finally {
      refreshInProgress = false;
      automaticRefresh = null;
    }
    if (wrote) notifyAutoPriceRefresh(lastUpdated);
  };
  automaticRefresh = run();
  return automaticRefresh;
}
