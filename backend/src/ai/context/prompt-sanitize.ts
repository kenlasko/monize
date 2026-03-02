/**
 * Sanitize user-controlled strings before interpolating them into LLM prompts.
 *
 * Strips characters that could break the prompt structure or inject
 * instructions: newlines, carriage returns, null bytes, and control
 * characters. The result is a single-line string safe for use inside
 * a prompt data section.
 */
export function sanitizePromptValue(value: string): string {
  return (
    value
      .replace(/[\r\n]+/g, " ") // collapse newlines into space
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "") // strip control chars
      .trim()
  );
}

/**
 * Recursively sanitize all string values in a tool result object.
 *
 * Tool results may contain user-controlled strings (payee names,
 * category names, transaction descriptions) that could include
 * prompt injection payloads. This function applies sanitizePromptValue()
 * to every string value in the data structure before it is passed
 * back to the LLM as a tool result message.
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

  // numbers, booleans, etc. pass through unchanged
  return data;
}
