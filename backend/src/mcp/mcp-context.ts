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

export function toolResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}
