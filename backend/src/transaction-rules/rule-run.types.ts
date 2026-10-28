import type { RuleAccrualImpact } from "./rule-accrual";
import type { LoanSettlementRefusalDetail } from "../loan-installments/loan-settlement.types";
import type { StructuralRefusal } from "./rule-structure";
import { RuleEffectsLabels } from "./transaction-rules-applier.service";

/** The filters of a manual run or a test, as the service reads them. */
export interface RuleRunFilters {
  readonly accountIds?: readonly string[];
  readonly startDate?: string;
  readonly endDate?: string;
  readonly limit?: number;
}

/** Why a row the rule reached was left alone. */
export type RuleRunSkipReason =
  | "reconciled_locked"
  | "transfer_leg_category"
  | "split_category"
  | "cross_owner_transfer_payee"
  /** A text action rendered to nothing for this row (design 10.2). */
  | "empty_render"
  /** No payee has the rendered name and the action does not create one. */
  | "payee_not_found"
  /** A structural action the row cannot take: the planner's name, unchanged (spec section 4). */
  | StructuralRefusal;

/** `{field: {before, after}}`, the shape the trace stores. */
export type RuleRunChanges = Readonly<
  Record<string, { readonly before: unknown; readonly after: unknown }>
>;

export interface RuleRunMatchedRow {
  /** For a same-owner transfer: the outgoing leg; the mirror leg gets the same change. */
  readonly transactionId: string;
  readonly date: string;
  readonly payeeName: string | null;
  readonly amount: number;
  readonly currencyCode: string;
  readonly changes: RuleRunChanges;
}

export interface RuleRunSkippedRow {
  readonly transactionId: string;
  readonly reason: RuleRunSkipReason;
  /** What a settlement refusal names: the field to set, the slot that is taken (spec decision 18). */
  readonly detail?: LoanSettlementRefusalDetail;
}

/**
 * The end of the register a run scanned from. `newest_first` for every rule
 * without a `settle_loan_installment` action; `oldest_first` with one, so the
 * settlements fold forward through time (INV-RULE-005). A truncated run's
 * copy says which rows were kept.
 */
export type RuleRunScanOrder = "newest_first" | "oldest_first";

/** What `preview-run` and `preview-draft` return: exactly what the commit would write. */
export interface RuleRunPreview {
  readonly matched: RuleRunMatchedRow[];
  readonly skipped: RuleRunSkippedRow[];
  /** Transactions examined (a same-owner transfer counts once). */
  readonly scanned: number;
  /** Which end of the register the scan started from, and so which rows a truncated run kept. */
  readonly scanOrder: RuleRunScanOrder;
  /**
   * Scanned transactions whose rule condition matched, whether or not an
   * action would change anything or the row was skipped. `matched` lists only
   * the rows that would change, so zero there is not "the rule matches nothing".
   */
  readonly conditionMatchedCount: number;
  /** More rows matched the filters than `limit` allowed. */
  readonly truncated: boolean;
  /**
   * The date (YYYY-MM-DD) of the last row the scan examined, in scan order;
   * null when it examined none. A truncated oldest-first run's next page
   * starts on it (loan settlement spec section 14.1).
   */
  readonly scannedThrough: string | null;
  /** Hash of the planned changes and the rule revision; the commit must echo it. */
  readonly fingerprint: string;
  readonly accrualImpacts?: RuleAccrualImpact[];
  readonly labels: RuleEffectsLabels;
  /** Rows whose run would queue an AI review request (queued on commit, never on preview). */
  readonly aiReviewRequests: number;
}

export interface RuleRunResult {
  /** Rows written (both legs of a same-owner transfer count). */
  readonly changed: number;
  readonly skipped: RuleRunSkippedRow[];
  /** The single action-history entry, or null when nothing changed or it could not be recorded. */
  readonly historyId: string | null;
  /** Rows the run queued an AI review request for. */
  readonly aiReviewsQueued: number;
  /** Rows whose AI review request was already open, so nothing new was queued. */
  readonly aiReviewsAlreadyQueued: number;
}

export interface RuleApplicationRow {
  readonly id: string;
  readonly transactionId: string;
  readonly date: string;
  readonly payeeName: string | null;
  readonly amount: number;
  readonly currencyCode: string;
  readonly source: string;
  readonly changes: Record<string, unknown>;
  readonly appliedAt: Date;
}
