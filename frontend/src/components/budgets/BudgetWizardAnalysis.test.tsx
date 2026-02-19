import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@/test/render';
import { BudgetWizardAnalysis } from './BudgetWizardAnalysis';
import type { WizardState } from './BudgetWizard';

// Mock budgets API
const mockGenerate = vi.fn();
vi.mock('@/lib/budgets', () => ({
  budgetsApi: {
    generate: (...args: any[]) => mockGenerate(...args),
  },
}));

// Mock errors
vi.mock('@/lib/errors', () => ({
  getErrorMessage: vi.fn((_e: any, fallback: string) => fallback),
}));

describe('BudgetWizardAnalysis', () => {
  const defaultState: WizardState = {
    analysisMonths: 6,
    profile: 'ON_TRACK',
    strategy: 'FIXED',
    analysisResult: null,
    selectedCategories: new Map(),
    selectedTransfers: new Map(),
    budgetName: 'Test Budget',
    budgetType: 'MONTHLY',
    periodStart: '2026-02-01',
    currencyCode: 'USD',
    isSubmitting: false,
  };

  const mockUpdateState = vi.fn();
  const mockOnAnalysisComplete = vi.fn();
  const mockOnNext = vi.fn();
  const mockOnCancel = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders strategy selection cards', () => {
    render(
      <BudgetWizardAnalysis
        state={defaultState}
        updateState={mockUpdateState}
        onAnalysisComplete={mockOnAnalysisComplete}
        onNext={mockOnNext}
        onCancel={mockOnCancel}
      />,
    );

    expect(screen.getByText('Fixed')).toBeInTheDocument();
    expect(screen.getByText('Rollover')).toBeInTheDocument();
    expect(screen.getByText('Zero-Based')).toBeInTheDocument();
    expect(screen.getByText('50/30/20')).toBeInTheDocument();
  });

  it('renders analysis period options', () => {
    render(
      <BudgetWizardAnalysis
        state={defaultState}
        updateState={mockUpdateState}
        onAnalysisComplete={mockOnAnalysisComplete}
        onNext={mockOnNext}
        onCancel={mockOnCancel}
      />,
    );

    expect(screen.getByText('3 months')).toBeInTheDocument();
    expect(screen.getByText('6 months')).toBeInTheDocument();
    expect(screen.getByText('12 months')).toBeInTheDocument();
  });

  it('renders profile options', () => {
    render(
      <BudgetWizardAnalysis
        state={defaultState}
        updateState={mockUpdateState}
        onAnalysisComplete={mockOnAnalysisComplete}
        onNext={mockOnNext}
        onCancel={mockOnCancel}
      />,
    );

    expect(screen.getByText('Comfortable')).toBeInTheDocument();
    expect(screen.getByText('On Track')).toBeInTheDocument();
    expect(screen.getByText('Aggressive')).toBeInTheDocument();
  });

  it('updates strategy when card is clicked', () => {
    render(
      <BudgetWizardAnalysis
        state={defaultState}
        updateState={mockUpdateState}
        onAnalysisComplete={mockOnAnalysisComplete}
        onNext={mockOnNext}
        onCancel={mockOnCancel}
      />,
    );

    fireEvent.click(screen.getByText('Rollover'));
    expect(mockUpdateState).toHaveBeenCalledWith({ strategy: 'ROLLOVER' });
  });

  it('updates analysis period when clicked', () => {
    render(
      <BudgetWizardAnalysis
        state={defaultState}
        updateState={mockUpdateState}
        onAnalysisComplete={mockOnAnalysisComplete}
        onNext={mockOnNext}
        onCancel={mockOnCancel}
      />,
    );

    fireEvent.click(screen.getByText('3 months'));
    expect(mockUpdateState).toHaveBeenCalledWith({ analysisMonths: 3 });
  });

  it('updates profile when clicked', () => {
    render(
      <BudgetWizardAnalysis
        state={defaultState}
        updateState={mockUpdateState}
        onAnalysisComplete={mockOnAnalysisComplete}
        onNext={mockOnNext}
        onCancel={mockOnCancel}
      />,
    );

    fireEvent.click(screen.getByText('Aggressive'));
    expect(mockUpdateState).toHaveBeenCalledWith({ profile: 'AGGRESSIVE' });
  });

  it('calls generate API and advances on analyze click', async () => {
    const mockResult = {
      categories: [{ categoryId: 'cat-1', categoryName: 'Groceries', isIncome: false, suggested: 500 }],
      estimatedMonthlyIncome: 5000,
      totalBudgeted: 500,
      projectedMonthlySavings: 4500,
      analysisWindow: { startDate: '2025-08-01', endDate: '2026-02-01', months: 6 },
    };
    mockGenerate.mockResolvedValue(mockResult);

    render(
      <BudgetWizardAnalysis
        state={defaultState}
        updateState={mockUpdateState}
        onAnalysisComplete={mockOnAnalysisComplete}
        onNext={mockOnNext}
        onCancel={mockOnCancel}
      />,
    );

    fireEvent.click(screen.getByText('Analyze My Spending'));

    await waitFor(() => {
      expect(mockGenerate).toHaveBeenCalledWith({
        analysisMonths: 6,
        strategy: 'FIXED',
        profile: 'ON_TRACK',
      });
      expect(mockOnAnalysisComplete).toHaveBeenCalledWith(mockResult);
      expect(mockOnNext).toHaveBeenCalled();
    });
  });

  it('calls onCancel when cancel button is clicked', () => {
    render(
      <BudgetWizardAnalysis
        state={defaultState}
        updateState={mockUpdateState}
        onAnalysisComplete={mockOnAnalysisComplete}
        onNext={mockOnNext}
        onCancel={mockOnCancel}
      />,
    );

    fireEvent.click(screen.getByText('Cancel'));
    expect(mockOnCancel).toHaveBeenCalled();
  });
});
