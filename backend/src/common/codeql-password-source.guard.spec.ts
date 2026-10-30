import { readFileSync } from "fs";
import { join } from "path";
import * as ts from "typescript";
import { findRepoRoot, gitListFiles, requireRepoRoot } from "./repo-tree.util";

/**
 * A string derived by a `.replace` call with a password-like argument is a
 * password to CodeQL.
 *
 * CodeQL's sensitive-data model reads any call carrying a string-constant
 * argument whose text its name heuristic classes as a password as a call that
 * returns one, so `url.replace("password", "rotated")` is a cleartext password
 * source. A SimpleFIN spec built its rotated access URL that way and passed it
 * to `readAccount`, whose cache key is `hashToken(accessUrl)`, and code
 * scanning reported js/insufficient-password-hash on `hashToken` itself. The
 * same text as a plain string literal is not a source, so a fixture that needs
 * a second credential spells it out (docs/backend/modules-and-runtime.md,
 * CodeQL). Only `replace` and `replaceAll` are checked: they return the
 * derived string, which is how a fixture reaches a hash; a password-like
 * argument to `tr`, `toContain` or `configService.get` returns nothing that is
 * hashed.
 *
 * The check is deliberately broader than CodeQL in one direction: CodeQL's
 * `notSensitiveRegexp` exempts a string holding a non-word character other
 * than `$`, `.` or `-`, so a URL whose userinfo carries the word is not a
 * source and the bare `"password"` was. Telling the two apart buys nothing here, so any
 * password-like argument fails. CodeQL also reads a constant through a local
 * `const`, so an identifier bound in the same file to such a literal fails too.
 */

// The part of CodeQL's password heuristic (HeuristicNames.qll) a fixture is
// likely to spell, plus the `oauth` and `apiKey` names the CodeQL section of
// docs/backend/modules-and-runtime.md records.
const PASSWORD_LIKE =
  /pass(wd|word|code|phrase)|auth(entication|ori[sz]ation)?[-_]?key|api[-_]?key|oauth/i;

const DERIVING_METHODS = new Set(["replace", "replaceAll"]);

function passwordLikeConstants(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclarationList(node) &&
      (node.flags & ts.NodeFlags.Const) !== 0
    ) {
      for (const d of node.declarations) {
        if (
          ts.isIdentifier(d.name) &&
          d.initializer &&
          ts.isStringLiteralLike(d.initializer) &&
          PASSWORD_LIKE.test(d.initializer.text)
        ) {
          names.add(d.name.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return names;
}

function findPasswordReplaces(fileName: string, source: string): number[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest);
  const constants = passwordLikeConstants(sf);
  const isPasswordLike = (arg: ts.Expression): boolean =>
    ts.isStringLiteralLike(arg)
      ? PASSWORD_LIKE.test(arg.text)
      : ts.isIdentifier(arg) && constants.has(arg.text);
  const lines: number[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      DERIVING_METHODS.has(node.expression.name.text) &&
      node.arguments.some(isPasswordLike)
    ) {
      lines.push(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return lines;
}

describe("a password-like string is not derived with replace", () => {
  it("fails the original mistake", () => {
    expect(
      findPasswordReplaces(
        "a.spec.ts",
        'const rotated = creds.accessUrl.replace("password", "rotated");',
      ),
    ).toEqual([1]);
  });

  it("fails a password-like argument CodeQL itself would exempt", () => {
    expect(
      findPasswordReplaces(
        "a.spec.ts",
        [
          "const url =",
          '  host.replace("bridge", "user:password@bridge");',
        ].join("\n"),
      ),
    ).toEqual([2]);
  });

  it("fails a password-like literal reached through a local const", () => {
    expect(
      findPasswordReplaces(
        "a.spec.ts",
        ['const PW = "password";', "const b = a.replace(PW, x);"].join("\n"),
      ),
    ).toEqual([2]);
  });

  it("fails replaceAll and a template literal argument", () => {
    expect(
      findPasswordReplaces("a.ts", "s.replaceAll(`oauth`, x);"),
    ).toHaveLength(1);
  });

  it("accepts a literal fixture and an unrelated replace", () => {
    expect(
      findPasswordReplaces(
        "a.spec.ts",
        [
          'const secret = "password";',
          'const path = base.replace(/\\/+$/, "");',
          'expect(text).not.toContain("password");',
        ].join("\n"),
      ),
    ).toEqual([]);
  });
});

const REPO_ROOT = findRepoRoot(__dirname);
const describeTree = REPO_ROOT || process.env.CI ? describe : describe.skip;

describeTree(
  "no backend file derives a password-like string with replace",
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
        for (const line of findPasswordReplaces(file, source)) {
          offenders.push(`${file}:${line}`);
        }
      }

      expect(offenders).toEqual([]);
    });
  },
);
