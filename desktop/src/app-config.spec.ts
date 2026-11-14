import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  AppConfig,
  ConfigError,
  parseConfig,
  readConfig,
  serializeConfig,
  writeConfig,
} from "./app-config";

const VALID: AppConfig = {
  version: 1,
  ports: { frontend: 3380, backend: 3381, postgres: 5433 },
  secrets: {
    jwtSecret: { enc: "safeStorage", value: "AAAA" },
    encryptionKey: { enc: "safeStorage", value: "BBBB" },
    databasePassword: { enc: "plain", value: "CCCC" },
    databaseAppPassword: { enc: "plain", value: "DDDD" },
  },
};

function mutate(edit: (raw: Record<string, unknown>) => void): string {
  const raw = JSON.parse(serializeConfig(VALID)) as Record<string, unknown>;
  edit(raw);
  return JSON.stringify(raw);
}

function codeOf(text: string): string {
  try {
    parseConfig(text);
  } catch (error) {
    if (error instanceof ConfigError) return error.code;
    throw error;
  }
  return "parsed";
}

describe("parseConfig", () => {
  it("round-trips a valid config", () => {
    expect(parseConfig(serializeConfig(VALID))).toEqual(VALID);
  });

  it("refuses text that is not JSON", () => {
    expect(codeOf("{")).toBe("not-json");
  });

  it("refuses an unknown or missing version", () => {
    expect(codeOf(mutate((raw) => (raw.version = 2)))).toBe(
      "unsupported-version",
    );
    expect(codeOf(mutate((raw) => delete raw.version))).toBe(
      "unsupported-version",
    );
  });

  it.each<[string, (raw: Record<string, unknown>) => void]>([
    ["a missing ports block", (raw) => delete raw.ports],
    [
      "a missing secret",
      (raw) => delete (raw.secrets as Record<string, unknown>).encryptionKey,
    ],
    ["an unknown top-level key", (raw) => (raw.dataDir = "/x")],
    [
      "a port given as a string",
      (raw) => ((raw.ports as Record<string, unknown>).backend = "3381"),
    ],
    [
      "a privileged port",
      (raw) => ((raw.ports as Record<string, unknown>).frontend = 80),
    ],
    [
      "two equal ports",
      (raw) => ((raw.ports as Record<string, unknown>).backend = 3380),
    ],
    [
      "an unknown encoding",
      (raw) =>
        ((
          raw.secrets as Record<string, Record<string, unknown>>
        ).jwtSecret.enc = "rot13"),
    ],
    [
      "an empty secret value",
      (raw) =>
        ((
          raw.secrets as Record<string, Record<string, unknown>>
        ).jwtSecret.value = ""),
    ],
    [
      "a secret that is a string",
      (raw) => ((raw.secrets as Record<string, unknown>).jwtSecret = "abc"),
    ],
    [
      "an empty object",
      (raw) => Object.keys(raw).forEach((k) => delete raw[k]),
    ],
  ])("refuses %s", (_label, edit) => {
    expect(["invalid", "unsupported-version"]).toContain(codeOf(mutate(edit)));
  });

  it("names the offending key", () => {
    expect(() =>
      parseConfig(
        mutate(
          (raw) =>
            delete (raw.secrets as Record<string, unknown>).databasePassword,
        ),
      ),
    ).toThrow("secrets.databasePassword is missing");
  });
});

describe("readConfig / writeConfig", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "monize-config-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when the file does not exist", async () => {
    expect(await readConfig(join(dir, "config.json"))).toBeNull();
  });

  it("reads back exactly what was written", async () => {
    const path = join(dir, "config.json");
    await writeConfig(path, VALID);
    expect(await readConfig(path)).toEqual(VALID);
  });

  it("throws, never defaults, on a damaged file", async () => {
    const path = join(dir, "config.json");
    writeFileSync(path, '{"version":1}');
    await expect(readConfig(path)).rejects.toThrow(ConfigError);
  });

  it("reports an unreadable path as a typed error", async () => {
    await expect(readConfig(dir)).rejects.toMatchObject({ code: "unreadable" });
  });
});
