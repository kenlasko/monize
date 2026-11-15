import { posix, win32 } from "path";

/**
 * Which image the window, the splash and the tray show. Both files are
 * extraResources, outside the asar, because Windows loads an `.ico` from a
 * real file.
 *
 * - Windows: `shell/icon.ico`, staged from `desktop/build/icon.ico` (the
 *   installer's and the executable's icon too). It carries every size from
 *   16 to 256 pixels and Windows picks the one that fits the display scale,
 *   so the tray shows it as it is.
 * - Elsewhere (development on Linux): the web manifest's PNG, scaled down
 *   for the tray.
 */

export const WINDOWS_ICON = ["shell", "icon.ico"] as const;
const PNG_ICON = ["frontend", "public", "icons", "icon-192x192.png"] as const;
const TRAY_PNG_SIZE = 16;

export function iconPathFor(
  resourcesDir: string,
  platform: NodeJS.Platform,
): string {
  return platform === "win32"
    ? win32.join(resourcesDir, ...WINDOWS_ICON)
    : posix.join(resourcesDir, ...PNG_ICON);
}

/**
 * The edge the tray image is scaled to, or null to hand the image over
 * untouched: scaling an `.ico` would freeze one size and discard the rest.
 */
export function trayResizeFor(iconPath: string): number | null {
  return iconPath.toLowerCase().endsWith(".ico") ? null : TRAY_PNG_SIZE;
}
