import { SupervisorStatus } from "../supervisor/types";

/**
 * Every sentence the shell shows a person, in one place and keyed by id.
 *
 * English only: the shell has no translation framework yet, which is a gap
 * against the repository's every-string-is-translated rule. Keeping the text
 * here, and out of the glue that shows it, is what lets a later translation
 * change one module.
 */

export const APP_NAME = "Monize";

/**
 * What the splash says while the supervisor is in each status. A `Record` over
 * the closed list, so a new status fails the typecheck until it has text.
 */
export const STATUS_TEXT: Readonly<Record<SupervisorStatus, string>> = {
  idle: "Getting ready...",
  postgres: "Starting the database...",
  "db-init": "Preparing the database...",
  "db-migrate": "Updating the database...",
  backend: "Starting the server...",
  frontend: "Starting the web application...",
  ready: "Ready.",
  "restarting-backend": "The server stopped unexpectedly. Restarting it...",
  "restarting-frontend":
    "The web application stopped unexpectedly. Restarting it...",
  fatal: "Monize stopped working.",
  failed: "Monize could not start.",
  stopping: "Shutting down...",
  stopped: "Stopped.",
};

export const TEXT = {
  splashPreparing: "Opening the data folder...",
  bootFailedTitle: "Monize could not start",
  bootFailedAt: "This step failed:",
  startupErrorTitle: "Monize could not start",
  startupErrorUnknown: "An unexpected error stopped Monize from starting:",
  retry: "Retry",
  quit: "Quit",
  showLogs: "Show logs",
  close: "Close",
  copy: "Copy",
  cancel: "Cancel",

  fatalTitle: "Monize stopped working",
  fatalMessage:
    "A part of Monize stopped and could not be restarted. Your data is safe; " +
    "quit Monize and open it again. The logs say what happened.",
  fatalChild: {
    backend: "The server stopped:",
    frontend: "The web application stopped:",
  },

  addressChangedTitle: "Monize has a new address",
  addressChangedMessage:
    "The port Monize used before is taken by another program, so Monize " +
    "moved to a new address:",
  addressChangedDetail:
    "Bookmarks, a browser where Monize is installed as an app, sign-in " +
    "providers registered for the old address and AI assistants connected " +
    "over MCP need the new address. Monize keeps this address from now on.",

  recoveryConfirmTitle: "Show the recovery key?",
  recoveryConfirmMessage:
    "The recovery key is shown on screen in full. Make sure nobody can see " +
    "your screen.",
  recoveryConfirmShow: "Show the key",
  recoveryKeyTitle: "Recovery key",
  recoveryKeyMessage:
    "This key decrypts your two-factor sign-in secrets and every encrypted " +
    "value in your Monize data. Windows keeps it locked to your account, so " +
    "a restored backup on another computer or a new Windows account cannot " +
    "be read without it. Store it somewhere safe, such as a password " +
    "manager, and never share it.",
  recoveryKeyCopied: "The recovery key was copied to the clipboard.",

  trayTooltip: "Monize",
  trayOpen: "Open Monize",
  trayOpenInBrowser: "Open in browser",
  trayShowLogs: "Show logs",
  trayShowRecoveryKey: "Show recovery key...",
  trayCheckForUpdates: "Check for updates",
  trayQuit: "Quit Monize",
} as const;
