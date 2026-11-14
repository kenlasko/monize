import { TEXT } from "./strings";
import { UpdateState } from "./update-policy";

/**
 * The tray menu as data (plan section 6): `tray.ts` turns each item into an
 * Electron `MenuItem` and binds its id to a handler, through a `Record` over
 * the ids so an item without a handler fails the typecheck. The tray is
 * created once the stack is ready, so every item works; the updater's item
 * follows the update state and is rebuilt on every change of it.
 */

export const TRAY_ITEM_IDS = [
  "open",
  "open-in-browser",
  "show-logs",
  "show-recovery-key",
  "move-data-folder",
  "check-for-updates",
  "quit",
] as const;
export type TrayItemId = (typeof TRAY_ITEM_IDS)[number];

export type TrayEntry =
  | {
      readonly type: "item";
      readonly id: TrayItemId;
      readonly label: string;
      readonly enabled: boolean;
    }
  | { readonly type: "separator" };

export interface TrayState {
  readonly update: UpdateState;
}

function item(id: TrayItemId, label: string, enabled: boolean): TrayEntry {
  return { type: "item", id, label, enabled };
}

const SEPARATOR: TrayEntry = { type: "separator" };

/**
 * The updater's item. Its one id means "check" or, once a download is ready,
 * "restart to update" (`UpdatePolicy.menuAction` decides); it is disabled
 * while something is already running and when updates are off.
 */
export function updateItem(update: UpdateState): TrayEntry {
  const id = "check-for-updates";
  switch (update.kind) {
    case "disabled":
      return item(id, TEXT.trayCheckForUpdates, false);
    case "checking":
      return item(id, TEXT.trayCheckingForUpdates, false);
    case "downloading":
      return item(id, TEXT.trayDownloadingUpdate(update.percent), false);
    case "downloaded":
      return item(id, TEXT.trayRestartToUpdate(update.version), true);
    case "installing":
      return item(id, TEXT.trayInstallingUpdate, false);
    case "idle":
    case "up-to-date":
    case "error":
      return item(id, TEXT.trayCheckForUpdates, true);
  }
}

export function trayMenuModel(state: TrayState): readonly TrayEntry[] {
  return [
    item("open", TEXT.trayOpen, true),
    item("open-in-browser", TEXT.trayOpenInBrowser, true),
    SEPARATOR,
    item("show-logs", TEXT.trayShowLogs, true),
    item("show-recovery-key", TEXT.trayShowRecoveryKey, true),
    item("move-data-folder", TEXT.move.trayItem, true),
    updateItem(state.update),
    SEPARATOR,
    item("quit", TEXT.trayQuit, true),
  ];
}
