import {
  BrowserWindow,
  IpcMainEvent,
  ipcMain,
  Menu,
  MenuItemConstructorOptions,
} from "electron";

import { Logger } from "./logger";
import { isFromAppPage } from "./shell/ipc-sender";
import { SHELL_MENU_CHANNEL } from "./shell/shell-menu";
import { TEXT } from "./shell/strings";
import { TrayState, windowMenuModel } from "./shell/tray-model";
import { menuTemplate, TrayHandlers } from "./tray";

/**
 * The tray's menu, offered inside the window as well
 * (`docs/frontend/shell-contract.md`, "The shell menu"):
 *
 * - the menu bar (shown with Alt, the window hides it) gets a "Monize" menu
 *   in place of Electron's File menu, holding the tray's items;
 * - the page's Help menu asks, through the preload, for the same items as a
 *   popup in the window.
 *
 * Both are built from `windowMenuModel` with the tray's own handlers, so the
 * three never disagree, and both are rebuilt from the latest state on every
 * change the tray sees. `stop()` (a data-folder move, a quit) puts back a menu
 * bar without the Monize items and ignores further requests, as the tray is
 * removed at the same moments.
 */

export interface WindowMenusOptions {
  readonly origin: string;
  readonly logger: Logger;
  readonly window: BrowserWindow;
  readonly state: TrayState;
  readonly handlers: TrayHandlers;
}

export interface WindowMenusHandle {
  /** Rebuild for a new state (the updater's item, the login checkbox). */
  setState(state: TrayState): void;
  /** Drop the Monize items and stop answering the page. */
  stop(): void;
}

/**
 * The menu bar: the Monize menu (or Electron's File menu once stopped), then
 * Electron's own Edit, View and Window menus, which carry the clipboard, zoom
 * and reload shortcuts. Electron's Help menu links to electronjs.org and is
 * left out.
 */
export function applicationMenuTemplate(
  shellItems: MenuItemConstructorOptions[] | null,
): MenuItemConstructorOptions[] {
  return [
    shellItems === null
      ? { role: "fileMenu" }
      : { label: TEXT.appMenuMonize, submenu: shellItems },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
}

export function createWindowMenus(
  options: WindowMenusOptions,
): WindowMenusHandle {
  const { origin, logger, window, handlers } = options;
  let state = options.state;
  let stopped = false;

  const items = (): MenuItemConstructorOptions[] =>
    menuTemplate(windowMenuModel(state), handlers);

  const setApplicationMenu = (): void =>
    Menu.setApplicationMenu(
      Menu.buildFromTemplate(applicationMenuTemplate(stopped ? null : items())),
    );

  const listener = (event: IpcMainEvent): void => {
    const contents = window.isDestroyed() ? null : window.webContents;
    const facts = {
      sender: event.sender,
      frameUrl: event.senderFrame?.url ?? "",
    };
    if (!isFromAppPage(facts, contents, origin)) {
      logger.warn("Shell menu: ignored a request from another page.");
      return;
    }
    Menu.buildFromTemplate(items()).popup({ window });
  };

  setApplicationMenu();
  ipcMain.on(SHELL_MENU_CHANNEL, listener);

  return {
    setState(next) {
      state = next;
      if (!stopped) setApplicationMenu();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      ipcMain.removeListener(SHELL_MENU_CHANNEL, listener);
      setApplicationMenu();
    },
  };
}
