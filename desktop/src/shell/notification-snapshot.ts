/**
 * What the page hands the notification bridge (`docs/frontend/shell-contract.md`,
 * "Native notifications"), and the check it passes before the bridge reads it.
 *
 * The page polls the notification centre itself, with its own session, and
 * publishes what it found through the preload: who is signed in (or `null`)
 * and the unread rows it would interrupt the person about. The main process
 * trusts none of it until it has the shape below, because the IPC channel is
 * reachable from any script the window runs. A malformed snapshot is dropped
 * whole rather than repaired.
 *
 * The preload cannot import this module (it runs sandboxed), so it carries its
 * own copies of the key and the channel; `preload.spec.ts` holds them equal.
 */

/** Where the preload exposes the bridge in the page's world. */
export const NOTIFICATIONS_KEY = "__MONIZE_SHELL_NOTIFICATIONS__";
/** The IPC channel the preload sends a snapshot on. */
export const NOTIFICATIONS_CHANNEL = "monize:notifications";

/** The backend's list returns 50 rows; anything past this is not the page. */
export const MAX_SNAPSHOT_ROWS = 100;
/** The service worker's own bound on push text (`frontend/public/sw.js`). */
export const MAX_TEXT_LENGTH = 300;
/** The service worker's bound on a push target. */
export const MAX_TARGET_LENGTH = 512;
const MAX_IDENTITY_LENGTH = 128;
const ID_PATTERN = /^[0-9A-Za-z-]{1,64}$/;
const IDENTITY_PATTERN = /^[\x21-\x7e]+$/;

export interface BridgeRow {
  readonly id: string;
  readonly createdAtMs: number;
  readonly title: string;
  readonly body: string;
  /** The notification's in-app path, unchecked; `notificationUrl` decides. */
  readonly target: string | null;
}

export interface BridgeSnapshot {
  /** The signed-in user's id, or null when nobody is (or someone is acting). */
  readonly identity: string | null;
  /** Unread, undismissed rows the person wants to be interrupted about. */
  readonly rows: readonly BridgeRow[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function parseIdentity(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (
    typeof value === "string" &&
    value.length <= MAX_IDENTITY_LENGTH &&
    IDENTITY_PATTERN.test(value)
  ) {
    return value;
  }
  return undefined;
}

function parseRow(value: unknown): BridgeRow | null {
  if (!isRecord(value)) return null;
  const { id, createdAt, title, body, target } = value;
  if (typeof id !== "string" || !ID_PATTERN.test(id)) return null;
  if (typeof createdAt !== "string") return null;
  const createdAtMs = Date.parse(createdAt);
  if (!Number.isFinite(createdAtMs)) return null;
  if (!boundedText(title, MAX_TEXT_LENGTH)) return null;
  if (!boundedText(body, MAX_TEXT_LENGTH)) return null;
  if (target !== null && !boundedText(target, MAX_TARGET_LENGTH)) return null;
  return { id, createdAtMs, title, body, target };
}

/** The snapshot, or null when anything in it is not what the page sends. */
export function parseSnapshot(raw: unknown): BridgeSnapshot | null {
  if (!isRecord(raw)) return null;
  const identity = parseIdentity(raw.identity);
  if (identity === undefined) return null;
  const { rows } = raw;
  if (!Array.isArray(rows) || rows.length > MAX_SNAPSHOT_ROWS) return null;
  // Nobody signed in has nothing to be told about; rows then are a page bug.
  if (identity === null && rows.length > 0) return null;
  const parsed = rows.map(parseRow);
  if (parsed.some((row) => row === null)) return null;
  return { identity, rows: parsed as BridgeRow[] };
}
