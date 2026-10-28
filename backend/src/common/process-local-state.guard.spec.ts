import { readFileSync } from "node:fs";
import { join } from "node:path";
import { globSync } from "glob";

import { extractTsComments } from "./repo-paths.util";

/**
 * Every backend replica is interchangeable, so a `Map` or a `Set` held on a
 * class is state only *this* process can see. Where that state decides
 * something -- an attempt budget, a replay window, a claim, a session -- N
 * replicas mean N answers, and the deployment quietly gets N times the limit it
 * wrote down. That is the whole of the horizontal-scaling work
 * (`docs/specs/horizontal-scaling.md`): the counters, the single-use
 * artifacts, the relay queue and the signing keys became rows.
 *
 * `db/derived-state-writers.guard.spec.ts` already scans the files containing an
 * `@Cron(` for this shape, with a narrower and stronger claim (a cron guard held
 * in memory is not a guard). This is the same scan widened to the whole tree,
 * where the claim is weaker and the answer is therefore an allowlist rather than
 * a refusal: some per-replica state is correct, and the point of the guard is
 * that each instance is a *written* decision instead of an unexamined default.
 *
 * What it can and cannot see:
 *
 *  - It matches `Map`, `Set` and `EmptyWindowMemory` fields at class scope. A
 *    `new Map()` inside a method is a local and never matches -- the regex
 *    anchors on the `private`/`protected` modifier.
 *  - It skips a field whose declared type is `ReadonlySet`/`ReadonlyMap`: the
 *    type already forbids the mutation this guard is about, and a constant
 *    lookup table is not state. That is the machine holding the rule, which is
 *    the shape this repo prefers to an allowlist entry.
 *  - It does not match arrays, scalars or `WeakMap`/`WeakSet`, so it is not the
 *    whole of the "is this per-replica state correct?" question. The design
 *    doc's "Per-replica state that stays" table is; `yahoo-finance.service.ts`'s
 *    crumb and `email.service.ts`'s failure scalars are in that table and out
 *    of this regex's reach.
 *  - It reads code, not comments: a `private readonly x = new Map()` written out
 *    in a doc comment as an example is blanked before the scan.
 *
 * The allowlist is keyed by `path#field` rather than by file, so a new map in a
 * file that already has one is still reported, and by field rather than by line
 * so moving a declaration does not churn it. It may shrink; it grows only with a
 * reason in the same PR that adds the field.
 */
const SRC = join(__dirname, "..");

/**
 * `private readonly x = new Map<...>()`, with or without a type annotation in
 * front of the `=`.
 */
const ASSIGNED_FIELD =
  /^\s*(?:private|protected)\s+(?:static\s+)?(?:readonly\s+)?(\w+)\s*(?::[^=;]*)?=\s*new\s+(?:Map|Set|EmptyWindowMemory)\b/;

/**
 * `private readonly x: Map<...>;` -- declared on the class and assigned in the
 * constructor, which is the same state written in two places.
 */
const DECLARED_FIELD =
  /^\s*(?:private|protected)\s+(?:static\s+)?(?:readonly\s+)?(\w+)\s*[!?]?\s*:\s*(?:Map|Set|EmptyWindowMemory)\s*[<;]/;

function sourceFiles(): string[] {
  return globSync("**/*.ts", {
    cwd: SRC,
    absolute: true,
    ignore: ["**/*.spec.ts", "**/*.d.ts", "**/node_modules/**"],
  });
}

/**
 * A field the type system has already made immutable is not state -- but only
 * when the binding is immutable too. `private x: ReadonlySet<string> = new
 * Set()` forbids `add` and still allows `this.x = new Set([...])`, which is
 * process state by another route, so the skip requires `readonly` as well.
 */
const READONLY_FIELD = /\breadonly\s+\w+\s*:\s*Readonly(?:Set|Map)\s*</;

function relative(file: string): string {
  return file.slice(SRC.length + 1).replace(/\\/g, "/");
}

/**
 * `source` with every comment body replaced by spaces, newlines kept, so a line
 * number in the report still points at the line the field is on.
 *
 * `extractTsComments` returns the bodies in source order but not their
 * positions, so they have to be located again -- and a plain `indexOf` is
 * unsound: a short body such as `" delete"` matches inside code before it
 * reaches the comment it came from, and blanking there corrupts the source the
 * scan is about to read. That is measurable rather than theoretical; it happens
 * in `ai/query/tool-input-schemas.ts` today.
 *
 * So a landing site is accepted only where a comment can actually begin,
 * immediately after `//` or the block opener. When no such site is found the
 * comment is left in place, which is the safe direction: an unblanked comment
 * can only add an offender the report names out loud, never hide one.
 */
function blankComments(source: string): string {
  let out = source;
  let cursor = 0;
  for (const body of extractTsComments(source)) {
    if (body === "") continue;
    const at = commentBodyStart(out, body, cursor);
    if (at === -1) continue;
    out =
      out.slice(0, at) +
      body.replace(/[^\n]/g, " ") +
      out.slice(at + body.length);
    cursor = at + body.length;
  }
  return out;
}

/** The first occurrence of `body` at or after `from` that a `//` or `/*` opens. */
function commentBodyStart(source: string, body: string, from: number): number {
  for (let at = source.indexOf(body, from); at !== -1;) {
    const opener = source.slice(Math.max(0, at - 2), at);
    if (opener === "//" || opener === "/*") return at;
    at = source.indexOf(body, at + 1);
  }
  return -1;
}

interface Field {
  /** `path#field`, the allowlist key. */
  key: string;
  /** `path:line`, what the report shows. */
  at: string;
  /** Which regex matched, for the vacuity anchor. */
  shape: "assigned" | "declared";
}

function processLocalFields(): Field[] {
  const fields: Field[] = [];
  for (const file of sourceFiles()) {
    const path = relative(file);
    const lines = blankComments(readFileSync(file, "utf8")).split("\n");
    lines.forEach((line, index) => {
      if (READONLY_FIELD.test(line)) return;
      const assigned = ASSIGNED_FIELD.exec(line);
      const declared = assigned ? null : DECLARED_FIELD.exec(line);
      const match = assigned ?? declared;
      if (!match) return;
      fields.push({
        key: `${path}#${match[1]}`,
        at: `${path}:${index + 1}`,
        shape: assigned ? "assigned" : "declared",
      });
    });
  }
  return fields;
}

/**
 * Every class-scope `Map`/`Set` in the tree that is allowed to stay per replica,
 * with the reason it is allowed. Seeded from the "Per-replica state that stays"
 * table in `docs/specs/horizontal-scaling.md`.
 */
const ALLOWED = new Map<string, string>([
  // -- Sockets and connections this process owns ---------------------------
  [
    "ai/relay/relay-stream.registry.ts#streams",
    "an `emit` closure writes to an SSE socket this process holds, so it can " +
      "no more move to a row than the controller's heartbeat interval can. " +
      "Everything a second replica must see is a row in `ai_relay_prompts`; " +
      "this map only decides whether an interim event reaches a browser " +
      "parked here or is buffered for pickup",
  ],
  [
    "common/cluster/pg-listener.provider.ts#channels",
    "the channels this process wants, replayed onto the new session after a " +
      "reconnect: it describes this connection, and there is nothing to share",
  ],
  [
    "common/cluster/pg-listener.provider.ts#handlers",
    "the in-process callbacks for notifications arriving on this replica's " +
      "own listening connection",
  ],
  [
    "common/events/memory-event-bus.ts#handlers",
    "the `CLUSTER_MODE=single` bus: there is no second process to reach, and " +
      "in `multi` this class is not the bound implementation",
  ],
  [
    "common/events/postgres-event-bus.ts#handlers",
    "local fan-out for a wake-up that arrived over LISTEN: the delivery " +
      "across replicas is `pg_notify`, and this map is the last hop to the " +
      "requests this replica is currently serving",
  ],
  [
    "mcp/mcp-http.controller.ts#transports",
    "a 2025-era MCP session's live state is this pod's open SSE stream and " +
      "the promise a `confirmWrite` elicitation is waiting on, neither of " +
      "which is addressable by a session id. M1 made sticky routing on the " +
      "MCP path a documented deployment requirement instead (`docs/backend/mcp.md`)",
  ],
  [
    "mcp/mcp-http.controller.ts#servers",
    "the `McpServer` bound to that transport; see `#transports`",
  ],
  [
    "mcp/mcp-http.controller.ts#sessionUsers",
    "the identity behind a transport this pod holds; persisting it would " +
      "rebuild no transport. See `#transports`",
  ],
  [
    "mcp/mcp-http.controller.ts#sessionCreatedAt",
    "the sweep age for a transport this pod holds; see `#transports`",
  ],

  // -- Caches: a miss costs a round trip and changes no row ----------------
  [
    "common/time-series/history-fill.ts#expiries",
    "`EmptyWindowMemory` itself -- a cache, not a guard; a cold replica costs " +
      "one extra provider fetch behind an idempotent upsert",
  ],
  [
    "currencies/exchange-rate.service.ts#emptyRateWindows",
    "the empty-window negative cache for FX history; gates nothing, and the " +
      "write behind it is an upsert on `(from, to, rate_date)`",
  ],
  [
    "securities/security-price.service.ts#emptyPriceWindows",
    "the same negative cache for security prices, with the same upsert behind it",
  ],
  [
    "currencies/exchange-rate-history.service.ts#emptyWindows",
    "the empty-window negative cache for the user-driven gap fill; a window " +
      "the provider answered with nothing cannot be filled by asking again, " +
      "and a cold replica costs one extra fetch behind the same upsert",
  ],
  [
    "currencies/providers/yahoo-fx.provider.ts#reverseFirst",
    "Yahoo pairs whose direct symbol answered the 0.01 placeholder, asked " +
      "reverse-first; a call-order hint that changes no rate (every answer " +
      "still passes the same cross-check), bounded, and a cold replica costs " +
      "one extra quote call",
  ],
  [
    "currencies/exchange-rate-history.service.ts#inFlight",
    "a coalescer, not a guard: a double-clicked button costs one provider " +
      "call instead of two, and a replica that has not seen the first click " +
      "simply makes the call",
  ],
  [
    "payees/lookup/payee-contact-enrichment.service.ts#inFlight",
    "the same coalescer for background contact lookups; a re-dispatch on " +
      "another replica costs one lookup and writes the same row",
  ],
  [
    "securities/security-news.service.ts#cache",
    "short-TTL news cache; a miss costs one provider call",
  ],
  [
    "securities/portfolio.service.ts#intradayCache",
    "short-TTL intraday quote cache; a miss costs one provider call",
  ],
  [
    "securities/msn-finance.service.ts#instrumentIdCache",
    "provider instrument-id lookups; a miss costs one resolution call",
  ],
  [
    "securities/lse-finance.service.ts#instrumentCache",
    "short-TTL LSE instrument master (currency, name); a miss costs one lookup",
  ],
  [
    "securities/deutsche-boerse-finance.service.ts#currencyCache",
    "short-TTL Deutsche Börse ISIN currency; a miss costs one lookup",
  ],
  [
    "securities/portfolio-summary-memo.ts#entries",
    "a request-coalescing memo keyed by user, scope, currency and the acting " +
      "identity, held for seconds; its invalidation is announced on the " +
      "EVENT_BUS and applied by every replica, so what N replicas cost is N " +
      "computations of the same summary, never a stale one past the announcement",
  ],
  [
    "net-worth/daily-investments-in-flight.ts#entries",
    "in-flight promises only, dropped when they settle, keyed by user, window, " +
      "scope, currency and the acting identity; the summary memo's announced " +
      "invalidation drops them on every replica, so N replicas cost N " +
      "concurrent valuations of the same series, never a finished one served",
  ],
  [
    "backup/support-backup/support-backup.service.ts#rawCache",
    "preview and generate landing on different replicas degrade to two " +
      "exports; documented on the endpoint",
  ],

  // -- Per-replica by construction, or a soft budget that may multiply -----
  [
    "provider-health/provider-health.service.ts#circuits",
    "the breaker describes this replica's own sockets; episode start and " +
      "notification markers are already shared rows",
  ],
  [
    "provider-health/provider-health.service.ts#logStates",
    "log-line suppression per provider; costs at most one extra line per replica",
  ],
  [
    "provider-health/provider-health.service.ts#lastPersistedAt",
    "throttles how often this replica writes its own breaker state to the row",
  ],
  [
    "provider-health/provider-health.service.ts#successPersisted",
    "one extra write per provider per process, deliberately, so a restart " +
      "cannot leave a `down` row for a provider that is answering",
  ],
  [
    "provider-health/provider-health.service.ts#writeQueues",
    "orders this process's own writes; ordering across replicas is the row's " +
      "conditional update, not this",
  ],
  [
    "common/interceptors/request-context.interceptor.ts#lastActivityWrite",
    "up to N activity writes per five minutes instead of one; harmless",
  ],
  [
    "common/throttler/postgres-throttler-storage.ts#blockedUntilByKey",
    "a refusal this replica already saw from the database. Sound because a " +
      "block only moves forward or lapses, so it can only refuse during a " +
      "period the database would also have refused",
  ],
  [
    "notifications/provider-outage-alert.service.ts#noRecipientsReported",
    "suppresses a repeated log line and gates no work: whether an alert is " +
      "sent is decided by the conditional UPDATE on `provider_health`",
  ],
  [
    "ai/insights/ai-insights.service.ts#generatingUsers",
    "a cheap local short-circuit ONLY; the exclusion is a durable lease",
  ],
  [
    "net-worth/net-worth.service.ts#recalcTimers",
    "a debounce registry, not a guard: duplicate work is an absolute " +
      "recomputation under the account lock, and a lost timer's two jobs -- the " +
      "snapshot recompute and the balance-threshold evaluation behind its " +
      "compare-and-set latch -- are both recovered by `sweepStaleSnapshots` " +
      "reading `accounts.updated_at`",
  ],

  // -- Not process state at all: per-request value objects ----------------
  [
    "securities/daily-movement.service.ts#values",
    "`MovementModel` is a value object built and discarded inside one request; " +
      "these maps are its indexes over what that request read",
  ],
  [
    "securities/daily-movement.service.ts#flows",
    "per-request index on `MovementModel`; see `#values`",
  ],
  [
    "securities/daily-movement.service.ts#holdings",
    "per-request index on `MovementModel`; see `#values`",
  ],
  [
    "securities/daily-movement.service.ts#securities",
    "per-request index on `MovementModel`; see `#values`",
  ],
  [
    "common/fx-aggregate.ts#missing",
    "`FxAggregate` is an accumulator a caller constructs, fills and reads " +
      "within one calculation; the set is the currency pairs that calculation " +
      "could not convert",
  ],
]);

describe("process-local state is a written decision, not a default", () => {
  it("holds no class-scope Map or Set outside the allowlist", () => {
    const offenders = processLocalFields()
      .filter((field) => !ALLOWED.has(field.key))
      .map((field) => field.at);

    // A new entry here means: either move the state to a row (the mechanisms
    // are in `docs/concurrency-and-idempotency.md` section 2), or add the field
    // to ALLOWED with the reason N copies of it are correct.
    expect(offenders).toEqual([]);
  });

  it("carries no allowlist entry for a field that is gone", () => {
    const present = new Set(processLocalFields().map((field) => field.key));
    const stale = [...ALLOWED.keys()].filter((key) => !present.has(key));

    // The list may only shrink, and it shrinks here: a field that was moved to
    // a row or renamed leaves its exemption behind, ready to re-exempt the next
    // field that happens to take the name.
    expect(stale).toEqual([]);
  });

  it("scans both field shapes and reads code only, so neither is vacuous", () => {
    const fields = processLocalFields();

    expect(fields.some((field) => field.shape === "assigned")).toBe(true);
    expect(fields.some((field) => field.shape === "declared")).toBe(true);

    // A comment body that also occurs in the code before it must not drag the
    // blanking onto that code. Locating comments by a bare `indexOf` did, which
    // left the scan reading a corrupted file; this is that mistake as a case.
    // The literal below is the shape that actually collides in this tree:
    // `ai/query/tool-input-schemas.ts` holds "...not used for delete." and a
    // `// delete` comment after it, and a bare indexOf blanked the message.
    const collision = [
      'const message = "attachments are not used for delete.";',
      "class C {",
      "  // delete",
      "  private readonly seen = new Map<string, number>();",
      "}",
    ].join("\n");
    const blanked = blankComments(collision);
    expect(blanked).toContain(
      'const message = "attachments are not used for delete.";',
    );
    expect(blanked.split("\n").some((line) => ASSIGNED_FIELD.test(line))).toBe(
      true,
    );

    // A method-local map is not a field, and a field written out in a doc
    // comment is not code.
    const sample = [
      "class C {",
      "  /** private readonly ghost = new Map<string, number>(); */",
      "  run() {",
      "    const seen = new Map<string, number>();",
      "    return seen;",
      "  }",
      "}",
    ].join("\n");
    const lines = blankComments(sample).split("\n");
    expect(lines).toHaveLength(7);
    expect(
      lines.some(
        (line) => ASSIGNED_FIELD.test(line) || DECLARED_FIELD.test(line),
      ),
    ).toBe(false);
  });
});
