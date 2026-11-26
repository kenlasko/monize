import { describe, it, expect } from 'vitest';
import {
  categoryTypeOf,
  isExpenseCategory,
  isIncomeCategory,
  isTransferCategory,
  signByCategoryType,
} from './category-type';

describe('category type', () => {
  it('reads the type, and the legacy flag only for a value built without one', () => {
    expect(categoryTypeOf({ categoryType: 'transfer', isIncome: false })).toBe('transfer');
    expect(categoryTypeOf({ categoryType: 'income' })).toBe('income');
    expect(categoryTypeOf({ isIncome: true })).toBe('income');
    expect(categoryTypeOf({ isIncome: false })).toBe('expense');
    expect(categoryTypeOf({})).toBe('expense');
  });

  it('never reads a Transfer category as an expense or as income', () => {
    const transfer = { categoryType: 'transfer', isIncome: false } as const;
    expect(isTransferCategory(transfer)).toBe(true);
    expect(isExpenseCategory(transfer)).toBe(false);
    expect(isIncomeCategory(transfer)).toBe(false);
  });

  it('signs income positive and expense negative, and leaves a Transfer amount as typed', () => {
    expect(signByCategoryType({ categoryType: 'income' }, 5)).toBe(5);
    expect(signByCategoryType({ categoryType: 'expense' }, 5)).toBe(-5);
    expect(signByCategoryType({ categoryType: 'transfer' }, 5)).toBe(5);
  });
});
