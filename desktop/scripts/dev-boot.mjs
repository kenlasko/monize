#!/usr/bin/env node
// Boots the staged stack without Electron: PostgreSQL, db-init, db-migrate,
// the backend and the frontend, through the same runtime module the Electron
// main process uses (src/runtime.ts). Under plain Node the children run on
// `process.execPath` as well, so this proves the supervisor, the PostgreSQL
// runner, the child environments and the staged layout on Linux or Windows
// with no window involved.
//
//   npm run build && npm run stage            (once; see the README)
//   node scripts/dev-boot.mjs --data-dir <dir> [--exit-when-ready]
//
// Secrets are stored in plain text (there is no safeStorage outside Electron),
// so a data directory must be named explicitly: this script never touches the
// installed application's data folder.

import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const desktopRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function out(line) {
  process.stdout.write(`${line}\n`);
}

function parseArgs(argv) {
  const options = { dataDir: null, exitWhenReady: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--data-dir") {
      options.dataDir = argv[(i += 1)] ?? null;
    } else if (arg.startsWith("--data-dir=")) {
      options.dataDir = arg.slice("--data-dir=".length);
    } else if (arg === "--exit-when-ready") {
      options.exitWhenReady = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!options.dataDir) {
    throw new Error(
      "Name a data directory: --data-dir <dir> (it is created if missing).",
    );
  }
  return { ...options, dataDir: path.resolve(options.dataDir) };
}

function load(module) {
  try {
    return require(path.join(desktopRoot, "dist", module));
  } catch (error) {
    if (error.code === "MODULE_NOT_FOUND") {
      throw new Error("dist/ is missing: run `npm run build` in desktop/.", {
        cause: error,
      });
    }
    throw error;
  }
}

/** Outside Electron there is no OS-backed encryption to offer. */
const noSafeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: () => {
    throw new Error("safeStorage is not available outside Electron");
  },
  decryptString: () => {
    throw new Error("safeStorage is not available outside Electron");
  },
};

function describeFailure(failure, describeCause) {
  const lines = [
    `Boot failed at step "${failure.step}": ${describeCause(failure.cause)}`,
  ];
  for (const record of failure.logTail) {
    lines.push(`  ${record.source} ${record.level} ${record.msg}`);
  }
  return lines.join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { resolveAppPaths } = load("app-paths.js");
  const { createRuntime } = load("runtime.js");
  const { describeCause } = load("supervisor/index.js");

  const baseEnv = {
    ...process.env,
    MONIZE_DATA_DIR: options.dataDir,
    MONIZE_INSECURE_SECRETS: "1",
  };
  const paths = resolveAppPaths({
    env: baseEnv,
    platform: process.platform,
    isPackaged: false,
    resourcesPath: "",
    desktopRoot,
    homeDir: os.homedir(),
  });
  const runtime = await createRuntime({
    paths,
    safeStorage: noSafeStorage,
    baseEnv,
    execPath: process.execPath,
  });
  const { supervisor } = runtime;
  supervisor.onStatus((status) => out(`status: ${status}`));
  supervisor.onFatal((fatal) => {
    out(`fatal: ${fatal.child}: ${describeCause(fatal.cause)}`);
  });

  let stopping = null;
  const stop = () => {
    stopping ??= supervisor.stop().then((report) => {
      for (const { component, error } of report.errors) {
        out(`stop: ${component}: ${error?.message ?? String(error)}`);
      }
      runtime.logger.close();
      return report.errors.length === 0;
    });
    return stopping;
  };
  process.once("SIGINT", () => void stop().then(() => process.exit(130)));
  process.once("SIGTERM", () => void stop().then(() => process.exit(143)));

  const result = await supervisor.start();
  if (result.outcome === "failed") {
    out(describeFailure(result.failure, describeCause));
    await stop();
    return 1;
  }
  if (result.outcome === "cancelled") {
    return 1;
  }
  out(`ready: ${runtime.origin}`);
  if (!options.exitWhenReady) {
    out("Press Ctrl-C to stop.");
    await new Promise(() => {});
  }

  // The page itself, through the frontend, proves more than the health route.
  const response = await globalThis.fetch(`${runtime.origin}/login`, {
    redirect: "manual",
  });
  out(`GET /login -> ${response.status}`);
  const clean = await stop();
  return response.status === 200 && clean ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`${error?.message ?? String(error)}\n`);
    process.exit(1);
  },
);
