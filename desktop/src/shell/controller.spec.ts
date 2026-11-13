import { ConfigError } from "../app-config";
import { BootFailure, FatalFailure } from "../supervisor/types";
import {
  FAKE_ORIGIN,
  FAKE_SECRETS,
  fakeRuntime,
  FakeRuntime,
} from "../test-support/fake-runtime";
import { createShellController, ShellUi } from "./controller";
import { SplashView } from "./splash-view";
import { STATUS_TEXT, TEXT } from "./strings";

interface Recorder extends ShellUi {
  readonly events: string[];
  readonly views: SplashView[];
}

function recorder(): Recorder {
  const events: string[] = [];
  const views: SplashView[] = [];
  return {
    events,
    views,
    showSplash: (view) => {
      views.push(view);
      events.push(`splash:${view.title}`);
    },
    openApp: (_runtime, url) => events.push(`open:${url}`),
    navigate: (url) => events.push(`navigate:${url}`),
    focus: () => events.push("focus"),
    addressChanged: (origin) => events.push(`moved:${origin}`),
    fatal: (_runtime, failure) => events.push(`fatal:${failure.child}`),
  };
}

const failure: BootFailure = {
  step: "db-migrate",
  cause: { kind: "exited", code: 1, signal: null },
  logSource: "backend",
  logTail: [
    {
      time: "t",
      level: "error",
      source: "backend",
      msg: "migration 42 failed",
    },
  ],
};

function setup(runtime: FakeRuntime | Error = fakeRuntime()) {
  const ui = recorder();
  const reported: unknown[] = [];
  const controller = createShellController({
    createRuntime: () =>
      runtime instanceof Error
        ? Promise.reject(runtime)
        : Promise.resolve(runtime),
    ui,
    reportStartupError: (error) => reported.push(error),
  });
  return { ui, reported, controller };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("createShellController", () => {
  it("shows the splash, boots, then opens the app on its origin", async () => {
    const runtime = fakeRuntime();
    const { ui, controller } = setup(runtime);
    const booted = controller.boot();
    await tick();
    runtime.emitStatus("postgres");
    await runtime.settleStart({ outcome: "ready" });
    await booted;
    expect(ui.events).toEqual([
      `splash:${STATUS_TEXT.idle}`,
      `splash:${STATUS_TEXT.postgres}`,
      `open:${FAKE_ORIGIN}`,
    ]);
    expect(controller.runtime).toBe(runtime);
  });

  it("redacts the two secrets the runtime does not", async () => {
    const runtime = fakeRuntime();
    const { controller } = setup(runtime);
    const booted = controller.boot();
    await tick();
    await runtime.settleStart({ outcome: "ready" });
    await booted;
    expect(runtime.logger.redacted).toEqual(
      expect.arrayContaining([
        FAKE_SECRETS.encryptionKey,
        FAKE_SECRETS.jwtSecret,
      ]),
    );
  });

  it("says once that the address changed when a port moved", async () => {
    const runtime = fakeRuntime(["frontend"]);
    const { ui, controller } = setup(runtime);
    const booted = controller.boot();
    await tick();
    await runtime.settleStart({ outcome: "ready" });
    await booted;
    expect(ui.events.filter((e) => e.startsWith("moved:"))).toEqual([
      `moved:${FAKE_ORIGIN}`,
    ]);
  });

  it("shows a failed boot with its log tail, and Retry boots again", async () => {
    const runtime = fakeRuntime();
    const { ui, controller } = setup(runtime);
    const booted = controller.boot();
    await tick();
    runtime.emitStatus("failed");
    await runtime.settleStart({ outcome: "failed", failure });
    await booted;
    const shown = ui.views[ui.views.length - 1];
    expect(shown.title).toBe(TEXT.bootFailedTitle);
    expect(shown.canRetry).toBe(true);
    expect(shown.lines.join("\n")).toContain("migration 42 failed");
    // The failed status itself is not shown: the result says more.
    expect(ui.events).not.toContain(`splash:${STATUS_TEXT.failed}`);

    const retried = controller.retry();
    expect(runtime.calls).toEqual(["start", "start"]);
    await runtime.settleStart({ outcome: "ready" });
    await retried;
    expect(ui.events[ui.events.length - 1]).toBe(`open:${FAKE_ORIGIN}`);
  });

  it("ignores Retry while a boot is running or after it succeeded", async () => {
    const runtime = fakeRuntime();
    const { controller } = setup(runtime);
    const booted = controller.boot();
    await tick();
    await controller.retry();
    await runtime.settleStart({ outcome: "ready" });
    await booted;
    await controller.retry();
    expect(runtime.calls).toEqual(["start"]);
  });

  it("shows a typed startup error as it is, with Quit only", async () => {
    const error = new ConfigError("invalid", "config.json is damaged.");
    const { ui, reported, controller } = setup(error);
    await controller.boot();
    const shown = ui.views[ui.views.length - 1];
    expect(shown.detail).toBe("config.json is damaged.");
    expect(shown.canRetry).toBe(false);
    expect(shown.canQuit).toBe(true);
    expect(reported).toEqual([error]);
    await expect(controller.shutdown()).resolves.toBeUndefined();
  });

  it("opens a deep link that arrived before the window, on the app origin", async () => {
    const runtime = fakeRuntime();
    const { ui, controller } = setup(runtime);
    controller.deepLink("monize://open/accounts");
    const booted = controller.boot();
    await tick();
    await runtime.settleStart({ outcome: "ready" });
    await booted;
    expect(ui.events).toContain(`open:${FAKE_ORIGIN}/accounts`);
  });

  it("navigates for a valid deep link once open and refuses a hostile one", async () => {
    const runtime = fakeRuntime();
    const { ui, controller } = setup(runtime);
    const booted = controller.boot();
    await tick();
    await runtime.settleStart({ outcome: "ready" });
    await booted;
    controller.deepLink("monize://open/reports?range=ytd");
    controller.deepLink("monize://open//evil.example/");
    expect(ui.events.slice(-2)).toEqual([
      `navigate:${FAKE_ORIGIN}/reports?range=ytd`,
      "focus",
    ]);
    expect(runtime.logger.messages("main").join("\n")).toContain("Refused");
  });

  it("opens the origin when the pending deep link is refused", async () => {
    const runtime = fakeRuntime();
    const { ui, controller } = setup(runtime);
    controller.deepLink("monize://elsewhere/accounts");
    const booted = controller.boot();
    await tick();
    await runtime.settleStart({ outcome: "ready" });
    await booted;
    expect(ui.events).toContain(`open:${FAKE_ORIGIN}`);
  });

  it("hands a fatal failure to the ui", async () => {
    const runtime = fakeRuntime();
    const { ui, controller } = setup(runtime);
    const booted = controller.boot();
    await tick();
    await runtime.settleStart({ outcome: "ready" });
    await booted;
    const fatal: FatalFailure = {
      child: "backend",
      cause: { kind: "exited", code: 1, signal: null },
      logSource: "backend",
      logTail: [],
    };
    runtime.emitFatal(fatal);
    expect(ui.events[ui.events.length - 1]).toBe("fatal:backend");
  });

  it("stops the supervisor once however often shutdown is called", async () => {
    const runtime = fakeRuntime();
    const { controller } = setup(runtime);
    const booted = controller.boot();
    await tick();
    await runtime.settleStart({ outcome: "ready" });
    await booted;
    const release = runtime.holdStop();
    let done = false;
    const first = controller.shutdown().then(() => {
      done = true;
    });
    expect(controller.shutdown()).toBe(controller.shutdown());
    await tick();
    expect(done).toBe(false);
    release();
    await first;
    expect(runtime.calls.filter((call) => call === "stop")).toHaveLength(1);
  });

  it("waits for a runtime still being created before stopping it", async () => {
    const runtime = fakeRuntime();
    let create: (value: FakeRuntime) => void = () => undefined;
    const ui = recorder();
    const controller = createShellController({
      createRuntime: () =>
        new Promise((resolve) => {
          create = resolve;
        }),
      ui,
      reportStartupError: () => undefined,
    });
    const booted = controller.boot();
    const stopped = controller.shutdown();
    create(runtime);
    await stopped;
    await booted;
    expect(runtime.calls).toEqual(["stop"]);
    expect(ui.events.some((e) => e.startsWith("open:"))).toBe(false);
  });

  it("does not open the app when shutdown began during the boot", async () => {
    const runtime = fakeRuntime();
    const { ui, controller } = setup(runtime);
    const booted = controller.boot();
    await tick();
    const stopped = controller.shutdown();
    await runtime.settleStart({ outcome: "ready" });
    await Promise.all([booted, stopped]);
    expect(ui.events.some((e) => e.startsWith("open:"))).toBe(false);
  });
});
