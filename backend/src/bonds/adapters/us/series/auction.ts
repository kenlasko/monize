import { SeriesFetchError } from "../../../bond-adapter";
import { echo, TEXT_ECHO } from "../../../series-echo";
import {
  addMonthsClamped,
  compareYMD,
  daysBetween,
  daysInMonth,
  parseYMD,
} from "../../../domain/calendar-date";
import { ExactDecimal } from "../../../domain/exact-decimal";
import {
  buildCouponSchedule,
  CouponScheduleError,
  firstRegularCouponDate,
} from "../../../domain/period-schedule";
import {
  AuctionRecord,
  formatChanged,
  optionalText,
  parseIndexLevel,
  parsePercent,
  parseSignedPercent,
  requiredDate,
  requiredFlag,
  requiredText,
} from "./ta-ws";
import { UsProgram } from "./templates";

/** The bounds of country spec section 3.5. */
const BILL_MIN_DAYS = 28;
const BILL_MAX_DAYS = 364;
const MAX_COUPON_PERCENT = "20";
const MAX_YEARS_TO_MATURITY = 31;
const BILL_PRICE_PLACES = 6;
const BILL_DAYS_IN_YEAR = 360;
const SEMIANNUAL = /^semi-?\s?annual$/i;
/** `firstInterestPaymentLength`, upper-cased: how long the first coupon period is. */
const FIRST_PERIODS = ["NORMAL", "SHORT", "LONG"] as const;
const QUARTERLY = /^quarterly$/i;
const MAX_SPREAD_PERCENT = "1";
const MIN_REF_CPI = "100";
const MAX_REF_CPI = "1000";

export interface BillAuction {
  readonly program: "BILL";
  readonly cusip: string;
  readonly auctionDate: string;
  readonly issueDate: string;
  readonly maturityDate: string;
  readonly discountRate: ExactDecimal;
  /** The auction price per 100, as the source states it. */
  readonly highPrice: string;
  readonly xmlFileName: string;
}

/** What a note, a bond, a TIPS and a floating rate note share. */
interface CouponBase {
  readonly cusip: string;
  readonly auctionDate: string;
  readonly issueDate: string;
  readonly datedDate: string;
  readonly firstCouponDate: string;
  readonly maturityDate: string;
  readonly highPrice: string;
  readonly xmlFileName: string;
}

export interface CouponAuction extends CouponBase {
  readonly program: "NOTE" | "BOND";
  /** The coupon in percent, exact. */
  readonly interestRate: ExactDecimal;
}

export interface TipsAuction extends CouponBase {
  readonly program: "TIPS";
  readonly interestRate: ExactDecimal;
  /** The reference CPI of the dated date, exact. */
  readonly refCpi: ExactDecimal;
}

export interface FrnAuction extends CouponBase {
  readonly program: "FRN";
  /** The spread over the 13-week bill yield, in percent, exact; may be negative. */
  readonly spread: ExactDecimal;
}

export type AnyCouponAuction = CouponAuction | TipsAuction | FrnAuction;
export type Auction = BillAuction | AnyCouponAuction;

export function inconsistent(
  field: string,
  value: string,
  expected: string,
): SeriesFetchError {
  // Both sides may be the source's own text: only a short machine value is
  // echoed (INV-BOND-006).
  return new SeriesFetchError("SOURCE_INCONSISTENT", {
    field,
    value: echo(value, TEXT_ECHO),
    expected: echo(expected, TEXT_ECHO),
  });
}

/**
 * The program of an auction from its security type and its two flags.
 * `securityType` is compared as upper case: the JSON says "Note", the results
 * file "NOTE".
 */
export function programOfRecord(record: AuctionRecord): UsProgram {
  const type = requiredText(record, "securityType").toUpperCase();
  const inflation = requiredFlag(record, "inflationProtected");
  const floating = requiredFlag(record, "floatingRate");
  if (type === "TIPS" || inflation) return "TIPS";
  if (type === "FRN" || floating) return "FRN";
  switch (type) {
    case "BILL":
    case "CMB":
      return "BILL";
    case "NOTE":
      return "NOTE";
    case "BOND":
      return "BOND";
    default:
      throw formatChanged("securityType");
  }
}

/** True when the date is the last day of its month: coupons then fall on month ends. */
export function isMonthEnd(date: string): boolean {
  const { year, month, day } = parseYMD(date);
  return day === daysInMonth(year, month);
}

function optionalPrice(record: AuctionRecord): string {
  const price = optionalText(record, "highPrice");
  if (price !== "") parsePercent(price, "highPrice");
  return price;
}

/**
 * `100 x (1 - rate / 100 x days / 360)` rounded to six decimals: the price of a
 * bill per 100 of face (country spec section 3.4).
 */
export function billPrice(rate: ExactDecimal, days: number): ExactDecimal {
  const discount = rate
    .mul(ExactDecimal.fromInt(days))
    .div(ExactDecimal.fromInt(BILL_DAYS_IN_YEAR));
  return ExactDecimal.fromInt(100)
    .sub(discount)
    .round(BILL_PRICE_PLACES, "HALF_UP");
}

export function readBill(record: AuctionRecord, cusip: string): BillAuction {
  const auctionDate = requiredDate(record, "competitiveAuctionCloseDate");
  const issueDate = requiredDate(record, "issueDate");
  const maturityDate = requiredDate(record, "maturityDate");
  // A bill's `highRate` is its high discount rate; `investmentRate` is its yield.
  const discountRate = parsePercent(
    requiredText(record, "highRate"),
    "highRate",
  );
  const highPrice = requiredText(record, "highPrice");
  const price = parsePercent(highPrice, "highPrice");
  if (compareYMD(auctionDate, issueDate) > 0) {
    throw inconsistent("auctionDate", auctionDate, issueDate);
  }
  const days = daysBetween(issueDate, maturityDate);
  if (days < BILL_MIN_DAYS || days > BILL_MAX_DAYS) {
    throw inconsistent("term", String(days), "28-364");
  }
  // A price of exactly 100 is a bill auctioned at a rate of nothing (Treasury
  // did so in 2020): no discount, and the price check below ties it to the rate.
  if (price.cmp(ExactDecimal.fromInt(100)) > 0) {
    throw inconsistent("highPrice", highPrice, "<=100");
  }
  const expected = billPrice(discountRate, days);
  if (expected.cmp(price) !== 0) {
    throw inconsistent(
      "highPrice",
      price.toTrimmedString(9, 6),
      expected.toFixed(BILL_PRICE_PLACES),
    );
  }
  return {
    program: "BILL",
    cusip,
    auctionDate,
    issueDate,
    maturityDate,
    discountRate,
    highPrice,
    xmlFileName: optionalText(record, "treasuryAuctionResultsXmlFileName"),
  };
}

/** The coupon rate in percent, 0 to 20. */
export function readCouponRate(record: AuctionRecord): ExactDecimal {
  const interestRate = parsePercent(
    requiredText(record, "interestRate"),
    "interestRate",
  );
  if (interestRate.cmp(ExactDecimal.parse(MAX_COUPON_PERCENT)) > 0) {
    throw inconsistent(
      "interestRate",
      interestRate.toTrimmedString(9, 0),
      `<=${MAX_COUPON_PERCENT}`,
    );
  }
  return interestRate;
}

/**
 * The dates, the frequency and the price every coupon security has, checked
 * against the bounds of country spec section 3.5. `couponMonths` is 6 for a
 * note, a bond and a TIPS, 3 for a floating rate note.
 */
export function readCouponBase(
  record: AuctionRecord,
  cusip: string,
  couponMonths: 3 | 6,
): CouponBase {
  const auctionDate = requiredDate(record, "competitiveAuctionCloseDate");
  const issueDate = requiredDate(record, "issueDate");
  const maturityDate = requiredDate(record, "maturityDate");
  const datedDate = requiredDate(record, "datedDate");
  const frequency = requiredText(record, "frequencyOfInterestPayments");
  if (!(couponMonths === 6 ? SEMIANNUAL : QUARTERLY).test(frequency)) {
    throw inconsistent(
      "frequencyOfInterestPayments",
      "other",
      couponMonths === 6 ? "semiannual" : "quarterly",
    );
  }
  if (compareYMD(auctionDate, issueDate) > 0) {
    throw inconsistent("auctionDate", auctionDate, issueDate);
  }
  if (compareYMD(datedDate, issueDate) > 0) {
    throw inconsistent("datedDate", datedDate, issueDate);
  }
  if (
    compareYMD(maturityDate, issueDate) <= 0 ||
    compareYMD(
      maturityDate,
      addMonthsClamped(issueDate, 12 * MAX_YEARS_TO_MATURITY),
    ) > 0
  ) {
    throw inconsistent("maturityDate", maturityDate, issueDate);
  }
  const firstPeriod = requiredText(
    record,
    "firstInterestPaymentLength",
  ).toUpperCase();
  if (!(FIRST_PERIODS as readonly string[]).includes(firstPeriod)) {
    throw formatChanged("firstInterestPaymentLength");
  }
  const endOfMonth = isMonthEnd(maturityDate);
  let firstCouponDate: string;
  try {
    // The JSON states no first coupon date, only the first period's length;
    // the results file's FirstInterestPaymentDate is checked against this.
    firstCouponDate = firstRegularCouponDate(
      { datedDate, maturityDate, couponMonths, endOfMonth },
      firstPeriod as (typeof FIRST_PERIODS)[number],
    );
    buildCouponSchedule({
      datedDate,
      firstCouponDate,
      maturityDate,
      couponMonths,
      endOfMonth,
    });
  } catch (error) {
    if (error instanceof CouponScheduleError) {
      throw inconsistent("firstInterestPaymentLength", firstPeriod, "regular");
    }
    throw error;
  }
  return {
    cusip,
    auctionDate,
    issueDate,
    datedDate,
    firstCouponDate,
    maturityDate,
    highPrice: optionalPrice(record),
    xmlFileName: optionalText(record, "treasuryAuctionResultsXmlFileName"),
  };
}

export function readCoupon(
  record: AuctionRecord,
  cusip: string,
  program: "NOTE" | "BOND",
): CouponAuction {
  const interestRate = readCouponRate(record);
  return { ...readCouponBase(record, cusip, 6), program, interestRate };
}

/** A TIPS: a coupon security with a reference CPI of its dated date, 100 to 1,000. */
export function readTips(record: AuctionRecord, cusip: string): TipsAuction {
  const interestRate = readCouponRate(record);
  const base = readCouponBase(record, cusip, 6);
  // The original issue's record: its dated date is the original dated date.
  const field = "referenceCpiOnOriginalDatedDate";
  const text = optionalText(record, field);
  if (text === "") throw inconsistent(field, "", "present");
  const refCpi = parseIndexLevel(text, field);
  if (
    refCpi.cmp(ExactDecimal.parse(MIN_REF_CPI)) < 0 ||
    refCpi.cmp(ExactDecimal.parse(MAX_REF_CPI)) > 0
  ) {
    throw inconsistent(
      field,
      refCpi.toTrimmedString(9, 0),
      `${MIN_REF_CPI}-${MAX_REF_CPI}`,
    );
  }
  return { ...base, program: "TIPS", interestRate, refCpi };
}

/** A floating rate note: quarterly, with a spread of -1 to 1 percent. */
export function readFrn(record: AuctionRecord, cusip: string): FrnAuction {
  const base = readCouponBase(record, cusip, 3);
  const text = optionalText(record, "spread");
  if (text === "") throw inconsistent("spread", "", "present");
  const spread = parseSignedPercent(text, "spread");
  const limit = ExactDecimal.parse(MAX_SPREAD_PERCENT);
  if (spread.cmp(limit) > 0 || spread.cmp(limit.negate()) < 0) {
    throw inconsistent(
      "spread",
      spread.toTrimmedString(9, 0),
      `-${MAX_SPREAD_PERCENT}-${MAX_SPREAD_PERCENT}`,
    );
  }
  return { ...base, program: "FRN", spread };
}
