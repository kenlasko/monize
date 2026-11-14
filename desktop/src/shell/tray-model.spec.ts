import { TEXT } from "./strings";
import { TRAY_ITEM_IDS, trayMenuModel } from "./tray-model";
import { UpdateState } from "./update-policy";

describe("trayMenuModel", () => {
  const items = (update: UpdateState) =>
    trayMenuModel({ update }).flatMap((entry) =>
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

  it("labels every item", () => {
    for (const item of items({ kind: "idle" })) {
      expect(item.label.length).toBeGreaterThan(0);
    }
  });

  it("offers Move data folder beside the recovery key, always enabled", () => {
    const ids = items({ kind: "disabled" }).map((item) => item.id);
    expect(ids.indexOf("move-data-folder")).toBe(
      ids.indexOf("show-recovery-key") + 1,
    );
    expect(
      items({ kind: "disabled" }).find(
        (item) => item.id === "move-data-folder",
      ),
    ).toMatchObject({ label: TEXT.move.trayItem, enabled: true });
  });
});
