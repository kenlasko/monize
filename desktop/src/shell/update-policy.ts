import { decideOffer } from "./version-policy";

/**
 * The updater's decisions, with electron-updater and Electron behind small
 * ports so the order of things is unit-tested (plan task D8).
 *
 * Rules:
 * - One automatic check, after the stack first reaches `ready`; every other
 *   check is the person's (the tray). Never a check while one is running, a
 *   download is in flight or an install has begun.
 * - The download runs in the background (`autoDownload` is off and this module
 *   starts it, after `decideOffer` has accepted the version).
 * - Nothing installs without the person's confirmation.
 * - A failed check or download is logged; it is shown only when the person
 *   asked, and the app keeps running.
 *
 * The install sequence, on confirmation (`install` below):
 * 1. state `installing`; `beginInstall` hides the window.
 * 2. `await stopStack()`: the controller's `shutdown()`, which awaits
 *    `supervisor.stop()` (frontend, backend, then a clean `pg_ctl stop`). It is
 *    memoized and never rejects, so the quit gate below joins this same
 *    promise instead of stopping twice.
 * 3. `quitAndInstall(false, true)`: electron-updater spawns the installer at
 *    once (detached, synchronously inside the call) and schedules `app.quit()`.
 * 4. `quit()`: `app.quit()` now, so the app leaves even if electron-updater
 *    refused to install (no file, a spawn error): the stack is down either way
 *    and a running window over a stopped stack is the one state to avoid.
 *    The quit gate's `before-quit` holds the quit, joins the already-resolved
 *    shutdown and calls `app.exit(0)`; electron-updater's own scheduled
 *    `app.quit()` then meets a gate that is stopping or a process that is gone.
 *
 * The installer therefore never runs while PostgreSQL or the backend run from
 * the files it replaces; the installer's stop-running-instance step is only
 * the backstop. A confirmation that arrives after a quit began is refused:
 * that quit is already stopping the stack, and the downloaded update stays in
 * electron-updater's cache for the next launch.
 */

export type UpdateState =
  /** Not a packaged app and no forced dev config: the updater does nothing. */
  | { readonly kind: "disabled" }
  | { readonly kind: "idle" }
  | { readonly kind: "checking" }
  | { readonly kind: "up-to-date" }
  | {
      readonly kind: "downloading";
      readonly version: string;
      /** 0 to 100, whole numbers. */
      readonly percent: number;
    }
  /** Waiting for the person to say "restart now". */
  | { readonly kind: "downloaded"; readonly version: string }
  /** Terminal: the stack is stopping or stopped and the app is leaving. */
  | { readonly kind: "installing"; readonly version: string }
  | { readonly kind: "error" };

/** The slice of electron-updater's `AppUpdater` this module drives. */
export interface UpdaterPort {
  checkForUpdates(): Promise<{
    readonly isUpdateAvailable: boolean;
    readonly updateInfo: { readonly version: string };
  } | null>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent: boolean, isForceRunAfter: boolean): void;
}

export interface UpdateUi {
  /** The person asked and there is nothing newer. */
  upToDate(): void;
  /** The person asked and the check or the download failed. */
  failed(): void;
  /** An automatic check downloaded `version`: say so without interrupting. */
  notifyDownloaded(version: string): void;
  /** Ask "restart now?"; resolves true only on an explicit yes. */
  confirmInstall(version: string): Promise<boolean>;
}

export interface UpdatePolicyDeps {
  /** Null when updates are off (development without a dev update config). */
  readonly updater: UpdaterPort | null;
  readonly currentVersion: string;
  readonly ui: UpdateUi;
  /** The controller's `shutdown()`: memoized, never rejects. */
  readonly stopStack: () => Promise<void>;
  /** The quit gate's `quitting`. */
  readonly isQuitting: () => boolean;
  /** `app.quit()`, through the quit gate. */
  readonly quit: () => void;
  /** Hide the window and say in the log that the install began. */
  readonly beginInstall: () => void;
  readonly log: {
    info(message: string): void;
    warn(message: string): void;
  };
}

export interface UpdatePolicy {
  readonly state: UpdateState;
  onChange(listener: (state: UpdateState) => void): void;
  /** The supervisor reached `ready`; only the first call checks. */
  stackReady(): void;
  /** The tray item: check, or offer the restart once a download is ready. */
  menuAction(): void;
  check(asked: boolean): Promise<void>;
  /** electron-updater's `download-progress`, as a percentage. */
  progress(percent: number): void;
  /** The tray's "Restart to update" or a click on the notification. */
  requestInstall(): Promise<void>;
}

/** States in which a new check would run beside something already going on. */
function isBusy(state: UpdateState): boolean {
  return (
    state.kind === "checking" ||
    state.kind === "downloading" ||
    state.kind === "installing"
  );
}

function describe(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split("\n", 1)[0];
}

export function createUpdatePolicy(deps: UpdatePolicyDeps): UpdatePolicy {
  const { updater, ui, log } = deps;
  const listeners: ((state: UpdateState) => void)[] = [];
  let state: UpdateState =
    updater === null ? { kind: "disabled" } : { kind: "idle" };
  let autoChecked = false;
  let confirming = false;

  function set(next: UpdateState): void {
    state = next;
    for (const listener of listeners) listener(state);
  }

  function fail(stage: string, error: unknown, asked: boolean): void {
    log.warn(`Updates: the ${stage} failed: ${describe(error)}`);
    set({ kind: "error" });
    if (asked) ui.failed();
  }

  async function download(
    port: UpdaterPort,
    version: string,
    asked: boolean,
  ): Promise<void> {
    set({ kind: "downloading", version, percent: 0 });
    try {
      await port.downloadUpdate();
    } catch (error) {
      fail("download", error, asked);
      return;
    }
    log.info(`Updates: version ${version} is downloaded.`);
    set({ kind: "downloaded", version });
    if (asked) {
      await policy.requestInstall();
    } else {
      ui.notifyDownloaded(version);
    }
  }

  async function install(port: UpdaterPort, version: string): Promise<void> {
    set({ kind: "installing", version });
    deps.beginInstall();
    await deps.stopStack();
    log.info(`Updates: the stack is stopped; installing version ${version}.`);
    port.quitAndInstall(false, true);
    deps.quit();
  }

  const policy: UpdatePolicy = {
    get state() {
      return state;
    },

    onChange(listener) {
      listeners.push(listener);
    },

    stackReady() {
      if (autoChecked) return;
      autoChecked = true;
      void policy.check(false);
    },

    menuAction() {
      if (state.kind === "downloaded") {
        void policy.requestInstall();
      } else {
        void policy.check(true);
      }
    },

    async check(asked) {
      if (updater === null || isBusy(state) || deps.isQuitting()) return;
      if (state.kind === "downloaded") {
        if (asked) await policy.requestInstall();
        return;
      }
      set({ kind: "checking" });
      let result: Awaited<ReturnType<UpdaterPort["checkForUpdates"]>>;
      try {
        result = await updater.checkForUpdates();
      } catch (error) {
        fail("check", error, asked);
        return;
      }
      if (result === null) {
        // electron-updater found itself inactive (not packaged, not forced).
        set({ kind: "idle" });
        return;
      }
      const offered = result.updateInfo.version;
      const decision = result.isUpdateAvailable
        ? decideOffer(deps.currentVersion, offered)
        : null;
      if (decision === null || !decision.accept) {
        if (decision !== null && !decision.accept) {
          log.info(`Updates: version ${offered} refused (${decision.reason}).`);
        }
        set({ kind: "up-to-date" });
        if (asked) ui.upToDate();
        return;
      }
      log.info(`Updates: version ${offered} is available; downloading.`);
      await download(updater, offered, asked);
    },

    progress(percent) {
      if (state.kind !== "downloading") return;
      const rounded = Math.max(0, Math.min(100, Math.floor(percent)));
      if (rounded === state.percent) return;
      set({ ...state, percent: rounded });
    },

    async requestInstall() {
      if (updater === null || state.kind !== "downloaded" || confirming) {
        return;
      }
      const { version } = state;
      confirming = true;
      let confirmed: boolean;
      try {
        confirmed = await ui.confirmInstall(version);
      } catch (error) {
        log.warn(`Updates: could not ask to restart: ${describe(error)}`);
        confirmed = false;
      }
      confirming = false;
      if (!confirmed) {
        log.info(`Updates: the person postponed version ${version}.`);
        return;
      }
      if (deps.isQuitting() || state.kind !== "downloaded") {
        log.info("Updates: Monize is already quitting; installing next time.");
        return;
      }
      await install(updater, version);
    },
  };
  return policy;
}
