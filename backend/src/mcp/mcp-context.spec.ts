import {
  confirmWrite,
  hasScope,
  requireScope,
  safeToolError,
  toolError,
  toolResult,
} from "./mcp-context";

function fakeServer(opts: { capabilities?: unknown; elicit?: jest.Mock }): any {
  return {
    server: {
      getClientCapabilities: jest.fn().mockReturnValue(opts.capabilities),
      elicitInput: opts.elicit ?? jest.fn(),
    },
  };
}

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
    it("should return a success response with JSON data", () => {
      const data = { accounts: [{ id: "a1", name: "Checking" }] };
      const result = toolResult(data);
      expect((result as any).isError).toBeUndefined();
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      expect(JSON.parse(result.content[0].text)).toEqual(data);
    });

    it("should pretty-print JSON with 2-space indentation", () => {
      const result = toolResult({ key: "value" });
      expect(result.content[0].text).toBe('{\n  "key": "value"\n}');
    });

    it("should handle arrays", () => {
      const result = toolResult([1, 2, 3]);
      expect(JSON.parse(result.content[0].text)).toEqual([1, 2, 3]);
    });

    it("should handle null and primitive values", () => {
      expect(JSON.parse(toolResult(null).content[0].text)).toBeNull();
      expect(JSON.parse(toolResult(42).content[0].text)).toBe(42);
      expect(JSON.parse(toolResult("hello").content[0].text)).toBe("hello");
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

  describe("confirmWrite", () => {
    const caps = { elicitation: { form: {} } };

    it("returns 'accepted' when the user accepts the elicitation", async () => {
      const elicit = jest.fn().mockResolvedValue({ action: "accept" });
      const server = fakeServer({ capabilities: caps, elicit });
      await expect(confirmWrite(server, "Confirm?")).resolves.toBe("accepted");
      expect(elicit).toHaveBeenCalledWith(
        {
          message: "Confirm?",
          requestedSchema: { type: "object", properties: {} },
        },
        { timeout: expect.any(Number) },
      );
    });

    it("returns 'declined' when the user declines or cancels", async () => {
      const declineServer = fakeServer({
        capabilities: caps,
        elicit: jest.fn().mockResolvedValue({ action: "decline" }),
      });
      await expect(confirmWrite(declineServer, "Confirm?")).resolves.toBe(
        "declined",
      );

      const cancelServer = fakeServer({
        capabilities: caps,
        elicit: jest.fn().mockResolvedValue({ action: "cancel" }),
      });
      await expect(confirmWrite(cancelServer, "Confirm?")).resolves.toBe(
        "declined",
      );
    });

    it("returns 'unsupported' without eliciting when the client lacks the capability", async () => {
      const elicit = jest.fn();
      const server = fakeServer({ capabilities: {}, elicit });
      await expect(confirmWrite(server, "Confirm?")).resolves.toBe(
        "unsupported",
      );
      expect(elicit).not.toHaveBeenCalled();
    });

    it("returns 'unsupported' when capabilities are undefined", async () => {
      const server = fakeServer({ capabilities: undefined });
      await expect(confirmWrite(server, "Confirm?")).resolves.toBe(
        "unsupported",
      );
    });

    it("returns 'declined' (never silently proceeds) when a supported dialog errors or times out", async () => {
      const elicit = jest.fn().mockRejectedValue(new Error("timed out"));
      const server = fakeServer({ capabilities: caps, elicit });
      await expect(confirmWrite(server, "Confirm?")).resolves.toBe("declined");
    });
  });
});
