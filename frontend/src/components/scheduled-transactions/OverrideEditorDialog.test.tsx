import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@/test/render';
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

const mockGetSecurityPrices = vi.fn().mockResolvedValue([]);

vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getSecurityPrices: (...args: any[]) => mockGetSecurityPrices(...args),
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('@/lib/format', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/format')>()),
  getCurrencySymbol: () => '$',
  getDecimalPlacesForCurrency: () => 2,
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

vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({ formatDate: (d: string) => d, dateFormat: 'browser', datePattern: 'YYYY-MM-DD' }),
}));

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrency: (n: number, _c?: string) => `$${n.toFixed(2)}`,
      formatNumber: (n: number, d: number = 2) => n.toFixed(d),
      // Mirrors the real formatPrice: up to 6 decimals, trailing zeros trimmed.
      formatPrice: (n: number) => n.toFixed(6).replace(/0+$/, '').replace(/\.$/, ''),
    }),
  };
});
vi.mock('@/lib/categoryUtils', () => ({
  buildCategoryTree: (cats: any[]) => (cats || []).map((c: any) => ({ category: c })),
}));

vi.mock('@/components/transactions/SplitEditor', () => ({
  SplitEditor: ({ onCreateCategory }: any) => (
    <div data-testid="split-editor">{onCreateCategory ? 'can-create' : 'no-create'}</div>
  ),
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
  Combobox: ({ placeholder, onChange, onCreateNew, value }: any) => (
    <>
      <input
        placeholder={placeholder}
        data-testid="combobox-category"
        value={value || ''}
        onChange={(e: any) => onChange?.(e.target.value, '')}
      />
      {onCreateNew && (
        <button
          data-testid="combobox-category-create"
          onClick={() => onCreateNew('vet bills')}
        >
          Create
        </button>
      )}
    </>
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

  it('is named by its title through Modal and draws no corner X', () => {
    render(<OverrideEditorDialog {...defaultProps} />);
    expect(screen.getByRole('dialog', { name: 'Edit Occurrence' })).toBeInTheDocument();
    // Cancel in the button row is what closes it: no icon-only button sits
    // beside the title.
    const iconOnly = screen
      .getAllByRole('button')
      .filter((b) => b.querySelector('svg') && !b.textContent?.trim() && !b.getAttribute('aria-label'));
    expect(iconOnly).toHaveLength(0);
  });

  it('spaces the transfer icon from its text with the container gap, not a margin on the icon', () => {
    render(<OverrideEditorDialog {...defaultProps} scheduledTransaction={transferTransaction} />);
    const summary = screen.getByText(/Transfer:/);
    const row = summary.parentElement!;
    expect(row.className).toContain('gap-2');
    expect(row.querySelector('svg')?.getAttribute('class') ?? '').not.toMatch(/\bmr-/);
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
    const dateInput = screen.getByLabelText('Occurrence Date');
    expect(dateInput).toBeInTheDocument();

    fireEvent.change(dateInput, { target: { value: '2025-03-05' } });
    expect((dateInput as HTMLInputElement).value).toBe('2025-03-05');
  });

  // Issue #1167 R10-F3: moving an occurrence's date updates the existing override
  // in place (preserving its split identities and FX provenance), rather than
  // deleting it and creating a new one -- which lost a validly pinned rate.
  it('moves the date by updating the existing override in place, not delete+create', async () => {
    const existingOverride = {
      id: 'o1', originalDate: '2025-03-01', overrideDate: '2025-03-01',
      amount: -1500, categoryId: 'c1', description: null,
      isSplit: false, splits: null,
    } as any;

    render(<OverrideEditorDialog {...defaultProps} existingOverride={existingOverride} />);

    // Change the date
    const dateInput = screen.getByLabelText('Occurrence Date');
    fireEvent.change(dateInput, { target: { value: '2025-03-10' } });

    // Save
    fireEvent.click(screen.getByText('Update Override'));

    await waitFor(() => {
      expect(mockUpdateOverride).toHaveBeenCalledWith(
        's1',
        'o1',
        expect.objectContaining({ overrideDate: '2025-03-10' }),
      );
    });
    // The row is not recreated -- its identity (and any pinned FX provenance) survives.
    expect(mockDeleteOverride).not.toHaveBeenCalled();
    expect(mockCreateOverride).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Override moved to new date');
    });
  });

  // --- Description override ---
  it('allows changing description', () => {
    render(<OverrideEditorDialog {...defaultProps} />);
    const descInput = screen.getByPlaceholderText('Override description…');
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
  it('shows split toggle for non-transfer transactions', () => {
    render(<OverrideEditorDialog {...defaultProps} />);
    expect(screen.getByLabelText('Split this occurrence')).toBeInTheDocument();
  });

  // --- Creating a category from the dialog (issue #1187 follow-up) ---
  describe('creating a category', () => {
    it('offers no create option when the page cannot create categories', () => {
      render(<OverrideEditorDialog {...defaultProps} />);
      expect(screen.queryByTestId('combobox-category-create')).not.toBeInTheDocument();
    });

    it('selects the category the page created', async () => {
      const onCreateCategory = vi
        .fn()
        .mockResolvedValue({ id: 'c-new', name: 'Vet Bills', parentId: null });

      render(
        <OverrideEditorDialog {...defaultProps} onCreateCategory={onCreateCategory} />,
      );

      await act(async () => {
        fireEvent.click(screen.getByTestId('combobox-category-create'));
      });

      expect(onCreateCategory).toHaveBeenCalledWith('vet bills');
      expect(screen.getByTestId('combobox-category')).toHaveValue('c-new');
    });

    it('leaves the field alone when nothing was created', async () => {
      const onCreateCategory = vi.fn().mockResolvedValue(null);

      render(
        <OverrideEditorDialog {...defaultProps} onCreateCategory={onCreateCategory} />,
      );

      await act(async () => {
        fireEvent.click(screen.getByTestId('combobox-category-create'));
      });

      expect(screen.getByTestId('combobox-category')).toHaveValue('c1');
    });

    it('passes the creator through to the split editor', () => {
      render(
        <OverrideEditorDialog
          {...defaultProps}
          onCreateCategory={vi.fn()}
        />,
      );
      fireEvent.click(screen.getByLabelText('Split this occurrence'));
      expect(screen.getByTestId('split-editor')).toHaveTextContent('can-create');
    });

    it('leaves the split editor without a creator when the page has none', () => {
      render(<OverrideEditorDialog {...defaultProps} />);
      fireEvent.click(screen.getByLabelText('Split this occurrence'));
      expect(screen.getByTestId('split-editor')).toHaveTextContent('no-create');
    });
  });

  it('does not show split toggle for transfer transactions', () => {
    render(<OverrideEditorDialog {...defaultProps} scheduledTransaction={transferTransaction} />);
    expect(screen.queryByLabelText('Split this occurrence')).not.toBeInTheDocument();
  });

  it('shows split editor when split toggle is enabled', () => {
    render(<OverrideEditorDialog {...defaultProps} />);

    const splitToggle = screen.getByLabelText('Split this occurrence') as HTMLElement;
    fireEvent.click(splitToggle);

    expect(screen.getByTestId('split-editor')).toBeInTheDocument();
  });

  it('hides category combobox when split is enabled', () => {
    render(<OverrideEditorDialog {...defaultProps} />);

    // Category combobox should be present initially
    expect(screen.getByTestId('combobox-category')).toBeInTheDocument();

    const splitToggle = screen.getByLabelText('Split this occurrence') as HTMLElement;
    fireEvent.click(splitToggle);

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
    const dateInput = screen.getByLabelText('Occurrence Date');
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

    const splitToggle = screen.getByLabelText('Split this occurrence') as HTMLElement;
    expect(splitToggle).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('split-editor')).toBeInTheDocument();
  });

  // --- Initializes with base transaction split values ---
  it('initializes split from base split transaction', () => {
    render(<OverrideEditorDialog {...defaultProps} scheduledTransaction={splitTransaction} />);

    const splitToggle = screen.getByLabelText('Split this occurrence') as HTMLElement;
    expect(splitToggle).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('split-editor')).toBeInTheDocument();
  });

  // --- Investment-mode occurrence editing (BUY/SELL/REINVEST) ---
  describe('investment qty+price actions', () => {
    const investmentTransaction = {
      id: 'inv1',
      name: 'Buy VTI',
      amount: -1000,
      currencyCode: 'CAD',
      accountId: 'a1',
      account: { name: 'Brokerage' },
      isTransfer: false,
      isSplit: false,
      isInvestment: true,
      investmentAction: 'BUY',
      investmentSecurityId: 'sec1',
      investmentSecurity: { id: 'sec1', symbol: 'VTI', name: 'Vanguard Total' },
      investmentQuantity: 10,
      investmentPrice: 100,
      investmentCommission: 0,
    } as any;

    beforeEach(() => {
      mockGetSecurityPrices.mockReset();
      mockGetSecurityPrices.mockResolvedValue([]);
    });

    /**
     * The dialog looks the security's price up on mount. A test that asserts
     * synchronously returns before that answer lands, so the state it sets
     * commits outside act() -- against whatever tree happens to be mounted by
     * then. The tests below that wait for "Use latest close" already settle the
     * lookup; the ones mocking an empty price list have nothing to wait for and
     * settle it here instead.
     */
    async function settlePriceLookup() {
      await act(async () => {
        await Promise.resolve();
      });
    }

    it('hides Amount / Category / Split toggle for investment occurrences', async () => {
      render(
        <OverrideEditorDialog
          {...defaultProps}
          scheduledTransaction={investmentTransaction}
        />,
      );
      await settlePriceLookup();
      expect(screen.queryByText('Amount')).not.toBeInTheDocument();
      expect(screen.queryByText('Category')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Split this occurrence')).not.toBeInTheDocument();
    });

    it('shows Quantity, Price, and Total Price inputs', async () => {
      render(
        <OverrideEditorDialog
          {...defaultProps}
          scheduledTransaction={investmentTransaction}
        />,
      );
      await settlePriceLookup();
      expect(screen.getByLabelText('Quantity (Shares)')).toBeInTheDocument();
      expect(screen.getByLabelText('Price per Share')).toBeInTheDocument();
      expect(screen.getByLabelText('Total Price')).toBeInTheDocument();
    });

    it('seeds Total Price from saved quantity * price', async () => {
      render(
        <OverrideEditorDialog
          {...defaultProps}
          scheduledTransaction={investmentTransaction}
        />,
      );
      await settlePriceLookup();
      const totalInput = screen.getByLabelText('Total Price') as HTMLInputElement;
      expect(totalInput.value).toBe('1,000');
    });

    it('updates Quantity when Total Price is changed', async () => {
      render(
        <OverrideEditorDialog
          {...defaultProps}
          scheduledTransaction={investmentTransaction}
        />,
      );
      await settlePriceLookup();
      const totalInput = screen.getByLabelText('Total Price') as HTMLInputElement;
      fireEvent.change(totalInput, { target: { value: '250' } });
      fireEvent.blur(totalInput);
      const qtyInput = screen.getByLabelText('Quantity (Shares)') as HTMLInputElement;
      expect(Number(qtyInput.value)).toBeCloseTo(2.5, 6);
    });

    // The dialog used to write the latest close over whatever price the
    // occurrence had, so reopening an override to change only its date
    // re-priced a future purchase at today's market. A stored price is an
    // instruction; market data is a suggestion offered beside it.
    it('keeps the scheduled price when a latest close arrives', async () => {
      mockGetSecurityPrices.mockResolvedValue([
        { closePrice: '123.45', priceDate: '2025-02-20' },
      ]);
      render(
        <OverrideEditorDialog
          {...defaultProps}
          scheduledTransaction={investmentTransaction}
        />,
      );
      await waitFor(() => {
        expect(screen.getByText('Use latest close')).toBeInTheDocument();
      });
      const priceInput = screen.getByLabelText('Price per Share') as HTMLInputElement;
      expect(Number(priceInput.value)).toBe(100);
      const totalInput = screen.getByLabelText('Total Price') as HTMLInputElement;
      expect(totalInput.value).toBe('1,000');
    });

    it('keeps an existing override price when a latest close arrives', async () => {
      mockGetSecurityPrices.mockResolvedValue([
        { closePrice: '123.45', priceDate: '2025-02-20' },
      ]);
      const existingOverride = {
        id: 'ov1',
        scheduledTransactionId: 'inv1',
        originalDate: '2025-02-15',
        overrideDate: '2025-02-15',
        investmentQuantity: 10,
        investmentPrice: 100,
        investmentTotalAmount: null,
      } as any;
      render(
        <OverrideEditorDialog
          {...defaultProps}
          scheduledTransaction={investmentTransaction}
          existingOverride={existingOverride}
        />,
      );
      await waitFor(() => {
        expect(screen.getByText('Use latest close')).toBeInTheDocument();
      });
      expect(
        Number((screen.getByLabelText('Price per Share') as HTMLInputElement).value),
      ).toBe(100);
    });

    // The reproduction from the audit: a date-only edit must not move money.
    it('saves the stored price when only the date is changed', async () => {
      mockGetSecurityPrices.mockResolvedValue([
        { closePrice: '120', priceDate: '2025-02-20' },
      ]);
      const existingOverride = {
        id: 'ov1',
        scheduledTransactionId: 'inv1',
        originalDate: '2025-02-15',
        overrideDate: '2025-02-15',
        investmentQuantity: 10,
        investmentPrice: 100,
        investmentTotalAmount: null,
      } as any;
      render(
        <OverrideEditorDialog
          {...defaultProps}
          scheduledTransaction={investmentTransaction}
          existingOverride={existingOverride}
        />,
      );
      await waitFor(() => {
        expect(screen.getByText('Use latest close')).toBeInTheDocument();
      });

      const dateInput = screen.getByLabelText('Occurrence Date') as HTMLInputElement;
      fireEvent.change(dateInput, { target: { value: '2025-02-18' } });
      fireEvent.blur(dateInput);
      fireEvent.click(screen.getByText('Update Override'));

      // A date-only move updates the existing override in place (R10-F3), keeping
      // the stored price rather than recreating the row.
      await waitFor(() => {
        expect(mockUpdateOverride).toHaveBeenCalled();
      });
      expect(mockUpdateOverride).toHaveBeenCalledWith(
        'inv1',
        'ov1',
        expect.objectContaining({ investmentPrice: 100, overrideDate: '2025-02-18' }),
      );
      expect(mockCreateOverride).not.toHaveBeenCalled();
    });

    // Total-first (issue #1148): "use latest close" now keeps the scheduled total
    // and re-derives the quantity, exactly as typing the same price does. It used
    // to keep the quantity (10) and recompute the total to 1,234.5 -- the divergent
    // behaviour the issue is closing.
    it('applies the latest close only when the user asks for it', async () => {
      mockGetSecurityPrices.mockResolvedValue([
        { closePrice: '123.45', priceDate: '2025-02-20' },
      ]);
      render(
        <OverrideEditorDialog
          {...defaultProps}
          scheduledTransaction={investmentTransaction}
        />,
      );
      await waitFor(() => {
        expect(screen.getByText('Use latest close')).toBeInTheDocument();
      });
      fireEvent.click(screen.getByText('Use latest close'));

      const priceInput = screen.getByLabelText('Price per Share') as HTMLInputElement;
      expect(Number(priceInput.value)).toBeCloseTo(123.45, 6);
      // The scheduled total stands; the quantity follows the applied price.
      const totalInput = screen.getByLabelText('Total Price') as HTMLInputElement;
      expect(totalInput.value.replace(/,/g, '')).toBe('1000');
      const qtyInput = screen.getByLabelText('Quantity (Shares)') as HTMLInputElement;
      // 1000 / 123.45 = 8.10044552 shares.
      expect(Number(qtyInput.value)).toBeCloseTo(8.100446, 5);
    });

    // Issue #1148: the two affordances must agree. This runs BOTH paths from the
    // same starting state (qty=10, price=100, total=1000) -- clicking "use latest
    // close" and typing the same price -- and asserts they book the same quantity
    // and total. Before the fix the button was quantity-first (10 / 1,234.5) and
    // typing was total-first (8.1 / 1,000), so this comparison would have failed.
    it('books the same quantity and total whether the price is typed or applied', async () => {
      const readFields = () => ({
        qty: Number(
          (screen.getByLabelText('Quantity (Shares)') as HTMLInputElement).value,
        ),
        total: (screen.getByLabelText('Total Price') as HTMLInputElement).value.replace(
          /,/g,
          '',
        ),
      });

      // Path A -- the button. A stored price (100) differing from the market close
      // (123.45) is what makes "use latest close" appear.
      mockGetSecurityPrices.mockResolvedValue([
        { closePrice: '123.45', priceDate: '2025-02-20' },
      ]);
      const applied = render(
        <OverrideEditorDialog
          {...defaultProps}
          scheduledTransaction={investmentTransaction}
        />,
      );
      await waitFor(() => {
        expect(screen.getByText('Use latest close')).toBeInTheDocument();
      });
      fireEvent.click(screen.getByText('Use latest close'));
      const appliedFields = readFields();
      applied.unmount();

      // Path B -- typing the same price into the same starting state.
      mockGetSecurityPrices.mockResolvedValue([]);
      render(
        <OverrideEditorDialog
          {...defaultProps}
          scheduledTransaction={investmentTransaction}
        />,
      );
      await settlePriceLookup();
      fireEvent.change(screen.getByLabelText('Price per Share'), {
        target: { value: '123.45' },
      });
      const typedFields = readFields();

      // Same intent -> same booking, and concretely total-first: total held at
      // 1000, quantity 1000 / 123.45 = 8.10044552.
      expect(typedFields.total).toBe(appliedFields.total);
      expect(typedFields.qty).toBeCloseTo(appliedFields.qty, 6);
      expect(typedFields.total).toBe('1000');
      expect(typedFields.qty).toBeCloseTo(8.100446, 5);
    });

    it('fills Price from the latest close when the schedule stored none', async () => {
      mockGetSecurityPrices.mockResolvedValue([
        { closePrice: '123.45', priceDate: '2025-02-20' },
      ]);
      render(
        <OverrideEditorDialog
          {...defaultProps}
          scheduledTransaction={{ ...investmentTransaction, investmentPrice: null }}
        />,
      );
      const priceInput = screen.getByLabelText('Price per Share') as HTMLInputElement;
      await waitFor(() => {
        expect(Number(priceInput.value)).toBeCloseTo(123.45, 6);
      });
      // and it says where the number came from
      expect(screen.getByText(/Filled from the close on/)).toBeInTheDocument();
    });

    it('names the price provenance truthfully: schedule vs this occurrence', async () => {
      // The provenance note is the point of the feature, so it must not claim a
      // price was "saved on this occurrence" when it was inherited from the base
      // schedule. No market price here (mock empty), so the stored-price note is
      // the only one in play.
      mockGetSecurityPrices.mockResolvedValue([]);
      const { rerender } = render(
        <OverrideEditorDialog
          {...defaultProps}
          scheduledTransaction={investmentTransaction}
        />,
      );
      await settlePriceLookup();
      // A brand-new override inherits the price from the schedule -> "from the
      // schedule", never "saved on this occurrence".
      expect(screen.getByText('Using the price from the schedule.')).toBeInTheDocument();
      expect(
        screen.queryByText('Using the price saved on this occurrence.'),
      ).not.toBeInTheDocument();

      // A price actually saved on the override reads as the occurrence's own.
      const existingOverride = {
        id: 'ov1',
        scheduledTransactionId: 'inv1',
        originalDate: '2025-02-15',
        overrideDate: '2025-02-15',
        amount: null,
        categoryId: null,
        description: null,
        isSplit: null,
        splits: null,
        investmentQuantity: 5,
        investmentPrice: 250,
        investmentTotalAmount: null,
        createdAt: '',
        updatedAt: '',
      } as any;
      rerender(
        <OverrideEditorDialog
          {...defaultProps}
          scheduledTransaction={investmentTransaction}
          existingOverride={existingOverride}
        />,
      );
      await settlePriceLookup();
      expect(
        screen.getByText('Using the price saved on this occurrence.'),
      ).toBeInTheDocument();
      expect(
        screen.queryByText('Using the price from the schedule.'),
      ).not.toBeInTheDocument();
    });

    it('stops calling the price stored once the user edits it', async () => {
      // The provenance note recorded the price's origin on open but never
      // cleared it on a manual edit, so it went on claiming a user-typed value
      // was the stored one.
      mockGetSecurityPrices.mockResolvedValue([]);
      render(
        <OverrideEditorDialog
          {...defaultProps}
          scheduledTransaction={investmentTransaction}
        />,
      );
      await settlePriceLookup();
      expect(screen.getByText('Using the price from the schedule.')).toBeInTheDocument();
      const priceInput = screen.getByLabelText('Price per Share') as HTMLInputElement;
      fireEvent.change(priceInput, { target: { value: '150' } });
      expect(
        screen.queryByText('Using the price from the schedule.'),
      ).not.toBeInTheDocument();
    });

    it('derives quantity when "use latest close" is clicked with only a Total entered', async () => {
      // The inconsistent-triple case: a Total but no Quantity. Clicking the
      // suggestion used to set the price and leave the quantity empty; it now
      // derives the quantity from the total, matching what typing the price does.
      // A stored price (100) differs from the market (125), so the suggestion is
      // offered rather than auto-applied -- the state the button needs to exist.
      mockGetSecurityPrices.mockResolvedValue([
        { closePrice: '125', priceDate: '2025-02-20' },
      ]);
      render(
        <OverrideEditorDialog
          {...defaultProps}
          scheduledTransaction={investmentTransaction}
        />,
      );
      await waitFor(() => {
        expect(screen.getByText('Use latest close')).toBeInTheDocument();
      });
      const qtyInput = screen.getByLabelText('Quantity (Shares)') as HTMLInputElement;
      const priceInput = screen.getByLabelText('Price per Share') as HTMLInputElement;
      const totalInput = screen.getByLabelText('Total Price') as HTMLInputElement;
      // Reduce to a Total only: clear the quantity and the stored price, then
      // enter a total. With no price the total does not back-derive a quantity,
      // so the quantity stays empty -- the finding's precondition.
      fireEvent.change(qtyInput, { target: { value: '' } });
      fireEvent.change(priceInput, { target: { value: '' } });
      fireEvent.change(totalInput, { target: { value: '1000' } });
      fireEvent.blur(totalInput);
      expect(qtyInput.value).toBe('');

      fireEvent.click(screen.getByText('Use latest close'));

      // 1000 / 125 = 8 shares; the triple is now consistent, not price+total
      // with an empty quantity.
      expect(Number(qtyInput.value)).toBeCloseTo(8, 6);
      expect(Number(priceInput.value)).toBe(125);
    });

    it('does not overwrite a total typed before the latest close arrives', async () => {
      // The typed-before-fetch race on the override editor's own auto-fill. On a
      // slow connection the user enters a quantity and a total while
      // getSecurityPrices is still pending; the price field is still blank, so
      // the auto-fill gate's `investmentPrice === ''` holds. Without the
      // userEditedTotal guard the arriving close fired writePrice, and its
      // total-first branch would keep the typed total (950) but re-derive the
      // quantity from it -- 950 / 123.45 = ~7.6954 -- silently changing the 10
      // shares the user entered. The guard blocks the fill entirely, so both the
      // typed total and the typed quantity stand. A deferred promise reproduces
      // the timing. (No stored price, so the auto-fill is armed.)
      let resolvePrices: (v: any) => void = () => {};
      mockGetSecurityPrices.mockReturnValue(
        new Promise((resolve) => {
          resolvePrices = resolve;
        }),
      );
      render(
        <OverrideEditorDialog
          {...defaultProps}
          scheduledTransaction={{
            ...investmentTransaction,
            investmentPrice: null,
            investmentQuantity: null,
          }}
        />,
      );
      const qtyInput = screen.getByLabelText('Quantity (Shares)') as HTMLInputElement;
      const totalInput = screen.getByLabelText('Total Price') as HTMLInputElement;
      await act(async () => {
        fireEvent.change(qtyInput, { target: { value: '10' } });
        fireEvent.change(totalInput, { target: { value: '950' } });
        fireEvent.blur(totalInput);
      });
      expect(totalInput.value.replace(/,/g, '')).toBe('950');

      // The close lands after the user has already typed.
      await act(async () => {
        resolvePrices([{ closePrice: '123.45', priceDate: '2025-02-20' }]);
      });

      // The typed total stands and the quantity is untouched; the auto-fill did
      // not fire over the user's own entry.
      expect(Number(totalInput.value.replace(/,/g, ''))).toBe(950);
      expect(Number(qtyInput.value)).toBe(10);
    });

    it('auto-fills the price after a quantity-only edit, keeping the quantity', async () => {
      // A quantity-only edit is safe to auto-fill: the fill is total-first, but
      // with no total on the field yet it falls into the fallback branch that
      // derives the total from the shares, so the shares are preserved and the
      // total simply follows. Blocking it (as an any-edit guard did) left the
      // price empty and forced a manual click, diverging from
      // ScheduledTransactionForm on identical input.
      let resolvePrices: (v: any) => void = () => {};
      mockGetSecurityPrices.mockReturnValue(
        new Promise((resolve) => {
          resolvePrices = resolve;
        }),
      );
      render(
        <OverrideEditorDialog
          {...defaultProps}
          scheduledTransaction={{
            ...investmentTransaction,
            investmentPrice: null,
            investmentQuantity: null,
          }}
        />,
      );
      const qtyInput = screen.getByLabelText('Quantity (Shares)') as HTMLInputElement;
      const priceInput = screen.getByLabelText('Price per Share') as HTMLInputElement;
      const totalInput = screen.getByLabelText('Total Price') as HTMLInputElement;
      // Type only a quantity while the price fetch is still pending.
      await act(async () => {
        fireEvent.change(qtyInput, { target: { value: '10' } });
      });

      await act(async () => {
        resolvePrices([{ closePrice: '123.45', priceDate: '2025-02-20' }]);
      });

      // The close fills the price, the typed quantity stands, and the total
      // follows (10 * 123.45 = 1,234.5).
      expect(Number(priceInput.value)).toBe(123.45);
      expect(Number(qtyInput.value)).toBe(10);
      expect(Number(totalInput.value.replace(/,/g, ''))).toBeCloseTo(1234.5, 4);
    });

    it('does not tell the user to enter a price that is already stored', async () => {
      // With a stored price and no market history, the provenance note and the
      // "enter the price manually" hint used to render together -- contradictory
      // instructions. The hint belongs only where the field is genuinely empty.
      mockGetSecurityPrices.mockResolvedValue([]);
      const existingOverride = {
        id: 'ov1',
        scheduledTransactionId: 'inv1',
        originalDate: '2025-02-15',
        overrideDate: '2025-02-15',
        investmentQuantity: 5,
        investmentPrice: 250,
        investmentTotalAmount: null,
      } as any;
      render(
        <OverrideEditorDialog
          {...defaultProps}
          scheduledTransaction={investmentTransaction}
          existingOverride={existingOverride}
        />,
      );
      await waitFor(() => {
        expect(
          screen.getByText('Using the price saved on this occurrence.'),
        ).toBeInTheDocument();
      });
      expect(screen.queryByText(/No price history yet/)).not.toBeInTheDocument();
    });

    it('sends investment fields when saving a new override', async () => {
      render(
        <OverrideEditorDialog
          {...defaultProps}
          scheduledTransaction={investmentTransaction}
        />,
      );
      // Change qty
      const qtyInput = screen.getByLabelText('Quantity (Shares)') as HTMLInputElement;
      fireEvent.change(qtyInput, { target: { value: '7' } });

      const saveButton = screen.getByText('Save Override');
      fireEvent.click(saveButton);

      await waitFor(() => {
        expect(mockCreateOverride).toHaveBeenCalledWith(
          'inv1',
          expect.objectContaining({
            investmentQuantity: 7,
            investmentPrice: 100,
          }),
        );
      });
      const payload = mockCreateOverride.mock.calls[0][1];
      // Non-investment fields should not be set for investment overrides
      expect(payload.amount).toBeUndefined();
      expect(payload.categoryId).toBeUndefined();
      expect(payload.isSplit).toBeUndefined();
    });

    it('prefills existing override values when editing', async () => {
      const existingOverride = {
        id: 'ov1',
        scheduledTransactionId: 'inv1',
        originalDate: '2025-02-15',
        overrideDate: '2025-02-15',
        amount: null,
        categoryId: null,
        description: 'One-off',
        isSplit: null,
        splits: null,
        investmentQuantity: 3,
        investmentPrice: 250,
        investmentTotalAmount: null,
        createdAt: '',
        updatedAt: '',
      } as any;
      render(
        <OverrideEditorDialog
          {...defaultProps}
          scheduledTransaction={investmentTransaction}
          existingOverride={existingOverride}
        />,
      );
      await settlePriceLookup();
      const qtyInput = screen.getByLabelText('Quantity (Shares)') as HTMLInputElement;
      const priceInput = screen.getByLabelText('Price per Share') as HTMLInputElement;
      expect(Number(qtyInput.value)).toBe(3);
      expect(Number(priceInput.value)).toBe(250);
    });

    it('shows Total Amount field for DIVIDEND occurrences', () => {
      const dividendTx = {
        ...investmentTransaction,
        investmentAction: 'DIVIDEND',
        investmentQuantity: null,
        investmentPrice: null,
        investmentTotalAmount: 75,
      };
      render(
        <OverrideEditorDialog
          {...defaultProps}
          scheduledTransaction={dividendTx}
        />,
      );
      expect(screen.queryByLabelText('Quantity (Shares)')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Price per Share')).not.toBeInTheDocument();
      expect(screen.getByLabelText('Total Amount')).toBeInTheDocument();
    });

    it('rejects save when quantity is zero', async () => {
      const zeroQtyTx = {
        ...investmentTransaction,
        investmentQuantity: 0,
      };
      render(
        <OverrideEditorDialog
          {...defaultProps}
          scheduledTransaction={zeroQtyTx}
        />,
      );
      const saveButton = screen.getByText('Save Override');
      fireEvent.click(saveButton);

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Quantity must be greater than zero');
      });
      expect(mockCreateOverride).not.toHaveBeenCalled();
    });

    it('rejects save when price is empty for qty+price action', async () => {
      const noPriceTx = {
        ...investmentTransaction,
        investmentPrice: null,
      };
      render(
        <OverrideEditorDialog
          {...defaultProps}
          scheduledTransaction={noPriceTx}
        />,
      );
      fireEvent.click(screen.getByText('Save Override'));
      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Price must be greater than zero');
      });
      expect(mockCreateOverride).not.toHaveBeenCalled();
    });

    it('rejects save when total amount is empty for amount-only action', async () => {
      const dividendNoTotal = {
        ...investmentTransaction,
        investmentAction: 'DIVIDEND',
        investmentQuantity: null,
        investmentPrice: null,
        investmentTotalAmount: null,
      };
      render(
        <OverrideEditorDialog
          {...defaultProps}
          scheduledTransaction={dividendNoTotal}
        />,
      );
      fireEvent.click(screen.getByText('Save Override'));
      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Total amount is required');
      });
      expect(mockCreateOverride).not.toHaveBeenCalled();
    });

    it('saves a DIVIDEND amount-only override with the total amount', async () => {
      const dividendTx = {
        ...investmentTransaction,
        investmentAction: 'DIVIDEND',
        investmentQuantity: null,
        investmentPrice: null,
        investmentTotalAmount: 60,
      };
      render(
        <OverrideEditorDialog
          {...defaultProps}
          scheduledTransaction={dividendTx}
        />,
      );
      fireEvent.click(screen.getByText('Save Override'));
      await waitFor(() => {
        expect(mockCreateOverride).toHaveBeenCalledWith('inv1', expect.objectContaining({
          investmentTotalAmount: 60,
        }));
      });
    });

    it('renders Quantity only for a quantity-only action (ADD_SHARES)', () => {
      const addSharesTx = {
        ...investmentTransaction,
        investmentAction: 'ADD_SHARES',
        investmentQuantity: 5,
        investmentPrice: null,
      };
      render(
        <OverrideEditorDialog
          {...defaultProps}
          scheduledTransaction={addSharesTx}
        />,
      );
      expect(screen.getByLabelText('Quantity (Shares)')).toBeInTheDocument();
      expect(screen.queryByLabelText('Price per Share')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Total Price')).not.toBeInTheDocument();
    });

    it('edits quantity directly for a quantity-only action', () => {
      const addSharesTx = {
        ...investmentTransaction,
        investmentAction: 'ADD_SHARES',
        investmentQuantity: 5,
        investmentPrice: null,
      };
      render(
        <OverrideEditorDialog
          {...defaultProps}
          scheduledTransaction={addSharesTx}
        />,
      );
      const qtyInput = screen.getByLabelText('Quantity (Shares)') as HTMLInputElement;
      fireEvent.change(qtyInput, { target: { value: '12' } });
      expect(Number(qtyInput.value)).toBe(12);
      fireEvent.change(qtyInput, { target: { value: '' } });
      expect(qtyInput.value).toBe('');
    });

    it('shows manual-price hint when there is no price history and no stored price', async () => {
      mockGetSecurityPrices.mockResolvedValue([]);
      render(
        <OverrideEditorDialog
          {...defaultProps}
          scheduledTransaction={{
            ...investmentTransaction,
            investmentPrice: null,
            investmentQuantity: null,
          }}
        />,
      );
      await waitFor(() => {
        expect(
          screen.getByText(/No price history yet for this security/),
        ).toBeInTheDocument();
      });
    });

    it('handles getSecurityPrices rejection without crashing', async () => {
      mockGetSecurityPrices.mockRejectedValueOnce(new Error('network'));
      render(
        <OverrideEditorDialog
          {...defaultProps}
          scheduledTransaction={investmentTransaction}
        />,
      );
      await waitFor(() => {
        expect(screen.getByLabelText('Price per Share')).toBeInTheDocument();
      });
    });

    it('does not show the no-price-history hint when the lookup fails', async () => {
      // A failed lookup is not an empty dataset -- the hint must stay off, not
      // falsely tell the user the security has no price history.
      mockGetSecurityPrices.mockRejectedValueOnce(new Error('network'));
      render(
        <OverrideEditorDialog
          {...defaultProps}
          scheduledTransaction={{
            ...investmentTransaction,
            investmentPrice: null,
            investmentQuantity: null,
          }}
        />,
      );
      await waitFor(() => {
        expect(screen.getByLabelText('Price per Share')).toBeInTheDocument();
      });
      await act(async () => {});
      expect(screen.queryByText(/No price history yet/)).not.toBeInTheDocument();
    });
  });

  // --- Transfer save: amount is negated ---
  describe('transfer override save', () => {
    it('negates the amount on save for a transfer override', async () => {
      render(
        <OverrideEditorDialog
          {...defaultProps}
          scheduledTransaction={transferTransaction}
        />,
      );
      // Amount field shows absolute value (500). Change it and save.
      const amountInput = screen.getByLabelText('Amount') as HTMLInputElement;
      fireEvent.change(amountInput, { target: { value: '600' } });
      fireEvent.blur(amountInput);

      fireEvent.click(screen.getByText('Save Override'));
      await waitFor(() => {
        expect(mockCreateOverride).toHaveBeenCalledWith('s2', expect.objectContaining({
          amount: -600,
        }));
      });
    });
  });

  // --- prefillAmount (post-reconciliation flow) ---
  describe('prefillAmount', () => {
    it('seeds the Amount field from prefillAmount', () => {
      render(<OverrideEditorDialog {...defaultProps} prefillAmount={999.5} />);
      const amountInput = screen.getByLabelText('Amount') as HTMLInputElement;
      expect(Number(amountInput.value)).toBe(999.5);
    });

    it('seeds and negates prefillAmount on save for a transfer', async () => {
      render(
        <OverrideEditorDialog
          {...defaultProps}
          scheduledTransaction={transferTransaction}
          prefillAmount={123.45}
        />,
      );
      // Save without touching the field: the seeded prefill amount is used,
      // negated for the transfer.
      fireEvent.click(screen.getByText('Save Override'));
      await waitFor(() => {
        expect(mockCreateOverride).toHaveBeenCalledWith('s2', expect.objectContaining({
          amount: -123.45,
        }));
      });
    });
  });

  // --- Split override save sends serialized splits ---
  describe('split override save', () => {
    it('sends split data with null categoryId when split is enabled', async () => {
      render(<OverrideEditorDialog {...defaultProps} scheduledTransaction={splitTransaction} />);
      // Already split; save should send isSplit true and categoryId null
      fireEvent.click(screen.getByText('Save Override'));
      await waitFor(() => {
        expect(mockCreateOverride).toHaveBeenCalledWith('s3', expect.objectContaining({
          isSplit: true,
          categoryId: null,
          splits: expect.any(Array),
        }));
      });
    });
  });

  // --- Category selection sends categoryId ---
  describe('category selection', () => {
    it('sends selected categoryId on save', async () => {
      render(<OverrideEditorDialog {...defaultProps} />);
      const combobox = screen.getByTestId('combobox-category');
      fireEvent.change(combobox, { target: { value: 'c2' } });
      fireEvent.click(screen.getByText('Save Override'));
      await waitFor(() => {
        expect(mockCreateOverride).toHaveBeenCalledWith('s1', expect.objectContaining({
          categoryId: 'c2',
        }));
      });
    });
  });
});

// Issue #2096: an estimated schedule's occurrence opens at its month's estimate
// and keeps following it when saved unchanged.
describe('OverrideEditorDialog: an estimated schedule (issue #2096)', () => {
  const heating = {
    id: 's9', name: 'Heating', amount: -999, currencyCode: 'CAD',
    accountId: 'a1', categoryId: 'c1', description: '',
    isTransfer: false, isSplit: false,
    account: { name: 'Checking' },
    amountIsEstimated: true,
    amountEstimate: {
      status: 'estimated',
      currencyCode: 'CAD',
      months: { '2025-03': { amount: -180, basis: 'seasonal' } },
      paymentCount: 8,
      latestPaymentDate: '2025-02-10',
      growthRate: null,
      historyMonths: 24,
      missingPair: null,
    },
  } as any;
  const props = {
    isOpen: true,
    scheduledTransaction: heating,
    overrideDate: '2025-03-01',
    categories: [{ id: 'c1', name: 'Utilities', parentId: null }] as any[],
    accounts: [{ id: 'a1', name: 'Checking', currentBalance: 5000 }] as any[],
    onClose: vi.fn(),
    onSave: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("opens on the month's estimate, never the snapshot", () => {
    render(<OverrideEditorDialog {...props} />);
    const amountInput = screen.getByLabelText('Amount') as HTMLInputElement;
    expect(Number(amountInput.value)).toBe(-180);
    expect(screen.getByText(/keeps following the estimate/)).toBeInTheDocument();
  });

  it('saves an unchanged estimate as no amount, so it keeps following it', async () => {
    render(<OverrideEditorDialog {...props} />);
    fireEvent.click(screen.getByText('Save Override'));
    await waitFor(() => {
      expect(mockCreateOverride).toHaveBeenCalledWith(
        's9',
        expect.objectContaining({ amount: null, originalDate: '2025-03-01' }),
      );
    });
  });

  it('pins the estimate as a stated amount when asked to keep it', async () => {
    render(<OverrideEditorDialog {...props} />);
    fireEvent.click(
      screen.getByRole('switch', { name: 'Keep this amount, even when new payments change the estimate' }),
    );
    fireEvent.click(screen.getByText('Save Override'));
    await waitFor(() => {
      expect(mockCreateOverride).toHaveBeenCalledWith(
        's9',
        expect.objectContaining({ amount: -180 }),
      );
    });
  });

  it('saves a changed amount as a stated one', async () => {
    render(<OverrideEditorDialog {...props} />);
    const amountInput = screen.getByLabelText('Amount') as HTMLInputElement;
    fireEvent.change(amountInput, { target: { value: '-205' } });
    fireEvent.blur(amountInput);
    fireEvent.click(screen.getByText('Save Override'));
    await waitFor(() => {
      expect(mockCreateOverride).toHaveBeenCalledWith(
        's9',
        expect.objectContaining({ amount: -205 }),
      );
    });
  });

  it('saves an unknown estimate left empty as no amount, so it keeps following it', async () => {
    render(
      <OverrideEditorDialog
        {...props}
        scheduledTransaction={{ ...heating, amountEstimate: { ...heating.amountEstimate, status: 'no-history', months: {} } }}
      />,
    );
    const amountInput = screen.getByLabelText('Amount') as HTMLInputElement;
    expect(amountInput.value).toBe('');
    fireEvent.click(screen.getByText('Save Override'));
    await waitFor(() => {
      expect(mockCreateOverride).toHaveBeenCalledWith(
        's9',
        expect.objectContaining({ amount: null }),
      );
    });
    expect(toast.error).not.toHaveBeenCalled();
  });
});
