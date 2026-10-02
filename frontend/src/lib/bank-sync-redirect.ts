import { toSafeExternalUrl } from './external-url';

/**
 * The bank's authorization address, if it is safe to send the browser to, else
 * null.
 *
 * The address comes from the server, which got it from the provider, and the
 * next thing done with it is `location.assign` -- so a `javascript:` or `data:`
 * value would run here. `toSafeExternalUrl` admits http and https; a consent
 * page for a bank is https or it is not one worth sending a customer to, so the
 * plain-http case is refused as well.
 */
export function safeAuthorizationUrl(
  url: string | null | undefined,
): string | null {
  const safe = toSafeExternalUrl(url);
  return safe && /^https:\/\//i.test(safe) ? safe : null;
}
