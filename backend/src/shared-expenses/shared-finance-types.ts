import { SharedJournalEntry } from "./shared-journal";
import { SharedBankBreakdown, SharedPersonalEffect } from "./shared-projection";

export interface SharedIntegration {
  id: string;
  groupId: string;
  participantId: string;
  accountId: string;
  currencyCode: string;
  currentBalance: string;
  active: boolean;
}
export interface SharedPosting {
  id: string;
  entryId: string;
  fingerprint: string;
  acceptedRevision: number;
  snapshot: {
    title?: string;
    effect: SharedPersonalEffect;
    input: Record<string, unknown>;
  };
  categoryId: string | null;
  payeeId: string | null;
  originalBanks?: SharedBankRow[];
}
export interface SharedFinanceOverview {
  integration: SharedIntegration | null;
  accessRevoked: boolean;
  pendingCount: number;
  entries: {
    entryId: string;
    title: string;
    date: string;
    type: SharedJournalEntry["type"];
    state: SharedJournalEntry["state"];
    revision: number;
    effect: SharedPersonalEffect | null;
    posting: SharedPosting | null;
    needsReview: boolean;
    reviewReason: import("./shared-review-state").SharedReviewReason | null;
  }[];
}
export interface SharedBankRow {
  id: string;
  accountId: string;
  date: string;
  amount: string;
  currencyCode: string;
  status: string;
  isSplit: boolean;
  isTransfer: boolean;
  linkedTransactionId: string | null;
  parentTransactionId: string | null;
  postingId: string | null;
  categoryId: string | null;
  payeeId: string | null;
  payeeName: string | null;
  description: string | null;
  externalId: string | null;
  originalAmount: string | null;
  originalCurrencyCode: string | null;
  exchangeRate: string;
  investmentLinked?: boolean;
  splits?: SharedBankSplit[];
}
export interface SharedBankSplit {
  id: string;
  kind: string;
  amount: string;
  categoryId: string | null;
  memo: string | null;
  createdAt: string;
  tagIds: string[];
  transferAccountId: string | null;
  linkedTransactionId: string | null;
  investmentLinked: boolean;
}
export interface SharedLedgerLink {
  transactionId: string;
  kind: "BANK" | "COST" | "COUNTERPART" | "FX";
  created: boolean;
  before: SharedBankRow | null;
}
export interface SharedBankPaymentPlan {
  cash: string;
  originalCash: string;
  bank: SharedBankRow | null;
  bankAccountId: string;
  bankCurrency: string;
  breakdown: SharedBankBreakdown;
  privateCategoryId: string | null;
  fxCategoryId: string | null;
  privateSplits?: SharedBankSplit[];
}
export interface SharedFinancePlan {
  payments: SharedBankPaymentPlan[];
  entry: SharedJournalEntry;
  integration: SharedIntegration;
  existing: SharedPosting | null;
  effect: SharedPersonalEffect;
  fingerprint: string;
  bank: SharedBankRow | null;
  bankAccountId: string | null;
  bankCurrency: string | null;
  breakdown: SharedBankBreakdown | null;
  categoryId: string | null;
  payeeId: string | null;
  privateCategoryId: string | null;
  fxCategoryId: string | null;
  sourceLinks: SharedLedgerLink[];
  sourceRows: SharedBankRow[];
}
export const SHARED_BANK_SELECT = `id, account_id AS "accountId", TO_CHAR(transaction_date, 'YYYY-MM-DD') AS date,
  amount, currency_code AS "currencyCode", status, is_split AS "isSplit", is_transfer AS "isTransfer",
  linked_transaction_id AS "linkedTransactionId", parent_transaction_id AS "parentTransactionId",
  shared_expense_posting_id AS "postingId", category_id AS "categoryId", payee_id AS "payeeId", payee_name AS "payeeName",
  description, external_id AS "externalId", original_amount AS "originalAmount", original_currency_code AS "originalCurrencyCode", exchange_rate AS "exchangeRate"`;
