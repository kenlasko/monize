import { PathModule } from "../supervisor/postgres-args";
import { STAGING_MARKER, TOMBSTONE_FILE } from "./layout";
import { MoveFs } from "./move-types";

/**
 * The two small records a move leaves besides the pointer.
 *
 * The journal sits beside the pointer from before the first byte is copied
 * until the move is over, so a launch after a crash knows a copy was being
 * made and where (`recover.ts`). The tombstone is written into the folder the
 * data was moved FROM, after the pointer has switched: the shell refuses to
 * start on a folder that holds one, so the stale copy cannot be opened by
 * hand and drift apart from the real data.
 */

const JOURNAL_SUFFIX = "-move.json";
const RECORD_VERSION = 1;

/** `<default data dir>-move.json`, beside the pointer. */
export function journalFileFor(defaultDataDir: string): string {
  return `${defaultDataDir}${JOURNAL_SUFFIX}`;
}

export interface MoveJournal {
  /** Also written into the staging folder, to prove a folder is this move's. */
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly staging: string;
  readonly startedAt: string;
}

export interface Tombstone {
  readonly movedTo: string;
  readonly movedAt: string;
}

function encode(value: object): Buffer {
  return Buffer.from(
    `${JSON.stringify({ version: RECORD_VERSION, ...value }, null, 2)}\n`,
    "utf8",
  );
}

function decode(data: Buffer | null, keys: readonly string[]): unknown {
  if (data === null) return null;
  try {
    const value = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
    const usable =
      typeof value === "object" &&
      value !== null &&
      value.version === RECORD_VERSION &&
      keys.every((key) => typeof value[key] === "string" && value[key] !== "");
    return usable ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function writeJournal(
  fs: MoveFs,
  file: string,
  journal: MoveJournal,
): Promise<void> {
  await fs.writeFileAtomic(file, encode(journal));
}

/** The journal; null when there is none; "unreadable" when it is damaged. */
export async function readJournal(
  fs: MoveFs,
  file: string,
): Promise<MoveJournal | null | "unreadable"> {
  const value = decode(await fs.readFile(file), [
    "id",
    "from",
    "to",
    "staging",
    "startedAt",
  ]);
  if (value === undefined) return "unreadable";
  return value as MoveJournal | null;
}

export function tombstoneFileIn(path: PathModule, dataDir: string): string {
  return path.join(dataDir, TOMBSTONE_FILE);
}

export function markerFileIn(path: PathModule, dir: string): string {
  return path.join(dir, STAGING_MARKER);
}

export async function writeTombstone(
  fs: MoveFs,
  path: PathModule,
  dataDir: string,
  tombstone: Tombstone,
): Promise<void> {
  await fs.writeFileAtomic(tombstoneFileIn(path, dataDir), encode(tombstone));
}

/** Text of a tombstone file, parsed; null when it is not one. */
export function parseTombstone(data: Buffer | null): Tombstone | null {
  const value = decode(data, ["movedTo", "movedAt"]);
  return value === undefined ? null : (value as Tombstone | null);
}

/** True when `dir` holds the staging marker of the move called `id`. */
export async function isStagingOf(
  fs: MoveFs,
  path: PathModule,
  dir: string,
  id: string,
): Promise<boolean> {
  const data = await fs.readFile(markerFileIn(path, dir)).catch(() => null);
  return data !== null && data.toString("utf8").trim() === id;
}
