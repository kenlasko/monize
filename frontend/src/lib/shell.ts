import { getPushSupport } from '@/lib/push';

/**
 * The page's side of the native-shell contract (`docs/frontend/shell-contract.md`).
 *
 * This is the only module that reads `window.__MONIZE_SHELL__`,
 * `window.__MONIZE_SHELL_NOTIFICATIONS__` or `window.Capacitor`, and
 * `SHELL_CAPABILITIES` is the only place a shell kind is named. Components ask for a capability, never for a kind, so a third shell or
 * a renamed flag is a change here and nowhere else.
 */

export type ShellKind = 'electron' | 'capacitor';

export interface Shell {
  kind: ShellKind;
  version: string;
}

declare global {
  interface Window {
    /** Set by a native shell's preload; absent in an ordinary browser. */
    __MONIZE_SHELL__?: unknown;
    /** The Electron preload's notification bridge: `{ publish(snapshot) }`. */
    __MONIZE_SHELL_NOTIFICATIONS__?: unknown;
    /** Present in a Capacitor WebView; its bridge does not set the flag. */
    Capacitor?: { isNativePlatform?: () => boolean } & Record<string, unknown>;
  }
}

interface ShellCapabilities {
  /** FCM is not built yet for capacitor; Electron has no push service. */
  canReceivePush: boolean;
  /** The shell sends a foreign-origin navigation to the system browser. */
  opensExternalLinksNatively: boolean;
  /** The operating system hands `monize://` URLs to the shell. */
  supportsDeepLinks: boolean;
  /**
   * The shell raises the operating system's own notifications from what this
   * page publishes to it (`publishNotificationsToShell`). Not push: nothing
   * arrives while the shell is closed, and the push controls stay unavailable.
   */
  receivesNotificationsNatively: boolean;
}

/** The one derivation table. Change a row when a shell gains a capability. */
const SHELL_CAPABILITIES: Record<ShellKind, ShellCapabilities> = {
  electron: {
    canReceivePush: false,
    opensExternalLinksNatively: true,
    supportsDeepLinks: true,
    receivesNotificationsNatively: true,
  },
  capacitor: {
    canReceivePush: false,
    opensExternalLinksNatively: false,
    supportsDeepLinks: false,
    receivesNotificationsNatively: false,
  },
};

function isShellKind(value: unknown): value is ShellKind {
  return typeof value === 'string' && Object.hasOwn(SHELL_CAPABILITIES, value);
}

/**
 * The shell hosting this page, or null for a browser (installed PWA included)
 * and on the server. A malformed flag is treated as absent rather than trusted.
 */
export function detectShell(): Shell | null {
  if (typeof window === 'undefined') return null;

  const flag = window.__MONIZE_SHELL__;
  if (typeof flag === 'object' && flag !== null) {
    const { kind, version } = flag as { kind?: unknown; version?: unknown };
    if (isShellKind(kind) && typeof version === 'string') {
      return { kind, version };
    }
  }

  // The Android plan detects Capacitor this way and its bridge sets no flag. A
  // web build of Capacitor in a plain browser reports a non-native platform.
  const capacitor = window.Capacitor;
  if (typeof capacitor === 'object' && capacitor !== null) {
    const native = capacitor.isNativePlatform;
    if (typeof native !== 'function' || native.call(capacitor) === true) {
      return { kind: 'capacitor', version: '' };
    }
  }

  return null;
}

/**
 * Whether this client can receive push. In a shell, the table decides; in a
 * browser it is exactly what `getPushSupport` already says.
 */
export function canReceivePush(): boolean {
  if (typeof window === 'undefined') return false;
  const shell = detectShell();
  return shell ? SHELL_CAPABILITIES[shell.kind].canReceivePush : getPushSupport().supported;
}

export function opensExternalLinksNatively(): boolean {
  const shell = detectShell();
  return shell ? SHELL_CAPABILITIES[shell.kind].opensExternalLinksNatively : false;
}

export function supportsDeepLinks(): boolean {
  const shell = detectShell();
  return shell ? SHELL_CAPABILITIES[shell.kind].supportsDeepLinks : false;
}

/**
 * The shell that cannot receive push, or null when the client is a browser or a
 * shell that can. Unlike `canReceivePush` this never consults the browser, so a
 * browser that has blocked notifications still reaches the existing "blocked"
 * handling instead of being mistaken for a shell.
 */
export function pushUnavailableShell(): Shell | null {
  const shell = detectShell();
  return shell && !SHELL_CAPABILITIES[shell.kind].canReceivePush ? shell : null;
}

/** One unread notification, as the shell shows it. */
export interface ShellNotificationRow {
  id: string;
  /** ISO timestamp from the server: the shell raises nothing older than its start. */
  createdAt: string;
  /** Composed by the page in the reader's language. */
  title: string;
  body: string;
  /** A same-origin path, already checked by `safeNotificationTarget`. */
  target: string | null;
}

/** One poll's result: who is signed in (null for nobody), and what is unread. */
export interface ShellNotificationSnapshot {
  identity: string | null;
  rows: ShellNotificationRow[];
}

interface NotificationBridge {
  publish: (snapshot: ShellNotificationSnapshot) => void;
}

function notificationBridge(): NotificationBridge | null {
  if (typeof window === 'undefined') return null;
  const bridge = window.__MONIZE_SHELL_NOTIFICATIONS__;
  if (typeof bridge !== 'object' || bridge === null) return null;
  return typeof (bridge as { publish?: unknown }).publish === 'function'
    ? (bridge as NotificationBridge)
    : null;
}

/**
 * Whether the shell shows this page's notifications natively. The table must
 * say so AND the bridge must be there: a page newer than its shell would
 * otherwise tell the reader notifications appear when nothing would show them.
 */
export function receivesNotificationsNatively(): boolean {
  const shell = detectShell();
  return (
    shell !== null &&
    SHELL_CAPABILITIES[shell.kind].receivesNotificationsNatively &&
    notificationBridge() !== null
  );
}

/**
 * Hands one poll's result to the shell. A no-op outside such a shell; never
 * throws, because a notification the shell could not take is not the page's
 * error to show.
 */
export function publishNotificationsToShell(
  snapshot: ShellNotificationSnapshot,
): void {
  if (!receivesNotificationsNatively()) return;
  try {
    notificationBridge()?.publish(snapshot);
  } catch {
    // The shell refused the value; the next poll publishes the whole state again.
  }
}
