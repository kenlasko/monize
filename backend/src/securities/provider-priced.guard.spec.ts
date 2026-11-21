import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

/**
 * INV-BOND-005: a security linked to a bond instrument is priced by the bond
 * engine only. Every path that asks a quote provider for a security's quote,
 * bar, window or intraday series therefore consults ONE predicate,
 * `isPricedByQuoteProvider` (`provider-priced.util.ts`), directly or through
 * `isRefreshEligible`, which is built on it.
 *
 * The mistake is mechanical -- a new refresh, backfill or chart path that
 * fetches for "every security" and never asks -- so it gets a scanning test
 * rather than a paragraph. A failure names the predicate to call; the fix is the
 * call, never an entry in EXEMPT below (an entry is a decision about a kind of
 * caller that has no security to price, with its reason).
 */
const SRC_ROOT = join(__dirname, "..");

const PREDICATE = /\b(?:isPricedByQuoteProvider|isRefreshEligible)\s*\(/;

/** The three private entry points of `SecurityPriceService` that reach a provider for a security. */
const GATED_FETCHES =
  /\bthis\.(?:fetchQuoteWithFallback|fetchHistoricalWithFallback|fillPriceWindow)\s*\(/;

/** A direct call of a provider's fetch method. */
const PROVIDER_CALL =
  /\.(?:fetchQuote|fetchHistoricalSeries|fetchHistoricalWindowSeries|fetchIntradaySeries|fetchHistorical|fetchHistoricalWindow)\s*\(/;

const PRICE_SERVICE = "securities/security-price.service.ts";
const PROVIDER_PRICED_UTIL = "securities/provider-priced.util.ts";

/**
 * Files that call a provider's fetch method without pricing a security, each with
 * the reason. The provider implementations call one another's methods; the FX
 * provider and the market-index service fetch a currency pair or an index, which no security link
 * can name. Shrink-only: a new reader of security quotes is not an exemption.
 */
const EXEMPT: ReadonlyMap<string, string> = new Map([
  [
    "securities/yahoo-finance.service.ts",
    "a provider implementation, calling its own methods",
  ],
  [
    "securities/msn-finance.service.ts",
    "a provider implementation, calling its own methods",
  ],
  [
    "securities/lse-finance.service.ts",
    "a provider implementation, calling its own methods",
  ],
  [
    "currencies/providers/yahoo-fx.provider.ts",
    "fetches a currency pair's rate, not a security (the FX provider chain " +
      "took these calls over from exchange-rate.service.ts)",
  ],
  [
    "securities/market-index.service.ts",
    "fetches a market index, not a security",
  ],
]);

/**
 * Methods that reach a provider and do not consult the predicate themselves,
 * each with the reason. Keyed `<file>::<method>`. The first three are the gated
 * entry points of `SecurityPriceService`: the scan holds their CALLERS to the
 * predicate (GATED_FETCHES), so the predicate is not repeated inside them. The
 * last prices no stored security. Shrink-only.
 */
const METHOD_EXEMPT: ReadonlyMap<string, string> = new Map([
  [
    `${PRICE_SERVICE}::fetchQuoteWithFallback`,
    "a gated entry point; every caller is scanned for the predicate",
  ],
  [
    `${PRICE_SERVICE}::fetchHistoricalWithFallback`,
    "a gated entry point; every caller is scanned for the predicate",
  ],
  [
    `${PRICE_SERVICE}::fillPriceWindow`,
    "a gated entry point; every caller is scanned for the predicate",
  ],
  [
    `${PRICE_SERVICE}::fetchAuthoritativeCurrency`,
    "reads the currency of a symbol being added, which prices no stored security",
  ],
]);

/** Blank comments, keeping line numbers, so prose may name what the code must not. */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(
      /(^|[^:"'`\\])\/\/[^\n]*/g,
      (m, lead) => lead + " ".repeat(m.length - lead.length),
    );
}

/** Class members at two-space indent, by name, with their text up to the next member. */
export function classMethods(source: string): Map<string, string> {
  const lines = source.split("\n");
  const starts: Array<{ name: string; line: number }> = [];
  lines.forEach((text, line) => {
    const m =
      /^ {2}(?:(?:public|private|protected|static|async)\s+)*([A-Za-z_]\w*)\s*(?:<[^>]*>)?\(/.exec(
        text,
      );
    if (m) starts.push({ name: m[1], line });
  });
  const methods = new Map<string, string>();
  starts.forEach(({ name, line }, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].line : lines.length;
    methods.set(name, lines.slice(line, end).join("\n"));
  });
  return methods;
}

/**
 * Methods that reach a provider, through a gated entry point or by a direct
 * fetch call, without consulting the predicate in the same method. A call in a
 * method is the unit: a file that consults the predicate once somewhere else does
 * not excuse a second fetch path. `exempt` names the methods that need not.
 */
export function ungatedMethods(
  source: string,
  exempt: ReadonlySet<string> = new Set(),
): string[] {
  const stripped = stripComments(source);
  const offenders = [...classMethods(stripped)]
    .filter(
      ([name, body]) =>
        (GATED_FETCHES.test(body) || PROVIDER_CALL.test(body)) &&
        !PREDICATE.test(body) &&
        !exempt.has(name),
    )
    .map(([name]) => name);
  // A call outside any class member (a top-level function) belongs to no
  // method above; the file-level predicate is then the only thing to hold it to.
  const inMember = [...classMethods(stripped).values()].some((body) =>
    PROVIDER_CALL.test(body),
  );
  if (!inMember && PROVIDER_CALL.test(stripped) && !PREDICATE.test(stripped)) {
    offenders.push("<outside any class member>");
  }
  return offenders;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      out.push(...sourceFiles(full));
      continue;
    }
    if (!entry.endsWith(".ts") || /\.(spec|test)\.ts$/.test(entry)) continue;
    out.push(full);
  }
  return out;
}

const exemptIn = (rel: string): ReadonlySet<string> =>
  new Set(
    [...METHOD_EXEMPT.keys()]
      .filter((key) => key.startsWith(`${rel}::`))
      .map((key) => key.split("::")[1]),
  );

const read = (rel: string) =>
  stripComments(readFileSync(join(SRC_ROOT, rel), "utf8"));
const relOf = (file: string) => relative(SRC_ROOT, file).split("\\").join("/");

describe("a bond-linked security is never priced by a quote provider (INV-BOND-005)", () => {
  const files = sourceFiles(SRC_ROOT);

  it("scans files at all", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("builds the refresh-eligibility predicate on the one named predicate", () => {
    const methodless = read(PROVIDER_PRICED_UTIL);
    const body = /function isRefreshEligible\([\s\S]*?\n\}\n/.exec(methodless);
    expect(body).not.toBeNull();
    expect(body![0]).toMatch(/\bisPricedByQuoteProvider\s*\(/);
  });

  it("has no method of SecurityPriceService reaching a provider without consulting it", () => {
    const offenders = ungatedMethods(
      readFileSync(join(SRC_ROOT, PRICE_SERVICE), "utf8"),
      exemptIn(PRICE_SERVICE),
    );
    expect(offenders.map((name) => `${PRICE_SERVICE}: ${name}()`)).toEqual([]);
  });

  it("still finds the gated entry points, so the rule cannot pass over an empty sweep", () => {
    const methods = [...classMethods(read(PRICE_SERVICE))].filter(([, body]) =>
      GATED_FETCHES.test(body),
    );
    // refresh x2, backfill, settlement, range fetch, on-demand fill, holding period.
    expect(methods.length).toBeGreaterThanOrEqual(7);
  });

  it("has no other file with a method calling a provider without consulting it, or being exempt", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relOf(file);
      if (rel === PRICE_SERVICE || rel.startsWith("securities/providers/")) {
        continue;
      }
      const source = readFileSync(file, "utf8");
      if (!PROVIDER_CALL.test(stripComments(source)) || EXEMPT.has(rel)) {
        continue;
      }
      for (const method of ungatedMethods(source, exemptIn(rel))) {
        offenders.push(
          `${rel}: ${method}() -- call isPricedByQuoteProvider (securities/provider-priced.util.ts) in the method that asks a provider about a security`,
        );
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps every exemption pointing at a file that still calls a provider", () => {
    for (const rel of EXEMPT.keys()) {
      expect(PROVIDER_CALL.test(read(rel))).toBe(true);
    }
  });

  it("keeps every method exemption pointing at a method that still reaches a provider", () => {
    for (const key of METHOD_EXEMPT.keys()) {
      const [rel, name] = key.split("::");
      const body = classMethods(read(rel)).get(name);
      expect(body).toBeDefined();
      expect(GATED_FETCHES.test(body!) || PROVIDER_CALL.test(body!)).toBe(true);
    }
  });

  describe("the scanner", () => {
    it("flags a method that fetches without the predicate, and passes one that asks", () => {
      const source = [
        "class S {",
        "  async refreshNew() {",
        "    return this.fetchQuoteWithFallback(s);",
        "  }",
        "  async refreshOld() {",
        "    const ok = list.filter((s) => isRefreshEligible(s));",
        "    return this.fetchHistoricalWithFallback(ok[0]);",
        "  }",
        "  private async other(x) {",
        "    return this.fillPriceWindow(x);",
        "  }",
        "}",
      ].join("\n");
      expect(ungatedMethods(source)).toEqual(["refreshNew", "other"]);
    });

    it("reads a comment naming the predicate as prose, not as a call", () => {
      const source = [
        "class S {",
        "  async refreshNew() {",
        "    // consults isPricedByQuoteProvider(s) -- not really",
        "    return this.fetchQuoteWithFallback(s);",
        "  }",
        "}",
      ].join("\n");
      expect(ungatedMethods(source)).toEqual(["refreshNew"]);
    });

    it("flags a method that calls a provider directly, wrapper or not", () => {
      const source = [
        "class S {",
        "  async latestClose(s) {",
        "    return provider.fetchQuote(s.symbol, s.exchange);",
        "  }",
        "  async series(s) {",
        "    return this.providers.getByName(s.quoteProvider).fetchHistoricalSeries(s.symbol);",
        "  }",
        "  async asked(s) {",
        "    if (!isPricedByQuoteProvider(s)) return null;",
        "    return provider.fetchQuote(s.symbol);",
        "  }",
        "}",
      ].join("\n");
      expect(ungatedMethods(source)).toEqual(["latestClose", "series"]);
    });

    it("holds a second fetch path in a file that consults the predicate elsewhere", () => {
      const source = [
        "class P {",
        "  async chart(s) {",
        "    if (!isPricedByQuoteProvider(s)) return [];",
        "    return yahoo.fetchIntradaySeries(s.symbol);",
        "  }",
        "  async another(s) {",
        "    return yahoo.fetchIntradaySeries(s.symbol);",
        "  }",
        "}",
      ].join("\n");
      expect(ungatedMethods(source)).toEqual(["another"]);
    });

    it("lets a named method through, and only that one", () => {
      const source = [
        "class S {",
        "  async fetchAuthoritativeCurrency(sym) {",
        "    return p.fetchQuote(sym);",
        "  }",
        "  async sneaky(s) {",
        "    return p.fetchQuote(s);",
        "  }",
        "}",
      ].join("\n");
      expect(
        ungatedMethods(source, new Set(["fetchAuthoritativeCurrency"])),
      ).toEqual(["sneaky"]);
    });

    it("flags a fetch outside any class member unless the file consults the predicate", () => {
      expect(
        ungatedMethods(
          "export async function f(s) { return y.fetchQuote(s); }",
        ),
      ).toEqual(["<outside any class member>"]);
      expect(
        ungatedMethods(
          "export async function f(s) { if (!isPricedByQuoteProvider(s)) return null; return y.fetchQuote(s); }",
        ),
      ).toEqual([]);
    });
  });
});
