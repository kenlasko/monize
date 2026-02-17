import { OpenAiCompatibleProvider } from "./openai-compatible.provider";

jest.mock("openai", () => {
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
      chat: { completions: { create: jest.fn() } },
      models: { list: jest.fn() },
    })),
  };
});

describe("OpenAiCompatibleProvider", () => {
  it("has name openai-compatible", () => {
    const provider = new OpenAiCompatibleProvider(
      "test-key",
      "https://api.groq.com/openai/v1",
      "mixtral-8x7b",
    );
    expect(provider.name).toBe("openai-compatible");
    expect(provider.supportsStreaming).toBe(true);
    expect(provider.supportsToolUse).toBe(true);
  });
});
