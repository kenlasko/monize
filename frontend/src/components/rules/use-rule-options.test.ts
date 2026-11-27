import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@/test/render';
import type { RuleLookups } from '@/hooks/useRuleLookups';
import { useRuleOptions } from './use-rule-options';

vi.mock('@/hooks/useInstitutionLogos', () => ({ useInstitutionLogos: () => new Map() }));
vi.mock('@/hooks/useMainAccountName', () => ({
  useAccountOptionLabel: () => (account: { name: string }) => account.name,
}));

const category = (id: string, name: string, categoryType: string) => ({
  id,
  name,
  parentId: null,
  categoryType,
});

describe('useRuleOptions: the category pickers by what holds the category (INV-CATEGORY-001)', () => {
  const lookups = {
    accounts: [],
    payees: [],
    tags: [],
    currencyCodes: [],
    categories: [
      category('cat-food', 'Groceries', 'expense'),
      category('cat-save', 'Savings moves', 'transfer'),
    ],
  } as unknown as RuleLookups;

  it("offers a split's category line Income and Expense only, and a conversion every type, Transfer first", () => {
    const { result } = renderHook(() => useRuleOptions(lookups));
    expect(result.current.lineCategories.map((o) => o.value)).toEqual(['cat-food']);
    expect(result.current.transferCategories.map((o) => o.value)).toEqual(['cat-save', 'cat-food']);
    // `set_category` may target a transfer, so its picker keeps every type.
    expect(result.current.categories.map((o) => o.value).sort()).toEqual(['cat-food', 'cat-save']);
  });
});
