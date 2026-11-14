import { readFileSync } from "fs";
import { join } from "path";

import { LOG_VIEWER_CHANNELS as MAIN_CHANNELS } from "./shell/log-viewer-channels";

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

type Preload = typeof import("./log-viewer-preload");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const preload: Preload = require("./log-viewer-preload");

describe("log viewer preload", () => {
  it("keeps its copy of the channel names equal to the main process's", () => {
    expect(preload.LOG_VIEWER_CHANNELS).toEqual(MAIN_CHANNELS);
  });

  it("exposes three functions and no ipcRenderer", () => {
    expect(exposed.map(([key]) => key)).toEqual(["monizeLogs"]);
    const api = exposed[0][1] as Record<string, unknown>;
    expect(Object.keys(api).sort()).toEqual([
      "listSources",
      "readTail",
      "subscribe",
    ]);
    for (const value of Object.values(api)) {
      expect(typeof value).toBe("function");
    }
  });

  it("talks only on its own channels", async () => {
    await preload.logViewerApi.listSources();
    await preload.logViewerApi.readTail("main", 50);
    preload.logViewerApi.subscribe(() => undefined);
    expect(invoked).toEqual([
      [MAIN_CHANNELS.sources],
      [MAIN_CHANNELS.tail, "main", 50],
    ]);
    expect(listened).toEqual([MAIN_CHANNELS.tick]);
  });

  it("imports nothing but electron at runtime (it runs sandboxed)", () => {
    const source = readFileSync(
      join(__dirname, "log-viewer-preload.ts"),
      "utf8",
    );
    const imports = [...source.matchAll(/^import\s+[^;]*?from\s+"([^"]+)"/gms)];
    expect(imports.map((match) => match[1])).toEqual(["electron"]);
  });
});

describe("log viewer page", () => {
  const page = (file: string) =>
    readFileSync(join(__dirname, "log-viewer", file), "utf8");

  it("has a strict CSP and no inline script or handler", () => {
    const html = page("log-viewer.html");
    expect(html).toContain(
      "default-src 'none'; script-src 'self'; style-src 'self'",
    );
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).not.toMatch(/https?:\/\//);
  });

  it("never writes markup from data", () => {
    expect(page("log-viewer-page.ts")).not.toMatch(
      /innerHTML|outerHTML|insertAdjacentHTML|document\.write/,
    );
  });
});
