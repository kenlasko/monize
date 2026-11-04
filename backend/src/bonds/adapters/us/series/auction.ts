import { SeriesFetchError } from "../../../bond-adapter";
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
} from "../../../domain/period-schedule";
import {
  AuctionRecord,
  formatChanged,
  optionalText,
  parseDate,
  parsePercent,
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

/** Why a product is not read in this phase (`PRODUCT_NOT_SUPPORTED`). */
export type UnsupportedProduct = "TIPS" | "FRN";

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

export interface CouponAuction {
  readonly program: "NOTE" | "BOND";
  readonly cusip: string;
  readonly auctionDate: string;
  readonly issueDate: string;
  readonly datedDate: string;
  readonly firstCouponDate: string;
  readonly maturityDate: string;
  /** The coupon in percent, exact. */
  readonly interestRate: ExactDecimal;
  readonly highPrice: string;
  readonly xmlFileName: string;
}

export type Auction = BillAuction | CouponAuction;

export function inconsistent(
  field: string,
  value: string,
  expected: string,
): SeriesFetchError {
  return new SeriesFetchError("SOURCE_INCONSISTENT", {
    field,
    value,
    expected,
  });
}

/**
 * The program of an auction from its security type and its two flags, or the
 * product this phase does not read. `securityType` is compared as upper case:
 * the JSON says "Note", the results file "NOTE".
 */
export function programOfRecord(
  record: AuctionRecord,
): UsProgram | UnsupportedProduct {
  const type = requiredText(record, "securityType").toUpperCase();
  const inflation = requiredFlag(record, "inflationIndexSecurity");
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
  const auctionDate = requiredDate(record, "auctionDate");
  const issueDate = requiredDate(record, "issueDate");
  const maturityDate = requiredDate(record, "maturityDate");
  const discountRate = parsePercent(
    requiredText(record, "highDiscountRate"),
    "highDiscountRate",
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
  if (discountRate.isZero() || price.cmp(ExactDecimal.fromInt(100)) >= 0) {
    throw inconsistent("highPrice", highPrice, "<100");
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
    xmlFileName: optionalText(record, "xmlFilenameCompetitiveResults"),
  };
}

export function readCoupon(
  record: AuctionRecord,
  cusip: string,
  program: "NOTE" | "BOND",
): CouponAuction {
  const auctionDate = requiredDate(record, "auctionDate");
  const issueDate = requiredDate(record, "issueDate");
  const maturityDate = requiredDate(record, "maturityDate");
  const datedDate = requiredDate(record, "datedDate");
  const firstCouponDate = parseDate(
    requiredText(record, "firstInterestPaymentDate"),
    "firstInterestPaymentDate",
  );
  const interestRate = parsePercent(
    requiredText(record, "interestRate"),
    "interestRate",
  );
  const frequency = requiredText(record, "interestPaymentFrequency");
  if (!SEMIANNUAL.test(frequency)) {
    throw inconsistent("interestPaymentFrequency", "other", "semiannual");
  }
  if (interestRate.cmp(ExactDecimal.parse(MAX_COUPON_PERCENT)) > 0) {
    throw inconsistent(
      "interestRate",
      interestRate.toTrimmedString(9, 0),
      `<=${MAX_COUPON_PERCENT}`,
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
  try {
    buildCouponSchedule({
      datedDate,
      firstCouponDate,
      maturityDate,
      couponMonths: 6,
      endOfMonth: isMonthEnd(maturityDate),
    });
  } catch (error) {
    if (error instanceof CouponScheduleError) {
      throw inconsistent(
        "firstInterestPaymentDate",
        firstCouponDate,
        "regular",
      );
    }
    throw error;
  }
  return {
    program,
    cusip,
    auctionDate,
    issueDate,
    datedDate,
    firstCouponDate,
    maturityDate,
    interestRate,
    highPrice: optionalPrice(record),
    xmlFileName: optionalText(record, "xmlFilenameCompetitiveResults"),
  };
}
