/**
 * A stored exchange rate names the provider that observed it, and only that
 * provider's adapter knows the name (INV-FX-005).
 *
 * `exchange_rates.source` used to be a literal in the two upserts of
 * `ExchangeRateService`, and the service built Yahoo's symbols itself, so a
 * second provider meant a second copy of every rate path. Now the chain hands
 * each observation back with its provider's `source` and the service writes
 * what it is given. A slug spelled anywhere else is a row attributed by hand,
 * and an import of the Yahoo client under `currencies/` outside its adapter is
 * a provider question that bypassed the chain. Both are mechanical, so both are
 * held here rather than in a paragraph (`docs/guard-tests.md`; section 9 of
 * `docs/specs/exchange-rate-providers.md`).
 *
 * Production sources only. A spec's fixture of a stored row names the slug it
 * asserts, and the adapter's own spec types its double on the Yahoo client;
 * neither writes a row. The service spec is held to the chain by the service's
 * constructor, which no longer accepts the Yahoo client at all.
 */
import * as fs from "fs";
import * as path from "path";

/** `backend/src/currencies`, the directory held to the rule. */
const CURRENCIES_DIR = path.join(__dirname, "..");
/** `backend/src/currencies/providers`, the one place a slug may be spelled. */
const PROVIDERS_DIR = "providers";
/** The one file under `currencies/` that may import the Yahoo client. */
const YAHOO_ADAPTER = "providers/yahoo-fx.provider.ts";

/**
 * The `exchange_rates.source` slugs the adapters write. A new adapter's slug
 * joins this list; `every adapter's slug is on the list` below holds the two
 * in step, so the scan cannot miss a slug an adapter introduced.
 */
const PROVIDER_SOURCE_SLUGS = [
  "yahoo_finance",
  "frankfurter",
  "yahoo_crypto",
] as const;

const SOURCE_LITERAL = new RegExp(
  `["'\`](${PROVIDER_SOURCE_SLUGS.join("|")})["'\`]`,
);
/** Any way of reaching the module: `from "..."`, a bare `import "..."`, `require("...")`. */
const YAHOO_CLIENT_IMPORT =
  /(?:from|import|require\()\s*["'][^"'\n]*yahoo-finance\.service["']/;
/** What an adapter declares, e.g. `readonly source = "yahoo_finance";`. */
const ADAPTER_SOURCE_DECLARATION = /readonly\s+source\s*=\s*["']([\w-]+)["']/;

/**
 * Comments blanked, line count preserved, so the prose above -- which has to
 * name the very slugs this scan looks for -- cannot trip it, and an offender
 * report still points at the right line.
 *
 * String-aware: a `//` inside a quoted string (a URL literal, say) is code,
 * not a comment, so a slug later on the same line is still read. A regex
 * literal containing `//` is read as a comment start, which can only hide an
 * offender on that one line, never invent one.
 */
export function stripComments(source: string): string {
  let out = "";
  let state: "code" | "line" | "block" | "'" | '"' | "`" = "code";
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (state === "code") {
      if (ch === "/" && next === "/") {
        state = "line";
        i++;
        continue;
      }
      if (ch === "/" && next === "*") {
        state = "block";
        out += "  ";
        i++;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === "`") state = ch;
      out += ch;
      continue;
    }
    if (state === "line") {
      if (ch === "\n") {
        state = "code";
        out += ch;
      }
      continue;
    }
    if (state === "block") {
      if (ch === "*" && next === "/") {
        state = "code";
        out += "  ";
        i++;
        continue;
      }
      out += ch === "\n" ? ch : " ";
      continue;
    }
    // Inside a string: an escaped character never closes it.
    if (ch === "\\" && next !== undefined) {
      out += ch + next;
      i++;
      continue;
    }
    if (ch === state) state = "code";
    out += ch;
  }
  return out;
}

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (fs.statSync(full).isDirectory()) return sourceFiles(full);
    if (!entry.endsWith(".ts") || entry.endsWith(".spec.ts")) return [];
    return [full];
  });
}

/** `relative path -> its comment-free source`, for every production file. */
function currencySources(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of sourceFiles(CURRENCIES_DIR)) {
    const rel = path.relative(CURRENCIES_DIR, file).split(path.sep).join("/");
    found.set(rel, stripComments(fs.readFileSync(file, "utf8")));
  }
  return found;
}

/** `file:line` for every line of `code` the pattern matches. */
function offendingLines(file: string, code: string, pattern: RegExp): string[] {
  return code
    .split("\n")
    .flatMap((line, index) =>
      pattern.test(line) ? [`${file}:${index + 1}`] : [],
    );
}

const inProvidersDir = (file: string) => file.startsWith(`${PROVIDERS_DIR}/`);

describe("a stored exchange rate names its provider, and only the adapter knows the name", () => {
  const sources = currencySources();

  it("finds the sources it is guarding", () => {
    // A scan that silently matches nothing is the failure mode of every guard
    // in this repo, so it asserts its own subject exists first.
    expect(sources.size).toBeGreaterThan(10);
    expect(sources.has("exchange-rate.service.ts")).toBe(true);
    expect(sources.has(YAHOO_ADAPTER)).toBe(true);
  });

  it("the Yahoo adapter is where its slug is spelled and its client imported", () => {
    const adapter = sources.get(YAHOO_ADAPTER)!;
    expect(adapter).toMatch(SOURCE_LITERAL);
    expect(adapter.match(SOURCE_LITERAL)?.[1]).toBe("yahoo_finance");
    expect(adapter).toMatch(YAHOO_CLIENT_IMPORT);
  });

  it("every adapter's slug is on the list this scan bans", () => {
    const declared = [...sources.entries()]
      .filter(([file]) => inProvidersDir(file) && file.endsWith(".provider.ts"))
      .map(([file, code]) => ({
        file,
        slug: code.match(ADAPTER_SOURCE_DECLARATION)?.[1],
      }));

    // The list is only complete while every adapter's own declaration is on
    // it; a new adapter with a slug the scan does not know would be free to
    // leak that slug anywhere.
    expect(declared.length).toBeGreaterThan(0);
    for (const { file, slug } of declared) {
      expect({ file, slug }).toEqual({
        file,
        slug: expect.stringMatching(
          new RegExp(`^(${PROVIDER_SOURCE_SLUGS.join("|")})$`),
        ),
      });
    }
  });

  it("spells no provider source slug outside the providers directory", () => {
    const offenders = [...sources.entries()]
      .filter(([file]) => !inProvidersDir(file))
      .flatMap(([file, code]) => offendingLines(file, code, SOURCE_LITERAL))
      .sort();

    // A row attributed by hand. The slug comes with the observation from the
    // chain (`FxChainObservation.source`, `FxDailySeriesResult.source`); write
    // the one you were given.
    expect(offenders).toEqual([]);
  });

  it("imports the Yahoo client under currencies only in the Yahoo adapter", () => {
    const offenders = [...sources.entries()]
      .filter(([file]) => file !== YAHOO_ADAPTER)
      .flatMap(([file, code]) =>
        offendingLines(file, code, YAHOO_CLIENT_IMPORT),
      )
      .sort();

    // A provider question that bypassed the chain. Ask `FxProviderChain`,
    // which asks the providers in `FX_PROVIDERS` order and keeps "answered
    // with nothing" apart from "did not answer" per provider.
    expect(offenders).toEqual([]);
  });

  it("recognises the shapes it bans", () => {
    expect(SOURCE_LITERAL.test(`source: "yahoo_finance",`)).toBe(true);
    expect(SOURCE_LITERAL.test(`VALUES ($1, 'frankfurter')`)).toBe(true);
    expect(SOURCE_LITERAL.test("const s = `yahoo_finance`;")).toBe(true);
    // Another writer's slug, and a word that merely contains one.
    expect(SOURCE_LITERAL.test(`source = 'mny_import'`)).toBe(false);
    expect(SOURCE_LITERAL.test(`"yahoo_finance_quotes"`)).toBe(false);

    expect(
      YAHOO_CLIENT_IMPORT.test(
        `import { YahooFinanceService } from "../securities/yahoo-finance.service";`,
      ),
    ).toBe(true);
    expect(
      YAHOO_CLIENT_IMPORT.test(
        `import { YahooFinanceService } from "../../securities/yahoo-finance.service";`,
      ),
    ).toBe(true);
    expect(
      YAHOO_CLIENT_IMPORT.test(`import "../securities/yahoo-finance.service";`),
    ).toBe(true);
    expect(
      YAHOO_CLIENT_IMPORT.test(
        `const y = require("../securities/yahoo-finance.service");`,
      ),
    ).toBe(true);
    // The adapter, and the chain, are what a caller imports instead.
    expect(
      YAHOO_CLIENT_IMPORT.test(
        `import { YahooFxProvider } from "./providers/yahoo-fx.provider";`,
      ),
    ).toBe(false);
    expect(
      YAHOO_CLIENT_IMPORT.test(
        `import { FxProviderChain } from "./providers/fx-provider-chain";`,
      ),
    ).toBe(false);

    expect(
      ADAPTER_SOURCE_DECLARATION.exec(
        `  readonly source = "yahoo_finance";`,
      )?.[1],
    ).toBe("yahoo_finance");
  });

  it("reports the line of an offender", () => {
    const code = ["const a = 1;", `const source = "yahoo_finance";`].join("\n");

    expect(offendingLines("x.ts", code, SOURCE_LITERAL)).toEqual(["x.ts:2"]);
  });

  it("cannot be tripped or satisfied by prose", () => {
    const commentedSlug = [
      "// the row used to carry 'yahoo_finance' here",
      '/* and the client came from "../securities/yahoo-finance.service" */',
      "const source = given;",
    ].join("\n");
    const stripped = stripComments(commentedSlug);

    expect(SOURCE_LITERAL.test(stripped)).toBe(false);
    expect(YAHOO_CLIENT_IMPORT.test(stripped)).toBe(false);
    // The same text outside a comment is what fails.
    expect(SOURCE_LITERAL.test(commentedSlug)).toBe(true);
    expect(YAHOO_CLIENT_IMPORT.test(commentedSlug)).toBe(true);
    // Line numbers survive the blanking, so an offender report stays accurate.
    expect(stripped.split("\n")).toHaveLength(3);
    expect(stripComments("/* a\nb */\ncode").split("\n")).toHaveLength(3);
  });

  it("does not read a // inside a string as a comment", () => {
    // A URL literal earlier on the line used to hide everything after it.
    const line = `const u = "https://x.test/"; const s = "yahoo_finance";`;
    const stripped = stripComments(line);

    expect(stripped).toBe(line);
    expect(SOURCE_LITERAL.test(stripped)).toBe(true);
    // An escaped quote does not close the string either, and the real comment
    // after the string is still blanked.
    const escaped = `const q = "say \\"hi\\" // not a comment"; // 'frankfurter'`;
    expect(stripComments(escaped)).toBe(
      `const q = "say \\"hi\\" // not a comment"; `,
    );
    expect(SOURCE_LITERAL.test(stripComments(escaped))).toBe(false);
  });
});
