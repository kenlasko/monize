/**
 * Simple pub/sub signal for undo/redo notifications.
 * More reliable than DOM CustomEvent since it uses direct function calls.
 */
const listeners = new Set<() => void>();

export function subscribeUndoRedo(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function notifyUndoRedo(): void {
  listeners.forEach((fn) => fn());
}
