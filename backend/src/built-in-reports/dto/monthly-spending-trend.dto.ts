import { ApiProperty } from "@nestjs/swagger";

export class MonthlyCategorySpending {
  @ApiProperty({ example: "uuid-123", nullable: true })
  categoryId: string | null;

  @ApiProperty({ example: "Food & Dining" })
  categoryName: string;

  @ApiProperty({ example: "#3b82f6", nullable: true })
  color: string | null;

  @ApiProperty({ example: 500.0 })
  total: number;
}

export class MonthlySpendingItem {
  @ApiProperty({ example: "2024-01" })
  month: string;

  @ApiProperty({ type: [MonthlyCategorySpending] })
  categories: MonthlyCategorySpending[];

  @ApiProperty({ example: 3000.0 })
  totalSpending: number;
}

export class MonthlySpendingTrendResponse {
  @ApiProperty({ type: [MonthlySpendingItem] })
  data: MonthlySpendingItem[];
}
