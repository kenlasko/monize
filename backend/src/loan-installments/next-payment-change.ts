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
export interface NextPaymentChange {
  /** The first slot after the priced installment at which a stated payment newly applies. */
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

/**
 * The first due date after `dueDate` at which a stated annuity payment newly
 * applies (spec 7.3), and the total priced there -- what the rate-change
 * sync's preview says the bill becomes, and from when
 * (`docs/specs/scheduled-loan-installment-pricing.md` section 7.5). Null when
 * no `manual` or `inferred` row stating a payment is dated after `dueDate`,
 * or when the schedule's calendar ends before the first such row.
 *
 * The search is bounded by construction: only a row dated after `dueDate`
 * can make a later slot newly apply, and the earliest such row maps to the
 * first slot on or after its date, at which `newly` holds because every
 * earlier slot is dated before the row. The payment priced there is the
 * dated payment AT that slot (`datedAnnuityPayment`), which a second row
 * dated between the first row and the slot may state instead; `newly` is
 * checked rather than assumed so the function and the advancement cannot
 * disagree about the slot.
 *
 * `extraPrincipalAmount` is the standing extra the sync prices the template
 * with (`priceInstallment`'s `extraPrincipalAmount`), added on top of a row
 * that states the base (7.1, `statesBase`).
 */
export function nextPaymentChangeAfter(
  timeline: readonly RateTimelineRow[],
  schedule: SlotCalendarSchedule,
  dueDate: string,
  extraPrincipalAmount: number,
  configuredPayment: number | string | null | undefined,
): NextPaymentChange | null {
  let earliest: string | null = null;
  for (const row of timeline) {
    if (row.effectiveDate <= dueDate || row.source === "initial") continue;
    const amount = Number(row.newPaymentAmount);
    if (
      row.newPaymentAmount == null ||
      !Number.isFinite(amount) ||
      amount <= 0
    ) {
      continue;
    }
    if (earliest === null || row.effectiveDate < earliest) {
      earliest = row.effectiveDate;
    }
  }
  if (earliest === null) return null;

  const slots = occurrenceSlotsInRange(schedule, {
    from: earliest,
    to: addDaysYMD(earliest, ONE_CADENCE_DAYS),
  });
  const slot = slots.find((candidate) => candidate.date > dueDate);
  if (!slot) return null;

  const payment = datedAnnuityPayment(timeline, slot.date, configuredPayment);
  if (
    payment === null ||
    !paymentNewlyApplies(payment, precedingSlotDate(schedule, slot.date))
  ) {
    return null;
  }
  return {
    dueDate: slot.date,
    paymentAmount: payment.statesBase
      ? roundMoney(payment.amount + extraPrincipalAmount)
      : payment.amount,
  };
}
