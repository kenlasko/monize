import { roundMoney } from "../../common/round.util";
import type { DemoSplit } from "./transactions";

/**
 * The demo's biweekly (24 a year, the 15th and the 28th) paycheque: a gross
 * salary line and the payroll deductions taken from it. CPP and EI stop at a
 * yearly maximum, which is what the Payroll Deductions feature tracks; income
 * tax has no maximum and so no rule. The maximums are illustrative round-ups
 * of recent Canadian figures, not tax advice.
 */
export const DEMO_GROSS_SALARY = 3000;

export interface DemoPayrollDeduction {
  /** The category path the deduction line carries. */
  categoryPath: string;
  memo: string;
  /** What each paycheque withholds until the yearly maximum is reached. */
  perPaycheque: number;
  /** The most the category collects in one calendar year; none when uncapped. */
  yearlyMaximum?: number;
}

export const demoPayrollDeductions: DemoPayrollDeduction[] = [
  {
    categoryPath: "Payroll Taxes > Income Tax",
    memo: "Federal and provincial income tax",
    perPaycheque: 520,
  },
  {
    categoryPath: "Payroll Taxes > CPP",
    memo: "Canada Pension Plan contribution",
    perPaycheque: 175,
    yearlyMaximum: 4034.1,
  },
  {
    categoryPath: "Payroll Taxes > EI",
    memo: "Employment Insurance premium",
    perPaycheque: 49.2,
    yearlyMaximum: 1077.48,
  },
];

/** The deductions' year-to-date totals, by category path. */
export type PayrollYearToDate = Map<string, number>;

/**
 * One paycheque as split lines, and the net amount deposited. Each deduction
 * withholds its usual amount, less whatever would take the year past its
 * maximum (`ytd` is updated), exactly as a capped payroll deduction behaves.
 */
export function payrollPaycheque(ytd: PayrollYearToDate): {
  net: number;
  splits: DemoSplit[];
} {
  const splits: DemoSplit[] = [
    {
      categoryPath: "Salary",
      amount: DEMO_GROSS_SALARY,
      memo: "Gross salary",
    },
  ];
  let net = DEMO_GROSS_SALARY;
  for (const d of demoPayrollDeductions) {
    const paid = ytd.get(d.categoryPath) ?? 0;
    const room =
      d.yearlyMaximum === undefined
        ? d.perPaycheque
        : Math.max(0, roundMoney(d.yearlyMaximum - paid));
    const amount = Math.min(d.perPaycheque, room);
    if (amount <= 0) continue;
    ytd.set(d.categoryPath, roundMoney(paid + amount));
    splits.push({
      categoryPath: d.categoryPath,
      amount: -amount,
      memo: d.memo,
    });
    net = roundMoney(net - amount);
  }
  return { net, splits };
}

/** The net of a paycheque withholding every deduction in full. */
export const DEMO_REGULAR_NET_PAY = roundMoney(
  DEMO_GROSS_SALARY -
    demoPayrollDeductions.reduce((s, d) => s + d.perPaycheque, 0),
);
