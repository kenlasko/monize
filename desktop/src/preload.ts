import { contextBridge } from "electron";

/**
 * The main window's preload (`docs/frontend/shell-contract.md`, rule 1): it
 * exposes `window.__MONIZE_SHELL__ = { kind: 'electron', version }` and
 * nothing else. `contextBridge` freezes a copy into the page's world before any
 * page script runs, so the page cannot replace it.
 *
 * This file runs sandboxed, where `require` reaches only `electron` and a few
 * Node built-ins, so it imports nothing of its own: the prefix and the parser
 * below are copies of `shell/shell-flag.ts`, held equal by `preload.spec.ts`.
 */

export const SHELL_FLAG_KEY = "__MONIZE_SHELL__";
export const VERSION_ARG_PREFIX = "--monize-shell-version=";
const VERSION_PATTERN = /^[0-9A-Za-z.+-]{1,64}$/;

export interface ShellFlag {
  readonly kind: "electron";
  readonly version: string;
}

/** The flag for this renderer's argv; a missing or odd version becomes "". */
export function shellFlagFrom(argv: readonly string[]): ShellFlag {
  const arg = argv.find((value) => value.startsWith(VERSION_ARG_PREFIX));
  const version = arg === undefined ? "" : arg.slice(VERSION_ARG_PREFIX.length);
  return {
    kind: "electron",
    version: VERSION_PATTERN.test(version) ? version : "",
  };
}

contextBridge.exposeInMainWorld(SHELL_FLAG_KEY, shellFlagFrom(process.argv));
