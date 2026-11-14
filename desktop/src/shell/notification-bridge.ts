import { decideNavigation } from "./navigation";
import { BridgeRow, BridgeSnapshot } from "./notification-snapshot";

/**
 * Which of the page's unread notifications become native ones, as a pure
 * state machine (`docs/frontend/shell-contract.md`, "Native notifications").
 *
 * The page publishes a snapshot after every poll; this decides what to raise,
 * what to take back and when to forget. The rules:
 *
 * - A row is raised at most once. The state lives in the main process, so a
 *   page reload (a click on a notification loads its page) re-publishes
 *   rows the bridge has already raised and raises nothing.
 * - Nothing older than the floor is raised: the moment the bridge started, or
 *   the moment the last signed-in person left (signed out, or another person
 *   signed in). A launch, a sign-in or a second person on the same PC does not
 *   replay history; the bell still has it. The backend runs on this machine, so its `createdAt` and the
 *   shell's clock are one clock.
 * - At most `MAX_RAISED_PER_SNAPSHOT` rows per snapshot, newest first; the rest
 *   are counted into one summary.
 * - A raised row that is no longer in the snapshot (read, dismissed, or its
 *   category's push switched off) is taken back.
 * - A change of identity, sign-out included, takes back everything and starts
 *   again, so the previous person's notifications are never left on screen.
 * - After `stop` (quit) every notification is taken back and nothing more is
 *   accepted.
 */

export const MAX_RAISED_PER_SNAPSHOT = 3;
/** Rows remembered above the floor; the oldest go first, raising the floor. */
export const MAX_REMEMBERED_ROWS = 1000;

interface SeenRow {
  readonly id: string;
  readonly createdAtMs: number;
}

export interface BridgeState {
  /** `undefined` until the first snapshot: nobody has been seen yet. */
  readonly identity: string | null | undefined;
  /** Rows created before this are never raised. */
  readonly floorMs: number;
  /** Rows at or above the floor already handled (raised or summarised). */
  readonly seen: readonly SeenRow[];
  /** Rows with a native notification still showing. */
  readonly raised: readonly string[];
  readonly stopped: boolean;
}

export interface BridgeEffect {
  /** Close every notification the bridge raised, summaries included. */
  readonly clearAll: boolean;
  /** Close these rows' notifications. */
  readonly retract: readonly string[];
  /** Raise these, in this order. */
  readonly raise: readonly BridgeRow[];
  /** Raise one summary for this many more rows; 0 for none. */
  readonly overflow: number;
}

export interface BridgeStep {
  readonly state: BridgeState;
  readonly effect: BridgeEffect;
}

const NO_EFFECT: BridgeEffect = {
  clearAll: false,
  retract: [],
  raise: [],
  overflow: 0,
};

export function initialBridgeState(nowMs: number): BridgeState {
  return {
    identity: undefined,
    floorMs: nowMs,
    seen: [],
    raised: [],
    stopped: false,
  };
}

/** Keeps the newest `MAX_REMEMBERED_ROWS`, and the floor above the rest. */
function remember(
  seen: readonly SeenRow[],
  floorMs: number,
): { seen: readonly SeenRow[]; floorMs: number } {
  if (seen.length <= MAX_REMEMBERED_ROWS) return { seen, floorMs };
  const sorted = [...seen].sort((a, b) => b.createdAtMs - a.createdAtMs);
  const kept = sorted.slice(0, MAX_REMEMBERED_ROWS);
  const dropped = sorted.slice(MAX_REMEMBERED_ROWS);
  const newestDropped = Math.max(...dropped.map((row) => row.createdAtMs));
  return { seen: kept, floorMs: Math.max(floorMs, newestDropped + 1) };
}

function uniqueById(rows: readonly BridgeRow[]): readonly BridgeRow[] {
  const ids = new Set<string>();
  return rows.filter((row) => {
    if (ids.has(row.id)) return false;
    ids.add(row.id);
    return true;
  });
}

export function applySnapshot(
  state: BridgeState,
  snapshot: BridgeSnapshot,
  nowMs: number,
): BridgeStep {
  if (state.stopped) return { state, effect: NO_EFFECT };

  // Only a person leaving resets: the floor then marks the end of their
  // session, so whoever signs in next (or the same person again) hears about
  // rows created after it, and nothing from before.
  const changed =
    typeof state.identity === "string" && state.identity !== snapshot.identity;
  const base: BridgeState = changed
    ? {
        identity: snapshot.identity,
        floorMs: nowMs,
        seen: [],
        raised: [],
        stopped: false,
      }
    : { ...state, identity: snapshot.identity };
  if (snapshot.identity === null) {
    return { state: base, effect: { ...NO_EFFECT, clearAll: changed } };
  }

  const rows = uniqueById(snapshot.rows);
  const live = new Set(rows.map((row) => row.id));
  const seenIds = new Set(base.seen.map((row) => row.id));
  const fresh = rows
    .filter((row) => !seenIds.has(row.id) && row.createdAtMs >= base.floorMs)
    .sort((a, b) => b.createdAtMs - a.createdAtMs);
  const raise = fresh.slice(0, MAX_RAISED_PER_SNAPSHOT);
  const memory = remember(
    [
      ...base.seen,
      ...fresh.map(({ id, createdAtMs }) => ({ id, createdAtMs })),
    ],
    base.floorMs,
  );

  return {
    state: {
      ...base,
      floorMs: memory.floorMs,
      seen: memory.seen,
      raised: [
        ...base.raised.filter((id) => live.has(id)),
        ...raise.map((row) => row.id),
      ],
    },
    effect: {
      clearAll: changed,
      retract: changed ? [] : base.raised.filter((id) => !live.has(id)),
      raise,
      overflow: fresh.length - raise.length,
    },
  };
}

/** Quit: take everything back and accept nothing more. */
export function stopBridge(state: BridgeState): BridgeStep {
  return {
    state: { ...state, raised: [], stopped: true },
    effect: { ...NO_EFFECT, clearAll: !state.stopped },
  };
}

/**
 * Where a click on a notification goes: its target on the app's own origin,
 * through the window's navigation policy, or the app's home page when the
 * target is missing or would leave the origin. Like the service worker, a
 * target that does not resolve onto the origin is dropped, never repaired.
 */
export function notificationUrl(target: string | null, origin: string): string {
  const home = `${origin}/`;
  if (target === null || !target.startsWith("/")) return home;
  let url: URL;
  try {
    url = new URL(target, origin);
  } catch {
    return home;
  }
  if (url.origin !== origin) return home;
  return decideNavigation(url.href, origin).action === "allow"
    ? url.href
    : home;
}
