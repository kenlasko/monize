/**
 * Email receipts as the API answers them. Mirrors
 * `backend/src/email-receipts/` (mailbox view and DTOs, receipts view, parsers
 * view and DTOs, `parsing/receipt-parser.types.ts`). The value lists are
 * `as const` arrays with the unions derived from them, so a control can
 * enumerate what the type allows.
 *
 * Amounts inside a `ParsedReceipt` are integers in 1/10000 units (the parser
 * reads text, never floats); a transaction summary's `amount` is an ordinary
 * currency amount. `fromReceiptUnits` (`lib/email-receipts-format.ts`) is the
 * one conversion between the two.
 */

export const EMAIL_RECEIPT_MAILBOX_SECURITIES = ['tls', 'starttls'] as const;
export type EmailReceiptMailboxSecurity = (typeof EMAIL_RECEIPT_MAILBOX_SECURITIES)[number];

export const EMAIL_RECEIPT_AI_MODES = ['off', 'on_demand', 'automatic'] as const;
export type EmailReceiptAiMode = (typeof EMAIL_RECEIPT_AI_MODES)[number];

export const EMAIL_RECEIPT_AUTH_METHODS = ['password', 'oauth2'] as const;
export type EmailReceiptAuthMethod = (typeof EMAIL_RECEIPT_AUTH_METHODS)[number];

export const EMAIL_RECEIPT_OAUTH_PROVIDERS = ['google', 'microsoft'] as const;
export type EmailReceiptOAuthProvider = (typeof EMAIL_RECEIPT_OAUTH_PROVIDERS)[number];

export const EMAIL_RECEIPT_STATUSES = [
  'pending',
  'skipped',
  'no_parser',
  'parse_failed',
  'unmatched',
  'ambiguous',
  'review_conflict',
  'review',
  'ignored',
] as const;
export type EmailReceiptStatus = (typeof EMAIL_RECEIPT_STATUSES)[number];

export const EMAIL_RECEIPT_MATCH_KINDS = ['order_id', 'amount_payee', 'amount_only', 'manual'] as const;
export type EmailReceiptMatchKind = (typeof EMAIL_RECEIPT_MATCH_KINDS)[number];

/** What a `review` receipt's request says about it; null for every other status. */
export const EMAIL_RECEIPT_DISPLAY_STATES = [
  'proposed',
  'applied',
  'dismissed',
  'expired',
  'pending_ai',
  'request_missing',
] as const;
export type EmailReceiptDisplayState = (typeof EMAIL_RECEIPT_DISPLAY_STATES)[number];

export const EMAIL_RECEIPT_PARSER_STATUSES = ['draft', 'approved'] as const;
export type EmailReceiptParserStatus = (typeof EMAIL_RECEIPT_PARSER_STATUSES)[number];

export const EMAIL_RECEIPT_PARSER_SOURCES = ['manual', 'ai'] as const;
export type EmailReceiptParserSource = (typeof EMAIL_RECEIPT_PARSER_SOURCES)[number];

/** Why a parse is not complete (`ParsedReceipt.reason`). */
export const PARSED_RECEIPT_REASONS = [
  'no_total',
  'no_items',
  'items_unbalanced',
  'items_uncategorized',
  'shipping_uncategorized',
] as const;
export type ParsedReceiptReason = (typeof PARSED_RECEIPT_REASONS)[number];

// ---------------------------------------------------------------- mailbox

/** The user's mailbox. The password is never here: `passwordSet` says whether one is stored. */
export interface EmailReceiptMailbox {
  id: string;
  host: string;
  port: number;
  security: EmailReceiptMailboxSecurity;
  username: string;
  folder: string;
  enabled: boolean;
  aiMode: EmailReceiptAiMode;
  autoApply: boolean;
  passwordSet: boolean;
  encryptionConfigured: boolean;
  authMethod: EmailReceiptAuthMethod;
  oauthProvider: EmailReceiptOAuthProvider | null;
  oauthConnected: boolean;
  lastPolledAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** `PUT /email-receipts/mailbox`: the whole configuration. `password` only when typed. */
export interface UpsertEmailReceiptMailboxPayload {
  host: string;
  port: number;
  security: EmailReceiptMailboxSecurity;
  username: string;
  password?: string;
  folder?: string;
  enabled: boolean;
  aiMode: EmailReceiptAiMode;
  autoApply: boolean;
}

/** `PATCH /email-receipts/mailbox/settings`: the settings an OAuth mailbox has. */
export interface UpdateEmailReceiptMailboxSettingsPayload {
  folder?: string;
  enabled?: boolean;
  aiMode?: EmailReceiptAiMode;
  autoApply?: boolean;
}

/** `POST /email-receipts/mailbox/test`: a draft; a field left out is read from the stored mailbox. */
export interface TestEmailReceiptMailboxPayload {
  host?: string;
  port?: number;
  security?: EmailReceiptMailboxSecurity;
  username?: string;
  password?: string;
  folder?: string;
}

export type EmailReceiptMailboxTestResult =
  | { ok: true; messages: number }
  | { ok: false; error: string };

export interface EmailReceiptPollResult {
  ok: boolean;
  busy?: boolean;
  /** Emails stored by this poll. */
  fetched: number;
  /** Messages stored as skipped (too large or undecodable). */
  skipped: number;
  /** Stored emails the pipeline acted on. */
  processed: number;
  error?: string;
}

/** Which OAuth providers the operator configured, and the redirect URI to register. */
export interface EmailReceiptOAuthProviders {
  google: boolean;
  microsoft: boolean;
  redirectUri: string;
}

// --------------------------------------------------------------- receipts

export interface EmailReceiptTransactionSummary {
  id: string;
  /** YYYY-MM-DD. */
  date: string;
  amount: number;
  currencyCode: string;
  payeeName: string | null;
}

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

export interface EmailReceiptDetail extends EmailReceiptListItem {
  bodyText: string;
  /** The stored `ParsedReceipt`; read it through `readParsedReceipt`. */
  parsed: Record<string, unknown> | null;
  candidates: EmailReceiptCandidateSummary[];
}

/**
 * `POST /email-receipts/:id/ask-ai`: the request now waits, pending, in the AI
 * review inbox for whoever claims it by id (the assistant in the chat, or an
 * MCP agent). Nothing has answered it yet.
 */
export interface EmailReceiptAskAiResult {
  ok: true;
  requestId: string;
  transactionId: string;
}

// ---------------------------------------------------------------- parsers

/** Bounds the server's validator enforces (`receipt-parser.types.ts`), mirrored so the form says so first. */
export const RECEIPT_PARSER_LIMITS = {
  maxPatternsPerField: 10,
  maxPatternLength: 200,
  maxCategoryRules: 50,
  maxSectionMarkerLength: 100,
  maxNameLength: 100,
  maxFromDomains: 10,
  maxSubjectWords: 10,
  maxSubjectWordLength: 100,
} as const;

export interface ReceiptItemsDefinition {
  startAfter?: string;
  stopAt?: string;
  patterns: string[];
}

export interface ReceiptCategoryRule {
  match: string;
  categoryId: string;
}

/** A parser definition, version 1 (`definition` of an `email_receipt_parsers` row). */
export interface ReceiptParserDefinition {
  version: 1;
  orderId?: string[];
  total?: string[];
  shipping?: string[];
  discount?: string[];
  items?: ReceiptItemsDefinition;
  categoryRules?: ReceiptCategoryRule[];
  defaultCategoryId?: string;
  shippingCategoryId?: string;
}

/** One problem the server's validator found: where, and a machine-readable code. */
export interface ReceiptParserValidationError {
  path: string;
  code: string;
}

export interface EmailReceiptParser {
  id: string;
  name: string;
  payeeId: string | null;
  fromDomains: string[];
  subjectContains: string[];
  definition: Record<string, unknown>;
  definitionValid: boolean;
  definitionErrors: ReceiptParserValidationError[];
  status: EmailReceiptParserStatus;
  source: EmailReceiptParserSource;
  approvedAt: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateEmailReceiptParserPayload {
  name: string;
  payeeId?: string | null;
  fromDomains: string[];
  subjectContains?: string[];
  definition: ReceiptParserDefinition;
}

export interface UpdateEmailReceiptParserPayload extends Partial<CreateEmailReceiptParserPayload> {
  expectedRevision: number;
}

export interface TestEmailReceiptParserPayload {
  definition: ReceiptParserDefinition;
  receiptId: string;
  payeeId?: string | null;
}

export interface ParsedReceiptItem {
  name: string;
  qty: number;
  /** The line total, in 1/10000 units. */
  amount: number;
  categoryId: string | null;
}

/** What a parser read from one email. Every amount is in 1/10000 units; null means the email did not state it. */
export interface ParsedReceipt {
  orderId: string | null;
  total: number | null;
  shipping: number | null;
  discount: number | null;
  items: ParsedReceiptItem[];
  shippingCategoryId: string | null;
  discountCategoryId: string | null;
  complete: boolean;
  reason: ParsedReceiptReason | null;
  /** Who read the email: a saved parser, or the AI. Absent on a receipt stored before the field existed. */
  source?: 'parser' | 'ai';
}

export type ReceiptMatchResult =
  | { kind: 'matched'; transactionId: string; matchKind: Exclude<EmailReceiptMatchKind, 'manual'> }
  | { kind: 'ambiguous'; candidateIds: string[] }
  | { kind: 'unmatched' };

export interface EmailReceiptParserTestResult {
  parsed: ParsedReceipt;
  match: ReceiptMatchResult;
  /** Candidate transactions the matcher was given. */
  candidateCount: number;
  /** The matched transaction, when there is one (an ordinary amount, no currency). */
  transaction: { id: string; date: string; amount: number; payeeName: string | null } | null;
}
