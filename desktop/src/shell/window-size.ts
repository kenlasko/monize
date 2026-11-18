/**
 * The main window's first size. The page switches to its phone layout (tab
 * bar, collapsed header) below Tailwind's `xl` breakpoint, 1280 CSS pixels
 * of viewport (`frontend/src/components/layout/MobileTabBar.tsx` is
 * `xl:hidden`), so the window opens with a content area a little wider than
 * that. The size is of the page area (`useContentSize`), not the outer
 * frame, which on Windows is about 16 pixels wider than the page it holds.
 */

/** The frontend's `xl` breakpoint: below it, the page is laid out for phones. */
export const DESKTOP_LAYOUT_MIN_WIDTH = 1280;

/** The page area the window opens with, when the screen has room for it. */
export const DEFAULT_CONTENT_SIZE = { width: 1320, height: 860 } as const;

/** Room the frame takes around the page area: borders, and the title bar. */
const FRAME_ALLOWANCE = { width: 16, height: 40 } as const;

export interface Size {
  readonly width: number;
  readonly height: number;
}

/**
 * The page-area size to open at on a screen whose work area (the screen
 * less the taskbar) is `workArea`: the default, shrunk to fit a smaller
 * screen. On a screen narrower than the breakpoint the phone layout cannot
 * be avoided, and fitting the screen matters more.
 */
export function mainWindowContentSize(workArea: Size): Size {
  return {
    width: Math.max(
      1,
      Math.min(
        DEFAULT_CONTENT_SIZE.width,
        workArea.width - FRAME_ALLOWANCE.width,
      ),
    ),
    height: Math.max(
      1,
      Math.min(
        DEFAULT_CONTENT_SIZE.height,
        workArea.height - FRAME_ALLOWANCE.height,
      ),
    ),
  };
}
