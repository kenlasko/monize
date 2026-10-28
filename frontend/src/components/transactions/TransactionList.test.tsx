import { accrualsApi } from '@/lib/accruals';
vi.mock('@/lib/accruals', async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/accruals')>()), accrualsApi: { sources: vi.fn().mockResolvedValue([]) } }));
import { useAuthStore } from '@/store/authStore';
import { useDemoStore } from '@/store/demoStore';
import type { User } from '@/types/auth';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, cleanup } from '@/test/render';
import { TransactionList } from './TransactionList';
import { Transaction, TransactionStatus } from '@/types/transaction';
import { useDensityStore } from '@/store/densityStore';
import { useDateDisplayStore } from '@/store/dateDisplayStore';
import { REGISTER_PAYEE_CELL_FLOOR } from './register-columns';
import { usePreferencesStore } from '@/store/preferencesStore';
import { useHiddenColumnsStore } from '@/store/hiddenColumnsStore';
import toast from 'react-hot-toast';

vi.mock('@/lib/transactions', () => ({
  transactionsApi: {
    delete: vi.fn(),
    deleteTransfer: vi.fn(),
    updateStatus: vi.fn(),
  },
}));

vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({ dateFormat: 'browser', datePattern: 'YYYY-MM-DD',
    formatDate: (d: string) => d,
    // Stands in for the real helper, which drops the year through the user's
    // own pattern; under YYYY-MM-DD that leaves MM-DD.
    formatDateWithoutYear: (d: Date | string) => String(d).slice(5),
  }),
}));

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrency: (n: number) => `$${n.toFixed(2)}`,
    }),
  };
});
// Whether a row is still to come is a financial decision, so the register asks
// the user's own calendar rather than the browser's. Pinned here so these tests
// do not drift with the machine's clock; one test drives it directly.
const mockFinancialToday = vi.fn(() => '2026-01-01');
vi.mock('@/hooks/useFinancialToday', () => ({
  useFinancialToday: () => mockFinancialToday(),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

// The account preference write. Toggling a column saves to this browser only
// (`useHiddenColumnsStore`), so the hidden-column tests assert it is never called.
const mockUpdatePreferences = vi.fn();
vi.mock('@/lib/user-settings', () => ({
  userSettingsApi: {
    updatePreferences: (...args: unknown[]) => mockUpdatePreferences(...args),
  },
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
    originalAmount: null,
    originalCurrencyCode: null,
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
        onDeleted={mockOnDelete}
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
        onDeleted={mockOnDelete}
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
        onDeleted={mockOnDelete}
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

  it('shows action sheet immediately on right-click', async () => {
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

    const row = screen.getByText('Grocery Store').closest('tr')!;
    fireEvent.contextMenu(row);

    await waitFor(() => {
      expect(screen.getByText(/Filter by.*Groceries/)).toBeInTheDocument();
    });
  });

  it('does not invoke onEdit on right-click followed by click', async () => {
    const transaction = createTransaction();

    render(
      <TransactionList
        transactions={[transaction]}
        onEdit={mockOnEdit}
        onRefresh={mockOnRefresh}
      />
    );

    const row = screen.getByText('Grocery Store').closest('tr')!;
    fireEvent.contextMenu(row);
    fireEvent.click(row);

    expect(mockOnEdit).not.toHaveBeenCalled();
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

  describe('touch long-press handling', () => {
    it('opens the action sheet on a touch long-press', async () => {
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
      fireEvent.touchStart(row, { touches: [{ clientX: 10, clientY: 10 }] });
      await act(async () => { vi.advanceTimersByTime(800); });
      vi.useRealTimers();

      await waitFor(() => {
        expect(screen.getByText(/Filter by.*Groceries/)).toBeInTheDocument();
      });
    });

    it('cancels the long-press when the finger moves beyond the threshold', async () => {
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
      fireEvent.touchStart(row, { touches: [{ clientX: 10, clientY: 10 }] });
      // Move beyond the 10px threshold to cancel the pending long-press
      fireEvent.touchMove(row, { touches: [{ clientX: 100, clientY: 100 }] });
      await act(async () => { vi.advanceTimersByTime(800); });
      vi.useRealTimers();

      // Action sheet should NOT have opened
      expect(screen.queryByText(/Filter by.*Groceries/)).not.toBeInTheDocument();
    });

    it('cancels the long-press on touch end before the threshold', async () => {
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
      fireEvent.touchStart(row, { touches: [{ clientX: 10, clientY: 10 }] });
      fireEvent.touchEnd(row);
      await act(async () => { vi.advanceTimersByTime(800); });
      vi.useRealTimers();

      expect(screen.queryByText(/Filter by.*Groceries/)).not.toBeInTheDocument();
    });

    it('handles a touch start with no touch point gracefully', async () => {
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
      // touchStart with empty touches array -> touchStartPos stays null
      fireEvent.touchStart(row, { touches: [] });
      await act(async () => { vi.advanceTimersByTime(800); });
      vi.useRealTimers();

      // Long-press timer still fires and opens the sheet
      await waitFor(() => {
        expect(screen.getByText(/Filter by.*Groceries/)).toBeInTheDocument();
      });
    });

    it('ignores a non-primary mouse button on long-press start', async () => {
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
      // Right mouse button (button=2) should not start the long-press timer
      fireEvent.mouseDown(row, { button: 2 });
      await act(async () => { vi.advanceTimersByTime(800); });
      vi.useRealTimers();

      expect(screen.queryByText(/Filter by.*Groceries/)).not.toBeInTheDocument();
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
        expect(screen.getByLabelText('Attachments')).toBeInTheDocument();
      });
    });

    it('renders the attachment count for a transaction that has attachments', async () => {
      render(
        <TransactionList
          transactions={[createTransaction({ id: 'tx-att', attachmentCount: 4 })]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('4')).toBeInTheDocument();
      });
    });

    it('omits the Account column entirely in a single-account view', async () => {
      // Structural, not responsive: on a single account's page every row
      // would repeat the page's own title, so neither the header nor the
      // cells exist at any width (register-columns.ts).
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
        expect(screen.getByText('Grocery Store')).toBeInTheDocument();
      });
      expect(screen.queryByText('Account')).not.toBeInTheDocument();
      expect(screen.queryByText('Chequing')).not.toBeInTheDocument();
    });

    it('renders the Account column for a multi-account view', async () => {
      render(
        <TransactionList
          transactions={[createTransaction()]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Account')).toBeInTheDocument();
        expect(screen.getByText('Chequing')).toBeInTheDocument();
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

    it('displays the reference number once, in the Ref # column, not under the payee', async () => {
      const tx = createTransaction({ referenceNumber: 'CHQ-12345' });

      render(
        <TransactionList
          transactions={[tx]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
        />
      );

      await waitFor(() => {
        expect(screen.getAllByText('CHQ-12345')).toHaveLength(1);
      });
      expect(screen.queryByText('Ref: CHQ-12345')).not.toBeInTheDocument();
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

      useDensityStore.setState({ densities: { transactions: 'dense' } });
      render(
        <TransactionList
          transactions={[tx]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('C')).toBeInTheDocument();
      });
    });

    it('shows abbreviated R for reconciled in dense mode', async () => {
      const tx = createTransaction({ status: TransactionStatus.RECONCILED });

      useDensityStore.setState({ densities: { transactions: 'dense' } });
      render(
        <TransactionList
          transactions={[tx]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('R')).toBeInTheDocument();
      });
    });

    it('shows abbreviated V for void in dense mode', async () => {
      const tx = createTransaction({ status: TransactionStatus.VOID, isVoid: true });

      useDensityStore.setState({ densities: { transactions: 'dense' } });
      render(
        <TransactionList
          transactions={[tx]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
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

    /**
     * With "Lock reconciled transactions" on, a reconcile from this register is
     * the last freely reversible click on the row: the server allows the undo
     * for a few seconds and refuses it afterwards. The toast is the only place
     * the user is told that, so it is worth a test -- a window nobody is told
     * about is a trap with a timer on it.
     */
    describe('the undo window for a locked reconcile', () => {
      const reconcileFrom = async (locked: boolean) => {
        usePreferencesStore.setState({
          preferences: { lockReconciledTransactions: locked } as any,
        });
        const { transactionsApi } = await import('@/lib/transactions');
        const tx = createTransaction({ status: TransactionStatus.CLEARED });
        vi.mocked(transactionsApi.updateStatus).mockResolvedValueOnce({
          ...tx,
          status: TransactionStatus.RECONCILED,
        });

        render(
          <TransactionList
            transactions={[tx]}
            onEdit={mockOnEdit}
            onRefresh={mockOnRefresh}
          />,
        );
        fireEvent.click(screen.getByTitle('Click to cycle status'));
        await waitFor(() => {
          expect(transactionsApi.updateStatus).toHaveBeenCalledWith(
            tx.id,
            TransactionStatus.RECONCILED,
          );
        });
      };

      afterEach(() => {
        // `cleanup()` first: vitest runs after-hooks in reverse registration
        // order, so a store write here would re-render the still-mounted tree
        // outside act. `src/test/test-hygiene.test.ts` is the rule.
        cleanup();
        usePreferencesStore.setState({ preferences: null });
      });

      it('says how long the reconcile can still be taken back', async () => {
        await reconcileFrom(true);
        expect(toast.success).toHaveBeenCalledWith(
          expect.stringContaining('press again within 10 seconds to undo'),
        );
      });

      it('says nothing about a window when the lock is off', async () => {
        await reconcileFrom(false);
        expect(toast.success).toHaveBeenCalledWith('Status changed to Reconciled');
      });

      // The window belongs to a reconcile. Cycling to cleared is reversible for
      // as long as the user likes, and saying otherwise would invent a deadline.
      it('says nothing about a window on the other statuses', async () => {
        usePreferencesStore.setState({
          preferences: { lockReconciledTransactions: true } as any,
        });
        const { transactionsApi } = await import('@/lib/transactions');
        const tx = createTransaction({ status: TransactionStatus.UNRECONCILED });
        vi.mocked(transactionsApi.updateStatus).mockResolvedValueOnce({
          ...tx,
          status: TransactionStatus.CLEARED,
        });

        render(
          <TransactionList
            transactions={[tx]}
            onEdit={mockOnEdit}
            onRefresh={mockOnRefresh}
          />,
        );
        fireEvent.click(screen.getByTitle('Click to cycle status'));
        await waitFor(() => {
          expect(toast.success).toHaveBeenCalledWith('Status changed to Cleared');
        });
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

    it('preserves list-only enrichment fields when cycling status', async () => {
      const { transactionsApi } = await import('@/lib/transactions');
      const mockOnTransactionUpdate = vi.fn();
      const tx = createTransaction({
        status: TransactionStatus.UNRECONCILED,
        attachmentCount: 3,
        linkedInvestmentTransactionId: 'inv-1',
      });
      // The status endpoint returns the plain transaction, without the
      // attachment count / investment link the list query adds.
      const updatedTx = createTransaction({ status: TransactionStatus.CLEARED });
      vi.mocked(transactionsApi.updateStatus).mockResolvedValueOnce(updatedTx);

      render(
        <TransactionList
          transactions={[tx]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
          onTransactionUpdate={mockOnTransactionUpdate}
        />
      );

      fireEvent.click(screen.getByTitle('Click to cycle status'));

      await waitFor(() => {
        expect(mockOnTransactionUpdate).toHaveBeenCalledWith({
          ...updatedTx,
          attachmentCount: 3,
          linkedInvestmentTransactionId: 'inv-1',
        });
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
          onDeleted={mockOnDelete}
          onRefresh={mockOnRefresh}
        />
      );

      fireEvent.click(screen.getByText('Delete'));

      await waitFor(() => {
        expect(screen.getByText('Delete Transaction')).toBeInTheDocument();
        expect(screen.getByText(/This action cannot be undone/)).toBeInTheDocument();
      });
    });

    it('adds a reconciled warning to the delete dialog for a reconciled transaction', async () => {
      const tx = createTransaction({ status: TransactionStatus.RECONCILED });

      render(
        <TransactionList
          transactions={[tx]}
          onEdit={mockOnEdit}
          onDeleted={mockOnDelete}
          onRefresh={mockOnRefresh}
        />
      );

      fireEvent.click(screen.getByText('Delete'));

      await waitFor(() => {
        expect(
          screen.getByText(/will affect a completed reconciliation/i),
        ).toBeInTheDocument();
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
          onDeleted={mockOnDelete}
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
          onDeleted={mockOnDelete}
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
          onDeleted={mockOnDelete}
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
          onDeleted={mockOnDelete}
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

    it('calls onDeleted and onRefresh after successful deletion', async () => {
      const { transactionsApi } = await import('@/lib/transactions');
      vi.mocked(transactionsApi.delete).mockResolvedValueOnce(undefined);

      const tx = createTransaction();

      render(
        <TransactionList
          transactions={[tx]}
          onEdit={mockOnEdit}
          onDeleted={mockOnDelete}
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

    it('shows running balance when isSingleAccountView is false but startingBalance is provided', async () => {
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
        expect(screen.getByText('Balance')).toBeInTheDocument();
      });
    });

    it('does not show running balance when isSingleAccountView is false and no startingBalance', async () => {
      const tx = createTransaction({ amount: -50 });

      render(
        <TransactionList
          transactions={[tx]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
          isSingleAccountView={false}
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

    it('resolves running balance to exactly $0.00 when floating-point drift would produce epsilon', async () => {
      // 0.1 + 0.2 = 0.30000000000000004 in JS — naive subtraction from 0.3
      // would produce -5.5e-17 instead of 0, breaking roundToDecimals.
      // Integer arithmetic (x10000) should produce exactly 0.
      const transactions = [
        createTransaction({ id: 'tx-1', amount: 0.1, payeeName: 'First' }),
        createTransaction({ id: 'tx-2', amount: 0.2, payeeName: 'Second' }),
        createTransaction({ id: 'tx-3', amount: -0.05, payeeName: 'Third' }),
      ];

      render(
        <TransactionList
          transactions={transactions}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
          isSingleAccountView={true}
          startingBalance={0.3}
        />
      );

      await waitFor(() => {
        // tx-1: balance = 0.3
        // tx-2: balance = 0.3 - 0.1 = 0.2
        // tx-3: balance = 0.3 - (0.1 + 0.2) = 0.0 exactly (not epsilon)
        expect(screen.getByText('$0.00')).toBeInTheDocument();
      });
    });

    it('shows dashes instead of values when startingBalance is NaN', async () => {
      const transactions = [
        createTransaction({ id: 'tx-1', amount: -50, payeeName: 'Test' }),
      ];

      render(
        <TransactionList
          transactions={transactions}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
          isSingleAccountView={true}
          startingBalance={NaN}
        />
      );

      await waitFor(() => {
        // Balance column shows but runningBalances map is empty, so row shows '-'
        expect(screen.getByText('Balance')).toBeInTheDocument();
        // No dollar-formatted balance values should appear in the balance cells
        const balanceCells = document.querySelectorAll('td.text-right');
        const balanceTexts = Array.from(balanceCells).map(c => c.textContent);
        expect(balanceTexts).toContain('-');
      });
    });

    it('treats NaN transaction amounts as 0 in running balance', async () => {
      const transactions = [
        createTransaction({ id: 'tx-1', amount: -100, payeeName: 'First' }),
        createTransaction({ id: 'tx-2', amount: NaN as any, payeeName: 'NaN Tx' }),
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
        // tx-1: balance = 500
        // tx-2: balance = 500 - (-100) = 600 (NaN amount from tx-1 would corrupt this without fix)
        expect(screen.getByText('$500.00')).toBeInTheDocument();
        expect(screen.getByText('$600.00')).toBeInTheDocument();
      });
    });
  });

  // =========================================================================
  // Density toggle with controlled prop
  // =========================================================================

  describe('density with controlled prop', () => {
    it('uses propDensity when provided', async () => {
      useDensityStore.setState({ densities: { transactions: 'compact' } });
      render(
        <TransactionList
          transactions={[createTransaction()]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
        />
      );

      await waitFor(() => {
        const densityButton = screen.getByTitle('Toggle row density');
        expect(densityButton).toHaveTextContent('Compact');
      });
    });

    it('cycles the shared preference from normal to compact', async () => {
      useDensityStore.setState({ densities: { transactions: 'normal' } });
      render(
        <TransactionList
          transactions={[createTransaction()]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
        />
      );

      const densityButton = screen.getByTitle('Toggle row density');
      fireEvent.click(densityButton);

      await waitFor(() => {
        expect(useDensityStore.getState().densities.transactions).toBe('compact');
      });
    });

    it('cycles the shared preference from compact to dense', async () => {
      useDensityStore.setState({ densities: { transactions: 'compact' } });
      render(
        <TransactionList
          transactions={[createTransaction()]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
        />
      );

      const densityButton = screen.getByTitle('Toggle row density');
      fireEvent.click(densityButton);

      await waitFor(() => {
        expect(useDensityStore.getState().densities.transactions).toBe('dense');
      });
    });

    it('cycles the shared preference from dense to normal', async () => {
      useDensityStore.setState({ densities: { transactions: 'dense' } });
      render(
        <TransactionList
          transactions={[createTransaction()]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
        />
      );

      const densityButton = screen.getByTitle('Toggle row density');
      fireEvent.click(densityButton);

      await waitFor(() => {
        expect(useDensityStore.getState().densities.transactions).toBe('normal');
      });
    });
  });

  // =========================================================================
  // showToolbar prop
  // =========================================================================

  describe('showToolbar prop', () => {
    it('shows density toolbar by default', async () => {
      render(
        <TransactionList
          transactions={[createTransaction()]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
        />
      );

      await waitFor(() => {
        expect(screen.getByTitle('Toggle row density')).toBeInTheDocument();
      });
    });

    it('hides density toolbar when showToolbar is false', async () => {
      render(
        <TransactionList
          transactions={[createTransaction()]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
          showToolbar={false}
        />
      );

      await waitFor(() => {
        expect(screen.queryByTitle('Toggle row density')).not.toBeInTheDocument();
      });
    });

    it('hides pagination toolbar when showToolbar is false', async () => {
      render(
        <TransactionList
          transactions={[createTransaction()]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
          showToolbar={false}
          currentPage={1}
          totalPages={3}
          totalItems={75}
          pageSize={25}
          onPageChange={vi.fn()}
        />
      );

      await waitFor(() => {
        // The toolbar with pagination should not be present
        expect(screen.queryByTitle('Toggle row density')).not.toBeInTheDocument();
      });
    });

    it('still renders table content when showToolbar is false', async () => {
      const tx = createTransaction();
      render(
        <TransactionList
          transactions={[tx]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
          showToolbar={false}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Grocery Store')).toBeInTheDocument();
        expect(screen.getByText('Date')).toBeInTheDocument();
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

      const payeeButton = screen.getByTitle('View Grocery Store details');
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

    it('shows filtered amount with partial indicator when splits sum differs from transaction amount', async () => {
      const splitTx = createTransaction({
        isSplit: true,
        categoryId: null,
        category: null,
        amount: -200,
        splits: [
          { id: 's1', transactionId: 'tx-1', categoryId: 'cat-1', category: { id: 'cat-1', name: 'Groceries' } as any, transferAccountId: null, transferAccount: null, linkedTransactionId: null, amount: -50, memo: null, createdAt: '' },
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
        // Should show the filtered amount ($50) not the full amount ($200)
        expect(screen.getByText('-$50.00')).toBeInTheDocument();
        // Should show the partial indicator asterisk
        expect(screen.getByText('*')).toBeInTheDocument();
        // Should have tooltip with full amount
        const indicator = screen.getByText('*').closest('span[title]');
        expect(indicator?.getAttribute('title')).toContain('200');
      });
    });

    it('shows full amount when all splits are present', async () => {
      const splitTx = createTransaction({
        isSplit: true,
        categoryId: null,
        category: null,
        amount: -50,
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
        expect(screen.getByText('-$50.00')).toBeInTheDocument();
        // Should NOT show the partial indicator
        expect(screen.queryByText('*')).not.toBeInTheDocument();
      });
    });

    it('uses filtered amount for running balance when splits are partial', async () => {
      const transactions = [
        createTransaction({
          id: 'tx-1',
          isSplit: true,
          categoryId: null,
          category: null,
          amount: -200,
          payeeName: 'Split Store',
          splits: [
            { id: 's1', transactionId: 'tx-1', categoryId: 'cat-1', category: { id: 'cat-1', name: 'Groceries' } as any, transferAccountId: null, transferAccount: null, linkedTransactionId: null, amount: -50, memo: null, createdAt: '' },
          ],
        }),
        createTransaction({
          id: 'tx-2',
          amount: -100,
          payeeName: 'Regular Store',
        }),
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
        // Backend provides split-aware startingBalance (500).
        // First tx: balance = 500
        // Second tx: balance = 500 - (-50) = 550
        expect(screen.getByText('$500.00')).toBeInTheDocument();
        expect(screen.getByText('$550.00')).toBeInTheDocument();
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
          onDeleted={mockOnDelete}
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

      useDensityStore.setState({ densities: { transactions: 'compact' } });
      render(
        <TransactionList
          transactions={transactions}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
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

  // =========================================================================
  // Export button
  // =========================================================================

  describe('export button', () => {
    it('does not render Export button when onExport is not provided', async () => {
      render(
        <TransactionList
          transactions={[createTransaction()]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
        />
      );

      await waitFor(() => {
        expect(screen.queryByTitle('Export transactions to CSV')).not.toBeInTheDocument();
      });
    });

    it('renders Export button when onExport is provided', async () => {
      const mockOnExport = vi.fn();
      render(
        <TransactionList
          transactions={[createTransaction()]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
          onExport={mockOnExport}
        />
      );

      await waitFor(() => {
        expect(screen.getByTitle('Export transactions to CSV')).toBeInTheDocument();
        expect(screen.getByText('Export')).toBeInTheDocument();
      });
    });

    it('calls onExport when Export button is clicked', async () => {
      const mockOnExport = vi.fn();
      render(
        <TransactionList
          transactions={[createTransaction()]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
          onExport={mockOnExport}
        />
      );

      await waitFor(() => {
        expect(screen.getByTitle('Export transactions to CSV')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTitle('Export transactions to CSV'));
      expect(mockOnExport).toHaveBeenCalledTimes(1);
    });

    it('shows Exporting... text when isExporting is true', async () => {
      const mockOnExport = vi.fn();
      render(
        <TransactionList
          transactions={[createTransaction()]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
          onExport={mockOnExport}
          isExporting={true}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Exporting...')).toBeInTheDocument();
      });
    });

    it('disables Export button when isExporting is true', async () => {
      const mockOnExport = vi.fn();
      render(
        <TransactionList
          transactions={[createTransaction()]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
          onExport={mockOnExport}
          isExporting={true}
        />
      );

      await waitFor(() => {
        const exportButton = screen.getByTitle('Export transactions to CSV');
        expect(exportButton).toBeDisabled();
      });
    });

    it('renders Export button to the left of Density button', async () => {
      const mockOnExport = vi.fn();
      render(
        <TransactionList
          transactions={[createTransaction()]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
          onExport={mockOnExport}
        />
      );

      await waitFor(() => {
        const exportButton = screen.getByTitle('Export transactions to CSV');
        const densityButton = screen.getByTitle('Toggle row density');
        const parent = exportButton.parentElement;
        expect(parent).toBe(densityButton.parentElement);

        const children = Array.from(parent!.children);
        const exportIndex = children.indexOf(exportButton);
        const densityIndex = children.indexOf(densityButton);
        expect(exportIndex).toBeLessThan(densityIndex);
      });
    });
  });

  // =========================================================================
  // Duplicate transaction tests
  // =========================================================================

  describe('duplicate transaction', () => {
    it('shows Copy button when onDuplicate is provided', async () => {
      const mockOnDuplicate = vi.fn();
      render(
        <TransactionList
          transactions={[createTransaction()]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
          onDuplicate={mockOnDuplicate}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Copy')).toBeInTheDocument();
      });
    });

    it('does not show Copy button when onDuplicate is not provided', async () => {
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

      expect(screen.queryByText('Copy')).not.toBeInTheDocument();
    });

    it('calls onDuplicate with the transaction when Copy is clicked', async () => {
      const mockOnDuplicate = vi.fn();
      const transaction = createTransaction();

      render(
        <TransactionList
          transactions={[transaction]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
          onDuplicate={mockOnDuplicate}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Copy')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Copy'));

      expect(mockOnDuplicate).toHaveBeenCalledWith(transaction);
    });

    it('does not show Copy button for investment-linked transactions', async () => {
      const mockOnDuplicate = vi.fn();
      const investmentTransaction = createTransaction({
        linkedInvestmentTransactionId: 'inv-tx-1',
      });

      render(
        <TransactionList
          transactions={[investmentTransaction]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
          onDuplicate={mockOnDuplicate}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('View')).toBeInTheDocument();
      });

      expect(screen.queryByText('Copy')).not.toBeInTheDocument();
    });

    it('shows Duplicate option in action sheet when onDuplicate is provided', async () => {
      const mockOnDuplicate = vi.fn();
      const transaction = createTransaction();

      vi.useFakeTimers();

      render(
        <TransactionList
          transactions={[transaction]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
          onDuplicate={mockOnDuplicate}
        />
      );

      const row = screen.getByText('Grocery Store').closest('tr')!;
      fireEvent.mouseDown(row);
      await act(async () => { vi.advanceTimersByTime(800); });
      vi.useRealTimers();

      await waitFor(() => {
        expect(screen.getByText('Duplicate')).toBeInTheDocument();
      });
    });

    it('calls onDuplicate from action sheet and closes it', async () => {
      const mockOnDuplicate = vi.fn();
      const transaction = createTransaction();

      vi.useFakeTimers();

      render(
        <TransactionList
          transactions={[transaction]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
          onDuplicate={mockOnDuplicate}
        />
      );

      const row = screen.getByText('Grocery Store').closest('tr')!;
      fireEvent.mouseDown(row);
      await act(async () => { vi.advanceTimersByTime(800); });
      vi.useRealTimers();

      await waitFor(() => {
        expect(screen.getByText('Duplicate')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Duplicate'));

      expect(mockOnDuplicate).toHaveBeenCalledWith(transaction);
    });

    it('does not show Duplicate in action sheet for investment-linked transactions', async () => {
      const mockOnDuplicate = vi.fn();
      const investmentTransaction = createTransaction({
        linkedInvestmentTransactionId: 'inv-tx-1',
      });

      vi.useFakeTimers();

      render(
        <TransactionList
          transactions={[investmentTransaction]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
          onDuplicate={mockOnDuplicate}
        />
      );

      const row = screen.getByText('Grocery Store').closest('tr')!;
      fireEvent.mouseDown(row);
      await act(async () => { vi.advanceTimersByTime(800); });
      vi.useRealTimers();

      await waitFor(() => {
        // Action sheet opens (Edit button appears in the sheet)
        const editButtons = screen.getAllByText('Edit');
        expect(editButtons.length).toBeGreaterThanOrEqual(1);
      });

      expect(screen.queryByText('Duplicate')).not.toBeInTheDocument();
    });
  });

  describe('foreign-currency columns (showFxColumns)', () => {
    // Ordinary foreign entry: the fee is folded into `amount`, not a split.
    // base = round(100 EUR x 1.38) = 138; amount = -141.45 => fee = 3.45.
    const foldedFeeTransaction = () =>
      createTransaction({
        amount: -141.45,
        currencyCode: 'CAD',
        exchangeRate: 1.38,
        originalAmount: -100.0,
        originalCurrencyCode: 'EUR',
      });

    // A split foreign transaction folds the fee into `amount` exactly like an
    // ordinary one; its category lines sum to that fee-inclusive total
    // (-100 + -41.45 = -141.45). base 138 - amount 141.45 => fee 3.45.
    const splitFeeTransaction = () =>
      createTransaction({
        amount: -141.45,
        currencyCode: 'CAD',
        exchangeRate: 1.38,
        originalAmount: -100.0,
        originalCurrencyCode: 'EUR',
        isSplit: true,
        splits: [
          {
            id: 'split-1',
            transactionId: '123e4567-e89b-12d3-a456-426614174000',
            categoryId: 'cat-1',
            category: { id: 'cat-1', name: 'Groceries', color: null } as any,
            transferAccountId: null,
            transferAccount: null,
            linkedTransactionId: null,
            amount: -100.0,
            memo: null,
            createdAt: '2024-01-15T00:00:00Z',
          },
          {
            id: 'split-2',
            transactionId: '123e4567-e89b-12d3-a456-426614174000',
            categoryId: 'cat-2',
            category: { id: 'cat-2', name: 'Dining', color: null } as any,
            transferAccountId: null,
            transferAccount: null,
            linkedTransactionId: null,
            amount: -41.45,
            memo: null,
            createdAt: '2024-01-15T00:00:00Z',
          },
        ],
      });

    it('hides the FX columns by default', async () => {
      render(
        <TransactionList
          transactions={[foldedFeeTransaction()]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Grocery Store')).toBeInTheDocument();
      });
      expect(screen.queryByText('Paid Amount')).not.toBeInTheDocument();
      expect(screen.queryByText('Fee Paid')).not.toBeInTheDocument();
    });

    it('derives the fee folded into amount for an ordinary foreign entry', async () => {
      render(
        <TransactionList
          transactions={[foldedFeeTransaction()]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
          showFxColumns
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Currency')).toBeInTheDocument();
      });
      expect(screen.getByText('Paid Amount')).toBeInTheDocument();
      expect(screen.getByText('Fee Paid')).toBeInTheDocument();
      expect(screen.getByText('EUR')).toBeInTheDocument();
      // Paid amount: -100 EUR through the +/- formatter.
      expect(screen.getByText(/-\$100\.00/)).toBeInTheDocument();
      // Fee: base 138 - amount 141.45 = 3.45, shown as a positive cost.
      expect(screen.getByText('$3.45')).toBeInTheDocument();
    });

    it('derives the folded-in fee for a split foreign transaction', async () => {
      render(
        <TransactionList
          transactions={[splitFeeTransaction()]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
          showFxColumns
        />
      );

      await waitFor(() => {
        expect(screen.getByText('EUR')).toBeInTheDocument();
      });
      // Fee: base 138 - amount 141.45 = 3.45, from the parent amount not a split.
      expect(screen.getByText('$3.45')).toBeInTheDocument();
    });

    it('shows a dash in the fee column when a foreign transaction has no fee', async () => {
      // amount equals the converted base (100 EUR x 1.38), so no fee applies.
      const noFee = createTransaction({
        amount: -138.0,
        originalAmount: -100.0,
        exchangeRate: 1.38,
        originalCurrencyCode: 'EUR',
      });

      render(
        <TransactionList
          transactions={[noFee]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
          showFxColumns
        />
      );

      await waitFor(() => {
        expect(screen.getByText('EUR')).toBeInTheDocument();
      });
      const row = screen.getByText('Grocery Store').closest('tr')!;
      const cells = row.querySelectorAll('td');
      // Fee column is the last cell before balance/status/actions; assert a
      // dash is present somewhere in the row's fee cell.
      const feeCell = cells[cells.length - 3];
      expect(feeCell.textContent).toBe('-');
    });
  });
  // A green suite after a padding change is a finding, and this is the case it
  // was missing: the register spelled its own padding table out, so the values
  // reaching the DOM were pinned nowhere. It was one of five copies, and the
  // only one whose `normal` inset (a flat `px-4`) matched neither of the other
  // four.
  describe('cell padding comes from the shared scale', () => {
    it.each([
      ['normal', 'px-3 sm:px-6 py-4'],
      ['compact', 'px-4 py-2'],
      ['dense', 'px-3 py-1'],
    ] as const)('uses the default scale at %s density', (level, expected) => {
      useDensityStore.setState({ densities: { transactions: level } });
      render(
        <TransactionList
          transactions={[createTransaction()]}
          onEdit={mockOnEdit}
          onRefresh={mockOnRefresh}
        />
      );

      const cell = screen.getByText('Grocery Store').closest('td');
      for (const cls of expected.split(' ')) {
        expect(cell?.className, `${level}: ${cls}`).toContain(cls);
      }
    });
  });
});

describe('TransactionList compact mobile dates', () => {
  afterEach(() => {
    // `cleanup()` first: vitest runs after-hooks in reverse registration
    // order, so a store write here would re-render the still-mounted tree
    // outside act. `src/test/test-hygiene.test.ts` is the rule.
    cleanup();
    useDateDisplayStore.setState({ compactMobileDates: false });
  });

  it('offers the toggle in the Date column header, off by default', () => {
    render(<TransactionList transactions={[createTransaction()]} />);

    const toggle = screen.getByRole('button', { name: 'Hide the year' });
    expect(toggle.closest('th')).toHaveTextContent('Date');
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    // Full date, single rendering -- no phone/desktop split.
    expect(screen.getByText('2024-01-15')).toBeInTheDocument();
    expect(screen.queryByText('01-15')).not.toBeInTheDocument();
  });

  it('drops the year at every width once the option is on', async () => {
    render(<TransactionList transactions={[createTransaction()]} />);

    const toggle = screen.getByRole('button', { name: 'Hide the year' });
    // The toggle is offered at every width -- the day/month view began as a
    // phone-only trade and is now a date view the user can pick anywhere.
    expect(toggle.className).not.toContain('sm:hidden');
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(toggle).toHaveAttribute('aria-pressed', 'true');
    });

    // The day is kept -- the year is the part a register row can spare -- and
    // there is one rendering, no phone/desktop CSS split: the chosen view is
    // what every width shows.
    expect(screen.getByText('01-15')).toBeInTheDocument();
    expect(screen.queryByText('2024-01-15')).not.toBeInTheDocument();
  });

  it('closes the gap between the Date and Payee columns, header and cells alike', async () => {
    const { container } = render(<TransactionList transactions={[createTransaction()]} />);

    const dateHeader = () => container.querySelectorAll('thead th')[0];
    const payeeHeader = () => container.querySelectorAll('thead th')[2];
    const dateCell = () => container.querySelectorAll('tbody td')[0];
    const payeeCell = () => container.querySelectorAll('tbody td')[2];

    // The ordinary inset while the full date is shown.
    expect(dateHeader().className).not.toContain('max-sm:pr-1');
    expect(dateCell().className).not.toContain('max-sm:pr-1');

    fireEvent.click(screen.getByRole('button', { name: 'Hide the year' }));

    await waitFor(() => {
      expect(dateCell().className).toContain('max-sm:pr-1');
    });

    // Both facing sides move, so the whole gap closes rather than half of it.
    expect(payeeCell().className).toContain('max-sm:pl-1');

    // And the header moves with its column: a `th` and its `td` that disagree
    // about padding put the label and the values it labels at different
    // offsets.
    expect(dateHeader().className).toContain('max-sm:pr-1');
    expect(payeeHeader().className).toContain('max-sm:pl-1');
  });

  it('remembers the choice in the shared register-wide store', async () => {
    render(<TransactionList transactions={[createTransaction()]} />);

    fireEvent.click(screen.getByRole('button', { name: 'Hide the year' }));

    await waitFor(() => {
      expect(useDateDisplayStore.getState().compactMobileDates).toBe(true);
    });
  });
});

describe('the payee column floor', () => {
  // The register is filtered to one payee and every column beside it gets
  // shorter at once -- one payee name, one category, no reference numbers,
  // smaller amounts. Description carries `w-full`, which an auto-layout table
  // settles against the content columns in proportion to their content, so
  // that shrinkage became Description's: measured at a 1710px register, Payee
  // 270px -> 212px and Description 386px -> 517px, cutting off the very payee
  // the user had just filtered for. jsdom does no layout, so what is checkable
  // here is that the floor reaches the DOM -- on the header AND the cells,
  // because a column's minimum is the largest of its cells' and half a floor
  // is no floor.
  it('declares the floor on the payee header and its cells alike', () => {
    const { container } = render(
      <TransactionList transactions={[createTransaction()]} />,
    );

    const payeeHeader = container.querySelectorAll('thead th')[2];
    const payeeCell = container.querySelectorAll('tbody td')[2];

    expect(payeeHeader).toHaveTextContent('Payee');
    expect(payeeHeader.className).toContain(REGISTER_PAYEE_CELL_FLOOR);
    expect(payeeCell.className).toContain(REGISTER_PAYEE_CELL_FLOOR);
  });

  it('leaves the phone caps in charge below sm', () => {
    // `min-width` beats `max-width`, so the floor is `sm:`-scoped: below it
    // the payee cell's phone cap still decides, or a 240px floor would prise
    // the phone layout open.
    const { container } = render(
      <TransactionList transactions={[createTransaction()]} />,
    );
    const payeeCell = container.querySelectorAll('tbody td')[2];

    expect(REGISTER_PAYEE_CELL_FLOOR.startsWith('sm:')).toBe(true);
    expect(payeeCell.className).toContain('max-w-[100px]');
  });
});

describe('the Table / Calendar switch in the register toolbar', () => {
  it('sits beside the count, with export and density before the pager', () => {
    // The switch reads with the line saying what the reader is looking at; the
    // buttons that act on the list as drawn keep the right-hand end, in front
    // of the page stepper.
    render(
      <TransactionList
        transactions={[createTransaction()]}
        currentPage={1}
        totalPages={3}
        totalItems={60}
        pageSize={25}
        onPageChange={vi.fn()}
        onExport={vi.fn()}
        viewToggle={<button type="button">Switch view</button>}
      />,
    );

    const count = screen.getByText('60');
    const toggle = screen.getByRole('button', { name: 'Switch view' });
    const exportButton = screen.getByTitle('Export transactions to CSV');
    const density = screen.getByTitle('Toggle row density');
    const firstPage = screen.getByTitle('First page');

    expect(count.compareDocumentPosition(toggle)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(toggle.compareDocumentPosition(exportButton)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(exportButton.compareDocumentPosition(density)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(density.compareDocumentPosition(firstPage)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('survives an empty register, which is when a reader reaches for it', () => {
    // A control that vanishes with the last row is one the reader cannot get
    // back to without writing a transaction.
    render(
      <TransactionList
        transactions={[]}
        viewToggle={<button type="button">Switch view</button>}
      />,
    );

    expect(screen.getByRole('button', { name: 'Switch view' })).toBeInTheDocument();
    // No pages of nothing to step through.
    expect(screen.queryByTitle('First page')).not.toBeInTheDocument();
  });
});

describe('TransactionList sorting', () => {
  const mockOnEdit = vi.fn();
  const mockOnRefresh = vi.fn();

  const renderSortable = (
    props: Partial<React.ComponentProps<typeof TransactionList>> = {},
  ) => {
    const onSortChange = vi.fn();
    const utils = render(
      <TransactionList
        transactions={[createTransaction()]}
        onEdit={mockOnEdit}
        onRefresh={mockOnRefresh}
        sort={{ field: 'date', direction: 'desc' }}
        onSortChange={onSortChange}
        {...props}
      />,
    );
    return { ...utils, onSortChange };
  };

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('offers a sort control for every column the server can sort by', async () => {
    renderSortable();

    await waitFor(() => {
      expect(screen.getByRole('columnheader', { name: /date/i })).toBeInTheDocument();
    });
    // A field with no control anywhere would strand a remembered sort: the
    // register would stay ordered by it with no way to change it back.
    for (const name of [/date/i, /account/i, /payee/i, /category/i, /description/i, /ref #/i, /amount/i, /status/i]) {
      expect(screen.getByRole('columnheader', { name })).toHaveAttribute('aria-sort');
    }
  });

  it('marks only the sorted column, and says which way it runs', async () => {
    renderSortable({ sort: { field: 'payee', direction: 'asc' } });

    await waitFor(() => {
      expect(screen.getByRole('columnheader', { name: /payee/i })).toHaveAttribute(
        'aria-sort',
        'ascending',
      );
    });
    expect(screen.getByRole('columnheader', { name: /date/i })).toHaveAttribute(
      'aria-sort',
      'none',
    );
  });

  it('asks the page to re-sort when a header is used', async () => {
    const { onSortChange } = renderSortable();

    await waitFor(() => {
      expect(screen.getByRole('columnheader', { name: /amount/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('columnheader', { name: /amount/i }));
    expect(onSortChange).toHaveBeenCalledWith('amount');
  });

  it('keeps the year toggle in the Date header without sorting on it', async () => {
    const { onSortChange } = renderSortable();

    const toggle = await screen.findByRole('button', { name: /hide the year/i });
    fireEvent.click(toggle);
    expect(onSortChange).not.toHaveBeenCalled();
  });

  it('draws no Balance column while the register is sorted by something else', async () => {
    renderSortable({
      isSingleAccountView: true,
      startingBalance: 1000,
      sort: { field: 'amount', direction: 'desc' },
    });

    await waitFor(() => {
      expect(screen.getByRole('columnheader', { name: /amount/i })).toBeInTheDocument();
    });
    // A running balance is a figure about the row above it, so beside rows in
    // amount order it would be arithmetic nobody can read.
    expect(screen.queryByText('Balance')).not.toBeInTheDocument();
  });

  it('draws the Balance column in either date direction', async () => {
    for (const direction of ['asc', 'desc'] as const) {
      cleanup();
      renderSortable({
        isSingleAccountView: true,
        startingBalance: 1000,
        sort: { field: 'date', direction },
      });
      await waitFor(() => {
        expect(screen.getByText('Balance')).toBeInTheDocument();
      });
    }
  });

  it('says why the balance is missing, but only where there was one to miss', async () => {
    renderSortable({
      isSingleAccountView: true,
      sort: { field: 'payee', direction: 'asc' },
      startingBalanceWithheld: 'sort',
    });
    await waitFor(() => {
      expect(
        screen.getByText('Sort by date to see the running balance'),
      ).toBeInTheDocument();
    });

    cleanup();
    // No flag: this register never had a Balance column, so promising one
    // back would be a lie the reader cannot act on.
    renderSortable({ sort: { field: 'payee', direction: 'asc' } });
    await waitFor(() => {
      expect(screen.getByRole('columnheader', { name: /payee/i })).toBeInTheDocument();
    });
    expect(
      screen.queryByText('Sort by date to see the running balance'),
    ).not.toBeInTheDocument();
  });

  it('walks an oldest-first page from the same seed', async () => {
    // The seed is the balance after the page's NEWEST row whichever way the
    // page arrived, so the oldest row on an ascending page is not the one
    // carrying it.
    const older = createTransaction({ id: 'older', transactionDate: '2024-01-14', amount: -10 });
    const newer = createTransaction({ id: 'newer', transactionDate: '2024-01-15', amount: -40 });
    renderSortable({
      isSingleAccountView: true,
      startingBalance: 100,
      sort: { field: 'date', direction: 'asc' },
      transactions: [older, newer],
    });

    await waitFor(() => {
      expect(screen.getByText('$100.00')).toBeInTheDocument();
    });
    // newer: 100; older: 100 - (-40) = 140.
    expect(screen.getByText('$140.00')).toBeInTheDocument();
  });

  it('walks the page in the order the rows were fetched, not the order clicked', async () => {
    // The moment a reader clicks Date the header says oldest-first, but the
    // rows and the seed on screen are still the newest-first page from the
    // previous request. Reading the direction from the header there reverses
    // that page before walking it, and every figure in the Balance column
    // comes out inverted -- numbers that were never true of any state of the
    // ledger, drawn at full opacity with no spinner over them.
    const older = createTransaction({ id: 'older', transactionDate: '2024-01-14', amount: -10 });
    const newer = createTransaction({ id: 'newer', transactionDate: '2024-01-15', amount: -40 });
    renderSortable({
      isSingleAccountView: true,
      startingBalance: 100,
      sort: { field: 'date', direction: 'asc' },
      rowsSort: { field: 'date', direction: 'desc' },
      transactions: [newer, older],
    });

    // Walked newest-first as the rows arrived: newer 100, older 140. Walked
    // under the header's ascending direction the page is reversed first, and
    // the same two rows read 110 and 100.
    await waitFor(() => {
      expect(screen.getByText('$140.00')).toBeInTheDocument();
    });
    expect(screen.getByText('$100.00')).toBeInTheDocument();
    expect(screen.queryByText('$110.00')).not.toBeInTheDocument();
  });

  it('keeps the Balance column hidden until the date-ordered rows arrive', async () => {
    // Clicking Date while sorted by payee must not turn the column on over
    // rows that carry no balance: the seed was withheld with them, so every
    // cell would render as a dash under the line promising a balance.
    renderSortable({
      isSingleAccountView: true,
      sort: { field: 'date', direction: 'desc' },
      rowsSort: { field: 'payee', direction: 'asc' },
      startingBalanceWithheld: 'sort',
    });

    await waitFor(() => {
      expect(
        screen.getByText('Sort by date to see the running balance'),
      ).toBeInTheDocument();
    });
    expect(screen.queryByText('Balance')).not.toBeInTheDocument();
  });

  it('draws the plain header a surface that does not sort has always had', async () => {
    render(
      <TransactionList
        transactions={[createTransaction()]}
        onEdit={mockOnEdit}
        onRefresh={mockOnRefresh}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Date')).toBeInTheDocument();
    });
    expect(screen.queryByRole('columnheader', { name: /payee/i })).not.toHaveAttribute(
      'aria-sort',
    );
  });
});

describe('TransactionList today divider', () => {
  const mockOnEdit = vi.fn();
  const mockOnRefresh = vi.fn();

  // `useFinancialToday` is mocked for this file, so the fixture is dated
  // either side of that fixed day: one row plainly in the past, one plainly
  // ahead of it.
  const past = createTransaction({ id: 'past', transactionDate: '2020-01-01' });
  const future = createTransaction({ id: 'future', transactionDate: '2099-01-01' });

  const renderWith = (
    transactions: Transaction[],
    sort?: { field: 'date' | 'payee'; direction: 'asc' | 'desc' },
  ) =>
    render(
      <TransactionList
        transactions={transactions}
        onEdit={mockOnEdit}
        onRefresh={mockOnRefresh}
        sort={sort as never}
        onSortChange={sort ? vi.fn() : undefined}
      />,
    );

  afterEach(() => cleanup());

  it('marks where a newest-first page crosses today', async () => {
    renderWith([future, past], { field: 'date', direction: 'desc' });
    await waitFor(() => {
      expect(screen.getByText('Today')).toBeInTheDocument();
    });
  });

  it('marks where an oldest-first page crosses it, which is the other end', async () => {
    // The future rows are at the BOTTOM here, so a divider placed by index
    // rather than by date would sit above the past rows instead.
    renderWith([past, future], { field: 'date', direction: 'asc' });
    await waitFor(() => {
      expect(screen.getByText('Today')).toBeInTheDocument();
    });
    // And it sits between the two rows rather than above both: the divider
    // row comes after the past row in DOM order.
    const body = screen.getByText('Today').closest('tbody');
    const rows = Array.from(body!.children);
    const dividerIndex = rows.findIndex((row) => row.textContent?.includes('Today'));
    expect(dividerIndex).toBeGreaterThan(0);
  });

  it('draws none on a page that does not cross today', async () => {
    renderWith([past, { ...past, id: 'past-second' }], { field: 'date', direction: 'asc' });
    await waitFor(() => {
      expect(screen.getByText('Date')).toBeInTheDocument();
    });
    expect(screen.queryByText('Today')).not.toBeInTheDocument();
  });

  it("reads the user's calendar for 'today', not the browser's", async () => {
    // A traveller's laptop is on the wrong day for this. The register takes
    // the answer from the shared financial-today helper, which reads the
    // user's configured timezone, so moving that answer moves the divider.
    mockFinancialToday.mockReturnValue('2024-01-15');
    const onThatDay = createTransaction({ id: 'today', transactionDate: '2024-01-15' });
    const theDayAfter = createTransaction({ id: 'tomorrow', transactionDate: '2024-01-16' });

    renderWith([theDayAfter, onThatDay], { field: 'date', direction: 'desc' });
    await waitFor(() => {
      expect(screen.getByText('Today')).toBeInTheDocument();
    });

    // Move the user's day past both rows and the crossing disappears.
    cleanup();
    mockFinancialToday.mockReturnValue('2024-02-01');
    renderWith([theDayAfter, onThatDay], { field: 'date', direction: 'desc' });
    await waitFor(() => {
      expect(screen.getByText('Date')).toBeInTheDocument();
    });
    expect(screen.queryByText('Today')).not.toBeInTheDocument();
    mockFinancialToday.mockReturnValue('2026-01-01');
  });

  it('draws none under an order where "future" is not a place on the page', async () => {
    renderWith([future, past], { field: 'payee', direction: 'asc' });
    await waitFor(() => {
      expect(screen.getByRole('columnheader', { name: /payee/i })).toBeInTheDocument();
    });
    expect(screen.queryByText('Today')).not.toBeInTheDocument();
  });
});

describe('TransactionList hidden columns', () => {
  // The stored `hiddenTableColumns.transactions` set (one per table kind, read
  // everywhere the register is mounted) removes a hideable column from the
  // DOM at every width: no header, no cell, and the today divider spans one
  // column less. Restoring is the toolbar's Columns menu alone.
  const past = createTransaction({ id: 'past', transactionDate: '2020-01-01' });
  const future = createTransaction({ id: 'future', transactionDate: '2099-01-01' });

  const seed = (transactions: string[] | undefined) =>
    usePreferencesStore.setState({
      preferences: (transactions
        ? { hiddenTableColumns: { transactions } }
        : { hiddenTableColumns: {} }) as any,
    });

  const renderRegister = () =>
    render(
      <TransactionList
        transactions={[future, past]}
        onEdit={vi.fn()}
        onRefresh={vi.fn()}
        onExport={vi.fn()}
        sort={{ field: 'date', direction: 'desc' }}
        onSortChange={vi.fn()}
      />,
    );

  const dividerSpan = () => Number(screen.getByText('Today').closest('td')!.getAttribute('colspan'));

  beforeEach(() => {
    mockUpdatePreferences.mockReset();
    mockUpdatePreferences.mockImplementation(async (patch: Record<string, unknown>) => patch);
  });

  afterEach(() => {
    cleanup();
    usePreferencesStore.setState({ preferences: null });
  });

  it('renders every column with the default empty set, as before', async () => {
    seed(undefined);
    renderRegister();
    await waitFor(() => {
      expect(screen.getByRole('columnheader', { name: /status/i })).toBeInTheDocument();
    });
    expect(screen.getAllByTitle('Click to cycle status')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Columns' })).toBeInTheDocument();
    // Ten unconditional columns plus Account on a multi-account register.
    expect(dividerSpan()).toBe(11);
  });

  it('removes a hidden column from the header, the rows and the divider span', async () => {
    seed(['status']);
    renderRegister();
    await waitFor(() => {
      expect(screen.getByRole('columnheader', { name: /payee/i })).toBeInTheDocument();
    });
    expect(screen.queryByRole('columnheader', { name: /status/i })).not.toBeInTheDocument();
    expect(screen.queryByTitle('Click to cycle status')).not.toBeInTheDocument();
    expect(dividerSpan()).toBe(10);
    // The menu's trigger says where the column went.
    expect(screen.getByRole('button', { name: 'Columns, 1 hidden' })).toBeInTheDocument();
    // The structural columns and the other hideable ones are untouched.
    for (const name of [/date/i, /payee/i, /category/i, /description/i, /ref #/i, /amount/i]) {
      expect(screen.getByRole('columnheader', { name })).toBeInTheDocument();
    }
  });

  it('hides every hideable column at once and keeps what a register is', async () => {
    seed(['description', 'refNumber', 'tags', 'attachments', 'status']);
    renderRegister();
    await waitFor(() => {
      expect(screen.getByRole('columnheader', { name: /payee/i })).toBeInTheDocument();
    });
    // The sort icon's glyph trails each sortable label; the labels are the point.
    const headers = screen
      .getAllByRole('columnheader')
      .map((th) => th.textContent?.replace(/[^A-Za-z #]/g, '').trim());
    expect(headers).toEqual(['Date', 'Account', 'Payee', 'Category', 'Amount', 'Actions']);
    expect(dividerSpan()).toBe(6);
    expect(screen.getByRole('button', { name: 'Columns, 5 hidden' })).toBeInTheDocument();
  });

  it('hides a column from the toolbar menu and shows it again from there', async () => {
    seed(undefined);
    renderRegister();
    await waitFor(() => {
      expect(screen.getByRole('columnheader', { name: /status/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Status' }));
    });
    await waitFor(() => {
      expect(useHiddenColumnsStore.getState().columns).toEqual({ transactions: ['status'] });
    });
    expect(screen.queryByRole('columnheader', { name: /status/i })).not.toBeInTheDocument();
    expect(screen.getByRole('menuitemcheckbox', { name: 'Status' })).toHaveAttribute('aria-checked', 'false');

    await act(async () => {
      fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Status' }));
    });
    await waitFor(() => {
      expect(useHiddenColumnsStore.getState().columns).toEqual({ transactions: [] });
    });
    expect(mockUpdatePreferences).not.toHaveBeenCalled();
    expect(screen.getByRole('columnheader', { name: /status/i })).toBeInTheDocument();
  });

  it('hides a column from its header by right-click, through the sheet', async () => {
    seed(undefined);
    renderRegister();
    await waitFor(() => {
      expect(screen.getByRole('columnheader', { name: /status/i })).toBeInTheDocument();
    });

    fireEvent.contextMenu(screen.getByRole('columnheader', { name: /status/i }));
    const hide = await screen.findByRole('button', { name: /hide column/i });
    await act(async () => {
      fireEvent.click(hide);
    });
    await waitFor(() => {
      expect(useHiddenColumnsStore.getState().columns).toEqual({ transactions: ['status'] });
    });
    expect(screen.queryByRole('columnheader', { name: /status/i })).not.toBeInTheDocument();
  });

  it('still sorts from a plain click on a hideable header', async () => {
    seed(undefined);
    const onSortChange = vi.fn();
    render(
      <TransactionList
        transactions={[past]}
        onEdit={vi.fn()}
        onRefresh={vi.fn()}
        sort={{ field: 'date', direction: 'desc' }}
        onSortChange={onSortChange}
      />,
    );
    await waitFor(() => {
      expect(screen.getByRole('columnheader', { name: /status/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('columnheader', { name: /status/i }));
    expect(onSortChange).toHaveBeenCalledWith('status');
    // Tags and Attachments sort nowhere, so their click sorts nothing.
    fireEvent.click(screen.getByRole('columnheader', { name: /tags/i }));
    expect(onSortChange).toHaveBeenCalledTimes(1);
  });
});

describe('TransactionList warranties', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the shield but offers no warranty action in the Copy menu or the action sheet', async () => {
    render(
      <TransactionList
        transactions={[createTransaction({ warrantyCount: 2 })]}
        onEdit={vi.fn()}
        onDuplicate={vi.fn()}
      />,
    );
    expect(screen.getByRole('img', { name: '2 warranties' })).toBeInTheDocument();
    // Duplicate alone is the single button, not a menu.
    expect(screen.getByTitle('Duplicate transaction')).toBeInTheDocument();
    fireEvent.contextMenu(screen.getByText('Grocery Store').closest('tr')!);
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
    expect(screen.queryByText('Add warranty')).not.toBeInTheDocument();
    expect(screen.queryByText('View warranties')).not.toBeInTheDocument();
  });
});

describe('TransactionList accrual owner actions', () => {
  afterEach(() => {
    cleanup();
    useAuthStore.setState({ user: null, actingAsUserId: null });
    useDemoStore.setState({ isDemoMode: false });
  });
  it('shows the accrued badge without a separate register action', async () => {
    vi.mocked(accrualsApi.sources).mockResolvedValueOnce([{sourceTransactionId:createTransaction().id,scheduleCount:2}]);
    useAuthStore.setState({ user: { id: 'user-1' } as User, actingAsUserId: null });
    await act(async () => { render(<TransactionList transactions={[createTransaction()]} />); });
    expect(screen.queryByRole('button', { name: 'Accrual' })).not.toBeInTheDocument();
    expect(accrualsApi.sources).toHaveBeenCalled();
    expect(screen.getAllByText('Accrued').length).toBeGreaterThan(0);
  });
  it.each(['delegate', 'foreign', 'demo', 'transfer', 'joint'] as const)('hides accrual for %s contexts', async context => {
    useAuthStore.setState({ user: { id: 'user-1' } as User, actingAsUserId: context === 'delegate' ? 'owner' : null });
    useDemoStore.setState({ isDemoMode: context === 'demo' });
    const transaction = createTransaction({ userId: context === 'foreign' ? 'other-user' : 'user-1', isTransfer: context === 'transfer' });
    const jointPermissionsByAccount = context === 'joint' ? new Map([[transaction.accountId, { canCreate: true, canEdit: true, canDelete: true }]]) : undefined;
    await act(async () => { render(<TransactionList transactions={[transaction]} jointPermissionsByAccount={jointPermissionsByAccount} />); });
    expect(screen.queryByRole('button', { name: 'Accrual' })).not.toBeInTheDocument();
  });
});
