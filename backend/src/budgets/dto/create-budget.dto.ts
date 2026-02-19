import {
  IsString,
  IsOptional,
  IsBoolean,
  IsNumber,
  IsEnum,
  IsDateString,
  IsNotEmpty,
  MaxLength,
  Min,
  Max,
  IsObject,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { SanitizeHtml } from "../../common/decorators/sanitize-html.decorator";
import { IsSafeConfigObject } from "../../ai/validators/safe-config-object.validator";
import { BudgetType, BudgetStrategy } from "../entities/budget.entity";

export class CreateBudgetDto {
  @ApiProperty({ description: "Budget name" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  @SanitizeHtml()
  name: string;

  @ApiPropertyOptional({ description: "Budget description" })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @SanitizeHtml()
  description?: string;

  @ApiPropertyOptional({
    description: "Budget type",
    enum: BudgetType,
    default: BudgetType.MONTHLY,
  })
  @IsOptional()
  @IsEnum(BudgetType)
  budgetType?: BudgetType;

  @ApiProperty({ description: "Start date of the budget (YYYY-MM-DD)" })
  @IsDateString()
  periodStart: string;

  @ApiPropertyOptional({
    description: "End date of the budget (YYYY-MM-DD), null for ongoing",
  })
  @IsOptional()
  @IsDateString()
  periodEnd?: string;

  @ApiPropertyOptional({ description: "Expected monthly income" })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(999999999999)
  baseIncome?: number;

  @ApiPropertyOptional({
    description: "Whether category amounts are percentages of actual income",
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  incomeLinked?: boolean;

  @ApiPropertyOptional({
    description: "Budget strategy",
    enum: BudgetStrategy,
    default: BudgetStrategy.FIXED,
  })
  @IsOptional()
  @IsEnum(BudgetStrategy)
  strategy?: BudgetStrategy;

  @ApiProperty({ description: "Currency code (ISO 4217)" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(3)
  currencyCode: string;

  @ApiPropertyOptional({ description: "Budget configuration options" })
  @IsOptional()
  @IsObject()
  @IsSafeConfigObject()
  config?: Record<string, unknown>;
}
