/**
 * Types for the AI Assistant human-in-the-loop write actions.
 *
 * When the assistant proposes a write (create a transaction, categorize a
 * transaction, create a payee) the executor runs a dry-run preview and produces
 * a signed action descriptor. The descriptor flows to the browser as a
 * `pending_action` SSE event, the user reviews a confirmation card, and on
 * approval the descriptor is posted back to the confirm endpoint which verifies
 * the signature, re-validates, and performs the real write.
 *
 * The descriptor is the integrity boundary: it carries the validated/resolved
 * fields, the owning `userId`, and an `expiresAt`, all covered by the HMAC
 * signature. The confirm endpoint always re-validates and re-checks ownership;
 * the signature only guarantees the client did not tamper with what the
 * assistant proposed.
 */

import { InvestmentAction } from "../../securities/entities/investment-transaction.entity";

export type AiActionType =
  | "create_transaction"
  | "categorize_transaction"
  | "create_payee"
  | "update_payee"
  | "delete_payee"
  | "create_security"
  | "update_security"
  | "delete_security"
  | "create_investment_transaction"
  | "create_transactions"
  | "create_investment_transactions"
  | "update_transaction"
  | "delete_transaction"
  | "update_investment_transaction"
  | "delete_investment_transaction"
  | "create_transfer"
  | "update_transfer"
  | "batch_actions";

export const AI_ACTION_TYPES: AiActionType[] = [
  "create_transaction",
  "categorize_transaction",
  "create_payee",
  "update_payee",
  "delete_payee",
  "create_security",
  "update_security",
  "delete_security",
  "create_investment_transaction",
  "create_transactions",
  "create_investment_transactions",
  "update_transaction",
  "delete_transaction",
  "update_investment_transaction",
  "delete_investment_transaction",
  "create_transfer",
  "update_transfer",
  "batch_actions",
];

/**
 * Largest batch a single bulk action may carry. Tool-call arguments count
 * against the provider output-token budget (Anthropic completes tool use with a
 * bounded `max_tokens`), so the parsed table is capped here, in the bulk tool's
 * Zod schema, and again defensively at confirm time.
 */
export const MAX_BULK_ACTION_ROWS = 25;

/** How a multi-item transaction write is confirmed. */
export type ApprovalMode = "bulk" | "individual";

/**
 * Smallest batch size that defaults to a single bulk confirmation card. Below
 * this, a multi-item transaction batch is confirmed one card per item so small
 * batches stay easy to review; at or above it the batch collapses to one bulk
 * card. The user can still force per-item review at any size by asking for
 * "individual".
 */
export const BULK_APPROVAL_THRESHOLD = 6;

/**
 * Resolve the effective approval mode for a batch of `count` transaction items.
 * An explicit "individual" request is always honoured (per-item review is
 * available at any size). Otherwise the batch only switches to bulk once it
 * reaches BULK_APPROVAL_THRESHOLD items; smaller batches stay per-item.
 */
export function resolveApprovalMode(
  requested: ApprovalMode | undefined,
  count: number,
): ApprovalMode {
  if (requested === "individual") return "individual";
  return count >= BULK_APPROVAL_THRESHOLD ? "bulk" : "individual";
}

/** Fields common to every signed descriptor. */
interface BaseDescriptor {
  type: AiActionType;
  /** Owner the descriptor was minted for; checked against the JWT on confirm. */
  userId: string;
  /** Unique id for correlation, anti-replay, and UI keying. */
  actionId: string;
  /** Epoch ms after which the descriptor is no longer accepted. */
  expiresAt: number;
}

/**
 * One resolved category-split line carried on a create/update transaction
 * descriptor. Ids are resolved at preview time and covered by the signature.
 * Category splits only: the AI tool does not expose transfer/investment splits.
 */
export interface SplitRowDescriptor {
  categoryId: string;
  amount: number;
  memo: string | null;
}

/**
 * A category-split line resolved at preview time: carries both the id (for the
 * signed descriptor) and the display name (for the confirmation card). Produced
 * by the shared prep service and consumed by the action builder.
 */
export interface ResolvedSplitLine extends SplitRowDescriptor {
  categoryName: string;
}

export interface CreateTransactionDescriptor extends BaseDescriptor {
  type: "create_transaction";
  accountId: string;
  amount: number;
  transactionDate: string;
  /** Existing payee the name resolved to, or null to record a free-text name. */
  payeeId: string | null;
  payeeName: string | null;
  /**
   * When true and payeeId is null, the confirm step creates a payee from
   * payeeName and links the transaction to it; when false the name is stored as
   * free text. Always false when payeeId is set or no payee name was given.
   */
  createPayee: boolean;
  categoryId: string | null;
  description: string | null;
  currencyCode: string;
  /**
   * When present, the transaction is created as a split across these category
   * lines (their amounts sum to `amount`) and `categoryId` is ignored.
   */
  splits?: SplitRowDescriptor[];
}

export interface CategorizeTransactionDescriptor extends BaseDescriptor {
  type: "categorize_transaction";
  transactionId: string;
  categoryId: string;
}

export interface CreatePayeeDescriptor extends BaseDescriptor {
  type: "create_payee";
  name: string;
  defaultCategoryId: string | null;
}

/**
 * Edit an existing payee. Carries the resulting state (name + default category)
 * so confirm applies an idempotent overwrite of the identified payee.
 */
export interface UpdatePayeeDescriptor extends BaseDescriptor {
  type: "update_payee";
  payeeId: string;
  name: string;
  defaultCategoryId: string | null;
}

/** Delete an existing payee (identified only; confirm re-checks ownership). */
export interface DeletePayeeDescriptor extends BaseDescriptor {
  type: "delete_payee";
  payeeId: string;
}

export interface CreateSecurityDescriptor extends BaseDescriptor {
  type: "create_security";
  /** Ticker symbol resolved by the quote-provider lookup. */
  symbol: string;
  name: string;
  /** Constrained to the known security-type list, or null when unclassified. */
  securityType: string | null;
  /** Constrained to the known exchange list, or null when not exchange-listed. */
  exchange: string | null;
  currencyCode: string;
  isFavourite: boolean;
  /** Per-security quote-source override carried from the lookup; null = user default. */
  quoteProvider: "yahoo" | "msn" | null;
  msnInstrumentId: string | null;
}

/**
 * Edit an existing security's classification/display fields. Carries the
 * resulting state so confirm applies an idempotent overwrite of the identified
 * security.
 */
export interface UpdateSecurityDescriptor extends BaseDescriptor {
  type: "update_security";
  securityId: string;
  securityType: string | null;
  exchange: string | null;
  currencyCode: string;
  isFavourite: boolean;
  /** Manual country allocation (decimal 0-1 weights) resolved at preview time. */
  countryWeightings: { name: string; weight: number }[] | null;
}

/** Delete an existing security (identified only; confirm re-checks ownership). */
export interface DeleteSecurityDescriptor extends BaseDescriptor {
  type: "delete_security";
  securityId: string;
}

export interface CreateInvestmentTransactionDescriptor extends BaseDescriptor {
  type: "create_investment_transaction";
  accountId: string;
  action: InvestmentAction;
  transactionDate: string;
  /** Resolved security (matched by symbol or name); null for cash-only actions. */
  securityId: string | null;
  /** Explicit cash account override, or null to use the brokerage's cash sleeve. */
  fundingAccountId: string | null;
  quantity: number | null;
  price: number | null;
  commission: number;
  /** Resolved at preview time so confirm persists the rate the user approved. */
  exchangeRate: number;
  description: string | null;
}

/**
 * One resolved cash-transaction row inside a bulk `create_transactions` action.
 * Identical to the singular `CreateTransactionDescriptor` minus the per-action
 * envelope (the batch shares one `actionId`/`expiresAt`/`userId`/signature).
 */
export interface TransactionRowDescriptor {
  accountId: string;
  amount: number;
  transactionDate: string;
  payeeId: string | null;
  payeeName: string | null;
  createPayee: boolean;
  categoryId: string | null;
  description: string | null;
  currencyCode: string;
}

export interface CreateTransactionsDescriptor extends BaseDescriptor {
  type: "create_transactions";
  /** Order is load-bearing: it is covered by the signature and preserved on confirm. */
  rows: TransactionRowDescriptor[];
}

/**
 * One resolved investment-transaction row inside a bulk
 * `create_investment_transactions` action. Mirrors the singular
 * `CreateInvestmentTransactionDescriptor` minus the envelope.
 */
export interface InvestmentTransactionRowDescriptor {
  accountId: string;
  action: InvestmentAction;
  transactionDate: string;
  securityId: string | null;
  fundingAccountId: string | null;
  quantity: number | null;
  price: number | null;
  commission: number;
  exchangeRate: number;
  description: string | null;
}

export interface CreateInvestmentTransactionsDescriptor extends BaseDescriptor {
  type: "create_investment_transactions";
  /** Order is load-bearing: it is covered by the signature and preserved on confirm. */
  rows: InvestmentTransactionRowDescriptor[];
}

/**
 * Edit an existing transaction. Carries the full resulting state (every field
 * as it will be persisted), so confirm applies an idempotent overwrite of the
 * identified transaction -- mirroring `CreateTransactionDescriptor` plus the id.
 */
export interface UpdateTransactionDescriptor extends BaseDescriptor {
  type: "update_transaction";
  transactionId: string;
  accountId: string;
  amount: number;
  transactionDate: string;
  payeeId: string | null;
  payeeName: string | null;
  createPayee: boolean;
  categoryId: string | null;
  description: string | null;
  currencyCode: string;
  /**
   * When present, confirm replaces the transaction's split set with these
   * category lines (their amounts sum to `amount`); `categoryId` is ignored.
   */
  splits?: SplitRowDescriptor[];
}

/** Delete an existing transaction (identified only; confirm re-checks ownership). */
export interface DeleteTransactionDescriptor extends BaseDescriptor {
  type: "delete_transaction";
  transactionId: string;
}

/**
 * Edit an existing investment transaction. Carries the full resolved resulting
 * state (mirroring `CreateInvestmentTransactionDescriptor`) plus the id.
 */
export interface UpdateInvestmentTransactionDescriptor extends BaseDescriptor {
  type: "update_investment_transaction";
  transactionId: string;
  accountId: string;
  action: InvestmentAction;
  transactionDate: string;
  securityId: string | null;
  fundingAccountId: string | null;
  quantity: number | null;
  price: number | null;
  commission: number;
  exchangeRate: number;
  description: string | null;
}

/** Delete an existing investment transaction. */
export interface DeleteInvestmentTransactionDescriptor extends BaseDescriptor {
  type: "delete_investment_transaction";
  transactionId: string;
}

/**
 * Create a transfer between two of the user's own accounts. Carries the full
 * resolved resulting state of both legs so confirm reproduces it exactly. The
 * `from` leg is debited `amount` and the `to` leg is credited `toAmount`
 * (equal to `amount` for same-currency transfers).
 */
export interface CreateTransferDescriptor extends BaseDescriptor {
  type: "create_transfer";
  fromAccountId: string;
  toAccountId: string;
  amount: number;
  transactionDate: string;
  fromCurrencyCode: string;
  toCurrencyCode: string;
  exchangeRate: number;
  toAmount: number;
  description: string | null;
  /** Existing payee the custom label resolved to, or null for free text. */
  payeeId: string | null;
  payeeName: string | null;
  /** When true and payeeId is null, confirm creates a payee from payeeName. */
  createPayee: boolean;
  /** Optional spending category applied to both transfer legs (null = none). */
  categoryId: string | null;
}

/** Edit an existing transfer (both linked legs). */
export interface UpdateTransferDescriptor extends BaseDescriptor {
  type: "update_transfer";
  transactionId: string;
  fromAccountId: string;
  toAccountId: string;
  amount: number;
  transactionDate: string;
  exchangeRate: number;
  toAmount: number;
  description: string | null;
  payeeId: string | null;
  payeeName: string | null;
  createPayee: boolean;
  /**
   * Optional spending category applied to both transfer legs (null = none).
   * Carries the existing category when an edit leaves it unchanged so the
   * confirm step re-applies it idempotently.
   */
  categoryId: string | null;
}

/**
 * One resolved row inside a generic `batch_actions` envelope. The row carries
 * the same resolved fields the matching singular descriptor would, minus the
 * per-action envelope (the batch shares one actionId/expiresAt/userId/signature).
 */
export interface BatchUpdateTransactionRow {
  transactionId: string;
  accountId: string;
  amount: number;
  transactionDate: string;
  payeeId: string | null;
  payeeName: string | null;
  createPayee: boolean;
  categoryId: string | null;
  description: string | null;
  currencyCode: string;
}

export interface BatchDeleteTransactionRow {
  transactionId: string;
}

export interface BatchCreateTransferRow {
  fromAccountId: string;
  toAccountId: string;
  amount: number;
  transactionDate: string;
  fromCurrencyCode: string;
  toCurrencyCode: string;
  exchangeRate: number;
  toAmount: number;
  description: string | null;
  payeeId: string | null;
  payeeName: string | null;
  createPayee: boolean;
  /** Optional spending category applied to both transfer legs (null = none). */
  categoryId: string | null;
}

/**
 * One resolved investment-transaction edit inside a generic `batch_actions`
 * envelope (operation `update_investment`). Carries the full resolved resulting
 * state -- exactly what the singular `UpdateInvestmentTransactionDescriptor`
 * holds minus the per-action envelope -- so confirm applies an idempotent
 * overwrite of the identified transaction.
 */
export interface BatchUpdateInvestmentTransactionRow {
  transactionId: string;
  accountId: string;
  action: InvestmentAction;
  transactionDate: string;
  securityId: string | null;
  fundingAccountId: string | null;
  quantity: number | null;
  price: number | null;
  commission: number;
  exchangeRate: number;
  description: string | null;
}

/** One investment-transaction deletion inside a `batch_actions` envelope. */
export interface BatchDeleteInvestmentTransactionRow {
  transactionId: string;
}

/** One resolved new payee inside a `batch_actions` envelope (operation `create_payee`). */
export interface BatchCreatePayeeRow {
  name: string;
  defaultCategoryId: string | null;
}

/** One resolved payee edit inside a `batch_actions` envelope (operation `update_payee`). */
export interface BatchUpdatePayeeRow {
  payeeId: string;
  name: string;
  defaultCategoryId: string | null;
}

/** One payee deletion inside a `batch_actions` envelope (operation `delete_payee`). */
export interface BatchDeletePayeeRow {
  payeeId: string;
}

/** One resolved new security inside a `batch_actions` envelope (operation `create_security`). */
export interface BatchCreateSecurityRow {
  symbol: string;
  name: string;
  securityType: string | null;
  exchange: string | null;
  currencyCode: string;
  isFavourite: boolean;
  quoteProvider: "yahoo" | "msn" | null;
  msnInstrumentId: string | null;
}

/** One resolved security edit inside a `batch_actions` envelope (operation `update_security`). */
export interface BatchUpdateSecurityRow {
  securityId: string;
  securityType: string | null;
  exchange: string | null;
  currencyCode: string;
  isFavourite: boolean;
  /**
   * Manual country allocation (decimal 0-1 weights), when the edit sets it.
   * Omitted/undefined leaves the security's existing allocation untouched.
   */
  countryWeightings?: { name: string; weight: number }[] | null;
}

/** One security deletion inside a `batch_actions` envelope (operation `delete_security`). */
export interface BatchDeleteSecurityRow {
  securityId: string;
}

export type BatchActionRow =
  | TransactionRowDescriptor
  | BatchUpdateTransactionRow
  | BatchDeleteTransactionRow
  | BatchCreateTransferRow
  | BatchUpdateInvestmentTransactionRow
  | BatchDeleteInvestmentTransactionRow
  | BatchCreatePayeeRow
  | BatchUpdatePayeeRow
  | BatchDeletePayeeRow
  | BatchCreateSecurityRow
  | BatchUpdateSecurityRow
  | BatchDeleteSecurityRow;

/**
 * Generic homogeneous bulk envelope executed as one unit. `operation` selects
 * the per-row shape (standard create reuses `TransactionRowDescriptor`). Used by
 * the unified `manage_transactions` tool for bulk update/delete/transfer-create
 * and by `manage_investment_transactions` for bulk investment update/delete
 * (standard bulk create keeps its dedicated `create_transactions` /
 * `create_investment_transactions` descriptors).
 */
export interface BatchActionsDescriptor extends BaseDescriptor {
  type: "batch_actions";
  operation:
    | "create"
    | "update"
    | "delete"
    | "create_transfer"
    | "update_investment"
    | "delete_investment"
    | "create_payee"
    | "update_payee"
    | "delete_payee"
    | "create_security"
    | "update_security"
    | "delete_security";
  /** Order is load-bearing: covered by the signature and preserved on confirm. */
  rows: BatchActionRow[];
}

export type AiActionDescriptor =
  | CreateTransactionDescriptor
  | CategorizeTransactionDescriptor
  | CreatePayeeDescriptor
  | UpdatePayeeDescriptor
  | DeletePayeeDescriptor
  | CreateSecurityDescriptor
  | UpdateSecurityDescriptor
  | DeleteSecurityDescriptor
  | CreateInvestmentTransactionDescriptor
  | CreateTransactionsDescriptor
  | CreateInvestmentTransactionsDescriptor
  | UpdateTransactionDescriptor
  | DeleteTransactionDescriptor
  | UpdateInvestmentTransactionDescriptor
  | DeleteInvestmentTransactionDescriptor
  | CreateTransferDescriptor
  | UpdateTransferDescriptor
  | BatchActionsDescriptor;

/**
 * Display-only preview of one category-split line on a split create/update card.
 * Carries the resolved category name so the user sees the breakdown.
 */
export interface AiActionSplitPreview {
  categoryName: string | null;
  amount: number;
  memo?: string | null;
}

/**
 * Human-readable preview shown on the confirmation card. Display-only (not part
 * of the signed descriptor) -- it carries resolved names so the user sees what
 * the action will do.
 */
export interface AiActionPreview {
  accountName?: string;
  amount?: number;
  currencyCode?: string;
  transactionDate?: string;
  payeeName?: string | null;
  /** True when approving the transaction will also create a new payee. */
  payeeWillBeCreated?: boolean;
  categoryName?: string | null;
  newCategoryName?: string | null;
  currentCategoryName?: string | null;
  description?: string | null;
  name?: string | null;
  /**
   * True when an update/delete targets a reconciled transaction. The
   * confirmation card surfaces a warning so the user knows approving will
   * disturb a completed reconciliation.
   */
  isReconciled?: boolean;
  /**
   * Resolved category-split lines for a split create/update. Display-only --
   * shown on the confirmation card in place of the single category row.
   */
  splits?: AiActionSplitPreview[];
  // create_investment_transaction display fields.
  investmentAction?: InvestmentAction;
  symbol?: string | null;
  securityName?: string | null;
  securityCurrency?: string | null;
  quantity?: number | null;
  price?: number | null;
  commission?: number;
  totalAmount?: number;
  cashAccountName?: string | null;
  cashCurrency?: string | null;
  cashAmount?: number | null;
  // create_security display fields (symbol/securityName/securityCurrency above
  // are reused for the ticker, full name, and currency).
  securityType?: string | null;
  exchange?: string | null;
  isFavourite?: boolean;
  // create_transfer / update_transfer display fields. The "from" leg reuses
  // accountName/amount/currencyCode; these add the destination leg.
  fromAccountName?: string;
  toAccountName?: string;
  toAmount?: number;
  toCurrencyCode?: string;
  /**
   * Per-row previews for the bulk actions (`create_transactions`,
   * `create_investment_transactions`, `batch_actions`). Carries every pasted row
   * in order --
   * both the valid rows that will be created and the flagged rows that were
   * dropped -- so the confirmation card can show the whole table with badges.
   */
  rows?: AiActionPreviewRow[];
}

/**
 * Display-only preview of a single row in a bulk action. Reuses the singular
 * display fields and adds a `status` so the card can grey out and explain rows
 * that failed to resolve (unknown security/account, validation error). Flagged
 * rows are NOT part of the signed descriptor; only `status: "ok"` rows are.
 */
export interface AiActionPreviewRow {
  status: "ok" | "error";
  /** Human-readable reason the row was dropped, when status is "error". */
  error?: string;
  // Payee display field (batch_actions with a payee operation).
  name?: string | null;
  // Shared / cash-transaction display fields.
  accountName?: string;
  amount?: number;
  currencyCode?: string;
  transactionDate?: string;
  payeeName?: string | null;
  payeeWillBeCreated?: boolean;
  categoryName?: string | null;
  description?: string | null;
  /**
   * True when this bulk update/delete row targets a reconciled transaction, so
   * the card can flag the row before the user approves the batch.
   */
  isReconciled?: boolean;
  // Investment-transaction display fields.
  investmentAction?: InvestmentAction;
  symbol?: string | null;
  securityName?: string | null;
  securityCurrency?: string | null;
  quantity?: number | null;
  price?: number | null;
  commission?: number;
  totalAmount?: number;
  cashAccountName?: string | null;
  cashCurrency?: string | null;
  cashAmount?: number | null;
  // Transfer-row display fields (batch_actions with operation: "create_transfer").
  // The "from" leg reuses accountName/amount/currencyCode.
  fromAccountName?: string;
  toAccountName?: string;
  toAmount?: number;
  toCurrencyCode?: string;
}

/**
 * The full payload emitted to the browser as a `pending_action` SSE event and
 * stored on the assistant message.
 */
export interface PendingAiAction {
  actionId: string;
  type: AiActionType;
  preview: AiActionPreview;
  descriptor: AiActionDescriptor;
  signature: string;
  expiresAt: number;
}
