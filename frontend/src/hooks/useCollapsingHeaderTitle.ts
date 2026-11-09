'use client';

import { createContext, useEffect, useState } from 'react';
import {
  useMobileChromeStore,
  type CollapsedHeaderTitle,
} from '@/store/mobileChromeStore';

/** The app header's height before it is laid out. */
const HEADER_HEIGHT_PX = 64;

/**
 * Whether a `PageHeader` below may collapse its title. The dashboard hero turns
 * it off around the greeting while its own headline figure collapses instead.
 */
export const CollapsingTitleContext = createContext(true);

/**
 * Hands `content` to the app header once the element this ref lands on has
 * scrolled up behind it, and takes it back when the element returns or the
 * page goes. Only a title that left through the top counts: one still below
 * the fold, as on a page loading long content above it, has not collapsed.
 *
 * Returns a callback ref, because a headline can mount after its page does.
 */
export function useCollapsingHeaderTitle<T extends Element>(
  content: CollapsedHeaderTitle | null,
): (node: T | null) => void {
  const [node, setNode] = useState<T | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  const enabled = content !== null;

  useEffect(() => {
    if (!enabled || !node || typeof IntersectionObserver === 'undefined') return;
    // Measured: an installed app's header also covers the status bar.
    const headerHeight =
      document.querySelector('header')?.offsetHeight || HEADER_HEIGHT_PX;
    const observer = new IntersectionObserver(
      ([entry]) => {
        setCollapsed(!entry.isIntersecting && entry.boundingClientRect.top < headerHeight);
      },
      { rootMargin: `-${headerHeight}px 0px 0px 0px` },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [enabled, node]);

  // Named one by one: the caller builds a new object on every render, and the
  // header should only hear about a change in what it draws.
  const title = content?.title;
  const figure = content?.figure;
  const figurePartial = content?.figurePartial;
  const changeText = content?.change?.text;
  const changeUp = content?.change?.up;

  useEffect(() => {
    if (!collapsed || title === undefined) return;
    const { setCollapsedTitle } = useMobileChromeStore.getState();
    setCollapsedTitle({
      title,
      figure,
      figurePartial,
      change:
        changeText !== undefined && changeUp !== undefined
          ? { text: changeText, up: changeUp }
          : undefined,
    });
    return () => setCollapsedTitle(null);
  }, [collapsed, title, figure, figurePartial, changeText, changeUp]);

  return setNode;
}
