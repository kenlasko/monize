import { ApiProperty } from "@nestjs/swagger";

export class CategorySpendingItem {
  @ApiProperty({ example: "uuid-123", nullable: true })
  categoryId: string | null;

  @ApiProperty({ example: "Food & Dining" })
  categoryName: string;

  @ApiProperty({ example: "#3b82f6", nullable: true })
  color: string | null;

  @ApiProperty({ example: 1500.5 })
  total: number;
}

export class SpendingByCategoryResponse {
  @ApiProperty({ type: [CategorySpendingItem] })
  data: CategorySpendingItem[];

  @ApiProperty({ example: 5000.0 })
  totalSpending: number;
}
