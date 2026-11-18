/**
 * The "Set up another device" window's IPC, all of it. `lan-setup-preload.ts`
 * carries its own copy of these names (a sandboxed preload cannot load this
 * module); `lan-setup-preload.spec.ts` holds the copies equal.
 */
export const LAN_SETUP_CHANNELS = {
  view: "monize-lan:view",
  saveRoot: "monize-lan:save-root",
  replaceRoot: "monize-lan:replace-root",
  changed: "monize-lan:changed",
} as const;
