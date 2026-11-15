import { findDeepLinkArgument } from "./deep-link";

/**
 * What a launch asks for, read from its command line. A second launch hands
 * its request to the running instance (Electron's `second-instance` event)
 * both as its argv and as `additionalData`; the data is preferred because
 * Chromium may reorder or rewrite switches in the forwarded argv on Windows,
 * and the argv is the fallback for a sender that passed none.
 */

/**
 * Asks the running instance to quit cleanly and returns once it has gone
 * (`quit-wait.ts`); with none running, stops a PostgreSQL a killed instance
 * left behind. The installer, the uninstaller and the CI smoke test use it.
 */
export const QUIT_FLAG = "--quit";

export interface LaunchRequest {
  readonly quit: boolean;
  /** The raw `monize:` argument, unvalidated: `parseDeepLink` decides. */
  readonly deepLink: string | null;
}

export function launchRequestFrom(argv: readonly string[]): LaunchRequest {
  return {
    quit: argv.includes(QUIT_FLAG),
    deepLink: findDeepLinkArgument(argv) ?? null,
  };
}

/** What a second launch sends to the first as `additionalData`. */
export function instanceData(request: LaunchRequest): Record<string, unknown> {
  return { monize: 1, quit: request.quit, deepLink: request.deepLink };
}

function fromData(data: unknown): LaunchRequest | null {
  if (typeof data !== "object" || data === null) {
    return null;
  }
  const record = data as Record<string, unknown>;
  if (record.monize !== 1 || typeof record.quit !== "boolean") {
    return null;
  }
  const deepLink = typeof record.deepLink === "string" ? record.deepLink : null;
  return { quit: record.quit, deepLink };
}

export type SecondInstanceAction =
  | { readonly kind: "quit" }
  | { readonly kind: "deep-link"; readonly raw: string }
  | { readonly kind: "focus" };

export function secondInstanceAction(
  argv: readonly string[],
  additionalData: unknown,
): SecondInstanceAction {
  const request = fromData(additionalData) ?? launchRequestFrom(argv);
  if (request.quit) {
    return { kind: "quit" };
  }
  if (request.deepLink !== null) {
    return { kind: "deep-link", raw: request.deepLink };
  }
  return { kind: "focus" };
}
