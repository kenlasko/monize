import { hostname as osHostname } from "os";

import { LanSettings, writeLanSettings } from "../app-config";
import { frontendOrigin } from "../env";
import { PortProber, Ports, probeLanPort, resolveLanPort } from "../ports";
import { SecretPolicy } from "../secrets";
import {
  addressUrls,
  allowedHosts,
  InterfaceTable,
  isAllowedPeer,
  LocalAddress,
  servedAddresses,
  servedNames,
  systemInterfaces,
} from "./addresses";
import {
  LanProxy,
  LanProxyOptions,
  ROOT_DOWNLOAD_PATH,
  startLanProxy,
} from "./lan-proxy";
import { MdnsResponder, startMdns } from "./mdns";
import { computerLabel, mdnsCandidates } from "./names";
import { loadOrCreateTls, replaceTls, TlsMaterial } from "./tls-store";
import { udpTransport } from "./udp-transport";
import { SubjectNames } from "./x509";

/**
 * Local-network access as one switch (docs/future-plans/desktop-lan-access.md):
 * the LAN port, the mDNS name, the certificates and the listener, started
 * and stopped together, and kept in step with the PC's addresses while they
 * run. Nothing here imports Electron; the tray and the setup window drive it.
 *
 * The children are never restarted for it: the listener forwards to the
 * frontend's loopback port and hands the backend the window's own origin
 * (`lan-proxy.ts`), so turning it on or off touches no environment.
 */

export type LanStatus =
  | { readonly kind: "off" }
  | { readonly kind: "starting" }
  | {
      readonly kind: "on";
      readonly port: number;
      /** The mDNS label, or null when the name could not be claimed. */
      readonly label: string | null;
      /** Why there is no mDNS name, or null. */
      readonly mdnsProblem: string | null;
      /** The `https://` addresses, best first. */
      readonly urls: readonly string[];
      /** Where a device downloads the root while setup is open. */
      readonly downloadUrls: readonly string[];
      readonly rootFingerprint: string;
    }
  | { readonly kind: "failed"; readonly message: string };

export interface LanLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface LanServiceDeps {
  readonly interfaces: () => InterfaceTable;
  readonly hostname: () => string;
  readonly now: () => Date;
  readonly probe: PortProber;
  readonly startProxy: (options: LanProxyOptions) => Promise<LanProxy>;
  readonly startResponder: (options: {
    readonly candidates: readonly string[];
    readonly addresses: () => readonly { address: string; cidr: string }[];
    readonly log: (message: string) => void;
  }) => Promise<MdnsResponder>;
  readonly watchIntervalMs: number;
}

export interface LanServiceOptions {
  readonly configFile: string;
  readonly tlsDir: string;
  readonly policy: SecretPolicy;
  /** The children's loopback ports; the listener fronts `ports.frontend`. */
  readonly ports: Ports;
  readonly settings: LanSettings | null;
  readonly logger: LanLogger;
  readonly deps?: Partial<LanServiceDeps>;
}

export interface LanService {
  readonly status: LanStatus;
  readonly enabled: boolean;
  onChange(listener: (status: LanStatus) => void): void;
  /** Turn it on and remember that; rejects with a message to show. */
  enable(): Promise<void>;
  /** Turn it off and remember that. */
  disable(): Promise<void>;
  /** At start: run it when it was left on. Never rejects. */
  startIfEnabled(): Promise<void>;
  /** While the setup window is open, the root is served over plain HTTP. */
  setSetupOpen(open: boolean): void;
  /** The root certificate's DER bytes, while running. */
  rootDer(): Buffer | null;
  /** A new root; every device must be set up again. */
  replaceRoot(): Promise<void>;
  /** Stop for quit or a data-folder move; the setting is kept. */
  stop(): Promise<void>;
}

/** How often the adapters are re-read for a changed address. */
export const WATCH_INTERVAL_MS = 30_000;

const DEFAULT_DEPS: LanServiceDeps = {
  interfaces: systemInterfaces,
  hostname: osHostname,
  now: () => new Date(),
  probe: probeLanPort,
  startProxy: startLanProxy,
  startResponder: async ({ candidates, addresses, log }) =>
    startMdns({ transport: await udpTransport(), candidates, addresses, log }),
  watchIntervalMs: WATCH_INTERVAL_MS,
};

interface Running {
  readonly port: number;
  readonly proxy: LanProxy;
  readonly responder: MdnsResponder | null;
  readonly mdnsProblem: string | null;
  readonly timer: NodeJS.Timeout;
  table: InterfaceTable;
  addresses: readonly LocalAddress[];
  names: SubjectNames;
  hosts: ReadonlySet<string>;
  material: TlsMaterial;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function addressKey(addresses: readonly LocalAddress[]): string {
  return addresses
    .map((entry) => `${entry.address}/${entry.cidr}`)
    .sort()
    .join(",");
}

export function createLanService(options: LanServiceOptions): LanService {
  const deps: LanServiceDeps = { ...DEFAULT_DEPS, ...options.deps };
  const { logger } = options;
  const listeners: ((status: LanStatus) => void)[] = [];
  let settings = options.settings;
  let status: LanStatus = { kind: "off" };
  let running: Running | null = null;
  let setupOpen = false;
  let busy: Promise<void> = Promise.resolve();

  function setStatus(next: LanStatus): void {
    status = next;
    for (const listener of listeners) listener(next);
  }

  /** One change at a time: a click during a start waits for it. */
  function serially(work: () => Promise<void>): Promise<void> {
    const next = busy.then(work);
    busy = next.catch(() => undefined);
    return next;
  }

  async function persist(next: LanSettings): Promise<void> {
    settings = next;
    await writeLanSettings(options.configFile, next);
  }

  function onStatus(run: Running): LanStatus {
    const ipv4 = run.addresses.filter((entry) => entry.family === 4);
    return {
      kind: "on",
      port: run.port,
      label: run.responder?.label ?? null,
      mdnsProblem: run.mdnsProblem,
      urls: addressUrls(run.names, run.port),
      downloadUrls: ipv4.map(
        (entry) => `http://${entry.address}:${run.port}${ROOT_DOWNLOAD_PATH}`,
      ),
      rootFingerprint: run.material.rootFingerprint,
    };
  }

  function namesFor(
    label: string | null,
    addresses: readonly LocalAddress[],
  ): SubjectNames {
    return servedNames({
      mdnsLabel: label,
      computerLabel: computerLabel(deps.hostname()),
      addresses,
    });
  }

  async function tlsFor(names: SubjectNames, replace = false) {
    const load = replace ? replaceTls : loadOrCreateTls;
    const result = await load({
      dir: options.tlsDir,
      policy: options.policy,
      computerName: deps.hostname(),
      names,
      now: deps.now(),
    });
    if (result.createdRoot) logger.info("LAN: created a new root certificate.");
    if (result.issued !== null) {
      logger.info(`LAN: issued a server certificate (${result.issued}).`);
    }
    return result.material;
  }

  async function refresh(run: Running): Promise<void> {
    const table = deps.interfaces();
    const addresses = servedAddresses(table);
    run.table = table;
    if (addressKey(addresses) === addressKey(run.addresses)) return;
    logger.info("LAN: this PC's network addresses changed.");
    run.addresses = addresses;
    run.names = namesFor(run.responder?.label ?? null, addresses);
    run.material = await tlsFor(run.names);
    run.proxy.setCredentials({
      cert: run.material.server.certPem,
      key: run.material.server.keyPem,
    });
    run.hosts = allowedHosts(run.names, run.port);
    await run.responder?.refresh();
    setStatus(onStatus(run));
  }

  async function start(): Promise<void> {
    const { port, moved } = await resolveLanPort(
      settings?.port ?? null,
      options.ports,
      deps.probe,
    );
    if (moved) {
      logger.warn(
        `LAN: port ${settings?.port} is in use; using ${port}. Devices need the new address.`,
      );
    }
    const table = deps.interfaces();
    const addresses = servedAddresses(table);
    let responder: MdnsResponder | null = null;
    let mdnsProblem: string | null = null;
    try {
      responder = await deps.startResponder({
        candidates: mdnsCandidates(settings?.hostname ?? null),
        addresses: () =>
          servedAddresses(running?.table ?? table)
            .filter((entry) => entry.family === 4)
            .map((entry) => ({ address: entry.address, cidr: entry.cidr })),
        log: (message) => logger.info(message),
      });
    } catch (error) {
      mdnsProblem = messageOf(error);
      logger.warn(`LAN: no mDNS name (${mdnsProblem}).`);
    }
    try {
      const names = namesFor(responder?.label ?? null, addresses);
      const material = await tlsFor(names);
      const holder: { run: Running | null } = { run: null };
      const proxy = await deps.startProxy({
        port,
        upstreamPort: options.ports.frontend,
        upstreamOrigin: frontendOrigin(options.ports),
        tls: { cert: material.server.certPem, key: material.server.keyPem },
        isAllowedHost: (host) => holder.run?.hosts.has(host) ?? false,
        isAllowedPeer: (address) =>
          isAllowedPeer(address, holder.run?.table ?? table),
        rootDer: () =>
          setupOpen && holder.run !== null ? holder.run.material.rootDer : null,
        log: (message) => logger.warn(message),
      });
      const timer = setInterval(() => {
        if (running !== null) {
          void serially(() => refresh(running as Running)).catch((error) =>
            logger.warn(
              `LAN: could not follow an address change (${messageOf(error)}).`,
            ),
          );
        }
      }, deps.watchIntervalMs);
      timer.unref();
      running = {
        port: proxy.port,
        proxy,
        responder,
        mdnsProblem,
        timer,
        table,
        addresses,
        names,
        hosts: allowedHosts(names, proxy.port),
        material,
      };
      holder.run = running;
    } catch (error) {
      await responder?.close().catch(() => undefined);
      throw error;
    }
    await persist({
      enabled: true,
      port,
      hostname: responder?.label ?? settings?.hostname ?? null,
    });
    logger.info(
      `LAN: serving other devices at ${onStatusUrls(running)} on port ${port}.`,
    );
    setStatus(onStatus(running));
  }

  function onStatusUrls(run: Running): string {
    return addressUrls(run.names, run.port).join(", ");
  }

  async function halt(): Promise<void> {
    const run = running;
    running = null;
    if (run === null) return;
    clearInterval(run.timer);
    await run.proxy.close().catch(() => undefined);
    await run.responder?.close().catch(() => undefined);
  }

  return {
    get status() {
      return status;
    },
    get enabled() {
      return settings?.enabled ?? false;
    },
    onChange(listener) {
      listeners.push(listener);
    },
    enable() {
      return serially(async () => {
        if (running !== null) return;
        setStatus({ kind: "starting" });
        try {
          await start();
        } catch (error) {
          await halt();
          setStatus({ kind: "failed", message: messageOf(error) });
          throw error;
        }
      });
    },
    disable() {
      return serially(async () => {
        await halt();
        if (settings !== null) await persist({ ...settings, enabled: false });
        setStatus({ kind: "off" });
        logger.info("LAN: turned off.");
      });
    },
    startIfEnabled() {
      return serially(async () => {
        if (!(settings?.enabled ?? false) || running !== null) return;
        setStatus({ kind: "starting" });
        try {
          await start();
        } catch (error) {
          await halt();
          logger.warn(`LAN: could not start (${messageOf(error)}).`);
          setStatus({ kind: "failed", message: messageOf(error) });
        }
      });
    },
    setSetupOpen(open) {
      setupOpen = open;
    },
    rootDer() {
      return running?.material.rootDer ?? null;
    },
    replaceRoot() {
      return serially(async () => {
        const run = running;
        if (run === null) return;
        run.material = await tlsFor(run.names, true);
        run.proxy.setCredentials({
          cert: run.material.server.certPem,
          key: run.material.server.keyPem,
        });
        logger.warn("LAN: replaced the root certificate.");
        setStatus(onStatus(run));
      });
    },
    stop() {
      return serially(async () => {
        await halt();
        if (status.kind !== "off") setStatus({ kind: "off" });
      });
    },
  };
}
