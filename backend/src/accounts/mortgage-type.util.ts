/**
 * A mortgage's compounding convention and amortization method, stored in
 * `accounts.mortgage_type` (docs/specs/mortgage-types.md, decision 1). The list
 * is the `accounts_mortgage_type_check` CHECK in `database/schema.sql`.
 */
export const MORTGAGE_TYPES = [
  "ANNUITY",
  "CANADIAN_FIXED",
  "LINEAR",
  "INTEREST_ONLY",
] as const;
export type MortgageType = (typeof MORTGAGE_TYPES)[number];

/**
 * How the quoted annual rate becomes a per-period rate (spec table 4.1):
 * `NOMINAL` divides it by the payments per year, `SEMI_ANNUAL` compounds it
 * twice a year and converts that to the payment period.
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
 * Spec table 4.1, the one place a type's behaviour is decided. A `Record` over
 * `MortgageType`, so a type added to `MORTGAGE_TYPES` without a row here is a
 * compile error. A consumer asks a trait through the accessors below rather
 * than comparing type literals, so a new type is one row plus whatever the
 * compiler then names.
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
 * What an extra repayment does to a LINEAR mortgage's constant principal
 * (spec decision 4, table 4.3), stored in `accounts.prepayment_mode`. The list
 * is the `accounts_prepayment_mode_check` CHECK in `database/schema.sql`.
 * `SHORTEN_TERM` keeps the principal and ends the loan earlier;
 * `LOWER_INSTALLMENT` re-derives it as the remaining debt over the remaining
 * scheduled payments and keeps the end date.
 */
export const PREPAYMENT_MODES = ["SHORTEN_TERM", "LOWER_INSTALLMENT"] as const;
export type PrepaymentMode = (typeof PREPAYMENT_MODES)[number];

/**
 * The mode a LINEAR mortgage prices by: the column, else `SHORTEN_TERM`
 * (spec decision 10). Only LINEAR reads it; the column is null on every other
 * type (`accounts_prepayment_mode_linear_only`).
 */
export function prepaymentModeOf(row: {
  prepaymentMode?: PrepaymentMode | null;
}): PrepaymentMode {
  return row.prepaymentMode ?? "SHORTEN_TERM";
}

/**
 * The `prepayment_mode` a save writes for `type`: the requested mode, else the
 * stored one, for a LINEAR mortgage; null for every other type, whatever the
 * request carries, because forms resend every field and a mortgage switched
 * away from LINEAR would otherwise be refused by the CHECK (spec decision 10).
 */
export function prepaymentModeColumn(
  type: MortgageType | null,
  requested: PrepaymentMode | null | undefined,
  stored: PrepaymentMode | null | undefined = null,
): PrepaymentMode | null {
  if (type !== "LINEAR") return null;
  return requested !== undefined ? requested : (stored ?? null);
}

/**
 * Whether a mortgage of `type` stores a constant payment in
 * `accounts.payment_amount`: only the annuity methods. LINEAR and
 * INTEREST_ONLY price each installment at its due date, so the column is null
 * for them (spec decision 11, `accounts_payment_amount_method_check`).
 */
export function storesConstantPayment(type: MortgageType): boolean {
  return amortizationMethodFor(type) === "ANNUITY";
}

/**
 * The type a stored account carries: `accounts.mortgage_type`, NOT NULL since
 * the contract migration (P3-B1). Read only on a MORTGAGE; every other account
 * carries the column's default, `ANNUITY`, the annuity engine a plain `LOAN`
 * uses. Every consumer of the type reads it through here.
 */
export function mortgageTypeOf(row: {
  mortgageType: MortgageType;
}): MortgageType {
  return row.mortgageType;
}
