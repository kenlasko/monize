'use client';

import { useEffect, useCallback, useRef } from 'react';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { actionHistoryApi } from '@/lib/action-history';
import { renderActionDescription } from '@/lib/action-history-format';
import { clearAllCache } from '@/lib/apiCache';
import { notifyUndoRedo } from '@/lib/undoRedoSignal';
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
  const t = useTranslations('common');
  // Action descriptions live in the `layout` catalog (shared with the panel);
  // render them here so keyboard-driven undo/redo toasts are localized too.
  const tLayout = useTranslations('layout');
  const pendingRef = useRef(false);

  const handleUndo = useCallback(async () => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    try {
      const result = await actionHistoryApi.undo();
      toast.success(
        tLayout('actionHistory.undonePrefix', {
          description: renderActionDescription(tLayout, result.action),
        }),
      );
      clearAllCache();
      notifyUndoRedo();
    } catch (error: any) {
      const status = error?.response?.status;
      const message = error?.response?.data?.message;
      if (status === 404) {
        toast.success(t('undoRedo.nothingToUndo'));
      } else if (status === 409) {
        toast.error(message || t('undoRedo.cannotUndo'));
      } else {
        logger.error('Undo failed', error);
        toast.error(t('undoRedo.undoFailed'));
      }
    } finally {
      pendingRef.current = false;
    }
  }, [t, tLayout]);

  const handleRedo = useCallback(async () => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    try {
      const result = await actionHistoryApi.redo();
      toast.success(
        tLayout('actionHistory.redonePrefix', {
          description: renderActionDescription(tLayout, result.action),
        }),
      );
      clearAllCache();
      notifyUndoRedo();
    } catch (error: any) {
      const status = error?.response?.status;
      const message = error?.response?.data?.message;
      if (status === 404) {
        toast.success(t('undoRedo.nothingToRedo'));
      } else if (status === 409) {
        toast.error(message || t('undoRedo.cannotRedo'));
      } else {
        logger.error('Redo failed', error);
        toast.error(t('undoRedo.redoFailed'));
      }
    } finally {
      pendingRef.current = false;
    }
  }, [t, tLayout]);

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
