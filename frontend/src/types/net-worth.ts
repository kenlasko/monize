export interface MonthlyNetWorth {
  month: string; // "2023-01-01"
  assets: number;
  liabilities: number;
  netWorth: number;
}

export interface MonthlyInvestmentValue {
  month: string;
  value: number;
}
