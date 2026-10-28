import { reportingFailure } from "../accruals/reporting-errors";
import { sanitizeToolResultStrings } from "../common/sanitization.util";
import type { AuthInfo, ServerContext } from "@modelcontextprotocol/server";
import { ConfirmMismatchError } from "./mcp-confirm";

export interface McpUserContext {
  userId: string;
  scopes: string;
  /**
   * Stable identifier of the credential that authorized this request: the PAT
   * row's id, or the OAuth grant behind the access token.
   *
   * Matching only `userId` let a 2025-era session outlive the credential that
   * created it: a read-only PAT presenting the session id of a session opened
   * with a write PAT inherited the write scope, and a replacement token kept a
   * session alive after the original was revoked (P2-004). It is also the
   * caller key a 2026-07-28 request has instead of a session (see
   * `callerKey`). A context without one cannot be bound, and the transport
   * refuses it rather than serving an unbindable credential.
   */
  credentialId?: string;
}

/**
 * The `extra` payload the transport puts on the request's `AuthInfo`, and the
 * only place a tool handler may learn who is calling.
 *
 * Identity is a property of the REQUEST, not of a session: the 2026-07-28
 * revision has no sessions at all, and even on a 2025-era connection the
 * bearer token rides on every request, so the credential presented on THIS
 * request decides the user and the scopes (INV-MCP-001). `userId` never comes
 * from tool arguments.
 */
interface McpAuthExtra {
  userId: string;
  scopes: string;
  credentialId: string;
}

/**
 * Build the SDK `AuthInfo` the transport attaches to a validated request.
 *
 * Returns `undefined` for a context that carries no `credentialId` -- an OAuth
 * grant with no id cannot be bound to anything, and an unbindable credential
 * must be refused rather than served.
 */
export function toAuthInfo(
  user: McpUserContext,
  token: string,
): AuthInfo | undefined {
  if (!user.credentialId) return undefined;
  const extra: McpAuthExtra = {
    userId: user.userId,
    scopes: user.scopes,
    credentialId: user.credentialId,
  };
  return {
    token,
    clientId: user.credentialId,
    scopes: user.scopes ? user.scopes.split(",") : [],
    extra: extra as unknown as Record<string, unknown>,
  };
}

/**
 * The calling user, read from the request's own validated credential.
 *
 * The shape is checked rather than cast: `authInfo` is pass-through data the
 * transport supplied, and a handler that trusted a malformed one would run
 * with an undefined user id.
 */
export function resolveUserContext(
  ctx: Pick<ServerContext, "http">,
): McpUserContext | undefined {
  const extra = ctx.http?.authInfo?.extra as Partial<McpAuthExtra> | undefined;
  if (
    typeof extra?.userId !== "string" ||
    typeof extra.scopes !== "string" ||
    typeof extra.credentialId !== "string"
  ) {
    return undefined;
  }
  return {
    userId: extra.userId,
    scopes: extra.scopes,
    credentialId: extra.credentialId,
  };
}

/**
 * Which client this call belongs to, for the things that are genuinely about
 * one connected agent rather than about the user: the web-chat relay claim and
 * the observed elicitation behaviour.
 *
 * A 2025-era connection has a session id and keeps using it, so relay
 * semantics there are unchanged. A 2026-07-28 request has no session, and the
 * credential is the only stable per-client fact on the wire -- so two clients
 * sharing one token share a caller key (`docs/backend/mcp.md`).
 * `undefined` means "cannot prove which client", which callers must treat as a
 * direct client, never as a relay turn.
 */
export function callerKey(
  ctx: Pick<ServerContext, "sessionId" | "http">,
): string | undefined {
  return ctx.sessionId ?? resolveUserContext(ctx)?.credentialId;
}

export function hasScope(scopes: string, required: string): boolean {
  return scopes.split(",").includes(required);
}

export function requireScope(
  scopes: string,
  required: string,
):
  | {
      error: true;
      result: { content: { type: "text"; text: string }[]; isError: true };
    }
  | { error: false } {
  if (!hasScope(scopes, required)) {
    return {
      error: true,
      result: {
        content: [
          {
            type: "text",
            text: `Error: Insufficient scope. Requires "${required}" scope.`,
          },
        ],
        isError: true,
      },
    };
  }
  return { error: false };
}

export function toolError(message: string) {
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true as const,
  };
}

/**
 * Converts an unknown error into a safe tool error response.
 * Known HTTP exceptions (4xx) pass through their message;
 * all other errors return a generic message to avoid leaking internals.
 */
export function safeToolError(err: unknown) {
  const failure = reportingFailure(err);
  if (failure)
    return { ...toolResult({ error: failure }), isError: true as const };
  // A confirmation that no longer matches the change is not an internal
  // failure: it is a refusal the caller can act on, and the model needs to be
  // told to ask again rather than to retry the same call.
  if (err instanceof ConfirmMismatchError) {
    return toolError(err.message);
  }
  if (
    err &&
    typeof err === "object" &&
    "getStatus" in err &&
    typeof (err as any).getStatus === "function"
  ) {
    const status = (err as any).getStatus();
    if (status >= 400 && status < 500) {
      const response = (err as any).getResponse?.();
      const message =
        typeof response === "string"
          ? response
          : (response?.message ?? "Request failed");
      return toolError(
        typeof message === "string" ? message : "Request failed",
      );
    }
  }
  return toolError("An error occurred while processing your request");
}

/**
 * Wrap a sanitized payload into the object form required for an MCP tool's
 * `structuredContent`. Bare arrays are nested under `items` (structured content
 * must be a JSON object); primitives under `value`; objects pass through.
 */
function toStructuredContent(data: unknown): Record<string, unknown> {
  if (Array.isArray(data)) {
    return { items: data };
  }
  if (data !== null && typeof data === "object") {
    return data as Record<string, unknown>;
  }
  return { value: data };
}

/**
 * Recursively replace non-finite numbers (NaN, Infinity, -Infinity) with null.
 *
 * Structured-output validation runs against this in-memory object, and each
 * tool's outputSchema is also serialized to JSON Schema for `tools/list`.
 * Neither can represent NaN -- a `z.nan()` branch throws "NaN cannot be
 * represented in JSON Schema" and fails the entire tools/list response, so
 * clients see zero tools. null is exactly what JSON.stringify already emits for
 * these values on the wire, so the normalization is lossless.
 */
function normalizeNonFiniteNumbers(data: unknown): unknown {
  if (typeof data === "number") {
    return Number.isFinite(data) ? data : null;
  }
  if (Array.isArray(data)) {
    return data.map((item) => normalizeNonFiniteNumbers(item));
  }
  if (data !== null && typeof data === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      result[key] = normalizeNonFiniteNumbers(value);
    }
    return result;
  }
  return data;
}

/**
 * The one success path for a tool.
 *
 * It returns `structuredContent` and NOTHING ELSE. Every tool here declares an
 * `outputSchema`, so `structuredContent` is what the SDK validates and what a
 * client reads; the spec's backwards-compatibility advice to ALSO emit the
 * serialized JSON as a text block meant every result travelled twice, once
 * pretty-printed, and a model paid for both halves of every answer. A portfolio
 * summary or a page of transactions is far larger than the tool definition that
 * asked for it, so this is the bigger half of the per-request cost.
 *
 * The cost of dropping it is a client too old to read `structuredContent`, which
 * would see an empty result rather than a degraded one. Restoring the block is a
 * one-line change here if such a client turns up.
 *
 * Errors keep their text block: `toolError` carries no structured content, and
 * an error bypasses output validation entirely.
 */
export function toolResult(data: unknown) {
  const sanitized = normalizeNonFiniteNumbers(sanitizeToolResultStrings(data));
  return {
    content: [] as { type: "text"; text: string }[],
    structuredContent: toStructuredContent(sanitized),
  };
}
