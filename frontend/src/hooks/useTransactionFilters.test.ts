import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

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
