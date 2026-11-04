import { roundToDecimals } from "../common/round.util";
import { currencyMinorUnitDecimals } from "../common/currency-minor-unit.util";
import {
  DEFAULT_PERIODS_PER_YEAR,
  periodsPerYearForStoredFrequency,
} from "../accounts/payment-frequency.util";

/**
 * The fees a mortgage payment collects beside principal and interest
 * (`docs/specs/mortgage-fees.md`, INV-LOAN-011): how one fee is priced for
 * one installment. Pure: no I/O, no clock. The template rewrite, the
 * projection and the mortgage create all price a fee line through
 * `priceLoanFee`, so the three cannot disagree about it.
 */

export const LOAN_FEE_CALCULATIONS = [
  "FIXED",
  "PERCENT_CURRENT_BALANCE",
  "PERCENT_ORIGINAL_BALANCE",
] as const;
export type LoanFeeCalculation = (typeof LOAN_FEE_CALCULATIONS)[number];

export const LOAN_FEE_BASES = ["PER_PAYMENT", "ANNUAL"] as const;
export type LoanFeeBasis = (typeof LOAN_FEE_BASES)[number];

/** The most fees one mortgage carries (spec section 7). */
export const MAX_LOAN_FEES = 10;

/** The terms of one fee, as `loan_fees` stores them. */
export interface LoanFeeTerms {
  readonly categoryId: string;
  readonly name: string;
  readonly calculation: LoanFeeCalculation;
  readonly basis: LoanFeeBasis;
  /** A FIXED fee's money; null for a percentage. */
  readonly amount: number | string | null;
  /** A percentage fee's rate in percent; null for a FIXED fee. */
  readonly rate: number | string | null;
}

/** The facts one installment's fees are priced from, all dated at its due date. */
export interface LoanFeeFacts {
  /** The ledger debt through the installment's date (`datedLoanDebt`). */
  readonly debt: number;
  /**
   * `accounts.original_principal`, else `|accounts.opening_balance|`
   * (`originalPrincipalOf`); null when neither is positive.
   */
  readonly originalPrincipal: number | null;
  /** The installments a year at the stored cadence. */
  readonly periodsPerYear: number;
  /** The currency's minor-unit decimals: a fee is booked in whole units. */
  readonly decimals: number;
}

export type PricedLoanFee =
  | { readonly kind: "ok"; readonly amount: number }
  /** A figure the fee needs is unknown; never priced as 0. */
  | { readonly kind: "unknown"; readonly reason: string };

/**
 * The amount one fee charges on one installment (spec section 3): the
 * calculation's base, divided over the periods per year for an ANNUAL fee,
 * rounded to the currency's minor unit.
 */
export function priceLoanFee(
  fee: LoanFeeTerms,
  facts: LoanFeeFacts,
): PricedLoanFee {
  const value = Number(
    fee.calculation === "FIXED" ? fee.amount : (fee.rate ?? NaN),
  );
  if (!Number.isFinite(value) || value <= 0) {
    return {
      kind: "unknown",
      reason: `the fee "${fee.name}" has no ${fee.calculation === "FIXED" ? "amount" : "rate"}`,
    };
  }
  let base: number;
  switch (fee.calculation) {
    case "FIXED":
      base = value;
      break;
    case "PERCENT_CURRENT_BALANCE":
      base = (Math.max(0, facts.debt) * value) / 100;
      break;
    case "PERCENT_ORIGINAL_BALANCE":
      if (facts.originalPrincipal === null) {
        return {
          kind: "unknown",
          reason: `the fee "${fee.name}" is a percentage of the original principal, and the mortgage records none`,
        };
      }
      base = (facts.originalPrincipal * value) / 100;
      break;
  }
  const perInstallment =
    fee.basis === "ANNUAL" ? base / facts.periodsPerYear : base;
  return {
    kind: "ok",
    amount: roundToDecimals(perInstallment, facts.decimals),
  };
}

/**
 * The amount a PERCENT_ORIGINAL_BALANCE fee is a percentage of: the amount
 * originally borrowed, else the debt the ledger opened at; null when neither
 * is positive (spec section 3).
 */
export function originalPrincipalOf(account: {
  originalPrincipal?: number | string | null;
  openingBalance?: number | string | null;
}): number | null {
  const original = Number(account.originalPrincipal);
  if (account.originalPrincipal != null && Number.isFinite(original)) {
    if (original > 0) return original;
  }
  const opening = Math.abs(Number(account.openingBalance));
  return account.openingBalance != null &&
    Number.isFinite(opening) &&
    opening > 0
    ? opening
    : null;
}

/** The fees of one installment, each priced, or the first one that cannot be. */
export type PricedLoanFees =
  | { readonly kind: "ok"; readonly amounts: number[]; readonly total: number }
  | { readonly kind: "unknown"; readonly reason: string };

/**
 * Price every fee for one installment and total them on scaled integers
 * (never by accumulating floats). The one loop the template rewrite, the
 * projection, the mortgage create and the fee replace all price through.
 */
export function priceLoanFees(
  fees: readonly LoanFeeTerms[],
  facts: LoanFeeFacts,
): PricedLoanFees {
  const amounts: number[] = [];
  let units = 0;
  for (const fee of fees) {
    const priced = priceLoanFee(fee, facts);
    if (priced.kind === "unknown") return priced;
    amounts.push(priced.amount);
    units += Math.round(priced.amount * MONEY_SCALE);
  }
  return { kind: "ok", amounts, total: units / MONEY_SCALE };
}

/** 10^4: money's storage precision, the scale fee totals are summed at. */
const MONEY_SCALE = 10_000;

/**
 * The facts a mortgage's fees are priced from at one installment: the debt
 * through its date, the account's original principal, the periods a year of
 * the stored cadence (defaulting as `periodicRateFor` does) and the
 * currency's minor unit.
 */
export function loanFeeFactsFor(
  account: {
    currencyCode: string;
    originalPrincipal?: number | string | null;
    openingBalance?: number | string | null;
  },
  debt: number,
  frequency: string | null | undefined,
): LoanFeeFacts {
  return {
    debt,
    originalPrincipal: originalPrincipalOf(account),
    periodsPerYear:
      periodsPerYearForStoredFrequency(frequency) ?? DEFAULT_PERIODS_PER_YEAR,
    decimals: currencyMinorUnitDecimals(account.currencyCode),
  };
}
