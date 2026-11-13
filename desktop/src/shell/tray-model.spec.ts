import { TEXT } from "./strings";
import { TRAY_ITEM_IDS, trayMenuModel } from "./tray-model";

describe("trayMenuModel", () => {
  const items = (updatesAvailable: boolean) =>
    trayMenuModel({ updatesAvailable }).flatMap((entry) =>
      entry.type === "item" ? [entry] : [],
    );

  it("lists every item once, in the plan's order, Quit last", () => {
    expect(items(false).map((item) => item.id)).toEqual([...TRAY_ITEM_IDS]);
    expect(items(false).at(-1)?.label).toBe(TEXT.trayQuit);
  });

  it("keeps Check for updates disabled until the updater is wired", () => {
    const disabled = items(false).filter((item) => !item.enabled);
    expect(disabled.map((item) => item.id)).toEqual(["check-for-updates"]);
    expect(items(true).every((item) => item.enabled)).toBe(true);
  });

  it("labels every item", () => {
    for (const item of items(false)) {
      expect(item.label.length).toBeGreaterThan(0);
    }
  });
});
