import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  MinLength,
  Min,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { SanitizeHtml } from "../../common/decorators/sanitize-html.decorator";
import { IsMoneyAmount } from "../../common/validators/is-money-amount.validator";
import { BudgetBucketTargetType } from "../entities/budget-bucket.entity";

export class CreateBudgetBucketDto {
  @ApiProperty({ description: "Bucket name, unique within the budget" })
  @IsString()
  @SanitizeHtml()
  @MinLength(1)
  @MaxLength(50)
  name: string;

  @ApiProperty({ enum: BudgetBucketTargetType })
  @IsEnum(BudgetBucketTargetType)
  targetType: BudgetBucketTargetType;

  @ApiProperty({
    description:
      "Percent of bucket income (greater than 0, at most 100, two decimals) or an amount per period",
  })
  @IsMoneyAmount()
  @IsPositive()
  @Max(999999999999)
  targetValue: number;

  @ApiPropertyOptional({ description: "Carry what is left to the next period" })
  @IsOptional()
  @IsBoolean()
  carryOver?: boolean;

  @ApiPropertyOptional({
    description: "Most that is carried in; needs carryOver",
  })
  @IsOptional()
  @IsMoneyAmount()
  @IsPositive()
  @Max(999999999999)
  carryCap?: number;

  @ApiPropertyOptional({ description: "Sort order for display" })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  sortOrder?: number;
}
