import { mkdtempSync, rmSync } from "fs";
import { NetworkInterfaceInfo, tmpdir } from "os";
import { join } from "path";

import { AppConfig, LanSettings, readConfig, writeConfig } from "../app-config";
import { SecretPolicy } from "../secrets";
import { fakeSafeStorage } from "../test-support/fake-safe-storage";
import { InterfaceTable } from "./addresses";
import { LanProxy, LanProxyOptions } from "./lan-proxy";
import { createLanService, LanService, LanServiceDeps } from "./lan-service";
import { MdnsResponder } from "./mdns";

const POLICY: SecretPolicy = {
  safeStorage: fakeSafeStorage(true),
  allowInsecure: false,
};
const PORTS = { frontend: 3380, backend: 3381, postgres: 5433 };

const CONFIG: AppConfig = {
  ports: PORTS,
  lan: null,
  secrets: {
    jwtSecret: { enc: "plain", value: "AAAA" },
    encryptionKey: { enc: "plain", value: "BBBB" },
    databasePassword: { enc: "plain", value: "CCCC" },
    databaseAppPassword: { enc: "plain", value: "DDDD" },
  },
};

function wifi(address: string): InterfaceTable {
  const entry: NetworkInterfaceInfo = {
    address,
    netmask: "255.255.255.0",
    family: "IPv4",
    mac: "00:00:00:00:00:00",
    internal: false,
    cidr: `${address}/24`,
  };
  return { "Wi-Fi": [entry] };
}

interface Fakes {
  proxyOptions: LanProxyOptions | null;
  proxyClosed: number;
  credentials: { cert: string; key: string }[];
  responderClosed: number;
  refreshed: number;
  table: InterfaceTable;
  proxyFails: boolean;
  mdnsFails: boolean;
}

function fakeDeps(fakes: Fakes): Partial<LanServiceDeps> {
  return {
    interfaces: () => fakes.table,
    hostname: () => "DESKTOP-1",
    now: () => new Date("2026-11-17T12:00:00Z"),
    probe: async () => true,
    watchIntervalMs: 10,
    startProxy: async (options) => {
      if (fakes.proxyFails) throw new Error("EADDRINUSE: port 3382");
      fakes.proxyOptions = options;
      const proxy: LanProxy = {
        port: options.port,
        setCredentials: (tls) => {
          fakes.credentials.push({ ...tls });
        },
        close: async () => {
          fakes.proxyClosed += 1;
        },
      };
      return proxy;
    },
    startResponder: async ({ candidates }) => {
      if (fakes.mdnsFails) throw new Error("bind EADDRINUSE 0.0.0.0:5353");
      const responder: MdnsResponder = {
        label: candidates[0] as string,
        refresh: async () => {
          fakes.refreshed += 1;
        },
        close: async () => {
          fakes.responderClosed += 1;
        },
      };
      return responder;
    },
  };
}

/** Resolves once `condition` holds; a spec fails on its timeout otherwise. */
async function until(condition: () => boolean): Promise<void> {
  while (!condition()) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("createLanService", () => {
  let root: string;
  let fakes: Fakes;
  const logs: string[] = [];

  function service(settings: LanSettings | null = null): LanService {
    return createLanService({
      configFile: join(root, "config.json"),
      tlsDir: join(root, "tls"),
      policy: POLICY,
      ports: PORTS,
      settings,
      logger: {
        info: (message) => logs.push(message),
        warn: (message) => logs.push(message),
      },
      deps: fakeDeps(fakes),
    });
  }

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "monize-lan-service-"));
    await writeConfig(join(root, "config.json"), CONFIG);
    fakes = {
      proxyOptions: null,
      proxyClosed: 0,
      credentials: [],
      responderClosed: 0,
      refreshed: 0,
      table: wifi("192.168.1.23"),
      proxyFails: false,
      mdnsFails: false,
    };
    logs.length = 0;
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("turns on, remembers it, and lists the addresses best first", async () => {
    const lan = service();
    await lan.enable();
    expect(lan.status).toMatchObject({
      kind: "on",
      port: 3382,
      label: "monize",
      mdnsProblem: null,
      urls: [
        "https://monize.local:3382",
        "https://desktop-1.local:3382",
        "https://192.168.1.23:3382",
      ],
      downloadUrls: ["http://192.168.1.23:3382/monize-root.crt"],
    });
    expect((await readConfig(join(root, "config.json")))?.lan).toEqual({
      enabled: true,
      port: 3382,
      hostname: "monize",
    });
    await lan.stop();
  });

  it("fronts the frontend's loopback port with the window's origin, and nothing else", async () => {
    const lan = service();
    await lan.enable();
    const options = fakes.proxyOptions as LanProxyOptions;
    expect(options.upstreamPort).toBe(PORTS.frontend);
    expect(options.upstreamOrigin).toBe("http://127.0.0.1:3380");
    expect(options.isAllowedHost("monize.local:3382")).toBe(true);
    expect(options.isAllowedHost("192.168.1.23:3382")).toBe(true);
    expect(options.isAllowedHost("evil.example:3382")).toBe(false);
    expect(options.isAllowedPeer("192.168.1.77")).toBe(true);
    expect(options.isAllowedPeer("8.8.8.8")).toBe(false);
    await lan.stop();
  });

  it("serves the root over plain HTTP only while setup is open", async () => {
    const lan = service();
    await lan.enable();
    const options = fakes.proxyOptions as LanProxyOptions;
    expect(options.rootDer()).toBeNull();
    lan.setSetupOpen(true);
    expect(options.rootDer()?.[0]).toBe(0x30);
    lan.setSetupOpen(false);
    expect(options.rootDer()).toBeNull();
    await lan.stop();
  });

  it("turns off, stops everything, and keeps the port and name for next time", async () => {
    const lan = service();
    await lan.enable();
    await lan.disable();
    expect(lan.status).toEqual({ kind: "off" });
    expect(fakes.proxyClosed).toBe(1);
    expect(fakes.responderClosed).toBe(1);
    expect((await readConfig(join(root, "config.json")))?.lan).toEqual({
      enabled: false,
      port: 3382,
      hostname: "monize",
    });
  });

  it("starts at launch only when it was left on", async () => {
    await service({
      enabled: false,
      port: 3382,
      hostname: "monize",
    }).startIfEnabled();
    expect(fakes.proxyOptions).toBeNull();
    const lan = service({ enabled: true, port: 3390, hostname: "monize-2" });
    await lan.startIfEnabled();
    expect(lan.status).toMatchObject({
      kind: "on",
      port: 3390,
      label: "monize-2",
    });
    await lan.stop();
  });

  it("still serves the addresses when the mDNS name cannot be had", async () => {
    fakes.mdnsFails = true;
    const lan = service({ enabled: false, port: 3382, hostname: "monize" });
    await lan.enable();
    expect(lan.status).toMatchObject({
      kind: "on",
      label: null,
      urls: ["https://desktop-1.local:3382", "https://192.168.1.23:3382"],
    });
    expect((lan.status as { mdnsProblem: string }).mdnsProblem).toContain(
      "5353",
    );
    // The name claimed before is kept for the next try.
    expect((await readConfig(join(root, "config.json")))?.lan?.hostname).toBe(
      "monize",
    );
    await lan.stop();
  });

  it("reports a listener that cannot start, and remembers nothing", async () => {
    fakes.proxyFails = true;
    const lan = service();
    await expect(lan.enable()).rejects.toThrow(/EADDRINUSE/);
    expect(lan.status).toEqual({
      kind: "failed",
      message: "EADDRINUSE: port 3382",
    });
    expect(fakes.responderClosed).toBe(1);
    expect((await readConfig(join(root, "config.json")))?.lan).toBeNull();
  });

  it("follows an address change with a new certificate and the new address", async () => {
    const lan = service();
    const changes: string[] = [];
    lan.onChange((status) => {
      if (status.kind === "on") changes.push(status.urls.at(-1) as string);
    });
    await lan.enable();
    const fingerprint = (lan.status as { rootFingerprint: string })
      .rootFingerprint;
    fakes.table = wifi("192.168.1.40");
    await until(() => changes.at(-1) === "https://192.168.1.40:3382");
    expect(fakes.credentials.length).toBeGreaterThanOrEqual(1);
    expect(fakes.refreshed).toBeGreaterThanOrEqual(1);
    expect(changes.at(-1)).toBe("https://192.168.1.40:3382");
    const options = fakes.proxyOptions as LanProxyOptions;
    expect(options.isAllowedHost("192.168.1.40:3382")).toBe(true);
    expect(options.isAllowedHost("192.168.1.23:3382")).toBe(false);
    // The root stays, so no device has to be set up again.
    expect((lan.status as { rootFingerprint: string }).rootFingerprint).toBe(
      fingerprint,
    );
    await lan.stop();
  });

  it("replaces the root on request", async () => {
    const lan = service();
    await lan.enable();
    const before = (lan.status as { rootFingerprint: string }).rootFingerprint;
    await lan.replaceRoot();
    const after = (lan.status as { rootFingerprint: string }).rootFingerprint;
    expect(after).not.toBe(before);
    expect(fakes.credentials).toHaveLength(1);
    await lan.stop();
  });

  it("stops for quit without changing the setting", async () => {
    const lan = service();
    await lan.enable();
    await lan.stop();
    expect(lan.enabled).toBe(true);
    expect((await readConfig(join(root, "config.json")))?.lan?.enabled).toBe(
      true,
    );
  });
});
