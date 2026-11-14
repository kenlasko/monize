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

// The server refuses some undos (409 + errorCode) before writing anything and
// always picks the same newest entry, so retrying cannot succeed until the
// history changes. Holds the server's message while Undo is unavailable.
const UNDO_REFUSAL_CODES: ReadonlySet<string> = new Set([
  'UNDO_SPLIT_LEGS_CHANGED',
  'UNDO_VOID_WITH_LEGS',
  'LOAN_EDIT_NOT_UNDOABLE',
  'RULE_RUN_UNDO_LATER_SETTLEMENT',
  'RULE_RUN_UNDO_STRUCTURE_CHANGED',
  'SCHEDULED_POSTING_UNDO_LATER_OCCURRENCE',
  'SCHEDULED_POSTING_UNDO_CURSOR_MOVED',
  'SCHEDULED_POSTING_UNDO_REFERENCE_GONE',
]);

let undoRefusal: string | null = null;
const refusalListeners = new Set<() => void>();

function setUndoRefusal(message: string | null): void {
  if (undoRefusal === message) return;
  undoRefusal = message;
  refusalListeners.forEach((fn) => fn());
}

export function isUndoRefusal(status: unknown, errorCode: unknown): boolean {
  return status === 409 && typeof errorCode === 'string' && UNDO_REFUSAL_CODES.has(errorCode);
}

export const markUndoRefused = (message: string): void => setUndoRefusal(message);
export const clearUndoRefused = (): void => setUndoRefusal(null);
export const getUndoRefusal = (): string | null => undoRefusal;

export function subscribeUndoRefusal(fn: () => void): () => void {
  refusalListeners.add(fn);
  return () => {
    refusalListeners.delete(fn);
  };
}
