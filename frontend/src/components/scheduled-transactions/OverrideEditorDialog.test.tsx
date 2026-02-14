import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@/test/render';
import { OverrideEditorDialog } from './OverrideEditorDialog';
import toast from 'react-hot-toast';

vi.mock('react-hot-toast', () => ({
  default: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

const mockCreateOverride = vi.fn().mockResolvedValue({});
const mockUpdateOverride = vi.fn().mockResolvedValue({});
const mockDeleteOverride = vi.fn().mockResolvedValue({});

vi.mock('@/lib/scheduled-transactions', () => ({
  scheduledTransactionsApi: {
    createOverride: (...args: any[]) => mockCreateOverride(...args),
    updateOverride: (...args: any[]) => mockUpdateOverride(...args),
    deleteOverride: (...args: any[]) => mockDeleteOverride(...args),
  },
}));

vi.mock('@/lib/format', () => ({
  getCurrencySymbol: () => '$',
  roundToCents: (v: number) => Math.round(v * 100) / 100,
  formatAmountWithCommas: (v: number) => v?.toLocaleString() ?? '',
  parseAmount: (v: string) => parseFloat(v) || 0,
  filterCurrencyInput: (v: string) => v,
  filterCalculatorInput: (v: string) => v,
  hasCalculatorOperators: () => false,
  evaluateExpression: (v: string) => parseFloat(v) || 0,
}));

vi.mock('@/lib/errors', () => ({
  getErrorMessage: (_error: unknown, fallback: string) => fallback,
}));

vi.mock('@/lib/categoryUtils', () => ({
  buildCategoryTree: (cats: any[]) => (cats || []).map((c: any) => ({ category: c })),
}));

vi.mock('@/components/transactions/SplitEditor', () => ({
  SplitEditor: () => <div data-testid="split-editor">SplitEditor</div>,
  SplitRow: null,
  createEmptySplits: () => [
    { id: '1', categoryId: '', amount: 0, memo: '', splitType: 'category' },
    { id: '2', categoryId: '', amount: 0, memo: '', splitType: 'category' },
  ],
  toSplitRows: () => [
    { id: '1', categoryId: 'c1', amount: -750, memo: '', splitType: 'category' },
    { id: '2', categoryId: 'c2', amount: -750, memo: '', splitType: 'category' },
  ],
}));

vi.mock('@/components/ui/Combobox', () => ({
  Combobox: ({ placeholder, onChange, value }: any) => (
    <input
      placeholder={placeholder}
      data-testid="combobox-category"
      value={value || ''}
      onChange={(e: any) => onChange?.(e.target.value, '')}
    />
  ),
}));

describe('OverrideEditorDialog', () => {
  const scheduledTransaction = {
    id: 's1', name: 'Rent', amount: -1500, currencyCode: 'CAD',
    accountId: 'a1', categoryId: 'c1', description: 'Monthly rent',
    isTransfer: false, isSplit: false,
    account: { name: 'Checking' },
  } as any;

  const transferTransaction = {
    id: 's2', name: 'Savings Transfer', amount: -500, currencyCode: 'CAD',
    accountId: 'a1', categoryId: null, description: '',
    isTransfer: true, isSplit: false,
    account: { name: 'Checking' },
    transferAccount: { name: 'Savings' },
  } as any;

  const splitTransaction = {
    id: 's3', name: 'Split Payment', amount: -100, currencyCode: 'CAD',
    accountId: 'a1', categoryId: null, description: '',
    isTransfer: false, isSplit: true,
    splits: [
      { id: 'sp1', categoryId: 'c1', amount: -50, memo: '' },
      { id: 'sp2', categoryId: 'c2', amount: -50, memo: '' },
    ],
  } as any;

  const categories = [
    { id: 'c1', name: 'Housing', parentId: null },
    { id: 'c2', name: 'Utilities', parentId: null },
  ] as any[];
  const accounts = [
    { id: 'a1', name: 'Checking' },
    { id: 'a2', name: 'Savings' },
  ] as any[];

  const defaultProps = {
    isOpen: true,
    scheduledTransaction,
    overrideDate: '2025-03-01',
    categories,
    accounts,
    onClose: vi.fn(),
    onSave: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --- Rendering ---
  it('renders dialog title', () => {
    render(<OverrideEditorDialog {...defaultProps} />);
    expect(screen.getByText('Edit Occurrence')).toBeInTheDocument();
  });

  it('displays transaction name in description', () => {
    render(<OverrideEditorDialog {...defaultProps} />);
    expect(screen.getByText(/Rent/)).toBeInTheDocument();
  });

  it('shows occurrence date field', () => {
    render(<OverrideEditorDialog {...defaultProps} />);
    expect(screen.getByText('Occurrence Date')).toBeInTheDocument();
  });

  it('shows amount field', () => {
    render(<OverrideEditorDialog {...defaultProps} />);
    expect(screen.getByText('Amount')).toBeInTheDocument();
  });

  it('shows description field', () => {
    render(<OverrideEditorDialog {...defaultProps} />);
    expect(screen.getByText('Description (optional)')).toBeInTheDocument();
  });

  it('does not render when isOpen is false', () => {
    render(<OverrideEditorDialog {...defaultProps} isOpen={false} />);
    expect(screen.queryByText('Edit Occurrence')).not.toBeInTheDocument();
  });

  // --- Save Override button ---
  it('shows Save Override button for new override', () => {
    render(<OverrideEditorDialog {...defaultProps} />);
    expect(screen.getByText('Save Override')).toBeInTheDocument();
  });

  it('shows Update Override button for existing override', () => {
    const existingOverride = {
      id: 'o1', originalDate: '2025-03-01', overrideDate: '2025-03-01',
      amount: -1600, categoryId: 'c1', description: 'Override desc',
      isSplit: false, splits: null,
    } as any;
    render(<OverrideEditorDialog {...defaultProps} existingOverride={existingOverride} />);
    expect(screen.getByText('Update Override')).toBeInTheDocument();
  });

  it('shows Reset to Default button for existing override', () => {
    const existingOverride = {
      id: 'o1', originalDate: '2025-03-01', overrideDate: '2025-03-01',
      amount: -1600, categoryId: null, description: null,
      isSplit: false, splits: null,
    } as any;
    render(<OverrideEditorDialog {...defaultProps} existingOverride={existingOverride} />);
    expect(screen.getByText('Reset to Default')).toBeInTheDocument();
  });

  it('does not show Reset to Default button for new override', () => {
    render(<OverrideEditorDialog {...defaultProps} />);
    expect(screen.queryByText('Reset to Default')).not.toBeInTheDocument();
  });

  // --- Cancel button ---
  it('shows Cancel button', () => {
    render(<OverrideEditorDialog {...defaultProps} />);
    expect(screen.getByText('Cancel')).toBeInTheDocument();
  });

  it('calls onClose when Cancel button is clicked', () => {
    const onClose = vi.fn();
    render(<OverrideEditorDialog {...defaultProps} onClose={onClose} />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalled();
  });

  it('calls onClose when X button is clicked', () => {
    const onClose = vi.fn();
    render(<OverrideEditorDialog {...defaultProps} onClose={onClose} />);
    // Find the close button (SVG X icon button)
    const closeButtons = screen.getAllByRole('button');
    // The X button is the first button in the dialog header
    const xButton = closeButtons.find(b => b.querySelector('svg path[d*="M6 18L18 6"]'));
    if (xButton) {
      fireEvent.click(xButton);
      expect(onClose).toHaveBeenCalled();
    }
  });

  // --- Override indicator ---
  it('shows override exists indicator for existing override', () => {
    const existingOverride = {
      id: 'o1', originalDate: '2025-03-01', overrideDate: '2025-03-01',
      amount: -1600, categoryId: null, description: null,
      isSplit: false, splits: null,
    } as any;
    render(<OverrideEditorDialog {...defaultProps} existingOverride={existingOverride} />);
    expect(screen.getByText('(Override exists)')).toBeInTheDocument();
  });

  it('does not show override indicator for new override', () => {
    render(<OverrideEditorDialog {...defaultProps} />);
    expect(screen.queryByText('(Override exists)')).not.toBeInTheDocument();
  });

  // --- Save override (create new) ---
  it('calls createOverride API when saving new override', async () => {
    const onSave = vi.fn();
    const onClose = vi.fn();
    render(<OverrideEditorDialog {...defaultProps} onSave={onSave} onClose={onClose} />);

    fireEvent.click(screen.getByText('Save Override'));

    await waitFor(() => {
      expect(mockCreateOverride).toHaveBeenCalledWith('s1', expect.objectContaining({
        originalDate: '2025-03-01',
        overrideDate: '2025-03-01',
      }));
    });

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Override created');
    });

    await waitFor(() => {
      expect(onSave).toHaveBeenCalled();
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('calls updateOverride API when updating existing override', async () => {
    const onSave = vi.fn();
    const onClose = vi.fn();
    const existingOverride = {
      id: 'o1', originalDate: '2025-03-01', overrideDate: '2025-03-01',
      amount: -1600, categoryId: 'c1', description: 'test',
      isSplit: false, splits: null,
    } as any;

    render(<OverrideEditorDialog {...defaultProps} existingOverride={existingOverride} onSave={onSave} onClose={onClose} />);

    fireEvent.click(screen.getByText('Update Override'));

    await waitFor(() => {
      expect(mockUpdateOverride).toHaveBeenCalledWith('s1', 'o1', expect.any(Object));
    });

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Override updated');
    });
  });

  // --- Delete override (reset to default) ---
  it('calls deleteOverride API when Reset to Default is clicked', async () => {
    const onSave = vi.fn();
    const onClose = vi.fn();
    const existingOverride = {
      id: 'o1', originalDate: '2025-03-01', overrideDate: '2025-03-01',
      amount: -1600, categoryId: null, description: null,
      isSplit: false, splits: null,
    } as any;

    render(<OverrideEditorDialog {...defaultProps} existingOverride={existingOverride} onSave={onSave} onClose={onClose} />);

    fireEvent.click(screen.getByText('Reset to Default'));

    await waitFor(() => {
      expect(mockDeleteOverride).toHaveBeenCalledWith('s1', 'o1');
    });

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Override deleted - will use base values');
    });

    await waitFor(() => {
      expect(onSave).toHaveBeenCalled();
      expect(onClose).toHaveBeenCalled();
    });
  });

  // --- Error handling ---
  it('shows error toast when save fails', async () => {
    mockCreateOverride.mockRejectedValueOnce(new Error('Save failed'));
    render(<OverrideEditorDialog {...defaultProps} />);

    fireEvent.click(screen.getByText('Save Override'));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to save override');
    });
  });

  it('shows error toast when delete fails', async () => {
    mockDeleteOverride.mockRejectedValueOnce(new Error('Delete failed'));
    const existingOverride = {
      id: 'o1', originalDate: '2025-03-01', overrideDate: '2025-03-01',
      amount: -1600, categoryId: null, description: null,
      isSplit: false, splits: null,
    } as any;

    render(<OverrideEditorDialog {...defaultProps} existingOverride={existingOverride} />);

    fireEvent.click(screen.getByText('Reset to Default'));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to delete override');
    });
  });

  // --- Date override ---
  it('allows changing occurrence date', () => {
    render(<OverrideEditorDialog {...defaultProps} />);
    const dateInput = screen.getByDisplayValue('2025-03-01');
    expect(dateInput).toBeInTheDocument();

    fireEvent.change(dateInput, { target: { value: '2025-03-05' } });
    expect((dateInput as HTMLInputElement).value).toBe('2025-03-05');
  });

  it('creates new override with changed date by deleting old and creating new', async () => {
    const existingOverride = {
      id: 'o1', originalDate: '2025-03-01', overrideDate: '2025-03-01',
      amount: -1500, categoryId: 'c1', description: null,
      isSplit: false, splits: null,
    } as any;

    render(<OverrideEditorDialog {...defaultProps} existingOverride={existingOverride} />);

    // Change the date
    const dateInput = screen.getByDisplayValue('2025-03-01');
    fireEvent.change(dateInput, { target: { value: '2025-03-10' } });

    // Save
    fireEvent.click(screen.getByText('Update Override'));

    await waitFor(() => {
      // Should delete old and create new
      expect(mockDeleteOverride).toHaveBeenCalledWith('s1', 'o1');
    });

    await waitFor(() => {
      expect(mockCreateOverride).toHaveBeenCalledWith('s1', expect.objectContaining({
        originalDate: '2025-03-01',
        overrideDate: '2025-03-10',
      }));
    });

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Override moved to new date');
    });
  });

  // --- Description override ---
  it('allows changing description', () => {
    render(<OverrideEditorDialog {...defaultProps} />);
    const descInput = screen.getByPlaceholderText('Override description...');
    expect(descInput).toBeInTheDocument();

    fireEvent.change(descInput, { target: { value: 'Special rent this month' } });
    expect((descInput as HTMLInputElement).value).toBe('Special rent this month');
  });

  // --- Transfer indicator ---
  it('shows transfer indicator for transfer transactions', () => {
    render(<OverrideEditorDialog {...defaultProps} scheduledTransaction={transferTransaction} />);
    expect(screen.getByText(/Transfer:/)).toBeInTheDocument();
    expect(screen.getByText(/Checking/)).toBeInTheDocument();
  });

  it('does not show category combobox for transfer transactions', () => {
    render(<OverrideEditorDialog {...defaultProps} scheduledTransaction={transferTransaction} />);
    expect(screen.queryByTestId('combobox-category')).not.toBeInTheDocument();
  });

  // --- Split toggle ---
  it('shows split toggle checkbox for non-transfer transactions', () => {
    render(<OverrideEditorDialog {...defaultProps} />);
    expect(screen.getByLabelText('Split this occurrence')).toBeInTheDocument();
  });

  it('does not show split toggle for transfer transactions', () => {
    render(<OverrideEditorDialog {...defaultProps} scheduledTransaction={transferTransaction} />);
    expect(screen.queryByLabelText('Split this occurrence')).not.toBeInTheDocument();
  });

  it('shows split editor when split checkbox is checked', () => {
    render(<OverrideEditorDialog {...defaultProps} />);

    const splitCheckbox = screen.getByLabelText('Split this occurrence') as HTMLInputElement;
    fireEvent.click(splitCheckbox);

    expect(screen.getByTestId('split-editor')).toBeInTheDocument();
  });

  it('hides category combobox when split is enabled', () => {
    render(<OverrideEditorDialog {...defaultProps} />);

    // Category combobox should be present initially
    expect(screen.getByTestId('combobox-category')).toBeInTheDocument();

    const splitCheckbox = screen.getByLabelText('Split this occurrence') as HTMLInputElement;
    fireEvent.click(splitCheckbox);

    // Category combobox should be replaced by split editor
    expect(screen.queryByTestId('combobox-category')).not.toBeInTheDocument();
    expect(screen.getByTestId('split-editor')).toBeInTheDocument();
  });

  // --- Category field ---
  it('shows category combobox for non-transfer, non-split transactions', () => {
    render(<OverrideEditorDialog {...defaultProps} />);
    expect(screen.getByText('Category')).toBeInTheDocument();
    expect(screen.getByTestId('combobox-category')).toBeInTheDocument();
  });

  // --- Initializes with existing override values ---
  it('initializes form with existing override values', () => {
    const existingOverride = {
      id: 'o1', originalDate: '2025-03-01', overrideDate: '2025-03-05',
      amount: -1800, categoryId: 'c2', description: 'Increased rent',
      isSplit: false, splits: null,
    } as any;

    render(<OverrideEditorDialog {...defaultProps} existingOverride={existingOverride} />);

    // Date should be set to override date
    const dateInput = screen.getByDisplayValue('2025-03-05');
    expect(dateInput).toBeInTheDocument();

    // Description should be set
    const descInput = screen.getByDisplayValue('Increased rent');
    expect(descInput).toBeInTheDocument();
  });

  // --- Initializes split state from existing override ---
  it('initializes split state from existing split override', () => {
    const existingOverride = {
      id: 'o1', originalDate: '2025-03-01', overrideDate: '2025-03-01',
      amount: -1500, categoryId: null, description: null,
      isSplit: true,
      splits: [
        { categoryId: 'c1', amount: -750, memo: '' },
        { categoryId: 'c2', amount: -750, memo: '' },
      ],
    } as any;

    render(<OverrideEditorDialog {...defaultProps} existingOverride={existingOverride} />);

    const splitCheckbox = screen.getByLabelText('Split this occurrence') as HTMLInputElement;
    expect(splitCheckbox.checked).toBe(true);
    expect(screen.getByTestId('split-editor')).toBeInTheDocument();
  });

  // --- Initializes with base transaction split values ---
  it('initializes split from base split transaction', () => {
    render(<OverrideEditorDialog {...defaultProps} scheduledTransaction={splitTransaction} />);

    const splitCheckbox = screen.getByLabelText('Split this occurrence') as HTMLInputElement;
    expect(splitCheckbox.checked).toBe(true);
    expect(screen.getByTestId('split-editor')).toBeInTheDocument();
  });
});
