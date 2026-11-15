import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/render';
import { BudgetPeriodDetail } from './BudgetPeriodDetail';
import type { BudgetPeriod, BudgetPeriodCategory, BudgetCategory } from '@/types/budget';
import type { UserPreferences } from '@/types/auth';
import { usePreferencesStore } from '@/store/preferencesStore';

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
  bucketId: null,
  transferAccountId: null,
  transferAccount: null,
  isTransfer: false,
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

  it('reads a closed period\'s income from the close, transfers in included (issue #2141)', () => {
    const hisaLine: BudgetPeriodCategory = {
      ...mockIncomePeriodCategory,
      id: 'bpc-hisa',
      budgetCategoryId: 'bc-hisa',
      categoryId: null,
      actualAmount: 2000,
      category: null,
      budgetCategory: {
        ...mockIncomeBudgetCategory,
        id: 'bc-hisa',
        categoryId: null,
        category: null,
        isTransfer: true,
        transferAccountId: 'acc-hisa',
        transferAccount: { id: 'acc-hisa', name: 'HISA', accountType: 'SAVINGS' },
      },
    };
    render(
      <BudgetPeriodDetail
        period={{
          ...mockPeriod,
          // 5,200 salary + 2,000 from the HISA line + 300 the toggle swept in.
          actualIncome: 7500,
          periodCategories: [mockPeriodCategory, mockIncomePeriodCategory, hisaLine],
        }}
        formatCurrency={mockFormat}
      />,
    );

    expect(screen.getByText('Transfers from HISA')).toBeInTheDocument();
    expect(screen.getByText('$7500.00')).toBeInTheDocument();
    // The part no line carries is its own row, so the rows add up to the card.
    expect(
      screen.getByText('Transfers from accounts outside this budget'),
    ).toBeInTheDocument();
    expect(screen.getByText('$300.00')).toBeInTheDocument();
  });

  it('shows no outside-transfer row when the close froze only the lines\' income', () => {
    render(
      <BudgetPeriodDetail
        period={{
          ...mockPeriod,
          actualIncome: 5200,
          periodCategories: [mockPeriodCategory, mockIncomePeriodCategory],
        }}
        formatCurrency={mockFormat}
      />,
    );

    expect(
      screen.queryByText('Transfers from accounts outside this budget'),
    ).not.toBeInTheDocument();
  });

  it('shows the outside-transfer row on a closed period with no income line', () => {
    render(
      <BudgetPeriodDetail
        period={{
          ...mockPeriod,
          actualIncome: 450,
          periodCategories: [mockPeriodCategory],
        }}
        formatCurrency={mockFormat}
      />,
    );

    expect(screen.getByText('Income Categories')).toBeInTheDocument();
    expect(
      screen.getByText('Transfers from accounts outside this budget'),
    ).toBeInTheDocument();
  });

  it('adds up an open period\'s income from its lines alone', () => {
    render(
      <BudgetPeriodDetail
        period={{
          ...mockPeriod,
          status: 'OPEN',
          actualIncome: 9999,
          periodCategories: [mockPeriodCategory, mockIncomePeriodCategory],
        }}
        formatCurrency={mockFormat}
      />,
    );

    expect(screen.queryByText('$9999.00')).not.toBeInTheDocument();
    expect(
      screen.queryByText('Transfers from accounts outside this budget'),
    ).not.toBeInTheDocument();
  });

  it('renders period status badge', () => {
    render(
      <BudgetPeriodDetail period={mockPeriod} formatCurrency={mockFormat} />,
    );

    expect(screen.getByText('CLOSED')).toBeInTheDocument();
  });

  it('renders period date range in the reader\'s date format', () => {
    // The range goes through useDateFormat(), so the reader's own format
    // decides it, not a fixed English 'MMM d, yyyy'.
    usePreferencesStore.setState({
      preferences: { dateFormat: 'YYYY-MM-DD' } as UserPreferences,
    });
    const { unmount } = render(
      <BudgetPeriodDetail period={mockPeriod} formatCurrency={mockFormat} />,
    );

    expect(screen.getByText('2026-01-01 to 2026-01-31')).toBeInTheDocument();
    expect(screen.queryByText(/Jan 31, 2026/)).toBeNull();
    // Unmounted first: a store write under a mounted tree re-renders it
    // outside act().
    unmount();
    usePreferencesStore.setState({ preferences: null });
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
      // A close with no line froze no income; income without a line is the
      // toggle's, covered above.
      actualIncome: 0,
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

  describe('buckets table', () => {
    const periodBucket = {
      id: 'pb-1',
      budgetPeriodId: 'period-1',
      bucketId: 'b-1',
      bucketName: 'Needs',
      targetType: 'PERCENT' as const,
      targetValue: 50,
      incomeBasis: 5000,
      allocatedAmount: 2500 as number | null,
      carryIn: 100,
      actualAmount: 2300,
      carryOut: 300,
      createdAt: '2026-01-01',
      updatedAt: '2026-02-01',
    };

    it('shows the frozen figures of a closed period', () => {
      render(
        <BudgetPeriodDetail
          period={{ ...mockPeriod, periodBuckets: [periodBucket] }}
          formatCurrency={mockFormat}
        />,
      );

      expect(screen.getByRole('heading', { name: 'Buckets' })).toBeInTheDocument();
      expect(screen.getByText('Needs')).toBeInTheDocument();
      expect(screen.getByText('50% of income')).toBeInTheDocument();
      expect(screen.getByText('$2500.00')).toBeInTheDocument();
      expect(screen.getByText('$100.00')).toBeInTheDocument();
      expect(screen.getByText('$2300.00')).toBeInTheDocument();
      expect(screen.getByText('$300.00')).toBeInTheDocument();
    });

    it('renders an unknown allocation as a label, not zero', () => {
      render(
        <BudgetPeriodDetail
          period={{
            ...mockPeriod,
            periodBuckets: [{ ...periodBucket, allocatedAmount: null }],
          }}
          formatCurrency={mockFormat}
        />,
      );

      expect(screen.getByText('Unknown')).toBeInTheDocument();
      expect(screen.queryByText('$0.00')).toBeNull();
    });

    it('is not shown for an open period', () => {
      render(
        <BudgetPeriodDetail
          period={{ ...mockPeriod, status: 'OPEN', periodBuckets: [periodBucket] }}
          formatCurrency={mockFormat}
        />,
      );

      expect(screen.queryByRole('heading', { name: 'Buckets' })).toBeNull();
    });

    it('is not shown when there are no rows', () => {
      render(
        <BudgetPeriodDetail
          period={{ ...mockPeriod, periodBuckets: [] }}
          formatCurrency={mockFormat}
        />,
      );

      expect(screen.queryByRole('heading', { name: 'Buckets' })).toBeNull();
    });
  });
});
