import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  FAKE_PARENT_WATCH,
  FAKE_PARENT_WATCH_DEPS,
  FakeProcess,
  fakeSpawner,
} from "../test-support/fake-process";
import { flush, manualClock } from "../test-support/manual-clock";
import { memoryLogger } from "../test-support/memory-logger";
import { REPO_PARENT_WATCH } from "../test-support/parent-watch-processes";
import { ChildSpec, ChildStopError, startChild } from "./child";
import { ParentWatchMissingError } from "./parent-watch";

const SPEC: ChildSpec = {
  source: "backend",
  args: ["dist/main.js"],
  cwd: "/res/backend",
  env: { NODE_ENV: "production", ELECTRON_RUN_AS_NODE: "1" },
};

const OPTIONS = {
  stopGraceMs: 5000,
  killTimeoutMs: 5000,
  drainTimeoutMs: 2000,
};

function setup(configure: (process: FakeProcess) => void = () => undefined) {
  const spawner = fakeSpawner();
  spawner.onSpawn = configure;
  const clock = manualClock();
  const logger = memoryLogger();
  const child = startChild(SPEC, {
    execPath: "/opt/monize/Monize",
    ...FAKE_PARENT_WATCH_DEPS,
    logger,
    spawn: spawner.spawn,
    clock,
    options: OPTIONS,
  });
  return { child, clock, logger, process: spawner.processes[0], spawner };
}

/** True once `promise` has settled. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  const mark = (): void => {
    done = true;
  };
  promise.then(mark, mark);
  await flush();
  return done;
}

describe("startChild with a fake spawner", () => {
  it("spawns the executable with the argv, the directory and the composed environment as the whole environment", () => {
    const { process: spawned, child } = setup();

    expect(spawned.command).toBe("/opt/monize/Monize");
    // The parent-watch preload comes first, before the layer's own arguments.
    expect(spawned.args).toEqual([
      "--require",
      FAKE_PARENT_WATCH,
      "dist/main.js",
    ]);
    // Exactly the composed environment: nothing merged in from the parent.
    // stdin is a pipe: the one the preload watches.
    expect(spawned.options).toEqual({
      cwd: "/res/backend",
      env: { NODE_ENV: "production", ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });
    expect(child.pid).toBe(spawned.pid);
  });

  it("refuses to start a child without the parent-watch preload, naming the file", async () => {
    const spawner = fakeSpawner();
    const logger = memoryLogger();
    const child = startChild(SPEC, {
      execPath: "/opt/monize/Monize",
      parentWatch: "/res/shell/parent-watch.cjs",
      fileExists: () => false,
      logger,
      spawn: spawner.spawn,
    });

    const exit = await child.exited;

    expect(spawner.processes).toEqual([]);
    expect(child.pid).toBeUndefined();
    expect(exit.error).toBeInstanceOf(ParentWatchMissingError);
    expect(exit.error?.code).toBe("PARENT_WATCH_MISSING");
    expect(exit.error?.message).toContain("/res/shell/parent-watch.cjs");
    expect(logger.messages("main").join("\n")).toMatch(/could not be started/);
    await expect(child.stop()).resolves.toBeUndefined();
  });

  it("ignores an error on the stdin pipe, which it never writes to", async () => {
    const { process: spawned, child } = setup();

    spawned.stdin.emit("error", new Error("write EPIPE"));

    expect(await settled(child.exited)).toBe(false);
  });

  it("logs stdout as info and stderr as warn under the child's source, line by line", async () => {
    const { process: spawned, logger, child } = setup();

    spawned.stdout.emit("data", Buffer.from("listening\nhalf a "));
    spawned.stderr.emit("data", "deprecated\n");
    spawned.stdout.emit("data", "line");
    spawned.exit(0);
    await child.exited;

    expect(
      logger.records
        .filter((record) => record.source === "backend")
        .map((record) => [record.level, record.msg]),
    ).toEqual([
      ["info", "listening"],
      ["warn", "deprecated"],
      // The unterminated last line is flushed when the process is gone.
      ["info", "half a line"],
    ]);
  });

  it("settles `exited` with the code, or with the signal", async () => {
    const byCode = setup();
    byCode.process.exit(3);
    await expect(byCode.child.exited).resolves.toEqual({
      code: 3,
      signal: null,
    });

    const bySignal = setup();
    bySignal.process.exit(null, "SIGKILL");
    await expect(bySignal.child.exited).resolves.toEqual({
      code: null,
      signal: "SIGKILL",
    });
  });

  it("waits for the output pipes to close, but only for the drain bound", async () => {
    const { process: spawned, child, clock } = setup();

    spawned.exitOnly(1);
    expect(await settled(child.exited)).toBe(false);
    await clock.advance(1999);
    expect(await settled(child.exited)).toBe(false);
    await clock.advance(1);

    await expect(child.exited).resolves.toEqual({ code: 1, signal: null });
  });

  it("leaves no drain timer behind when the pipes close normally", async () => {
    const { process: spawned, child, clock } = setup();

    spawned.exit(0);
    await child.exited;

    expect(clock.pending).toBe(0);
  });

  it("settles `exited` with the error when the spawn fails asynchronously", async () => {
    const { process: spawned, child, logger } = setup();

    spawned.failToStart("ENOENT");

    const exit = await child.exited;
    expect(exit).toMatchObject({ code: null, signal: null });
    expect(exit.error?.code).toBe("ENOENT");
    expect(logger.messages("main").join("\n")).toMatch(/could not be started/);
    // Nothing to stop: no signal is sent and stop() resolves.
    await child.stop();
    expect(spawned.kills).toEqual([]);
  });

  it("settles `exited` with the error when the spawner throws", async () => {
    const clock = manualClock();
    const child = startChild(SPEC, {
      execPath: "/opt/monize/Monize",
      ...FAKE_PARENT_WATCH_DEPS,
      logger: memoryLogger(),
      clock,
      spawn: () => {
        throw Object.assign(new Error("spawn EACCES"), { code: "EACCES" });
      },
    });

    expect(child.pid).toBeUndefined();
    expect((await child.exited).error?.code).toBe("EACCES");
    await expect(child.stop()).resolves.toBeUndefined();
  });

  it("does not take a later process error for an exit", async () => {
    const { process: spawned, child } = setup();

    spawned.emit("error", new Error("kill EPERM"));

    expect(await settled(child.exited)).toBe(false);
  });

  describe("stop", () => {
    it("sends SIGTERM and resolves once the process is gone, with no timer left", async () => {
      const { process: spawned, child, clock } = setup();

      await child.stop();

      expect(spawned.kills).toEqual(["SIGTERM"]);
      expect(await settled(child.exited)).toBe(true);
      expect(clock.pending).toBe(0);
    });

    it("does not resolve while the process is still running", async () => {
      const { child, clock } = setup((spawned) => spawned.ignore("SIGTERM"));

      const stopping = child.stop();
      await clock.advance(4999);

      expect(await settled(stopping)).toBe(false);
    });

    it("kills a process that outlives the grace period", async () => {
      const {
        process: spawned,
        child,
        clock,
        logger,
      } = setup((spawned) => spawned.ignore("SIGTERM"));

      const stopping = child.stop();
      await clock.advance(4999);
      expect(spawned.kills).toEqual(["SIGTERM"]);
      await clock.advance(1);

      await stopping;
      expect(spawned.kills).toEqual(["SIGTERM", "SIGKILL"]);
      expect(logger.messages("main").join("\n")).toMatch(/killing it/);
      expect(clock.pending).toBe(0);
    });

    it("rejects with ChildStopError when the process outlives the kill too", async () => {
      const { child, clock } = setup((spawned) =>
        spawned.ignore("SIGTERM", "SIGKILL"),
      );

      const stopping = child.stop();
      const outcome = stopping.catch((error: unknown) => error);
      await clock.advance(10_000);

      const error = await outcome;
      expect(error).toBeInstanceOf(ChildStopError);
      expect((error as ChildStopError).source).toBe("backend");
    });

    it("is idempotent: concurrent and repeated calls signal once and share one promise", async () => {
      const { process: spawned, child } = setup();

      const first = child.stop();
      const second = child.stop();
      await Promise.all([first, second]);
      await child.stop();

      expect(second).toBe(first);
      expect(spawned.kills).toEqual(["SIGTERM"]);
    });

    it("resolves without signalling a process that already exited", async () => {
      const { process: spawned, child } = setup();
      spawned.exit(0);
      await child.exited;

      await child.stop();

      expect(spawned.kills).toEqual([]);
    });

    it("keeps waiting for the exit when sending the signal throws", async () => {
      const {
        process: spawned,
        child,
        logger,
      } = setup((spawned) => {
        spawned.kill = () => {
          throw new Error("kill EPERM");
        };
      });

      const stopping = child.stop();
      expect(await settled(stopping)).toBe(false);
      spawned.exit(0);

      await stopping;
      expect(logger.messages("main").join("\n")).toMatch(/kill EPERM/);
    });
  });
});

describe("startChild with a real process", () => {
  const PARENT_ONLY = "MONIZE_CHILD_SPEC_PARENT_ONLY";
  const real = (
    args: readonly string[],
    execPath = process.execPath,
    parentWatch = REPO_PARENT_WATCH,
  ) => {
    const logger = memoryLogger();
    const child = startChild(
      {
        source: "frontend",
        args,
        cwd: __dirname,
        env: { MONIZE_CHILD_SPEC: "given" },
      },
      { execPath, parentWatch, logger },
    );
    return { child, logger };
  };

  afterEach(() => {
    delete process.env[PARENT_ONLY];
  });

  it("runs with only the environment it was given, and logs both streams before `exited` settles", async () => {
    process.env[PARENT_ONLY] = "leaked";
    const script =
      `console.log(process.env.MONIZE_CHILD_SPEC + " " + process.env.${PARENT_ONLY});` +
      'console.error("to stderr"); process.exitCode = 3;';

    const { child, logger } = real(["-e", script]);

    await expect(child.exited).resolves.toEqual({ code: 3, signal: null });
    expect(
      logger.records
        .filter((record) => record.source === "frontend")
        .map((record) => [record.level, record.msg]),
    ).toEqual(
      expect.arrayContaining([
        ["info", "given undefined"],
        ["warn", "to stderr"],
      ]),
    );
  });

  it("settles `exited` with ENOENT for an executable that does not exist", async () => {
    const { child } = real(["-e", "0"], `${__dirname}/no-such-executable`);

    const exit = await child.exited;

    expect(exit.error?.code).toBe("ENOENT");
    expect(exit.code).toBeNull();
    await expect(child.stop()).resolves.toBeUndefined();
  });

  it("loads the parent-watch preload by absolute path, even one with spaces in it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "monize child spec "));
    try {
      const preload = join(dir, "Program Files", "shell", "parent-watch.cjs");
      mkdirSync(join(dir, "Program Files", "shell"), { recursive: true });
      copyFileSync(REPO_PARENT_WATCH, preload);
      const script =
        "console.log(Object.keys(require.cache).filter((k) => k.endsWith('parent-watch.cjs')).join());";

      const { child, logger } = real(["-e", script], process.execPath, preload);

      await expect(child.exited).resolves.toEqual({ code: 0, signal: null });
      expect(logger.messages("frontend")).toEqual([preload]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stops a running process and resolves once it is gone", async () => {
    const { child } = real(["-e", "setInterval(() => undefined, 1000)"]);

    await child.stop();

    // SIGTERM on POSIX; TerminateProcess on Windows, reported the same way.
    expect((await child.exited).code).not.toBe(0);
  });
});
