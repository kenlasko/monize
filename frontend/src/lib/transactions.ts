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
  BulkUpdateData,
  BulkUpdateResult,
  BulkDeleteData,
  BulkDeleteResult,
  MonthlyTotal,
  GroupedTotal,
  RecurringChargeInfo,
} from '@/types/transaction';
import { invalidateCache } from './apiCache';

/** Convert array filter params to comma-separated strings for the API. */
function buildFilterParams(params?: {
  accountId?: string;
  accountIds?: string[];
  categoryId?: string;
  categoryIds?: string[];
  payeeId?: string;
  payeeIds?: string[];
  tagIds?: string[];
}): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};

  if (params?.accountIds && params.accountIds.length > 0) {
    result.accountIds = params.accountIds.join(',');
  } else if (params?.accountId) {
    result.accountId = params.accountId;
  }

  if (params?.categoryIds && params.categoryIds.length > 0) {
    result.categoryIds = params.categoryIds.join(',');
  } else if (params?.categoryId) {
    result.categoryId = params.categoryId;
  }

  if (params?.payeeIds && params.payeeIds.length > 0) {
    result.payeeIds = params.payeeIds.join(',');
  } else if (params?.payeeId) {
    result.payeeId = params.payeeId;
  }

  if (params?.tagIds && params.tagIds.length > 0) {
    result.tagIds = params.tagIds.join(',');
  }

  return result;
}

export interface TransactionsGetAllParams {
  accountId?: string;
  accountIds?: string[];
  startDate?: string;
  endDate?: string;
  categoryId?: string;
  categoryIds?: string[];
  payeeId?: string;
  payeeIds?: string[];
  page?: number;
  limit?: number;
  search?: string;
  targetTransactionId?: string;
  amountFrom?: number;
  amountTo?: number;
  tagIds?: string[];
  statuses?: TransactionStatus[];
  /** KEY:VALUE tag filter: the key to filter on (e.g. "country"). */
  tagKey?: string;
  /** KEY:VALUE tag filter operator. */
  tagKeyOp?: 'hasValue' | 'noValue' | 'contains' | 'notContains';
  /** Substring term for the contains / notContains operators. */
  tagKeyValue?: string;
}

export const transactionsApi = {
  // Create a new transaction
  create: async (data: CreateTransactionData): Promise<Transaction> => {
    const response = await apiClient.post<Transaction>('/transactions', data);
    invalidateCache('accounts:');
    invalidateCache('investments:');
    return response.data;
  },

  // Get paginated transactions with optional filters
  getAll: async (params?: TransactionsGetAllParams): Promise<PaginatedTransactions> => {
    const apiParams = {
      ...buildFilterParams(params),
      startDate: params?.startDate,
      endDate: params?.endDate,
      page: params?.page,
      limit: params?.limit,
      search: params?.search,
      targetTransactionId: params?.targetTransactionId,
      amountFrom: params?.amountFrom,
      amountTo: params?.amountTo,
      statuses: params?.statuses && params.statuses.length > 0 ? params.statuses.join(',') : undefined,
      tagKey: params?.tagKey || undefined,
      tagKeyOp: params?.tagKey ? params?.tagKeyOp : undefined,
      tagKeyValue: params?.tagKey ? params?.tagKeyValue || undefined : undefined,
    };

    const response = await apiClient.get<PaginatedTransactions>('/transactions', {
      params: apiParams,
      timeout: 60000,
    });
    return response.data;
  },

  /**
   * Fetch every transaction matching the filters by walking the paginated
   * endpoint until `hasMore=false`. The dashboard uses this for the trend
   * chart where partial-page data would render wrong totals. Defaults to
   * the maximum page size (200) so the round-trip count stays low.
   *
   * A page cap and an empty-page guard bound the loop: if the backend ever
   * reports `hasMore=true` without returning new rows (a count/offset bug or a
   * stale-cache response), the loop would otherwise spin forever accumulating
   * duplicates. MAX_PAGES at 200 rows/page covers 1,000,000 transactions.
   */
  getAllPages: async (
    params?: TransactionsGetAllParams & { pageSize?: number },
  ): Promise<Transaction[]> => {
    const MAX_PAGES = 5000;
    const { pageSize = 200, ...rest } = params ?? {};
    const all: Transaction[] = [];
    let page = 1;
    let hasMore = true;
    while (hasMore && page <= MAX_PAGES) {
      const result = await transactionsApi.getAll({
        ...rest,
        page,
        limit: pageSize,
      });
      // Defend against a backend that returns hasMore=true on an empty page;
      // without new rows there is nothing left to fetch.
      if (result.data.length === 0) break;
      all.push(...result.data);
      hasMore = result.pagination.hasMore;
      page++;
    }
    return all;
  },

  // Quick-fill recents. Without a payee filter the backend dedups by
  // payee+category to surface variety; with payeeId or payeeName it returns
  // the raw last-N entries for that payee.
  getRecent: async (params?: {
    limit?: number;
    payeeId?: string;
    payeeName?: string;
  }): Promise<Transaction[]> => {
    const response = await apiClient.get<Transaction[]>('/transactions/recent', {
      params: {
        limit: params?.limit ?? 5,
        payeeId: params?.payeeId,
        payeeName: params?.payeeName,
      },
    });
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
    invalidateCache('accounts:');
    invalidateCache('investments:');
    return response.data;
  },

  // Delete transaction
  delete: async (id: string): Promise<void> => {
    await apiClient.delete(`/transactions/${id}`);
    invalidateCache('accounts:');
    invalidateCache('investments:');
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
    invalidateCache('accounts:');
    invalidateCache('investments:');
    return response.data;
  },

  // Get transaction summary
  getSummary: async (params?: {
    accountId?: string;
    accountIds?: string[];
    startDate?: string;
    endDate?: string;
    categoryId?: string;
    categoryIds?: string[];
    payeeId?: string;
    payeeIds?: string[];
    search?: string;
    amountFrom?: number;
    amountTo?: number;
    tagIds?: string[];
  }): Promise<TransactionSummary> => {
    const apiParams = {
      ...buildFilterParams(params),
      startDate: params?.startDate,
      endDate: params?.endDate,
      search: params?.search,
      amountFrom: params?.amountFrom,
      amountTo: params?.amountTo,
    };

    const response = await apiClient.get<TransactionSummary>('/transactions/summary', {
      params: apiParams,
      timeout: 60000,
    });
    return response.data;
  },

  // Get totals grouped by category or payee under the same filters as the summary
  getGroupedTotals: async (params: {
    groupBy: 'category' | 'payee';
    accountIds?: string[];
    startDate?: string;
    endDate?: string;
    categoryIds?: string[];
    payeeIds?: string[];
    tagIds?: string[];
    search?: string;
    amountFrom?: number;
    amountTo?: number;
    limit?: number;
  }): Promise<GroupedTotal[]> => {
    const apiParams = {
      ...buildFilterParams(params),
      groupBy: params.groupBy,
      startDate: params.startDate,
      endDate: params.endDate,
      search: params.search,
      amountFrom: params.amountFrom,
      amountTo: params.amountTo,
      limit: params.limit,
    };

    const response = await apiClient.get<GroupedTotal[]>('/transactions/grouped-totals', {
      params: apiParams,
      timeout: 60000,
    });
    return response.data;
  },

  // Spending broken down by the value of a KEY:VALUE tag key (e.g. key
  // "country" -> a total per country). Rows are per-currency, like grouped
  // totals, so the caller converts to one display currency.
  getTagKeyBreakdown: async (params: {
    key: string;
    accountIds?: string[];
    startDate?: string;
    endDate?: string;
    categoryIds?: string[];
    payeeIds?: string[];
    tagIds?: string[];
    search?: string;
    amountFrom?: number;
    amountTo?: number;
    limit?: number;
  }): Promise<GroupedTotal[]> => {
    const apiParams = {
      ...buildFilterParams(params),
      key: params.key,
      startDate: params.startDate,
      endDate: params.endDate,
      search: params.search,
      amountFrom: params.amountFrom,
      amountTo: params.amountTo,
      limit: params.limit,
    };

    const response = await apiClient.get<GroupedTotal[]>(
      '/transactions/tag-key-breakdown',
      { params: apiParams, timeout: 60000 },
    );
    return response.data;
  },

  // Detect recurring charges (cadence + typical amount) for the given payees
  getRecurringCharges: async (params: {
    payeeIds: string[];
    startDate: string;
    endDate: string;
  }): Promise<RecurringChargeInfo[]> => {
    const response = await apiClient.get<RecurringChargeInfo[]>('/transactions/recurring-charges', {
      params: {
        payeeIds: params.payeeIds.join(','),
        startDate: params.startDate,
        endDate: params.endDate,
      },
      timeout: 60000,
    });
    return response.data;
  },

  // Get monthly transaction totals (for category/payee bar chart)
  getMonthlyTotals: async (params?: {
    accountIds?: string[];
    startDate?: string;
    endDate?: string;
    categoryIds?: string[];
    payeeIds?: string[];
    search?: string;
    amountFrom?: number;
    amountTo?: number;
    tagIds?: string[];
  }): Promise<MonthlyTotal[]> => {
    const apiParams = {
      ...buildFilterParams(params),
      startDate: params?.startDate,
      endDate: params?.endDate,
      search: params?.search,
      amountFrom: params?.amountFrom,
      amountTo: params?.amountTo,
    };

    const response = await apiClient.get<MonthlyTotal[]>('/transactions/monthly-totals', {
      params: apiParams,
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
    invalidateCache('accounts:');
    invalidateCache('investments:');
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
    invalidateCache('accounts:');
    invalidateCache('investments:');
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
    invalidateCache('accounts:');
    invalidateCache('investments:');
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
    invalidateCache('accounts:');
    invalidateCache('investments:');
    return response.data;
  },

  // Bulk update transactions
  bulkUpdate: async (data: BulkUpdateData): Promise<BulkUpdateResult> => {
    const response = await apiClient.post<BulkUpdateResult>(
      '/transactions/bulk-update',
      data,
    );
    invalidateCache('accounts:');
    invalidateCache('investments:');
    return response.data;
  },

  // Bulk delete transactions
  bulkDelete: async (data: BulkDeleteData): Promise<BulkDeleteResult> => {
    const response = await apiClient.post<BulkDeleteResult>(
      '/transactions/bulk-delete',
      data,
    );
    invalidateCache('accounts:');
    invalidateCache('investments:');
    return response.data;
  },
};
