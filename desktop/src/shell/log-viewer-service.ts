import {
  parseViewerLines,
  parseViewerSource,
  ViewerSource,
  viewerSources,
} from "./log-sources";
import { readSourceTail } from "./log-tail";
import { TEXT } from "./strings";

/**
 * What the log viewer's IPC handlers answer, as plain functions: the request
 * comes from a page, so the source is checked against the allowlist and the
 * line count clamped before any file is touched, and the answer is data the
 * page renders with `textContent`.
 */

export interface ViewerSetup {
  readonly sources: readonly ViewerSource[];
  /** The page's own words, so no sentence lives in the static HTML. */
  readonly text: {
    readonly title: string;
    readonly sourceLabel: string;
    readonly pause: string;
    readonly refresh: string;
    readonly empty: string;
    readonly missing: string;
    readonly failed: string;
  };
}

export type TailAnswer =
  | {
      readonly ok: true;
      readonly found: boolean;
      readonly lines: readonly string[];
    }
  | { readonly ok: false };

export function viewerSetup(): ViewerSetup {
  return {
    sources: viewerSources(),
    text: {
      title: TEXT.logViewerTitle,
      sourceLabel: TEXT.logViewerSourceLabel,
      pause: TEXT.logViewerPause,
      refresh: TEXT.logViewerRefresh,
      empty: TEXT.logViewerEmpty,
      missing: TEXT.logViewerMissing,
      failed: TEXT.logViewerFailed,
    },
  };
}

export async function answerTail(
  logsDir: string,
  rawSource: unknown,
  rawLines: unknown,
): Promise<TailAnswer> {
  const source = parseViewerSource(rawSource);
  if (source === null) return { ok: false };
  try {
    const tail = await readSourceTail(
      logsDir,
      source,
      parseViewerLines(rawLines),
    );
    return { ok: true, found: tail.found, lines: tail.lines };
  } catch {
    return { ok: false };
  }
}
