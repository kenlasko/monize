import type { Request, Response } from "express";
import { ThrottlerStorageService } from "@nestjs/throttler";

import {
  OIDC_PROVIDER_ROUTES,
  isOidcProviderPath,
} from "./oidc-provider-paths";

import {
  ENDPOINT_THROTTLE_RULES,
  createOAuthEndpointThrottle,
  routeKey,
} from "./oauth-endpoint-throttle";

/**
 * The provider is mounted ahead of the Nest router, so ThrottlerGuard never
 * reached `/oauth/*` and one host could register clients and open interactions
 * without limit (#2177). These run against the library's real in-memory
 * storage, the one `CLUSTER_MODE=single` uses.
 */
describe("createOAuthEndpointThrottle", () => {
  let storage: ThrottlerStorageService;

  beforeEach(() => {
    storage = new ThrottlerStorageService();
  });

  afterEach(() => {
    storage.onApplicationShutdown();
  });

  function call(
    middleware: ReturnType<typeof createOAuthEndpointThrottle>,
    method: string,
    path: string,
    ip = "203.0.113.7",
  ) {
    const res = {
      status: jest.fn().mockReturnThis(),
      setHeader: jest.fn(),
      json: jest.fn(),
    };
    return new Promise<{ passed: boolean; res: typeof res }>((resolve) => {
      res.json.mockImplementation(() => resolve({ passed: false, res }));
      middleware(
        { method, path, ip } as unknown as Request,
        res as unknown as Response,
        () => resolve({ passed: true, res }),
      );
    });
  }

  it("refuses the registration past its cap with 429 and Retry-After", async () => {
    const middleware = createOAuthEndpointThrottle(storage);
    const cap = ENDPOINT_THROTTLE_RULES[0].limit;

    for (let i = 0; i < cap; i += 1) {
      await expect(call(middleware, "POST", "/oauth/reg")).resolves.toEqual(
        expect.objectContaining({ passed: true }),
      );
    }
    const refused = await call(middleware, "POST", "/oauth/reg");

    expect(refused.passed).toBe(false);
    expect(refused.res.status).toHaveBeenCalledWith(429);
    expect(refused.res.setHeader).toHaveBeenCalledWith(
      "Retry-After",
      expect.stringMatching(/^\d+$/),
    );
    expect(refused.res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "too_many_requests" }),
    );
  });

  it("counts each client address separately", async () => {
    const middleware = createOAuthEndpointThrottle(storage, [
      { ...ENDPOINT_THROTTLE_RULES[0], limit: 1 },
    ]);

    await call(middleware, "POST", "/oauth/reg", "198.51.100.1");
    const other = await call(middleware, "POST", "/oauth/reg", "198.51.100.2");
    const again = await call(middleware, "POST", "/oauth/reg", "198.51.100.1");

    expect(other.passed).toBe(true);
    expect(again.passed).toBe(false);
  });

  it("caps new authorization requests, direct and pushed, in one bucket", async () => {
    const middleware = createOAuthEndpointThrottle(storage, [
      { ...ENDPOINT_THROTTLE_RULES[1], limit: 2 },
    ]);

    expect((await call(middleware, "GET", "/oauth/auth")).passed).toBe(true);
    expect((await call(middleware, "POST", "/oauth/request")).passed).toBe(
      true,
    );
    expect((await call(middleware, "POST", "/oauth/auth")).passed).toBe(false);
  });

  it.each(["/oauth/reg/", "/oauth/REG", "/oauth/Reg/"])(
    "counts %s as the registration route, as the provider's router does",
    async (path) => {
      // The router folds ASCII case and ignores one trailing slash; a looser
      // match here was a way past the cap.
      const middleware = createOAuthEndpointThrottle(storage, [
        { ...ENDPOINT_THROTTLE_RULES[0], limit: 1 },
      ]);

      await call(middleware, "POST", "/oauth/reg");
      expect((await call(middleware, "POST", path)).passed).toBe(false);
    },
  );

  it("counts a case-folded authorization request too", async () => {
    const middleware = createOAuthEndpointThrottle(storage, [
      { ...ENDPOINT_THROTTLE_RULES[1], limit: 1 },
    ]);

    await call(middleware, "GET", "/oauth/auth");
    expect((await call(middleware, "GET", "/oauth/AUTH/")).passed).toBe(false);
  });

  it("needs no rule for a prefix the root mount never hands the provider", () => {
    // main.ts delegates only isOidcProviderPath paths, and that prefix check is
    // case-sensitive, so /OAUTH/REG reaches the Nest router, not registration.
    expect(isOidcProviderPath("/OAUTH/REG")).toBe(false);
    expect(isOidcProviderPath("/oauth/REG")).toBe(true);
  });

  it("counts the logout page, which saves a Session for an anonymous caller", async () => {
    const middleware = createOAuthEndpointThrottle(storage, [
      { ...ENDPOINT_THROTTLE_RULES[1], limit: 1 },
    ]);

    await call(middleware, "GET", "/oauth/session/end");
    expect((await call(middleware, "GET", "/oauth/session/end/")).passed).toBe(
      false,
    );
  });

  it("decides every provider route: capped, or known to store nothing for an anonymous caller", () => {
    // Measured against oidc-provider 9.13 with no session cookie: only these
    // four wrote a row. A route added to OIDC_PROVIDER_ROUTES fails here until
    // someone decides which list it belongs on.
    const capped = [
      "registration",
      "authorization",
      "pushed_authorization_request",
      "end_session",
    ];
    const storesNothing = ["token", "jwks", "revocation", "userinfo"];
    expect(Object.keys(OIDC_PROVIDER_ROUTES).sort()).toEqual(
      [...capped, ...storesNothing].sort(),
    );
    const methods = ["GET", "POST"];
    for (const name of capped) {
      const path = routeKey(
        OIDC_PROVIDER_ROUTES[name as keyof typeof OIDC_PROVIDER_ROUTES],
      );
      expect(
        methods.some((m) =>
          ENDPOINT_THROTTLE_RULES.some((rule) => rule.matches(m, path)),
        ),
      ).toBe(true);
    }
    for (const name of storesNothing) {
      const path = routeKey(
        OIDC_PROVIDER_ROUTES[name as keyof typeof OIDC_PROVIDER_ROUTES],
      );
      for (const m of methods) {
        expect(
          ENDPOINT_THROTTLE_RULES.some((rule) => rule.matches(m, path)),
        ).toBe(false);
      }
    }
  });

  it("stores a hash of the client address, never the address", async () => {
    const middleware = createOAuthEndpointThrottle(storage);

    await call(middleware, "POST", "/oauth/reg", "198.51.100.77");

    const keys = [...storage.storage.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toContain("198.51.100.77");
    expect(keys[0]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("normalizes the way the provider's router does", () => {
    expect(routeKey("/oauth/reg/")).toBe("/OAUTH/REG");
    expect(routeKey("/")).toBe("/");
    // Only one trailing slash: the router does not strip two, so neither do we.
    expect(routeKey("/oauth/reg//")).toBe("/OAUTH/REG/");
  });

  it.each([
    ["GET", "/oauth/auth/abc123"], // resume of an interaction already counted
    ["POST", "/oauth/token"],
    ["GET", "/oauth/jwks"],
    ["GET", "/oauth/reg"],
    ["GET", "/.well-known/oauth-authorization-server"],
    ["POST", "/api/v1/auth/login"],
  ])("leaves %s %s alone", async (method, path) => {
    const increment = jest.spyOn(storage, "increment");
    const middleware = createOAuthEndpointThrottle(storage);

    expect((await call(middleware, method, path)).passed).toBe(true);
    expect(increment).not.toHaveBeenCalled();
  });

  it("fails open when the storage throws", async () => {
    const middleware = createOAuthEndpointThrottle({
      increment: jest.fn().mockRejectedValue(new Error("db down")),
    });

    expect((await call(middleware, "POST", "/oauth/reg")).passed).toBe(true);
  });

  it("keeps DCR far below the 50-per-second the issue measured", () => {
    const [registration, authorization] = ENDPOINT_THROTTLE_RULES;
    expect(registration.limit / (registration.ttlMs / 60_000)).toBeLessThan(1);
    expect(authorization.limit / (authorization.ttlMs / 60_000)).toBeLessThan(
      100,
    );
  });
});
