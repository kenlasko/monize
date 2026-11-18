'use client';

import { useEffect, useState } from 'react';

/** The app header's height before it is laid out. */
const HEADER_HEIGHT_PX = 64;

/**
 * Whether the element this ref lands on has scrolled wholly up behind the app
 * header. One still below the fold, or not yet laid out, has not. While
 * `enabled` is false nothing is observed and the answer is `false`.
 *
 * Returns a callback ref, because the element can mount after the page does.
 */
export function useScrolledPast<T extends Element>(
  enabled = true,
): [(node: T | null) => void, boolean] {
  const [node, setNode] = useState<T | null>(null);
  const [past, setPast] = useState(false);

  // Off and on again starts from "not past", never a stale answer.
  const [wasEnabled, setWasEnabled] = useState(enabled);
  if (wasEnabled !== enabled) {
    setWasEnabled(enabled);
    setPast(false);
  }

  useEffect(() => {
    if (!enabled || !node || typeof IntersectionObserver === 'undefined') return;
    // Measured: an installed app's header also covers the status bar.
    const headerHeight =
      document.querySelector('header')?.offsetHeight || HEADER_HEIGHT_PX;
    const observer = new IntersectionObserver(
      ([entry]) => {
        setPast(!entry.isIntersecting && entry.boundingClientRect.top < headerHeight);
      },
      { rootMargin: `-${headerHeight}px 0px 0px 0px` },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [enabled, node]);

  return [setNode, enabled && past];
}
