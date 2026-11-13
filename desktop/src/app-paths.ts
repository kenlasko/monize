import { posix, win32 } from "path";

/**
 * Where the desktop app finds what it ships and where it keeps what it owns.
 *
 * Pure: every input is passed in (the Electron main process supplies
 * `app.isPackaged` and `process.resourcesPath`), so the same functions run
 * under jest on Linux. The path flavour follows `platform`, not the host, so a
 * spec can ask for the Windows layout on a Linux runner.
 */

export interface AppPathsInput {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  /** Electron's `app.isPackaged`. */
  readonly isPackaged: boolean;
  /** Electron's `process.resourcesPath`; only read when packaged. */
  readonly resourcesPath: string;
  /** The `desktop/` package directory, for the unpackaged (dev) layout. */
  readonly desktopRoot: string;
  /** `os.homedir()`, for the XDG fallback off Windows. */
  readonly homeDir: string;
}

/** Everything the app writes, under one per-user directory (plan D6). */
export interface DataPaths {
  readonly dataDir: string;
  readonly pgdata: string;
  readonly backups: string;
  readonly attachments: string;
  readonly logs: string;
  readonly configFile: string;
}

export interface AppPaths {
  /** Holds `backend/`, `frontend/` and `postgres/` (extraResources). */
  readonly resourcesDir: string;
  readonly data: DataPaths;
}

export const DATA_DIR_ENV = "MONIZE_DATA_DIR";
const APP_DIR_NAME = "Monize";

export class AppPathsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppPathsError";
  }
}

function pathFor(platform: NodeJS.Platform): typeof posix {
  return platform === "win32" ? win32 : posix;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** `resourcesPath` when packaged, else the `desktop/staging` tree. */
export function resolveResourcesDir(input: AppPathsInput): string {
  const path = pathFor(input.platform);
  return input.isPackaged
    ? input.resourcesPath
    : path.join(input.desktopRoot, "staging");
}

/**
 * `MONIZE_DATA_DIR` when set, else `%LOCALAPPDATA%\Monize` on Windows, else
 * `$XDG_DATA_HOME/Monize` or `~/.local/share/Monize` so the package can be
 * exercised on Linux. A relative override is refused rather than resolved
 * against whatever the working directory happens to be; a relative
 * `XDG_DATA_HOME` is ignored, as the XDG specification says.
 */
export function resolveDataDir(input: AppPathsInput): string {
  const path = pathFor(input.platform);
  const override = nonEmpty(input.env[DATA_DIR_ENV]);
  if (override !== undefined) {
    if (!path.isAbsolute(override)) {
      throw new AppPathsError(
        `${DATA_DIR_ENV} must be an absolute path; got a relative one.`,
      );
    }
    return path.normalize(override);
  }
  if (input.platform === "win32") {
    const localAppData = nonEmpty(input.env.LOCALAPPDATA);
    if (localAppData === undefined || !path.isAbsolute(localAppData)) {
      throw new AppPathsError(
        "LOCALAPPDATA is not set to an absolute path, so there is nowhere to " +
          `keep Monize's data. Set ${DATA_DIR_ENV} to choose a folder.`,
      );
    }
    return path.join(localAppData, APP_DIR_NAME);
  }
  const xdg = nonEmpty(input.env.XDG_DATA_HOME);
  if (xdg !== undefined && path.isAbsolute(xdg)) {
    return path.join(xdg, APP_DIR_NAME);
  }
  return path.join(input.homeDir, ".local", "share", APP_DIR_NAME);
}

/** The fixed layout under a data directory. */
export function dataPathsFor(
  dataDir: string,
  platform: NodeJS.Platform,
): DataPaths {
  const path = pathFor(platform);
  return {
    dataDir,
    pgdata: path.join(dataDir, "pgdata"),
    backups: path.join(dataDir, "backups"),
    attachments: path.join(dataDir, "attachments"),
    logs: path.join(dataDir, "logs"),
    configFile: path.join(dataDir, "config.json"),
  };
}

export function resolveAppPaths(input: AppPathsInput): AppPaths {
  return {
    resourcesDir: resolveResourcesDir(input),
    data: dataPathsFor(resolveDataDir(input), input.platform),
  };
}
