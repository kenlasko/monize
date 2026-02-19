import {
  IsString,
  IsOptional,
  IsBoolean,
  IsNumber,
  IsEnum,
  IsDateString,
  IsArray,
  IsUUID,
  IsInt,
  MaxLength,
  Min,
  Max,
  IsObject,
  ValidateNested,
  ArrayMinSize,
} from "class-validator";
import { Type } from "class-transformer";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { SanitizeHtml } from "../../common/decorators/sanitize-html.decorator";
import { BudgetType, BudgetStrategy } from "../entities/budget.entity";
import {
  RolloverType,
  CategoryGroup,
} from "../entities/budget-category.entity";

export class ApplyBudgetCategoryDto {
  @ApiProperty({ description: "Category ID" })
  @IsUUID()
  categoryId: string;

  @ApiProperty({ description: "Budget amount for this category" })
  @IsNumber()
  @Min(0)
  amount: number;

  @ApiPropertyOptional({
    description: "Whether this is an income category",
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  isIncome?: boolean;

  @ApiPropertyOptional({
    description: "Category group for 50/30/20 strategy",
    enum: CategoryGroup,
  })
  @IsOptional()
  @IsEnum(CategoryGroup)
  categoryGroup?: CategoryGroup;

  @ApiPropertyOptional({
    description: "Rollover type for unused budget",
    enum: RolloverType,
    default: RolloverType.NONE,
  })
  @IsOptional()
  @IsEnum(RolloverType)
  rolloverType?: RolloverType;

  @ApiPropertyOptional({
    description: "Maximum rollover accumulation",
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  rolloverCap?: number;

  @ApiPropertyOptional({
    description: "Flex group name",
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @SanitizeHtml()
  flexGroup?: string;

  @ApiPropertyOptional({
    description: "Warning alert threshold percentage",
    default: 80,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  alertWarnPercent?: number;

  @ApiPropertyOptional({
    description: "Critical alert threshold percentage",
    default: 95,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  alertCriticalPercent?: number;

  @ApiPropertyOptional({ description: "Notes" })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @SanitizeHtml()
  notes?: string;

  @ApiPropertyOptional({ description: "Sort order" })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  sortOrder?: number;
}

export class ApplyGeneratedBudgetDto {
  @ApiProperty({ description: "Budget name" })
  @IsString()
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

  @ApiProperty({ description: "Start date (YYYY-MM-DD)" })
  @IsDateString()
  periodStart: string;

  @ApiPropertyOptional({ description: "End date (YYYY-MM-DD)" })
  @IsOptional()
  @IsDateString()
  periodEnd?: string;

  @ApiPropertyOptional({ description: "Expected monthly income" })
  @IsOptional()
  @IsNumber()
  @Min(0)
  baseIncome?: number;

  @ApiPropertyOptional({
    description: "Whether amounts are percentages of income",
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
  @MaxLength(3)
  currencyCode: string;

  @ApiPropertyOptional({ description: "Budget configuration" })
  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;

  @ApiProperty({
    description: "Categories with budget amounts from the generator",
    type: [ApplyBudgetCategoryDto],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ApplyBudgetCategoryDto)
  categories: ApplyBudgetCategoryDto[];
}
