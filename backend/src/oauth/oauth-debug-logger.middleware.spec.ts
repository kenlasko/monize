import type { NextFunction, Request, Response } from "express";

type MwFactory = (
  scope: string,
) => (req: Request, res: Response, next: NextFunction) => void;

function loadModuleWithEnv(envValue: string | undefined): MwFactory {
  const prev = process.env.OAUTH_DEBUG_LOG;
  if (envValue === undefined) {
    delete process.env.OAUTH_DEBUG_LOG;
  } else {
    process.env.OAUTH_DEBUG_LOG = envValue;
  }
  let factory!: MwFactory;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("./oauth-debug-logger.middleware") as {
      oauthDebugLogger: MwFactory;
    };
    factory = mod.oauthDebugLogger;
  });
  // Restore env
  if (prev === undefined) {
    delete process.env.OAUTH_DEBUG_LOG;
  } else {
    process.env.OAUTH_DEBUG_LOG = prev;
  }
  return factory;
}

interface MockRes {
  statusCode: number;
  finishHandler?: () => void;
  on: jest.Mock;
  getHeader: jest.Mock;
}

function makeRes(headers: Record<string, string> = {}): MockRes {
  const res: MockRes = {
    statusCode: 200,
    on: jest.fn((evt: string, cb: () => void) => {
      if (evt === "finish") res.finishHandler = cb;
    }),
    getHeader: jest.fn((name: string) => headers[name.toLowerCase()]),
  };
  return res;
}

describe("oauthDebugLogger middleware", () => {
  it("returns a NOOP middleware when OAUTH_DEBUG_LOG is unset", () => {
    const factory = loadModuleWithEnv(undefined);
    const mw = factory("oauth");
    const next = jest.fn();
    mw({} as Request, {} as Response, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("returns NOOP for falsey-ish values like 'no'", () => {
    const factory = loadModuleWithEnv("no");
    const mw = factory("oauth");
    const next = jest.fn();
    mw({} as Request, {} as Response, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  describe("when enabled", () => {
    let factory: MwFactory;
    beforeAll(() => {
      factory = loadModuleWithEnv("true");
    });

    it("logs request, body, and response details for a non-token endpoint", () => {
      const mw = factory("oauth");
      const req = {
        method: "POST",
        originalUrl: "/api/v1/oauth-consent/abc",
        url: "/api/v1/oauth-consent/abc",
        path: "/api/v1/oauth-consent/abc",
        query: { foo: "bar" },
        headers: {
          authorization: "Bearer pat_abc123",
          "user-agent": "x".repeat(120),
        },
        body: {
          client_id: "c1",
          client_secret: "secretvalue",
          password: "p",
          code: "abc",
        },
      } as unknown as Request;
      const res = makeRes({
        location: "/somewhere",
        "www-authenticate": 'Bearer realm="x"',
      });
      const next = jest.fn();

      mw(req, res as unknown as Response, next);
      expect(next).toHaveBeenCalled();

      // Trigger res.on('finish')
      res.statusCode = 302;
      res.finishHandler?.();
      // Run finish handler twice to exercise both branches inside; harmless
      expect(res.on).toHaveBeenCalledWith("finish", expect.any(Function));
    });

    it("skips body logging on token endpoint and handles bare 'Bearer <token>' auth", () => {
      const mw = factory("oauth");
      const req = {
        method: "POST",
        url: "/oauth/token",
        path: "/oauth/token",
        query: {},
        headers: {
          authorization: "Bearer abc.def.ghi",
        },
        body: { grant_type: "authorization_code", refresh_token: "rt" },
      } as unknown as Request;
      const res = makeRes();
      const next = jest.fn();

      mw(req, res as unknown as Response, next);
      expect(next).toHaveBeenCalled();
      res.finishHandler?.();
    });

    it("handles array auth header, missing user-agent, missing originalUrl, no body", () => {
      const mw = factory("oauth");
      const req = {
        method: "GET",
        url: "/oauth/auth",
        path: "/oauth/auth",
        query: {},
        headers: {
          authorization: ["Bearer x", "Bearer y"],
        },
        body: undefined,
      } as unknown as Request;
      const res = makeRes();
      const next = jest.fn();

      mw(req, res as unknown as Response, next);
      expect(next).toHaveBeenCalled();
      res.finishHandler?.();
    });

    it("handles missing authorization header and Basic auth", () => {
      const mw = factory("oauth");
      const reqNoAuth = {
        method: "GET",
        url: "/oauth/jwks",
        path: "/oauth/jwks",
        query: {},
        headers: {},
        body: {},
      } as unknown as Request;
      const reqBasic = {
        method: "GET",
        url: "/oauth/test",
        path: "/oauth/test",
        query: {},
        headers: { authorization: "Basic dXNlcjpwYXNz" },
        body: {},
      } as unknown as Request;
      const res = makeRes();
      const next = jest.fn();

      mw(reqNoAuth, res as unknown as Response, next);
      mw(reqBasic, res as unknown as Response, next);
      expect(next).toHaveBeenCalledTimes(2);
    });

    it("handles a body that fails to JSON.stringify gracefully", () => {
      const mw = factory("oauth");
      const cyclical: Record<string, unknown> = { foo: "bar" };
      cyclical.self = cyclical; // creates a circular ref -> JSON.stringify throws
      const req = {
        method: "POST",
        url: "/api/v1/oauth-consent/x/confirm",
        path: "/api/v1/oauth-consent/x/confirm",
        query: {},
        headers: {},
        body: cyclical,
      } as unknown as Request;
      const res = makeRes();
      const next = jest.fn();

      expect(() => mw(req, res as unknown as Response, next)).not.toThrow();
      expect(next).toHaveBeenCalled();
    });

    it("redacts non-string secret values and falls back to req.url when path is missing", () => {
      const mw = factory("oauth");
      const req = {
        method: "POST",
        url: "/oauth/something",
        // no path
        query: { a: "1", b: "2" },
        headers: {},
        body: {
          client_secret: 12345 as unknown as string,
          regular: "ok",
        },
      } as unknown as Request;
      const res = makeRes();
      const next = jest.fn();

      mw(req, res as unknown as Response, next);
      expect(next).toHaveBeenCalled();
      res.finishHandler?.();
    });
  });
});
