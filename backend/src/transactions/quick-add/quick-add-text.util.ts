/**
 * The text model the Quick Add reader works on (`docs/future-plans/quick-add.md`,
 * "Reading the text", step 1): the typed line as code points ("units"), each
 * with its comparison fold, and the boundary rule a name must meet.
 *
 * Folding is for comparison only. NFKC first (full-width digits and kana
 * become their ordinary forms), then case in the reader's locale, then the
 * diacritics of Latin, Greek and Cyrillic letters (`cafe` finds `Café`).
 * Combining marks are never stripped from kana, Hangul, Han or any other
 * script, so `が` stays `が`. The typed line is folded unit by unit, for its
 * offsets; a candidate name is folded whole (`foldForComparison`) by the same
 * rule, so a name and the text it appears in always fold alike.
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
const TYPOGRAPHIC_APOSTROPHES = /[’‘ʼ]/gu;
const FINAL_SIGMA = /ς/gu;
/** Whitespace other than the space character. */
const OTHER_WHITESPACE = /[^\S ]/u;

/**
 * The longest line Quick Add reads, in code points after
 * {@link normalizeQuickAddText}: NFKC can turn one typed character into
 * eighteen (U+FDFA), so the cap is held on what the reader works on, not on
 * what was sent (`docs/future-plans/quick-add.md`, "Bounds").
 */
export const QUICK_ADD_TEXT_MAX_LENGTH = 200;

/**
 * The most words the reader reads; the rest of the line is not read. Every
 * step's work grows with the words (a wildcard alias is tried against each
 * run of up to six of them), and a 200-character line of ordinary words is
 * about 35; 40 leaves room for short ones without letting a line of
 * one-letter words multiply the work.
 */
export const QUICK_ADD_MAX_WORDS = 40;

/** Whether `value` holds whitespace other than single spaces between words. */
function hasUnevenSpace(value: string): boolean {
  return (
    value.startsWith(" ") ||
    value.endsWith(" ") ||
    value.includes("  ") ||
    OTHER_WHITESPACE.test(value)
  );
}

/** Every run of whitespace as one space, trimmed. */
function evenSpaces(value: string): string {
  return hasUnevenSpace(value) ? value.replace(/\s+/gu, " ").trim() : value;
}

/** NFKC, every run of whitespace as one space, trimmed. */
export function normalizeQuickAddText(raw: string): string {
  return evenSpaces(raw.normalize("NFKC"));
}

/** The line as the reader reads it: normalized, cut to the word and length caps. */
export function boundedQuickAddText(raw: string): string {
  const words = normalizeQuickAddText(raw).split(" ");
  const kept = words.slice(0, QUICK_ADD_MAX_WORDS).join(" ");
  return [...kept].slice(0, QUICK_ADD_TEXT_MAX_LENGTH).join("").trimEnd();
}

export function isCjkChar(ch: string): boolean {
  return CJK_CHAR.test(ch);
}

/**
 * The languages whose lower case differs from the root's: ECMA-402 lower-cases
 * by Unicode's SpecialCasing, whose only language rules for lower case are
 * Lithuanian's, Turkish's and Azeri's. Every other locale lower-cases exactly
 * as `toLowerCase` does, which is the cheaper call on a long string.
 */
const LOCALE_LOWER_CASE_LANGUAGES = new Set(["az", "lt", "tr"]);
/** Per locale (the request locales, a fixed set): whether it has its own lower case. */
const HAS_OWN_LOWER_CASE = new Map<string, boolean>();

function hasOwnLowerCase(locale: string): boolean {
  const known = HAS_OWN_LOWER_CASE.get(locale);
  if (known !== undefined) return known;
  let own: boolean;
  try {
    own = LOCALE_LOWER_CASE_LANGUAGES.has(new Intl.Locale(locale).language);
  } catch {
    // `toLocaleLowerCase` refuses the tag too: `lowerInLocale` falls back.
    own = false;
  }
  HAS_OWN_LOWER_CASE.set(locale, own);
  return own;
}

function lowerInLocale(value: string, locale: string): string {
  if (!hasOwnLowerCase(locale)) return value.toLowerCase();
  try {
    return value.toLocaleLowerCase(locale);
  } catch {
    return value.toLowerCase();
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

const PRINTABLE_ASCII = /^[\x20-\x7e\t\n\v\f\r]*$/u;

/** What a code point is to the diacritic fold (`foldUnit`'s cases). */
const OTHER = 1;
const MARK = 2;
/** A Latin, Greek or Cyrillic letter with no diacritic of its own. */
const FOLDABLE = 3;
/** A Latin, Greek or Cyrillic letter carrying one (`é`): NFD differs. */
const FOLDABLE_WITH_DIACRITIC = 4;

/**
 * Each code point's class, decided the first time the process meets it by
 * the regular expressions `foldUnit` uses; 0 is not yet decided. A fixed
 * table over every code point, so no name can make it grow.
 */
const CLASSES = new Uint8Array(0x110000);
/**
 * A letter of {@link FOLDABLE_WITH_DIACRITIC} without its diacritics: at most
 * one entry per such letter Unicode has.
 */
const WITHOUT_DIACRITICS = new Map<number, string>();

function classify(codePoint: number): number {
  const ch = String.fromCodePoint(codePoint);
  if (COMBINING_MARK.test(ch)) return MARK;
  if (!FOLDABLE_SCRIPT.test(ch)) return OTHER;
  return ch.normalize("NFD") === ch ? FOLDABLE : FOLDABLE_WITH_DIACRITIC;
}

function classOf(codePoint: number): number {
  const known = CLASSES[codePoint];
  if (known !== 0) return known;
  const decided = classify(codePoint);
  CLASSES[codePoint] = decided;
  return decided;
}

function withoutDiacritics(codePoint: number): string {
  const known = WITHOUT_DIACRITICS.get(codePoint);
  if (known !== undefined) return known;
  const bare = String.fromCodePoint(codePoint)
    .normalize("NFD")
    .replace(COMBINING_MARKS, "")
    .normalize("NFC");
  WITHOUT_DIACRITICS.set(codePoint, bare);
  return bare;
}

/**
 * `lower` without the diacritics of its Latin, Greek and Cyrillic letters and
 * without a combining mark that follows one: `unitsOf`'s rule, in one pass
 * over the string with each code point's class looked up, never a regular
 * expression or a normalization per character.
 */
function stripFoldableDiacritics(lower: string): string {
  let out = "";
  let from = 0;
  let foldableBase = false;
  for (let i = 0; i < lower.length;) {
    const codePoint = lower.codePointAt(i)!;
    const size = codePoint > 0xffff ? 2 : 1;
    const kind = classOf(codePoint);
    if (kind === MARK) {
      if (foldableBase) {
        out += lower.slice(from, i);
        from = i + size;
      }
    } else {
      foldableBase = kind === FOLDABLE || kind === FOLDABLE_WITH_DIACRITIC;
      if (kind === FOLDABLE_WITH_DIACRITIC) {
        out += lower.slice(from, i) + withoutDiacritics(codePoint);
        from = i + size;
      }
    }
    i += size;
  }
  return from === 0 ? lower : out + lower.slice(from);
}

/**
 * The comparison fold of a whole string (a candidate name, a vocabulary word):
 * the answer the typed line's units give for the same text, by whole-string
 * operations (`docs/future-plans/quick-add.md`, "Bounds"). NFKC, the
 * typographic apostrophes and the case are folded over the whole string, and
 * the diacritics in one pass ({@link stripFoldableDiacritics}).
 *
 * Lower-casing the whole string agrees with lower-casing each character
 * because the only mappings that look at a neighbour are the final sigma,
 * folded to `σ` either way, and the Lithuanian, Turkish and Azeri dotted `i`,
 * whose dot is a combining mark after a Latin letter and dropped either way
 * (`quick-add-bounds.spec.ts` holds the two folds equal).
 *
 * Printable ASCII takes a shorter path with the same answer: NFKC leaves it
 * unchanged, it holds no combining mark, diacritic or typographic apostrophe,
 * and lower-casing it whole in the locale is lower-casing each character
 * (Turkish `I` becomes `ı` either way).
 */
export function foldForComparison(value: string, locale: string): string {
  if (PRINTABLE_ASCII.test(value)) {
    return lowerInLocale(evenSpaces(value), locale);
  }
  const lower = lowerInLocale(
    normalizeQuickAddText(value).replace(TYPOGRAPHIC_APOSTROPHES, "'"),
    locale,
  );
  return stripFoldableDiacritics(
    lower.includes("ς") ? lower.replace(FINAL_SIGMA, "σ") : lower,
  );
}

const PUNCTUATION_OR_SYMBOL = /[\p{P}\p{S}]/u;
const PUNCTUATION_OR_SYMBOLS = /[\p{P}\p{S}]/gu;

/**
 * A folded name without its punctuation and symbols, spaces evened: the
 * spelling a reader types when they leave the apostrophe out (`zehrs` for
 * `Zehr's`). The same string when the name holds none.
 */
export function withoutPunctuation(folded: string): string {
  if (!PUNCTUATION_OR_SYMBOL.test(folded)) return folded;
  return evenSpaces(folded.replace(PUNCTUATION_OR_SYMBOLS, ""));
}

/** The typed line's text model, within {@link boundedQuickAddText}'s caps. */
export function buildQuickAddText(raw: string, locale: string): QuickAddText {
  const units = unitsOf(boundedQuickAddText(raw), locale);
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
 * Where an occurrence of a folded phrase `length` long at index `at` of the
 * folded line ends, in units, or -1 when it does not start and end on whole
 * units and on word boundaries, or covers a used unit.
 */
function occurrenceEnd(
  text: QuickAddText,
  at: number,
  length: number,
  used: readonly boolean[],
): number {
  const start = text.unitAt[at];
  if (text.foldedStart[start] !== at) return -1;
  const lastFolded = at + length - 1;
  const lastUnit = text.unitAt[lastFolded];
  const lastEnds =
    text.foldedStart[lastUnit] + text.units[lastUnit].folded.length;
  if (lastEnds !== lastFolded + 1) return -1;
  let end = lastUnit + 1;
  // A stripped combining mark folds to nothing and belongs to its letter.
  while (end < text.units.length && text.units[end].folded === "") end++;
  if (!onWordBoundaries(text, start, end)) return -1;
  if (!isSpanFree(used, start, end)) return -1;
  return end;
}

/** Whether `phrase` (already folded) can be looked for at all. */
function isSearchable(phrase: string): boolean {
  return phrase !== "" && phrase.trim() === phrase;
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
  if (!isSearchable(phrase)) return found;
  for (
    let at = text.folded.indexOf(phrase);
    at !== -1;
    at = text.folded.indexOf(phrase, at + 1)
  ) {
    const end = occurrenceEnd(text, at, phrase.length, used);
    if (end !== -1) found.push({ start: text.unitAt[at], end });
  }
  return found;
}

/**
 * The first `limit` occurrences of `phrase` that {@link findPhrase} would
 * find, leftmost first and never two that overlap each other. Two
 * occurrences of one name that overlap can never both be chosen by
 * {@link selectLongest}, so the line holds no more of these than it holds
 * copies of the name side by side (`ああ` in two hundred `あ` has a hundred,
 * where {@link findPhrase} finds 199), and `limit` bounds them further.
 */
export function findOccurrences(
  text: QuickAddText,
  phrase: string,
  used: readonly boolean[],
  limit: number,
): UnitSpan[] {
  const found: UnitSpan[] = [];
  if (limit <= 0 || !isSearchable(phrase)) return found;
  let at = text.folded.indexOf(phrase);
  while (at !== -1) {
    const end = occurrenceEnd(text, at, phrase.length, used);
    if (end === -1) {
      at = text.folded.indexOf(phrase, at + 1);
      continue;
    }
    found.push({ start: text.unitAt[at], end });
    if (found.length >= limit) break;
    // Past the whole occurrence: the next one starts at or after `end`.
    at = text.folded.indexOf(phrase, at + phrase.length);
  }
  return found;
}

/**
 * The longest spans first, then the earliest, never two that overlap each
 * other or a used unit. Items sharing one span are returned together. Every
 * span lies within `used`.
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
  // A span as one number, `start * stride + end`: no key string per item.
  const stride = used.length + 1;
  const byKey = new Map<number, { span: UnitSpan; items: T[] }>();
  for (const item of sorted) {
    const key = item.span.start * stride + item.span.end;
    const same = byKey.get(key);
    if (same) {
      same.items.push(item);
      continue;
    }
    if (!isSpanFree(taken, item.span.start, item.span.end)) continue;
    for (let i = item.span.start; i < item.span.end; i++) taken[i] = true;
    const group = { span: item.span, items: [item] };
    groups.push(group);
    byKey.set(key, group);
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
