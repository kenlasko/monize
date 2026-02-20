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
