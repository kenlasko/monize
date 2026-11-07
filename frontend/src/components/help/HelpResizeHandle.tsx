'use client';

import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { HELP_PANEL_KEY_STEP, HELP_PANEL_MIN_WIDTH } from '@/components/help/help-layout';

interface HelpResizeHandleProps {
  /** The panel's width now, in px. */
  width: number;
  /** The widest the panel may be in this window. */
  maxWidth: number;
  /** Asks for a width; the owner holds it to the bounds. */
  onResize: (width: number) => void;
}

/**
 * The drag handle on the docked panel's left edge, and a window splitter for
 * the keyboard: a focusable `role="separator"` whose value is the panel's
 * width. The edge being the panel's left one, moving it left (the Left arrow,
 * or a drag towards the page) widens the panel.
 *
 * The drag uses pointer events with capture, so the pointer keeps steering the
 * edge when it leaves the 8px strip, crosses the page or leaves the window, and
 * a touch or a pen works as a mouse does. The width is worked out from where
 * the drag began rather than accumulated from each move, so a dropped event
 * cannot make the edge drift from the pointer.
 */
export function HelpResizeHandle({ width, maxWidth, onResize }: HelpResizeHandleProps) {
  const t = useTranslations('help.panel');
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const end = () => {
    drag.current = null;
    setDragging(false);
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    // No text selection or native drag while the edge is being moved.
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { startX: e.clientX, startWidth: width };
    setDragging(true);
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start) return;
    onResize(start.startWidth + (start.startX - e.clientX));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    let next: number;
    switch (e.key) {
      case 'ArrowLeft':
        next = width + HELP_PANEL_KEY_STEP;
        break;
      case 'ArrowRight':
        next = width - HELP_PANEL_KEY_STEP;
        break;
      case 'Home':
        next = HELP_PANEL_MIN_WIDTH;
        break;
      case 'End':
        next = maxWidth;
        break;
      default:
        return;
    }
    e.preventDefault();
    onResize(next);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t('resize')}
      aria-valuenow={width}
      aria-valuemin={HELP_PANEL_MIN_WIDTH}
      aria-valuemax={maxWidth}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onKeyDown={onKeyDown}
      className={cn(
        'absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize touch-none select-none',
        'hover:bg-blue-500/30 focus-visible:bg-blue-500/40 focus-visible:outline-none',
        dragging && 'bg-blue-500/40',
      )}
    />
  );
}
