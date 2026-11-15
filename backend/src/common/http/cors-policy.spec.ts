import express from "express";
import { ExpressAdapter } from "@nestjs/platform-express";
import request from "supertest";
import { createCorsDelegate } from "./cors-policy";

// Drives the middleware the Express adapter's enableCors installs, so the
// assertions are the headers a browser reads, not the options object.
const APP_ORIGIN = "https://app.monize.test";
const FOREIGN_ORIGIN = "https://evil.example";

function buildApp() {
  const adapter = new ExpressAdapter(express());
  adapter.enableCors(createCorsDelegate([APP_ORIGIN]));
  const app = adapter.getInstance();
  app.all(/.*/, (_req, res) => {
    res.status(200).json({ ok: true });
  });
  return app;
}

function preflight(path: string, origin: string) {
  return request(buildApp())
    .options(path)
    .set("Origin", origin)
    .set("Access-Control-Request-Method", "POST")
    .set(
      "Access-Control-Request-Headers",
      "authorization,content-type,mcp-protocol-version",
    );
}

describe("createCorsDelegate", () => {
  describe("/api/v1/mcp (kenlasko/monize#2178)", () => {
    it.each(["/api/v1/mcp", "/api/v1/mcp/anything"])(
      "gives a foreign origin's preflight on %s no Access-Control-Allow-Origin",
      async (path) => {
        const res = await preflight(path, FOREIGN_ORIGIN);
        expect(res.headers["access-control-allow-origin"]).toBeUndefined();
      },
    );

    it("gives a foreign origin's POST no Access-Control-Allow-Origin, so the body is unreadable", async () => {
      const res = await request(buildApp())
        .post("/api/v1/mcp")
        .set("Origin", FOREIGN_ORIGIN)
        .set("Authorization", "Bearer token");
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    });

    it("reflects an allow-listed origin with the MCP headers, without credentials", async () => {
      const res = await preflight("/api/v1/mcp", APP_ORIGIN);
      expect(res.status).toBe(204);
      expect(res.headers["access-control-allow-origin"]).toBe(APP_ORIGIN);
      expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
      expect(res.headers["access-control-allow-headers"]).toContain(
        "Mcp-Protocol-Version",
      );
      expect(res.headers["vary"]).toContain("Origin");
    });

    it("serves a native client that sends no Origin", async () => {
      const res = await request(buildApp())
        .post("/api/v1/mcp")
        .set("Authorization", "Bearer token");
      expect(res.status).toBe(200);
    });

    it("does not widen to a path that only starts with the same letters", async () => {
      // Only the strict branch sets credentials, so this fails if /mcpx
      // were treated as an MCP path.
      const res = await preflight("/api/v1/mcpx", APP_ORIGIN);
      expect(res.headers["access-control-allow-credentials"]).toBe("true");
    });

    it("lets an allow-listed page read a POST and its challenge headers", async () => {
      const res = await request(buildApp())
        .post("/api/v1/mcp")
        .set("Origin", APP_ORIGIN)
        .set("Authorization", "Bearer token");
      expect(res.headers["access-control-allow-origin"]).toBe(APP_ORIGIN);
      const exposed = String(
        res.headers["access-control-expose-headers"],
      ).toLowerCase();
      expect(exposed).toContain("www-authenticate");
      expect(exposed).toContain("mcp-session-id");
    });
  });

  describe("OAuth and discovery", () => {
    it.each([
      "/oauth/token",
      "/oauth/reg",
      "/api/v1/oauth-consent/abc",
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-authorization-server/api/v1/mcp",
      "/.well-known/openid-configuration",
    ])("answers any origin on %s", async (path) => {
      const res = await preflight(path, FOREIGN_ORIGIN);
      expect(res.headers["access-control-allow-origin"]).toBe("*");
      // The wildcard is safe only while credentials stay off: some of these
      // paths read a cookie.
      expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
    });
  });

  describe("the rest of the app", () => {
    it("reflects an allow-listed origin with credentials", async () => {
      const res = await preflight("/api/v1/accounts", APP_ORIGIN);
      expect(res.headers["access-control-allow-origin"]).toBe(APP_ORIGIN);
      expect(res.headers["access-control-allow-credentials"]).toBe("true");
    });

    it("refuses a foreign origin", async () => {
      const res = await preflight("/api/v1/accounts", FOREIGN_ORIGIN);
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    });

    it("lets a request with no Origin through", async () => {
      const res = await request(buildApp()).get("/api/v1/accounts");
      expect(res.status).toBe(200);
    });
  });
});
