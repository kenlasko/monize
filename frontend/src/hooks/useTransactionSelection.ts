'use client';

import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { Transaction, BulkUpdateData, BulkUpdateFilters } from '@/types/transaction';

interface UseTransactionSelectionReturn {
  selectedIds: Set<string>;
  selectAllMatching: boolean;
  isAllOnPageSelected: boolean;
  selectionCount: number;
  toggleTransaction: (id: string) => void;
  toggleAllOnPage: () => void;
  selectAllMatchingTransactions: () => void;
  clearSelection: () => void;
  hasSelection: boolean;
  buildSelectionPayload: () => Pick<BulkUpdateData, 'mode' | 'transactionIds' | 'filters'>;
}

export function useTransactionSelection(
  transactions: Transaction[],
  totalMatching: number,
  currentFilters: BulkUpdateFilters,
): UseTransactionSelectionReturn {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectAllMatching, setSelectAllMatching] = useState(false);

  // Track filter changes to clear selection
  const filtersRef = useRef(currentFilters);
  useEffect(() => {
    const prev = filtersRef.current;
    const changed =
      JSON.stringify(prev) !== JSON.stringify(currentFilters);
    if (changed) {
      setSelectedIds(new Set());
      setSelectAllMatching(false);
      filtersRef.current = currentFilters;
    }
  }, [currentFilters]);

  // Clear individual selections on page change (but not selectAllMatching)
  const transactionIdsKey = transactions.map(t => t.id).join(',');
  const prevTransactionIdsKey = useRef(transactionIdsKey);
  useEffect(() => {
    if (prevTransactionIdsKey.current !== transactionIdsKey && !selectAllMatching) {
      setSelectedIds(new Set());
    }
    prevTransactionIdsKey.current = transactionIdsKey;
  }, [transactionIdsKey, selectAllMatching]);

  const isAllOnPageSelected = useMemo(() => {
    if (transactions.length === 0) return false;
    return transactions.every(t => selectedIds.has(t.id));
  }, [transactions, selectedIds]);

  const selectionCount = selectAllMatching
    ? totalMatching
    : selectedIds.size;

  const hasSelection = selectionCount > 0;

  const toggleTransaction = useCallback((id: string) => {
    if (selectAllMatching) {
      // Switching out of selectAllMatching mode - select all on current page minus this one
      const newIds = new Set(transactions.map(t => t.id));
      newIds.delete(id);
      setSelectedIds(newIds);
      setSelectAllMatching(false);
      return;
    }

    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, [selectAllMatching, transactions]);

  const toggleAllOnPage = useCallback(() => {
    if (isAllOnPageSelected) {
      // Deselect all on page
      setSelectedIds(prev => {
        const next = new Set(prev);
        for (const t of transactions) {
          next.delete(t.id);
        }
        return next;
      });
      setSelectAllMatching(false);
    } else {
      // Select all on page
      setSelectedIds(prev => {
        const next = new Set(prev);
        for (const t of transactions) {
          next.add(t.id);
        }
        return next;
      });
    }
  }, [isAllOnPageSelected, transactions]);

  const selectAllMatchingTransactions = useCallback(() => {
    setSelectAllMatching(true);
    // Also select all on current page for visual consistency
    setSelectedIds(new Set(transactions.map(t => t.id)));
  }, [transactions]);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    setSelectAllMatching(false);
  }, []);

  const buildSelectionPayload = useCallback((): Pick<BulkUpdateData, 'mode' | 'transactionIds' | 'filters'> => {
    if (selectAllMatching) {
      return {
        mode: 'filter',
        filters: currentFilters,
      };
    }
    return {
      mode: 'ids',
      transactionIds: Array.from(selectedIds),
    };
  }, [selectAllMatching, selectedIds, currentFilters]);

  return {
    selectedIds,
    selectAllMatching,
    isAllOnPageSelected,
    selectionCount,
    toggleTransaction,
    toggleAllOnPage,
    selectAllMatchingTransactions,
    clearSelection,
    hasSelection,
    buildSelectionPayload,
  };
}
