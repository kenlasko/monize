// Self-test for scripts/lib/*.mjs against a small fixture tree.
// Run: node --test scripts/stage.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { copySource, globToRegExp, sizeOf } from "./lib/copy.mjs";
import { stageHelpImages } from "./lib/help-images.mjs";
import { loadManifest } from "./lib/manifest.mjs";
import { postgresPackageName, stagePostgres } from "./lib/postgres.mjs";
import {
  assertSafeOut,
  missingBuildOutput,
  missingDestinations,
  stage,
} from "./lib/stage.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const realManifest = path.join(here, "..", "staging-manifest.json");

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "monize-stage-test-"));
}
function write(root, rel, content = rel) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** A repository with just enough build output and tracked sources. */
function fixtureRepo() {
  const root = tmp();
  for (const f of ["main.js", "db-init.js", "db-migrate.js", "main.js.map"]) {
    write(root, `backend/dist/${f}`);
  }
  write(root, "backend/dist/i18n/locales/en/a.json", "{}");
  write(root, "backend/package.json", "{}");
  write(root, "backend/package-lock.json", "{}");
  write(root, "backend/scripts/convert-help-images.sh", "#!/bin/sh\n");
  write(root, "database/schema.sql");
  write(root, "database/migrations/1.sql");
  write(root, "docs/release-notes/v1.md");
  write(root, "website/docs/a.md");
  write(root, "website/docs/b.md");
  write(root, "website/docs/nav.json", "{}");
  write(root, "website/docs/search-index.json", "{}");
  write(root, "website/docs/images/x.png");
  write(root, "website/docs/images/x.light.png");
  write(root, "frontend/.next/standalone/server.js");
  write(root, "frontend/.next/standalone/node_modules/n/index.js");
  write(root, "frontend/.next/static/chunks/c.js");
  write(root, "frontend/public/favicon.ico");
  write(root, "frontend/server-log-format.cjs");
  write(root, "desktop/resources/parent-watch.cjs");
  write(root, "desktop/build/icon.ico");
  return root;
}

const fakeDeps = ({ dest }) => write(dest, "pkg/index.js");
const fakeImages = ({ out }) => write(out, "x.webp");
const fakeHooks = { installBackendDeps: fakeDeps, stageHelpImages: fakeImages };

test("globToRegExp matches one segment and escapes dots", () => {
  assert.ok(globToRegExp("*.md").test("a.md"));
  assert.ok(!globToRegExp("*.md").test("a.mdx"));
  assert.ok(!globToRegExp("*.md").test("amd"));
  assert.ok(globToRegExp("*.js.map").test("main.js.map"));
});

test("copySource copies a directory, honours exclude, and a glob", () => {
  const repo = fixtureRepo();
  const out = tmp();
  const n = copySource({
    src: path.join(repo, "backend/dist"),
    dest: path.join(out, "dist"),
    exclude: ["*.js.map"],
  });
  assert.equal(n, 4);
  assert.ok(fs.existsSync(path.join(out, "dist/main.js")));
  assert.ok(!fs.existsSync(path.join(out, "dist/main.js.map")));
  copySource({
    src: path.join(repo, "website/docs/*.md"),
    dest: path.join(out, "help"),
  });
  assert.deepEqual(fs.readdirSync(path.join(out, "help")).sort(), [
    "a.md",
    "b.md",
  ]);
  assert.throws(
    () => copySource({ src: path.join(repo, "nope/*.md"), dest: out }),
    /ENOENT|nothing matches/,
  );
  assert.throws(
    () => copySource({ src: path.join(repo, "nope"), dest: out }),
    /missing source/,
  );
});

test("copySource dereferences symlinks when asked", (t) => {
  const root = tmp();
  write(root, "real/f.txt", "hi");
  fs.mkdirSync(path.join(root, "src"));
  try {
    fs.symlinkSync(path.join(root, "real"), path.join(root, "src/link"), "dir");
  } catch {
    t.skip("symlinks are not available here");
    return;
  }
  copySource({
    src: path.join(root, "src"),
    dest: path.join(root, "out"),
    dereference: true,
  });
  const copied = path.join(root, "out/link");
  assert.ok(!fs.lstatSync(copied).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(copied, "f.txt"), "utf8"), "hi");
});

test("missingBuildOutput names what is missing and how to make it", () => {
  const repo = fixtureRepo();
  assert.deepEqual(missingBuildOutput(repo), []);
  fs.rmSync(path.join(repo, "frontend/.next/static"), { recursive: true });
  fs.rmSync(path.join(repo, "backend/dist/db-init.js"));
  const missing = missingBuildOutput(repo);
  assert.deepEqual(
    missing.map((m) => m.path),
    ["backend/dist/db-init.js", "frontend/.next/static"],
  );
  assert.match(missing[0].build, /backend && npm run build/);
});

test("assertSafeOut refuses the repository and its parents", () => {
  assert.throws(() => assertSafeOut("/a/b", "/a/b"), /refusing/);
  assert.throws(() => assertSafeOut("/a", "/a/b"), /refusing/);
  assert.doesNotThrow(() => assertSafeOut("/a/b/desktop/staging", "/a/b"));
  assert.doesNotThrow(() => assertSafeOut("/tmp/x", "/a/b"));
});

test("stage assembles the manifest layout from a fixture", () => {
  const repo = fixtureRepo();
  const out = path.join(tmp(), "staging");
  const logs = [];
  const result = stage({
    repoRoot: repo,
    desktopRoot: path.join(here, ".."),
    outDir: out,
    skipPostgres: true,
    hooks: fakeHooks,
    log: (l) => logs.push(l),
  });
  for (const rel of [
    "backend/dist/main.js",
    "backend/dist/i18n/locales/en/a.json",
    "backend/node_modules/pkg/index.js",
    "backend/package.json",
    "backend/package-lock.json",
    "backend/schema.sql",
    "backend/migrations/1.sql",
    "backend/release-notes/v1.md",
    "backend/help/a.md",
    "backend/help/nav.json",
    "backend/help/search-index.json",
    "backend/help/images/x.webp",
    "frontend/server.js",
    "frontend/node_modules/n/index.js",
    ".next/static/chunks/c.js",
    "frontend/public/favicon.ico",
    "frontend/server-log-format.cjs",
    "shell/parent-watch.cjs",
    "shell/icon.ico",
  ]) {
    const file = rel.startsWith(".next")
      ? path.join(out, "frontend", rel)
      : path.join(out, rel);
    assert.ok(fs.existsSync(file), `${rel} staged`);
  }
  assert.ok(!fs.existsSync(path.join(out, "backend/dist/main.js.map")));
  assert.ok(!fs.existsSync(path.join(out, "postgres")));
  assert.ok(result.total > 0);
  assert.ok(logs.includes("skip   postgres"));
});

test("stage clears old content and --skip-backend-deps keeps node_modules", () => {
  const repo = fixtureRepo();
  const out = path.join(tmp(), "staging");
  const base = {
    repoRoot: repo,
    desktopRoot: path.join(here, ".."),
    outDir: out,
    skipPostgres: true,
    hooks: fakeHooks,
  };
  assert.throws(() => stage({ ...base, skipBackendDeps: true }), /existing/);
  stage(base);
  write(out, "stale.txt");
  write(out, "backend/node_modules/pkg/marker.txt");
  stage({
    ...base,
    skipBackendDeps: true,
    hooks: {
      installBackendDeps: () => assert.fail("npm ci must not run"),
      stageHelpImages: fakeImages,
    },
  });
  assert.ok(!fs.existsSync(path.join(out, "stale.txt")));
  assert.ok(
    fs.existsSync(path.join(out, "backend/node_modules/pkg/marker.txt")),
  );
});

test("stage fails naming missing build output and the command", () => {
  const repo = fixtureRepo();
  fs.rmSync(path.join(repo, "frontend/.next"), { recursive: true });
  assert.throws(
    () =>
      stage({
        repoRoot: repo,
        desktopRoot: path.join(here, ".."),
        outDir: path.join(tmp(), "s"),
        skipPostgres: true,
        hooks: fakeHooks,
      }),
    /frontend\/\.next\/standalone\/server\.js.*cd frontend && npm run build/s,
  );
});

test("missingDestinations reports what is absent, ignoring skipped entries", () => {
  const manifest = loadManifest(realManifest);
  const out = tmp();
  const all = missingDestinations(manifest, out);
  assert.ok(all.includes("postgres") && all.includes("backend/dist"));
  const some = missingDestinations(manifest, out, {
    skipPostgres: true,
    skipBackendDeps: true,
  });
  assert.ok(!some.includes("postgres"));
  assert.ok(!some.includes("backend/node_modules"));
});

test("the Visual C++ runtime is staged on Windows only, after PostgreSQL", () => {
  const manifest = loadManifest(realManifest);
  const out = tmp();
  const dll = "postgres/bin/vcruntime140.dll";
  assert.ok(
    missingDestinations(manifest, out, { platform: "win32" }).includes(dll),
  );
  for (const options of [
    { platform: "linux" },
    { platform: "win32", skipPostgres: true },
  ]) {
    assert.ok(!missingDestinations(manifest, out, options).includes(dll));
  }

  const kinds = manifest.entries.map((entry) => entry.kind ?? "copy");
  assert.ok(kinds.indexOf("vc-runtime") > kinds.indexOf("postgres"));

  // On Windows the step runs with the manifest's list; a missing DLL fails the run.
  const repo = fixtureRepo();
  const desktop = path.join(repo, "desktop");
  write(
    desktop,
    "staging-manifest.json",
    fs.readFileSync(realManifest, "utf8"),
  );
  for (const d of ["bin", "lib", "share"]) {
    write(
      desktop,
      `node_modules/@embedded-postgres/${process.platform === "win32" ? "windows" : "linux"}-x64/native/${d}/f`,
    );
  }
  const calls = [];
  const base = {
    repoRoot: repo,
    desktopRoot: desktop,
    outDir: path.join(tmp(), "staging"),
    platform: "win32",
  };
  assert.throws(
    () =>
      stage({
        ...base,
        hooks: {
          ...fakeHooks,
          stageVcRuntime: (args) => {
            calls.push(args);
            return { dir: "C:\\redist", source: "test" };
          },
        },
      }),
    /staging is incomplete.*postgres\/bin\/vcruntime140\.dll/,
  );
  assert.deepEqual(calls[0].files, [
    "vcruntime140.dll",
    "vcruntime140_1.dll",
    "msvcp140.dll",
  ]);
  assert.equal(calls[0].platform, "win32");
  assert.ok(calls[0].postgresDir.endsWith("postgres"));

  const logs = [];
  stage({
    ...base,
    log: (line) => logs.push(line),
    hooks: {
      ...fakeHooks,
      stageVcRuntime: ({ postgresDir, files }) => {
        for (const file of files) write(postgresDir, `bin/${file}`);
        return { dir: "C:\\redist", source: "test" };
      },
    },
  });
  assert.ok(logs.some((line) => line.includes("[test]")));

  // Elsewhere the step is skipped, not attempted.
  const skipped = [];
  stage({
    ...base,
    platform: "linux",
    log: (line) => skipped.push(line),
    hooks: { ...fakeHooks, stageVcRuntime: () => assert.fail("not on Linux") },
  });
  assert.ok(skipped.includes("skip   postgres/bin"));
});

test("help images: PNG fallback warns, --require-webp fails, cwebp runs the script", () => {
  const repo = fixtureRepo();
  const src = path.join(repo, "website/docs/images");
  const script = path.join(repo, "backend/scripts/convert-help-images.sh");
  const out = path.join(tmp(), "images");
  const warnings = [];
  const kind = stageHelpImages({
    src,
    out,
    script,
    cwebpAvailable: false,
    warn: (w) => warnings.push(w),
  });
  assert.equal(kind, "png");
  assert.deepEqual(fs.readdirSync(out).sort(), ["x.light.png", "x.png"]);
  assert.match(warnings[0], /PNG/);

  assert.throws(
    () =>
      stageHelpImages({
        src,
        out,
        script,
        cwebpAvailable: false,
        requireWebp: true,
      }),
    /--require-webp/,
  );

  const calls = [];
  const run = (cmd, args) => {
    calls.push([cmd, ...args]);
    return { status: 0 };
  };
  assert.equal(
    stageHelpImages({ src, out, script, cwebpAvailable: true, run }),
    "webp",
  );
  assert.equal(calls[0][0], "sh");
  assert.ok(calls[0][1].endsWith("convert-help-images.sh"));
  assert.throws(
    () =>
      stageHelpImages({
        src,
        out,
        script,
        cwebpAvailable: true,
        run: () => ({ status: 1 }),
      }),
    /convert-help-images\.sh failed/,
  );
});

test("postgres: package by platform, and a clear failure when absent", () => {
  assert.equal(
    postgresPackageName("win32", "x64"),
    "@embedded-postgres/windows-x64",
  );
  assert.equal(
    postgresPackageName("linux", "x64"),
    "@embedded-postgres/linux-x64",
  );
  assert.throws(() => postgresPackageName("darwin", "arm64"), /no embedded/);

  const desktop = tmp();
  assert.throws(
    () =>
      stagePostgres({
        desktopRoot: desktop,
        dest: path.join(tmp(), "pg"),
        platform: "win32",
        arch: "x64",
      }),
    /@embedded-postgres\/windows-x64 is not installed/,
  );
  for (const d of ["bin", "lib", "share"]) {
    write(desktop, `node_modules/@embedded-postgres/windows-x64/native/${d}/f`);
  }
  const dest = path.join(tmp(), "pg");
  stagePostgres({ desktopRoot: desktop, dest, platform: "win32", arch: "x64" });
  assert.ok(fs.existsSync(path.join(dest, "bin/f")));
  assert.equal(sizeOf(path.join(dest, "bin/f")) > 0, true);
});

test("the real manifest loads and rejects a malformed one", () => {
  assert.ok(loadManifest(realManifest).entries.length > 10);
  const bad = path.join(tmp(), "m.json");
  fs.writeFileSync(bad, JSON.stringify({ entries: [{ from: "a", to: "b" }] }));
  assert.throws(() => loadManifest(bad), /"mirrors"/);
});

test("a desktop entry comes from desktop/ and stays out of the layers", () => {
  const manifest = loadManifest(realManifest);
  const desktop = manifest.entries.filter((e) => e.kind === "desktop");
  assert.deepEqual(
    desktop.map((e) => e.to),
    ["shell/parent-watch.cjs", "shell/icon.ico"],
  );
  const entry = { kind: "desktop", from: "desktop/x.cjs", mirrors: "none: x" };
  for (const bad of [
    { ...entry, to: "backend/x.cjs" },
    { ...entry, to: "frontend/x.cjs" },
    { ...entry, from: "backend/x.cjs", to: "shell/x.cjs" },
  ]) {
    const file = path.join(tmp(), "m.json");
    fs.writeFileSync(file, JSON.stringify({ entries: [bad] }));
    assert.throws(() => loadManifest(file), /desktop entry/);
  }
});

test("a vc-runtime entry lists runtime DLLs and stages under postgres/", () => {
  const entry = {
    kind: "vc-runtime",
    from: "vc-redist/x64",
    to: "postgres/bin",
    files: ["vcruntime140.dll"],
    mirrors: "none: x",
  };
  for (const bad of [
    { ...entry, files: [] },
    { ...entry, files: undefined },
    { ...entry, files: ["kernel32.dll"] },
    { ...entry, files: ["VCRUNTIME140.dll"] },
    { ...entry, to: "backend/bin" },
  ]) {
    const file = path.join(tmp(), "m.json");
    fs.writeFileSync(file, JSON.stringify({ entries: [bad] }));
    assert.throws(() => loadManifest(file), /vc-runtime entry/);
  }
  const file = path.join(tmp(), "m.json");
  fs.writeFileSync(file, JSON.stringify({ entries: [entry] }));
  assert.doesNotThrow(() => loadManifest(file));
});
