import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  findRepoRoot,
  gitListFiles,
  requireRepoRoot,
} from "../common/repo-tree.util";

/**
 * Occurrence selection is one decision, made in one place (issue #1247,
 * INV-OCCURRENCE-003).
 *
 * The first pass at #1247 centralized the *arithmetic* -- what a schedule costs
 * at today's rate -- and left every consumer to work out which occurrence was
 * due and which override governed it. They did not agree: the budget alert path
 * keyed the override lookup on `overrideDate` when the identity is
 * `originalDate` (so a moved occurrence silently read the template), the
 * Upcoming Bills report applied one schedule-level amount to every projected
 * occurrence, and AI/MCP reported the base for an occurrence the user had
 * re-priced. An import-presence scan cannot see any of that, which is why this
 * guard is about the *shapes* those mistakes take.
 *
 * Each allowlist entry below is a reviewed decision with a reason. Adding a file
 * to one is a deliberate act; the default is to go through
 * `ScheduledOccurrenceService`.
 */

const SRC_PREFIX = "backend/src/";

interface SourceFile {
  path: string;
  lines: string[];
}

function sourceFiles(): SourceFile[] {
  const root = requireRepoRoot(findRepoRoot(__dirname));
  // `--others --exclude-standard` as well as `--cached`: a guard that lists only
  // tracked files is blind to a brand-new one until it is staged, which is how a
  // scan goes green locally and red in CI on the same content.
  return gitListFiles(root, "--cached --others --exclude-standard")
    .filter(
      (f) =>
        f.startsWith(SRC_PREFIX) &&
        f.endsWith(".ts") &&
        !f.endsWith(".spec.ts"),
    )
    .map((f) => ({
      path: f.slice(SRC_PREFIX.length),
      lines: readFileSync(join(root, f), "utf8").split("\n"),
    }));
}

/** Comment-only lines, so the prose describing a rule cannot trip it. */
function isComment(line: string): boolean {
  const t = line.trim();
  return (
    t.startsWith("//") ||
    t.startsWith("*") ||
    t.startsWith("/*") ||
    t.startsWith("*/")
  );
}

/**
 * A read of the resolver's `base` member -- `resolved.base`, `r.base.amount`, or
 * an aliased `const b = resolved.base`.
 *
 * The lookbehind excludes a spread (`{ ...base }`), which is an unrelated local.
 * The previous matcher required `.base.amount` on ONE expression, so it could not
 * see `const amount = own ? own.effective : resolved.base` -- the only real base
 * read in the tree -- and every allowance it granted was dead.
 */
const BASE_READ = /(?<!\.)\.base\b/;

/**
 * A direction decision taken from a schedule's stored amount.
 *
 * Any identifier, not a fixed list of variable names: the alias is the whole
 * problem (`isIncome: (occurrence.amount ?? Number(b.amount)) > 0` slipped past a
 * matcher that alternated over `st|row|schedule`, and the closing paren of the
 * `??` expression slipped past the comparison half). Scoped to the resolver's
 * consumers, because a posted transfer leg's own `Number(tx.amount) < 0` is a
 * legitimate question about a row that has already happened.
 */
const STORED_SIGN = /Number\(\s*\w+\??\.amount\s*\)[\s)]*[<>]/;

/**
 * The files that hold a resolved occurrence or the resolver's own result -- the
 * only ones these two scans are about. Scoping by import is what lets the
 * matchers be shape-based rather than name-based.
 */
function resolverConsumers(all: SourceFile[]): SourceFile[] {
  const IMPORTS_RESOLVER = /scheduled-(effective-amount|occurrence)\.service/;
  return all.filter((file) => file.lines.some((l) => IMPORTS_RESOLVER.test(l)));
}

/** Whether a loop opens within `window` lines above `index`. */
function insideLoop(lines: string[], index: number, window = 12): boolean {
  for (let i = Math.max(0, index - window); i < index; i += 1) {
    if (/\b(while|for)\s*\(/.test(lines[i])) return true;
  }
  return false;
}

describe("occurrence selection stays in one place", () => {
  const files = sourceFiles();

  it("finds the sources it is meant to scan", () => {
    // A guard that walks the tree with `git ls-files` cannot see an untracked
    // file, and an empty match set is indistinguishable from a clean one.
    expect(files.length).toBeGreaterThan(400);
    expect(files.map((f) => f.path)).toContain(
      "common/scheduled-occurrences.ts",
    );
    expect(files.map((f) => f.path)).toContain(
      "scheduled-transactions/scheduled-occurrence.service.ts",
    );
  });

  /**
   * A recurrence walked in a loop is an occurrence expansion, and there is one.
   * The allowed sites do different jobs, and only the first looks at overrides or
   * a window; the rest walk a recurrence for a reason that is not occurrence
   * selection at all.
   *
   * Hoisted out of the test so the staleness check below can hold the list
   * against the tree: an exemption for a file that no longer exists, or that no
   * longer walks a recurrence, silently pre-authorises the next collision.
   */
  const EXPANDERS = [
    // The one occurrence expander.
    "common/scheduled-occurrences.ts",
    // Rolls a single stale due date forward to the present during a Money
    // import. No window and no overrides: it answers "when is this bill next
    // due" for a row being created, not "which occurrences fall in a range".
    "import/mny/map/map-bills.ts",
    // `advancePaymentDates`: what date is N payments after this one. It is
    // date arithmetic over a LOAN TERM, not an occurrence expansion -- no
    // window, no overrides, no per-occurrence amount, and its only callers
    // (loan-amortization.util, mortgage-amortization.util) ask it for a term
    // end date. Nothing here can fork the occurrence-selection decision this
    // guard protects, so routing it through the expander would be nonsense
    // rather than an improvement.
    "accounts/payment-frequency.util.ts",
  ];

  it("expands a recurrence in exactly one place", () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (EXPANDERS.includes(file.path)) continue;
      file.lines.forEach((line, i) => {
        if (isComment(line)) return;
        if (!/calculateNextDueDate\s*\(|advanceByFrequency\s*\(/.test(line)) {
          return;
        }
        if (insideLoop(file.lines, i)) {
          offenders.push(`${file.path}:${i + 1}`);
        }
      });
    }

    expect(offenders).toEqual([]);
  });

  it("every exemption still has a subject, so the list cannot go stale", () => {
    // Two ways the list rots, and both re-permit a collision without saying so:
    // a path that no longer exists, and a path whose code no longer calls a
    // recurrence helper at all (a dead exemption, which should be deleted rather
    // than carried).
    //
    // Deliberately NOT re-running `insideLoop` here. That heuristic looks 12
    // lines above the call, and the canonical expander's own `while` sits 23
    // lines above its `calculateNextDueDate` -- so a staleness check built on it
    // reports the one file this guard exists to sanction. A check that re-derives
    // the main scan's verdict inherits the main scan's blind spots; this one asks
    // the narrower question it can actually answer.
    const byPath = new Map(files.map((f) => [f.path, f]));
    const missing: string[] = [];
    const noRecurrenceCall: string[] = [];
    for (const path of EXPANDERS) {
      const file = byPath.get(path);
      if (!file) {
        missing.push(path);
        continue;
      }
      const calls = file.lines.some(
        (line) =>
          !isComment(line) &&
          /calculateNextDueDate\s*\(|advanceByFrequency\s*\(/.test(line),
      );
      if (!calls) noRecurrenceCall.push(path);
    }
    // Collected rather than asserted per entry, so one run reports every stale
    // exemption instead of stopping at the first.
    expect({ missing, noRecurrenceCall }).toEqual({
      missing: [],
      noRecurrenceCall: [],
    });
  });

  /**
   * Choosing which override governs an occurrence -- and therefore whether the
   * base amount applies -- happens in the occurrence service. `??` collapsing
   * "no override" with "override priced as unknown" is the specific mistake this
   * keeps out of new code.
   */
  it("selects an override in exactly one place", () => {
    const SELECTORS = [
      // Defines the key and files each override's answer under it.
      "scheduled-transactions/scheduled-effective-amount.service.ts",
      // The one selector: matches the occurrence's slot to its override.
      "scheduled-transactions/scheduled-occurrence.service.ts",
      // Decorates EVERY override in the list read model with its own effective
      // amount. It selects no occurrence -- the client's occurrence-level answer
      // comes from the occurrences endpoint.
      "scheduled-transactions/scheduled-transactions.service.ts",
    ];

    const offenders: string[] = [];
    for (const file of files) {
      if (SELECTORS.includes(file.path)) continue;
      file.lines.forEach((line, i) => {
        if (isComment(line)) return;
        if (/overrideEffectiveKey\s*\(/.test(line)) {
          offenders.push(`${file.path}:${i + 1}`);
        }
      });
    }

    expect(offenders).toEqual([]);
  });

  /**
   * `base` is the answer for "every occurrence with no override". A surface that
   * reports ONE occurrence must not read it: that is how AI/MCP, the budget and
   * the report each ended up quoting the template for an occurrence the user had
   * changed.
   */
  it("reads the resolver's base amount only where the base is the question", () => {
    // Counts, not a blanket exemption: `scheduled-transactions.service.ts` is
    // 4000 lines, and a file-level allowance would let a NEW occurrence-aware
    // method in it read the base freely. Shrink-only -- a lower number is a
    // migration, a higher one needs its own argument here.
    const ALLOWED_BASE_READS = new Map([
      // The one consumer that may: `own ? own.effective : resolved.base` is the
      // override-then-base precedence itself.
      ["scheduled-transactions/scheduled-occurrence.service.ts", 1],
      // findAll's schedule-level read model: `effectiveAmount`,
      // `effectiveAmountComplete`, `effectiveCurrencyCode` and
      // `effectiveDirectionAmount` on a schedule row are by definition the base,
      // and the row carries its overrides beside it.
      ["scheduled-transactions/scheduled-transactions.service.ts", 4],
    ]);

    const counts = new Map<string, number>();
    for (const file of resolverConsumers(files)) {
      file.lines.forEach((line) => {
        if (isComment(line)) return;
        if (BASE_READ.test(line)) {
          counts.set(file.path, (counts.get(file.path) ?? 0) + 1);
        }
      });
    }

    const offenders = [...counts.entries()]
      .filter(([path, count]) => count > (ALLOWED_BASE_READS.get(path) ?? 0))
      .map(([path, count]) => `${path}: ${count} base reads`);

    expect(offenders).toEqual([]);
    // Every allowance is live: a dead one is a guard that would not notice being
    // shrunk to zero, which is how `.base.amount` came to match nothing at all
    // while claiming to police the only real base read in the tree.
    for (const [path, allowed] of ALLOWED_BASE_READS) {
      expect({ path, reads: counts.get(path) ?? 0 }).toEqual({
        path,
        reads: allowed,
      });
    }
  });

  /**
   * The resolver is the arithmetic layer. A consumer holding schedule rows asks
   * the occurrence service, which asks the resolver once -- so a new
   * `resolveMany` call site is a new occurrence-selection decision and has to be
   * argued for here.
   */
  it("calls the effective-amount resolver only from declared places", () => {
    // Also counted, for the same reason as the base reads above.
    const ALLOWED_RESOLVER_CALLS = new Map([
      // `resolveOne` delegates to `resolveMany`.
      ["scheduled-transactions/scheduled-effective-amount.service.ts", 1],
      // The one consumer: prices the occurrences it has expanded.
      ["scheduled-transactions/scheduled-occurrence.service.ts", 1],
      // The schedule-level list read model (see above).
      ["scheduled-transactions/scheduled-transactions.service.ts", 1],
    ]);

    const counts = new Map<string, number>();
    for (const file of resolverConsumers(files)) {
      file.lines.forEach((line) => {
        if (isComment(line)) return;
        if (/\.(resolveMany|resolveOne)\s*\(/.test(line)) {
          counts.set(file.path, (counts.get(file.path) ?? 0) + 1);
        }
      });
    }

    const offenders = [...counts.entries()]
      .filter(
        ([path, count]) => count > (ALLOWED_RESOLVER_CALLS.get(path) ?? 0),
      )
      .map(([path, count]) => `${path}: ${count} resolver calls`);

    expect(offenders).toEqual([]);
  });

  /**
   * Direction is a question about the occurrence, so the sign comes from
   * `directionAmount` -- never from a schedule row's stored amount compared
   * against zero.
   *
   * "An exchange rate is positive, so it cannot flip a sign" was written in three
   * places and is false for a mixed-sign split parent, where only the investment
   * line re-prices: a parent stored at -200 posts +150 once that line moves, so
   * AI/MCP called a deposit a bill, the forecast called an inflow an expense, and
   * a budget filter keyed on the snapshot dropped the reverse case outright.
   */
  it("decides an occurrence's direction from the occurrence", () => {
    // The one place the fallback lives: `directionAmount` is defined as the
    // occurrence's amount when known and the snapshot's sign when not.
    const DECIDERS = ["scheduled-transactions/scheduled-occurrence.service.ts"];

    const offenders: string[] = [];
    for (const file of resolverConsumers(files)) {
      if (DECIDERS.includes(file.path)) continue;
      file.lines.forEach((line, i) => {
        if (isComment(line)) return;
        if (STORED_SIGN.test(line)) offenders.push(`${file.path}:${i + 1}`);
      });
    }

    expect(offenders).toEqual([]);
  });

  /**
   * The candidate prefilter is an optimization over a semantic question, so it has
   * to be provably complete: it may narrow on the stored sign only while keeping
   * every shape whose sign something else can move.
   *
   * A base-only `st.amount < 0` gate dropped a +100 schedule whose next occurrence
   * was overridden to -250, and later a positive one whose override carried an
   * embedded investment split with no amount of its own. Both were invisible to a
   * test of the resolver, because the row never reached it.
   */
  it("keeps every shape whose direction is not the stored sign in the candidate read", () => {
    const source = files.find(
      (f) =>
        f.path === "scheduled-transactions/scheduled-occurrence.service.ts",
    );
    expect(source).toBeDefined();
    const body = source!.lines.filter((l) => !isComment(l)).join("\n");

    // The narrowing exists...
    expect(body).toContain("st.amount < 0");
    // ...and every escape from it is present: an FX-sensitive base, a base
    // investment split, and an override that carries either an amount or a shape.
    expect(body).toContain("st.isInvestment = true");
    expect(body).toContain("scheduled_transaction_splits");
    expect(body).toContain("scheduled_transaction_overrides ovr");
    expect(body).toContain("ovr.amount IS NOT NULL OR ovr.is_split = true");
    // And the direction itself is decided after pricing, never in the SQL.
    expect(body).toContain(
      "o.directionAmount === null || o.directionAmount < 0",
    );
  });

  /**
   * Direction has to be able to say "not derivable", or the implementation is
   * forced to invent an answer for a mixed-sign aggregate.
   */
  it("keeps the occurrence direction nullable", () => {
    const contract = files.find(
      (f) =>
        f.path === "scheduled-transactions/scheduled-occurrence.service.ts",
    );
    const arithmetic = files.find(
      (f) =>
        f.path ===
        "scheduled-transactions/scheduled-effective-amount.service.ts",
    );
    expect(contract!.lines.join("\n")).toContain(
      "directionAmount: number | null",
    );
    expect(arithmetic!.lines.join("\n")).toContain(
      "directionAmount: number | null",
    );
    // The fallback is conditional on the sign being provable -- an unconditional
    // `?? Number(row.amount)` is the shape this guards against.
    const body = contract!.lines.filter((l) => !isComment(l)).join("\n");
    expect(body).not.toMatch(/directionAmount:\s*\w+\.amount\s*\?\?/);
  });

  // The predicates themselves, pinned: a guard whose matcher quietly stopped
  // matching would report a clean tree for ever.
  describe("its own matchers", () => {
    it("recognises the shapes it bans", () => {
      const lines = [
        "    while (d <= horizon) {",
        "      const next = calculateNextDueDate(d, s.frequency);",
      ];
      expect(insideLoop(lines, 1)).toBe(true);
      expect(
        /overrideEffectiveKey\s*\(/.test(
          "resolved.overrides.get(overrideEffectiveKey(o))",
        ),
      ).toBe(true);
      expect(
        /\.base\.(amount|complete|currencyCode)\b/.test(
          "effective.get(r.id)!.base.amount",
        ),
      ).toBe(true);
      expect(
        /\.(resolveMany|resolveOne)\s*\(/.test(
          "await this.effectiveAmounts.resolveMany(userId, rows)",
        ),
      ).toBe(true);
      // The three shapes it actually caught, including the ALIASED one that the
      // old name-alternating matcher let through.
      expect(
        BASE_READ.test("const amount = own ? own.effective : resolved.base"),
      ).toBe(true);
      expect(BASE_READ.test("effectiveAmount: resolved.base.amount")).toBe(
        true,
      );
      expect(BASE_READ.test("const b = resolved.base; return b.amount")).toBe(
        true,
      );
      // A spread of an unrelated local is not a base read.
      expect(
        BASE_READ.test("previewRows.push({ ...base, error: reason })"),
      ).toBe(false);
      expect(
        STORED_SIGN.test('return Number(row.amount) < 0 ? "bill" : "d"'),
      ).toBe(true);
      expect(STORED_SIGN.test("const isIncome = Number(st.amount) > 0")).toBe(
        true,
      );
      expect(
        STORED_SIGN.test(
          "isIncome: (occurrence.amount ?? Number(b.amount)) > 0",
        ),
      ).toBe(true);
      // And the shapes that are the correct answer, so it does not ban them.
      expect(STORED_SIGN.test("occurrence.directionAmount < 0")).toBe(false);
      expect(STORED_SIGN.test("roundMoney(Number(row.amount))")).toBe(false);
    });

    it("does not fire on the prose that describes them", () => {
      expect(isComment("   * `resolved.base` is the wrong member here")).toBe(
        true,
      );
      expect(isComment("// calculateNextDueDate in a while loop")).toBe(true);
      expect(isComment("const own = resolved.overrides.get(key);")).toBe(false);
    });

    it("does not fire on a single advance outside a loop", () => {
      const lines = [
        "  private advance(row: ScheduledTransaction): string {",
        "    return calculateNextDueDate(row.nextDueDate, row.frequency);",
      ];
      expect(insideLoop(lines, 1)).toBe(false);
    });
  });
});
