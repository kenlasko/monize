import { MoveProgress } from "../move/move-types";
import { SplashView } from "./splash-view";
import { TEXT } from "./strings";

/** The splash window while a move runs: what is happening and how far along. */

const UNITS = ["bytes", "KB", "MB", "GB", "TB"] as const;

/** `1.4 GB`: binary units, one decimal from KB up. */
export function formatBytes(bytes: number): string {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? String(Math.round(value)) : value.toFixed(1)} ${UNITS[unit]}`;
}

export function percentOf(progress: MoveProgress): number {
  if (progress.totalBytes <= 0) return 0;
  const ratio = progress.doneBytes / progress.totalBytes;
  return Math.max(0, Math.min(100, Math.floor(ratio * 100)));
}

export function moveProgressView(progress: MoveProgress): SplashView {
  const phase = TEXT.move.phase[progress.phase];
  const counted =
    progress.phase === "copying" || progress.phase === "verifying";
  return {
    title: TEXT.move.progressTitle,
    detail: counted
      ? `${TEXT.move.progressDetail(
          phase,
          formatBytes(progress.doneBytes),
          formatBytes(progress.totalBytes),
          percentOf(progress),
        )} ${TEXT.move.progressKeepOpen}`
      : phase,
    lines: [],
    retryLabel: TEXT.retry,
    quitLabel: TEXT.quit,
    canRetry: false,
    canQuit: false,
    busy: true,
    progress: counted ? percentOf(progress) / 100 : null,
  };
}
