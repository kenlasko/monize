'use client';

import { createPortal } from 'react-dom';
import { inflateRect, type Rect } from '@/lib/tours/positioning';

interface TourSpotlightProps {
  /** The anchor rect to cut out, or null for a centered step (full backdrop). */
  rect: Rect | null;
  /** Interactive steps leave the hole clickable (no blocker over it). */
  interactive: boolean;
  /** Disable the cutout animation for reduced-motion users. */
  reducedMotion: boolean;
}

/** Padding around the anchor inside the spotlight cutout. */
const HOLE_PADDING = 6;

const DIM = 'bg-black/50';

/**
 * The dimming overlay with a cutout around the current anchor. Rendered above
 * the Modal backdrop (z-50) at z-[60]. Four dimming panels frame the hole so
 * the highlighted control stays fully lit; a ring outlines it. Passive steps
 * add a transparent blocker over the hole so the page cannot be clicked
 * mid-explanation; interactive steps omit it so only the anchor is clickable.
 * Clicks on the dimmed area are inert (they neither pass through nor dismiss).
 */
export function TourSpotlight({
  rect,
  interactive,
  reducedMotion,
}: TourSpotlightProps) {
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  const transition = reducedMotion ? '' : 'transition-all duration-200';

  if (!rect) {
    return createPortal(
      <div
        className={`fixed inset-0 z-[60] ${DIM}`}
        onClick={stop}
        aria-hidden="true"
      />,
      document.body,
    );
  }

  const hole = inflateRect(rect, HOLE_PADDING);
  const holeRight = hole.left + hole.width;
  const holeBottom = hole.top + hole.height;

  return createPortal(
    <div className="fixed inset-0 z-[60] pointer-events-none" aria-hidden="true">
      {/* Top */}
      <div
        className={`fixed left-0 top-0 w-full ${DIM} ${transition} pointer-events-auto`}
        style={{ height: Math.max(0, hole.top) }}
        onClick={stop}
      />
      {/* Bottom */}
      <div
        className={`fixed left-0 w-full ${DIM} ${transition} pointer-events-auto`}
        style={{ top: holeBottom, bottom: 0 }}
        onClick={stop}
      />
      {/* Left */}
      <div
        className={`fixed left-0 ${DIM} ${transition} pointer-events-auto`}
        style={{ top: hole.top, height: hole.height, width: Math.max(0, hole.left) }}
        onClick={stop}
      />
      {/* Right */}
      <div
        className={`fixed ${DIM} ${transition} pointer-events-auto`}
        style={{ top: hole.top, height: hole.height, left: holeRight, right: 0 }}
        onClick={stop}
      />
      {/* Ring around the hole */}
      <div
        className={`fixed rounded-md ring-2 ring-blue-500 ${transition}`}
        style={{
          top: hole.top,
          left: hole.left,
          width: hole.width,
          height: hole.height,
        }}
      />
      {/* Passive hole blocker: swallows clicks so the page is inert while the
          engine explains the control. Interactive steps omit this. */}
      {!interactive && (
        <div
          className="fixed pointer-events-auto"
          style={{
            top: hole.top,
            left: hole.left,
            width: hole.width,
            height: hole.height,
          }}
          onClick={stop}
        />
      )}
    </div>,
    document.body,
  );
}
