import {
  IsString,
  IsOptional,
  IsBoolean,
  IsNumber,
  IsEnum,
  IsDateString,
  MaxLength,
  Min,
  Max,
  IsObject,
} from "class-validator";
import { ApiPropertyOptional } from "@nestjs/swagger";
import { SanitizeHtml } from "../../common/decorators/sanitize-html.decorator";
import { IsSafeConfigObject } from "../../ai/validators/safe-config-object.validator";
import { BudgetType, BudgetStrategy } from "../entities/budget.entity";

export class UpdateBudgetDto {
  @ApiPropertyOptional({ description: "Budget name" })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  @SanitizeHtml()
  name?: string;

  @ApiPropertyOptional({ description: "Budget description" })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @SanitizeHtml()
  description?: string;

  @ApiPropertyOptional({
    description: "Budget type",
    enum: BudgetType,
  })
  @IsOptional()
  @IsEnum(BudgetType)
  budgetType?: BudgetType;

  @ApiPropertyOptional({
    description: "Start date of the budget (YYYY-MM-DD)",
  })
  @IsOptional()
  @IsDateString()
  periodStart?: string;

  @ApiPropertyOptional({
    description: "End date of the budget (YYYY-MM-DD)",
  })
  @IsOptional()
  @IsDateString()
  periodEnd?: string | null;

  @ApiPropertyOptional({ description: "Expected monthly income" })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(999999999999)
  baseIncome?: number | null;

  @ApiPropertyOptional({
    description: "Whether category amounts are percentages of actual income",
  })
  @IsOptional()
  @IsBoolean()
  incomeLinked?: boolean;

  @ApiPropertyOptional({
    description: "Budget strategy",
    enum: BudgetStrategy,
  })
  @IsOptional()
  @IsEnum(BudgetStrategy)
  strategy?: BudgetStrategy;

  @ApiPropertyOptional({ description: "Whether the budget is active" })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ description: "Budget configuration options" })
  @IsOptional()
  @IsObject()
  @IsSafeConfigObject()
  config?: Record<string, unknown>;
}
