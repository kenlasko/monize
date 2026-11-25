import { ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsUUID,
} from "class-validator";
import { splitCsv } from "../../common/helpers/split-csv";
import { ReportQueryDto } from "./report-query.dto";

/**
 * Monthly Breakdown takes the account scope the other income and spending
 * reports take (`docs/specs/report-tag-key-breakdown.md` section 11.5); absent
 * means every account, as it always was.
 */
export class MonthlyCategoryBreakdownQueryDto extends ReportQueryDto {
  @ApiPropertyOptional({
    description: "Account ids to restrict the report to (comma-separated)",
    type: [String],
  })
  @IsOptional()
  @Transform(splitCsv)
  @IsArray()
  // Bounded because an unbounded array is a lever on the query planner, and
  // `common/array-bound-dto.spec.ts` fails a new one without a cap.
  @ArrayMaxSize(200)
  @IsUUID("4", { each: true })
  accountIds?: string[];

  @ApiPropertyOptional({
    description:
      "Column width: one calendar month or one calendar year. Defaults to month.",
    enum: ["month", "year"],
  })
  @IsOptional()
  @IsIn(["month", "year"])
  period?: "month" | "year";
}
