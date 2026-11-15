// Self-test for scripts/lib/pe.mjs and scripts/lib/vc-runtime.mjs against
// small synthetic PE images. Run: node --test scripts/vc-runtime.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MACHINE_X64, peImports, peMachine } from "./lib/pe.mjs";
import {
  missingVcRuntime,
  redistCandidates,
  stageVcRuntime,
  VC_RUNTIME_DLL,
} from "./lib/vc-runtime.mjs";

const MACHINE_X86 = 0x014c;

/** A minimal PE32+ image: headers, one section, an import table of `imports`. */
function fakePe({ machine = MACHINE_X64, imports = [] } = {}) {
  const buffer = Buffer.alloc(0x400);
  buffer.write("MZ", 0, "latin1");
  buffer.writeUInt32LE(0x40, 0x3c);
  buffer.write("PE\0\0", 0x40, "latin1");
  buffer.writeUInt16LE(machine, 0x44);
  buffer.writeUInt16LE(1, 0x46); // one section
  buffer.writeUInt16LE(240, 0x54); // size of the optional header
  const optional = 0x58;
  buffer.writeUInt16LE(0x20b, optional);
  buffer.writeUInt32LE(16, optional + 108); // data directories
  if (imports.length > 0) {
    buffer.writeUInt32LE(0x1000, optional + 112 + 8);
  }
  const section = optional + 240;
  buffer.writeUInt32LE(0x200, section + 8); // virtual size
  buffer.writeUInt32LE(0x1000, section + 12); // virtual address
  buffer.writeUInt32LE(0x200, section + 16); // raw size
  buffer.writeUInt32LE(0x200, section + 20); // raw offset
  let name = 0x200 + (imports.length + 1) * 20;
  imports.forEach((dll, index) => {
    buffer.writeUInt32LE(0x1000 + (name - 0x200), 0x200 + index * 20 + 12);
    buffer.write(`${dll}\0`, name, "latin1");
    name += dll.length + 1;
  });
  return buffer;
}

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "monize-vc-test-"));
}
function write(root, rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

/** A postgres/ tree whose executables import `needs`, and a redist dir holding `has`. */
function fixture({ needs, has, machine }) {
  const postgresDir = path.join(tmp(), "postgres");
  write(postgresDir, "bin/postgres.exe", fakePe({ imports: needs }));
  write(postgresDir, "bin/libpq.dll", fakePe({ imports: ["KERNEL32.dll"] }));
  write(postgresDir, "lib/pgcrypto.dll", fakePe({ imports: ["postgres.exe"] }));
  write(postgresDir, "share/readme.txt", "not an image");
  const redist = tmp();
  for (const dll of has) {
    write(redist, dll, fakePe({ machine, imports: ["KERNEL32.dll"] }));
  }
  return { postgresDir, redist };
}

const FILES = ["vcruntime140.dll", "msvcp140.dll"];
const candidate = (dir, fallback = false) => ({
  dir,
  source: fallback ? "System32" : "test",
  fallback,
});

test("peMachine and peImports read a PE image and refuse anything else", () => {
  const image = fakePe({ imports: ["KERNEL32.dll", "VCRUNTIME140.dll"] });
  assert.equal(peMachine(image), MACHINE_X64);
  assert.deepEqual(peImports(image), ["kernel32.dll", "vcruntime140.dll"]);
  assert.deepEqual(peImports(fakePe()), []);
  assert.equal(peMachine(fakePe({ machine: MACHINE_X86 })), MACHINE_X86);
  assert.equal(peMachine(Buffer.from("#!/bin/sh\n")), null);
  assert.throws(() => peImports(Buffer.alloc(128)), /not a PE image/);
});

test("VC_RUNTIME_DLL names the Visual C++ runtime and not Windows components", () => {
  for (const dll of [
    "vcruntime140.dll",
    "vcruntime140_1.dll",
    "msvcp140.dll",
    "msvcp140_atomic_wait.dll",
    "concrt140.dll",
    "vcomp140.dll",
  ]) {
    assert.ok(VC_RUNTIME_DLL.test(dll), dll);
  }
  for (const dll of [
    "kernel32.dll",
    "msvcrt.dll",
    "ucrtbase.dll",
    "api-ms-win-crt-runtime-l1-1-0.dll",
    "libpq.dll",
  ]) {
    assert.ok(!VC_RUNTIME_DLL.test(dll), dll);
  }
});

test("stageVcRuntime does nothing off Windows", () => {
  const { postgresDir } = fixture({ needs: FILES, has: [] });
  assert.equal(
    stageVcRuntime({ postgresDir, files: FILES, platform: "linux" }),
    null,
  );
  assert.ok(!fs.existsSync(path.join(postgresDir, "bin/vcruntime140.dll")));
});

test("stageVcRuntime copies from the first directory holding every DLL", () => {
  const { postgresDir, redist } = fixture({ needs: FILES, has: FILES });
  const partial = tmp();
  write(partial, "vcruntime140.dll", fakePe());
  fs.chmodSync(path.join(redist, "msvcp140.dll"), 0o444);
  const warnings = [];
  const used = stageVcRuntime({
    postgresDir,
    files: FILES,
    platform: "win32",
    candidates: [candidate(partial), candidate(redist)],
    warn: (message) => warnings.push(message),
  });
  assert.equal(used.dir, redist);
  assert.deepEqual(warnings, []);
  for (const dll of FILES) {
    const staged = path.join(postgresDir, "bin", dll);
    assert.ok(fs.existsSync(staged), dll);
    // Writable, so the next run can replace it.
    assert.doesNotThrow(() => fs.accessSync(staged, fs.constants.W_OK));
  }
  assert.deepEqual(missingVcRuntime(postgresDir), []);
  // A second run replaces what the first one staged.
  assert.doesNotThrow(() =>
    stageVcRuntime({
      postgresDir,
      files: FILES,
      platform: "win32",
      candidates: [candidate(redist)],
    }),
  );
});

test("stageVcRuntime warns when it has to fall back to System32", () => {
  const { postgresDir, redist } = fixture({ needs: FILES, has: FILES });
  const warnings = [];
  stageVcRuntime({
    postgresDir,
    files: FILES,
    platform: "win32",
    candidates: [candidate(tmp()), candidate(redist, true)],
    warn: (message) => warnings.push(message),
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /no Visual Studio redistributable/);
});

test("stageVcRuntime fails when no directory holds the DLLs", () => {
  const { postgresDir } = fixture({ needs: FILES, has: [] });
  const empty = tmp();
  assert.throws(
    () =>
      stageVcRuntime({
        postgresDir,
        files: FILES,
        platform: "win32",
        candidates: [candidate(empty)],
      }),
    (error) =>
      error.message.includes("was not found") &&
      error.message.includes(empty) &&
      error.message.includes("--vc-redist"),
  );
});

test("stageVcRuntime refuses a DLL built for another processor", () => {
  const { postgresDir, redist } = fixture({
    needs: FILES,
    has: FILES,
    machine: MACHINE_X86,
  });
  assert.throws(
    () =>
      stageVcRuntime({
        postgresDir,
        files: FILES,
        platform: "win32",
        candidates: [candidate(redist)],
      }),
    /not a 64-bit x64 DLL/,
  );
});

test("stageVcRuntime fails when the tree imports a runtime DLL the list lacks", () => {
  const { postgresDir, redist } = fixture({
    needs: [...FILES, "VCRUNTIME140_1.dll"],
    has: FILES,
  });
  assert.deepEqual(
    missingVcRuntime(postgresDir)
      .map((m) => m.dll)
      .sort(),
    ["msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll"],
  );
  assert.throws(
    () =>
      stageVcRuntime({
        postgresDir,
        files: FILES,
        platform: "win32",
        candidates: [candidate(redist)],
      }),
    /vcruntime140_1\.dll \(imported by bin[\\/]postgres\.exe\).*staging-manifest\.json/,
  );
});

test("redistCandidates: an explicit directory is the only candidate", () => {
  assert.deepEqual(redistCandidates({ explicitDir: "D:\\crt", env: {} }), [
    { dir: "D:\\crt", source: "--vc-redist", fallback: false },
  ]);
});

test("redistCandidates ends with System32 as the stated fallback", () => {
  const candidates = redistCandidates({
    env: { SystemRoot: "C:\\Windows" },
    run: () => ({ status: 1 }),
  });
  assert.deepEqual(candidates.at(-1), {
    dir: "C:\\Windows\\System32",
    source: "System32",
    fallback: true,
  });
});
