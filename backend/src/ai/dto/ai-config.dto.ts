import {
  IsString,
  IsOptional,
  IsBoolean,
  IsInt,
  IsIn,
  IsObject,
  MaxLength,
  Min,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { SanitizeHtml } from "../../common/decorators/sanitize-html.decorator";
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
    example: "http://localhost:11434",
    description:
      "Base URL for the provider (required for Ollama and OpenAI-compatible)",
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
  priority?: number;

  @ApiPropertyOptional({
    description: "Provider-specific settings (temperature, maxTokens, etc.)",
  })
  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;
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
    example: "http://localhost:11434",
    description: "Base URL for the provider",
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
  config?: Record<string, unknown>;
}
