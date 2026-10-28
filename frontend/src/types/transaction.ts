import { Payee } from './payee';
import { Category } from './category';
import { Account } from './account';
import { Tag } from './tag';
import { InvestmentAction, Security } from './investment';

export enum TransactionStatus {
  UNRECONCILED = 'UNRECONCILED',
  CLEARED = 'CLEARED',
  RECONCILED = 'RECONCILED',
  VOID = 'VOID',
}

export type SplitKind = 'category' | 'transfer' | 'investment';

export interface InvestmentSplitDetails {
  action: InvestmentAction;
  securityId?: string;
  quantity?: number;
  price?: number;
  commission?: number;
  exchangeRate?: number;
  // Currency pair a stored exchangeRate was resolved for (issue #1167),
  // populated by the server on scheduled-transaction split/override responses.
  // Server-derived; the client never *invents* these, but it does echo them back
  // unchanged when posting a scheduled occurrence (F5-1) so the server can tell a
  // rate that still belongs to the current settlement pair from a stale one.
  exchangeRateFromCurrency?: string;
  exchangeRateToCurrency?: string;
  description?: string;
}

export interface TransactionSplit {
  id: string;
  transactionId: string;
  kind?: SplitKind;
  categoryId: string | null;
  category: Category | null;
  transferAccountId: string | null;
  transferAccount: Account | null;
  linkedTransactionId: string | null;
  amount: number;
  memo: string | null;
  tags?: Tag[];
  /** Present when kind === 'investment' */
  investmentTransaction?: {
    id: string;
    action: InvestmentAction;
    securityId: string | null;
    security: Security | null;
    quantity: number | null;
    price: number | null;
    commission: number;
    exchangeRate: number;
  } | null;
  createdAt: string;
}

export interface RegisterProvenance {
  readOnly: true;
  isRecognition?: boolean;
  reportId: string;
  sourceTransactionId: string;
  cashDate: string;
  effectiveDate: string;
  sourceAmount: string;
  nativeAmount: string;
}
export interface Transaction {
  /** Transient editor navigation context, never sent to the ledger API. */
  accrualRecognitionDate?: string;
  reportingProvenance?: RegisterProvenance;
  id: string;
  userId: string;
  accountId: string;
  account: Account | null;
  transactionDate: string;
  payeeId: string | null;
  payeeName: string | null;
  payee: Payee | null;
  categoryId: string | null;
  category: Category | null;
  amount: number;
  currencyCode: string;
  exchangeRate: number;
  /**
   * Foreign-currency entry: the amount the user actually paid and the currency
   * they paid in. Null for an ordinary transaction (amount/currencyCode are the
   * account currency); exchangeRate is account-currency units per 1 unit of
   * originalCurrencyCode.
   */
  originalAmount: number | null;
  originalCurrencyCode: string | null;
  description: string | null;
  referenceNumber: string | null;
  status: TransactionStatus;
  // Computed properties for backwards compatibility
  isCleared: boolean;
  isReconciled: boolean;
  isVoid: boolean;
  reconciledDate: string | null;
  isSplit: boolean;
  parentTransactionId: string | null;
  isTransfer: boolean;
  linkedTransactionId: string | null;
  linkedTransaction?: Transaction | null;
  /** ID of the linked investment transaction (if this is a cash transaction for an investment) */
  linkedInvestmentTransactionId?: string | null;
  /** Number of file attachments on this transaction (populated by the list endpoint). */
  attachmentCount?: number;
  /** Number of unarchived warranties linked to this transaction (populated by the list endpoint). */
  warrantyCount?: number;
  /**
   * The key an API client created this row with (unique per account), or null.
   * Not shown in the app; it exists so a client can retry a create safely.
   */
  externalId?: string | null;
  splits?: TransactionSplit[];
  tags?: Tag[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateSplitData {
  splitKind?: SplitKind;
  categoryId?: string;
  transferAccountId?: string;
  investment?: InvestmentSplitDetails;
  amount: number;
  memo?: string;
  tagIds?: string[];
  // Id of the source split this row continues (issue #1167 F4). Sent on a
  // scheduled-transaction update so the server decides FX-rate provenance by
  // stable identity; absent for a newly added split.
  sourceSplitId?: string;
  // Set for a newly added investment line (no `sourceSplitId`) so the server
  // knows its FX rate is a deliberate value for the current settlement pair and
  // stamps that pair, rather than treating the line as an unidentified legacy
  // row and re-resolving (issue #1167 R8-F2). Scheduled surfaces only.
  rateExplicit?: boolean;
}

export interface CreateTransactionData {
  accountId: string;
  transactionDate: string;
  payeeId?: string | null;
  payeeName?: string | null;
  categoryId?: string | null;
  amount: number;
  currencyCode: string;
  exchangeRate?: number;
  /** Foreign-currency entry (both provided together, or null to clear on update). */
  originalAmount?: number | null;
  originalCurrencyCode?: string | null;
  description?: string | null;
  referenceNumber?: string | null;
  status?: TransactionStatus;
  reconciledDate?: string;
  isSplit?: boolean;
  parentTransactionId?: string;
  splits?: CreateSplitData[];
  tagIds?: string[];
}

export interface UpdateTransactionData extends Partial<CreateTransactionData> {
  accrualImpactFingerprint?: string;
  createdAt?: string;
}

export interface CurrencySummary {
  totalIncome: number;
  totalExpenses: number;
  netCashFlow: number;
  transactionCount: number;
}

export interface TransactionSummary {
  currency?: string;
  fxComplete?: boolean;
  totalIncome: number;
  totalExpenses: number;
  netCashFlow: number;
  transactionCount: number;
  firstTransactionDate?: string | null;
  lastTransactionDate?: string | null;
  byCurrency?: Record<string, CurrencySummary>;
}

export interface GroupedTotal {
  id: string | null;
  name: string | null;
  currencyCode: string;
  total: number;
  count: number;
}

export interface RecurringChargeInfo {
  payeeName: string;
  payeeId: string | null;
  amounts: number[];
  dates: string[];
  frequency: string;
  currentAmount: number;
  previousAmount: number;
  categoryName: string | null;
  categoryId: string | null;
}

export interface MonthlyTotal {
  month: string;
  total: number;
  count: number;
}

/**
 * Monthly foreign-transaction fee totals for one account, per paid currency.
 * feeTotal is positive, in the account currency; count is the number of
 * foreign-entered transactions that month (fee split or not).
 */
export interface FxFeeMonthlyTotal {
  month: string;
  currencyCode: string;
  feeTotal: number;
  count: number;
}

export interface TransactionFilters {
  accountId?: string;
  startDate?: string;
  endDate?: string;
  payeeId?: string;
  categoryId?: string;
  status?: TransactionStatus;
}

export interface PaginationInfo {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasMore: boolean;
}

/** A search field, as the server names it; `any` is a bare word or phrase. */
export type SearchField =
  | 'any'
  | 'payee'
  | 'memo'
  | 'cat'
  | 'tag'
  | 'account'
  | 'ref'
  | 'amount'
  | 'date'
  | 'status'
  | 'is'
  | 'has';

export type SearchOp =
  | 'contains'
  | 'exact'
  | 'glob'
  | 'eq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'between';

/** One term of a search as the server read it (`searchInterpretation`). */
export interface SearchTermEcho {
  field: SearchField;
  op: SearchOp;
  /** An amount is a plain decimal string, a date ISO `yyyy-MM-dd`. */
  value: string;
  /** `between` only: the inclusive upper bound. */
  valueTo?: string;
  negated: boolean;
  /** The term as typed. */
  raw: string;
  /** Set when the server could not use the term as written. */
  ignored?: 'malformed' | 'empty';
}

export interface SearchInterpretation {
  terms: SearchTermEcho[];
}

export interface PaginatedTransactions {
  data: Transaction[];
  pagination: PaginationInfo;
  /** Starting balance for running balance calculation (only set when filtering by single account) */
  startingBalance?: number;
  /**
   * Why no starting balance came back, where one otherwise would have. Read as
   * `=== 'sort'`: absent is "nothing to say", not "a balance is coming".
   */
  startingBalanceWithheld?: 'sort';
  /**
   * How the server read the search string, term by term. Present when a
   * search was sent; absent from a server that predates the search syntax, in
   * which case nothing is shown.
   */
  searchInterpretation?: SearchInterpretation;
}

// Transfer types
export interface CreateTransferData {
  fromAccountId: string;
  toAccountId: string;
  transactionDate: string;
  amount: number;
  fromCurrencyCode: string;
  toCurrencyCode?: string;
  exchangeRate?: number;
  description?: string;
  referenceNumber?: string;
  status?: TransactionStatus;
  /** Optional category; surfaces the transfer in the monthly category breakdown without counting as income/expense. null clears it. */
  categoryId?: string | null;
}

export interface TransferResult {
  fromTransaction: Transaction;
  toTransaction: Transaction;
}

// Reconciliation types
export interface ReconciliationData {
  transactions: Transaction[];
  reconciledBalance: number;
  clearedBalance: number;
  difference: number;
  /**
   * The account's most recent reconciled date, or null when it has never been
   * reconciled. Read defensively (`?? null`): during a rolling deploy this can
   * arrive from a backend that predates the field, and absent means "no
   * information", which classifies nothing rather than everything.
   */
  lastReconciledDate: string | null;
  /** The window `overdueBefore` was derived from, for the copy that names it. */
  staleAfterDays: number;
  /** Server-chosen date a row must fall before to count as overdue. */
  overdueBefore: string;
}

/** One account with rows left outstanding, from GET /transactions/reconcile/stale. */
export interface StaleUnreconciledAccount {
  accountId: string;
  accountName: string;
  currencyCode: string;
  count: number;
  oldestDate: string;
  lastReconciledDate: string;
  missedCount: number;
  overdueCount: number;
}

export interface StaleUnreconciledSummary {
  staleAfterDays: number;
  overdueBefore: string;
  accounts: StaleUnreconciledAccount[];
  totalCount: number;
}

/**
 * What a register's filter pickers offer: the payees and categories actually
 * used by the rows in the accounts on screen.
 *
 * `categories` carries the ancestors of every used category as well, because a
 * tree picker builds its top level from the rows with no parent and drops a
 * child whose parent is missing.
 */
export interface RegisterFilterOptions {
  payees: { id: string; name: string }[];
  categories: { id: string; name: string; parentId: string | null }[];
}

export interface BulkReconcileResult {
  reconciled: number;
}

export interface BulkUpdateFilters {
  accountIds?: string[];
  startDate?: string;
  endDate?: string;
  categoryIds?: string[];
  payeeIds?: string[];
  search?: string;
  amountFrom?: number;
  amountTo?: number;
  tagIds?: string[];
}

export interface BulkUpdateData {
  mode: 'ids' | 'filter';
  transactionIds?: string[];
  filters?: BulkUpdateFilters;
  excludedIds?: string[];
  payeeId?: string | null;
  payeeName?: string | null;
  categoryId?: string | null;
  description?: string | null;
  tagIds?: string[];
  status?: TransactionStatus;
  /**
   * Category filter active in the UI when the update was issued, sent in BOTH
   * selection modes: it restricts split-line recategorization to lines
   * currently in these categories, and hand-picked rows (mode "ids") must
   * honor the filter the user was looking through just like select-all does.
   */
  categoryFilterIds?: string[];
}

export interface BulkUpdateResult {
  updated: number;
  skipped: number;
  skippedReasons: string[];
  /** Split lines recategorized across split parents; present only when > 0. */
  splitLinesUpdated?: number;
}

export interface BulkDeleteData {
  mode: 'ids' | 'filter';
  transactionIds?: string[];
  filters?: BulkUpdateFilters;
  excludedIds?: string[];
}

export interface BulkDeleteResult {
  deleted: number;
}
