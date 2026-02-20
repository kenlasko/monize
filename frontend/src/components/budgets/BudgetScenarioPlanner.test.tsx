import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { BudgetScenarioPlanner } from './BudgetScenarioPlanner';
import type { CategoryBreakdown } from '@/types/budget';

const mockFormat = (amount: number) => `$${amount.toFixed(2)}`;

const mockCategories: CategoryBreakdown[] = [
  {
    budgetCategoryId: 'bc-1',
    categoryId: 'cat-1',
    categoryName: 'Groceries',
    budgeted: 500,
    spent: 350,
    remaining: 150,
    percentUsed: 70,
    isIncome: false,
    percentage: null,
  },
  {
    budgetCategoryId: 'bc-2',
    categoryId: 'cat-2',
    categoryName: 'Dining',
    budgeted: 300,
    spent: 200,
    remaining: 100,
    percentUsed: 66.67,
    isIncome: false,
    percentage: null,
  },
  {
    budgetCategoryId: 'bc-income',
    categoryId: 'cat-income',
    categoryName: 'Salary',
    budgeted: 5000,
    spent: 5000,
    remaining: 0,
    percentUsed: 100,
    isIncome: true,
    percentage: null,
  },
];

describe('BudgetScenarioPlanner', () => {
  it('renders heading', () => {
    render(
      <BudgetScenarioPlanner
        categories={mockCategories}
        totalIncome={5000}
        formatCurrency={mockFormat}
      />,
    );
    expect(screen.getByText('What-If Scenario Planner')).toBeInTheDocument();
  });

  it('shows only expense categories, not income', () => {
    render(
      <BudgetScenarioPlanner
        categories={mockCategories}
        totalIncome={5000}
        formatCurrency={mockFormat}
      />,
    );

    expect(screen.getByText('Groceries')).toBeInTheDocument();
    expect(screen.getByText('Dining')).toBeInTheDocument();
    expect(screen.queryByText('Salary')).not.toBeInTheDocument();
  });

  it('renders summary cards with correct initial values', () => {
    render(
      <BudgetScenarioPlanner
        categories={mockCategories}
        totalIncome={5000}
        formatCurrency={mockFormat}
      />,
    );

    // Current budget: 500 + 300 = 800
    expect(screen.getByTestId('current-total')).toHaveTextContent('$800.00');
    // Projected savings: 5000 - 800 = 4200
    expect(screen.getByTestId('projected-savings')).toHaveTextContent('$4200.00');
    // Savings change: 0 initially
    expect(screen.getByTestId('savings-difference')).toHaveTextContent('$0.00');
  });

  it('renders sliders for each expense category', () => {
    render(
      <BudgetScenarioPlanner
        categories={mockCategories}
        totalIncome={5000}
        formatCurrency={mockFormat}
      />,
    );

    expect(screen.getByTestId('slider-bc-1')).toBeInTheDocument();
    expect(screen.getByTestId('slider-bc-2')).toBeInTheDocument();
  });

  it('updates proposed total when slider changes', () => {
    render(
      <BudgetScenarioPlanner
        categories={mockCategories}
        totalIncome={5000}
        formatCurrency={mockFormat}
      />,
    );

    const slider = screen.getByTestId('slider-bc-1');
    fireEvent.change(slider, { target: { value: '600' } });

    // Proposed total should now be 600 + 300 = 900
    expect(screen.getByTestId('proposed-total')).toHaveTextContent('$900.00');
  });

  it('shows reset button only when changes are made', () => {
    render(
      <BudgetScenarioPlanner
        categories={mockCategories}
        totalIncome={5000}
        formatCurrency={mockFormat}
      />,
    );

    // Initially no reset button
    expect(screen.queryByTestId('reset-scenario')).not.toBeInTheDocument();

    // Make a change
    const slider = screen.getByTestId('slider-bc-1');
    fireEvent.change(slider, { target: { value: '600' } });

    // Now reset should appear
    expect(screen.getByTestId('reset-scenario')).toBeInTheDocument();
  });

  it('resets all sliders to original values', () => {
    render(
      <BudgetScenarioPlanner
        categories={mockCategories}
        totalIncome={5000}
        formatCurrency={mockFormat}
      />,
    );

    // Change value
    const slider = screen.getByTestId('slider-bc-1');
    fireEvent.change(slider, { target: { value: '600' } });

    // Reset
    fireEvent.click(screen.getByTestId('reset-scenario'));

    // Proposed total should be back to original
    expect(screen.getByTestId('proposed-total')).toHaveTextContent('$800.00');
    expect(screen.getByTestId('savings-difference')).toHaveTextContent('$0.00');
  });

  it('shows apply button when onApplyChanges provided and changes made', () => {
    const onApply = vi.fn();
    render(
      <BudgetScenarioPlanner
        categories={mockCategories}
        totalIncome={5000}
        formatCurrency={mockFormat}
        onApplyChanges={onApply}
      />,
    );

    // Initially no apply button
    expect(screen.queryByTestId('apply-scenario')).not.toBeInTheDocument();

    // Make a change
    const slider = screen.getByTestId('slider-bc-1');
    fireEvent.change(slider, { target: { value: '600' } });

    // Now apply should appear
    expect(screen.getByTestId('apply-scenario')).toBeInTheDocument();
  });

  it('calls onApplyChanges with changed categories', () => {
    const onApply = vi.fn();
    render(
      <BudgetScenarioPlanner
        categories={mockCategories}
        totalIncome={5000}
        formatCurrency={mockFormat}
        onApplyChanges={onApply}
      />,
    );

    // Change groceries
    const slider = screen.getByTestId('slider-bc-1');
    fireEvent.change(slider, { target: { value: '600' } });

    // Click apply
    fireEvent.click(screen.getByTestId('apply-scenario'));

    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledWith([
      { budgetCategoryId: 'bc-1', amount: 600 },
    ]);
  });

  it('updates savings difference correctly', () => {
    render(
      <BudgetScenarioPlanner
        categories={mockCategories}
        totalIncome={5000}
        formatCurrency={mockFormat}
      />,
    );

    // Reduce groceries from 500 to 400 (save 100 more)
    const slider = screen.getByTestId('slider-bc-1');
    fireEvent.change(slider, { target: { value: '400' } });

    expect(screen.getByTestId('savings-difference')).toHaveTextContent('+$100.00');
  });

  it('shows empty state when no expense categories', () => {
    const incomeOnly: CategoryBreakdown[] = [
      {
        budgetCategoryId: 'bc-income',
        categoryId: 'cat-income',
        categoryName: 'Salary',
        budgeted: 5000,
        spent: 5000,
        remaining: 0,
        percentUsed: 100,
        isIncome: true,
        percentage: null,
      },
    ];

    render(
      <BudgetScenarioPlanner
        categories={incomeOnly}
        totalIncome={5000}
        formatCurrency={mockFormat}
      />,
    );

    expect(screen.getByText('No expense categories to plan with.')).toBeInTheDocument();
  });
});
