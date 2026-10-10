import { Account, AccountType } from "../accounts/entities/account.entity";
import { ScheduledTransaction } from "../scheduled-transactions/entities/scheduled-transaction.entity";
import { ScheduledTransactionSplit } from "../scheduled-transactions/entities/scheduled-transaction-split.entity";
import {
  OverrideSplit,
  ScheduledTransactionOverride,
} from "../scheduled-transactions/entities/scheduled-transaction-override.entity";
import {
  ExpandedOccurrence,
  expandOccurrenceSlots,
  OccurrenceOverrideInput,
  OccurrenceScheduleInput,
} from "../common/scheduled-occurrences";
import { ensureYMD } from "../common/recurrence";
import { currencyMinorUnitDecimals } from "../common/currency-minor-unit.util";
import { MONEY_DECIMALS, roundMoney } from "../common/round.util";
import { bookLoanAllocation } from "../accounts/loan-payment-waterfall.util";
import { periodsPerYearForStoredFrequency } from "../accounts/payment-frequency.util";
import {
  annualRateOn,
  datedAnnuityPayment,
  declineReason,
  identifyLoanTemplate,
  isAnnuity,
  LoanTemplateSplits,
  methodTermsDecline,
  paymentNewlyApplies,
  priceInstallment,
  RateTimelineRow,
} from "./price-installment";

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
 * The fold walks the occurrences in SLOT order, the order `post()` claims
 * them in (it posts only the cursor) and `rewriteLoanTemplate` advances the
 * template in, whatever date an override moves one to; the rows are answered
 * in the expander's `dueDate` order. Two chains run side by side (section
 * 8.2). The TEMPLATE chain is what `rewriteLoanTemplate` would write after
 * each posting: the stored amount for the cursor, then the advancement
 * (purpose `template`, spec 7.3) at each later slot. The BILL of an
 * occurrence is its override's amount when it states one, else the chain's
 * figure; the override never enters the chain, because the advancement reads
 * the stored template an override does not write (8.3). The lines of each
 * bill are the posting's re-division at the date the occurrence falls on, on
 * the debt the earlier slots leave.
 */

/**
 * What an incomplete occurrence lacks, and so where the reader repairs it
 * (spec 8.4; AGENTS.md, "withholding a figure is only honest if the reader
 * learns why"). Structured, so the client names it in the reader's language.
 */
export type LoanOccurrenceMissing =
  /** No rate is recorded at `date` (the slot or the due date): the loan's rate history. */
  | { readonly kind: "rate"; readonly date: string }
  /** The cadence the loan is priced at is not one the pricing knows: the loan's payment frequency. */
  | { readonly kind: "cadence"; readonly frequency: string }
  /** The override's lines are not the loan's principal, interest and extra: the override. */
  | { readonly kind: "override-lines"; readonly overrideId: string }
  /**
   * The override states an amount, and no lines, for a date by which the debt
   * is settled: the posting moves the amount, but no division of it into the
   * loan's lines is priced on a settled debt. The override.
   */
  | { readonly kind: "override-on-settled-debt"; readonly overrideId: string }
  /** An earlier slot's figures are unknown, so the debt this one starts from is: that occurrence's own `missing`. */
  | { readonly kind: "earlier-occurrence"; readonly originalDate: string };

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
  /** Why a figure above is null; null exactly when `complete`. */
  missing: LoanOccurrenceMissing | null;
}

/** The columns of an override the fold reads; the rest decide nothing here. */
export type LoanOccurrenceOverride = Pick<
  ScheduledTransactionOverride,
  "id" | "originalDate" | "overrideDate" | "amount" | "splits"
>;

export interface ProjectLoanOccurrencesInput {
  readonly schedule: Pick<
    ScheduledTransaction,
    "amount" | "frequency" | "currencyCode"
  >;
  /** The stored template lines. */
  readonly splits: ScheduledTransactionSplit[];
  readonly loanAccount: Account;
  /** The loan's rate timeline, ascending by effective date. */
  readonly rateChanges: readonly RateTimelineRow[];
  /**
   * Every occurrence from the cursor through the last slot to report, as
   * `expandOccurrenceSlots` ordered them (by `dueDate`). Every slot in that
   * span is here, including one an override moved past the reported rows:
   * the template advances at each slot in turn, so a slot left out would
   * break the chain.
   */
  readonly occurrences: readonly ExpandedOccurrence<LoanOccurrenceOverride>[];
  /** How many rows to answer: the first `count` by `dueDate`. */
  readonly count: number;
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

/** An occurrence nothing can be said about beyond its identity, its dated rate and why. */
function unknownOccurrence(
  occurrence: ExpandedOccurrence<LoanOccurrenceOverride>,
  annualRate: number | null,
  debtBefore: number | null,
  missing: LoanOccurrenceMissing,
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
    missing,
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

/** The unsigned amount of a line, 0 for a line the template does not carry. */
function lineAmount(split: ScheduledTransactionSplit | undefined): number {
  return split ? roundMoney(Math.abs(Number(split.amount))) : 0;
}

/**
 * The occurrences the fold takes (`ProjectLoanOccurrencesInput.occurrences`):
 * the first `count` by the date each falls on, walked no further than
 * `horizon`, and every slot between the cursor and the last of them. The
 * template advances at each slot in turn, so a slot an override moved past
 * the `count`-th date still carries the chain to the slots after it; the fold
 * reports only the first `count`. Both reads are the one expander's
 * (INV-OCCURRENCE-003): the second walks through the latest date any of
 * those slots falls on.
 */
export function loanProjectionOccurrences<O extends OccurrenceOverrideInput>(
  schedule: OccurrenceScheduleInput,
  overrides: readonly O[],
  count: number,
  horizon: string,
): ExpandedOccurrence<O>[] {
  const reported = expandOccurrenceSlots(schedule, overrides, {
    through: horizon,
    maxOccurrences: count,
  });
  if (reported.length === 0) return reported;
  const lastSlot = reported.reduce(
    (last, o) => (o.originalDate > last ? o.originalDate : last),
    reported[0].originalDate,
  );
  let through = lastSlot;
  for (const override of overrides) {
    const slot = ensureYMD(override.originalDate as string);
    const due = ensureYMD(override.overrideDate as string);
    if (slot <= lastSlot && due > through) through = due;
  }
  return expandOccurrenceSlots(schedule, overrides, { through }).filter(
    (o) => o.originalDate <= lastSlot,
  );
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
  // date is priced, as `priceInstallment` would at the first one: the shape
  // decides it, not a date, so a projection that ends before pricing anything
  // still answers the same status.
  const missingTerms = methodTermsDecline(loanAccount);
  if (missingTerms !== null) {
    return { status: "declined", reason: missingTerms, occurrences: [] };
  }
  const annuity = isAnnuity(loanAccount);
  // `rewriteLoanTemplate` keeps a line of credit's schedule active at a
  // settled debt (it can be drawn on again) and deactivates every other.
  const revolving = loanAccount.accountType === AccountType.LINE_OF_CREDIT;

  const frequency = loanAccount.paymentFrequency || schedule.frequency;
  // The posting books in the schedule's currency, which is the paying
  // account's: the service declines a foreign-currency schedule, which the
  // posting does not re-price.
  const decimals = currencyMinorUnitDecimals(
    schedule.currencyCode ?? loanAccount.currencyCode,
  );

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

  // The fold: what the earlier slots book, dated, so the debt at a date
  // subtracts only what falls on or before it (8.2). A later slot is not in
  // it yet when an earlier one is priced, whatever its date: it posts after.
  const booked: Array<{ dueDate: string; units: number }> = [];
  const debtAt = (date: string): number => {
    const ledger = debtLedger.get(date);
    if (ledger === undefined) {
      // The caller reads the ledger at every date it hands over; a date it
      // missed is a defect in the caller, not a figure to guess.
      throw new RangeError(
        `projectLoanOccurrences: no ledger debt was supplied for ${date}`,
      );
    }
    const folded = booked
      .filter((b) => b.dueDate <= date)
      .reduce((sum, b) => sum + b.units, 0);
    return roundMoney(fromUnits(toUnits(ledger) - folded));
  };

  const bySlot = [...occurrences].sort((a, b) =>
    a.originalDate < b.originalDate
      ? -1
      : a.originalDate > b.originalDate
        ? 1
        : 0,
  );
  const rowsBySlot = new Map<string, LoanOccurrence>();
  // Once a figure is unknown the debt after it is too, and so is every
  // later slot (8.4): identity, the dated rate and the reason are all that
  // remain. The posting path defaults an unknown cadence to monthly; a
  // projected figure from that default would be a guess, so the cadence is
  // checked once and names every occurrence.
  const cadenceKnown = periodsPerYearForStoredFrequency(frequency) !== null;
  let firstUnknownSlot: string | null = null;
  let precedingSlot: string | null = null;

  for (const occurrence of bySlot) {
    const { originalDate, dueDate } = occurrence;
    const isCursor = precedingSlot === null;
    const previous = precedingSlot;
    precedingSlot = originalDate;
    const rateAtDue = annualRateOn(rateChanges, loanAccount, dueDate);
    if (!cadenceKnown || firstUnknownSlot !== null) {
      rowsBySlot.set(
        originalDate,
        unknownOccurrence(
          occurrence,
          rateAtDue,
          null,
          firstUnknownSlot === null
            ? { kind: "cadence", frequency }
            : { kind: "earlier-occurrence", originalDate: firstUnknownSlot },
        ),
      );
      continue;
    }

    // The template chain advances at the slot (purpose `template`, 7.3) from
    // the second slot on, as `rewriteLoanTemplate` does after the posting
    // before it; the cursor's bill is the template as stored. That rewrite
    // reads the debt first: settled, it deactivates the schedule, so this
    // slot never posts, or for a line of credit keeps the template as it is.
    if (!isCursor) {
      const debtSlot = debtAt(originalDate);
      if (debtSlot <= 0.01 && !revolving) break;
      if (debtSlot > 0.01) {
        const rateAtSlot = annualRateOn(rateChanges, loanAccount, originalDate);
        if (rateAtSlot === null) {
          firstUnknownSlot = originalDate;
          rowsBySlot.set(
            originalDate,
            unknownOccurrence(occurrence, rateAtDue, debtAt(dueDate), {
              kind: "rate",
              date: originalDate,
            }),
          );
          continue;
        }
        const datedPayment = annuity
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
          // The slots are contiguous from the cursor, so the one before this
          // is `prev(D)` (7.3) without walking the calendar again.
          paymentNewlyApplies: paymentNewlyApplies(datedPayment, previous),
          frequency,
          asOfDate: originalDate,
          purpose: "template",
        });
        if (advanced.kind !== "ok") {
          return {
            status: "declined",
            reason: advanced.reason,
            occurrences: [],
          };
        }
        // `rewriteLoanTemplate` writes the parent only when the installment
        // is positive; the extra line whenever it differs.
        if (advanced.allocation.total > 0) {
          chainAmount = advanced.allocation.total;
        }
        chainExtra = advanced.allocation.extraPrincipal;
      }
    }

    const debtDue = debtAt(dueDate);
    const override = occurrence.override;
    const statedAmount =
      override?.amount != null && Number.isFinite(Number(override.amount))
        ? roundMoney(Math.abs(Number(override.amount)))
        : null;
    const overrideLines =
      statedAmount !== null && override?.splits && override.splits.length > 0
        ? override.splits
        : null;

    // The payoff `post()` writes no money for (section 3). `post()` checks it
    // only for a bill priced from the template; an override's amount is the
    // user's statement for the occurrence and posts as given. Zero needs no
    // rate, but `annualRate` is a figure of the row like any other.
    if (debtDue <= 0.01 && statedAmount === null) {
      rowsBySlot.set(originalDate, {
        originalDate,
        dueDate,
        overrideId: override?.id ?? null,
        amount: 0,
        principal: 0,
        interest: 0,
        extraPrincipal: 0,
        annualRate: rateAtDue,
        debtBefore: debtDue,
        complete: rateAtDue !== null,
        missing: rateAtDue === null ? { kind: "rate", date: dueDate } : null,
      });
      continue;
    }

    if (rateAtDue === null) {
      firstUnknownSlot = originalDate;
      rowsBySlot.set(
        originalDate,
        unknownOccurrence(occurrence, rateAtDue, debtDue, {
          kind: "rate",
          date: dueDate,
        }),
      );
      continue;
    }

    // An override with an amount and its own lines: the lines stand as
    // given (8.3), and the fold takes their principal and extra.
    if (overrideLines !== null && override && statedAmount !== null) {
      const lines = identifyLoanTemplate(
        overrideLinesAsSplits(overrideLines),
        loanAccount,
      );
      if (!lines.managed) {
        firstUnknownSlot = originalDate;
        rowsBySlot.set(
          originalDate,
          unknownOccurrence(
            occurrence,
            rateAtDue,
            debtDue,
            { kind: "override-lines", overrideId: override.id },
            statedAmount,
          ),
        );
        continue;
      }
      const principal = lineAmount(lines.principalSplit);
      const interest = lineAmount(lines.interestSplit);
      const extraPrincipal = lineAmount(lines.extraPrincipalSplit);
      booked.push({
        dueDate,
        units: toUnits(principal) + toUnits(extraPrincipal),
      });
      rowsBySlot.set(originalDate, {
        originalDate,
        dueDate,
        overrideId: override.id,
        amount: statedAmount,
        principal,
        interest,
        extraPrincipal,
        annualRate: rateAtDue,
        debtBefore: debtDue,
        complete: true,
        missing: null,
      });
      continue;
    }

    if (debtDue <= 0.01 && override && statedAmount !== null) {
      firstUnknownSlot = originalDate;
      rowsBySlot.set(
        originalDate,
        unknownOccurrence(
          occurrence,
          rateAtDue,
          debtDue,
          { kind: "override-on-settled-debt", overrideId: override.id },
          statedAmount,
        ),
      );
      continue;
    }

    // The lines: the posting's re-division of the bill at the date it falls
    // on, booked as the posting books it (`bookLoanAllocation`).
    const priced = priceInstallment({
      debt: debtDue,
      annualRate: rateAtDue,
      loanAccount,
      template: templateOf(chainExtra),
      templateAmount: statedAmount ?? chainAmount,
      datedPayment: null,
      paymentNewlyApplies: false,
      frequency,
      asOfDate: dueDate,
      purpose: "posting",
    });
    if (priced.kind !== "ok") {
      return { status: "declined", reason: priced.reason, occurrences: [] };
    }
    const allocation = bookLoanAllocation(priced.allocation, decimals, debtDue);
    booked.push({
      dueDate,
      units: toUnits(allocation.principal) + toUnits(allocation.extraPrincipal),
    });
    rowsBySlot.set(originalDate, {
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
      missing: null,
    });
  }

  // Answered in the expander's order (by the date each falls on), the first
  // `count`: a slot walked only to carry the chain past one an override
  // moved later is not reported.
  const rows = occurrences
    .map((occurrence) => rowsBySlot.get(occurrence.originalDate))
    .filter((row): row is LoanOccurrence => row !== undefined)
    .slice(0, input.count);
  return { status: "priced", occurrences: rows };
}
