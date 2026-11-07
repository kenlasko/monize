/** One run of `text`, `match` when it is (part of) a typed term. */
export interface HighlightSegment {
  text: string;
  match: boolean;
}

/**
 * Splits `text` into segments by whether each run falls inside one of
 * `terms` (case-insensitive, whole terms only -- no partial-character
 * highlighting). No regular expression: `terms` comes from what a person
 * typed, so it is matched with plain substring scans rather than built into
 * a pattern.
 */
export function highlightMatches(text: string, terms: readonly string[]): HighlightSegment[] {
  const needles = terms.map((t) => t.toLowerCase()).filter((t) => t.length > 0);
  if (needles.length === 0) return [{ text, match: false }];

  const lower = text.toLowerCase();
  const segments: HighlightSegment[] = [];
  let i = 0;
  let runStart = 0;

  const matchLengthAt = (index: number): number => {
    let longest = 0;
    for (const needle of needles) {
      if (lower.startsWith(needle, index)) longest = Math.max(longest, needle.length);
    }
    return longest;
  };

  while (i < text.length) {
    const length = matchLengthAt(i);
    if (length > 0) {
      if (i > runStart) segments.push({ text: text.slice(runStart, i), match: false });
      segments.push({ text: text.slice(i, i + length), match: true });
      i += length;
      runStart = i;
    } else {
      i++;
    }
  }
  if (runStart < text.length) segments.push({ text: text.slice(runStart), match: false });
  return segments;
}
