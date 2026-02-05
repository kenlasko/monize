import { ApiProperty } from '@nestjs/swagger';

export class IncomeSourceItem {
  @ApiProperty({ example: 'uuid-123', nullable: true })
  categoryId: string | null;

  @ApiProperty({ example: 'Salary' })
  categoryName: string;

  @ApiProperty({ example: '#22c55e', nullable: true })
  color: string | null;

  @ApiProperty({ example: 5000.00 })
  total: number;
}

export class IncomeBySourceResponse {
  @ApiProperty({ type: [IncomeSourceItem] })
  data: IncomeSourceItem[];

  @ApiProperty({ example: 8000.00 })
  totalIncome: number;
}
