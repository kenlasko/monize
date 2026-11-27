import { describe, it, expect } from 'vitest';
import { transferCategoryIds, wizardPlannedTotals } from './wizard-totals';
import type { ApplyBudgetCategoryData } from '@/types/budget';

const line = (data: ApplyBudgetCategoryData): [string, ApplyBudgetCategoryData] => [
  data.categoryId ?? data.transferAccountId ?? '',
  data,
];

describe('wizardPlannedTotals', () => {
  // docs/specs/transfer-categories.md section 6.5's planned lines.
  const selectedCategories = new Map([
    line({ categoryId: 'salary', amount: 5000, isIncome: true }),
    line({ categoryId: 'groceries', amount: 600, isIncome: false }),
    line({ categoryId: 'mortgage', amount: 1600, isIncome: false }),
    line({ categoryId: 'savings-contributions', amount: 500, isIncome: false }),
    line({ categoryId: 'reserve-draws', amount: 400, isIncome: true }),
  ]);
  const selectedTransfers = new Map([
    line({ transferAccountId: 'hisa', isTransfer: true, amount: 300 }),
  ]);
  const selectedIncomeTransfers = new Map([
    line({ transferAccountId: 'reserve', isTransfer: true, isIncome: true, amount: 1000 }),
  ]);
  const ids = transferCategoryIds([
    { categoryId: 'salary', categoryType: 'income' },
    { categoryId: 'groceries', categoryType: 'expense' },
    { categoryId: 'savings-contributions', categoryType: 'transfer' },
    { categoryId: 'reserve-draws', categoryType: 'transfer' },
    { categoryId: 'mortgage' },
  ]);

  it('files a Transfer category\'s lines with the transfers and the funding', () => {
    expect(
      wizardPlannedTotals({
        selectedCategories,
        selectedTransfers,
        selectedIncomeTransfers,
        transferCategoryIds: ids,
      }),
    ).toEqual({
      categoryIncome: 5000,
      transferFunding: 1400,
      totalIncome: 6400,
      totalExpenses: 2200,
      totalTransfers: 800,
      net: 3400,
    });
  });

  it('keeps every figure of a plan with no Transfer category', () => {
    expect(
      wizardPlannedTotals({
        selectedCategories,
        selectedTransfers,
        selectedIncomeTransfers,
        transferCategoryIds: new Set(),
      }),
    ).toEqual({
      categoryIncome: 5400,
      transferFunding: 1000,
      totalIncome: 6400,
      totalExpenses: 2700,
      totalTransfers: 300,
      net: 3400,
    });
  });
});
