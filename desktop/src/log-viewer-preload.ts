import { contextBridge, ipcRenderer } from "electron";

/**
 * The log viewer page's preload: three calls and nothing else. The page gets
 * `window.monizeLogs` with `listSources`, `readTail` and `subscribe`; it never
 * sees `ipcRenderer`, and it can name a source by id only (the main process
 * checks the id against an allowlist). Sandboxed, so the channel names are a
 * copy of `shell/log-viewer-channels.ts`, held equal by
 * `log-viewer-preload.spec.ts`.
 */

export const LOG_VIEWER_API_NAME = "monizeLogs";
export const LOG_VIEWER_CHANNELS = {
  sources: "monize-logs:sources",
  tail: "monize-logs:tail",
  tick: "monize-logs:tick",
} as const;

export interface LogViewerApi {
  listSources(): Promise<unknown>;
  readTail(source: string, lines: number): Promise<unknown>;
  /** Called whenever the main process says the logs may have changed. */
  subscribe(listener: () => void): void;
}

export const logViewerApi: LogViewerApi = {
  listSources: () => ipcRenderer.invoke(LOG_VIEWER_CHANNELS.sources),
  readTail: (source, lines) =>
    ipcRenderer.invoke(LOG_VIEWER_CHANNELS.tail, source, lines),
  subscribe(listener) {
    ipcRenderer.on(LOG_VIEWER_CHANNELS.tick, () => listener());
  },
};

contextBridge.exposeInMainWorld(LOG_VIEWER_API_NAME, logViewerApi);
