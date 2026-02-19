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

export function toolResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}
