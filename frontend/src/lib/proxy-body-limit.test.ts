import { describe, it, expect } from "vitest";
import {
  BodyTooLargeError,
  DEFAULT_PROXY_BODY_LIMIT_BYTES,
  LARGE_UPLOAD_ROUTES,
  declaresBodyOver,
  limitBodyStream,
  mnyImportLimitBytes,
  readBoundedBody,
} from "./proxy-body-limit";

const MIB = 1024 * 1024;

function streamOf(...chunks: number[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const size of chunks)
        controller.enqueue(new Uint8Array(size).fill(7));
      controller.close();
    },
  });
}

function limitFor(path: string): number | null {
  const route = LARGE_UPLOAD_ROUTES.find((candidate) =>
    candidate.pattern.test(path),
  );
  return route ? route.limitBytes() : null;
}

describe("declaresBodyOver", () => {
  it("compares a declared length with the limit", () => {
    expect(declaresBodyOver(new Headers({ "content-length": "11" }), 10)).toBe(
      true,
    );
    expect(declaresBodyOver(new Headers({ "content-length": "10" }), 10)).toBe(
      false,
    );
  });

  it("treats a missing or unparsable length as undeclared", () => {
    expect(declaresBodyOver(new Headers(), 10)).toBe(false);
    expect(
      declaresBodyOver(new Headers({ "content-length": "lots" }), 10),
    ).toBe(false);
  });
});

describe("readBoundedBody", () => {
  it("returns the whole body when it fits", async () => {
    const body = await readBoundedBody(streamOf(3, 4), 10);
    expect(body?.byteLength).toBe(7);
  });

  it("answers an empty body for no stream at all", async () => {
    expect((await readBoundedBody(null, 10))?.byteLength).toBe(0);
  });

  it("gives up as soon as the body passes the limit, and stops reading", async () => {
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(4));
      },
    });

    expect(await readBoundedBody(endless, 10)).toBeNull();
    // Three chunks cross 10 bytes; nothing past that point is held or read
    // beyond the stream's own read-ahead.
    expect(pulled).toBeLessThan(6);
  });
});

describe("limitBodyStream", () => {
  async function drain(stream: ReadableStream<Uint8Array>): Promise<number> {
    const reader = stream.getReader();
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return total;
      total += value.byteLength;
    }
  }

  it("passes a body within the limit through unchanged", async () => {
    expect(await drain(limitBodyStream(streamOf(5, 5), 10))).toBe(10);
  });

  it("errors the stream once the limit is passed", async () => {
    await expect(
      drain(limitBodyStream(streamOf(5, 6), 10)),
    ).rejects.toBeInstanceOf(BodyTooLargeError);
  });
});

describe("LARGE_UPLOAD_ROUTES", () => {
  it("names exactly the routes the backend accepts large bodies on", () => {
    expect(limitFor("/api/v1/import/mny/parse")).toBe(mnyImportLimitBytes());
    expect(limitFor("/api/v1/import/kmy/parse")).toBe(mnyImportLimitBytes());
    expect(limitFor("/api/v1/backup/restore")).toBe(mnyImportLimitBytes());
    expect(limitFor("/api/v1/ai/query")).toBe(30 * MIB);
    expect(limitFor("/api/v1/ai/query/stream")).toBe(30 * MIB);
    expect(limitFor("/api/v1/transactions/0c1e/attachments")).toBe(21 * MIB);
    expect(limitFor("/api/v1/email-receipts/mailbox/import")).toBe(26 * MIB);
  });

  it.each([
    "/api/v1/auth/login",
    "/api/v1/backup/restore/ticket",
    "/api/v1/import/mny/start",
    "/api/v1/import/kmy/start",
    "/api/v1/import/kmy/jobs/0c1e",
    "/api/v1/ai/relay/query",
    "/api/v1/transactions/0c1e/attachments/extra",
    "/api/v1/mcp",
    "/api/v1/email-receipts/mailbox/import/extra",
  ])("leaves %s at the default limit", (path) => {
    expect(limitFor(path)).toBeNull();
  });

  it("keeps every large route above the default it exists to exceed", () => {
    for (const route of LARGE_UPLOAD_ROUTES) {
      expect(route.limitBytes()).toBeGreaterThan(
        DEFAULT_PROXY_BODY_LIMIT_BYTES,
      );
    }
  });
});

describe("mnyImportLimitBytes", () => {
  it("follows MNY_IMPORT_LIMIT_MB with room for the multipart framing", () => {
    expect(mnyImportLimitBytes("50")).toBe(58 * MIB);
  });

  it.each([undefined, "", "abc", "-5", "2.5"])(
    "falls back to 300 MB for %s",
    (raw) => {
      expect(mnyImportLimitBytes(raw)).toBe(308 * MIB);
    },
  );
});
