import { ApiProperty } from "@nestjs/swagger";
import { IsString, Matches } from "class-validator";

export class MonthlyComparisonQueryDto {
  @ApiProperty({
    description: "Month to compare (YYYY-MM format)",
    example: "2026-01",
  })
  @IsString()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, {
    message: "month must be in YYYY-MM format",
  })
  month: string;
}
