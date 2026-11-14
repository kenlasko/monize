import { TEXT } from "./strings";
import { LoginItemState, TRAY_ITEM_IDS, trayMenuModel } from "./tray-model";
import { UpdateState } from "./update-policy";

describe("trayMenuModel", () => {
  const items = (
    update: UpdateState,
    loginItem: LoginItemState = { enabled: false },
  ) =>
    trayMenuModel({ update, loginItem }).flatMap((entry) =>
      entry.type === "item" ? [entry] : [],
    );
  const updateEntry = (update: UpdateState) =>
    items(update).find((item) => item.id === "check-for-updates");

  it("lists every item once, in the plan's order, Quit last", () => {
    expect(items({ kind: "idle" }).map((item) => item.id)).toEqual([
      ...TRAY_ITEM_IDS,
    ]);
    expect(items({ kind: "idle" }).at(-1)?.label).toBe(TEXT.trayQuit);
  });

  it("orders the items and separators as the plan lays them out", () => {
    const layout = trayMenuModel({
      update: { kind: "idle" },
      loginItem: { enabled: false },
    }).map((entry) => (entry.type === "separator" ? "-" : entry.id));
    expect(layout).toEqual([
      "open",
      "open-in-browser",
      "-",
      "view-logs",
      "show-logs",
      "show-recovery-key",
      "export-recovery-key",
      "-",
      "start-at-login",
      "check-for-updates",
      "-",
      "quit",
    ]);
  });

  it("enables Check for updates when nothing is running", () => {
    for (const kind of ["idle", "up-to-date", "error"] as const) {
      expect(updateEntry({ kind })).toMatchObject({
        label: TEXT.trayCheckForUpdates,
        enabled: true,
      });
    }
    expect(items({ kind: "idle" }).every((item) => item.enabled)).toBe(true);
  });

  it("disables it when updates are off, and only it", () => {
    const disabled = items({ kind: "disabled" }).filter(
      (item) => !item.enabled,
    );
    expect(disabled.map((item) => item.id)).toEqual(["check-for-updates"]);
  });

  it("shows a check, a download and an install as running, disabled", () => {
    expect(updateEntry({ kind: "checking" })).toMatchObject({
      label: "Checking for updates...",
      enabled: false,
    });
    expect(
      updateEntry({ kind: "downloading", version: "1.22.0", percent: 42 }),
    ).toMatchObject({ label: "Downloading update... 42%", enabled: false });
    expect(
      updateEntry({ kind: "installing", version: "1.22.0" }),
    ).toMatchObject({ label: TEXT.trayInstallingUpdate, enabled: false });
  });

  it("offers the restart once the download is ready", () => {
    expect(
      updateEntry({ kind: "downloaded", version: "1.22.0" }),
    ).toMatchObject({ label: "Restart to update to 1.22.0", enabled: true });
  });

  it("offers Start at sign-in as a checkbox that follows the system", () => {
    const entry = (loginItem: LoginItemState) =>
      items({ kind: "idle" }, loginItem).find(
        (item) => item.id === "start-at-login",
      );
    expect(entry({ enabled: false })).toMatchObject({
      label: TEXT.trayStartAtLogin,
      enabled: true,
      checked: false,
    });
    expect(entry({ enabled: true })).toMatchObject({ checked: true });
  });

  it("leaves the item out where it is not offered, with no stray separator", () => {
    const model = trayMenuModel({ update: { kind: "idle" }, loginItem: null });
    const ids = model.flatMap((entry) =>
      entry.type === "item" ? [entry.id] : [],
    );
    expect(ids).not.toContain("start-at-login");
    expect(ids).toContain("check-for-updates");
    for (let i = 1; i < model.length; i++) {
      expect(
        model[i].type === "separator" && model[i - 1].type === "separator",
      ).toBe(false);
    }
  });

  it("puts the update item after the login item, then Quit", () => {
    const ids = items({ kind: "idle" }).map((item) => item.id);
    expect(ids.slice(-3)).toEqual([
      "start-at-login",
      "check-for-updates",
      "quit",
    ]);
  });

  it("labels every item", () => {
    for (const item of items({ kind: "idle" })) {
      expect(item.label.length).toBeGreaterThan(0);
    }
  });
});
