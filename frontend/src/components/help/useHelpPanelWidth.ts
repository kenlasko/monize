'use client';

import { useSyncExternalStore } from 'react';
import { clampHelpPanelWidth } from '@/components/help/help-layout';
import { useHelpWidthStore } from '@/store/helpWidthStore';

function subscribe(callback: () => void): () => void {
  window.addEventListener('resize', callback);
  return () => window.removeEventListener('resize', callback);
}

function getViewportWidth(): number {
  // The layout viewport, scrollbar excluded: the panel is `position: fixed`
  // against it, so `innerWidth` would count room the panel cannot use. A
  // document that has no layout (clientWidth 0) falls back to the window's.
  return document.documentElement.clientWidth || window.innerWidth;
}

/** Rendered on the server, where no window exists; the clamp is settled on the client. */
function getServerViewportWidth(): number {
  return Number.MAX_SAFE_INTEGER;
}

/** The document's width, as React state, so a bound that depends on it follows a resize. */
export function useViewportWidth(): number {
  return useSyncExternalStore(subscribe, getViewportWidth, getServerViewportWidth);
}

/**
 * The width the docked help panel has right now: what the reader chose, held to
 * what the window allows. The window can shrink after a width was chosen, so the
 * stored value is clamped again on every read and never written back; widening
 * the window again returns the panel to the width the reader chose.
 *
 * The one place the width is worked out. The panel, the shell that makes room
 * beside it and the assistant's launcher all read it here.
 */
export function useHelpPanelWidth(): number {
  const stored = useHelpWidthStore((s) => s.width);
  return clampHelpPanelWidth(stored, useViewportWidth());
}
