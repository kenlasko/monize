import "reflect-metadata";
import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { CreateAiConfigDto, UpdateAiConfigDto } from "./ai-config.dto";

describe("CreateAiConfigDto", () => {
  function createDto(data: Record<string, unknown>): CreateAiConfigDto {
    return plainToInstance(CreateAiConfigDto, data, {
      enableImplicitConversion: true,
    });
  }

  it("accepts valid anthropic config", async () => {
    const dto = createDto({
      provider: "anthropic",
      apiKey: "sk-ant-test-key",
      model: "claude-sonnet-4-20250514",
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it("accepts valid openai config", async () => {
    const dto = createDto({
      provider: "openai",
      apiKey: "sk-test-key",
      model: "gpt-4o",
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it("accepts valid ollama config without API key", async () => {
    const dto = createDto({
      provider: "ollama",
      baseUrl: "http://ollama-server.example.com:11434",
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it("accepts valid openai-compatible config", async () => {
    const dto = createDto({
      provider: "openai-compatible",
      apiKey: "sk-test",
      baseUrl: "https://api.example.com",
      model: "custom-model",
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it("requires provider field", async () => {
    const dto = createDto({ apiKey: "sk-test" });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    const providerErrors = errors.find((e) => e.property === "provider");
    expect(providerErrors).toBeDefined();
  });

  it("rejects invalid provider value", async () => {
    const dto = createDto({ provider: "invalid-provider" });
    const errors = await validate(dto);
    const providerErrors = errors.find((e) => e.property === "provider");
    expect(providerErrors).toBeDefined();
    expect(providerErrors!.constraints).toHaveProperty("isIn");
  });

  it("accepts all valid provider types", async () => {
    for (const provider of [
      "anthropic",
      "openai",
      "ollama",
      "openai-compatible",
    ]) {
      const dto = createDto({ provider });
      const errors = await validate(dto);
      const providerErrors = errors.find((e) => e.property === "provider");
      expect(providerErrors).toBeUndefined();
    }
  });

  it("rejects displayName exceeding 100 characters", async () => {
    const dto = createDto({
      provider: "anthropic",
      displayName: "a".repeat(101),
    });
    const errors = await validate(dto);
    const nameErrors = errors.find((e) => e.property === "displayName");
    expect(nameErrors).toBeDefined();
  });

  it("accepts displayName at exactly 100 characters", async () => {
    const dto = createDto({
      provider: "anthropic",
      displayName: "a".repeat(100),
    });
    const errors = await validate(dto);
    const nameErrors = errors.find((e) => e.property === "displayName");
    expect(nameErrors).toBeUndefined();
  });

  it("rejects model exceeding 100 characters", async () => {
    const dto = createDto({
      provider: "anthropic",
      model: "m".repeat(101),
    });
    const errors = await validate(dto);
    const modelErrors = errors.find((e) => e.property === "model");
    expect(modelErrors).toBeDefined();
  });

  it("rejects apiKey exceeding 2000 characters", async () => {
    const dto = createDto({
      provider: "anthropic",
      apiKey: "k".repeat(2001),
    });
    const errors = await validate(dto);
    const keyErrors = errors.find((e) => e.property === "apiKey");
    expect(keyErrors).toBeDefined();
  });

  it("rejects baseUrl exceeding 500 characters", async () => {
    const dto = createDto({
      provider: "ollama",
      baseUrl: "http://example.com/" + "x".repeat(500),
    });
    const errors = await validate(dto);
    const urlErrors = errors.find((e) => e.property === "baseUrl");
    expect(urlErrors).toBeDefined();
  });

  it("rejects negative priority", async () => {
    const dto = createDto({
      provider: "anthropic",
      priority: -1,
    });
    const errors = await validate(dto);
    const priorityErrors = errors.find((e) => e.property === "priority");
    expect(priorityErrors).toBeDefined();
  });

  it("accepts priority of 0", async () => {
    const dto = createDto({
      provider: "anthropic",
      priority: 0,
    });
    const errors = await validate(dto);
    const priorityErrors = errors.find((e) => e.property === "priority");
    expect(priorityErrors).toBeUndefined();
  });

  it("rejects non-integer priority", async () => {
    const dto = createDto({
      provider: "anthropic",
      priority: 1.5,
    });
    const errors = await validate(dto);
    const priorityErrors = errors.find((e) => e.property === "priority");
    expect(priorityErrors).toBeDefined();
  });

  it("rejects non-object config", async () => {
    const dto = createDto({
      provider: "anthropic",
      config: "not-an-object",
    });
    const errors = await validate(dto);
    const configErrors = errors.find((e) => e.property === "config");
    expect(configErrors).toBeDefined();
  });

  it("accepts valid config object", async () => {
    const dto = createDto({
      provider: "anthropic",
      config: { temperature: 0.7, maxTokens: 2048 },
    });
    const errors = await validate(dto);
    const configErrors = errors.find((e) => e.property === "config");
    expect(configErrors).toBeUndefined();
  });

  it("strips HTML from displayName via SanitizeHtml", () => {
    const dto = createDto({
      provider: "anthropic",
      displayName: "My <b>Config</b>",
    });
    expect(dto.displayName).not.toContain("<");
    expect(dto.displayName).not.toContain(">");
  });

  it("allows all optional fields to be omitted", async () => {
    const dto = createDto({ provider: "anthropic" });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });
});

describe("UpdateAiConfigDto", () => {
  function createDto(data: Record<string, unknown>): UpdateAiConfigDto {
    return plainToInstance(UpdateAiConfigDto, data, {
      enableImplicitConversion: true,
    });
  }

  it("accepts valid partial update", async () => {
    const dto = createDto({ model: "claude-haiku-4-20250414" });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it("accepts empty object (no updates)", async () => {
    const dto = createDto({});
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it("rejects displayName exceeding 100 characters", async () => {
    const dto = createDto({ displayName: "a".repeat(101) });
    const errors = await validate(dto);
    const nameErrors = errors.find((e) => e.property === "displayName");
    expect(nameErrors).toBeDefined();
  });

  it("rejects model exceeding 100 characters", async () => {
    const dto = createDto({ model: "m".repeat(101) });
    const errors = await validate(dto);
    const modelErrors = errors.find((e) => e.property === "model");
    expect(modelErrors).toBeDefined();
  });

  it("rejects apiKey exceeding 2000 characters", async () => {
    const dto = createDto({ apiKey: "k".repeat(2001) });
    const errors = await validate(dto);
    const keyErrors = errors.find((e) => e.property === "apiKey");
    expect(keyErrors).toBeDefined();
  });

  it("rejects baseUrl exceeding 500 characters", async () => {
    const dto = createDto({ baseUrl: "http://x.com/" + "x".repeat(500) });
    const errors = await validate(dto);
    const urlErrors = errors.find((e) => e.property === "baseUrl");
    expect(urlErrors).toBeDefined();
  });

  it("rejects negative priority", async () => {
    const dto = createDto({ priority: -1 });
    const errors = await validate(dto);
    const priorityErrors = errors.find((e) => e.property === "priority");
    expect(priorityErrors).toBeDefined();
  });

  it("accepts boolean isActive", async () => {
    const dto = createDto({ isActive: false });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
    expect(dto.isActive).toBe(false);
  });

  it("accepts true/false isActive values", async () => {
    const dtoTrue = createDto({ isActive: true });
    const errorsTrue = await validate(dtoTrue);
    expect(errorsTrue).toHaveLength(0);
    expect(dtoTrue.isActive).toBe(true);

    const dtoFalse = createDto({ isActive: false });
    const errorsFalse = await validate(dtoFalse);
    expect(errorsFalse).toHaveLength(0);
    expect(dtoFalse.isActive).toBe(false);
  });

  it("rejects non-object config", async () => {
    const dto = createDto({ config: "not-an-object" });
    const errors = await validate(dto);
    const configErrors = errors.find((e) => e.property === "config");
    expect(configErrors).toBeDefined();
  });

  it("strips HTML from displayName via SanitizeHtml", () => {
    const dto = createDto({ displayName: "Test <script>xss</script>" });
    expect(dto.displayName).not.toContain("<");
    expect(dto.displayName).not.toContain(">");
  });
});
