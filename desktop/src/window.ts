import {
  BrowserWindow,
  Session,
  shell,
  WebContents,
  WebPreferences,
} from "electron";

import { Logger } from "./logger";
import { closeDecision } from "./shell/quit-gate";
import { decideNavigation, isPermissionAllowed } from "./shell/navigation";
import { versionArgument } from "./shell/shell-flag";
import { APP_NAME } from "./shell/strings";

/**
 * The main window: the app's own origin, sandboxed, with the shell flag
 * preload. Every decision (where a navigation may go, which permission is
 * granted, whether a close hides) is a pure function in `shell/`; this file
 * only applies them.
 */

export interface MainWindowOptions {
  readonly origin: string;
  readonly url: string;
  readonly preloadPath: string;
  readonly version: string;
  readonly iconPath: string;
  readonly logger: Logger;
  readonly isQuitting: () => boolean;
  readonly trayAvailable: () => boolean;
}

export function secureWebPreferences(
  preloadPath: string,
  version: string,
): WebPreferences {
  return {
    preload: preloadPath,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    sandbox: true,
    webSecurity: true,
    webviewTag: false,
    additionalArguments: [versionArgument(version)],
  };
}

function openExternal(url: string, logger: Logger): void {
  shell.openExternal(url).catch((error: unknown) => {
    logger.warn(
      `Could not open a link in the system browser: ${String(error)}`,
    );
  });
}

/** Applies the navigation policy to one page (the main window or a child). */
export function guardContents(
  contents: WebContents,
  options: Pick<
    MainWindowOptions,
    "origin" | "logger" | "preloadPath" | "version"
  >,
): void {
  const { origin, logger } = options;
  const intercept = (
    event: { preventDefault(): void },
    url: string,
    isMainFrame: boolean,
  ): void => {
    const decision = decideNavigation(url, origin);
    if (decision.action === "allow") return;
    event.preventDefault();
    if (decision.action === "deny") {
      logger.warn(`Blocked a navigation: ${decision.reason}.`);
    } else if (isMainFrame) {
      openExternal(decision.url, logger);
    } else {
      logger.warn("Blocked a frame navigation to another origin.");
    }
  };

  contents.setWindowOpenHandler(({ url }) => {
    const decision = decideNavigation(url, origin);
    if (decision.action === "allow") {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          webPreferences: secureWebPreferences(
            options.preloadPath,
            options.version,
          ),
        },
      };
    }
    if (decision.action === "external") {
      openExternal(decision.url, logger);
    } else {
      logger.warn(`Blocked a new window: ${decision.reason}.`);
    }
    return { action: "deny" };
  });
  contents.on("did-create-window", (child) =>
    guardContents(child.webContents, options),
  );
  contents.on("will-navigate", (event) =>
    intercept(event, event.url, event.isMainFrame),
  );
  contents.on("will-frame-navigate", (event) => {
    if (!event.isMainFrame) intercept(event, event.url, false);
  });
  contents.on("will-redirect", (event) =>
    intercept(event, event.url, event.isMainFrame),
  );
}

/** Deny every permission the page does not demonstrably need. */
export function installPermissionPolicy(
  session: Session,
  origin: string,
  logger: Logger,
): void {
  session.setPermissionRequestHandler((contents, permission, callback) => {
    const allowed = isPermissionAllowed(permission, contents.getURL(), origin);
    if (!allowed) logger.info(`Denied the permission "${permission}".`);
    callback(allowed);
  });
  session.setPermissionCheckHandler((_contents, permission, requestingOrigin) =>
    isPermissionAllowed(permission, requestingOrigin, origin),
  );
}

function logLoads(contents: WebContents, logger: Logger): void {
  contents.on("did-finish-load", () => {
    logger.info(`Window finished loading ${contents.getURL()}`);
  });
  contents.on(
    "did-fail-load",
    (_event, code, description, url, isMainFrame) => {
      if (isMainFrame) {
        logger.error(`Window failed to load ${url}: ${description} (${code})`);
      }
    },
  );
  contents.on("render-process-gone", (_event, details) => {
    logger.error(`The window's page process ended: ${details.reason}`);
  });
}

export function createMainWindow(options: MainWindowOptions): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 800,
    minHeight: 600,
    show: false,
    title: APP_NAME,
    icon: options.iconPath,
    autoHideMenuBar: true,
    webPreferences: secureWebPreferences(options.preloadPath, options.version),
  });
  const contents = window.webContents;
  guardContents(contents, options);
  logLoads(contents, options.logger);
  window.once("ready-to-show", () => window.show());
  window.on("close", (event) => {
    const decision = closeDecision({
      quitting: options.isQuitting(),
      trayAvailable: options.trayAvailable(),
    });
    if (decision === "hide") {
      event.preventDefault();
      window.hide();
    }
  });
  window.loadURL(options.url).catch(() => {
    // did-fail-load has logged it; the page can be reloaded from the window.
  });
  return window;
}

export function showWindow(window: BrowserWindow): void {
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}
