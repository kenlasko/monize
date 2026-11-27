import { roundMoney, sumMoney } from '@/lib/format';
import type { ApplyBudgetCategoryData, CategoryAnalysis, CategoryGroup } from '@/types/budget';

/**
 * The wizard's planned figures, read the way the budget reads its actuals
 * (docs/specs/transfer-categories.md sections 6.1 and 6.2): an income line on
 * an Income or Expense category is Actual Income, a transfer income line or
 * an income line on a Transfer category is Transfer Funding, and an outgoing
 * line on a Transfer category sits with the outgoing transfer lines, never
 * with the expenses. `net` is what it was before the split.
 */
export interface WizardPlannedTotals {
  categoryIncome: number;
  transferFunding: number;
  /** Total Budget Funding. */
  totalIncome: number;
  totalExpenses: number;
  totalTransfers: number;
  net: number;
}

/** The ids of the analysed categories that are Transfer categories. */
export function transferCategoryIds(
  categories: readonly Pick<CategoryAnalysis, 'categoryId' | 'categoryType'>[] | undefined,
): ReadonlySet<string> {
  return new Set(
    (categories ?? [])
      .filter((c) => c.categoryType === 'transfer')
      .map((c) => c.categoryId),
  );
}

export function wizardPlannedTotals(input: {
  selectedCategories: ReadonlyMap<string, ApplyBudgetCategoryData>;
  selectedTransfers?: ReadonlyMap<string, ApplyBudgetCategoryData>;
  selectedIncomeTransfers?: ReadonlyMap<string, ApplyBudgetCategoryData>;
  transferCategoryIds: ReadonlySet<string>;
}): WizardPlannedTotals {
  const cats = Array.from(input.selectedCategories.values());
  const isTransferType = (c: ApplyBudgetCategoryData) =>
    c.categoryId !== undefined && input.transferCategoryIds.has(c.categoryId);
  const amounts = (rows: ApplyBudgetCategoryData[]) => rows.map((c) => c.amount);

  const categoryIncome = sumMoney(
    amounts(cats.filter((c) => c.isIncome && !isTransferType(c))),
  );
  const transferFunding = sumMoney([
    ...amounts(cats.filter((c) => c.isIncome && isTransferType(c))),
    ...amounts(Array.from(input.selectedIncomeTransfers?.values() ?? [])),
  ]);
  const totalIncome = sumMoney([categoryIncome, transferFunding]);
  const totalExpenses = sumMoney(
    amounts(cats.filter((c) => !c.isIncome && !isTransferType(c))),
  );
  const totalTransfers = sumMoney([
    ...amounts(Array.from(input.selectedTransfers?.values() ?? [])),
    ...amounts(cats.filter((c) => !c.isIncome && isTransferType(c))),
  ]);

  return {
    categoryIncome,
    transferFunding,
    totalIncome,
    totalExpenses,
    totalTransfers,
    net: roundMoney(totalIncome - totalExpenses - totalTransfers),
  };
}

/**
 * The 50/30/20 group an outgoing analysed line starts in: a Transfer
 * category's line is a saving, as a per-account transfer line is; every other
 * line starts as a need.
 */
export function wizardDefaultGroup(
  cat: Pick<CategoryAnalysis, 'categoryType'>,
): CategoryGroup {
  return cat.categoryType === 'transfer' ? 'SAVING' : 'NEED';
}
