// Self-test for scripts/lib/prune.mjs and prune-check.mjs.
// Run: node --test scripts/prune.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertEntryPointsIntact } from "./lib/prune-check.mjs";
import { countFiles, isPrunable, pruneTree } from "./lib/prune.mjs";
import { formatSummary, stage } from "./lib/stage.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "monize-prune-test-"));
}
function write(root, rel, content = rel) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
function pkg(root, name, manifest, files = []) {
  write(root, `${name}/package.json`, JSON.stringify({ name, ...manifest }));
  for (const f of files) write(root, `${name}/${f}`);
}
/** Prunes `root` and runs the check the way the staging script does. */
function pruneAndCheck(root) {
  const { removed } = pruneTree(root);
  return assertEntryPointsIntact(root, removed);
}

test("isPrunable removes what Node never loads and keeps licences", () => {
  for (const name of [
    "foo.d.ts",
    "foo.d.mts",
    "foo.d.cts",
    "foo.js.map",
    "foo.mjs.map",
    "foo.ts",
    "foo.mts",
    "foo.cts",
    "README.md",
    "CHANGELOG.markdown",
    "History.MD",
    "FOO.D.TS",
  ]) {
    assert.equal(isPrunable(name), true, `${name} is pruned`);
  }
  for (const name of [
    "LICENSE",
    "LICENSE.md",
    "license.txt",
    "LICENCE.markdown",
    "License-MIT.md",
    "NOTICE",
    "NOTICE.md",
    "COPYING",
    "AUTHORS.md",
    "package.json",
    "foo.js",
    "foo.mjs",
    "foo.cjs",
    "foo.json",
    "foo.node",
    "foo.wasm",
    "foo.tsx",
    "Makefile",
    "map",
  ]) {
    assert.equal(isPrunable(name), false, `${name} is kept`);
  }
});

test("pruneTree removes empty directories and keeps licences and runtime code", () => {
  const root = tmp();
  write(root, "a/index.js");
  write(root, "a/index.d.ts");
  write(root, "a/index.js.map");
  write(root, "a/README.md");
  write(root, "a/LICENSE.md");
  write(root, "a/types/only/x.d.ts");
  write(root, "a/test/runtime.js");
  write(root, "b/empty-after/x.md");
  fs.mkdirSync(path.join(root, "b/was-empty"));
  const result = pruneTree(root);
  assert.equal(result.before, 8);
  assert.equal(result.after, 3);
  assert.equal(result.removed.length, 5);
  assert.equal(countFiles(root), 3);
  assert.ok(fs.existsSync(path.join(root, "a/LICENSE.md")));
  assert.ok(fs.existsSync(path.join(root, "a/test/runtime.js")));
  assert.ok(!fs.existsSync(path.join(root, "a/types")));
  assert.ok(!fs.existsSync(path.join(root, "b/empty-after")));
  assert.ok(
    fs.existsSync(path.join(root, "b/was-empty")),
    "untouched dirs stay",
  );
});

test("the entry-point check passes when types conditions point at declarations", () => {
  const root = tmp();
  pkg(
    root,
    "ok",
    {
      main: "./dist/index.js",
      module: "./dist/index.mjs",
      types: "./dist/index.d.ts",
      typings: "./dist/index.d.ts",
      bin: { ok: "bin/cli.js" },
      exports: {
        ".": {
          types: "./dist/index.d.ts",
          import: { types: "./dist/index.d.mts", default: "./dist/index.mjs" },
          require: "./dist/index.js",
        },
        "./features/*": "./dist/features/*.js",
        "./package.json": "./package.json",
      },
    },
    [
      "dist/index.js",
      "dist/index.mjs",
      "dist/index.d.ts",
      "dist/index.d.mts",
      "dist/features/a.js",
      "bin/cli.js",
    ],
  );
  const checked = pruneAndCheck(root);
  assert.equal(checked.packages, 1);
  assert.ok(checked.targets >= 7);
});

test("the entry-point check names the package and target it broke", () => {
  const cases = [
    ["main: a .ts file", { main: "src/index.ts" }, ["src/index.ts", "x.js"]],
    [
      "exports default: a .ts file",
      { exports: { ".": { default: "./index.ts" } } },
      ["index.ts", "x.js"],
    ],
    [
      "bin: an object of .ts files",
      { bin: { x: "cli.ts" } },
      ["cli.ts", "x.js"],
    ],
    ["bin: a string of a .ts file", { bin: "cli.mts" }, ["cli.mts", "x.js"]],
    [
      "exports import: a source map",
      { exports: { ".": { import: "./index.mjs.map" } } },
      ["index.mjs.map", "x.js"],
    ],
    [
      "main that never existed but has a pruned extension",
      { main: "lib/gone.d.ts" },
      ["x.js"],
    ],
    [
      "subpath pattern whose directory held only declarations",
      { exports: { "./lib/*": "./lib/*.js" } },
      ["lib/a.d.ts", "x.js"],
    ],
    [
      "subpath pattern whose directory is missing",
      { exports: { "./lib/*": { default: "./lib/*" } } },
      ["x.js"],
    ],
  ];
  for (const [label, manifest, files] of cases) {
    const root = tmp();
    pkg(root, "@scope/bad", manifest, files);
    assert.throws(
      () => pruneAndCheck(root),
      (error) =>
        /@scope\/bad: /.test(error.message) &&
        /broke 1 entry point/.test(error.message),
      label,
    );
  }
  const root = tmp();
  pkg(root, "bad", { main: "src/index.ts" }, ["src/index.ts", "x.js"]);
  assert.throws(() => pruneAndCheck(root), /bad: src\/index\.ts/);
});

test("the entry-point check fails when the prune removed a package's only code", () => {
  const root = tmp();
  pkg(root, "lost-code", {}, ["index.ts", "LICENSE.md"]);
  pkg(root, "fine", { main: "i.js" }, ["i.js", "i.d.ts", "LICENSE.md"]);
  assert.throws(
    () => pruneAndCheck(root),
    (error) =>
      /lost-code: the prune removed every file but/.test(error.message) &&
      !/fine/.test(error.message),
  );
});

test("a types-only package and conditions Node never takes are not entry points", () => {
  const root = tmp();
  pkg(
    root,
    "@types/dep",
    {
      types: "index.d.ts",
      exports: { ".": { import: "./index.d.mts", require: "./index.d.ts" } },
    },
    ["index.d.ts", "index.d.mts", "README.md", "LICENSE"],
  );
  pkg(root, "bare-types", { types: "index.d.ts" }, ["index.d.ts"]);
  pkg(
    root,
    "custom",
    {
      exports: {
        ".": { "@custom/source": "./src/index.ts", default: "./index.js" },
        "./sub/*": {
          "@custom/source": "./src/sub/*",
          browser: "./sub/*.ts",
          default: "./sub/*.js",
        },
      },
    },
    ["index.js", "src/index.ts", "sub/a.js", "sub/a.ts"],
  );
  const checked = pruneAndCheck(root);
  assert.equal(checked.packages, 1);
  assert.equal(checked.typesOnly, 2);
});

test("a nested module-type package.json does not count as an emptied package", () => {
  const root = tmp();
  pkg(root, "dual", { main: "cjs/index.js" }, [
    "cjs/index.js",
    "esm/index.d.ts",
  ]);
  write(root, "dual/esm/package.json", '{"type":"module"}');
  assert.doesNotThrow(() => pruneAndCheck(root));
});

test("stage reports the prune and fails closed on a broken entry point", () => {
  const repo = tmp();
  for (const f of ["main.js", "db-init.js", "db-migrate.js"]) {
    write(repo, `backend/dist/${f}`);
  }
  for (const f of ["package.json", "package-lock.json"]) {
    write(repo, `backend/${f}`, "{}");
  }
  write(repo, "backend/scripts/convert-help-images.sh", "#!/bin/sh\n");
  write(repo, "database/schema.sql");
  write(repo, "database/migrations/1.sql");
  write(repo, "docs/release-notes/v1.md");
  write(repo, "website/docs/a.md");
  write(repo, "website/docs/nav.json", "{}");
  write(repo, "website/docs/search-index.json", "{}");
  write(repo, "website/docs/images/x.png");
  write(repo, "frontend/.next/standalone/server.js");
  write(repo, "frontend/.next/static/c.js");
  write(repo, "frontend/public/favicon.ico");
  write(repo, "frontend/server-log-format.cjs");
  write(repo, "desktop/resources/parent-watch.cjs");
  write(repo, "desktop/build/icon.ico");
  const run = (installBackendDeps) =>
    stage({
      repoRoot: repo,
      desktopRoot: path.join(here, ".."),
      outDir: path.join(tmp(), "staging"),
      skipPostgres: true,
      hooks: {
        installBackendDeps,
        stageHelpImages: ({ out }) => write(out, "images/x.webp"),
      },
    });
  const result = run(({ dest }) => {
    pkg(dest, "p", { main: "i.js" }, ["i.js", "i.d.ts", "i.js.map", "R.md"]);
  });
  assert.deepEqual(
    [result.prune.before, result.prune.after, result.prune.packages],
    [5, 2, 1],
  );
  assert.ok(result.files > 0);
  assert.match(formatSummary(result), /5 before prune, 2 after/);
  assert.match(formatSummary(result), /staged files: \d+/);
  assert.throws(
    () => run(({ dest }) => pkg(dest, "q", { main: "i.ts" }, ["i.ts"])),
    /q: i\.ts/,
  );
});
