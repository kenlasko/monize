import {
  PathModule,
  pathFor,
  shellUnsafeIn,
} from "../supervisor/postgres-args";
import { isStorablePath } from "./location";
import { PGDATA_DIR } from "./layout";
import { MoveFs } from "./move-types";

/**
 * Which folder a data folder may be moved to. The rules are refusals: the
 * move would rather say no than put a database somewhere an update, an
 * uninstall or the next start could lose it.
 */

export type TargetProblem =
  | "not-absolute"
  | "unstorable"
  | "network"
  | "root"
  | "same"
  | "inside-data"
  | "inside-default"
  | "inside-install"
  | "parent-missing"
  | "not-a-folder"
  | "not-empty"
  | "leftover"
  | "no-space";

export interface TargetRules {
  readonly platform: NodeJS.Platform;
  /** The data folder being moved. */
  readonly source: string;
  /** The default data folder; moving back to exactly it is allowed. */
  readonly defaultDataDir: string;
  /**
   * The installation folder when packaged, else null. An update or an
   * uninstall deletes it with everything in it.
   */
  readonly installDir: string | null;
}

export type Relation = "same" | "inside" | "contains" | "apart";

/** How folder `a` stands to folder `b`; names compare as the platform does. */
export function relationOf(
  a: string,
  b: string,
  platform: NodeJS.Platform,
): Relation {
  const path = pathFor(platform);
  const fold = (value: string): string => {
    const resolved = path.resolve(value);
    return platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  const [left, right] = [fold(a), fold(b)];
  if (left === right) return "same";
  const under = (child: string, parent: string): boolean =>
    child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
  if (under(left, right)) return "inside";
  return under(right, left) ? "contains" : "apart";
}

/** The staging folder a copy is built in: a sibling, so the last step is a rename. */
export function stagingFor(target: string): string {
  return `${target}.monize-partial`;
}

/** The rules that need no disk: what the path itself says. */
export function checkTargetPath(
  target: string,
  rules: TargetRules,
): TargetProblem | null {
  const { platform } = rules;
  const path = pathFor(platform);
  if (!path.isAbsolute(target)) return "not-absolute";
  // A share reached by name. A mapped drive letter cannot be told apart
  // from a local disk without asking Windows, which this code does not do.
  if (platform === "win32" && /^[\\/]{2}/.test(target)) return "network";
  const resolved = path.resolve(target);
  if (path.dirname(resolved) === resolved) return "root";
  // pg_ctl cannot pass some characters to the server, and the pointer file
  // cannot hold others; either would leave a copy that never starts.
  if (
    !isStorablePath(resolved) ||
    shellUnsafeIn(path.join(resolved, PGDATA_DIR), platform) !== undefined
  ) {
    return "unstorable";
  }
  const toSource = relationOf(resolved, rules.source, platform);
  if (toSource === "same") return "same";
  if (toSource !== "apart") return "inside-data";
  const toDefault = relationOf(resolved, rules.defaultDataDir, platform);
  if (toDefault === "inside" || toDefault === "contains") {
    return "inside-default";
  }
  if (
    rules.installDir !== null &&
    relationOf(resolved, rules.installDir, platform) !== "apart"
  ) {
    return "inside-install";
  }
  return null;
}

export interface TargetVerdict {
  readonly problem: TargetProblem | null;
  /** The folder as it will be recorded: absolute and normalised. */
  readonly target: string;
  readonly freeBytes: number | null;
  readonly neededBytes: number;
}

/** Room for the copy, one tenth over, and a little for the first start. */
export function neededBytesFor(sourceBytes: number): number {
  return Math.ceil(sourceBytes * 1.1) + 64 * 1024 * 1024;
}

/** The parent with every link resolved, or null when it is not a folder. */
async function realParentOf(
  fs: MoveFs,
  path: PathModule,
  target: string,
): Promise<string | null> {
  try {
    const real = await fs.realpath(path.dirname(target));
    return (await fs.lstat(real))?.kind === "dir" ? real : null;
  } catch {
    return null;
  }
}

async function diskProblem(
  fs: MoveFs,
  target: string,
): Promise<TargetProblem | null> {
  const stat = await fs.lstat(target);
  if (stat !== null) {
    if (stat.kind !== "dir") return "not-a-folder";
    if ((await fs.list(target)).length > 0) return "not-empty";
  }
  // A staging folder already there is not this move's: an earlier one's is
  // removed at launch (`recover.ts`), so this is somebody's own folder.
  return (await fs.lstat(stagingFor(target))) === null ? null : "leftover";
}

/**
 * The full check: the path's own rules, the same rules again on the path
 * with every link in its parent resolved (a new folder under another name
 * for the data folder is still inside it), what is on disk, and free space.
 */
export async function inspectTarget(
  fs: MoveFs,
  chosen: string,
  sourceBytes: number,
  rules: TargetRules,
): Promise<TargetVerdict> {
  const path = pathFor(rules.platform);
  const neededBytes = neededBytesFor(sourceBytes);
  const verdict = (
    problem: TargetProblem | null,
    target: string,
    freeBytes: number | null = null,
  ): TargetVerdict => ({ problem, target, freeBytes, neededBytes });

  const lexical = checkTargetPath(chosen, rules);
  if (lexical !== null) return verdict(lexical, chosen);
  const target = path.resolve(chosen);
  const realParent = await realParentOf(fs, path, target);
  if (realParent === null) return verdict("parent-missing", target);
  const aliased = checkTargetPath(
    path.join(realParent, path.basename(target)),
    rules,
  );
  if (aliased !== null) return verdict(aliased, target);
  const onDisk = await diskProblem(fs, target);
  if (onDisk !== null) return verdict(onDisk, target);

  const freeBytes = await fs.freeBytes(path.dirname(target));
  if (freeBytes !== null && freeBytes < neededBytes) {
    return verdict("no-space", target, freeBytes);
  }
  return verdict(null, target, freeBytes);
}
