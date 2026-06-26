/**
 * Simple pub/sub signal fired after the AI assistant commits a write action
 * (create/update/delete of a transaction, payee, security, ...). List pages
 * subscribe via {@link useOnAiAction} so the data the user is looking at
 * refreshes immediately, instead of going stale until the next navigation.
 *
 * Mirrors {@link import('./undoRedoSignal')} -- direct function calls are more
 * reliable than DOM CustomEvents and avoid coupling to the window object.
 */
const listeners = new Set<() => void>();

export function subscribeAiAction(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function notifyAiAction(): void {
  listeners.forEach((fn) => fn());
}
