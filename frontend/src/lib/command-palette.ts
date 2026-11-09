import { highlightMatches, type HighlightSegment } from '@/lib/helpers/highlight-matches';

/** Result groups, in the order the palette draws them. */
export const COMMAND_GROUPS = [
  'accounts',
  'payees',
  'categories',
  'bills',
  'securities',
  'reports',
  'pages',
  'transactions',
  'help',
  'actions',
] as const;

export type CommandGroup = (typeof COMMAND_GROUPS)[number];

/** Lower case with combining marks removed, so "cafe" finds "Café". */
function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** The typed query as the terms `matchScore` compares. */
export function commandTerms(query: string): string[] {
  return fold(query).split(/\s+/).filter(Boolean);
}

/**
 * How well `text` answers `terms`: 0 unless every term is found. A term at the
 * very start counts more than one at the start of a later word, which counts
 * more than one inside a word.
 */
export function matchScore(text: string, terms: readonly string[]): number {
  const haystack = fold(text);
  const words = haystack.split(/[^\p{L}\p{N}]+/u);
  let score = 0;
  for (const term of terms) {
    if (!haystack.includes(term)) return 0;
    if (haystack.startsWith(term)) score += 3;
    else if (words.some((word) => word.startsWith(term))) score += 2;
    else score += 1;
  }
  return score;
}

/**
 * `highlightMatches` for folded `terms`, so a match `matchScore` accepted is the
 * one that gets marked. Folded one code unit at a time, keeping any unit whose
 * fold is not exactly one unit, so an offset in the folded text is an offset in
 * `text`.
 */
export function highlightFolded(text: string, terms: readonly string[]): HighlightSegment[] {
  const folded = text
    .split('')
    .map((unit) => {
      const f = fold(unit);
      return f.length === 1 ? f : unit;
    })
    .join('');
  let at = 0;
  return highlightMatches(folded, terms).map((segment) => {
    const original = text.slice(at, at + segment.text.length);
    at += segment.text.length;
    return { text: original, match: segment.match };
  });
}

/** The best `limit` of `items` for `terms`, ties kept in their given order. */
export function topMatches<T>(
  items: readonly T[],
  textOf: (item: T) => string,
  terms: readonly string[],
  limit: number,
): T[] {
  return items
    .map((item) => ({ item, score: matchScore(textOf(item), terms) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ item }) => item);
}

/** Whole days from `today` to `date`, both `YYYY-MM-DD`; negative when past. */
export function daysUntil(date: string, today: string): number {
  const utc = (ymd: string) => {
    const [year, month, day] = ymd.split('-').map(Number);
    return Date.UTC(year, month - 1, day);
  };
  return Math.round((utc(date) - utc(today)) / 86_400_000);
}
