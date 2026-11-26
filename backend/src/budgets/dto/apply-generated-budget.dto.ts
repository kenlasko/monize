import {
  IsString,
  IsOptional,
  IsBoolean,
  IsNumber,
  IsEnum,
  IsDateString,
  IsNotEmpty,
  IsArray,
  IsUUID,
  IsInt,
  MaxLength,
  MinLength,
  Min,
  Max,
  IsObject,
  ValidateNested,
  ArrayMinSize,
  ArrayMaxSize,
} from "class-validator";
import { Type } from "class-transformer";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { SanitizeHtml } from "../../common/decorators/sanitize-html.decorator";
import { IsSafeConfigObject } from "../../ai/validators/safe-config-object.validator";
import { BudgetType, BudgetStrategy } from "../entities/budget.entity";
import {
  RolloverType,
  CategoryGroup,
} from "../entities/budget-category.entity";
import { CreateBudgetBucketDto } from "./create-budget-bucket.dto";

/** A bucket of the wizard request: a create-bucket body plus a request-local key. */
export class ApplyBudgetBucketDto extends CreateBudgetBucketDto {
  @ApiProperty({
    description:
      "Client-chosen key, unique in the request; lines name their bucket by it",
  })
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  key: string;
}

export class ApplyBudgetCategoryDto {
  @ApiPropertyOptional({
    description: "Category ID (for regular budget lines)",
  })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({
    description: "Transfer destination account ID (for transfer budget lines)",
  })
  @IsOptional()
  @IsUUID()
  transferAccountId?: string;

  @ApiPropertyOptional({
    description: "Whether this is a transfer budget line",
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  isTransfer?: boolean;

  @ApiProperty({ description: "Budget amount for this category" })
  @IsNumber()
  @Min(0)
  @Max(999999999999)
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
    description: "Rollover setting (expense lines carry the signed balance)",
    enum: RolloverType,
    default: RolloverType.NONE,
  })
  @IsOptional()
  @IsEnum(RolloverType)
  rolloverType?: RolloverType;

  @ApiPropertyOptional({
    description: "Maximum positive rollover",
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(999999999999)
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

  @ApiPropertyOptional({
    description: "Key of a bucket in this request; not for an income line",
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  bucketKey?: string;
}

export class ApplyGeneratedBudgetDto {
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
  @Max(999999999999)
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
  @IsNotEmpty()
  @MaxLength(3)
  currencyCode: string;

  @ApiPropertyOptional({ description: "Budget configuration" })
  @IsOptional()
  @IsObject()
  @IsSafeConfigObject()
  config?: Record<string, unknown>;

  @ApiProperty({
    description: "Categories with budget amounts from the generator",
    type: [ApplyBudgetCategoryDto],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ApplyBudgetCategoryDto)
  categories: ApplyBudgetCategoryDto[];

  @ApiPropertyOptional({
    description: "Buckets of a Bucket-strategy budget (at most 12)",
    type: [ApplyBudgetBucketDto],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @ValidateNested({ each: true })
  @Type(() => ApplyBudgetBucketDto)
  buckets?: ApplyBudgetBucketDto[];
}
