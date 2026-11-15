import type { MenuItemConstructorOptions } from "electron";

import { TEXT } from "./shell/strings";
import { TrayItemId, TrayState } from "./shell/tray-model";
import { memoryLogger } from "./test-support/memory-logger";
import { TrayHandlers } from "./tray";

interface FakeMenu {
  readonly template: MenuItemConstructorOptions[];
  readonly popup: jest.Mock;
}

const built: FakeMenu[] = [];
const applied: FakeMenu[] = [];
const listeners = new Map<string, (event: unknown) => void>();

jest.mock("electron", () => ({
  Menu: {
    buildFromTemplate: (template: MenuItemConstructorOptions[]) => {
      const menu = { template, popup: jest.fn() };
      built.push(menu);
      return menu;
    },
    setApplicationMenu: (menu: FakeMenu) => applied.push(menu),
  },
  ipcMain: {
    on: (channel: string, listener: (event: unknown) => void) =>
      listeners.set(channel, listener),
    removeListener: (channel: string) => listeners.delete(channel),
  },
  // tray.ts is imported for menuTemplate; its Tray is never constructed here.
  nativeImage: {},
  Tray: class {},
}));

// Loaded after the mock (jest hoists jest.mock above the imports anyway).
const windowMenus =
  jest.requireActual<typeof import("./window-menus")>("./window-menus");
const { applicationMenuTemplate, createWindowMenus } = windowMenus;

const ORIGIN = "http://127.0.0.1:43123";
const CHANNEL = "monize:shell-menu";

function setup(state: TrayState = idle()) {
  built.length = 0;
  applied.length = 0;
  listeners.clear();
  const contents = { id: "main" };
  const window = {
    isDestroyed: () => false,
    webContents: contents,
  };
  const clicked: TrayItemId[] = [];
  const handlers = new Proxy({} as TrayHandlers, {
    get: (_target, id: TrayItemId) => () => clicked.push(id),
  });
  const logger = memoryLogger();
  const warnings = () =>
    logger.records.filter((record) => record.level === "warn");
  const menus = createWindowMenus({
    origin: ORIGIN,
    logger,
    window: window as never,
    state,
    handlers,
  });
  const request = (sender: unknown, frameUrl: string) =>
    listeners.get(CHANNEL)?.({ sender, senderFrame: { url: frameUrl } });
  return { menus, contents, window, clicked, warnings, request };
}

function idle(): TrayState {
  return { update: { kind: "idle" }, loginItem: { enabled: false } };
}

function monizeMenu(menu: FakeMenu): MenuItemConstructorOptions[] {
  const entry = menu.template[0];
  expect(entry.label).toBe(TEXT.appMenuMonize);
  return entry.submenu as MenuItemConstructorOptions[];
}

const ids = (items: MenuItemConstructorOptions[]) =>
  items.map((item) => item.id ?? item.type);

describe("applicationMenuTemplate", () => {
  it("puts the Monize menu first, then Electron's Edit, View and Window menus", () => {
    const items: MenuItemConstructorOptions[] = [{ id: "quit" }];
    const template = applicationMenuTemplate(items);
    expect(template[0]).toEqual({ label: "&Monize", submenu: items });
    expect(template.slice(1).map((entry) => entry.role)).toEqual([
      "editMenu",
      "viewMenu",
      "windowMenu",
    ]);
  });

  it("falls back to Electron's File menu without the Monize items", () => {
    expect(applicationMenuTemplate(null).map((entry) => entry.role)).toEqual([
      "fileMenu",
      "editMenu",
      "viewMenu",
      "windowMenu",
    ]);
  });
});

describe("createWindowMenus", () => {
  it("sets a menu bar whose Monize menu holds the tray's items but Open Monize", () => {
    setup();
    expect(applied).toHaveLength(1);
    const items = monizeMenu(applied[0]);
    expect(ids(items)).toEqual([
      "open-in-browser",
      "separator",
      "view-logs",
      "show-logs",
      "show-recovery-key",
      "export-recovery-key",
      "move-data-folder",
      "separator",
      "start-at-login",
      "check-for-updates",
      "separator",
      "quit",
    ]);
  });

  it("runs the tray's own handler for a menu bar item", () => {
    const { clicked } = setup();
    const quit = monizeMenu(applied[0]).find((item) => item.id === "quit");
    (quit?.click as () => void)();
    expect(clicked).toEqual(["quit"]);
  });

  it("pops the same items up in the window for the main window's page", () => {
    const { contents, window, request } = setup();
    request(contents, `${ORIGIN}/dashboard`);
    const popup = built.at(-1);
    expect(popup?.popup).toHaveBeenCalledWith({ window });
    expect(popup?.template.map((item) => item.id ?? item.type)).toEqual(
      ids(monizeMenu(applied[0])),
    );
  });

  it("ignores a request from another window or another origin", () => {
    const { contents, warnings, request } = setup();
    const before = built.length;
    request({ id: "log-viewer" }, `${ORIGIN}/`);
    request(contents, "https://example.com/");
    expect(built).toHaveLength(before);
    expect(warnings()).toHaveLength(2);
  });

  it("rebuilds the menu bar and the popup from the latest state", () => {
    const { menus, contents, request } = setup();
    menus.setState({
      update: { kind: "downloaded", version: "1.22.0" },
      loginItem: { enabled: true },
    });
    const update = (items: MenuItemConstructorOptions[]) =>
      items.find((item) => item.id === "check-for-updates")?.label;
    expect(applied).toHaveLength(2);
    expect(update(monizeMenu(applied[1]))).toBe(
      TEXT.trayRestartToUpdate("1.22.0"),
    );
    request(contents, `${ORIGIN}/`);
    expect(update(built.at(-1)?.template ?? [])).toBe(
      TEXT.trayRestartToUpdate("1.22.0"),
    );
  });

  it("drops the Monize items and stops answering once stopped", () => {
    const { menus, contents, request } = setup();
    menus.stop();
    expect(applied.at(-1)?.template[0]).toEqual({ role: "fileMenu" });
    expect(listeners.has(CHANNEL)).toBe(false);
    const before = applied.length;
    menus.setState(idle());
    menus.stop();
    expect(applied).toHaveLength(before);
    request(contents, `${ORIGIN}/`);
    expect(built.at(-1)?.popup).not.toHaveBeenCalled();
  });
});
