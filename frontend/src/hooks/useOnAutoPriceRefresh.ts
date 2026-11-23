'use client';

import { useEffect, useLayoutEffect, useRef } from 'react';
import { subscribeAutoPriceRefresh } from '@/lib/autoPriceRefreshSignal';

/**
 * Listens for automatic price refreshes that wrote new quotes and calls the
 * provided callback with the refresh's timestamp. Use it on a surface that
 * shows prices, with a callback that reloads it in the background: the
 * refresh is meant to be invisible, so the callback must not put the surface
 * back to its loading state.
 */
export function useOnAutoPriceRefresh(
  callback: (lastUpdated?: string) => void | Promise<void>,
) {
  const callbackRef = useRef(callback);

  // Refreshed after every commit rather than during render, so an inline
  // callback neither resubscribes on every render nor fires a stale closure.
  useLayoutEffect(() => {
    callbackRef.current = callback;
  });

  useEffect(() => {
    return subscribeAutoPriceRefresh((lastUpdated) => {
      void callbackRef.current(lastUpdated);
    });
  }, []);
}
