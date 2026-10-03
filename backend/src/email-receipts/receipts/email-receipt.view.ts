import type { EmailReceiptMatchKind } from "../entities/email-receipt.entity";
import type { EmailReceiptStatus } from "../entities/email-receipt.entity";

/**
 * What a `review` receipt's request says about it (design section 6): `proposed`
 * waits for approval, `applied` was written, `dismissed` was rejected (by the
 * person, or by a refusal whose reason is `requestNote`), `expired` ran out,
 * `pending_ai` waits for the AI (or an agent), and `request_missing` means the
 * request row is gone (a restore), which the next poll repairs. Null for every
 * other status.
 */
export type EmailReceiptDisplayState =
  | "proposed"
  | "applied"
  | "dismissed"
  | "expired"
  | "pending_ai"
  | "request_missing";

/** The linked transaction, as far as the receipts page needs it. */
export interface EmailReceiptTransactionSummary {
  id: string;
  /** `YYYY-MM-DD`. */
  date: string;
  amount: number;
  currencyCode: string;
  payeeName: string | null;
}

/** A candidate of an ambiguous receipt: the summary plus the text that helps choose. */
export interface EmailReceiptCandidateSummary extends EmailReceiptTransactionSummary {
  description: string | null;
}

/** One stored email in the list: never its text. */
export interface EmailReceiptListItem {
  id: string;
  fromAddress: string;
  fromDomain: string;
  subject: string;
  receivedAt: string;
  status: EmailReceiptStatus;
  statusReason: string | null;
  matchKind: EmailReceiptMatchKind | null;
  parserId: string | null;
  parserName: string | null;
  aiReviewRequestId: string | null;
  displayState: EmailReceiptDisplayState | null;
  /** Why the request was closed without being applied, when it says. */
  requestNote: string | null;
  transaction: EmailReceiptTransactionSummary | null;
  createdAt: string;
}

/** One stored email with its text, what the parser read and the candidates. */
export interface EmailReceiptDetail extends EmailReceiptListItem {
  bodyText: string;
  parsed: Record<string, unknown> | null;
  candidates: EmailReceiptCandidateSummary[];
}
