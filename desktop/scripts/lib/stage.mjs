import fs from "node:fs";
import path from "node:path";
import { formatSize, copySource, sizeOf } from "./copy.mjs";
import { installBackendDeps } from "./backend-deps.mjs";
import { stageHelpImages } from "./help-images.mjs";
import { loadManifest } from "./manifest.mjs";
import { stagePostgres } from "./postgres.mjs";

/** Build output the script consumes and never produces. */
export const REQUIRED_BUILD_OUTPUT = [
  { path: "backend/dist/main.js", build: "cd backend && npm run build" },
  { path: "backend/dist/db-init.js", build: "cd backend && npm run build" },
  { path: "backend/dist/db-migrate.js", build: "cd backend && npm run build" },
  {
    path: "frontend/.next/standalone/server.js",
    build: "cd frontend && npm run build",
  },
  { path: "frontend/.next/static", build: "cd frontend && npm run build" },
];

/** What is missing from the build output, each with the command that makes it. */
export function missingBuildOutput(repoRoot) {
  return REQUIRED_BUILD_OUTPUT.filter(
    (item) => !fs.existsSync(path.join(repoRoot, item.path)),
  );
}

/** Refuses an --out that is, or contains, the repository. */
export function assertSafeOut(outDir, repoRoot) {
  const rel = path.relative(path.resolve(outDir), path.resolve(repoRoot));
  if (rel === "" || !rel.startsWith("..")) {
    throw new Error(
      `refusing to clear ${outDir}: it is or contains the repository (${repoRoot})`,
    );
  }
}

function isSkipped(entry, options) {
  const kind = entry.kind ?? "copy";
  return (
    (kind === "postgres" && options.skipPostgres) ||
    (kind === "backend-deps" && options.skipBackendDeps)
  );
}

/** Every non-skipped manifest destination that does not exist under `outDir`. */
export function missingDestinations(manifest, outDir, options = {}) {
  return manifest.entries
    .filter((entry) => !isSkipped(entry, options))
    .filter((entry) => !fs.existsSync(path.join(outDir, entry.to)))
    .map((entry) => entry.to);
}

/**
 * Assembles `outDir` from the manifest. Throws on the first problem; `log`
 * receives progress lines and `warn` receives warnings.
 */
export function stage({
  repoRoot,
  desktopRoot,
  outDir,
  manifestFile = path.join(desktopRoot, "staging-manifest.json"),
  skipPostgres = false,
  skipBackendDeps = false,
  requireWebp = false,
  log = () => {},
  warn = () => {},
  hooks = {},
}) {
  const options = { skipPostgres, skipBackendDeps };
  const manifest = loadManifest(manifestFile);

  const missing = missingBuildOutput(repoRoot);
  if (missing.length > 0) {
    const lines = missing.map((m) => `  ${m.path}  (run: ${m.build})`);
    throw new Error(
      `build output is missing; this script does not build:\n${lines.join("\n")}`,
    );
  }
  assertSafeOut(outDir, repoRoot);

  // --skip-backend-deps keeps the previously staged node_modules across the clear.
  const stagedDeps = path.join(outDir, "backend", "node_modules");
  const keep = `${path.resolve(outDir)}.node_modules-keep`;
  fs.rmSync(keep, { recursive: true, force: true });
  if (skipBackendDeps) {
    if (!fs.existsSync(stagedDeps)) {
      throw new Error(
        `--skip-backend-deps needs an existing ${stagedDeps}; run once without it`,
      );
    }
    fs.renameSync(stagedDeps, keep);
  }
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  if (skipBackendDeps) {
    fs.mkdirSync(path.dirname(stagedDeps), { recursive: true });
    fs.renameSync(keep, stagedDeps);
  }

  const sizes = [];
  for (const entry of manifest.entries) {
    const kind = entry.kind ?? "copy";
    const dest = path.join(outDir, entry.to);
    if (isSkipped(entry, options)) {
      log(`skip   ${entry.to}`);
      continue;
    }
    log(`stage  ${entry.to}`);
    if (kind === "copy" || kind === "desktop") {
      copySource({
        src: path.join(repoRoot, entry.from),
        dest,
        exclude: entry.exclude,
        dereference: entry.dereference,
      });
    } else if (kind === "backend-deps") {
      (hooks.installBackendDeps ?? installBackendDeps)({
        backendDir: path.join(repoRoot, "backend"),
        dest,
      });
    } else if (kind === "help-images") {
      (hooks.stageHelpImages ?? stageHelpImages)({
        src: path.join(repoRoot, entry.from),
        out: dest,
        script: path.join(
          repoRoot,
          "backend",
          "scripts",
          "convert-help-images.sh",
        ),
        requireWebp,
        warn,
      });
    } else {
      stagePostgres({ desktopRoot, dest });
    }
  }

  const absent = missingDestinations(manifest, outDir, options);
  if (absent.length > 0) {
    throw new Error(
      `staging is incomplete; missing under ${outDir}: ${absent.join(", ")}`,
    );
  }
  for (const entry of manifest.entries) {
    if (!isSkipped(entry, options)) {
      sizes.push({ to: entry.to, bytes: sizeOf(path.join(outDir, entry.to)) });
    }
  }
  return { sizes, total: sizeOf(outDir) };
}

export function formatSummary({ sizes, total }) {
  const width = Math.max(...sizes.map((s) => s.to.length));
  const rows = sizes.map(
    (s) => `  ${s.to.padEnd(width)}  ${formatSize(s.bytes)}`,
  );
  return [...rows, `  ${"total".padEnd(width)}  ${formatSize(total)}`].join(
    "\n",
  );
}
