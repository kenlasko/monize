'use client';

import { useEffect, useCallback, useRef } from 'react';
import toast from 'react-hot-toast';
import { actionHistoryApi } from '@/lib/action-history';
import { createLogger } from '@/lib/logger';

const logger = createLogger('UndoRedo');

/**
 * Global hook for undo/redo keyboard shortcuts.
 * Mount once in the authenticated layout.
 *
 * - Ctrl+Z / Cmd+Z  -> undo
 * - Ctrl+Shift+Z / Cmd+Shift+Z  -> redo
 * - Ctrl+Y / Cmd+Y  -> redo (alternative)
 *
 * After a successful undo/redo, dispatches a custom 'undoredo' event
 * so pages can refetch their data.
 */
export function useUndoRedo() {
  const pendingRef = useRef(false);

  const handleUndo = useCallback(async () => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    try {
      const result = await actionHistoryApi.undo();
      toast.success(result.description);
      window.dispatchEvent(new CustomEvent('undoredo'));
    } catch (error: any) {
      const status = error?.response?.status;
      const message = error?.response?.data?.message;
      if (status === 404) {
        toast.success('Nothing to undo');
      } else if (status === 409) {
        toast.error(message || 'Cannot undo this action');
      } else {
        logger.error('Undo failed', error);
        toast.error('Undo failed');
      }
    } finally {
      pendingRef.current = false;
    }
  }, []);

  const handleRedo = useCallback(async () => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    try {
      const result = await actionHistoryApi.redo();
      toast.success(result.description);
      window.dispatchEvent(new CustomEvent('undoredo'));
    } catch (error: any) {
      const status = error?.response?.status;
      const message = error?.response?.data?.message;
      if (status === 404) {
        toast.success('Nothing to redo');
      } else if (status === 409) {
        toast.error(message || 'Cannot redo this action');
      } else {
        logger.error('Redo failed', error);
        toast.error('Redo failed');
      }
    } finally {
      pendingRef.current = false;
    }
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isModifier = e.ctrlKey || e.metaKey;
      if (!isModifier) return;

      // Skip when focus is in an input/textarea/contenteditable
      const target = e.target as HTMLElement;
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      ) {
        return;
      }

      if (e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        handleUndo();
      } else if ((e.key === 'z' && e.shiftKey) || e.key === 'y') {
        e.preventDefault();
        handleRedo();
      }
    };

    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [handleUndo, handleRedo]);

  return { handleUndo, handleRedo };
}
