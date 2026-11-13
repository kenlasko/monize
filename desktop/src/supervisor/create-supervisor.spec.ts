import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { PlainSecrets } from "../app-config";
import { AppPaths, dataPathsFor } from "../app-paths";
import { ChildEnvError, composeBackendEnv, composeFrontendEnv } from "../env";
import { createLogger, Logger } from "../logger";
import { generateSecret } from "../secrets";
import { fakePostgres } from "../test-support/boot-harness";
import { fakeFetch } from "../test-support/fake-fetch";
import { fakeSpawner } from "../test-support/fake-process";
import { flush, manualClock } from "../test-support/manual-clock";
import { memoryLogger } from "../test-support/memory-logger";
import { createSupervisor, SupervisorInput } from "./create-supervisor";

const PORTS = { frontend: 4380, backend: 4381, postgres: 6433 };
const SECRETS: PlainSecrets = {
  jwtSecret: generateSecret(),
  encryptionKey: generateSecret(),
  databasePassword: generateSecret(),
};
const WINDOWS_PATHS: AppPaths = {
  resourcesDir: "C:\\Program Files\\Monize\\resources",
  data: dataPathsFor("C:\\Users\\a\\AppData\\Local\\Monize", "win32"),
};
const BASE_ENV = {
  SystemRoot: "C:\\Windows",
  DEMO_MODE: "true",
  NODE_OPTIONS: "--require C:\\evil.js",
  HOST: "0.0.0.0",
};

function setup(overrides: Partial<SupervisorInput> = {}) {
  const journal: string[] = [];
  const spawner = fakeSpawner(journal);
  const net = fakeFetch();
  const clock = manualClock();
  const logger = memoryLogger();
  const input: SupervisorInput = {
    paths: WINDOWS_PATHS,
    config: { ports: PORTS },
    secrets: SECRETS,
    logger,
    postgres: fakePostgres(journal),
    baseEnv: BASE_ENV,
    execPath: "C:\\Program Files\\Monize\\Monize.exe",
    platform: "win32",
    spawn: spawner.spawn,
    fetch: net.fetch,
    clock,
    ...overrides,
  };
  const backendUrl = "http://127.0.0.1:4381/api/v1/health/ready";
  const frontendUrl = "http://127.0.0.1:4380/api/v1/health/live";
  net.respond(backendUrl, 200);
  net.respond(frontendUrl, 200);

  async function boot() {
    const supervisor = createSupervisor(input);
    const started = supervisor.start();
    await flush();
    spawner.find("dist/db-init.js").exit(0);
    await flush();
    spawner.find("dist/db-migrate.js").exit(0);
    return { supervisor, result: await started };
  }

  return {
    input,
    spawner,
    net,
    logger,
    journal,
    boot,
    backendUrl,
    frontendUrl,
  };
}

describe("createSupervisor", () => {
  it("boots the whole stack to ready from the bootstrap's result", async () => {
    const { boot, journal } = setup();

    const { result, supervisor } = await boot();

    expect(result).toEqual({ outcome: "ready" });
    expect(supervisor.status).toBe("ready");
    expect(journal.filter((entry) => !entry.startsWith("exit"))).toEqual([
      "postgres.start",
      "spawn dist/db-init.js",
      "spawn dist/db-migrate.js",
      "spawn dist/main.js",
      "spawn --require ./server-log-format.cjs server.js",
    ]);
  });

  it("runs every child as Electron's binary, in its layer's resource directory", async () => {
    const { boot, spawner } = setup();
    await boot();

    for (const spawned of spawner.processes) {
      expect(spawned.command).toBe("C:\\Program Files\\Monize\\Monize.exe");
    }
    expect(
      spawner.processes.map((spawned) => [spawned.script, spawned.options.cwd]),
    ).toEqual([
      ["dist/db-init.js", "C:\\Program Files\\Monize\\resources\\backend"],
      ["dist/db-migrate.js", "C:\\Program Files\\Monize\\resources\\backend"],
      ["dist/main.js", "C:\\Program Files\\Monize\\resources\\backend"],
      ["server.js", "C:\\Program Files\\Monize\\resources\\frontend"],
    ]);
  });

  it("gives each child exactly the environment env.ts composes, and nothing else from the parent", async () => {
    const { boot, spawner } = setup();
    await boot();

    const backendEnv = composeBackendEnv(
      { ports: PORTS, secrets: SECRETS },
      WINDOWS_PATHS.data,
      BASE_ENV,
    );
    for (const script of [
      "dist/db-init.js",
      "dist/db-migrate.js",
      "dist/main.js",
    ]) {
      expect(spawner.find(script).options.env).toEqual(backendEnv);
    }
    const frontendEnv = spawner.find("server.js").options.env;
    expect(frontendEnv).toEqual(composeFrontendEnv({ ports: PORTS }, BASE_ENV));

    // The properties that must not be lost on the way through.
    expect(backendEnv).toMatchObject({
      ELECTRON_RUN_AS_NODE: "1",
      HOST: "127.0.0.1",
      PORT: "4381",
      SystemRoot: "C:\\Windows",
    });
    expect(frontendEnv).toMatchObject({
      ELECTRON_RUN_AS_NODE: "1",
      HOSTNAME: "127.0.0.1",
      PORT: "4380",
      INTERNAL_API_URL: "http://127.0.0.1:4381",
    });
    for (const env of [backendEnv, frontendEnv]) {
      expect(env).not.toHaveProperty("DEMO_MODE");
      expect(env).not.toHaveProperty("NODE_OPTIONS");
    }
    expect(frontendEnv).not.toHaveProperty("JWT_SECRET");
  });

  it("polls the backend's readiness route and the frontend's liveness route on their loopback ports", async () => {
    const { boot, net, backendUrl, frontendUrl } = setup();
    await boot();

    expect(net.calls).toEqual([backendUrl, frontendUrl]);
  });

  it("uses the host's path flavour when no platform is given", async () => {
    const { boot, spawner } = setup({
      platform: undefined,
      paths: { ...WINDOWS_PATHS, resourcesDir: join(tmpdir(), "resources") },
    });
    await boot();

    expect(spawner.find("server.js").options.cwd).toBe(
      join(tmpdir(), "resources", "frontend"),
    );
  });

  it("registers the three secrets for redaction before anything is started", () => {
    const { input, logger, journal } = setup();

    createSupervisor(input);

    expect([...logger.redacted].sort()).toEqual(
      [
        SECRETS.jwtSecret,
        SECRETS.encryptionKey,
        SECRETS.databasePassword,
      ].sort(),
    );
    expect(journal).toEqual([]);
  });

  it("refuses an empty secret before anything is started", () => {
    const { input, journal } = setup({
      secrets: { ...SECRETS, encryptionKey: "" },
    });

    expect(() => createSupervisor(input)).toThrow(ChildEnvError);
    expect(journal).toEqual([]);
  });

  it("passes the deadlines through: a short backend deadline fails the boot at that bound", async () => {
    const { input, spawner, net, backendUrl } = setup({
      options: { backendReadyDeadlineMs: 1000 },
    });
    net.respond(backendUrl, "refused");
    const clock = input.clock as ReturnType<typeof manualClock>;
    const supervisor = createSupervisor(input);
    const started = supervisor.start();
    await flush();
    spawner.find("dist/db-init.js").exit(0);
    await flush();
    spawner.find("dist/db-migrate.js").exit(0);

    await clock.advance(1000);

    await expect(started).resolves.toMatchObject({
      outcome: "failed",
      failure: {
        step: "backend",
        cause: { kind: "timeout", deadlineMs: 1000 },
      },
    });
  });

  describe("with the real logger", () => {
    let dir: string;
    let logger: Logger;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "monize-supervisor-"));
      logger = createLogger({ logsDir: join(dir, "logs"), stdout: null });
    });

    afterEach(() => {
      logger.close();
      rmSync(dir, { recursive: true, force: true });
    });

    it("carries a failure's log tail with a secret the child printed replaced", async () => {
      const { input, spawner } = setup({ logger });
      const supervisor = createSupervisor(input);
      const started = supervisor.start();
      await flush();
      spawner
        .find("dist/db-init.js")
        .stderr.emit(
          "data",
          `password authentication failed for ${SECRETS.databasePassword}\n`,
        );

      spawner.find("dist/db-init.js").exit(1);

      const result = await started;
      if (result.outcome !== "failed") throw new Error("expected a failure");
      const tail = result.failure.logTail.map((record) => record.msg);
      expect(tail).toEqual(["password authentication failed for [redacted]"]);
      expect(result.failure.step).toBe("db-init");
    });
  });
});
