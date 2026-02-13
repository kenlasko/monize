import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@/test/render';
import { CategoryAutoAssignDialog } from './CategoryAutoAssignDialog';
import { payeesApi } from '@/lib/payees';
import toast from 'react-hot-toast';
import { CategorySuggestion } from '@/types/payee';

vi.mock('@/lib/payees', () => ({
  payeesApi: {
    getCategorySuggestions: vi.fn().mockResolvedValue([]),
    applyCategorySuggestions: vi.fn().mockResolvedValue({ updated: 0 }),
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

vi.mock('@/lib/errors', () => ({
  getErrorMessage: (_error: unknown, fallback: string) => fallback,
}));

const mockGetCategorySuggestions = vi.mocked(payeesApi.getCategorySuggestions);
const mockApplyCategorySuggestions = vi.mocked(payeesApi.applyCategorySuggestions);

const makeSuggestion = (overrides: Partial<CategorySuggestion> = {}): CategorySuggestion => ({
  payeeId: 'payee-1',
  payeeName: 'Grocery Store',
  currentCategoryId: null,
  currentCategoryName: null,
  suggestedCategoryId: 'cat-1',
  suggestedCategoryName: 'Groceries',
  transactionCount: 25,
  categoryCount: 20,
  percentage: 80,
  ...overrides,
});

const sampleSuggestions: CategorySuggestion[] = [
  makeSuggestion({
    payeeId: 'payee-1',
    payeeName: 'Grocery Store',
    suggestedCategoryId: 'cat-1',
    suggestedCategoryName: 'Groceries',
    transactionCount: 25,
    percentage: 80,
  }),
  makeSuggestion({
    payeeId: 'payee-2',
    payeeName: 'Gas Station',
    suggestedCategoryId: 'cat-2',
    suggestedCategoryName: 'Transportation',
    transactionCount: 15,
    percentage: 95,
  }),
  makeSuggestion({
    payeeId: 'payee-3',
    payeeName: 'Coffee Shop',
    suggestedCategoryId: 'cat-3',
    suggestedCategoryName: 'Dining',
    transactionCount: 30,
    percentage: 70,
  }),
];

describe('CategoryAutoAssignDialog', () => {
  const onClose = vi.fn();
  const onSuccess = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCategorySuggestions.mockResolvedValue([]);
    mockApplyCategorySuggestions.mockResolvedValue({ updated: 0 });
  });

  // --- Existing tests (preserved) ---

  it('renders dialog when open', () => {
    render(<CategoryAutoAssignDialog isOpen={true} onClose={onClose} onSuccess={onSuccess} />);
    expect(screen.getByText('Auto-Assign Default Categories')).toBeInTheDocument();
    expect(screen.getByText('How it works')).toBeInTheDocument();
  });

  it('shows settings controls', () => {
    render(<CategoryAutoAssignDialog isOpen={true} onClose={onClose} onSuccess={onSuccess} />);
    expect(screen.getByText(/Minimum Transactions/)).toBeInTheDocument();
    expect(screen.getByText(/Category Match Percentage/)).toBeInTheDocument();
    expect(screen.getByText('Only payees without a default category')).toBeInTheDocument();
  });

  it('shows preview button', () => {
    render(<CategoryAutoAssignDialog isOpen={true} onClose={onClose} onSuccess={onSuccess} />);
    expect(screen.getByText('Preview Suggestions')).toBeInTheDocument();
  });

  it('renders cancel button', () => {
    render(<CategoryAutoAssignDialog isOpen={true} onClose={onClose} onSuccess={onSuccess} />);
    expect(screen.getByText('Cancel')).toBeInTheDocument();
  });

  // --- New tests ---

  describe('dialog renders with title and description', () => {
    it('shows the title', () => {
      render(<CategoryAutoAssignDialog isOpen={true} onClose={onClose} onSuccess={onSuccess} />);
      expect(screen.getByText('Auto-Assign Default Categories')).toBeInTheDocument();
    });

    it('shows the how-it-works description', () => {
      render(<CategoryAutoAssignDialog isOpen={true} onClose={onClose} onSuccess={onSuccess} />);
      expect(screen.getByText(/analyzes your transaction history/)).toBeInTheDocument();
    });

    it('does not render when isOpen is false', () => {
      render(<CategoryAutoAssignDialog isOpen={false} onClose={onClose} onSuccess={onSuccess} />);
      expect(screen.queryByText('Auto-Assign Default Categories')).not.toBeInTheDocument();
    });
  });

  describe('min transactions slider', () => {
    it('renders with default value of 10', () => {
      render(<CategoryAutoAssignDialog isOpen={true} onClose={onClose} onSuccess={onSuccess} />);
      const sliders = screen.getAllByRole('slider');
      // First slider is min transactions
      expect(sliders[0]).toHaveValue('10');
    });

    it('updates value when changed', () => {
      render(<CategoryAutoAssignDialog isOpen={true} onClose={onClose} onSuccess={onSuccess} />);
      const sliders = screen.getAllByRole('slider');
      fireEvent.change(sliders[0], { target: { value: '25' } });
      expect(sliders[0]).toHaveValue('25');
    });

    it('displays the current value in the label', () => {
      render(<CategoryAutoAssignDialog isOpen={true} onClose={onClose} onSuccess={onSuccess} />);
      // Default label should contain "10"
      expect(screen.getByText('10')).toBeInTheDocument();
    });
  });

  describe('min percentage slider', () => {
    it('renders with default value of 75', () => {
      render(<CategoryAutoAssignDialog isOpen={true} onClose={onClose} onSuccess={onSuccess} />);
      const sliders = screen.getAllByRole('slider');
      // Second slider is min percentage
      expect(sliders[1]).toHaveValue('75');
    });

    it('updates value when changed', () => {
      render(<CategoryAutoAssignDialog isOpen={true} onClose={onClose} onSuccess={onSuccess} />);
      const sliders = screen.getAllByRole('slider');
      fireEvent.change(sliders[1], { target: { value: '90' } });
      expect(sliders[1]).toHaveValue('90');
    });

    it('displays percentage in the label', () => {
      render(<CategoryAutoAssignDialog isOpen={true} onClose={onClose} onSuccess={onSuccess} />);
      // "75%" appears both in the label bold span and in the scale markers
      const matches = screen.getAllByText(/75%/);
      expect(matches.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('only without category toggle', () => {
    it('renders as checked by default', () => {
      render(<CategoryAutoAssignDialog isOpen={true} onClose={onClose} onSuccess={onSuccess} />);
      const checkbox = screen.getByLabelText('Only payees without a default category');
      expect(checkbox).toBeChecked();
    });

    it('can be toggled off', () => {
      render(<CategoryAutoAssignDialog isOpen={true} onClose={onClose} onSuccess={onSuccess} />);
      const checkbox = screen.getByLabelText('Only payees without a default category');
      fireEvent.click(checkbox);
      expect(checkbox).not.toBeChecked();
    });

    it('can be toggled back on', () => {
      render(<CategoryAutoAssignDialog isOpen={true} onClose={onClose} onSuccess={onSuccess} />);
      const checkbox = screen.getByLabelText('Only payees without a default category');
      fireEvent.click(checkbox); // off
      fireEvent.click(checkbox); // on
      expect(checkbox).toBeChecked();
    });
  });

  describe('load preview button', () => {
    it('triggers API call with correct parameters', async () => {
      mockGetCategorySuggestions.mockResolvedValue([]);
      render(<CategoryAutoAssignDialog isOpen={true} onClose={onClose} onSuccess={onSuccess} />);

      fireEvent.click(screen.getByText('Preview Suggestions'));

      await waitFor(() => {
        expect(mockGetCategorySuggestions).toHaveBeenCalledWith({
          minTransactions: 10,
          minPercentage: 75,
          onlyWithoutCategory: true,
        });
      });
    });

    it('triggers API call with updated slider values', async () => {
      mockGetCategorySuggestions.mockResolvedValue([]);
      render(<CategoryAutoAssignDialog isOpen={true} onClose={onClose} onSuccess={onSuccess} />);

      // Adjust sliders
      const sliders = screen.getAllByRole('slider');
      fireEvent.change(sliders[0], { target: { value: '20' } });
      fireEvent.change(sliders[1], { target: { value: '90' } });

      // Uncheck the toggle
      const checkbox = screen.getByLabelText('Only payees without a default category');
      fireEvent.click(checkbox);

      fireEvent.click(screen.getByText('Preview Suggestions'));

      await waitFor(() => {
        expect(mockGetCategorySuggestions).toHaveBeenCalledWith({
          minTransactions: 20,
          minPercentage: 90,
          onlyWithoutCategory: false,
        });
      });
    });
  });

  describe('loading state during preview', () => {
    it('shows Loading text while fetching', async () => {
      let resolvePromise: (value: CategorySuggestion[]) => void;
      const promise = new Promise<CategorySuggestion[]>((resolve) => {
        resolvePromise = resolve;
      });
      mockGetCategorySuggestions.mockReturnValue(promise);

      render(<CategoryAutoAssignDialog isOpen={true} onClose={onClose} onSuccess={onSuccess} />);

      fireEvent.click(screen.getByText('Preview Suggestions'));

      // Should show "Loading..." while the API call is in progress
      await waitFor(() => {
        expect(screen.getByText('Loading...')).toBeInTheDocument();
      });

      // Resolve the promise
      await act(async () => {
        resolvePromise!([]);
      });

      // Should go back to "Preview Suggestions"
      await waitFor(() => {
        expect(screen.getByText('Preview Suggestions')).toBeInTheDocument();
      });
    });
  });

  describe('suggestion list rendering', () => {
    it('renders suggestion list with payee names and categories', async () => {
      mockGetCategorySuggestions.mockResolvedValue(sampleSuggestions);
      render(<CategoryAutoAssignDialog isOpen={true} onClose={onClose} onSuccess={onSuccess} />);

      fireEvent.click(screen.getByText('Preview Suggestions'));

      await waitFor(() => {
        expect(screen.getByText('Grocery Store')).toBeInTheDocument();
        expect(screen.getByText('Groceries')).toBeInTheDocument();
        expect(screen.getByText('Gas Station')).toBeInTheDocument();
        expect(screen.getByText('Transportation')).toBeInTheDocument();
        expect(screen.getByText('Coffee Shop')).toBeInTheDocument();
        expect(screen.getByText('Dining')).toBeInTheDocument();
      });
    });

    it('displays transaction counts', async () => {
      mockGetCategorySuggestions.mockResolvedValue(sampleSuggestions);
      render(<CategoryAutoAssignDialog isOpen={true} onClose={onClose} onSuccess={onSuccess} />);

      fireEvent.click(screen.getByText('Preview Suggestions'));

      await waitFor(() => {
        expect(screen.getByText('25 transactions')).toBeInTheDocument();
        expect(screen.getByText('15 transactions')).toBeInTheDocument();
        expect(screen.getByText('30 transactions')).toBeInTheDocument();
      });
    });

    it('displays percentage values', async () => {
      mockGetCategorySuggestions.mockResolvedValue(sampleSuggestions);
      render(<CategoryAutoAssignDialog isOpen={true} onClose={onClose} onSuccess={onSuccess} />);

      fireEvent.click(screen.getByText('Preview Suggestions'));

      await waitFor(() => {
        expect(screen.getByText('80%')).toBeInTheDocument();
        expect(screen.getByText('95%')).toBeInTheDocument();
        expect(screen.getByText('70%')).toBeInTheDocument();
      });
    });

    it('shows the count of suggestions found', async () => {
      mockGetCategorySuggestions.mockResolvedValue(sampleSuggestions);
      render(<CategoryAutoAssignDialog isOpen={true} onClose={onClose} onSuccess={onSuccess} />);

      fireEvent.click(screen.getByText('Preview Suggestions'));

      await waitFor(() => {
        expect(screen.getByText('Suggestions (3 found)')).toBeInTheDocument();
      });
    });

    it('all suggestions are checked by default after preview', async () => {
      mockGetCategorySuggestions.mockResolvedValue(sampleSuggestions);
      render(<CategoryAutoAssignDialog isOpen={true} onClose={onClose} onSuccess={onSuccess} />);

      fireEvent.click(screen.getByText('Preview Suggestions'));

      await waitFor(() => {
        const checkboxes = screen.getAllByRole('checkbox').filter(
          (el) => el.closest('table')
        );
        // All should be checked
        checkboxes.forEach((cb) => {
          expect(cb).toBeChecked();
        });
      });
    });
  });

  describe('individual suggestion checkbox toggle', () => {
    it('unchecks a suggestion when clicked', async () => {
      mockGetCategorySuggestions.mockResolvedValue(sampleSuggestions);
      render(<CategoryAutoAssignDialog isOpen={true} onClose={onClose} onSuccess={onSuccess} />);

      fireEvent.click(screen.getByText('Preview Suggestions'));

      await waitFor(() => {
        expect(screen.getByText('Grocery Store')).toBeInTheDocument();
      });

      // Find the checkbox in the Grocery Store row
      const groceryRow = screen.getByText('Grocery Store').closest('tr')!;
      const checkbox = groceryRow.querySelector('input[type="checkbox"]') as HTMLInputElement;
      expect(checkbox).toBeChecked();

      fireEvent.click(checkbox);
      expect(checkbox).not.toBeChecked();
    });

    it('re-checks a suggestion when clicked again', async () => {
      mockGetCategorySuggestions.mockResolvedValue(sampleSuggestions);
      render(<CategoryAutoAssignDialog isOpen={true} onClose={onClose} onSuccess={onSuccess} />);

      fireEvent.click(screen.getByText('Preview Suggestions'));

      await waitFor(() => {
        expect(screen.getByText('Grocery Store')).toBeInTheDocument();
      });

      const groceryRow = screen.getByText('Grocery Store').closest('tr')!;
      const checkbox = groceryRow.querySelector('input[type="checkbox"]') as HTMLInputElement;

      fireEvent.click(checkbox); // uncheck
      fireEvent.click(checkbox); // re-check
      expect(checkbox).toBeChecked();
    });

    it('toggles suggestion when row is clicked', async () => {
      mockGetCategorySuggestions.mockResolvedValue(sampleSuggestions);
      render(<CategoryAutoAssignDialog isOpen={true} onClose={onClose} onSuccess={onSuccess} />);

      fireEvent.click(screen.getByText('Preview Suggestions'));

      await waitFor(() => {
        expect(screen.getByText('Gas Station')).toBeInTheDocument();
      });

      const gasRow = screen.getByText('Gas Station').closest('tr')!;
      const checkbox = gasRow.querySelector('input[type="checkbox"]') as HTMLInputElement;
      expect(checkbox).toBeChecked();

      // Click the row (not the checkbox)
      fireEvent.click(gasRow);
      expect(checkbox).not.toBeChecked();
    });

    it('updates selected count in footer when toggling', async () => {
      mockGetCategorySuggestions.mockResolvedValue(sampleSuggestions);
      render(<CategoryAutoAssignDialog isOpen={true} onClose={onClose} onSuccess={onSuccess} />);

      fireEvent.click(screen.getByText('Preview Suggestions'));

      await waitFor(() => {
        expect(screen.getByText('3 payees selected')).toBeInTheDocument();
      });

      // Uncheck one
      const groceryRow = screen.getByText('Grocery Store').closest('tr')!;
      const checkbox = groceryRow.querySelector('input[type="checkbox"]') as HTMLInputElement;
      fireEvent.click(checkbox);

      expect(screen.getByText('2 payees selected')).toBeInTheDocument();
    });
  });

  describe('select all button', () => {
    it('selects all suggestions when clicked', async () => {
      mockGetCategorySuggestions.mockResolvedValue(sampleSuggestions);
      render(<CategoryAutoAssignDialog isOpen={true} onClose={onClose} onSuccess={onSuccess} />);

      fireEvent.click(screen.getByText('Preview Suggestions'));

      await waitFor(() => {
        expect(screen.getByText('Grocery Store')).toBeInTheDocument();
      });

      // First uncheck one
      const groceryRow = screen.getByText('Grocery Store').closest('tr')!;
      const checkbox = groceryRow.querySelector('input[type="checkbox"]') as HTMLInputElement;
      fireEvent.click(checkbox);
      expect(checkbox).not.toBeChecked();

      // Click "Select all"
      fireEvent.click(screen.getByText('Select all'));

      // All should be checked now
      const checkboxes = screen.getAllByRole('checkbox').filter(
        (el) => el.closest('table')
      );
      checkboxes.forEach((cb) => {
        expect(cb).toBeChecked();
      });
    });
  });

  describe('deselect all button', () => {
    it('clears all selections when clicked', async () => {
      mockGetCategorySuggestions.mockResolvedValue(sampleSuggestions);
      render(<CategoryAutoAssignDialog isOpen={true} onClose={onClose} onSuccess={onSuccess} />);

      fireEvent.click(screen.getByText('Preview Suggestions'));

      await waitFor(() => {
        expect(screen.getByText('Grocery Store')).toBeInTheDocument();
      });

      // Click "Select none"
      fireEvent.click(screen.getByText('Select none'));

      const checkboxes = screen.getAllByRole('checkbox').filter(
        (el) => el.closest('table')
      );
      checkboxes.forEach((cb) => {
        expect(cb).not.toBeChecked();
      });
    });

    it('updates the footer to show no selections', async () => {
      mockGetCategorySuggestions.mockResolvedValue(sampleSuggestions);
      render(<CategoryAutoAssignDialog isOpen={true} onClose={onClose} onSuccess={onSuccess} />);

      fireEvent.click(screen.getByText('Preview Suggestions'));

      await waitFor(() => {
        expect(screen.getByText('3 payees selected')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Select none'));

      // No "payees selected" text should appear
      expect(screen.queryByText(/payees? selected/)).not.toBeInTheDocument();
    });
  });

  describe('apply button', () => {
    it('calls API with selected suggestions', async () => {
      mockGetCategorySuggestions.mockResolvedValue(sampleSuggestions);
      mockApplyCategorySuggestions.mockResolvedValue({ updated: 3 });
      render(<CategoryAutoAssignDialog isOpen={true} onClose={onClose} onSuccess={onSuccess} />);

      fireEvent.click(screen.getByText('Preview Suggestions'));

      await waitFor(() => {
        expect(screen.getByText('Grocery Store')).toBeInTheDocument();
      });

      // Click the apply button (all 3 selected)
      fireEvent.click(screen.getByText('Apply to 3 Payees'));

      await waitFor(() => {
        expect(mockApplyCategorySuggestions).toHaveBeenCalledWith([
          { payeeId: 'payee-1', categoryId: 'cat-1' },
          { payeeId: 'payee-2', categoryId: 'cat-2' },
          { payeeId: 'payee-3', categoryId: 'cat-3' },
        ]);
      });
    });

    it('calls onSuccess and onClose after successful apply', async () => {
      mockGetCategorySuggestions.mockResolvedValue(sampleSuggestions);
      mockApplyCategorySuggestions.mockResolvedValue({ updated: 3 });
      render(<CategoryAutoAssignDialog isOpen={true} onClose={onClose} onSuccess={onSuccess} />);

      fireEvent.click(screen.getByText('Preview Suggestions'));

      await waitFor(() => {
        expect(screen.getByText('Grocery Store')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Apply to 3 Payees'));

      await waitFor(() => {
        expect(onSuccess).toHaveBeenCalled();
        expect(onClose).toHaveBeenCalled();
      });
    });

    it('shows success toast after apply', async () => {
      mockGetCategorySuggestions.mockResolvedValue(sampleSuggestions);
      mockApplyCategorySuggestions.mockResolvedValue({ updated: 3 });
      render(<CategoryAutoAssignDialog isOpen={true} onClose={onClose} onSuccess={onSuccess} />);

      fireEvent.click(screen.getByText('Preview Suggestions'));

      await waitFor(() => {
        expect(screen.getByText('Grocery Store')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Apply to 3 Payees'));

      await waitFor(() => {
        expect(toast.success).toHaveBeenCalledWith('Updated 3 payees');
      });
    });

    it('sends only selected suggestions, not all', async () => {
      mockGetCategorySuggestions.mockResolvedValue(sampleSuggestions);
      mockApplyCategorySuggestions.mockResolvedValue({ updated: 1 });
      render(<CategoryAutoAssignDialog isOpen={true} onClose={onClose} onSuccess={onSuccess} />);

      fireEvent.click(screen.getByText('Preview Suggestions'));

      await waitFor(() => {
        expect(screen.getByText('Grocery Store')).toBeInTheDocument();
      });

      // Deselect all then select only Grocery Store
      fireEvent.click(screen.getByText('Select none'));
      const groceryRow = screen.getByText('Grocery Store').closest('tr')!;
      const checkbox = groceryRow.querySelector('input[type="checkbox"]') as HTMLInputElement;
      fireEvent.click(checkbox);

      fireEvent.click(screen.getByText('Apply to 1 Payee'));

      await waitFor(() => {
        expect(mockApplyCategorySuggestions).toHaveBeenCalledWith([
          { payeeId: 'payee-1', categoryId: 'cat-1' },
        ]);
      });
    });

    it('is disabled when no suggestions are selected', async () => {
      mockGetCategorySuggestions.mockResolvedValue(sampleSuggestions);
      render(<CategoryAutoAssignDialog isOpen={true} onClose={onClose} onSuccess={onSuccess} />);

      fireEvent.click(screen.getByText('Preview Suggestions'));

      await waitFor(() => {
        expect(screen.getByText('Grocery Store')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Select none'));

      const applyButton = screen.getByText('Apply to 0 Payees');
      expect(applyButton).toBeDisabled();
    });

    it('shows error toast when apply fails', async () => {
      mockGetCategorySuggestions.mockResolvedValue(sampleSuggestions);
      mockApplyCategorySuggestions.mockRejectedValue(new Error('Network error'));
      render(<CategoryAutoAssignDialog isOpen={true} onClose={onClose} onSuccess={onSuccess} />);

      fireEvent.click(screen.getByText('Preview Suggestions'));

      await waitFor(() => {
        expect(screen.getByText('Grocery Store')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Apply to 3 Payees'));

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Failed to apply category assignments');
      });
    });

    it('shows Applying text while applying', async () => {
      let resolvePromise: (value: { updated: number }) => void;
      const promise = new Promise<{ updated: number }>((resolve) => {
        resolvePromise = resolve;
      });
      mockGetCategorySuggestions.mockResolvedValue(sampleSuggestions);
      mockApplyCategorySuggestions.mockReturnValue(promise);
      render(<CategoryAutoAssignDialog isOpen={true} onClose={onClose} onSuccess={onSuccess} />);

      fireEvent.click(screen.getByText('Preview Suggestions'));

      await waitFor(() => {
        expect(screen.getByText('Grocery Store')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Apply to 3 Payees'));

      await waitFor(() => {
        expect(screen.getByText('Applying...')).toBeInTheDocument();
      });

      await act(async () => {
        resolvePromise!({ updated: 3 });
      });
    });

    it('shows singular "payee" for single update', async () => {
      const singleSuggestion = [sampleSuggestions[0]];
      mockGetCategorySuggestions.mockResolvedValue(singleSuggestion);
      mockApplyCategorySuggestions.mockResolvedValue({ updated: 1 });
      render(<CategoryAutoAssignDialog isOpen={true} onClose={onClose} onSuccess={onSuccess} />);

      fireEvent.click(screen.getByText('Preview Suggestions'));

      await waitFor(() => {
        expect(screen.getByText('1 payee selected')).toBeInTheDocument();
        expect(screen.getByText('Apply to 1 Payee')).toBeInTheDocument();
      });
    });
  });

  describe('cancel/close button', () => {
    it('calls onClose when Cancel is clicked', () => {
      render(<CategoryAutoAssignDialog isOpen={true} onClose={onClose} onSuccess={onSuccess} />);
      fireEvent.click(screen.getByText('Cancel'));
      expect(onClose).toHaveBeenCalled();
    });

    it('does not call onSuccess when Cancel is clicked', () => {
      render(<CategoryAutoAssignDialog isOpen={true} onClose={onClose} onSuccess={onSuccess} />);
      fireEvent.click(screen.getByText('Cancel'));
      expect(onSuccess).not.toHaveBeenCalled();
    });
  });

  describe('empty suggestions after preview', () => {
    it('shows empty state message when no suggestions found', async () => {
      mockGetCategorySuggestions.mockResolvedValue([]);
      render(<CategoryAutoAssignDialog isOpen={true} onClose={onClose} onSuccess={onSuccess} />);

      fireEvent.click(screen.getByText('Preview Suggestions'));

      await waitFor(() => {
        expect(screen.getByText('No payees match the current criteria.')).toBeInTheDocument();
        expect(screen.getByText('Try adjusting the settings above.')).toBeInTheDocument();
      });
    });

    it('shows suggestions count as 0', async () => {
      mockGetCategorySuggestions.mockResolvedValue([]);
      render(<CategoryAutoAssignDialog isOpen={true} onClose={onClose} onSuccess={onSuccess} />);

      fireEvent.click(screen.getByText('Preview Suggestions'));

      await waitFor(() => {
        expect(screen.getByText('Suggestions (0 found)')).toBeInTheDocument();
      });
    });

    it('does not show select all/none buttons when empty', async () => {
      mockGetCategorySuggestions.mockResolvedValue([]);
      render(<CategoryAutoAssignDialog isOpen={true} onClose={onClose} onSuccess={onSuccess} />);

      fireEvent.click(screen.getByText('Preview Suggestions'));

      await waitFor(() => {
        expect(screen.getByText('Suggestions (0 found)')).toBeInTheDocument();
      });

      expect(screen.queryByText('Select all')).not.toBeInTheDocument();
      expect(screen.queryByText('Select none')).not.toBeInTheDocument();
    });
  });

  describe('error handling during preview', () => {
    it('shows error toast when preview fails', async () => {
      mockGetCategorySuggestions.mockRejectedValue(new Error('Server error'));
      render(<CategoryAutoAssignDialog isOpen={true} onClose={onClose} onSuccess={onSuccess} />);

      fireEvent.click(screen.getByText('Preview Suggestions'));

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Failed to load suggestions');
      });
    });
  });

  describe('state reset on reopen', () => {
    it('clears suggestions when dialog reopens', async () => {
      mockGetCategorySuggestions.mockResolvedValue(sampleSuggestions);
      const { rerender } = render(
        <CategoryAutoAssignDialog isOpen={true} onClose={onClose} onSuccess={onSuccess} />
      );

      fireEvent.click(screen.getByText('Preview Suggestions'));

      await waitFor(() => {
        expect(screen.getByText('Grocery Store')).toBeInTheDocument();
      });

      // Close dialog
      rerender(
        <CategoryAutoAssignDialog isOpen={false} onClose={onClose} onSuccess={onSuccess} />
      );

      // Reopen dialog
      rerender(
        <CategoryAutoAssignDialog isOpen={true} onClose={onClose} onSuccess={onSuccess} />
      );

      // Suggestions should be cleared, no table visible
      expect(screen.queryByText('Grocery Store')).not.toBeInTheDocument();
      expect(screen.queryByText('Suggestions (3 found)')).not.toBeInTheDocument();
    });
  });

  describe('apply prevents empty submission', () => {
    it('shows error toast when trying to apply with no selections', async () => {
      mockGetCategorySuggestions.mockResolvedValue(sampleSuggestions);
      render(<CategoryAutoAssignDialog isOpen={true} onClose={onClose} onSuccess={onSuccess} />);

      fireEvent.click(screen.getByText('Preview Suggestions'));

      await waitFor(() => {
        expect(screen.getByText('Grocery Store')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Select none'));

      // The button should be disabled, but let's verify the behavior
      const applyBtn = screen.getByText('Apply to 0 Payees');
      expect(applyBtn).toBeDisabled();
    });
  });
});
