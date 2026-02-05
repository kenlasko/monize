import { ApiProperty } from '@nestjs/swagger';

export class PayeeSpendingItem {
  @ApiProperty({ example: 'uuid-123', nullable: true })
  payeeId: string | null;

  @ApiProperty({ example: 'Amazon' })
  payeeName: string;

  @ApiProperty({ example: 500.00 })
  total: number;
}

export class SpendingByPayeeResponse {
  @ApiProperty({ type: [PayeeSpendingItem] })
  data: PayeeSpendingItem[];

  @ApiProperty({ example: 5000.00 })
  totalSpending: number;
}
