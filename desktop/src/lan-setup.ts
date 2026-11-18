import { BrowserWindow, dialog, ipcMain, IpcMainInvokeEvent } from "electron";
import { join } from "path";

import { writeFileAtomic } from "./atomic-write";
import { LanService } from "./lan/lan-service";
import { Logger } from "./logger";
import { LAN_SETUP_CHANNELS } from "./shell/lan-setup-channels";
import { lanSetupView } from "./shell/lan-setup-view";
import { APP_NAME, TEXT } from "./shell/strings";

/**
 * The "Set up another device" window (docs/future-plans/desktop-lan-access.md,
 * L6): a local static page in a sandboxed renderer, the log viewer's pattern.
 * While it is open, and only then, the LAN listener answers the plain-HTTP
 * download of the root certificate. The page can ask for the view, for
 * "Save certificate..." and for "Replace certificate..."; the main process
 * decides everything else.
 */

export interface LanSetupOptions {
  readonly htmlPath: string;
  readonly preloadPath: string;
  readonly iconPath: string;
  readonly lan: LanService;
  readonly documentsDir: string;
  readonly logger: Logger;
}

export interface LanSetupWindow {
  show(): void;
}

async function saveRoot(
  options: LanSetupOptions,
  parent: BrowserWindow,
): Promise<boolean> {
  const der = options.lan.rootDer();
  if (der === null) return false;
  const choice = await dialog.showSaveDialog(parent, {
    title: TEXT.lan.saveTitle,
    defaultPath: join(options.documentsDir, TEXT.lan.saveFileName),
    filters: [{ name: TEXT.lan.saveFilter, extensions: ["crt", "cer"] }],
  });
  if (choice.canceled || choice.filePath === undefined) return false;
  await writeFileAtomic(choice.filePath, der);
  options.logger.info(`LAN: saved the root certificate to ${choice.filePath}.`);
  return true;
}

async function replaceRoot(
  options: LanSetupOptions,
  parent: BrowserWindow,
): Promise<boolean> {
  const { response } = await dialog.showMessageBox(parent, {
    type: "warning",
    title: APP_NAME,
    message: TEXT.lan.replaceTitle,
    detail: TEXT.lan.replaceMessage,
    buttons: [TEXT.lan.replaceConfirm, TEXT.lan.cancel],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  if (response !== 0) return false;
  await options.lan.replaceRoot();
  return true;
}

export function createLanSetupWindow(options: LanSetupOptions): LanSetupWindow {
  let window: BrowserWindow | null = null;

  const fromPage = (event: IpcMainInvokeEvent): boolean =>
    window !== null && event.sender === window.webContents;

  options.lan.onChange(() => {
    if (window !== null && !window.isDestroyed()) {
      window.webContents.send(LAN_SETUP_CHANNELS.changed);
    }
  });

  function open(): BrowserWindow {
    const created = new BrowserWindow({
      width: 1080,
      height: 860,
      minWidth: 520,
      minHeight: 480,
      show: false,
      title: TEXT.lan.setupTitle,
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
      options.lan.setSetupOpen(false);
      for (const channel of [
        LAN_SETUP_CHANNELS.view,
        LAN_SETUP_CHANNELS.saveRoot,
        LAN_SETUP_CHANNELS.replaceRoot,
      ]) {
        ipcMain.removeHandler(channel);
      }
    });
    ipcMain.handle(LAN_SETUP_CHANNELS.view, (event) =>
      fromPage(event) ? lanSetupView(options.lan.status) : null,
    );
    ipcMain.handle(LAN_SETUP_CHANNELS.saveRoot, (event) =>
      fromPage(event) ? saveRoot(options, created) : false,
    );
    ipcMain.handle(LAN_SETUP_CHANNELS.replaceRoot, (event) =>
      fromPage(event) ? replaceRoot(options, created) : false,
    );
    options.lan.setSetupOpen(true);
    created.loadFile(options.htmlPath).catch((error: unknown) => {
      options.logger.warn(
        `The device setup page could not be loaded: ${String(error)}`,
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
