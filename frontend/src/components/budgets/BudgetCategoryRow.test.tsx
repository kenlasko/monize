import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { BudgetCategoryRow } from './BudgetCategoryRow';
import type { CategoryBreakdown } from '@/types/budget';

const mockFormat = (amount: number) => `$${amount.toFixed(2)}`;

const baseCategory: CategoryBreakdown = {
  budgetCategoryId: 'bc-1',
  categoryId: 'cat-1',
  categoryName: 'Groceries',
  budgeted: 600,
  spent: 420,
  remaining: 180,
  percentUsed: 70,
  isIncome: false,
};

describe('BudgetCategoryRow', () => {
  it('renders category name and amounts', () => {
    render(
      <BudgetCategoryRow category={baseCategory} formatCurrency={mockFormat} />,
    );

    expect(screen.getByText('Groceries')).toBeInTheDocument();
    expect(screen.getByText('$420.00')).toBeInTheDocument();
    expect(screen.getByText('$600.00')).toBeInTheDocument();
    expect(screen.getByText('70%')).toBeInTheDocument();
  });

  it('shows remaining amount', () => {
    render(
      <BudgetCategoryRow category={baseCategory} formatCurrency={mockFormat} />,
    );

    expect(screen.getByText('$180.00 left')).toBeInTheDocument();
  });

  it('shows over budget text when over', () => {
    const overCategory: CategoryBreakdown = {
      ...baseCategory,
      spent: 700,
      remaining: -100,
      percentUsed: 116.67,
    };

    render(
      <BudgetCategoryRow category={overCategory} formatCurrency={mockFormat} />,
    );

    expect(screen.getByText('$100.00 over')).toBeInTheDocument();
    expect(screen.getByText('117%')).toBeInTheDocument();
  });

  it('shows flex group badge when provided', () => {
    render(
      <BudgetCategoryRow
        category={baseCategory}
        formatCurrency={mockFormat}
        flexGroup="Fun Money"
      />,
    );

    expect(screen.getByText('Fun Money')).toBeInTheDocument();
  });

  it('does not show flex group badge when null', () => {
    render(
      <BudgetCategoryRow
        category={baseCategory}
        formatCurrency={mockFormat}
        flexGroup={null}
      />,
    );

    expect(screen.queryByText('Fun Money')).not.toBeInTheDocument();
  });

  it('shows rollover type when not NONE', () => {
    render(
      <BudgetCategoryRow
        category={baseCategory}
        formatCurrency={mockFormat}
        rolloverType="MONTHLY"
      />,
    );

    expect(screen.getByText('Rollover: monthly')).toBeInTheDocument();
  });

  it('hides rollover type when NONE', () => {
    render(
      <BudgetCategoryRow
        category={baseCategory}
        formatCurrency={mockFormat}
        rolloverType="NONE"
      />,
    );

    expect(screen.queryByText(/Rollover/)).not.toBeInTheDocument();
  });

  it('shows pace label when pacePercent is provided', () => {
    render(
      <BudgetCategoryRow
        category={{ ...baseCategory, percentUsed: 80 }}
        formatCurrency={mockFormat}
        pacePercent={60}
      />,
    );

    expect(screen.getByText('Over pace')).toBeInTheDocument();
  });

  it('shows on pace when close to expected', () => {
    render(
      <BudgetCategoryRow
        category={{ ...baseCategory, percentUsed: 58 }}
        formatCurrency={mockFormat}
        pacePercent={60}
      />,
    );

    expect(screen.getByText('On pace')).toBeInTheDocument();
  });

  it('shows under pace when spending is lower', () => {
    render(
      <BudgetCategoryRow
        category={{ ...baseCategory, percentUsed: 40 }}
        formatCurrency={mockFormat}
        pacePercent={60}
      />,
    );

    expect(screen.getByText('Under pace')).toBeInTheDocument();
  });

  it('calls onClick when clicked', () => {
    const handleClick = vi.fn();
    render(
      <BudgetCategoryRow
        category={baseCategory}
        formatCurrency={mockFormat}
        onClick={handleClick}
      />,
    );

    fireEvent.click(screen.getByRole('button'));
    expect(handleClick).toHaveBeenCalledTimes(1);
  });

  it('renders progress bar', () => {
    render(
      <BudgetCategoryRow category={baseCategory} formatCurrency={mockFormat} />,
    );

    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });
});
