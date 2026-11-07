'use client';

import { useLayoutEffect, useSyncExternalStore } from 'react';
import {
  HELP_PANEL_BESIDE_BREAKPOINT,
  HELP_PANEL_WIDTH_VAR,
  clampHelpPanelWidth,
  helpPanelMaxWidth,
} from '@/components/help/help-layout';
import { useHelpWidthStore } from '@/store/helpWidthStore';

function subscribe(callback: () => void): () => void {
  window.addEventListener('resize', callback);
  return () => window.removeEventListener('resize', callback);
}

/**
 * The widest the panel may be in this window. A number rather than the window's
 * width, so the store snapshot is a primitive and a resize that changes nothing
 * the panel cares about re-renders nothing.
 *
 * The width is the document's, scrollbar excluded (the panel is
 * `position: fixed` against it); a document with no layout (clientWidth 0, as
 * in jsdom) falls back to the window's. Whether the page is pushed aside is the
 * `xl` media query, which counts the scrollbar, so it reads `innerWidth`.
 */
function getMaxWidth(): number {
  const viewport = document.documentElement.clientWidth || window.innerWidth;
  return helpPanelMaxWidth(viewport, window.innerWidth >= HELP_PANEL_BESIDE_BREAKPOINT);
}

/** Rendered on the server, where no window exists; the panel is client-only. */
function getServerMaxWidth(): number {
  return helpPanelMaxWidth(Number.MAX_SAFE_INTEGER);
}

/**
 * The bounds the docked panel works within, and the width it has: what the
 * reader chose, held to what the window allows. The window can shrink after a
 * width was chosen, so the stored value is clamped again on every read and
 * never written back; widening the window again returns the panel to the width
 * the reader chose.
 *
 * Called only by the panel, which is mounted only while help is open: a page
 * that merely carries a `?` icon never measures the window or listens for a
 * resize for this.
 */
export function useHelpPanelWidth(): { width: number; maxWidth: number } {
  const stored = useHelpWidthStore((s) => s.width);
  const maxWidth = useSyncExternalStore(subscribe, getMaxWidth, getServerMaxWidth);
  return { width: clampHelpPanelWidth(stored, maxWidth), maxWidth };
}

/** Writes the panel's width to the root, for the panel, the shell and the assistant to read. */
export function setHelpWidthVar(width: number): void {
  document.documentElement.style.setProperty(HELP_PANEL_WIDTH_VAR, `${width}px`);
}

/**
 * Publishes `width` as the root's `--help-panel-width` while `active` (the
 * panel is docked), and removes it after. The panel's own width, the shell's
 * `xl:pr-(--help-panel-width)` and the assistant launcher's offset all read the
 * one variable, so a drag moves all three by writing one property, with no
 * React render between the pointer and the pixels. Set in a layout effect so it
 * is in place before the first paint of the panel.
 */
export function useHelpWidthVar(width: number, active: boolean): void {
  useLayoutEffect(() => {
    if (!active) return;
    setHelpWidthVar(width);
    return () => {
      document.documentElement.style.removeProperty(HELP_PANEL_WIDTH_VAR);
    };
  }, [width, active]);
}
