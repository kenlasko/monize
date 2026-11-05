'use client';

import { useSyncExternalStore } from 'react';
import {
  currencyDecimalsVersion,
  subscribeCurrencyDecimals,
} from '@/lib/currency-decimals';

/**
 * The currency decimals registry's version (`lib/currency-decimals.ts`), with
 * the calling component subscribed to it.
 *
 * The registry fills after the first render, from `GET /currencies`. A value
 * derived from `decimalPlacesForCurrency`, `getDecimalPlacesForCurrency` or
 * `roundToEntryPlaces` inside a `useMemo` or `useCallback` lists this in its
 * deps, and a component that reads the registry during render calls it so the
 * render runs again: either way a coin's figure drawn at `Intl`'s two places
 * before the list arrived is redrawn at its own.
 */
export function useCurrencyDecimalsVersion(): number {
  return useSyncExternalStore(
    subscribeCurrencyDecimals,
    currencyDecimalsVersion,
    currencyDecimalsVersion,
  );
}
