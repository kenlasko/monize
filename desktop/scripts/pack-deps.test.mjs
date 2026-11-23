// Self-test for finding @electron/asar's CLI: scripts/lib/pack-deps.mjs.
// Run: node --test scripts/pack-deps.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { asarCli } from "./lib/pack-deps.mjs";

test("asarCli finds the installed package's CLI through its bin field", () => {
  const cli = asarCli();

  assert.ok(fs.existsSync(cli), `${cli} does not exist`);
  assert.match(path.basename(cli), /^asar\.m?js$/);
});

test("asarCli walks up from the exported entry past a nested package.json", () => {
  const root = path.join(path.sep, "nm", "@electron", "asar");
  const files = {
    [path.join(root, "lib", "package.json")]: { type: "module" },
    [path.join(root, "package.json")]: {
      name: "@electron/asar",
      bin: { asar: "./bin/asar.mjs" },
    },
  };
  const read = (file) => {
    if (!(file in files)) throw new Error(`ENOENT ${file}`);
    return JSON.stringify(files[file]);
  };

  assert.equal(
    asarCli(() => path.join(root, "lib", "asar.js"), read),
    path.join(root, "bin", "asar.mjs"),
  );
});

test("asarCli fails naming the manifest when it lists no CLI", () => {
  const root = path.join(path.sep, "nm", "@electron", "asar");
  const read = (file) => {
    if (file !== path.join(root, "package.json")) throw new Error("ENOENT");
    return JSON.stringify({ name: "@electron/asar" });
  };

  assert.throws(
    () => asarCli(() => path.join(root, "lib", "asar.js"), read),
    /names no asar CLI/,
  );
});
