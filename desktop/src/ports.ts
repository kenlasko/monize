import { createServer } from "net";

/**
 * The three loopback ports (plan D8). Chosen once and persisted, because the
 * frontend port is the origin: `PUBLIC_APP_URL`, OIDC redirect registration,
 * the MCP issuer and service-worker caches are all keyed on it. So a persisted
 * port that is free is never changed, and one that is busy is moved upward and
 * reported, so the caller persists it and warns the person.
 *
 * Probing binds and releases, so another program can take a port between the
 * probe and the child's own listen. That is a boot failure the supervisor
 * reports, not something a probe can close.
 */

export type PortName = "frontend" | "backend" | "postgres";

export interface Ports {
  readonly frontend: number;
  readonly backend: number;
  readonly postgres: number;
}

export const PORT_NAMES: readonly PortName[] = [
  "frontend",
  "backend",
  "postgres",
];

export const DEFAULT_PORTS: Ports = {
  frontend: 3380,
  backend: 3381,
  postgres: 5433,
};

export const MIN_PORT = 1024;
export const MAX_PORT = 65535;

/** How far upward a busy port is probed before giving up. */
export const MAX_PROBE_ATTEMPTS = 100;

/** Resolves true when the port can be bound on 127.0.0.1. */
export type PortProber = (port: number) => Promise<boolean>;

export interface PortResolution {
  readonly ports: Ports;
  /** Persisted ports that were busy and now differ: the origin may change. */
  readonly moved: readonly PortName[];
  /** True when `ports` must be written back (first run, or any move). */
  readonly changed: boolean;
}

export class PortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PortError";
  }
}

/**
 * Bind a throwaway server on 127.0.0.1. `EADDRINUSE` is busy; so is `EACCES`,
 * which Windows returns for ports inside an excluded range (Hyper-V and WSL
 * reserve blocks). Anything else is a real error and propagates.
 */
export const probePort: PortProber = (port) =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE" || error.code === "EACCES") {
        resolve(false);
      } else {
        reject(error);
      }
    });
    server.listen({ port, host: "127.0.0.1", exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });

export function isValidPort(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_PORT &&
    value <= MAX_PORT
  );
}

async function firstFreeFrom(
  start: number,
  name: PortName,
  taken: ReadonlySet<number>,
  probe: PortProber,
): Promise<number> {
  for (let offset = 0; offset < MAX_PROBE_ATTEMPTS; offset++) {
    const port = start + offset;
    if (port > MAX_PORT) break;
    if (taken.has(port)) continue;
    if (await probe(port)) return port;
  }
  throw new PortError(
    `No free port for the ${name} found in ${MAX_PROBE_ATTEMPTS} tries from ${start}.`,
  );
}

/**
 * Choose the ports for this launch. `persisted` is null on first run, when
 * every default is probed upward. On a later run a free persisted port is kept
 * as is; a busy one is moved upward. Every chosen port stays distinct from the
 * other two, persisted or newly picked.
 */
export async function resolvePorts(
  persisted: Ports | null,
  probe: PortProber = probePort,
): Promise<PortResolution> {
  const start = persisted ?? DEFAULT_PORTS;
  const chosen: Partial<Record<PortName, number>> = {};
  const moved: PortName[] = [];

  for (const name of PORT_NAMES) {
    // Reserve what the others already hold or will ask for first, so a moved
    // port never lands on a sibling's persisted value.
    const taken = new Set<number>(
      PORT_NAMES.filter((other) => other !== name).map(
        (other) => chosen[other] ?? start[other],
      ),
    );
    const port = await firstFreeFrom(start[name], name, taken, probe);
    chosen[name] = port;
    if (persisted !== null && port !== persisted[name]) moved.push(name);
  }

  const ports: Ports = {
    frontend: chosen.frontend as number,
    backend: chosen.backend as number,
    postgres: chosen.postgres as number,
  };
  return { ports, moved, changed: persisted === null || moved.length > 0 };
}
