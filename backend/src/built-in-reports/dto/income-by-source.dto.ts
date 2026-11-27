import { ApiProperty } from "@nestjs/swagger";

export class IncomeSourceItem {
  @ApiProperty({ example: "uuid-123", nullable: true })
  categoryId: string | null;

  @ApiProperty({ example: "Salary" })
  categoryName: string;

  @ApiProperty({ example: "#22c55e", nullable: true })
  color: string | null;

  @ApiProperty({ example: 5000.0 })
  total: number;

  /**
   * The source's share of the income that converted (`knownIncome`), in
   * percent, divided from the unrounded figures before either is rounded
   * (docs/specs/report-rounding-and-aggregation.md rule 8): two equal sources
   * read 50 each, never `total / knownIncome` over the two readings. Null when the signed rows do not form a positive whole.
   */
  @ApiProperty({ type: Number, example: 62.5, nullable: true })
  percentage: number | null;
}

export class IncomeBySourceResponse {
  /**
   * The largest sources, in {@link currency}. Rows whose currency had no rate
   * are left out of every figure, so when `missingCurrencies` is non-empty each
   * `total` is only the part that converted.
   */
  @ApiProperty({ type: [IncomeSourceItem] })
  data: IncomeSourceItem[];

  /**
   * Total income of `data`, or `null` when any row could not be converted into
   * {@link currency} -- a missing rate makes the total unknowable, never
   * smaller. `knownIncome` carries the part that did convert.
   */
  @ApiProperty({ example: 8000.0, nullable: true })
  totalIncome: number | null;

  /**
   * What `data`'s rows add up to, rounded once from their unrounded sums, so
   * it can sit a ten-thousandth from the sum of the rounded rows
   * (docs/specs/report-rounding-and-aggregation.md rule 4). Equals
   * `totalIncome` when nothing was excluded; otherwise a subtotal, to be
   * labelled as one and never shown under a "Total" caption.
   */
  @ApiProperty({ example: 8000.0 })
  knownIncome: number;

  /** Reporting currency every figure above is expressed in. */
  @ApiProperty({ example: "CAD" })
  currency: string;

  /**
   * Source currencies with no usable rate into {@link currency}, so their rows
   * are in none of the figures above. Empty when the report is complete.
   */
  @ApiProperty({ type: [String], example: ["JPY"] })
  missingCurrencies: string[];

  /** How many aggregate rows were left out, by any cause. */
  @ApiProperty({ example: 0 })
  excludedCount: number;
}
