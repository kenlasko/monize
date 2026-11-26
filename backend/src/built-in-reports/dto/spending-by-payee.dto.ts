import { ApiProperty } from "@nestjs/swagger";

export class PayeeSpendingItem {
  @ApiProperty({ example: "uuid-123", nullable: true })
  payeeId: string | null;

  @ApiProperty({ example: "Amazon" })
  payeeName: string;

  @ApiProperty({ example: 500.0 })
  total: number;

  @ApiProperty({ type: Number, nullable: true })
  percentage?: number | null;
}

export class SpendingByPayeeResponse {
  /**
   * All qualifying payees, in {@link currency}. Rows whose currency had no rate
   * are left out of every figure, so when `missingCurrencies` is non-empty each
   * payee's `total` is only the part that converted.
   */
  @ApiProperty({ type: [PayeeSpendingItem] })
  data: PayeeSpendingItem[];

  /**
   * Total spent over `data`, or `null` when any row could not be converted into
   * {@link currency} -- a missing rate makes the total unknowable, never
   * smaller. `knownSpending` carries the part that did convert.
   */
  @ApiProperty({ example: 5000.0, nullable: true })
  totalSpending: number | null;

  /**
   * What `data`'s rows add up to, rounded once from their unrounded sums, so
   * it can sit a ten-thousandth from the sum of the rounded rows
   * (docs/specs/report-rounding-and-aggregation.md rule 4). Equals
   * `totalSpending` when nothing was excluded; otherwise a subtotal, to be
   * labelled as one and never shown under a "Total" caption.
   */
  @ApiProperty({ example: 5000.0 })
  knownSpending: number;

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
