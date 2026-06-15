import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useLongPress } from './useLongPress';

type Item = { id: string };
const item: Item = { id: 'x1' };

function touchEvent(x: number, y: number): React.TouchEvent {
  return { touches: [{ clientX: x, clientY: y }] } as unknown as React.TouchEvent;
}

describe('useLongPress', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fires onLongPress after the delay on touch and suppresses the trailing click', () => {
    const onLongPress = vi.fn();
    const onClick = vi.fn();
    const { result } = renderHook(() => useLongPress<Item>({ onLongPress, onClick }));
    const handlers = result.current.getRowHandlers(item);

    handlers.onTouchStart(touchEvent(0, 0));
    vi.advanceTimersByTime(750);
    expect(onLongPress).toHaveBeenCalledWith(item);
    expect(result.current.wasLongPress.current).toBe(true);

    // The click that follows a long-press must be swallowed.
    handlers.onClick({} as React.MouseEvent);
    expect(onClick).not.toHaveBeenCalled();
    expect(result.current.wasLongPress.current).toBe(false);
  });

  it('does not fire onLongPress when released before the delay', () => {
    const onLongPress = vi.fn();
    const onClick = vi.fn();
    const { result } = renderHook(() => useLongPress<Item>({ onLongPress, onClick }));
    const handlers = result.current.getRowHandlers(item);

    handlers.onTouchStart(touchEvent(0, 0));
    vi.advanceTimersByTime(300);
    handlers.onTouchEnd();
    vi.advanceTimersByTime(750);
    expect(onLongPress).not.toHaveBeenCalled();

    handlers.onClick({} as React.MouseEvent);
    expect(onClick).toHaveBeenCalledWith(item);
  });

  it('cancels the press when the touch moves beyond the threshold', () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress<Item>({ onLongPress }));
    const handlers = result.current.getRowHandlers(item);

    handlers.onTouchStart(touchEvent(0, 0));
    handlers.onTouchMove(touchEvent(20, 0));
    vi.advanceTimersByTime(750);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('keeps the press alive for small moves within the threshold', () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress<Item>({ onLongPress }));
    const handlers = result.current.getRowHandlers(item);

    handlers.onTouchStart(touchEvent(0, 0));
    handlers.onTouchMove(touchEvent(5, 5));
    vi.advanceTimersByTime(750);
    expect(onLongPress).toHaveBeenCalledWith(item);
  });

  it('fires immediately on context menu and suppresses the click', () => {
    const onLongPress = vi.fn();
    const onClick = vi.fn();
    const preventDefault = vi.fn();
    const { result } = renderHook(() => useLongPress<Item>({ onLongPress, onClick }));
    const handlers = result.current.getRowHandlers(item);

    handlers.onContextMenu({ preventDefault } as unknown as React.MouseEvent);
    expect(preventDefault).toHaveBeenCalled();
    expect(onLongPress).toHaveBeenCalledWith(item);

    handlers.onClick({} as React.MouseEvent);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('ignores non-left mouse buttons', () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress<Item>({ onLongPress }));
    const handlers = result.current.getRowHandlers(item);

    handlers.onMouseDown({ button: 2 } as React.MouseEvent);
    vi.advanceTimersByTime(750);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('does nothing when disabled but still forwards plain clicks', () => {
    const onLongPress = vi.fn();
    const onClick = vi.fn();
    const { result } = renderHook(() => useLongPress<Item>({ onLongPress, onClick, enabled: false }));
    const handlers = result.current.getRowHandlers(item);

    handlers.onTouchStart(touchEvent(0, 0));
    vi.advanceTimersByTime(750);
    expect(onLongPress).not.toHaveBeenCalled();

    handlers.onClick({} as React.MouseEvent);
    expect(onClick).toHaveBeenCalledWith(item);
  });
});
