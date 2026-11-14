import { contextBridge, ipcRenderer } from "electron";

/**
 * The main window's preload (`docs/frontend/shell-contract.md`). It exposes
 * exactly two things: the shell flag, `window.__MONIZE_SHELL__ = { kind:
 * 'electron', version }`, and the notification bridge,
 * `window.__MONIZE_SHELL_NOTIFICATIONS__ = { publish(snapshot) }`, which
 * carries what the page found in its own notification centre to the main
 * process. `contextBridge` freezes a copy of each into the page's world before
 * any page script runs, so the page cannot replace them.
 *
 * The bridge sends, and receives nothing: no cookie, token or response ever
 * crosses it, and the main process validates every snapshot itself
 * (`shell/notification-snapshot.ts`).
 *
 * This file runs sandboxed, where `require` reaches only `electron` and a few
 * Node built-ins, so it imports nothing of its own: the constants and the
 * parser below are copies of `shell/shell-flag.ts` and
 * `shell/notification-snapshot.ts`, held equal by `preload.spec.ts`.
 */

export const SHELL_FLAG_KEY = "__MONIZE_SHELL__";
export const VERSION_ARG_PREFIX = "--monize-shell-version=";
const VERSION_PATTERN = /^[0-9A-Za-z.+-]{1,64}$/;
export const NOTIFICATIONS_KEY = "__MONIZE_SHELL_NOTIFICATIONS__";
export const NOTIFICATIONS_CHANNEL = "monize:notifications";

export interface ShellFlag {
  readonly kind: "electron";
  readonly version: string;
}

export interface NotificationBridge {
  /** Hands one poll's result to the shell; never throws into the page. */
  readonly publish: (snapshot: unknown) => void;
}

/** The flag for this renderer's argv; a missing or odd version becomes "". */
export function shellFlagFrom(argv: readonly string[]): ShellFlag {
  const arg = argv.find((value) => value.startsWith(VERSION_ARG_PREFIX));
  const version = arg === undefined ? "" : arg.slice(VERSION_ARG_PREFIX.length);
  return {
    kind: "electron",
    version: VERSION_PATTERN.test(version) ? version : "",
  };
}

export function notificationBridgeFor(
  send: (channel: string, payload: unknown) => void,
): NotificationBridge {
  return {
    publish: (snapshot) => {
      try {
        send(NOTIFICATIONS_CHANNEL, snapshot);
      } catch {
        // A value IPC cannot clone; the main process would drop it anyway.
      }
    },
  };
}

contextBridge.exposeInMainWorld(SHELL_FLAG_KEY, shellFlagFrom(process.argv));
contextBridge.exposeInMainWorld(
  NOTIFICATIONS_KEY,
  notificationBridgeFor((channel, payload) =>
    ipcRenderer.send(channel, payload),
  ),
);
