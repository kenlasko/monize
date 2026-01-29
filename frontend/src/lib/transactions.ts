import apiClient from './api';
import {
  Transaction,
  TransactionSplit,
  TransactionStatus,
  CreateTransactionData,
  UpdateTransactionData,
  CreateSplitData,
  TransactionSummary,
  PaginatedTransactions,
  CreateTransferData,
  TransferResult,
  ReconciliationData,
  BulkReconcileResult,
} from '@/types/transaction';

export const transactionsApi = {
  // Create a new transaction
  create: async (data: CreateTransactionData): Promise<Transaction> => {
    const response = await apiClient.post<Transaction>('/transactions', data);
    return response.data;
  },

  // Get paginated transactions with optional filters
  getAll: async (params?: {
    accountId?: string;
    startDate?: string;
    endDate?: string;
    categoryId?: string;
    payeeId?: string;
    page?: number;
    limit?: number;
  }): Promise<PaginatedTransactions> => {
    // Use a longer timeout for accounts with many transactions
    const response = await apiClient.get<PaginatedTransactions>('/transactions', { params, timeout: 60000 });
    return response.data;
  },

  // Get single transaction by ID
  getById: async (id: string): Promise<Transaction> => {
    const response = await apiClient.get<Transaction>(`/transactions/${id}`);
    return response.data;
  },

  // Update transaction
  update: async (id: string, data: UpdateTransactionData): Promise<Transaction> => {
    const response = await apiClient.patch<Transaction>(`/transactions/${id}`, data);
    return response.data;
  },

  // Delete transaction
  delete: async (id: string): Promise<void> => {
    await apiClient.delete(`/transactions/${id}`);
  },

  // Mark transaction as cleared/uncleared
  markCleared: async (id: string, isCleared: boolean): Promise<Transaction> => {
    const response = await apiClient.post<Transaction>(`/transactions/${id}/clear`, {
      isCleared,
    });
    return response.data;
  },

  // Reconcile transaction
  reconcile: async (id: string): Promise<Transaction> => {
    const response = await apiClient.post<Transaction>(`/transactions/${id}/reconcile`);
    return response.data;
  },

  // Unreconcile transaction
  unreconcile: async (id: string): Promise<Transaction> => {
    const response = await apiClient.post<Transaction>(`/transactions/${id}/unreconcile`);
    return response.data;
  },

  // Update transaction status
  updateStatus: async (id: string, status: TransactionStatus): Promise<Transaction> => {
    const response = await apiClient.patch<Transaction>(`/transactions/${id}/status`, {
      status,
    });
    return response.data;
  },

  // Get transaction summary
  getSummary: async (params?: {
    accountId?: string;
    startDate?: string;
    endDate?: string;
    categoryId?: string;
    payeeId?: string;
  }): Promise<TransactionSummary> => {
    // Use a longer timeout for accounts with many transactions
    const response = await apiClient.get<TransactionSummary>('/transactions/summary', {
      params,
      timeout: 60000,
    });
    return response.data;
  },

  // ==================== Split Transaction Methods ====================

  // Get splits for a transaction
  getSplits: async (transactionId: string): Promise<TransactionSplit[]> => {
    const response = await apiClient.get<TransactionSplit[]>(
      `/transactions/${transactionId}/splits`,
    );
    return response.data;
  },

  // Replace all splits for a transaction (atomic update)
  updateSplits: async (
    transactionId: string,
    splits: CreateSplitData[],
  ): Promise<TransactionSplit[]> => {
    const response = await apiClient.put<TransactionSplit[]>(
      `/transactions/${transactionId}/splits`,
      splits,
    );
    return response.data;
  },

  // Add a single split to a transaction
  addSplit: async (
    transactionId: string,
    split: CreateSplitData,
  ): Promise<TransactionSplit> => {
    const response = await apiClient.post<TransactionSplit>(
      `/transactions/${transactionId}/splits`,
      split,
    );
    return response.data;
  },

  // Remove a split from a transaction
  deleteSplit: async (transactionId: string, splitId: string): Promise<void> => {
    await apiClient.delete(`/transactions/${transactionId}/splits/${splitId}`);
  },

  // ==================== Transfer Methods ====================

  // Create a transfer between two accounts
  createTransfer: async (data: CreateTransferData): Promise<TransferResult> => {
    const response = await apiClient.post<TransferResult>('/transactions/transfer', data);
    return response.data;
  },

  // Get the linked transaction for a transfer
  getLinkedTransaction: async (transactionId: string): Promise<Transaction | null> => {
    const response = await apiClient.get<Transaction | null>(
      `/transactions/${transactionId}/linked`,
    );
    return response.data;
  },

  // Delete a transfer (deletes both linked transactions)
  deleteTransfer: async (transactionId: string): Promise<void> => {
    await apiClient.delete(`/transactions/${transactionId}/transfer`);
  },

  // Update a transfer (updates both linked transactions)
  updateTransfer: async (
    transactionId: string,
    data: Partial<CreateTransferData>,
  ): Promise<TransferResult> => {
    const response = await apiClient.patch<TransferResult>(
      `/transactions/${transactionId}/transfer`,
      data,
    );
    return response.data;
  },

  // ==================== Reconciliation Methods ====================

  // Get reconciliation data for an account
  getReconciliationData: async (
    accountId: string,
    statementDate: string,
    statementBalance: number,
  ): Promise<ReconciliationData> => {
    const response = await apiClient.get<ReconciliationData>(
      `/transactions/reconcile/${accountId}`,
      {
        params: { statementDate, statementBalance },
      },
    );
    return response.data;
  },

  // Bulk reconcile transactions for an account
  bulkReconcile: async (
    accountId: string,
    transactionIds: string[],
    reconciledDate: string,
  ): Promise<BulkReconcileResult> => {
    const response = await apiClient.post<BulkReconcileResult>(
      `/transactions/reconcile/${accountId}`,
      { transactionIds, reconciledDate },
    );
    return response.data;
  },
};
