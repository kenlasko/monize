import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import process from "node:process";
import { asarCli } from "./lib/pack-deps.mjs";

test("asarCli resolves the installed @electron/asar's own command, and it runs", () => {
  // 4.x moved the CLI to bin/asar.mjs behind an exports map; the hard-coded
  // bin/asar.js stopped resolving and every staging run failed.
  const cli = asarCli();
  assert.ok(fs.existsSync(cli), `${cli} does not exist`);
  const result = spawnSync(process.execPath, [cli, "--version"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\d+\.\d+\.\d+/);
});
