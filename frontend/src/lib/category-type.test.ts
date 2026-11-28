import { describe, it, expect } from 'vitest';
import {
  categoriesForHolder,
  categoryFitsHolder,
  categoryTypeOf,
  categoryTypeOrUndefined,
  isExpenseCategory,
  isIncomeCategory,
  isTransferCategory,
  signByCategoryType,
} from './category-type';

describe('category type', () => {
  it('reads the type', () => {
    expect(categoryTypeOf({ categoryType: 'transfer' })).toBe('transfer');
    expect(categoryTypeOf({ categoryType: 'income' })).toBe('income');
    expect(categoryTypeOf({ categoryType: 'expense' })).toBe('expense');
  });

  it('answers undefined for a value that carries no type, never a guessed expense', () => {
    expect(categoryTypeOrUndefined({})).toBeUndefined();
    expect(categoryTypeOrUndefined({ categoryType: null })).toBeUndefined();
    expect(categoryTypeOrUndefined({ categoryType: 'income' })).toBe('income');
  });

  it('never reads a Transfer category as an expense or as income', () => {
    const transfer = { categoryType: 'transfer' } as const;
    expect(isTransferCategory(transfer)).toBe(true);
    expect(isExpenseCategory(transfer)).toBe(false);
    expect(isIncomeCategory(transfer)).toBe(false);
  });

  it('signs income positive and expense negative, whatever sign was typed', () => {
    expect(signByCategoryType({ categoryType: 'income' }, 5)).toBe(5);
    expect(signByCategoryType({ categoryType: 'income' }, -5)).toBe(5);
    expect(signByCategoryType({ categoryType: 'expense' }, 5)).toBe(-5);
    expect(signByCategoryType({ categoryType: 'expense' }, -5)).toBe(-5);
  });

  it('leaves a Transfer category amount exactly as typed, negative or positive', () => {
    expect(signByCategoryType({ categoryType: 'transfer' }, -1000)).toBe(-1000);
    expect(signByCategoryType({ categoryType: 'transfer' }, 1000)).toBe(1000);
  });

  describe('what a row may hold (INV-CATEGORY-001)', () => {
    const food = { id: 'f', categoryType: 'expense' } as const;
    const salary = { id: 's', categoryType: 'income' } as const;
    const savings = { id: 't', categoryType: 'transfer' } as const;

    it('fits any type on a transfer and only Income or Expense elsewhere', () => {
      expect(categoryFitsHolder(savings, 'transfer')).toBe(true);
      expect(categoryFitsHolder(food, 'transfer')).toBe(true);
      expect(categoryFitsHolder(savings, 'category')).toBe(false);
      expect(categoryFitsHolder(salary, 'category')).toBe(true);
    });

    it('offers a transfer every type, Transfer categories first, and a category row no Transfer category', () => {
      expect(categoriesForHolder([food, savings, salary], 'transfer').map((c) => c.id)).toEqual(['t', 'f', 's']);
      expect(categoriesForHolder([food, savings, salary], 'category').map((c) => c.id)).toEqual(['f', 's']);
    });
  });
});
