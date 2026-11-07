import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import { HELP_SLUG_RE } from "../help.constants";

export const HELP_SEARCH_QUERY_MAX_LENGTH = 200;
export const HELP_SEARCH_MIN_LIMIT = 1;
export const HELP_SEARCH_MAX_LIMIT = 20;
export const HELP_SEARCH_DEFAULT_LIMIT = 10;

/** Query of `GET /help/search`. Public, like the rest of `HelpController`. */
export class HelpSearchQueryDto {
  @ApiProperty({ description: "The search text, trimmed, 1-200 characters." })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(HELP_SEARCH_QUERY_MAX_LENGTH)
  q: string;

  @ApiPropertyOptional({
    description:
      "The current screen's help page slug; its sections are boosted. A slug the guide does not have is ignored rather than refused.",
  })
  @IsOptional()
  @IsString()
  @Matches(HELP_SLUG_RE)
  context?: string;

  @ApiPropertyOptional({
    minimum: HELP_SEARCH_MIN_LIMIT,
    maximum: HELP_SEARCH_MAX_LIMIT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(HELP_SEARCH_MIN_LIMIT)
  @Max(HELP_SEARCH_MAX_LIMIT)
  limit?: number;
}
