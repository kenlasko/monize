import { renderHook } from '@testing-library/react';
import { useOnUndoRedo } from './useOnUndoRedo';
import { notifyUndoRedo } from '@/lib/undoRedoSignal';

describe('useOnUndoRedo', () => {
  it('should call callback when undoredo signal fires', () => {
    const callback = vi.fn();
    renderHook(() => useOnUndoRedo(callback));

    notifyUndoRedo();
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('should clean up listener on unmount', () => {
    const callback = vi.fn();
    const { unmount } = renderHook(() => useOnUndoRedo(callback));

    unmount();
    notifyUndoRedo();
    expect(callback).not.toHaveBeenCalled();
  });

  it('should update listener when callback changes', () => {
    const callback1 = vi.fn();
    const callback2 = vi.fn();
    const { rerender } = renderHook(
      ({ cb }) => useOnUndoRedo(cb),
      { initialProps: { cb: callback1 } },
    );

    rerender({ cb: callback2 });
    notifyUndoRedo();

    expect(callback1).not.toHaveBeenCalled();
    expect(callback2).toHaveBeenCalledTimes(1);
  });
});
