// Mock undici BEFORE importing the helper, so the helper picks up our mocks.
const mockUndiciFetch = jest.fn();
const mockAgentInstances: Array<{ options: unknown; dispatch: jest.Mock }> = [];

jest.mock("undici", () => {
  return {
    Agent: jest.fn().mockImplementation((options: unknown) => {
      const instance = { options, dispatch: jest.fn() };
      mockAgentInstances.push(instance);
      return instance;
    }),
    fetch: mockUndiciFetch,
  };
});

import { longRunningAgent, longRunningFetch } from "./long-running-fetch";

describe("long-running-fetch", () => {
  beforeEach(() => {
    mockUndiciFetch.mockReset();
    mockUndiciFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
    });
  });

  describe("longRunningAgent", () => {
    it("is constructed with body and headers timeouts disabled", () => {
      // The Agent mock captured the constructor options at module load time.
      const constructed = mockAgentInstances[0];
      expect(constructed).toBeDefined();
      expect(constructed.options).toEqual({
        bodyTimeout: 0,
        headersTimeout: 0,
      });
    });

    it("is the same instance the helper exports", () => {
      // Sanity check: longRunningAgent is the mocked Agent instance.
      expect(longRunningAgent).toBe(mockAgentInstances[0]);
    });
  });

  describe("longRunningFetch", () => {
    it("calls undici.fetch (not global fetch) with the long-running dispatcher", async () => {
      await longRunningFetch("https://example.test/api", {
        method: "POST",
        body: JSON.stringify({ ping: true }),
      });

      expect(mockUndiciFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockUndiciFetch.mock.calls[0];
      expect(url).toBe("https://example.test/api");
      expect(init.method).toBe("POST");
      expect(init.dispatcher).toBe(longRunningAgent);
    });

    it("passes through caller-provided init options", async () => {
      const headers = { "X-Custom": "value" };
      await longRunningFetch("https://example.test/api", {
        method: "GET",
        headers,
      });

      const [, init] = mockUndiciFetch.mock.calls[0];
      expect(init.method).toBe("GET");
      expect(init.headers).toBe(headers);
      expect(init.dispatcher).toBe(longRunningAgent);
    });

    it("works without any caller-provided init", async () => {
      await longRunningFetch("https://example.test/api");

      const [, init] = mockUndiciFetch.mock.calls[0];
      expect(init.dispatcher).toBe(longRunningAgent);
    });

    it("does not call globalThis.fetch", async () => {
      // Critical regression: globalThis.fetch (Node's built-in) silently
      // ignores or rejects an Agent instance from a separately-installed
      // undici package. The helper must call undici.fetch directly.
      const globalFetchSpy = jest.fn();
      const originalGlobalFetch = global.fetch;
      global.fetch = globalFetchSpy as unknown as typeof fetch;
      try {
        await longRunningFetch("https://example.test/api");
        expect(globalFetchSpy).not.toHaveBeenCalled();
        expect(mockUndiciFetch).toHaveBeenCalled();
      } finally {
        global.fetch = originalGlobalFetch;
      }
    });

    it("matches the global fetch signature", () => {
      // Compile-time check: longRunningFetch must be assignable to typeof fetch
      const f: typeof fetch = longRunningFetch;
      expect(typeof f).toBe("function");
    });
  });
});
