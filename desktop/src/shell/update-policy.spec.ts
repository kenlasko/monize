import {
  available,
  notAvailable,
  policyHarness,
  tick,
} from "../test-support/fake-updater";

describe("createUpdatePolicy", () => {
  it("does nothing at all when updates are off", async () => {
    const { policy, events } = policyHarness({ updater: null });
    expect(policy.state).toEqual({ kind: "disabled" });
    policy.stackReady();
    policy.menuAction();
    await policy.requestInstall();
    await tick();
    expect(events).toEqual([]);
    expect(policy.state).toEqual({ kind: "disabled" });
  });

  it("checks once after the first ready, never on a later one", async () => {
    const { policy, updater, events } = policyHarness();
    policy.stackReady();
    expect(policy.state).toEqual({ kind: "checking" });
    await updater.settleCheck(notAvailable("1.21.0"));
    policy.stackReady();
    await tick();
    expect(events).toEqual(["check"]);
    // An automatic check that found nothing says nothing.
    expect(policy.state).toEqual({ kind: "up-to-date" });
  });

  it("never starts a check while a check or a download is running", async () => {
    const { policy, updater, events } = policyHarness();
    policy.stackReady();
    policy.menuAction();
    await policy.check(true);
    expect(events).toEqual(["check"]);
    await updater.settleCheck(available("1.22.0"));
    expect(policy.state).toEqual({
      kind: "downloading",
      version: "1.22.0",
      percent: 0,
    });
    policy.menuAction();
    await tick();
    expect(events).toEqual(["check", "download"]);
  });

  it("does not check once the app is quitting", async () => {
    const { policy, events } = policyHarness({ isQuitting: () => true });
    policy.stackReady();
    await tick();
    expect(events).toEqual([]);
  });

  it("tells the person who asked that they are up to date", async () => {
    const { policy, updater, events } = policyHarness();
    policy.menuAction();
    await updater.settleCheck(notAvailable("1.21.0"));
    expect(events).toEqual(["check", "ui:up-to-date"]);
  });

  it("downloads in the background and only notifies after an automatic check", async () => {
    const { policy, updater, events, logs } = policyHarness();
    const states: string[] = [];
    policy.onChange((state) =>
      states.push(
        state.kind === "downloading"
          ? `downloading ${state.percent}`
          : state.kind,
      ),
    );
    policy.stackReady();
    await updater.settleCheck(available("1.22.0"));
    policy.progress(12.7);
    policy.progress(12.9);
    policy.progress(140);
    await updater.settleDownload();
    expect(states).toEqual([
      "checking",
      "downloading 0",
      "downloading 12",
      "downloading 100",
      "downloaded",
    ]);
    expect(events).toEqual(["check", "download", "ui:notify:1.22.0"]);
    expect(policy.state).toEqual({ kind: "downloaded", version: "1.22.0" });
    expect(logs.join("\n")).toContain("1.22.0 is downloaded");
  });

  it("asks to restart at once when the person asked for the check", async () => {
    const { policy, updater, ui, events } = policyHarness();
    ui.answer = false;
    policy.menuAction();
    await updater.settleCheck(available("1.22.0"));
    await updater.settleDownload();
    expect(events).toEqual(["check", "download", "ui:confirm:1.22.0"]);
    expect(policy.state).toEqual({ kind: "downloaded", version: "1.22.0" });
  });

  it("never installs without a yes, and the tray then offers the restart", async () => {
    const { policy, updater, ui, events } = policyHarness();
    policy.stackReady();
    await updater.settleCheck(available("1.22.0"));
    await updater.settleDownload();
    ui.answer = false;
    policy.menuAction();
    await tick();
    expect(events).not.toContain("stop-stack");
    expect(events.filter((e) => e.startsWith("installer"))).toEqual([]);

    ui.answer = true;
    policy.menuAction();
    await tick();
    expect(events.slice(-5)).toEqual([
      "ui:confirm:1.22.0",
      "begin-install",
      "stop-stack",
      "installer:visible:run-after",
      "quit",
    ]);
    expect(policy.state).toEqual({ kind: "installing", version: "1.22.0" });
  });

  it("asks only once when the notification and the tray both ask", async () => {
    const { policy, updater, events } = policyHarness();
    policy.stackReady();
    await updater.settleCheck(available("1.22.0"));
    await updater.settleDownload();
    await Promise.all([policy.requestInstall(), policy.requestInstall()]);
    expect(events.filter((e) => e.startsWith("ui:confirm"))).toHaveLength(1);
    expect(events.filter((e) => e === "stop-stack")).toHaveLength(1);
  });

  it("refuses a yes that arrives after a quit began", async () => {
    let quitting = false;
    const { policy, updater, ui, events } = policyHarness({
      isQuitting: () => quitting,
    });
    policy.stackReady();
    await updater.settleCheck(available("1.22.0"));
    await updater.settleDownload();
    ui.confirmInstall = () => {
      quitting = true;
      return Promise.resolve(true);
    };
    await policy.requestInstall();
    expect(events).not.toContain("stop-stack");
    expect(events.filter((e) => e.startsWith("installer"))).toEqual([]);
  });

  it("treats a dialog that fails as a no", async () => {
    const { policy, updater, ui, events, logs } = policyHarness();
    policy.stackReady();
    await updater.settleCheck(available("1.22.0"));
    await updater.settleDownload();
    ui.confirmInstall = () => Promise.reject(new Error("no display"));
    await policy.requestInstall();
    expect(events).not.toContain("stop-stack");
    expect(logs.join("\n")).toContain("no display");
    // And it can ask again.
    ui.confirmInstall = () => Promise.resolve(true);
    await policy.requestInstall();
    expect(events).toContain("stop-stack");
  });

  it("refuses a downgrade, the running version and a beta for a stable install", async () => {
    for (const offered of ["1.20.0", "1.21.0", "1.22.0-beta"]) {
      const { policy, updater, events, logs } = policyHarness();
      policy.menuAction();
      await updater.settleCheck(available(offered));
      expect(events).toEqual(["check", "ui:up-to-date"]);
      expect(logs.join("\n")).toContain(`${offered} refused`);
    }
  });

  it("lets a beta install take the next beta", async () => {
    const { policy, updater, events } = policyHarness({
      currentVersion: "1.21.1-beta.1",
    });
    policy.stackReady();
    await updater.settleCheck(available("1.21.1-beta.2"));
    expect(events).toEqual(["check", "download"]);
  });

  it("logs a failed automatic check without a dialog, and keeps running", async () => {
    const { policy, updater, events, logs } = policyHarness();
    policy.stackReady();
    await updater.settleCheck(
      new Error("net::ERR_INTERNET_DISCONNECTED\nstack"),
    );
    expect(events).toEqual(["check"]);
    expect(policy.state).toEqual({ kind: "error" });
    expect(logs).toEqual([
      "warn: Updates: the check failed: net::ERR_INTERNET_DISCONNECTED",
    ]);
    // The tray can try again.
    policy.menuAction();
    expect(policy.state).toEqual({ kind: "checking" });
  });

  it("shows a failed check or download only to the person who asked", async () => {
    const asked = policyHarness();
    asked.policy.menuAction();
    await asked.updater.settleCheck(new Error("404"));
    expect(asked.events).toEqual(["check", "ui:failed"]);

    const download = policyHarness();
    download.policy.stackReady();
    await download.updater.settleCheck(available("1.22.0"));
    await download.updater.settleDownload(
      new Error("sha512 checksum mismatch"),
    );
    expect(download.events).toEqual(["check", "download"]);
    expect(download.policy.state).toEqual({ kind: "error" });

    download.policy.menuAction();
    await download.updater.settleCheck(available("1.22.0"));
    await download.updater.settleDownload(
      new Error("sha512 checksum mismatch"),
    );
    expect(download.events.slice(-1)).toEqual(["ui:failed"]);
  });

  it("goes back to idle when electron-updater reports itself inactive", async () => {
    const { policy, updater } = policyHarness();
    policy.stackReady();
    await updater.settleCheck(null);
    expect(policy.state).toEqual({ kind: "idle" });
  });

  it("ignores progress outside a download", () => {
    const { policy } = policyHarness();
    policy.progress(50);
    expect(policy.state).toEqual({ kind: "idle" });
  });
});
