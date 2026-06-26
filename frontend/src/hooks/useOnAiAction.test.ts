import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useOnAiAction } from './useOnAiAction';
import { notifyAiAction } from '@/lib/aiActionSignal';

describe('useOnAiAction', () => {
  it('should call callback when ai-action signal fires', () => {
    const callback = vi.fn();
    renderHook(() => useOnAiAction(callback));

    notifyAiAction();
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('should clean up listener on unmount', () => {
    const callback = vi.fn();
    const { unmount } = renderHook(() => useOnAiAction(callback));

    unmount();
    notifyAiAction();
    expect(callback).not.toHaveBeenCalled();
  });

  it('should update listener when callback changes', () => {
    const callback1 = vi.fn();
    const callback2 = vi.fn();
    const { rerender } = renderHook(
      ({ cb }) => useOnAiAction(cb),
      { initialProps: { cb: callback1 } },
    );

    rerender({ cb: callback2 });
    notifyAiAction();

    expect(callback1).not.toHaveBeenCalled();
    expect(callback2).toHaveBeenCalledTimes(1);
  });
});
