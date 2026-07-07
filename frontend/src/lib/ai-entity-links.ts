/**
 * Entity deep-links emitted by the AI assistant (both the native LLM path and
 * the MCP web-chat relay). The model formats entity mentions as markdown links
 * with a structured `monize://<entity-type>/<uuid>` href; this module is the
 * single place that decides where those links actually navigate. Keeping the
 * mapping client-side means the AI contract stays stable if a destination
 * changes (e.g. a future dedicated payee page), and the strict parse means a
 * hallucinated or injected URI can at worst navigate to a same-origin filtered
 * transaction list (ownership is enforced server-side, so a foreign id just
 * shows an empty list).
 */

/**
 * Window event dispatched when an entity deep-link inside an assistant
 * message is clicked. The chat bubble listens for it to collapse the panel:
 * a click while already on /transactions only changes the query string, so
 * the bubble's pathname-based collapse never fires.
 */
export const AI_ENTITY_LINK_EVENT = 'ai:entityLinkNavigate';

const ENTITY_URI_REGEX =
  /^monize:\/\/(account|payee|category|transaction|security|scheduled)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export function isMonizeHref(href: string | undefined): boolean {
  return typeof href === 'string' && /^monize:/i.test(href);
}

/**
 * Map a `monize://` entity URI to its in-app route, or null when the URI is
 * not a valid entity link (unknown type, malformed id, trailing junk).
 * Account/payee/category/transaction resolve to the Transactions page (single-
 * entity filters also surface the matching info sidebar; `targetTransactionId`
 * highlights the row). Securities and scheduled transactions resolve to their
 * own list pages with a passive `?highlight=` that flashes/scrolls to the row.
 * Account links carry `accountStatus=all` so a closed account is not pruned by
 * the stored Show Accounts toggle (Institutions-page precedent).
 */
export function resolveEntityHref(href: string | undefined): string | null {
  if (!href) return null;
  const match = ENTITY_URI_REGEX.exec(href);
  if (!match) return null;
  const [, entityType, id] = match;
  switch (entityType.toLowerCase()) {
    case 'account':
      return `/transactions?accountId=${id}&accountStatus=all`;
    case 'payee':
      return `/transactions?payeeId=${id}`;
    case 'category':
      return `/transactions?categoryId=${id}`;
    case 'transaction':
      return `/transactions?targetTransactionId=${id}`;
    case 'security':
      return `/securities?highlight=${id}`;
    case 'scheduled':
      return `/bills?highlight=${id}`;
    default:
      return null;
  }
}
