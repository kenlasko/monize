import { sanitizeToolResultStrings } from "../common/sanitization.util";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface McpUserContext {
  userId: string;
  scopes: string;
}

export type UserContextResolver = (
  sessionId?: string,
) => McpUserContext | undefined;

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

export type WriteConfirmation = "accepted" | "declined" | "unsupported";

// A human needs time to read and decide, so override the SDK's short default
// request timeout for the confirmation round-trip.
const CONFIRM_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Ask the MCP client to confirm a write via elicitation -- the MCP-native
 * equivalent of the AI Assistant's approve/reject card. Returns:
 *  - "accepted": the user approved; proceed with the write.
 *  - "declined": the user rejected/cancelled, or a supported dialog
 *    failed/timed out; abort so a write never happens without an explicit
 *    accept.
 *  - "unsupported": the client advertises no form-elicitation capability, so no
 *    dialog can be shown and the caller falls back to its normal behavior. The
 *    client still gates every tool call with its own approval prompt, so this
 *    is not a consent bypass.
 *
 * We pre-check the capability (rather than relying solely on the thrown
 * "client does not support elicitation" error) so that only a genuine lack of
 * capability falls through to the write -- a dismissed or timed-out dialog on a
 * capable client must abort.
 */
export async function confirmWrite(
  server: McpServer,
  message: string,
): Promise<WriteConfirmation> {
  const capabilities = server.server.getClientCapabilities();
  if (!capabilities?.elicitation?.form) {
    return "unsupported";
  }
  try {
    const result = await server.server.elicitInput(
      {
        message,
        // No fields to collect -- the accept/decline/cancel action is the answer.
        requestedSchema: { type: "object", properties: {} },
      },
      { timeout: CONFIRM_TIMEOUT_MS },
    );
    return result.action === "accept" ? "accepted" : "declined";
  } catch {
    return "declined";
  }
}

export function toolResult(data: unknown) {
  const sanitized = normalizeNonFiniteNumbers(sanitizeToolResultStrings(data));
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(sanitized, null, 2) },
    ],
    structuredContent: toStructuredContent(sanitized),
  };
}
