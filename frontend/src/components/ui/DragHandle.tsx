'use client';

import { useRef } from 'react';

interface DragHandleProps {
  /** Accessible name for the handle; also its tooltip when `title` is unset. */
  label: string;
  /** Tooltip, when it should say more than the accessible name. */
  title?: string;
  /** Pointer press, before any movement. */
  onDragStart?: () => void;
  /** Pointer moved: offsets from where the press started, in px. */
  onDragMove: (dx: number, dy: number) => void;
  /** Pointer released: the final offsets from the press. */
  onDragEnd?: (dx: number, dy: number) => void;
  /** Arrow keys, so the panel is movable without a pointer. */
  onNudge: (dx: number, dy: number) => void;
  /**
   * A plain activation: a click that did not drag, or Enter/Space from the
   * keyboard. Lets the handle carry a snap-to-next-position action without
   * costing a second button; omit it and a click does nothing.
   */
  onActivate?: () => void;
  /** Keyboard nudge distance in px. */
  nudgeStep?: number;
  /** Positioning classes; the visual treatment comes from the component. */
  className?: string;
}

/** Default keyboard nudge distance, in px. */
const NUDGE = 24;
/** Pointer travel under which a press stays a click rather than a drag. */
const CLICK_SLOP = 4;

/**
 * The six-dot grip that moves a floating panel: drag it with a pointer, or
 * nudge it with the arrow keys while it has focus. Shared by the guided-tour
 * card and the AI assistant panel so both are moved the same way -- an
 * explicit, visible handle beats a draggable region the user has to discover.
 *
 * Deliberately position-agnostic: it reports offsets from the press and lets
 * the owner decide what they mean (and clamp them to the viewport), because the
 * two panels keep their position in different shapes and units.
 */
export function DragHandle({
  label,
  title,
  onDragStart,
  onDragMove,
  onDragEnd,
  onNudge,
  onActivate,
  nudgeStep = NUDGE,
  className = '',
}: DragHandleProps) {
  const from = useRef<{ x: number; y: number } | null>(null);
  // Whether the current press turned into a drag, so the click that follows a
  // drag does not also fire the activation.
  const dragged = useRef(false);

  const handlePointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    // Stop the press from selecting text or focusing through to the page.
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    from.current = { x: e.clientX, y: e.clientY };
    dragged.current = false;
    onDragStart?.();
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const start = from.current;
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (Math.abs(dx) + Math.abs(dy) >= CLICK_SLOP) dragged.current = true;
    onDragMove(dx, dy);
  };

  const endDrag = (e: React.PointerEvent<HTMLButtonElement>) => {
    const start = from.current;
    from.current = null;
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture?.(e.pointerId);
    }
    if (start) onDragEnd?.(e.clientX - start.x, e.clientY - start.y);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    const deltas: Record<string, [number, number]> = {
      ArrowUp: [0, -nudgeStep],
      ArrowDown: [0, nudgeStep],
      ArrowLeft: [-nudgeStep, 0],
      ArrowRight: [nudgeStep, 0],
    };
    const delta = deltas[e.key];
    if (!delta) return;
    e.preventDefault();
    onNudge(delta[0], delta[1]);
  };

  return (
    <button
      type="button"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onClick={() => {
        // Consume the flag: a keyboard activation fires `click` with no
        // preceding pointerdown, so leaving it set after a mouse drag would
        // make Enter and Space dead for the rest of the component's life.
        const wasDrag = dragged.current;
        dragged.current = false;
        if (!wasDrag) onActivate?.();
      }}
      onKeyDown={handleKeyDown}
      aria-label={label}
      title={title ?? label}
      className={`cursor-move touch-none rounded p-1 text-gray-400 transition-colors motion-reduce:transition-none hover:bg-gray-100 hover:text-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:text-gray-500 dark:hover:bg-gray-700 dark:hover:text-gray-300 ${className}`}
    >
      {/* Six-dot grip */}
      <svg
        className="h-4 w-4"
        viewBox="0 0 20 20"
        fill="currentColor"
        aria-hidden="true"
      >
        <circle cx="7" cy="5" r="1.5" />
        <circle cx="13" cy="5" r="1.5" />
        <circle cx="7" cy="10" r="1.5" />
        <circle cx="13" cy="10" r="1.5" />
        <circle cx="7" cy="15" r="1.5" />
        <circle cx="13" cy="15" r="1.5" />
      </svg>
    </button>
  );
}
