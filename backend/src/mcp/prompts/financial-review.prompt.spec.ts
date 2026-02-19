import { McpFinancialReviewPrompt } from "./financial-review.prompt";

describe("McpFinancialReviewPrompt", () => {
  let prompt: McpFinancialReviewPrompt;
  let server: { registerPrompt: jest.Mock };
  let handler: (...args: any[]) => any;

  beforeEach(() => {
    prompt = new McpFinancialReviewPrompt();

    server = {
      registerPrompt: jest.fn((_name, _opts, h) => {
        handler = h;
      }),
    };

    prompt.register(server as any);
  });

  it("should register the prompt", () => {
    expect(server.registerPrompt).toHaveBeenCalledWith(
      "financial-review",
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("should return messages with default period", async () => {
    const result = await handler({});
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("user");
    expect(result.messages[0].content.text).toContain("the current month");
  });

  it("should use provided period", async () => {
    const result = await handler({ period: "last quarter" });
    expect(result.messages[0].content.text).toContain("last quarter");
  });
});
