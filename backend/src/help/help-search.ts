/**
 * Scores the bundled guide's sections against a typed query. Pure and
 * synchronous over the index `HelpService` loads once, so every caller --
 * the search endpoint, and later the assistant tool and the help menu's
 * search entry -- answers from the same ranking.
 */
import { escapeRegExp } from "../common/escape-regexp.util";

/** One section of the guide, as the search index lists it. */
export interface HelpSearchSection {
  /** The page's slug, the argument of `HelpService.getPage`. */
  page: string;
  /** The section's heading anchor, or `null` for a page's lead paragraph. */
  section: string | null;
  pageTitle: string;
  /** `''` for a page's lead paragraph, which the index gives no heading. */
  heading: string;
  /** Plain text, never Markdown or HTML. */
  text: string;
}

export interface HelpSearchResult {
  page: string;
  section: string | null;
  pageTitle: string;
  heading: string;
  /** About 160 characters of plain text around the first matched word. */
  excerpt: string;
  score: number;
}

export interface HelpSearchOptions {
  /** The screen's current help page; its sections are boosted. */
  contextPage?: string | null;
  /** Results to return; the match count may exceed this. */
  limit?: number;
}

export interface HelpSearchAnswer {
  results: HelpSearchResult[];
  total: number;
}

/** The single source of this default; `HelpSearchQueryDto` reads it too. */
export const HELP_SEARCH_DEFAULT_LIMIT = 10;
const EXCERPT_LENGTH = 160;
const EXCERPT_LEAD = 40;

// A heading match outranks a title match, which outranks a body match. A
// section matching every query token outranks one matching only some, which
// is by design: a context-boosted, full-coverage body match CAN outrank a
// heading match elsewhere that only covers some of the tokens ("all tokens
// beats some" takes precedence over the context boost's own "comparable
// matches" guarantee). For an equal-coverage comparison, though, the gap
// between heading and (title + body) is wide enough that the context boost
// can never turn a body-only match in the current screen into a win over a
// genuine heading match elsewhere; `help-search.spec.ts` pins exactly that
// comparison.
const HEADING_WEIGHT = 6;
const TITLE_WEIGHT = 3;
const BODY_WEIGHT = 1;
/** Every query token matched beats some of them matching. */
const FULL_COVERAGE_BONUS = 3;
/**
 * Enough to lead among otherwise-comparable matches (e.g. two body-only
 * matches, or two title matches) without coming close to a single heading
 * match's weight.
 */
const CONTEXT_BOOST = 2;

const STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "is",
  "are",
  "do",
  "does",
  "how",
  "to",
  "for",
  "of",
  "in",
  "on",
  "my",
  "i",
  "what",
]);

/**
 * Words the guide's vocabulary splits that a reader's query may not. Each
 * group is a set of tokens that count as the same word; grow it when a real
 * query misses (`in-app-help-search.md`).
 *
 * "Two-factor" is not here: "two" and "factor" are too generic to treat as
 * synonyms of "2FA" on their own (they match unrelated sections, like a
 * transfer's "two rows"). `PHRASE_NORMALIZATIONS` below folds the whole
 * phrase, "2FA" and "TOTP" into one token instead.
 */
const SYNONYM_GROUPS: readonly (readonly string[])[] = [
  ["chequing", "checking"],
  ["recurring", "scheduled", "bills"],
  // "security" is not in this group: the guide uses that word for account
  // security (2FA, headers, "Settings and Security") far more than for a
  // tradable instrument, so adding it here made "stock" and "holding" match
  // those unrelated sections instead (verified against the real guide).
  ["stock", "holding"],
  ["split", "splits"],
  ["import", "upload"],
];

const SYNONYMS = new Map<string, readonly string[]>();
for (const group of SYNONYM_GROUPS) {
  for (const token of group) {
    SYNONYMS.set(token, group);
  }
}

/** Phrases folded to one token before splitting, so they match as a unit. */
const PHRASE_NORMALIZATIONS: readonly [RegExp, string][] = [
  [/\btwo[\s-]*factor\b/g, "twofactor"],
  [/\b2fa\b/g, "twofactor"],
  [/\btotp\b/g, "twofactor"],
];

/** Lower-cased, with combining marks stripped, so accents are ignored. */
function foldCase(text: string): string {
  const folded = text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
  return PHRASE_NORMALIZATIONS.reduce(
    (result, [pattern, replacement]) => result.replace(pattern, replacement),
    folded,
  );
}

/** Splits folded text on anything that is not a letter or a digit. */
function tokenize(text: string): string[] {
  return foldCase(text)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

/**
 * The query's tokens, in order, with the stop-word list applied -- unless
 * every token is a stop word, in which case none are dropped, so a query of
 * only common words still searches on something.
 */
function queryTokens(query: string): string[] {
  const tokens = tokenize(query);
  const kept = tokens.filter((token) => !STOP_WORDS.has(token));
  return kept.length > 0 ? kept : tokens;
}

/**
 * Whether `token` (or a synonym of it) appears in `fieldTokens`: an exact
 * match, or, when `prefix` is set, a prefix match too -- used for the
 * query's last token so results appear while it is still being typed.
 */
function tokenMatches(
  fieldTokens: readonly string[],
  token: string,
  prefix: boolean,
): boolean {
  const candidates = SYNONYMS.get(token) ?? [token];
  for (const candidate of candidates) {
    for (const fieldToken of fieldTokens) {
      if (fieldToken === candidate) return true;
      if (prefix && candidate.length > 0 && fieldToken.startsWith(candidate)) {
        return true;
      }
    }
  }
  return false;
}

interface Tokenized {
  raw: HelpSearchSection;
  heading: string[];
  title: string[];
  body: string[];
}

/**
 * Keyed on the section object itself, which `HelpService` builds once and
 * reuses for every search: the real caller's sections never change, so this
 * turns the repeated cost of tokenizing the whole bundled guide (NFKD,
 * phrase folding, a regex split, for every section's heading, title and
 * body) into a one-time cost, paid on the first search after the bundle
 * loads. A test's own fixture sections cache independently of each other and
 * of the real bundle's, since they are different objects.
 */
const tokenCache = new WeakMap<HelpSearchSection, Tokenized>();

function tokenizeSection(section: HelpSearchSection): Tokenized {
  const cached = tokenCache.get(section);
  if (cached) return cached;
  const entry: Tokenized = {
    raw: section,
    heading: tokenize(section.heading),
    title: tokenize(section.pageTitle),
    body: tokenize(section.text),
  };
  tokenCache.set(section, entry);
  return entry;
}

/**
 * Every literal spelling that could appear in raw text for a normalized query
 * token -- the token itself, its synonym group, and (for the one token
 * `PHRASE_NORMALIZATIONS` folds several spellings into) those spellings. A
 * result found only through a synonym or a folded phrase would otherwise
 * anchor its excerpt on nothing, since none of those spellings literally
 * occur in the token's own folded form.
 */
function excerptCandidates(token: string): readonly string[] {
  const candidates = SYNONYMS.get(token) ?? [token];
  if (token === "twofactor") {
    return [...candidates, "two-factor", "two factor", "2fa", "totp"];
  }
  return candidates;
}

/** Builds an excerpt of plain text around the first matched token, bounded to about `EXCERPT_LENGTH` characters. */
function buildExcerpt(text: string, tokens: readonly string[]): string {
  if (text.length <= EXCERPT_LENGTH) return text;
  // Searched case-insensitively directly against `text`, never a folded
  // copy of it: any transform that can change a string's length (NFKD's
  // ligatures and fractions, but also plain `toLowerCase()`'s few
  // expansions, like Turkish "İ") would misalign an index found in that
  // copy against the untouched `text` being sliced here. Losing an
  // accent-insensitive match this way only widens the excerpt window to the
  // start of the text; it never misaligns it.
  let matchIndex = -1;
  for (const token of tokens) {
    if (token.length === 0) continue;
    for (const candidate of excerptCandidates(token)) {
      const index = text.search(new RegExp(escapeRegExp(candidate), "i"));
      if (index !== -1 && (matchIndex === -1 || index < matchIndex)) {
        matchIndex = index;
      }
    }
  }
  const anchor = matchIndex === -1 ? 0 : matchIndex;
  const start = Math.max(0, anchor - EXCERPT_LEAD);
  const end = Math.min(text.length, start + EXCERPT_LENGTH);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end).trim()}${suffix}`;
}

function scoreSection(
  entry: Tokenized,
  tokens: readonly string[],
  contextPage: string | null | undefined,
): number {
  let score = 0;
  let matchedAll = true;
  let matchedAny = false;
  const lastIndex = tokens.length - 1;

  for (let i = 0; i <= lastIndex; i++) {
    const token = tokens[i];
    const prefix = i === lastIndex;
    if (tokenMatches(entry.heading, token, prefix)) {
      score += HEADING_WEIGHT;
      matchedAny = true;
    } else if (tokenMatches(entry.title, token, prefix)) {
      score += TITLE_WEIGHT;
      matchedAny = true;
    } else if (tokenMatches(entry.body, token, prefix)) {
      score += BODY_WEIGHT;
      matchedAny = true;
    } else {
      matchedAll = false;
    }
  }

  if (!matchedAny) return 0;
  if (matchedAll) score += FULL_COVERAGE_BONUS;
  if (contextPage && entry.raw.page === contextPage) score += CONTEXT_BOOST;
  return score;
}

/**
 * Ranks `sections` against `query`. Deterministic: ties keep the sections'
 * original order (the order `HelpService` loaded them in), so repeating the
 * same query always answers the same list.
 */
export function searchHelp(
  sections: readonly HelpSearchSection[],
  query: string,
  options: HelpSearchOptions = {},
): HelpSearchAnswer {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return { results: [], total: 0 };

  const limit = options.limit ?? HELP_SEARCH_DEFAULT_LIMIT;
  const contextPage = options.contextPage;

  const scored: { entry: Tokenized; score: number; order: number }[] = [];
  sections.forEach((section, order) => {
    const entry = tokenizeSection(section);
    const score = scoreSection(entry, tokens, contextPage);
    if (score > 0) scored.push({ entry, score, order });
  });

  scored.sort((a, b) => b.score - a.score || a.order - b.order);

  const results = scored.slice(0, limit).map(({ entry, score }) => ({
    page: entry.raw.page,
    section: entry.raw.section,
    pageTitle: entry.raw.pageTitle,
    heading: entry.raw.heading,
    excerpt: buildExcerpt(entry.raw.text, tokens),
    score,
  }));

  return { results, total: scored.length };
}
