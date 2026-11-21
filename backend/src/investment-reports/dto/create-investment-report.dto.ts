import {
  IsString,
  IsOptional,
  IsEnum,
  IsBoolean,
  IsArray,
  IsUUID,
  IsObject,
  MaxLength,
  ArrayMaxSize,
  ValidateNested,
  IsNumber,
  Min,
  Max,
  Matches,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  Validate,
  ValidateIf,
} from "class-validator";
import { Type } from "class-transformer";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { SanitizeHtml } from "../../common/decorators/sanitize-html.decorator";
import {
  InvestmentGroupBy,
  InvestmentSortDirection,
} from "../entities/investment-report.entity";
import { isValidInvestmentColumn } from "../investment-report-columns";

@ValidatorConstraint({ name: "areValidInvestmentColumns", async: false })
class AreValidInvestmentColumns implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return (
      Array.isArray(value) &&
      value.every((v) => typeof v === "string" && isValidInvestmentColumn(v))
    );
  }

  defaultMessage(): string {
    return "columns must be an array of known investment report column keys";
  }
}

@ValidatorConstraint({ name: "isValidInvestmentColumn", async: false })
class IsValidInvestmentColumn implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === "string" && isValidInvestmentColumn(value);
  }

  defaultMessage(): string {
    return "must be a known investment report column key";
  }
}

export class InvestmentReportConfigDto {
  @ApiProperty({
    description: "Ordered column keys to display (symbol is always included)",
    type: [String],
  })
  @IsArray()
  @ArrayMaxSize(60)
  @Validate(AreValidInvestmentColumns)
  columns: string[];

  @ApiPropertyOptional({
    description: "Holdings account IDs to include (empty means all accounts)",
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID("4", { each: true })
  accountIds?: string[];

  @ApiPropertyOptional({ description: "Column key to sort by", nullable: true })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @Validate(IsValidInvestmentColumn)
  sortColumn?: string | null;

  @ApiPropertyOptional({
    description: "Sort direction",
    enum: InvestmentSortDirection,
  })
  @IsOptional()
  @IsEnum(InvestmentSortDirection)
  sortDirection?: InvestmentSortDirection;

  @ApiPropertyOptional({
    description: "As-of date (YYYY-MM-DD), null for the latest market day",
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: "asOfDate must be in YYYY-MM-DD format",
  })
  asOfDate?: string | null;

  @ApiPropertyOptional({
    description:
      "Combine a security held across accounts into one row (non-account grouping only)",
  })
  @IsOptional()
  @IsBoolean()
  mergeAccounts?: boolean;
}

export class CreateInvestmentReportDto {
  @ApiProperty({ description: "Report name" })
  @IsString()
  @MaxLength(255)
  @SanitizeHtml()
  name: string;

  @ApiPropertyOptional({ description: "Report description" })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @SanitizeHtml()
  description?: string;

  @ApiPropertyOptional({ description: "Icon identifier (emoji or icon name)" })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  @SanitizeHtml()
  icon?: string;

  @ApiPropertyOptional({
    description: "Background color as hex code (e.g., #3b82f6)",
  })
  @IsOptional()
  @IsString()
  @Matches(/^#[0-9A-Fa-f]{6}$/, {
    message: "Background color must be in hex format (e.g., #3b82f6)",
  })
  backgroundColor?: string;

  @ApiPropertyOptional({
    description: "How to group rows",
    enum: InvestmentGroupBy,
  })
  @IsOptional()
  @IsEnum(InvestmentGroupBy)
  groupBy?: InvestmentGroupBy;

  @ApiProperty({
    description: "Report configuration",
    type: InvestmentReportConfigDto,
  })
  @IsObject()
  @ValidateNested()
  @Type(() => InvestmentReportConfigDto)
  config: InvestmentReportConfigDto;

  @ApiPropertyOptional({ description: "Mark as favourite" })
  @IsOptional()
  @IsBoolean()
  isFavourite?: boolean;

  @ApiPropertyOptional({ description: "Sort order for display" })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1000)
  sortOrder?: number;
}
