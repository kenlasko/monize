import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

/**
 * Guard tests for the E2E specs in `e2e/tests`, which live outside `src/` and
 * so outside every other scan in this directory. Same shape as
 * `ui-conventions.test.ts`: a mechanical mistake a reviewer caught once, turned
 * into a rule the machine checks. The rule is in `frontend/CLAUDE.md`.
 */
const E2E_TESTS_DIR = resolve(__dirname, "../../../e2e/tests");

function e2eSpecs(): [string, string][] {
  return readdirSync(E2E_TESTS_DIR)
    .filter((name) => name.endsWith(".spec.ts"))
    .map((name) => [
      `e2e/tests/${name}`,
      readFileSync(resolve(E2E_TESTS_DIR, name), "utf8"),
    ]);
}

/** Blank comment bodies, keeping line breaks so a report still points at the source. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "))
    .replace(
      /(^|[^:])\/\/[^\n]*/g,
      (match, before: string) =>
        before + " ".repeat(match.length - before.length),
    );
}

describe("an alert locator is scoped to a region", () => {
  // Next's route announcer is a `role="alert"` on every hydrated page, so a
  // page-wide alert locator resolves to two elements once a panel renders.
  const PAGE_WIDE_ALERT = /\bpage\s*\.\s*getByRole\(\s*['"]alert['"]/;

  it("has no page-wide getByRole('alert') in any E2E spec", () => {
    const offenders = e2eSpecs()
      .map(([path, content]) => [path, withoutComments(content)] as const)
      .filter(([, content]) => PAGE_WIDE_ALERT.test(content))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it("reads the real spec directory", () => {
    // A guard over an empty list is green for the wrong reason.
    expect(e2eSpecs().length).toBeGreaterThan(10);
  });

  it("would fail the shape it bans", () => {
    expect(PAGE_WIDE_ALERT.test("await expect(page.getByRole('alert')).toBeVisible();")).toBe(true);
    expect(PAGE_WIDE_ALERT.test("page.getByRole('main').getByRole('alert')")).toBe(false);
  });
});
