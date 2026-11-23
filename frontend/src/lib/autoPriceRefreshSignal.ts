/**
 * Simple pub/sub signal fired after an automatic price refresh wrote new
 * quotes (`runAutomaticPriceRefresh` in `lib/price-refresh-state.ts`). Pages
 * that show prices subscribe via {@link useOnAutoPriceRefresh} and reload in
 * the background, so the figures the reader is looking at follow the market
 * without a click, a toast or a skeleton.
 *
 * A manual refresh does not fire it: the control that asked reloads its own
 * surface through `usePriceRefresh`'s `onRefreshComplete`.
 *
 * Mirrors {@link import('./aiActionSignal')}.
 */
type Listener = (lastUpdated?: string) => void;

const listeners = new Set<Listener>();

export function subscribeAutoPriceRefresh(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** `lastUpdated` is the refresh result's own timestamp (ISO). */
export function notifyAutoPriceRefresh(lastUpdated?: string): void {
  listeners.forEach((fn) => fn(lastUpdated));
}
