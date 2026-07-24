import { useEffect, useState } from 'react';
import { findTourAnchor, type TourAnchorId } from '@/lib/tours/anchors';

export type AnchorStatus = 'waiting' | 'found' | 'timeout';

export interface TourAnchorResult {
  element: HTMLElement | null;
  status: AnchorStatus;
}

/** How often to re-poll for the anchor between MutationObserver notifications. */
const POLL_MS = 250;

/**
 * Wait for a tour anchor element to mount. Resolves via a MutationObserver, a
 * fallback poll, and a timeout (graceful skip). Centered steps (`anchorId` null)
 * or a disabled hook resolve to `found` immediately with no element.
 *
 * State is only ever set from async callbacks (observer / interval / timeout /
 * rAF) or the info-from-previous-render reset, never synchronously inside the
 * effect, to satisfy `react-hooks/set-state-in-effect`.
 */
export function useTourAnchor(
  anchorId: TourAnchorId | null,
  options: { enabled?: boolean; timeoutMs?: number } = {},
): TourAnchorResult {
  const { enabled = true, timeoutMs = 5000 } = options;
  const [result, setResult] = useState<TourAnchorResult>(() =>
    anchorId === null || !enabled
      ? { element: null, status: 'found' }
      : { element: null, status: 'waiting' },
  );

  // Reset when the target (or enabled flag) changes, during render.
  const key = `${anchorId ?? ''}|${enabled}`;
  const [prevKey, setPrevKey] = useState(key);
  if (key !== prevKey) {
    setPrevKey(key);
    setResult(
      anchorId === null || !enabled
        ? { element: null, status: 'found' }
        : { element: null, status: 'waiting' },
    );
  }

  useEffect(() => {
    if (!enabled || anchorId === null) return;

    let settled = false;
    const settle = (next: TourAnchorResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      setResult(next);
    };
    const check = () => {
      const element = findTourAnchor(anchorId);
      if (element) settle({ element, status: 'found' });
    };

    const observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true });
    const interval = setInterval(check, POLL_MS);
    const timeout = setTimeout(
      () => settle({ element: null, status: 'timeout' }),
      timeoutMs,
    );
    // First check on the next frame (async, so not a synchronous effect set).
    const raf = requestAnimationFrame(check);

    function cleanup() {
      observer.disconnect();
      clearInterval(interval);
      clearTimeout(timeout);
      cancelAnimationFrame(raf);
    }
    return cleanup;
  }, [anchorId, enabled, timeoutMs]);

  return result;
}
