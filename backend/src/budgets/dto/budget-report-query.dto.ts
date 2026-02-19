import { IsOptional, IsInt, Min, Max, IsArray, IsUUID } from "class-validator";
import { Transform, Type } from "class-transformer";
import { ApiPropertyOptional } from "@nestjs/swagger";

export class BudgetReportQueryDto {
  @ApiPropertyOptional({
    description: "Number of months to include in the report (1-24)",
    default: 6,
    minimum: 1,
    maximum: 24,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(24)
  months?: number = 6;

  @ApiPropertyOptional({
    description: "Filter to specific category IDs",
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsUUID("4", { each: true })
  @Transform(({ value }) => {
    if (typeof value === "string") return [value];
    return value;
  })
  categoryIds?: string[];
}
