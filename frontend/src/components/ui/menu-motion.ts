/**
 * How a dropdown menu or popover panel arrives: it fades in and grows from
 * 95% out of the corner it hangs from, over 150ms, through the CSS
 * `@starting-style` (`starting:`) variant -- the same mechanism `Modal` uses
 * for its panel, so a menu needs no open/closing state of its own. A panel
 * that is conditionally rendered gets the entrance on every open; there is no
 * exit animation, the panel unmounts on close.
 *
 * Pair it with the origin of the edge the panel is anchored to, or it grows
 * out of its own centre and appears to drift: `MENU_ORIGIN_LEFT` for a panel
 * on `left-0`, `MENU_ORIGIN_RIGHT` for one on `right-0`.
 */
export const MENU_ENTER_CLASS =
  'transition-[opacity,scale] duration-150 ease-out opacity-100 scale-100 starting:opacity-0 starting:scale-95 motion-reduce:transition-none';

export const MENU_ORIGIN_LEFT = 'origin-top-left';
export const MENU_ORIGIN_RIGHT = 'origin-top-right';
