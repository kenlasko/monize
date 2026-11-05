'use client';

import { useEffect, useRef } from 'react';
import { useAuthStore } from '@/store/authStore';
import { exchangeRatesApi } from '@/lib/exchange-rates';
import { clearCurrencyDecimals, registerCurrencyDecimals } from '@/lib/currency-decimals';
import { createLogger } from '@/lib/logger';

const logger = createLogger('CurrencyRegistryLoader');

/**
 * Fills the currency decimals registry (`lib/currency-decimals.ts`) once per
 * signed-in session, so a coin stored with four places formats with four on
 * every screen rather than at `Intl`'s two, and with its stored symbol (`₿`)
 * rather than the code `Intl` writes for a currency it does not know. Mounted beside `PreferencesLoader`
 * and, like it, waits for the auth store to hydrate.
 *
 * A failed load is logged and leaves the registry empty: every figure then
 * formats as it did before the registry existed, which is a precision loss on
 * a coin, never a broken screen. Signing out empties the registry, and the next
 * sign-in loads it again.
 */
export function CurrencyRegistryLoader() {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const authHydrated = useAuthStore((state) => state._hasHydrated);
  // Whether this session's load has started, and which session a load belongs
  // to: a sign-out bumps the generation so an answer still in flight for the
  // previous session is dropped rather than registered for the next one.
  const loadStarted = useRef(false);
  const generation = useRef(0);

  useEffect(() => {
    if (!authHydrated) return;
    if (!isAuthenticated) {
      if (loadStarted.current) generation.current += 1;
      loadStarted.current = false;
      clearCurrencyDecimals();
      return;
    }
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
      });
  }, [isAuthenticated, authHydrated]);

  return null;
}
