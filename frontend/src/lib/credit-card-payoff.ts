import type { PayoffScenario } from '@/types/credit-card-detail';

/**
 * Project how long a carried credit-card balance takes to clear at a fixed
 * monthly payment, using revolving (declining-balance) interest. Money is
 * accumulated in integer cents to avoid floating-point drift.
 *
 * @param balance   Amount owed as a positive magnitude.
 * @param annualRatePercent Nominal APR (e.g. 19.99), or null for 0%.
 * @param monthlyPayment    Fixed monthly payment as a positive magnitude.
 * @param fromDate  Anchor for the projected payoff date (defaults to now).
 */
export function computePayoffScenario(
  balance: number,
  annualRatePercent: number | null,
  monthlyPayment: number,
  fromDate: Date = new Date(),
): PayoffScenario {
  const owed = Math.max(0, balance);
  const payment = Math.max(0, monthlyPayment);
  const monthlyRate = (annualRatePercent ?? 0) / 100 / 12;

  if (owed <= 0) {
    return {
      monthlyPayment: payment,
      payoffMonths: 0,
      totalInterest: 0,
      payoffDate: addMonths(fromDate, 0),
      neverPaysOff: false,
    };
  }

  // A payment that never exceeds the first month's interest can never reduce
  // the principal, so the balance is carried indefinitely.
  if (payment <= 0 || (monthlyRate > 0 && payment <= owed * monthlyRate)) {
    return {
      monthlyPayment: payment,
      payoffMonths: null,
      totalInterest: 0,
      payoffDate: null,
      neverPaysOff: true,
    };
  }

  let balanceCents = Math.round(owed * 100);
  const paymentCents = Math.round(payment * 100);
  let interestCents = 0;
  let months = 0;
  const MAX_MONTHS = 1200; // 100 years -- guards against pathological inputs

  while (balanceCents > 0 && months < MAX_MONTHS) {
    const monthInterest = Math.round(balanceCents * monthlyRate);
    interestCents += monthInterest;
    const pay = Math.min(paymentCents, balanceCents + monthInterest);
    balanceCents = balanceCents + monthInterest - pay;
    months += 1;
  }

  return {
    monthlyPayment: payment,
    payoffMonths: months,
    totalInterest: interestCents / 100,
    payoffDate: addMonths(fromDate, months),
    neverPaysOff: false,
  };
}

/** Add whole months to a date, returning a `YYYY-MM-DD` string. */
function addMonths(from: Date, months: number): string {
  const d = new Date(from.getFullYear(), from.getMonth() + months, from.getDate());
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
