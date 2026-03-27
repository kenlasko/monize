'use client';

import { useEffect } from 'react';

/**
 * Listens for the custom 'undoredo' event and calls the provided callback.
 * Use this in page components to refresh data after undo/redo.
 */
export function useOnUndoRedo(callback: () => void) {
  useEffect(() => {
    const handler = () => callback();
    window.addEventListener('undoredo', handler);
    return () => window.removeEventListener('undoredo', handler);
  }, [callback]);
}
