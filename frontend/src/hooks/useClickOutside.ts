import { useEffect, useRef } from 'react';

// Read-only structural ref so refs of any element subtype (HTMLDivElement,
// HTMLButtonElement, ...) are accepted -- RefObject<T>.current is mutable and
// therefore invariant, which would reject subtypes.
type ElementRef = { readonly current: HTMLElement | null };

interface UseClickOutsideOptions {
  /** When false, no listeners are attached (e.g. while the menu is closed). Defaults to true. */
  enabled?: boolean;
  /** When provided, also attaches a keydown listener that calls this on Escape. */
  onEscape?: () => void;
}

/**
 * Attach a document `mousedown` listener that fires `handler` when the click
 * lands outside every supplied ref. Optionally also closes on Escape.
 *
 * The handler and onEscape callbacks are read through a ref, so passing inline
 * closures does not re-subscribe the listeners on every render -- only the
 * `enabled` flag drives attach/detach.
 */
export function useClickOutside(
  refs: ElementRef | ElementRef[],
  handler: (event: MouseEvent) => void,
  options: UseClickOutsideOptions = {},
): void {
  const { enabled = true, onEscape } = options;

  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const escapeRef = useRef(onEscape);
  escapeRef.current = onEscape;

  const refList = Array.isArray(refs) ? refs : [refs];

  useEffect(() => {
    if (!enabled) return;

    function handleMouseDown(event: MouseEvent) {
      const target = event.target as Node;
      const inside = refList.some((ref) => ref.current?.contains(target));
      if (!inside) handlerRef.current(event);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') escapeRef.current?.();
    }

    document.addEventListener('mousedown', handleMouseDown);
    if (escapeRef.current) document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
    // Spread the individual refs: their identities are stable across renders,
    // so inline array literals at the call site do not re-subscribe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, Boolean(onEscape), ...refList]);
}
