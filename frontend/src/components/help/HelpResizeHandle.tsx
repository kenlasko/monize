'use client';

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useTranslations } from 'next-intl';
import { clamp } from '@/lib/clamp';
import { cn } from '@/lib/utils';
import { HELP_PANEL_KEY_STEP, HELP_PANEL_MIN_WIDTH } from '@/components/help/help-layout';

interface HelpResizeHandleProps {
  /** The id of the panel the handle resizes. */
  controls: string;
  /** The panel's committed width now, in px. */
  width: number;
  /** The widest the panel may be in this window. */
  maxWidth: number;
  /**
   * Shows `width` while a drag is under way. Called at most once per frame and
   * never stored: it moves pixels only.
   */
  onPreview: (width: number) => void;
  /** Keeps `width`: when a drag ends, and for each key press. */
  onCommit: (width: number) => void;
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
 *
 * A drag is cheap by construction. A move only records the pointer; once a
 * frame the width is previewed (one CSS variable written to the root, which the
 * panel, the page's padding and the assistant's launcher all read) and this
 * component re-renders for `aria-valuenow`. Nothing is stored and no other
 * component renders until the pointer is released, when the width is committed
 * once.
 */
export function HelpResizeHandle({
  controls,
  width,
  maxWidth,
  onPreview,
  onCommit,
}: HelpResizeHandleProps) {
  const t = useTranslations('help.panel');
  const drag = useRef<{ startX: number; startWidth: number; latest: number } | null>(null);
  const frame = useRef<number | null>(null);
  const [live, setLive] = useState<number | null>(null);

  const cancelFrame = () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  };
  // A handle unmounted mid-drag (the panel closed) leaves no frame behind.
  useEffect(() => cancelFrame, []);

  const end = () => {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    cancelFrame();
    setLive(null);
    // Skipped when the drag ended where it began; the store ignores an equal
    // value too, but the variable then already shows the committed width.
    onPreview(current.latest);
    if (current.latest !== width) onCommit(current.latest);
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    // No text selection or native drag while the edge is being moved.
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { startX: e.clientX, startWidth: width, latest: width };
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current) return;
    current.latest = clamp(
      Math.round(current.startWidth + (current.startX - e.clientX)),
      HELP_PANEL_MIN_WIDTH,
      maxWidth,
    );
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const latest = drag.current?.latest;
      if (latest === undefined) return;
      onPreview(latest);
      setLive(latest);
    });
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
    onCommit(clamp(next, HELP_PANEL_MIN_WIDTH, maxWidth));
  };

  const shown = live ?? width;
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t('resize')}
      aria-controls={controls}
      aria-valuenow={shown}
      aria-valuetext={t('resizeValue', { width: shown })}
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
        'absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize touch-none select-none outline-none',
        'hover:bg-blue-500/30',
        // A 2px ring that reaches 3:1 against the page and the panel in both
        // themes (blue-600 on white, blue-400 on gray-800).
        'focus-visible:ring-2 focus-visible:ring-blue-600 dark:focus-visible:ring-blue-400',
        live !== null && 'bg-blue-500/40',
      )}
    />
  );
}
