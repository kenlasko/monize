import { readFileSync } from "fs";
import { join } from "path";

import { SPLASH_CHANNELS as MAIN_CHANNELS } from "./shell/splash-channels";

const exposed: [string, unknown][] = [];
const sent: string[] = [];
const listened: string[] = [];

jest.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, value: unknown) => {
      exposed.push([key, value]);
    },
  },
  ipcRenderer: {
    send: (channel: string) => sent.push(channel),
    on: (channel: string) => listened.push(channel),
  },
}));

// Loaded after the mock, so the module's one exposeInMainWorld call is seen.
type SplashPreload = typeof import("./splash-preload");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const splashPreload: SplashPreload = require("./splash-preload");

describe("splash preload", () => {
  it("keeps its copy of the channel names equal to the main process's", () => {
    expect(splashPreload.SPLASH_CHANNELS).toEqual(MAIN_CHANNELS);
  });

  it("exposes three functions and no ipcRenderer", () => {
    expect(exposed.map(([key]) => key)).toEqual(["monizeSplash"]);
    const api = exposed[0][1] as Record<string, unknown>;
    expect(Object.keys(api).sort()).toEqual(["onView", "quit", "retry"]);
    for (const value of Object.values(api)) {
      expect(typeof value).toBe("function");
    }
  });

  it("sends only on its own channels", () => {
    splashPreload.splashApi.retry();
    splashPreload.splashApi.quit();
    splashPreload.splashApi.onView(() => undefined);
    expect(sent).toEqual([MAIN_CHANNELS.retry, MAIN_CHANNELS.quit]);
    expect(listened).toEqual([MAIN_CHANNELS.view]);
  });

  it("imports nothing but electron at runtime (it runs sandboxed)", () => {
    const source = readFileSync(join(__dirname, "splash-preload.ts"), "utf8");
    const imports = [...source.matchAll(/^import\s+[^;]*?from\s+"([^"]+)"/gms)];
    expect(imports.map((match) => match[1])).toEqual(["electron"]);
  });
});

describe("splash page", () => {
  const page = (file: string) =>
    readFileSync(join(__dirname, "splash", file), "utf8");

  it("has a strict CSP and no inline script or handler", () => {
    const html = page("splash.html");
    expect(html).toContain(
      "default-src 'none'; script-src 'self'; style-src 'self'",
    );
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).not.toMatch(/https?:\/\//);
  });

  it("never writes markup from data", () => {
    expect(page("splash-page.ts")).not.toMatch(
      /innerHTML|outerHTML|insertAdjacentHTML|document\.write/,
    );
  });
});
