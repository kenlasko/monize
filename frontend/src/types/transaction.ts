import { Payee } from './payee';
import { Category } from './category';
import { Account } from './account';

export enum TransactionStatus {
  UNRECONCILED = 'UNRECONCILED',
  CLEARED = 'CLEARED',
  RECONCILED = 'RECONCILED',
  VOID = 'VOID',
}

export interface TransactionSplit {
  id: string;
  transactionId: string;
  categoryId: string | null;
  category: Category | null;
  transferAccountId: string | null;
  transferAccount: Account | null;
  linkedTransactionId: string | null;
  amount: number;
  memo: string | null;
  createdAt: string;
}

export interface Transaction {
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
  splits?: TransactionSplit[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateSplitData {
  categoryId?: string;
  transferAccountId?: string;
  amount: number;
  memo?: string;
}

export interface CreateTransactionData {
  accountId: string;
  transactionDate: string;
  payeeId?: string;
  payeeName?: string;
  categoryId?: string;
  amount: number;
  currencyCode: string;
  exchangeRate?: number;
  description?: string | null;
  referenceNumber?: string | null;
  status?: TransactionStatus;
  reconciledDate?: string;
  isSplit?: boolean;
  parentTransactionId?: string;
  splits?: CreateSplitData[];
}

export interface UpdateTransactionData extends Partial<CreateTransactionData> {}

export interface CurrencySummary {
  totalIncome: number;
  totalExpenses: number;
  netCashFlow: number;
  transactionCount: number;
}

export interface TransactionSummary {
  totalIncome: number;
  totalExpenses: number;
  netCashFlow: number;
  transactionCount: number;
  byCurrency?: Record<string, CurrencySummary>;
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

export interface PaginatedTransactions {
  data: Transaction[];
  pagination: PaginationInfo;
  /** Starting balance for running balance calculation (only set when filtering by single account) */
  startingBalance?: number;
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
}

export interface BulkUpdateData {
  mode: 'ids' | 'filter';
  transactionIds?: string[];
  filters?: BulkUpdateFilters;
  payeeId?: string | null;
  payeeName?: string | null;
  categoryId?: string | null;
  description?: string | null;
  status?: TransactionStatus;
}

export interface BulkUpdateResult {
  updated: number;
  skipped: number;
  skippedReasons: string[];
}
