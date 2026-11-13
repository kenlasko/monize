// Assembles the already-built backend, frontend and PostgreSQL binaries into
// desktop/staging/ for packaging. It builds nothing. See desktop/README.md.
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { formatSummary, stage } from "./lib/stage.mjs";

const USAGE = `Usage: node scripts/stage.mjs [options]

  --repo-root <dir>      repository root (default: two levels above this script)
  --out <dir>            output directory (default: <desktop>/staging)
  --skip-postgres        do not stage the embedded PostgreSQL binaries
  --skip-backend-deps    reuse the staged backend/node_modules instead of npm ci
  --require-webp         fail when cwebp is missing instead of copying PNGs
  --vc-redist <dir>      Windows: the directory holding the x64 Visual C++
                         runtime DLLs (default: found through vswhere)
`;

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      i += 1;
      if (argv[i] === undefined) {
        throw new Error(`${arg} needs a value`);
      }
      return path.resolve(argv[i]);
    };
    if (arg === "--repo-root") opts.repoRoot = value();
    else if (arg === "--out") opts.outDir = value();
    else if (arg === "--skip-postgres") opts.skipPostgres = true;
    else if (arg === "--skip-backend-deps") opts.skipBackendDeps = true;
    else if (arg === "--require-webp") opts.requireWebp = true;
    else if (arg === "--vc-redist") opts.vcRedistDir = value();
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else throw new Error(`unknown option ${arg}`);
  }
  return opts;
}

const out = (text) => process.stdout.write(`${text}\n`);
const err = (text) => process.stderr.write(`${text}\n`);

try {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    out(USAGE);
  } else {
    const desktopRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
    );
    const started = Date.now();
    const result = stage({
      repoRoot: opts.repoRoot ?? path.resolve(desktopRoot, ".."),
      desktopRoot,
      outDir: opts.outDir ?? path.join(desktopRoot, "staging"),
      skipPostgres: opts.skipPostgres,
      skipBackendDeps: opts.skipBackendDeps,
      requireWebp: opts.requireWebp,
      vcRedistDir: opts.vcRedistDir,
      log: out,
      warn: (message) => err(`warning: ${message}`),
    });
    out(formatSummary(result));
    out(`staged in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  }
} catch (error) {
  err(`stage: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
