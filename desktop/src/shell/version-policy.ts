/**
 * Which release the updater may offer. electron-updater already refuses an
 * equal or older version (`allowDowngrade` is false) and keys prereleases on
 * the running version; this is the shell's own check on top, so the rule does
 * not depend on how a release happens to be marked on GitHub:
 *
 * - never a downgrade, and never the running version again;
 * - a stable install is never offered a prerelease, even one published as a
 *   normal GitHub release by mistake;
 * - a prerelease install (`1.22.0-beta.1`) follows newer prereleases and the
 *   next stable release, which is electron-updater's own default for it.
 *
 * Semantic-version precedence (semver.org section 11), written out here
 * because `semver` is only a transitive dependency of electron-updater.
 */

interface Version {
  readonly core: readonly [number, number, number];
  /** Dot-separated prerelease identifiers; empty for a stable version. */
  readonly pre: readonly string[];
}

const VERSION =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function parseVersion(raw: string): Version | null {
  const match = VERSION.exec(raw.trim());
  if (match === null) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] === undefined ? [] : match[4].split("."),
  };
}

const NUMERIC = /^\d+$/;

function compareIdentifier(a: string, b: string): number {
  const aNumeric = NUMERIC.test(a);
  const bNumeric = NUMERIC.test(b);
  if (aNumeric && bNumeric) return Math.sign(Number(a) - Number(b));
  if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Negative, zero or positive as `a` precedes, equals or follows `b`. */
export function compareVersions(a: Version, b: Version): number {
  for (let i = 0; i < 3; i += 1) {
    if (a.core[i] !== b.core[i]) return Math.sign(a.core[i] - b.core[i]);
  }
  if (a.pre.length === 0 || b.pre.length === 0) {
    // A stable version follows every prerelease of the same core.
    return Math.sign(b.pre.length - a.pre.length);
  }
  const shared = Math.min(a.pre.length, b.pre.length);
  for (let i = 0; i < shared; i += 1) {
    const order = compareIdentifier(a.pre[i], b.pre[i]);
    if (order !== 0) return order;
  }
  return Math.sign(a.pre.length - b.pre.length);
}

/** electron-updater's `allowPrerelease`: only a prerelease install follows them. */
export function followsPrereleases(current: string): boolean {
  const parsed = parseVersion(current);
  return parsed !== null && parsed.pre.length > 0;
}

export type OfferDecision =
  | { readonly accept: true }
  | {
      readonly accept: false;
      readonly reason: "invalid" | "not-newer" | "prerelease-for-stable";
    };

export function decideOffer(current: string, offered: string): OfferDecision {
  const running = parseVersion(current);
  const candidate = parseVersion(offered);
  if (running === null || candidate === null) {
    return { accept: false, reason: "invalid" };
  }
  if (compareVersions(candidate, running) <= 0) {
    return { accept: false, reason: "not-newer" };
  }
  if (running.pre.length === 0 && candidate.pre.length > 0) {
    return { accept: false, reason: "prerelease-for-stable" };
  }
  return { accept: true };
}
