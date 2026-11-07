import { clamp } from '@/lib/clamp';

/** Width the docked help panel opens at, in px, until the reader resizes it. */
export const HELP_PANEL_DEFAULT_WIDTH = 420;
/** Narrowest the docked panel can be dragged or keyed to. */
export const HELP_PANEL_MIN_WIDTH = 320;
/** Widest the docked panel gets, however wide the window is. */
export const HELP_PANEL_MAX_WIDTH = 960;
/** The widest share of the window the panel may take, so the page keeps the rest. */
export const HELP_PANEL_MAX_VIEWPORT_SHARE = 0.7;
/** What one arrow key press on the resize handle moves the edge by. */
export const HELP_PANEL_KEY_STEP = 24;

/**
 * The widest the panel may be in a window `viewportWidth` px across: 70% of it,
 * at most 960, and never below the minimum (a window so narrow that 70% is under
 * 320 still gets the 320 the panel needs to be readable).
 */
export function helpPanelMaxWidth(viewportWidth: number): number {
  return clamp(
    Math.floor(viewportWidth * HELP_PANEL_MAX_VIEWPORT_SHARE),
    HELP_PANEL_MIN_WIDTH,
    HELP_PANEL_MAX_WIDTH,
  );
}

/**
 * `width` held to the panel's bounds in a window `viewportWidth` px across. A
 * value that is not a finite number is the default, so a hand-edited storage
 * entry cannot leave the panel without a width.
 */
export function clampHelpPanelWidth(width: number, viewportWidth: number): number {
  const wanted = Number.isFinite(width) ? Math.round(width) : HELP_PANEL_DEFAULT_WIDTH;
  return clamp(wanted, HELP_PANEL_MIN_WIDTH, helpPanelMaxWidth(viewportWidth));
}
