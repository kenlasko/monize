import { describe, it, expect, vi } from 'vitest';
import { subscribeAiAction, notifyAiAction } from './aiActionSignal';

describe('aiActionSignal', () => {
  it('should notify subscribers when signal fires', () => {
    const callback = vi.fn();
    const unsubscribe = subscribeAiAction(callback);

    notifyAiAction();
    expect(callback).toHaveBeenCalledTimes(1);

    unsubscribe();
  });

  it('should support multiple subscribers', () => {
    const callback1 = vi.fn();
    const callback2 = vi.fn();
    const unsub1 = subscribeAiAction(callback1);
    const unsub2 = subscribeAiAction(callback2);

    notifyAiAction();
    expect(callback1).toHaveBeenCalledTimes(1);
    expect(callback2).toHaveBeenCalledTimes(1);

    unsub1();
    unsub2();
  });

  it('should unsubscribe correctly', () => {
    const callback = vi.fn();
    const unsubscribe = subscribeAiAction(callback);

    unsubscribe();
    notifyAiAction();
    expect(callback).not.toHaveBeenCalled();
  });

  it('should only remove the unsubscribed listener', () => {
    const callback1 = vi.fn();
    const callback2 = vi.fn();
    const unsub1 = subscribeAiAction(callback1);
    const unsub2 = subscribeAiAction(callback2);

    unsub1();
    notifyAiAction();

    expect(callback1).not.toHaveBeenCalled();
    expect(callback2).toHaveBeenCalledTimes(1);

    unsub2();
  });

  it('should handle notify with no subscribers', () => {
    expect(() => notifyAiAction()).not.toThrow();
  });
});
