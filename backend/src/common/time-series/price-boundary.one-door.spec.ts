import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

/**
 * `docs/time-series-contract.md` section 2.1: turning a stored observation into
 * a value-for-a-date must go through the shared helper that applies the
 * staleness window, and adding a second unbounded path beside the bounded one is
 * how the rule ends up with a constant, a docstring and three call sites that
 * ignore both. The contract asks for a scanning test "in the manner of
 * `frontend/src/test/ui-conventions.test.ts`", because the prose form of this
 * rule cannot see a new call site. This is it.
 *
 * What it looks for: a *newest-observation* read of a price or rate -- a date
 * ordered descending beside a one-row fetch (`findOne`, `take(1)`, `LIMIT 1`,
 * `DISTINCT ON`, `ROW_NUMBER() ... = 1`) -- with no lower bound on the date
 * nearby. Ordering a list by date descending is not that, and is not flagged.
 *
 * Matching is done over a window of lines around each ordering rather than over
 * the whole file: a file usually contains several queries, and a bounded one
 * elsewhere in it says nothing about this one. That imprecision is what the
 * first draft of this guard got wrong, and it hid two of the sites below.
 *
 * The baseline is **shrink-only**. Every entry is a site that predates the
 * guard, with the reason it is tolerated. A new one fails the build; fixing one
 * means deleting its line here in the same change.
 */

const SRC_ROOT = join(__dirname, "..", "..");

/** How many lines either side of the ordering count as the same statement. */
const WINDOW = 12;

/**
 * Sites that already read a latest price or rate with no lower date bound.
 *
 * These are not endorsements. Each is somewhere the contract's rule 2 would want
 * revisited; recording them is what lets the guard be switched on today rather
 * than after a refactor nobody has scheduled. New code must not join the list --
 * `closeAt` in `price-boundary.util.ts` is the door.
 */
const BASELINE: ReadonlyArray<{ file: string; reason: string }> = [
  {
    file: "securities/security-price.service.ts",
    reason:
      "getLatestPrice / getPriceHistory: the newest stored close for a " +
      "security, feeding quote display and staleness reporting rather than a " +
      "computed return. GemPriceService.latestPrices is the bounded door for " +
      "valuation.",
  },
  {
    file: "securities/portfolio.service.ts",
    reason:
      "getLatestPrices and the ROW_NUMBER latest-close CTEs behind the " +
      "portfolio summary. Bounding these changes what the Investments page " +
      "reports as a position's value, which is a separate decision from this " +
      "chart.",
  },
  {
    file: "securities/sector-weighting.service.ts",
    reason: "Latest close per security for sector weighting by market value.",
  },
  {
    file: "securities/securities.service.ts",
    reason:
      "Latest price *source* per security (which provider last wrote), and " +
      "the securities list's latest-close column. The source is metadata " +
      "about the row, not a value-for-a-date.",
  },
];

const DATE_ORDER_DESC =
  /(?:priceDate|rateDate|price_date|rate_date)["'\s]*[,:]?\s*["']?DESC/;
const SINGLE_ROW =
  /\bfindOne\b|\.take\(1\)|\.limit\(1\)|LIMIT\s+1|DISTINCT ON|ROW_NUMBER\s*\(/;
const LOWER_BOUND =
  /MoreThanOrEqual|Between\s*\(|(?:price_date|rate_date|priceDate|rateDate)\s*>=/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      return entry === "node_modules" ? [] : sourceFiles(full);
    }
    if (!entry.endsWith(".ts") || entry.endsWith(".spec.ts")) return [];
    return [full];
  });
}

/**
 * The door itself is exempt, as `DateInput.tsx` is from the raw-date-input scan:
 * `price-series.util.ts` samples buckets with `DISTINCT ON` under a window whose
 * lower bound is a parameter forty lines above the ordering, and
 * `price-boundary.util.ts` is where the bound is defined.
 */
const DOOR = "common/time-series/";

/** Files holding at least one unbounded newest-observation read. */
function findOffenders(): string[] {
  const offenders = new Set<string>();
  for (const file of sourceFiles(SRC_ROOT)) {
    if (relative(SRC_ROOT, file).replace(/\\/g, "/").startsWith(DOOR)) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      if (!DATE_ORDER_DESC.test(line)) return;
      const window = lines
        .slice(Math.max(0, index - WINDOW), index + WINDOW + 1)
        .join("\n");
      if (SINGLE_ROW.test(window) && !LOWER_BOUND.test(window)) {
        offenders.add(relative(SRC_ROOT, file).replace(/\\/g, "/"));
      }
    });
  }
  return [...offenders].sort();
}

describe("one door for a value-for-a-date", () => {
  const offenders = findOffenders();

  it("has no unbounded latest-price read outside the recorded baseline", () => {
    const allowed = new Set(BASELINE.map((entry) => entry.file));
    expect(offenders.filter((file) => !allowed.has(file))).toEqual([]);
  });

  it("keeps the baseline shrink-only", () => {
    // A baseline entry whose file no longer offends has been fixed: delete the
    // line rather than leaving a licence nothing is using.
    const found = new Set(offenders);
    expect(
      BASELINE.map((entry) => entry.file)
        .filter((file) => !found.has(file))
        .sort(),
    ).toEqual([]);
  });

  it("every baseline entry states why it is tolerated", () => {
    for (const entry of BASELINE) {
      expect(entry.reason.length).toBeGreaterThan(30);
    }
  });
});
