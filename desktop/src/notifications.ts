import { IpcMainEvent, ipcMain, Notification, WebContents } from "electron";

import { Logger } from "./logger";
import {
  applySnapshot,
  BridgeEffect,
  initialBridgeState,
  notificationUrl,
  stopBridge,
} from "./shell/notification-bridge";
import {
  BridgeRow,
  NOTIFICATIONS_CHANNEL,
  parseSnapshot,
} from "./shell/notification-snapshot";
import { TEXT } from "./shell/strings";

/**
 * The notification bridge's Electron side (`docs/frontend/shell-contract.md`,
 * "Native notifications"): it receives the page's snapshots, lets
 * `shell/notification-bridge.ts` decide, and raises or closes the native
 * notifications. It makes no request of its own; the page polls with its own
 * session, so the shell never touches a credential.
 *
 * Every raise is logged by row id (never its text), so the behaviour is
 * visible in `main.log` on a system that draws no notification.
 */

export interface NotificationBridgeOptions {
  readonly origin: string;
  readonly logger: Logger;
  /** The main window's page: the only one whose snapshots count. */
  readonly contents: () => WebContents | null;
  /** Load `url` (already on the app's origin) in the window and show it. */
  readonly open: (url: string) => void;
  /** Show the window where it is. */
  readonly show: () => void;
  readonly now?: () => number;
}

export interface NotificationBridgeHandle {
  /** On quit: close every notification and stop listening. */
  stop(): void;
}

export function createNotificationBridge(
  options: NotificationBridgeOptions,
): NotificationBridgeHandle {
  const { origin, logger } = options;
  const now = options.now ?? Date.now;
  const supported = Notification.isSupported();
  let state = initialBridgeState(now());
  // Held so a click still reaches us after a garbage collection.
  const shown = new Map<string, Notification>();
  let summaries: Notification[] = [];

  function close(id: string): void {
    shown.get(id)?.close();
    shown.delete(id);
  }

  function clearAll(): void {
    for (const id of [...shown.keys()]) close(id);
    for (const summary of summaries) summary.close();
    summaries = [];
  }

  /** A click from a notification raised for someone no longer signed in only shows the window. */
  function clicked(identity: string | null, url: string | null): void {
    if (url !== null && state.identity === identity) {
      options.open(url);
    } else {
      options.show();
    }
  }

  function raise(row: BridgeRow, identity: string | null): void {
    logger.info(`Notifications: raised one for row ${row.id}.`);
    if (!supported) return;
    const notification = new Notification({ title: row.title, body: row.body });
    notification.on("click", () => {
      shown.delete(row.id);
      clicked(identity, notificationUrl(row.target, origin));
    });
    notification.on("failed", (_event, error) =>
      logger.warn(`Notifications: Windows refused one: ${error}`),
    );
    shown.set(row.id, notification);
    notification.show();
  }

  function summarise(count: number, identity: string | null): void {
    logger.info(`Notifications: ${count} more summarised in one.`);
    if (!supported) return;
    const notification = new Notification({
      title: TEXT.notificationsMoreTitle,
      body: TEXT.notificationsMoreBody(count),
    });
    notification.on("click", () => clicked(identity, null));
    summaries = [...summaries, notification];
    notification.show();
  }

  function apply(effect: BridgeEffect, identity: string | null): void {
    if (effect.clearAll) {
      logger.info("Notifications: the signed-in person left; closed theirs.");
      clearAll();
    }
    for (const id of effect.retract) close(id);
    for (const row of effect.raise) raise(row, identity);
    if (effect.overflow > 0) summarise(effect.overflow, identity);
  }

  const listener = (event: IpcMainEvent, payload: unknown): void => {
    const contents = options.contents();
    const frameUrl = event.senderFrame?.url ?? "";
    if (contents === null || event.sender !== contents || !onOrigin(frameUrl)) {
      logger.warn("Notifications: ignored a snapshot from another page.");
      return;
    }
    const snapshot = parseSnapshot(payload);
    if (snapshot === null) {
      logger.warn("Notifications: ignored a malformed snapshot.");
      return;
    }
    const step = applySnapshot(state, snapshot, now());
    state = step.state;
    apply(step.effect, snapshot.identity);
  };

  function onOrigin(url: string): boolean {
    try {
      return new URL(url).origin === origin;
    } catch {
      return false;
    }
  }

  ipcMain.on(NOTIFICATIONS_CHANNEL, listener);
  logger.info(
    supported
      ? "Notifications: the bridge is listening."
      : "Notifications: this system shows no native notifications; raises are only logged.",
  );

  return {
    stop() {
      ipcMain.removeListener(NOTIFICATIONS_CHANNEL, listener);
      const step = stopBridge(state);
      state = step.state;
      if (step.effect.clearAll) clearAll();
    },
  };
}
