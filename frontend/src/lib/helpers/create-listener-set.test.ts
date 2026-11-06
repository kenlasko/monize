import { describe, it, expect, vi } from 'vitest';
import { createListenerSet } from './create-listener-set';

describe('createListenerSet', () => {
  it('calls every subscriber on notify until it unsubscribes', () => {
    const set = createListenerSet();
    const a = vi.fn();
    const b = vi.fn();
    const stopA = set.subscribe(a);
    set.subscribe(b);
    set.notify();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    stopA();
    set.notify();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
  });

  it('keeps two sets apart', () => {
    const first = createListenerSet();
    const second = createListenerSet();
    const listener = vi.fn();
    first.subscribe(listener);
    second.notify();
    expect(listener).not.toHaveBeenCalled();
  });
});
