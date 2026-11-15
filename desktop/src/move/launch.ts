import {
  AppPaths,
  AppPathsInput,
  DataDirOrigin,
  dataDirOverride,
  dataPathsFor,
  resolveDataDirOrigin,
  resolveDefaultDataDir,
  resolveResourcesDir,
} from "../app-paths";
import { pathFor } from "../supervisor/postgres-args";
import { CONFIG_FILE, TOMBSTONE_FILE } from "./layout";
import { DataLocation, locationFileFor, readLocationSync } from "./location";
import { journalFileFor, parseTombstone } from "./records";

/**
 * Which data folder a launch uses, and whether it may start there. Read
 * before the single-instance lock is taken, because the lock is keyed on the
 * data folder: every launch reads the same pointer, so every launch asks for
 * the same lock, before, during and after a move.
 */

export interface LaunchPaths {
  readonly paths: AppPaths;
  readonly origin: DataDirOrigin;
  /**
   * Where a move keeps its records, beside the default data folder. Null
   * under `MONIZE_DATA_DIR`: that launch ignores the pointer, so it must not
   * write one either, and the data folder cannot be moved from it.
   */
  readonly records: {
    readonly defaultDataDir: string;
    readonly locationFile: string;
    readonly journalFile: string;
  } | null;
  readonly location: DataLocation | null;
}

export type LocationReader = (
  file: string,
  platform: NodeJS.Platform,
) => DataLocation | null;

/** Throws `AppPathsError` or `LocationError`, each written to be shown. */
export function resolveLaunchPaths(
  input: AppPathsInput,
  read: LocationReader = readLocationSync,
): LaunchPaths {
  const resourcesDir = resolveResourcesDir(input);
  if (dataDirOverride(input) !== undefined) {
    const { dataDir, origin } = resolveDataDirOrigin(input);
    return {
      paths: { resourcesDir, data: dataPathsFor(dataDir, input.platform) },
      origin,
      records: null,
      location: null,
    };
  }
  const defaultDataDir = resolveDefaultDataDir(input);
  const locationFile = locationFileFor(defaultDataDir);
  const location = read(locationFile, input.platform);
  const { dataDir, origin } = resolveDataDirOrigin({
    ...input,
    movedDataDir: location?.dataDir ?? null,
  });
  return {
    paths: { resourcesDir, data: dataPathsFor(dataDir, input.platform) },
    origin,
    records: {
      defaultDataDir,
      locationFile,
      journalFile: journalFileFor(defaultDataDir),
    },
    location,
  };
}

export type LaunchVerdict =
  | { readonly kind: "ok" }
  /** The folder holds a tombstone: its data was moved to `movedTo`. */
  | {
      readonly kind: "moved-away";
      readonly dataDir: string;
      readonly movedTo: string;
    }
  /**
   * The pointer names a folder with no `config.json`: a drive that is not
   * connected, or a folder deleted or renamed by hand. Starting would create
   * an empty Monize there, so the launch stops. `canGoBack` when the move
   * never started there and the previous folder is still whole.
   */
  | {
      readonly kind: "missing";
      readonly dataDir: string;
      readonly canGoBack: boolean;
    };

export interface LaunchProbe {
  exists(path: string): boolean;
  /** The file's bytes, or null when it cannot be read. */
  read(path: string): Buffer | null;
}

export function launchVerdict(
  launch: LaunchPaths,
  platform: NodeJS.Platform,
  probe: LaunchProbe,
): LaunchVerdict {
  const path = pathFor(platform);
  const { dataDir } = launch.paths.data;
  const tombstoneFile = path.join(dataDir, TOMBSTONE_FILE);
  if (probe.exists(tombstoneFile)) {
    const tombstone = parseTombstone(probe.read(tombstoneFile));
    return {
      kind: "moved-away",
      dataDir,
      movedTo: tombstone?.movedTo ?? "",
    };
  }
  if (launch.origin !== "pointer" || launch.location === null) {
    return { kind: "ok" };
  }
  if (probe.exists(path.join(dataDir, CONFIG_FILE))) {
    return { kind: "ok" };
  }
  const { previousDataDir, state } = launch.location;
  return {
    kind: "missing",
    dataDir,
    canGoBack:
      state === "pending" &&
      previousDataDir !== null &&
      probe.exists(path.join(previousDataDir, CONFIG_FILE)),
  };
}
