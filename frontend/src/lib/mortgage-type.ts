/**
 * A mortgage type's behaviour, decided once: the browser-side twin of
 * `backend/src/accounts/mortgage-type.util.ts` (docs/specs/mortgage-types.md,
 * table 4.1). A consumer asks a trait through the accessors below rather than
 * comparing type literals, so a new type is one row here plus whatever the
 * compiler then names.
 *
 * `mortgage-type.contract.test.ts` reads the backend's
 * `mortgage-type-cases.json` and fails when the two layers disagree.
 */

import type { MortgageType } from "@/types/account";

/**
 * How the quoted annual rate becomes a per-period rate: `NOMINAL` divides it
 * by the payments per year, `SEMI_ANNUAL` compounds it twice a year and
 * converts that to the payment period.
 */
export type MortgageCompounding = "NOMINAL" | "SEMI_ANNUAL";

/** How each installment's principal is derived (spec table 4.3). */
export type MortgageAmortizationMethod = "ANNUITY" | "LINEAR" | "INTEREST_ONLY";

/**
 * How rate inference turns an observed periodic rate back into an annual one:
 * `DAY_COUNT` scales by the days the period spans, `SEMI_ANNUAL` inverts the
 * semi-annual conversion.
 */
export type MortgageAnnualization = "DAY_COUNT" | "SEMI_ANNUAL";

export interface MortgageTypeTraits {
  readonly compounding: MortgageCompounding;
  readonly method: MortgageAmortizationMethod;
  readonly annualization: MortgageAnnualization;
}

/**
 * Spec table 4.1. A `Record` over `MortgageType`, so a type added to
 * `MORTGAGE_TYPES` without a row here is a compile error.
 */
export const MORTGAGE_TYPE_TRAITS: Readonly<
  Record<MortgageType, MortgageTypeTraits>
> = Object.freeze({
  ANNUITY: Object.freeze({
    compounding: "NOMINAL",
    method: "ANNUITY",
    annualization: "DAY_COUNT",
  }),
  CANADIAN_FIXED: Object.freeze({
    compounding: "SEMI_ANNUAL",
    method: "ANNUITY",
    annualization: "SEMI_ANNUAL",
  }),
  LINEAR: Object.freeze({
    compounding: "NOMINAL",
    method: "LINEAR",
    annualization: "DAY_COUNT",
  }),
  INTEREST_ONLY: Object.freeze({
    compounding: "NOMINAL",
    method: "INTEREST_ONLY",
    annualization: "DAY_COUNT",
  }),
});

export function compoundingFor(type: MortgageType): MortgageCompounding {
  return MORTGAGE_TYPE_TRAITS[type].compounding;
}

export function amortizationMethodFor(
  type: MortgageType,
): MortgageAmortizationMethod {
  return MORTGAGE_TYPE_TRAITS[type].method;
}

export function annualizationFor(type: MortgageType): MortgageAnnualization {
  return MORTGAGE_TYPE_TRAITS[type].annualization;
}

/**
 * The type an account carries: its stored `mortgageType`, NOT NULL since the
 * contract migration (P3-B1). Read only on a mortgage; every other account
 * carries the column default, `ANNUITY`, the annuity engine every `LOAN`
 * account uses. Mirrors the backend's `mortgageTypeOf`; every frontend
 * consumer of the type reads it through here.
 */
export function mortgageTypeOf(account: {
  mortgageType: MortgageType;
}): MortgageType {
  return account.mortgageType;
}

/**
 * What an extra repayment does to a LINEAR mortgage's principal (spec decision
 * 4, table 4.3), stored in `accounts.prepayment_mode`; the browser-side twin of
 * the backend's `PREPAYMENT_MODES`. `SHORTEN_TERM` keeps the constant
 * principal and ends the loan earlier; `LOWER_INSTALLMENT` re-derives it as
 * the remaining debt over the remaining scheduled payments and keeps the end
 * date.
 */
export const PREPAYMENT_MODES = ["SHORTEN_TERM", "LOWER_INSTALLMENT"] as const;
export type PrepaymentMode = (typeof PREPAYMENT_MODES)[number];

/**
 * The mode a LINEAR mortgage prices by: the column, else `SHORTEN_TERM` (spec
 * decision 10). Only LINEAR reads it; the server stores null on every other
 * type.
 */
export function prepaymentModeOf(row: {
  prepaymentMode?: PrepaymentMode | null;
}): PrepaymentMode {
  return row.prepaymentMode ?? "SHORTEN_TERM";
}

/**
 * Whether a mortgage of `type` has a constant payment: only the annuity
 * methods. LINEAR and INTEREST_ONLY price each installment at its due date
 * (spec decision 11), so a form shows their first installment read-only, and
 * the accelerated cadences -- a fraction of the annuity's monthly installment
 * -- are not offered for them (spec section 5.1). Mirrors the backend's
 * `storesConstantPayment`.
 */
export function storesConstantPayment(type: MortgageType): boolean {
  return amortizationMethodFor(type) === "ANNUITY";
}

/**
 * Whether a stored cadence is accelerated: a fraction of an annuity's monthly
 * installment, so meaningful only for a type with a constant payment (spec
 * section 5.1). Mirrors the backend's `isAcceleratedFrequency`.
 */
export function isAcceleratedFrequency(
  frequency: string | null | undefined,
): boolean {
  return (
    frequency === "ACCELERATED_BIWEEKLY" || frequency === "ACCELERATED_WEEKLY"
  );
}
