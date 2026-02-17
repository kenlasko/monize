import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@/test/render';
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

  it('renders empty state when no transactions', async () => {
    render(
      <TransactionList
        transactions={[]}
        onEdit={mockOnEdit}
        onDelete={mockOnDelete}
        onRefresh={mockOnRefresh}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('No transactions')).toBeInTheDocument();
      expect(screen.getByText('Get started by creating a new transaction.')).toBeInTheDocument();
    });
  });

  it('renders transaction rows with data', async () => {
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

    await waitFor(() => {
      expect(screen.getByText('Grocery Store')).toBeInTheDocument();
      expect(screen.getByText('Coffee Shop')).toBeInTheDocument();
    });
  });

  it('shows amount with color - negative red, positive green', async () => {
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

    await waitFor(() => {
      // Negative amounts should have text-red-600
      const negativeAmount = screen.getByText('-$50.00');
      expect(negativeAmount).toHaveClass('text-red-600');

      // Positive amounts should have text-green-600
      const positiveAmount = screen.getByText('+$100.00');
      expect(positiveAmount).toHaveClass('text-green-600');
    });
  });

  it('calls onEdit when Edit button is clicked', async () => {
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

    await waitFor(() => {
      expect(mockOnEdit).toHaveBeenCalledWith(transaction);
    });
  });

  it('shows delete button and opens confirm dialog', async () => {
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
    await waitFor(() => {
      expect(screen.getByText('Delete Transaction')).toBeInTheDocument();
      expect(screen.getByText(/Are you sure you want to delete this transaction/)).toBeInTheDocument();
    });
  });

  it('density toggle changes the displayed label', async () => {
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
    await waitFor(() => {
      expect(densityButton).toHaveTextContent('Normal');
    });

    // Click to cycle to compact
    fireEvent.click(densityButton);
    await waitFor(() => {
      expect(densityButton).toHaveTextContent('Compact');
    });

    // Click to cycle to dense
    fireEvent.click(densityButton);
    await waitFor(() => {
      expect(densityButton).toHaveTextContent('Dense');
    });

    // Click to cycle back to normal
    fireEvent.click(densityButton);
    await waitFor(() => {
      expect(densityButton).toHaveTextContent('Normal');
    });
  });

  it('shows VOID status indicator with reduced opacity', async () => {
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

    await waitFor(() => {
      expect(screen.getByText('VOID')).toBeInTheDocument();

      // The row should have opacity-50 class
      const row = screen.getByText('Grocery Store').closest('tr');
      expect(row).toHaveClass('opacity-50');
    });
  });

  it('shows running balance when isSingleAccountView is true', async () => {
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

    await waitFor(() => {
      // The Balance column header should be visible
      expect(screen.getByText('Balance')).toBeInTheDocument();

      // First transaction: startingBalance = 1000
      // Second transaction: 1000 - (-50) = 1050
      expect(screen.getByText('$1000.00')).toBeInTheDocument();
      expect(screen.getByText('$1050.00')).toBeInTheDocument();
    });
  });

  it('shows Transfer badge for transfer transactions', async () => {
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
    await waitFor(() => {
      expect(screen.getByText(/Savings/)).toBeInTheDocument();
    });
  });

  it('calls onCategoryClick when category badge is clicked', async () => {
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

    await waitFor(() => {
      expect(mockOnCategoryClick).toHaveBeenCalledWith('cat-1');
    });
  });

  it('renders category as non-clickable span when onCategoryClick is not provided', async () => {
    const transaction = createTransaction();

    render(
      <TransactionList
        transactions={[transaction]}
        onEdit={mockOnEdit}
        onRefresh={mockOnRefresh}
      />
    );

    await waitFor(() => {
      // Should show category name but as a span (with plain title, not "Filter by")
      const categorySpan = screen.getByTitle('Groceries');
      expect(categorySpan.tagName).toBe('SPAN');
    });
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
    await act(async () => { vi.advanceTimersByTime(800); });

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

  it('shows all filter options in action sheet when all callbacks provided', async () => {
    const transaction = createTransaction();

    vi.useFakeTimers();

    render(
      <TransactionList
        transactions={[transaction]}
        onEdit={mockOnEdit}
        onRefresh={mockOnRefresh}
        onCategoryClick={vi.fn()}
        onDateFilterClick={vi.fn()}
        onAccountFilterClick={vi.fn()}
        onPayeeFilterClick={vi.fn()}
      />
    );

    const row = screen.getByText('Grocery Store').closest('tr')!;
    fireEvent.mouseDown(row);
    await act(async () => { vi.advanceTimersByTime(800); });
    vi.useRealTimers();

    await waitFor(() => {
      expect(screen.getByText(/Filter by date/)).toBeInTheDocument();
      expect(screen.getByText(/Filter by.*Chequing/)).toBeInTheDocument();
      expect(screen.getByText(/Filter by.*Grocery Store/)).toBeInTheDocument();
      expect(screen.getByText(/Filter by.*Groceries/)).toBeInTheDocument();
    });
  });

  it('calls onDateFilterClick with transaction date from action sheet', async () => {
    const mockOnDateFilterClick = vi.fn();
    const transaction = createTransaction({ transactionDate: '2024-03-15' });

    vi.useFakeTimers();

    render(
      <TransactionList
        transactions={[transaction]}
        onEdit={mockOnEdit}
        onRefresh={mockOnRefresh}
        onDateFilterClick={mockOnDateFilterClick}
      />
    );

    const row = screen.getByText('Grocery Store').closest('tr')!;
    fireEvent.mouseDown(row);
    await act(async () => { vi.advanceTimersByTime(800); });
    vi.useRealTimers();

    await waitFor(() => {
      expect(screen.getByText(/Filter by date/)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText(/Filter by date/));
    expect(mockOnDateFilterClick).toHaveBeenCalledWith('2024-03-15');
  });

  it('calls onAccountFilterClick with account ID from action sheet', async () => {
    const mockOnAccountFilterClick = vi.fn();
    const transaction = createTransaction();

    vi.useFakeTimers();

    render(
      <TransactionList
        transactions={[transaction]}
        onEdit={mockOnEdit}
        onRefresh={mockOnRefresh}
        onAccountFilterClick={mockOnAccountFilterClick}
      />
    );

    const row = screen.getByText('Grocery Store').closest('tr')!;
    fireEvent.mouseDown(row);
    await act(async () => { vi.advanceTimersByTime(800); });
    vi.useRealTimers();

    await waitFor(() => {
      expect(screen.getByText(/Filter by.*Chequing/)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText(/Filter by.*Chequing/));
    expect(mockOnAccountFilterClick).toHaveBeenCalledWith('acc-1');
  });

  it('calls onPayeeFilterClick with payee ID from action sheet', async () => {
    const mockOnPayeeFilterClick = vi.fn();
    const transaction = createTransaction();

    vi.useFakeTimers();

    render(
      <TransactionList
        transactions={[transaction]}
        onEdit={mockOnEdit}
        onRefresh={mockOnRefresh}
        onPayeeFilterClick={mockOnPayeeFilterClick}
      />
    );

    const row = screen.getByText('Grocery Store').closest('tr')!;
    fireEvent.mouseDown(row);
    await act(async () => { vi.advanceTimersByTime(800); });
    vi.useRealTimers();

    await waitFor(() => {
      expect(screen.getByText(/Filter by.*Grocery Store/)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText(/Filter by.*Grocery Store/));
    expect(mockOnPayeeFilterClick).toHaveBeenCalledWith('payee-1');
  });

  it('does not show date filter option when onDateFilterClick is not provided', async () => {
    const transaction = createTransaction();

    vi.useFakeTimers();

    render(
      <TransactionList
        transactions={[transaction]}
        onEdit={mockOnEdit}
        onRefresh={mockOnRefresh}
        onCategoryClick={vi.fn()}
      />
    );

    const row = screen.getByText('Grocery Store').closest('tr')!;
    fireEvent.mouseDown(row);
    await act(async () => { vi.advanceTimersByTime(800); });
    vi.useRealTimers();

    await waitFor(() => {
      expect(screen.getByText(/Filter by.*Groceries/)).toBeInTheDocument();
    });

    expect(screen.queryByText(/Filter by date/)).not.toBeInTheDocument();
  });

  it('does not show account filter option when account is null', async () => {
    const transaction = createTransaction({ account: null });

    vi.useFakeTimers();

    render(
      <TransactionList
        transactions={[transaction]}
        onEdit={mockOnEdit}
        onRefresh={mockOnRefresh}
        onAccountFilterClick={vi.fn()}
      />
    );

    const row = screen.getAllByText('Grocery Store')[0].closest('tr')!;
    fireEvent.mouseDown(row);
    await act(async () => { vi.advanceTimersByTime(800); });
    vi.useRealTimers();

    // Wait for action sheet to appear
    await waitFor(() => {
      expect(screen.getAllByText('Edit').length).toBeGreaterThanOrEqual(2);
    });

    // Account filter should not appear since account is null
    const filterButtons = screen.queryAllByText(/Filter by/);
    const accountFilterButton = filterButtons.find(el => el.textContent?.includes('Chequing'));
    expect(accountFilterButton).toBeUndefined();
  });

  it('does not show payee filter option when payeeId is null', async () => {
    const transaction = createTransaction({ payeeId: null, payeeName: null });

    vi.useFakeTimers();

    render(
      <TransactionList
        transactions={[transaction]}
        onEdit={mockOnEdit}
        onRefresh={mockOnRefresh}
        onPayeeFilterClick={vi.fn()}
        onCategoryClick={vi.fn()}
      />
    );

    const row = screen.getByText('Chequing').closest('tr')!;
    fireEvent.mouseDown(row);
    await act(async () => { vi.advanceTimersByTime(800); });
    vi.useRealTimers();

    await waitFor(() => {
      expect(screen.getByText(/Filter by.*Groceries/)).toBeInTheDocument();
    });

    // Payee filter should not appear since payeeId is null
    const filterButtons = screen.queryAllByText(/Filter by/);
    const payeeFilterButton = filterButtons.find(el => el.textContent?.includes('Payee'));
    expect(payeeFilterButton).toBeUndefined();
  });

  it('shows Split badge for split transactions', async () => {
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

    await waitFor(() => {
      expect(screen.getByText('Split (2)')).toBeInTheDocument();
    });
  });

  describe('selection mode', () => {
    it('renders checkboxes when selectionMode is true', async () => {
      const transactions = [createTransaction()];

      render(
        <TransactionList
          transactions={transactions}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
          selectionMode
          selectedIds={new Set()}
          onToggleSelection={vi.fn()}
          onToggleAllOnPage={vi.fn()}
          isAllOnPageSelected={false}
        />
      );

      await waitFor(() => {
        const checkboxes = screen.getAllByRole('checkbox');
        // 1 header checkbox + 1 row checkbox
        expect(checkboxes).toHaveLength(2);
      });
    });

    it('does not render checkboxes when selectionMode is false', async () => {
      const transactions = [createTransaction()];

      render(
        <TransactionList
          transactions={transactions}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
        />
      );

      await waitFor(() => {
        expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
      });
    });

    it('shows selected row with highlight', async () => {
      const transaction = createTransaction();

      render(
        <TransactionList
          transactions={[transaction]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
          selectionMode
          selectedIds={new Set([transaction.id])}
          onToggleSelection={vi.fn()}
          onToggleAllOnPage={vi.fn()}
          isAllOnPageSelected={true}
        />
      );

      await waitFor(() => {
        const row = screen.getByText('Grocery Store').closest('tr');
        expect(row).toHaveClass('bg-blue-50');
      });
    });

    it('calls onToggleSelection when row checkbox is clicked', async () => {
      const mockToggle = vi.fn();
      const transaction = createTransaction();

      render(
        <TransactionList
          transactions={[transaction]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
          selectionMode
          selectedIds={new Set()}
          onToggleSelection={mockToggle}
          onToggleAllOnPage={vi.fn()}
          isAllOnPageSelected={false}
        />
      );

      const checkboxes = screen.getAllByRole('checkbox');
      // checkboxes[0] is header, checkboxes[1] is the row
      fireEvent.click(checkboxes[1]);
      await waitFor(() => {
        expect(mockToggle).toHaveBeenCalledWith(transaction.id);
      });
    });

    it('calls onToggleAllOnPage when header checkbox is clicked', async () => {
      const mockToggleAll = vi.fn();
      const transactions = [createTransaction()];

      render(
        <TransactionList
          transactions={transactions}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
          selectionMode
          selectedIds={new Set()}
          onToggleSelection={vi.fn()}
          onToggleAllOnPage={mockToggleAll}
          isAllOnPageSelected={false}
        />
      );

      const checkboxes = screen.getAllByRole('checkbox');
      fireEvent.click(checkboxes[0]);
      await waitFor(() => {
        expect(mockToggleAll).toHaveBeenCalled();
      });
    });
  });

  // =========================================================================
  // Table column headers
  // =========================================================================

  describe('table column headers', () => {
    it('renders all column headers', async () => {
      render(
        <TransactionList
          transactions={[createTransaction()]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Date')).toBeInTheDocument();
        expect(screen.getByText('Account')).toBeInTheDocument();
        expect(screen.getByText('Payee')).toBeInTheDocument();
        expect(screen.getByText('Category')).toBeInTheDocument();
        expect(screen.getByText('Description')).toBeInTheDocument();
        expect(screen.getByText('Amount')).toBeInTheDocument();
        expect(screen.getByText('Status')).toBeInTheDocument();
        expect(screen.getByText('Actions')).toBeInTheDocument();
      });
    });

    it('renders Balance column header when isSingleAccountView is true', async () => {
      render(
        <TransactionList
          transactions={[createTransaction()]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
          isSingleAccountView={true}
          startingBalance={1000}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Balance')).toBeInTheDocument();
      });
    });

    it('does not render Balance column header when isSingleAccountView is false', async () => {
      render(
        <TransactionList
          transactions={[createTransaction()]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
        />
      );

      await waitFor(() => {
        expect(screen.queryByText('Balance')).not.toBeInTheDocument();
      });
    });
  });

  // =========================================================================
  // Transaction row data display
  // =========================================================================

  describe('transaction row data display', () => {
    it('displays transaction date', async () => {
      const tx = createTransaction({ transactionDate: '2024-03-15' });

      render(
        <TransactionList
          transactions={[tx]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('2024-03-15')).toBeInTheDocument();
      });
    });

    it('displays account name', async () => {
      render(
        <TransactionList
          transactions={[createTransaction()]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Chequing')).toBeInTheDocument();
      });
    });

    it('displays dash when account is null', async () => {
      const tx = createTransaction({ account: null });

      render(
        <TransactionList
          transactions={[tx]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
        />
      );

      await waitFor(() => {
        // Account column should show '-'
        const accountCells = document.querySelectorAll('td');
        const accountCell = Array.from(accountCells).find(cell =>
          cell.textContent === '-' && cell.classList.contains('hidden')
        );
        expect(accountCell).toBeTruthy();
      });
    });

    it('displays payee name', async () => {
      render(
        <TransactionList
          transactions={[createTransaction()]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Grocery Store')).toBeInTheDocument();
      });
    });

    it('displays description', async () => {
      const tx = createTransaction({ description: 'Test description text' });

      render(
        <TransactionList
          transactions={[tx]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Test description text')).toBeInTheDocument();
      });
    });

    it('displays dash when description is null', async () => {
      const tx = createTransaction({ description: null });

      render(
        <TransactionList
          transactions={[tx]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
        />
      );

      await waitFor(() => {
        // Multiple '-' dashes may appear (for null fields)
        const dashes = screen.getAllByText('-');
        expect(dashes.length).toBeGreaterThanOrEqual(1);
      });
    });

    it('displays reference number when available in normal density', async () => {
      const tx = createTransaction({ referenceNumber: 'CHQ-12345' });

      render(
        <TransactionList
          transactions={[tx]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Ref: CHQ-12345')).toBeInTheDocument();
      });
    });

    it('does not display reference number in compact density', async () => {
      const tx = createTransaction({ referenceNumber: 'CHQ-12345' });

      render(
        <TransactionList
          transactions={[tx]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
          density="compact"
        />
      );

      await waitFor(() => {
        expect(screen.queryByText('Ref: CHQ-12345')).not.toBeInTheDocument();
      });
    });
  });

  // =========================================================================
  // Status display and cycling
  // =========================================================================

  describe('status display', () => {
    it('shows Pending for unreconciled transactions', async () => {
      const tx = createTransaction({ status: TransactionStatus.UNRECONCILED });

      render(
        <TransactionList
          transactions={[tx]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Pending')).toBeInTheDocument();
      });
    });

    it('shows Cleared for cleared transactions', async () => {
      const tx = createTransaction({ status: TransactionStatus.CLEARED });

      render(
        <TransactionList
          transactions={[tx]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Cleared')).toBeInTheDocument();
      });
    });

    it('shows Reconciled for reconciled transactions', async () => {
      const tx = createTransaction({ status: TransactionStatus.RECONCILED });

      render(
        <TransactionList
          transactions={[tx]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Reconciled')).toBeInTheDocument();
      });
    });

    it('shows VOID for void transactions', async () => {
      const tx = createTransaction({ status: TransactionStatus.VOID, isVoid: true });

      render(
        <TransactionList
          transactions={[tx]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('VOID')).toBeInTheDocument();
      });
    });

    it('shows abbreviated status in dense mode', async () => {
      const tx = createTransaction({ status: TransactionStatus.CLEARED });

      render(
        <TransactionList
          transactions={[tx]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
          density="dense"
        />
      );

      await waitFor(() => {
        expect(screen.getByText('C')).toBeInTheDocument();
      });
    });

    it('shows abbreviated R for reconciled in dense mode', async () => {
      const tx = createTransaction({ status: TransactionStatus.RECONCILED });

      render(
        <TransactionList
          transactions={[tx]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
          density="dense"
        />
      );

      await waitFor(() => {
        expect(screen.getByText('R')).toBeInTheDocument();
      });
    });

    it('shows abbreviated V for void in dense mode', async () => {
      const tx = createTransaction({ status: TransactionStatus.VOID, isVoid: true });

      render(
        <TransactionList
          transactions={[tx]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
          density="dense"
        />
      );

      await waitFor(() => {
        expect(screen.getByText('V')).toBeInTheDocument();
      });
    });

    it('cycles status when status button is clicked', async () => {
      const { transactionsApi } = await import('@/lib/transactions');
      const tx = createTransaction({ status: TransactionStatus.UNRECONCILED });
      const updatedTx = { ...tx, status: TransactionStatus.CLEARED };
      vi.mocked(transactionsApi.updateStatus).mockResolvedValueOnce(updatedTx);

      render(
        <TransactionList
          transactions={[tx]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
        />
      );

      const statusButton = screen.getByTitle('Click to cycle status');
      fireEvent.click(statusButton);

      await waitFor(() => {
        expect(transactionsApi.updateStatus).toHaveBeenCalledWith(
          tx.id,
          TransactionStatus.CLEARED
        );
      });
    });

    it('shows toast.error when trying to cycle VOID status', async () => {
      const { transactionsApi } = await import('@/lib/transactions');
      const tx = createTransaction({ status: TransactionStatus.VOID, isVoid: true });

      render(
        <TransactionList
          transactions={[tx]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
        />
      );

      const statusButton = screen.getByTitle('Click to cycle status');
      fireEvent.click(statusButton);

      // Should not call updateStatus for VOID
      expect(transactionsApi.updateStatus).not.toHaveBeenCalled();
    });

    it('calls onTransactionUpdate after successful status cycle', async () => {
      const { transactionsApi } = await import('@/lib/transactions');
      const mockOnTransactionUpdate = vi.fn();
      const tx = createTransaction({ status: TransactionStatus.UNRECONCILED });
      const updatedTx = { ...tx, status: TransactionStatus.CLEARED };
      vi.mocked(transactionsApi.updateStatus).mockResolvedValueOnce(updatedTx);

      render(
        <TransactionList
          transactions={[tx]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
          onTransactionUpdate={mockOnTransactionUpdate}
        />
      );

      const statusButton = screen.getByTitle('Click to cycle status');
      fireEvent.click(statusButton);

      await waitFor(() => {
        expect(mockOnTransactionUpdate).toHaveBeenCalledWith(updatedTx);
      });
    });

    it('calls onRefresh when onTransactionUpdate is not provided', async () => {
      const { transactionsApi } = await import('@/lib/transactions');
      const tx = createTransaction({ status: TransactionStatus.UNRECONCILED });
      const updatedTx = { ...tx, status: TransactionStatus.CLEARED };
      vi.mocked(transactionsApi.updateStatus).mockResolvedValueOnce(updatedTx);

      render(
        <TransactionList
          transactions={[tx]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
        />
      );

      const statusButton = screen.getByTitle('Click to cycle status');
      fireEvent.click(statusButton);

      await waitFor(() => {
        expect(mockOnRefresh).toHaveBeenCalled();
      });
    });
  });

  // =========================================================================
  // Delete confirmation and execution
  // =========================================================================

  describe('delete confirmation flow', () => {
    it('shows delete confirmation dialog with correct message for regular transaction', async () => {
      const tx = createTransaction();

      render(
        <TransactionList
          transactions={[tx]}
          onEdit={mockOnEdit}
          onDelete={mockOnDelete}
          onRefresh={mockOnRefresh}
        />
      );

      fireEvent.click(screen.getByText('Delete'));

      await waitFor(() => {
        expect(screen.getByText('Delete Transaction')).toBeInTheDocument();
        expect(screen.getByText(/This action cannot be undone/)).toBeInTheDocument();
      });
    });

    it('shows delete confirmation dialog with transfer-specific message', async () => {
      const transferTx = createTransaction({
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
          transactions={[transferTx]}
          onEdit={mockOnEdit}
          onDelete={mockOnDelete}
          onRefresh={mockOnRefresh}
        />
      );

      fireEvent.click(screen.getByText('Delete'));

      await waitFor(() => {
        expect(screen.getByText('Delete Transfer')).toBeInTheDocument();
        expect(screen.getByText(/Both linked transactions will be deleted/)).toBeInTheDocument();
      });
    });

    it('deletes transaction when confirm is clicked', async () => {
      const { transactionsApi } = await import('@/lib/transactions');
      vi.mocked(transactionsApi.delete).mockResolvedValueOnce(undefined);

      const tx = createTransaction();

      render(
        <TransactionList
          transactions={[tx]}
          onEdit={mockOnEdit}
          onDelete={mockOnDelete}
          onRefresh={mockOnRefresh}
        />
      );

      // Open confirm dialog
      fireEvent.click(screen.getByText('Delete'));

      // Click the confirmation button (the red "Delete" button in the dialog)
      const confirmButtons = screen.getAllByText('Delete');
      // Find the confirm button in the dialog (last one)
      const confirmButton = confirmButtons[confirmButtons.length - 1];
      fireEvent.click(confirmButton);

      await waitFor(() => {
        expect(transactionsApi.delete).toHaveBeenCalledWith(tx.id);
      });
    });

    it('deletes transfer when confirm is clicked for transfer transaction', async () => {
      const { transactionsApi } = await import('@/lib/transactions');
      vi.mocked(transactionsApi.deleteTransfer).mockResolvedValueOnce(undefined);

      const transferTx = createTransaction({
        isTransfer: true,
        linkedTransactionId: 'linked-tx-1',
        categoryId: null,
        category: null,
      });

      render(
        <TransactionList
          transactions={[transferTx]}
          onEdit={mockOnEdit}
          onDelete={mockOnDelete}
          onRefresh={mockOnRefresh}
        />
      );

      fireEvent.click(screen.getByText('Delete'));

      const confirmButtons = screen.getAllByText('Delete');
      const confirmButton = confirmButtons[confirmButtons.length - 1];
      fireEvent.click(confirmButton);

      await waitFor(() => {
        expect(transactionsApi.deleteTransfer).toHaveBeenCalledWith(transferTx.id);
      });
    });

    it('closes confirm dialog when Cancel is clicked', async () => {
      const tx = createTransaction();

      render(
        <TransactionList
          transactions={[tx]}
          onEdit={mockOnEdit}
          onDelete={mockOnDelete}
          onRefresh={mockOnRefresh}
        />
      );

      fireEvent.click(screen.getByText('Delete'));
      await waitFor(() => {
        expect(screen.getByText('Delete Transaction')).toBeInTheDocument();
      });

      // Click Cancel in the dialog
      fireEvent.click(screen.getByText('Cancel'));

      // Dialog should close (the title should no longer be visible)
      await waitFor(() => {
        expect(screen.queryByText('Delete Transaction')).not.toBeInTheDocument();
      });
    });

    it('calls onDelete and onRefresh after successful deletion', async () => {
      const { transactionsApi } = await import('@/lib/transactions');
      vi.mocked(transactionsApi.delete).mockResolvedValueOnce(undefined);

      const tx = createTransaction();

      render(
        <TransactionList
          transactions={[tx]}
          onEdit={mockOnEdit}
          onDelete={mockOnDelete}
          onRefresh={mockOnRefresh}
        />
      );

      fireEvent.click(screen.getByText('Delete'));

      const confirmButtons = screen.getAllByText('Delete');
      const confirmButton = confirmButtons[confirmButtons.length - 1];
      fireEvent.click(confirmButton);

      await waitFor(() => {
        expect(mockOnDelete).toHaveBeenCalledWith(tx.id);
        expect(mockOnRefresh).toHaveBeenCalled();
      });
    });
  });

  // =========================================================================
  // Amount formatting
  // =========================================================================

  describe('amount formatting', () => {
    it('formats negative amounts with minus sign and red color', async () => {
      const tx = createTransaction({ amount: -75.50 });

      render(
        <TransactionList
          transactions={[tx]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
        />
      );

      await waitFor(() => {
        const amountEl = screen.getByText('-$75.50');
        expect(amountEl).toHaveClass('text-red-600');
      });
    });

    it('formats positive amounts with plus sign and green color', async () => {
      const tx = createTransaction({
        id: 'income-tx',
        amount: 250.00,
        payeeName: 'Income Source',
      });

      render(
        <TransactionList
          transactions={[tx]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
        />
      );

      await waitFor(() => {
        const amountEl = screen.getByText('+$250.00');
        expect(amountEl).toHaveClass('text-green-600');
      });
    });

    it('formats zero amounts', async () => {
      const tx = createTransaction({
        id: 'zero-tx',
        amount: 0,
        payeeName: 'Zero Amount',
      });

      render(
        <TransactionList
          transactions={[tx]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
        />
      );

      await waitFor(() => {
        const amountEl = screen.getByText('+$0.00');
        expect(amountEl).toHaveClass('text-green-600');
      });
    });
  });

  // =========================================================================
  // Running balance calculation
  // =========================================================================

  describe('running balance calculation', () => {
    it('calculates running balances correctly for multiple transactions', async () => {
      const transactions = [
        createTransaction({ id: 'tx-1', amount: -100, payeeName: 'First' }),
        createTransaction({ id: 'tx-2', amount: -50, payeeName: 'Second' }),
        createTransaction({ id: 'tx-3', amount: 200, payeeName: 'Third' }),
      ];

      render(
        <TransactionList
          transactions={transactions}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
          isSingleAccountView={true}
          startingBalance={500}
        />
      );

      await waitFor(() => {
        // First tx: balance = 500 (startingBalance)
        // Second tx: balance = 500 - (-100) = 600
        // Third tx: balance = 500 - (-100) - (-50) = 650
        expect(screen.getByText('$500.00')).toBeInTheDocument();
        expect(screen.getByText('$600.00')).toBeInTheDocument();
        expect(screen.getByText('$650.00')).toBeInTheDocument();
      });
    });

    it('does not show running balance when isSingleAccountView is false', async () => {
      const tx = createTransaction({ amount: -50 });

      render(
        <TransactionList
          transactions={[tx]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
          isSingleAccountView={false}
          startingBalance={1000}
        />
      );

      await waitFor(() => {
        expect(screen.queryByText('Balance')).not.toBeInTheDocument();
      });
    });

    it('shows negative balances in red', async () => {
      const tx = createTransaction({ amount: 100, payeeName: 'Test' });

      render(
        <TransactionList
          transactions={[tx]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
          isSingleAccountView={true}
          startingBalance={-50}
        />
      );

      await waitFor(() => {
        // Balance of -50 should be rendered as "-$50.00" in red
        const balanceEl = screen.getByText('-$50.00');
        expect(balanceEl).toHaveClass('text-red-600');
      });
    });
  });

  // =========================================================================
  // Density toggle with controlled prop
  // =========================================================================

  describe('density with controlled prop', () => {
    it('uses propDensity when provided', async () => {
      render(
        <TransactionList
          transactions={[createTransaction()]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
          density="compact"
        />
      );

      await waitFor(() => {
        const densityButton = screen.getByTitle('Toggle row density');
        expect(densityButton).toHaveTextContent('Compact');
      });
    });

    it('calls onDensityChange when density toggle is clicked', async () => {
      const mockOnDensityChange = vi.fn();

      render(
        <TransactionList
          transactions={[createTransaction()]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
          density="normal"
          onDensityChange={mockOnDensityChange}
        />
      );

      const densityButton = screen.getByTitle('Toggle row density');
      fireEvent.click(densityButton);

      await waitFor(() => {
        expect(mockOnDensityChange).toHaveBeenCalledWith('compact');
      });
    });

    it('cycles from compact to dense via onDensityChange', async () => {
      const mockOnDensityChange = vi.fn();

      render(
        <TransactionList
          transactions={[createTransaction()]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
          density="compact"
          onDensityChange={mockOnDensityChange}
        />
      );

      const densityButton = screen.getByTitle('Toggle row density');
      fireEvent.click(densityButton);

      await waitFor(() => {
        expect(mockOnDensityChange).toHaveBeenCalledWith('dense');
      });
    });

    it('cycles from dense back to normal via onDensityChange', async () => {
      const mockOnDensityChange = vi.fn();

      render(
        <TransactionList
          transactions={[createTransaction()]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
          density="dense"
          onDensityChange={mockOnDensityChange}
        />
      );

      const densityButton = screen.getByTitle('Toggle row density');
      fireEvent.click(densityButton);

      await waitFor(() => {
        expect(mockOnDensityChange).toHaveBeenCalledWith('normal');
      });
    });
  });

  // =========================================================================
  // Payee click interaction
  // =========================================================================

  describe('payee click', () => {
    it('calls onPayeeClick when payee name is clicked', async () => {
      const mockOnPayeeClick = vi.fn();
      const tx = createTransaction();

      render(
        <TransactionList
          transactions={[tx]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
          onPayeeClick={mockOnPayeeClick}
        />
      );

      const payeeButton = screen.getByTitle('Edit payee: Grocery Store');
      fireEvent.click(payeeButton);

      await waitFor(() => {
        expect(mockOnPayeeClick).toHaveBeenCalledWith('payee-1');
      });
    });

    it('renders payee as plain text when onPayeeClick is not provided', async () => {
      const tx = createTransaction();

      render(
        <TransactionList
          transactions={[tx]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
        />
      );

      await waitFor(() => {
        // Should show payee name as a div (non-clickable)
        const payeeEl = screen.getByText('Grocery Store');
        expect(payeeEl.tagName).toBe('DIV');
      });
    });

    it('shows dash when payee name is null', async () => {
      const tx = createTransaction({ payeeName: null, payeeId: null });

      render(
        <TransactionList
          transactions={[tx]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
        />
      );

      await waitFor(() => {
        // Should have at least one dash for the payee
        const dashes = screen.getAllByText('-');
        expect(dashes.length).toBeGreaterThanOrEqual(1);
      });
    });
  });

  // =========================================================================
  // Transfer click interaction
  // =========================================================================

  describe('transfer click', () => {
    it('calls onTransferClick when transfer badge is clicked', async () => {
      const mockOnTransferClick = vi.fn();
      const transferTx = createTransaction({
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
          transactions={[transferTx]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
          onTransferClick={mockOnTransferClick}
        />
      );

      const transferButton = screen.getByTitle('Click to view in Savings');
      fireEvent.click(transferButton);

      await waitFor(() => {
        expect(mockOnTransferClick).toHaveBeenCalledWith('acc-2', 'linked-tx-1');
      });
    });

    it('shows transfer badge as non-clickable span when onTransferClick is not provided', async () => {
      const transferTx = createTransaction({
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
          transactions={[transferTx]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
        />
      );

      await waitFor(() => {
        // Should show as span (not button) since no onTransferClick
        const transferSpan = screen.getByText(/Savings/);
        expect(transferSpan.tagName).toBe('SPAN');
      });
    });

    it('shows arrow direction based on amount sign for outgoing transfer', async () => {
      const transferTx = createTransaction({
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
          transactions={[transferTx]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
        />
      );

      await waitFor(() => {
        // Negative amount means outgoing: arrow points right
        expect(screen.getByText(/→ Savings/)).toBeInTheDocument();
      });
    });

    it('shows arrow direction based on amount sign for incoming transfer', async () => {
      const transferTx = createTransaction({
        isTransfer: true,
        linkedTransactionId: 'linked-tx-1',
        linkedTransaction: {
          id: 'linked-tx-1',
          account: { id: 'acc-2', name: 'Savings' },
        } as any,
        amount: 200,
        categoryId: null,
        category: null,
      });

      render(
        <TransactionList
          transactions={[transferTx]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
        />
      );

      await waitFor(() => {
        // Positive amount means incoming: arrow points away from source
        expect(screen.getByText(/Savings →/)).toBeInTheDocument();
      });
    });
  });

  // =========================================================================
  // Split transaction display
  // =========================================================================

  describe('split transaction display', () => {
    it('shows split count in badge', async () => {
      const splitTx = createTransaction({
        isSplit: true,
        categoryId: null,
        category: null,
        splits: [
          { id: 's1', transactionId: 'tx-1', categoryId: 'cat-1', category: { id: 'cat-1', name: 'Groceries' } as any, transferAccountId: null, transferAccount: null, linkedTransactionId: null, amount: -30, memo: null, createdAt: '' },
          { id: 's2', transactionId: 'tx-1', categoryId: 'cat-2', category: { id: 'cat-2', name: 'Dining' } as any, transferAccountId: null, transferAccount: null, linkedTransactionId: null, amount: -20, memo: null, createdAt: '' },
          { id: 's3', transactionId: 'tx-1', categoryId: 'cat-1', category: { id: 'cat-1', name: 'Groceries' } as any, transferAccountId: null, transferAccount: null, linkedTransactionId: null, amount: -10, memo: null, createdAt: '' },
        ],
      });

      render(
        <TransactionList
          transactions={[splitTx]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Split (3)')).toBeInTheDocument();
      });
    });

    it('shows split details in normal density with category names and amounts', async () => {
      const splitTx = createTransaction({
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
          transactions={[splitTx]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
        />
      );

      await waitFor(() => {
        // In normal density, split details are shown
        expect(screen.getByText(/Groceries.*30\.00/)).toBeInTheDocument();
        expect(screen.getByText(/Dining.*20\.00/)).toBeInTheDocument();
      });
    });

    it('shows "+N more" indicator when more than 3 splits', async () => {
      const splitTx = createTransaction({
        isSplit: true,
        categoryId: null,
        category: null,
        splits: [
          { id: 's1', transactionId: 'tx-1', categoryId: 'cat-1', category: { id: 'cat-1', name: 'Groceries' } as any, transferAccountId: null, transferAccount: null, linkedTransactionId: null, amount: -30, memo: null, createdAt: '' },
          { id: 's2', transactionId: 'tx-1', categoryId: 'cat-2', category: { id: 'cat-2', name: 'Dining' } as any, transferAccountId: null, transferAccount: null, linkedTransactionId: null, amount: -20, memo: null, createdAt: '' },
          { id: 's3', transactionId: 'tx-1', categoryId: 'cat-3', category: { id: 'cat-3', name: 'Transport' } as any, transferAccountId: null, transferAccount: null, linkedTransactionId: null, amount: -15, memo: null, createdAt: '' },
          { id: 's4', transactionId: 'tx-1', categoryId: 'cat-4', category: { id: 'cat-4', name: 'Utilities' } as any, transferAccountId: null, transferAccount: null, linkedTransactionId: null, amount: -10, memo: null, createdAt: '' },
        ],
      });

      render(
        <TransactionList
          transactions={[splitTx]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('+1 more')).toBeInTheDocument();
      });
    });

    it('shows transfer account name for split transfers', async () => {
      const splitTx = createTransaction({
        isSplit: true,
        categoryId: null,
        category: null,
        splits: [
          {
            id: 's1',
            transactionId: 'tx-1',
            categoryId: null,
            category: null,
            transferAccountId: 'acc-2',
            transferAccount: { id: 'acc-2', name: 'Savings' } as any,
            linkedTransactionId: 'linked-split-1',
            amount: -30,
            memo: null,
            createdAt: '',
          },
        ],
      });

      render(
        <TransactionList
          transactions={[splitTx]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
        />
      );

      await waitFor(() => {
        expect(screen.getByText(/Savings/)).toBeInTheDocument();
      });
    });

    it('shows "Uncategorized" for splits without category', async () => {
      const splitTx = createTransaction({
        isSplit: true,
        categoryId: null,
        category: null,
        splits: [
          { id: 's1', transactionId: 'tx-1', categoryId: null, category: null, transferAccountId: null, transferAccount: null, linkedTransactionId: null, amount: -30, memo: null, createdAt: '' },
        ],
      });

      render(
        <TransactionList
          transactions={[splitTx]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
        />
      );

      await waitFor(() => {
        expect(screen.getByText(/Uncategorized/)).toBeInTheDocument();
      });
    });
  });

  // =========================================================================
  // Investment transaction indicator
  // =========================================================================

  describe('investment transaction', () => {
    it('shows Investment badge for linked investment transactions', async () => {
      const investmentTx = createTransaction({
        linkedInvestmentTransactionId: 'inv-tx-1',
        categoryId: null,
        category: null,
      });

      render(
        <TransactionList
          transactions={[investmentTx]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Investment')).toBeInTheDocument();
      });
    });

    it('shows "View" button instead of "Edit" for investment transactions', async () => {
      const investmentTx = createTransaction({
        linkedInvestmentTransactionId: 'inv-tx-1',
      });

      render(
        <TransactionList
          transactions={[investmentTx]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('View')).toBeInTheDocument();
        expect(screen.queryByText('Edit')).not.toBeInTheDocument();
      });
    });

    it('hides delete button for investment transactions', async () => {
      const investmentTx = createTransaction({
        linkedInvestmentTransactionId: 'inv-tx-1',
      });

      render(
        <TransactionList
          transactions={[investmentTx]}
          onEdit={mockOnEdit}
          onDelete={mockOnDelete}
          onRefresh={mockOnRefresh}
        />
      );

      await waitFor(() => {
        // Delete button should not be present for investment transactions
        expect(screen.queryByText('Delete')).not.toBeInTheDocument();
      });
    });
  });

  // =========================================================================
  // Row click behavior
  // =========================================================================

  describe('row click', () => {
    it('calls onEdit when row is clicked', async () => {
      const tx = createTransaction();

      render(
        <TransactionList
          transactions={[tx]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
        />
      );

      const row = screen.getByText('Grocery Store').closest('tr')!;
      fireEvent.click(row);

      await waitFor(() => {
        expect(mockOnEdit).toHaveBeenCalledWith(tx);
      });
    });

    it('does not call onEdit when onEdit is not provided', async () => {
      const tx = createTransaction();

      render(
        <TransactionList
          transactions={[tx]}
          onRefresh={mockOnRefresh}
        />
      );

      const row = screen.getByText('Grocery Store').closest('tr')!;
      fireEvent.click(row);

      await waitFor(() => {
        // No error should be thrown, and onEdit should not have been called
        expect(mockOnEdit).not.toHaveBeenCalled();
      });
    });
  });

  // =========================================================================
  // Void transaction styling
  // =========================================================================

  describe('void transaction styling', () => {
    it('applies opacity-50 to void transaction rows', async () => {
      const tx = createTransaction({ status: TransactionStatus.VOID, isVoid: true });

      render(
        <TransactionList
          transactions={[tx]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
        />
      );

      await waitFor(() => {
        const row = screen.getByText('Grocery Store').closest('tr');
        expect(row).toHaveClass('opacity-50');
      });
    });

    it('applies line-through to void transaction text', async () => {
      const tx = createTransaction({ status: TransactionStatus.VOID, isVoid: true });

      render(
        <TransactionList
          transactions={[tx]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
        />
      );

      await waitFor(() => {
        // The date cell should have line-through
        const dateCell = screen.getByText('2024-01-15');
        expect(dateCell).toHaveClass('line-through');
      });
    });

    it('does not apply void styling to non-void transactions', async () => {
      const tx = createTransaction({ status: TransactionStatus.CLEARED });

      render(
        <TransactionList
          transactions={[tx]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
        />
      );

      await waitFor(() => {
        const row = screen.getByText('Grocery Store').closest('tr');
        expect(row).not.toHaveClass('opacity-50');
      });
    });
  });

  // =========================================================================
  // No category display
  // =========================================================================

  describe('no category', () => {
    it('shows dash when category is null', async () => {
      const tx = createTransaction({ categoryId: null, category: null });

      render(
        <TransactionList
          transactions={[tx]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
        />
      );

      await waitFor(() => {
        // There should be dash elements for the missing category
        const dashes = screen.getAllByText('-');
        expect(dashes.length).toBeGreaterThanOrEqual(1);
      });
    });
  });

  // =========================================================================
  // Multiple transactions rendering
  // =========================================================================

  describe('multiple transactions', () => {
    it('renders all transactions in order', async () => {
      const transactions = [
        createTransaction({ id: 'tx-1', payeeName: 'First Payee' }),
        createTransaction({ id: 'tx-2', payeeName: 'Second Payee' }),
        createTransaction({ id: 'tx-3', payeeName: 'Third Payee' }),
      ];

      render(
        <TransactionList
          transactions={transactions}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('First Payee')).toBeInTheDocument();
        expect(screen.getByText('Second Payee')).toBeInTheDocument();
        expect(screen.getByText('Third Payee')).toBeInTheDocument();
      });
    });

    it('applies alternating row colors in compact density', async () => {
      const transactions = [
        createTransaction({ id: 'tx-1', payeeName: 'First' }),
        createTransaction({ id: 'tx-2', payeeName: 'Second' }),
      ];

      render(
        <TransactionList
          transactions={transactions}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
          density="compact"
        />
      );

      await waitFor(() => {
        const firstRow = screen.getByText('First').closest('tr');
        const secondRow = screen.getByText('Second').closest('tr');

        // Odd index rows (1-based index 2 = 0-based index 1) should have bg-gray-50
        expect(firstRow).not.toHaveClass('bg-gray-50');
        expect(secondRow).toHaveClass('bg-gray-50');
      });
    });
  });

  // =========================================================================
  // Edit button when onEdit is not provided
  // =========================================================================

  describe('edit button visibility', () => {
    it('does not render Edit button when onEdit is not provided', async () => {
      render(
        <TransactionList
          transactions={[createTransaction()]}
          onRefresh={mockOnRefresh}
        />
      );

      await waitFor(() => {
        expect(screen.queryByText('Edit')).not.toBeInTheDocument();
      });
    });

    it('renders Edit button when onEdit is provided', async () => {
      render(
        <TransactionList
          transactions={[createTransaction()]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Edit')).toBeInTheDocument();
      });
    });
  });
});
