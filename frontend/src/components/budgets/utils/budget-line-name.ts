import type { BudgetCategory } from '@/types/budget';

type BudgetLine = Pick<
  BudgetCategory,
  'isTransfer' | 'isIncome' | 'transferAccount' | 'category'
>;

/**
 * The display name of a budget line: a transfer income line reads "Transfers
 * from <account>" (issue #2141), a savings transfer its account, a category
 * "Parent: Child". `labels` carries the translated copy, so the helper stays
 * free of a translation hook.
 */
export function budgetLineName(
  line: BudgetLine,
  labels: { transfersFrom: (name: string) => string; unknown: string },
): string {
  if (line.isTransfer && line.transferAccount) {
    return line.isIncome
      ? labels.transfersFrom(line.transferAccount.name)
      : line.transferAccount.name;
  }
  if (!line.category) return labels.unknown;
  const { name, parent } = line.category;
  return parent ? `${parent.name}: ${name}` : name;
}
