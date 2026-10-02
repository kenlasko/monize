/**
 * The longest consent Monize asks a bank for, whatever the bank would allow.
 * Mirrors `MAX_CONSENT_VALIDITY_DAYS` on the server, which is what asks for
 * `min(the bank's maximum, 180 days)`; the client never sends a validity.
 */
export const MAX_CONSENT_VALIDITY_DAYS = 180;

/**
 * The consent length to tell the reader about, in whole days: the bank's stated
 * maximum capped at what the server requests. `null` when the bank stated none
 * (or nothing usable), so no length is claimed for a bank that did not give one.
 */
export function consentDaysToShow(maximumDays: number | null | undefined): number | null {
  if (typeof maximumDays !== 'number' || !Number.isFinite(maximumDays) || maximumDays <= 0) {
    return null;
  }
  return Math.min(Math.max(1, Math.floor(maximumDays)), MAX_CONSENT_VALIDITY_DAYS);
}
