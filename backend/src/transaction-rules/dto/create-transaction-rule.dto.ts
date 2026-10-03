import { Transform } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  Length,
  ValidateIf,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsCalendarDate } from "../../common/validators/is-calendar-date.validator";
import { MAX_RULE_ACTIONS } from "../rule-validation";
import { RULE_TRIGGERS, RuleTrigger } from "../rule-trigger.types";

/** Trimmed length of a rule name (`ck_transaction_rules_name_length`). */
export const MIN_RULE_NAME_LENGTH = 1;
export const MAX_RULE_NAME_LENGTH = 100;

/** Strip angle brackets (stored XSS) then trim; a non-string is left for `@IsString`. */
export const trimSanitizedName = Transform(({ value }) =>
  typeof value === "string" ? value.replace(/[<>]/g, "").trim() : value,
);

/**
 * The DTO checks the shape and the size of `condition` and `actions` only.
 * Their content (fields, operators, value types, depth, leaf count) is
 * `validateRuleDefinition`'s, run by the service inside the write's
 * transaction, so the rules exist once.
 */
export class CreateTransactionRuleDto {
  @ApiProperty({ description: "Rule name", maxLength: MAX_RULE_NAME_LENGTH })
  @trimSanitizedName
  @IsString()
  @Length(MIN_RULE_NAME_LENGTH, MAX_RULE_NAME_LENGTH)
  name: string;

  @ApiPropertyOptional({ description: "Whether the rule runs", default: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiProperty({
    description: "When the rule runs",
    enum: RULE_TRIGGERS,
    isArray: true,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(RULE_TRIGGERS.length)
  @ArrayUnique()
  @IsIn(RULE_TRIGGERS, { each: true })
  triggers: RuleTrigger[];

  @ApiProperty({
    description: "Condition tree: an all/any group or a field/op/value leaf",
    type: "object",
    additionalProperties: true,
  })
  @IsObject()
  condition: Record<string, unknown>;

  @ApiProperty({
    description: "Ordered actions (add_tags, remove_tags, set_category, ...)",
    type: "array",
    items: { type: "object", additionalProperties: true },
    maxItems: MAX_RULE_ACTIONS,
  })
  @IsArray()
  @ArrayMaxSize(MAX_RULE_ACTIONS)
  actions: Record<string, unknown>[];

  @ApiPropertyOptional({
    description: "Rules after this one do not run for the transaction",
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  stopProcessing?: boolean;

  @ApiPropertyOptional({
    example: "2026-10-01",
    nullable: true,
    description:
      "First transaction date (inclusive) the rule applies to; null or absent is open",
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
      "Last transaction date (inclusive) the rule applies to; null or absent is open",
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null && v !== "")
  @IsCalendarDate({
    message: "activeTo must be a real YYYY-MM-DD calendar date",
  })
  activeTo?: string | null;
}
