import { addDaysYMD } from "../common/date-utils";
import { roundMoney } from "../common/round.util";
import {
  occurrenceSlotsInRange,
  precedingSlotDate,
  SlotCalendarSchedule,
} from "./occurrence-slots";
import {
  datedAnnuityPayment,
  paymentNewlyApplies,
  RateTimelineRow,
} from "./price-installment";

/** A later due date from which the bill becomes a different stated payment. */
export interface UpcomingPaymentChange {
  /** A slot after the priced installment at which a stated payment newly applies. */
  readonly dueDate: string;
  /** `total(dueDate, E)`: the stated payment plus the standing extra it is priced with. */
  readonly paymentAmount: number;
}

/**
 * Longer than any cadence the recurrence engine steps (a yearly slot plus a
 * leap day): the first slot on or after a date, when the calendar has one,
 * falls inside it.
 */
const ONE_CADENCE_DAYS = 400;

/** A `manual` or `inferred` row dated after `dueDate` that states a payment. */
function statesLaterPayment(row: RateTimelineRow, dueDate: string): boolean {
  if (row.effectiveDate <= dueDate || row.source === "initial") return false;
  const amount = Number(row.newPaymentAmount);
  return row.newPaymentAmount != null && Number.isFinite(amount) && amount > 0;
}

/**
 * Every due date after `dueDate` at which a stated annuity payment newly
 * applies (spec 7.3), in date order, each with the total priced there --
 * what the rate-change sync's preview says the bill becomes, and from when
 * (`docs/specs/scheduled-loan-installment-pricing.md` section 7.5). Empty
 * when no `manual` or `inferred` row stating a payment is dated after
 * `dueDate`, or when the schedule's calendar ends before the first such row.
 *
 * The search is bounded by construction: only a row dated after `dueDate`
 * can make a later slot newly apply, and each such row maps to the first
 * slot on or after its date, at which `newly` holds because every earlier
 * slot is dated before the row. Rows that map to the same slot report it
 * once: the payment priced there is the dated payment AT that slot
 * (`datedAnnuityPayment`), the latest of them. `newly` is checked rather than
 * assumed so the function and the advancement cannot disagree about a slot.
 *
 * `extraPrincipalAmount` is the standing extra the sync prices the template
 * with (`priceInstallment`'s `extraPrincipalAmount`), added on top of a row
 * that states the base (7.1, `statesBase`).
 */
export function upcomingPaymentChangesAfter(
  timeline: readonly RateTimelineRow[],
  schedule: SlotCalendarSchedule,
  dueDate: string,
  extraPrincipalAmount: number,
  configuredPayment: number | string | null | undefined,
): UpcomingPaymentChange[] {
  const rowDates = [
    ...new Set(
      timeline
        .filter((row) => statesLaterPayment(row, dueDate))
        .map((row) => row.effectiveDate),
    ),
  ].sort();

  const changes: UpcomingPaymentChange[] = [];
  for (const rowDate of rowDates) {
    // A row dated on or before the slot already reported maps to that slot,
    // whose payment was priced with every row up to it.
    const last = changes[changes.length - 1];
    if (last && rowDate <= last.dueDate) continue;

    const slots = occurrenceSlotsInRange(schedule, {
      from: rowDate,
      to: addDaysYMD(rowDate, ONE_CADENCE_DAYS),
    });
    const slot = slots.find((candidate) => candidate.date > dueDate);
    // The calendar ends before this row, so before every later row too.
    if (!slot) break;

    const payment = datedAnnuityPayment(timeline, slot.date, configuredPayment);
    if (
      payment === null ||
      !paymentNewlyApplies(payment, precedingSlotDate(schedule, slot.date))
    ) {
      continue;
    }
    changes.push({
      dueDate: slot.date,
      paymentAmount: payment.statesBase
        ? roundMoney(payment.amount + extraPrincipalAmount)
        : payment.amount,
    });
  }
  return changes;
}
