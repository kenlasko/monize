import { isUuid } from '@/lib/uuid';

/**
 * A one-shot hand-off of staged content to the assistant's chat page, from a
 * screen that already holds it (the receipts page: an order email as a text file
 * and a prefilled message). Kept in memory only, in this module: nothing is
 * written to localStorage, sessionStorage or IndexedDB, so the email's text never
 * sits in browser storage and a reload or a closed tab drops it.
 *
 * The same contract as the Web Share Target's hand-off (INV-SHARE-002): the
 * receiver STAGES the files and the text on the composer and the user still
 * presses Send. Nothing here asks the assistant anything. The page reads the
 * entry by its random id (`peekChatHandoff`) and discards it once the composer
 * holds the files (`discardChatHandoff`), so one owner holds the bytes; an entry
 * nobody collects is dropped when newer ones push it out.
 */
export interface ChatHandoff {
  files: File[];
  /** Text for the composer, staged and never sent. */
  draft: string;
}

/** A page that never collects its hand-off leaks at most this many. */
const MAX_PENDING_HANDOFFS = 5;

const pending = new Map<string, ChatHandoff>();

/** Park a hand-off and return the id the chat page is opened with (`/ai?handoff=<id>`). */
export function stageChatHandoff(handoff: ChatHandoff): string {
  const id = crypto.randomUUID();
  while (pending.size >= MAX_PENDING_HANDOFFS) {
    const oldest = pending.keys().next().value;
    if (oldest === undefined) break;
    pending.delete(oldest);
  }
  pending.set(id, handoff);
  return id;
}

/** The hand-off parked under `id`, left in place; null for an unknown, malformed or taken id. */
export function peekChatHandoff(id: string | null | undefined): ChatHandoff | null {
  if (!isUuid(id)) return null;
  return pending.get(id) ?? null;
}

/** Drop a hand-off once the composer holds its contents. */
export function discardChatHandoff(id: string | null | undefined): void {
  if (isUuid(id)) pending.delete(id);
}
