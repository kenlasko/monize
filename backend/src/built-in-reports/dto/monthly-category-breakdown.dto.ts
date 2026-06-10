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
    description:
      "True when the category is an income category (deposits dominate).",
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

export class MonthlyCategoryBreakdownResponse {
  @ApiProperty({
    type: [String],
    example: ["2025-01", "2025-02", "2025-03"],
    description: "Sorted list of YYYY-MM months covered by the report.",
  })
  months: string[];

  @ApiProperty({ type: [MonthlyBreakdownCategoryRow] })
  data: MonthlyBreakdownCategoryRow[];

  @ApiProperty({ example: "USD" })
  currency: string;
}
