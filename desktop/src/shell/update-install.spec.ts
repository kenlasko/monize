import { fakeRuntime, FakeRuntime } from "../test-support/fake-runtime";
import {
  available,
  fakeUpdater,
  recordingUi,
  tick,
} from "../test-support/fake-updater";
import { createShellController, ShellController } from "./controller";
import { createQuitGate, QuitGate } from "./quit-gate";
import { createUpdatePolicy, UpdatePolicy } from "./update-policy";

/**
 * The install sequence against the real quit gate and the real controller,
 * with Electron's `app` reduced to what matters: `quit()` emits `before-quit`
 * and leaves only if nobody prevented it; `exit()` leaves without one. The
 * fake updater spawns the installer inside `quitAndInstall` and schedules
 * `app.quit()` with `setImmediate`, as `BaseUpdater.quitAndInstall` does.
 */

interface World {
  readonly events: string[];
  readonly runtime: FakeRuntime;
  readonly controller: ShellController;
  readonly gate: QuitGate;
  readonly policy: UpdatePolicy;
  readonly quit: () => void;
}

async function world(): Promise<World> {
  const events: string[] = [];
  const runtime = fakeRuntime();
  const controller = createShellController({
    createRuntime: () => Promise.resolve(runtime),
    reportStartupError: () => undefined,
    ui: {
      showSplash: () => undefined,
      openApp: () => undefined,
      stackReady: () => undefined,
      navigate: () => undefined,
      focus: () => undefined,
      addressChanged: () => undefined,
      fatal: () => undefined,
    },
  });
  let gone = false;
  const gate = createQuitGate({
    shutdown: () => controller.shutdown(),
    exit: (code) => {
      if (gone) return;
      gone = true;
      events.push(`exit:${code}`);
    },
    onBegin: () => events.push("gate:begin"),
  });
  const quit = () => {
    if (gone) return;
    let prevented = false;
    gate.beforeQuit({ preventDefault: () => (prevented = true) });
    if (!prevented) {
      gone = true;
      events.push("quit:left");
    }
  };
  const updater = fakeUpdater(events);
  updater.scheduleQuit = () => {
    events.push("updater:quit");
    quit();
  };
  const policy = createUpdatePolicy({
    updater,
    currentVersion: "1.21.0",
    ui: recordingUi(events),
    stopStack: () => {
      events.push("stop-stack");
      return controller.shutdown();
    },
    isQuitting: () => gate.quitting,
    quit,
    beginInstall: () => events.push("begin-install"),
    log: { info: () => undefined, warn: () => undefined },
  });

  const booted = controller.boot();
  await tick();
  await runtime.settleStart({ outcome: "ready" });
  await booted;
  policy.stackReady();
  await updater.settleCheck(available("1.22.0"));
  await updater.settleDownload();
  events.length = 0;
  return { events, runtime, controller, gate, policy, quit };
}

const stops = (runtime: FakeRuntime) =>
  runtime.calls.filter((call) => call === "stop").length;

describe("installing an update", () => {
  it("stops the stack, then spawns the installer, then exits once", async () => {
    const { events, runtime, policy } = await world();
    const release = runtime.holdStop();
    const installing = policy.requestInstall();
    await tick();
    // PostgreSQL is still stopping: no installer yet, and the app stays.
    expect(events).toEqual([
      "ui:confirm:1.22.0",
      "begin-install",
      "stop-stack",
    ]);
    release();
    await installing;
    await tick();
    expect(events).toEqual([
      "ui:confirm:1.22.0",
      "begin-install",
      "stop-stack",
      "installer:visible:run-after",
      "gate:begin",
      "exit:0",
      // electron-updater's own scheduled quit, after the process left.
      "updater:quit",
    ]);
    expect(stops(runtime)).toBe(1);
  });

  it("joins a Quit pressed while the stack is stopping: one stop, one exit", async () => {
    const { events, runtime, policy, quit } = await world();
    const release = runtime.holdStop();
    const installing = policy.requestInstall();
    await tick();
    quit();
    quit();
    release();
    await installing;
    await tick();
    expect(stops(runtime)).toBe(1);
    expect(events.filter((e) => e.startsWith("exit:"))).toEqual(["exit:0"]);
    // The install had begun first, so its continuation runs before the exit.
    expect(events.indexOf("installer:visible:run-after")).toBeLessThan(
      events.indexOf("exit:0"),
    );
  });

  it("leaves even when electron-updater schedules its own quit after ours", async () => {
    const { events, policy } = await world();
    await policy.requestInstall();
    await tick();
    await tick();
    // The updater's scheduled quit met a process that had already left.
    expect(events.filter((e) => e.startsWith("exit:"))).toEqual(["exit:0"]);
    expect(events).not.toContain("quit:left");
  });

  it("installs nothing when the person quits instead of confirming", async () => {
    const { events, runtime, policy, quit } = await world();
    quit();
    await tick();
    await policy.requestInstall();
    await tick();
    expect(events.some((e) => e.startsWith("installer"))).toBe(false);
    expect(events).not.toContain("stop-stack");
    expect(stops(runtime)).toBe(1);
    expect(events.filter((e) => e.startsWith("exit:"))).toEqual(["exit:0"]);
  });
});
