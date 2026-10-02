import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";
import { TRACKED_PROVIDERS } from "./providers";

const SRC_ROOT = join(__dirname, "..");

/**
 * The clients whose outbound calls have to be answerable to a circuit breaker,
 * because these are the ones a whole deployment's worth of requests fan out
 * into (issue #1265).
 *
 * Market data was the original scope. `payees/lookup/google-places` joined it
 * because the payee contact lookup has the same fan-out shape -- one request
 * per payee, from every user, against one third-party host -- even though it
 * runs in front of a waiting person rather than in a background refresh.
 *
 * `bank-sync/providers/enable-banking` joined for the same reason: the daily
 * bank sync makes one call per linked bank account for every user, against one
 * third-party host.
 *
 * Still scoped deliberately. The FX, AI, favicon, release-check and
 * breach-check callers have the same shape and are named in
 * `docs/specs/provider-outage-alerts.md` as the next adopters; widening this
 * scan before they adopt would only be a failing test nobody can fix in one
 * change.
 */
const GUARDED_DIRS = [
  "securities",
  "payees/lookup/google-places",
  "bank-sync/providers/enable-banking",
];

/** A bare global `fetch(` or a raw `https.get(` -- an outbound request. */
const OUTBOUND_CALL = /(?<![.\w])fetch\(|https\.(get|request)\(/;

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

function guardedFiles(): Array<{ path: string; source: string }> {
  return GUARDED_DIRS.flatMap((dir) => sourceFiles(join(SRC_ROOT, dir))).map(
    (path) => ({
      path: relative(SRC_ROOT, path),
      source: readFileSync(path, "utf8"),
    }),
  );
}

describe("outbound provider calls are answerable to the breaker", () => {
  it("finds the clients it is guarding", () => {
    // A scan that silently matches nothing is the failure mode of every guard
    // in this repo, so it asserts its own subject exists first.
    const callers = guardedFiles().filter((file) =>
      OUTBOUND_CALL.test(file.source),
    );
    expect(callers.map((file) => file.path).sort()).toEqual([
      "bank-sync/providers/enable-banking/enable-banking.client.ts",
      "payees/lookup/google-places/google-places.client.ts",
      "securities/deutsche-boerse-finance.service.ts",
      "securities/lse-finance.service.ts",
      "securities/msn-finance.service.ts",
      "securities/security-news.service.ts",
      "securities/yahoo-finance.service.ts",
    ]);
  });

  it.each(guardedFiles().filter((file) => OUTBOUND_CALL.test(file.source)))(
    "$path routes its availability through ProviderHealthService",
    ({ path, source }) => {
      // The exemption is positive and narrow: SecurityNewsService fetches
      // thumbnail bytes for an image the page has already been given a URL for,
      // one request per rendered image, from the URL the news payload carried --
      // there is no symbol loop behind it and no provider host it owns.
      if (path === "securities/security-news.service.ts") {
        expect(source).toContain("private async fetchImage(");
        return;
      }
      // The relative depth differs by where the client lives, so the assertion
      // is on the module it reaches, not on one spelling of the path.
      expect(source).toMatch(
        /from "(?:\.\.\/)+provider-health\/provider-health\.service"/,
      );
      expect(source).toMatch(/this\.health\.(tryRequest|assertAvailable)\(/);
      expect(source).toContain("this.health.recordSuccess(");
      // `wouldRefuse` reads without taking the half-open probe slot, so as a
      // gate it lets every caller through the instant an open window elapses --
      // the herd the slot exists to prevent.
      //
      // The ban is on the *negated* form, because that is exactly the misuse:
      // `if (!wouldRefuse(...)) { fetch(...) }` reads "may I call", which is a
      // gate. The positive form reads "should I stop", which is what it is for
      // -- skipping work whose gate has already been taken (the crumb
      // handshake's second cookie source) or that should not be started at all
      // (MarketIndexService's per-index cooldown).
      expect(source).not.toMatch(/!\s*this\.health\.wouldRefuse\(/);
    },
  );

  it.each(guardedFiles())(
    "$path does not log a provider failure as a bare stack",
    ({ source }) => {
      // `TypeError: fetch failed` plus undici's own frames is what issue #1265
      // filled the log with: true, and impossible to act on. The diagnostic
      // goes through describeFetchFailure (usually via logFailure), which names
      // the cause chain instead.
      expect(source).not.toContain("error.stack");
      expect(source).not.toContain("err.stack");
    },
  );
});

describe("a response is recorded in one place per client", () => {
  /**
   * Nine `if (!response.ok)` branches each recorded the answer for themselves,
   * and two forgot -- leaving the exclusive half-open probe slot held for two
   * minutes against a provider that had just answered a routine 404. The rule
   * moved to the places each client funnels requests through, and the count is
   * what keeps it from drifting back out:
   *
   * - Yahoo: three. `throttledFetch`'s non-2xx rule, `readBody`'s
   *   body-completion rule, and the crumb handshake, which is a raw `fetch`
   *   outside `throttledFetch`.
   * - MSN: four. Two request helpers, each with a non-2xx branch and a
   *   body-completion point; it has no shared fetch helper to hang the rule on.
   *
   * A number going *up* means a branch started recording for itself again.
   */
  it.each([
    ["securities/yahoo-finance.service.ts", 3],
    ["securities/msn-finance.service.ts", 4],
    // Google Places: two. The non-2xx branch, which is a complete answer, and
    // the point the body finishes arriving -- the same split Yahoo documents.
    ["payees/lookup/google-places/google-places.client.ts", 2],
    // Enable Banking: two, the same split as Google Places. Every call funnels
    // through one `request` method, so the rule lives there once.
    ["bank-sync/providers/enable-banking/enable-banking.client.ts", 2],
  ])("%s records an arrived response in at most %i places", (file, allowed) => {
    const source = readFileSync(join(SRC_ROOT, file), "utf8");
    const occurrences = source.split("recordSuccess(").length - 1;
    expect(occurrences).toBeLessThanOrEqual(allowed);
    expect(occurrences).toBeGreaterThan(0);
  });
});

describe("tracked provider ids", () => {
  it.each(Object.keys(TRACKED_PROVIDERS))(
    "%s is the id some client actually reports under",
    (provider) => {
      // The id is the primary key of the durable alert state. A renamed or
      // orphaned id would silently start a fresh outage episode, so the label
      // table and the clients have to agree.
      const used = GUARDED_DIRS.flatMap((dir) =>
        sourceFiles(join(SRC_ROOT, dir)),
      ).some((path) => readFileSync(path, "utf8").includes(`"${provider}"`));
      expect(used).toBe(true);
    },
  );
});
