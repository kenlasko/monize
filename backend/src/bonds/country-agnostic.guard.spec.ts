import { readdirSync, readFileSync } from "fs";
import { join, relative } from "path";

/**
 * The bond domain and engine know no country, issuer, program or product. A rule
 * of one market is data in an adapter (`src/bonds/adapters/<country>/`) built
 * from the generic primitives of the terms document; the engine only switches on
 * a primitive's `type`. Adding a country must not change `domain/` or `engine/`.
 */
const BONDS_ROOT = join(__dirname);
const GUARDED = ["domain", "engine"];
/**
 * The shared services directly under `src/bonds/` (refresh, catalog, pricing,
 * valuation, controller) serve every country, so they are scanned for the same
 * literals; only `adapters/` may name a market.
 */
const SHARED_SCANNED_FOR_LITERALS = true;
/**
 * Country, currency, publisher and product literals. `_` and digits count as
 * separators (`PL_CPI_GUS_YOY`, `"EDO1036"`, `TOS1029`), so a token is bounded
 * by non-letters; a lowercase token is only a literal when a digit or `_` follows
 * (`edo1036`, `pl_cpi`), which keeps ordinary words out. `BOND` is not listed:
 * it is the domain's own word (`BOND_ERROR_FALLBACKS`); the US product `BOND` is
 * one of the program codes the adapter's spec names.
 */
const FORBIDDEN =
  /(?<![A-Za-z])(?:(?:PLN|PL|TOS|ROR|COI|EDO|OTS|DOR|ROS|ROD|NBP|GUS|BLS|USD|US|BILL|NOTE|TIPS|FRN)(?![A-Za-z])|(?:pln|pl|tos|ror|coi|edo|ots|dor|ros|rod|nbp|gus|bls|usd|us|bill|note|tips|frn)(?=[0-9_])|treasurydirect|api\.bls\.gov|CUUR0000SA0)/;
const ADAPTER_IMPORT =
  /from\s+["'][^"']*adapters[^"']*["']|require\(\s*["'][^"']*adapters/;

/**
 * INV-BOND-003: money and rates are ExactDecimal. JavaScript number parsing and
 * Math belong only to the calendar-date module, which counts days.
 */
const FLOAT_ARITHMETIC =
  /\bparseFloat\s*\(|\bNumber\s*\(|\bNumber\.parse|\bMath\./;
const DATE_MODULE = "calendar-date.ts";

const HOW_TO_FIX =
  "Express the rule as a primitive in the terms data (a new union member in " +
  "domain/bond-terms.ts plus one engine case) and keep the market-specific part " +
  "in src/bonds/adapters/<country>/.";

/** Blank comments, keeping line numbers, so prose may name what the code must not. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(
      /(^|[^:"'`\\])\/\/[^\n]*/g,
      (m, lead) => lead + " ".repeat(m.length - lead.length),
    );
}

function sharedServiceFiles(): string[] {
  return readdirSync(BONDS_ROOT, { withFileTypes: true })
    .filter(
      (e) =>
        e.isFile() && e.name.endsWith(".ts") && !e.name.endsWith(".spec.ts"),
    )
    .map((e) => join(BONDS_ROOT, e.name));
}

/** What the literal rule scans: domain/, engine/ and the shared services. */
function literalFiles(): string[] {
  return [
    ...guardedFiles(),
    ...(SHARED_SCANNED_FOR_LITERALS ? sharedServiceFiles() : []),
  ];
}

function guardedFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (path.endsWith(".ts") && !path.endsWith(".spec.ts"))
        out.push(path);
    }
  };
  GUARDED.forEach((d) => walk(join(BONDS_ROOT, d)));
  return out;
}

function offenders(
  pattern: RegExp,
  exempt: (file: string) => boolean = () => false,
  files: string[] = guardedFiles(),
): string[] {
  const found: string[] = [];
  for (const file of files.filter((f) => !exempt(f))) {
    stripComments(readFileSync(file, "utf8"))
      .split("\n")
      .forEach((line, i) => {
        if (pattern.test(line))
          found.push(`${relative(BONDS_ROOT, file)}:${i + 1}: ${line.trim()}`);
      });
  }
  return found;
}

describe("bonds domain and engine are country-agnostic", () => {
  it("scans files at all", () => {
    expect(guardedFiles().length).toBeGreaterThan(5);
  });

  it("scans the shared services directly under bonds/, never adapters/ or specs", () => {
    const shared = sharedServiceFiles().map((f) => relative(BONDS_ROOT, f));
    expect(shared).toContain("benchmark-refresh.service.ts");
    expect(shared).toContain("bond-catalog.service.ts");
    expect(shared.some((f) => f.includes("/") || f.endsWith(".spec.ts"))).toBe(
      false,
    );
  });

  it("imports nothing from an adapter", () => {
    const found = offenders(ADAPTER_IMPORT);
    if (found.length) {
      throw new Error(
        `domain/ and engine/ must not import adapters:\n${found.join("\n")}\n${HOW_TO_FIX}`,
      );
    }
  });

  it("names no country, currency, issuer, program or product", () => {
    const found = offenders(FORBIDDEN, () => false, literalFiles());
    if (found.length) {
      throw new Error(
        `country or product literal in domain/, engine/ or a shared bonds/ service:\n${found.join("\n")}\n${HOW_TO_FIX}`,
      );
    }
  });

  it("does no number arithmetic outside the calendar-date module (INV-BOND-003)", () => {
    const found = offenders(FLOAT_ARITHMETIC, (f) => f.endsWith(DATE_MODULE));
    if (found.length) {
      throw new Error(
        `number arithmetic in domain/ or engine/:\n${found.join("\n")}\n` +
          "Compute money and rates with ExactDecimal (domain/exact-decimal.ts); " +
          "only calendar-date.ts may count days with numbers.",
      );
    }
  });

  describe("the scanner", () => {
    it("catches number parsing and Math, not ExactDecimal", () => {
      expect(FLOAT_ARITHMETIC.test("const x = Number(row.amount);")).toBe(true);
      expect(FLOAT_ARITHMETIC.test("const x = parseFloat(v);")).toBe(true);
      expect(FLOAT_ARITHMETIC.test("const x = Math.round(v * 100);")).toBe(
        true,
      );
      expect(FLOAT_ARITHMETIC.test("ExactDecimal.parse(v).mul(q)")).toBe(false);
    });

    it("lets a comment name what code may not, and catches code", () => {
      const prose = stripComments(
        "// TOS note\n/* ROR\nPLN */\nconst a = 1;\n",
      );
      expect(FORBIDDEN.test(prose)).toBe(false);
      expect(prose.split("\n")).toHaveLength(5);
      expect(FORBIDDEN.test(stripComments('const c = "PLN";'))).toBe(true);
      expect(FORBIDDEN.test('const h = "api.bls.gov";')).toBe(true);
      expect(FORBIDDEN.test('const s = "CUUR0000SA0";')).toBe(true);
      expect(FORBIDDEN.test('const p = "BLS";')).toBe(true);
      expect(
        FORBIDDEN.test(
          stripComments('const c = "x"; // fine\nconst d = "TOS";'),
        ),
      ).toBe(true);
    });

    it.each([
      'const id = "PL_CPI_GUS_YOY";',
      "if (rule.benchmarkId === PL_NBP_REFERENCE) {",
      'seriesCode === "EDO1036"',
      "x=TOS1029",
      'startsWith("OTS")',
      'const m = "edo1036";',
      'id = "pl_cpi";',
      "const c = PLN;",
    ])("catches the identifier form %s", (code) => {
      expect(FORBIDDEN.test(code)).toBe(true);
    });

    it.each([
      "const placeholder = 1;",
      "const POLICY = RATE_UNKNOWN;",
      "const prorated = ExactDecimal.ONE;",
      "const doRoundTrip = true;",
      "const ros = 1; // lowercase word, no digit or underscore",
    ])("does not flag ordinary words in %s", (code) => {
      expect(FORBIDDEN.test(stripComments(code))).toBe(false);
    });

    it("matches an adapter import in both import styles", () => {
      expect(ADAPTER_IMPORT.test('import { x } from "../adapters/pl";')).toBe(
        true,
      );
      expect(ADAPTER_IMPORT.test('const x = require("../adapters/pl")')).toBe(
        true,
      );
      expect(ADAPTER_IMPORT.test('import { x } from "../domain/a";')).toBe(
        false,
      );
    });
  });
});
