// Checks local-network access against a running stack (dev-boot --lan
// --exit-when-ready): the requests a phone makes, sent through the TLS
// listener to the real frontend and backend, verified against the
// install's own root certificate. Docs: desktop/README.md, "Local network".

import { request } from "node:https";
import { URL } from "node:url";

/** One HTTPS request to the LAN listener on loopback, as `host`. */
function send({
  port,
  host,
  ca,
  method = "GET",
  path,
  headers = {},
  body,
  servername = host.replace(/:\d+$/, ""),
}) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        servername,
        ca,
        headers: { host, ...headers },
        agent: false,
      },
      (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, text }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

/**
 * Resolves with one line per check, each starting "ok" or "FAILED". The
 * login is refused for its credentials (400 or 401), which shows the backend
 * accepted the request's origin: a CORS refusal would be a 500.
 */
export async function lanSmoke({ status, rootCertPem }) {
  const host = new URL(status.urls[0]).host;
  const base = { port: status.port, host, ca: rootCertPem };
  const own = `https://${host}`;
  const results = [];
  const check = (name, ok, detail) =>
    results.push(`${ok ? "ok" : "FAILED"}: ${name} (${detail})`);

  const page = await send({ ...base, path: "/login" });
  check("the login page loads over TLS", page.status === 200, page.status);

  const login = await send({
    ...base,
    method: "POST",
    path: "/api/v1/auth/login",
    headers: { origin: own, "content-type": "application/json" },
    body: JSON.stringify({ email: "nobody@example.invalid", password: "x" }),
  });
  check(
    "the backend accepts the LAN origin",
    login.status === 400 || login.status === 401,
    login.status,
  );

  const foreign = await send({
    ...base,
    method: "POST",
    path: "/api/v1/auth/login",
    headers: {
      origin: "https://evil.example",
      "content-type": "application/json",
    },
    body: "{}",
  });
  check("a foreign origin is refused", foreign.status === 403, foreign.status);

  // TLS names monize.local; only the Host header is the attacker's, as after
  // a DNS rebinding (the browser would also refuse the certificate).
  const rebinding = await send({
    ...base,
    host: `attacker.example:${status.port}`,
    servername: new URL(status.urls[0]).hostname,
    path: "/",
  });
  check(
    "an unknown Host is refused",
    rebinding.status === 421,
    rebinding.status,
  );

  const cookies = [page, login].flatMap(
    (reply) => reply.headers["set-cookie"] ?? [],
  );
  check(
    "every cookie is Secure",
    cookies.every((cookie) => /;\s*secure/i.test(cookie)),
    `${cookies.length} cookie(s)`,
  );
  return results;
}
