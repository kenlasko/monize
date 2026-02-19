import { McpTransactionLookupPrompt } from "./transaction-lookup.prompt";

describe("McpTransactionLookupPrompt", () => {
  let prompt: McpTransactionLookupPrompt;
  let server: { registerPrompt: jest.Mock };
  let handler: (...args: any[]) => any;

  beforeEach(() => {
    prompt = new McpTransactionLookupPrompt();

    server = {
      registerPrompt: jest.fn((_name, _opts, h) => {
        handler = h;
      }),
    };

    prompt.register(server as any);
  });

  it("should register the prompt", () => {
    expect(server.registerPrompt).toHaveBeenCalledWith(
      "transaction-lookup",
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("should include the query in the message", async () => {
    const result = await handler({ query: "Amazon purchases last month" });
    expect(result.messages[0].content.text).toContain(
      "Amazon purchases last month",
    );
  });
});
