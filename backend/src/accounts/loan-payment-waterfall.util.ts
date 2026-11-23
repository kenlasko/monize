import {
  FIAT_MONEY_DECIMALS,
  moneyUnits,
  roundMoney,
} from "../common/round.util";
import { bookSplitsAtMinorUnit } from "../common/currency-minor-unit.util";

export interface LoanPaymentWaterfallInput {
  /** Total configured installment, extra principal included. */
  paymentAmount: number;
  /** Standing extra-principal instruction (0 when there is none). */
  extraPrincipal: number;
  /** Accrued interest for the period, before any clamp. */
  interest: number;
  /** Regular amortized principal for the period, before any clamp. */
  principal: number;
  /**
   * Outstanding debt to retire, as a positive number -- or null when the
   * balance cannot bound the payment (an account whose history has not been
   * recorded yet reads 0, which means "unknown", not "paid off"). With null,
   * no balance clamp applies.
   */
  currentBalance: number | null;
  /**
   * What to do when the accrued interest exceeds the WHOLE installment, extra
   * included (default false). False caps interest at the installment and
   * reports the shortfall in `unpaidInterest`; true books the whole interest
   * and carries the shortfall as a NEGATIVE principal, so the debt grows by
   * it (negative amortization). See the policy below.
   */
  capitalizeUnpaidInterest?: boolean;
}

export interface LoanPaymentAllocation {
  /** Negative only for a capitalized shortfall (`capitalizeUnpaidInterest`). */
  principal: number;
  interest: number;
  extraPrincipal: number;
  /** Sum of the three parts -- what the installment's parent row must carry. */
  total: number;
  /**
   * The accrued interest the installment did not cover, positive, 0 when the
   * interest is covered. With `capitalizeUnpaidInterest` it equals the
   * negative principal's magnitude; without it the amount was not booked
   * anywhere (the caller's policy decides what that means).
   */
  unpaidInterest: number;
}

/**
 * The one place a loan installment is divided between interest, regular
 * principal and extra principal. `LoanPaymentSetupService` (the first
 * installment) and `ScheduledTransactionLoanService` (every recalculation
 * after a posting) both call this, because the two must agree about what any
 * given installment looks like -- the copy each held drifted twice before this
 * existed (audit P5-008, recheck DR3-01, review #1131).
 * `loan-waterfall.guard.spec.ts` fails on a new hand-rolled copy.
 *
 * Policy, decided once:
 *
 * - A payment that does not cover the accrued interest is applied
 *   interest-first across the WHOLE installment, extra principal included. A
 *   lender applies a payment to accrued interest before principal, so a
 *   designated extra-principal transfer has no principal to reduce until the
 *   interest is met. Interest itself is bounded by the whole installment so a
 *   child can never exceed its parent.
 * - An installment below the accrued interest (the interest exceeds the WHOLE
 *   installment, extra included) leaves a shortfall, reported as
 *   `unpaidInterest`. A caller that settles an outside payment keeps the cap
 *   (interest = the installment, principal 0): its shortfall policy is its
 *   own. A scheduled bill passes `capitalizeUnpaidInterest`: the whole interest
 *   is booked, the principal is the NEGATIVE of the shortfall (a transfer line
 *   FROM the loan) and the extra is 0, so the lines still sum to the
 *   installment and the loan's debt grows by the interest nobody paid, in the
 *   same posting. Nothing is a separate row a delete or an undo could orphan.
 *   Where the installment covers the interest and the base payment does not,
 *   the extra sheds first and `unpaidInterest` is 0.
 * - Never schedule more principal than the loan still owes. Regular principal
 *   is what the amortization says is owed, so it is filled first; the
 *   discretionary extra absorbs the shortfall. Interest is not clamped by the
 *   balance -- it accrued on the debt and is owed independently of how much
 *   principal is left to retire.
 * - What is left of the installment after interest is the most that can go to
 *   principal in total, so the extra is bounded by that as well as by the
 *   debt.
 * - The parts only ever shrink from the configured figures, and the total is
 *   the sum of the parts by construction, so the split validator's exact-4dp
 *   equality between parent and children cannot be reached with a mismatch.
 */
export function allocateLoanPayment(
  input: LoanPaymentWaterfallInput,
): LoanPaymentAllocation {
  const paymentAmount = roundMoney(input.paymentAmount);
  const configuredExtra = Math.max(0, roundMoney(input.extraPrincipal));
  const basePayment = roundMoney(paymentAmount - configuredExtra);
  const balance =
    input.currentBalance == null ? null : roundMoney(input.currentBalance);

  let interest = Math.max(0, roundMoney(input.interest));
  let principal = Math.max(0, roundMoney(input.principal));

  let unpaidInterest = 0;
  if (interest > basePayment) {
    if (interest > paymentAmount) {
      unpaidInterest = roundMoney(interest - paymentAmount);
      // A zero or negative installment has nothing to capitalize against:
      // there is no bill whose lines could carry the shortfall.
      if (input.capitalizeUnpaidInterest && paymentAmount > 0) {
        return {
          principal: roundMoney(paymentAmount - interest),
          interest,
          extraPrincipal: 0,
          total: paymentAmount,
          unpaidInterest,
        };
      }
    }
    interest = Math.min(interest, paymentAmount);
    principal = 0;
  }

  if (balance !== null && principal > balance) {
    principal = balance;
  }

  const availableForPrincipal = Math.max(
    0,
    roundMoney(paymentAmount - interest),
  );
  let extraPrincipal = Math.min(
    configuredExtra,
    Math.max(0, roundMoney(availableForPrincipal - principal)),
  );
  if (balance !== null && roundMoney(principal + extraPrincipal) > balance) {
    extraPrincipal = Math.max(0, roundMoney(balance - principal));
  }

  return {
    principal,
    interest,
    extraPrincipal,
    total: roundMoney(principal + interest + extraPrincipal),
    unpaidInterest,
  };
}

/**
 * The installment as the bank books it: in the currency's smallest unit
 * (`decimals`, from `currencyMinorUnitDecimals`), issue #1581.
 *
 * The waterfall prices at storage precision (docs/specs/mortgage-types.md,
 * decision 7), so a LINEAR installment is 864.5833 principal + 306.0625
 * interest = 1,170.6458; the account it is debited from moves 1,170.65. The
 * total and the interest are each rounded to the unit and principal takes
 * what the roundings leave (864.59), because interest is the period's charge
 * and principal is what retires the loan. Where principal is zero (an
 * interest-only installment carrying an extra), the extra takes it instead,
 * so no line turns negative. The parts still sum to the total exactly.
 *
 * A principal that is negative on purpose (a capitalized shortfall,
 * `capitalizeUnpaidInterest`) stays on the principal line: the rounding
 * difference is absorbed there and `unpaidInterest` is its magnitude as
 * booked.
 *
 * Booking never retires more than `debt`. A ledger posted at 4dp before
 * #1581 can owe 833.3449 on its final installment, and rounding would book
 * 833.35 and push the loan into credit; there the principal is cut down to
 * the unit at or below the debt (833.34), leaving a residue of less than one
 * unit that the next occurrence reads as paid off (a debt below 0.01). A ledger
 * booked in the unit owes a whole number of units, so its final installment
 * retires it exactly.
 */
export function bookLoanAllocation(
  allocation: LoanPaymentAllocation,
  decimals: number,
  debt: number | null = null,
): LoanPaymentAllocation {
  const lines = [
    allocation.principal,
    allocation.interest,
    allocation.extraPrincipal,
  ];
  let booked = bookSplitsAtMinorUnit(lines, allocation.total, decimals, 0);
  if (allocation.principal >= 0 && booked.amounts[0] < 0) {
    booked = bookSplitsAtMinorUnit(lines, allocation.total, decimals, 2);
  }
  const [principal, interest, extraPrincipal] = booked.amounts;
  const unpaidInterest =
    allocation.principal < 0 && principal < 0
      ? roundMoney(-principal)
      : allocation.unpaidInterest;
  if (
    debt !== null &&
    roundMoney(principal + extraPrincipal) > roundMoney(debt)
  ) {
    const retired = towardZeroInUnit(
      Math.min(allocation.principal + allocation.extraPrincipal, debt),
      decimals,
    );
    const extra = Math.min(
      towardZeroInUnit(allocation.extraPrincipal, decimals),
      retired,
    );
    const cappedPrincipal = roundMoney(retired - extra);
    return {
      principal: cappedPrincipal,
      interest,
      extraPrincipal: extra,
      total: roundMoney(cappedPrincipal + interest + extra),
      unpaidInterest,
    };
  }
  return {
    principal,
    interest,
    extraPrincipal,
    total: booked.parentAmount,
    unpaidInterest,
  };
}

/** A non-negative 4dp amount cut down to the unit (833.3449 -> 833.34 at 2). */
function towardZeroInUnit(value: number, decimals: number): number {
  const step = 10 ** Math.max(0, FIAT_MONEY_DECIMALS - decimals);
  const units = moneyUnits(Math.max(0, value), FIAT_MONEY_DECIMALS);
  return roundMoney(
    (Math.floor(units / step) * step) / 10 ** FIAT_MONEY_DECIMALS,
  );
}
