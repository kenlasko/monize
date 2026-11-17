import { TEXT } from "./strings";
import {
  LanTrayState,
  LoginItemState,
  TRAY_ITEM_IDS,
  trayMenuModel,
  windowMenuModel,
} from "./tray-model";
import { UpdateState } from "./update-policy";

const LAN_OFF: LanTrayState = { enabled: false, running: false, busy: false };
/** Serving, so every LAN item is available: the "all enabled" baseline. */
const LAN_ON: LanTrayState = { enabled: true, running: true, busy: false };

describe("trayMenuModel", () => {
  const items = (
    update: UpdateState,
    loginItem: LoginItemState = { enabled: false },
    lan: LanTrayState = LAN_ON,
  ) =>
    trayMenuModel({ update, loginItem, lan }).flatMap((entry) =>
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
      lan: LAN_OFF,
    }).map((entry) => (entry.type === "separator" ? "-" : entry.id));
    expect(layout).toEqual([
      "open",
      "open-in-browser",
      "-",
      "lan-access",
      "lan-setup",
      "-",
      "view-logs",
      "show-logs",
      "show-recovery-key",
      "export-recovery-key",
      "move-data-folder",
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
    const model = trayMenuModel({
      update: { kind: "idle" },
      loginItem: null,
      lan: LAN_OFF,
    });
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

  it("offers local-network access as a checkbox, and setup only while it serves", () => {
    const lan = (state: LanTrayState) =>
      items({ kind: "idle" }, { enabled: false }, state).filter((item) =>
        item.id.startsWith("lan-"),
      );
    expect(lan(LAN_OFF)).toEqual([
      expect.objectContaining({
        id: "lan-access",
        checked: false,
        enabled: true,
      }),
      expect.objectContaining({ id: "lan-setup", enabled: false }),
    ]);
    expect(lan({ enabled: true, running: true, busy: false })).toEqual([
      expect.objectContaining({
        id: "lan-access",
        checked: true,
        enabled: true,
      }),
      expect.objectContaining({ id: "lan-setup", enabled: true }),
    ]);
    // Turned on but not serving (it failed to start): setup has nothing to show.
    expect(
      lan({ enabled: true, running: false, busy: false })[1],
    ).toMatchObject({ enabled: false });
    // While a change is under way, both wait.
    for (const entry of lan({ enabled: true, running: true, busy: true })) {
      expect(entry.enabled).toBe(false);
    }
  });

  it("labels every item", () => {
    for (const item of items({ kind: "idle" })) {
      expect(item.label.length).toBeGreaterThan(0);
    }
  });

  it("offers Move data folder after the recovery-key items, always enabled", () => {
    const ids = items({ kind: "disabled" }).map((item) => item.id);
    expect(ids.indexOf("move-data-folder")).toBe(
      ids.indexOf("export-recovery-key") + 1,
    );
    expect(
      items({ kind: "disabled" }).find(
        (item) => item.id === "move-data-folder",
      ),
    ).toMatchObject({ label: TEXT.move.trayItem, enabled: true });
  });
});

describe("windowMenuModel", () => {
  const state = {
    update: { kind: "downloaded", version: "1.22.0" },
    loginItem: { enabled: true },
    lan: { enabled: true, running: true, busy: false },
  } as const;

  it("is the tray's menu without Open Monize, entry for entry", () => {
    const tray = trayMenuModel(state);
    expect(windowMenuModel(state)).toEqual(
      tray.filter((entry) => entry.type !== "item" || entry.id !== "open"),
    );
    expect(windowMenuModel(state)).toHaveLength(tray.length - 1);
  });

  it("follows the update state and the login checkbox as the tray does", () => {
    const items = windowMenuModel(state).flatMap((entry) =>
      entry.type === "item" ? [entry] : [],
    );
    expect(items.find((item) => item.id === "check-for-updates")).toMatchObject(
      { label: TEXT.trayRestartToUpdate("1.22.0"), enabled: true },
    );
    expect(items.find((item) => item.id === "start-at-login")).toMatchObject({
      checked: true,
    });
  });

  it("starts with a real item, never a separator", () => {
    expect(windowMenuModel(state)[0]).toMatchObject({
      type: "item",
      id: "open-in-browser",
    });
  });
});
