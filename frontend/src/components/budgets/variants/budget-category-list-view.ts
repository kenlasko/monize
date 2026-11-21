import type { BudgetCategory, CategoryBreakdown } from '@/types/budget';

export type BudgetCategorySortField = 'name' | 'spent' | 'remaining' | 'percentUsed';

/**
 * What a renderer of the category budgets is handed: the rows already sorted
 * by the list, the figures each carries, and the sort state a ledger header
 * reads. Nothing here is derived by a variant.
 */
export interface BudgetCategoryListViewProps {
  rows: ReadonlyArray<{
    category: CategoryBreakdown;
    rolloverType?: BudgetCategory['rolloverType'];
    flexGroup?: BudgetCategory['flexGroup'];
  }>;
  formatCurrency: (amount: number) => string;
  pacePercent?: number;
  onCategoryClick?: (budgetCategoryId: string) => void;
  sortField: BudgetCategorySortField;
  sortDirection: 'asc' | 'desc';
  onSort: (field: BudgetCategorySortField) => void;
}
