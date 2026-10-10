import { Account, AccountType } from "../accounts/entities/account.entity";
import { ScheduledTransaction } from "../scheduled-transactions/entities/scheduled-transaction.entity";
import { ScheduledTransactionSplit } from "../scheduled-transactions/entities/scheduled-transaction-split.entity";
import {
  OverrideSplit,
  ScheduledTransactionOverride,
} from "../scheduled-transactions/entities/scheduled-transaction-override.entity";
import { ExpandedOccurrence } from "../common/scheduled-occurrences";
import { currencyMinorUnitDecimals } from "../common/currency-minor-unit.util";
import { MONEY_DECIMALS, roundMoney } from "../common/round.util";
import { bookLoanAllocation } from "../accounts/loan-payment-waterfall.util";
import {
  amortizationMethodFor,
  mortgageTypeOf,
} from "../accounts/mortgage-type.util";
import { missingMethodTerms } from "../accounts/mortgage-installment.util";
import { periodsPerYearForStoredFrequency } from "../accounts/payment-frequency.util";
import {
  annualRateOn,
  datedAnnuityPayment,
  declineReason,
  identifyLoanTemplate,
  LoanTemplateSplits,
  paymentNewlyApplies,
  priceInstallment,
  RateTimelineRow,
} from "./price-installment";
import { precedingSlotDate, SlotCalendarSchedule } from "./occurrence-slots";

/**
 * The projection of a loan bill's next occurrences, each priced at its own
 * due date (`docs/specs/scheduled-loan-installment-pricing.md` section 8,
 * decision 4 of issue #1637). Pure: the occurrences come in from
 * `expandOccurrenceSlots` (their identity is not decided here), the ledger
 * debt at every date comes in from `datedLoanDebts`, and the timeline rows
 * from one read; the fold prices each occurrence through `priceInstallment`
 * and books it as the posting books it, so what it shows for an occurrence
 * is what posting that occurrence would move.
 *
 * Two chains run side by side (section 8.2). The TEMPLATE chain is what
 * `rewriteLoanTemplate` would write after each posting: the stored amount
 * for the cursor, then the advancement (purpose `template`, spec 7.3) at
 * each later slot. The BILL of an occurrence is its override's amount when
 * it states one, else the chain's figure; the override never enters the
 * chain, because the advancement reads the stored template an override does
 * not write (8.3). The lines of each bill are the posting's re-division at
 * the date the occurrence falls on, on the debt the fold has reached.
 */

/** One projected occurrence (spec 8.1). Unsigned money, booked in the minor unit. */
export interface LoanOccurrence {
  /** The recurrence slot: the occurrence's identity. */
  originalDate: string;
  /** The date it falls on: an override's date when one moved it. */
  dueDate: string;
  overrideId: string | null;
  amount: number | null;
  principal: number | null;
  interest: number | null;
  extraPrincipal: number | null;
  /** The rate at `dueDate` (spec section 1); known independently of the fold. */
  annualRate: number | null;
  /** The folded debt at `dueDate` (spec 8.2). */
  debtBefore: number | null;
  /** True when every figure above is known. */
  complete: boolean;
}

/** The columns of an override the fold reads; the rest decide nothing here. */
export type LoanOccurrenceOverride = Pick<
  ScheduledTransactionOverride,
  "id" | "originalDate" | "overrideDate" | "amount" | "splits"
>;

export interface ProjectLoanOccurrencesInput {
  readonly schedule: Pick<
    ScheduledTransaction,
    | "amount"
    | "frequency"
    | "startDate"
    | "nextDueDate"
    | "endDate"
    | "occurrencesRemaining"
    | "currencyCode"
  >;
  /** The stored template lines. */
  readonly splits: ScheduledTransactionSplit[];
  readonly loanAccount: Account;
  /** The loan's rate timeline, ascending by effective date. */
  readonly rateChanges: readonly RateTimelineRow[];
  /** The occurrences to price, as `expandOccurrenceSlots` ordered them (by `dueDate`). */
  readonly occurrences: readonly ExpandedOccurrence<LoanOccurrenceOverride>[];
  /** `datedLoanDebt` at every `originalDate` and `dueDate` among `occurrences`. */
  readonly debtLedger: ReadonlyMap<string, number>;
}

export type LoanOccurrenceProjection =
  /** The template is a loan's but not a shape this core prices (8.1); `occurrences` is empty. */
  | {
      readonly status: "declined";
      readonly reason: string;
      readonly occurrences: LoanOccurrence[];
    }
  | { readonly status: "priced"; readonly occurrences: LoanOccurrence[] };

const SCALE = 10 ** MONEY_DECIMALS;
const toUnits = (value: number): number => Math.round(value * SCALE);
const fromUnits = (units: number): number => units / SCALE;

/** An occurrence nothing can be said about beyond its identity and its dated rate. */
function unknownOccurrence(
  occurrence: ExpandedOccurrence<LoanOccurrenceOverride>,
  annualRate: number | null,
  debtBefore: number | null,
  amount: number | null = null,
): LoanOccurrence {
  return {
    originalDate: occurrence.originalDate,
    dueDate: occurrence.dueDate,
    overrideId: occurrence.override?.id ?? null,
    amount,
    principal: null,
    interest: null,
    extraPrincipal: null,
    annualRate,
    debtBefore,
    complete: false,
  };
}

/**
 * An override's lines as `identifyLoanTemplate` reads a template's: the two
 * share the columns the identification keys on (the transfer account, the
 * category, the memo).
 */
function overrideLinesAsSplits(
  lines: readonly OverrideSplit[],
): ScheduledTransactionSplit[] {
  return lines.map(
    (line) =>
      ({
        transferAccountId: line.transferAccountId ?? null,
        categoryId: line.categoryId ?? null,
        amount: line.amount,
        memo: line.memo ?? null,
      }) as unknown as ScheduledTransactionSplit,
  );
}

/**
 * Why the pure tail did not price. It answers `paid-off` only from the core's
 * own debt check, never over the facts handed to it here, so that branch is a
 * defect named rather than a figure guessed.
 */
function notPricedReason(
  result: Exclude<ReturnType<typeof priceInstallment>, { kind: "ok" }>,
): string {
  return result.kind === "paid-off"
    ? "the installment priced as paid off on a positive debt"
    : result.reason;
}

/** The unsigned amount of a line, 0 for a line the template does not carry. */
function lineAmount(split: ScheduledTransactionSplit | undefined): number {
  return split ? roundMoney(Math.abs(Number(split.amount))) : 0;
}

export function projectLoanOccurrences(
  input: ProjectLoanOccurrencesInput,
): LoanOccurrenceProjection {
  const { schedule, loanAccount, rateChanges, occurrences, debtLedger } = input;

  const identified = identifyLoanTemplate(input.splits, loanAccount);
  if (!identified.managed) {
    return {
      status: "declined",
      reason: declineReason(identified, loanAccount),
      occurrences: [],
    };
  }
  // A LINEAR or INTEREST_ONLY mortgage without its terms declines before any
  // date is priced, as `priceInstallment` would at the first one.
  const mortgageType =
    loanAccount.accountType === AccountType.MORTGAGE
      ? mortgageTypeOf(loanAccount)
      : null;
  if (mortgageType && amortizationMethodFor(mortgageType) !== "ANNUITY") {
    const missing = missingMethodTerms(mortgageType, loanAccount);
    if (missing.length > 0) {
      return {
        status: "declined",
        reason: `the ${mortgageType} mortgage ${loanAccount.id} has no ${missing.join(", ")}`,
        occurrences: [],
      };
    }
  }
  const isAnnuity =
    mortgageType === null || amortizationMethodFor(mortgageType) === "ANNUITY";

  const frequency = loanAccount.paymentFrequency || schedule.frequency;
  // The posting path defaults an unknown cadence to monthly; a projected
  // figure from that default would be a guess (8.4), so the cadence is
  // checked once and every occurrence is reported as unknown.
  const cadenceKnown = periodsPerYearForStoredFrequency(frequency) !== null;
  const decimals = currencyMinorUnitDecimals(
    schedule.currencyCode ?? loanAccount.currencyCode,
  );
  const calendar: SlotCalendarSchedule = {
    startDate: schedule.startDate,
    nextDueDate: schedule.nextDueDate,
    frequency: schedule.frequency,
    endDate: schedule.endDate ?? null,
    occurrencesRemaining: schedule.occurrencesRemaining ?? null,
  };

  // The template chain: its parent amount, and its extra line as the
  // advancement rewrites it (`rewriteLoanTemplate` writes the extra line
  // when the installment's extra differs from what the template holds).
  let chainAmount = Math.abs(Number(schedule.amount));
  let chainExtra = lineAmount(identified.extraPrincipalSplit);
  const templateOf = (extra: number): LoanTemplateSplits => ({
    principalSplit: identified.principalSplit,
    interestSplit: identified.interestSplit,
    extraPrincipalSplit: identified.extraPrincipalSplit
      ? ({
          ...identified.extraPrincipalSplit,
          amount: -extra,
        } as ScheduledTransactionSplit)
      : undefined,
  });

  // The fold: what the projection has booked so far, dated, so the debt at
  // a date subtracts only what falls on or before it (8.2).
  const booked: Array<{ dueDate: string; units: number }> = [];
  const debtAt = (date: string): number | undefined => {
    const ledger = debtLedger.get(date);
    if (ledger === undefined) return undefined;
    const folded = booked
      .filter((b) => b.dueDate <= date)
      .reduce((sum, b) => sum + b.units, 0);
    return roundMoney(fromUnits(toUnits(ledger) - folded));
  };

  const rows: LoanOccurrence[] = [];
  // Once a figure is unknown the debt after it is too, and so is every
  // later occurrence (8.4): identity and the dated rate are all that remain.
  let unknown = !cadenceKnown;

  for (const [index, occurrence] of occurrences.entries()) {
    const { originalDate, dueDate } = occurrence;
    const rateAtDue = annualRateOn(rateChanges, loanAccount, dueDate);
    if (unknown) {
      rows.push(unknownOccurrence(occurrence, rateAtDue, null));
      continue;
    }
    const debtDue = debtAt(dueDate);
    if (debtDue === undefined) {
      // The caller reads the ledger at every date it hands over; a date it
      // missed is a defect in the caller, not a figure to guess.
      throw new RangeError(
        `projectLoanOccurrences: no ledger debt was supplied for ${dueDate}`,
      );
    }

    // The payoff `post()` writes no money for (section 3): listed at zero,
    // and the projection ends, as the recalculation deactivates the schedule.
    if (debtDue <= 0.01) {
      rows.push({
        originalDate,
        dueDate,
        overrideId: occurrence.override?.id ?? null,
        amount: 0,
        principal: 0,
        interest: 0,
        extraPrincipal: 0,
        annualRate: rateAtDue,
        debtBefore: debtDue,
        complete: true,
      });
      break;
    }

    // The template chain advances at the slot (purpose `template`, 7.3) from
    // the second occurrence on; the cursor's bill is the template as stored.
    if (index > 0) {
      const rateAtSlot = annualRateOn(rateChanges, loanAccount, originalDate);
      const debtSlot = debtAt(originalDate);
      if (rateAtSlot === null || debtSlot === undefined) {
        unknown = true;
        rows.push(unknownOccurrence(occurrence, rateAtDue, debtDue));
        continue;
      }
      const datedPayment = isAnnuity
        ? datedAnnuityPayment(
            rateChanges,
            originalDate,
            loanAccount.paymentAmount,
          )
        : null;
      const advanced = priceInstallment({
        debt: debtSlot,
        annualRate: rateAtSlot,
        loanAccount,
        template: templateOf(chainExtra),
        templateAmount: chainAmount,
        datedPayment,
        paymentNewlyApplies: paymentNewlyApplies(
          datedPayment,
          precedingSlotDate(calendar, originalDate),
        ),
        frequency,
        asOfDate: originalDate,
        purpose: "template",
      });
      if (advanced.kind !== "ok") {
        return {
          status: "declined",
          reason: notPricedReason(advanced),
          occurrences: [],
        };
      }
      chainAmount = advanced.allocation.total;
      chainExtra = advanced.allocation.extraPrincipal;
    }

    if (rateAtDue === null) {
      unknown = true;
      rows.push(unknownOccurrence(occurrence, rateAtDue, debtDue));
      continue;
    }

    const override = occurrence.override;
    const statedAmount =
      override?.amount != null && Number.isFinite(Number(override.amount))
        ? roundMoney(Math.abs(Number(override.amount)))
        : null;
    const bill = statedAmount ?? chainAmount;

    // An override with an amount and its own lines: the lines stand as
    // given (8.3), and the fold takes their principal and extra.
    if (
      statedAmount !== null &&
      override?.splits &&
      override.splits.length > 0
    ) {
      const lines = identifyLoanTemplate(
        overrideLinesAsSplits(override.splits),
        loanAccount,
      );
      if (!lines.managed) {
        unknown = true;
        rows.push(unknownOccurrence(occurrence, rateAtDue, debtDue, bill));
        continue;
      }
      const principal = lineAmount(lines.principalSplit);
      const interest = lineAmount(lines.interestSplit);
      const extraPrincipal = lineAmount(lines.extraPrincipalSplit);
      booked.push({
        dueDate,
        units: toUnits(principal) + toUnits(extraPrincipal),
      });
      rows.push({
        originalDate,
        dueDate,
        overrideId: override.id,
        amount: bill,
        principal,
        interest,
        extraPrincipal,
        annualRate: rateAtDue,
        debtBefore: debtDue,
        complete: true,
      });
      continue;
    }

    // The lines: the posting's re-division of the bill at the date it falls
    // on, booked as the posting books it (`bookLoanAllocation`).
    const priced = priceInstallment({
      debt: debtDue,
      annualRate: rateAtDue,
      loanAccount,
      template: templateOf(chainExtra),
      templateAmount: bill,
      datedPayment: null,
      paymentNewlyApplies: false,
      frequency,
      asOfDate: dueDate,
      purpose: "posting",
    });
    if (priced.kind !== "ok") {
      return {
        status: "declined",
        reason: notPricedReason(priced),
        occurrences: [],
      };
    }
    const allocation = bookLoanAllocation(priced.allocation, decimals, debtDue);
    booked.push({
      dueDate,
      units: toUnits(allocation.principal) + toUnits(allocation.extraPrincipal),
    });
    rows.push({
      originalDate,
      dueDate,
      overrideId: override?.id ?? null,
      amount: allocation.total,
      principal: allocation.principal,
      interest: allocation.interest,
      extraPrincipal: allocation.extraPrincipal,
      annualRate: rateAtDue,
      debtBefore: debtDue,
      complete: true,
    });
  }

  return { status: "priced", occurrences: rows };
}
