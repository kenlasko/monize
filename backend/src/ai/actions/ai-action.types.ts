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

import { ContactLookupSource } from "../../payees/lookup/payee-contact-lookup.types";
import { InvestmentAction } from "../../securities/entities/investment-transaction.entity";
import type {
  RuleEffectsLabels,
  RuleEffectsPreview,
} from "../../transaction-rules/transaction-rules-applier.service";
import type { RuleAction } from "../../transaction-rules/rule-action.types";
import type { RuleConditionNode } from "../../transaction-rules/rule-condition.types";
import type { RuleDefinitionLabels } from "../../transaction-rules/rule-labels";
import type {
  RuleRunMatchedRow,
  RuleRunSkippedRow,
} from "../../transaction-rules/rule-run.types";
import type { RuleTrigger } from "../../transaction-rules/rule-trigger.types";

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
  | "batch_actions"
  | "create_transaction_rule"
  | "update_transaction_rule"
  | "delete_transaction_rule"
  | "run_transaction_rule";

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
  "create_transaction_rule",
  "update_transaction_rule",
  "delete_transaction_rule",
  "run_transaction_rule",
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
 * The descriptor fields the builder mints FRESH on every build -- a random
 * `actionId` and a clock-derived `expiresAt`. Everything else in a descriptor
 * describes the change and is the same whenever the same change is re-derived.
 *
 * The list exists because the MCP multi round-trip confirmation fingerprints
 * the action a user approved and re-checks it on the round that writes
 * (`backend/src/mcp/mcp-confirm.ts`). Those two rounds are two separate tool
 * calls, so they build two descriptors; hashing these fields would make the
 * fingerprint differ every time and refuse every confirmed write. It is
 * declared here, beside the descriptor, rather than restated as a literal in
 * the consumer -- and `AiActionEnvelope` below is what makes the compiler
 * check it: a new per-build field cannot be minted without joining the list.
 */
export const AI_ACTION_ENVELOPE_FIELDS = ["actionId", "expiresAt"] as const;

export type AiActionEnvelopeField = (typeof AI_ACTION_ENVELOPE_FIELDS)[number];

/** Exactly the fields `AI_ACTION_ENVELOPE_FIELDS` names, typed from the descriptor. */
export type AiActionEnvelope = Pick<BaseDescriptor, AiActionEnvelopeField>;

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

/**
 * Map resolved/signed split lines to the `CreateTransactionSplitDto` shape
 * `TransactionsService.create`/`update` accept inside their DTO. Written once
 * for both confirm-time executors (AI Assistant and MCP): the splits must ride
 * in the SAME DTO as the scalar fields so the whole edit commits in one
 * transaction under one row lock -- a follow-up `updateSplits` call would
 * commit separately and a failure between the two would strand the parent
 * amount against the old lines.
 */
export function toSplitDtoRows(
  splits: readonly SplitRowDescriptor[],
): { categoryId: string; amount: number; memo: string | undefined }[] {
  return splits.map((s) => ({
    categoryId: s.categoryId,
    amount: s.amount,
    memo: s.memo ?? undefined,
  }));
}

/**
 * Strip a resolved split line down to the signed-descriptor shape (ids only).
 * Lives here beside {@link toSplitDtoRows} rather than in the action builder,
 * because the shared prep service builds batch rows too and a second copy is
 * how the two shapes drift apart.
 */
export function toSplitRowDescriptor(
  line: ResolvedSplitLine,
): SplitRowDescriptor {
  return { categoryId: line.categoryId, amount: line.amount, memo: line.memo };
}

/** Map a resolved split line to its display-only confirmation-card shape. */
export function toSplitPreview(line: ResolvedSplitLine): AiActionSplitPreview {
  return {
    categoryName: line.categoryName,
    amount: line.amount,
    memo: line.memo,
  };
}

/**
 * One chat/MCP-supplied file to persist as a transaction attachment when the
 * action is confirmed. The bytes themselves never travel in the descriptor:
 * they are parked server-side in the RelayAttachmentStore under
 * `attachmentRefId`, and `sha256` binds those parked bytes into the signature
 * so confirm can verify it is attaching exactly what was previewed.
 */
export interface AttachmentRefDescriptor {
  attachmentRefId: string;
  filename: string;
  contentType: string;
  byteSize: number;
  sha256: string;
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
  /** Files to persist as transaction attachments after the create commits. */
  attachments?: AttachmentRefDescriptor[];
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
  /** Normalised at preview time; absent means the request set no address. */
  website?: string | null;
  /** Contact fields, same contract as {@link website} above. */
  address?: string | null;
  email?: string | null;
  phone?: string | null;
  /**
   * Present when the preview already ran a contact lookup for this payee.
   * The commit stores it as the row's provenance instead of looking up
   * again, so the card and the stored row agree. `source` is null when the
   * lookup answered but found nothing.
   */
  contactLookup?: PayeeContactLookupStamp;
}

/** Serialisable copy of the provenance a contact lookup leaves on a payee. */
export interface PayeeContactLookupStamp {
  source: ContactLookupSource | null;
  /** ISO-8601 -- the descriptor is signed JSON. */
  attemptedAt: string;
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
  /** Absent leaves the stored address alone; null clears it. */
  website?: string | null;
  /** Contact fields, same contract as {@link website} above. */
  address?: string | null;
  email?: string | null;
  phone?: string | null;
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
  quoteProvider: "yahoo" | "msn" | "lse" | "deutsche_boerse" | null;
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
  /** Manual asset-class allocation (decimal 0-1 weights) resolved at preview time. */
  assetWeightings: { name: string; weight: number }[] | null;
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
  /** Files to persist as transaction attachments after the update commits. */
  attachments?: AttachmentRefDescriptor[];
  /**
   * The AI review request this edit answers. Not part of the change (nothing on
   * the transaction reads it) and not an envelope field: it is signed with the
   * rest, so a client cannot point an approval at another request, and confirm
   * marks that request applied in the transaction that writes the edit.
   */
  aiReviewRequestId?: string;
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
  /**
   * The COMPLETE replacement split set for this row, when the edit changes a
   * split transaction's categories. Present means `categoryId` is null and the
   * categories live here -- the same relationship the singular descriptor has,
   * carried per row so several split transactions can be edited under one
   * confirmation.
   *
   * Rows without it are ordinary parent-field edits, unchanged.
   */
  splits?: SplitRowDescriptor[];
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
  /** REDEEM only; applied through the linked INTEREST companion. */
  accruedInterest: number;
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
  website?: string | null;
  address?: string | null;
  email?: string | null;
  phone?: string | null;
}

/** One resolved payee edit inside a `batch_actions` envelope (operation `update_payee`). */
export interface BatchUpdatePayeeRow {
  payeeId: string;
  name: string;
  defaultCategoryId: string | null;
  website?: string | null;
  address?: string | null;
  email?: string | null;
  phone?: string | null;
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
  quoteProvider: "yahoo" | "msn" | "lse" | "deutsche_boerse" | null;
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
  /**
   * Manual asset-class allocation (decimal 0-1 weights), when the edit sets it.
   * Omitted/undefined leaves the security's existing allocation untouched.
   */
  assetWeightings?: { name: string; weight: number }[] | null;
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

/**
 * A transaction rule as a descriptor carries it: ids resolved at preview time
 * (never names), the actions with their `onlyIfEmpty` defaults applied. Confirm
 * hands it to `TransactionRulesService`, which validates it again and checks
 * every id against the owner inside the write's transaction.
 */
export interface RuleDefinitionDescriptor {
  name: string;
  enabled: boolean;
  triggers: RuleTrigger[];
  condition: RuleConditionNode;
  actions: RuleAction[];
  stopProcessing: boolean;
  /**
   * The active window (INV-RULE-004). Optional so a descriptor signed before
   * the window existed still confirms; absent is "leave as stored" on an edit.
   */
  activeFrom?: string | null;
  activeTo?: string | null;
}

/** Create a rule (appended at the end of the user's list). */
export interface CreateTransactionRuleDescriptor extends BaseDescriptor {
  type: "create_transaction_rule";
  rule: RuleDefinitionDescriptor;
}

/**
 * Edit a rule. Carries the full resulting state and the revision the card was
 * built from: a rule changed since is refused with 409 and nothing is written.
 */
export interface UpdateTransactionRuleDescriptor extends BaseDescriptor {
  type: "update_transaction_rule";
  ruleId: string;
  expectedRevision: number;
  rule: RuleDefinitionDescriptor;
}

/** Delete a rule, if it is still at the revision the card showed. */
export interface DeleteTransactionRuleDescriptor extends BaseDescriptor {
  type: "delete_transaction_rule";
  ruleId: string;
  expectedRevision: number;
}

/** Which existing transactions a rule run looks at (ids, as the run service reads them). */
export interface RuleRunFiltersDescriptor {
  accountIds?: string[];
  startDate?: string;
  endDate?: string;
  limit?: number;
}

/**
 * Run a saved rule on existing transactions. `fingerprint` is the hash of the
 * plan the card showed (it covers the rule revision too): the commit re-plans
 * and refuses with 409 PREVIEW_CHANGED, writing nothing, when it differs.
 */
export interface RunTransactionRuleDescriptor extends BaseDescriptor {
  type: "run_transaction_rule";
  ruleId: string;
  filters: RuleRunFiltersDescriptor;
  fingerprint: string;
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
  | BatchActionsDescriptor
  | CreateTransactionRuleDescriptor
  | UpdateTransactionRuleDescriptor
  | DeleteTransactionRuleDescriptor
  | RunTransactionRuleDescriptor;

/**
 * Display-only preview of one category-split line on a split create/update card.
 * Carries the resolved category name so the user sees the breakdown.
 */
export interface AiActionSplitPreview {
  categoryName: string | null;
  amount: number;
  memo?: string | null;
}

/** Display-only preview of one file an action will attach on approval. */
export interface AiActionAttachmentPreview {
  filename: string;
  contentType: string;
  byteSize: number;
}

/** Rows of a rule test a card lists; the counts cover all of them. */
export const RULE_CARD_PREVIEW_ROWS = 10;

/** What running a rule on existing transactions would do, as a card shows it. */
export interface AiActionRuleTestPreview {
  /** Transactions the rule would change. */
  matchedCount: number;
  /**
   * Transactions whose rule condition matched, whether or not an action would
   * change them. Only 0 means the rule matches nothing.
   */
  conditionMatchedCount: number;
  /** Transactions examined. */
  scanned: number;
  /** More transactions matched the filters than the run examines. */
  truncated: boolean;
  /** The first {@link RULE_CARD_PREVIEW_ROWS} rows that would change. */
  rows: RuleRunMatchedRow[];
  /** Rows the rule reached and left alone, and why (first rows only). */
  skipped: RuleRunSkippedRow[];
  skippedCount: number;
  /** Rows whose run would queue an AI review request (queued on approval, never on preview). */
  aiReviewRequests: number;
  /** Names for the ids in `rows`. */
  labels: RuleEffectsLabels;
}

/** A stored rule as it was before an edit, for the card's "was" side. */
export interface AiActionRuleState {
  name: string;
  enabled: boolean;
  triggers: RuleTrigger[];
  condition: RuleConditionNode;
  actions: RuleAction[];
  stopProcessing: boolean;
  /** The active window, `YYYY-MM-DD`; null is open on that side. */
  activeFrom: string | null;
  activeTo: string | null;
}

/**
 * The rule a rule card shows. The client renders the definition in words with
 * its own translations, so this carries the structure and the names of the ids
 * in it (`labels`), not a sentence.
 */
export interface AiActionRulePreview extends AiActionRuleState {
  labels: RuleDefinitionLabels;
  /** update: the rule as stored now. */
  current?: AiActionRuleState;
  /** run: the filters, as ids (`labels.accounts` names the accounts). */
  filters?: RuleRunFiltersDescriptor;
  /** create/update/run: what running it on existing transactions would change. */
  test?: AiActionRuleTestPreview;
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
  /**
   * What the user's transaction rules will do to a created transaction on
   * approval (display-only, not signed). Absent when no rule matches.
   */
  ruleEffects?: RuleEffectsPreview;
  newCategoryName?: string | null;
  currentCategoryName?: string | null;
  description?: string | null;
  name?: string | null;
  /** Payee website, as the commit would store it (create_payee/update_payee). */
  website?: string | null;
  /** Payee contact fields, as the commit would store them. */
  address?: string | null;
  email?: string | null;
  phone?: string | null;
  /**
   * Set when the contact fields above were looked up rather than supplied
   * (create_payee). The card labels them as suggestions.
   */
  contactLookupSource?: ContactLookupSource | null;
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
  /**
   * Files that will be saved as transaction attachments on approval.
   * Display-only mirror of the descriptor's attachment refs.
   */
  attachments?: AiActionAttachmentPreview[];
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
  /** create/update/delete/run_transaction_rule: the rule and its test. */
  rule?: AiActionRulePreview;
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
  // Payee display fields (batch_actions with a payee operation).
  name?: string | null;
  website?: string | null;
  address?: string | null;
  email?: string | null;
  phone?: string | null;
  // Shared / cash-transaction display fields.
  accountName?: string;
  amount?: number;
  currencyCode?: string;
  transactionDate?: string;
  payeeName?: string | null;
  payeeWillBeCreated?: boolean;
  categoryName?: string | null;
  description?: string | null;
  /** The rule effects of a created row (display-only). */
  ruleEffects?: RuleEffectsPreview;
  /**
   * The complete replacement split set for this row, when the edit rewrites a
   * split transaction's categories. Present means `categoryName` is null: the
   * categories are these lines, and the card shows them instead -- a row that
   * says "Groceries" while writing three other lines would be a card the user
   * approved for something else.
   */
  splits?: AiActionSplitPreview[];
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
