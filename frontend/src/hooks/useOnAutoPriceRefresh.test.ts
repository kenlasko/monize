import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@/test/render';
import { useOnAutoPriceRefresh } from './useOnAutoPriceRefresh';
import { notifyAutoPriceRefresh } from '@/lib/autoPriceRefreshSignal';

describe('useOnAutoPriceRefresh', () => {
  it('calls the callback with the refresh timestamp when the signal fires', () => {
    const callback = vi.fn();
    renderHook(() => useOnAutoPriceRefresh(callback));

    notifyAutoPriceRefresh('2026-11-23T15:00:00Z');

    expect(callback).toHaveBeenCalledWith('2026-11-23T15:00:00Z');
  });

  it('stops listening on unmount', () => {
    const callback = vi.fn();
    const { unmount } = renderHook(() => useOnAutoPriceRefresh(callback));

    unmount();
    notifyAutoPriceRefresh();

    expect(callback).not.toHaveBeenCalled();
  });

  it('calls the latest callback, not the one it first rendered with', () => {
    // A page passes an inline closure over its current selection; the reload
    // must be the one for what is on screen now.
    const first = vi.fn();
    const latest = vi.fn();
    const { rerender } = renderHook(({ cb }) => useOnAutoPriceRefresh(cb), {
      initialProps: { cb: first },
    });

    rerender({ cb: latest });
    notifyAutoPriceRefresh();

    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledTimes(1);
  });
});
