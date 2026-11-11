'use client';

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import {
  HEIGHT_FLOORS_PX,
  WIDGET_HEIGHTS,
  WIDTH_SPANS,
  widthsOfferedFor,
  type DashboardLayoutItem,
  type WidgetHeight,
  type WidgetWidth,
} from './dashboard-layout';
import { useWidgetName } from './widget-glyphs';

const COLUMNS = 12;
/**
 * Pointer travel along one axis, in px, that it takes to change that axis
 * (DragHandle's CLICK_SLOP, which it does not export). Below it the axis keeps
 * its preset: the item's real height comes from its content and its row's
 * stretch, so reading a preset off a still pointer would change it.
 */
const AXIS_SLOP = 4;
/** The grid's `gap-6`, used when the computed style gives no number. */
const FALLBACK_GAP = 24;
/** Auto has no floor to draw, so its outline is this tall rather than a line. */
const AUTO_PREVIEW_HEIGHT = 64;

type Size = { width?: WidgetWidth; height?: WidgetHeight };

interface Drag {
  left: number;
  top: number;
  /** The item's real height at the press, drawn while the height is kept. */
  height: number;
  col: number;
  gap: number;
  /** Where the press landed. */
  x0: number;
  y0: number;
  x: number;
  y: number;
}

interface Target {
  width: WidgetWidth;
  height: WidgetHeight;
  /** Viewport box of the outline. */
  box: { left: number; top: number; width: number; height: number };
}

function nearest<T>(options: readonly T[], at: (o: T) => number, to: number): T {
  return options.reduce((best, o) => (Math.abs(at(o) - to) < Math.abs(at(best) - to) ? o : best));
}

/**
 * The presets a pointer at (x, y) points at: the offered width whose right
 * edge (left + span columns + the gaps between them) is nearest x, and the
 * height whose floor is nearest the pointer's depth below the item's top.
 * An axis the pointer has not moved along since the press keeps `current`.
 */
function targetAt(d: Drag, offered: readonly WidgetWidth[], current: Required<Size>): Target {
  const edge = (w: WidgetWidth) => d.left + WIDTH_SPANS[w] * d.col + (WIDTH_SPANS[w] - 1) * d.gap;
  const movedX = Math.abs(d.x - d.x0) > AXIS_SLOP;
  const movedY = Math.abs(d.y - d.y0) > AXIS_SLOP;
  const width = movedX ? nearest(offered, edge, d.x) : current.width;
  const height = movedY ? nearest(WIDGET_HEIGHTS, (h) => HEIGHT_FLOORS_PX[h], d.y - d.top) : current.height;
  return {
    width,
    height,
    box: {
      left: d.left,
      top: d.top,
      width: edge(width) - d.left,
      height: movedY ? HEIGHT_FLOORS_PX[height] || AUTO_PREVIEW_HEIGHT : d.height,
    },
  };
}

interface WidgetResizeGripProps {
  id: DashboardLayoutItem['id'];
  width: WidgetWidth;
  height: WidgetHeight;
  /** One call per release or key press, with only what changed. */
  onResize: (id: DashboardLayoutItem['id'], size: Size) => void;
}

/**
 * The corner grip on a widget's edit overlay (lg and up). A drag snaps to the
 * width and height presets and shows the result as a dashed outline; the card
 * changes once, on release. Escape or a cancelled pointer changes nothing.
 * The arrow keys step one preset at a time. Pointer capture keeps the drag
 * going outside the grip, as in HelpResizeHandle, and the outline updates at
 * most once per frame.
 */
export function WidgetResizeGrip({ id, width, height, onResize }: WidgetResizeGripProps) {
  const t = useTranslations('dashboard');
  const name = useWidgetName()(id);
  const drag = useRef<Drag | null>(null);
  const frame = useRef<number | null>(null);
  const [target, setTarget] = useState<Target | null>(null);
  const offered = widthsOfferedFor(id);
  const current = { width, height };

  const cancelFrame = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  }, []);
  useEffect(() => cancelFrame, [cancelFrame]);

  const cancel = useCallback(() => {
    drag.current = null;
    cancelFrame();
    setTarget(null);
  }, [cancelFrame]);

  // Escape cancels the drag and only the drag: window capture runs before
  // edit mode's Escape listener, which skips a prevented event.
  const dragging = target !== null;
  useEffect(() => {
    if (!dragging) return;
    const onKeyDown = (event: KeyboardEvent | globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [dragging, cancel]);

  const onPointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    const item = e.currentTarget.closest<HTMLElement>('[data-widget-id]');
    const grid = item?.parentElement;
    if (!item || !grid) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const box = item.getBoundingClientRect();
    const gap = parseFloat(getComputedStyle(grid).columnGap) || FALLBACK_GAP;
    const col = (grid.getBoundingClientRect().width - (COLUMNS - 1) * gap) / COLUMNS;
    drag.current = {
      left: box.left,
      top: box.top,
      height: box.height,
      col,
      gap,
      x0: e.clientX,
      y0: e.clientY,
      x: e.clientX,
      y: e.clientY,
    };
    setTarget(targetAt(drag.current, offered, current));
  };

  const onPointerMove = (e: PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d) return;
    d.x = e.clientX;
    d.y = e.clientY;
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      if (drag.current) setTarget(targetAt(drag.current, offered, current));
    });
  };

  const onPointerUp = (e: PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d) return;
    d.x = e.clientX;
    d.y = e.clientY;
    const end = targetAt(d, offered, current);
    cancel();
    const size: Size = {};
    if (end.width !== width) size.width = end.width;
    if (end.height !== height) size.height = end.height;
    if (size.width || size.height) onResize(id, size);
  };

  const step = <T,>(list: readonly T[], current: T, by: number): T | undefined => list[list.indexOf(current) + by];

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (drag.current) return;
    let size: Size | undefined;
    switch (e.key) {
      case 'ArrowLeft': {
        const w = step(offered, width, -1);
        size = w && { width: w };
        break;
      }
      case 'ArrowRight': {
        const w = step(offered, width, 1);
        size = w && { width: w };
        break;
      }
      case 'ArrowUp': {
        const h = step(WIDGET_HEIGHTS, height, -1);
        size = h && { height: h };
        break;
      }
      case 'ArrowDown': {
        const h = step(WIDGET_HEIGHTS, height, 1);
        size = h && { height: h };
        break;
      }
      default:
        return;
    }
    e.preventDefault();
    if (size) onResize(id, size);
  };

  return (
    <>
      <button
        type="button"
        data-edit-slot="resize"
        aria-label={t('edit.resize', { name })}
        title={t('edit.resizeHint', { name })}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={cancel}
        onLostPointerCapture={cancel}
        onKeyDown={onKeyDown}
        className={cn(
          'pointer-events-auto absolute bottom-1 right-1 flex h-5 w-5 cursor-nwse-resize touch-none select-none items-end justify-end rounded-sm text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100',
          'transition-colors motion-reduce:transition-none focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500',
        )}
      >
        <svg viewBox="0 0 10 10" className="h-3 w-3" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <path d="M9 3L3 9M9 7L7 9" />
        </svg>
      </button>
      {target && (
        <div
          aria-hidden="true"
          data-testid="widget-resize-preview"
          className="pointer-events-none fixed z-50 rounded-lg border-2 border-dashed border-blue-600 bg-blue-500/10 dark:border-blue-400"
          style={target.box}
        />
      )}
    </>
  );
}
