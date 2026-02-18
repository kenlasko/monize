import "reflect-metadata";
import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { AiQueryDto } from "./ai-query.dto";

describe("AiQueryDto", () => {
  function createDto(data: Record<string, unknown>): AiQueryDto {
    return plainToInstance(AiQueryDto, data, {
      enableImplicitConversion: true,
    });
  }

  it("accepts a valid query string", async () => {
    const dto = createDto({ query: "How much did I spend last month?" });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it("rejects an empty query", async () => {
    const dto = createDto({ query: "" });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    const messages = errors.flatMap((e) => Object.values(e.constraints || {}));
    expect(messages.some((m) => m.includes("should not be empty"))).toBe(true);
  });

  it("rejects a missing query", async () => {
    const dto = createDto({});
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("rejects non-string query", async () => {
    const dto = createDto({ query: 12345 });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("rejects query exceeding 2000 characters", async () => {
    const dto = createDto({ query: "a".repeat(2001) });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    const messages = errors.flatMap((e) => Object.values(e.constraints || {}));
    expect(
      messages.some((m) => m.includes("must be shorter than or equal to 2000")),
    ).toBe(true);
  });

  it("accepts query at exactly 2000 characters", async () => {
    const dto = createDto({ query: "a".repeat(2000) });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it("strips HTML angle brackets via SanitizeHtml", () => {
    const dto = createDto({
      query: "Hello <script>alert('xss')</script> world",
    });
    // SanitizeHtml strips < and >
    expect(dto.query).not.toContain("<");
    expect(dto.query).not.toContain(">");
  });
});
