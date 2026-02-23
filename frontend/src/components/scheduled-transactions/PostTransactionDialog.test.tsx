import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@/test/render';
import { PostTransactionDialog } from './PostTransactionDialog';
import toast from 'react-hot-toast';

vi.mock('react-hot-toast', () => ({
  default: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

const mockPostApi = vi.fn().mockResolvedValue({});

vi.mock('@/lib/scheduled-transactions', () => ({
  scheduledTransactionsApi: {
    post: (...args: any[]) => mockPostApi(...args),
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

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: (n: number, _c?: string) => `$${n.toFixed(2)}`,
  }),
}));

vi.mock('@/lib/forecast', () => ({
  getProjectedBalanceAtDate: (account: any) => Number(account.currentBalance) || 0,
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
    { id: '1', categoryId: 'c1', amount: -8, memo: '', splitType: 'category' },
    { id: '2', categoryId: 'c2', amount: -7.99, memo: '', splitType: 'category' },
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

describe('PostTransactionDialog', () => {
  const scheduledTransaction = {
    id: 's1', name: 'Netflix', amount: -15.99, currencyCode: 'CAD',
    accountId: 'a1', categoryId: 'c1', description: 'Monthly sub',
    nextDueDate: '2025-02-15T00:00:00Z', isTransfer: false, isSplit: false,
    account: { name: 'Checking' },
  } as any;

  const transferTransaction = {
    id: 's2', name: 'Savings Transfer', amount: -500, currencyCode: 'CAD',
    accountId: 'a1', categoryId: null, description: '',
    nextDueDate: '2025-02-15T00:00:00Z', isTransfer: true, isSplit: false,
    account: { name: 'Checking', currentBalance: 5000 },
    transferAccountId: 'a2',
    transferAccount: { name: 'Savings', currentBalance: 10000 },
  } as any;

  const splitTransaction = {
    id: 's3', name: 'Split Sub', amount: -15.99, currencyCode: 'CAD',
    accountId: 'a1', categoryId: null, description: '',
    nextDueDate: '2025-02-15T00:00:00Z', isTransfer: false, isSplit: true,
    account: { name: 'Checking' },
    splits: [
      { id: 'sp1', categoryId: 'c1', amount: -8, memo: '' },
      { id: 'sp2', categoryId: 'c2', amount: -7.99, memo: '' },
    ],
  } as any;

  const transactionWithOverride = {
    ...scheduledTransaction,
    nextOverride: {
      amount: -19.99,
      categoryId: 'c2',
      description: 'Price increased',
      isSplit: false,
      splits: null,
    },
  } as any;

  const categories = [
    { id: 'c1', name: 'Entertainment', parentId: null },
    { id: 'c2', name: 'Subscriptions', parentId: null },
  ] as any[];
  const accounts = [
    { id: 'a1', name: 'Checking', currentBalance: 5000 },
    { id: 'a2', name: 'Savings', currentBalance: 10000 },
  ] as any[];

  const defaultProps = {
    isOpen: true,
    scheduledTransaction,
    categories,
    accounts,
    scheduledTransactions: [] as any[],
    futureTransactions: [] as any[],
    onClose: vi.fn(),
    onPosted: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --- Rendering ---
  it('renders dialog title', () => {
    render(<PostTransactionDialog {...defaultProps} />);
    const elements = screen.getAllByText('Post Transaction');
    expect(elements.length).toBeGreaterThanOrEqual(1);
  });

  it('shows posting description with transaction name', () => {
    render(<PostTransactionDialog {...defaultProps} />);
    expect(screen.getByText(/Netflix/)).toBeInTheDocument();
  });

  it('renders transaction date and amount fields', () => {
    render(<PostTransactionDialog {...defaultProps} />);
    expect(screen.getByText('Transaction Date')).toBeInTheDocument();
    expect(screen.getByText('Amount')).toBeInTheDocument();
  });

  it('renders Post Transaction button', () => {
    render(<PostTransactionDialog {...defaultProps} />);
    const buttons = screen.getAllByText('Post Transaction');
    // Title and button
    expect(buttons.length).toBeGreaterThanOrEqual(2);
  });

  it('does not render when isOpen is false', () => {
    render(<PostTransactionDialog {...defaultProps} isOpen={false} />);
    expect(screen.queryByText('Post Transaction')).not.toBeInTheDocument();
  });

  // --- Cancel button ---
  it('shows Cancel button', () => {
    render(<PostTransactionDialog {...defaultProps} />);
    expect(screen.getByText('Cancel')).toBeInTheDocument();
  });

  it('calls onClose when Cancel button is clicked', () => {
    const onClose = vi.fn();
    render(<PostTransactionDialog {...defaultProps} onClose={onClose} />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalled();
  });

  it('calls onClose when X button is clicked', () => {
    const onClose = vi.fn();
    render(<PostTransactionDialog {...defaultProps} onClose={onClose} />);
    const closeButtons = screen.getAllByRole('button');
    const xButton = closeButtons.find(b => b.querySelector('svg path[d*="M6 18L18 6"]'));
    if (xButton) {
      fireEvent.click(xButton);
      expect(onClose).toHaveBeenCalled();
    }
  });

  // --- Description field ---
  it('shows description field with placeholder', () => {
    render(<PostTransactionDialog {...defaultProps} />);
    expect(screen.getByText('Description (optional)')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Description...')).toBeInTheDocument();
  });

  it('allows changing description', () => {
    render(<PostTransactionDialog {...defaultProps} />);
    const descInput = screen.getByPlaceholderText('Description...');
    fireEvent.change(descInput, { target: { value: 'Custom description' } });
    expect((descInput as HTMLInputElement).value).toBe('Custom description');
  });

  // --- Transaction date ---
  it('initializes transaction date to next due date', () => {
    render(<PostTransactionDialog {...defaultProps} />);
    const dateInput = screen.getByDisplayValue('2025-02-15');
    expect(dateInput).toBeInTheDocument();
  });

  it('allows changing transaction date', () => {
    render(<PostTransactionDialog {...defaultProps} />);
    const dateInput = screen.getByDisplayValue('2025-02-15');
    fireEvent.change(dateInput, { target: { value: '2025-02-20' } });
    expect((dateInput as HTMLInputElement).value).toBe('2025-02-20');
  });

  // --- Post transaction ---
  it('calls post API when Post Transaction button is clicked', async () => {
    const onPosted = vi.fn();
    const onClose = vi.fn();
    render(<PostTransactionDialog {...defaultProps} onPosted={onPosted} onClose={onClose} />);

    // Click the Post Transaction button (the button, not the title)
    const buttons = screen.getAllByText('Post Transaction');
    const postButton = buttons[buttons.length - 1]; // Last one is the button
    fireEvent.click(postButton);

    await waitFor(() => {
      expect(mockPostApi).toHaveBeenCalledWith('s1', expect.objectContaining({
        transactionDate: '2025-02-15',
        amount: -15.99,
      }));
    });

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Transaction posted');
    });

    await waitFor(() => {
      expect(onPosted).toHaveBeenCalled();
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('shows error toast when post fails', async () => {
    mockPostApi.mockRejectedValueOnce(new Error('Post failed'));
    render(<PostTransactionDialog {...defaultProps} />);

    const buttons = screen.getAllByText('Post Transaction');
    const postButton = buttons[buttons.length - 1];
    fireEvent.click(postButton);

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to post transaction');
    });
  });

  // --- Transfer transaction display ---
  it('shows transfer description for transfer transactions', () => {
    render(<PostTransactionDialog {...defaultProps} scheduledTransaction={transferTransaction} />);
    // Description mentions "transfer" and account names - may appear in multiple elements
    const transferElements = screen.getAllByText(/transfer/i);
    expect(transferElements.length).toBeGreaterThanOrEqual(1);
    const checkingElements = screen.getAllByText(/Checking/);
    expect(checkingElements.length).toBeGreaterThanOrEqual(1);
  });

  it('shows transfer indicator block for transfer transactions', () => {
    render(<PostTransactionDialog {...defaultProps} scheduledTransaction={transferTransaction} />);
    expect(screen.getByText(/Transfer:/)).toBeInTheDocument();
    // "Savings" appears in both the description and the transfer indicator
    const savingsElements = screen.getAllByText(/Savings/);
    expect(savingsElements.length).toBeGreaterThanOrEqual(1);
  });

  it('does not show category combobox for transfer transactions', () => {
    render(<PostTransactionDialog {...defaultProps} scheduledTransaction={transferTransaction} />);
    expect(screen.queryByTestId('combobox-category')).not.toBeInTheDocument();
  });

  it('does not show split toggle for transfer transactions', () => {
    render(<PostTransactionDialog {...defaultProps} scheduledTransaction={transferTransaction} />);
    expect(screen.queryByLabelText('Split this transaction')).not.toBeInTheDocument();
  });

  // --- Regular transaction display ---
  it('shows non-transfer description for regular transactions', () => {
    render(<PostTransactionDialog {...defaultProps} />);
    expect(screen.getByText(/Modify values below if needed/)).toBeInTheDocument();
  });

  it('shows category combobox for regular transactions', () => {
    render(<PostTransactionDialog {...defaultProps} />);
    expect(screen.getByText('Category')).toBeInTheDocument();
    expect(screen.getByTestId('combobox-category')).toBeInTheDocument();
  });

  // --- Split toggle ---
  it('shows split toggle for non-transfer transactions', () => {
    render(<PostTransactionDialog {...defaultProps} />);
    expect(screen.getByLabelText('Split this transaction')).toBeInTheDocument();
  });

  it('shows split editor when split checkbox is checked', () => {
    render(<PostTransactionDialog {...defaultProps} />);

    const splitCheckbox = screen.getByLabelText('Split this transaction') as HTMLInputElement;
    fireEvent.click(splitCheckbox);

    expect(screen.getByTestId('split-editor')).toBeInTheDocument();
  });

  it('hides category combobox when split is enabled', () => {
    render(<PostTransactionDialog {...defaultProps} />);

    expect(screen.getByTestId('combobox-category')).toBeInTheDocument();

    const splitCheckbox = screen.getByLabelText('Split this transaction') as HTMLInputElement;
    fireEvent.click(splitCheckbox);

    expect(screen.queryByTestId('combobox-category')).not.toBeInTheDocument();
    expect(screen.getByTestId('split-editor')).toBeInTheDocument();
  });

  // --- Initialize with split transaction ---
  it('initializes split state from split transaction', () => {
    render(<PostTransactionDialog {...defaultProps} scheduledTransaction={splitTransaction} />);

    const splitCheckbox = screen.getByLabelText('Split this transaction') as HTMLInputElement;
    expect(splitCheckbox.checked).toBe(true);
    expect(screen.getByTestId('split-editor')).toBeInTheDocument();
  });

  // --- Override values ---
  it('initializes with override values when override exists', () => {
    render(<PostTransactionDialog {...defaultProps} scheduledTransaction={transactionWithOverride} />);

    // Description from override
    const descInput = screen.getByPlaceholderText('Description...');
    expect((descInput as HTMLInputElement).value).toBe('Price increased');
  });

  // --- Post with modified date ---
  it('posts with modified transaction date', async () => {
    const onPosted = vi.fn();
    render(<PostTransactionDialog {...defaultProps} onPosted={onPosted} />);

    // Change date
    const dateInput = screen.getByDisplayValue('2025-02-15');
    fireEvent.change(dateInput, { target: { value: '2025-02-20' } });

    // Post
    const buttons = screen.getAllByText('Post Transaction');
    const postButton = buttons[buttons.length - 1];
    fireEvent.click(postButton);

    await waitFor(() => {
      expect(mockPostApi).toHaveBeenCalledWith('s1', expect.objectContaining({
        transactionDate: '2025-02-20',
      }));
    });
  });

  // --- Account balance info ---
  it('shows account balance info for regular transactions', () => {
    render(<PostTransactionDialog {...defaultProps} />);
    // Account name and projected balance should appear
    const checkingElements = screen.getAllByText(/Checking/);
    expect(checkingElements.length).toBeGreaterThanOrEqual(1);
    // Balance before (5000) and after (5000 + -15.99 = 4984.01) shown together
    expect(screen.getByText(/\$5000\.00/)).toBeInTheDocument();
    expect(screen.getByText('$4984.01')).toBeInTheDocument();
  });

  it('shows both account balances for transfer transactions', () => {
    render(<PostTransactionDialog {...defaultProps} scheduledTransaction={transferTransaction} />);
    // Both Checking and Savings should appear in the balance info
    const checkingElements = screen.getAllByText(/Checking/);
    expect(checkingElements.length).toBeGreaterThanOrEqual(2); // description + balance info
    const savingsElements = screen.getAllByText(/Savings/);
    expect(savingsElements.length).toBeGreaterThanOrEqual(2); // description + balance info
  });

  // --- Negative balance warning ---
  it('shows warning when posting will make source account go negative', () => {
    const lowBalanceAccounts = [
      { id: 'a1', name: 'Checking', currentBalance: 10 },
      { id: 'a2', name: 'Savings', currentBalance: 10000 },
    ] as any[];
    render(<PostTransactionDialog {...defaultProps} accounts={lowBalanceAccounts} />);
    // Balance after: 10 + (-15.99) = -5.99
    expect(screen.getByText(/below zero/)).toBeInTheDocument();
  });

  it('does not show warning when balance stays positive', () => {
    render(<PostTransactionDialog {...defaultProps} />);
    // Balance after: 5000 + (-15.99) = 4984.01
    expect(screen.queryByText(/below zero/)).not.toBeInTheDocument();
  });

  it('shows warning for transfer when source account goes negative', () => {
    const lowBalanceAccounts = [
      { id: 'a1', name: 'Checking', currentBalance: 100 },
      { id: 'a2', name: 'Savings', currentBalance: 10000 },
    ] as any[];
    const largeTx = {
      ...transferTransaction,
      amount: -500,
    } as any;
    render(<PostTransactionDialog {...defaultProps} accounts={lowBalanceAccounts} scheduledTransaction={largeTx} />);
    // Source after: 100 + (-500) = -400
    expect(screen.getByText(/below zero/)).toBeInTheDocument();
  });

  // --- Today button ---
  it('shows Today button when date is not today', () => {
    render(<PostTransactionDialog {...defaultProps} />);
    // The date is 2025-02-15, which is not today
    expect(screen.getByText('Today')).toBeInTheDocument();
  });

  it('sets date to today when Today button is clicked', () => {
    render(<PostTransactionDialog {...defaultProps} />);
    fireEvent.click(screen.getByText('Today'));
    const today = new Date();
    const expectedDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const dateInput = document.querySelector('input[type="date"]') as HTMLInputElement;
    expect(dateInput.value).toBe(expectedDate);
  });
});
