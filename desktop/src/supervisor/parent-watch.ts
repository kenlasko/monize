import { posix, win32 } from "path";

/**
 * The orphan guard every backend and frontend process runs with:
 * `desktop/resources/parent-watch.cjs`, staged to
 * `<resources>/shell/parent-watch.cjs` (outside the asar when packaged,
 * `desktop/staging/shell/` in development) and loaded with `--require`
 * before the layer's own arguments. The child is given a stdin pipe that the
 * supervisor never writes to or closes; when the shell dies the OS closes
 * it and the preload exits the child. The file's header says why it is safe.
 *
 * The prefix is the one place the desktop's command line differs from the
 * container's. `boot-contract.guard.spec.ts` holds every spawned command to
 * exactly `parentWatchArgs(...)` followed by the container's own arguments.
 */

export const PARENT_WATCH_DIR = "shell";
export const PARENT_WATCH_FILE = "parent-watch.cjs";

/** Where the preload is under a resources directory, in the platform's flavour. */
export function parentWatchPath(
  resourcesDir: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const path = platform === "win32" ? win32 : posix;
  return path.join(resourcesDir, PARENT_WATCH_DIR, PARENT_WATCH_FILE);
}

/** The desktop-only argument prefix: load the preload, by absolute path. */
export function parentWatchArgs(preloadPath: string): readonly string[] {
  return ["--require", preloadPath];
}

/** The preload is missing: a damaged install or an incomplete staging. */
export class ParentWatchMissingError extends Error {
  readonly code = "PARENT_WATCH_MISSING";

  constructor(readonly path: string) {
    super(
      `The desktop's process guard ${path} is missing, so a child could ` +
        "outlive the application. The installation is incomplete; in " +
        "development, run `npm run stage` in desktop/.",
    );
    this.name = "ParentWatchMissingError";
  }
}
