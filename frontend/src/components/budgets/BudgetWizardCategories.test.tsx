import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { BudgetWizardCategories } from './BudgetWizardCategories';
import type { WizardState } from './BudgetWizard';
import type { GenerateBudgetResponse, ApplyBudgetCategoryData } from '@/types/budget';

// Mock format
vi.mock('@/lib/format', () => ({
  formatCurrency: vi.fn((amount: number) => `$${amount.toFixed(2)}`),
  getCurrencySymbol: vi.fn(() => '$'),
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
    budgetName: 'Test Budget',
    budgetType: 'MONTHLY',
    periodStart: '2026-02-01',
    currencyCode: 'USD',
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
    expect(screen.getByText('Net (Savings)')).toBeInTheDocument();
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
});
