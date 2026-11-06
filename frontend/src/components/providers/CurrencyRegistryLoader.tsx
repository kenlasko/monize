'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useAuthStore } from '@/store/authStore';
import { exchangeRatesApi } from '@/lib/exchange-rates';
import { clearCurrencyDecimals, registerCurrencyDecimals } from '@/lib/currency-decimals';
import { createLogger } from '@/lib/logger';

const logger = createLogger('CurrencyRegistryLoader');

/**
 * Fills the currency decimals registry (`lib/currency-decimals.ts`) once per
 * signed-in session, so a coin stored with four places formats with four on
 * every screen rather than at `Intl`'s two, and with its stored symbol (`₿`)
 * rather than the code `Intl` writes for a currency it does not know. Mounted
 * beside `PreferencesLoader` and, like it, waits for the auth store to hydrate.
 *
 * A failed load is logged and leaves the registry empty: every figure then
 * formats as it did before the registry existed, and a coin amount is entered
 * at the stored four places (`entryDecimalPlaces`). It is not final: the load
 * runs again on the next auth change, when the tab becomes visible again and
 * when the browser comes back online, until one succeeds. Signing out empties
 * the registry, and the next sign-in loads it again.
 */
export function CurrencyRegistryLoader() {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const authHydrated = useAuthStore((state) => state._hasHydrated);
  // Whether this session's load has started (or succeeded), and which session
  // a load belongs to: a sign-out bumps the generation so an answer still in
  // flight for the previous session is dropped rather than registered for the
  // next one. A failure clears `loadStarted` so a retry can run.
  const loadStarted = useRef(false);
  const generation = useRef(0);

  const load = useCallback(() => {
    if (loadStarted.current) return;
    loadStarted.current = true;
    const startedFor = generation.current;
    exchangeRatesApi
      .getCurrencies(true)
      .then((currencies) => {
        if (generation.current !== startedFor) return;
        registerCurrencyDecimals(Array.isArray(currencies) ? currencies : []);
      })
      .catch((error) => {
        logger.error('Failed to load currency decimal places:', error);
        // Same session: let the next trigger try again. A later session has
        // already reset the flag and may have started its own load.
        if (generation.current === startedFor) loadStarted.current = false;
      });
  }, []);

  useEffect(() => {
    if (!authHydrated) return;
    if (!isAuthenticated) {
      if (loadStarted.current) generation.current += 1;
      loadStarted.current = false;
      clearCurrencyDecimals();
      return;
    }
    load();
  }, [isAuthenticated, authHydrated, load]);

  // Retry a failed load when the reader comes back to the tab or the network
  // returns; a no-op once a load has started or succeeded.
  useEffect(() => {
    if (!authHydrated || !isAuthenticated) return;
    const retry = () => {
      if (document.visibilityState === 'visible') load();
    };
    document.addEventListener('visibilitychange', retry);
    window.addEventListener('online', retry);
    return () => {
      document.removeEventListener('visibilitychange', retry);
      window.removeEventListener('online', retry);
    };
  }, [isAuthenticated, authHydrated, load]);

  return null;
}
