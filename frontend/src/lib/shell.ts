import { getPushSupport } from '@/lib/push';

/**
 * The page's side of the native-shell contract (`docs/frontend/shell-contract.md`).
 *
 * This is the only module that reads `window.__MONIZE_SHELL__` or
 * `window.Capacitor`, and `SHELL_CAPABILITIES` is the only place a shell kind is
 * named. Components ask for a capability, never for a kind, so a third shell or
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
}

/** The one derivation table. Change a row when a shell gains a capability. */
const SHELL_CAPABILITIES: Record<ShellKind, ShellCapabilities> = {
  electron: {
    canReceivePush: false,
    opensExternalLinksNatively: true,
    supportsDeepLinks: true,
  },
  capacitor: {
    canReceivePush: false,
    opensExternalLinksNatively: false,
    supportsDeepLinks: false,
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
