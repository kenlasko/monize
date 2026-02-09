import { ApiProperty } from "@nestjs/swagger";
import { IsOptional, IsDateString, IsNumber, Min, Max } from "class-validator";
import { Type } from "class-transformer";

export class UncategorizedTransactionsQueryDto {
  @ApiProperty({
    required: false,
    description: "Start date for the report (YYYY-MM-DD)",
    example: "2024-01-01",
  })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiProperty({
    required: true,
    description: "End date for the report (YYYY-MM-DD)",
    example: "2024-12-31",
  })
  @IsDateString()
  endDate: string;

  @ApiProperty({
    required: false,
    description: "Maximum number of transactions to return",
    example: 500,
    default: 500,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(1000)
  limit?: number;
}
