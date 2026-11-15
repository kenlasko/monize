import { BrowserWindow, ipcMain, IpcMainInvokeEvent } from "electron";

import { Logger } from "./logger";
import { LOG_VIEWER_CHANNELS } from "./shell/log-viewer-channels";
import { answerTail, viewerSetup } from "./shell/log-viewer-service";
import { TEXT } from "./shell/strings";

/**
 * The log viewer window: a local static page (`log-viewer/log-viewer.html`)
 * in a sandboxed renderer, the splash's pattern. The page reaches the main
 * process through two invoke channels and a tick; the main process reads the
 * files (`shell/log-tail.ts`) after checking the requested source against an
 * allowlist, so the page can never name a path. While the window is open the
 * main process ticks every `REFRESH_MS`, and the page re-reads.
 */

export interface LogViewerOptions {
  readonly htmlPath: string;
  readonly preloadPath: string;
  readonly iconPath: string;
  readonly logsDir: string;
  readonly logger: Logger;
}

export interface LogViewer {
  show(): void;
}

const REFRESH_MS = 2000;

export function createLogViewer(options: LogViewerOptions): LogViewer {
  let window: BrowserWindow | null = null;
  let timer: NodeJS.Timeout | null = null;

  const fromViewer = (event: IpcMainInvokeEvent): boolean =>
    window !== null && event.sender === window.webContents;
  const onSources = (event: IpcMainInvokeEvent) =>
    fromViewer(event) ? viewerSetup() : null;
  const onTail = (
    event: IpcMainInvokeEvent,
    source: unknown,
    lines: unknown,
  ) =>
    fromViewer(event)
      ? answerTail(options.logsDir, source, lines)
      : { ok: false };

  function open(): BrowserWindow {
    const created = new BrowserWindow({
      width: 960,
      height: 640,
      minWidth: 480,
      minHeight: 320,
      show: false,
      title: TEXT.logViewerTitle,
      icon: options.iconPath,
      autoHideMenuBar: true,
      webPreferences: {
        preload: options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        webviewTag: false,
      },
    });
    const contents = created.webContents;
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", (event) => event.preventDefault());
    created.once("ready-to-show", () => created.show());
    created.on("closed", () => {
      window = null;
      if (timer !== null) clearInterval(timer);
      timer = null;
      ipcMain.removeHandler(LOG_VIEWER_CHANNELS.sources);
      ipcMain.removeHandler(LOG_VIEWER_CHANNELS.tail);
    });
    ipcMain.handle(LOG_VIEWER_CHANNELS.sources, onSources);
    ipcMain.handle(LOG_VIEWER_CHANNELS.tail, onTail);
    timer = setInterval(() => {
      if (window !== null && !window.isDestroyed() && window.isVisible()) {
        contents.send(LOG_VIEWER_CHANNELS.tick);
      }
    }, REFRESH_MS);
    created.loadFile(options.htmlPath).catch((error: unknown) => {
      options.logger.warn(
        `The log viewer page could not be loaded: ${String(error)}`,
      );
    });
    return created;
  }

  return {
    show() {
      if (window === null) {
        window = open();
        return;
      }
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    },
  };
}
