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
  'layout',
  'navigation',
  'notifications',
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

export function messagesForScope<T extends Record<string, unknown>>(
  messages: T,
  scope: MessageScope,
): Partial<T> {
  if (scope === 'full') return messages;
  const picked: Partial<T> = {};
  for (const namespace of PUBLIC_CLIENT_NAMESPACES) {
    if (namespace in messages) {
      picked[namespace as keyof T] = messages[namespace as keyof T];
    }
  }
  return picked;
}
