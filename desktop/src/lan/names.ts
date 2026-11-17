/**
 * The names local-network access answers on (docs/future-plans/
 * desktop-lan-access.md, L5, L7 and L8): the mDNS label the app claims for
 * itself, `monize` first and then `monize-2`, `monize-3` and so on when
 * another device on the network holds it, and the computer's own name, which
 * Windows answers for under `.local`.
 */

export const MDNS_DOMAIN = "local";
export const DEFAULT_MDNS_LABEL = "monize";

/** How far the suffix goes before the claim gives up. */
export const MAX_MDNS_SUFFIX = 99;

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** One DNS label: lower case letters, digits and inner hyphens, 1 to 63 long. */
export function isMdnsLabel(value: unknown): value is string {
  return typeof value === "string" && LABEL.test(value);
}

/** `monize`, `monize-2`, ... `monize-99`. */
export function mdnsCandidate(index: number): string {
  return index <= 1 ? DEFAULT_MDNS_LABEL : `${DEFAULT_MDNS_LABEL}-${index}`;
}

/**
 * The labels to try, in order: the one claimed last time first, so the
 * origin stays what devices already know, then the default sequence.
 */
export function mdnsCandidates(persisted: string | null): readonly string[] {
  const sequence = Array.from({ length: MAX_MDNS_SUFFIX }, (_, i) =>
    mdnsCandidate(i + 1),
  );
  return persisted === null || !isMdnsLabel(persisted)
    ? sequence
    : [persisted, ...sequence.filter((label) => label !== persisted)];
}

export function localName(label: string): string {
  return `${label}.${MDNS_DOMAIN}`;
}

/**
 * The computer's name as a `.local` label, or null when it cannot be one
 * (Windows allows characters DNS does not). Windows compares names without
 * case, and DNS does too, so it is lower-cased.
 */
export function computerLabel(hostname: string): string | null {
  const label = hostname.trim().toLowerCase().split(".")[0] ?? "";
  return isMdnsLabel(label) ? label : null;
}
