import { McpBudgetCheckPrompt } from "./budget-check.prompt";

describe("McpBudgetCheckPrompt", () => {
  let prompt: McpBudgetCheckPrompt;
  let server: { registerPrompt: jest.Mock };
  let handler: (...args: any[]) => any;

  beforeEach(() => {
    prompt = new McpBudgetCheckPrompt();

    server = {
      registerPrompt: jest.fn((_name, _opts, h) => {
        handler = h;
      }),
    };

    prompt.register(server as any);
  });

  it("should register the prompt", () => {
    expect(server.registerPrompt).toHaveBeenCalledWith(
      "budget-check",
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("should return messages with default month", async () => {
    const result = await handler({});
    expect(result.messages[0].content.text).toContain("this month");
  });

  it("should use provided month", async () => {
    const result = await handler({ month: "January 2025" });
    expect(result.messages[0].content.text).toContain("January 2025");
  });
});
