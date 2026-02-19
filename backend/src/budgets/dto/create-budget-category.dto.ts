import {
  IsString,
  IsOptional,
  IsBoolean,
  IsNumber,
  IsEnum,
  IsUUID,
  MaxLength,
  Min,
  Max,
  IsInt,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { SanitizeHtml } from "../../common/decorators/sanitize-html.decorator";
import {
  RolloverType,
  CategoryGroup,
} from "../entities/budget-category.entity";

export class CreateBudgetCategoryDto {
  @ApiProperty({ description: "Category ID to budget" })
  @IsUUID()
  categoryId: string;

  @ApiPropertyOptional({
    description: "Category group for 50/30/20 strategy",
    enum: CategoryGroup,
  })
  @IsOptional()
  @IsEnum(CategoryGroup)
  categoryGroup?: CategoryGroup;

  @ApiProperty({
    description: "Monthly target amount (or percentage if income-linked)",
  })
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
    description: "Rollover type for unused budget",
    enum: RolloverType,
    default: RolloverType.NONE,
  })
  @IsOptional()
  @IsEnum(RolloverType)
  rolloverType?: RolloverType;

  @ApiPropertyOptional({
    description: "Maximum rollover accumulation (null for unlimited)",
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(999999999999)
  rolloverCap?: number;

  @ApiPropertyOptional({
    description: "Flex group name for grouped budget tracking",
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

  @ApiPropertyOptional({ description: "Notes about this budget category" })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @SanitizeHtml()
  notes?: string;

  @ApiPropertyOptional({ description: "Sort order for display" })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  sortOrder?: number;
}
