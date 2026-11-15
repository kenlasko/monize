import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { ConfigError, readConfig, serializeConfig } from "./app-config";
import { DataPaths, dataPathsFor } from "./app-paths";
import { loadOrCreateConfig } from "./config-bootstrap";
import { PortProber } from "./ports";
import { SecretError, SecretPolicy } from "./secrets";
import { fakeSafeStorage } from "./test-support/fake-safe-storage";

const SECURE: SecretPolicy = {
  safeStorage: fakeSafeStorage(true),
  allowInsecure: false,
};
const allFree: PortProber = async () => true;
const busy =
  (...ports: number[]): PortProber =>
  async (port) =>
    !ports.includes(port);

describe("loadOrCreateConfig", () => {
  let root: string;
  let paths: DataPaths;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "monize-bootstrap-"));
    paths = dataPathsFor(join(root, "Monize"), process.platform);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("creates the data tree, the secrets and the config on first run", async () => {
    const result = await loadOrCreateConfig({
      paths,
      policy: SECURE,
      probe: allFree,
    });
    expect(result.firstRun).toBe(true);
    expect(result.movedPorts).toEqual([]);
    for (const dir of [
      paths.pgdata,
      paths.backups,
      paths.attachments,
      paths.logs,
    ]) {
      expect(statSync(dir).isDirectory()).toBe(true);
    }
    const onDisk = readFileSync(paths.configFile, "utf8");
    for (const secret of Object.values(result.secrets)) {
      expect(secret).toMatch(/^[A-Za-z0-9_-]{64}$/);
      expect(onDisk).not.toContain(secret);
    }
    expect(onDisk).not.toContain("dataDir");
  });

  it("reads back identically on the next run", async () => {
    const first = await loadOrCreateConfig({
      paths,
      policy: SECURE,
      probe: allFree,
    });
    const before = readFileSync(paths.configFile, "utf8");
    const second = await loadOrCreateConfig({
      paths,
      policy: SECURE,
      probe: allFree,
    });
    expect(second.firstRun).toBe(false);
    expect(second.secrets).toEqual(first.secrets);
    expect(second.config).toEqual(first.config);
    expect(readFileSync(paths.configFile, "utf8")).toBe(before);
  });

  it("moves a busy persisted port, persists it and reports it", async () => {
    await loadOrCreateConfig({ paths, policy: SECURE, probe: allFree });
    const result = await loadOrCreateConfig({
      paths,
      policy: SECURE,
      probe: busy(3380),
    });
    expect(result.movedPorts).toEqual(["frontend"]);
    expect(result.config.ports.frontend).toBe(3382);
    expect((await readConfig(paths.configFile))?.ports.frontend).toBe(3382);
  });

  it("refuses to regenerate when config.json is gone but pgdata holds data", async () => {
    mkdirSync(paths.pgdata, { recursive: true });
    writeFileSync(join(paths.pgdata, "PG_VERSION"), "16\n");
    const attempt = loadOrCreateConfig({
      paths,
      policy: SECURE,
      probe: allFree,
    });
    await expect(attempt).rejects.toMatchObject({ code: "damaged-install" });
    await expect(attempt).rejects.toThrow(ConfigError);
    expect(existsSync(paths.configFile)).toBe(false);
  });

  it("treats an empty pgdata as a first run", async () => {
    mkdirSync(paths.pgdata, { recursive: true });
    const result = await loadOrCreateConfig({
      paths,
      policy: SECURE,
      probe: allFree,
    });
    expect(result.firstRun).toBe(true);
  });

  it("fails closed when a secret is missing from the config", async () => {
    await loadOrCreateConfig({ paths, policy: SECURE, probe: allFree });
    const raw = JSON.parse(readFileSync(paths.configFile, "utf8"));
    delete raw.secrets.encryptionKey;
    writeFileSync(paths.configFile, JSON.stringify(raw));
    await expect(
      loadOrCreateConfig({ paths, policy: SECURE, probe: allFree }),
    ).rejects.toThrow("secrets.encryptionKey is missing");
    expect(readFileSync(paths.configFile, "utf8")).toBe(JSON.stringify(raw));
  });

  it("fails closed when a secret does not decrypt", async () => {
    const created = await loadOrCreateConfig({
      paths,
      policy: SECURE,
      probe: allFree,
    });
    const damaged = {
      ...created.config,
      secrets: {
        ...created.config.secrets,
        databasePassword: {
          enc: "safeStorage" as const,
          value: Buffer.from("garbage").toString("base64"),
        },
      },
    };
    writeFileSync(paths.configFile, serializeConfig(damaged));
    const attempt = loadOrCreateConfig({
      paths,
      policy: SECURE,
      probe: allFree,
    });
    await expect(attempt).rejects.toThrow(SecretError);
    await expect(attempt).rejects.toMatchObject({
      code: "decrypt-failed",
      secretName: "databasePassword",
    });
  });

  it("creates nothing when secrets cannot be stored safely", async () => {
    const strictNoOs: SecretPolicy = {
      safeStorage: fakeSafeStorage(false),
      allowInsecure: false,
    };
    await expect(
      loadOrCreateConfig({ paths, policy: strictNoOs, probe: allFree }),
    ).rejects.toMatchObject({ code: "insecure-not-allowed" });
    expect(existsSync(paths.dataDir)).toBe(false);
  });

  it("stores plaintext secrets only under the insecure policy", async () => {
    const insecure: SecretPolicy = {
      safeStorage: fakeSafeStorage(false),
      allowInsecure: true,
    };
    const result = await loadOrCreateConfig({
      paths,
      policy: insecure,
      probe: allFree,
    });
    expect(result.config.secrets.jwtSecret.enc).toBe("plain");
    await expect(
      loadOrCreateConfig({ paths, policy: SECURE, probe: allFree }),
    ).rejects.toMatchObject({ code: "insecure-not-allowed" });
  });

  it("refuses a generator that repeats itself", async () => {
    await expect(
      loadOrCreateConfig({
        paths,
        policy: SECURE,
        probe: allFree,
        generate: () => "x".repeat(64),
      }),
    ).rejects.toThrow(/same value/);
  });
});
