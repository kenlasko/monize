import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@/test/render';
import { BudgetWizard } from './BudgetWizard';

/** What a step sees of the wizard's buckets and of Groceries' assignment. */
function WizardBucketProbe({ state }: { state: any }) {
  return (
    <>
      <output data-testid="bucket-names">{state.buckets.map((b: any) => b.name).join('|')}</output>
      <output data-testid="bucket-keys">{state.buckets.map((b: any) => b.key).join('|')}</output>
      <output data-testid="groceries-bucket">{state.selectedCategories.get('cat-1')?.bucketKey ?? 'none'}</output>
    </>
  );
}

// Mock child components
vi.mock('./BudgetWizardAnalysis', () => ({
  BudgetWizardAnalysis: ({ onNext, onCancel, onAnalysisComplete, updateState }: any) => (
    <div data-testid="step-analysis">
      <button data-testid="choose-bucket" onClick={() => updateState({ strategy: 'BUCKET' })}>Bucket</button>
      <button data-testid="choose-fixed" onClick={() => updateState({ strategy: 'FIXED' })}>Fixed</button>
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
              {
                categoryId: 'cat-2',
                categoryName: 'Groceries Zero',
                isIncome: false,
                suggested: 0,
                median: 0,
                p25: 0,
                p75: 0,
              },
            ],
            transfers: [
              { accountId: 'acc-savings', accountName: 'Savings', suggested: 200, average: 200 },
              { accountId: 'acc-zero', accountName: 'Zero Transfer', suggested: 0, average: 0 },
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
  BudgetWizardCategories: ({ state, updateState, onNext, onBack }: any) => (
    <div data-testid="step-categories">
      <WizardBucketProbe state={state} />
      <button data-testid="clear-buckets" onClick={() => updateState({ buckets: [] })}>
        Clear
      </button>
      <button
        data-testid="rename-first-bucket"
        onClick={() =>
          updateState({ buckets: state.buckets.map((b: any, i: number) => (i === 0 ? { ...b, name: 'Bills' } : b)) })
        }
      >
        Rename
      </button>
      <button
        data-testid="assign-groceries"
        onClick={() => {
          const next = new Map(state.selectedCategories);
          next.set('cat-1', { ...state.selectedCategories.get('cat-1'), bucketKey: state.buckets[0].key });
          updateState({ selectedCategories: next });
        }}
      >
        Assign
      </button>
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
  BudgetWizardReview: ({ state, onComplete, onBack }: any) => (
    <div data-testid="step-review">
      <WizardBucketProbe state={state} />
      <button data-testid="review-create" onClick={onComplete}>Create</button>
      <button data-testid="review-back" onClick={onBack}>Back</button>
    </div>
  ),
}));

describe('BudgetWizard', () => {
  const mockOnComplete = vi.fn();
  const mockOnCancel = vi.fn();
  const originalPushState = window.history.pushState;
  const originalReplaceState = window.history.replaceState;
  const originalBack = window.history.back;
  const mockPushState = vi.fn();
  const mockReplaceState = vi.fn();
  const mockHistoryBack = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    window.history.pushState = mockPushState;
    window.history.replaceState = mockReplaceState;
    window.history.back = mockHistoryBack;
  });

  afterEach(() => {
    window.history.pushState = originalPushState;
    window.history.replaceState = originalReplaceState;
    window.history.back = originalBack;
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

  it('pushes history state on mount with step 0', () => {
    render(
      <BudgetWizard
        onComplete={mockOnComplete}
        onCancel={mockOnCancel}
        defaultCurrency="USD"
      />,
    );

    expect(mockPushState).toHaveBeenCalledWith({ wizardStep: 0 }, '');
  });

  it('pushes history state when advancing steps', () => {
    render(
      <BudgetWizard
        onComplete={mockOnComplete}
        onCancel={mockOnCancel}
        defaultCurrency="USD"
      />,
    );

    fireEvent.click(screen.getByTestId('analyze-btn'));
    expect(mockPushState).toHaveBeenCalledWith({ wizardStep: 1 }, '');

    fireEvent.click(screen.getByTestId('categories-next'));
    expect(mockPushState).toHaveBeenCalledWith({ wizardStep: 2 }, '');
  });

  it('calls history.back when going back', () => {
    render(
      <BudgetWizard
        onComplete={mockOnComplete}
        onCancel={mockOnCancel}
        defaultCurrency="USD"
      />,
    );

    fireEvent.click(screen.getByTestId('analyze-btn'));
    fireEvent.click(screen.getByTestId('categories-back'));
    expect(mockHistoryBack).toHaveBeenCalled();
  });

  it('responds to popstate events for browser back navigation', () => {
    render(
      <BudgetWizard
        onComplete={mockOnComplete}
        onCancel={mockOnCancel}
        defaultCurrency="USD"
      />,
    );

    // Advance to step 2
    fireEvent.click(screen.getByTestId('analyze-btn'));
    expect(screen.getByTestId('step-categories')).toBeInTheDocument();

    // Simulate browser back button via popstate
    act(() => {
      const popStateEvent = new PopStateEvent('popstate', {
        state: { wizardStep: 0 },
      });
      window.dispatchEvent(popStateEvent);
    });

    expect(screen.getByTestId('step-analysis')).toBeInTheDocument();
  });

  it('calls onCancel when popstate event has no wizardStep in state', () => {
    render(
      <BudgetWizard
        onComplete={mockOnComplete}
        onCancel={mockOnCancel}
        defaultCurrency="USD"
      />,
    );

    // Simulate browser back past the wizard start (null state)
    act(() => {
      const popStateEvent = new PopStateEvent('popstate', { state: null });
      window.dispatchEvent(popStateEvent);
    });

    expect(mockOnCancel).toHaveBeenCalled();
  });

  it('calls onCancel when popstate event state is empty object', () => {
    render(
      <BudgetWizard
        onComplete={mockOnComplete}
        onCancel={mockOnCancel}
        defaultCurrency="USD"
      />,
    );

    // Simulate popstate with state that has no wizardStep
    act(() => {
      const popStateEvent = new PopStateEvent('popstate', { state: {} });
      window.dispatchEvent(popStateEvent);
    });

    expect(mockOnCancel).toHaveBeenCalled();
  });

  it('initializes categories from analysis successfully', () => {
    render(
      <BudgetWizard
        onComplete={mockOnComplete}
        onCancel={mockOnCancel}
        defaultCurrency="USD"
      />,
    );

    // Click analyze which triggers onAnalysisComplete
    fireEvent.click(screen.getByTestId('analyze-btn'));
    // Verify we advanced to categories step (analysis completed with categories)
    expect(screen.getByTestId('step-categories')).toBeInTheDocument();
  });

  describe('Bucket strategy', () => {
    const renderWizard = () =>
      render(<BudgetWizard onComplete={mockOnComplete} onCancel={mockOnCancel} defaultCurrency="USD" />);
    const popTo = (step: number) =>
      act(() => {
        window.dispatchEvent(new PopStateEvent('popstate', { state: { wizardStep: step } }));
      });

    it('pre-applies the Three buckets preset with translated names and assigns no line', () => {
      renderWizard();
      fireEvent.click(screen.getByTestId('choose-bucket'));
      fireEvent.click(screen.getByTestId('analyze-btn'));

      expect(screen.getByTestId('bucket-names')).toHaveTextContent('Fixed costs|Everyday spending|Savings');
      const keys = screen.getByTestId('bucket-keys').textContent!.split('|');
      expect(new Set(keys).size).toBe(3);
      expect(keys.every((k) => k.length >= 1 && k.length <= 40)).toBe(true);
      expect(screen.getByTestId('groceries-bucket')).toHaveTextContent('none');
    });

    it('does not pre-apply buckets for another strategy', () => {
      renderWizard();
      fireEvent.click(screen.getByTestId('choose-fixed'));
      fireEvent.click(screen.getByTestId('analyze-btn'));
      expect(screen.getByTestId('bucket-names')).toBeEmptyDOMElement();
    });

    it('keeps edited buckets and assignments when the analysis is run again, even via another strategy', () => {
      renderWizard();
      fireEvent.click(screen.getByTestId('choose-bucket'));
      fireEvent.click(screen.getByTestId('analyze-btn'));
      const keys = screen.getByTestId('bucket-keys').textContent;
      fireEvent.click(screen.getByTestId('rename-first-bucket'));
      fireEvent.click(screen.getByTestId('assign-groceries'));

      // Back, re-run with Bucket: the preset is not applied a second time.
      fireEvent.click(screen.getByTestId('categories-back'));
      fireEvent.click(screen.getByTestId('analyze-btn'));
      expect(screen.getByTestId('bucket-names')).toHaveTextContent('Bills|Everyday spending|Savings');
      expect(screen.getByTestId('bucket-keys')).toHaveTextContent(keys!);
      expect(screen.getByTestId('groceries-bucket')).toHaveTextContent(keys!.split('|')[0]);

      // Away to Fixed and back to Bucket: the buckets are still the edited ones.
      fireEvent.click(screen.getByTestId('categories-back'));
      fireEvent.click(screen.getByTestId('choose-fixed'));
      fireEvent.click(screen.getByTestId('analyze-btn'));
      expect(screen.getByTestId('bucket-names')).toHaveTextContent('Bills|Everyday spending|Savings');
      expect(screen.getByTestId('groceries-bucket')).toHaveTextContent('none');
      fireEvent.click(screen.getByTestId('categories-back'));
      fireEvent.click(screen.getByTestId('choose-bucket'));
      fireEvent.click(screen.getByTestId('analyze-btn'));
      expect(screen.getByTestId('bucket-names')).toHaveTextContent('Bills|Everyday spending|Savings');
      expect(screen.getByTestId('bucket-keys')).toHaveTextContent(keys!);
    });

    it('leaves an emptied bucket list empty when the analysis is run again', () => {
      renderWizard();
      fireEvent.click(screen.getByTestId('choose-bucket'));
      fireEvent.click(screen.getByTestId('analyze-btn'));
      expect(screen.getByTestId('bucket-names')).toHaveTextContent('Fixed costs|Everyday spending|Savings');

      // Start from scratch, then back and re-run: the preset does not return.
      fireEvent.click(screen.getByTestId('clear-buckets'));
      fireEvent.click(screen.getByTestId('categories-back'));
      fireEvent.click(screen.getByTestId('analyze-btn'));
      expect(screen.getByTestId('bucket-names')).toBeEmptyDOMElement();
    });

    it('keeps buckets and assignments across back and forward navigation', () => {
      renderWizard();
      fireEvent.click(screen.getByTestId('choose-bucket'));
      fireEvent.click(screen.getByTestId('analyze-btn'));
      fireEvent.click(screen.getByTestId('rename-first-bucket'));
      fireEvent.click(screen.getByTestId('assign-groceries'));
      const firstKey = screen.getByTestId('bucket-keys').textContent!.split('|')[0];
      fireEvent.click(screen.getByTestId('categories-next'));
      fireEvent.click(screen.getByTestId('strategy-next'));
      expect(screen.getByTestId('step-review')).toBeInTheDocument();
      expect(screen.getByTestId('bucket-names')).toHaveTextContent('Bills|Everyday spending|Savings');
      expect(screen.getByTestId('groceries-bucket')).toHaveTextContent(firstKey);

      // Browser back to the analysis step, then forward again.
      popTo(0);
      expect(screen.getByTestId('step-analysis')).toBeInTheDocument();
      popTo(1);
      expect(screen.getByTestId('bucket-names')).toHaveTextContent('Bills|Everyday spending|Savings');
      expect(screen.getByTestId('groceries-bucket')).toHaveTextContent(firstKey);
      popTo(3);
      expect(screen.getByTestId('step-review')).toBeInTheDocument();
      expect(screen.getByTestId('groceries-bucket')).toHaveTextContent(firstKey);
    });
  });
});
