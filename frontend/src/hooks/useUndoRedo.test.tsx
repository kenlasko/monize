import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { ReactNode } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import commonEn from '@/i18n/messages/en/common.json';
import layoutEn from '@/i18n/messages/en/layout.json';

// Hook emits toasts via next-intl; resolve them against the real English
// catalogs so renderHook has an intl context. `layout` carries the action
// descriptions and undo/redo prefixes; `common` carries the error messages.
const wrapper = ({ children }: { children: ReactNode }) => (
  <NextIntlClientProvider
    locale="en"
    messages={{ common: commonEn, layout: layoutEn }}
  >
    {children}
  </NextIntlClientProvider>
);
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
    const { result } = renderHook(() => useUndoRedo(), { wrapper });
    expect(result.current.handleUndo).toBeInstanceOf(Function);
    expect(result.current.handleRedo).toBeInstanceOf(Function);
  });

  it('should call undo API and show success toast', async () => {
    actionHistoryApi.undo.mockResolvedValue({
      action: {
        id: 'action-1',
        descriptionKey: 'createdTag',
        descriptionParams: { name: 'Test' },
      },
      description: 'ignored backend string',
    });

    const { result } = renderHook(() => useUndoRedo(), { wrapper });

    await act(async () => {
      await result.current.handleUndo();
    });

    expect(actionHistoryApi.undo).toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith('Undone: Created tag "Test"');
  });

  it('should call redo API and show success toast', async () => {
    actionHistoryApi.redo.mockResolvedValue({
      action: {
        id: 'action-1',
        descriptionKey: 'createdTag',
        descriptionParams: { name: 'Test' },
      },
      description: 'ignored backend string',
    });

    const { result } = renderHook(() => useUndoRedo(), { wrapper });

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

    const { result } = renderHook(() => useUndoRedo(), { wrapper });

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
        data: { message: 'Cannot undo: entity no longer exists' },
      },
    });

    const { result } = renderHook(() => useUndoRedo(), { wrapper });

    await act(async () => {
      await result.current.handleUndo();
    });

    expect(toast.error).toHaveBeenCalledWith(
      'Cannot undo: entity no longer exists',
    );
  });

  it('should notify undoredo signal on success', async () => {
    actionHistoryApi.undo.mockResolvedValue({
      action: { id: 'action-1' },
      description: 'Undone: test',
    });

    const { subscribeUndoRedo } = await import('@/lib/undoRedoSignal');
    const signalHandler = vi.fn();
    const unsubscribe = subscribeUndoRedo(signalHandler);

    const { result } = renderHook(() => useUndoRedo(), { wrapper });

    await act(async () => {
      await result.current.handleUndo();
    });

    expect(signalHandler).toHaveBeenCalled();
    unsubscribe();
  });

  it('should respond to Ctrl+Z keyboard shortcut', async () => {
    actionHistoryApi.undo.mockResolvedValue({
      action: { id: 'action-1' },
      description: 'Undone: test',
    });

    renderHook(() => useUndoRedo(), { wrapper });

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

    renderHook(() => useUndoRedo(), { wrapper });

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
    renderHook(() => useUndoRedo(), { wrapper });

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

  it('should not trigger from textarea', async () => {
    renderHook(() => useUndoRedo(), { wrapper });
    const ta = document.createElement('textarea');
    document.body.appendChild(ta);
    ta.focus();
    await act(async () => {
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(actionHistoryApi.undo).not.toHaveBeenCalled();
    document.body.removeChild(ta);
  });

  it('should not trigger when no modifier key', async () => {
    renderHook(() => useUndoRedo(), { wrapper });
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', bubbles: true }));
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(actionHistoryApi.undo).not.toHaveBeenCalled();
  });

  it('should respond to Ctrl+Y for redo', async () => {
    actionHistoryApi.redo.mockResolvedValue({ action: { id: 'a' }, description: 'Redo' });
    renderHook(() => useUndoRedo(), { wrapper });
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true, bubbles: true }));
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(actionHistoryApi.redo).toHaveBeenCalled();
  });

  it('should show success toast (not error) when nothing to redo', async () => {
    actionHistoryApi.redo.mockRejectedValue({ response: { status: 404, data: { message: 'Nothing to redo' } } });
    const { result } = renderHook(() => useUndoRedo(), { wrapper });
    await act(async () => {
      await result.current.handleRedo();
    });
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('should show error toast on redo conflict', async () => {
    actionHistoryApi.redo.mockRejectedValue({ response: { status: 409, data: { message: 'Conflict' } } });
    const { result } = renderHook(() => useUndoRedo(), { wrapper });
    await act(async () => {
      await result.current.handleRedo();
    });
    expect(toast.error).toHaveBeenCalledWith('Conflict');
  });

  it('should show generic error toast when undo fails unexpectedly', async () => {
    actionHistoryApi.undo.mockRejectedValue({ response: { status: 500 } });
    const { result } = renderHook(() => useUndoRedo(), { wrapper });
    await act(async () => {
      await result.current.handleUndo();
    });
    expect(toast.error).toHaveBeenCalledWith('Undo failed');
  });

  it('should show generic error toast when redo fails unexpectedly', async () => {
    actionHistoryApi.redo.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useUndoRedo(), { wrapper });
    await act(async () => {
      await result.current.handleRedo();
    });
    expect(toast.error).toHaveBeenCalledWith('Redo failed');
  });

  it('uses default messages when 409 has no message', async () => {
    actionHistoryApi.undo.mockRejectedValue({ response: { status: 409, data: {} } });
    const { result } = renderHook(() => useUndoRedo(), { wrapper });
    await act(async () => {
      await result.current.handleUndo();
    });
    expect(toast.error).toHaveBeenCalledWith('Cannot undo this action');
  });

  it('does not start a second undo while one is pending', async () => {
    let resolve!: (v: any) => void;
    actionHistoryApi.undo.mockImplementation(
      () => new Promise((res) => { resolve = res; }),
    );
    const { result } = renderHook(() => useUndoRedo(), { wrapper });

    // Start first undo without awaiting so the second call races with it
    const firstPromise = result.current.handleUndo();
    // Second call while first is pending — should be deduped
    await act(async () => {
      await result.current.handleUndo();
    });
    expect(actionHistoryApi.undo).toHaveBeenCalledTimes(1);
    resolve({ description: 'done' });
    await act(async () => { await firstPromise; });
  });
});
