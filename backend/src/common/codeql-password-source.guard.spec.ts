import { readFileSync } from "fs";
import { join } from "path";
import * as ts from "typescript";
import { findRepoRoot, gitListFiles, requireRepoRoot } from "./repo-tree.util";

/**
 * A fixture value built by a call with a password-like argument is a password
 * to CodeQL.
 *
 * CodeQL's sensitive-data model reads any call carrying a string-constant
 * argument its heuristic classes as a password as a call that returns one. A
 * SimpleFIN spec built its rotated access URL as
 * `accessUrl.replace("password", "rotated")`, and after that was fixed, as
 * `simplefinAccessUrl(base, "user", "password")`; either way the result went
 * to `readAccount`, whose cache key is `hashToken(accessUrl)`, and code
 * scanning reported js/insufficient-password-hash on `hashToken` itself. A
 * fixture credential is therefore an opaque word the heuristic does not class
 * as a password (docs/backend/modules-and-runtime.md, CodeQL).
 *
 * Checked are the calls that build a fixture value: `replace`, `replaceAll`,
 * `simplefinAccessUrl`, and a function declared in the same file whose body
 * calls one of those (the `accessWith` wrappers). A password-like argument to `tr`, `toContain` or
 * `describe` returns nothing that is hashed and is left alone. CodeQL also
 * reads a constant through a local `const`, so an identifier bound in the
 * same file to such a literal counts too.
 */

// CodeQL's `maybePassword` and `notSensitiveRegexp`
// (codeql/concepts SensitiveDataHeuristics.qll): a string is a password when
// the first matches and the second does not.
const MAYBE_PASSWORD =
  /(pass(wd|word|code|.?phrase)(?![\s\S]*question)|(auth(entication|ori[sz]ation)?).?key|oauth|api.?(key|tok)|([_-]|\b)mfa([_-]|\b))/i;
const NOT_SENSITIVE =
  /([^\w$.-]|redact|censor|obfuscate|hash|md5|sha|random|(?<!unen)crypt|(?<!un)encode|certain|concert|secretar|wildcard|coauthor|account(ant|ab|ing|ed)|(?<!pro)file|path|([_-]|\b)url)/i;

function isPasswordText(text: string): boolean {
  return MAYBE_PASSWORD.test(text) && !NOT_SENSITIVE.test(text);
}

const BUILDERS = new Set(["replace", "replaceAll", "simplefinAccessUrl"]);

function calleeName(call: ts.CallExpression): string | null {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
}

function callsBuilder(body: ts.Node): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      if (name !== null && BUILDERS.has(name)) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return found;
}

/** Same-file builder wrappers, and consts bound to a password-like literal. */
function localNames(sf: ts.SourceFile): {
  functions: Set<string>;
  passwordConstants: Set<string>;
} {
  const functions = new Set<string>();
  const passwordConstants = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name && callsBuilder(node)) {
      functions.add(node.name.text);
    }
    if (
      ts.isVariableDeclarationList(node) &&
      (node.flags & ts.NodeFlags.Const) !== 0
    ) {
      for (const d of node.declarations) {
        if (!ts.isIdentifier(d.name) || !d.initializer) continue;
        if (
          ts.isArrowFunction(d.initializer) ||
          ts.isFunctionExpression(d.initializer)
        ) {
          if (callsBuilder(d.initializer)) functions.add(d.name.text);
        } else if (
          ts.isStringLiteralLike(d.initializer) &&
          isPasswordText(d.initializer.text)
        ) {
          passwordConstants.add(d.name.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { functions, passwordConstants };
}

function findPasswordBuilds(fileName: string, source: string): number[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest);
  const { functions, passwordConstants } = localNames(sf);
  const isPasswordArg = (arg: ts.Expression): boolean =>
    ts.isStringLiteralLike(arg)
      ? isPasswordText(arg.text)
      : ts.isIdentifier(arg) && passwordConstants.has(arg.text);
  const lines: number[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      if (
        name !== null &&
        (BUILDERS.has(name) || functions.has(name)) &&
        node.arguments.some(isPasswordArg)
      ) {
        lines.push(
          sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return lines;
}

describe("a fixture credential is not built from a password-like argument", () => {
  it("fails the original mistake", () => {
    expect(
      findPasswordBuilds(
        "a.spec.ts",
        'const rotated = creds.accessUrl.replace("password", "rotated");',
      ),
    ).toEqual([1]);
  });

  it("fails the helper, and a local wrapper, given a password-like secret", () => {
    expect(
      findPasswordBuilds(
        "a.spec.ts",
        'const url = simplefinAccessUrl(base, "user", "password");',
      ),
    ).toEqual([1]);
    expect(
      findPasswordBuilds(
        "a.spec.ts",
        [
          "const accessWith = (s: string) => simplefinAccessUrl(base, u, s);",
          'const access = accessWith("demo-password");',
        ].join("\n"),
      ),
    ).toEqual([2]);
  });

  it("fails a password-like literal reached through a local const", () => {
    expect(
      findPasswordBuilds(
        "a.spec.ts",
        ['const PW = "password";', "const b = a.replace(PW, x);"].join("\n"),
      ),
    ).toEqual([2]);
  });

  it("fails replaceAll and a template literal argument", () => {
    expect(findPasswordBuilds("a.ts", "s.replaceAll(`oauth`, x);")).toEqual([
      1,
    ]);
  });

  it("accepts what CodeQL does not read as a password", () => {
    expect(
      findPasswordBuilds(
        "a.spec.ts",
        [
          'const access = simplefinAccessUrl(base, "user", "demo-opaque");',
          'const path = base.replace(/\\/+$/, "");',
          'expect(text).not.toContain("password");',
          'tr("errors.auth.passwordInvalid", "Wrong password.");',
          'const shown = s.replace("redacted-password", "");',
          "const login = (p: string) => api.post(p);",
          'login("password");',
        ].join("\n"),
      ),
    ).toEqual([]);
  });
});

const REPO_ROOT = findRepoRoot(__dirname);
const describeTree = REPO_ROOT || process.env.CI ? describe : describe.skip;

describeTree(
  "no backend file builds a fixture credential from a password-like argument",
  () => {
    it("finds none, and does scan the backend", () => {
      const root = requireRepoRoot(REPO_ROOT);
      const files = gitListFiles(root).filter((path) =>
        /^backend\/(src|test)\/.*\.ts$/.test(path),
      );
      expect(files.length).toBeGreaterThan(100);

      const offenders: string[] = [];
      for (const file of files) {
        const source = readFileSync(join(root, file), "utf8");
        for (const line of findPasswordBuilds(file, source)) {
          offenders.push(`${file}:${line}`);
        }
      }

      expect(offenders).toEqual([]);
    });
  },
);
