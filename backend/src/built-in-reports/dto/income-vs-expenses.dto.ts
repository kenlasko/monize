import { ApiProperty } from '@nestjs/swagger';

export class MonthlyIncomeExpenseItem {
  @ApiProperty({ example: '2024-01' })
  month: string;

  @ApiProperty({ example: 5000.00 })
  income: number;

  @ApiProperty({ example: 3500.00 })
  expenses: number;

  @ApiProperty({ example: 1500.00 })
  net: number;
}

export class IncomeExpenseTotals {
  @ApiProperty({ example: 60000.00 })
  income: number;

  @ApiProperty({ example: 42000.00 })
  expenses: number;

  @ApiProperty({ example: 18000.00 })
  net: number;
}

export class IncomeVsExpensesResponse {
  @ApiProperty({ type: [MonthlyIncomeExpenseItem] })
  data: MonthlyIncomeExpenseItem[];

  @ApiProperty({ type: IncomeExpenseTotals })
  totals: IncomeExpenseTotals;
}
