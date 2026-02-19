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
vi.mock('@/lib/format', () => ({
  formatCurrency: vi.fn((amount: number) => `$${amount.toFixed(2)}`),
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
    currencyCode: 'USD',
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

    expect(screen.getByText('Total Budget')).toBeInTheDocument();
    expect(screen.getByText('Est. Income')).toBeInTheDocument();
    expect(screen.getByText('Projected Savings')).toBeInTheDocument();
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
});
