import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@/test/render';
import { TransactionList } from './TransactionList';
import { Transaction, TransactionStatus } from '@/types/transaction';

vi.mock('@/lib/transactions', () => ({
  transactionsApi: {
    delete: vi.fn(),
    deleteTransfer: vi.fn(),
    updateStatus: vi.fn(),
  },
}));

vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({
    formatDate: (d: string) => d,
  }),
}));

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: (n: number) => `$${n.toFixed(2)}`,
  }),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

function createTransaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: '123e4567-e89b-12d3-a456-426614174000',
    userId: 'user-1',
    accountId: 'acc-1',
    account: { id: 'acc-1', name: 'Chequing', accountType: 'CHEQUING' } as any,
    transactionDate: '2024-01-15',
    payeeId: 'payee-1',
    payeeName: 'Grocery Store',
    payee: null,
    categoryId: 'cat-1',
    category: { id: 'cat-1', name: 'Groceries', color: '#22c55e' } as any,
    amount: -50.0,
    currencyCode: 'CAD',
    exchangeRate: 1,
    description: 'Weekly groceries',
    referenceNumber: null,
    status: TransactionStatus.UNRECONCILED,
    isCleared: false,
    isReconciled: false,
    isVoid: false,
    reconciledDate: null,
    isSplit: false,
    parentTransactionId: null,
    isTransfer: false,
    linkedTransactionId: null,
    createdAt: '2024-01-15T00:00:00Z',
    updatedAt: '2024-01-15T00:00:00Z',
    ...overrides,
  };
}

describe('TransactionList', () => {
  const mockOnEdit = vi.fn();
  const mockOnDelete = vi.fn();
  const mockOnRefresh = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders empty state when no transactions', () => {
    render(
      <TransactionList
        transactions={[]}
        onEdit={mockOnEdit}
        onDelete={mockOnDelete}
        onRefresh={mockOnRefresh}
      />
    );

    expect(screen.getByText('No transactions')).toBeInTheDocument();
    expect(screen.getByText('Get started by creating a new transaction.')).toBeInTheDocument();
  });

  it('renders transaction rows with data', () => {
    const transactions = [
      createTransaction(),
      createTransaction({
        id: '223e4567-e89b-12d3-a456-426614174001',
        payeeName: 'Coffee Shop',
        amount: -5.5,
      }),
    ];

    render(
      <TransactionList
        transactions={transactions}
        onEdit={mockOnEdit}
        onDelete={mockOnDelete}
        onRefresh={mockOnRefresh}
      />
    );

    expect(screen.getByText('Grocery Store')).toBeInTheDocument();
    expect(screen.getByText('Coffee Shop')).toBeInTheDocument();
  });

  it('shows amount with color - negative red, positive green', () => {
    const transactions = [
      createTransaction({ amount: -50.0 }),
      createTransaction({
        id: '223e4567-e89b-12d3-a456-426614174001',
        amount: 100.0,
        payeeName: 'Salary',
      }),
    ];

    render(
      <TransactionList
        transactions={transactions}
        onEdit={mockOnEdit}
        onRefresh={mockOnRefresh}
      />
    );

    // Negative amounts should have text-red-600
    const negativeAmount = screen.getByText('-$50.00');
    expect(negativeAmount).toHaveClass('text-red-600');

    // Positive amounts should have text-green-600
    const positiveAmount = screen.getByText('+$100.00');
    expect(positiveAmount).toHaveClass('text-green-600');
  });

  it('calls onEdit when Edit button is clicked', () => {
    const transaction = createTransaction();

    render(
      <TransactionList
        transactions={[transaction]}
        onEdit={mockOnEdit}
        onRefresh={mockOnRefresh}
      />
    );

    const editButton = screen.getByText('Edit');
    fireEvent.click(editButton);

    expect(mockOnEdit).toHaveBeenCalledWith(transaction);
  });

  it('shows delete button and opens confirm dialog', () => {
    const transaction = createTransaction();

    render(
      <TransactionList
        transactions={[transaction]}
        onEdit={mockOnEdit}
        onDelete={mockOnDelete}
        onRefresh={mockOnRefresh}
      />
    );

    const deleteButton = screen.getByText('Delete');
    fireEvent.click(deleteButton);

    // Confirm dialog should appear
    expect(screen.getByText('Delete Transaction')).toBeInTheDocument();
    expect(screen.getByText(/Are you sure you want to delete this transaction/)).toBeInTheDocument();
  });

  it('density toggle changes the displayed label', () => {
    const transactions = [createTransaction()];

    render(
      <TransactionList
        transactions={transactions}
        onEdit={mockOnEdit}
        onRefresh={mockOnRefresh}
      />
    );

    // Default density is 'normal'
    const densityButton = screen.getByTitle('Toggle row density');
    expect(densityButton).toHaveTextContent('Normal');

    // Click to cycle to compact
    fireEvent.click(densityButton);
    expect(densityButton).toHaveTextContent('Compact');

    // Click to cycle to dense
    fireEvent.click(densityButton);
    expect(densityButton).toHaveTextContent('Dense');

    // Click to cycle back to normal
    fireEvent.click(densityButton);
    expect(densityButton).toHaveTextContent('Normal');
  });

  it('shows VOID status indicator with reduced opacity', () => {
    const voidTransaction = createTransaction({
      status: TransactionStatus.VOID,
      isVoid: true,
    });

    render(
      <TransactionList
        transactions={[voidTransaction]}
        onEdit={mockOnEdit}
        onRefresh={mockOnRefresh}
      />
    );

    expect(screen.getByText('VOID')).toBeInTheDocument();

    // The row should have opacity-50 class
    const row = screen.getByText('Grocery Store').closest('tr');
    expect(row).toHaveClass('opacity-50');
  });

  it('shows running balance when isSingleAccountView is true', () => {
    const transactions = [
      createTransaction({ amount: -50.0 }),
      createTransaction({
        id: '223e4567-e89b-12d3-a456-426614174001',
        amount: -25.0,
        payeeName: 'Coffee',
      }),
    ];

    render(
      <TransactionList
        transactions={transactions}
        onEdit={mockOnEdit}
        onRefresh={mockOnRefresh}
        isSingleAccountView={true}
        startingBalance={1000}
      />
    );

    // The Balance column header should be visible
    expect(screen.getByText('Balance')).toBeInTheDocument();

    // First transaction: startingBalance = 1000
    // Second transaction: 1000 - (-50) = 1050
    expect(screen.getByText('$1000.00')).toBeInTheDocument();
    expect(screen.getByText('$1050.00')).toBeInTheDocument();
  });

  it('shows Transfer badge for transfer transactions', () => {
    const transferTransaction = createTransaction({
      isTransfer: true,
      linkedTransactionId: 'linked-tx-1',
      linkedTransaction: {
        id: 'linked-tx-1',
        account: { id: 'acc-2', name: 'Savings' },
      } as any,
      amount: -200,
      categoryId: null,
      category: null,
    });

    render(
      <TransactionList
        transactions={[transferTransaction]}
        onEdit={mockOnEdit}
        onRefresh={mockOnRefresh}
      />
    );

    // Should show the transfer badge with destination account name
    expect(screen.getByText(/Savings/)).toBeInTheDocument();
  });

  it('calls onCategoryClick when category badge is clicked', () => {
    const mockOnCategoryClick = vi.fn();
    const transaction = createTransaction();

    render(
      <TransactionList
        transactions={[transaction]}
        onEdit={mockOnEdit}
        onRefresh={mockOnRefresh}
        onCategoryClick={mockOnCategoryClick}
      />
    );

    const categoryButton = screen.getByTitle('Filter by Groceries');
    fireEvent.click(categoryButton);

    expect(mockOnCategoryClick).toHaveBeenCalledWith('cat-1');
  });

  it('renders category as non-clickable span when onCategoryClick is not provided', () => {
    const transaction = createTransaction();

    render(
      <TransactionList
        transactions={[transaction]}
        onEdit={mockOnEdit}
        onRefresh={mockOnRefresh}
      />
    );

    // Should show category name but as a span (with plain title, not "Filter by")
    const categorySpan = screen.getByTitle('Groceries');
    expect(categorySpan.tagName).toBe('SPAN');
  });

  it('shows action sheet with filter and delete options on long-press', async () => {
    const mockOnCategoryClick = vi.fn();
    const transaction = createTransaction();

    vi.useFakeTimers();

    render(
      <TransactionList
        transactions={[transaction]}
        onEdit={mockOnEdit}
        onRefresh={mockOnRefresh}
        onCategoryClick={mockOnCategoryClick}
      />
    );

    const row = screen.getByText('Grocery Store').closest('tr')!;
    fireEvent.mouseDown(row);

    // Advance past 750ms long-press threshold
    vi.advanceTimersByTime(800);

    vi.useRealTimers();

    // Action sheet should appear with filter and delete options
    await waitFor(() => {
      expect(screen.getByText(/Filter by.*Groceries/)).toBeInTheDocument();
    });

    // Should also have Edit and Delete options in the action sheet
    const editButtons = screen.getAllByText('Edit');
    expect(editButtons.length).toBeGreaterThanOrEqual(2); // row Edit + action sheet Edit
    const deleteButtons = screen.getAllByText('Delete');
    expect(deleteButtons.length).toBeGreaterThanOrEqual(2); // row Delete + action sheet Delete
  });

  it('shows Split badge for split transactions', () => {
    const splitTransaction = createTransaction({
      isSplit: true,
      categoryId: null,
      category: null,
      splits: [
        { id: 's1', transactionId: 'tx-1', categoryId: 'cat-1', category: { id: 'cat-1', name: 'Groceries' } as any, transferAccountId: null, transferAccount: null, linkedTransactionId: null, amount: -30, memo: null, createdAt: '' },
        { id: 's2', transactionId: 'tx-1', categoryId: 'cat-2', category: { id: 'cat-2', name: 'Dining' } as any, transferAccountId: null, transferAccount: null, linkedTransactionId: null, amount: -20, memo: null, createdAt: '' },
      ],
    });

    render(
      <TransactionList
        transactions={[splitTransaction]}
        onEdit={mockOnEdit}
        onRefresh={mockOnRefresh}
      />
    );

    expect(screen.getByText('Split (2)')).toBeInTheDocument();
  });
});
