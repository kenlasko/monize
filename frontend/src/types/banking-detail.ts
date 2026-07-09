/** A projected balance series from GET /accounts/:id/balance-forecast. */
export interface BalanceForecast {
  accountId: string;
  currencyCode: string;
  points: Array<{ date: string; balance: number }>;
}
