import { Runtime } from "../runtime";
import { FatalFailure, SupervisorStatus } from "../supervisor/types";
import { parseDeepLink } from "./deep-link";
import {
  failedView,
  preparingView,
  SplashView,
  startupErrorView,
  statusView,
} from "./splash-view";
import { TEXT } from "./strings";

/**
 * The shell's boot and shutdown sequence, with every Electron call behind
 * `ShellUi` so the order of things is unit-tested: splash, runtime, boot,
 * then the window, or the failure in the splash with Retry and Quit.
 *
 * `shutdown()` is the one way out. It waits for a runtime still being created
 * and then for `supervisor.stop()`, which is what shuts PostgreSQL down
 * cleanly, so the quit path can hold the app open until it resolves.
 */

export interface ShellUi {
  showSplash(view: SplashView): void;
  /** The stack answered: open the main window on `url`, close the splash. */
  openApp(runtime: Runtime, url: string): void;
  /** Once, right after `openApp`: the stack first reached `ready` (the updater's cue). */
  stackReady(runtime: Runtime): void;
  /** Load `url` (already checked to be on the app's origin) and focus. */
  navigate(url: string): void;
  /** Bring the shell forward: the main window once open, else the splash. */
  focus(): void;
  /** Persisted ports moved this launch; the app has a new origin (plan D8). */
  addressChanged(origin: string): void;
  fatal(runtime: Runtime, failure: FatalFailure): void;
  /**
   * The splash is showing a failure: the runtime could not be created, or a
   * boot attempt failed. "Move data folder" offers the way back to the
   * previous folder from here when this folder has never started.
   */
  bootFailed?(): void;
}

export interface ControllerDeps {
  readonly createRuntime: () => Promise<Runtime>;
  readonly ui: ShellUi;
  /** Best effort: `createRuntime` failed before its logger was handed over. */
  readonly reportStartupError: (error: unknown) => void;
}

export interface ShellController {
  boot(): Promise<void>;
  /** The splash's Retry: only after a failed boot, and only once at a time. */
  retry(): Promise<void>;
  /** A raw `monize:` argument; refused unless it maps onto the app origin. */
  deepLink(raw: string): void;
  shutdown(): Promise<void>;
  readonly runtime: Runtime | null;
}

/** Statuses the splash shows; the boot result covers `failed` and `ready`. */
function splashShows(status: SupervisorStatus): boolean {
  return status !== "failed" && status !== "ready";
}

export function createShellController(deps: ControllerDeps): ShellController {
  const { ui } = deps;
  let creation: Promise<Runtime | null> | null = null;
  let runtime: Runtime | null = null;
  let opened = false;
  let booting = false;
  let lastFailed = false;
  let pendingDeepLink: string | null = null;
  let lastStatus: SupervisorStatus | null = null;
  let stopping: Promise<void> | null = null;

  function resolveDeepLink(rt: Runtime, raw: string): string | null {
    const target = parseDeepLink(raw, rt.origin);
    if (target === null) {
      rt.logger.warn("Refused a monize: link that does not name an app page.");
    }
    return target;
  }

  function firstUrl(rt: Runtime): string {
    const raw = pendingDeepLink;
    pendingDeepLink = null;
    return (raw === null ? null : resolveDeepLink(rt, raw)) ?? rt.origin;
  }

  async function attempt(rt: Runtime): Promise<void> {
    booting = true;
    lastFailed = false;
    const result = await rt.supervisor.start();
    booting = false;
    if (stopping !== null) {
      return;
    }
    if (result.outcome === "ready") {
      if (!opened) {
        opened = true;
        ui.openApp(rt, firstUrl(rt));
        if (rt.bootstrap.movedPorts.length > 0) {
          ui.addressChanged(rt.origin);
        }
        ui.stackReady(rt);
      }
    } else if (result.outcome === "failed") {
      lastFailed = true;
      ui.showSplash(failedView(result.failure));
      ui.bootFailed?.();
    }
  }

  function adopt(rt: Runtime): void {
    runtime = rt;
    // Never logged by the shell; redacted in case a child ever echoes them.
    rt.logger.redact(rt.bootstrap.secrets.encryptionKey);
    rt.logger.redact(rt.bootstrap.secrets.jwtSecret);
    rt.supervisor.onStatus((status) => {
      lastStatus = status;
      if (!opened && splashShows(status)) {
        ui.showSplash(statusView(status));
      }
    });
    // A server that has been starting a while: say so, under the same title,
    // until the next status replaces it. Only for the step still showing.
    rt.supervisor.onSlowStart((server) => {
      if (!opened && lastStatus === server) {
        ui.showSplash(statusView(server, TEXT.slowStart));
      }
    });
    rt.supervisor.onFatal((failure) => ui.fatal(rt, failure));
  }

  return {
    get runtime() {
      return runtime;
    },

    async boot() {
      if (creation !== null) {
        return;
      }
      ui.showSplash(preparingView());
      creation = deps.createRuntime().then(
        (rt) => rt,
        (error: unknown) => {
          deps.reportStartupError(error);
          ui.showSplash(startupErrorView(error));
          ui.bootFailed?.();
          return null;
        },
      );
      const rt = await creation;
      if (rt === null || stopping !== null) {
        return;
      }
      adopt(rt);
      await attempt(rt);
    },

    async retry() {
      if (runtime === null || !lastFailed || booting || stopping !== null) {
        return;
      }
      ui.showSplash(statusView("idle"));
      await attempt(runtime);
    },

    deepLink(raw) {
      if (runtime !== null && opened) {
        const target = resolveDeepLink(runtime, raw);
        if (target !== null) {
          ui.navigate(target);
          return;
        }
      } else {
        pendingDeepLink = raw;
      }
      ui.focus();
    },

    shutdown() {
      stopping ??= (async () => {
        const rt = creation === null ? null : await creation;
        if (rt === null) {
          return;
        }
        const report = await rt.supervisor.stop();
        rt.logger.info(
          report.errors.length === 0
            ? "Shell: every process stopped; exiting."
            : `Shell: exiting; ${report.errors.length} component(s) did not stop cleanly.`,
        );
        rt.logger.close();
      })();
      return stopping;
    },
  };
}
