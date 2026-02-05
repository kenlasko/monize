export class CategoryTotal {
  name: string;
  total: number;
}

export class TaxTotals {
  income: number;
  expenses: number;
  deductible: number;
}

export class TaxSummaryResponse {
  incomeBySource: CategoryTotal[];
  deductibleExpenses: CategoryTotal[];
  allExpenses: CategoryTotal[];
  totals: TaxTotals;
}
