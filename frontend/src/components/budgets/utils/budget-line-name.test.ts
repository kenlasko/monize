import { describe, it, expect } from 'vitest';
import { budgetLineName } from './budget-line-name';
import type { BudgetCategory } from '@/types/budget';

const labels = {
  transfersFrom: (name: string) => `Transfers from ${name}`,
  unknown: 'Unknown',
};

const line = (overrides: Partial<BudgetCategory>) =>
  ({
    isTransfer: false,
    isIncome: false,
    transferAccount: null,
    category: null,
    ...overrides,
  }) as BudgetCategory;

describe('budgetLineName', () => {
  const hisa = { id: 'a-1', name: 'HISA', accountType: 'SAVINGS' };

  it('names a transfer income line after its source', () => {
    expect(
      budgetLineName(line({ isTransfer: true, isIncome: true, transferAccount: hisa }), labels),
    ).toBe('Transfers from HISA');
  });

  it('names a savings transfer line by its account', () => {
    expect(budgetLineName(line({ isTransfer: true, transferAccount: hisa }), labels)).toBe('HISA');
  });

  it('names a category with its parent', () => {
    expect(
      budgetLineName(
        line({
          category: {
            id: 'c-1',
            name: 'Restaurants',
            categoryType: 'expense',
            parent: { id: 'c-0', name: 'Food' },
          },
        }),
        labels,
      ),
    ).toBe('Food: Restaurants');
    expect(
      budgetLineName(line({ category: { id: 'c-2', name: 'Salary', categoryType: 'income' } }), labels),
    ).toBe('Salary');
  });

  it('falls back when the line has neither', () => {
    expect(budgetLineName(line({ isTransfer: true }), labels)).toBe('Unknown');
  });
});
