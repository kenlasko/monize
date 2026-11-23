import { describe, it, expect, vi } from 'vitest';
import { subscribeAutoPriceRefresh, notifyAutoPriceRefresh } from './autoPriceRefreshSignal';

describe('autoPriceRefreshSignal', () => {
  it('notifies every subscriber with the refresh timestamp', () => {
    const first = vi.fn();
    const second = vi.fn();
    const unsubFirst = subscribeAutoPriceRefresh(first);
    const unsubSecond = subscribeAutoPriceRefresh(second);

    notifyAutoPriceRefresh('2026-11-23T15:00:00Z');

    expect(first).toHaveBeenCalledWith('2026-11-23T15:00:00Z');
    expect(second).toHaveBeenCalledWith('2026-11-23T15:00:00Z');
    unsubFirst();
    unsubSecond();
  });

  it('stops notifying only the listener that unsubscribed', () => {
    const gone = vi.fn();
    const kept = vi.fn();
    const unsubGone = subscribeAutoPriceRefresh(gone);
    const unsubKept = subscribeAutoPriceRefresh(kept);

    unsubGone();
    notifyAutoPriceRefresh();

    expect(gone).not.toHaveBeenCalled();
    expect(kept).toHaveBeenCalledTimes(1);
    unsubKept();
  });

  it('does nothing with no subscribers', () => {
    expect(() => notifyAutoPriceRefresh()).not.toThrow();
  });
});
