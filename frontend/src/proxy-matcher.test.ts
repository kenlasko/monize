import { describe, it, expect } from "vitest";
import { AsyncLocalStorage } from "node:async_hooks";
import { config } from "./proxy";
import { LARGE_UPLOAD_ROUTES } from "@/lib/proxy-body-limit";

// Next's server modules read `AsyncLocalStorage` from the global when they are
// first evaluated; Next's own server sets it, a test has to. Set before the
// dynamic import below loads them.
(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage ??=
  AsyncLocalStorage;

const BASE = "https://monize.example";

/**
 * The matcher is the half of the body limit the proxy's code cannot see: Next
 * copies the body of every request the proxy matches into memory before the
 * proxy runs, so a large-upload path left in the matcher has its body buffered
 * whatever the route handler does, and a path wrongly excluded is served by
 * nothing. Checked with Next's own matcher compiler rather than a copy of it.
 */
describe("proxy matcher", () => {
  async function matches(path: string): Promise<boolean> {
    const { unstable_doesMiddlewareMatch } =
      await import("next/experimental/testing/server");
    return unstable_doesMiddlewareMatch({ config, url: `${BASE}${path}` });
  }

  it.each([
    "/api/v1/import/mny/parse",
    "/api/v1/import/kmy/parse",
    "/api/v1/backup/restore",
    "/api/v1/ai/query",
    "/api/v1/ai/query/stream",
    "/api/v1/transactions/0c1e/attachments",
    "/api/v1/email-receipts/mailbox/import",
  ])("leaves the large upload %s to its route handler", async (path) => {
    expect(await matches(path)).toBe(false);
    expect(LARGE_UPLOAD_ROUTES.some((route) => route.pattern.test(path))).toBe(
      true,
    );
  });

  it.each([
    "/api/v1/auth/login",
    "/api/v1/backup/restore/ticket",
    "/api/v1/import/mny/start",
    "/api/v1/import/kmy/start",
    "/api/v1/import/kmy/parse/extra",
    "/api/v1/transactions/0c1e/attachments/x",
    "/api/v1/ai/relay/query",
    "/api/v1/email-receipts/mailbox",
    "/api/v1/email-receipts/mailbox/poll",
    "/oauth/token",
    "/",
    "/dashboard",
  ])("still proxies %s", async (path) => {
    expect(await matches(path)).toBe(true);
    expect(LARGE_UPLOAD_ROUTES.some((route) => route.pattern.test(path))).toBe(
      false,
    );
  });
});
