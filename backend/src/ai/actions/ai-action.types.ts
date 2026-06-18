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
  | "create_investment_transaction";

export const AI_ACTION_TYPES: AiActionType[] = [
  "create_transaction",
  "categorize_transaction",
  "create_payee",
  "create_investment_transaction",
];

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

export type AiActionDescriptor =
  | CreateTransactionDescriptor
  | CategorizeTransactionDescriptor
  | CreatePayeeDescriptor
  | CreateInvestmentTransactionDescriptor;

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
