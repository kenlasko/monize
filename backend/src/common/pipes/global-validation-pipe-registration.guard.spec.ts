import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

/**
 * Every global pipe registration, the server's and each test app's alike, is
 * the one pipe `createGlobalValidationPipe` builds. A test app with a
 * `ValidationPipe` of its own converts what the server does not (the
 * `enableImplicitConversion` `test/helpers/test-database.ts` carried) or leaves
 * a `number` query to `+value`, so its suite passes requests the server answers
 * differently (issue 2225).
 */

const BACKEND_ROOT = join(__dirname, "..", "..", "..");
const SCANNED_DIRS = ["src", "test"];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      out.push(...sourceFiles(full));
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

/** Blank comments while keeping line numbers, so prose may name the call. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

/** The 1-based lines of a `useGlobalPipes(...)` call with any other argument. */
function offendingLines(source: string): number[] {
  const code = stripComments(source);
  const lines: number[] = [];
  for (const match of code.matchAll(/\buseGlobalPipes\s*\(/g)) {
    const rest = code.slice((match.index ?? 0) + match[0].length);
    if (!/^\s*createGlobalValidationPipe\(\)\s*,?\s*\)/.test(rest)) {
      lines.push(code.slice(0, match.index).split("\n").length);
    }
  }
  return lines;
}

describe("a global pipe registration", () => {
  it("is createGlobalValidationPipe() alone, in the server and every test app", () => {
    const offenders: string[] = [];
    let registrations = 0;
    for (const dir of SCANNED_DIRS) {
      for (const file of sourceFiles(join(BACKEND_ROOT, dir))) {
        // This file's fixtures are the offending calls it tests itself on.
        if (file === __filename) continue;
        const source = readFileSync(file, "utf8");
        registrations +=
          stripComments(source).split("useGlobalPipes(").length - 1;
        for (const line of offendingLines(source)) {
          offenders.push(`${relative(BACKEND_ROOT, file)}:${line}`);
        }
      }
    }
    expect(registrations).toBeGreaterThan(3);
    expect(
      offenders.map(
        (o) =>
          `${o} registers a global pipe of its own: use app.useGlobalPipes(createGlobalValidationPipe()) (src/common/pipes/global-validation.pipe.ts)`,
      ),
    ).toEqual([]);
  });

  describe("the scan", () => {
    it("accepts the shared pipe, wrapped or not, and ignores prose", () => {
      expect(
        offendingLines(
          [
            "app.useGlobalPipes(createGlobalValidationPipe());",
            "app.useGlobalPipes(",
            "  createGlobalValidationPipe(),",
            ");",
            "// app.useGlobalPipes(new ValidationPipe());",
            "/* app.useGlobalPipes(new ValidationPipe()) */",
          ].join("\n"),
        ),
      ).toEqual([]);
    });

    it("names a pipe of the app's own, or a second pipe beside the shared one", () => {
      expect(
        offendingLines(
          [
            "app.useGlobalPipes(",
            "  new ValidationPipe({ transform: true }),",
            ");",
            "app.useGlobalPipes(createGlobalValidationPipe(), new OtherPipe());",
            "app.useGlobalPipes(pipe);",
          ].join("\n"),
        ),
      ).toEqual([1, 4, 5]);
    });
  });
});
