import { isCalendarDate } from "../../../common/validators/is-calendar-date.validator";
import { AccountType } from "../../../accounts/entities/account.entity";
import {
  MappedLoanRate,
  MappedLoanTerms,
  MappedLoans,
} from "../../mny/model/mny-import-model";
import { MnyWarning } from "../../mny/model/mny-warnings";
import { KmyAccount, KmyRawFile } from "../model/kmy-raw";
import {
  Rational,
  abs,
  compare,
  isZero,
  parseKmyNumber,
  rational,
  toDecimalString,
} from "../model/kmy-rational";
import { KmyAccountMapping } from "./kmy-map-accounts";
import { KMY_TYPE } from "./kmy-account-tree";
import { amountNumber } from "./kmy-amounts";
import { OCCURRENCE, normalizeOccurrence } from "./kmy-schedule-cadence";

/**
 * Spec 5.11: the loan terms a KMyMoney loan account states in its KVPs
 * (reference 5.9) -- the dated rates, the original amount and the term -- as
 * the optional fields of `MappedLoanTerms`, merged into what `mapLoans`
 * inferred from the payments.
 */

/** Places an annual rate keeps: the `NUMERIC(8,4)` of both rate columns. */
const RATE_PLACES = 4;
const MAX_RATE = rational(100n);
/** The account DTO's bound on `originalPrincipal`. */
const MAX_PRINCIPAL = rational(999999999999n);
/** A hundred years: past this a term is a misread, not a loan. */
const MAX_AMORTIZATION_MONTHS = 1200;
const RATE_KEY = /^ir-(\d{4}-\d{2}-\d{2})$/;

/** The KVP-stated terms of one loan account, by its Monize key. */
export interface KmyLoanKvpTerms {
  readonly accountKey: string;
  readonly rates: readonly MappedLoanRate[];
  readonly originalPrincipal: number | null;
  readonly amortizationMonths: number | null;
}

export interface KmyLoanTermsInput {
  readonly raw: KmyRawFile;
  readonly mapping: KmyAccountMapping;
  readonly coinDecimals: ReadonlyMap<string, number>;
}

export interface KmyLoanTermsResult {
  readonly terms: readonly KmyLoanKvpTerms[];
  readonly warnings: readonly MnyWarning[];
}

export function readKmyLoanTerms(input: KmyLoanTermsInput): KmyLoanTermsResult {
  const { raw, mapping, coinDecimals } = input;
  const loanKeys = new Set(
    mapping.mapped.accounts
      .filter((account) => account.accountType === AccountType.LOAN)
      .map((account) => account.key),
  );
  const terms: KmyLoanKvpTerms[] = [];
  const warnings: MnyWarning[] = [];

  for (const account of raw.accounts) {
    if (account.type !== KMY_TYPE.LOAN) {
      continue;
    }
    const accountKey = mapping.keyById.get(account.id);
    if (accountKey === undefined || !loanKeys.has(accountKey)) {
      continue;
    }
    const currencyCode =
      mapping.currencyByKey.get(accountKey) ?? mapping.baseCurrency;
    const rates = loanRates(account, warnings);
    const originalPrincipal = loanPrincipal(
      account,
      currencyCode,
      coinDecimals,
      warnings,
    );
    const amortizationMonths = loanAmortizationMonths(account, raw, warnings);
    if (
      rates.length > 0 ||
      originalPrincipal !== null ||
      amortizationMonths !== null
    ) {
      terms.push({ accountKey, rates, originalPrincipal, amortizationMonths });
    }
  }

  return { terms, warnings };
}

/**
 * Every readable `ir-YYYY-MM-DD` rate, ascending, a repeat of the rate kept
 * before it dropped; an unreadable or out-of-range value is named.
 */
function loanRates(
  account: KmyAccount,
  warnings: MnyWarning[],
): MappedLoanRate[] {
  const dated = [...account.kvp.entries()]
    .map(([key, text]) => ({ date: RATE_KEY.exec(key)?.[1], text }))
    .filter(
      (entry): entry is { date: string; text: string } =>
        entry.date !== undefined && isCalendarDate(entry.date),
    )
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const rates: MappedLoanRate[] = [];
  for (const { date, text } of dated) {
    const parsed = parseKmyNumber(text);
    if (
      parsed.kind !== "value" ||
      compare(parsed.value, rational(0n)) < 0 ||
      compare(parsed.value, MAX_RATE) > 0
    ) {
      warnings.push({
        code: "loanInterestRateNotImported",
        subject: account.name,
        detail: text,
      });
      continue;
    }
    const annualRate = Number(toDecimalString(parsed.value, RATE_PLACES));
    if (rates[rates.length - 1]?.annualRate === annualRate) {
      continue;
    }
    rates.push({ effectiveDate: date, annualRate });
  }
  return rates;
}

/** `loan-amount` as a positive amount at the account's places. */
function loanPrincipal(
  account: KmyAccount,
  currencyCode: string,
  coinDecimals: ReadonlyMap<string, number>,
  warnings: MnyWarning[],
): number | null {
  const text = account.kvp.get("loan-amount");
  if (text === undefined || text.trim() === "") {
    return null;
  }
  const parsed = parseKmyNumber(text);
  if (
    parsed.kind !== "value" ||
    compare(abs(parsed.value), MAX_PRINCIPAL) > 0
  ) {
    warnings.push({
      code: "loanTermsNotImported",
      subject: account.name,
      detail: `loan-amount=${text}`,
    });
    return null;
  }
  if (isZero(parsed.value)) {
    return null;
  }
  const amount = amountNumber(abs(parsed.value), currencyCode, coinDecimals);
  return amount > 0 ? amount : null;
}

/**
 * `term` (a count of payments) in months, through the loan-payment
 * schedule's interval; null and named when the interval is unknown or not a
 * whole-month-like cadence the count converts from.
 */
function loanAmortizationMonths(
  account: KmyAccount,
  raw: KmyRawFile,
  warnings: MnyWarning[],
): number | null {
  const text = account.kvp.get("term");
  if (text === undefined || text.trim() === "") {
    return null;
  }
  const refuse = (): null => {
    warnings.push({
      code: "loanTermsNotImported",
      subject: account.name,
      detail: `term=${text}`,
    });
    return null;
  };
  if (!/^\d+$/.test(text.trim())) {
    return refuse();
  }
  const payments = BigInt(text.trim());
  const scheduleId = account.kvp.get("schedule");
  const schedule = scheduleId
    ? raw.schedules.find((entry) => entry.id === scheduleId)
    : undefined;
  const occurrence = schedule
    ? normalizeOccurrence(schedule.occurrence, schedule.multiplier)
    : null;
  const months = occurrence
    ? monthsForPayments(payments, occurrence.base, occurrence.multiplier)
    : null;
  if (months === null) {
    return refuse();
  }
  const rounded = Number(toDecimalString(months, 0));
  return rounded >= 1 && rounded <= MAX_AMORTIZATION_MONTHS
    ? rounded
    : refuse();
}

/** `payments` x 12 / payments-per-year, exactly; null for a daily or once cadence. */
function monthsForPayments(
  payments: bigint,
  base: number,
  multiplier: number,
): Rational | null {
  const m = BigInt(multiplier);
  switch (base) {
    case OCCURRENCE.MONTHLY:
      return rational(payments * m);
    case OCCURRENCE.YEARLY:
      return rational(payments * 12n * m);
    case OCCURRENCE.WEEKLY:
      return rational(payments * 12n * m, 52n);
    case OCCURRENCE.HALF_MONTH:
      return rational(payments * m, 2n);
    default:
      return null;
  }
}

/**
 * The KVP terms merged into the inferred ones: a loan `mapLoans` left out
 * gets an entry whose inferred fields are null and `paymentsObserved` 0.
 */
export function withKmyLoanTerms(
  loans: MappedLoans,
  terms: readonly KmyLoanKvpTerms[],
): MappedLoans {
  const byKey = new Map(terms.map((entry) => [entry.accountKey, entry]));
  const merged: MappedLoanTerms[] = loans.loans.map((loan) => {
    const stated = byKey.get(loan.accountKey);
    return stated ? { ...loan, ...statedFields(stated) } : loan;
  });
  const inferredKeys = new Set(loans.loans.map((loan) => loan.accountKey));
  for (const stated of terms) {
    if (inferredKeys.has(stated.accountKey)) {
      continue;
    }
    merged.push({
      accountKey: stated.accountKey,
      interestCategoryHandle: null,
      interestBookingMode: null,
      sourceAccountKey: null,
      paymentAmount: null,
      paymentFrequency: null,
      paymentStartDate: null,
      paymentsObserved: 0,
      ...statedFields(stated),
    });
  }
  return { ...loans, loans: merged };
}

function statedFields(
  stated: KmyLoanKvpTerms,
): Pick<MappedLoanTerms, "rates" | "originalPrincipal" | "amortizationMonths"> {
  return {
    rates: stated.rates,
    originalPrincipal: stated.originalPrincipal,
    amortizationMonths: stated.amortizationMonths,
  };
}
