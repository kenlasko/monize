import {
  UpdatePolicy,
  UpdatePolicyDeps,
  UpdaterPort,
  UpdateUi,
  createUpdatePolicy,
} from "../shell/update-policy";

/**
 * A stand-in for electron-updater's `AppUpdater` whose check and download the
 * spec settles by hand, plus a recording `UpdateUi`. `quitAndInstall` does
 * what `BaseUpdater.quitAndInstall` does: it spawns the installer at once and
 * schedules a quit with `setImmediate`, through the `scheduleQuit` the spec
 * gives it.
 */

type CheckResult = Awaited<ReturnType<UpdaterPort["checkForUpdates"]>>;

interface Pending<T> {
  resolve(value: T): void;
  reject(error: unknown): void;
}

export interface FakeUpdater extends UpdaterPort {
  readonly events: string[];
  settleCheck(result: CheckResult | Error): Promise<void>;
  settleDownload(error?: Error): Promise<void>;
  scheduleQuit: () => void;
}

export const tick = () => new Promise((resolve) => setImmediate(resolve));

export function fakeUpdater(events: string[] = []): FakeUpdater {
  const checks: Pending<CheckResult>[] = [];
  const downloads: Pending<unknown>[] = [];
  const updater: FakeUpdater = {
    events,
    scheduleQuit: () => undefined,
    checkForUpdates() {
      events.push("check");
      return new Promise((resolve, reject) => checks.push({ resolve, reject }));
    },
    downloadUpdate() {
      events.push("download");
      return new Promise((resolve, reject) =>
        downloads.push({ resolve, reject }),
      );
    },
    quitAndInstall(isSilent, isForceRunAfter) {
      events.push(
        `installer:${isSilent ? "silent" : "visible"}:${isForceRunAfter ? "run-after" : "no-run"}`,
      );
      setImmediate(() => updater.scheduleQuit());
    },
    async settleCheck(result) {
      const pending = checks.shift();
      if (pending === undefined) throw new Error("no check is pending");
      if (result instanceof Error) pending.reject(result);
      else pending.resolve(result);
      await tick();
    },
    async settleDownload(error) {
      const pending = downloads.shift();
      if (pending === undefined) throw new Error("no download is pending");
      if (error === undefined) pending.resolve(["/cache/Monize-Setup.exe"]);
      else pending.reject(error);
      await tick();
    },
  };
  return updater;
}

export function available(version: string): CheckResult {
  return { isUpdateAvailable: true, updateInfo: { version } };
}

export function notAvailable(version: string): CheckResult {
  return { isUpdateAvailable: false, updateInfo: { version } };
}

export interface RecordingUi extends UpdateUi {
  /** What `confirmInstall` answers next. */
  answer: boolean;
}

export function recordingUi(events: string[]): RecordingUi {
  const ui: RecordingUi = {
    answer: true,
    upToDate: () => events.push("ui:up-to-date"),
    failed: () => events.push("ui:failed"),
    notifyDownloaded: (version) => events.push(`ui:notify:${version}`),
    confirmInstall: (version) => {
      events.push(`ui:confirm:${version}`);
      return Promise.resolve(ui.answer);
    },
  };
  return ui;
}

export interface PolicyHarness {
  readonly policy: UpdatePolicy;
  readonly updater: FakeUpdater;
  readonly ui: RecordingUi;
  readonly events: string[];
  readonly logs: string[];
}

export function policyHarness(
  overrides: Partial<UpdatePolicyDeps> = {},
): PolicyHarness {
  const events: string[] = [];
  const logs: string[] = [];
  const updater = fakeUpdater(events);
  const ui = recordingUi(events);
  const policy = createUpdatePolicy({
    updater,
    currentVersion: "1.21.0",
    ui,
    stopStack: () => {
      events.push("stop-stack");
      return Promise.resolve();
    },
    isQuitting: () => false,
    quit: () => events.push("quit"),
    beginInstall: () => events.push("begin-install"),
    log: {
      info: (message) => logs.push(`info: ${message}`),
      warn: (message) => logs.push(`warn: ${message}`),
    },
    ...overrides,
  });
  return { policy, updater, ui, events, logs };
}
