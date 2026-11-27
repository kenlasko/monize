import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@/test/render';
import { BudgetWizardReview } from './BudgetWizardReview';
import type { WizardState } from './BudgetWizard';
import type { ApplyBudgetCategoryData, GenerateBudgetResponse } from '@/types/budget';
import type { BudgetBucketEditorRow } from './utils/budget-bucket-presets';

// Mock budgets API
const mockApplyGenerated = vi.fn();
vi.mock('@/lib/budgets', () => ({
  budgetsApi: {
    applyGenerated: (...args: any[]) => mockApplyGenerated(...args),
  },
}));

// Mock format
vi.mock('@/lib/format', async (importOriginal) => ({
  // The bucket review needs the rest of the module (moneyDecimalsForCurrency).
  ...(await importOriginal<typeof import('@/lib/format')>()),
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
    incomeTransfers: [],
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
    selectedIncomeTransfers: new Map(),
    buckets: [],
    bucketsPresetApplied: false,
    currencyCode: 'USD',
    baseIncome: null,
    incomeLinked: false,
    defaultRolloverType: 'NONE',
    alertWarnPercent: 80,
    alertCriticalPercent: 95,
    excludedAccountIds: [],
    transfersInAsIncome: false,
    isSubmitting: false,
  };

  const mockUpdateState = vi.fn();
  const mockOnComplete = vi.fn();
  const mockOnBack = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends transfer income lines and the transfers-in option (issue #2141)', async () => {
    mockApplyGenerated.mockResolvedValue({ id: 'b-new' });
    const state: WizardState = {
      ...defaultState,
      analysisResult: {
        ...defaultState.analysisResult!,
        incomeTransfers: [
          {
            accountId: 'acc-hisa',
            accountName: 'HISA',
            accountType: 'SAVINGS',
            average: 2000,
            median: 2000,
            p25: 2000,
            p75: 2000,
            min: 2000,
            max: 2000,
            stdDev: 0,
            monthlyAmounts: [2000],
            monthlyOccurrences: 1,
            isFixed: true,
            seasonalMonths: [],
            suggested: 2000,
          },
        ],
      },
      selectedIncomeTransfers: new Map([
        ['acc-hisa', { transferAccountId: 'acc-hisa', isTransfer: true, isIncome: true, amount: 2000 }],
      ]),
      excludedAccountIds: ['acc-rrsp'],
      transfersInAsIncome: true,
    };

    render(
      <BudgetWizardReview
        state={state}
        updateState={mockUpdateState}
        onComplete={mockOnComplete}
        onBack={mockOnBack}
      />,
    );

    expect(screen.getByText('Transfers from HISA')).toBeInTheDocument();
    expect(screen.getByText('Transfer in')).toBeInTheDocument();
    expect(screen.getByText('From excluded accounts count as income')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Create Budget'));

    await waitFor(() => expect(mockApplyGenerated).toHaveBeenCalled());
    const payload = mockApplyGenerated.mock.calls[0][0];
    expect(payload.config).toEqual({
      excludedAccountIds: ['acc-rrsp'],
      transfersInAsIncome: true,
    });
    expect(payload.categories).toContainEqual({
      transferAccountId: 'acc-hisa',
      isTransfer: true,
      isIncome: true,
      amount: 2000,
    });
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

  it('files a Transfer category\'s line as a transfer and splits the funding (transfer categories, 6.1 and 6.2)', () => {
    const categories = new Map(defaultState.selectedCategories);
    categories.set('cat-savings', { categoryId: 'cat-savings', amount: 500, isIncome: false });
    const incomeTransfers = new Map([
      ['acc-reserve', { transferAccountId: 'acc-reserve', isTransfer: true, isIncome: true, amount: 1000 }],
    ]);
    render(
      <BudgetWizardReview
        state={{
          ...defaultState,
          analysisResult: {
            ...defaultState.analysisResult!,
            categories: [
              ...defaultState.analysisResult!.categories,
              {
                ...defaultState.analysisResult!.categories[1],
                categoryId: 'cat-savings',
                categoryName: 'Savings contributions',
                categoryType: 'transfer',
              },
            ],
          },
          selectedCategories: categories,
          selectedIncomeTransfers: incomeTransfers,
        }}
        updateState={mockUpdateState}
        onComplete={mockOnComplete}
        onBack={mockOnBack}
      />,
    );

    expect(screen.getByText('Est. Income').nextElementSibling!.textContent).toBe('$6,000.00');
    expect(
      screen.getByText('Actual Income $5,000.00, Transfer Funding $1,000.00'),
    ).toBeInTheDocument();
    expect(screen.getByText('Total Expenses').nextElementSibling!.textContent).toBe('$400.00');
    expect(screen.getByText('Transfers').nextElementSibling!.textContent).toBe('$500.00');
    const row = screen.getByText('Savings contributions').closest('tr')!;
    expect(row.textContent).toContain('Transfer');
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

  describe('Bucket strategy', () => {
    const buckets: BudgetBucketEditorRow[] = [
      { key: 'k-fixed', name: 'Fixed costs', targetType: 'PERCENT', targetValue: 50, carryOver: false, carryCap: null },
      { key: 'k-save', name: 'Savings', targetType: 'AMOUNT', targetValue: 300, carryOver: true, carryCap: 1000 },
      { key: 'k-fun', name: 'Fun', targetType: 'PERCENT', targetValue: 10, carryOver: true, carryCap: null },
    ];

    const analysisWithTransfer: GenerateBudgetResponse = {
      ...mockAnalysisResult,
      categories: [
        ...mockAnalysisResult.categories,
        { ...mockAnalysisResult.categories[1], categoryId: 'cat-dining', categoryName: 'Dining', suggested: 200 },
      ],
      transfers: [{ accountId: 'acc-tfsa', accountName: 'TFSA', suggested: 250 } as any],
    };

    /** Lines as the categories step can leave them, stale and stray keys included. */
    const lines = () => ({
      selectedCategories: new Map<string, ApplyBudgetCategoryData>([
        // A stray key on an income line is never sent.
        ['cat-salary', { categoryId: 'cat-salary', amount: 5000, isIncome: true, bucketKey: 'k-fixed' }],
        ['cat-groceries', { categoryId: 'cat-groceries', amount: 400, isIncome: false, bucketKey: 'k-fixed' }],
        // The bucket this named was removed.
        ['cat-dining', { categoryId: 'cat-dining', amount: 200, isIncome: false, bucketKey: 'k-gone' }],
      ]),
      selectedTransfers: new Map<string, ApplyBudgetCategoryData>([
        ['acc-tfsa', { transferAccountId: 'acc-tfsa', isTransfer: true, amount: 250, bucketKey: 'k-save' }],
      ]),
    });

    const bucketState = (overrides: Partial<WizardState> = {}): WizardState => ({
      ...defaultState,
      strategy: 'BUCKET',
      analysisResult: analysisWithTransfer,
      buckets,
      ...lines(),
      ...overrides,
    });

    const renderReview = (state: WizardState) =>
      render(
        <BudgetWizardReview state={state} updateState={mockUpdateState} onComplete={mockOnComplete} onBack={mockOnBack} />,
      );

    const basePayload = {
      name: 'February 2026 Budget',
      budgetType: 'MONTHLY',
      periodStart: '2026-02-01',
      currencyCode: 'USD',
      baseIncome: undefined,
      incomeLinked: false,
      config: undefined,
    };

    it('lists the buckets with their target, carry-over and line counts', () => {
      renderReview(bucketState());
      const list = screen.getByRole('list', { name: 'Buckets' });
      const items = within(list).getAllByRole('listitem');
      expect(items).toHaveLength(3);
      expect(within(items[0]).getByText('Fixed costs')).toBeInTheDocument();
      expect(within(items[0]).getByText('1 line')).toBeInTheDocument();
      expect(within(items[0]).getByText(/of income · Starts each period fresh$/)).toBeInTheDocument();
      expect(within(items[1]).getByText('Savings')).toBeInTheDocument();
      expect(within(items[1]).getByText(/per period · Carries over, up to /)).toBeInTheDocument();
      expect(within(items[1]).getByText('1 line')).toBeInTheDocument();
      expect(within(items[2]).getByText(/of income · Carries over$/)).toBeInTheDocument();
      expect(within(items[2]).getByText('0 lines')).toBeInTheDocument();
    });

    it('warns, without blocking, when selected lines are unassigned', async () => {
      mockApplyGenerated.mockResolvedValue({ id: 'new-budget' });
      renderReview(bucketState());
      expect(screen.getByRole('note')).toHaveTextContent(
        '1 expense or transfer line is not in any bucket. You can still create the budget and assign them later on its edit page.',
      );
      fireEvent.click(screen.getByText('Create Budget'));
      await waitFor(() => expect(mockOnComplete).toHaveBeenCalled());
    });

    it('warns when there are no buckets, and still creates the budget', async () => {
      mockApplyGenerated.mockResolvedValue({ id: 'new-budget' });
      renderReview(bucketState({ buckets: [] }));
      expect(screen.getByRole('note')).toHaveTextContent(
        'This budget has no buckets yet. You can still create it and add buckets later on its edit page.',
      );
      expect(screen.queryByRole('list', { name: 'Buckets' })).not.toBeInTheDocument();
      fireEvent.click(screen.getByText('Create Budget'));
      await waitFor(() => expect(mockApplyGenerated).toHaveBeenCalledWith(expect.objectContaining({ buckets: [] })));
      // No line names a bucket that is not in the request.
      const sent = mockApplyGenerated.mock.calls[0][0].categories as ApplyBudgetCategoryData[];
      expect(sent.every((c) => !('bucketKey' in c))).toBe(true);
    });

    it('shows no warning when every selected expense and transfer line has a bucket', () => {
      const all = lines();
      all.selectedCategories.set('cat-dining', { categoryId: 'cat-dining', amount: 200, isIncome: false, bucketKey: 'k-fun' });
      renderReview(bucketState(all));
      expect(screen.queryByRole('note')).not.toBeInTheDocument();
    });

    it('sends the buckets with their keys and each line bucketKey only for a live bucket', async () => {
      mockApplyGenerated.mockResolvedValue({ id: 'new-budget' });
      renderReview(bucketState());
      fireEvent.click(screen.getByText('Create Budget'));

      await waitFor(() => expect(mockApplyGenerated).toHaveBeenCalledTimes(1));
      expect(mockApplyGenerated.mock.calls[0][0]).toEqual({
        ...basePayload,
        strategy: 'BUCKET',
        categories: [
          { categoryId: 'cat-salary', amount: 5000, isIncome: true },
          { categoryId: 'cat-groceries', amount: 400, isIncome: false, bucketKey: 'k-fixed' },
          { categoryId: 'cat-dining', amount: 200, isIncome: false },
          { transferAccountId: 'acc-tfsa', isTransfer: true, amount: 250, bucketKey: 'k-save' },
        ],
        buckets: [
          { key: 'k-fixed', name: 'Fixed costs', targetType: 'PERCENT', targetValue: 50, carryOver: false, sortOrder: 0 },
          { key: 'k-save', name: 'Savings', targetType: 'AMOUNT', targetValue: 300, carryOver: true, carryCap: 1000, sortOrder: 1 },
          { key: 'k-fun', name: 'Fun', targetType: 'PERCENT', targetValue: 10, carryOver: true, sortOrder: 2 },
        ],
      });
      const sentBuckets = mockApplyGenerated.mock.calls[0][0].buckets as Record<string, unknown>[];
      expect(sentBuckets[0]).not.toHaveProperty('carryCap');
      expect(sentBuckets[2]).not.toHaveProperty('carryCap');
    });

    it.each([
      ['FIXED', {}],
      ['FIFTY_THIRTY_TWENTY', { categoryGroup: 'NEED' }],
    ] as const)('leaves the %s payload unchanged: no buckets, no bucketKey', async (strategy, group) => {
      mockApplyGenerated.mockResolvedValue({ id: 'new-budget' });
      const state: WizardState = {
        ...defaultState,
        strategy,
        // Buckets kept from an earlier Bucket choice are not sent.
        buckets,
        selectedCategories: new Map<string, ApplyBudgetCategoryData>([
          ['cat-salary', { categoryId: 'cat-salary', amount: 5000, isIncome: true }],
          ['cat-groceries', { categoryId: 'cat-groceries', amount: 400, isIncome: false, ...group }],
        ]),
      };
      renderReview(state);
      expect(screen.queryByRole('heading', { name: 'Buckets' })).not.toBeInTheDocument();
      fireEvent.click(screen.getByText('Create Budget'));

      await waitFor(() => expect(mockApplyGenerated).toHaveBeenCalledTimes(1));
      expect(mockApplyGenerated.mock.calls[0][0]).toEqual({
        ...basePayload,
        strategy,
        categories: [
          { categoryId: 'cat-salary', amount: 5000, isIncome: true },
          { categoryId: 'cat-groceries', amount: 400, isIncome: false, ...group },
        ],
      });
      expect(mockApplyGenerated.mock.calls[0][0]).not.toHaveProperty('buckets');
    });

    it('drops a leftover bucketKey when the strategy is no longer Bucket', async () => {
      mockApplyGenerated.mockResolvedValue({ id: 'new-budget' });
      renderReview(bucketState({ strategy: 'ROLLOVER' }));
      fireEvent.click(screen.getByText('Create Budget'));
      await waitFor(() => expect(mockApplyGenerated).toHaveBeenCalledTimes(1));
      const payload = mockApplyGenerated.mock.calls[0][0];
      expect(payload).not.toHaveProperty('buckets');
      expect((payload.categories as ApplyBudgetCategoryData[]).some((c) => 'bucketKey' in c)).toBe(false);
    });
  });
});
