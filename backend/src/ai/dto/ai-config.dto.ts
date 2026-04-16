import {
  IsString,
  IsOptional,
  IsBoolean,
  IsInt,
  IsIn,
  IsObject,
  IsNumber,
  Matches,
  MaxLength,
  Min,
  Max,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { SanitizeHtml } from "../../common/decorators/sanitize-html.decorator";
import { IsSafeConfigObject } from "../validators/safe-config-object.validator";
import {
  AI_PROVIDERS,
  AiProviderType,
} from "../entities/ai-provider-config.entity";

export class CreateAiConfigDto {
  @ApiProperty({
    example: "anthropic",
    description: "AI provider type",
    enum: AI_PROVIDERS,
  })
  @IsString()
  @IsIn([...AI_PROVIDERS])
  provider: AiProviderType;

  @ApiPropertyOptional({
    example: "My Claude API",
    description: "User-friendly display name for this configuration",
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @SanitizeHtml()
  displayName?: string;

  @ApiPropertyOptional({
    example: "claude-sonnet-4-20250514",
    description: "Model identifier for the provider",
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  model?: string;

  @ApiPropertyOptional({
    example: "sk-ant-...",
    description: "API key for the provider (will be encrypted at rest)",
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  apiKey?: string;

  @ApiPropertyOptional({
    example: "https://api.example.com",
    description:
      "Base URL for the provider (required for Ollama and OpenAI-compatible; optional for Ollama Cloud, defaults to https://ollama.com). Self-hosted providers allow private/local URLs.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  baseUrl?: string;

  @ApiPropertyOptional({
    example: 0,
    description: "Priority for fallback ordering (lower = higher priority)",
    default: 0,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  priority?: number;

  @ApiPropertyOptional({
    description: "Provider-specific settings (temperature, maxTokens, etc.)",
  })
  @IsOptional()
  @IsObject()
  @IsSafeConfigObject()
  config?: Record<string, unknown>;

  @ApiPropertyOptional({
    example: 3,
    description:
      "User-defined input cost per 1,000,000 tokens (for usage cost estimation). Set to null to clear.",
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(1000000)
  inputCostPer1M?: number | null;

  @ApiPropertyOptional({
    example: 15,
    description:
      "User-defined output cost per 1,000,000 tokens (for usage cost estimation). Set to null to clear.",
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(1000000)
  outputCostPer1M?: number | null;

  @ApiPropertyOptional({
    example: "USD",
    description:
      "ISO 4217 currency code for the cost rates (e.g. USD, EUR). Defaults to USD.",
  })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{3}$/, {
    message: "costCurrency must be a 3-letter ISO 4217 currency code",
  })
  costCurrency?: string;
}

export class UpdateAiConfigDto {
  @ApiPropertyOptional({
    example: "My Claude API",
    description: "User-friendly display name",
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @SanitizeHtml()
  displayName?: string;

  @ApiPropertyOptional({
    example: "claude-sonnet-4-20250514",
    description: "Model identifier",
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  model?: string;

  @ApiPropertyOptional({
    description: "New API key (will be encrypted, omit to keep existing)",
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  apiKey?: string;

  @ApiPropertyOptional({
    example: "https://api.example.com",
    description:
      "Base URL for the provider. Self-hosted providers allow private/local URLs.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  baseUrl?: string;

  @ApiPropertyOptional({
    example: 0,
    description: "Priority for fallback ordering",
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  priority?: number;

  @ApiPropertyOptional({
    example: true,
    description: "Whether this provider is active",
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({
    description: "Provider-specific settings",
  })
  @IsOptional()
  @IsObject()
  @IsSafeConfigObject()
  config?: Record<string, unknown>;

  @ApiPropertyOptional({
    example: 3,
    description:
      "User-defined input cost per 1,000,000 tokens (for usage cost estimation). Pass null to clear.",
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(1000000)
  inputCostPer1M?: number | null;

  @ApiPropertyOptional({
    example: 15,
    description:
      "User-defined output cost per 1,000,000 tokens (for usage cost estimation). Pass null to clear.",
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(1000000)
  outputCostPer1M?: number | null;

  @ApiPropertyOptional({
    example: "USD",
    description: "ISO 4217 currency code for the cost rates (e.g. USD, EUR).",
  })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{3}$/, {
    message: "costCurrency must be a 3-letter ISO 4217 currency code",
  })
  costCurrency?: string;
}
