import { Menu, MenuItemConstructorOptions, nativeImage, Tray } from "electron";

import { Logger } from "./logger";
import { TEXT } from "./shell/strings";
import {
  TrayEntry,
  TrayItemId,
  trayMenuModel,
  TrayState,
} from "./shell/tray-model";

/**
 * The tray icon and its menu, built from `shell/tray-model.ts`. Some Linux
 * sessions have no status area and `new Tray` throws there: the app logs it
 * and carries on without one (the main window then closes instead of hiding).
 */

export type TrayHandlers = Readonly<Record<TrayItemId, () => void>>;

/** The tray, kept referenced (a collected `Tray` vanishes), and its menu's state. */
export interface TrayHandle {
  readonly tray: Tray;
  /** Rebuild the menu for a new state (the updater's item changes). */
  setState(state: TrayState): void;
}

const TRAY_ICON_SIZE = 16;

export function menuTemplate(
  entries: readonly TrayEntry[],
  handlers: TrayHandlers,
): MenuItemConstructorOptions[] {
  return entries.map((entry) =>
    entry.type === "separator"
      ? { type: "separator" }
      : {
          id: entry.id,
          label: entry.label,
          enabled: entry.enabled,
          click: () => handlers[entry.id](),
        },
  );
}

export function createTray(options: {
  readonly iconPath: string;
  readonly state: TrayState;
  readonly handlers: TrayHandlers;
  readonly logger: Logger;
}): TrayHandle | null {
  const { logger } = options;
  try {
    const source = nativeImage.createFromPath(options.iconPath);
    if (source.isEmpty()) {
      logger.warn(`The tray icon ${options.iconPath} could not be read.`);
    }
    const image = source.isEmpty()
      ? source
      : source.resize({ width: TRAY_ICON_SIZE, height: TRAY_ICON_SIZE });
    const tray = new Tray(image);
    const setState = (state: TrayState): void =>
      tray.setContextMenu(
        Menu.buildFromTemplate(
          menuTemplate(trayMenuModel(state), options.handlers),
        ),
      );
    tray.setToolTip(TEXT.trayTooltip);
    setState(options.state);
    tray.on("click", () => options.handlers.open());
    return { tray, setState };
  } catch (error) {
    logger.warn(
      `No tray icon in this session (${error instanceof Error ? error.message : String(error)}); continuing without one.`,
    );
    return null;
  }
}
