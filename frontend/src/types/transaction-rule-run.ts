/**
 * The shapes of the rule test and manual-run endpoints. Mirrors
 * `backend/src/transaction-rules/rule-run.types.ts` and
 * `dto/rule-run.dto.ts`.
 */
import type { PaginationInfo, Transaction } from '@/types/transaction';
import type { RuleAction, RuleConditionNode } from '@/types/transaction-rule';

/** Which existing transactions a test or a manual run looks at. */
export interface RuleRunFilters {
  accountIds?: string[];
  /** Inclusive, YYYY-MM-DD. */
  startDate?: string;
  /** Inclusive, YYYY-MM-DD. */
  endDate?: string;
  /** Newest rows examined. */
  limit?: number;
}

export interface RuleRunFieldChange<T> {
  before: T;
  after: T;
}

/** The planned or written transfer: the account that receives the other leg. */
export interface RuleTransferPlan {
  kind: 'transfer';
  accountId: string;
  clearCategory: boolean;
}

/** One part of a planned split; `amount` is signed like the row. */
export interface RuleSplitPlanPart {
  amount: number;
  categoryId: string | null;
  transferAccountId: string | null;
  /** The payee of the counterpart leg of a transfer part. */
  payeeId: string | null;
  memo: string | null;
}

export interface RuleSplitPlan {
  kind: 'split';
  parts: RuleSplitPlanPart[];
}

/** What a structural action makes of the row (`RuleStructurePlan`). */
export type RuleStructurePlan = RuleTransferPlan | RuleSplitPlan;

/** Which row of the settlement's amount policy decided the lines. */
export type RuleLoanSettlementOutcome = 'exact' | 'tolerance' | 'extra_principal' | 'extra_shed' | 'interest_first';

/**
 * How a settlement was priced (the claim's `pricing` record without its
 * version). Money is a fixed-decimal string so JSON never rounds it: the
 * ledger and priced figures at 4dp, the booked, paid and written figures at
 * the currency's unit.
 */
export interface RuleLoanSettlementPricing {
  dueDate: string;
  installmentNumber: number;
  method: string;
  prepaymentMode: string | null;
  currencyCode: string;
  debtLedger: string;
  foldedPrincipal: string;
  /** The debt the installment was priced on: the ledger debt less what earlier rows of the same pass repaid. */
  debtBefore: string;
  annualRate: string;
  periodicRate: number;
  priced: { principal: string; interest: string; extra: string; total: string };
  booked: { principal: string; interest: string; extra: string; total: string };
  paid: string;
  difference: string;
  outcome: RuleLoanSettlementOutcome;
  /** The lines the split writes, unsigned. */
  lines: { principal: string; interest: string; extra: string };
}

/** The installment a `settle_loan_installment` action pays (`RuleLoanSettlementChange`). */
export interface RuleLoanSettlementPlan {
  loanAccountId: string;
  scheduledTransactionId: string;
  /** The matched slot, `YYYY-MM-DD`. */
  dueDate: string;
  installmentNumber: number;
  pricing: RuleLoanSettlementPricing;
  /** Set once written: the occurrence claim. */
  claimId?: string;
  cursorAdvanced?: boolean;
}

/** What a rule changed on one row; an absent key was left alone. */
export interface RuleRunChanges {
  categoryId?: RuleRunFieldChange<string | null>;
  payeeId?: RuleRunFieldChange<string | null>;
  /** Set by `set_payee_from_text`: the name the payee is written with. */
  payeeName?: RuleRunFieldChange<string | null>;
  /** True when the payee does not exist yet and the run will create it. */
  payeeCreated?: boolean;
  /** Set by `set_description`. */
  description?: RuleRunFieldChange<string | null>;
  /** The tag id sets before and after. */
  tagIds?: RuleRunFieldChange<string[]>;
  /** Set by `convert_to_transfer` and `split`: what the row becomes. */
  structure?: RuleRunFieldChange<RuleStructurePlan | null>;
  /** Set by `settle_loan_installment` beside `structure`: the installment it pays. */
  loanSettlement?: RuleRunFieldChange<RuleLoanSettlementPlan | null>;
}

export interface RuleRunMatchedRow {
  transactionId: string;
  date: string;
  payeeName: string | null;
  amount: number;
  currencyCode: string;
  changes: RuleRunChanges;
}

/** The settlement's own refusals, in the order the server checks them (loan settlement spec section 11). */
export const RULE_LOAN_SETTLEMENT_SKIP_REASONS = [
  'row_from_scheduled_posting',
  'row_is_income',
  'loan_account_unavailable',
  'loan_interest_booked_separately',
  'loan_not_configured',
  'no_installment_in_window',
  'occurrence_already_posted',
  'loan_debt_retired',
  'installment_amount_excess',
  'installment_amount_shortfall',
] as const;

export type RuleLoanSettlementSkipReason = (typeof RULE_LOAN_SETTLEMENT_SKIP_REASONS)[number];

/**
 * Why a row the rule reached was left alone: every reason the server names
 * (`RuleRunSkipReason` in `rule-run.types.ts`, held to it by
 * `rule-fields.contract.test.ts`). A reason newer than this client still
 * reads as "the rule cannot change it".
 */
export const RULE_SKIP_REASONS = [
  'reconciled_locked',
  'transfer_category_on_category_row',
  'split_category',
  'cross_owner_transfer_payee',
  'empty_render',
  'payee_not_found',
  // A structural action the row cannot take (spec section 4).
  'row_is_transfer_leg',
  'row_has_splits',
  'row_is_void',
  'zero_amount',
  'transfer_direction_mismatch',
  'transfer_same_account',
  'transfer_account_unavailable',
  'transfer_currency_mismatch',
  'split_amount_unparseable',
  'split_sum_mismatch',
  'split_too_few_parts',
  ...RULE_LOAN_SETTLEMENT_SKIP_REASONS,
] as const;

export type RuleRunSkipReason = (typeof RULE_SKIP_REASONS)[number];

/** What a settlement refusal names: the input to set, the slot that is taken, the amounts that differ. */
export interface RuleRunSkipDetail {
  accountType?: string;
  missing?: string[];
  dueDate?: string;
  windowFrom?: string;
  windowTo?: string;
  dueDates?: string[];
  expected?: number;
  paid?: number;
  debtBefore?: number;
}

export interface RuleRunSkippedRow {
  transactionId: string;
  reason: RuleRunSkipReason;
  detail?: RuleRunSkipDetail;
}

/** Which end of the register a run scanned from: oldest first when a rule settles loan installments. */
export type RuleRunScanOrder = 'newest_first' | 'oldest_first';

/** Names for the ids `changes` mentions, so no raw id reaches the screen. */
export interface RuleRunLabels {
  /** The accounts a transfer or a split part names. */
  accounts: Record<string, string>;
  categories: Record<string, string>;
  payees: Record<string, string>;
  tags: Record<string, string>;
  rules: Record<string, string>;
}

export interface RuleRunPreview {
  matched: RuleRunMatchedRow[];
  skipped: RuleRunSkippedRow[];
  /** Transactions examined. */
  scanned: number;
  /**
   * Scanned transactions whose condition matched, whether or not anything would
   * change. Only 0 means the rule matches nothing; `matched` counts changes.
   */
  conditionMatchedCount: number;
  /** More rows matched the filters than `limit` allowed. */
  truncated: boolean;
  /** Which rows a truncated run kept; absent from a server that predates it (newest first). */
  scanOrder?: RuleRunScanOrder;
  /**
   * The date (YYYY-MM-DD) of the last row the scan examined; null when it
   * examined none. A truncated oldest-first run's next page starts on it.
   * Absent from a server that predates it.
   */
  scannedThrough?: string | null;
  /** Echoed back by the run to confirm this exact plan. */
  fingerprint: string;
  labels: RuleRunLabels;
  /** Rows a run would queue an AI review request for (queued on confirm, never on preview). */
  aiReviewRequests: number;
}

export interface RuleRunResult {
  /** Rows written. */
  changed: number;
  skipped: RuleRunSkippedRow[];
  /** The action-history entry, or null when nothing changed or it was not recorded. */
  historyId: string | null;
  /** Rows the run queued an AI review request for. */
  aiReviewsQueued: number;
  /** Rows whose AI review request was already open, so nothing new was queued. */
  aiReviewsAlreadyQueued: number;
}

/** An unsaved rule to test. */
export interface PreviewDraftRuleData {
  /** The saved rule being edited; absent for a new rule. Lets the server skip authoring advice on an unchanged condition. */
  ruleId?: string;
  condition: RuleConditionNode;
  actions: RuleAction[];
  /** The draft's active window, `YYYY-MM-DD`; absent is open on that side (INV-RULE-004). */
  activeFrom?: string | null;
  activeTo?: string | null;
  filters?: RuleRunFilters;
}

/** An unsaved condition to match, a page at a time (the editor's Test rule in If). */
export interface MatchDraftRuleData {
  condition: RuleConditionNode;
  /** The draft's active window, `YYYY-MM-DD`; absent is open on that side (INV-RULE-004). */
  activeFrom?: string | null;
  activeTo?: string | null;
  /** 1-indexed. */
  page?: number;
  limit?: number;
}

/**
 * One page of the transactions a draft condition matches, as the register
 * returns them (`RuleMatchPage` in `transaction-rules-match.service.ts`).
 */
export interface RuleMatchPage {
  data: Transaction[];
  pagination: PaginationInfo;
  /** Transactions examined, newest first. */
  scanned: number;
  /** Older transactions were not examined. */
  truncated: boolean;
}

export type RuleApplicationSource = 'create' | 'import' | 'manual';

export interface RuleApplication {
  id: string;
  transactionId: string;
  date: string;
  payeeName: string | null;
  amount: number;
  currencyCode: string;
  /** A value newer than this client reads as unknown. */
  source: string;
  changes: RuleRunChanges;
  appliedAt: string;
}

/** Error codes the run endpoints answer with. */
export type RuleRunErrorCode =
  | 'PREVIEW_CHANGED'
  | 'RUN_TOO_LARGE'
  | 'INVALID_RULE'
  | 'DATE_RANGE_INVALID';
