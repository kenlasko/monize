import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class CategorySpendingItem {
  @ApiProperty({ example: "uuid-123", nullable: true })
  categoryId: string | null;

  @ApiProperty({ example: "Food & Dining" })
  categoryName: string;

  @ApiProperty({ example: "#3b82f6", nullable: true })
  color: string | null;

  /**
   * Spending in this category, in {@link SpendingByCategoryResponse.currency}.
   *
   * Rows whose currency had no rate are left out of every figure in the
   * response, so when `missingCurrencies` is non-empty this is the part that
   * converted. The response-level completeness is the one flag every surface
   * reads; a per-category one would say the same thing many times over.
   */
  @ApiProperty({ example: 1500.5 })
  total: number;

  /** Share from unrounded aggregates when every category is nonnegative and the complete total is positive. */
  @ApiPropertyOptional({ example: 37.5 })
  percentage?: number;
}

export class SpendingByCategoryResponse {
  /** Present on reports that retain fully refunded and net-credit expense categories. */
  @ApiPropertyOptional({ example: true })
  netSpending?: true;

  /**
   * Expense categories with activity, including a zero or negative net, plus
   * other buckets that net to spending over the window, largest first. The
   * full list, not a top-N: a caller that draws fewer decides its own cut and
   * can still say what it merged. The Spending by Category report lists them
   * all and the dashboard widget keeps eleven, folding the tail into Other.
   */
  @ApiProperty({ type: [CategorySpendingItem] })
  data: CategorySpendingItem[];

  /**
   * Total spent, or `null` when any row could not be converted into
   * {@link currency} -- a missing rate makes the total unknowable, never
   * smaller. `knownSpending` carries the part that did convert.
   */
  @ApiProperty({ example: 5000.0, nullable: true })
  totalSpending: number | null;

  /**
   * What `data`'s rows add up to, rounded once from their unrounded sums, so
   * it can sit a ten-thousandth from the sum of the rounded rows
   * (docs/specs/report-rounding-and-aggregation.md rule 4). Equals
   * `totalSpending` when nothing was excluded; otherwise it is a subtotal and
   * must be labelled as one, never under "Total".
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
