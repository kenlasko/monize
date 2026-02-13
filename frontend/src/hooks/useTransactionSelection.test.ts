import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTransactionSelection } from './useTransactionSelection';
import { Transaction, TransactionStatus, BulkUpdateFilters } from '@/types/transaction';

function createTransaction(id: string): Transaction {
  return {
    id,
    userId: 'user-1',
    accountId: 'acc-1',
    account: null,
    transactionDate: '2024-01-15',
    payeeId: null,
    payeeName: null,
    payee: null,
    categoryId: null,
    category: null,
    amount: -50,
    currencyCode: 'CAD',
    exchangeRate: 1,
    description: null,
    referenceNumber: null,
    status: TransactionStatus.UNRECONCILED,
    isCleared: false,
    isReconciled: false,
    isVoid: false,
    reconciledDate: null,
    isSplit: false,
    parentTransactionId: null,
    isTransfer: false,
    linkedTransactionId: null,
    createdAt: '2024-01-15T00:00:00Z',
    updatedAt: '2024-01-15T00:00:00Z',
  };
}

const emptyFilters: BulkUpdateFilters = {};

describe('useTransactionSelection', () => {
  const transactions = [
    createTransaction('tx-1'),
    createTransaction('tx-2'),
    createTransaction('tx-3'),
  ];

  it('starts with no selection', () => {
    const { result } = renderHook(() =>
      useTransactionSelection(transactions, 100, emptyFilters)
    );

    expect(result.current.selectedIds.size).toBe(0);
    expect(result.current.selectAllMatching).toBe(false);
    expect(result.current.hasSelection).toBe(false);
    expect(result.current.selectionCount).toBe(0);
    expect(result.current.isAllOnPageSelected).toBe(false);
  });

  it('toggleTransaction selects and deselects individual transactions', () => {
    const { result } = renderHook(() =>
      useTransactionSelection(transactions, 100, emptyFilters)
    );

    act(() => result.current.toggleTransaction('tx-1'));
    expect(result.current.selectedIds.has('tx-1')).toBe(true);
    expect(result.current.selectionCount).toBe(1);
    expect(result.current.hasSelection).toBe(true);

    act(() => result.current.toggleTransaction('tx-1'));
    expect(result.current.selectedIds.has('tx-1')).toBe(false);
    expect(result.current.selectionCount).toBe(0);
  });

  it('toggleAllOnPage selects all transactions on the current page', () => {
    const { result } = renderHook(() =>
      useTransactionSelection(transactions, 100, emptyFilters)
    );

    act(() => result.current.toggleAllOnPage());
    expect(result.current.selectedIds.size).toBe(3);
    expect(result.current.isAllOnPageSelected).toBe(true);
  });

  it('toggleAllOnPage deselects all when all are selected', () => {
    const { result } = renderHook(() =>
      useTransactionSelection(transactions, 100, emptyFilters)
    );

    act(() => result.current.toggleAllOnPage());
    expect(result.current.isAllOnPageSelected).toBe(true);

    act(() => result.current.toggleAllOnPage());
    expect(result.current.selectedIds.size).toBe(0);
    expect(result.current.isAllOnPageSelected).toBe(false);
  });

  it('selectAllMatchingTransactions enables filter-based selection', () => {
    const { result } = renderHook(() =>
      useTransactionSelection(transactions, 100, emptyFilters)
    );

    act(() => result.current.selectAllMatchingTransactions());
    expect(result.current.selectAllMatching).toBe(true);
    expect(result.current.selectionCount).toBe(100);
    // All on page should also be selected for visual consistency
    expect(result.current.isAllOnPageSelected).toBe(true);
  });

  it('clearSelection resets everything', () => {
    const { result } = renderHook(() =>
      useTransactionSelection(transactions, 100, emptyFilters)
    );

    act(() => result.current.selectAllMatchingTransactions());
    expect(result.current.selectionCount).toBe(100);

    act(() => result.current.clearSelection());
    expect(result.current.selectedIds.size).toBe(0);
    expect(result.current.selectAllMatching).toBe(false);
    expect(result.current.hasSelection).toBe(false);
  });

  it('toggleTransaction exits selectAllMatching mode', () => {
    const { result } = renderHook(() =>
      useTransactionSelection(transactions, 100, emptyFilters)
    );

    act(() => result.current.selectAllMatchingTransactions());
    expect(result.current.selectAllMatching).toBe(true);

    // Toggling one off exits filter mode, selects all on page minus that one
    act(() => result.current.toggleTransaction('tx-2'));
    expect(result.current.selectAllMatching).toBe(false);
    expect(result.current.selectedIds.has('tx-1')).toBe(true);
    expect(result.current.selectedIds.has('tx-2')).toBe(false);
    expect(result.current.selectedIds.has('tx-3')).toBe(true);
    expect(result.current.selectionCount).toBe(2);
  });

  it('clears selection when filters change', () => {
    const filters1: BulkUpdateFilters = { search: 'foo' };
    const filters2: BulkUpdateFilters = { search: 'bar' };

    const { result, rerender } = renderHook(
      ({ filters }) => useTransactionSelection(transactions, 100, filters),
      { initialProps: { filters: filters1 } }
    );

    act(() => result.current.toggleTransaction('tx-1'));
    expect(result.current.selectionCount).toBe(1);

    rerender({ filters: filters2 });
    expect(result.current.selectedIds.size).toBe(0);
    expect(result.current.selectAllMatching).toBe(false);
  });

  describe('buildSelectionPayload', () => {
    it('returns ids mode when using individual selection', () => {
      const { result } = renderHook(() =>
        useTransactionSelection(transactions, 100, emptyFilters)
      );

      act(() => result.current.toggleTransaction('tx-1'));
      act(() => result.current.toggleTransaction('tx-3'));

      const payload = result.current.buildSelectionPayload();
      expect(payload.mode).toBe('ids');
      expect(payload.transactionIds).toEqual(expect.arrayContaining(['tx-1', 'tx-3']));
      expect(payload.transactionIds).toHaveLength(2);
      expect(payload.filters).toBeUndefined();
    });

    it('returns filter mode when selectAllMatching is active', () => {
      const filters: BulkUpdateFilters = { accountIds: ['acc-1'], search: 'test' };
      const { result } = renderHook(() =>
        useTransactionSelection(transactions, 100, filters)
      );

      act(() => result.current.selectAllMatchingTransactions());

      const payload = result.current.buildSelectionPayload();
      expect(payload.mode).toBe('filter');
      expect(payload.filters).toEqual(filters);
      expect(payload.transactionIds).toBeUndefined();
    });
  });
});
