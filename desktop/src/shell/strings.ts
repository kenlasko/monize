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

  recoveryExportConfirmTitle: "Export the recovery key?",
  recoveryExportConfirmMessage:
    "The recovery key decrypts your two-factor sign-in secrets and every " +
    "encrypted value in your Monize data, so a restored backup can be read " +
    "on another computer or a new Windows account. The file you save holds " +
    "the key in plain text: keep it somewhere safe and off this PC, such as " +
    "a password manager or a USB drive in a safe place, and never share it.",
  recoveryExportConfirmSave: "Choose where to save it",
  recoveryExportSaveTitle: "Save the recovery key",
  recoveryExportSavedTitle: "The recovery key was saved",
  recoveryExportSavedMessage: (path: string) =>
    `The file is ${path}. Move it somewhere safe and off this PC.`,
  recoveryExportFailedTitle: "The recovery key could not be saved",
  recoveryExportFailedMessage: (reason: string) =>
    `Nothing was saved. ${reason}`,
  recoveryExportFileExplanation:
    "This key decrypts the two-factor sign-in secrets and every encrypted " +
    "value in your Monize data. A backup restored on another computer, or " +
    "under a new Windows account, cannot be read without it.",
  recoveryExportFileKeepSafe:
    "Keep this file somewhere safe and off the PC that runs Monize, and " +
    "never share it: anyone who has it can read your encrypted data.",

  trayTooltip: "Monize",
  trayOpen: "Open Monize",
  trayOpenInBrowser: "Open in browser",
  trayShowLogs: "Show logs",
  trayShowRecoveryKey: "Show recovery key...",
  trayExportRecoveryKey: "Export recovery key...",
  trayStartAtLogin: "Start Monize when I sign in",
  trayCheckForUpdates: "Check for updates",
  trayCheckingForUpdates: "Checking for updates...",
  trayDownloadingUpdate: (percent: number) =>
    `Downloading update... ${percent}%`,
  trayRestartToUpdate: (version: string) => `Restart to update to ${version}`,
  trayInstallingUpdate: "Installing update...",
  trayQuit: "Quit Monize",

  updateUpToDateTitle: "Monize is up to date",
  updateUpToDateMessage: (version: string) =>
    `You have the newest version, ${version}.`,
  updateFailedTitle: "Monize could not check for updates",
  updateFailedMessage:
    "The check or the download did not complete. Check the internet " +
    "connection and try again from the tray icon; the logs say what happened. " +
    "Monize keeps working as it is.",
  updateReadyTitle: (version: string) =>
    `Monize ${version} is ready to install`,
  updateReadyMessage:
    "Monize closes, stops its database and installs the update, then opens " +
    "again. This takes a minute or two; your data stays where it is.",
  updateRestartNow: "Restart now",
  updateLater: "Later",
  updateNotificationBody:
    "Click here, or choose Restart to update in the tray menu, when it suits you.",
} as const;
