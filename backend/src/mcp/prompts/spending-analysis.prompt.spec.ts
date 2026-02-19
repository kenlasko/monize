import { McpSpendingAnalysisPrompt } from "./spending-analysis.prompt";

describe("McpSpendingAnalysisPrompt", () => {
  let prompt: McpSpendingAnalysisPrompt;
  let server: { registerPrompt: jest.Mock };
  let handler: (...args: any[]) => any;

  beforeEach(() => {
    prompt = new McpSpendingAnalysisPrompt();

    server = {
      registerPrompt: jest.fn((_name, _opts, h) => {
        handler = h;
      }),
    };

    prompt.register(server as any);
  });

  it("should register the prompt", () => {
    expect(server.registerPrompt).toHaveBeenCalledWith(
      "spending-analysis",
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("should use default category and period", async () => {
    const result = await handler({});
    expect(result.messages[0].content.text).toContain("all categories");
    expect(result.messages[0].content.text).toContain("the last 3 months");
  });

  it("should use provided category and period", async () => {
    const result = await handler({ category: "Food", period: "2025" });
    expect(result.messages[0].content.text).toContain("Food");
    expect(result.messages[0].content.text).toContain("2025");
  });
});
