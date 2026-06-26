'use client';

import { useEffect } from 'react';
import { subscribeAiAction } from '@/lib/aiActionSignal';

/**
 * Listens for AI write-action notifications and calls the provided callback.
 * Use this in page components to refresh data after the AI assistant creates
 * or edits a record (e.g. a transaction confirmed from the chat bubble), so
 * the change shows up without a manual reload or navigation.
 */
export function useOnAiAction(callback: () => void) {
  useEffect(() => {
    return subscribeAiAction(callback);
  }, [callback]);
}
