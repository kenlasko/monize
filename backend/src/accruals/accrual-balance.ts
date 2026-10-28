import { isCalendarDate } from "../common/validators/is-calendar-date.validator";
import { AccrualPlan } from "./accrual-allocation";
import { formatAccrualMoney, parseAccrualMoney } from "./accrual-money";

export type AccrualFamily = "expense" | "income";

/** Exact source-currency balances; one ordered pass for an entire preview. */
export function accrualBalancesAt(
  family: AccrualFamily,
  paymentDate: string,
  plan: AccrualPlan,
  dates: readonly string[],
): string[] {
  if (
    !isCalendarDate(paymentDate) ||
    dates.some((date) => !isCalendarDate(date))
  )
    throw new Error("Invalid accrual balance date");
  if (family !== "expense" && family !== "income")
    throw new Error("Invalid accrual family");
  const total = parseAccrualMoney(plan.amount);
  const allocations = plan.allocations
    .map((row) => ({
      date: row.recognitionDate,
      amount: parseAccrualMoney(row.amount),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const requests = dates
    .map((date, index) => ({ date, index }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const result: string[] = new Array(dates.length);
  let recognized = 0n;
  let cursor = 0;
  for (const { date, index } of requests) {
    while (cursor < allocations.length && allocations[cursor].date <= date) {
      recognized += allocations[cursor].amount;
      cursor++;
    }
    const paid = paymentDate <= date ? total : 0n;
    result[index] = formatAccrualMoney(
      family === "expense" ? recognized - paid : paid - recognized,
    );
  }
  return result;
}

/** Source-currency end-of-day timing balance; never a cash-account mutation. */
export function accrualBalanceAt(
  family: AccrualFamily,
  paymentDate: string,
  plan: AccrualPlan,
  asOf: string,
): string {
  return accrualBalancesAt(family, paymentDate, plan, [asOf])[0];
}
