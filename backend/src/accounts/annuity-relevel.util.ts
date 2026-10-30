import { ServiceUnavailableException } from "@nestjs/common";
import { EntityManager } from "typeorm";
import { Account } from "./entities/account.entity";
import { datedLoanDebt } from "./dated-loan-debt.util";
import {
  calculatePaymentAmount,
  getPeriodicRate,
  recalculateMortgageAfterRateChange,
} from "./mortgage-amortization.util";
import {
  calendarPaymentNumber,
  scheduledPaymentDate,
} from "./mortgage-installment.util";
import { mortgageTypeOf } from "./mortgage-type.util";
import {
  DEFAULT_PERIODS_PER_YEAR,
  periodsPerYearForStoredFrequency,
  toMortgagePaymentFrequency,
} from "./payment-frequency.util";
import { formatDateYMDLocal, todayYMD } from "../common/date-utils";
import { ledgerMovementPredicate } from "../common/ledger-balance.sql";
import { tr } from "../i18n/translate";

/** Normalize a DATE column value (string at runtime, Date in tests) to YYYY-MM-DD */
function toYmd(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (typeof value === "string") return value.split("T")[0];
  return formatDateYMDLocal(value);
}

/** Whole calendar months from `fromYmd` to `toYmd` (floored at 0) */
function monthsBetweenYmd(fromYmd: string, toYmdStr: string): number {
  const [fromYear, fromMonth] = fromYmd.split("-").map(Number);
  const [toYear, toMonth] = toYmdStr.split("-").map(Number);
  return Math.max(0, (toYear - fromYear) * 12 + (toMonth - fromMonth));
}

/**
 * Whether the installment due in (`afterDate`, `throughDate`] is posted.
 *
 * A window, not an exact date: the scheduler clamps a 31st to the 30th and an
 * occurrence can be moved within its period, so its `original_due_date` need
 * not equal the calendar date. The previous calendar due date bounds it below.
 *
 * Two sources: the schedule's claimed occurrence, and the ledger itself -- a
 * non-VOID, top-level payment row (a credit to the debt) on the loan account in
 * the window, the rows `datedLoanDebt` counts. A loan with no schedule, or a
 * payment entered by hand or imported, is only visible through the ledger.
 */
async function isInstallmentPosted(
  m: EntityManager,
  account: Account,
  afterDate: string | null,
  throughDate: string,
): Promise<boolean> {
  if (account.scheduledTransactionId) {
    const claimed: unknown[] = await m.query(
      `SELECT 1 FROM scheduled_transaction_postings
        WHERE scheduled_transaction_id = $1
          AND original_due_date <= $2
          AND ($3::date IS NULL OR original_due_date > $3)
        LIMIT 1`,
      [account.scheduledTransactionId, throughDate, afterDate],
    );
    if (claimed.length > 0) return true;
  }
  const payments: unknown[] = await m.query(
    `SELECT 1 FROM transactions t
      WHERE t.account_id = $1
        AND t.user_id = $2
        AND ${ledgerMovementPredicate("t")}
        AND t.amount > 0
        AND t.transaction_date <= $3
        AND ($4::date IS NULL OR t.transaction_date > $4)
      LIMIT 1`,
    [account.id, account.userId, throughDate, afterDate],
  );
  return payments.length > 0;
}

/**
 * The annuity installment of an annuity mortgage re-levelled on `asOfDate`:
 * the payment that clears the ledger debt through that date over the
 * remaining amortization at `annualRate` (spec section 5.3, the ANNUITY row).
 * The debt is `datedLoanDebt`, never `current_balance`, which stops at today
 * (spec decision 5).
 *
 * One formula for the two places that re-level a payment: a rate change
 * recorded with `recalculatePayment` (`LoanRateChangesService`), and a type
 * change from LINEAR or INTEREST_ONLY back to an annuity type, which must
 * store a constant payment again (spec section 5.6).
 *
 * Throws 503 when the ledger cannot be read: a failed read is not a zero
 * debt.
 */
export async function datedAnnuityInstallment(
  m: EntityManager,
  account: Account,
  annualRate: number,
  asOfDate: string,
): Promise<number> {
  const debt = await datedLoanDebt(m, account, asOfDate);
  if (debt === null) {
    throw new ServiceUnavailableException(
      tr(
        "errors.accounts.loanLedgerUnreadable",
        "This loan's balance could not be read. Try again.",
      ),
    );
  }
  const mortgageType = mortgageTypeOf(account);
  const totalMonths = account.amortizationMonths || 300;
  // The debt is read through `asOfDate`, so every payment due on or before it
  // is already reflected in it: count those payments (INV-LOAN-005 calendar),
  // not calendar months, or one period too many is left to amortize. No
  // 12-month floor: 5 remaining months are not re-amortized over 12.
  const terms = { ...account, amortizationMonths: totalMonths };
  const dueNumber = calendarPaymentNumber(terms, asOfDate);
  // A rate change recorded in advance (before the payment due on `asOfDate`
  // posts) reads a debt that does not hold that payment yet: count it only
  // once its occurrence is claimed in the ledger.
  const paymentsReflected =
    dueNumber !== null &&
    dueNumber > 0 &&
    !(await isInstallmentPosted(
      m,
      account,
      scheduledPaymentDate(terms, dueNumber - 1),
      asOfDate,
    ))
      ? dueNumber - 1
      : dueNumber;
  const monthsPerPayment =
    12 /
    (periodsPerYearForStoredFrequency(account.paymentFrequency) ??
      DEFAULT_PERIODS_PER_YEAR);
  const remainingAmortizationMonths =
    paymentsReflected === null
      ? Math.max(
          1,
          totalMonths -
            monthsBetweenYmd(
              toYmd(account.paymentStartDate) ?? todayYMD(),
              asOfDate,
            ),
        )
      : Math.max(
          1,
          Math.round(totalMonths - paymentsReflected * monthsPerPayment),
        );

  // Converted, not cast. `recalculateMortgageAfterRateChange` derives its
  // periodic rate from a MORTGAGE-domain cadence, and the column can hold the
  // recurrence spelling: casting handed it SEMIMONTHLY, which its lookup read
  // as monthly, so the recalculated installment was a whole month's payment on
  // a half-monthly schedule -- persisted on the rate change and pushed into
  // the scheduled transaction. Quarterly and yearly have no mortgage cadence
  // at all, so those amortize on the standard convention instead of being
  // forced into a mortgage shape the helpers cannot express.
  const mortgageFrequency = toMortgagePaymentFrequency(
    account.paymentFrequency || "MONTHLY",
  );
  if (!mortgageFrequency) {
    const periodsPerYear =
      periodsPerYearForStoredFrequency(account.paymentFrequency) ??
      DEFAULT_PERIODS_PER_YEAR;
    // The COMPOUNDING is still the account's own, even where the cadence is
    // not one the mortgage helpers can express. Amortizing on the nominal
    // convention here would have derived the persisted installment one way
    // and the split this file computes 200 lines above it the other, for the
    // same Canadian account -- two conventions for one mortgage.
    return calculatePaymentAmount(
      debt,
      getPeriodicRate(annualRate, periodsPerYear, mortgageType),
      Math.max(
        1,
        Math.round((remainingAmortizationMonths * periodsPerYear) / 12),
      ),
    );
  }

  const result = recalculateMortgageAfterRateChange(
    debt,
    annualRate,
    remainingAmortizationMonths,
    mortgageFrequency,
    mortgageType,
  );
  return result.paymentAmount;
}
