import { AccountType } from "../accounts/entities/account.entity";
import type {
  LoanFactsUnavailable,
  LoanSettlementFacts,
} from "../loan-installments/loan-settlement-facts";
import {
  LoanSettlementPlan,
  LoanSettlementPricingRecord,
  LoanSettlementRefusalDetail,
  PriorSettlement,
  pricingColumn,
} from "../loan-installments/loan-settlement.types";
import {
  DateRange,
  settlementWindow,
} from "../loan-installments/occurrence-slots";
import type { ScheduleCursorChange } from "../scheduled-transactions/schedule-cursor";
import { planLoanSettlement } from "../loan-installments/plan-loan-settlement";
import { SettleLoanInstallmentAction } from "./rule-action.types";
import { RuleFacts } from "./rule-condition.types";
import {
  RuleTargetAccounts,
  SplitStructurePlan,
  StructuralRefusal,
  settlementSharedRefusal,
} from "./rule-structure";

/**
 * `settle_loan_installment` in the pure rules planner
 * (`docs/specs/loan-installment-settlement.md` sections 7 to 11). The engine
 * decides the shared refusals and the ones it can see without I/O, then asks
 * for the loan's facts the way `set_payee_from_text` asks for a payee: the
 * plan reports a `LoanFactsLookup`, the applier loads the facts
 * (`loadLoanSettlementFacts`) and plans again. The pricing and every other
 * refusal are the loan core's (`planLoanSettlement`), so the preview, the
 * test panel and the commit price through the one path (INV-LOAN-006).
 */

/** A loan's facts as the planner reads them, with what they were loaded for. */
export interface RuleLoanFacts {
  /** The dates the slots were enumerated over: a superset of the window of every row this entry answers. */
  readonly window: DateRange;
  /** The row ids the `post` claims were looked up for (`postedRowIds`). */
  readonly rowIds: ReadonlySet<string>;
  readonly facts: LoanSettlementFacts | LoanFactsUnavailable;
}

/** Loan facts by loan account id. The planner does no I/O: a loan missing here, or loaded over too narrow a window, is looked up. */
export type RuleLoanFactsByAccount = ReadonlyMap<string, RuleLoanFacts>;

/** Loan facts the plan needed and the context did not hold. */
export interface LoanFactsLookup {
  readonly loanAccountId: string;
  /** The row's account: a write path locks it with the loan before the reads. */
  readonly sourceAccountId: string;
  /** The row's settlement window: the slots it may pay. */
  readonly window: DateRange;
  /** The stored row's id, for the posted-bill check; absent for a row not stored yet. */
  readonly transactionId?: string;
}

/**
 * What the trace records of a planned settlement (spec section 12.2): the
 * slot and its pricing record, the stored `pricing` column without its
 * `version`. The stored trace (the application row `writeEffects` inserts)
 * adds the claim the write made: its id, whether it advanced the cursor and
 * the cursor before and after; a plan carries none of them, and the
 * fingerprint reads none of them (`canonicalChanges`).
 */
export interface RuleLoanSettlementChange {
  readonly loanAccountId: string;
  readonly scheduledTransactionId: string;
  readonly dueDate: string;
  readonly installmentNumber: number;
  readonly pricing: Omit<LoanSettlementPricingRecord, "version">;
  readonly claimId?: string;
  readonly cursorAdvanced?: boolean;
  readonly cursor?: Pick<ScheduleCursorChange, "before" | "after">;
}

/** What the planner knows about the row and the pass besides its facts. */
export interface LoanSettlementStepContext {
  readonly accounts?: RuleTargetAccounts;
  readonly loanFacts?: RuleLoanFactsByAccount;
  readonly priorSettlements?: readonly PriorSettlement[];
  readonly fromScheduledPosting?: boolean;
  readonly transactionId?: string;
}

export type LoanSettlementStep =
  | {
      readonly kind: "planned";
      readonly structure: SplitStructurePlan;
      readonly settlement: LoanSettlementPlan;
    }
  | {
      readonly kind: "refused";
      readonly reason: StructuralRefusal;
      readonly detail?: LoanSettlementRefusalDetail;
    }
  | { readonly kind: "lookup"; readonly lookup: LoanFactsLookup };

const LOAN_ACCOUNT_TYPES: readonly string[] = [
  AccountType.MORTGAGE,
  AccountType.LOAN,
];

const refused = (
  reason: StructuralRefusal,
  detail?: LoanSettlementRefusalDetail,
): LoanSettlementStep =>
  detail === undefined
    ? { kind: "refused", reason }
    : { kind: "refused", reason, detail };

/** True when `entry` was loaded over the lookup's window and, for a stored row, its id. */
export function loanFactsCover(
  entry: RuleLoanFacts | undefined,
  lookup: LoanFactsLookup,
): boolean {
  if (entry === undefined) return false;
  if (
    entry.window.from > lookup.window.from ||
    entry.window.to < lookup.window.to
  ) {
    return false;
  }
  return (
    lookup.transactionId === undefined || entry.rowIds.has(lookup.transactionId)
  );
}

/**
 * Plan the action against the row as the rules before it left it, in the
 * order of spec section 11: rows 2 to 8 (the shared refusals, row 1 is the
 * caller's), then 9 to 12 as far as the engine can see them without I/O (the
 * server-set `fromScheduledPosting`, the row's sign, the target account's
 * type and interest booking mode), then the loan core for the rest, which
 * also repeats 9 to 12 from the facts (a `post` claim naming the row, a loan
 * the target-account read did not describe).
 */
export function planSettlementStep(
  action: SettleLoanInstallmentAction,
  facts: RuleFacts,
  context: LoanSettlementStepContext,
): LoanSettlementStep {
  const shared = settlementSharedRefusal(action, facts, context.accounts);
  if (shared !== null) return refused(shared);
  if (context.fromScheduledPosting === true) {
    return refused("row_from_scheduled_posting");
  }
  // Non-zero and same-currency here (`settlementSharedRefusal`).
  const amount = facts.amount ?? 0;
  if (amount > 0) return refused("row_is_income");
  const target = context.accounts?.get(action.loanAccountId);
  if (
    target?.accountType !== undefined &&
    !LOAN_ACCOUNT_TYPES.includes(target.accountType)
  ) {
    return refused("loan_account_unavailable", {
      accountType: target.accountType,
    });
  }
  if (target?.interestBookingMode === "SEPARATE") {
    return refused("loan_interest_booked_separately");
  }
  // A row whose date is unknown (a preview without one) has no window.
  if (facts.date === null) return refused("no_installment_in_window");

  const lookup: LoanFactsLookup = {
    loanAccountId: action.loanAccountId,
    sourceAccountId: facts.accountId,
    window: settlementWindow(facts.date, action.dueDateWindow),
    ...(context.transactionId !== undefined
      ? { transactionId: context.transactionId }
      : {}),
  };
  const entry = context.loanFacts?.get(action.loanAccountId);
  if (entry === undefined || !loanFactsCover(entry, lookup)) {
    return { kind: "lookup", lookup };
  }
  const planned = planLoanSettlement(
    action,
    {
      id: context.transactionId ?? "",
      date: facts.date,
      amount,
      currencyCode: facts.currencyCode ?? "",
      accountId: facts.accountId,
    },
    entry.facts,
    context.priorSettlements ?? [],
  );
  if (!planned.ok) return refused(planned.reason, planned.detail);
  return {
    kind: "planned",
    structure: planned.structure,
    settlement: planned.settlement,
  };
}

/** The trace's record of a planned settlement (spec section 12.2). */
export function loanSettlementChange(
  plan: LoanSettlementPlan,
): RuleLoanSettlementChange {
  const { version: _version, ...pricing } = pricingColumn(plan);
  return {
    loanAccountId: plan.loanAccountId,
    scheduledTransactionId: plan.scheduledTransactionId,
    dueDate: plan.dueDate,
    installmentNumber: plan.installmentNumber,
    pricing,
  };
}
