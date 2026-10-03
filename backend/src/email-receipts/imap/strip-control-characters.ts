const NEWLINE = 0x0a;
const TAB = 0x09;
const DELETE = 0x7f;
const LAST_C0 = 0x1f;
const C1_START = 0x80;
const C1_END = 0x9f;

function isDroppedControl(code: number): boolean {
  if (code === NEWLINE || code === TAB) return false;
  return (
    code <= LAST_C0 || code === DELETE || (code >= C1_START && code <= C1_END)
  );
}

/**
 * The text with every control character removed except newline and tab (a NUL
 * is refused by PostgreSQL outright). Line endings are normalised to `\n` first
 * so a CRLF message does not lose its line breaks. Written as code-point
 * arithmetic rather than a character class of control characters, which nobody
 * can read in a diff.
 */
export function stripControlCharacters(input: string): string {
  const unified = input.replace(/\r\n?/g, "\n");
  let out = "";
  for (let index = 0; index < unified.length; index += 1) {
    if (!isDroppedControl(unified.charCodeAt(index))) out += unified[index];
  }
  return out;
}
