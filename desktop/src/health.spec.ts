import { createServer, Server } from "http";
import { AddressInfo } from "net";

import { HealthOutcome, waitForHealthy } from "./health";
import { Clock } from "./supervisor/clock";
import { fakeFetch } from "./test-support/fake-fetch";
import { flush, manualClock } from "./test-support/manual-clock";

const URL = "http://127.0.0.1:3381/api/v1/health/ready";

function setup() {
  const clock = manualClock();
  const net = fakeFetch();
  return { clock, net, deps: { clock, fetch: net.fetch } };
}

/** Resolves to the outcome, or to "pending" while the wait is still going. */
async function peek<E>(
  wait: Promise<HealthOutcome<E>>,
): Promise<HealthOutcome<E> | "pending"> {
  await flush();
  return Promise.race([wait, Promise.resolve("pending" as const)]);
}

describe("waitForHealthy", () => {
  it("resolves healthy on the first 200", async () => {
    const { net, deps } = setup();
    net.respond(URL, 200);

    await expect(
      waitForHealthy(URL, { deadlineMs: 1000, ...deps }),
    ).resolves.toEqual({
      kind: "healthy",
      attempts: 1,
      lastStatus: 200,
      lastError: null,
    });
  });

  it("treats a refused connection as not yet, and polls at the interval", async () => {
    const { clock, net, deps } = setup();
    const wait = waitForHealthy(URL, {
      deadlineMs: 10_000,
      intervalMs: 250,
      ...deps,
    });

    expect(await peek(wait)).toBe("pending");
    expect(net.calls).toHaveLength(1);
    await clock.advance(249);
    expect(net.calls).toHaveLength(1);
    await clock.advance(1);
    expect(net.calls).toHaveLength(2);

    net.respond(URL, 200);
    await clock.advance(250);
    await expect(wait).resolves.toMatchObject({ kind: "healthy", attempts: 3 });
  });

  it("treats a 503 as not yet: only a 200 is healthy", async () => {
    const { clock, net, deps } = setup();
    net.respond(URL, 503);
    const wait = waitForHealthy(URL, { deadlineMs: 600, ...deps });

    await clock.advance(600);

    await expect(wait).resolves.toEqual({
      kind: "timeout",
      deadlineMs: 600,
      attempts: 3,
      lastStatus: 503,
      lastError: null,
    });
  });

  it("does not take a 204 or a redirect for a 200", async () => {
    const { clock, net, deps } = setup();
    net.respond(URL, 204);
    const wait = waitForHealthy(URL, { deadlineMs: 300, ...deps });
    await clock.advance(249);
    net.respond(URL, 302);
    await clock.advance(51);

    await expect(wait).resolves.toMatchObject({
      kind: "timeout",
      lastStatus: 302,
    });
  });

  it("times out at the deadline and says what the last attempt saw", async () => {
    const { clock, deps } = setup();
    const wait = waitForHealthy(URL, {
      deadlineMs: 1000,
      intervalMs: 250,
      ...deps,
    });

    await clock.advance(999);
    expect(await peek(wait)).toBe("pending");
    await clock.advance(1);

    await expect(wait).resolves.toEqual({
      kind: "timeout",
      deadlineMs: 1000,
      attempts: 4,
      lastStatus: null,
      lastError: "ECONNREFUSED",
    });
    expect(clock.pending).toBe(0);
  });

  it("gives up on a request that does not answer, and tries again", async () => {
    const { clock, net, deps } = setup();
    net.respond(URL, "hang");
    const wait = waitForHealthy(URL, {
      deadlineMs: 10_000,
      intervalMs: 250,
      requestTimeoutMs: 3000,
      ...deps,
    });

    expect(await peek(wait)).toBe("pending");
    expect(net.open).toBe(1);
    await clock.advance(3000);
    // The hung request was aborted, not left open behind the next one.
    expect(net.open).toBe(0);

    net.respond(URL, 200);
    await clock.advance(250);
    await expect(wait).resolves.toMatchObject({ kind: "healthy", attempts: 2 });
  });

  it("never lets one hung request outlast the deadline", async () => {
    const { clock, net, deps } = setup();
    net.respond(URL, "hang");
    const wait = waitForHealthy(URL, {
      deadlineMs: 1000,
      requestTimeoutMs: 3000,
      ...deps,
    });

    await clock.advance(1000);

    await expect(wait).resolves.toMatchObject({
      kind: "timeout",
      attempts: 1,
      lastError: "no response within 1000 ms",
    });
    expect(net.open).toBe(0);
  });

  it("is aborted promptly between polls, leaving no timer armed", async () => {
    const { clock, net, deps } = setup();
    const controller = new AbortController();
    const wait = waitForHealthy(URL, {
      deadlineMs: 60_000,
      signal: controller.signal,
      ...deps,
    });
    expect(await peek(wait)).toBe("pending");

    controller.abort();

    await expect(wait).resolves.toEqual({ kind: "aborted" });
    expect(clock.pending).toBe(0);
    expect(net.calls).toHaveLength(1);
  });

  it("is aborted promptly in the middle of a request", async () => {
    const { clock, net, deps } = setup();
    net.respond(URL, "hang");
    const controller = new AbortController();
    const wait = waitForHealthy(URL, {
      deadlineMs: 60_000,
      signal: controller.signal,
      ...deps,
    });
    expect(await peek(wait)).toBe("pending");

    controller.abort();

    await expect(wait).resolves.toEqual({ kind: "aborted" });
    expect(net.open).toBe(0);
    expect(clock.pending).toBe(0);
  });

  it("makes no request when it is already aborted", async () => {
    const { net, deps } = setup();
    const controller = new AbortController();
    controller.abort();

    await expect(
      waitForHealthy(URL, {
        deadlineMs: 1000,
        signal: controller.signal,
        ...deps,
      }),
    ).resolves.toEqual({ kind: "aborted" });
    expect(net.calls).toHaveLength(0);
  });

  it("loses the race to the process exiting, without waiting for the deadline", async () => {
    const { clock, net, deps } = setup();
    net.respond(URL, "hang");
    let exit!: (value: { code: number }) => void;
    const exited = new Promise<{ code: number }>((resolve) => {
      exit = resolve;
    });
    const wait = waitForHealthy(URL, {
      deadlineMs: 120_000,
      exited,
      ...deps,
    });
    expect(await peek(wait)).toBe("pending");

    exit({ code: 1 });

    await expect(wait).resolves.toEqual({ kind: "exited", exit: { code: 1 } });
    // The poll stopped with it: no open request, no timer left to fire.
    await flush();
    expect(net.open).toBe(0);
    expect(clock.pending).toBe(0);
    expect(clock.now()).toBe(0);
  });

  it("reports an exit that happened before the first poll, even if the port answers", async () => {
    const { net, deps } = setup();
    // Something else is listening on the port; the process we started is gone.
    net.respond(URL, 200);

    await expect(
      waitForHealthy(URL, {
        deadlineMs: 1000,
        exited: Promise.resolve({ code: 1 }),
        ...deps,
      }),
    ).resolves.toEqual({ kind: "exited", exit: { code: 1 } });
  });

  it("survives a fetch that throws synchronously", async () => {
    const { clock } = setup();
    const wait = waitForHealthy(URL, {
      deadlineMs: 250,
      clock,
      fetch: () => {
        throw new Error("boom");
      },
    });

    await clock.advance(250);

    await expect(wait).resolves.toMatchObject({
      kind: "timeout",
      lastError: "boom",
    });
  });
});

describe("waitForHealthy with Node's own fetch", () => {
  const INTERVAL = 250;
  let server: Server;
  let origin: string;

  /**
   * Real requests, no real waiting: the request timeout never fires on its
   * own, and the pause between polls jumps straight past the deadline, so each
   * case makes exactly one request.
   */
  function oneAttemptClock(): Clock {
    let now = 0;
    return {
      now: () => now,
      sleep: (ms, signal) =>
        new Promise<void>((resolve) => {
          if (ms === INTERVAL) {
            now += 60_000;
            resolve();
          } else {
            signal?.addEventListener("abort", () => resolve(), { once: true });
          }
        }),
    };
  }

  const wait = (path: string) =>
    waitForHealthy(`${origin}${path}`, {
      deadlineMs: 60_000,
      intervalMs: INTERVAL,
      clock: oneAttemptClock(),
    });

  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url === "/ready") {
        response.writeHead(200).end('{"status":"ok"}');
      } else if (request.url === "/moved") {
        response.writeHead(302, { Location: "/ready" }).end();
      } else {
        response.writeHead(503).end();
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it("is healthy on a 200 from a real listener", async () => {
    await expect(wait("/ready")).resolves.toMatchObject({ kind: "healthy" });
  });

  it("reads a 503 as not yet", async () => {
    await expect(wait("/not-ready")).resolves.toMatchObject({
      kind: "timeout",
      lastStatus: 503,
    });
  });

  it("does not follow a redirect to a 200", async () => {
    await expect(wait("/moved")).resolves.toMatchObject({
      kind: "timeout",
      lastStatus: 302,
    });
  });

  it("reads a refused connection as not yet, and names it", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) =>
      closed.listen(0, "127.0.0.1", resolve),
    );
    const { port } = closed.address() as AddressInfo;
    await new Promise((resolve) => closed.close(resolve));

    await expect(
      waitForHealthy(`http://127.0.0.1:${port}/ready`, {
        deadlineMs: 60_000,
        intervalMs: INTERVAL,
        clock: oneAttemptClock(),
      }),
    ).resolves.toEqual({
      kind: "timeout",
      deadlineMs: 60_000,
      attempts: 1,
      lastStatus: null,
      lastError: "ECONNREFUSED",
    });
  });
});
