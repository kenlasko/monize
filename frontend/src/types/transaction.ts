import { Payee } from './payee';
import { Category } from './category';
import { Account } from './account';

export interface TransactionSplit {
  id: string;
  transactionId: string;
  categoryId: string | null;
  category: Category | null;
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
  isCleared: boolean;
  isReconciled: boolean;
  reconciledDate: string | null;
  isSplit: boolean;
  parentTransactionId: string | null;
  isTransfer: boolean;
  linkedTransactionId: string | null;
  splits?: TransactionSplit[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateSplitData {
  categoryId?: string;
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
  description?: string;
  referenceNumber?: string;
  isCleared?: boolean;
  isReconciled?: boolean;
  reconciledDate?: string;
  isSplit?: boolean;
  parentTransactionId?: string;
  splits?: CreateSplitData[];
}

export interface UpdateTransactionData extends Partial<CreateTransactionData> {}

export interface TransactionSummary {
  totalIncome: number;
  totalExpenses: number;
  netCashFlow: number;
  transactionCount: number;
}

export interface TransactionFilters {
  accountId?: string;
  startDate?: string;
  endDate?: string;
  payeeId?: string;
  categoryId?: string;
  isCleared?: boolean;
  isReconciled?: boolean;
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
  isCleared?: boolean;
}

export interface TransferResult {
  fromTransaction: Transaction;
  toTransaction: Transaction;
}
