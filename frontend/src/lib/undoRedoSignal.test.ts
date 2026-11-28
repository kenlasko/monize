import { describe, it, expect, vi } from 'vitest';
import { subscribeUndoRedo, notifyUndoRedo, isUndoRefusal } from './undoRedoSignal';

describe('undoRedoSignal', () => {
  it('should notify subscribers when signal fires', () => {
    const callback = vi.fn();
    const unsubscribe = subscribeUndoRedo(callback);

    notifyUndoRedo();
    expect(callback).toHaveBeenCalledTimes(1);

    unsubscribe();
  });

  it('should support multiple subscribers', () => {
    const callback1 = vi.fn();
    const callback2 = vi.fn();
    const unsub1 = subscribeUndoRedo(callback1);
    const unsub2 = subscribeUndoRedo(callback2);

    notifyUndoRedo();
    expect(callback1).toHaveBeenCalledTimes(1);
    expect(callback2).toHaveBeenCalledTimes(1);

    unsub1();
    unsub2();
  });

  it('should unsubscribe correctly', () => {
    const callback = vi.fn();
    const unsubscribe = subscribeUndoRedo(callback);

    unsubscribe();
    notifyUndoRedo();
    expect(callback).not.toHaveBeenCalled();
  });

  it('should only remove the unsubscribed listener', () => {
    const callback1 = vi.fn();
    const callback2 = vi.fn();
    const unsub1 = subscribeUndoRedo(callback1);
    const unsub2 = subscribeUndoRedo(callback2);

    unsub1();
    notifyUndoRedo();

    expect(callback1).not.toHaveBeenCalled();
    expect(callback2).toHaveBeenCalledTimes(1);

    unsub2();
  });

  it('should handle notify with no subscribers', () => {
    expect(() => notifyUndoRedo()).not.toThrow();
  });

  it('holds Undo on a delete the server refuses to undo (transfer leg, split lines)', () => {
    for (const code of [
      'UNDO_DELETED_SPLIT_HAS_TRANSFER_LINE',
      'UNDO_TRANSFER_LEG_DELETED',
      'UNDO_TRANSFER_CHANGE_NOT_SUPPORTED',
      'UNDO_BULK_DELETED_SPLIT',
    ]) {
      expect(isUndoRefusal(409, code)).toBe(true);
    }
  });

  it('holds Undo on a budget creation whose budget gained periods or lines', () => {
    expect(isUndoRefusal(409, 'UNDO_BUDGET_HAS_HISTORY')).toBe(true);
  });

  it('holds Undo on a scheduled posting the server refuses to undo (issue #2165)', () => {
    for (const code of [
      'SCHEDULED_POSTING_UNDO_LATER_OCCURRENCE',
      'SCHEDULED_POSTING_UNDO_CURSOR_MOVED',
      'SCHEDULED_POSTING_UNDO_REFERENCE_GONE',
    ]) {
      expect(isUndoRefusal(409, code)).toBe(true);
    }
    // A redo refusal is not an undo refusal.
    expect(isUndoRefusal(409, 'SCHEDULED_POSTING_REDO')).toBe(false);
  });
});
