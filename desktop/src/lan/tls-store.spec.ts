import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { SecretError, SecretPolicy } from "../secrets";
import { fakeSafeStorage } from "../test-support/fake-safe-storage";
import {
  loadOrCreateTls,
  replaceTls,
  TLS_FILES,
  TlsStoreError,
  TlsStoreOptions,
} from "./tls-store";

const SECURE: SecretPolicy = {
  safeStorage: fakeSafeStorage(true),
  allowInsecure: false,
};
const NOW = new Date("2026-11-17T12:00:00Z");

describe("loadOrCreateTls", () => {
  let dir: string;
  let options: TlsStoreOptions;

  beforeEach(() => {
    dir = join(mkdtempSync(join(tmpdir(), "monize-tls-")), "tls");
    options = {
      dir,
      policy: SECURE,
      computerName: "DESKTOP-1",
      names: { dns: ["monize.local"], ip: ["192.168.1.23"] },
      now: NOW,
    };
  });
  afterEach(() => rmSync(join(dir, ".."), { recursive: true, force: true }));

  it("creates the root and a server certificate on first use", async () => {
    const result = await loadOrCreateTls(options);
    expect(result.createdRoot).toBe(true);
    expect(result.issued).toBe("missing");
    expect(result.material.rootFingerprint).toMatch(/^[0-9A-F:]+$/);
    expect(result.material.rootDer[0]).toBe(0x30);
  });

  it("never writes a private key unwrapped", async () => {
    const { material } = await loadOrCreateTls(options);
    for (const file of [TLS_FILES.rootKey, TLS_FILES.serverKey]) {
      const text = readFileSync(join(dir, file), "utf8");
      expect(text).not.toContain("PRIVATE KEY");
      expect(JSON.parse(text)).toMatchObject({ enc: "safeStorage" });
    }
    expect(readFileSync(join(dir, TLS_FILES.rootCert), "utf8")).toBe(
      material.rootCertPem,
    );
  });

  it("keeps both certificates on the next start", async () => {
    const first = await loadOrCreateTls(options);
    const second = await loadOrCreateTls(options);
    expect(second.createdRoot).toBe(false);
    expect(second.issued).toBeNull();
    expect(second.material.rootFingerprint).toBe(
      first.material.rootFingerprint,
    );
    expect(second.material.server.certPem).toBe(first.material.server.certPem);
  });

  it("reissues the server certificate, not the root, when an address changes", async () => {
    const first = await loadOrCreateTls(options);
    const moved = await loadOrCreateTls({
      ...options,
      names: { dns: ["monize.local"], ip: ["192.168.1.40"] },
    });
    expect(moved.createdRoot).toBe(false);
    expect(moved.issued).toBe("names-changed");
    expect(moved.material.rootFingerprint).toBe(first.material.rootFingerprint);
    expect(moved.material.server.certPem).not.toBe(
      first.material.server.certPem,
    );
  });

  it("reissues a damaged server certificate", async () => {
    await loadOrCreateTls(options);
    writeFileSync(join(dir, TLS_FILES.serverKey), "{not json");
    const result = await loadOrCreateTls(options);
    expect(result.createdRoot).toBe(false);
    expect(result.issued).toBe("missing");
  });

  it("refuses, rather than replacing, a root whose key is missing", async () => {
    await loadOrCreateTls(options);
    rmSync(join(dir, TLS_FILES.rootKey));
    await expect(loadOrCreateTls(options)).rejects.toBeInstanceOf(
      TlsStoreError,
    );
  });

  it("refuses a root key that does not decrypt for this account", async () => {
    await loadOrCreateTls(options);
    await expect(
      loadOrCreateTls({
        ...options,
        policy: { safeStorage: fakeSafeStorage(false), allowInsecure: false },
      }),
    ).rejects.toBeInstanceOf(SecretError);
  });

  it("replaces the root on request", async () => {
    const first = await loadOrCreateTls(options);
    const replaced = await replaceTls(options);
    expect(replaced.createdRoot).toBe(true);
    expect(replaced.material.rootFingerprint).not.toBe(
      first.material.rootFingerprint,
    );
    const next = await loadOrCreateTls(options);
    expect(next.issued).toBeNull();
    expect(next.material.rootFingerprint).toBe(
      replaced.material.rootFingerprint,
    );
  });
});
