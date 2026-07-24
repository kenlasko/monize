import type { TourPlacement } from './types';

export interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export interface TooltipPosition {
  top: number;
  left: number;
  /** The placement actually used after auto-resolution and flipping. */
  placement: Exclude<TourPlacement, 'auto'>;
}

/** Gap between the anchor and the tooltip, and the min margin from the viewport edge. */
const GAP = 12;
const EDGE_MARGIN = 8;

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

/**
 * Pure tooltip placement. Mirrors CalendarPopover's flip/clamp approach: prefer
 * the requested side, flip to the opposite side when there is not enough room,
 * and clamp the result inside the viewport so the card never leaves the screen.
 *
 * `auto` resolves to `bottom` (the most predictable default for a walkthrough)
 * and flips to `top` near the page bottom.
 */
export function computeTooltipPosition(
  anchor: Rect,
  tooltip: Size,
  viewport: Viewport,
  placement: TourPlacement = 'auto',
): TooltipPosition {
  const resolved: Exclude<TourPlacement, 'auto'> =
    placement === 'auto' ? 'bottom' : placement;

  const spaceBelow = viewport.height - (anchor.top + anchor.height);
  const spaceAbove = anchor.top;
  const spaceRight = viewport.width - (anchor.left + anchor.width);
  const spaceLeft = anchor.left;

  let side = resolved;

  // Flip when the preferred side lacks room and the opposite side has more.
  if (side === 'bottom' && spaceBelow < tooltip.height + GAP && spaceAbove > spaceBelow) {
    side = 'top';
  } else if (side === 'top' && spaceAbove < tooltip.height + GAP && spaceBelow > spaceAbove) {
    side = 'bottom';
  } else if (side === 'right' && spaceRight < tooltip.width + GAP && spaceLeft > spaceRight) {
    side = 'left';
  } else if (side === 'left' && spaceLeft < tooltip.width + GAP && spaceRight > spaceLeft) {
    side = 'right';
  }

  let top: number;
  let left: number;

  if (side === 'top' || side === 'bottom') {
    top =
      side === 'bottom'
        ? anchor.top + anchor.height + GAP
        : anchor.top - tooltip.height - GAP;
    // Centre horizontally on the anchor, then clamp inside the viewport.
    left = anchor.left + anchor.width / 2 - tooltip.width / 2;
  } else {
    left = side === 'right' ? anchor.left + anchor.width + GAP : anchor.left - tooltip.width - GAP;
    // Centre vertically on the anchor, then clamp.
    top = anchor.top + anchor.height / 2 - tooltip.height / 2;
  }

  left = clamp(left, EDGE_MARGIN, viewport.width - tooltip.width - EDGE_MARGIN);
  top = clamp(top, EDGE_MARGIN, viewport.height - tooltip.height - EDGE_MARGIN);

  return { top, left, placement: side };
}

/** Inflate an anchor rect by `padding` on every side, clamped to non-negative. */
export function inflateRect(rect: Rect, padding: number): Rect {
  return {
    top: rect.top - padding,
    left: rect.left - padding,
    width: rect.width + padding * 2,
    height: rect.height + padding * 2,
  };
}
