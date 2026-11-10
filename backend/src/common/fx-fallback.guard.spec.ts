import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

const SRC_ROOT = join(__dirname, "..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      out.push(...sourceFiles(full));
      continue;
    }
    if (!entry.endsWith(".ts") || entry.endsWith(".spec.ts")) continue;
    out.push(full);
  }
  return out;
}

/**
 * `1` as a fallback value: not the start of a longer number (`1.5`, `10`) and
 * not the numerator of a reciprocal (`1 / rate`, which is arithmetic, not a
 * default).
 */
const ONE = String.raw`1(?![\d.]|\s*/)`;

/**
 * A line that answers 1 for something named for a rate: `x ?? 1`, `x || 1`, or
 * an `a ? b : 1` assignment, with an identifier containing `rate` (any case)
 * to the left of it on the same line. The name is matched anywhere in the left
 * side, not as a word, so `exchangeRate`, `spotRate` and a call chain such as
 * `loaded.spotRate.get(key) ?? 1` are all seen; the earlier `\brate\w*` could
 * see none of them.
 *
 * A literal 1 for the same-currency case (`if (from === to) return 1;`) has no
 * `??`, `||` or ternary and does not match.
 */
const RATE_DEFAULTS_TO_ONE = new RegExp(
  String.raw`\w*rate\w*[^;]*?(?:\?\?|\|\|)\s*${ONE}` +
    "|" +
    String.raw`\w*rate\w*[^;]*?(?<!\?)\?(?![?.])[^;]*:\s*${ONE}`,
  "i",
);

/** A line without its `//` comment, so prose that quotes `?? 1` is not code. */
function codeOf(line: string): string {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("*") || trimmed.startsWith("/*")) return "";
  return line.replace(/\/\/.*$/, "");
}

/**
 * A silent currency-conversion fallback is a one-token mistake, so it gets a
 * scan rather than a paragraph.
 *
 * Audit finding P5-009: two conversion paths turned "no rate available" into
 * "rate 1.0" -- `return result ?? amount` and
 * `rate = reverseRate !== null ? 1 / reverseRate : 1`. 1,000 USD reported into
 * a EUR total came out as 1,000 EUR, an 11% overstatement that is numerically
 * plausible, and nothing in the response distinguished it from a genuine 1:1.
 *
 * The rule: a conversion returns `null` when it has no rate, and callers
 * accumulate through `FxAggregate`. Rate 1 is reachable only when the source
 * and destination currency codes are equal. See
 * `docs/specs/fx-conversion-completeness.md`.
 */
describe("currency conversion has no silent identity fallback", () => {
  const files = sourceFiles(SRC_ROOT);

  it("finds source files to scan", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("never falls back from a failed conversion to the input amount", () => {
    const offenders: string[] = [];

    for (const file of files) {
      const rel = relative(SRC_ROOT, file).split("\\").join("/");
      const lines = readFileSync(file, "utf8").split("\n");
      for (const [index, line] of lines.entries()) {
        // `?? amount`, `|| amount`, `?? value` right where a conversion result
        // is consumed -- the exact shape of the removed defect.
        if (/(\?\?|\|\|)\s*(amount|rawValue|value)\s*;?\s*$/.test(line)) {
          const context = lines
            .slice(Math.max(0, index - 6), index + 1)
            .join("\n");
          if (/convert|Convert|rate|Rate/.test(context)) {
            offenders.push(`${rel}:${index + 1}`);
          }
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  /**
   * The rule is "a conversion with no rate returns null", and `?? amount` is
   * only one way to break it. The scan above was written from the shape of the
   * two fixed defects, so it matches a fallback that ends a line -- and an
   * `if (result == null) { log(); return amount; }` block, which returns the
   * unconverted amount just as surely, passed straight through it.
   *
   * So this scan is written from the rule instead: a statement handing back the
   * function's own input, inside a null-check of a conversion result, is the
   * violation whatever punctuation it wears.
   *
   * Each entry would name a call site that DOES this, with the reason it is
   * still here. The list is empty: `ReportCurrencyService.convertAmount`, the
   * last entry, is gone, and every built-in report now excludes a row with no
   * rate and names its currency. The mechanism stays so that a new offender is
   * a reviewed decision rather than an unseen one.
   */
  const RETURNS_ITS_INPUT_UNCONVERTED: ReadonlyArray<{
    file: string;
    reason: string;
  }> = [];

  it("never returns its own input from a conversion's null branch", () => {
    // A bare `return amount;` / `return value;` -- no `??`, no `||`, so the
    // scan above cannot see it.
    const RETURNS_INPUT =
      /^\s*return\s+(?:amount|rawValue|value|input)\s*;\s*$/;
    // The branch it sits in has to be about a conversion that came back empty.
    const CONVERSION = /convert|Convert|\brate\b|Rate/;
    const ABSENT_RESULT =
      /(?:==|===)\s*null|(?:==|===)\s*undefined|!\s*(?:result|converted|convertedAmount)\b/;

    const allowed = new Set(RETURNS_ITS_INPUT_UNCONVERTED.map((e) => e.file));
    const offenders: string[] = [];
    const allowedHits: string[] = [];

    for (const file of files) {
      const rel = relative(SRC_ROOT, file).split("\\").join("/");
      const lines = readFileSync(file, "utf8").split("\n");
      for (const [index, line] of lines.entries()) {
        if (!RETURNS_INPUT.test(line)) continue;
        const context = lines
          .slice(Math.max(0, index - 8), index + 1)
          .join("\n");
        if (!CONVERSION.test(context) || !ABSENT_RESULT.test(context)) continue;
        (allowed.has(rel) ? allowedHits : offenders).push(
          `${rel}:${index + 1}`,
        );
      }
    }

    expect(offenders).toEqual([]);
    // The allowlist is shrink-only: an entry whose call site has been fixed (or
    // moved) has to go, or the next one hides behind it.
    expect(allowedHits.map((hit) => hit.split(":")[0])).toEqual(
      RETURNS_ITS_INPUT_UNCONVERTED.map((entry) => entry.file),
    );
  });

  it("recognises the returned-input shape it bans", () => {
    // Both directions, so neither half can quietly stop working: the block the
    // scan exists for is caught, and a conversion that correctly returns null
    // is not.
    const RETURNS_INPUT =
      /^\s*return\s+(?:amount|rawValue|value|input)\s*;\s*$/;
    const caught = [
      "    const result = convertWithRateLookup(amount, from, to, getRate);",
      "    if (result == null) {",
      "      this.logger.warn(`no rate for ${from} -> ${to}`);",
      "      return amount;",
    ];
    const clean = [
      "    const result = convertWithRateLookup(amount, from, to, getRate);",
      "    if (result == null) return null;",
      "    return result;",
    ];

    expect(caught.some((line) => RETURNS_INPUT.test(line))).toBe(true);
    expect(clean.some((line) => RETURNS_INPUT.test(line))).toBe(false);
  });

  /**
   * Reads of a rate that was STORED or typed in, where `1` is the column's own
   * default and not the answer to a failed lookup: an `exchange_rate NUMERIC
   * NOT NULL DEFAULT 1` row, or a request body that omitted the field. Another
   * remediation stream owns each file, so this stream may not edit it.
   *
   * Shrink-only. `count` is the exact number of hits: a new hit fails the scan,
   * and a removed hit fails it too, so the entry has to shrink or go with the
   * fix. A hit anywhere else -- above all a lookup that found no rate -- is
   * fixed in the code, never added here.
   */
  const STORED_RATE_DEFAULTS_OWNED_ELSEWHERE: ReadonlyArray<{
    file: string;
    count: number;
    reason: string;
  }> = [
    {
      file: "transactions/transaction-transfer.service.ts",
      count: 3,
      reason:
        "reads the transfer leg's stored or submitted exchange_rate " +
        "(`existingExchangeRate ?? 1`, a non-positive stored rate, " +
        "`toTransaction.exchangeRate || 1`); the column is NOT NULL DEFAULT 1 " +
        "and none of these is a lookup that failed. Owned by another " +
        "remediation stream.",
    },
    {
      file: "transactions/transactions.service.ts",
      count: 1,
      reason:
        "`transactionData.exchangeRate || 1` defaults an omitted input " +
        "exchange_rate (NOT NULL DEFAULT 1), not a failed lookup. Owned by " +
        "another remediation stream.",
    },
    {
      file: "action-history/action-history.service.ts",
      count: 5,
      reason:
        "replays a stored transaction's `exchangeRate ?? 1` when undoing or " +
        "redoing an action; the value is the row's own exchange_rate column " +
        "(NOT NULL DEFAULT 1), not a lookup that failed. Owned by another " +
        "remediation stream.",
    },
  ];

  const rateDefaultHits = (): Map<string, number[]> => {
    const hits = new Map<string, number[]>();
    for (const file of files) {
      const rel = relative(SRC_ROOT, file).split("\\").join("/");
      const lines = readFileSync(file, "utf8").split("\n");
      for (const [index, line] of lines.entries()) {
        // `rate = ... : 1`, `exchangeRate ?? 1`, `loaded.spotRate.get(k) ?? 1`
        // -- answering 1 for a pair whose rate could not be found.
        if (!RATE_DEFAULTS_TO_ONE.test(codeOf(line))) continue;
        hits.set(rel, [...(hits.get(rel) ?? []), index + 1]);
      }
    }
    return hits;
  };

  it("never defaults a missing exchange rate to 1", () => {
    const hits = rateDefaultHits();
    const grandfathered = new Set(
      STORED_RATE_DEFAULTS_OWNED_ELSEWHERE.map((entry) => entry.file),
    );

    const offenders = [...hits.entries()]
      .filter(([rel]) => !grandfathered.has(rel))
      .flatMap(([rel, lineNumbers]) =>
        lineNumbers.map((lineNumber) => `${rel}:${lineNumber}`),
      );

    expect(offenders).toEqual([]);
  });

  it("holds the stored-rate reads owned elsewhere to their exact count", () => {
    const hits = rateDefaultHits();

    const actual = Object.fromEntries(
      STORED_RATE_DEFAULTS_OWNED_ELSEWHERE.map((entry) => [
        entry.file,
        hits.get(entry.file)?.length ?? 0,
      ]),
    );
    const expected = Object.fromEntries(
      STORED_RATE_DEFAULTS_OWNED_ELSEWHERE.map((entry) => [
        entry.file,
        entry.count,
      ]),
    );

    // Shrink-only: a fixed hit has to lower its count (or remove the entry),
    // and a new hit in the same file is not covered by the old reason.
    expect(actual).toEqual(expected);
    for (const entry of STORED_RATE_DEFAULTS_OWNED_ELSEWHERE) {
      expect(entry.count).toBeGreaterThan(0);
    }
  });

  it("recognises the rate-defaults-to-one shapes it bans and spares the rest", () => {
    const caught = [
      "    const rate = exchangeRate ?? 1;",
      "    return exchangeRate ?? 1;",
      "    const x = spotRate.get(k) ?? 1;",
      "    return loaded.spotRate.get(`${currency}->${display}`) ?? 1;",
      "    const fx = Number(tx.exchangeRate) || 1;",
      "    const directRate = x ? y : 1;",
      "    rate = reverseRate !== null ? 1 / reverseRate : 1;",
    ];
    const clean = [
      "    return rate ?? null;",
      "    return loaded.spotRate.get(key) ?? null;",
      "    const x = exchangeRate ?? 1.5;",
      "    const x = exchangeRate ?? 10;",
      "    if (from === to) return 1;",
      "    return from === to ? 1 : rate;",
      '    rate: direction === "direct" ? observedRate : 1 / observedRate,',
      "    const quantity = count ?? 1;",
    ];

    for (const line of caught) {
      expect([line, RATE_DEFAULTS_TO_ONE.test(line)]).toEqual([line, true]);
    }
    for (const line of clean) {
      expect([line, RATE_DEFAULTS_TO_ONE.test(line)]).toEqual([line, false]);
    }
    // Prose that quotes the shape is not code.
    expect(codeOf("    // `exchangeRate ?? 1` is the old shape").trim()).toBe(
      "",
    );
    expect(codeOf(" * `rate || 1` was posted at 1.0")).toBe("");
  });

  it("never calls the removed ReportCurrencyService.convertAmount", () => {
    // A report with nowhere to say "unknown" was the only reason the
    // unconverted-amount door existed. Each report now converts through the
    // nullable converter `buildConverter` returns, excludes the row and names
    // the currency.
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(SRC_ROOT, file).split("\\").join("/");
      if (!rel.startsWith("built-in-reports/")) continue;
      const lines = readFileSync(file, "utf8").split("\n");
      for (const [index, line] of lines.entries()) {
        if (/\bconvertAmount\s*\(/.test(codeOf(line))) {
          offenders.push(`${rel}:${index + 1}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("reciprocates a reverse rate only in reviewed places", () => {
    // "Try direct, then try the reverse and reciprocate" is the shape that has
    // to end in `null` when neither exists -- three copies of it ended in `1`
    // instead. Reciprocating is legitimate; doing it in a new place without
    // deciding what happens when there is no rate is not.
    //
    // Adding a file here is a reviewed decision: confirm the branch returns
    // null (or a typed unknown) rather than 1 before doing it.
    const allowed = new Set([
      // The shared date-aware helper -- the single direct/inverse decision.
      "common/currency-conversion.util.ts",
      // `getLiveRate` reciprocates a reverse quote from the provider, not a
      // stored row: a live fetch has no resolver to defer to, and the branch
      // falls through to `resolveStoredRate` and then to null.
      "currencies/exchange-rate.service.ts",
    ]);

    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(SRC_ROOT, file).split("\\").join("/");
      if (allowed.has(rel)) continue;
      const source = readFileSync(file, "utf8");
      if (/1\s*\/\s*(reverse|inverse)\w*/i.test(source)) offenders.push(rel);
    }

    expect(offenders).toEqual([]);
  });

  it("every reviewed reciprocal returns null when neither direction exists", () => {
    // The allowlist above is only meaningful if the files on it actually
    // handle the absent case. Each must mention returning null near its
    // reciprocal rather than falling through to a number.
    //
    // `gem-position.service.ts` left this list when it stopped reciprocating at
    // all: it makes one `getLatestRate` call, which answers from either stored
    // direction (INV-FX-003). A reciprocal reintroduced there fails the scan
    // above, which is the point of taking it off.
    const resolvers = ["currencies/exchange-rate.service.ts"];

    for (const rel of resolvers) {
      const source = readFileSync(join(SRC_ROOT, rel), "utf8");
      const idx = source.search(/1\s*\/\s*(reverse|inverse)\w*/i);
      expect(idx).toBeGreaterThan(-1);
      // Look at the surrounding block for the null-return decision.
      const around = source.slice(Math.max(0, idx - 400), idx + 200);
      expect(around).toMatch(/null/);
    }
  });
});
