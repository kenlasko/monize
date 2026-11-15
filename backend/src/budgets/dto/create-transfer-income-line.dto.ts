import {
  IsString,
  IsOptional,
  IsNumber,
  IsEnum,
  IsUUID,
  MaxLength,
  Min,
  Max,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { SanitizeHtml } from "../../common/decorators/sanitize-html.decorator";
import { RolloverType } from "../entities/budget-category.entity";

/**
 * A transfer income line: money arriving from `transferAccountId` counts as
 * the budget's income (issue #2141, `docs/specs/budget-transfer-income.md`).
 */
export class CreateTransferIncomeLineDto {
  @ApiProperty({ description: "The account the transfers come from" })
  @IsUUID()
  transferAccountId: string;

  @ApiProperty({ description: "Planned income from it per period" })
  @IsNumber()
  @Min(0)
  @Max(999999999999)
  amount: number;

  @ApiPropertyOptional({
    description: "Rollover type for unused budget",
    enum: RolloverType,
    default: RolloverType.NONE,
  })
  @IsOptional()
  @IsEnum(RolloverType)
  rolloverType?: RolloverType;

  @ApiPropertyOptional({ description: "Notes about this budget line" })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @SanitizeHtml()
  notes?: string;
}
