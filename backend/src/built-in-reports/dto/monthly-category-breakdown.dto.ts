import { ApiProperty } from "@nestjs/swagger";

/**
 * One category's row in the monthly breakdown matrix. The frontend builds the
 * sections, deviation highlighting and percentage views from these raw rows;
 * the backend only provides the per-(category, month) aggregates already
 * converted to the user's base currency.
 */
export class MonthlyBreakdownCategoryRow {
  @ApiProperty({ example: "uuid-123", nullable: true })
  categoryId: string | null;

  @ApiProperty({ example: "Groceries" })
  categoryName: string;

  @ApiProperty({ example: "uuid-parent", nullable: true })
  parentId: string | null;

  @ApiProperty({ example: "Food & Dining", nullable: true })
  parentName: string | null;

  @ApiProperty({
    example: false,
    nullable: true,
    description:
      "Income flag of the parent category (null when the category has no " +
      "parent). Lets the frontend classify a whole section as income or " +
      "expense from its parent rather than guessing from the children.",
  })
  parentIsIncome: boolean | null;

  @ApiProperty({
    example: false,
    description:
      "True when the category is designated as income. Uses the category's " +
      "own isIncome flag, falling back to deposits-dominate for uncategorized " +
      "rows.",
  })
  isIncome: boolean;

  @ApiProperty({
    example: { "2025-01": 120.5, "2025-02": 98.0 },
    description:
      "Signed net amount per YYYY-MM month, in the user's base currency. " +
      "Positive for income, positive magnitude for expenses.",
  })
  valuesByMonth: Record<string, number>;

  @ApiProperty({ example: 240.0 })
  depositTotal: number;

  @ApiProperty({ example: 1480.0 })
  withdrawalTotal: number;
}

/**
 * One transfer row in the breakdown: the net transfer flow for a single
 * account in one direction. "from" rows are money leaving an account (a source
 * of funds, positive); "to" rows are money entering an account (a use of funds,
 * negative). Grouping every transfer leg by the account it sits on and the
 * sign of its amount reproduces a Microsoft Money style banking summary.
 */
export class MonthlyBreakdownTransferRow {
  @ApiProperty({ example: "uuid-123" })
  accountId: string;

  @ApiProperty({ example: "Chequing" })
  accountName: string;

  @ApiProperty({
    enum: ["from", "to"],
    example: "from",
    description:
      "'from' = outflows from the account (positive); 'to' = inflows to " +
      "the account (negative).",
  })
  direction: "from" | "to";

  @ApiProperty({
    example: { "2025-01": 500.0, "2025-02": -250.0 },
    description:
      "Signed net transfer amount per YYYY-MM month, in the user's base " +
      "currency. Positive for 'from' rows, negative for 'to' rows.",
  })
  valuesByMonth: Record<string, number>;
}

export class MonthlyCategoryBreakdownResponse {
  @ApiProperty({
    type: [String],
    example: ["2025-01", "2025-02", "2025-03"],
    description: "Sorted list of YYYY-MM months covered by the report.",
  })
  months: string[];

  @ApiProperty({ type: [MonthlyBreakdownCategoryRow] })
  data: MonthlyBreakdownCategoryRow[];

  @ApiProperty({ type: [MonthlyBreakdownTransferRow] })
  transfers: MonthlyBreakdownTransferRow[];

  @ApiProperty({ example: "USD" })
  currency: string;
}
