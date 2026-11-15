/**
 * The splash window's IPC, all of it: the main process pushes the view, the
 * page sends Retry or Quit. `splash-preload.ts` carries its own copy of these
 * names (a sandboxed preload cannot load this module); `splash-preload.spec.ts`
 * holds the copies equal.
 */
export const SPLASH_CHANNELS = {
  view: "monize-splash:view",
  retry: "monize-splash:retry",
  quit: "monize-splash:quit",
} as const;
