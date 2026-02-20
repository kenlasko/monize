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
      isDefault: true,
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
      isDefault: false,
      canDelete: true,
      createdAt: '2025-01-01',
      updatedAt: '2025-01-01',
    },
  ] as Account[];

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
});
