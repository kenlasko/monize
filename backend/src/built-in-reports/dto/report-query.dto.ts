import { ApiProperty } from "@nestjs/swagger";
import { IsOptional, IsDateString } from "class-validator";

export class ReportQueryDto {
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
}
