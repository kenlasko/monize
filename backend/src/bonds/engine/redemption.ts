import { assertNever } from "../domain/assert-never";
import {
  BusinessDayCalendar,
  nthBusinessDayBefore,
} from "../domain/business-day-calendar";
import { BondTerms, benchmarkFieldsOf } from "../domain/bond-terms";
import { addDays, compareYMD } from "../domain/calendar-date";
import { ExactDecimal } from "../domain/exact-decimal";
import { SchedulePeriod } from "../domain/period-schedule";
import { principalAt } from "./accrual";
import { roundLot } from "./rounding";
import { EarlyRedemptionRefusal } from "./bond-engine-types";

/** Why a request on `asOf` is refused by the window rules, or null when it is allowed. */
export function windowRefusal(
  terms: BondTerms,
  calendars: ReadonlyMap<string, BusinessDayCalendar>,
  purchaseDate: string,
  asOf: string,
  period: SchedulePeriod | null,
  maturity: string,
): EarlyRedemptionRefusal | null {
  if (period === null || compareYMD(asOf, maturity) >= 0) return "MATURED";
  const redemption = terms.redemption;
  switch (redemption.type) {
    case "MATURITY_ONLY":
      return "NOT_REDEEMABLE";
    case "ON_DEMAND": {
      // A period of N days that must fully elapse, the sale day not counted
      // (Civil Code art. 111 par. 2): it ends with purchaseDate + N, so the
      // first request is on purchaseDate + N + 1.
      if (
        compareYMD(
          asOf,
          addDays(purchaseDate, redemption.earliestDaysAfterPurchase + 1),
        ) < 0
      ) {
        return "TOO_EARLY";
      }
      if (
        compareYMD(
          asOf,
          addDays(maturity, -redemption.latestDaysBeforeMaturity),
        ) > 0
      ) {
        return "TOO_LATE";
      }
      for (const blackout of redemption.blackouts) {
        switch (blackout.type) {
          case "RECORD_DAY_BEFORE_COUPON": {
            const calendar = calendars.get(blackout.calendarId);
            if (!calendar) return "TERMS_INCOMPLETE";
            if (
              asOf ===
              nthBusinessDayBefore(calendar, period.end, blackout.businessDays)
            ) {
              return "RECORD_DAY";
            }
            break;
          }
          default:
            return assertNever(blackout.type);
        }
      }
      return null;
    }
    default:
      return assertNever(redemption);
  }
}

/**
 * The lot's proceeds of an early redemption: value less penalties, rounded as
 * the terms' basis says, then the floor. `periodBase` is what a unit is worth at
 * the start of the period, so the interest accrued since then is
 * `valueBeforePenalty - periodBase`; the penalties are per unit.
 */
export function proceedsLot(
  terms: BondTerms,
  valueBeforePenalty: ExactDecimal,
  periodBase: ExactDecimal,
  periodIndex: number,
  asOf: string,
  quantity: ExactDecimal,
): ExactDecimal {
  const redemption = terms.redemption;
  if (redemption.type !== "ON_DEMAND")
    return roundLot(terms, valueBeforePenalty, quantity);
  const penalty = redemption.penalties.reduce((sum, p) => {
    switch (p.type) {
      case "FIXED_FEE_PER_UNIT":
        return sum.add(ExactDecimal.parse(p.amount));
      case "FORFEIT_ACCRUED_SINCE_LAST_PAYMENT":
        return sum.add(valueBeforePenalty.sub(periodBase));
      default:
        return assertNever(p);
    }
  }, ExactDecimal.ZERO);
  const net = roundLot(terms, valueBeforePenalty.sub(penalty), quantity);
  const floor = redemption.proceedsFloor;
  if (floor === null) return net;
  switch (floor.type) {
    case "FACE_VALUE":
      return floor.appliesTo === "ALL_PERIODS" || periodIndex === 1
        ? ExactDecimal.max(
            net,
            principalAt(terms, { date: asOf }).mul(quantity),
          )
        : net;
    default:
      return assertNever(floor.type);
  }
}

/** Every calendar id the terms refer to. */
export function referencedCalendarIds(terms: BondTerms): ReadonlySet<string> {
  const ids = new Set<string>([terms.schedule.calendarId]);
  const observation = benchmarkFieldsOf(terms.rateRule)?.observation;
  if (
    observation?.type === "STEP_VALUE_ON_NTH_BUSINESS_DAY_BEFORE_START_MONTH"
  ) {
    ids.add(observation.calendarId);
  }
  if (terms.rateRule.type === "DAILY_INDEX_PLUS_SPREAD") {
    ids.add(terms.rateRule.calendarId);
  }
  if (terms.redemption.type === "ON_DEMAND") {
    terms.redemption.blackouts.forEach((b) => ids.add(b.calendarId));
  }
  return ids;
}
