import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { BudgetWizard } from './BudgetWizard';

// Mock child components
vi.mock('./BudgetWizardAnalysis', () => ({
  BudgetWizardAnalysis: ({ onNext, onCancel, onAnalysisComplete }: any) => (
    <div data-testid="step-analysis">
      <button
        data-testid="analyze-btn"
        onClick={() => {
          onAnalysisComplete({
            categories: [
              {
                categoryId: 'cat-1',
                categoryName: 'Groceries',
                isIncome: false,
                suggested: 500,
                median: 500,
                p25: 300,
                p75: 700,
              },
            ],
            estimatedMonthlyIncome: 5000,
            totalBudgeted: 500,
            projectedMonthlySavings: 4500,
            analysisWindow: { startDate: '2025-08-01', endDate: '2026-02-01', months: 6 },
          });
          onNext();
        }}
      >
        Analyze
      </button>
      <button data-testid="cancel-btn" onClick={onCancel}>Cancel</button>
    </div>
  ),
}));

vi.mock('./BudgetWizardCategories', () => ({
  BudgetWizardCategories: ({ onNext, onBack }: any) => (
    <div data-testid="step-categories">
      <button data-testid="categories-next" onClick={onNext}>Next</button>
      <button data-testid="categories-back" onClick={onBack}>Back</button>
    </div>
  ),
}));

vi.mock('./BudgetWizardStrategy', () => ({
  BudgetWizardStrategy: ({ onNext, onBack }: any) => (
    <div data-testid="step-strategy">
      <button data-testid="strategy-next" onClick={onNext}>Next</button>
      <button data-testid="strategy-back" onClick={onBack}>Back</button>
    </div>
  ),
}));

vi.mock('./BudgetWizardReview', () => ({
  BudgetWizardReview: ({ onComplete, onBack }: any) => (
    <div data-testid="step-review">
      <button data-testid="review-create" onClick={onComplete}>Create</button>
      <button data-testid="review-back" onClick={onBack}>Back</button>
    </div>
  ),
}));

describe('BudgetWizard', () => {
  const mockOnComplete = vi.fn();
  const mockOnCancel = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders step 1 (Analysis) by default', () => {
    render(
      <BudgetWizard
        onComplete={mockOnComplete}
        onCancel={mockOnCancel}
        defaultCurrency="USD"
      />,
    );

    expect(screen.getByTestId('step-analysis')).toBeInTheDocument();
  });

  it('renders step indicators', () => {
    render(
      <BudgetWizard
        onComplete={mockOnComplete}
        onCancel={mockOnCancel}
        defaultCurrency="USD"
      />,
    );

    expect(screen.getAllByText('Analyze').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Categories')).toBeInTheDocument();
    expect(screen.getByText('Configure')).toBeInTheDocument();
    expect(screen.getByText('Review')).toBeInTheDocument();
  });

  it('advances to step 2 after analysis', () => {
    render(
      <BudgetWizard
        onComplete={mockOnComplete}
        onCancel={mockOnCancel}
        defaultCurrency="USD"
      />,
    );

    fireEvent.click(screen.getByTestId('analyze-btn'));

    expect(screen.getByTestId('step-categories')).toBeInTheDocument();
  });

  it('advances through all steps in order', () => {
    render(
      <BudgetWizard
        onComplete={mockOnComplete}
        onCancel={mockOnCancel}
        defaultCurrency="USD"
      />,
    );

    // Step 1 -> Step 2
    fireEvent.click(screen.getByTestId('analyze-btn'));
    expect(screen.getByTestId('step-categories')).toBeInTheDocument();

    // Step 2 -> Step 3
    fireEvent.click(screen.getByTestId('categories-next'));
    expect(screen.getByTestId('step-strategy')).toBeInTheDocument();

    // Step 3 -> Step 4
    fireEvent.click(screen.getByTestId('strategy-next'));
    expect(screen.getByTestId('step-review')).toBeInTheDocument();
  });

  it('can go back from step 2 to step 1', () => {
    render(
      <BudgetWizard
        onComplete={mockOnComplete}
        onCancel={mockOnCancel}
        defaultCurrency="USD"
      />,
    );

    fireEvent.click(screen.getByTestId('analyze-btn'));
    expect(screen.getByTestId('step-categories')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('categories-back'));
    expect(screen.getByTestId('step-analysis')).toBeInTheDocument();
  });

  it('calls onCancel when cancel is clicked', () => {
    render(
      <BudgetWizard
        onComplete={mockOnComplete}
        onCancel={mockOnCancel}
        defaultCurrency="USD"
      />,
    );

    fireEvent.click(screen.getByTestId('cancel-btn'));
    expect(mockOnCancel).toHaveBeenCalled();
  });

  it('calls onComplete when review step creates budget', () => {
    render(
      <BudgetWizard
        onComplete={mockOnComplete}
        onCancel={mockOnCancel}
        defaultCurrency="USD"
      />,
    );

    // Go through all steps
    fireEvent.click(screen.getByTestId('analyze-btn'));
    fireEvent.click(screen.getByTestId('categories-next'));
    fireEvent.click(screen.getByTestId('strategy-next'));

    fireEvent.click(screen.getByTestId('review-create'));
    expect(mockOnComplete).toHaveBeenCalled();
  });

  it('can navigate back from review to strategy', () => {
    render(
      <BudgetWizard
        onComplete={mockOnComplete}
        onCancel={mockOnCancel}
        defaultCurrency="USD"
      />,
    );

    // Go to review
    fireEvent.click(screen.getByTestId('analyze-btn'));
    fireEvent.click(screen.getByTestId('categories-next'));
    fireEvent.click(screen.getByTestId('strategy-next'));
    expect(screen.getByTestId('step-review')).toBeInTheDocument();

    // Go back
    fireEvent.click(screen.getByTestId('review-back'));
    expect(screen.getByTestId('step-strategy')).toBeInTheDocument();
  });
});
