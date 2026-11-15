import { ConfirmRequiredError } from "./mcp-confirm";
import {
  callerKey,
  hasScope,
  requireScope,
  resolveUserContext,
  safeToolError,
  toAuthInfo,
  toolError,
  toolResult,
} from "./mcp-context";

describe("mcp-context", () => {
  describe("hasScope", () => {
    it("should return true when scope is present", () => {
      expect(hasScope("read,write,reports", "read")).toBe(true);
      expect(hasScope("read,write,reports", "write")).toBe(true);
      expect(hasScope("read,write,reports", "reports")).toBe(true);
    });

    it("should return false when scope is missing", () => {
      expect(hasScope("read", "write")).toBe(false);
      expect(hasScope("read,reports", "write")).toBe(false);
    });

    it("should handle single scope", () => {
      expect(hasScope("read", "read")).toBe(true);
    });

    it("should not match partial scope names", () => {
      expect(hasScope("readonly", "read")).toBe(false);
      expect(hasScope("read", "readonly")).toBe(false);
    });
  });

  describe("requireScope", () => {
    it("should return error: false when scope is present", () => {
      const result = requireScope("read,write", "read");
      expect(result.error).toBe(false);
    });

    it("should return error result when scope is missing", () => {
      const result = requireScope("read", "write");
      expect(result.error).toBe(true);
      if (result.error) {
        expect(result.result.isError).toBe(true);
        expect(result.result.content[0].text).toContain("write");
        expect(result.result.content[0].text).toContain("Insufficient scope");
      }
    });

    it("should mention the required scope in the error message", () => {
      const result = requireScope("read", "reports");
      if (result.error) {
        expect(result.result.content[0].text).toContain('"reports"');
      }
    });
  });

  describe("toolError", () => {
    it("should return an error response with message", () => {
      const result = toolError("Something went wrong");
      expect(result.isError).toBe(true);
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      expect(result.content[0].text).toContain("Something went wrong");
      expect(result.content[0].text).toContain("Error:");
    });
  });

  describe("safeToolError", () => {
    it("should pass through the message of a ConfirmRequiredError", () => {
      const err = new ConfirmRequiredError();
      const result = safeToolError(err);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(err.message);
    });

    it("should pass through message for a 404 NotFoundException", () => {
      const notFoundErr = {
        getStatus: () => 404,
        getResponse: () => ({ message: "Category not found" }),
      };
      const result = safeToolError(notFoundErr);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Category not found");
    });

    it("should pass through message for a 400 BadRequestException", () => {
      const badRequestErr = {
        getStatus: () => 400,
        getResponse: () => ({ message: "Invalid account ID" }),
      };
      const result = safeToolError(badRequestErr);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Invalid account ID");
    });

    it("should return generic message for a plain Error without getStatus", () => {
      const plainErr = new Error("Something broke internally");
      const result = safeToolError(plainErr);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(
        "An error occurred while processing your request",
      );
      expect(result.content[0].text).not.toContain(
        "Something broke internally",
      );
    });

    it("should return generic message for null or undefined", () => {
      const nullResult = safeToolError(null);
      expect(nullResult.isError).toBe(true);
      expect(nullResult.content[0].text).toContain(
        "An error occurred while processing your request",
      );

      const undefinedResult = safeToolError(undefined);
      expect(undefinedResult.isError).toBe(true);
      expect(undefinedResult.content[0].text).toContain(
        "An error occurred while processing your request",
      );
    });

    it("should return generic message for a 500 InternalServerError", () => {
      const serverErr = {
        getStatus: () => 500,
        getResponse: () => ({ message: "Internal server error" }),
      };
      const result = safeToolError(serverErr);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(
        "An error occurred while processing your request",
      );
      expect(result.content[0].text).not.toContain("Internal server error");
    });
  });

  describe("toolResult", () => {
    it("returns the payload once, as structured content", () => {
      // Not twice. Every tool declares an outputSchema, so structuredContent is
      // what the SDK validates and what a client reads; the pretty-printed text
      // block beside it made a model pay for the same answer a second time.
      const data = { accounts: [{ id: "a1", name: "Checking" }] };
      const result = toolResult(data);
      expect((result as any).isError).toBeUndefined();
      expect(result.content).toEqual([]);
      expect(result.structuredContent as any).toEqual(data);
    });

    it("keeps the text block for errors, which carry no structured content", () => {
      const result = toolError("Unknown account");
      expect(result.content[0].text).toBe("Error: Unknown account");
      expect((result as any).structuredContent).toBeUndefined();
      expect(result.isError).toBe(true);
    });

    it("handles arrays and primitives through structured content alone", () => {
      expect(toolResult([1, 2, 3]).structuredContent).toEqual({
        items: [1, 2, 3],
      });
      expect(toolResult(null).structuredContent).toEqual({ value: null });
      expect(toolResult(42).structuredContent).toEqual({ value: 42 });
      expect(toolResult("hello").structuredContent).toEqual({ value: "hello" });
    });

    describe("structuredContent", () => {
      it("passes an object payload through unchanged", () => {
        const data = { netWorth: 1000, totalAccounts: 2 };
        const result = toolResult(data);
        expect(result.structuredContent).toEqual(data);
      });

      it("wraps a bare array under 'items' (structured content must be an object)", () => {
        const result = toolResult([{ id: "a1" }, { id: "a2" }]);
        expect(result.structuredContent).toEqual({
          items: [{ id: "a1" }, { id: "a2" }],
        });
      });

      it("wraps a primitive payload under 'value'", () => {
        expect(toolResult(42).structuredContent).toEqual({ value: 42 });
        expect(toolResult(null).structuredContent).toEqual({ value: null });
      });
    });
  });

  // Identity is a property of the REQUEST: the credential the transport
  // validated travels as the SDK's AuthInfo, and a handler reads the caller
  // from there and from nowhere else (INV-MCP-001).
  describe("request identity", () => {
    const user = {
      userId: "u1",
      scopes: "read,write",
      credentialId: "pat:t1",
    };

    it("round-trips the caller through AuthInfo", () => {
      const authInfo = toAuthInfo(user, "tok");
      expect(authInfo).toMatchObject({
        token: "tok",
        clientId: "pat:t1",
        scopes: ["read", "write"],
      });
      expect(resolveUserContext({ http: { authInfo } } as any)).toEqual(user);
    });

    // An OAuth grant with no id cannot be bound to a session or to a
    // confirmation, so the transport has nothing to serve it with.
    it("refuses a credential that cannot be identified", () => {
      expect(
        toAuthInfo({ userId: "u1", scopes: "read" }, "tok"),
      ).toBeUndefined();
    });

    it("answers undefined rather than trusting a malformed authInfo", () => {
      expect(resolveUserContext({} as any)).toBeUndefined();
      expect(
        resolveUserContext({ http: { authInfo: { extra: {} } } } as any),
      ).toBeUndefined();
      expect(
        resolveUserContext({
          http: { authInfo: { extra: { userId: 7, scopes: "read" } } },
        } as any),
      ).toBeUndefined();
    });

    // The relay claim is a question about one connected client. A 2025-era
    // connection answers it with its session; a 2026-07-28 request has none,
    // so the credential is the only stable per-client fact on the wire.
    describe("callerKey", () => {
      const authInfo = toAuthInfo(user, "tok");

      it("is the session id on a 2025-era connection", () => {
        expect(callerKey({ sessionId: "s1", http: { authInfo } } as any)).toBe(
          "s1",
        );
      });

      it("is the credential id on a 2026-07-28 request", () => {
        expect(callerKey({ http: { authInfo } } as any)).toBe("pat:t1");
      });

      it("is undefined when neither can be proven", () => {
        expect(callerKey({} as any)).toBeUndefined();
      });
    });
  });
});
