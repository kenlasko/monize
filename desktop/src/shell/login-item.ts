/**
 * Launch at login (plan section 12, D9). The decisions are here; the Electron
 * calls (`app.getLoginItemSettings`, `app.setLoginItemSettings`) are in
 * `electron-main.ts`.
 *
 * Offered only for a packaged app on Windows. That is how it is decided: the
 * login item registers `process.execPath` with the system, and in development
 * that is a development Electron binary, which must never be registered; and
 * the plan's login item is a Windows feature (the other platforms are not a
 * shipped target). Default off: nothing registers until the person ticks it.
 */

/** The argument a login launch carries, so it can tell itself from a double-click. */
export const LOGIN_LAUNCH_ARG = "--monize-login";

export function loginItemOffered(input: {
  readonly platform: string;
  readonly isPackaged: boolean;
}): boolean {
  return input.platform === "win32" && input.isPackaged;
}

/** The settings to register: the item on or off, the launch always marked. */
export function loginItemSettings(enabled: boolean): {
  readonly openAtLogin: boolean;
  readonly args: readonly string[];
} {
  return { openAtLogin: enabled, args: [LOGIN_LAUNCH_ARG] };
}

/**
 * Whether this launch came from the login item: the marker argument, or
 * Electron's own `wasOpenedAtLogin` where the platform reports it.
 */
export function startedAtLogin(input: {
  readonly argv: readonly string[];
  readonly wasOpenedAtLogin: boolean;
}): boolean {
  return input.wasOpenedAtLogin || input.argv.includes(LOGIN_LAUNCH_ARG);
}

/**
 * Whether the main window shows once its page is ready. A login launch stays
 * in the tray; but with no tray the window would be unreachable, so it shows.
 */
export function showWindowOnReady(input: {
  readonly startedAtLogin: boolean;
  readonly trayAvailable: boolean;
}): boolean {
  return !input.startedAtLogin || !input.trayAvailable;
}

/**
 * Whether the splash may open. A login launch keeps the busy splash away
 * (the tray appears when the stack is ready); a failure is always shown.
 */
export function showSplashView(input: {
  readonly startedAtLogin: boolean;
  readonly busy: boolean;
}): boolean {
  return !(input.startedAtLogin && input.busy);
}
