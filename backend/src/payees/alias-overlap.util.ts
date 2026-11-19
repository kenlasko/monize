import { matchesAliasPattern } from "./alias-match.util";

function normalizePattern(alias: string): string {
  return alias.replace(/\*{2,}/g, "*").toLowerCase();
}

/**
 * The refusal `PayeesService.createAlias` applies (and the auto-merge alias
 * writer, and the KMyMoney import): two aliases conflict when they are equal
 * ignoring case or when either one, read as a text, matches the other as a
 * pattern. Symmetric.
 */
export function aliasesConflict(a: string, b: string): boolean {
  return (
    a.toLowerCase() === b.toLowerCase() ||
    matchesAliasPattern(a, b) ||
    matchesAliasPattern(b, a)
  );
}

/**
 * True when some text matches both aliases (so a lookup of that text has two
 * candidate payees). Exact, not a heuristic: two literals overlap when equal;
 * a literal and a glob when the glob matches the literal; two globs exactly
 * when one literal prefix (before the first `*`) is a prefix of the other and
 * one literal suffix (after the last `*`) is a suffix of the other. The text
 * "longer prefix + a's middle segments + b's middle segments + longer suffix"
 * matches both; without compatible prefixes (or suffixes) no text can start
 * (or end) with both. Linear in the pattern lengths.
 */
export function aliasesCanOverlap(a: string, b: string): boolean {
  const left = normalizePattern(a);
  const right = normalizePattern(b);
  const leftGlob = left.includes("*");
  const rightGlob = right.includes("*");
  if (!leftGlob && !rightGlob) {
    return left === right;
  }
  if (!leftGlob) {
    return matchesAliasPattern(left, right);
  }
  if (!rightGlob) {
    return matchesAliasPattern(right, left);
  }
  const prefixA = left.slice(0, left.indexOf("*"));
  const prefixB = right.slice(0, right.indexOf("*"));
  const suffixA = left.slice(left.lastIndexOf("*") + 1);
  const suffixB = right.slice(right.lastIndexOf("*") + 1);
  const prefixesCompatible =
    prefixA.startsWith(prefixB) || prefixB.startsWith(prefixA);
  const suffixesCompatible =
    suffixA.endsWith(suffixB) || suffixB.endsWith(suffixA);
  return prefixesCompatible && suffixesCompatible;
}
