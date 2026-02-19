import {
  IsString,
  IsOptional,
  IsBoolean,
  IsNumber,
  IsEnum,
  MaxLength,
  Min,
  Max,
  IsInt,
} from "class-validator";
import { ApiPropertyOptional } from "@nestjs/swagger";
import { SanitizeHtml } from "../../common/decorators/sanitize-html.decorator";
import {
  RolloverType,
  CategoryGroup,
} from "../entities/budget-category.entity";

export class UpdateBudgetCategoryDto {
  @ApiPropertyOptional({
    description: "Category group for 50/30/20 strategy",
    enum: CategoryGroup,
  })
  @IsOptional()
  @IsEnum(CategoryGroup)
  categoryGroup?: CategoryGroup | null;

  @ApiPropertyOptional({
    description: "Monthly target amount (or percentage if income-linked)",
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  amount?: number;

  @ApiPropertyOptional({
    description: "Whether this is an income category",
  })
  @IsOptional()
  @IsBoolean()
  isIncome?: boolean;

  @ApiPropertyOptional({
    description: "Rollover type for unused budget",
    enum: RolloverType,
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
  rolloverCap?: number | null;

  @ApiPropertyOptional({
    description: "Flex group name for grouped budget tracking",
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @SanitizeHtml()
  flexGroup?: string | null;

  @ApiPropertyOptional({
    description: "Warning alert threshold percentage",
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  alertWarnPercent?: number;

  @ApiPropertyOptional({
    description: "Critical alert threshold percentage",
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
  notes?: string | null;

  @ApiPropertyOptional({ description: "Sort order for display" })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  sortOrder?: number;
}
