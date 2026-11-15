import {
  ProtocolError,
  ProtocolErrorCode,
  SdkError,
  SdkErrorCode,
} from "@modelcontextprotocol/server";
import type { McpServer } from "@modelcontextprotocol/server";

/**
 * What this session's client has actually been observed to do with an
 * `elicitation/create` request.
 *
 * The advertised capability cannot answer this. The SDK rewrites the legacy
 * 2025-06-18 shape `{"elicitation":{}}` into
 * `{"elicitation":{"form":{}}}` before `getClientCapabilities()` sees it
 * (`ElicitationCapabilitySchema`'s `z.preprocess`), so every client that
 * advertises elicitation at all now looks form-capable -- the ones that answer
 * -32601, and the ones that never answer, included. Only behaviour separates
 * them, so behaviour is what we record.
 *
 *  - "unknown":  nothing observed yet.
 *  - "answers":  the client returned an accept/decline/cancel at least once, so
 *                it demonstrably shows dialogs to a human.
 *  - "silent":   the client answered for itself (rejected the method or the
 *                request as malformed), so no human is behind it and it is
 *                not asked again.
 *  - "unanswered": a dialog for a single create or edit timed out or lost its
 *                connection. A person may still be behind the client, so a
 *                round that needs a human still asks; a single write skips
 *                the dialog rather than wait again.
 */
export type ElicitationBehaviour =
  "unknown" | "answers" | "silent" | "unanswered";

/**
 * Keyed on the `McpServer` because there is exactly one per 2025-era MCP
 * session (`mcp-http.controller.ts` builds a fresh server per
 * `Mcp-Session-Id`), and a weak key means the record dies with the session --
 * no cleanup hook to forget, and no way for one client's observed behaviour to
 * be read for another's. This memory is legacy-only: a 2026-07-28 request gets
 * a fresh server and holds nothing between rounds, and needs none of it,
 * because a multi round-trip confirmation has no server-side wait to save.
 */
const observed = new WeakMap<McpServer, ElicitationBehaviour>();

export function elicitationBehaviour(server: McpServer): ElicitationBehaviour {
  return observed.get(server) ?? "unknown";
}

export function recordElicitationAnswered(server: McpServer): void {
  observed.set(server, "answers");
}

/**
 * Record that the client answered for itself (rejected the method or the
 * request). A client that has already proven it shows dialogs is NOT demoted:
 * a single rejection on a capable client is a one-off, not evidence that the
 * next confirmation would go unseen.
 */
export function recordElicitationSilent(server: McpServer): void {
  if (observed.get(server) !== "answers") {
    observed.set(server, "silent");
  }
}

/**
 * Whether an `elicitInput` rejection means the client answered for itself
 * rather than for its user: it rejected the request as unknown or malformed, or
 * the SDK refused it locally for a missing capability. A timeout or a dropped
 * connection is not here: see `elicitationUnanswered`. `MethodNotFound` is the
 * one that matters in practice -- a client that advertises `elicitation` and
 * then answers -32601 to `elicitation/create`.
 *
 * The two error families are separate classes in the SDK and both have to be
 * read: a peer's refusal crosses the wire as a `ProtocolError`, while a
 * timeout, a dropped connection or a locally refused capability is a
 * client-side `SdkError` whose codes are strings, not numbers.
 *
 * An unknown rejection shape is deliberately absent, so a failure nobody has
 * reasoned about refuses the write instead of waving it through.
 */
export function clientAnsweredForItself(err: unknown): boolean {
  if (ProtocolError.isInstance(err)) {
    return (
      err.code === ProtocolErrorCode.ParseError ||
      err.code === ProtocolErrorCode.InvalidRequest ||
      err.code === ProtocolErrorCode.MethodNotFound ||
      err.code === ProtocolErrorCode.InvalidParams
    );
  }
  if (SdkError.isInstance(err)) {
    return (
      // The SDK refuses locally, before any network call, when the client
      // advertises no elicitation at all: no dialog reached a human, which is
      // the same outcome as a client that answered for itself.
      err.code === SdkErrorCode.CapabilityNotSupported
    );
  }
  return false;
}

/**
 * Whether an `elicitInput` rejection means nobody answered: the wait expired or
 * the connection closed while the dialog was open. That is one unanswered
 * dialog, not proof that the client cannot show one, so a round that needs a
 * human is refused without marking the session silent.
 */
export function elicitationUnanswered(err: unknown): boolean {
  return (
    SdkError.isInstance(err) &&
    (err.code === SdkErrorCode.ConnectionClosed ||
      err.code === SdkErrorCode.RequestTimeout)
  );
}

/** Record one unanswered dialog; neither a proven nor a silent client is changed. */
export function recordElicitationUnanswered(server: McpServer): void {
  const current = observed.get(server);
  if (current !== "answers" && current !== "silent") {
    observed.set(server, "unanswered");
  }
}
