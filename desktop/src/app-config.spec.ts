import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  AppConfig,
  ConfigError,
  configVersionOf,
  parseConfig,
  readConfig,
  serializeConfig,
  writeConfig,
  writeLanSettings,
} from "./app-config";

const VALID: AppConfig = {
  lan: null,
  ports: { frontend: 3380, backend: 3381, postgres: 5433 },
  secrets: {
    jwtSecret: { enc: "safeStorage", value: "AAAA" },
    encryptionKey: { enc: "safeStorage", value: "BBBB" },
    databasePassword: { enc: "plain", value: "CCCC" },
    databaseAppPassword: { enc: "plain", value: "DDDD" },
  },
};

const WITH_LAN: AppConfig = {
  ...VALID,
  lan: { enabled: true, port: 3382, hostname: "monize-2" },
};

function mutate(
  edit: (raw: Record<string, unknown>) => void,
  base: AppConfig = VALID,
): string {
  const raw = JSON.parse(serializeConfig(base)) as Record<string, unknown>;
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

  it("round-trips a config with local-network settings as version 2", () => {
    const text = serializeConfig(WITH_LAN);
    expect((JSON.parse(text) as { version: number }).version).toBe(2);
    expect(parseConfig(text)).toEqual(WITH_LAN);
  });

  it("still writes version 1 while local-network access was never turned on", () => {
    // An older build reads version 1 only; a person who never used the
    // feature must be able to go back to one.
    expect(configVersionOf(VALID)).toBe(1);
    const raw = JSON.parse(serializeConfig(VALID)) as Record<string, unknown>;
    expect(raw.version).toBe(1);
    expect("lan" in raw).toBe(false);
  });

  it("keeps version 2 once the feature has been turned off again", () => {
    const off: AppConfig = {
      ...VALID,
      lan: { enabled: false, port: 3382, hostname: "monize" },
    };
    expect(configVersionOf(off)).toBe(2);
    expect(parseConfig(serializeConfig(off))).toEqual(off);
  });

  it.each<[string, (raw: Record<string, unknown>) => void]>([
    ["a version 2 file without a lan block", (raw) => delete raw.lan],
    [
      "a lan port that is a loopback port",
      (raw) => ((raw.lan as Record<string, unknown>).port = 3380),
    ],
    [
      "a lan port out of range",
      (raw) => ((raw.lan as Record<string, unknown>).port = 80),
    ],
    [
      "an enabled flag that is not a boolean",
      (raw) => ((raw.lan as Record<string, unknown>).enabled = "yes"),
    ],
    [
      "a hostname that is not a DNS label",
      (raw) => ((raw.lan as Record<string, unknown>).hostname = "Monize PC"),
    ],
    [
      "an unknown lan key",
      (raw) => ((raw.lan as Record<string, unknown>).bind = "0.0.0.0"),
    ],
  ])("refuses %s", (_label, edit) => {
    expect(codeOf(mutate(edit, WITH_LAN))).toBe("invalid");
  });

  it("refuses a lan block in a version 1 file", () => {
    expect(
      codeOf(
        mutate((raw) => {
          raw.version = 1;
        }, WITH_LAN),
      ),
    ).toBe("invalid");
  });

  it("refuses text that is not JSON", () => {
    expect(codeOf("{")).toBe("not-json");
  });

  it("refuses an unknown or missing version", () => {
    expect(codeOf(mutate((raw) => (raw.version = 3)))).toBe(
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

describe("writeLanSettings", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "monize-lan-config-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("replaces only the lan block and writes version 2", async () => {
    const path = join(dir, "config.json");
    await writeConfig(path, VALID);
    const lan = { enabled: true, port: 3382, hostname: null };
    const written = await writeLanSettings(path, lan);
    expect(written).toEqual({ ...VALID, lan });
    expect(await readConfig(path)).toEqual({ ...VALID, lan });
  });

  it("refuses when there is no config to update", async () => {
    await expect(
      writeLanSettings(join(dir, "config.json"), {
        enabled: true,
        port: 3382,
        hostname: null,
      }),
    ).rejects.toBeInstanceOf(ConfigError);
  });
});
