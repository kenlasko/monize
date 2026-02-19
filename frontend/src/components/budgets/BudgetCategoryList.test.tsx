import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { BudgetCategoryList } from './BudgetCategoryList';
import type { CategoryBreakdown, BudgetCategory } from '@/types/budget';

const mockFormat = (amount: number) => `$${amount.toFixed(2)}`;

const mockCategories: CategoryBreakdown[] = [
  {
    budgetCategoryId: 'bc-1',
    categoryId: 'cat-1',
    categoryName: 'Groceries',
    budgeted: 600,
    spent: 420,
    remaining: 180,
    percentUsed: 70,
    isIncome: false,
  },
  {
    budgetCategoryId: 'bc-2',
    categoryId: 'cat-2',
    categoryName: 'Dining',
    budgeted: 300,
    spent: 180,
    remaining: 120,
    percentUsed: 60,
    isIncome: false,
  },
  {
    budgetCategoryId: 'bc-3',
    categoryId: 'cat-3',
    categoryName: 'Salary',
    budgeted: 5000,
    spent: 5000,
    remaining: 0,
    percentUsed: 100,
    isIncome: true,
  },
];

const mockBudgetCategories: BudgetCategory[] = [
  {
    id: 'bc-1',
    budgetId: 'budget-1',
    categoryId: 'cat-1',
    category: { id: 'cat-1', name: 'Groceries', isIncome: false },
    categoryGroup: null,
    amount: 600,
    isIncome: false,
    rolloverType: 'NONE',
    rolloverCap: null,
    flexGroup: null,
    alertWarnPercent: 80,
    alertCriticalPercent: 95,
    notes: null,
    sortOrder: 0,
    createdAt: '2026-02-01',
    updatedAt: '2026-02-01',
  },
  {
    id: 'bc-2',
    budgetId: 'budget-1',
    categoryId: 'cat-2',
    category: { id: 'cat-2', name: 'Dining', isIncome: false },
    categoryGroup: null,
    amount: 300,
    isIncome: false,
    rolloverType: 'MONTHLY',
    rolloverCap: null,
    flexGroup: 'Fun Money',
    alertWarnPercent: 80,
    alertCriticalPercent: 95,
    notes: null,
    sortOrder: 1,
    createdAt: '2026-02-01',
    updatedAt: '2026-02-01',
  },
];

describe('BudgetCategoryList', () => {
  it('renders expense categories but not income categories', () => {
    render(
      <BudgetCategoryList
        categories={mockCategories}
        budgetCategories={mockBudgetCategories}
        formatCurrency={mockFormat}
      />,
    );

    expect(screen.getByText('Groceries')).toBeInTheDocument();
    expect(screen.getByText('Dining')).toBeInTheDocument();
    expect(screen.queryByText('Salary')).not.toBeInTheDocument();
  });

  it('renders heading', () => {
    render(
      <BudgetCategoryList
        categories={mockCategories}
        budgetCategories={mockBudgetCategories}
        formatCurrency={mockFormat}
      />,
    );

    expect(screen.getByText('Category Budgets')).toBeInTheDocument();
  });

  it('shows empty state when no expense categories', () => {
    const incomeOnly = mockCategories.filter((c) => c.isIncome);
    render(
      <BudgetCategoryList
        categories={incomeOnly}
        budgetCategories={[]}
        formatCurrency={mockFormat}
      />,
    );

    expect(
      screen.getByText('No expense categories in this budget.'),
    ).toBeInTheDocument();
  });

  it('sorts by % used descending by default', () => {
    render(
      <BudgetCategoryList
        categories={mockCategories}
        budgetCategories={mockBudgetCategories}
        formatCurrency={mockFormat}
      />,
    );

    const buttons = screen.getAllByRole('button');
    const categoryButtons = buttons.filter(
      (b) => b.textContent?.includes('Groceries') || b.textContent?.includes('Dining'),
    );
    // 70% (Groceries) should be first, then 60% (Dining)
    expect(categoryButtons[0].textContent).toContain('Groceries');
    expect(categoryButtons[1].textContent).toContain('Dining');
  });

  it('has a sort dropdown', () => {
    render(
      <BudgetCategoryList
        categories={mockCategories}
        budgetCategories={mockBudgetCategories}
        formatCurrency={mockFormat}
      />,
    );

    const select = screen.getByLabelText('Sort categories');
    expect(select).toBeInTheDocument();
  });

  it('can toggle sort direction', () => {
    render(
      <BudgetCategoryList
        categories={mockCategories}
        budgetCategories={mockBudgetCategories}
        formatCurrency={mockFormat}
      />,
    );

    const toggleButton = screen.getByLabelText('Sort ascending');
    fireEvent.click(toggleButton);

    // After clicking, label should change
    expect(screen.getByLabelText('Sort descending')).toBeInTheDocument();
  });

  it('calls onCategoryClick when a category row is clicked', () => {
    const handleClick = vi.fn();
    render(
      <BudgetCategoryList
        categories={mockCategories}
        budgetCategories={mockBudgetCategories}
        formatCurrency={mockFormat}
        onCategoryClick={handleClick}
      />,
    );

    const buttons = screen.getAllByRole('button');
    const groceriesButton = buttons.find((b) =>
      b.textContent?.includes('Groceries'),
    );
    if (groceriesButton) fireEvent.click(groceriesButton);

    expect(handleClick).toHaveBeenCalledWith('bc-1');
  });

  it('shows flex group badge on category row', () => {
    render(
      <BudgetCategoryList
        categories={mockCategories}
        budgetCategories={mockBudgetCategories}
        formatCurrency={mockFormat}
      />,
    );

    expect(screen.getByText('Fun Money')).toBeInTheDocument();
  });
});
