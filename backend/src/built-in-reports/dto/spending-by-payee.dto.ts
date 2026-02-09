import { ApiProperty } from "@nestjs/swagger";

export class PayeeSpendingItem {
  @ApiProperty({ example: "uuid-123", nullable: true })
  payeeId: string | null;

  @ApiProperty({ example: "Amazon" })
  payeeName: string;

  @ApiProperty({ example: 500.0 })
  total: number;
}

export class SpendingByPayeeResponse {
  @ApiProperty({ type: [PayeeSpendingItem] })
  data: PayeeSpendingItem[];

  @ApiProperty({ example: 5000.0 })
  totalSpending: number;
}
