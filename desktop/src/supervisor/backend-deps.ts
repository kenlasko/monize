import { posix, win32 } from "path";

/**
 * The backend's second desktop-only preload: `desktop/resources/backend-deps.cjs`,
 * staged to `<resources>/shell/backend-deps.cjs` beside the parent-watch
 * preload. Staging packs the backend's production dependencies into one
 * archive, `<resources>/backend/node_modules.asar`, so that the installer
 * writes one file instead of about 18,000; this preload is what lets the
 * backend's processes find their packages in it. The file's header says how.
 *
 * Only the backend's three processes (db-init, db-migrate and the server)
 * load it; the frontend ships its own node_modules unpacked and never sees it.
 * `boot-contract.guard.spec.ts` holds each backend command to exactly the
 * parent-watch prefix, this preload's two arguments, then the container's own.
 */

export const BACKEND_DEPS_DIR = "shell";
export const BACKEND_DEPS_FILE = "backend-deps.cjs";

/** Where the preload is under a resources directory, in the platform's flavour. */
export function backendDepsPath(
  resourcesDir: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const path = platform === "win32" ? win32 : posix;
  return path.join(resourcesDir, BACKEND_DEPS_DIR, BACKEND_DEPS_FILE);
}

/** A layer preload other than parent-watch is missing: a damaged install. */
export class PreloadMissingError extends Error {
  readonly code = "PRELOAD_MISSING";

  constructor(readonly path: string) {
    super(
      `The desktop's preload ${path} is missing, so the process cannot ` +
        "start. The installation is incomplete; in development, run " +
        "`npm run stage` in desktop/.",
    );
    this.name = "PreloadMissingError";
  }
}
