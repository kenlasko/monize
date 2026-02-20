import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/render';
import { Budget503020Summary } from './Budget503020Summary';
import type { BudgetCategory, CategoryBreakdown } from '@/types/budget';

const formatCurrency = (amount: number) => `$${amount.toFixed(2)}`;

const makeBudgetCategory = (overrides: Partial<BudgetCategory> = {}): BudgetCategory =>
  ({
    id: 'bc-1',
    budgetId: 'budget-1',
    categoryId: 'cat-1',
    amount: 500,
    isIncome: false,
    rolloverType: 'NONE',
    categoryGroup: null,
    flexGroup: null,
    sortOrder: 0,
    category: { id: 'cat-1', name: 'Groceries' },
    ...overrides,
  }) as unknown as BudgetCategory;

const makeBreakdown = (overrides: Partial<CategoryBreakdown> = {}): CategoryBreakdown =>
  ({
    budgetCategoryId: 'bc-1',
    categoryName: 'Groceries',
    budgeted: 500,
    spent: 400,
    remaining: 100,
    percentUsed: 80,
    isIncome: false,
    ...overrides,
  }) as CategoryBreakdown;

describe('Budget503020Summary', () => {
  it('renders all three group labels', () => {
    render(
      <Budget503020Summary
        budgetCategories={[]}
        categoryBreakdown={[]}
        totalIncome={5000}
        formatCurrency={formatCurrency}
      />,
    );

    expect(screen.getByText('Needs')).toBeInTheDocument();
    expect(screen.getByText('Wants')).toBeInTheDocument();
    expect(screen.getByText('Savings')).toBeInTheDocument();
  });

  it('renders nothing when totalIncome is zero', () => {
    const { container } = render(
      <Budget503020Summary
        budgetCategories={[]}
        categoryBreakdown={[]}
        totalIncome={0}
        formatCurrency={formatCurrency}
      />,
    );

    expect(container.innerHTML).toBe('');
  });

  it('shows target percentages', () => {
    render(
      <Budget503020Summary
        budgetCategories={[]}
        categoryBreakdown={[]}
        totalIncome={5000}
        formatCurrency={formatCurrency}
      />,
    );

    expect(screen.getByText('Target: 50%')).toBeInTheDocument();
    expect(screen.getByText('Target: 30%')).toBeInTheDocument();
    expect(screen.getByText('Target: 20%')).toBeInTheDocument();
  });

  it('calculates group percentages from spending', () => {
    const categories = [
      makeBudgetCategory({ id: 'bc-need', categoryGroup: 'NEED' }),
      makeBudgetCategory({ id: 'bc-want', categoryGroup: 'WANT' }),
      makeBudgetCategory({ id: 'bc-save', categoryGroup: 'SAVING' }),
    ];

    const breakdown = [
      makeBreakdown({ budgetCategoryId: 'bc-need', budgeted: 2500, spent: 2000, isIncome: false }),
      makeBreakdown({ budgetCategoryId: 'bc-want', budgeted: 1500, spent: 1500, isIncome: false }),
      makeBreakdown({ budgetCategoryId: 'bc-save', budgeted: 1000, spent: 500, isIncome: false }),
    ];

    render(
      <Budget503020Summary
        budgetCategories={categories}
        categoryBreakdown={breakdown}
        totalIncome={5000}
        formatCurrency={formatCurrency}
      />,
    );

    // Needs: 2000/5000 = 40%
    expect(screen.getByText('40%')).toBeInTheDocument();
    // Wants: 1500/5000 = 30%
    expect(screen.getByText('30%')).toBeInTheDocument();
    // Savings: 500/5000 = 10%
    expect(screen.getByText('10%')).toBeInTheDocument();
  });

  it('ignores income categories in calculations', () => {
    const categories = [
      makeBudgetCategory({ id: 'bc-income', categoryGroup: 'NEED' }),
    ];

    const breakdown = [
      makeBreakdown({ budgetCategoryId: 'bc-income', budgeted: 5000, spent: 5000, isIncome: true }),
    ];

    render(
      <Budget503020Summary
        budgetCategories={categories}
        categoryBreakdown={breakdown}
        totalIncome={5000}
        formatCurrency={formatCurrency}
      />,
    );

    // All groups should show 0%
    const percentElements = screen.getAllByText('0%');
    expect(percentElements.length).toBe(3);
  });

  it('displays budgeted amounts', () => {
    const categories = [
      makeBudgetCategory({ id: 'bc-need', categoryGroup: 'NEED' }),
    ];

    const breakdown = [
      makeBreakdown({ budgetCategoryId: 'bc-need', budgeted: 2500, spent: 2000, isIncome: false }),
    ];

    render(
      <Budget503020Summary
        budgetCategories={categories}
        categoryBreakdown={breakdown}
        totalIncome={5000}
        formatCurrency={formatCurrency}
      />,
    );

    expect(screen.getByText(/Budgeted: 50%/)).toBeInTheDocument();
    expect(screen.getByText(/\$2500\.00/)).toBeInTheDocument();
  });

  it('shows heading', () => {
    render(
      <Budget503020Summary
        budgetCategories={[]}
        categoryBreakdown={[]}
        totalIncome={5000}
        formatCurrency={formatCurrency}
      />,
    );

    expect(screen.getByText('50/30/20 Allocation')).toBeInTheDocument();
  });
});
