import { Injectable, Logger } from "@nestjs/common";

export interface CashFlow {
  amount: number; // Negative for outflow (buy/SIP), Positive for inflow (sell/dividend/current value)
  date: Date;
}

@Injectable()
export class InvestmentAnalyticsService {
  private readonly logger = new Logger(InvestmentAnalyticsService.name);

  /**
   * Calculate CAGR (Compound Annual Growth Rate) in percentage.
   */
  calculateCagr(
    initialValue: number,
    finalValue: number,
    years: number,
  ): number {
    if (initialValue <= 0 || finalValue <= 0 || years <= 0) return 0;
    const cagr = (Math.pow(finalValue / initialValue, 1 / years) - 1) * 100;
    return Math.round(cagr * 100) / 100;
  }

  /**
   * Calculate XIRR (Extended Internal Rate of Return) in percentage using Newton-Raphson method.
   */
  calculateXirr(cashFlows: CashFlow[], guess = 0.1): number {
    if (!cashFlows || cashFlows.length < 2) return 0;

    // Ensure cash flows are sorted by date
    const sorted = [...cashFlows].sort(
      (a, b) => a.date.getTime() - b.date.getTime(),
    );
    const startDate = sorted[0].date;

    const xirrFunc = (rate: number): number => {
      return sorted.reduce((sum, cf) => {
        const days =
          (cf.date.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24);
        return sum + cf.amount / Math.pow(1 + rate, days / 365);
      }, 0);
    };

    const xirrDeriv = (rate: number): number => {
      return sorted.reduce((sum, cf) => {
        const days =
          (cf.date.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24);
        return (
          sum - (days / 365) * cf.amount * Math.pow(1 + rate, -days / 365 - 1)
        );
      }, 0);
    };

    let rate = guess;
    const maxIter = 100;
    const tol = 1e-6;

    for (let i = 0; i < maxIter; i++) {
      const fValue = xirrFunc(rate);
      const fDeriv = xirrDeriv(rate);
      if (Math.abs(fDeriv) < 1e-10) break;
      const newRate = rate - fValue / fDeriv;
      if (Math.abs(newRate - rate) < tol) {
        return Math.round(newRate * 10000) / 100;
      }
      rate = newRate;
    }

    return Math.round(rate * 10000) / 100;
  }
}
