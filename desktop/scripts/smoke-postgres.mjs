// Smoke test of the embedded PostgreSQL runner against the real binaries.
//
// Runs the compiled runner (dist/supervisor/postgres.js, so `npm run build`
// first; `npm run smoke:postgres` does both) through a first start, a clean
// stop, two starts that must fail (port taken, wrong password), a second
// start on the same cluster, a hard kill of the server with and without a
// busy backend, a pid file naming another program, a server left running by
// a "crashed" shell and an interrupted first initialization. Written for
// Windows and Linux.
//
//   node scripts/smoke-postgres.mjs [--bin-dir=<dir holding initdb, pg_ctl, postgres>]
//
// Without --bin-dir the binaries come from the platform package in
// node_modules. Every path used contains a space, like a Windows profile
// directory with a first and a last name. Exits non-zero on the first failed
// assertion, after stopping the server and removing the temporary directory.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const {
  createPostgresRunner,
  PostgresRunnerError,
} = require("../dist/supervisor/postgres.js");
const { Client } = require("pg");

const PLATFORM_PACKAGES = { win32: "windows-x64", linux: "linux-x64" };
const EXTENSIONS = ["uuid-ossp", "pgcrypto", "pg_trgm", "btree_gist"];
const SUPERUSER = "monize";
const DATABASE = "monize";
const PASSWORD = randomBytes(24).toString("base64");

const say = (line) => process.stdout.write(`${line}\n`);

function resolveBinDir() {
  const flag = process.argv.find((arg) => arg.startsWith("--bin-dir="));
  if (flag) {
    return path.resolve(flag.slice("--bin-dir=".length));
  }
  const name = PLATFORM_PACKAGES[process.platform];
  assert.ok(name, `no PostgreSQL binary package for ${process.platform}`);
  const packageDir = path.join(
    here,
    "..",
    "node_modules",
    "@embedded-postgres",
    name,
  );
  // The Linux package ships its versioned libraries without their symlinks
  // (libpq.so.5, libicuuc.so.60, ...) and recreates them in a postinstall
  // script. Run it here too, so an install with scripts disabled still works;
  // it skips the links that exist. The Windows package has none.
  const hydrate = path.join(packageDir, "scripts", "hydrate-symlinks.js");
  if (fs.existsSync(hydrate)) {
    execFileSync(process.execPath, [hydrate], { stdio: "ignore" });
  }
  return path.join(packageDir, "native", "bin");
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const binDir = resolveBinDir();
const exe = process.platform === "win32" ? ".exe" : "";
for (const binary of ["initdb", "pg_ctl", "postgres"]) {
  assert.ok(
    fs.existsSync(path.join(binDir, `${binary}${exe}`)),
    `${binary}${exe} is missing from ${binDir}`,
  );
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "monize pg smoke "));
const profile = path.join(root, "First Last");
const dataDir = path.join(profile, "pgdata");
const secondDataDir = path.join(profile, "pgdata-interrupted");
const serverLogFile = path.join(profile, "logs", "postgres.log");
const pidFile = path.join(dataDir, "postmaster.pid");
const port = await freePort();

/** A new runner, as a new launch of the shell would create one. */
function launch(dir = dataDir, password = PASSWORD) {
  const statuses = [];
  const lines = [];
  const runner = createPostgresRunner({
    binDir,
    dataDir: dir,
    port,
    superuser: SUPERUSER,
    password,
    database: DATABASE,
    serverLogFile,
    log: (line) => {
      lines.push(line);
      say(`      ${line.split("\n").join("\n      ")}`);
    },
    onStatus: (status) => statuses.push(status),
  });
  return { runner, statuses, lines };
}

async function sql(text, values, overrides = {}) {
  const client = new Client({
    host: "127.0.0.1",
    port,
    user: SUPERUSER,
    password: PASSWORD,
    database: DATABASE,
    ssl: false,
    connectionTimeoutMillis: 5000,
    ...overrides,
  });
  client.on("error", () => undefined);
  await client.connect();
  try {
    return (await client.query(text, values)).rows;
  } finally {
    await client.end();
  }
}

const postmasterPid = () =>
  Number.parseInt(fs.readFileSync(pidFile, "utf8").split("\n")[0], 10);

function isGone(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return true;
  }
  if (process.platform !== "linux") {
    return false;
  }
  // A killed process nobody has reaped yet still answers signal 0.
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
  } catch {
    return true;
  }
}

async function waitUntilGone(pid) {
  for (let waited = 0; waited < 15_000; waited += 100) {
    if (isGone(pid)) {
      return;
    }
    await sleep(100);
  }
  assert.fail(`process ${pid} is still running`);
}

async function assertRefused() {
  await assert.rejects(
    sql("SELECT 1"),
    (error) => error.code === "ECONNREFUSED",
    "nothing should be listening once the server has stopped",
  );
}

const systemIdentifier = async () =>
  (
    await sql("SELECT system_identifier::text AS id FROM pg_control_system()")
  )[0].id;

const sentinels = async () =>
  (await sql("SELECT note FROM smoke_sentinel ORDER BY id")).map(
    (row) => row.note,
  );

let clusterId;
/** The runner of the shell session the steps are currently in. */
let session;
/** The pid of the backend one step leaves spinning, killed on the way out. */
let busyBackend;
const steps = [];
const step = (name, body) => steps.push({ name, body });

step("first start creates the cluster and the database", async () => {
  session = launch();
  const { runner, statuses, lines } = session;
  await runner.start();
  assert.deepEqual(statuses, ["initializing", "starting", "ready"]);
  assert.ok(fs.existsSync(path.join(dataDir, "monize.initialized")));
  assert.equal(
    fs.readFileSync(path.join(dataDir, "PG_VERSION"), "utf8").trim(),
    "16",
  );
  assert.deepEqual(
    fs.readdirSync(profile).sort(),
    ["logs", "pgdata"],
    "the password file must be gone and nothing else left beside pgdata",
  );
  assert.ok(
    lines.every((line) => !line.includes(PASSWORD)),
    "the password must not reach the log",
  );

  assert.deepEqual(await sql("SELECT 1 AS one"), [{ one: 1 }]);
  const [settings] = await sql(
    `SELECT current_setting('listen_addresses') AS listen,
            current_setting('unix_socket_directories') AS sockets,
            current_setting('TimeZone') AS zone,
            current_setting('server_encoding') AS encoding,
            current_setting('log_checkpoints') AS checkpoints,
            current_setting('fsync') AS fsync,
            (SELECT datcollate FROM pg_database WHERE datname = current_database()) AS collation,
            (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database()) AS owner`,
  );
  assert.deepEqual(settings, {
    listen: "127.0.0.1",
    sockets: "",
    zone: "UTC",
    encoding: "UTF8",
    checkpoints: "off",
    fsync: "on",
    collation: "C",
    owner: SUPERUSER,
  });
  clusterId = await systemIdentifier();
});

step("the server demands the scram password", async () => {
  const methods = await sql(
    "SELECT DISTINCT auth_method FROM pg_hba_file_rules ORDER BY 1",
  );
  assert.deepEqual(methods, [{ auth_method: "scram-sha-256" }]);
  await assert.rejects(
    sql("SELECT 1", [], { password: `${PASSWORD}x` }),
    (error) => error.code === "28P01",
    "a wrong password must be rejected",
  );
});

step("the four extensions schema.sql needs can be created", async () => {
  for (const extension of EXTENSIONS) {
    await sql(`CREATE EXTENSION "${extension}"`);
  }
  const installed = await sql(
    "SELECT extname FROM pg_extension WHERE extname = ANY($1) ORDER BY 1",
    [EXTENSIONS],
  );
  assert.deepEqual(
    installed.map((row) => row.extname),
    [...EXTENSIONS].sort(),
  );
  const [used] = await sql(
    `SELECT uuid_generate_v4() IS NOT NULL AS uuid,
            length(digest('monize', 'sha256')) AS digest,
            similarity('monize', 'monise') > 0 AS trigram`,
  );
  assert.deepEqual(used, { uuid: true, digest: 32, trigram: true });
  await sql(
    "CREATE TABLE smoke_sentinel (id serial PRIMARY KEY, note text NOT NULL)",
  );
  await sql("INSERT INTO smoke_sentinel (note) VALUES ('first run')");
});

step("start is idempotent while the server runs", async () => {
  const pid = postmasterPid();
  await session.runner.start();
  await Promise.all([session.runner.start(), session.runner.start()]);
  assert.equal(postmasterPid(), pid, "a repeated start must not restart");
  assert.deepEqual(session.statuses, ["initializing", "starting", "ready"]);
});

step("stop shuts down cleanly and is idempotent", async () => {
  const pid = postmasterPid();
  await session.runner.stop();
  assert.ok(!fs.existsSync(pidFile), "postmaster.pid must be gone");
  assert.ok(isGone(pid));
  await assertRefused();
  await session.runner.stop();
  assert.deepEqual(session.statuses.slice(3), ["stopping", "stopped"]);
  if (process.platform !== "win32") {
    assert.ok(
      !fs.existsSync(`/tmp/.s.PGSQL.${port}`),
      "no socket may be left in /tmp",
    );
  }
});

step("a start that cannot bind the port says why", async () => {
  const squatter = net.createServer();
  await new Promise((resolve) => squatter.listen(port, "127.0.0.1", resolve));
  try {
    const { runner, lines } = launch();
    const error = await runner.start().then(
      () => assert.fail("start must fail while the port is taken"),
      (reason) => reason,
    );
    assert.ok(error instanceof PostgresRunnerError);
    assert.equal(error.failure, "start");
    assert.match(error.outputTail, /could not bind/);
    for (const text of [error.message, error.outputTail, ...lines]) {
      assert.ok(!text.includes(PASSWORD));
    }
    assert.ok(!fs.existsSync(pidFile), "a failed start must leave no server");
  } finally {
    await new Promise((resolve) => squatter.close(resolve));
  }
});

step(
  "a wrong stored password is reported and nothing is left running",
  async () => {
    const wrong = `${PASSWORD}-wrong`;
    const { runner, lines } = launch(dataDir, wrong);
    const error = await runner.start().then(
      () => assert.fail("start must fail with the wrong password"),
      (reason) => reason,
    );
    assert.ok(error instanceof PostgresRunnerError);
    assert.equal(error.failure, "auth");
    for (const text of [error.message, error.outputTail, ...lines]) {
      assert.ok(!text.includes(PASSWORD) && !text.includes(wrong));
    }
    assert.ok(!fs.existsSync(pidFile), "the server must be stopped again");
    await assertRefused();
  },
);

step("a second run reuses the cluster without initdb", async () => {
  const { runner, statuses } = launch();
  await runner.start();
  assert.deepEqual(statuses, ["starting", "ready"]);
  assert.equal(await systemIdentifier(), clusterId);
  assert.deepEqual(await sentinels(), ["first run"]);
});

step("a killed server is recovered on the next start", async () => {
  await sql("INSERT INTO smoke_sentinel (note) VALUES ('before the kill')");
  const pid = postmasterPid();
  process.kill(pid, "SIGKILL");
  await waitUntilGone(pid);
  assert.ok(fs.existsSync(pidFile), "the kill must leave postmaster.pid");

  const { runner, statuses } = launch();
  await runner.start();
  assert.deepEqual(statuses, ["recovering", "starting", "ready"]);
  assert.notEqual(postmasterPid(), pid);
  assert.equal(await systemIdentifier(), clusterId);
  assert.deepEqual(await sentinels(), ["first run", "before the kill"]);
  await runner.stop();
  assert.ok(!fs.existsSync(pidFile));
});

step("a killed server with a busy backend is waited out", async () => {
  await launch().runner.start();
  // A backend in the middle of a statement does not notice the server dying
  // until the statement ends, and a new server refuses to start beside it.
  // This one computes without touching the disk until its timeout ends it.
  const client = new Client({
    host: "127.0.0.1",
    port,
    user: SUPERUSER,
    password: PASSWORD,
    database: DATABASE,
    ssl: false,
  });
  client.on("error", () => undefined);
  await client.connect();
  await client.query("SET statement_timeout = '3s'");
  busyBackend = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0]
    .pid;
  const busy = client
    .query(
      `WITH RECURSIVE spin(n) AS (
         SELECT 1::bigint UNION ALL SELECT n + 1 FROM spin WHERE n < 1000000000000
       ) SELECT count(*) FROM spin`,
    )
    .catch((error) => error);
  await sleep(500);
  const pid = postmasterPid();
  process.kill(pid, "SIGKILL");
  await waitUntilGone(pid);
  say(
    `      the busy backend ${isGone(busyBackend) ? "exited with" : "outlived"} its server`,
  );

  const { runner, statuses } = launch();
  await runner.start();
  assert.deepEqual(statuses, ["recovering", "starting", "ready"]);
  assert.ok((await busy) instanceof Error, "the orphaned statement must fail");
  await waitUntilGone(busyBackend);
  assert.deepEqual(await sentinels(), ["first run", "before the kill"]);
  await runner.stop();
  assert.ok(!fs.existsSync(pidFile));
});

step("a pid file naming another program is cleared", async () => {
  // This script's own pid: alive, and not a PostgreSQL server.
  fs.writeFileSync(
    pidFile,
    `${process.pid}\n${dataDir}\n1700000000\n${port}\n\n127.0.0.1\n`,
  );
  const { runner, statuses } = launch();
  await runner.start();
  assert.deepEqual(statuses, ["recovering", "starting", "ready"]);
  assert.notEqual(postmasterPid(), process.pid);
  assert.deepEqual(await sentinels(), ["first run", "before the kill"]);
});

step("a server left by a crashed shell is replaced", async () => {
  // The runner of the previous step is dropped without stop(), as if the
  // shell had died: its server is still running.
  const orphan = postmasterPid();
  assert.ok(!isGone(orphan));
  await sql("INSERT INTO smoke_sentinel (note) VALUES ('orphaned')");

  const { runner, statuses } = launch();
  await runner.start();
  assert.deepEqual(statuses, ["recovering", "starting", "ready"]);
  assert.ok(isGone(orphan), "the orphan must have been shut down");
  assert.notEqual(postmasterPid(), orphan);
  assert.equal(await systemIdentifier(), clusterId);
  assert.deepEqual(await sentinels(), [
    "first run",
    "before the kill",
    "orphaned",
  ]);
  await runner.stop();
  assert.ok(!fs.existsSync(pidFile));
  await assertRefused();
});

step("an interrupted initialization is moved aside, not deleted", async () => {
  fs.mkdirSync(secondDataDir, { recursive: true });
  fs.writeFileSync(path.join(secondDataDir, "PG_VERSION"), "16\n");
  const { runner, statuses } = launch(secondDataDir);
  await runner.start();
  assert.deepEqual(statuses, ["initializing", "starting", "ready"]);
  const aside = fs
    .readdirSync(profile)
    .filter((name) => name.startsWith("pgdata-interrupted.incomplete-"));
  assert.equal(aside.length, 1);
  assert.deepEqual(fs.readdirSync(path.join(profile, aside[0])), [
    "PG_VERSION",
  ]);
  assert.notEqual(await systemIdentifier(), clusterId);
  await runner.stop();
  assert.ok(!fs.existsSync(path.join(secondDataDir, "postmaster.pid")));
});

let failed = false;
say(`PostgreSQL smoke test: ${binDir}`);
say(`data directory: ${dataDir} (port ${port})`);
try {
  for (const { name, body } of steps) {
    say(`  ... ${name}`);
    await body();
    say(`  ok  ${name}`);
  }
} catch (error) {
  failed = true;
  say(`  FAILED: ${error?.stack ?? error}`);
  if (error?.outputTail) {
    say(`  output:\n${error.outputTail}`);
  }
  if (fs.existsSync(serverLogFile)) {
    const log = fs.readFileSync(serverLogFile, "utf8").trimEnd().split("\n");
    say(`  server log (last lines):\n${log.slice(-30).join("\n")}`);
  }
} finally {
  if (busyBackend !== undefined && !isGone(busyBackend)) {
    process.kill(busyBackend, "SIGKILL");
    await waitUntilGone(busyBackend).catch(() => undefined);
  }
  for (const dir of [dataDir, secondDataDir]) {
    await launch(dir)
      .runner.stop()
      .catch((error) => {
        failed = true;
        say(`  FAILED to stop the server in ${dir}: ${error.message}`);
      });
  }
  fs.rmSync(root, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 250,
  });
}

say(failed ? "PostgreSQL smoke test FAILED" : "PostgreSQL smoke test passed");
process.exitCode = failed ? 1 : 0;
