import {
  app,
  BrowserWindow,
  dialog,
  safeStorage,
  session,
  shell,
} from "electron";
import { homedir } from "os";
import { join, resolve } from "path";

import { AppPaths, resolveAppPaths } from "./app-paths";
import {
  openFolder,
  showAddressChanged,
  showFatalDialog,
  showRecoveryKey,
} from "./dialogs";
import { createLogger } from "./logger";
import { createRuntime, Runtime } from "./runtime";
import { createShellController } from "./shell/controller";
import { DEEP_LINK_SCHEME } from "./shell/deep-link";
import {
  instanceData,
  launchRequestFrom,
  secondInstanceAction,
} from "./shell/launch-args";
import { createQuitGate } from "./shell/quit-gate";
import { effectiveSafeStorage } from "./shell/safe-storage";
import { isPresentableError } from "./shell/splash-view";
import { TEXT } from "./shell/strings";
import { createSplash } from "./splash";
import { UpdatePolicy } from "./shell/update-policy";
import { createTray, TrayHandle } from "./tray";
import { createUpdater } from "./updater";
import {
  createMainWindow,
  installPermissionPolicy,
  showWindow,
} from "./window";

/**
 * The Electron main process: the twin of `scripts/dev-boot.mjs` with a window.
 * Order matters. The single-instance lock is taken before anything else (a
 * second shell would otherwise find the first one's PostgreSQL, take it for
 * an orphan and stop it); then the splash, the runtime, the boot, the window.
 * Quitting holds `before-quit` until `supervisor.stop()` has resolved, and an
 * update installs only after the same stop (`shell/update-policy.ts`).
 */

/** `dist/` when built, so `desktop/` is one level up. */
const desktopRoot = resolve(__dirname, "..");
const launch = launchRequestFrom(process.argv);

function resolvePaths(): AppPaths {
  return resolveAppPaths({
    env: process.env,
    platform: process.platform,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    desktopRoot,
    homeDir: homedir(),
  });
}

/** No data folder means no lock to take and nothing to run: say why, exit. */
function exitWithPathError(error: unknown): void {
  void app.whenReady().then(() => {
    dialog.showErrorBox(
      TEXT.startupErrorTitle,
      error instanceof Error ? error.message : String(error),
    );
    app.exit(1);
  });
}

function iconPathFor(paths: AppPaths): string {
  return join(
    paths.resourcesDir,
    "frontend",
    "public",
    "icons",
    "icon-192x192.png",
  );
}

function main(): void {
  let paths: AppPaths;
  try {
    paths = resolvePaths();
  } catch (error) {
    exitWithPathError(error);
    return;
  }
  // Chromium's profile (the page's cookies included) lives with the app's
  // data, and Electron keys the single-instance lock on this folder, so one
  // data folder is one running shell.
  app.setPath("userData", join(paths.data.dataDir, "shell"));
  if (!app.requestSingleInstanceLock(instanceData(launch))) {
    app.exit(0);
    return;
  }
  if (launch.quit) {
    // Nothing else is running, so there is nothing to ask to quit.
    app.exit(0);
    return;
  }
  run(paths);
}

function run(paths: AppPaths): void {
  const iconPath = iconPathFor(paths);
  let mainWindow: BrowserWindow | null = null;
  let tray: TrayHandle | null = null;
  let updates: UpdatePolicy | null = null;

  const controller = createShellController({
    createRuntime: () =>
      createRuntime({
        paths,
        safeStorage: effectiveSafeStorage(safeStorage, process.platform),
        baseEnv: process.env,
        execPath: process.execPath,
      }),
    reportStartupError: (error) => {
      // createRuntime closed its own logger; this one says why it gave up.
      const logger = createLogger({ logsDir: paths.data.logs, stdout: null });
      const detail = !(error instanceof Error)
        ? String(error)
        : isPresentableError(error)
          ? error.message
          : (error.stack ?? error.message);
      logger.error(`The shell could not start: ${detail}`);
      logger.close();
    },
    ui: {
      showSplash: (view) => splash.show(view),
      openApp: (runtime, url) => {
        mainWindow = openApp(runtime, url);
        splash.close();
      },
      stackReady: () => updates?.stackReady(),
      navigate: (url) => {
        if (mainWindow === null) return;
        void mainWindow.loadURL(url).catch(() => undefined);
        showWindow(mainWindow);
      },
      focus: () =>
        mainWindow === null ? splash.focus() : showWindow(mainWindow),
      addressChanged: (origin) => void showAddressChanged(origin, mainWindow),
      fatal: (runtime, failure) =>
        void showFatalDialog(failure, {
          parent: mainWindow,
          logsDir: runtime.paths.data.logs,
          logger: runtime.logger,
          quit: () => app.quit(),
        }),
    },
  });

  const splash = createSplash({
    htmlPath: join(__dirname, "splash", "splash.html"),
    preloadPath: join(__dirname, "splash-preload.js"),
    iconPath,
    onRetry: () => void controller.retry(),
    onQuit: () => app.quit(),
  });

  const gate = createQuitGate({
    shutdown: () => controller.shutdown(),
    exit: (code) => app.exit(code),
    onBegin: () => {
      controller.runtime?.logger.info("Shell: quitting; stopping the stack.");
      mainWindow?.hide();
    },
  });

  function openApp(runtime: Runtime, url: string): BrowserWindow {
    const { logger, origin } = runtime;
    installPermissionPolicy(session.defaultSession, origin, logger);
    const window = createMainWindow({
      origin,
      url,
      preloadPath: join(__dirname, "preload.js"),
      version: app.getVersion(),
      iconPath,
      logger,
      isQuitting: () => gate.quitting,
      trayAvailable: () => tray !== null,
    });
    const updater = createUpdater({
      logger,
      logsDir: runtime.paths.data.logs,
      window: () => mainWindow,
      stopStack: () => controller.shutdown(),
      isQuitting: () => gate.quitting,
      quit: () => app.quit(),
      beginInstall: () => {
        logger.info("Shell: installing an update; stopping the stack first.");
        mainWindow?.hide();
      },
    });
    updates = updater;
    tray = createTray({
      iconPath,
      state: { update: updater.state },
      logger,
      handlers: {
        open: () => showWindow(window),
        "open-in-browser": () => void shell.openExternal(origin),
        "show-logs": () => void openFolder(runtime.paths.data.logs, logger),
        "show-recovery-key": () =>
          void showRecoveryKey(runtime.bootstrap.secrets.encryptionKey, window),
        "check-for-updates": () => updater.menuAction(),
        quit: () => app.quit(),
      },
    });
    updater.onChange((update) => tray?.setState({ update }));
    return window;
  }

  app.on("before-quit", (event) => gate.beforeQuit(event));
  app.on("window-all-closed", () => app.quit());
  app.on("second-instance", (_event, argv, _cwd, data) => {
    const action = secondInstanceAction(argv, data);
    if (action.kind === "quit") {
      controller.runtime?.logger.info("Shell: another launch asked to quit.");
      app.quit();
    } else if (action.kind === "deep-link") {
      controller.deepLink(action.raw);
    } else {
      controller.runtime?.logger.info("Shell: a second launch; focusing.");
      if (mainWindow === null) splash.focus();
      else showWindow(mainWindow);
    }
  });
  app.on("open-url", (event, url) => {
    event.preventDefault();
    controller.deepLink(url);
  });
  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-attach-webview", (event) => event.preventDefault());
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => app.quit());
  }
  if (launch.deepLink !== null) controller.deepLink(launch.deepLink);

  void app.whenReady().then(async () => {
    // Registered by the installer too; from a development run it would point
    // the operating system at a checkout, so only a packaged app registers.
    const registered =
      app.isPackaged && app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);
    await controller.boot();
    controller.runtime?.logger.info(
      registered
        ? `Shell: ${DEEP_LINK_SCHEME}:// links open this app.`
        : `Shell: ${DEEP_LINK_SCHEME}:// is not registered (${app.isPackaged ? "the system refused" : "development run"}).`,
    );
  });
}

main();
