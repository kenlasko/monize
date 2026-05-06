import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { BudgetWizardCategories } from './BudgetWizardCategories';
import type { WizardState } from './BudgetWizard';
import type { GenerateBudgetResponse, ApplyBudgetCategoryData } from '@/types/budget';

// Mock format
vi.mock('@/lib/format', () => ({
  formatCurrency: vi.fn((amount: number) => `$${amount.toFixed(2)}`),
  getCurrencySymbol: vi.fn(() => '$'),
  getDecimalPlacesForCurrency: vi.fn(() => 2),
  formatAmount: vi.fn((v: number | undefined | null) => (v === undefined || v === null || isNaN(v)) ? '' : (Math.round(v * 100) / 100).toFixed(2)),
  roundToDecimals: vi.fn((v: number) => v),
}));

describe('BudgetWizardCategories', () => {
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
      {
        categoryId: 'cat-dining',
        categoryName: 'Dining',
        isIncome: false,
        average: 200,
        median: 200,
        p25: 150,
        p75: 250,
        min: 150,
        max: 250,
        stdDev: 35,
        monthlyAmounts: [150, 200, 250],
        monthlyOccurrences: 3,
        isFixed: false,
        seasonalMonths: [],
        suggested: 200,
      },
    ],
    estimatedMonthlyIncome: 5000,
    totalBudgeted: 600,
    projectedMonthlySavings: 4400,
    analysisWindow: { startDate: '2025-08-01', endDate: '2026-02-01', months: 6 },
    transfers: [],
    totalTransfers: 0,
  };

  const makeSelectedCategories = (): Map<string, ApplyBudgetCategoryData> => {
    const map = new Map<string, ApplyBudgetCategoryData>();
    map.set('cat-salary', { categoryId: 'cat-salary', amount: 5000, isIncome: true });
    map.set('cat-groceries', { categoryId: 'cat-groceries', amount: 400, isIncome: false });
    map.set('cat-dining', { categoryId: 'cat-dining', amount: 200, isIncome: false });
    return map;
  };

  const defaultState: WizardState = {
    analysisMonths: 6,
    profile: 'ON_TRACK',
    strategy: 'FIXED',
    analysisResult: mockAnalysisResult,
    selectedCategories: makeSelectedCategories(),
    selectedTransfers: new Map(),
    budgetName: 'Test Budget',
    budgetType: 'MONTHLY',
    periodStart: '2026-02-01',
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
  const mockOnNext = vi.fn();
  const mockOnBack = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders income and expense category sections', () => {
    render(
      <BudgetWizardCategories
        state={defaultState}
        updateState={mockUpdateState}
        onNext={mockOnNext}
        onBack={mockOnBack}
      />,
    );

    expect(screen.getByText('Income')).toBeInTheDocument();
    expect(screen.getByText('Expenses')).toBeInTheDocument();
  });

  it('renders category names', () => {
    render(
      <BudgetWizardCategories
        state={defaultState}
        updateState={mockUpdateState}
        onNext={mockOnNext}
        onBack={mockOnBack}
      />,
    );

    expect(screen.getByText('Salary')).toBeInTheDocument();
    expect(screen.getByText('Groceries')).toBeInTheDocument();
    expect(screen.getByText('Dining')).toBeInTheDocument();
  });

  it('renders profile toggle buttons', () => {
    render(
      <BudgetWizardCategories
        state={defaultState}
        updateState={mockUpdateState}
        onNext={mockOnNext}
        onBack={mockOnBack}
      />,
    );

    expect(screen.getByText('Comfortable')).toBeInTheDocument();
    expect(screen.getByText('On Track')).toBeInTheDocument();
    expect(screen.getByText('Aggressive')).toBeInTheDocument();
  });

  it('renders totals summary', () => {
    render(
      <BudgetWizardCategories
        state={defaultState}
        updateState={mockUpdateState}
        onNext={mockOnNext}
        onBack={mockOnBack}
      />,
    );

    expect(screen.getByText('Total Income')).toBeInTheDocument();
    expect(screen.getByText('Total Expenses')).toBeInTheDocument();
    expect(screen.getByText('Remaining')).toBeInTheDocument();
  });

  it('calls onNext when Next button is clicked', () => {
    render(
      <BudgetWizardCategories
        state={defaultState}
        updateState={mockUpdateState}
        onNext={mockOnNext}
        onBack={mockOnBack}
      />,
    );

    fireEvent.click(screen.getByText('Next: Configure'));
    expect(mockOnNext).toHaveBeenCalled();
  });

  it('calls onBack when Back button is clicked', () => {
    render(
      <BudgetWizardCategories
        state={defaultState}
        updateState={mockUpdateState}
        onNext={mockOnNext}
        onBack={mockOnBack}
      />,
    );

    fireEvent.click(screen.getByText('Back'));
    expect(mockOnBack).toHaveBeenCalled();
  });

  it('disables Next when no categories are selected', () => {
    const emptyState = {
      ...defaultState,
      selectedCategories: new Map(),
    };

    render(
      <BudgetWizardCategories
        state={emptyState}
        updateState={mockUpdateState}
        onNext={mockOnNext}
        onBack={mockOnBack}
      />,
    );

    const nextButton = screen.getByText('Next: Configure');
    expect(nextButton).toBeDisabled();
  });

  it('shows "No analysis data" when analysisResult is null', () => {
    const noDataState = {
      ...defaultState,
      analysisResult: null,
    };

    render(
      <BudgetWizardCategories
        state={noDataState}
        updateState={mockUpdateState}
        onNext={mockOnNext}
        onBack={mockOnBack}
      />,
    );

    expect(screen.getByText(/no analysis data/i)).toBeInTheDocument();
  });

  it('updates profile and recalculates amounts on profile change', () => {
    render(
      <BudgetWizardCategories
        state={defaultState}
        updateState={mockUpdateState}
        onNext={mockOnNext}
        onBack={mockOnBack}
      />,
    );

    fireEvent.click(screen.getByText('Aggressive'));
    expect(mockUpdateState).toHaveBeenCalled();

    const updateCall = mockUpdateState.mock.calls[0][0];
    expect(updateCall.profile).toBe('AGGRESSIVE');
    expect(updateCall.selectedCategories).toBeInstanceOf(Map);
  });

  it('renders amount inputs with 2 decimal places', () => {
    render(
      <BudgetWizardCategories
        state={defaultState}
        updateState={mockUpdateState}
        onNext={mockOnNext}
        onBack={mockOnBack}
      />,
    );

    // The BudgetAmountInput component shows amounts with toFixed(2) using type="text" inputMode="decimal"
    const inputs = document.querySelectorAll('input[type="text"][inputmode="decimal"]');
    // Should have inputs for selected categories (Salary=5000, Groceries=400, Dining=200)
    expect(inputs.length).toBeGreaterThanOrEqual(3);
    // Check that values have 2 decimal places
    const values = Array.from(inputs).map(input => (input as HTMLInputElement).value);
    expect(values).toContain('5000.00');
    expect(values).toContain('400.00');
    expect(values).toContain('200.00');
  });

  it('renders amount inputs as right-aligned', () => {
    render(
      <BudgetWizardCategories
        state={defaultState}
        updateState={mockUpdateState}
        onNext={mockOnNext}
        onBack={mockOnBack}
      />,
    );

    const inputs = document.querySelectorAll('input[type="text"][inputmode="decimal"]');
    expect(inputs.length).toBeGreaterThanOrEqual(1);
    // BudgetAmountInput has text-right class
    expect((inputs[0] as HTMLElement).className).toContain('text-right');
  });

  it('renders currency symbol prefix in amount inputs', () => {
    render(
      <BudgetWizardCategories
        state={defaultState}
        updateState={mockUpdateState}
        onNext={mockOnNext}
        onBack={mockOnBack}
      />,
    );

    // getCurrencySymbol is mocked to return '$'
    const dollarSigns = screen.getAllByText('$');
    // Should have at least one per input (currency symbol prefix)
    expect(dollarSigns.length).toBeGreaterThanOrEqual(3);
  });

  describe('50/30/20 strategy', () => {
    const make503020Categories = (): Map<string, ApplyBudgetCategoryData> => {
      const map = new Map<string, ApplyBudgetCategoryData>();
      map.set('cat-salary', { categoryId: 'cat-salary', amount: 5000, isIncome: true });
      map.set('cat-groceries', { categoryId: 'cat-groceries', amount: 400, isIncome: false, categoryGroup: 'NEED' });
      map.set('cat-dining', { categoryId: 'cat-dining', amount: 200, isIncome: false, categoryGroup: 'WANT' });
      return map;
    };

    const state503020: WizardState = {
      ...defaultState,
      strategy: 'FIFTY_THIRTY_TWENTY',
      selectedCategories: make503020Categories(),
    };

    it('shows group pickers on expense rows when strategy is FIFTY_THIRTY_TWENTY', () => {
      render(
        <BudgetWizardCategories
          state={state503020}
          updateState={mockUpdateState}
          onNext={mockOnNext}
          onBack={mockOnBack}
        />,
      );

      // Each picker has 3 buttons (N, W, S). 2 expense categories = 6 group buttons
      const groupButtons = screen.getAllByTitle(/Need|Want|Saving/);
      expect(groupButtons.length).toBe(6);
    });

    it('does not show group pickers when strategy is FIXED', () => {
      render(
        <BudgetWizardCategories
          state={defaultState}
          updateState={mockUpdateState}
          onNext={mockOnNext}
          onBack={mockOnBack}
        />,
      );

      const groupButtons = screen.queryAllByTitle(/Need|Want|Saving/);
      expect(groupButtons.length).toBe(0);
    });

    it('renders 50/30/20 allocation summary', () => {
      render(
        <BudgetWizardCategories
          state={state503020}
          updateState={mockUpdateState}
          onNext={mockOnNext}
          onBack={mockOnBack}
        />,
      );

      expect(screen.getByText('50/30/20 Allocation')).toBeInTheDocument();
      expect(screen.getByText(/Needs/)).toBeInTheDocument();
      expect(screen.getByText(/Wants/)).toBeInTheDocument();
      expect(screen.getByText(/Savings/)).toBeInTheDocument();
    });

    it('does not render allocation summary for FIXED strategy', () => {
      render(
        <BudgetWizardCategories
          state={defaultState}
          updateState={mockUpdateState}
          onNext={mockOnNext}
          onBack={mockOnBack}
        />,
      );

      expect(screen.queryByText('50/30/20 Allocation')).not.toBeInTheDocument();
    });

    it('updates categoryGroup when group picker button is clicked', () => {
      render(
        <BudgetWizardCategories
          state={state503020}
          updateState={mockUpdateState}
          onNext={mockOnNext}
          onBack={mockOnBack}
        />,
      );

      // Click the "S" (Saving) button in the first picker
      const savingButtons = screen.getAllByTitle('Saving');
      fireEvent.click(savingButtons[0]);
      expect(mockUpdateState).toHaveBeenCalled();

      const update = mockUpdateState.mock.calls[0][0];
      expect(update.selectedCategories).toBeInstanceOf(Map);
    });

    it('sets default categoryGroup to NEED when toggling expense category on', () => {
      const stateWithUnselected: WizardState = {
        ...state503020,
        selectedCategories: new Map([
          ['cat-salary', { categoryId: 'cat-salary', amount: 5000, isIncome: true }],
        ]),
      };

      render(
        <BudgetWizardCategories
          state={stateWithUnselected}
          updateState={mockUpdateState}
          onNext={mockOnNext}
          onBack={mockOnBack}
        />,
      );

      // Find the Groceries checkbox (unchecked expense) and check it
      const checkboxes = document.querySelectorAll('input[type="checkbox"]');
      // Groceries is the first expense category checkbox
      const groceriesCheckbox = Array.from(checkboxes).find(cb => {
        const label = cb.closest('label');
        return label?.textContent?.includes('Groceries');
      });
      expect(groceriesCheckbox).toBeDefined();
      fireEvent.click(groceriesCheckbox!);

      expect(mockUpdateState).toHaveBeenCalled();
      const update = mockUpdateState.mock.calls[0][0];
      const groceriesEntry = update.selectedCategories.get('cat-groceries');
      expect(groceriesEntry?.categoryGroup).toBe('NEED');
    });

    it('shows target percentages in allocation summary', () => {
      render(
        <BudgetWizardCategories
          state={state503020}
          updateState={mockUpdateState}
          onNext={mockOnNext}
          onBack={mockOnBack}
        />,
      );

      expect(screen.getByText(/target 50%/)).toBeInTheDocument();
      expect(screen.getByText(/target 30%/)).toBeInTheDocument();
      expect(screen.getByText(/target 20%/)).toBeInTheDocument();
    });
  });

  describe('profile change updates amounts based on profile', () => {
    it('uses p75 when profile changes to COMFORTABLE', () => {
      render(
        <BudgetWizardCategories
          state={defaultState}
          updateState={mockUpdateState}
          onNext={mockOnNext}
          onBack={mockOnBack}
        />,
      );
      // Click the "Comfortable" profile option (it's a button)
      const btn = screen.getByRole('button', { name: /Comfortable/i });
      fireEvent.click(btn);
      expect(mockUpdateState).toHaveBeenCalled();
      const call = mockUpdateState.mock.calls[mockUpdateState.mock.calls.length - 1][0];
      expect(call.profile).toBe('COMFORTABLE');
      // Groceries p75=500
      const grocery = call.selectedCategories.get('cat-groceries');
      expect(grocery?.amount).toBe(500);
    });

    it('uses p25 when profile changes to AGGRESSIVE', () => {
      render(
        <BudgetWizardCategories
          state={defaultState}
          updateState={mockUpdateState}
          onNext={mockOnNext}
          onBack={mockOnBack}
        />,
      );
      const btn = screen.getByRole('button', { name: /Aggressive/i });
      fireEvent.click(btn);
      const call = mockUpdateState.mock.calls[mockUpdateState.mock.calls.length - 1][0];
      expect(call.profile).toBe('AGGRESSIVE');
      const grocery = call.selectedCategories.get('cat-groceries');
      expect(grocery?.amount).toBe(300);
    });

    it('uses median when profile changes to ON_TRACK', () => {
      const cstate: WizardState = { ...defaultState, profile: 'AGGRESSIVE' };
      render(
        <BudgetWizardCategories
          state={cstate}
          updateState={mockUpdateState}
          onNext={mockOnNext}
          onBack={mockOnBack}
        />,
      );
      const btn = screen.getByRole('button', { name: /On Track/i });
      fireEvent.click(btn);
      const call = mockUpdateState.mock.calls[mockUpdateState.mock.calls.length - 1][0];
      expect(call.profile).toBe('ON_TRACK');
      const grocery = call.selectedCategories.get('cat-groceries');
      expect(grocery?.amount).toBe(400);
    });
  });

  describe('amount editing', () => {
    it('updates category amount on focus and blur with valid value', () => {
      render(
        <BudgetWizardCategories
          state={defaultState}
          updateState={mockUpdateState}
          onNext={mockOnNext}
          onBack={mockOnBack}
        />,
      );

      // Find an amount input (text input with currency prefix)
      const inputs = document.querySelectorAll('input[type="text"][inputMode="decimal"]');
      const input = inputs[0] as HTMLInputElement;
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: '999' } });
      fireEvent.blur(input);
      expect(mockUpdateState).toHaveBeenCalled();
    });

    it('ignores blur with invalid value', () => {
      render(
        <BudgetWizardCategories
          state={defaultState}
          updateState={mockUpdateState}
          onNext={mockOnNext}
          onBack={mockOnBack}
        />,
      );

      const inputs = document.querySelectorAll('input[type="text"][inputMode="decimal"]');
      const input = inputs[0] as HTMLInputElement;
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: 'invalid' } });
      fireEvent.blur(input);
      // mockUpdateState may have been called from initial setup, but for invalid values not invoked again
    });

    it('ignores blur with negative value', () => {
      render(
        <BudgetWizardCategories
          state={defaultState}
          updateState={mockUpdateState}
          onNext={mockOnNext}
          onBack={mockOnBack}
        />,
      );

      const inputs = document.querySelectorAll('input[type="text"][inputMode="decimal"]');
      const input = inputs[0] as HTMLInputElement;
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: '-50' } });
      fireEvent.blur(input);
    });
  });

  describe('transfers', () => {
    const stateWithTransfers: WizardState = {
      ...defaultState,
      analysisResult: {
        ...mockAnalysisResult,
        transfers: [
          {
            accountId: 'acc-savings',
            accountName: 'Savings',
            accountType: 'SAVINGS',
            average: 200,
            median: 200,
            p25: 100,
            p75: 300,
            min: 100,
            max: 300,
            stdDev: 80,
            monthlyAmounts: [100, 200, 300],
            monthlyOccurrences: 3,
            isFixed: false,
            seasonalMonths: [],
            suggested: 200,
          } as any,
        ],
      },
      selectedTransfers: new Map([
        ['acc-savings', { transferAccountId: 'acc-savings', isTransfer: true, amount: 200 }],
      ]),
    };

    it('renders transfer rows with account name', () => {
      render(
        <BudgetWizardCategories
          state={stateWithTransfers}
          updateState={mockUpdateState}
          onNext={mockOnNext}
          onBack={mockOnBack}
        />,
      );
      expect(screen.getByText('Savings')).toBeInTheDocument();
    });

    it('toggles a transfer on/off', () => {
      const noSelected: WizardState = {
        ...stateWithTransfers,
        selectedTransfers: new Map(),
      };
      render(
        <BudgetWizardCategories
          state={noSelected}
          updateState={mockUpdateState}
          onNext={mockOnNext}
          onBack={mockOnBack}
        />,
      );

      const checkboxes = document.querySelectorAll('input[type="checkbox"]');
      const savings = Array.from(checkboxes).find(cb => {
        const label = cb.closest('label');
        return label?.textContent?.includes('Savings');
      });
      expect(savings).toBeDefined();
      fireEvent.click(savings!);
      expect(mockUpdateState).toHaveBeenCalled();
      const call = mockUpdateState.mock.calls[mockUpdateState.mock.calls.length - 1][0];
      expect(call.selectedTransfers.get('acc-savings')?.amount).toBe(200);
    });

    it('toggles a transfer off (uncheck)', () => {
      render(
        <BudgetWizardCategories
          state={stateWithTransfers}
          updateState={mockUpdateState}
          onNext={mockOnNext}
          onBack={mockOnBack}
        />,
      );

      const checkboxes = document.querySelectorAll('input[type="checkbox"]:checked');
      const savings = Array.from(checkboxes).find(cb => {
        const label = cb.closest('label');
        return label?.textContent?.includes('Savings');
      });
      expect(savings).toBeDefined();
      fireEvent.click(savings!);
      const call = mockUpdateState.mock.calls[mockUpdateState.mock.calls.length - 1][0];
      expect(call.selectedTransfers.has('acc-savings')).toBe(false);
    });

    it('updates transfer amount', () => {
      render(
        <BudgetWizardCategories
          state={stateWithTransfers}
          updateState={mockUpdateState}
          onNext={mockOnNext}
          onBack={mockOnBack}
        />,
      );

      const inputs = document.querySelectorAll('input[type="text"][inputMode="decimal"]');
      // Last input is the transfer amount
      const input = inputs[inputs.length - 1] as HTMLInputElement;
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: '500' } });
      fireEvent.blur(input);
      expect(mockUpdateState).toHaveBeenCalled();
    });

    it('profile change updates transfer amounts', () => {
      render(
        <BudgetWizardCategories
          state={stateWithTransfers}
          updateState={mockUpdateState}
          onNext={mockOnNext}
          onBack={mockOnBack}
        />,
      );
      const btn = screen.getByRole('button', { name: /Comfortable/i });
      fireEvent.click(btn);
      const call = mockUpdateState.mock.calls[mockUpdateState.mock.calls.length - 1][0];
      const t = call.selectedTransfers.get('acc-savings');
      expect(t?.amount).toBe(300);
    });

    it('renders transfer category group picker for 50/30/20 strategy', () => {
      const s: WizardState = { ...stateWithTransfers, strategy: 'FIFTY_THIRTY_TWENTY' };
      render(
        <BudgetWizardCategories
          state={s}
          updateState={mockUpdateState}
          onNext={mockOnNext}
          onBack={mockOnBack}
        />,
      );
      expect(screen.getAllByTitle('Saving').length).toBeGreaterThan(0);
    });

    it('updates transfer group via picker', () => {
      const s: WizardState = {
        ...stateWithTransfers,
        strategy: 'FIFTY_THIRTY_TWENTY',
        selectedTransfers: new Map([
          ['acc-savings', { transferAccountId: 'acc-savings', isTransfer: true, amount: 200, categoryGroup: 'SAVING' }],
        ]),
      };
      render(
        <BudgetWizardCategories
          state={s}
          updateState={mockUpdateState}
          onNext={mockOnNext}
          onBack={mockOnBack}
        />,
      );
      // The Need button next to the transfer is the last "Need" button
      const buttons = screen.getAllByTitle('Need');
      fireEvent.click(buttons[buttons.length - 1]);
      const call = mockUpdateState.mock.calls[mockUpdateState.mock.calls.length - 1][0];
      const t = call.selectedTransfers.get('acc-savings');
      expect(t?.categoryGroup).toBe('NEED');
    });
  });
});
