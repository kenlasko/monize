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

  @ApiProperty({
    example: "uuid-parent",
    description:
      "The section the row draws under: its parent's id, its own id for a " +
      "top-level category, or __other_income__ / __other_expense__ for the " +
      "uncategorized row.",
  })
  sectionKey: string;

  @ApiProperty({
    example: 218.5,
    description:
      "The row's columns summed once, in the row's own sign convention: the " +
      "single rounding of its cells' exact sum, never the sum of the cells.",
  })
  total: number;

  @ApiProperty({
    example: 36.42,
    description:
      "The total over the columns listed, divided before it is read.",
  })
  average: number;
}

/** A line of figures: one per column, the window's total and its average. */
export class MonthlyBreakdownFigures {
  @ApiProperty({ example: { "2025-01": 120.5, "2025-02": 98.0 } })
  valuesByMonth: Record<string, number>;

  @ApiProperty({ example: 218.5 })
  total: number;

  @ApiProperty({ example: 109.25 })
  average: number;
}

/**
 * One section of the breakdown, the rows sharing a `sectionKey`, in the
 * section's own sign convention (money in positive for an income section,
 * money out positive for an expense one).
 */
export class MonthlyBreakdownSection extends MonthlyBreakdownFigures {
  @ApiProperty({ example: "uuid-parent" })
  key: string;

  @ApiProperty({ example: false })
  isIncome: boolean;
}

/** The breakdown's bottom lines, each folded from the sections' aggregates. */
export class MonthlyBreakdownSummary {
  @ApiProperty({ type: MonthlyBreakdownFigures })
  income: MonthlyBreakdownFigures;

  @ApiProperty({ type: MonthlyBreakdownFigures })
  expenses: MonthlyBreakdownFigures;

  @ApiProperty({ type: MonthlyBreakdownFigures })
  balance: MonthlyBreakdownFigures;

  @ApiProperty({ type: MonthlyBreakdownFigures })
  transfers: MonthlyBreakdownFigures;

  @ApiProperty({ type: MonthlyBreakdownFigures })
  overall: MonthlyBreakdownFigures;
}

/**
 * One transfer row in the breakdown, in one direction. "from" rows are money
 * leaving (a source of funds, positive); "to" rows are money entering (a use of
 * funds, negative). A leg holding a Transfer category is counted on its
 * category's row (`kind: "category"`); every other leg, one holding an Income or
 * Expense category included, on its account's row (`kind: "account"`), a
 * Microsoft Money style banking summary (docs/specs/transfer-categories.md
 * section 7). Each leg is on exactly one non-subtotal row.
 */
export class MonthlyBreakdownTransferRow {
  @ApiProperty({
    enum: ["category", "account"],
    example: "account",
    description:
      "'category' = the legs holding one Transfer category (or, with " +
      "isSubtotal, a parent's roll-up); 'account' = every other leg on one " +
      "account.",
  })
  kind: "category" | "account";

  @ApiProperty({ example: "uuid-123", nullable: true, type: String })
  accountId: string | null;

  @ApiProperty({ example: "Chequing", nullable: true, type: String })
  accountName: string | null;

  @ApiProperty({ example: "uuid-456", nullable: true, type: String })
  categoryId: string | null;

  @ApiProperty({
    example: "Savings contributions",
    nullable: true,
    type: String,
  })
  categoryName: string | null;

  @ApiProperty({ nullable: true, type: String })
  parentId: string | null;

  @ApiProperty({ nullable: true, type: String })
  parentName: string | null;

  @ApiProperty({
    example: false,
    description:
      "A parent Transfer category's roll-up of its own legs and its " +
      "children's, per direction. Its legs are already on the other rows, so " +
      "it is not part of the group total.",
  })
  isSubtotal: boolean;

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

  @ApiProperty({ example: 250.0 })
  total: number;

  @ApiProperty({ example: 125.0 })
  average: number;
}

export class MonthlyCategoryBreakdownResponse {
  @ApiProperty({
    enum: ["month", "year"],
    description: "The column width: `months` holds YYYY-MM or YYYY keys.",
  })
  period: "month" | "year";

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

  @ApiProperty({ type: [MonthlyBreakdownSection] })
  sections: MonthlyBreakdownSection[];

  @ApiProperty({ type: MonthlyBreakdownSummary })
  summary: MonthlyBreakdownSummary;

  /** Reporting currency every figure above is expressed in. */
  @ApiProperty({ example: "USD" })
  currency: string;

  /**
   * Source currencies with no usable rate into {@link currency}, so their rows
   * are in none of the figures above (no category value, deposit or withdrawal
   * total, transfer row or month). Empty when the report is complete.
   */
  @ApiProperty({ type: [String], example: ["JPY"] })
  missingCurrencies: string[];

  /** How many aggregate rows were left out, by any cause. */
  @ApiProperty({ example: 0 })
  excludedCount: number;

  /**
   * Provisional transfer legs (an imported estimate of what the other account
   * received or sent) inside the transfer rows. The figures include them;
   * above 0 the page says the report holds estimated amounts.
   */
  @ApiProperty({ example: 0 })
  provisionalCount: number;
}
