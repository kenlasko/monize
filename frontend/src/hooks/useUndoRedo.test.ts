import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import toast from 'react-hot-toast';
import { useUndoRedo } from './useUndoRedo';

vi.mock('@/lib/action-history', () => ({
  actionHistoryApi: {
    undo: vi.fn(),
    redo: vi.fn(),
    getHistory: vi.fn(),
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe('useUndoRedo', () => {
  let actionHistoryApi: any;

  beforeEach(async () => {
    const mod = await import('@/lib/action-history');
    actionHistoryApi = mod.actionHistoryApi;
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return handleUndo and handleRedo functions', () => {
    const { result } = renderHook(() => useUndoRedo());
    expect(result.current.handleUndo).toBeInstanceOf(Function);
    expect(result.current.handleRedo).toBeInstanceOf(Function);
  });

  it('should call undo API and show success toast', async () => {
    actionHistoryApi.undo.mockResolvedValue({
      action: { id: 'action-1' },
      description: 'Undone: Created tag "Test"',
    });

    const { result } = renderHook(() => useUndoRedo());

    await act(async () => {
      await result.current.handleUndo();
    });

    expect(actionHistoryApi.undo).toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith('Undone: Created tag "Test"');
  });

  it('should call redo API and show success toast', async () => {
    actionHistoryApi.redo.mockResolvedValue({
      action: { id: 'action-1' },
      description: 'Redone: Created tag "Test"',
    });

    const { result } = renderHook(() => useUndoRedo());

    await act(async () => {
      await result.current.handleRedo();
    });

    expect(actionHistoryApi.redo).toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith('Redone: Created tag "Test"');
  });

  it('should show success toast (not error) when nothing to undo', async () => {
    actionHistoryApi.undo.mockRejectedValue({
      response: { status: 404, data: { message: 'Nothing to undo' } },
    });

    const { result } = renderHook(() => useUndoRedo());

    await act(async () => {
      await result.current.handleUndo();
    });

    // 404 is not an error - should not show error toast
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('should show error toast on conflict', async () => {
    actionHistoryApi.undo.mockRejectedValue({
      response: {
        status: 409,
        data: { message: 'Cannot undo: transaction has been reconciled' },
      },
    });

    const { result } = renderHook(() => useUndoRedo());

    await act(async () => {
      await result.current.handleUndo();
    });

    expect(toast.error).toHaveBeenCalledWith(
      'Cannot undo: transaction has been reconciled',
    );
  });

  it('should dispatch undoredo event on success', async () => {
    actionHistoryApi.undo.mockResolvedValue({
      action: { id: 'action-1' },
      description: 'Undone: test',
    });

    const eventHandler = vi.fn();
    window.addEventListener('undoredo', eventHandler);

    const { result } = renderHook(() => useUndoRedo());

    await act(async () => {
      await result.current.handleUndo();
    });

    expect(eventHandler).toHaveBeenCalled();
    window.removeEventListener('undoredo', eventHandler);
  });

  it('should respond to Ctrl+Z keyboard shortcut', async () => {
    actionHistoryApi.undo.mockResolvedValue({
      action: { id: 'action-1' },
      description: 'Undone: test',
    });

    renderHook(() => useUndoRedo());

    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'z',
          ctrlKey: true,
          bubbles: true,
        }),
      );
      // Wait for async handler
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(actionHistoryApi.undo).toHaveBeenCalled();
  });

  it('should respond to Ctrl+Shift+Z keyboard shortcut for redo', async () => {
    actionHistoryApi.redo.mockResolvedValue({
      action: { id: 'action-1' },
      description: 'Redone: test',
    });

    renderHook(() => useUndoRedo());

    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'z',
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
        }),
      );
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(actionHistoryApi.redo).toHaveBeenCalled();
  });

  it('should not trigger when focus is in an input', async () => {
    renderHook(() => useUndoRedo());

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'z',
          ctrlKey: true,
          bubbles: true,
        }),
      );
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(actionHistoryApi.undo).not.toHaveBeenCalled();
    document.body.removeChild(input);
  });
});
