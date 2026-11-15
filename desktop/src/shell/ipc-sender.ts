/**
 * Whether an IPC message came from the main window's own page on the app's
 * origin. The preload's channels are reachable from any script the window
 * runs, and from any other window that shares the preload, so every listener
 * the main window's preload talks to checks this first: the notification
 * bridge (`notifications.ts`) and the shell menu (`window-menus.ts`).
 *
 * Plain data in, so it is tested without Electron.
 */

export interface IpcSenderFacts {
  /** The `WebContents` that sent the message (`event.sender`). */
  readonly sender: unknown;
  /** The sending frame's URL (`event.senderFrame?.url`), "" when unknown. */
  readonly frameUrl: string;
}

export function isFromAppPage(
  facts: IpcSenderFacts,
  contents: unknown,
  origin: string,
): boolean {
  if (contents === null || facts.sender !== contents) return false;
  try {
    return new URL(facts.frameUrl).origin === origin;
  } catch {
    return false;
  }
}
