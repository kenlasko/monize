import { app, BrowserWindow, Notification } from "electron";
import { autoUpdater } from "electron-updater";
import { existsSync } from "fs";
import { join } from "path";

import {
  confirmInstallUpdate,
  showUpdateFailed,
  showUpToDate,
} from "./dialogs";
import { Logger } from "./logger";
import { TEXT } from "./shell/strings";
import {
  createUpdatePolicy,
  UpdatePolicy,
  UpdatePolicyDeps,
  UpdaterPort,
} from "./shell/update-policy";
import { followsPrereleases } from "./shell/version-policy";

/**
 * electron-updater wired to `shell/update-policy.ts`, which makes every
 * decision. The feed is the GitHub provider that electron-builder writes into
 * `resources/app-update.yml` from the `publish` block of `electron-builder.yml`
 * (owner `kenlasko`, repo `monize`); nothing here names a URL.
 *
 * Off in development unless `dev-app-update.yml` sits beside `package.json`:
 * its presence is the opt-in, and electron-updater reads the feed from it
 * (`forceDevUpdateConfig`). An installed build always reads `app-update.yml`.
 */

export const DEV_UPDATE_CONFIG = "dev-app-update.yml";

export interface UpdaterOptions extends Pick<
  UpdatePolicyDeps,
  "stopStack" | "isQuitting" | "quit" | "beginInstall"
> {
  readonly logger: Logger;
  readonly logsDir: string;
  readonly window: () => BrowserWindow | null;
}

function configure(logger: Logger, forced: boolean): UpdaterPort {
  const line = (level: "info" | "warn" | "error") => (message?: unknown) =>
    logger.log("main", level, `Updater: ${String(message)}`);
  autoUpdater.logger = {
    info: line("info"),
    warn: line("warn"),
    error: line("error"),
  };
  autoUpdater.forceDevUpdateConfig = forced;
  // The policy starts the download after its own version check, and installs
  // only on a yes: never on an ordinary quit (see the README, "Updates").
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.allowPrerelease = followsPrereleases(app.getVersion());
  // Monize ships a full installer; a web installer is never accepted.
  autoUpdater.disableWebInstaller = true;
  return autoUpdater;
}

export function createUpdater(options: UpdaterOptions): UpdatePolicy {
  const { logger } = options;
  const forced =
    !app.isPackaged && existsSync(join(app.getAppPath(), DEV_UPDATE_CONFIG));
  const updater = app.isPackaged || forced ? configure(logger, forced) : null;
  // Held so a click on it still reaches us after a garbage collection.
  let notification: Notification | null = null;

  const policy = createUpdatePolicy({
    ...options,
    updater,
    currentVersion: app.getVersion(),
    log: {
      info: (message) => logger.info(message),
      warn: (message) => logger.warn(message),
    },
    ui: {
      upToDate: () => void showUpToDate(app.getVersion(), options.window()),
      failed: () =>
        void showUpdateFailed({
          parent: options.window(),
          logsDir: options.logsDir,
          logger,
        }),
      notifyDownloaded: (version) => {
        if (!Notification.isSupported()) return;
        notification = new Notification({
          title: TEXT.updateReadyTitle(version),
          body: TEXT.updateNotificationBody,
        });
        notification.on("click", () => void policy.requestInstall());
        notification.show();
      },
      confirmInstall: (version) =>
        confirmInstallUpdate(version, options.window()),
    },
  });
  if (updater !== null) {
    autoUpdater.on("download-progress", (info) =>
      policy.progress(info.percent),
    );
  }
  logger.info(
    updater === null
      ? `Updates: off (development run without ${DEV_UPDATE_CONFIG}).`
      : `Updates: on, from ${forced ? DEV_UPDATE_CONFIG : "app-update.yml"}; prereleases ${autoUpdater.allowPrerelease ? "followed" : "never offered"}.`,
  );
  return policy;
}
