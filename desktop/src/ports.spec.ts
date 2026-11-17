import { createServer, Server } from "net";

import {
  DEFAULT_LAN_PORT,
  DEFAULT_PORTS,
  isValidPort,
  PortError,
  PortProber,
  probeLanPort,
  probePort,
  resolveLanPort,
  resolvePorts,
} from "./ports";

function busy(...ports: number[]): PortProber {
  const set = new Set(ports);
  return async (port) => !set.has(port);
}

describe("resolvePorts on first run", () => {
  it("takes the defaults when they are free", async () => {
    const result = await resolvePorts(null, busy());
    expect(result).toEqual({ ports: DEFAULT_PORTS, moved: [], changed: true });
  });

  it("probes upward past a busy default without colliding with a sibling", async () => {
    const result = await resolvePorts(null, busy(3380));
    // 3381 is the backend's, so the frontend skips to 3382.
    expect(result.ports).toEqual({
      frontend: 3382,
      backend: 3381,
      postgres: 5433,
    });
    expect(result.moved).toEqual([]);
    expect(result.changed).toBe(true);
  });

  it("keeps all three distinct when a run of defaults is busy", async () => {
    const result = await resolvePorts(null, busy(3380, 3381, 3382, 5433));
    const values = Object.values(result.ports);
    expect(new Set(values).size).toBe(3);
    expect(result.ports.postgres).toBe(5434);
  });
});

describe("resolvePorts on a later run", () => {
  const persisted = { frontend: 4000, backend: 4001, postgres: 4002 };

  it("never changes a persisted port that is free", async () => {
    const result = await resolvePorts(persisted, busy(3380, 3381, 5433));
    expect(result).toEqual({ ports: persisted, moved: [], changed: false });
  });

  it("moves a busy persisted port upward and says which one moved", async () => {
    const result = await resolvePorts(persisted, busy(4000));
    // 4001 and 4002 are reserved by the siblings.
    expect(result.ports).toEqual({
      frontend: 4003,
      backend: 4001,
      postgres: 4002,
    });
    expect(result.moved).toEqual(["frontend"]);
    expect(result.changed).toBe(true);
  });

  it("reports every port that moved", async () => {
    const result = await resolvePorts(persisted, busy(4001, 4002));
    expect(result.moved).toEqual(["backend", "postgres"]);
    expect(new Set(Object.values(result.ports)).size).toBe(3);
  });

  it("gives up with a typed error when nothing upward is free", async () => {
    await expect(resolvePorts(persisted, async () => false)).rejects.toThrow(
      PortError,
    );
  });
});

describe("isValidPort", () => {
  it("accepts unprivileged integer ports only", () => {
    expect(isValidPort(3380)).toBe(true);
    expect(isValidPort(80)).toBe(false);
    expect(isValidPort(70000)).toBe(false);
    expect(isValidPort(3380.5)).toBe(false);
    expect(isValidPort("3380")).toBe(false);
  });
});

describe("probePort", () => {
  let holder: Server | undefined;

  afterEach(async () => {
    await new Promise<void>((resolve) =>
      holder ? holder.close(() => resolve()) : resolve(),
    );
    holder = undefined;
  });

  it("reports a port held on 127.0.0.1 as busy and a released one as free", async () => {
    const server = createServer();
    holder = server;
    const port = await new Promise<number>((resolve) => {
      server.listen({ port: 0, host: "127.0.0.1" }, () => {
        const address = server.address();
        resolve(typeof address === "object" && address ? address.port : 0);
      });
    });
    expect(await probePort(port)).toBe(false);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    holder = undefined;
    expect(await probePort(port)).toBe(true);
  });
});

describe("resolvePorts with reserved ports", () => {
  it("never hands a child a reserved port", async () => {
    const result = await resolvePorts(null, busy(3380), [3382]);
    expect(result.ports.frontend).toBe(3383);
  });
});

describe("resolveLanPort", () => {
  it("takes the default on first use and reports no move", async () => {
    expect(await resolveLanPort(null, DEFAULT_PORTS, busy())).toEqual({
      port: DEFAULT_LAN_PORT,
      moved: false,
    });
  });

  it("keeps a free persisted port", async () => {
    expect(await resolveLanPort(4000, DEFAULT_PORTS, busy())).toEqual({
      port: 4000,
      moved: false,
    });
  });

  it("moves a busy persisted port upward and reports it", async () => {
    expect(await resolveLanPort(4000, DEFAULT_PORTS, busy(4000))).toEqual({
      port: 4001,
      moved: true,
    });
  });

  it("skips the loopback ports", async () => {
    const taken = { frontend: 3380, backend: 3382, postgres: 3383 };
    const result = await resolveLanPort(null, taken, busy());
    expect(result.port).toBe(3384);
  });

  it("gives up with a PortError after the probe limit", async () => {
    await expect(
      resolveLanPort(null, DEFAULT_PORTS, async () => false),
    ).rejects.toBeInstanceOf(PortError);
  });
});

describe("probeLanPort", () => {
  async function holdOn(
    host: string,
    ipv6Only = false,
  ): Promise<{ port: number; release: () => Promise<unknown> }> {
    const holder: Server = createServer();
    await new Promise<void>((resolve) =>
      holder.listen({ port: 0, host, ipv6Only }, resolve),
    );
    return {
      port: (holder.address() as { port: number }).port,
      release: () => new Promise((resolve) => holder.close(resolve)),
    };
  }

  // Windows lets a dual-stack probe bind a port held on 0.0.0.0, which is
  // why each family is probed on its own.
  it("sees a port held on IPv4 alone as busy, and free once released", async () => {
    const held = await holdOn("0.0.0.0");
    try {
      expect(await probeLanPort(held.port)).toBe(false);
    } finally {
      await held.release();
    }
    expect(await probeLanPort(held.port)).toBe(true);
  });

  it("sees a port held on IPv6 alone as busy", async () => {
    let held: { port: number; release: () => Promise<unknown> };
    try {
      held = await holdOn("::", true);
    } catch {
      return; // No IPv6 on this machine: nothing to hold.
    }
    try {
      expect(await probeLanPort(held.port)).toBe(false);
    } finally {
      await held.release();
    }
  });
});
