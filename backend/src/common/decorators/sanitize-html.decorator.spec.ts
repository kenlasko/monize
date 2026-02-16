import { plainToInstance } from "class-transformer";
import { IsString, IsOptional, MaxLength } from "class-validator";
import { validate } from "class-validator";
import { SanitizeHtml } from "./sanitize-html.decorator";

class TestDto {
  @IsString()
  @MaxLength(100)
  @SanitizeHtml()
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  @SanitizeHtml()
  description?: string;
}

function toDto(plain: Record<string, unknown>): TestDto {
  return plainToInstance(TestDto, plain);
}

describe("SanitizeHtml", () => {
  it("passes through normal strings unchanged", () => {
    const dto = toDto({ name: "Hello World" });
    expect(dto.name).toBe("Hello World");
  });

  it("strips < and > characters from strings", () => {
    const dto = toDto({ name: "<script>alert(1)</script>" });
    expect(dto.name).toBe("scriptalert(1)/script");
  });

  it("strips img onerror XSS payload", () => {
    const dto = toDto({ name: '<img src=x onerror=alert(1)>' });
    expect(dto.name).toBe("img src=x onerror=alert(1)");
  });

  it("handles multiple angle brackets", () => {
    const dto = toDto({ name: "<<bold>>" });
    expect(dto.name).toBe("bold");
  });

  it("preserves null values", () => {
    const dto = toDto({ name: "test", description: null as any });
    expect(dto.description).toBeNull();
  });

  it("preserves undefined values", () => {
    const dto = toDto({ name: "test" });
    expect(dto.description).toBeUndefined();
  });

  it("does not coerce objects to strings (prevents [object Object])", () => {
    const dto = toDto({ name: { $gt: "" } as any });
    // The raw value is an object, so SanitizeHtml returns it as-is
    // and @IsString() will reject it during validation
    expect(dto.name).toEqual({ $gt: "" });
  });

  it("fails validation when an object is passed for a string field", async () => {
    const dto = toDto({ name: { $gt: "" } as any });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe("name");
    expect(errors[0].constraints).toHaveProperty("isString");
  });

  it("preserves strings with ampersands and quotes", () => {
    const dto = toDto({ name: 'Ben & Jerry\'s "Ice Cream"' });
    expect(dto.name).toBe('Ben & Jerry\'s "Ice Cream"');
  });

  it("handles empty strings", () => {
    const dto = toDto({ name: "" });
    expect(dto.name).toBe("");
  });
});
