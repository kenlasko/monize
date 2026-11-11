'use client';

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { useIsLgUp } from '@/hooks/useIsMobile';
import type { DragAxis, DropPosition } from '@/hooks/useDragReorder';

/** Distance from the viewport's top or bottom edge within which a drag scrolls the page. */
export const AUTO_SCROLL_EDGE = 80;
/** The most the page scrolls in one frame, reached at the very edge. */
const MAX_SCROLL_STEP = 20;
/** Pointer travel under which a press on the grip is not yet a drag (DragHandle's CLICK_SLOP). */
const DRAG_SLOP = 4;
/** Where the chip sits from the pointer, so it does not hide what is under it. */
const CHIP_OFFSET = 12;

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * The insertion gap for a pointer at (x, y) over item rectangles in flow
 * order: gap g is between item g-1 and item g, as in `useDragReorder`. The
 * item under the pointer, or the nearest one when the pointer is in a gutter
 * or past the grid, gives the gap before or after it by which half of it the
 * pointer is in along the flow axis. Null when there are no items.
 */
export function gapAt(rects: readonly Box[], x: number, y: number, axis: DragAxis): number | null {
  let nearest = -1;
  let nearestDistance = Infinity;
  rects.forEach((r, i) => {
    const dx = Math.max(r.left - x, 0, x - r.right);
    const dy = Math.max(r.top - y, 0, y - r.bottom);
    const distance = dx * dx + dy * dy;
    if (distance < nearestDistance) {
      nearest = i;
      nearestDistance = distance;
    }
  });
  if (nearest < 0) return null;
  const r = rects[nearest];
  const leading = axis === 'x' ? x < (r.left + r.right) / 2 : y < (r.top + r.bottom) / 2;
  return leading ? nearest : nearest + 1;
}

/** How far to scroll this frame for a pointer at viewport height y: negative is up, 0 is not at all. */
function scrollStepAt(y: number): number {
  const height = window.innerHeight;
  const root = document.scrollingElement ?? document.documentElement;
  const step = (depth: number) =>
    Math.min(MAX_SCROLL_STEP, Math.max(1, Math.ceil((depth / AUTO_SCROLL_EDGE) * MAX_SCROLL_STEP)));
  if (y < AUTO_SCROLL_EDGE && window.scrollY > 0) return -step(AUTO_SCROLL_EDGE - y);
  if (y > height - AUTO_SCROLL_EDGE && window.scrollY + height < root.scrollHeight) {
    return step(y - (height - AUTO_SCROLL_EDGE));
  }
  return 0;
}

function readRects(container: HTMLElement | null): Box[] {
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLElement>(':scope > [data-widget-id]'), (el) =>
    el.getBoundingClientRect(),
  );
}

function placeChip(chip: HTMLElement | null, x: number, y: number) {
  if (chip) chip.style.transform = `translate3d(${x + CHIP_OFFSET}px, ${y + CHIP_OFFSET}px, 0)`;
}

/** What the overlay wires to its grip: the DragHandle's callbacks plus two the wrapper catches. */
export interface GridReorderGrip {
  /** Where the press landed, caught in the capture phase before DragHandle's own handler. */
  onPress: (clientX: number, clientY: number) => void;
  onDragStart: () => void;
  onDragMove: (dx: number, dy: number) => void;
  onDragEnd: (dx: number, dy: number) => void;
  /** A cancelled pointer: DragHandle reports it as an end, so the wrapper catches it first. */
  onCancel: () => void;
  onNudge: (dx: number, dy: number) => void;
}

export type GridReorderVia = 'pointer' | 'keyboard';

interface GridReorderOptions {
  /** The grid whose `[data-widget-id]` children are the items, in flow order. */
  containerRef: RefObject<HTMLElement | null>;
  count: number;
  /** False outside edit mode: a drag under way is dropped and nothing is moved. */
  enabled: boolean;
  /** One move per drop or per arrow key; `via` lets the caller decide where focus goes. */
  onMove: (from: number, to: number, via: GridReorderVia) => void;
}

interface Session {
  from: number;
  axis: DragAxis;
  x0: number;
  y0: number;
  dx: number;
  dy: number;
  rects: Box[];
  active: boolean;
  gap: number | null;
}

interface DragState {
  from: number;
  gap: number | null;
  active: boolean;
}

/**
 * Pointer reorder over the dashboard grid's items, driven by each item's
 * `DragHandle` (design 10.1). The page never reflows during a drag: the
 * rectangles are read on press (and again after any scroll), the pointer
 * is hit-tested against them once a frame, and only a change of gap renders.
 * The chip is moved by writing its transform directly, so following the
 * pointer re-renders nothing. Release moves once; Escape or a cancelled
 * pointer moves nothing.
 */
export function useGridReorder({ containerRef, count, enabled, onMove }: GridReorderOptions) {
  // The grid flows in rows from lg up, in one column below.
  const axis: DragAxis = useIsLgUp() ? 'x' : 'y';
  const [drag, setDrag] = useState<DragState | null>(null);
  const session = useRef<Session | null>(null);
  const press = useRef<{ x: number; y: number } | null>(null);
  const frame = useRef<number | null>(null);
  const chip = useRef<HTMLElement | null>(null);

  // Leaving edit mode mid-drag drops the drag's state during render, and its
  // listener and frame in the effect below.
  const [wasEnabled, setWasEnabled] = useState(enabled);
  if (wasEnabled !== enabled) {
    setWasEnabled(enabled);
    if (!enabled) setDrag(null);
  }

  const teardown = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    session.current = null;
    press.current = null;
  }, []);

  const cancel = useCallback(() => {
    teardown();
    setDrag(null);
  }, [teardown]);

  useEffect(() => {
    if (!enabled) teardown();
  }, [enabled, teardown]);
  useEffect(() => teardown, [teardown]);

  // Escape cancels the drag and only the drag. Window capture runs before
  // edit mode's own Escape listener, which also skips a prevented event.
  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [dragging, cancel]);

  const tick = useCallback(
    function tick() {
      frame.current = null;
      const s = session.current;
      if (!s) return;
      const x = s.x0 + s.dx;
      const y = s.y0 + s.dy;
      const step = scrollStepAt(y);
      if (step !== 0) {
        window.scrollBy(0, step);
        // The items moved under a still pointer; keep scrolling while it stays at the edge.
        s.rects = readRects(containerRef.current);
        frame.current = requestAnimationFrame(tick);
      }
      placeChip(chip.current, x, y);
      const gap = gapAt(s.rects, x, y, s.axis);
      if (gap !== s.gap) {
        s.gap = gap;
        setDrag({ from: s.from, gap, active: true });
      }
    },
    [containerRef],
  );

  // A scroll the reader makes (wheel, trackpad) moves the items under a still
  // pointer too: re-read them, and hit-test again on the next frame, so
  // neither the line nor the drop is decided against where they were.
  useEffect(() => {
    if (!dragging) return;
    const onScroll = () => {
      const s = session.current;
      if (!s) return;
      s.rects = readRects(containerRef.current);
      if (s.active && frame.current === null) frame.current = requestAnimationFrame(tick);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [dragging, containerRef, tick]);

  const grip = (index: number): GridReorderGrip => ({
    onPress: (x, y) => {
      press.current = { x, y };
    },
    onDragStart: () => {
      const at = press.current;
      if (!enabled || session.current || !at) return;
      session.current = {
        from: index,
        axis,
        x0: at.x,
        y0: at.y,
        dx: 0,
        dy: 0,
        rects: readRects(containerRef.current),
        active: false,
        gap: null,
      };
      setDrag({ from: index, gap: null, active: false });
    },
    onDragMove: (dx, dy) => {
      const s = session.current;
      if (!s || s.from !== index) return;
      s.dx = dx;
      s.dy = dy;
      if (!s.active) {
        // A press that has not travelled yet is still a click: no chip, no dimming.
        if (Math.abs(dx) + Math.abs(dy) < DRAG_SLOP) return;
        s.active = true;
        setDrag({ from: s.from, gap: s.gap, active: true });
      }
      if (frame.current === null) frame.current = requestAnimationFrame(tick);
    },
    onDragEnd: (dx, dy) => {
      const s = session.current;
      if (!s || s.from !== index) return;
      const gap = s.active ? gapAt(s.rects, s.x0 + dx, s.y0 + dy, s.axis) : null;
      cancel();
      if (gap === null) return;
      // The gaps either side of the dragged item leave it where it is.
      const to = gap > s.from ? gap - 1 : gap;
      if (to !== s.from) onMove(s.from, to, 'pointer');
    },
    onCancel: cancel,
    onNudge: (dx, dy) => {
      if (!enabled || session.current) return;
      const to = dx < 0 || dy < 0 ? index - 1 : index + 1;
      if (to < 0 || to >= count) return;
      onMove(index, to, 'keyboard');
    },
  });

  const active = enabled && drag?.active ? drag : null;

  /** The insertion line for item `index`: on the item the gap precedes, or after the last. */
  const dropIndicator = (index: number): DropPosition | null => {
    if (!active || active.gap === null) return null;
    if (active.gap === active.from || active.gap === active.from + 1) return null;
    if (active.gap === index) return 'before';
    if (index === count - 1 && active.gap === count) return 'after';
    return null;
  };

  const chipRef = useCallback((el: HTMLElement | null) => {
    chip.current = el;
    const s = session.current;
    if (el && s) placeChip(el, s.x0 + s.dx, s.y0 + s.dy);
  }, []);

  return { axis, draggingIndex: active ? active.from : null, dropIndicator, chipRef, grip };
}

export type GridReorder = ReturnType<typeof useGridReorder>;
