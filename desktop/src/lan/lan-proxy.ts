import {
  createServer as createHttpServer,
  IncomingHttpHeaders,
  IncomingMessage,
  OutgoingHttpHeaders,
  request,
  ServerResponse,
} from "http";
import { createServer as createNetServer, Socket } from "net";
import { Duplex } from "stream";
import { createSecureContext, SecureContext, TLSSocket } from "tls";

import { WILDCARD_HOSTS } from "../ports";
import { unmapAddress } from "./ranges";

/**
 * The one listener local-network access adds
 * (docs/future-plans/desktop-lan-access.md, L2, L3, L6 and L9 to L11). It
 * accepts TLS on every address and forwards to the frontend's loopback port,
 * and nowhere else: the backend and PostgreSQL stay unreachable from the
 * network.
 *
 * - A connection from a peer outside the home network is closed at once.
 * - The first byte tells TLS (0x16, a handshake) from plain HTTP. Plain HTTP
 *   gets a redirect to `https://`, and the root certificate at
 *   `/monize-root.crt` while the setup window is open; nothing else.
 * - A request whose `Host` is not one of the served names is refused, which
 *   stops DNS rebinding; one whose `Origin` is not its own `https://` origin
 *   is refused, which stops a foreign page.
 * - What passes is forwarded with the window's own origin in place of the
 *   `Origin` header. The proxy has made the backend's check already, exactly,
 *   and the backend's list of allowed origins is fixed when it starts while
 *   the IP addresses this listener answers on are not.
 * - Every cookie relayed is marked `Secure`; `X-Forwarded-For` gains the
 *   peer, the one trusted hop the frontend's client-address code expects.
 * - A redirect to the window's origin is rewritten to the request's own.
 * - WebSocket upgrades are refused: the production frontend uses none.
 */

export interface TlsCredentials {
  readonly cert: string;
  readonly key: string;
}

export interface LanProxyOptions {
  /** 0 picks a free port (specs). */
  readonly port: number;
  /** The frontend's loopback port. */
  readonly upstreamPort: number;
  /** `http://127.0.0.1:<frontend port>`: what the backend allows. */
  readonly upstreamOrigin: string;
  readonly tls: TlsCredentials;
  /** Lower-cased `Host` values to accept, read per request. */
  readonly isAllowedHost: (host: string) => boolean;
  readonly isAllowedPeer: (address: string) => boolean;
  /** The root certificate while the setup window is open, else null. */
  readonly rootDer: () => Buffer | null;
  readonly log: (message: string) => void;
}

export interface LanProxy {
  readonly port: number;
  setCredentials(tls: TlsCredentials): void;
  close(): Promise<void>;
}

export const ROOT_DOWNLOAD_PATH = "/monize-root.crt";
const TLS_HANDSHAKE = 0x16;
const FIRST_BYTE_TIMEOUT_MS = 10_000;
const HANDSHAKE_TIMEOUT_MS = 10_000;

function contextFor(tls: TlsCredentials): SecureContext {
  return createSecureContext({
    cert: tls.cert,
    key: tls.key,
    minVersion: "TLSv1.2",
  });
}

/**
 * The connection as a stream that replays the byte already read to tell TLS
 * from plain HTTP. `socket.unshift` is not enough: a TLS socket built on a
 * `net.Socket` reads its native handle directly and never sees what was put
 * back, so the handshake would stall.
 */
function replaying(socket: Socket, head: Buffer): Duplex {
  const stream = new Duplex({
    read() {
      socket.resume();
    },
    write(chunk: Buffer, _encoding, done) {
      socket.write(chunk, done);
    },
    final(done) {
      socket.end();
      done();
    },
    destroy(error, done) {
      socket.destroy();
      done(error);
    },
  });
  stream.push(head);
  socket.on("data", (chunk: Buffer) => {
    if (!stream.push(chunk)) socket.pause();
  });
  socket.on("end", () => stream.push(null));
  socket.on("close", () => stream.destroy());
  return stream;
}

const HOP_BY_HOP = [
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

function withoutHopByHop(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const named = String(headers.connection ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name !== "");
  const drop = new Set([...HOP_BY_HOP, ...named]);
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !drop.has(name)) out[name] = value;
  }
  return out;
}

function text(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(`${body}\n`);
}

function hostOf(req: IncomingMessage): string | null {
  const host = req.headers.host;
  return typeof host === "string" && host !== "" ? host.toLowerCase() : null;
}

/** The headers sent to the frontend. */
export function upstreamHeaders(
  req: IncomingMessage,
  peer: string,
  upstreamOrigin: string,
): OutgoingHttpHeaders {
  const headers = withoutHopByHop(req.headers);
  delete headers["x-forwarded-host"];
  delete headers["x-forwarded-proto"];
  delete headers.forwarded;
  const prior = req.headers["x-forwarded-for"];
  headers["x-forwarded-for"] =
    typeof prior === "string" && prior.trim() !== ""
      ? `${prior}, ${peer}`
      : peer;
  headers["x-forwarded-proto"] = "https";
  headers["x-forwarded-host"] = req.headers.host;
  if (headers.origin !== undefined) headers.origin = upstreamOrigin;
  return headers;
}

function secureCookie(cookie: string): string {
  return /;\s*secure\s*(;|$)/i.test(cookie) ? cookie : `${cookie}; Secure`;
}

/** The headers sent back to the device. */
export function downstreamHeaders(
  headers: IncomingHttpHeaders,
  host: string,
  upstreamOrigin: string,
): OutgoingHttpHeaders {
  const out = withoutHopByHop(headers);
  const cookies = headers["set-cookie"];
  if (cookies !== undefined) out["set-cookie"] = cookies.map(secureCookie);
  const location = headers.location;
  if (typeof location === "string") {
    const own = `https://${host}`;
    for (const from of [upstreamOrigin, `http://${host}`]) {
      if (location === from || location.startsWith(`${from}/`)) {
        out.location = own + location.slice(from.length);
        break;
      }
    }
  }
  return out;
}

export async function startLanProxy(
  options: LanProxyOptions,
): Promise<LanProxy> {
  const sockets = new Set<Socket>();
  /** The peer behind each stream the HTTP servers see. */
  const peers = new WeakMap<object, string>();
  const peerOf = (req: IncomingMessage): string => peers.get(req.socket) ?? "";
  let context = contextFor(options.tls);

  function forward(req: IncomingMessage, res: ServerResponse): void {
    const host = hostOf(req);
    if (host === null || !options.isAllowedHost(host)) {
      text(res, 421, "This address is not served here.");
      return;
    }
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== `https://${host}`) {
      text(res, 403, "Cross-origin requests are not accepted.");
      return;
    }
    const upstream = request({
      host: "127.0.0.1",
      port: options.upstreamPort,
      method: req.method,
      path: req.url,
      headers: upstreamHeaders(req, peerOf(req), options.upstreamOrigin),
    });
    upstream.on("response", (answer) => {
      res.writeHead(
        answer.statusCode ?? 502,
        downstreamHeaders(answer.headers, host, options.upstreamOrigin),
      );
      answer.pipe(res);
    });
    upstream.on("error", (error) => {
      options.log(
        `LAN: the web application did not answer (${error.message}).`,
      );
      if (!res.headersSent) text(res, 502, "Monize is not answering.");
      else res.destroy();
    });
    res.on("close", () => {
      if (!res.writableFinished) upstream.destroy();
    });
    req.pipe(upstream);
  }

  function plain(req: IncomingMessage, res: ServerResponse): void {
    const host = hostOf(req);
    if (host === null || !options.isAllowedHost(host)) {
      text(res, 421, "This address is not served here.");
      return;
    }
    const root = options.rootDer();
    if (
      req.method === "GET" &&
      req.url === ROOT_DOWNLOAD_PATH &&
      root !== null
    ) {
      res.writeHead(200, {
        "content-type": "application/x-x509-ca-cert",
        "content-disposition": 'attachment; filename="monize-root.crt"',
        "content-length": root.length,
        "cache-control": "no-store",
      });
      res.end(root);
      return;
    }
    if (req.method === "GET" || req.method === "HEAD") {
      res.writeHead(301, { location: `https://${host}${req.url ?? "/"}` });
      res.end();
      return;
    }
    text(res, 400, "Use https://.");
  }

  // Both servers are fed streams, never a listening socket of their own.
  const decrypted = createHttpServer(forward);
  const cleartext = createHttpServer(plain);
  for (const server of [decrypted, cleartext]) {
    server.on("clientError", (_error, socket) => socket.destroy());
  }

  function serveTls(stream: Duplex, peer: string): void {
    const secure = new TLSSocket(stream, {
      isServer: true,
      secureContext: context,
    });
    peers.set(secure, peer);
    const timer = setTimeout(() => secure.destroy(), HANDSHAKE_TIMEOUT_MS);
    secure.once("secure", () => clearTimeout(timer));
    secure.once("close", () => clearTimeout(timer));
    secure.on("error", () => secure.destroy());
    decrypted.emit("connection", secure);
  }

  const listener = createNetServer({ pauseOnConnect: true }, (socket) => {
    const address = socket.remoteAddress;
    const peer = address === undefined ? null : unmapAddress(address);
    if (peer === null || !options.isAllowedPeer(peer)) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.setTimeout(FIRST_BYTE_TIMEOUT_MS, () => socket.destroy());
    socket.once("data", (head: Buffer) => {
      socket.pause();
      socket.setTimeout(0);
      const stream = replaying(socket, head);
      if (head[0] === TLS_HANDSHAKE) {
        serveTls(stream, peer);
      } else {
        peers.set(stream, peer);
        cleartext.emit("connection", stream);
      }
    });
    socket.resume();
  });

  const port = await listenOnEveryAddress(listener, options.port);
  return {
    port,
    setCredentials(tls) {
      context = contextFor(tls);
    },
    close() {
      return new Promise((resolve) => {
        listener.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      });
    },
  };
}

async function listenOnEveryAddress(
  listener: ReturnType<typeof createNetServer>,
  port: number,
): Promise<number> {
  let lastError: unknown = null;
  for (const host of WILDCARD_HOSTS) {
    try {
      await new Promise<void>((resolve, reject) => {
        listener.once("error", reject);
        listener.listen({ port, host, ipv6Only: false }, () => {
          listener.off("error", reject);
          resolve();
        });
      });
      return (listener.address() as { port: number }).port;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EAFNOSUPPORT" && code !== "EADDRNOTAVAIL") throw error;
    }
  }
  throw lastError;
}
