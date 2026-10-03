import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsCalendarDate } from "../../common/validators/is-calendar-date.validator";
import { MAX_RULE_ACTIONS } from "../rule-validation";
import {
  DEFAULT_RULE_RUN_LIMIT,
  MAX_RULE_RUN_ACCOUNTS,
  MAX_RULE_RUN_LIMIT,
} from "../transaction-rules.limits";

/** Which existing transactions a manual run or a test looks at. */
export class RuleRunFiltersDto {
  @ApiPropertyOptional({
    type: [String],
    description: "Only these accounts (default: all of them)",
    maxItems: MAX_RULE_RUN_ACCOUNTS,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_RULE_RUN_ACCOUNTS)
  @ArrayUnique()
  @IsUUID("all", { each: true })
  accountIds?: string[];

  @ApiPropertyOptional({ example: "2026-01-01", description: "Inclusive" })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null && v !== "")
  @IsCalendarDate({
    message: "startDate must be a real YYYY-MM-DD calendar date",
  })
  startDate?: string;

  @ApiPropertyOptional({ example: "2026-12-31", description: "Inclusive" })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null && v !== "")
  @IsCalendarDate({
    message: "endDate must be a real YYYY-MM-DD calendar date",
  })
  endDate?: string;

  @ApiPropertyOptional({
    description: "Newest rows examined",
    default: DEFAULT_RULE_RUN_LIMIT,
    minimum: 1,
    maximum: MAX_RULE_RUN_LIMIT,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_RULE_RUN_LIMIT)
  limit?: number;
}

/** The commit: the same filters plus the fingerprint of the preview being confirmed. */
export class RunTransactionRuleDto extends RuleRunFiltersDto {
  @ApiProperty({
    description: "The fingerprint the preview returned",
    example: "0".repeat(64),
  })
  @IsString()
  @Matches(/^[0-9a-f]{64}$/)
  fingerprint: string;
}

/** An unsaved rule to test. Validated exactly like a create. */
export class PreviewDraftRuleDto {
  @ApiPropertyOptional({
    format: "uuid",
    description:
      "The saved rule this draft edits. When the draft condition equals its stored condition, the glob-trap advice is skipped, as a save would",
  })
  @IsOptional()
  @IsUUID()
  ruleId?: string;

  @ApiProperty({ type: "object", additionalProperties: true })
  @IsObject()
  condition: Record<string, unknown>;

  @ApiProperty({
    type: "array",
    items: { type: "object", additionalProperties: true },
    maxItems: MAX_RULE_ACTIONS,
  })
  @IsArray()
  @ArrayMaxSize(MAX_RULE_ACTIONS)
  actions: Record<string, unknown>[];

  @ApiPropertyOptional({
    example: "2026-10-01",
    nullable: true,
    description:
      "The draft's active window start (inclusive); rows dated before it are not evaluated, as for a saved rule",
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null && v !== "")
  @IsCalendarDate({
    message: "activeFrom must be a real YYYY-MM-DD calendar date",
  })
  activeFrom?: string | null;

  @ApiPropertyOptional({
    example: "2026-12-31",
    nullable: true,
    description:
      "The draft's active window end (inclusive); rows dated after it are not evaluated, as for a saved rule",
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null && v !== "")
  @IsCalendarDate({
    message: "activeTo must be a real YYYY-MM-DD calendar date",
  })
  activeTo?: string | null;

  @ApiPropertyOptional({ type: RuleRunFiltersDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => RuleRunFiltersDto)
  filters?: RuleRunFiltersDto;
}
