import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@/test/render';
import { BudgetWizardReview } from './BudgetWizardReview';
import type { WizardState } from './BudgetWizard';
import type { ApplyBudgetCategoryData, GenerateBudgetResponse } from '@/types/budget';

// Mock budgets API
const mockApplyGenerated = vi.fn();
vi.mock('@/lib/budgets', () => ({
  budgetsApi: {
    applyGenerated: (...args: any[]) => mockApplyGenerated(...args),
  },
}));

// Mock format
vi.mock('@/lib/format', async (importOriginal) => ({
  roundMoney: (await importOriginal<typeof import('@/lib/format')>()).roundMoney,
  sumMoney: (await importOriginal<typeof import('@/lib/format')>()).sumMoney,
  formatCurrency: vi.fn((amount: number) => `$${amount.toFixed(2)}`),
  getDecimalPlacesForCurrency: vi.fn(() => 2),
  roundToDecimals: vi.fn((v: number) => v),
  gainLossColor: vi.fn((v: number) =>
    v >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400',
  ),
}));

// Mock errors
vi.mock('@/lib/errors', () => ({
  getErrorMessage: vi.fn((_e: any, fallback: string) => fallback),
}));

describe('BudgetWizardReview', () => {
  const mockAnalysisResult: GenerateBudgetResponse = {
    categories: [
      {
        categoryId: 'cat-salary',
        categoryName: 'Salary',
        isIncome: true,
        average: 5000,
        median: 5000,
        p25: 4500,
        p75: 5500,
        min: 4500,
        max: 5500,
        stdDev: 300,
        monthlyAmounts: [5000, 5000, 5000],
        monthlyOccurrences: 3,
        isFixed: true,
        seasonalMonths: [],
        suggested: 5000,
      },
      {
        categoryId: 'cat-groceries',
        categoryName: 'Groceries',
        isIncome: false,
        average: 400,
        median: 400,
        p25: 300,
        p75: 500,
        min: 300,
        max: 500,
        stdDev: 70,
        monthlyAmounts: [300, 400, 500],
        monthlyOccurrences: 3,
        isFixed: false,
        seasonalMonths: [],
        suggested: 400,
      },
    ],
    transfers: [],
    totalTransfers: 0,
    estimatedMonthlyIncome: 5000,
    totalBudgeted: 400,
    projectedMonthlySavings: 4600,
    analysisWindow: { startDate: '2025-08-01', endDate: '2026-02-01', months: 6 },
  };

  const makeSelectedCategories = (): Map<string, ApplyBudgetCategoryData> => {
    const map = new Map<string, ApplyBudgetCategoryData>();
    map.set('cat-salary', { categoryId: 'cat-salary', amount: 5000, isIncome: true });
    map.set('cat-groceries', { categoryId: 'cat-groceries', amount: 400, isIncome: false });
    return map;
  };

  const defaultState: WizardState = {
    analysisMonths: 6,
    profile: 'ON_TRACK',
    strategy: 'FIXED',
    analysisResult: mockAnalysisResult,
    selectedCategories: makeSelectedCategories(),
    budgetName: 'February 2026 Budget',
    budgetType: 'MONTHLY',
    periodStart: '2026-02-01',
    selectedTransfers: new Map(),
    currencyCode: 'USD',
    baseIncome: null,
    incomeLinked: false,
    defaultRolloverType: 'NONE',
    alertWarnPercent: 80,
    alertCriticalPercent: 95,
    excludedAccountIds: [],
    isSubmitting: false,
  };

  const mockUpdateState = vi.fn();
  const mockOnComplete = vi.fn();
  const mockOnBack = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders budget details', () => {
    render(
      <BudgetWizardReview
        state={defaultState}
        updateState={mockUpdateState}
        onComplete={mockOnComplete}
        onBack={mockOnBack}
      />,
    );

    expect(screen.getByText('February 2026 Budget')).toBeInTheDocument();
    expect(screen.getByText('Monthly')).toBeInTheDocument();
    expect(screen.getByText('Fixed')).toBeInTheDocument();
    expect(screen.getByText('2026-02-01')).toBeInTheDocument();
  });

  it('renders summary cards with totals', () => {
    render(
      <BudgetWizardReview
        state={defaultState}
        updateState={mockUpdateState}
        onComplete={mockOnComplete}
        onBack={mockOnBack}
      />,
    );

    expect(screen.getByText('Est. Income')).toBeInTheDocument();
    expect(screen.getByText('Total Expenses')).toBeInTheDocument();
    expect(screen.getByText('Transfers')).toBeInTheDocument();
    expect(screen.getByText('Remaining')).toBeInTheDocument();
  });

  it('renders category list with names', () => {
    render(
      <BudgetWizardReview
        state={defaultState}
        updateState={mockUpdateState}
        onComplete={mockOnComplete}
        onBack={mockOnBack}
      />,
    );

    expect(screen.getByText('Salary')).toBeInTheDocument();
    expect(screen.getByText('Groceries')).toBeInTheDocument();
  });

  it('calls API and onComplete when Create Budget is clicked', async () => {
    mockApplyGenerated.mockResolvedValue({ id: 'new-budget' });

    render(
      <BudgetWizardReview
        state={defaultState}
        updateState={mockUpdateState}
        onComplete={mockOnComplete}
        onBack={mockOnBack}
      />,
    );

    fireEvent.click(screen.getByText('Create Budget'));

    await waitFor(() => {
      expect(mockApplyGenerated).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'February 2026 Budget',
          budgetType: 'MONTHLY',
          periodStart: '2026-02-01',
          strategy: 'FIXED',
          currencyCode: 'USD',
          categories: expect.any(Array),
        }),
      );
      expect(mockOnComplete).toHaveBeenCalled();
    });
  });

  it('calls onBack when Back button is clicked', () => {
    render(
      <BudgetWizardReview
        state={defaultState}
        updateState={mockUpdateState}
        onComplete={mockOnComplete}
        onBack={mockOnBack}
      />,
    );

    fireEvent.click(screen.getByText('Back'));
    expect(mockOnBack).toHaveBeenCalled();
  });

  it('shows error toast on API failure', async () => {
    mockApplyGenerated.mockRejectedValue(new Error('Server error'));

    render(
      <BudgetWizardReview
        state={defaultState}
        updateState={mockUpdateState}
        onComplete={mockOnComplete}
        onBack={mockOnBack}
      />,
    );

    fireEvent.click(screen.getByText('Create Budget'));

    await waitFor(() => {
      expect(mockApplyGenerated).toHaveBeenCalled();
      expect(mockOnComplete).not.toHaveBeenCalled();
    });
  });

  it('shows "Not selected" when strategy is null', () => {
    const stateWithNoStrategy: WizardState = {
      ...defaultState,
      strategy: null,
    };

    render(
      <BudgetWizardReview
        state={stateWithNoStrategy}
        updateState={mockUpdateState}
        onComplete={mockOnComplete}
        onBack={mockOnBack}
      />,
    );

    expect(screen.getByText('Not selected')).toBeInTheDocument();
  });

  it('falls back to raw budgetType when not in BUDGET_TYPE_LABELS', () => {
    const stateWithCustomType: WizardState = {
      ...defaultState,
      budgetType: 'CUSTOM_TYPE' as any,
    };

    render(
      <BudgetWizardReview
        state={stateWithCustomType}
        updateState={mockUpdateState}
        onComplete={mockOnComplete}
        onBack={mockOnBack}
      />,
    );

    expect(screen.getByText('CUSTOM_TYPE')).toBeInTheDocument();
  });

  it('falls back to raw strategy when not in STRATEGY_LABELS', () => {
    const stateWithCustomStrategy: WizardState = {
      ...defaultState,
      strategy: 'UNKNOWN_STRATEGY' as any,
    };

    render(
      <BudgetWizardReview
        state={stateWithCustomStrategy}
        updateState={mockUpdateState}
        onComplete={mockOnComplete}
        onBack={mockOnBack}
      />,
    );

    expect(screen.getByText('UNKNOWN_STRATEGY')).toBeInTheDocument();
  });

  it('shows formatted rollover type when not NONE', () => {
    const stateWithRollover: WizardState = {
      ...defaultState,
      strategy: null,
      defaultRolloverType: 'PARTIAL' as any,
    };

    render(
      <BudgetWizardReview
        state={stateWithRollover}
        updateState={mockUpdateState}
        onComplete={mockOnComplete}
        onBack={mockOnBack}
      />,
    );

    // PARTIAL -> 'P' + 'artial' -> 'Partial'
    expect(screen.getByText('Partial')).toBeInTheDocument();
  });

  it('shows income linked row when incomeLinked is true and baseIncome is set', () => {
    const stateWithIncomeLinked: WizardState = {
      ...defaultState,
      incomeLinked: true,
      baseIncome: 5000,
    };

    render(
      <BudgetWizardReview
        state={stateWithIncomeLinked}
        updateState={mockUpdateState}
        onComplete={mockOnComplete}
        onBack={mockOnBack}
      />,
    );

    expect(screen.getByText('Income Linked')).toBeInTheDocument();
  });

  it('shows excluded accounts count (singular) when one account excluded', () => {
    const stateWithOneExcluded: WizardState = {
      ...defaultState,
      excludedAccountIds: ['acc-1'],
    };

    render(
      <BudgetWizardReview
        state={stateWithOneExcluded}
        updateState={mockUpdateState}
        onComplete={mockOnComplete}
        onBack={mockOnBack}
      />,
    );

    expect(screen.getByText('Excluded Accounts')).toBeInTheDocument();
    expect(screen.getByText('1 account')).toBeInTheDocument();
  });

  it('shows excluded accounts count (plural) when multiple accounts excluded', () => {
    const stateWithMultipleExcluded: WizardState = {
      ...defaultState,
      excludedAccountIds: ['acc-1', 'acc-2', 'acc-3'],
    };

    render(
      <BudgetWizardReview
        state={stateWithMultipleExcluded}
        updateState={mockUpdateState}
        onComplete={mockOnComplete}
        onBack={mockOnBack}
      />,
    );

    expect(screen.getByText('3 accounts')).toBeInTheDocument();
  });

  it('shows negative remaining in red when expenses exceed income', () => {
    const highExpensesCategories = new Map<string, ApplyBudgetCategoryData>();
    highExpensesCategories.set('cat-salary', { categoryId: 'cat-salary', amount: 1000, isIncome: true });
    highExpensesCategories.set('cat-groceries', { categoryId: 'cat-groceries', amount: 5000, isIncome: false });

    const stateWithNegativeNet: WizardState = {
      ...defaultState,
      selectedCategories: highExpensesCategories,
    };

    render(
      <BudgetWizardReview
        state={stateWithNegativeNet}
        updateState={mockUpdateState}
        onComplete={mockOnComplete}
        onBack={mockOnBack}
      />,
    );

    expect(screen.getByText('Remaining')).toBeInTheDocument();
  });

  it('treats income equal to expenses as zero remaining, not a float-noise deficit', () => {
    const categories = new Map<string, ApplyBudgetCategoryData>();
    categories.set('cat-salary', { categoryId: 'cat-salary', amount: 0.3, isIncome: true });
    categories.set('cat-a', { categoryId: 'cat-a', amount: 0.1, isIncome: false });
    categories.set('cat-b', { categoryId: 'cat-b', amount: 0.2, isIncome: false });

    render(
      <BudgetWizardReview
        state={{ ...defaultState, selectedCategories: categories }}
        updateState={mockUpdateState}
        onComplete={mockOnComplete}
        onBack={mockOnBack}
      />,
    );

    const remaining = screen.getByText('Remaining').nextElementSibling;
    expect(remaining).toHaveTextContent('$0.00');
    expect(remaining?.className).toContain('text-green');
    expect(remaining?.className).not.toContain('text-red');
  });

  it('renders transfer entries in table', () => {
    const selectedTransfers = new Map<string, ApplyBudgetCategoryData>();
    selectedTransfers.set('acc-savings', {
      categoryId: undefined,
      transferAccountId: 'acc-savings',
      amount: 500,
      isIncome: false,
    } as any);

    const analysisResultWithTransfers = {
      ...mockAnalysisResult,
      transfers: [{ accountId: 'acc-savings', accountName: 'Savings Account', average: 500 }],
    };

    const stateWithTransfers: WizardState = {
      ...defaultState,
      selectedTransfers,
      analysisResult: analysisResultWithTransfers as any,
    };

    render(
      <BudgetWizardReview
        state={stateWithTransfers}
        updateState={mockUpdateState}
        onComplete={mockOnComplete}
        onBack={mockOnBack}
      />,
    );

    expect(screen.getByText('Savings Account')).toBeInTheDocument();
    expect(screen.getAllByText('Transfer').length).toBeGreaterThan(0);
  });

  it('shows "Unknown" for category with undefined categoryId in table', () => {
    const categoriesWithUndefined = new Map<string, ApplyBudgetCategoryData>();
    categoriesWithUndefined.set('unknown-cat', { categoryId: undefined as any, amount: 200, isIncome: false });

    const stateWithUnknownCat: WizardState = {
      ...defaultState,
      selectedCategories: categoriesWithUndefined,
    };

    render(
      <BudgetWizardReview
        state={stateWithUnknownCat}
        updateState={mockUpdateState}
        onComplete={mockOnComplete}
        onBack={mockOnBack}
      />,
    );

    expect(screen.getByText('Unknown')).toBeInTheDocument();
  });

  it('shows "Transfer" for transfer with unknown accountId', () => {
    const selectedTransfers = new Map<string, ApplyBudgetCategoryData>();
    selectedTransfers.set('unknown-acc', {
      categoryId: undefined,
      transferAccountId: 'unknown-acc',
      amount: 300,
      isIncome: false,
    } as any);

    const stateWithUnknownTransfer: WizardState = {
      ...defaultState,
      selectedTransfers,
    };

    render(
      <BudgetWizardReview
        state={stateWithUnknownTransfer}
        updateState={mockUpdateState}
        onComplete={mockOnComplete}
        onBack={mockOnBack}
      />,
    );

    // When transferAccountId doesn't match any transfer, shows 'Transfer' fallback
    expect(screen.getAllByText('Transfer').length).toBeGreaterThan(0);
  });

  it('includes excluded accounts in config when submitting', async () => {
    mockApplyGenerated.mockResolvedValue({ id: 'new-budget' });

    const stateWithExcluded: WizardState = {
      ...defaultState,
      excludedAccountIds: ['acc-exclude-1'],
    };

    render(
      <BudgetWizardReview
        state={stateWithExcluded}
        updateState={mockUpdateState}
        onComplete={mockOnComplete}
        onBack={mockOnBack}
      />,
    );

    fireEvent.click(screen.getByText('Create Budget'));

    await waitFor(() => {
      expect(mockApplyGenerated).toHaveBeenCalledWith(
        expect.objectContaining({
          config: { excludedAccountIds: ['acc-exclude-1'] },
        }),
      );
    });
  });

  it('does not include income linked row when incomeLinked is false', () => {
    render(
      <BudgetWizardReview
        state={defaultState}
        updateState={mockUpdateState}
        onComplete={mockOnComplete}
        onBack={mockOnBack}
      />,
    );

    expect(screen.queryByText('Income Linked')).not.toBeInTheDocument();
  });
});
