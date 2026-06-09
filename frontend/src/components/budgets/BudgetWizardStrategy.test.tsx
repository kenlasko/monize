import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { BudgetWizardStrategy } from './BudgetWizardStrategy';
import type { WizardState } from './BudgetWizard';
import type { ApplyBudgetCategoryData, GenerateBudgetResponse } from '@/types/budget';
import type { Account } from '@/types/account';

describe('BudgetWizardStrategy', () => {
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
    estimatedMonthlyIncome: 5000,
    totalBudgeted: 400,
    projectedMonthlySavings: 4600,
    analysisWindow: { startDate: '2025-08-01', endDate: '2026-02-01', months: 6 },
    transfers: [],
    totalTransfers: 0,
  };

  const makeSelectedCategories = (): Map<string, ApplyBudgetCategoryData> => {
    const map = new Map<string, ApplyBudgetCategoryData>();
    map.set('cat-salary', { categoryId: 'cat-salary', amount: 5000, isIncome: true });
    map.set('cat-groceries', { categoryId: 'cat-groceries', amount: 400, isIncome: false });
    return map;
  };

  const mockAccounts: Account[] = [
    {
      id: 'acc-1',
      userId: 'user-1',
      accountType: 'CHECKING',
      accountSubType: 'NONE',
      linkedAccountId: null,
      name: 'Main Checking',
      description: null,
      currencyCode: 'USD',
      accountNumber: null,
      institution: 'Test Bank',
      openingBalance: 0,
      currentBalance: 5000,
      creditLimit: null,
      interestRate: null,
      isClosed: false,
      canDelete: true,
      createdAt: '2025-01-01',
      updatedAt: '2025-01-01',
    },
    {
      id: 'acc-2',
      userId: 'user-1',
      accountType: 'SAVINGS',
      accountSubType: 'NONE',
      linkedAccountId: null,
      name: 'Savings',
      description: null,
      currencyCode: 'USD',
      accountNumber: null,
      institution: 'Test Bank',
      openingBalance: 0,
      currentBalance: 10000,
      creditLimit: null,
      interestRate: null,
      isClosed: false,
      canDelete: true,
      createdAt: '2025-01-01',
      updatedAt: '2025-01-01',
    },
  ] as unknown as Account[];

  const defaultState: WizardState = {
    analysisMonths: 6,
    profile: 'ON_TRACK',
    strategy: 'FIXED',
    analysisResult: mockAnalysisResult,
    selectedCategories: makeSelectedCategories(),
    selectedTransfers: new Map(),
    budgetName: 'February 2026 Budget',
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

  it('renders budget details section', () => {
    render(
      <BudgetWizardStrategy
        state={defaultState}
        updateState={mockUpdateState}
        onNext={mockOnNext}
        onBack={mockOnBack}
      />,
    );

    expect(screen.getByText('Budget Details')).toBeInTheDocument();
    expect(screen.getByDisplayValue('February 2026 Budget')).toBeInTheDocument();
  });

  it('renders income section', () => {
    render(
      <BudgetWizardStrategy
        state={defaultState}
        updateState={mockUpdateState}
        onNext={mockOnNext}
        onBack={mockOnBack}
      />,
    );

    expect(screen.getByText('Income')).toBeInTheDocument();
    expect(screen.getByText('Link budget to income')).toBeInTheDocument();
  });

  it('renders rollover rules section', () => {
    render(
      <BudgetWizardStrategy
        state={defaultState}
        updateState={mockUpdateState}
        onNext={mockOnNext}
        onBack={mockOnBack}
      />,
    );

    expect(screen.getByText('Rollover Rules')).toBeInTheDocument();
    expect(screen.getByText('Default Rollover Type')).toBeInTheDocument();
  });

  it('renders alert thresholds section', () => {
    render(
      <BudgetWizardStrategy
        state={defaultState}
        updateState={mockUpdateState}
        onNext={mockOnNext}
        onBack={mockOnBack}
      />,
    );

    expect(screen.getByText('Alert Thresholds')).toBeInTheDocument();
    expect(screen.getByText('Warning at (%)')).toBeInTheDocument();
    expect(screen.getByText('Critical at (%)')).toBeInTheDocument();
  });

  it('renders flex groups section when expense categories exist', () => {
    render(
      <BudgetWizardStrategy
        state={defaultState}
        updateState={mockUpdateState}
        onNext={mockOnNext}
        onBack={mockOnBack}
      />,
    );

    expect(screen.getByText('Flex Groups')).toBeInTheDocument();
  });

  it('renders excluded accounts section when accounts are provided', () => {
    render(
      <BudgetWizardStrategy
        state={defaultState}
        updateState={mockUpdateState}
        accounts={mockAccounts}
        onNext={mockOnNext}
        onBack={mockOnBack}
      />,
    );

    expect(screen.getByText('Excluded Accounts')).toBeInTheDocument();
    expect(screen.getByText('Main Checking')).toBeInTheDocument();
    expect(screen.getByText('Savings')).toBeInTheDocument();
  });

  it('calls onNext when Next button is clicked', () => {
    render(
      <BudgetWizardStrategy
        state={defaultState}
        updateState={mockUpdateState}
        onNext={mockOnNext}
        onBack={mockOnBack}
      />,
    );

    fireEvent.click(screen.getByText('Next: Review'));
    expect(mockOnNext).toHaveBeenCalled();
  });

  it('calls onBack when Back button is clicked', () => {
    render(
      <BudgetWizardStrategy
        state={defaultState}
        updateState={mockUpdateState}
        onNext={mockOnNext}
        onBack={mockOnBack}
      />,
    );

    fireEvent.click(screen.getByText('Back'));
    expect(mockOnBack).toHaveBeenCalled();
  });

  it('disables Next when budget name is empty', () => {
    const emptyNameState = { ...defaultState, budgetName: '' };

    render(
      <BudgetWizardStrategy
        state={emptyNameState}
        updateState={mockUpdateState}
        onNext={mockOnNext}
        onBack={mockOnBack}
      />,
    );

    expect(screen.getByText('Next: Review')).toBeDisabled();
  });

  it('updates budget name on input', () => {
    render(
      <BudgetWizardStrategy
        state={defaultState}
        updateState={mockUpdateState}
        onNext={mockOnNext}
        onBack={mockOnBack}
      />,
    );

    fireEvent.change(screen.getByDisplayValue('February 2026 Budget'), {
      target: { value: 'New Name' },
    });

    expect(mockUpdateState).toHaveBeenCalledWith({ budgetName: 'New Name' });
  });

  it('toggles income linking', () => {
    render(
      <BudgetWizardStrategy
        state={defaultState}
        updateState={mockUpdateState}
        onNext={mockOnNext}
        onBack={mockOnBack}
      />,
    );

    const checkbox = screen.getByText('Link budget to income').closest('label')!.querySelector('input')!;
    fireEvent.click(checkbox);

    expect(mockUpdateState).toHaveBeenCalledWith({ incomeLinked: true });
  });

  it('updates rollover type and applies to categories', () => {
    render(
      <BudgetWizardStrategy
        state={defaultState}
        updateState={mockUpdateState}
        onNext={mockOnNext}
        onBack={mockOnBack}
      />,
    );

    const select = screen.getByLabelText('Default Rollover Type');
    fireEvent.change(select, { target: { value: 'MONTHLY' } });

    expect(mockUpdateState).toHaveBeenCalled();
    const call = mockUpdateState.mock.calls[0][0];
    expect(call.defaultRolloverType).toBe('MONTHLY');
    expect(call.selectedCategories).toBeInstanceOf(Map);
  });

  it('toggles excluded account', () => {
    render(
      <BudgetWizardStrategy
        state={defaultState}
        updateState={mockUpdateState}
        accounts={mockAccounts}
        onNext={mockOnNext}
        onBack={mockOnBack}
      />,
    );

    const checkingLabel = screen.getByText('Main Checking').closest('label')!;
    const checkbox = checkingLabel.querySelector('input')!;
    fireEvent.click(checkbox);

    expect(mockUpdateState).toHaveBeenCalledWith({
      excludedAccountIds: ['acc-1'],
    });
  });

  it('shows flex groups table when Configure is clicked', () => {
    render(
      <BudgetWizardStrategy
        state={defaultState}
        updateState={mockUpdateState}
        onNext={mockOnNext}
        onBack={mockOnBack}
      />,
    );

    fireEvent.click(screen.getByText('Configure'));

    expect(screen.getByText('Groceries')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('e.g. Fun Money')).toBeInTheDocument();
  });

  it('updates flex group for a category', () => {
    render(
      <BudgetWizardStrategy
        state={defaultState}
        updateState={mockUpdateState}
        onNext={mockOnNext}
        onBack={mockOnBack}
      />,
    );

    fireEvent.click(screen.getByText('Configure'));

    const input = screen.getByPlaceholderText('e.g. Fun Money');
    fireEvent.change(input, { target: { value: 'Food' } });

    expect(mockUpdateState).toHaveBeenCalled();
    const call = mockUpdateState.mock.calls[0][0];
    expect(call.selectedCategories).toBeInstanceOf(Map);
    const groceries = call.selectedCategories.get('cat-groceries');
    expect(groceries?.flexGroup).toBe('Food');
  });

  it('shows strategy summary', () => {
    render(
      <BudgetWizardStrategy
        state={defaultState}
        updateState={mockUpdateState}
        onNext={mockOnNext}
        onBack={mockOnBack}
      />,
    );

    expect(screen.getByText(/Strategy: Fixed/)).toBeInTheDocument();
  });

  it('shows selected category count', () => {
    render(
      <BudgetWizardStrategy
        state={defaultState}
        updateState={mockUpdateState}
        onNext={mockOnNext}
        onBack={mockOnBack}
      />,
    );

    expect(screen.getByText(/2 categories/)).toBeInTheDocument();
  });

  // --- Strategy descriptions ---
  it('shows ROLLOVER strategy description', () => {
    render(
      <BudgetWizardStrategy
        state={{ ...defaultState, strategy: 'ROLLOVER' }}
        updateState={mockUpdateState}
        onNext={mockOnNext}
        onBack={mockOnBack}
      />,
    );
    expect(screen.getByText(/Unspent budget carries forward/)).toBeInTheDocument();
  });

  it('shows ZERO_BASED strategy description', () => {
    render(
      <BudgetWizardStrategy
        state={{ ...defaultState, strategy: 'ZERO_BASED' }}
        updateState={mockUpdateState}
        onNext={mockOnNext}
        onBack={mockOnBack}
      />,
    );
    expect(screen.getByText(/Every dollar of income is assigned/)).toBeInTheDocument();
  });

  it('shows FIFTY_THIRTY_TWENTY strategy description', () => {
    render(
      <BudgetWizardStrategy
        state={{ ...defaultState, strategy: 'FIFTY_THIRTY_TWENTY' }}
        updateState={mockUpdateState}
        onNext={mockOnNext}
        onBack={mockOnBack}
      />,
    );
    expect(screen.getByText(/Categories grouped as Needs/)).toBeInTheDocument();
  });

  it('shows Not selected when strategy is null', () => {
    render(
      <BudgetWizardStrategy
        state={{ ...defaultState, strategy: null }}
        updateState={mockUpdateState}
        onNext={mockOnNext}
        onBack={mockOnBack}
      />,
    );
    expect(screen.getByText(/Strategy: Not selected/)).toBeInTheDocument();
  });

  // --- hasErrors: periodStart missing ---
  it('disables Next when periodStart is empty', () => {
    render(
      <BudgetWizardStrategy
        state={{ ...defaultState, periodStart: '' }}
        updateState={mockUpdateState}
        onNext={mockOnNext}
        onBack={mockOnBack}
      />,
    );
    expect(screen.getByText('Next: Review')).toBeDisabled();
  });

  // --- Income estimated display ---
  it('shows estimated monthly income from analysis result', () => {
    render(
      <BudgetWizardStrategy
        state={defaultState}
        updateState={mockUpdateState}
        onNext={mockOnNext}
        onBack={mockOnBack}
      />,
    );
    expect(screen.getByText(/Estimated from analysis/)).toBeInTheDocument();
  });

  it('does not show estimated income when analysis result is null', () => {
    render(
      <BudgetWizardStrategy
        state={{ ...defaultState, analysisResult: null }}
        updateState={mockUpdateState}
        onNext={mockOnNext}
        onBack={mockOnBack}
      />,
    );
    expect(screen.queryByText(/Estimated from analysis/)).not.toBeInTheDocument();
  });

  it('does not show estimated income when estimatedMonthlyIncome is 0', () => {
    render(
      <BudgetWizardStrategy
        state={{
          ...defaultState,
          analysisResult: { ...mockAnalysisResult, estimatedMonthlyIncome: 0 },
        }}
        updateState={mockUpdateState}
        onNext={mockOnNext}
        onBack={mockOnBack}
      />,
    );
    expect(screen.queryByText(/Estimated from analysis/)).not.toBeInTheDocument();
  });

  // --- Income link toggle with baseIncome > 0 ---
  it('converts category amounts to percentages when linking income with baseIncome', () => {
    const stateWithIncome = {
      ...defaultState,
      baseIncome: 5000,
      incomeLinked: false,
    };
    render(
      <BudgetWizardStrategy
        state={stateWithIncome}
        updateState={mockUpdateState}
        onNext={mockOnNext}
        onBack={mockOnBack}
      />,
    );

    const checkbox = screen.getByText('Link budget to income').closest('label')!.querySelector('input')!;
    fireEvent.click(checkbox);

    expect(mockUpdateState).toHaveBeenCalled();
    const call = mockUpdateState.mock.calls[0][0];
    expect(call.incomeLinked).toBe(true);
    expect(call.selectedCategories).toBeInstanceOf(Map);
    // Groceries: 400 / 5000 * 100 = 8%
    const groceries = call.selectedCategories.get('cat-groceries');
    expect(groceries?.amount).toBeCloseTo(8, 1);
  });

  it('converts category amounts from percentages to dollars when unlinking income', () => {
    const stateWithLinked = {
      ...defaultState,
      baseIncome: 5000,
      incomeLinked: true,
      selectedCategories: (() => {
        const map = new Map<string, ApplyBudgetCategoryData>();
        map.set('cat-salary', { categoryId: 'cat-salary', amount: 100, isIncome: true });
        map.set('cat-groceries', { categoryId: 'cat-groceries', amount: 8, isIncome: false });
        return map;
      })(),
    };
    render(
      <BudgetWizardStrategy
        state={stateWithLinked}
        updateState={mockUpdateState}
        onNext={mockOnNext}
        onBack={mockOnBack}
      />,
    );

    const checkbox = screen.getByText('Link budget to income').closest('label')!.querySelector('input')!;
    fireEvent.click(checkbox);

    expect(mockUpdateState).toHaveBeenCalled();
    const call = mockUpdateState.mock.calls[0][0];
    expect(call.incomeLinked).toBe(false);
    // Groceries: 8% of 5000 = 400
    const groceries = call.selectedCategories.get('cat-groceries');
    expect(groceries?.amount).toBeCloseTo(400, 1);
  });

  it('simply updates incomeLinked when baseIncome is null', () => {
    render(
      <BudgetWizardStrategy
        state={{ ...defaultState, baseIncome: null }}
        updateState={mockUpdateState}
        onNext={mockOnNext}
        onBack={mockOnBack}
      />,
    );

    const checkbox = screen.getByText('Link budget to income').closest('label')!.querySelector('input')!;
    fireEvent.click(checkbox);

    expect(mockUpdateState).toHaveBeenCalledWith({ incomeLinked: true });
    // Should not contain selectedCategories when no income
    expect(mockUpdateState.mock.calls[0][0].selectedCategories).toBeUndefined();
  });

  it('simply updates incomeLinked when baseIncome is 0', () => {
    render(
      <BudgetWizardStrategy
        state={{ ...defaultState, baseIncome: 0 }}
        updateState={mockUpdateState}
        onNext={mockOnNext}
        onBack={mockOnBack}
      />,
    );

    const checkbox = screen.getByText('Link budget to income').closest('label')!.querySelector('input')!;
    fireEvent.click(checkbox);

    expect(mockUpdateState).toHaveBeenCalledWith({ incomeLinked: true });
  });

  // --- Rollover updates also propagate to selectedTransfers ---
  it('updates rollover type across both categories and transfers', () => {
    const stateWithTransfers = {
      ...defaultState,
      selectedTransfers: (() => {
        const map = new Map<string, ApplyBudgetCategoryData>();
        map.set('tr-1', { categoryId: 'tr-1', amount: 200, isIncome: false });
        return map;
      })(),
    };
    render(
      <BudgetWizardStrategy
        state={stateWithTransfers}
        updateState={mockUpdateState}
        onNext={mockOnNext}
        onBack={mockOnBack}
      />,
    );

    const select = screen.getByLabelText('Default Rollover Type');
    fireEvent.change(select, { target: { value: 'QUARTERLY' } });

    const call = mockUpdateState.mock.calls[0][0];
    expect(call.defaultRolloverType).toBe('QUARTERLY');
    expect(call.selectedTransfers).toBeInstanceOf(Map);
    const transfer = call.selectedTransfers.get('tr-1');
    expect(transfer?.rolloverType).toBe('QUARTERLY');
  });

  // --- Alert threshold changes ---
  it('updates warning alert percent and applies to categories', () => {
    render(
      <BudgetWizardStrategy
        state={defaultState}
        updateState={mockUpdateState}
        onNext={mockOnNext}
        onBack={mockOnBack}
      />,
    );

    const warnInput = screen.getByDisplayValue('80');
    fireEvent.change(warnInput, { target: { value: '75' } });

    expect(mockUpdateState).toHaveBeenCalled();
    const call = mockUpdateState.mock.calls[0][0];
    expect(call.alertWarnPercent).toBe(75);
    expect(call.selectedCategories).toBeInstanceOf(Map);
  });

  it('updates critical alert percent and applies to categories', () => {
    render(
      <BudgetWizardStrategy
        state={defaultState}
        updateState={mockUpdateState}
        onNext={mockOnNext}
        onBack={mockOnBack}
      />,
    );

    const critInput = screen.getByDisplayValue('95');
    fireEvent.change(critInput, { target: { value: '90' } });

    expect(mockUpdateState).toHaveBeenCalled();
    const call = mockUpdateState.mock.calls[0][0];
    expect(call.alertCriticalPercent).toBe(90);
  });

  it('does not call updateState for alert percent with NaN value', () => {
    render(
      <BudgetWizardStrategy
        state={defaultState}
        updateState={mockUpdateState}
        onNext={mockOnNext}
        onBack={mockOnBack}
      />,
    );

    const warnInput = screen.getByDisplayValue('80');
    fireEvent.change(warnInput, { target: { value: '' } });

    expect(mockUpdateState).not.toHaveBeenCalled();
  });

  it('does not call updateState for alert percent below 1', () => {
    render(
      <BudgetWizardStrategy
        state={defaultState}
        updateState={mockUpdateState}
        onNext={mockOnNext}
        onBack={mockOnBack}
      />,
    );

    const warnInput = screen.getByDisplayValue('80');
    fireEvent.change(warnInput, { target: { value: '0' } });

    expect(mockUpdateState).not.toHaveBeenCalled();
  });

  it('does not call updateState for alert percent above 100', () => {
    render(
      <BudgetWizardStrategy
        state={defaultState}
        updateState={mockUpdateState}
        onNext={mockOnNext}
        onBack={mockOnBack}
      />,
    );

    const critInput = screen.getByDisplayValue('95');
    fireEvent.change(critInput, { target: { value: '101' } });

    expect(mockUpdateState).not.toHaveBeenCalled();
  });

  // --- Alert threshold also updates transfers ---
  it('applies alert warn threshold to transfers as well', () => {
    const stateWithTransfers = {
      ...defaultState,
      selectedTransfers: (() => {
        const map = new Map<string, ApplyBudgetCategoryData>();
        map.set('tr-1', { categoryId: 'tr-1', amount: 200, isIncome: false });
        return map;
      })(),
    };
    render(
      <BudgetWizardStrategy
        state={stateWithTransfers}
        updateState={mockUpdateState}
        onNext={mockOnNext}
        onBack={mockOnBack}
      />,
    );

    const warnInput = screen.getByDisplayValue('80');
    fireEvent.change(warnInput, { target: { value: '70' } });

    const call = mockUpdateState.mock.calls[0][0];
    expect(call.selectedTransfers).toBeInstanceOf(Map);
    const transfer = call.selectedTransfers.get('tr-1');
    expect(transfer?.alertWarnPercent).toBe(70);
  });

  // --- Flex group toggle (Hide) ---
  it('hides flex groups table when Hide is clicked after Configure', () => {
    render(
      <BudgetWizardStrategy
        state={defaultState}
        updateState={mockUpdateState}
        onNext={mockOnNext}
        onBack={mockOnBack}
      />,
    );

    fireEvent.click(screen.getByText('Configure'));
    expect(screen.getByText('Groceries')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Hide'));
    expect(screen.queryByText('Groceries')).not.toBeInTheDocument();
  });

  // --- Flex group empty string → undefined ---
  it('sets flexGroup to undefined when input value is whitespace only', () => {
    const stateWithFlexGroup = {
      ...defaultState,
      selectedCategories: (() => {
        const map = new Map<string, ApplyBudgetCategoryData>();
        map.set('cat-salary', { categoryId: 'cat-salary', amount: 5000, isIncome: true });
        map.set('cat-groceries', {
          categoryId: 'cat-groceries',
          amount: 400,
          isIncome: false,
          flexGroup: 'Food',
        });
        return map;
      })(),
    };
    render(
      <BudgetWizardStrategy
        state={stateWithFlexGroup}
        updateState={mockUpdateState}
        onNext={mockOnNext}
        onBack={mockOnBack}
      />,
    );

    fireEvent.click(screen.getByText('Configure'));
    const input = screen.getByDisplayValue('Food');
    // Clear to whitespace - should set flexGroup to undefined
    fireEvent.change(input, { target: { value: '   ' } });

    expect(mockUpdateState).toHaveBeenCalled();
    const call = mockUpdateState.mock.calls[0][0];
    const groceries = call.selectedCategories.get('cat-groceries');
    expect(groceries?.flexGroup).toBeUndefined();
  });

  // --- Excluded account: unchecking removes from list ---
  it('removes account from excludedAccountIds when unchecked', () => {
    const stateWithExcluded = {
      ...defaultState,
      excludedAccountIds: ['acc-1'],
    };
    render(
      <BudgetWizardStrategy
        state={stateWithExcluded}
        updateState={mockUpdateState}
        accounts={mockAccounts}
        onNext={mockOnNext}
        onBack={mockOnBack}
      />,
    );

    const checkingLabel = screen.getByText('Main Checking').closest('label')!;
    const checkbox = checkingLabel.querySelector('input')!;
    fireEvent.click(checkbox);

    expect(mockUpdateState).toHaveBeenCalledWith({ excludedAccountIds: [] });
  });

  // --- Excluded accounts counter pluralization ---
  it('shows singular account excluded message for 1 excluded account', () => {
    render(
      <BudgetWizardStrategy
        state={{ ...defaultState, excludedAccountIds: ['acc-1'] }}
        updateState={mockUpdateState}
        accounts={mockAccounts}
        onNext={mockOnNext}
        onBack={mockOnBack}
      />,
    );
    expect(screen.getByText('1 account excluded')).toBeInTheDocument();
  });

  it('shows plural accounts excluded message for 2+ excluded accounts', () => {
    render(
      <BudgetWizardStrategy
        state={{ ...defaultState, excludedAccountIds: ['acc-1', 'acc-2'] }}
        updateState={mockUpdateState}
        accounts={mockAccounts}
        onNext={mockOnNext}
        onBack={mockOnBack}
      />,
    );
    expect(screen.getByText('2 accounts excluded')).toBeInTheDocument();
  });

  it('does not show excluded count when no accounts excluded', () => {
    render(
      <BudgetWizardStrategy
        state={{ ...defaultState, excludedAccountIds: [] }}
        updateState={mockUpdateState}
        accounts={mockAccounts}
        onNext={mockOnNext}
        onBack={mockOnBack}
      />,
    );
    expect(screen.queryByText(/account.*excluded/)).not.toBeInTheDocument();
  });

  // --- Closed accounts filtered out ---
  it('does not render closed accounts in the excluded accounts list', () => {
    const accountsWithClosed = [
      ...mockAccounts,
      {
        ...mockAccounts[0],
        id: 'acc-closed',
        name: 'Old Account',
        isClosed: true,
      } as Account,
    ];
    render(
      <BudgetWizardStrategy
        state={defaultState}
        updateState={mockUpdateState}
        accounts={accountsWithClosed}
        onNext={mockOnNext}
        onBack={mockOnBack}
      />,
    );
    expect(screen.queryByText('Old Account')).not.toBeInTheDocument();
  });

  // --- No accounts prop provided ---
  it('does not render excluded accounts section when no accounts', () => {
    render(
      <BudgetWizardStrategy
        state={defaultState}
        updateState={mockUpdateState}
        onNext={mockOnNext}
        onBack={mockOnBack}
      />,
    );
    expect(screen.queryByText('Excluded Accounts')).not.toBeInTheDocument();
  });

  // --- No flex groups section when no expense categories ---
  it('does not render flex groups when no expense categories selected', () => {
    const noExpenseCatState = {
      ...defaultState,
      selectedCategories: (() => {
        const map = new Map<string, ApplyBudgetCategoryData>();
        // Only income category
        map.set('cat-salary', { categoryId: 'cat-salary', amount: 5000, isIncome: true });
        return map;
      })(),
    };
    render(
      <BudgetWizardStrategy
        state={noExpenseCatState}
        updateState={mockUpdateState}
        onNext={mockOnNext}
        onBack={mockOnBack}
      />,
    );
    expect(screen.queryByText('Flex Groups')).not.toBeInTheDocument();
  });

  // --- Budget type change ---
  it('updates budget type on select change', () => {
    render(
      <BudgetWizardStrategy
        state={defaultState}
        updateState={mockUpdateState}
        onNext={mockOnNext}
        onBack={mockOnBack}
      />,
    );

    const select = screen.getByLabelText('Budget Type');
    fireEvent.change(select, { target: { value: 'ANNUAL' } });

    expect(mockUpdateState).toHaveBeenCalledWith({ budgetType: 'ANNUAL' });
  });

  // --- Institution display in excluded accounts ---
  it('shows account type and institution in excluded accounts list', () => {
    render(
      <BudgetWizardStrategy
        state={defaultState}
        updateState={mockUpdateState}
        accounts={mockAccounts}
        onNext={mockOnNext}
        onBack={mockOnBack}
      />,
    );
    expect(screen.getByText(/CHECKING - Test Bank/)).toBeInTheDocument();
  });

  it('shows account type without institution separator when institution is null', () => {
    const accountNoInstitution = [
      {
        ...mockAccounts[0],
        id: 'acc-no-inst',
        name: 'Solo Account',
        institution: null, institutionId: null,
      } as unknown as Account,
    ];
    render(
      <BudgetWizardStrategy
        state={defaultState}
        updateState={mockUpdateState}
        accounts={accountNoInstitution}
        onNext={mockOnNext}
        onBack={mockOnBack}
      />,
    );
    expect(screen.getByText('CHECKING')).toBeInTheDocument();
    // The subtitle should not contain " - " when institution is null
    const subtitle = screen.getByText('CHECKING');
    expect(subtitle.textContent).not.toContain(' - ');
  });
});
