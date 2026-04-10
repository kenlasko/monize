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

  it("inherits streamWithTools from OpenAiProvider", () => {
    const provider = new OpenAiCompatibleProvider(
      "test-key",
      "https://api.groq.com/openai/v1",
      "mixtral-8x7b",
    );
    // streamWithTools is the realtime feedback path; openai-compatible should
    // pick it up through inheritance so any OpenAI-API-compatible backend
    // (Groq, vLLM, LM Studio, etc.) gets streaming for free.
    expect(typeof provider.streamWithTools).toBe("function");
  });
});
