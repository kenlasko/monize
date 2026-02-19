import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/render';
import { BudgetFlexGroupCard } from './BudgetFlexGroupCard';
import type { CategoryBreakdown, BudgetCategory } from '@/types/budget';

const mockFormat = (amount: number) => `$${amount.toFixed(2)}`;

const mockCategories: CategoryBreakdown[] = [
  {
    budgetCategoryId: 'bc-1',
    categoryId: 'cat-1',
    categoryName: 'Dining',
    budgeted: 300,
    spent: 180,
    remaining: 120,
    percentUsed: 60,
    isIncome: false,
  },
  {
    budgetCategoryId: 'bc-2',
    categoryId: 'cat-2',
    categoryName: 'Entertainment',
    budgeted: 200,
    spent: 45,
    remaining: 155,
    percentUsed: 22.5,
    isIncome: false,
  },
  {
    budgetCategoryId: 'bc-3',
    categoryId: 'cat-3',
    categoryName: 'Groceries',
    budgeted: 600,
    spent: 420,
    remaining: 180,
    percentUsed: 70,
    isIncome: false,
  },
];

const mockBudgetCategories: BudgetCategory[] = [
  {
    id: 'bc-1',
    budgetId: 'budget-1',
    categoryId: 'cat-1',
    category: { id: 'cat-1', name: 'Dining', isIncome: false },
    categoryGroup: null,
    transferAccountId: null,
    transferAccount: null,
    isTransfer: false,
    amount: 300,
    isIncome: false,
    rolloverType: 'NONE',
    rolloverCap: null,
    flexGroup: 'Fun Money',
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
    category: { id: 'cat-2', name: 'Entertainment', isIncome: false },
    categoryGroup: null,
    transferAccountId: null,
    transferAccount: null,
    isTransfer: false,
    amount: 200,
    isIncome: false,
    rolloverType: 'NONE',
    rolloverCap: null,
    flexGroup: 'Fun Money',
    alertWarnPercent: 80,
    alertCriticalPercent: 95,
    notes: null,
    sortOrder: 1,
    createdAt: '2026-02-01',
    updatedAt: '2026-02-01',
  },
  {
    id: 'bc-3',
    budgetId: 'budget-1',
    categoryId: 'cat-3',
    category: { id: 'cat-3', name: 'Groceries', isIncome: false },
    categoryGroup: null,
    transferAccountId: null,
    transferAccount: null,
    isTransfer: false,
    amount: 600,
    isIncome: false,
    rolloverType: 'NONE',
    rolloverCap: null,
    flexGroup: null,
    alertWarnPercent: 80,
    alertCriticalPercent: 95,
    notes: null,
    sortOrder: 2,
    createdAt: '2026-02-01',
    updatedAt: '2026-02-01',
  },
];

describe('BudgetFlexGroupCard', () => {
  it('renders flex group with aggregated data', () => {
    render(
      <BudgetFlexGroupCard
        categories={mockCategories}
        budgetCategories={mockBudgetCategories}
        formatCurrency={mockFormat}
      />,
    );

    expect(screen.getByText('Flex Groups')).toBeInTheDocument();
    expect(screen.getByText('Fun Money')).toBeInTheDocument();
    // Dining $180 + Entertainment $45 = $225 spent / $300 + $200 = $500 budgeted
    expect(screen.getByText(/\$225\.00/)).toBeInTheDocument();
    expect(screen.getByText(/\$500\.00/)).toBeInTheDocument();
    expect(screen.getByText(/45%/)).toBeInTheDocument();
  });

  it('shows individual category amounts within the group', () => {
    render(
      <BudgetFlexGroupCard
        categories={mockCategories}
        budgetCategories={mockBudgetCategories}
        formatCurrency={mockFormat}
      />,
    );

    expect(screen.getByText('Dining')).toBeInTheDocument();
    expect(screen.getByText('Entertainment')).toBeInTheDocument();
    // Groceries has no flex group so should not appear inside flex group list
    expect(screen.queryByText('Groceries')).not.toBeInTheDocument();
  });

  it('returns null when no flex groups exist', () => {
    const noFlexBudgetCategories = mockBudgetCategories.map((bc) => ({
      ...bc,
      flexGroup: null,
    }));

    const { container } = render(
      <BudgetFlexGroupCard
        categories={mockCategories}
        budgetCategories={noFlexBudgetCategories}
        formatCurrency={mockFormat}
      />,
    );

    expect(container.firstChild).toBeNull();
  });

  it('renders progress bar for flex group', () => {
    render(
      <BudgetFlexGroupCard
        categories={mockCategories}
        budgetCategories={mockBudgetCategories}
        formatCurrency={mockFormat}
      />,
    );

    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });

  it('excludes income categories from flex groups', () => {
    const withIncome: CategoryBreakdown[] = [
      ...mockCategories,
      {
        budgetCategoryId: 'bc-4',
        categoryId: 'cat-4',
        categoryName: 'Income',
        budgeted: 5000,
        spent: 5000,
        remaining: 0,
        percentUsed: 100,
        isIncome: true,
      },
    ];

    render(
      <BudgetFlexGroupCard
        categories={withIncome}
        budgetCategories={mockBudgetCategories}
        formatCurrency={mockFormat}
      />,
    );

    expect(screen.queryByText('Income')).not.toBeInTheDocument();
  });
});
