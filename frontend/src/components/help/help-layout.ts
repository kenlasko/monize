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
/** Tailwind's `xl`: from here the shell pushes the page aside instead of leaving the panel over it. */
export const HELP_PANEL_BESIDE_BREAKPOINT = 1280;
/**
 * The width the page keeps beside a docked panel on `xl`. The page's own `xl:`
 * layouts still apply at that width, so they need room to lay out.
 */
export const HELP_PAGE_MIN_WIDTH = 640;
/** The CSS variable on the root that carries the docked panel's width to everything beside it. */
export const HELP_PANEL_WIDTH_VAR = '--help-panel-width';

/**
 * The widest the panel may be in a window `viewportWidth` px across (the
 * document's width, scrollbar excluded): 70% of it, at most 960, and never
 * below the minimum (a window so narrow that 70% is under 320 still gets the
 * 320 the panel needs to be readable). `besidePage` is the `xl` case, where the
 * page is pushed aside and keeps at least 640 px of its own.
 */
export function helpPanelMaxWidth(viewportWidth: number, besidePage = false): number {
  const cap = besidePage
    ? Math.min(
        Math.floor(viewportWidth * HELP_PANEL_MAX_VIEWPORT_SHARE),
        viewportWidth - HELP_PAGE_MIN_WIDTH,
      )
    : Math.floor(viewportWidth * HELP_PANEL_MAX_VIEWPORT_SHARE);
  return clamp(cap, HELP_PANEL_MIN_WIDTH, HELP_PANEL_MAX_WIDTH);
}

/**
 * `width` held to the minimum and `maxWidth`. A value that is not a finite
 * number is the default, so a hand-edited storage entry cannot leave the panel
 * without a width.
 */
export function clampHelpPanelWidth(width: number, maxWidth: number): number {
  const wanted = Number.isFinite(width) ? Math.round(width) : HELP_PANEL_DEFAULT_WIDTH;
  return clamp(wanted, HELP_PANEL_MIN_WIDTH, maxWidth);
}
