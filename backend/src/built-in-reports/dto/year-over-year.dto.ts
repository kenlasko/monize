export class YearMonthData {
  month: number; // 1-12
  income: number;
  expenses: number;
  savings: number;
}

export class YearTotals {
  income: number;
  expenses: number;
  savings: number;
}

export class YearData {
  year: number;
  months: YearMonthData[];
  totals: YearTotals;
}

export class YearOverYearResponse {
  data: YearData[];
}
