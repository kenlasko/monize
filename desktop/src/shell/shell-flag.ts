/**
 * How the shell's version reaches the sandboxed preload: as one extra
 * renderer argument (`webPreferences.additionalArguments`), which the preload
 * reads from `process.argv`. The preload cannot `require` this module (a
 * sandboxed preload may load only `electron` and a few Node built-ins), so it
 * carries its own copy of the prefix and the parser; `preload.spec.ts` holds
 * the two copies equal.
 */

export const VERSION_ARG_PREFIX = "--monize-shell-version=";

/** Semver and its build metadata; anything else is not passed on. */
export const VERSION_PATTERN = /^[0-9A-Za-z.+-]{1,64}$/;

export function versionArgument(version: string): string {
  return `${VERSION_ARG_PREFIX}${VERSION_PATTERN.test(version) ? version : ""}`;
}
