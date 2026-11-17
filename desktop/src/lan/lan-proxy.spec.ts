import {
  createServer,
  IncomingHttpHeaders,
  request as httpRequest,
  Server,
} from "http";
import { request as httpsRequest } from "https";
import { AddressInfo } from "net";

import { issueRoot, issueServer } from "./certificate-authority";
import { LanProxy, ROOT_DOWNLOAD_PATH, startLanProxy } from "./lan-proxy";

const NOW = new Date();
const root = issueRoot({ computerName: "SPEC", now: NOW });
const first = issueServer({
  root,
  names: { dns: ["monize.local"], ip: [] },
  now: NOW,
});

interface Reply {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

/** The frontend stand-in: echoes what reached it, and a few canned answers. */
function upstreamApp(): Server {
  return createServer((req, res) => {
    if (req.url === "/cookie") {
      res.setHeader("set-cookie", [
        "session=abc; Path=/; HttpOnly",
        "csrf=xyz; Path=/; Secure",
      ]);
      res.end("ok");
      return;
    }
    if (req.url === "/to-login") {
      res.writeHead(307, { location: `${upstreamOrigin}/login?next=%2F` });
      res.end();
      return;
    }
    if (req.url === "/stream") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: one\n\n");
      setTimeout(() => res.end("data: two\n\n"), 300);
      return;
    }
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ url: req.url, headers: req.headers, body }));
    });
  });
}

let upstream: Server;
let upstreamOrigin: string;
let proxy: LanProxy;
let setupOpen: boolean;
let peerAllowed: boolean;
let hits: number;

async function startProxy(): Promise<LanProxy> {
  return startLanProxy({
    port: 0,
    upstreamPort: (upstream.address() as AddressInfo).port,
    upstreamOrigin,
    tls: { cert: first.certPem, key: first.keyPem },
    isAllowedHost: (host) => host === `monize.local:${proxy.port}`,
    isAllowedPeer: () => peerAllowed,
    rootDer: () => (setupOpen ? Buffer.from("ROOT-DER") : null),
    log: () => undefined,
  });
}

function secure(
  path: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    ca?: string;
    onFirstChunk?: (chunk: string) => void;
  } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: "127.0.0.1",
        port: proxy.port,
        path,
        method: options.method ?? "GET",
        servername: "monize.local",
        ca: options.ca ?? root.certPem,
        headers: { host: `monize.local:${proxy.port}`, ...options.headers },
        agent: false,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => {
          if (body === "") options.onFirstChunk?.(chunk.toString());
          body += chunk.toString();
        });
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body }),
        );
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

function plain(
  path: string,
  host = `monize.local:${proxy.port}`,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: proxy.port,
        path,
        headers: { host },
        agent: false,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => (body += chunk.toString("latin1")));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

beforeAll(async () => {
  upstream = upstreamApp();
  upstream.on("request", () => (hits += 1));
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  upstreamOrigin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => upstream.close(resolve));
});

beforeEach(async () => {
  setupOpen = false;
  peerAllowed = true;
  hits = 0;
  proxy = await startProxy();
});

afterEach(async () => {
  await proxy.close();
});

describe("the LAN listener over TLS", () => {
  it("forwards to the frontend with the request's Host and the peer appended", async () => {
    const reply = await secure("/dashboard?x=1", {
      headers: { "x-forwarded-for": "203.0.113.9" },
    });
    expect(reply.status).toBe(200);
    const seen = JSON.parse(reply.body) as {
      url: string;
      headers: IncomingHttpHeaders;
    };
    expect(seen.url).toBe("/dashboard?x=1");
    expect(seen.headers.host).toBe(`monize.local:${proxy.port}`);
    // A client's own value stays on the left; the right-most is the peer.
    expect(seen.headers["x-forwarded-for"]).toBe("203.0.113.9, 127.0.0.1");
    expect(seen.headers["x-forwarded-proto"]).toBe("https");
  });

  it("hands the backend the window's origin for a request from its own origin", async () => {
    const reply = await secure("/api/v1/auth/login", {
      method: "POST",
      headers: {
        origin: `https://monize.local:${proxy.port}`,
        "content-type": "application/json",
      },
      body: '{"email":"a@b.c"}',
    });
    const seen = JSON.parse(reply.body) as {
      headers: IncomingHttpHeaders;
      body: string;
    };
    expect(seen.headers.origin).toBe(upstreamOrigin);
    expect(seen.body).toBe('{"email":"a@b.c"}');
  });

  it("refuses a request from another origin before it reaches the frontend", async () => {
    const reply = await secure("/api/v1/accounts", {
      method: "POST",
      headers: { origin: "https://evil.example" },
    });
    expect(reply.status).toBe(403);
    expect(hits).toBe(0);
  });

  it("refuses an opaque origin", async () => {
    const reply = await secure("/api/v1/accounts", {
      method: "POST",
      headers: { origin: "null" },
    });
    expect(reply.status).toBe(403);
  });

  it("refuses a Host it does not serve (DNS rebinding)", async () => {
    const reply = await secure("/", { headers: { host: "attacker.example" } });
    expect(reply.status).toBe(421);
    expect(hits).toBe(0);
  });

  it("marks every relayed cookie Secure, once", async () => {
    const reply = await secure("/cookie");
    expect(reply.headers["set-cookie"]).toEqual([
      "session=abc; Path=/; HttpOnly; Secure",
      "csrf=xyz; Path=/; Secure",
    ]);
  });

  it("rewrites a redirect to the window's origin onto the request's own", async () => {
    const reply = await secure("/to-login");
    expect(reply.status).toBe(307);
    expect(reply.headers.location).toBe(
      `https://monize.local:${proxy.port}/login?next=%2F`,
    );
  });

  it("streams a response rather than buffering it", async () => {
    let firstChunkAt = 0;
    const started = Date.now();
    const reply = await secure("/stream", {
      onFirstChunk: () => (firstChunkAt = Date.now()),
    });
    expect(reply.body).toBe("data: one\n\ndata: two\n\n");
    expect(firstChunkAt - started).toBeLessThan(250);
  });

  it("drops hop-by-hop headers, including those Connection names", async () => {
    const reply = await secure("/", {
      headers: {
        connection: "x-private",
        "x-private": "1",
        "proxy-authorization": "Basic abc",
      },
    });
    const seen = JSON.parse(reply.body) as { headers: IncomingHttpHeaders };
    expect(seen.headers["x-private"]).toBeUndefined();
    expect(seen.headers["proxy-authorization"]).toBeUndefined();
  });

  it("answers 502 when the frontend is down", async () => {
    await proxy.close();
    proxy = await startLanProxy({
      port: 0,
      upstreamPort: 1,
      upstreamOrigin,
      tls: { cert: first.certPem, key: first.keyPem },
      isAllowedHost: () => true,
      isAllowedPeer: () => true,
      rootDer: () => null,
      log: () => undefined,
    });
    expect((await secure("/")).status).toBe(502);
  });

  it("presents a new certificate to new connections after setCredentials", async () => {
    const other = issueRoot({ computerName: "OTHER", now: NOW });
    const next = issueServer({
      root: other,
      names: { dns: ["monize.local"], ip: [] },
      now: NOW,
    });
    proxy.setCredentials({ cert: next.certPem, key: next.keyPem });
    await expect(secure("/")).rejects.toThrow();
    expect((await secure("/", { ca: other.certPem })).status).toBe(200);
  });
});

describe("the LAN listener's other answers", () => {
  it("closes a connection from a peer outside the home network", async () => {
    peerAllowed = false;
    await expect(secure("/")).rejects.toThrow();
    await expect(plain("/")).rejects.toThrow();
    expect(hits).toBe(0);
  });

  it("redirects plain HTTP to https", async () => {
    const reply = await plain("/accounts?id=1");
    expect(reply.status).toBe(301);
    expect(reply.headers.location).toBe(
      `https://monize.local:${proxy.port}/accounts?id=1`,
    );
    expect(hits).toBe(0);
  });

  it("serves the root certificate over plain HTTP only while setup is open", async () => {
    expect((await plain(ROOT_DOWNLOAD_PATH)).status).toBe(301);
    setupOpen = true;
    const reply = await plain(ROOT_DOWNLOAD_PATH);
    expect(reply.status).toBe(200);
    expect(reply.headers["content-type"]).toBe("application/x-x509-ca-cert");
    expect(reply.body).toBe("ROOT-DER");
  });

  it("refuses plain HTTP for a Host it does not serve", async () => {
    setupOpen = true;
    expect((await plain(ROOT_DOWNLOAD_PATH, "attacker.example")).status).toBe(
      421,
    );
  });

  it("stops listening when closed", async () => {
    const port = proxy.port;
    await proxy.close();
    await expect(
      new Promise((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port, path: "/" },
          resolve,
        );
        req.on("error", reject);
        req.end();
      }),
    ).rejects.toThrow();
    proxy = await startProxy();
  });
});
