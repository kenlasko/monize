import { OpenAiProvider } from "./openai.provider";

export class OpenAiCompatibleProvider extends OpenAiProvider {
  override readonly name = "openai-compatible";

  constructor(apiKey: string, baseUrl: string, model: string) {
    super(apiKey, model, baseUrl);
  }
}
