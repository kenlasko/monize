import {
  applySnapshot,
  BridgeState,
  initialBridgeState,
  MAX_RAISED_PER_SNAPSHOT,
  MAX_REMEMBERED_ROWS,
  notificationUrl,
  stopBridge,
} from "./notification-bridge";
import { BridgeRow, BridgeSnapshot } from "./notification-snapshot";

const START = Date.parse("2026-11-13T10:00:00.000Z");
const ORIGIN = "http://127.0.0.1:3380";

function row(id: string, offsetMs: number, target: string | null = null) {
  return {
    id,
    createdAtMs: START + offsetMs,
    title: `title ${id}`,
    body: `body ${id}`,
    target,
  } satisfies BridgeRow;
}

function signedIn(identity: string, ...rows: BridgeRow[]): BridgeSnapshot {
  return { identity, rows };
}

const SIGNED_OUT: BridgeSnapshot = { identity: null, rows: [] };

/** Applies snapshots in order, returning every id raised along the way. */
function run(state: BridgeState, ...snapshots: [BridgeSnapshot, number][]) {
  let current = state;
  const raised: string[] = [];
  for (const [snapshot, now] of snapshots) {
    const step = applySnapshot(current, snapshot, now);
    current = step.state;
    raised.push(...step.effect.raise.map((r) => r.id));
  }
  return { raised };
}

describe("applySnapshot", () => {
  it("raises a row created after the bridge started", () => {
    const step = applySnapshot(
      initialBridgeState(START),
      signedIn("u1", row("a", 5_000, "/bills")),
      START + 6_000,
    );
    expect(step.effect.raise.map((r) => r.id)).toEqual(["a"]);
    expect(step.effect.overflow).toBe(0);
    expect(step.state.raised).toEqual(["a"]);
  });

  it("raises nothing older than the bridge's start (no flood at launch)", () => {
    const step = applySnapshot(
      initialBridgeState(START),
      signedIn("u1", row("old", -60_000), row("older", -3_600_000)),
      START + 1_000,
    );
    expect(step.effect.raise).toEqual([]);
    expect(step.effect.overflow).toBe(0);
  });

  it("never raises a row twice, across any number of snapshots", () => {
    const a = row("a", 1_000);
    const { raised } = run(
      initialBridgeState(START),
      [signedIn("u1", a), START + 2_000],
      [signedIn("u1", a), START + 62_000],
      [signedIn("u1", row("b", 70_000), a), START + 122_000],
      [signedIn("u1", row("b", 70_000), a), START + 182_000],
    );
    expect(raised).toEqual(["a", "b"]);
  });

  it("does not re-raise a row that was read and then reappears", () => {
    const a = row("a", 1_000);
    const { raised } = run(
      initialBridgeState(START),
      [signedIn("u1", a), START + 2_000],
      [signedIn("u1"), START + 62_000],
      [signedIn("u1", a), START + 122_000],
    );
    expect(raised).toEqual(["a"]);
  });

  it("caps a burst and counts the rest into one summary, newest first", () => {
    const rows = ["a", "b", "c", "d", "e"].map((id, index) =>
      row(id, (index + 1) * 1_000),
    );
    const step = applySnapshot(
      initialBridgeState(START),
      signedIn("u1", ...rows),
      START + 10_000,
    );
    expect(step.effect.raise.map((r) => r.id)).toEqual(["e", "d", "c"]);
    expect(step.effect.raise).toHaveLength(MAX_RAISED_PER_SNAPSHOT);
    expect(step.effect.overflow).toBe(2);
    // The summarised rows are handled too: the next poll raises none of them.
    const next = applySnapshot(
      step.state,
      signedIn("u1", ...rows),
      START + 70_000,
    );
    expect(next.effect.raise).toEqual([]);
    expect(next.effect.overflow).toBe(0);
  });

  it("raises a duplicated row once", () => {
    const a = row("a", 1_000);
    const step = applySnapshot(
      initialBridgeState(START),
      signedIn("u1", a, a),
      START + 2_000,
    );
    expect(step.effect.raise.map((r) => r.id)).toEqual(["a"]);
  });

  it("takes back a raised row once it is read or dismissed", () => {
    const first = applySnapshot(
      initialBridgeState(START),
      signedIn("u1", row("a", 1_000), row("b", 2_000)),
      START + 3_000,
    );
    const next = applySnapshot(
      first.state,
      signedIn("u1", row("b", 2_000)),
      START + 63_000,
    );
    expect(next.effect.retract).toEqual(["a"]);
    expect(next.effect.clearAll).toBe(false);
    expect(next.state.raised).toEqual(["b"]);
  });

  it("clears everything on sign-out and raises nothing while signed out", () => {
    const first = applySnapshot(
      initialBridgeState(START),
      signedIn("u1", row("a", 1_000)),
      START + 2_000,
    );
    const out = applySnapshot(first.state, SIGNED_OUT, START + 3_000);
    expect(out.effect.clearAll).toBe(true);
    expect(out.state.raised).toEqual([]);
    expect(out.state.identity).toBeNull();
    const again = applySnapshot(out.state, SIGNED_OUT, START + 4_000);
    expect(again.effect.clearAll).toBe(false);
  });

  it("does not replay the previous person's rows, or the next person's history", () => {
    const first = applySnapshot(
      initialBridgeState(START),
      signedIn("u1", row("a", 1_000)),
      START + 2_000,
    );
    // A second person signs in on the same PC, without a signed-out snapshot
    // between: their rows from before the switch are history.
    const second = applySnapshot(
      first.state,
      signedIn("u2", row("x", 1_500), row("y", 9_000)),
      START + 10_000,
    );
    expect(second.effect.clearAll).toBe(true);
    expect(second.effect.raise).toEqual([]);
    expect(second.state.floorMs).toBe(START + 10_000);
    const later = applySnapshot(
      second.state,
      signedIn("u2", row("z", 20_000), row("y", 9_000)),
      START + 30_000,
    );
    expect(later.effect.raise.map((r) => r.id)).toEqual(["z"]);
  });

  it("raises again for the same person after they sign back in, but only new rows", () => {
    const { raised } = run(
      initialBridgeState(START),
      [signedIn("u1", row("a", 1_000)), START + 2_000],
      [SIGNED_OUT, START + 3_000],
      [signedIn("u1", row("b", 4_000), row("a", 1_000)), START + 5_000],
    );
    expect(raised).toEqual(["a", "b"]);
  });

  it("keeps the bridge's start as the floor when the first snapshot is signed out", () => {
    // A launch that shows the sign-in page first: rows produced by the first
    // list after sign-in (bill reminders are materialized on read) still count.
    const out = applySnapshot(
      initialBridgeState(START),
      SIGNED_OUT,
      START + 500,
    );
    expect(out.effect.clearAll).toBe(false);
    const step = applySnapshot(
      out.state,
      signedIn("u1", row("bill", 70_000)),
      START + 71_000,
    );
    expect(step.effect.raise.map((r) => r.id)).toEqual(["bill"]);
  });

  it("forgets the oldest rows past its memory by raising the floor above them", () => {
    let state = initialBridgeState(START);
    const batches = Math.ceil((MAX_REMEMBERED_ROWS + 50) / 50);
    for (let batch = 0; batch < batches; batch += 1) {
      const rows = Array.from({ length: 50 }, (_, i) =>
        row(`r${batch}-${i}`, (batch * 50 + i + 1) * 10),
      );
      state = applySnapshot(state, signedIn("u1", ...rows), START + 1e6).state;
    }
    expect(state.seen.length).toBeLessThanOrEqual(MAX_REMEMBERED_ROWS);
    // The very first row is no longer remembered, and it still never returns.
    const replay = applySnapshot(
      state,
      signedIn("u1", row("r0-0", 10)),
      START + 2e6,
    );
    expect(replay.effect.raise).toEqual([]);
    expect(state.floorMs).toBeGreaterThan(START + 10);
  });

  it("accepts nothing after stop, and stop takes everything back once", () => {
    const first = applySnapshot(
      initialBridgeState(START),
      signedIn("u1", row("a", 1_000)),
      START + 2_000,
    );
    const stopped = stopBridge(first.state);
    expect(stopped.effect.clearAll).toBe(true);
    expect(stopped.state.raised).toEqual([]);
    const after = applySnapshot(
      stopped.state,
      signedIn("u1", row("b", 3_000)),
      START + 4_000,
    );
    expect(after.effect.raise).toEqual([]);
    expect(after.state).toBe(stopped.state);
    expect(stopBridge(stopped.state).effect.clearAll).toBe(false);
  });

  it("does not mutate the state it was given", () => {
    const state = initialBridgeState(START);
    const frozen = Object.freeze({ ...state, seen: Object.freeze([]) });
    expect(() =>
      applySnapshot(frozen, signedIn("u1", row("a", 1_000)), START + 2_000),
    ).not.toThrow();
    expect(frozen.seen).toEqual([]);
  });
});

describe("notificationUrl", () => {
  it.each([
    ["/bills", `${ORIGIN}/bills`],
    ["/budgets/b-1?tab=alerts#top", `${ORIGIN}/budgets/b-1?tab=alerts#top`],
  ])("opens %s on the app origin", (target, url) => {
    expect(notificationUrl(target, ORIGIN)).toBe(url);
  });

  it.each([
    ["no target", null],
    ["a relative path", "bills"],
    ["an absolute URL", "https://evil.example/steal"],
    ["a protocol-relative URL", "//evil.example/steal"],
    ["a backslash the parser turns into a slash", "/\\evil.example"],
    ["a tab the parser strips", "/\t/evil.example/steal"],
    ["a newline the parser strips", "/\n/evil.example"],
    ["a javascript: string", "javascript:alert(1)"],
  ])("opens the home page for %s", (_label, target) => {
    expect(notificationUrl(target, ORIGIN)).toBe(`${ORIGIN}/`);
  });
});
