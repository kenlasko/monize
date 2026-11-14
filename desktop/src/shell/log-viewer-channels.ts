/**
 * The log viewer window's IPC, all of it. `log-viewer-preload.ts` carries its
 * own copy of these names (a sandboxed preload cannot load this module);
 * `log-viewer-preload.spec.ts` holds the copies equal.
 */
export const LOG_VIEWER_CHANNELS = {
  sources: "monize-logs:sources",
  tail: "monize-logs:tail",
  tick: "monize-logs:tick",
} as const;
