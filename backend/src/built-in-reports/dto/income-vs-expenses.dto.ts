import { ApiProperty } from "@nestjs/swagger";

export class MonthlyIncomeExpenseItem {
  @ApiProperty({ example: "2024-01" })
  month: string;

  @ApiProperty({ example: 5000.0 })
  income: number;

  @ApiProperty({ example: 3500.0 })
  expenses: number;

  @ApiProperty({ example: 1500.0 })
  net: number;
}

export class IncomeExpenseTotals {
  @ApiProperty({ example: 60000.0 })
  income: number;

  @ApiProperty({ example: 42000.0 })
  expenses: number;

  @ApiProperty({ example: 18000.0 })
  net: number;
}

export class IncomeVsExpensesResponse {
  @ApiProperty({ type: [MonthlyIncomeExpenseItem] })
  data: MonthlyIncomeExpenseItem[];

  @ApiProperty({ type: IncomeExpenseTotals })
  totals: IncomeExpenseTotals;
}
