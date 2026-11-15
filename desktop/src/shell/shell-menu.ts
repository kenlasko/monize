/**
 * The shell menu's bridge (`docs/frontend/shell-contract.md`, "The shell
 * menu"): the page asks for the shell's menu with `open()` and the main
 * process pops it up in the window. The request carries nothing and nothing
 * comes back; every item still needs the reader's own click.
 *
 * The preload cannot import this module (it runs sandboxed), so it carries its
 * own copies of the key and the channel; `preload.spec.ts` holds them equal.
 */

/** Where the preload exposes the bridge in the page's world. */
export const SHELL_MENU_KEY = "__MONIZE_SHELL_MENU__";
/** The IPC channel the preload sends the request on. */
export const SHELL_MENU_CHANNEL = "monize:shell-menu";
