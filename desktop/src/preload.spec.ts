import { readFileSync } from "fs";
import { join } from "path";

import {
  NOTIFICATIONS_CHANNEL as MAIN_CHANNEL,
  NOTIFICATIONS_KEY as MAIN_KEY,
} from "./shell/notification-snapshot";
import {
  SHELL_MENU_CHANNEL as MAIN_MENU_CHANNEL,
  SHELL_MENU_KEY as MAIN_MENU_KEY,
} from "./shell/shell-menu";
import {
  VERSION_ARG_PREFIX as MAIN_PREFIX,
  versionArgument,
} from "./shell/shell-flag";

const exposed: [string, unknown][] = [];
const sent: unknown[][] = [];

jest.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, value: unknown) => {
      exposed.push([key, value]);
    },
  },
  ipcRenderer: {
    send: (channel: string, ...args: unknown[]) => {
      sent.push([channel, ...args]);
    },
  },
}));

// Loaded after the mock, so the module's one exposeInMainWorld call is seen.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const preload = require("./preload") as typeof import("./preload");

/** A sandboxed preload may load only these; a local import would fail at runtime. */
function runtimeImports(file: string): string[] {
  const source = readFileSync(join(__dirname, file), "utf8");
  return [
    ...source.matchAll(/^import\s+(?!type\b)[^;]*?from\s+"([^"]+)"/gms),
  ].map((match) => match[1]);
}

describe("preload", () => {
  beforeEach(() => {
    sent.length = 0;
  });

  it("exposes exactly the shell flag, the notification bridge and the shell menu, once each", () => {
    expect(exposed.map(([key]) => key)).toEqual([
      "__MONIZE_SHELL__",
      "__MONIZE_SHELL_NOTIFICATIONS__",
      "__MONIZE_SHELL_MENU__",
    ]);
    const [, flag] = exposed[0];
    expect(Object.keys(flag as object).sort()).toEqual(["kind", "version"]);
    expect((flag as { kind: string }).kind).toBe("electron");
    const [, bridge] = exposed[1];
    expect(Object.keys(bridge as object)).toEqual(["publish"]);
  });

  it("asks for the shell menu on its channel, carrying nothing", () => {
    const [, menu] = exposed[2];
    expect(Object.keys(menu as object)).toEqual(["open"]);
    (menu as { open(...args: unknown[]): void }).open({ x: 1 });
    expect(sent).toEqual([["monize:shell-menu"]]);
  });

  it("never throws into the page when the menu request cannot be sent", () => {
    const menu = preload.shellMenuBridgeFor(() => {
      throw new Error("The render frame was disposed.");
    });
    expect(() => menu.open()).not.toThrow();
  });

  it("sends a published snapshot on the bridge's channel and nothing more", () => {
    const [, bridge] = exposed[1];
    const snapshot = { identity: null, rows: [] };
    (bridge as { publish(value: unknown): void }).publish(snapshot);
    expect(sent).toEqual([["monize:notifications", snapshot]]);
  });

  it("never throws into the page when IPC cannot send a value", () => {
    const bridge = preload.notificationBridgeFor(() => {
      throw new Error("An object could not be cloned.");
    });
    expect(() => bridge.publish({ f: () => 1 })).not.toThrow();
  });

  it("keeps its copies of the bridge's key and channel equal to the main process's", () => {
    expect(preload.NOTIFICATIONS_KEY).toBe(MAIN_KEY);
    expect(preload.NOTIFICATIONS_CHANNEL).toBe(MAIN_CHANNEL);
    expect(preload.SHELL_MENU_KEY).toBe(MAIN_MENU_KEY);
    expect(preload.SHELL_MENU_CHANNEL).toBe(MAIN_MENU_CHANNEL);
  });

  it("reads back the version the main process passes", () => {
    expect(
      preload.shellFlagFrom(["electron", versionArgument("1.21.0")]),
    ).toEqual({ kind: "electron", version: "1.21.0" });
    expect(
      preload.shellFlagFrom([versionArgument("2.0.0-beta.1+build.5")]).version,
    ).toBe("2.0.0-beta.1+build.5");
  });

  it("answers an empty version when there is none or it is odd", () => {
    expect(preload.shellFlagFrom(["electron"]).version).toBe("");
    expect(preload.shellFlagFrom([`${MAIN_PREFIX}<script>`]).version).toBe("");
    expect(
      preload.shellFlagFrom([versionArgument("bad version")]).version,
    ).toBe("");
    expect(
      preload.shellFlagFrom([`${MAIN_PREFIX}${"1".repeat(65)}`]).version,
    ).toBe("");
  });

  it("keeps its copy of the prefix equal to the main process's", () => {
    expect(preload.VERSION_ARG_PREFIX).toBe(MAIN_PREFIX);
  });

  it("imports nothing but electron at runtime (it runs sandboxed)", () => {
    expect(runtimeImports("preload.ts")).toEqual(["electron"]);
  });
});
