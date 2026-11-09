import { isPublicPath } from '@/lib/public-paths';

/**
 * Which catalogs the root layout hands to `NextIntlClientProvider`.
 *
 * The provider's messages are serialized into every page's RSC payload, so
 * handing it every namespace put the whole application's copy (some 600 KB in
 * English) on the login and register screens, before anyone has signed in.
 * Signed-out pages get only what the app shell and the public pages use;
 * everything else gets every namespace.
 *
 * `client-messages.guard.test.ts` walks the import graph of the root layout and
 * every public page and fails when one of them reaches a namespace missing
 * here, so add the namespace it names rather than loosening the check.
 */
export const PUBLIC_CLIENT_NAMESPACES = [
  'ai',
  'auth',
  'common',
  'emergencyAccess',
  'help',
  'layout',
  'navigation',
  'notifications',
  'reportNames',
  'rules',
  'settings',
  'sharedExpenses',
  'tours',
  'transactions',
] as const;

/**
 * Request header carrying the pathname the proxy saw, so the root layout (which
 * Next does not give the URL) can pick a scope. Always overwritten by the proxy.
 */
export const PATHNAME_HEADER = 'x-pathname';

export type MessageScope = 'public' | 'full';

/**
 * A request the proxy did not see (a dotted path: the not-found page for
 * /foo.txt) carries no pathname and is treated as public.
 */
export function messageScopeFor(pathname: string | null): MessageScope {
  return pathname !== null && !isPublicPath(pathname) ? 'full' : 'public';
}

/**
 * Adds `reportNames`: just the report titles (`reports.page.names`), about 2 KB
 * of a 90 KB catalog. The command palette lists them from the app shell, and
 * anything the shell can import must be in the public list, where the whole
 * `reports` namespace would ship on the login screen.
 */
export function withReportNames<T extends Record<string, unknown>>(messages: T): T {
  const names = (messages as { reports?: { page?: { names?: unknown } } }).reports?.page?.names;
  return names ? { ...messages, reportNames: names } : messages;
}

export function messagesForScope<T extends Record<string, unknown>>(
  source: T,
  scope: MessageScope,
): Partial<T> {
  const messages = withReportNames(source);
  if (scope === 'full') return messages;
  const picked: Partial<T> = {};
  for (const namespace of PUBLIC_CLIENT_NAMESPACES) {
    if (namespace in messages) {
      picked[namespace as keyof T] = messages[namespace as keyof T];
    }
  }
  return picked;
}
