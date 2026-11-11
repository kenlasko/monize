'use client';

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { useIsLgUp } from '@/hooks/useIsMobile';
import type { DragAxis, DropPosition } from '@/hooks/useDragReorder';
import { WIDGET_WIDTHS, type WidgetWidth } from '@/components/dashboard/dashboard-layout';

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

/** Distance from y to the band [top, bottom]: 0 inside it. */
function bandDistance(top: number, bottom: number, y: number): number {
  return Math.max(top - y, 0, y - bottom);
}

/**
 * The rows of a row-flowing grid: runs of consecutive items whose vertical
 * bands overlap, each with the band they span and the index of its first
 * item. Flow order puts a row's items next to each other.
 */
function rowsOf(rects: readonly Box[]): { start: number; end: number; top: number; bottom: number }[] {
  const rows: { start: number; end: number; top: number; bottom: number }[] = [];
  rects.forEach((r, i) => {
    const row = rows.at(-1);
    if (row && r.top < row.bottom && r.bottom > row.top) {
      rows[rows.length - 1] = { ...row, end: i + 1, top: Math.min(row.top, r.top), bottom: Math.max(row.bottom, r.bottom) };
    } else {
      rows.push({ start: i, end: i + 1, top: r.top, bottom: r.bottom });
    }
  });
  return rows;
}

/**
 * The insertion gap for a pointer at (x, y) over item rectangles in flow
 * order: gap g is between item g-1 and item g, as in `useDragReorder`. Null
 * when there are no items.
 *
 * In rows (axis x) the row comes first: the one whose band holds y, else the
 * nearest. Within it the gap is before the first item whose centre is right
 * of x, or after the row's last item. Choosing by straight-line distance
 * instead lets a row below win in the empty end of a short row.
 *
 * In one column (axis y) the item under the pointer, or the nearest, gives
 * the gap before or after it by which vertical half the pointer is in.
 */
export function gapAt(rects: readonly Box[], x: number, y: number, axis: DragAxis): number | null {
  if (rects.length === 0) return null;
  if (axis === 'x') {
    const rows = rowsOf(rects);
    const row = rows.reduce((best, r) =>
      bandDistance(r.top, r.bottom, y) < bandDistance(best.top, best.bottom, y) ? r : best,
    );
    for (let i = row.start; i < row.end; i += 1) {
      if ((rects[i].left + rects[i].right) / 2 > x) return i;
    }
    return row.end;
  }
  let nearest = 0;
  let nearestDistance = Infinity;
  rects.forEach((r, i) => {
    const dx = Math.max(r.left - x, 0, x - r.right);
    const dy = bandDistance(r.top, r.bottom, y);
    const distance = dx * dx + dy * dy;
    if (distance < nearestDistance) {
      nearest = i;
      nearestDistance = distance;
    }
  });
  const r = rects[nearest];
  return y < (r.top + r.bottom) / 2 ? nearest : nearest + 1;
}

/**
 * How far to scroll this frame for a pointer at viewport height y: negative
 * is up, 0 is not at all. Shared with the resize grip, so both drags scroll
 * the page the same way.
 */
export function scrollStepAt(y: number): number {
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

/** A row's empty end drawn as a slot (`data-gap-index`, `data-gap-width`), and where it is. */
interface SlotBox {
  index: number;
  width: WidgetWidth;
  box: Box;
}

function readSlots(container: HTMLElement | null): SlotBox[] {
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLElement>(':scope > [data-gap-index]')).flatMap((el) => {
    const index = Number(el.dataset.gapIndex);
    const width = el.dataset.gapWidth as WidgetWidth;
    if (!Number.isInteger(index) || !WIDGET_WIDTHS.includes(width)) return [];
    return [{ index, width, box: el.getBoundingClientRect() }];
  });
}

const contains = (b: Box, x: number, y: number) => x >= b.left && x <= b.right && y >= b.top && y <= b.bottom;

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
  /** Whether the widget at `from` can be as narrow as a slot of `width`. Without it no slot is a target. */
  fitsSlot?: (from: number, width: WidgetWidth) => boolean;
  /** A drop on a slot that takes the widget: the gap before `layout[gapIndex]`, `width` wide. */
  onSlotDrop?: (from: number, gapIndex: number, width: WidgetWidth) => void;
}

interface Session {
  from: number;
  x0: number;
  y0: number;
  dx: number;
  dy: number;
  active: boolean;
  gap: number | null;
  slot: number | null;
}

interface DragState {
  from: number;
  gap: number | null;
  /** The gap index of the slot under the pointer that takes the widget; it replaces the line. */
  slot: number | null;
  active: boolean;
}

/**
 * Pointer reorder over the dashboard grid's items, driven by each item's
 * `DragHandle` (design 10.1). The page never reflows during a drag: the
 * rectangles are read afresh on every frame that hit-tests the pointer (a
 * move, a scroll, a resize, a change of flow axis) and on release, so a
 * widget loading or a row growing mid-drag is seen; only a change of gap
 * renders.
 * The chip is moved by writing its transform directly, so following the
 * pointer re-renders nothing. Release moves once; Escape or a cancelled
 * pointer moves nothing.
 */
export function useGridReorder({ containerRef, count, enabled, onMove, fitsSlot, onSlotDrop }: GridReorderOptions) {
  // The grid flows in rows from lg up, in one column below.
  const axis: DragAxis = useIsLgUp() ? 'x' : 'y';
  // Read live by the frame and the release: a rotation across lg mid-drag changes the flow.
  const axisRef = useRef(axis);
  const [drag, setDrag] = useState<DragState | null>(null);
  const session = useRef<Session | null>(null);
  const press = useRef<{ x: number; y: number } | null>(null);
  const frame = useRef<number | null>(null);
  const chip = useRef<HTMLElement | null>(null);
  // Read by the frame, which is not re-created per render.
  const fitsSlotRef = useRef(fitsSlot);
  useEffect(() => {
    fitsSlotRef.current = fitsSlot;
  });

  /**
   * The slot under (x, y) that takes the widget at `from`, if any. Slots come
   * first: a slot the widget cannot be that narrow for is not a target, and
   * the row-band test below decides as if it were empty grid. The end of the
   * dragged widget's own row is never one: moving there changes nothing.
   */
  const slotAt = useCallback(
    (from: number, x: number, y: number): SlotBox | null => {
      const fits = fitsSlotRef.current;
      if (!fits || axisRef.current !== 'x') return null;
      return (
        readSlots(containerRef.current).find(
          (s) => s.index !== from + 1 && contains(s.box, x, y) && fits(from, s.width),
        ) ?? null
      );
    },
    [containerRef],
  );

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
        // Keep scrolling while a still pointer stays at the edge.
        frame.current = requestAnimationFrame(tick);
      }
      placeChip(chip.current, x, y);
      // About twenty reads a frame, after any scroll, so nothing is tested against a stale layout.
      const slot = slotAt(s.from, x, y)?.index ?? null;
      const gap = slot === null ? gapAt(readRects(containerRef.current), x, y, axisRef.current) : null;
      if (gap !== s.gap || slot !== s.slot) {
        s.gap = gap;
        s.slot = slot;
        setDrag({ from: s.from, gap, slot, active: true });
      }
    },
    [containerRef, slotAt],
  );

  const schedule = useCallback(() => {
    if (session.current?.active && frame.current === null) frame.current = requestAnimationFrame(tick);
  }, [tick]);

  // Only a real change of axis takes the gap again; `schedule` changes with the caller's ref.
  useEffect(() => {
    if (axisRef.current === axis) return;
    axisRef.current = axis;
    schedule();
  }, [axis, schedule]);

  // A scroll the reader makes (wheel, trackpad) or a resized window moves the
  // items under a still pointer: hit-test again on the next frame.
  useEffect(() => {
    if (!dragging) return;
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
    };
  }, [dragging, schedule]);

  const grip = (index: number): GridReorderGrip => ({
    onPress: (x, y) => {
      press.current = { x, y };
    },
    onDragStart: () => {
      const at = press.current;
      if (!enabled || session.current || !at) return;
      session.current = { from: index, x0: at.x, y0: at.y, dx: 0, dy: 0, active: false, gap: null, slot: null };
      setDrag({ from: index, gap: null, slot: null, active: false });
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
        setDrag({ from: s.from, gap: s.gap, slot: s.slot, active: true });
      }
      schedule();
    },
    onDragEnd: (dx, dy) => {
      const s = session.current;
      if (!s || s.from !== index) return;
      const x = s.x0 + dx;
      const y = s.y0 + dy;
      const slot = s.active ? slotAt(s.from, x, y) : null;
      const gap = s.active && !slot ? gapAt(readRects(containerRef.current), x, y, axisRef.current) : null;
      cancel();
      if (slot) {
        onSlotDrop?.(s.from, slot.index, slot.width);
        return;
      }
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

  return {
    axis,
    draggingIndex: active ? active.from : null,
    /** The gap index of the slot that would take the dragged widget, to highlight; null when none. */
    slotTarget: active ? active.slot : null,
    dropIndicator,
    chipRef,
    grip,
  };
}

export type GridReorder = ReturnType<typeof useGridReorder>;
