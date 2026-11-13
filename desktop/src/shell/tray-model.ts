import { TEXT } from "./strings";

/**
 * The tray menu as data (plan section 6): `tray.ts` turns each item into an
 * Electron `MenuItem` and binds its id to a handler, through a `Record` over
 * the ids so an item without a handler fails the typecheck. The tray is
 * created once the stack is ready, so every item but the updater's works.
 */

export const TRAY_ITEM_IDS = [
  "open",
  "open-in-browser",
  "show-logs",
  "show-recovery-key",
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
  /** Wired by the updater task; until then the item is shown disabled. */
  readonly updatesAvailable: boolean;
}

function item(id: TrayItemId, label: string, enabled: boolean): TrayEntry {
  return { type: "item", id, label, enabled };
}

const SEPARATOR: TrayEntry = { type: "separator" };

export function trayMenuModel(state: TrayState): readonly TrayEntry[] {
  return [
    item("open", TEXT.trayOpen, true),
    item("open-in-browser", TEXT.trayOpenInBrowser, true),
    SEPARATOR,
    item("show-logs", TEXT.trayShowLogs, true),
    item("show-recovery-key", TEXT.trayShowRecoveryKey, true),
    item("check-for-updates", TEXT.trayCheckForUpdates, state.updatesAvailable),
    SEPARATOR,
    item("quit", TEXT.trayQuit, true),
  ];
}
