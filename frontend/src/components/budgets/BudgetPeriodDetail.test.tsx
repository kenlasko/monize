import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/render';
import { BudgetPeriodDetail } from './BudgetPeriodDetail';
import type { BudgetPeriod, BudgetPeriodCategory, BudgetCategory } from '@/types/budget';

vi.mock('./BudgetProgressBar', () => ({
  BudgetProgressBar: ({ percentUsed }: { percentUsed: number }) => (
    <div data-testid="progress-bar" data-percent={percentUsed} />
  ),
}));

const mockBudgetCategory: BudgetCategory = {
  id: 'bc-1',
  budgetId: 'budget-1',
  categoryId: 'cat-1',
  category: { id: 'cat-1', name: 'Groceries', isIncome: false },
  categoryGroup: null,
  amount: 500,
  isIncome: false,
  rolloverType: 'MONTHLY',
  rolloverCap: null,
  flexGroup: null,
  alertWarnPercent: 80,
  alertCriticalPercent: 95,
  notes: null,
  sortOrder: 0,
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
};

const mockIncomeBudgetCategory: BudgetCategory = {
  ...mockBudgetCategory,
  id: 'bc-income',
  categoryId: 'cat-income',
  category: { id: 'cat-income', name: 'Salary', isIncome: true },
  isIncome: true,
  amount: 5000,
};

const mockPeriodCategory: BudgetPeriodCategory = {
  id: 'bpc-1',
  budgetPeriodId: 'period-1',
  budgetCategoryId: 'bc-1',
  categoryId: 'cat-1',
  budgetedAmount: 500,
  rolloverIn: 50,
  actualAmount: 380,
  effectiveBudget: 550,
  rolloverOut: 170,
  budgetCategory: mockBudgetCategory,
  category: { id: 'cat-1', name: 'Groceries', isIncome: false },
  createdAt: '2026-01-01',
  updatedAt: '2026-02-01',
};

const mockIncomePeriodCategory: BudgetPeriodCategory = {
  id: 'bpc-income',
  budgetPeriodId: 'period-1',
  budgetCategoryId: 'bc-income',
  categoryId: 'cat-income',
  budgetedAmount: 5000,
  rolloverIn: 0,
  actualAmount: 5200,
  effectiveBudget: 5000,
  rolloverOut: 0,
  budgetCategory: mockIncomeBudgetCategory,
  category: { id: 'cat-income', name: 'Salary', isIncome: true },
  createdAt: '2026-01-01',
  updatedAt: '2026-02-01',
};

const mockPeriod: BudgetPeriod = {
  id: 'period-1',
  budgetId: 'budget-1',
  periodStart: '2026-01-01',
  periodEnd: '2026-01-31',
  actualIncome: 5200,
  actualExpenses: 380,
  totalBudgeted: 500,
  status: 'CLOSED',
  periodCategories: [mockPeriodCategory, mockIncomePeriodCategory],
  createdAt: '2026-01-01',
  updatedAt: '2026-02-01',
};

const mockFormat = (amount: number) => `$${amount.toFixed(2)}`;

describe('BudgetPeriodDetail', () => {
  it('renders period header with month and year', () => {
    render(
      <BudgetPeriodDetail period={mockPeriod} formatCurrency={mockFormat} />,
    );

    expect(screen.getByText('January 2026')).toBeInTheDocument();
  });

  it('renders period status badge', () => {
    render(
      <BudgetPeriodDetail period={mockPeriod} formatCurrency={mockFormat} />,
    );

    expect(screen.getByText('CLOSED')).toBeInTheDocument();
  });

  it('renders period date range', () => {
    render(
      <BudgetPeriodDetail period={mockPeriod} formatCurrency={mockFormat} />,
    );

    expect(screen.getByText(/Jan 1/)).toBeInTheDocument();
    expect(screen.getByText(/Jan 31, 2026/)).toBeInTheDocument();
  });

  it('renders summary cards with correct values', () => {
    render(
      <BudgetPeriodDetail period={mockPeriod} formatCurrency={mockFormat} />,
    );

    expect(screen.getByText('Total Budgeted')).toBeInTheDocument();
    expect(screen.getByText('$550.00')).toBeInTheDocument();
    expect(screen.getByText('Total Spent')).toBeInTheDocument();
    expect(screen.getByText('$380.00')).toBeInTheDocument();
    expect(screen.getByText('Under Budget')).toBeInTheDocument();
    expect(screen.getByText('Income')).toBeInTheDocument();
    expect(screen.getByText('$5200.00')).toBeInTheDocument();
    // $170.00 appears in multiple places (Under Budget card, rollover, carried forward)
    expect(screen.getAllByText('$170.00').length).toBeGreaterThanOrEqual(1);
  });

  it('renders rollover summary when rollovers exist', () => {
    render(
      <BudgetPeriodDetail period={mockPeriod} formatCurrency={mockFormat} />,
    );

    expect(screen.getByText('Rollover Summary')).toBeInTheDocument();
    expect(screen.getByText('Carried in:')).toBeInTheDocument();
    expect(screen.getByText('Carried out:')).toBeInTheDocument();
  });

  it('does not render rollover summary when no rollovers exist', () => {
    const periodNoRollover: BudgetPeriod = {
      ...mockPeriod,
      periodCategories: [
        { ...mockPeriodCategory, rolloverIn: 0, rolloverOut: 0 },
        mockIncomePeriodCategory,
      ],
    };

    render(
      <BudgetPeriodDetail
        period={periodNoRollover}
        formatCurrency={mockFormat}
      />,
    );

    expect(screen.queryByText('Rollover Summary')).not.toBeInTheDocument();
  });

  it('renders expense categories section', () => {
    render(
      <BudgetPeriodDetail period={mockPeriod} formatCurrency={mockFormat} />,
    );

    expect(screen.getByText('Expense Categories')).toBeInTheDocument();
    expect(screen.getByText('Groceries')).toBeInTheDocument();
  });

  it('renders income categories section', () => {
    render(
      <BudgetPeriodDetail period={mockPeriod} formatCurrency={mockFormat} />,
    );

    expect(screen.getByText('Income Categories')).toBeInTheDocument();
    expect(screen.getByText('Salary')).toBeInTheDocument();
  });

  it('shows rollover badge on categories with rollover in', () => {
    render(
      <BudgetPeriodDetail period={mockPeriod} formatCurrency={mockFormat} />,
    );

    expect(screen.getByText('+$50.00 rollover')).toBeInTheDocument();
  });

  it('shows carried forward amount for categories with rollover out', () => {
    render(
      <BudgetPeriodDetail period={mockPeriod} formatCurrency={mockFormat} />,
    );

    expect(screen.getByText('$170.00 carried forward')).toBeInTheDocument();
  });

  it('renders progress bars for expense categories', () => {
    render(
      <BudgetPeriodDetail period={mockPeriod} formatCurrency={mockFormat} />,
    );

    const progressBars = screen.getAllByTestId('progress-bar');
    expect(progressBars.length).toBeGreaterThanOrEqual(1);
  });

  it('handles period with no categories', () => {
    const emptyPeriod: BudgetPeriod = {
      ...mockPeriod,
      periodCategories: [],
    };

    const { container } = render(
      <BudgetPeriodDetail period={emptyPeriod} formatCurrency={mockFormat} />,
    );

    expect(container).toBeTruthy();
    expect(screen.queryByText('Expense Categories')).not.toBeInTheDocument();
    expect(screen.queryByText('Income Categories')).not.toBeInTheDocument();
  });

  it('shows Over Budget label when spending exceeds budget', () => {
    const overBudgetPeriod: BudgetPeriod = {
      ...mockPeriod,
      periodCategories: [
        {
          ...mockPeriodCategory,
          actualAmount: 700,
          effectiveBudget: 550,
          rolloverIn: 0,
          rolloverOut: 0,
        },
      ],
    };

    render(
      <BudgetPeriodDetail
        period={overBudgetPeriod}
        formatCurrency={mockFormat}
      />,
    );

    expect(screen.getByText('Over Budget')).toBeInTheDocument();
  });

  it('displays overall budget usage section', () => {
    render(
      <BudgetPeriodDetail period={mockPeriod} formatCurrency={mockFormat} />,
    );

    expect(screen.getByText('Overall Budget Usage')).toBeInTheDocument();
  });

  it('handles undefined periodCategories gracefully', () => {
    const periodWithoutCategories: BudgetPeriod = {
      ...mockPeriod,
      periodCategories: undefined,
    };

    const { container } = render(
      <BudgetPeriodDetail
        period={periodWithoutCategories}
        formatCurrency={mockFormat}
      />,
    );

    expect(container).toBeTruthy();
  });

  it('sorts expense categories by percentage used descending', () => {
    const multiCategoryPeriod: BudgetPeriod = {
      ...mockPeriod,
      periodCategories: [
        {
          ...mockPeriodCategory,
          id: 'bpc-low',
          actualAmount: 100,
          effectiveBudget: 500,
          budgetCategory: {
            ...mockBudgetCategory,
            id: 'bc-low',
            category: { id: 'cat-low', name: 'Entertainment', isIncome: false },
          },
          category: { id: 'cat-low', name: 'Entertainment', isIncome: false },
          rolloverIn: 0,
          rolloverOut: 0,
        },
        {
          ...mockPeriodCategory,
          id: 'bpc-high',
          actualAmount: 450,
          effectiveBudget: 500,
          budgetCategory: {
            ...mockBudgetCategory,
            id: 'bc-high',
            category: { id: 'cat-high', name: 'Dining', isIncome: false },
          },
          category: { id: 'cat-high', name: 'Dining', isIncome: false },
          rolloverIn: 0,
          rolloverOut: 0,
        },
      ],
    };

    render(
      <BudgetPeriodDetail
        period={multiCategoryPeriod}
        formatCurrency={mockFormat}
      />,
    );

    const categoryNames = screen.getAllByText(/Dining|Entertainment/);
    expect(categoryNames[0]).toHaveTextContent('Dining');
    expect(categoryNames[1]).toHaveTextContent('Entertainment');
  });
});
