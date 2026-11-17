import { readFileSync } from "fs";
import { join } from "path";

import { LAN_SETUP_CHANNELS as MAIN_CHANNELS } from "./shell/lan-setup-channels";

const exposed: [string, unknown][] = [];
const invoked: unknown[][] = [];
const listened: string[] = [];

jest.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, value: unknown) => {
      exposed.push([key, value]);
    },
  },
  ipcRenderer: {
    invoke: (...args: unknown[]) => {
      invoked.push(args);
      return Promise.resolve(null);
    },
    on: (channel: string) => listened.push(channel),
  },
}));

type Preload = typeof import("./lan-setup-preload");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const preload: Preload = require("./lan-setup-preload");

describe("device setup preload", () => {
  it("keeps its copy of the channel names equal to the main process's", () => {
    expect(preload.LAN_SETUP_CHANNELS).toEqual(MAIN_CHANNELS);
  });

  it("exposes four functions and no ipcRenderer", () => {
    expect(exposed.map(([key]) => key)).toEqual(["monizeLanSetup"]);
    const api = exposed[0][1] as Record<string, unknown>;
    expect(Object.keys(api).sort()).toEqual([
      "replaceRoot",
      "saveRoot",
      "subscribe",
      "view",
    ]);
    for (const value of Object.values(api)) {
      expect(typeof value).toBe("function");
    }
  });

  it("talks only on its own channels, and sends the main process no argument", async () => {
    await preload.lanSetupApi.view();
    await preload.lanSetupApi.saveRoot();
    await preload.lanSetupApi.replaceRoot();
    preload.lanSetupApi.subscribe(() => undefined);
    expect(invoked).toEqual([
      [MAIN_CHANNELS.view],
      [MAIN_CHANNELS.saveRoot],
      [MAIN_CHANNELS.replaceRoot],
    ]);
    expect(listened).toEqual([MAIN_CHANNELS.changed]);
  });

  it("imports nothing but electron at runtime (it runs sandboxed)", () => {
    const source = readFileSync(
      join(__dirname, "lan-setup-preload.ts"),
      "utf8",
    );
    const imports = [...source.matchAll(/^import\s+[^;]*?from\s+"([^"]+)"/gms)];
    expect(imports.map((match) => match[1])).toEqual(["electron"]);
  });
});

describe("device setup page", () => {
  const page = (file: string) =>
    readFileSync(join(__dirname, "lan-setup", file), "utf8");

  it("has a strict CSP, images from data: only, and no inline script or handler", () => {
    const html = page("lan-setup.html");
    expect(html).toContain(
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src data:",
    );
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).not.toMatch(/https?:\/\//);
  });

  it("never writes markup from data", () => {
    expect(page("lan-setup-page.ts")).not.toMatch(
      /innerHTML|outerHTML|insertAdjacentHTML|document\.write/,
    );
  });
});
