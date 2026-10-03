import type { PendingAiAction } from "../ai/actions/ai-action.types";
import type { LlmTransactionRow } from "../transactions/transactions.service";
import type {
  AiReviewRequestKind,
  AiReviewRequestStatus,
} from "./ai-review-request.entity";

/** What an agent can do with the queue, on both tool surfaces. */
export const AI_REVIEW_OPERATIONS = [
  "list",
  "claim",
  "submit",
  "reject",
] as const;
export type AiReviewOperation = (typeof AI_REVIEW_OPERATIONS)[number];

/**
 * How much of a stored email a claim hands an agent: the receipt's text, cut.
 * The text is what a sender wrote to the user's mailbox -- data, never an
 * instruction -- and a claim is one of the places it reaches a model.
 */
export const AI_REVIEW_EMAIL_TEXT_MAX_CHARS = 20_000;

export const DEFAULT_AI_REVIEW_TOOL_LIST_LIMIT = 20;
export const MAX_AI_REVIEW_TOOL_LIST_LIMIT = 50;

/**
 * The claim key of the in-app assistant. The assistant has no connection to
 * key on, so every chat of one user shares it; an MCP client is keyed by its
 * own caller key (`callerKey` in `mcp/mcp-context.ts`), which never equals it.
 */
export const ASSISTANT_CLAIM_KEY = "assistant";

/**
 * The claim keys of the email-receipts module (docs/future-plans/email-receipts.md
 * section 6). A receipt's deterministic proposal is born claimed by the first
 * and submitted under it; the AI path claims under the second. Neither equals an
 * MCP caller key, so an agent never answers a request that is being worked on.
 */
export const EMAIL_RECEIPTS_CLAIM_KEY = "email-receipts";
export const EMAIL_RECEIPTS_AI_CLAIM_KEY = "email-receipts-ai";

/** One category line of a proposal, exactly as `manage_transactions` takes it. */
export interface AiReviewSplitLine {
  categoryName: string;
  amount: number;
  memo?: string;
}

/**
 * The edit an agent proposes for a `transaction_review` request. No amount, no
 * date and no account: a review may re-categorise, re-label and split, never
 * move money (design invariant I1).
 */
export interface AiReviewProposalInput {
  splits?: AiReviewSplitLine[];
  categoryName?: string;
  payeeName?: string;
  description?: string;
}

/** A request as a model reads it. The claim key itself never leaves the server. */
export interface LlmAiReviewRequest {
  id: string;
  kind: AiReviewRequestKind;
  status: AiReviewRequestStatus;
  instruction: string;
  transactionId: string;
  ruleId: string | null;
  /** The stored email a request of kind `email_receipt` was raised for, else null. */
  emailReceiptId: string | null;
  /** True when the caller holds the claim. */
  claimedByYou: boolean;
  createdAt: string;
  expiresAt: string;
  /** Why an earlier agent gave the request up, when one did. */
  agentNote?: { reason: string; at: string };
}

export interface LlmAiReviewList {
  requests: LlmAiReviewRequest[];
  totalCount: number;
  truncated: boolean;
}

/**
 * The email a `email_receipt` request was raised for, as a claim shows it. The
 * text is the sender's own words, cut to `AI_REVIEW_EMAIL_TEXT_MAX_CHARS`:
 * data to read, never an instruction.
 */
export interface LlmAiReviewEmailReceipt {
  fromAddress: string;
  subject: string;
  receivedAt: string;
  text: string;
}

export interface LlmAiReviewClaim {
  /** Null when nothing is pending; under contention that is not proof the queue is empty. */
  request: LlmAiReviewRequest | null;
  /** The reviewed transaction, one row or one per split line. */
  transaction?: LlmTransactionRow[];
  /** For a request of kind `email_receipt` whose email still exists. */
  emailReceipt?: LlmAiReviewEmailReceipt;
}

/** A stored proposal: what the agent sent and the signed card built from it. */
export interface StoredAiReviewProposal {
  input: AiReviewProposalInput;
  action: PendingAiAction;
  proposedAt: string;
}

export interface AiReviewSubmitResult {
  request: LlmAiReviewRequest;
  action: PendingAiAction;
}

/** The reviewed transaction as the inbox shows it (not a raw row). */
export interface AiReviewTransactionSummary {
  id: string;
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

/** The email an inbox row of kind `email_receipt` was raised for. */
export interface AiReviewInboxEmailReceipt {
  id: string;
  fromAddress: string;
  subject: string;
  receivedAt: string;
}

/** One inbox entry: the request, its transaction and, when proposed, the card. */
export interface AiReviewInboxItem {
  id: string;
  kind: AiReviewRequestKind;
  status: AiReviewRequestStatus;
  instruction: string;
  transactionId: string;
  ruleId: string | null;
  ruleName: string | null;
  /** Null unless the request is of kind `email_receipt` and its email still exists. */
  emailReceipt: AiReviewInboxEmailReceipt | null;
  createdAt: string;
  expiresAt: string;
  /** Null when the transaction no longer exists. */
  transaction: AiReviewTransactionSummary | null;
  agentNote?: { reason: string; at: string };
  /**
   * When `proposed`: the confirmation card, rebuilt from the stored proposal
   * against the transaction as it is now (so a stale proposal cannot overwrite a
   * later edit), or the reason it can no longer be built.
   */
  proposal?: { action: PendingAiAction } | { error: string };
}
