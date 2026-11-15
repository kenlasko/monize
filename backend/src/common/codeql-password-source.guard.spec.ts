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
 *
 * A name works the same way: CodeQL reads every access to a variable whose
 * name its heuristic classes as a password as a password, whatever it holds.
 * `auth.service.spec.ts` kept the cookie jar of a browser that signed in
 * under a since-replaced password as `oldPassword`; the jar went through
 * `login` to the HMAC in `verifyLoginDeviceCookie` and to `hashToken`, and
 * code scanning reported both (#2216). So a variable whose value is made by
 * something that hashes -- `createHash`, `createHmac`, bcrypt's `hash`, a
 * `backend/src` function that calls one of them, or a function in the same
 * file that does -- is named for the digest it is, not for a password.
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

/** What makes a digest: Node's fast hashes, and bcrypt's (`bcrypt.hash`). */
const HASH_PRIMITIVES: ReadonlySet<string> = new Set([
  "createHash",
  "createHmac",
  "hash",
  "hashSync",
]);

interface FunctionLike {
  name: string;
  node: ts.Node;
}

/** Named function declarations, methods and `const` function values. */
function functionLikes(sf: ts.SourceFile): FunctionLike[] {
  const found: FunctionLike[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      node.body
    ) {
      found.push({ name: node.name.text, node });
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) ||
        ts.isFunctionExpression(node.initializer))
    ) {
      found.push({ name: node.name.text, node });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function callsAny(node: ts.Node, names: ReadonlySet<string>): boolean {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(child)) {
      const name = calleeName(child);
      if (name !== null && names.has(name)) {
        found = true;
        return;
      }
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

/**
 * The names of the functions in `sf` that call one of `seed`, directly or
 * through another function of the same file. Followed within one file only:
 * across files a name is all there is to go on, and names like `create` or
 * `sign` would make most of the backend a hashing function.
 */
function hashingFunctions(
  sf: ts.SourceFile,
  seed: ReadonlySet<string>,
): Set<string> {
  const candidates = functionLikes(sf);
  const known = new Set(seed);
  const found = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const fn of candidates) {
      if (!found.has(fn.name) && callsAny(fn.node, known)) {
        found.add(fn.name);
        known.add(fn.name);
        grew = true;
      }
    }
  }
  return found;
}

/** Every `backend/src` function that hashes its input, by name. */
function hashingHelpers(
  files: ReadonlyArray<{ fileName: string; source: string }>,
): Set<string> {
  const helpers = new Set<string>();
  for (const { fileName, source } of files) {
    const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest);
    for (const name of hashingFunctions(sf, HASH_PRIMITIVES)) {
      helpers.add(name);
    }
  }
  return helpers;
}

/**
 * True when `expr` evaluates to what one of `names` returned, or to a method
 * chained on it (`createHash(...).update(x).digest()`). A value that merely
 * consults one, like a boolean from a check, is not a digest.
 */
function madeBy(expr: ts.Expression, names: ReadonlySet<string>): boolean {
  let value = expr;
  while (
    ts.isAwaitExpression(value) ||
    ts.isParenthesizedExpression(value) ||
    ts.isAsExpression(value) ||
    ts.isNonNullExpression(value) ||
    ts.isSatisfiesExpression(value)
  ) {
    value = value.expression;
  }
  if (!ts.isCallExpression(value)) return false;
  const name = calleeName(value);
  if (name !== null && names.has(name)) return true;
  return (
    ts.isPropertyAccessExpression(value.expression) &&
    madeBy(value.expression.expression, names)
  );
}

function findDigestsNamedAsPasswords(
  fileName: string,
  source: string,
  helpers: ReadonlySet<string>,
): number[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest);
  const seed = new Set([...HASH_PRIMITIVES, ...helpers]);
  const hashing = new Set([...seed, ...hashingFunctions(sf, seed)]);
  const lines: number[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      isPasswordText(node.name.text) &&
      node.initializer &&
      madeBy(node.initializer, hashing)
    ) {
      lines.push(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return lines;
}

describe("a digest is not named as a password", () => {
  const helpers = hashingHelpers([
    {
      fileName: "msisam-decrypt.ts",
      source: [
        "function verifyPassword(page: Buffer, pw: string) {",
        '  return createHash("md5").update(pw).digest().equals(page);',
        "}",
      ].join("\n"),
    },
    {
      fileName: "login-device.ts",
      source: [
        "function hmac(k: string, d: string) {",
        '  return crypto.createHmac("sha256", k).update(d).digest("hex");',
        "}",
        "export function issueLoginDeviceCookie(k: string, h: string) {",
        "  return `${iat}.${hmac(k, h)}`;",
        "}",
      ].join("\n"),
    },
  ]);

  it("finds a backend function that hashes through a same-file helper", () => {
    expect([...helpers].sort()).toEqual([
      "hmac",
      "issueLoginDeviceCookie",
      "verifyPassword",
    ]);
  });

  it("fails the original mistake: a cookie jar built by a hashing wrapper", () => {
    expect(
      findDigestsNamedAsPasswords(
        "a.spec.ts",
        [
          "const jar = (id: string, h: string) => ({",
          "  [name]: issueLoginDeviceCookie(key, h),",
          "});",
          'const oldPassword = jar(mockUser.id, await bcrypt.hash("Old", 4));',
        ].join("\n"),
        helpers,
      ),
    ).toEqual([4]);
  });

  it("fails a password-like name for any hash's output", () => {
    expect(
      findDigestsNamedAsPasswords(
        "a.spec.ts",
        [
          'const password = await bcrypt.hash("x", 4);',
          "const apiKey = hashToken(token);",
          'const passcode = createHash("sha1").update(x).digest("hex");',
        ].join("\n"),
        new Set(["hashToken"]),
      ),
    ).toEqual([1, 2, 3]);
  });

  it("accepts a digest named for what it is, and a password that is one", () => {
    expect(
      findDigestsNamedAsPasswords(
        "a.spec.ts",
        [
          'const supersededHash = jar(mockUser.id, await bcrypt.hash("Old", 4));',
          'const password = "demo-opaque";',
          "const isPasswordValid = await bcrypt.compare(pw, user.passwordHash);",
          "const password = generateReadablePassword();",
          'const passwordProtected = checked && !verifyPassword(page, "");',
        ].join("\n"),
        helpers,
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

describeTree("no backend file names a digest as a password", () => {
  it("finds none, and does find the backend's hashing functions", () => {
    const root = requireRepoRoot(REPO_ROOT);
    const files = gitListFiles(root)
      .filter((path) => /^backend\/(src|test)\/.*\.ts$/.test(path))
      .map((path) => ({
        fileName: path,
        source: readFileSync(join(root, path), "utf8"),
      }));
    const helpers = hashingHelpers(
      files.filter(
        ({ fileName }) =>
          fileName.startsWith("backend/src/") && !fileName.endsWith(".spec.ts"),
      ),
    );
    for (const name of [
      "hashToken",
      "issueLoginDeviceCookie",
      "verifyLoginDeviceCookie",
    ]) {
      expect(helpers.has(name)).toBe(true);
    }

    const offenders: string[] = [];
    for (const { fileName, source } of files) {
      for (const line of findDigestsNamedAsPasswords(
        fileName,
        source,
        helpers,
      )) {
        offenders.push(`${fileName}:${line}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
