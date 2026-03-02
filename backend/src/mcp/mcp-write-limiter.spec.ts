import { McpWriteLimiter, MCP_DAILY_WRITE_LIMIT } from "./mcp-write-limiter";

describe("McpWriteLimiter", () => {
  let limiter: McpWriteLimiter;

  beforeEach(() => {
    limiter = new McpWriteLimiter();
  });

  describe("checkLimit()", () => {
    it("allows operations when no previous writes exist", () => {
      const result = limiter.checkLimit("user-1");
      expect(result.allowed).toBe(true);
      expect(result.currentCount).toBe(0);
      expect(result.limit).toBe(MCP_DAILY_WRITE_LIMIT);
    });

    it("tracks operations per user", () => {
      limiter.record("user-1", "create_transaction");
      limiter.record("user-1", "categorize_transaction");

      const u1 = limiter.checkLimit("user-1");
      expect(u1.currentCount).toBe(2);
      expect(u1.allowed).toBe(true);

      const u2 = limiter.checkLimit("user-2");
      expect(u2.currentCount).toBe(0);
      expect(u2.allowed).toBe(true);
    });

    it("blocks when daily limit is reached", () => {
      for (let i = 0; i < MCP_DAILY_WRITE_LIMIT; i++) {
        limiter.record("user-1", "create_transaction");
      }

      const result = limiter.checkLimit("user-1");
      expect(result.allowed).toBe(false);
      expect(result.currentCount).toBe(MCP_DAILY_WRITE_LIMIT);
      expect(result.limit).toBe(MCP_DAILY_WRITE_LIMIT);
    });

    it("allows operations up to but not beyond the limit", () => {
      for (let i = 0; i < MCP_DAILY_WRITE_LIMIT - 1; i++) {
        limiter.record("user-1", "create_transaction");
      }

      const beforeLimit = limiter.checkLimit("user-1");
      expect(beforeLimit.allowed).toBe(true);
      expect(beforeLimit.currentCount).toBe(MCP_DAILY_WRITE_LIMIT - 1);

      limiter.record("user-1", "create_transaction");

      const atLimit = limiter.checkLimit("user-1");
      expect(atLimit.allowed).toBe(false);
      expect(atLimit.currentCount).toBe(MCP_DAILY_WRITE_LIMIT);
    });

    it("does not count operations from other users", () => {
      for (let i = 0; i < MCP_DAILY_WRITE_LIMIT; i++) {
        limiter.record("user-2", "create_transaction");
      }

      const result = limiter.checkLimit("user-1");
      expect(result.allowed).toBe(true);
      expect(result.currentCount).toBe(0);
    });
  });

  describe("record()", () => {
    it("records an operation", () => {
      limiter.record("user-1", "create_transaction");

      const result = limiter.checkLimit("user-1");
      expect(result.currentCount).toBe(1);
    });

    it("records multiple operations", () => {
      limiter.record("user-1", "create_transaction");
      limiter.record("user-1", "categorize_transaction");
      limiter.record("user-1", "create_transaction");

      const result = limiter.checkLimit("user-1");
      expect(result.currentCount).toBe(3);
    });
  });

  describe("pruning expired operations", () => {
    it("prunes operations older than 24 hours", () => {
      // Record operations and manually set old timestamps
      limiter.record("user-1", "create_transaction");

      // Access internal state to set an old timestamp
      const operations = (limiter as any).operations;
      operations[0].timestamp = Date.now() - 25 * 60 * 60 * 1000; // 25 hours ago

      // Check should trigger pruning
      const result = limiter.checkLimit("user-1");
      expect(result.currentCount).toBe(0);
      expect(result.allowed).toBe(true);
    });

    it("keeps operations within 24 hours", () => {
      limiter.record("user-1", "create_transaction");

      // Still recent, should be counted
      const result = limiter.checkLimit("user-1");
      expect(result.currentCount).toBe(1);
    });
  });

  describe("MCP_DAILY_WRITE_LIMIT constant", () => {
    it("is set to 50", () => {
      expect(MCP_DAILY_WRITE_LIMIT).toBe(50);
    });
  });
});
