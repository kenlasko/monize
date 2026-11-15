import {
  killLeftovers,
  runGuarded,
  startShell,
  within,
} from "../test-support/parent-watch-processes";
import {
  PARENT_WATCH_FILE,
  parentWatchArgs,
  parentWatchPath,
} from "./parent-watch";

/**
 * The orphan guard against real processes, since the mechanism is the whole
 * point: a stand-in shell starts a grandchild under the preload the way the
 * supervisor does, and the spec kills the shell. Every wait is bounded and
 * polls nothing; `killLeftovers` removes whatever a failed case left behind.
 */

/** Generous for a loaded CI runner; a healthy run takes a few hundred ms. */
const EXIT_BOUND_MS = 5_000;
const FOREVER = "setInterval(() => process.stdout.write('beat\\n'), 50);";

afterEach(killLeftovers);

describe("parentWatchPath and parentWatchArgs", () => {
  it("is <resources>/shell/parent-watch.cjs in the platform's flavour", () => {
    expect(
      parentWatchPath("C:\\Program Files\\Monize\\resources", "win32"),
    ).toBe("C:\\Program Files\\Monize\\resources\\shell\\parent-watch.cjs");
    expect(parentWatchPath("/opt/monize/resources", "linux")).toBe(
      `/opt/monize/resources/shell/${PARENT_WATCH_FILE}`,
    );
  });

  it("is a --require of the absolute path, as two arguments", () => {
    expect(parentWatchArgs("C:\\a b\\parent-watch.cjs")).toEqual([
      "--require",
      "C:\\a b\\parent-watch.cjs",
    ]);
  });
});

describe("the parent-watch preload, with real processes", () => {
  jest.setTimeout(20_000);

  it("ends a child that would run forever once the shell that started it is killed", async () => {
    const shell = startShell(FOREVER);
    await within(shell.count(/^beat$/, 2), EXIT_BOUND_MS, "the first beats");

    const killedAt = Date.now();
    shell.process.kill("SIGKILL");

    // The shell is gone at once; the grandchild's copy of the shared stdout
    // closes only when the grandchild exits too.
    await expect(shell.exited).resolves.toMatchObject({ signal: "SIGKILL" });
    await within(shell.stdoutClosed, EXIT_BOUND_MS, "the grandchild's exit");
    expect(Date.now() - killedAt).toBeLessThan(EXIT_BOUND_MS);
  });

  it("leaves the child running while the shell is alive", async () => {
    const shell = startShell(FOREVER);
    await within(shell.line(/^grandchild \d+$/), EXIT_BOUND_MS, "the spawn");

    // Twenty beats is about a second of the shell alive and silent.
    await within(shell.count(/^beat$/, 20), EXIT_BOUND_MS, "twenty beats");
    let closed = false;
    void shell.stdoutClosed.then(() => (closed = true));
    await new Promise((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);
  });

  it("ends the child when its stdin pipe is closed by a shell that is still alive", async () => {
    const shell = startShell(FOREVER, { closeStdin: true });

    await within(shell.stdoutClosed, EXIT_BOUND_MS, "the grandchild's exit");
  });

  it.each([
    ["finishes on its own", "setTimeout(() => undefined, 100);", 0],
    ["sets an exit code", "setTimeout(() => (process.exitCode = 7), 100);", 7],
    ["calls process.exit", "process.exit(3);", 3],
    ["throws", "setTimeout(() => { throw new Error('boom'); }, 50);", 1],
  ])(
    "does not hold a script that %s open, and keeps its exit code",
    async (_, script, code) => {
      // The spec is the live parent and never closes the pipe.
      const child = runGuarded(script, "pipe");

      await expect(
        within(child.exited, EXIT_BOUND_MS, "the script's own exit"),
      ).resolves.toEqual({ code, signal: null });
    },
  );

  it("does nothing when stdin is not a pipe", async () => {
    // With stdin ignored fd 0 is the null device, which reads end-of-file at
    // once: a guard that watched it would exit before the line is printed.
    const child = runGuarded(
      "setTimeout(() => console.log('still here'), 300);",
      "ignore",
    );

    await expect(
      within(child.exited, EXIT_BOUND_MS, "the script's own exit"),
    ).resolves.toEqual({ code: 0, signal: null });
    expect(child.lines).toContain("still here");
  });
});
