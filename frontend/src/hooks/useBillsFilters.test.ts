import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useBillsFilters } from './useBillsFilters';

describe('useBillsFilters', () => {
  beforeEach(() => {
    // Filters persist to localStorage, so reset it to keep cases isolated.
    localStorage.clear();
  });

  it('initializes with empty filters', () => {
    const { result } = renderHook(() => useBillsFilters());
    expect(result.current.nameSearch).toBe('');
    expect(result.current.selectedPayeeIds).toEqual([]);
    expect(result.current.selectedAccountIds).toEqual([]);
    expect(result.current.selectedCategoryIds).toEqual([]);
    expect(result.current.filtersExpanded).toBe(false);
    expect(result.current.activeFilterCount).toBe(0);
  });

  it('exposes a filterState object mirroring the individual filters', () => {
    const { result } = renderHook(() => useBillsFilters());
    act(() => {
      result.current.setNameSearch('rent');
      result.current.setSelectedAccountIds(['acc-1']);
    });
    expect(result.current.filterState).toEqual({
      nameSearch: 'rent',
      selectedPayeeIds: [],
      selectedAccountIds: ['acc-1'],
      selectedCategoryIds: [],
    });
  });

  it('counts each active filter group once', () => {
    const { result } = renderHook(() => useBillsFilters());
    act(() => {
      result.current.setNameSearch('rent');
      result.current.setSelectedPayeeIds(['p1']);
      result.current.setSelectedAccountIds(['a1', 'a2']);
      result.current.setSelectedCategoryIds(['c1']);
    });
    expect(result.current.activeFilterCount).toBe(4);
  });

  it('counts a type filter and clears it back to all', () => {
    const { result } = renderHook(() => useBillsFilters());
    expect(result.current.filterType).toBe('all');
    act(() => {
      result.current.setFilterType('deposits');
    });
    expect(result.current.activeFilterCount).toBe(1);
    expect(localStorage.getItem('monize-bills-filter-type')).toBe('"deposits"');
    act(() => {
      result.current.clearFilters();
    });
    expect(result.current.filterType).toBe('all');
    expect(result.current.activeFilterCount).toBe(0);
  });

  it('ignores whitespace-only name searches in the active count', () => {
    const { result } = renderHook(() => useBillsFilters());
    act(() => {
      result.current.setNameSearch('   ');
    });
    expect(result.current.activeFilterCount).toBe(0);
  });

  it('clears every filter', () => {
    const { result } = renderHook(() => useBillsFilters());
    act(() => {
      result.current.setNameSearch('rent');
      result.current.setSelectedPayeeIds(['p1']);
      result.current.setSelectedAccountIds(['a1']);
      result.current.setSelectedCategoryIds(['c1']);
    });
    act(() => {
      result.current.clearFilters();
    });
    expect(result.current.nameSearch).toBe('');
    expect(result.current.selectedPayeeIds).toEqual([]);
    expect(result.current.selectedAccountIds).toEqual([]);
    expect(result.current.selectedCategoryIds).toEqual([]);
    expect(result.current.activeFilterCount).toBe(0);
  });

  it('toggles the expanded state independently of filters', () => {
    const { result } = renderHook(() => useBillsFilters());
    act(() => {
      result.current.setFiltersExpanded(true);
    });
    expect(result.current.filtersExpanded).toBe(true);
    expect(result.current.activeFilterCount).toBe(0);
  });

  it('persists filter selections across remounts via localStorage', () => {
    const first = renderHook(() => useBillsFilters());
    act(() => {
      first.result.current.setNameSearch('rent');
      first.result.current.setSelectedPayeeIds(['p1']);
      first.result.current.setSelectedAccountIds(['a1']);
      first.result.current.setSelectedCategoryIds(['c1']);
      first.result.current.setFiltersExpanded(true);
    });
    first.unmount();

    // A fresh mount (simulating a page reload) reads the stored values.
    const second = renderHook(() => useBillsFilters());
    expect(second.result.current.nameSearch).toBe('rent');
    expect(second.result.current.selectedPayeeIds).toEqual(['p1']);
    expect(second.result.current.selectedAccountIds).toEqual(['a1']);
    expect(second.result.current.selectedCategoryIds).toEqual(['c1']);
    expect(second.result.current.filtersExpanded).toBe(true);
    expect(second.result.current.activeFilterCount).toBe(4);
  });

  it('clearing filters also clears the persisted values', () => {
    const first = renderHook(() => useBillsFilters());
    act(() => {
      first.result.current.setNameSearch('rent');
      first.result.current.setSelectedPayeeIds(['p1']);
    });
    act(() => {
      first.result.current.clearFilters();
    });
    first.unmount();

    const second = renderHook(() => useBillsFilters());
    expect(second.result.current.nameSearch).toBe('');
    expect(second.result.current.selectedPayeeIds).toEqual([]);
    expect(second.result.current.activeFilterCount).toBe(0);
  });
});
