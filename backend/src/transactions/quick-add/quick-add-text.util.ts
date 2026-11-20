/**
 * The text model the Quick Add reader works on (`docs/future-plans/quick-add.md`,
 * "Reading the text", step 1): the typed line as code points ("units"), each
 * with its comparison fold, and the boundary rule a name must meet.
 *
 * Folding is for comparison only. NFKC first (full-width digits and kana
 * become their ordinary forms), then case in the reader's locale, then the
 * diacritics of Latin, Greek and Cyrillic letters (`cafe` finds `Café`).
 * Combining marks are never stripped from kana, Hangul, Han or any other
 * script, so `が` stays `が`. Candidate names go through the same per-unit
 * fold, so a name and the text it appears in always fold alike.
 */

export interface TextUnit {
  /** The code point as typed (after NFKC). */
  readonly text: string;
  /** Its comparison fold; empty for a stripped combining mark. */
  readonly folded: string;
  readonly space: boolean;
  /** A letter, digit or mark: part of a word. */
  readonly word: boolean;
  /** Han, kana or Hangul, where a name may start and end anywhere. */
  readonly cjk: boolean;
}

export interface QuickAddText {
  readonly units: readonly TextUnit[];
  /** Every unit's fold, concatenated. */
  readonly folded: string;
  /** For each unit, where its fold starts in `folded`. */
  readonly foldedStart: readonly number[];
  /** For each index of `folded`, the unit it came from. */
  readonly unitAt: readonly number[];
}

/** A half-open range of units, `[start, end)`. */
export interface UnitSpan {
  readonly start: number;
  readonly end: number;
}

const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u;
const CJK_CHAR =
  /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}]/u;
const FOLDABLE_SCRIPT =
  /[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}]/u;
const COMBINING_MARK = /\p{M}/u;
const COMBINING_MARKS = /\p{M}/gu;
const APOSTROPHES = new Set(["’", "‘", "ʼ"]);

/** NFKC, every run of whitespace as one space, trimmed. */
export function normalizeQuickAddText(raw: string): string {
  return raw.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

export function isCjkChar(ch: string): boolean {
  return CJK_CHAR.test(ch);
}

function lowerInLocale(ch: string, locale: string): string {
  try {
    return ch.toLocaleLowerCase(locale);
  } catch {
    return ch.toLowerCase();
  }
}

/**
 * The fold of one code point. `foldableBase` says whether the letter a
 * combining mark sits on is Latin, Greek or Cyrillic.
 */
function foldUnit(ch: string, locale: string, foldableBase: boolean): string {
  if (COMBINING_MARK.test(ch)) return foldableBase ? "" : ch;
  if (APOSTROPHES.has(ch)) return "'";
  const lower = lowerInLocale(ch, locale);
  const sigma = lower === "ς" ? "σ" : lower;
  if (!FOLDABLE_SCRIPT.test(ch)) return sigma;
  return sigma.normalize("NFD").replace(COMBINING_MARKS, "").normalize("NFC");
}

/** The units of an already normalized string. */
function unitsOf(normalized: string, locale: string): TextUnit[] {
  const units: TextUnit[] = [];
  let foldableBase = false;
  for (const ch of normalized) {
    const mark = COMBINING_MARK.test(ch);
    if (!mark) foldableBase = FOLDABLE_SCRIPT.test(ch);
    units.push({
      text: ch,
      folded: foldUnit(ch, locale, foldableBase),
      space: ch === " ",
      word: WORD_CHAR.test(ch),
      cjk: CJK_CHAR.test(ch),
    });
  }
  return units;
}

/** The comparison fold of a whole string (a candidate name, a vocabulary word). */
export function foldForComparison(value: string, locale: string): string {
  return unitsOf(normalizeQuickAddText(value), locale)
    .map((unit) => unit.folded)
    .join("");
}

export function buildQuickAddText(raw: string, locale: string): QuickAddText {
  const units = unitsOf(normalizeQuickAddText(raw), locale);
  const foldedStart: number[] = [];
  const unitAt: number[] = [];
  let folded = "";
  for (const [index, unit] of units.entries()) {
    foldedStart.push(folded.length);
    for (let i = 0; i < unit.folded.length; i++) unitAt.push(index);
    folded += unit.folded;
  }
  return { units, folded, foldedStart, unitAt };
}

/** The typed text of a span. */
export function spanText(text: QuickAddText, span: UnitSpan): string {
  return text.units
    .slice(span.start, span.end)
    .map((unit) => unit.text)
    .join("");
}

/** The folded text of a span. */
export function spanFolded(text: QuickAddText, span: UnitSpan): string {
  return text.units
    .slice(span.start, span.end)
    .map((unit) => unit.folded)
    .join("");
}

/**
 * Whether a match over `[start, end)` starts and ends on a word boundary. In
 * a script that separates words with spaces a match may not begin or end
 * inside a word; beside a Han, kana or Hangul character it may, so
 * `ローソンで500円` finds `ローソン`.
 */
export function onWordBoundaries(
  text: QuickAddText,
  start: number,
  end: number,
): boolean {
  const { units } = text;
  const before = start > 0 ? units[start - 1] : null;
  const first = units[start];
  const last = units[end - 1];
  const after = end < units.length ? units[end] : null;
  const startOk =
    !before || !before.word || !first.word || before.cjk || first.cjk;
  const endOk = !after || !after.word || !last.word || after.cjk || last.cjk;
  return startOk && endOk;
}

export function isSpanFree(
  used: readonly boolean[],
  start: number,
  end: number,
): boolean {
  for (let i = start; i < end; i++) if (used[i]) return false;
  return true;
}

/**
 * Every occurrence of `phrase` (already folded) in the free units of `text`
 * that starts and ends on whole units and on word boundaries.
 */
export function findPhrase(
  text: QuickAddText,
  phrase: string,
  used: readonly boolean[],
): UnitSpan[] {
  const found: UnitSpan[] = [];
  if (phrase === "" || phrase.trim() !== phrase) return found;
  const count = text.units.length;
  for (
    let at = text.folded.indexOf(phrase);
    at !== -1;
    at = text.folded.indexOf(phrase, at + 1)
  ) {
    const start = text.unitAt[at];
    const lastFolded = at + phrase.length - 1;
    const lastUnit = text.unitAt[lastFolded];
    if (text.foldedStart[start] !== at) continue;
    const lastEnds =
      text.foldedStart[lastUnit] + text.units[lastUnit].folded.length;
    if (lastEnds !== lastFolded + 1) continue;
    let end = lastUnit + 1;
    // A stripped combining mark folds to nothing and belongs to its letter.
    while (end < count && text.units[end].folded === "") end++;
    if (!onWordBoundaries(text, start, end)) continue;
    if (!isSpanFree(used, start, end)) continue;
    found.push({ start, end });
  }
  return found;
}

/**
 * The longest spans first, then the earliest, never two that overlap each
 * other or a used unit. Items sharing one span are returned together.
 */
export function selectLongest<T extends { span: UnitSpan }>(
  items: readonly T[],
  used: readonly boolean[],
): Array<{ span: UnitSpan; items: T[] }> {
  const sorted = [...items].sort(
    (a, b) =>
      b.span.end - b.span.start - (a.span.end - a.span.start) ||
      a.span.start - b.span.start,
  );
  const taken = [...used];
  const groups: Array<{ span: UnitSpan; items: T[] }> = [];
  for (const item of sorted) {
    const same = groups.find(
      (g) => g.span.start === item.span.start && g.span.end === item.span.end,
    );
    if (same) {
      same.items.push(item);
      continue;
    }
    if (!isSpanFree(taken, item.span.start, item.span.end)) continue;
    for (let i = item.span.start; i < item.span.end; i++) taken[i] = true;
    groups.push({ span: item.span, items: [item] });
  }
  return groups;
}

/** A maximal run of free, non-space units. */
export interface FreeToken extends UnitSpan {
  readonly text: string;
}

export function freeTokens(
  text: QuickAddText,
  used: readonly boolean[],
): FreeToken[] {
  const tokens: FreeToken[] = [];
  let start = -1;
  const close = (end: number) => {
    if (start === -1) return;
    tokens.push({ start, end, text: spanText(text, { start, end }) });
    start = -1;
  };
  for (const [index, unit] of text.units.entries()) {
    if (used[index] || unit.space) {
      close(index);
    } else if (start === -1) {
      start = index;
    }
  }
  close(text.units.length);
  return tokens;
}

/** Whether only one space separates `left` from `right` (no used unit between). */
export function separatedBySpace(
  text: QuickAddText,
  left: UnitSpan,
  right: UnitSpan,
): boolean {
  return right.start === left.end + 1 && text.units[left.end].space;
}

/** Marks a span used, returning the new mask. */
export function markUsed(used: readonly boolean[], span: UnitSpan): boolean[] {
  const next = [...used];
  for (let i = span.start; i < span.end; i++) next[i] = true;
  return next;
}

/** Whether a unit beside the span (touching it) is used. */
export function touchesUsed(used: readonly boolean[], span: UnitSpan): boolean {
  return (
    (span.start > 0 && used[span.start - 1]) ||
    (span.end < used.length && used[span.end])
  );
}
