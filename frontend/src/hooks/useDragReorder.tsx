import { useState, DragEvent } from 'react';

/** Which side of a row/tile the insertion gap sits on, in flow order. */
export type DropPosition = 'before' | 'after';

export type DragAxis = 'x' | 'y';

/**
 * Shared state for HTML5 drag-to-reorder lists (Favourite Accounts widget,
 * investment report column chooser).
 *
 * Rows spread `rowProps(index)`. While dragging, the hook tracks the
 * insertion gap under the pointer (gap g = "between item g-1 and item g",
 * derived from which half of the hovered item the pointer is in), so the
 * trailing half of one item and the leading half of the next resolve to the
 * SAME gap and render one identical insertion line at that boundary. Gaps
 * that would not move the dragged item show no indicator. On drop,
 * `moveItem(from, to)` receives the source index and the insertion index
 * within the post-removal list.
 *
 * `axis` is the flow direction of the list: 'y' for vertical lists (the
 * pointer's height inside a row picks the gap), 'x' for grids flowing left
 * to right (the pointer's horizontal position inside a tile picks it).
 */
export function useDragReorder(
  moveItem: (from: number, to: number) => void,
  axis: DragAxis = 'y',
) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [gapIndex, setGapIndex] = useState<number | null>(null);

  const reset = () => {
    setDragIndex(null);
    setGapIndex(null);
  };

  const rowProps = (index: number) => ({
    draggable: true,
    onDragStart: () => setDragIndex(index),
    onDragOver: (e: DragEvent) => {
      e.preventDefault();
      const rect = e.currentTarget.getBoundingClientRect();
      const inLeadingHalf =
        axis === 'y'
          ? e.clientY < rect.top + rect.height / 2
          : e.clientX < rect.left + rect.width / 2;
      const gap = inLeadingHalf ? index : index + 1;
      if (gapIndex !== gap) setGapIndex(gap);
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      const from = dragIndex;
      const gap = gapIndex;
      reset();
      if (from === null || gap === null) return;
      const to = gap > from ? gap - 1 : gap; // account for the dragged item's removal
      if (to === from) return;
      moveItem(from, to);
    },
    onDragEnd: reset,
  });

  /**
   * The insertion line for the hovered gap, drawn once: on the leading edge
   * of the item the gap precedes, or on the trailing edge of the last item
   * for the end-of-list gap. `itemCount` is the rendered list's length.
   */
  const dropIndicator = (index: number, itemCount: number): DropPosition | null => {
    if (dragIndex === null || gapIndex === null) return null;
    // Dropping into the gap on either side of the dragged item is a no-op.
    if (gapIndex === dragIndex || gapIndex === dragIndex + 1) return null;
    if (gapIndex === index) return 'before';
    if (index === itemCount - 1 && gapIndex === itemCount) return 'after';
    return null;
  };

  return { dragIndex, rowProps, dropIndicator };
}

/**
 * Solid insertion line rendered in the gap next to an item. The item must be
 * `position: relative`; the line floats just outside its leading/trailing
 * edge (centred in the list gap) without affecting layout.
 */
export function DropIndicatorLine({
  position,
  axis = 'y',
}: {
  position: DropPosition | null;
  axis?: DragAxis;
}) {
  if (!position) return null;
  const placement =
    axis === 'y'
      ? position === 'before'
        ? 'inset-x-0 -top-[6px] h-[3px]'
        : 'inset-x-0 -bottom-[6px] h-[3px]'
      : position === 'before'
        ? 'inset-y-0 -left-[6px] w-[3px]'
        : 'inset-y-0 -right-[6px] w-[3px]';
  return (
    <span
      aria-hidden="true"
      data-testid={`drop-indicator-${position}`}
      className={`pointer-events-none absolute rounded-full bg-blue-500 dark:bg-blue-400 ${placement}`}
    />
  );
}

/**
 * Inset-shadow variant of the insertion line for flush vertical lists
 * (square-cornered rows with no gaps), where a line along the row's own
 * edge already reads as a straight rule at the boundary.
 */
export function dropIndicatorClass(indicator: DropPosition | null): string {
  if (indicator === 'before') {
    return 'shadow-[inset_0_3px_0_0_var(--color-blue-500)] dark:shadow-[inset_0_3px_0_0_var(--color-blue-400)]';
  }
  if (indicator === 'after') {
    return 'shadow-[inset_0_-3px_0_0_var(--color-blue-500)] dark:shadow-[inset_0_-3px_0_0_var(--color-blue-400)]';
  }
  return '';
}
