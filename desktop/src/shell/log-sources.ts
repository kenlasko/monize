import { TEXT } from "./strings";

/**
 * What the log viewer may read. The page names a source by id; the main
 * process maps the id to a file name from this fixed table and joins it to the
 * logs folder itself, so a page can never name a path. An id that is not in
 * the table is refused.
 */

export const VIEWER_SOURCE_IDS = [
  "main",
  "backend",
  "frontend",
  "postgres",
  "postgres-server",
] as const;
export type ViewerSourceId = (typeof VIEWER_SOURCE_IDS)[number];

/** The live file of each source (`logger.ts` and `runtime.ts` name them). */
export const VIEWER_SOURCE_FILES: Readonly<Record<ViewerSourceId, string>> = {
  main: "main.log",
  backend: "backend.log",
  frontend: "frontend.log",
  postgres: "postgres.log",
  "postgres-server": "postgres-server.log",
};

export const VIEWER_DEFAULT_LINES = 500;
export const VIEWER_MAX_LINES = 2000;
export const VIEWER_MAX_LINE_CHARS = 2000;

export interface ViewerSource {
  readonly id: ViewerSourceId;
  readonly label: string;
}

export function viewerSources(): readonly ViewerSource[] {
  return VIEWER_SOURCE_IDS.map((id) => ({
    id,
    label: TEXT.logViewerSources[id],
  }));
}

/** The allowlist check: an id from the table, or null. */
export function parseViewerSource(value: unknown): ViewerSourceId | null {
  return typeof value === "string" &&
    (VIEWER_SOURCE_IDS as readonly string[]).includes(value)
    ? (value as ViewerSourceId)
    : null;
}

/** A count of lines clamped to 1..max; anything that is not a number is the default. */
export function parseViewerLines(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return VIEWER_DEFAULT_LINES;
  }
  return Math.min(VIEWER_MAX_LINES, Math.max(1, Math.trunc(value)));
}

function clip(line: string): string {
  return line.length > VIEWER_MAX_LINE_CHARS
    ? `${line.slice(0, VIEWER_MAX_LINE_CHARS)}...`
    : line;
}

/**
 * A log file line as the viewer shows it: the JSON-lines records of the four
 * sources in the console shape (`<ISO> [<source>] <LEVEL>: <message>`), any
 * other line (PostgreSQL's own log) as it is.
 */
export function displayLine(raw: string): string {
  try {
    const record: unknown = JSON.parse(raw);
    if (typeof record === "object" && record !== null) {
      const { time, level, source, msg } = record as Record<string, unknown>;
      if (
        typeof time === "string" &&
        typeof level === "string" &&
        typeof source === "string" &&
        typeof msg === "string"
      ) {
        return clip(`${time} [${source}] ${level.toUpperCase()}: ${msg}`);
      }
    }
  } catch {
    // Not JSON: shown as written.
  }
  return clip(raw);
}
