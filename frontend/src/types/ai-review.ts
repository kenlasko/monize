import type { PendingAction } from '@/types/ai';

/**
 * The AI review inbox as `GET /ai-review-requests` answers it. Mirrors
 * `backend/src/ai-review/ai-review-work.types.ts` (`AiReviewInboxItem`).
 */
export const AI_REVIEW_STATUSES = [
  'pending',
  'claimed',
  'proposed',
  'applied',
  'rejected',
  'expired',
] as const;

export type AiReviewStatus = (typeof AI_REVIEW_STATUSES)[number];

/** What raised a request: a rule or a person (`transaction_review`), or a stored order-confirmation email. */
export const AI_REVIEW_KINDS = ['transaction_review', 'email_receipt'] as const;

export type AiReviewKind = (typeof AI_REVIEW_KINDS)[number];

/** The email a request of kind `email_receipt` was raised for (`AiReviewInboxEmailReceipt`). */
export interface AiReviewEmailReceipt {
  id: string;
  fromAddress: string;
  subject: string;
  /** ISO timestamp. */
  receivedAt: string;
}

/** The reviewed transaction as the inbox shows it (not a raw row). */
export interface AiReviewTransactionSummary {
  id: string;
  /** YYYY-MM-DD. */
  date: string;
  amount: number;
  currencyCode: string;
  payeeName: string | null;
  description: string | null;
  accountId: string;
  accountName: string | null;
  categoryName: string | null;
  isSplit: boolean;
}

/**
 * A proposal is the confirmation card rebuilt against the transaction as it is
 * now, or the reason it can no longer be built. The card is committed through
 * `POST /ai/actions/confirm`, never here.
 */
export type AiReviewProposal =
  | { action: Omit<PendingAction, 'status'> }
  | { error: string };

export interface AiReviewItem {
  id: string;
  kind: AiReviewKind;
  status: AiReviewStatus;
  instruction: string;
  transactionId: string;
  ruleId: string | null;
  ruleName: string | null;
  /** Null unless the request is of kind `email_receipt` and its email still exists. */
  emailReceipt: AiReviewEmailReceipt | null;
  createdAt: string;
  expiresAt: string;
  /** Null when the transaction no longer exists. */
  transaction: AiReviewTransactionSummary | null;
  agentNote?: { reason: string; at: string };
  proposal?: AiReviewProposal;
}

/** The inbox's default view (no status sent): everything waiting, plus expired. */
export type AiReviewFilter = 'open' | AiReviewStatus;
