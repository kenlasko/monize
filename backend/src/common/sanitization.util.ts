/**
 * Strip HTML angle brackets from a string.
 *
 * Matches the behaviour of the `@SanitizeHtml()` class-validator
 * decorator. MCP tools and other surfaces that bypass the DTO layer
 * use this to apply the same inline sanitization before persisting
 * user-controlled strings.
 */
export function stripHtml(value: string | undefined): string | undefined {
  if (value === undefined || value === null) return value;
  return value.replace(/[<>]/g, "");
}

/**
 * Sanitize a user-controlled string before interpolating it into an
 * LLM prompt or tool-result payload.
 *
 * Strips characters that could break prompt structure or inject
 * instructions: newlines, carriage returns, null bytes, and control
 * characters. Result is a single-line trimmed string.
 */
export function sanitizePromptValue(value: string): string {
  return (
    value
      .replace(/[\r\n]+/g, " ")
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
      .trim()
  );
}

/**
 * Recursively sanitize every string inside a tool-result payload.
 *
 * Payees, category names, and descriptions may contain prompt-injection
 * payloads. Applied to tool results (both AI and MCP) before they are
 * handed back to the LLM.
 */
export function sanitizeToolResultStrings(data: unknown): unknown {
  if (data === null || data === undefined) {
    return data;
  }

  if (typeof data === "string") {
    return sanitizePromptValue(data);
  }

  if (Array.isArray(data)) {
    return data.map((item) => sanitizeToolResultStrings(item));
  }

  if (typeof data === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      result[key] = sanitizeToolResultStrings(value);
    }
    return result;
  }

  return data;
}
