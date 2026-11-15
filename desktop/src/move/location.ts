import { readFileSync } from "fs";

import { writeFileAtomic } from "../atomic-write";
import { pathFor } from "../supervisor/postgres-args";

/**
 * The data-folder pointer: the one record of where a moved data folder is.
 *
 * It is a file beside the DEFAULT data folder (`%LOCALAPPDATA%\Monize` has
 * `%LOCALAPPDATA%\Monize-location.ini` next to it), never inside a data
 * folder: a pointer inside the folder it replaces dies with that folder, and
 * the person who deletes their old copy by hand would get an empty Monize.
 * Not the registry, so the shell reads it without starting a process and the
 * whole move runs under jest and on Linux.
 *
 * The format is what the installer reads without code of its own: an INI
 * file in UTF-16LE with a byte-order mark, which NSIS's `ReadINIStr` (the
 * Windows profile API) reads as Unicode, so a folder named in any script
 * survives. Read strictly: a pointer that cannot be read stops the launch.
 * Falling back to the default folder would start an empty Monize beside the
 * person's real data.
 */

export const LOCATION_VERSION = 1;
export const LOCATION_SECTION = "location";
const LOCATION_SUFFIX = "-location.ini";
const KEYS = [
  "version",
  "dataDir",
  "previousDataDir",
  "state",
  "movedAt",
] as const;
type Key = (typeof KEYS)[number];

/**
 * `pending`: written by the move; the folder has not started Monize yet, so
 * going back to `previousDataDir` loses nothing. `confirmed`: it has.
 */
export type LocationState = "pending" | "confirmed";

export interface DataLocation {
  readonly dataDir: string;
  /** The copy the data was moved from, until the person deletes or keeps it. */
  readonly previousDataDir: string | null;
  readonly state: LocationState;
  /** ISO 8601. */
  readonly movedAt: string;
}

export class LocationError extends Error {
  constructor(
    readonly file: string,
    why: string,
  ) {
    super(
      `The file that records where Monize's data folder was moved to cannot ` +
        `be used (${why}): ${file}. Monize will not guess, because starting ` +
        "on the wrong folder would show an empty Monize beside your data. " +
        "Restore the file, or delete it to use the default data folder again.",
    );
    this.name = "LocationError";
  }
}

/** `<default data dir>-location.ini`, a sibling of the default data folder. */
export function locationFileFor(defaultDataDir: string): string {
  return `${defaultDataDir}${LOCATION_SUFFIX}`;
}

/**
 * True when a path survives the INI round trip: the profile API trims
 * surrounding blanks and one pair of surrounding quotes, and a line break
 * would end the value.
 */
export function isStorablePath(path: string): boolean {
  if (path.length === 0 || path !== path.trim()) return false;
  // Control characters, a line break among them, would end or corrupt the value.
  if ([...path].some((char) => char.charCodeAt(0) < 0x20)) return false;
  return !/^["']/.test(path);
}

export function serializeLocation(location: DataLocation): Buffer {
  const values: Readonly<Record<Key, string>> = {
    version: String(LOCATION_VERSION),
    dataDir: location.dataDir,
    previousDataDir: location.previousDataDir ?? "",
    state: location.state,
    movedAt: location.movedAt,
  };
  const lines = [
    `[${LOCATION_SECTION}]`,
    ...KEYS.map((key) => `${key}=${values[key]}`),
  ];
  return Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from(`${lines.join("\r\n")}\r\n`, "utf16le"),
  ]);
}

function readValues(
  data: Buffer,
  fail: (why: string) => never,
): Map<Key, string> {
  if (data.length < 2 || data[0] !== 0xff || data[1] !== 0xfe) {
    fail("it is not a UTF-16 file");
  }
  const lines = data
    .subarray(2)
    .toString("utf16le")
    .split(/\r?\n/)
    .filter((line) => line !== "");
  if (lines[0] !== `[${LOCATION_SECTION}]`) {
    fail("its first line is not [location]");
  }
  const values = new Map<Key, string>();
  for (const line of lines.slice(1)) {
    const at = line.indexOf("=");
    const key = (at < 0 ? line : line.slice(0, at)) as Key;
    if (at < 0 || !KEYS.includes(key) || values.has(key)) {
      fail("it holds a line that is not one of its settings, or one twice");
    }
    values.set(key, line.slice(at + 1));
  }
  for (const key of KEYS) {
    if (!values.has(key)) fail(`${key} is missing`);
  }
  return values;
}

/** Parse the file's bytes. Never fills in a default. */
export function parseLocation(
  data: Buffer,
  file: string,
  platform: NodeJS.Platform,
): DataLocation {
  const fail: (why: string) => never = (why) => {
    throw new LocationError(file, why);
  };
  const path = pathFor(platform);
  const values = readValues(data, fail);
  const get = (key: Key): string => values.get(key) as string;
  if (get("version") !== String(LOCATION_VERSION)) {
    fail(`this build reads version ${LOCATION_VERSION} only`);
  }
  const usable = (value: string): boolean =>
    isStorablePath(value) && path.isAbsolute(value);
  if (!usable(get("dataDir"))) fail("dataDir is not an absolute path");
  const previous = get("previousDataDir");
  if (previous !== "" && !usable(previous)) {
    fail("previousDataDir is not an absolute path");
  }
  const state = get("state");
  if (state !== "pending" && state !== "confirmed") {
    fail("state is neither pending nor confirmed");
  }
  if (Number.isNaN(Date.parse(get("movedAt")))) fail("movedAt is not a date");
  return {
    dataDir: path.normalize(get("dataDir")),
    previousDataDir: previous === "" ? null : path.normalize(previous),
    state,
    movedAt: get("movedAt"),
  };
}

/** The pointer, or null when there is none. Throws `LocationError`. */
export function readLocationSync(
  file: string,
  platform: NodeJS.Platform,
): DataLocation | null {
  let data: Buffer;
  try {
    data = readFileSync(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw new LocationError(file, `it could not be read: ${code ?? "error"}`);
  }
  return parseLocation(data, file, platform);
}

export type LocationWriter = (file: string, data: Buffer) => Promise<void>;

/**
 * Replace the pointer atomically (`atomic-write.ts`). This write is the
 * commit of a move: before it the old folder is the data folder, after it
 * the new one is.
 */
export async function writeLocation(
  file: string,
  location: DataLocation,
  write: LocationWriter = (path, data) => writeFileAtomic(path, data),
): Promise<void> {
  const paths = [location.dataDir, location.previousDataDir ?? "x"];
  if (!paths.every(isStorablePath)) {
    throw new Error("A data folder path cannot be recorded as it is written.");
  }
  await write(file, serializeLocation(location));
}
