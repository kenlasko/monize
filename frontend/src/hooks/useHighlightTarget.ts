'use client';

import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';

/**
 * Shared deep-link "flash this row" helpers, used by list pages to draw
 * attention to the item a link points at -- e.g. the AI chat confirmation
 * card's "View payees / View securities / ..." links after creating or
 * editing an entity. A list page reads the id from the URL with
 * {@link useHighlightParam} and an item scrolls itself into view with
 * {@link useScrollIntoViewWhen}, painted with {@link HIGHLIGHT_RING}.
 *
 * The transactions list uses its own `targetTransactionId` mechanism instead,
 * because it is server-paginated and the backend has to resolve which page
 * contains the row; these helpers cover the client-loaded lists (payees,
 * securities, categories, ...).
 */

// One-shot amber flash for the targeted row: a fading background + inset ring
// (see the `highlight-flash` keyframe in globals.css) that gently fades out
// instead of blinking off. Sticky cells (e.g. a `sticky right-0` actions
// column) must drop their opaque background while highlighted so the flash
// and its ring wrap the whole row -- see HIGHLIGHT_FLASH_CELL.
export const HIGHLIGHT_FLASH = 'animate-highlight-flash motion-reduce:animate-none';

// Apply to a sticky/opaque cell so the row flash shows through it (otherwise
// the cell's own background paints over the flash and the ring stops short).
export const HIGHLIGHT_FLASH_CELL = '!bg-transparent';

// How long the flash lingers before it clears itself.
const HIGHLIGHT_DURATION_MS = 3500;

/**
 * Read a one-shot highlight id from the URL (`?highlight=<id>` by default).
 * Returns the id, then clears it after a short delay so the flash does not
 * stick on later interactions. The value is captured once on mount, so
 * navigating within the page (which rewrites the query string) does not
 * re-trigger it.
 */
export function useHighlightParam(param = 'highlight'): string | null {
  const searchParams = useSearchParams();
  const [highlightId, setHighlightId] = useState<string | null>(
    () => searchParams.get(param),
  );

  useEffect(() => {
    if (!highlightId) return;
    const timer = setTimeout(() => setHighlightId(null), HIGHLIGHT_DURATION_MS);
    return () => clearTimeout(timer);
  }, [highlightId]);

  return highlightId;
}

/**
 * Returns a ref to attach to a row element; when `active` flips to true the
 * row smoothly scrolls itself into view (centered). Pair it with
 * {@link HIGHLIGHT_RING} on the same element for the visual flash.
 */
export function useScrollIntoViewWhen<T extends HTMLElement>(active: boolean) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (active) {
      ref.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [active]);
  return ref;
}
