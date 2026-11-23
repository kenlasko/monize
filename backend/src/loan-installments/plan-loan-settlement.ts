import { Account, AccountType } from "../accounts/entities/account.entity";
import {
  amortizationMethodFor,
  MortgageType,
  mortgageTypeOf,
  prepaymentModeOf,
} from "../accounts/mortgage-type.util";
import { missingMethodTerms } from "../accounts/mortgage-installment.util";
import { periodsPerYearForStoredFrequency } from "../accounts/payment-frequency.util";
import { effectiveAnnualRateOn } from "../accounts/effective-loan-rate.util";
import {
  bookLoanAllocation,
  LoanPaymentAllocation,
} from "../accounts/loan-payment-waterfall.util";
import { currencyMinorUnitDecimals } from "../common/currency-minor-unit.util";
import {
  FIAT_MONEY_DECIMALS,
  moneyUnits,
  roundMoney,
} from "../common/round.util";
import {
  datedAnnuityPayment,
  identifyLoanTemplate,
  LoanTemplateSplits,
  periodicRateFor,
  priceInstallment,
  isDebtRetired,
} from "./price-installment";
import {
  installmentNumberOf,
  scheduleCadenceMatchesLoan,
  selectOccurrenceSlot,
  settlementWindow,
} from "./occurrence-slots";
import {
  LoanFactsUnavailable,
  LoanSettlementFacts,
} from "./loan-settlement-facts";
import {
  LOAN_SETTLEMENT_MEMOS,
  LOAN_SETTLEMENT_TOLERANCE_MINOR_UNITS,
  LoanSettlementAction,
  LoanSettlementMissingInput,
  LoanSettlementOutcome,
  LoanSettlementParts,
  LoanSettlementPlan,
  LoanSettlementRefusal,
  LoanSettlementRefusalDetail,
  LoanSettlementRefusalReason,
  LoanSettlementSplitPart,
  LoanSettlementSplitPlan,
  PriorSettlement,
} from "./loan-settlement.types";

/**
 * Plan the settlement of one bank row against a scheduled loan installment
 * (`docs/specs/loan-installment-settlement.md` sections 6 to 11). Pure: every
 * fact comes in through `LoanSettlementFacts`, every refusal is decided here
 * before anything is written, and nothing throws for a row that cannot be
 * settled. The rules engine (B4) calls this from its planner and writes the
 * `split` structure it returns through the split writer (B5).
 *
 * The one pricing path (INV-LOAN-006): the installment is priced by
 * `priceInstallment`, the pure tail every scheduled-loan consumer prices
 * through, with the matched slot as its boundary (decision 11), the dated
 * payment of decision 12 and the settlement's own missing-data rule
 * (decision 16: a missing rate or cadence refuses, never defaults).
 */

/** The matched row, as the planner reads it. `amount` is signed, in the account's currency at 4dp. */
export interface LoanSettlementRow {
  readonly id: string;
  /** `YYYY-MM-DD`. */
  readonly date: string;
  readonly amount: number;
  /** Derived from the account, never from the request. */
  readonly currencyCode: string;
  readonly accountId: string;
  /** Set by `post()`'s create (server-side, never from a request): the row is a posted bill. */
  readonly fromScheduledPosting?: boolean;
}

export interface LoanSettlementPlanned {
  readonly ok: true;
  readonly structure: LoanSettlementSplitPlan;
  readonly settlement: LoanSettlementPlan;
}

export type LoanSettlementPlanResult =
  LoanSettlementPlanned | LoanSettlementRefusal;

const SCALE = 10 ** FIAT_MONEY_DECIMALS;
const toUnits = (value: number): number =>
  moneyUnits(value, FIAT_MONEY_DECIMALS);
const fromUnits = (units: number): number => units / SCALE;

const refuse = (
  reason: LoanSettlementRefusalReason,
  detail?: LoanSettlementRefusalDetail,
): LoanSettlementRefusal =>
  detail === undefined ? { ok: false, reason } : { ok: false, reason, detail };

/** The account's scalar rate as a number, or null when the column holds nothing usable. */
function scalarRate(account: Pick<Account, "interestRate">): number | null {
  if (account.interestRate === null || account.interestRate === undefined) {
    return null;
  }
  const value = Number(account.interestRate);
  return Number.isFinite(value) ? value : null;
}

interface PolicyLines {
  readonly principal: number;
  readonly interest: number;
  readonly extra: number;
  readonly outcome: LoanSettlementOutcome;
  /** Signed, in scaled units; 0 unless a tolerance row applied. */
  readonly toleranceApplied: number;
}

type PolicyDecision =
  | { readonly kind: "lines"; readonly lines: PolicyLines }
  | { readonly kind: "excess" }
  | { readonly kind: "shortfall" };

/**
 * The amount policy (spec section 8), on scaled integers so the lines sum to
 * `paid` exactly. `booked` is `P`, `I`, `E`, `T` in scaled units; `tolerance`
 * is `tol` in scaled units; `debt` is `debtBefore` in scaled units. The first
 * row that matches decides.
 */
export function applyAmountPolicy(
  paid: number,
  booked: { principal: number; interest: number; extra: number; total: number },
  tolerance: number,
  debt: number,
  policy: Pick<LoanSettlementAction, "excess" | "shortfall">,
): PolicyDecision {
  const { principal: P, interest: I, extra: E, total: T } = booked;
  const d = paid - T;
  const B = P + I;
  const lines = (
    principal: number,
    interest: number,
    extra: number,
    outcome: LoanSettlementOutcome,
    toleranceApplied = 0,
  ): PolicyDecision => ({
    kind: "lines",
    lines: { principal, interest, extra, outcome, toleranceApplied },
  });

  // Row 1.
  if (d === 0) return lines(P, I, E, "exact");
  // Row 2: a rounding difference lands on the interest line.
  if (Math.abs(d) <= tolerance && I + d >= 0) {
    return lines(P, I + d, E, "tolerance", d);
  }
  // Rows 3 to 5: money above the priced total.
  if (d > tolerance) {
    if (policy.excess === "extra_principal" && P + E + d <= debt) {
      return lines(P, I, E + d, "extra_principal");
    }
    return { kind: "excess" };
  }
  // Row 6: the standing extra is discretionary and sheds first.
  if (E > 0 && B <= paid && paid < T) {
    return lines(P, I, paid - B, "extra_shed");
  }
  // Row 7: the whole extra shed and a rounding difference on the base.
  if (E > 0 && B - tolerance <= paid && paid < B && I + (paid - B) >= 0) {
    return lines(P, I + (paid - B), 0, "tolerance", paid - B);
  }
  // Rows 8 and 9.
  if (policy.shortfall === "refuse") return { kind: "shortfall" };
  const interest = Math.min(I, paid);
  return lines(paid - interest, interest, 0, "interest_first");
}

/**
 * Plan one row's settlement, or refuse it with a reason in the order of spec
 * section 11. `prior` carries the settlements planned earlier in the same
 * pass and not yet written (INV-RULE-005); those on another loan are ignored.
 */
export function planLoanSettlement(
  action: LoanSettlementAction,
  row: LoanSettlementRow,
  facts: LoanSettlementFacts | LoanFactsUnavailable,
  prior: readonly PriorSettlement[],
): LoanSettlementPlanResult {
  // Rows 5 and 6 of the shared refusals, decidable from the row alone.
  if (!Number.isFinite(row.amount) || row.amount === 0) {
    return refuse("zero_amount");
  }
  if (action.loanAccountId === row.accountId) {
    return refuse("transfer_same_account");
  }
  // Row 8: the loan's currency against the row's.
  if (
    facts.kind === "facts" &&
    facts.loanAccount.currencyCode.toUpperCase() !==
      row.currencyCode.toUpperCase()
  ) {
    return refuse("transfer_currency_mismatch");
  }
  // Row 9: a row that already pays an occurrence, by the server-set option
  // (a bill `post()` created) or by a claim of either source naming the row:
  // the facts loader's lookup over the pass's row ids (`postedRowIds`, every
  // schedule), or a claim of this schedule in the slots' span. A `rule`
  // claim's row that no longer reads as a split (edited down to one line,
  // spec section 15 item 9) is refused here, before the claim's `INSERT`
  // could conflict on the one-occurrence-per-transaction index. The engine
  // (B4) supplies both the option and the row ids.
  if (
    row.fromScheduledPosting === true ||
    (facts.kind === "facts" &&
      (facts.postedRowIds.has(row.id) ||
        facts.claims.some((claim) => claim.transactionId === row.id)))
  ) {
    return refuse("row_from_scheduled_posting");
  }
  // Row 10.
  if (row.amount > 0) return refuse("row_is_income");
  // Row 11: the account or its ledger could not be read, or it is not a loan.
  if (facts.kind === "unavailable") return refuse("loan_account_unavailable");
  const { loanAccount } = facts;
  if (
    (loanAccount.accountType !== AccountType.MORTGAGE &&
      loanAccount.accountType !== AccountType.LOAN) ||
    loanAccount.isClosed
  ) {
    return refuse("loan_account_unavailable", {
      accountType: loanAccount.accountType,
    });
  }
  // Row 12.
  if (loanAccount.interestBookingMode === "SEPARATE") {
    return refuse("loan_interest_booked_separately");
  }

  // Row 13: the static inputs of section 10, every missing one named.
  const missing: LoanSettlementMissingInput[] = [];
  const { schedule } = facts;
  let template: LoanTemplateSplits | null = null;
  if (schedule === null) {
    missing.push("scheduledPayment");
  } else {
    const identified = identifyLoanTemplate([...facts.splits], loanAccount);
    if (identified.managed) {
      template = identified;
    } else {
      missing.push("managedTemplate");
    }
    if (
      !scheduleCadenceMatchesLoan(
        loanAccount.paymentFrequency,
        schedule.frequency,
      )
    ) {
      missing.push("scheduleCalendar");
    }
  }
  const interestCategoryId =
    action.interestCategoryId ?? loanAccount.interestCategoryId ?? null;
  if (interestCategoryId === null) missing.push("interestCategory");
  const mortgageType: MortgageType | null =
    loanAccount.accountType === AccountType.MORTGAGE
      ? mortgageTypeOf(loanAccount)
      : null;
  const method = mortgageType ? amortizationMethodFor(mortgageType) : "ANNUITY";
  if (mortgageType && method !== "ANNUITY") {
    missing.push(...missingMethodTerms(mortgageType, loanAccount));
  }
  const frequency = loanAccount.paymentFrequency || schedule?.frequency || null;
  if (periodsPerYearForStoredFrequency(frequency) === null) {
    missing.push("paymentFrequency");
  }
  if (missing.length > 0) {
    return refuse("loan_not_configured", { missing: [...new Set(missing)] });
  }
  // Narrowed by the checks above; restated for the compiler.
  if (schedule === null || template === null || interestCategoryId === null) {
    return refuse("loan_not_configured", { missing: [...new Set(missing)] });
  }

  // Rows 14 and 15: the slot (section 6.2).
  const window = settlementWindow(row.date, action.dueDateWindow);
  const priorOnLoan = prior.filter(
    (p) => p.loanAccountId === action.loanAccountId,
  );
  const selection = selectOccurrenceSlot(
    facts.slots,
    row.date,
    window,
    facts.claims.map((claim) => claim.originalDueDate),
    new Set(priorOnLoan.map((p) => p.dueDate)),
  );
  if (selection.kind === "none_in_window") {
    return refuse("no_installment_in_window", {
      windowFrom: window.from,
      windowTo: window.to,
    });
  }
  if (selection.kind === "all_claimed") {
    return refuse("occurrence_already_posted", {
      dueDates: selection.dueDates,
    });
  }
  const { slot } = selection;
  const dueDate = slot.date;

  // Row 16: the dated inputs at the slot.
  const datedMissing: LoanSettlementMissingInput[] = [];
  const annualRate = effectiveAnnualRateOn(
    facts.rateChanges,
    dueDate,
    scalarRate(loanAccount),
  );
  if (annualRate === null) datedMissing.push("rate");
  const payment =
    method === "ANNUITY"
      ? datedAnnuityPayment(
          facts.rateChanges,
          dueDate,
          loanAccount.paymentAmount,
        )
      : null;
  if (method === "ANNUITY" && payment === null) datedMissing.push("payment");
  if (datedMissing.length > 0 || annualRate === null) {
    return refuse("loan_not_configured", { missing: datedMissing, dueDate });
  }

  // Row 17: the fold (section 7.2) and a retired debt.
  const debtLedger = facts.debtByDueDate.get(dueDate);
  if (debtLedger === undefined) {
    return refuse("loan_account_unavailable", { dueDate });
  }
  const foldedUnits = priorOnLoan
    .filter((p) => p.rowDate <= dueDate)
    .reduce(
      (sum, p) => sum + toUnits(p.principal) + toUnits(p.extraPrincipal),
      0,
    );
  const debtExact = fromUnits(toUnits(debtLedger) - foldedUnits);
  const debtBefore = roundMoney(debtExact);
  // Less than one minor unit, judged before the rounding so a 4dp residue of
  // 0.0099 stays a residue, as `resolveInstallmentCore` reads it.
  if (isDebtRetired(debtExact)) {
    return refuse("loan_debt_retired", { dueDate });
  }

  // Section 7.3: the one pricing path, bounded by the slot. The settlement
  // purpose takes the dated payment exactly; a stated base takes the
  // template's extra on top inside the tail (spec section 7.3 step 3,
  // `payment(s) + E`; pricing spec 7.1, `total(D, E)`).
  const priced = priceInstallment({
    debt: debtBefore,
    annualRate,
    loanAccount,
    template,
    templateAmount: Math.abs(Number(schedule.amount)),
    datedPayment: payment,
    paymentNewlyApplies: false,
    // Narrowed above: an unknown cadence was refused as `paymentFrequency`.
    frequency: frequency as string,
    asOfDate: dueDate,
    purpose: "settlement",
  });
  if (priced.kind !== "ok") {
    return refuse("loan_not_configured", {
      missing: mortgageType
        ? missingMethodTerms(mortgageType, loanAccount)
        : [],
      dueDate,
    });
  }
  const decimals = currencyMinorUnitDecimals(loanAccount.currencyCode);
  const booked = bookLoanAllocation(priced.allocation, decimals, debtBefore);

  // Section 8: the amount policy, on scaled integers.
  const paidUnits = toUnits(Math.abs(row.amount));
  const bookedUnits = {
    principal: toUnits(booked.principal),
    interest: toUnits(booked.interest),
    extra: toUnits(booked.extraPrincipal),
    total: toUnits(booked.total),
  };
  const toleranceUnits = Math.round(
    (LOAN_SETTLEMENT_TOLERANCE_MINOR_UNITS * SCALE) / 10 ** decimals,
  );
  const decision = applyAmountPolicy(
    paidUnits,
    bookedUnits,
    toleranceUnits,
    toUnits(debtBefore),
    action,
  );
  const paid = fromUnits(paidUnits);
  if (decision.kind === "excess") {
    return refuse("installment_amount_excess", {
      dueDate,
      expected: booked.total,
      paid,
      debtBefore,
    });
  }
  if (decision.kind === "shortfall") {
    return refuse("installment_amount_shortfall", {
      dueDate,
      expected: booked.total,
      paid,
    });
  }
  const { lines } = decision;

  const parts: LoanSettlementSplitPart[] = [
    {
      amount: -fromUnits(lines.principal) || 0,
      categoryId: null,
      transferAccountId: loanAccount.id,
      payeeId: null,
      memo: LOAN_SETTLEMENT_MEMOS.principal,
    },
    {
      amount: -fromUnits(lines.interest) || 0,
      categoryId: interestCategoryId,
      transferAccountId: null,
      payeeId: null,
      memo: LOAN_SETTLEMENT_MEMOS.interest,
    },
  ];
  if (lines.extra > 0) {
    parts.push({
      amount: -fromUnits(lines.extra) || 0,
      categoryId: null,
      transferAccountId: loanAccount.id,
      payeeId: null,
      memo: LOAN_SETTLEMENT_MEMOS.extraPrincipal,
    });
  }

  const settlement: LoanSettlementPlan = {
    loanAccountId: loanAccount.id,
    scheduledTransactionId: schedule.id,
    dueDate,
    installmentNumber: installmentNumberOf(slot, loanAccount),
    method: mortgageType ?? "LOAN",
    prepaymentMode:
      mortgageType === "LINEAR" ? prepaymentModeOf(loanAccount) : null,
    currencyCode: loanAccount.currencyCode,
    debtLedger: roundMoney(debtLedger),
    foldedPrincipal: fromUnits(foldedUnits),
    debtBefore,
    annualRate,
    periodicRate: periodicRateFor(loanAccount, frequency as string, annualRate),
    priced: partsOf(priced.allocation),
    booked: partsOf(booked),
    paid,
    difference: fromUnits(paidUnits - bookedUnits.total),
    outcome: lines.outcome,
    principal: fromUnits(lines.principal),
    interest: fromUnits(lines.interest),
    extraPrincipal: fromUnits(lines.extra),
    toleranceApplied: fromUnits(lines.toleranceApplied),
    policy: { excess: action.excess, shortfall: action.shortfall },
    advancesCursor: slot.isCursor,
  };

  return { ok: true, structure: { kind: "split", parts }, settlement };
}

function partsOf(allocation: LoanPaymentAllocation): LoanSettlementParts {
  return {
    principal: allocation.principal,
    interest: allocation.interest,
    extra: allocation.extraPrincipal,
    total: allocation.total,
  };
}
