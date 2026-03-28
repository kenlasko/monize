'use client';

import { useEffect } from 'react';
import { subscribeUndoRedo } from '@/lib/undoRedoSignal';

/**
 * Listens for undo/redo notifications and calls the provided callback.
 * Use this in page components to refresh data after undo/redo.
 */
export function useOnUndoRedo(callback: () => void) {
  useEffect(() => {
    return subscribeUndoRedo(callback);
  }, [callback]);
}
