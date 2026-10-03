import {
  GlobCaptures,
  GlobToken,
  MAX_CAPTURE_VALUE_LENGTH,
  MAX_GLOB_LENGTH,
  matchGlobWithCaptures,
  parseGlob,
} from "../../transaction-rules/rule-glob-capture";

/**
 * Pattern matching for one receipt line. A rule glob captures the SHORTEST run
 * for every capture followed by a literal, which reads `{name} {amount}` on
 * "USB-C cable 19.98" as name "USB-C" and amount "cable 19.98". Receipt lines
 * rarely have a delimiter a name cannot contain, so two strategies run in turn:
 *
 * 1. the rules' own lazy matcher (`matchGlobWithCaptures`);
 * 2. when the caller does not accept its result (or it found none), a greedy
 *    reading of the same pattern: literals are found right to left, each at its
 *    rightmost position, so every capture takes the LONGEST run that lets the
 *    rest of the pattern match.
 *
 * Both are anchored, case-insensitive, linear in the line length per literal,
 * and build no regular expression from the pattern. The caller decides what is
 * usable through `accept` (an amount that parses, a non-empty name), so a
 * result the lazy strategy accepts is never changed by the greedy one.
 */

/** A wildcard between two literal segments. */
type Wild = Extract<GlobToken, { kind: "star" | "capture" }>;

interface Segments {
  /** lits[0] anchors the start and lits[last] the end; either may be "". */
  readonly lits: string[];
  /** gaps[i] lies between lits[i] and lits[i + 1]. */
  readonly gaps: Wild[][];
}

function toSegments(tokens: readonly GlobToken[]): Segments {
  const lits: string[] = [""];
  const gaps: Wild[][] = [];
  let pendingGap: Wild[] | null = null;
  for (const token of tokens) {
    if (token.kind === "literal") {
      if (pendingGap !== null) {
        gaps.push(pendingGap);
        lits.push(token.text.toLowerCase());
        pendingGap = null;
      } else {
        lits[lits.length - 1] += token.text.toLowerCase();
      }
    } else {
      pendingGap ??= [];
      pendingGap.push(token);
    }
  }
  if (pendingGap !== null) {
    gaps.push(pendingGap);
    lits.push("");
  }
  return { lits, gaps };
}

function clean(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > MAX_CAPTURE_VALUE_LENGTH
    ? trimmed.slice(0, MAX_CAPTURE_VALUE_LENGTH).trim()
    : trimmed;
}

/**
 * The greedy reading. Within a run of adjacent wildcards the LAST CAPTURE takes
 * the run and the others (stars included) take nothing, so `*order #{orderid}*`
 * captures the text after "order #" rather than an empty string.
 */
function matchGreedy(text: string, pattern: string): GlobCaptures | null {
  const parsed = parseGlob(pattern);
  // A pattern without a capture has nothing for this strategy to add.
  if (parsed.captureNames.length === 0) return null;
  const { lits, gaps } = toSegments(parsed.tokens);
  const lower = text.toLowerCase();
  // Case folding can change the length; slice the original text only when
  // the offsets still line up.
  const source = lower.length === text.length ? text : lower;

  const last = lits.length - 1;
  const head = lits[0];
  const tail = lits[last];
  if (!lower.startsWith(head) || !lower.endsWith(tail)) return null;
  const suffixStart = lower.length - tail.length;
  if (suffixStart < head.length) return null;

  // starts[i] is where literal i begins; the last one is the suffix.
  const starts: number[] = new Array<number>(lits.length).fill(0);
  starts[last] = suffixStart;
  let limit = suffixStart;
  for (let i = last - 1; i >= 1; i--) {
    const latest = limit - lits[i].length;
    if (latest < head.length) return null;
    const at = lower.lastIndexOf(lits[i], latest);
    if (at < head.length) return null;
    starts[i] = at;
    limit = at;
  }

  const out: Record<string, string> = Object.create(null);
  for (let i = 0; i < gaps.length; i++) {
    const begin = i === 0 ? head.length : starts[i] + lits[i].length;
    const names = gaps[i].flatMap((token) =>
      token.kind === "capture" ? [token.name] : [],
    );
    names.forEach((name, index) => {
      out[name] =
        index === names.length - 1
          ? clean(source.slice(begin, starts[i + 1]))
          : "";
    });
  }
  return Object.freeze(out);
}

/**
 * Match one line against one pattern: the rules' lazy reading first, then the
 * greedy one, each only as far as `accept` allows. Returns the captured values
 * (trimmed, at most 200 characters each) of the first reading `accept` takes,
 * or null when neither reading is usable. A line or pattern over 500
 * characters never matches.
 */
export function matchReceiptPattern(
  pattern: string,
  line: string,
  accept: (captures: GlobCaptures) => boolean,
): GlobCaptures | null {
  if (pattern.length > MAX_GLOB_LENGTH || line.length > MAX_GLOB_LENGTH) {
    return null;
  }
  const lazy = matchGlobWithCaptures(line, pattern);
  if (lazy !== null && accept(lazy)) return lazy;
  const greedy = matchGreedy(line, pattern);
  return greedy !== null && accept(greedy) ? greedy : null;
}
