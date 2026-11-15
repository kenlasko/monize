/**
 * The quit path. Electron's `before-quit` is held (`preventDefault`) until the
 * shutdown has resolved, then the app exits: without the hold, Electron would
 * end the process while PostgreSQL was still being stopped, and the next start
 * would meet an unclean data directory. Every later `before-quit` (a second
 * Quit click, a signal, `--quit` from another launch) joins the one shutdown.
 */

export interface QuitGateDeps {
  /** Resolves once every process has stopped. Never rejects, by contract. */
  readonly shutdown: () => Promise<void>;
  /** `app.exit`: ends the process without another `before-quit`. */
  readonly exit: (code: number) => void;
  /** Called once when the shutdown begins (hide the window, say so). */
  readonly onBegin?: () => void;
}

export interface QuitGate {
  beforeQuit(event: { preventDefault(): void }): void;
  /** True from the first quit request on: a window close is a real close. */
  readonly quitting: boolean;
}

export function createQuitGate(deps: QuitGateDeps): QuitGate {
  let state: "running" | "stopping" | "done" = "running";
  return {
    get quitting() {
      return state !== "running";
    },
    beforeQuit(event) {
      if (state === "done") {
        return;
      }
      event.preventDefault();
      if (state === "stopping") {
        return;
      }
      state = "stopping";
      deps.onBegin?.();
      deps.shutdown().then(
        () => {
          state = "done";
          deps.exit(0);
        },
        () => {
          state = "done";
          deps.exit(1);
        },
      );
    },
  };
}

export type CloseDecision = "hide" | "close";

/**
 * Closing the main window hides it to the tray, so the servers keep running
 * for "Open in browser". Without a tray (some Linux sessions) a hidden window
 * could never be found again, so the close is a real one there, and so is a
 * close while the app is quitting.
 */
export function closeDecision(state: {
  readonly quitting: boolean;
  readonly trayAvailable: boolean;
}): CloseDecision {
  return !state.quitting && state.trayAvailable ? "hide" : "close";
}
