import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsUUID,
  Matches,
} from "class-validator";
import { splitCsv } from "../../common/helpers/split-csv";

/**
 * The Foreign Currency Fees report's selection: the accounts it covers and,
 * optionally, the currencies their transactions were paid in.
 */
export class FxFeeTotalsQueryDto {
  @ApiProperty({
    description: "Account ids to total (comma-separated)",
    type: [String],
  })
  @Transform(splitCsv)
  @IsArray()
  @ArrayMinSize(1)
  // Bounded because an unbounded array is a lever on the query planner, and
  // `common/array-bound-dto.spec.ts` fails a new one without a cap.
  @ArrayMaxSize(200)
  @IsUUID("4", { each: true })
  accountIds: string[];

  @ApiPropertyOptional({
    description:
      "Paid currencies to narrow to (comma-separated); all when absent",
    type: [String],
  })
  @IsOptional()
  @Transform(({ value }) => {
    const parts = splitCsv({ value });
    return Array.isArray(parts)
      ? parts.map((part) =>
          typeof part === "string" ? part.toUpperCase() : part,
        )
      : parts;
  })
  @IsArray()
  @ArrayMaxSize(50)
  @Matches(/^[A-Za-z0-9]{2,10}$/, { each: true })
  currencyCodes?: string[];
}
