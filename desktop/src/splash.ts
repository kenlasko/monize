import { BrowserWindow, ipcMain, IpcMainEvent } from "electron";

import { SPLASH_CHANNELS } from "./shell/splash-channels";
import { SplashView } from "./shell/splash-view";
import { APP_NAME } from "./shell/strings";

/**
 * The boot splash: a small frameless window over a local static page
 * (`splash/splash.html`), sandboxed, with no remote content and three IPC
 * channels. The view is plain data (`shell/splash-view.ts`); the latest one
 * is kept and re-sent when the page finishes loading, so nothing sent before
 * the page was ready is lost.
 */

export interface SplashOptions {
  readonly htmlPath: string;
  readonly preloadPath: string;
  readonly iconPath: string;
  readonly onRetry: () => void;
  readonly onQuit: () => void;
}

export interface Splash {
  show(view: SplashView): void;
  focus(): void;
  close(): void;
}

const SIZE = { width: 520, height: 300 };
/** The page's darkest blue, so no white shows before it paints or on a resize. */
const BACKGROUND = "#172554";
const FAILURE_SIZE = { width: 760, height: 540 };

export function createSplash(options: SplashOptions): Splash {
  let window: BrowserWindow | null = null;
  let latest: SplashView | null = null;

  const fromSplash = (event: IpcMainEvent): boolean =>
    window !== null && event.sender === window.webContents;
  const onRetry = (event: IpcMainEvent): void => {
    if (fromSplash(event)) options.onRetry();
  };
  const onQuit = (event: IpcMainEvent): void => {
    if (fromSplash(event)) options.onQuit();
  };

  function send(): void {
    if (window === null || latest === null) return;
    const large = latest.lines.length > 0;
    const size = large ? FAILURE_SIZE : SIZE;
    const [width, height] = window.getSize();
    if (width !== size.width || height !== size.height) {
      window.setSize(size.width, size.height);
      window.center();
    }
    window.webContents.send(SPLASH_CHANNELS.view, latest);
  }

  function open(): BrowserWindow {
    const created = new BrowserWindow({
      ...SIZE,
      frame: false,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      show: false,
      center: true,
      title: APP_NAME,
      icon: options.iconPath,
      backgroundColor: BACKGROUND,
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
    contents.on("did-finish-load", send);
    created.once("ready-to-show", () => created.show());
    created.on("closed", () => {
      window = null;
      ipcMain.removeListener(SPLASH_CHANNELS.retry, onRetry);
      ipcMain.removeListener(SPLASH_CHANNELS.quit, onQuit);
    });
    ipcMain.on(SPLASH_CHANNELS.retry, onRetry);
    ipcMain.on(SPLASH_CHANNELS.quit, onQuit);
    void created.loadFile(options.htmlPath);
    return created;
  }

  return {
    show(view) {
      latest = view;
      if (window === null) {
        window = open();
      } else if (!window.webContents.isLoading()) {
        send();
      }
    },
    focus() {
      if (window === null) return;
      window.show();
      window.focus();
    },
    close() {
      window?.close();
    },
  };
}
