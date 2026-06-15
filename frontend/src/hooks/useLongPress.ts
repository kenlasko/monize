import { useCallback, useEffect, useRef } from 'react';

export interface UseLongPressOptions<T> {
  /** Fired when a long-press (or right-click) completes -- typically opens an action sheet. */
  onLongPress: (item: T) => void;
  /** Fired on a normal click/tap that was not a long-press -- typically the row's primary action. */
  onClick?: (item: T) => void;
  /** How long the press must be held before `onLongPress` fires. Defaults to 750ms. */
  delayMs?: number;
  /** Cancels the press if the pointer moves more than this many pixels. Defaults to 10. */
  moveThresholdPx?: number;
  /** When false, the handlers become no-ops (and `onClick` still fires). Defaults to true. */
  enabled?: boolean;
}

/** Handler props to spread directly onto a row element (e.g. a `<tr>`). */
export interface LongPressRowHandlers {
  onClick: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onMouseDown: (e: React.MouseEvent) => void;
  onMouseUp: () => void;
  onMouseLeave: () => void;
  onTouchStart: (e: React.TouchEvent) => void;
  onTouchMove: (e: React.TouchEvent) => void;
  onTouchEnd: () => void;
  onTouchCancel: () => void;
}

export interface UseLongPressResult<T> {
  /** Binds the given item into a set of handlers to spread onto its row element. */
  getRowHandlers: (item: T) => LongPressRowHandlers;
  /**
   * True immediately after a long-press / context-menu fired, so the trailing
   * synthetic click can be suppressed. Reset by the click handler itself.
   */
  wasLongPress: React.RefObject<boolean>;
}

/**
 * Shared press-and-hold (long-press) behavior for list rows. A 750ms press --
 * or a right-click -- invokes `onLongPress` (used to open a mobile action sheet),
 * while a quick tap/click invokes `onClick`. Touch moves beyond the threshold
 * cancel the press so vertical scrolling does not trigger the menu.
 *
 * Extracted from the per-list duplicated logic so every list shares one
 * implementation. The handlers only ever set a timer; consumer state (the action
 * sheet) is set inside the supplied callbacks, never in an effect.
 */
export function useLongPress<T>({
  onLongPress,
  onClick,
  delayMs = 750,
  moveThresholdPx = 10,
  enabled = true,
}: UseLongPressOptions<T>): UseLongPressResult<T> {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wasLongPress = useRef(false);
  const touchStartPos = useRef<{ x: number; y: number } | null>(null);

  // Latest options held in a ref so the returned handlers stay stable (callers
  // can pass inline closures without re-binding every row each render). Updated
  // in an effect -- never during render -- and read only inside event handlers.
  const latest = useRef({ onLongPress, onClick, delayMs, moveThresholdPx, enabled });
  useEffect(() => {
    latest.current = { onLongPress, onClick, delayMs, moveThresholdPx, enabled };
  });

  const clearTimer = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  // Cancel any pending timer if the row unmounts mid-press.
  useEffect(() => clearTimer, [clearTimer]);

  const getRowHandlers = useCallback(
    (item: T): LongPressRowHandlers => ({
      onClick: () => {
        if (wasLongPress.current) {
          wasLongPress.current = false;
          return;
        }
        latest.current.onClick?.(item);
      },
      onContextMenu: (e: React.MouseEvent) => {
        if (!latest.current.enabled) return;
        e.preventDefault();
        clearTimer();
        wasLongPress.current = true;
        latest.current.onLongPress(item);
      },
      onMouseDown: (e: React.MouseEvent) => {
        if (!latest.current.enabled || e.button !== 0) return;
        touchStartPos.current = null;
        wasLongPress.current = false;
        timer.current = setTimeout(() => {
          wasLongPress.current = true;
          latest.current.onLongPress(item);
        }, latest.current.delayMs);
      },
      onMouseUp: clearTimer,
      onMouseLeave: clearTimer,
      onTouchStart: (e: React.TouchEvent) => {
        if (!latest.current.enabled) return;
        const touch = e.touches?.[0];
        touchStartPos.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
        wasLongPress.current = false;
        timer.current = setTimeout(() => {
          wasLongPress.current = true;
          latest.current.onLongPress(item);
        }, latest.current.delayMs);
      },
      onTouchMove: (e: React.TouchEvent) => {
        const start = touchStartPos.current;
        const touch = e.touches?.[0];
        if (start && timer.current && touch) {
          const deltaX = Math.abs(touch.clientX - start.x);
          const deltaY = Math.abs(touch.clientY - start.y);
          if (deltaX > latest.current.moveThresholdPx || deltaY > latest.current.moveThresholdPx) {
            clearTimer();
            touchStartPos.current = null;
          }
        }
      },
      onTouchEnd: clearTimer,
      onTouchCancel: clearTimer,
    }),
    [clearTimer],
  );

  return { getRowHandlers, wasLongPress };
}
