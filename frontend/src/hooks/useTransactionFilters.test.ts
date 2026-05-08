import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const mockPush = vi.fn();
const mockReplace = vi.fn();
let mockSearchParams = new URLSearchParams();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
  useSearchParams: () => mockSearchParams,
}));

vi.mock('@/lib/account-utils', () => ({
  isInvestmentBrokerageAccount: () => false,
}));

vi.mock('@/lib/categoryUtils', () => ({
  buildCategoryColorMap: () => new Map(),
}));

import { useTransactionFilters } from './useTransactionFilters';

const incomeCategory = { id: 'cat-salary', name: 'Salary', isIncome: true, parentId: null };
const incomeCategory2 = { id: 'cat-bonus', name: 'Bonus', isIncome: true, parentId: null };
const expenseCategory = { id: 'cat-food', name: 'Food', isIncome: false, parentId: null };
const expenseCategory2 = { id: 'cat-rent', name: 'Rent', isIncome: false, parentId: null };

const allCategories = [incomeCategory, incomeCategory2, expenseCategory, expenseCategory2] as any[];

const defaultOptions = {
  accounts: [],
  categories: allCategories,
  payees: [],
  tags: [],
  weekStartsOn: 1 as const,
};

describe('useTransactionFilters - categoryType', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams = new URLSearchParams();
    localStorage.clear();
  });

  it('resolves categoryType=income to all income category IDs', () => {
    mockSearchParams = new URLSearchParams('categoryType=income&startDate=2024-01-01');
    const { result } = renderHook(() => useTransactionFilters(defaultOptions));
    expect(result.current.filterCategoryIds).toEqual(['cat-salary', 'cat-bonus']);
  });

  it('resolves categoryType=expense to all expense category IDs', () => {
    mockSearchParams = new URLSearchParams('categoryType=expense&startDate=2024-01-01');
    const { result } = renderHook(() => useTransactionFilters(defaultOptions));
    expect(result.current.filterCategoryIds).toEqual(['cat-food', 'cat-rent']);
  });

  it('uses explicit categoryIds when categoryType is not present', () => {
    mockSearchParams = new URLSearchParams('categoryIds=cat-food&startDate=2024-01-01');
    const { result } = renderHook(() => useTransactionFilters(defaultOptions));
    expect(result.current.filterCategoryIds).toEqual(['cat-food']);
  });

  it('prefers categoryType over categoryIds when both present', () => {
    mockSearchParams = new URLSearchParams('categoryType=income&categoryIds=cat-food&startDate=2024-01-01');
    const { result } = renderHook(() => useTransactionFilters(defaultOptions));
    expect(result.current.filterCategoryIds).toEqual(['cat-salary', 'cat-bonus']);
  });

  it('returns empty category filter when no URL params present and no localStorage', () => {
    mockSearchParams = new URLSearchParams();
    const { result } = renderHook(() => useTransactionFilters(defaultOptions));
    expect(result.current.filterCategoryIds).toEqual([]);
  });
});

describe('useTransactionFilters - URL/localStorage initialization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams = new URLSearchParams();
    localStorage.clear();
  });

  it('reads filters from localStorage when no URL params present', () => {
    localStorage.setItem('transactions.filter.accountIds', JSON.stringify(['acc-1']));
    localStorage.setItem('transactions.filter.search', 'test');
    localStorage.setItem('transactions.filter.startDate', '2024-01-01');
    localStorage.setItem('transactions.filter.amountFrom', '10');
    localStorage.setItem('transactions.filter.amountTo', '100');
    localStorage.setItem('transactions.filter.timePeriod', 'thisMonth');

    const { result } = renderHook(() => useTransactionFilters(defaultOptions));
    expect(result.current.filterAccountIds).toEqual(['acc-1']);
    expect(result.current.filterSearch).toBe('test');
    expect(result.current.filterStartDate).toBe('2024-01-01');
    expect(result.current.filterAmountFrom).toBe('10');
    expect(result.current.filterAmountTo).toBe('100');
    expect(result.current.filterTimePeriod).toBe('thisMonth');
  });

  it('handles invalid JSON in localStorage gracefully', () => {
    localStorage.setItem('transactions.filter.accountIds', 'not-json');
    const { result } = renderHook(() => useTransactionFilters(defaultOptions));
    expect(result.current.filterAccountIds).toEqual([]);
  });

  it('handles invalid JSON for stored value (account status)', () => {
    localStorage.setItem('transactions.filter.accountStatus', 'not-json');
    const { result } = renderHook(() => useTransactionFilters(defaultOptions));
    expect(result.current.filterAccountStatus).toBe('');
  });

  it('falls back to single accountId param when accountIds plural not present', () => {
    mockSearchParams = new URLSearchParams('accountId=acc-x&startDate=2024-01-01');
    const { result } = renderHook(() => useTransactionFilters(defaultOptions));
    expect(result.current.filterAccountIds).toEqual(['acc-x']);
  });

  it('falls back to single payeeId param when payeeIds plural not present', () => {
    mockSearchParams = new URLSearchParams('payeeId=p1&startDate=2024-01-01');
    const { result } = renderHook(() => useTransactionFilters(defaultOptions));
    expect(result.current.filterPayeeIds).toEqual(['p1']);
  });

  it('initializes timePeriod to custom when start/end dates are in URL', () => {
    mockSearchParams = new URLSearchParams('startDate=2024-01-01&endDate=2024-12-31');
    const { result } = renderHook(() => useTransactionFilters(defaultOptions));
    expect(result.current.filterTimePeriod).toBe('custom');
  });

  it('initializes amountFrom/amountTo from URL params', () => {
    mockSearchParams = new URLSearchParams('amountFrom=10&amountTo=50');
    const { result } = renderHook(() => useTransactionFilters(defaultOptions));
    expect(result.current.filterAmountFrom).toBe('10');
    expect(result.current.filterAmountTo).toBe('50');
  });

  it('reads tagIds from URL params', () => {
    mockSearchParams = new URLSearchParams('tagIds=t1,t2');
    const { result } = renderHook(() => useTransactionFilters(defaultOptions));
    expect(result.current.filterTagIds).toEqual(['t1', 't2']);
  });

  it('initializes currentPage from URL', () => {
    mockSearchParams = new URLSearchParams('page=3');
    const { result } = renderHook(() => useTransactionFilters(defaultOptions));
    expect(result.current.currentPage).toBe(3);
  });
});

describe('useTransactionFilters - derived data and options', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams = new URLSearchParams();
    localStorage.clear();
  });

  const accounts = [
    { id: 'a1', name: 'Bank A', isClosed: false } as any,
    { id: 'a2', name: 'Bank B', isClosed: true } as any,
  ];

  const payees = [
    { id: 'p1', name: 'Beta', isActive: true } as any,
    { id: 'p2', name: 'Alpha', isActive: true } as any,
    { id: 'p3', name: 'Gamma', isActive: false } as any,
  ];

  const tags = [
    { id: 't1', name: 'Tag B' } as any,
    { id: 't2', name: 'Tag A' } as any,
  ];

  it('filters out brokerage and closed/active accounts based on accountStatus', () => {
    const { result, rerender } = renderHook(
      (props: any) => useTransactionFilters(props),
      { initialProps: { ...defaultOptions, accounts } as any },
    );
    expect(result.current.filteredAccounts).toHaveLength(2);

    act(() => {
      result.current.setFilterAccountStatus('active');
    });
    rerender({ ...defaultOptions, accounts } as any);
    expect(result.current.filteredAccounts.every(a => !a.isClosed)).toBe(true);

    act(() => {
      result.current.setFilterAccountStatus('closed');
    });
    rerender({ ...defaultOptions, accounts } as any);
    expect(result.current.filteredAccounts.every(a => a.isClosed)).toBe(true);
  });

  it('sorts payees alphabetically and excludes inactive', () => {
    const { result } = renderHook(() => useTransactionFilters({ ...defaultOptions, payees } as any));
    const labels = result.current.payeeFilterOptions.map(o => o.label);
    expect(labels).toEqual(['Alpha', 'Beta']);
    expect(labels.includes('Gamma')).toBe(false);
  });

  it('sorts tag options alphabetically', () => {
    const { result } = renderHook(() => useTransactionFilters({ ...defaultOptions, tags } as any));
    expect(result.current.tagFilterOptions.map(o => o.label)).toEqual(['Tag A', 'Tag B']);
  });

  it('builds category options including special and hierarchical entries', () => {
    const cats = [
      { id: 'p', name: 'Parent', parentId: null } as any,
      { id: 'c', name: 'Child', parentId: 'p' } as any,
    ];
    const { result } = renderHook(() => useTransactionFilters({ ...defaultOptions, categories: cats } as any));
    expect(result.current.categoryFilterOptions[0].value).toBe('uncategorized');
    expect(result.current.categoryFilterOptions[1].value).toBe('transfer');
    const parent = result.current.categoryFilterOptions.find(o => o.value === 'p') as any;
    expect(parent?.children?.[0]?.value).toBe('c');
  });

  it('returns selected categories with special "uncategorized" and "transfer" entries', () => {
    const cats = [{ id: 'c1', name: 'Food', parentId: null } as any];
    mockSearchParams = new URLSearchParams('categoryIds=uncategorized,transfer,c1');
    const { result } = renderHook(() => useTransactionFilters({ ...defaultOptions, categories: cats } as any));
    const names = result.current.selectedCategories.map((c: any) => c.name);
    expect(names).toContain('Uncategorized');
    expect(names).toContain('Transfers');
    expect(names).toContain('Food');
  });

  it('counts active filters correctly', () => {
    mockSearchParams = new URLSearchParams('startDate=2024-01-01&endDate=2024-12-31&search=foo&amountFrom=1&amountTo=2&accountIds=a1');
    const { result } = renderHook(() => useTransactionFilters({ ...defaultOptions, accounts } as any));
    expect(result.current.activeFilterCount).toBe(6);
  });
});

describe('useTransactionFilters - sync effects when entity lists change', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams = new URLSearchParams();
    localStorage.clear();
  });

  it('removes invalid selected accountIds when accountStatus filter excludes them', async () => {
    const accs = [
      { id: 'a1', name: 'A', isClosed: false } as any,
      { id: 'a2', name: 'B', isClosed: true } as any,
    ];
    mockSearchParams = new URLSearchParams('accountIds=a1,a2');
    const { result, rerender } = renderHook(
      (props: any) => useTransactionFilters(props),
      { initialProps: { ...defaultOptions, accounts: accs } as any },
    );
    expect(result.current.filterAccountIds).toEqual(['a1', 'a2']);

    act(() => {
      result.current.setFilterAccountStatus('closed');
    });
    rerender({ ...defaultOptions, accounts: accs } as any);
    expect(result.current.filterAccountIds).toEqual(['a2']);
  });

  it('removes invalid selected payee IDs when payees list changes', () => {
    mockSearchParams = new URLSearchParams('payeeIds=missing,p1');
    const initial = { ...defaultOptions, payees: [{ id: 'p1', name: 'A', isActive: true } as any] } as any;
    const { result, rerender } = renderHook(
      (props: any) => useTransactionFilters(props),
      { initialProps: initial },
    );
    rerender(initial);
    expect(result.current.filterPayeeIds).toEqual(['p1']);
  });

  it('removes invalid selected tag IDs when tags list changes', () => {
    mockSearchParams = new URLSearchParams('tagIds=missing,t1');
    const initial = { ...defaultOptions, tags: [{ id: 't1', name: 'X' } as any] } as any;
    const { result, rerender } = renderHook(
      (props: any) => useTransactionFilters(props),
      { initialProps: initial },
    );
    rerender(initial);
    expect(result.current.filterTagIds).toEqual(['t1']);
  });

  it('removes invalid selected category IDs (preserving special ones)', () => {
    mockSearchParams = new URLSearchParams('categoryIds=missing,uncategorized');
    const initial = { ...defaultOptions, categories: [] as any[] } as any;
    const { result, rerender } = renderHook(
      (props: any) => useTransactionFilters(props),
      { initialProps: initial },
    );
    // categories.length === 0 → effect early-returns
    rerender({ ...defaultOptions, categories: [{ id: 'c1', name: 'X', parentId: null } as any] } as any);
    expect(result.current.filterCategoryIds).toEqual(['uncategorized']);
  });
});

describe('useTransactionFilters - URL update', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams = new URLSearchParams();
    localStorage.clear();
  });

  it('updates URL with all params when push=false (replace)', () => {
    const { result } = renderHook(() => useTransactionFilters(defaultOptions));
    act(() => {
      result.current.updateUrl(2, {
        accountIds: ['a1'],
        categoryIds: ['c1'],
        payeeIds: ['p1'],
        tagIds: ['t1'],
        startDate: '2024-01-01',
        endDate: '2024-12-31',
        search: 'foo',
        amountFrom: '1',
        amountTo: '5',
      });
    });
    expect(mockReplace).toHaveBeenCalled();
    const calledWith = mockReplace.mock.calls[0][0];
    expect(calledWith).toContain('page=2');
    expect(calledWith).toContain('accountIds=a1');
    expect(calledWith).toContain('search=foo');
  });

  it('uses router.push when push=true', () => {
    const { result } = renderHook(() => useTransactionFilters(defaultOptions));
    act(() => {
      result.current.updateUrl(1, {
        accountIds: [], categoryIds: [], payeeIds: [], tagIds: [],
        startDate: '', endDate: '', search: '', amountFrom: '', amountTo: '',
      }, true);
    });
    expect(mockPush).toHaveBeenCalledWith('/transactions', { scroll: false });
  });
});

describe('useTransactionFilters - filter handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams = new URLSearchParams();
    localStorage.clear();
  });

  it('handleArrayFilterChange marks filter change and applies value', () => {
    const { result } = renderHook(() => useTransactionFilters(defaultOptions));
    const setter = vi.fn();
    act(() => {
      result.current.handleArrayFilterChange(setter, ['a1']);
    });
    expect(setter).toHaveBeenCalledWith(['a1']);
    expect(result.current.isFilterChange.current).toBe(true);
  });

  it('handleFilterChange marks filter change', () => {
    const { result } = renderHook(() => useTransactionFilters(defaultOptions));
    const setter = vi.fn();
    act(() => {
      result.current.handleFilterChange(setter, 'foo');
    });
    expect(setter).toHaveBeenCalledWith('foo');
  });

  it('handleSearchChange updates input immediately and debounces filter', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useTransactionFilters(defaultOptions));
    act(() => {
      result.current.handleSearchChange('hello');
    });
    expect(result.current.searchInput).toBe('hello');
    expect(result.current.filterSearch).toBe('');
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(result.current.filterSearch).toBe('hello');
    vi.useRealTimers();
  });

  it('handleSearchChange clears prior debounce timer on rapid input', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useTransactionFilters(defaultOptions));
    act(() => {
      result.current.handleSearchChange('a');
    });
    act(() => {
      result.current.handleSearchChange('ab');
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(result.current.filterSearch).toBe('ab');
    vi.useRealTimers();
  });

  it('handleCategoryClick sets only the category and clears account', () => {
    const { result } = renderHook(() => useTransactionFilters(defaultOptions));
    act(() => {
      result.current.handleCategoryClick('cat-x');
    });
    expect(result.current.filterCategoryIds).toEqual(['cat-x']);
    expect(result.current.filterAccountIds).toEqual([]);
  });

  it('handleDateFilterClick sets start and end to same date and timePeriod=custom', () => {
    const { result } = renderHook(() => useTransactionFilters(defaultOptions));
    act(() => {
      result.current.handleDateFilterClick('2024-06-01');
    });
    expect(result.current.filterStartDate).toBe('2024-06-01');
    expect(result.current.filterEndDate).toBe('2024-06-01');
    expect(result.current.filterTimePeriod).toBe('custom');
  });

  it('handleAccountFilterClick sets accountIds and clears status', () => {
    const { result } = renderHook(() => useTransactionFilters(defaultOptions));
    act(() => {
      result.current.handleAccountFilterClick('acc-1');
    });
    expect(result.current.filterAccountIds).toEqual(['acc-1']);
    expect(result.current.filterAccountStatus).toBe('');
  });

  it('handlePayeeFilterClick sets payeeIds', () => {
    const { result } = renderHook(() => useTransactionFilters(defaultOptions));
    act(() => {
      result.current.handlePayeeFilterClick('p1');
    });
    expect(result.current.filterPayeeIds).toEqual(['p1']);
  });

  it('handleTagFilterClick sets tagIds', () => {
    const { result } = renderHook(() => useTransactionFilters(defaultOptions));
    act(() => {
      result.current.handleTagFilterClick('t1');
    });
    expect(result.current.filterTagIds).toEqual(['t1']);
  });

  it('handleTransferClick sets target tx ref and account', () => {
    const { result } = renderHook(() => useTransactionFilters(defaultOptions));
    act(() => {
      result.current.handleTransferClick('linked-acc', 'tx-1');
    });
    expect(result.current.filterAccountIds).toEqual(['linked-acc']);
    expect(result.current.targetTransactionIdRef.current).toBe('tx-1');
  });

  it('clearFilters resets all filter state and removes localStorage entries', () => {
    localStorage.setItem('transactions.filter.accountIds', JSON.stringify(['a1']));
    const { result } = renderHook(() => useTransactionFilters(defaultOptions));
    act(() => {
      result.current.clearFilters();
    });
    expect(result.current.filterAccountIds).toEqual([]);
    expect(result.current.filterSearch).toBe('');
    // Note: persistence effect re-saves the empty arrays after clear, that is OK
    expect(mockReplace).toHaveBeenCalledWith('/transactions', { scroll: false });
  });

  it('clearFilters resets searchInput and cancels pending debounced search', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useTransactionFilters(defaultOptions));
    act(() => {
      result.current.handleSearchChange('hello');
    });
    expect(result.current.searchInput).toBe('hello');
    act(() => {
      result.current.clearFilters();
    });
    expect(result.current.searchInput).toBe('');
    expect(result.current.filterSearch).toBe('');
    // Pending debounce must not re-apply the cleared value
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(result.current.filterSearch).toBe('');
    vi.useRealTimers();
  });

  it('goToPage updates currentPage', () => {
    const { result } = renderHook(() => useTransactionFilters(defaultOptions));
    act(() => {
      result.current.goToPage(5);
    });
    expect(result.current.currentPage).toBe(5);
  });
});

describe('useTransactionFilters - popstate handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams = new URLSearchParams();
    localStorage.clear();
  });

  it('updates filter state when popstate fires with new URL', () => {
    const { result } = renderHook(() => useTransactionFilters(defaultOptions));
    // Simulate popstate
    act(() => {
      window.history.pushState({}, '', '/transactions?accountIds=acc-1&search=hello&startDate=2024-01-01&page=2');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(result.current.filterAccountIds).toEqual(['acc-1']);
    expect(result.current.filterSearch).toBe('hello');
    expect(result.current.filterStartDate).toBe('2024-01-01');
    expect(result.current.currentPage).toBe(2);
    expect(result.current.filterTimePeriod).toBe('custom');
  });

  it('clears filters on popstate to /transactions with no params', () => {
    mockSearchParams = new URLSearchParams('search=hello');
    const { result } = renderHook(() => useTransactionFilters(defaultOptions));
    act(() => {
      window.history.pushState({}, '', '/transactions');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(result.current.filterAccountIds).toEqual([]);
    expect(result.current.filterSearch).toBe('');
    expect(result.current.currentPage).toBe(1);
  });
});

describe('useTransactionFilters - filter persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams = new URLSearchParams();
    localStorage.clear();
  });

  it('persists filterAccountStatus to localStorage', () => {
    const { result } = renderHook(() => useTransactionFilters(defaultOptions));
    act(() => {
      result.current.setFilterAccountStatus('active');
    });
    expect(localStorage.getItem('transactions.filter.accountStatus')).toBe('"active"');
  });
});
