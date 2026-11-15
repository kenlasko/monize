import { promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { AppPaths, dataPathsFor } from "./app-paths";
import { DEFAULT_PORTS, PortProber } from "./ports";
import { createRuntime, PORT_RELEASE_WAIT_MS, RuntimeDeps } from "./runtime";
import { SecretError } from "./secrets";
import { Supervisor, SupervisorInput } from "./supervisor";
import { Clock } from "./supervisor/clock";
import { PostgresRunnerOptions } from "./supervisor/postgres";
import { fakeSafeStorage } from "./test-support/fake-safe-storage";

/** Records what the runtime built and in which order it did things. */
function harness(probe: PortProber = async () => true) {
  const events: string[] = [];
  const postgresOptions: PostgresRunnerOptions[] = [];
  const supervisorInputs: SupervisorInput[] = [];
  let now = 0;
  const clock: Clock = {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  };
  const deps: RuntimeDeps = {
    createPostgres: (options) => {
      postgresOptions.push(options);
      return {
        start: async () => {
          events.push("postgres.start");
        },
        stop: async () => {
          events.push("postgres.stop");
        },
      };
    },
    createSupervisor: (input) => {
      supervisorInputs.push(input);
      return {} as Supervisor;
    },
    probe: async (port) => {
      events.push(`probe:${port}`);
      return probe(port);
    },
    clock,
  };
  return { deps, events, postgresOptions, supervisorInputs, clock };
}

describe("createRuntime", () => {
  let root: string;
  let paths: AppPaths;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), "monize-runtime-"));
    paths = {
      resourcesDir: join(root, "resources"),
      data: dataPathsFor(join(root, "data"), process.platform),
    };
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const input = (deps: RuntimeDeps) => ({
    paths,
    safeStorage: fakeSafeStorage(),
    baseEnv: {},
    execPath: "/opt/monize/Monize",
    stdout: null,
    deps,
  });

  it("creates the config on a first run and wires the database to it", async () => {
    const h = harness();
    const runtime = await createRuntime(input(h.deps));
    runtime.logger.close();

    expect(runtime.bootstrap.firstRun).toBe(true);
    expect(runtime.origin).toBe(`http://127.0.0.1:${DEFAULT_PORTS.frontend}`);
    // Nothing was left by an earlier session, so nothing is stopped.
    expect(h.events).not.toContain("postgres.stop");

    expect(h.postgresOptions).toHaveLength(1);
    const [postgres] = h.postgresOptions;
    expect(postgres.binDir).toBe(join(paths.resourcesDir, "postgres", "bin"));
    expect(postgres.dataDir).toBe(paths.data.pgdata);
    expect(postgres.port).toBe(DEFAULT_PORTS.postgres);
    expect(postgres.superuser).toBe("monize");
    expect(postgres.database).toBe("monize");
    expect(postgres.password).toBe(runtime.bootstrap.secrets.databasePassword);
    expect(postgres.serverLogFile.startsWith(paths.data.logs)).toBe(true);

    expect(h.supervisorInputs).toHaveLength(1);
    const [supervisor] = h.supervisorInputs;
    expect(supervisor.secrets).toBe(runtime.bootstrap.secrets);
    expect(supervisor.config.ports).toEqual(DEFAULT_PORTS);
    expect(supervisor.execPath).toBe("/opt/monize/Monize");
  });

  it("reads the same secrets and ports back on the next run", async () => {
    const first = await createRuntime(input(harness().deps));
    first.logger.close();
    const second = await createRuntime(input(harness().deps));
    second.logger.close();

    expect(second.bootstrap.firstRun).toBe(false);
    expect(second.bootstrap.secrets).toEqual(first.bootstrap.secrets);
    expect(second.bootstrap.config.ports).toEqual(first.bootstrap.config.ports);
  });

  it("stops a server left by an earlier session before it probes a port", async () => {
    (await createRuntime(input(harness().deps))).logger.close();

    const h = harness();
    (await createRuntime(input(h.deps))).logger.close();

    expect(h.events[0]).toBe("postgres.stop");
    expect(h.events.findIndex((event) => event.startsWith("probe:"))).toBe(1);
    // The stop-only runner is given neither the real port nor the password.
    const [stopOnly, real] = h.postgresOptions;
    expect(stopOnly.dataDir).toBe(paths.data.pgdata);
    expect(stopOnly.password).not.toBe(real.password);
  });

  it("waits for a persisted port to come free instead of moving it", async () => {
    (await createRuntime(input(harness().deps))).logger.close();

    // The earlier session's frontend is still letting go of its port.
    let probesOfFrontend = 0;
    const h = harness(async (port) => {
      if (port !== DEFAULT_PORTS.frontend) return true;
      probesOfFrontend += 1;
      return probesOfFrontend > 3;
    });
    const runtime = await createRuntime(input(h.deps));
    runtime.logger.close();

    expect(runtime.bootstrap.movedPorts).toEqual([]);
    expect(runtime.bootstrap.config.ports).toEqual(DEFAULT_PORTS);
    expect(h.clock.now()).toBeLessThan(PORT_RELEASE_WAIT_MS);
  });

  it("moves a port another program keeps, after the bounded wait", async () => {
    (await createRuntime(input(harness().deps))).logger.close();

    const h = harness(async (port) => port !== DEFAULT_PORTS.backend);
    const runtime = await createRuntime(input(h.deps));
    runtime.logger.close();

    expect(h.clock.now()).toBeGreaterThanOrEqual(PORT_RELEASE_WAIT_MS);
    expect(runtime.bootstrap.movedPorts).toEqual(["backend"]);
    expect(runtime.bootstrap.config.ports.backend).not.toBe(
      DEFAULT_PORTS.backend,
    );
    expect(runtime.bootstrap.config.ports.frontend).toBe(
      DEFAULT_PORTS.frontend,
    );
  });

  it("still builds the runtime when the leftover server cannot be stopped", async () => {
    (await createRuntime(input(harness().deps))).logger.close();

    const h = harness();
    const failing: RuntimeDeps = {
      ...h.deps,
      createPostgres: (options) => ({
        ...h.deps.createPostgres(options),
        stop: async () => {
          throw new Error("pg_ctl is missing");
        },
      }),
    };
    const runtime = await createRuntime(input(failing));
    runtime.logger.close();

    expect(h.supervisorInputs).toHaveLength(1);
  });

  it("refuses to start without a way to protect the secrets", async () => {
    const h = harness();
    await expect(
      createRuntime({ ...input(h.deps), safeStorage: fakeSafeStorage(false) }),
    ).rejects.toBeInstanceOf(SecretError);
    expect(h.supervisorInputs).toHaveLength(0);
  });
});
