import { BusinessDayCalendar } from "@/bonds/domain/business-day-calendar";
import { BondTerms, parseBondTerms } from "@/bonds/domain/bond-terms";
import { dayOfWeek } from "@/bonds/domain/calendar-date";
import { BondEngineInput, valueBondLot } from "@/bonds/engine/bond-engine";

export type Doc = Record<string, any>;

export interface CouponDocOptions {
  readonly datedDate: string;
  readonly firstCouponDate: string;
  readonly maturityDate: string;
  /** Annual rate as a decimal string, e.g. "0.0675". */
  readonly rate: string;
  readonly couponMonths?: 3 | 6 | 12;
  readonly endOfMonth?: boolean;
  readonly paymentAdjustment?: "NONE" | "NEXT_BUSINESS_DAY";
  readonly calendarId?: string;
}

/**
 * A country-neutral marketable coupon note of face 100, rounded on the holding
 * with the per-unit accrued interest of six decimals per 100 par
 * (`docs/specs/bond-marketable-primitives.md` 5.2): the shape every coupon test
 * builds on.
 */
export function couponDoc(
  o: CouponDocOptions,
  change: (doc: Doc) => void = () => undefined,
): Doc {
  const doc: Doc = {
    schemaVersion: 1,
    instrument: {
      issuerCountryCode: "XX",
      issuerCode: "XX_ISSUER",
      programCode: "NOTE",
      seriesCode: "NOTE-1",
      currency: "XXX",
      marketability: "MARKETABLE",
      faceValue: "100",
    },
    saleWindow: null,
    schedule: {
      anchor: "COUPON_DATES",
      datedDate: o.datedDate,
      firstCouponDate: o.firstCouponDate,
      maturityDate: o.maturityDate,
      couponMonths: o.couponMonths ?? 6,
      endOfMonth: o.endOfMonth ?? false,
      paymentAdjustment: o.paymentAdjustment ?? "NONE",
      calendarId: o.calendarId ?? "TEST",
    },
    accrual: { type: "ACTUAL_ACTUAL_ICMA" },
    principalRule: { type: "FIXED_NOMINAL" },
    rateRule: { type: "FIXED", annualRate: o.rate },
    capitalization: { type: "NONE" },
    redemption: { type: "MATURITY_ONLY" },
    rounding: {
      moneyDecimals: 2,
      mode: "HALF_UP",
      basis: "PER_HOLDING",
      unitDecimals: 6,
    },
    source: { provider: "TEST", url: "https://example.test", document: "doc" },
  };
  change(doc);
  return doc;
}

export function couponTerms(
  o: CouponDocOptions,
  change?: (doc: Doc) => void,
): BondTerms {
  return parseBondTerms(couponDoc(o, change));
}

/** Monday to Friday are business days; the calendar the coupon fixtures name. */
export const weekdays: BusinessDayCalendar = {
  id: "TEST",
  isBusinessDay: (ymd) => ![0, 6].includes(dayOfWeek(ymd)),
};

export function lotOf(
  terms: BondTerms,
  purchaseDate: string,
  quantity: number,
  calendars: ReadonlyMap<string, BusinessDayCalendar> = new Map([
    ["TEST", weekdays],
  ]),
): Omit<BondEngineInput, "asOf"> {
  return {
    terms,
    termsVersion: 1,
    announcedRates: new Map(),
    benchmarks: new Map(),
    calendars,
    lot: { purchaseDate, quantity },
  };
}

/** The valuation of a lot on `asOf`; the calendar `TEST` (weekdays) is known unless `calendars` says otherwise. */
export const value = (
  terms: BondTerms,
  purchaseDate: string,
  quantity: number,
  asOf: string,
  calendars?: ReadonlyMap<string, BusinessDayCalendar>,
) => valueBondLot({ ...lotOf(terms, purchaseDate, quantity, calendars), asOf });

// The worked examples of 31 CFR 356 Appendix B, as notes of face 100.

/** Section I.D example 1: a 6 3/4 percent note, 92 days of a 184-day period. */
export const E4 = couponTerms({
  datedDate: "1990-08-15",
  firstCouponDate: "1991-02-15",
  maturityDate: "1992-02-15",
  rate: "0.0675",
});

/** Section I.D example 2: a 10 3/4 percent bond dated in the half-year before its first coupon (44 of 181 days, then 81 of 184). */
export const E5 = couponTerms({
  datedDate: "1990-07-02",
  firstCouponDate: "1991-02-15",
  maturityDate: "2000-02-15",
  rate: "0.1075",
});

/** Section I.A example 3: an 8 3/8 percent note with a short first coupon. */
export const E6 = couponTerms({
  datedDate: "1990-07-02",
  firstCouponDate: "1990-12-31",
  maturityDate: "1992-06-30",
  rate: "0.08375",
  endOfMonth: true,
});

/** Section I.A example 4: a 7 7/8 percent note with a long first coupon. */
export const E7 = couponTerms({
  datedDate: "1990-12-03",
  firstCouponDate: "1991-08-15",
  maturityDate: "1993-08-15",
  rate: "0.07875",
});
