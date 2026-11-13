import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { MACHINE_X64, peMachine, readImports } from "./pe.mjs";

/**
 * The PostgreSQL executables in @embedded-postgres/windows-x64 are built with
 * Visual C++ and import its runtime DLLs, which the package does not ship and
 * a clean Windows does not have. This step puts the DLLs beside the
 * executables ("app-local" deployment), from the Visual Studio
 * redistributable directory on the build machine, and then proves the result:
 * nothing under the staged postgres/ may import a Visual C++ runtime DLL that
 * is not there. Windows only; on any other platform there is nothing to do.
 *
 * The Universal CRT (ucrtbase.dll, the api-ms-win-crt-* names) is part of
 * Windows 10 and 11 and is not shipped.
 */

/** A Visual C++ runtime DLL, as opposed to a Windows component. */
export const VC_RUNTIME_DLL =
  /^(vcruntime|msvcp|concrt|vcomp|vccorlib)\d.*\.dll$/;

const VSWHERE = ["Microsoft Visual Studio", "Installer", "vswhere.exe"];

function listDirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function versionKey(name) {
  return name.split(".").map((part) => Number.parseInt(part, 10));
}

function newestFirst(a, b) {
  const [x, y] = [versionKey(a), versionKey(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const diff = (y[i] ?? 0) - (x[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** `<redist version dir>\x64\Microsoft.VC14x.CRT`, for every such directory. */
function crtDirsUnder(versionDir) {
  const x64 = path.win32.join(versionDir, "x64");
  return listDirs(x64)
    .filter((name) => /^Microsoft\.VC\d+\.CRT$/i.test(name))
    .map((name) => path.win32.join(x64, name));
}

/** Every `VC\Redist\MSVC\<version>` under a Visual Studio installation, newest first. */
function redistVersionDirs(installDir) {
  const root = path.win32.join(installDir, "VC", "Redist", "MSVC");
  return listDirs(root)
    .filter((name) => /^\d+(\.\d+)+$/.test(name))
    .sort(newestFirst)
    .map((name) => path.win32.join(root, name));
}

function vswhereInstallDirs(env, run) {
  const programFiles = env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const vswhere = path.win32.join(programFiles, ...VSWHERE);
  if (!fs.existsSync(vswhere)) {
    return [];
  }
  const result = run(
    vswhere,
    ["-products", "*", "-property", "installationPath", "-utf8"],
    { encoding: "utf8" },
  );
  if (result.error || result.status !== 0) {
    return [];
  }
  return String(result.stdout)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/**
 * Where the runtime DLLs may be, most trustworthy first. Each candidate is
 * `{ dir, source, fallback }`; `fallback` marks System32, which holds
 * whatever redistributable some installer last put on the machine.
 */
export function redistCandidates({
  explicitDir,
  env = process.env,
  run = spawnSync,
} = {}) {
  if (explicitDir) {
    return [{ dir: explicitDir, source: "--vc-redist", fallback: false }];
  }
  const candidates = [];
  const add = (versionDir, source) => {
    for (const dir of crtDirsUnder(versionDir)) {
      candidates.push({ dir, source, fallback: false });
    }
  };
  // Set by a Visual Studio developer prompt.
  if (env.VCToolsRedistDir) {
    add(env.VCToolsRedistDir.replace(/[\\/]+$/, ""), "VCToolsRedistDir");
  }
  for (const installDir of vswhereInstallDirs(env, run)) {
    for (const versionDir of redistVersionDirs(installDir)) {
      add(versionDir, `vswhere (${installDir})`);
    }
  }
  const systemRoot = env.SystemRoot ?? env.windir ?? "C:\\Windows";
  candidates.push({
    dir: path.win32.join(systemRoot, "System32"),
    source: "System32",
    fallback: true,
  });
  return candidates;
}

function hasAll(dir, files) {
  return files.every((file) => fs.existsSync(path.join(dir, file)));
}

/** Every .exe and .dll under `root`, recursively. */
function images(root) {
  const found = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      found.push(...images(full));
    } else if (/\.(exe|dll)$/i.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

/**
 * The Visual C++ runtime DLLs imported under `postgresDir` that are not in
 * its bin/: `[{ dll, importedBy }]`, empty when the tree is self-sufficient.
 */
export function missingVcRuntime(postgresDir) {
  const binDir = path.join(postgresDir, "bin");
  const present = new Set(
    fs.readdirSync(binDir).map((name) => name.toLowerCase()),
  );
  const missing = new Map();
  for (const file of images(postgresDir)) {
    for (const dll of readImports(file)) {
      if (VC_RUNTIME_DLL.test(dll) && !present.has(dll) && !missing.has(dll)) {
        missing.set(dll, path.relative(postgresDir, file));
      }
    }
  }
  return [...missing].map(([dll, importedBy]) => ({ dll, importedBy }));
}

/**
 * Copies `files` from the first candidate directory that holds all of them
 * into `<postgresDir>/bin`, checks each is a 64-bit image, then checks the
 * whole tree with `missingVcRuntime`. Returns the candidate used, or null on
 * a platform that needs no runtime. Throws when no candidate has the files or
 * the tree still imports a runtime DLL that is absent.
 */
export function stageVcRuntime({
  postgresDir,
  files,
  platform = process.platform,
  explicitDir,
  candidates,
  warn = () => {},
}) {
  if (platform !== "win32") {
    return null;
  }
  const all = candidates ?? redistCandidates({ explicitDir });
  const chosen = all.find((candidate) => hasAll(candidate.dir, files));
  if (chosen === undefined) {
    throw new Error(
      `the Visual C++ runtime (${files.join(", ")}) was not found in: ${all.map((c) => `${c.dir} [${c.source}]`).join("; ")}. Install Visual Studio or its Build Tools with the C++ workload, or pass --vc-redist <dir> naming a directory that holds the x64 DLLs.`,
    );
  }
  if (chosen.fallback) {
    warn(
      `no Visual Studio redistributable directory was found; copying the Visual C++ runtime from ${chosen.dir}, which holds whatever version this machine happens to have installed.`,
    );
  }
  const binDir = path.join(postgresDir, "bin");
  for (const file of files) {
    const from = path.join(chosen.dir, file);
    const machine = peMachine(fs.readFileSync(from));
    if (machine !== MACHINE_X64) {
      throw new Error(
        `${from} is not a 64-bit x64 DLL (machine 0x${(machine ?? 0).toString(16)}); the PostgreSQL executables are x64.`,
      );
    }
    // The redistributable's files can be read-only; the staged copy must not
    // be, or the next staging run could not replace it.
    const to = path.join(binDir, file);
    fs.rmSync(to, { force: true });
    fs.copyFileSync(from, to);
    fs.chmodSync(to, 0o644);
  }
  const missing = missingVcRuntime(postgresDir);
  if (missing.length > 0) {
    throw new Error(
      `the staged PostgreSQL imports Visual C++ runtime DLLs that are not beside it: ${missing.map((m) => `${m.dll} (imported by ${m.importedBy})`).join(", ")}. Add them to the vc-runtime entry in staging-manifest.json.`,
    );
  }
  return chosen;
}
