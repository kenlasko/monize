import { normalizeChildLine, stripEscapes } from "./child-line";

const ESC = "\x1b";

/** A Nest `ConsoleLogger` line as it reaches the supervisor, colours and all. */
function nestLine(level: string, context: string, message: string): string {
  return (
    `${ESC}[33m[Nest] 17136  - ${ESC}[39m2026-11-15, 11:33:34 p.m. ` +
    `${ESC}[33m${level.padStart(7, " ")}${ESC}[39m ` +
    `${ESC}[38;5;3m[${context}] ${ESC}[39m${ESC}[33m${message}${ESC}[39m`
  );
}

describe("normalizeChildLine", () => {
  it("turns the Nest line from the issue into its level and [Context] message", () => {
    expect(
      normalizeChildLine(
        nestLine(
          "WARN",
          "DbInit",
          'Postgres: policy "job_claims_isolation" for relation "job_claims" does not exist, skipping',
        ),
        "info",
      ),
    ).toEqual({
      level: "warn",
      msg: '[DbInit] Postgres: policy "job_claims_isolation" for relation "job_claims" does not exist, skipping',
    });
  });

  it.each([
    ["LOG", "info"],
    ["ERROR", "error"],
    ["WARN", "warn"],
    ["DEBUG", "debug"],
    ["VERBOSE", "debug"],
    ["FATAL", "error"],
  ] as const)("records a Nest %s line at %s", (nestLevel, level) => {
    expect(
      normalizeChildLine(nestLine(nestLevel, "Bootstrap", "hello"), "warn"),
    ).toEqual({ level, msg: "[Bootstrap] hello" });
  });

  it("reads an uncoloured Nest line in another locale's date", () => {
    expect(
      normalizeChildLine(
        "[Nest] 7  - 11/15/2026, 11:33:34 PM     LOG [RlsRuntimeRole] " +
          'RLS_MODE=enforce verified: connected as "monize_app"',
        "info",
      ),
    ).toEqual({
      level: "info",
      msg: '[RlsRuntimeRole] RLS_MODE=enforce verified: connected as "monize_app"',
    });
  });

  it("keeps a Nest line without a context as its bare message", () => {
    expect(
      normalizeChildLine(
        "[Nest] 7  - 15/11/2026 23:33:34   ERROR boom",
        "info",
      ),
    ).toEqual({ level: "error", msg: "boom" });
  });

  it("keeps any other line, and the stream's level, with only escapes removed", () => {
    expect(
      normalizeChildLine(
        `${ESC}[31m    at DbInit.run (/app/dist/db-init.js:10:5)${ESC}[39m`,
        "warn",
      ),
    ).toEqual({
      level: "warn",
      msg: "    at DbInit.run (/app/dist/db-init.js:10:5)",
    });
    expect(normalizeChildLine("plain text", "info")).toEqual({
      level: "info",
      msg: "plain text",
    });
  });

  it("does not read a message that merely mentions Nest as a Nest line", () => {
    expect(
      normalizeChildLine("see [Nest] 7  - x   WARN for details", "info"),
    ).toEqual({ level: "info", msg: "see [Nest] 7  - x   WARN for details" });
  });
});

describe("stripEscapes", () => {
  it("removes colour, cursor, title and two-byte escapes and nothing else", () => {
    expect(
      stripEscapes(
        `${ESC}[1;31mred${ESC}[0m ${ESC}[2K${ESC}]0;title\x07ok ` +
          `${ESC}]8;;https://x.test${ESC}\\link${ESC}]8;;${ESC}\\ ` +
          `${ESC}7${ESC}c[done]`,
      ),
    ).toBe("red ok link [done]");
  });
});
