import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";
import { ApiPropertyOptional } from "@nestjs/swagger";
import { SanitizeHtml } from "../../common/decorators/sanitize-html.decorator";
import { IsMoneyAmount } from "../../common/validators/is-money-amount.validator";
import { BudgetBucketTargetType } from "../entities/budget-bucket.entity";

export class UpdateBudgetBucketDto {
  @ApiPropertyOptional({ description: "Bucket name, unique within the budget" })
  @IsOptional()
  @IsString()
  @SanitizeHtml()
  @MinLength(1)
  @MaxLength(50)
  name?: string;

  @ApiPropertyOptional({ enum: BudgetBucketTargetType })
  @IsOptional()
  @IsEnum(BudgetBucketTargetType)
  targetType?: BudgetBucketTargetType;

  @ApiPropertyOptional({
    description: "Percent of bucket income, or an amount",
  })
  @IsOptional()
  @IsMoneyAmount()
  @IsPositive()
  @Max(999999999999)
  targetValue?: number;

  @ApiPropertyOptional({
    description: "Carry what is left to the next period; false clears carryCap",
  })
  @IsOptional()
  @IsBoolean()
  carryOver?: boolean;

  @ApiPropertyOptional({
    description: "Most that is carried in (null clears); needs carryOver",
  })
  @IsOptional()
  @IsMoneyAmount()
  @IsPositive()
  @Max(999999999999)
  carryCap?: number | null;

  @ApiPropertyOptional({ description: "Sort order for display" })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  sortOrder?: number;
}
