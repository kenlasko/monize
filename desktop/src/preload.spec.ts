import { readFileSync } from "fs";
import { join } from "path";

import {
  VERSION_ARG_PREFIX as MAIN_PREFIX,
  versionArgument,
} from "./shell/shell-flag";

const exposed: [string, unknown][] = [];

jest.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, value: unknown) => {
      exposed.push([key, value]);
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
  it("exposes exactly the shell flag, once (contract rule 1)", () => {
    expect(exposed).toHaveLength(1);
    const [key, value] = exposed[0];
    expect(key).toBe("__MONIZE_SHELL__");
    expect(Object.keys(value as object).sort()).toEqual(["kind", "version"]);
    expect((value as { kind: string }).kind).toBe("electron");
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
