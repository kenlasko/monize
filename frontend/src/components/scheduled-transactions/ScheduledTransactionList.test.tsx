import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@/test/render';
import { ScheduledTransactionList } from './ScheduledTransactionList';
import toast from 'react-hot-toast';

vi.mock('react-hot-toast', () => ({
  default: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({ formatDate: (d: string) => d }),
}));

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: (n: number, _c?: string) => `$${n.toFixed(2)}`,
  }),
}));

const mockPost = vi.fn().mockResolvedValue({});
const mockSkip = vi.fn().mockResolvedValue({});
const mockDelete = vi.fn().mockResolvedValue({});

vi.mock('@/lib/scheduled-transactions', () => ({
  scheduledTransactionsApi: {
    post: (...args: any[]) => mockPost(...args),
    skip: (...args: any[]) => mockSkip(...args),
    delete: (...args: any[]) => mockDelete(...args),
  },
}));

vi.mock('@/lib/errors', () => ({
  getErrorMessage: (_error: unknown, fallback: string) => fallback,
}));

vi.mock('@/lib/utils', () => ({
  parseLocalDate: (d: string) => new Date(d + 'T00:00:00'),
  cn: (...args: any[]) => args.filter(Boolean).join(' '),
}));

// Format a local date as YYYY-MM-DD (avoids UTC offset issues with toISOString)
function formatLocalDate(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Helper to create a future date string
function futureDate(daysFromNow: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return formatLocalDate(d);
}

// Helper to create a past date string
function pastDate(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return formatLocalDate(d);
}

// Helper to create today's date string
function todayDate(): string {
  return formatLocalDate(new Date());
}

function createTransaction(overrides: Partial<any> = {}) {
  return {
    id: 's1',
    name: 'Netflix',
    amount: -15.99,
    currencyCode: 'CAD',
    frequency: 'MONTHLY' as const,
    nextDueDate: futureDate(15),
    isActive: true,
    autoPost: false,
    isTransfer: false,
    isSplit: false,
    account: { name: 'Checking' },
    category: null,
    payeeName: null,
    payee: null,
    occurrencesRemaining: null,
    overrideCount: 0,
    nextOverride: null,
    ...overrides,
  } as any;
}

describe('ScheduledTransactionList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --- Empty state ---
  it('renders empty state', () => {
    render(<ScheduledTransactionList transactions={[]} />);
    expect(screen.getByText('No scheduled transactions')).toBeInTheDocument();
    expect(screen.getByText('Get started by creating a bill or deposit schedule.')).toBeInTheDocument();
  });

  // --- Basic table rendering ---
  it('renders transactions table', () => {
    const transactions = [createTransaction()];
    render(<ScheduledTransactionList transactions={transactions} />);
    expect(screen.getByText('Netflix')).toBeInTheDocument();
  });

  it('renders table headers', () => {
    const transactions = [createTransaction()];
    render(<ScheduledTransactionList transactions={transactions} />);
    expect(screen.getByText('Name / Payee')).toBeInTheDocument();
    expect(screen.getByText('Account')).toBeInTheDocument();
    expect(screen.getByText('Category')).toBeInTheDocument();
    expect(screen.getByText('Amount')).toBeInTheDocument();
    expect(screen.getByText('Schedule')).toBeInTheDocument();
    expect(screen.getByText('Auto')).toBeInTheDocument();
    expect(screen.getByText('Actions')).toBeInTheDocument();
  });

  it('renders multiple transactions', () => {
    const transactions = [
      createTransaction({ id: 's1', name: 'Netflix' }),
      createTransaction({ id: 's2', name: 'Spotify', amount: -9.99 }),
      createTransaction({ id: 's3', name: 'Salary', amount: 5000 }),
    ];
    render(<ScheduledTransactionList transactions={transactions} />);
    expect(screen.getByText('Netflix')).toBeInTheDocument();
    expect(screen.getByText('Spotify')).toBeInTheDocument();
    expect(screen.getByText('Salary')).toBeInTheDocument();
  });

  // --- Inactive transaction styling ---
  it('shows inactive transactions with reduced opacity', () => {
    const transactions = [createTransaction({ isActive: false, name: 'Cancelled Sub' })];
    const { container } = render(<ScheduledTransactionList transactions={transactions} />);
    expect(container.querySelector('.opacity-50')).toBeInTheDocument();
  });

  it('does not show reduced opacity for active transactions', () => {
    const transactions = [createTransaction({ isActive: true })];
    const { container } = render(<ScheduledTransactionList transactions={transactions} />);
    const rows = container.querySelectorAll('tr');
    // header row + data row
    const dataRow = rows[1];
    expect(dataRow?.classList.contains('opacity-50')).toBe(false);
  });

  // --- Amount formatting ---
  it('renders negative amounts with red color', () => {
    const transactions = [createTransaction({ amount: -25.50 })];
    render(<ScheduledTransactionList transactions={transactions} />);
    const amountEl = screen.getByText('-$25.50');
    expect(amountEl).toBeInTheDocument();
    expect(amountEl.className).toContain('text-red');
  });

  it('renders positive amounts with green color', () => {
    const transactions = [createTransaction({ amount: 1000 })];
    render(<ScheduledTransactionList transactions={transactions} />);
    const amountEl = screen.getByText('+$1000.00');
    expect(amountEl).toBeInTheDocument();
    expect(amountEl.className).toContain('text-green');
  });

  it('renders dash for null amount', () => {
    const transactions = [createTransaction({ amount: null })];
    render(<ScheduledTransactionList transactions={transactions} />);
    // Should render a dash character
    const dashes = screen.getAllByText('\u2014');
    expect(dashes.length).toBeGreaterThan(0);
  });

  // --- Override amount display ---
  it('shows override amount with strikethrough original when amounts differ', () => {
    const transactions = [createTransaction({
      amount: -15.99,
      nextOverride: { amount: -19.99, overrideDate: null },
    })];
    render(<ScheduledTransactionList transactions={transactions} />);
    // Both amounts should be displayed
    expect(screen.getByText('-$15.99')).toBeInTheDocument();
    expect(screen.getByText('-$19.99')).toBeInTheDocument();
  });

  // --- Account name display ---
  it('displays account name', () => {
    const transactions = [createTransaction({ account: { name: 'Main Checking' } })];
    render(<ScheduledTransactionList transactions={transactions} />);
    expect(screen.getByText('Main Checking')).toBeInTheDocument();
  });

  // --- Category display ---
  it('displays category name for categorized transaction', () => {
    const transactions = [createTransaction({
      category: { name: 'Entertainment', color: '#ff0000' },
    })];
    render(<ScheduledTransactionList transactions={transactions} />);
    expect(screen.getByText('Entertainment')).toBeInTheDocument();
  });

  it('displays Transfer badge for transfer transactions', () => {
    const transactions = [createTransaction({
      isTransfer: true,
      transferAccount: { name: 'Savings' },
    })];
    render(<ScheduledTransactionList transactions={transactions} />);
    expect(screen.getByText('Transfer')).toBeInTheDocument();
  });

  it('displays Split badge for split transactions', () => {
    const transactions = [createTransaction({
      isSplit: true,
      splits: [
        { category: { name: 'Cat1' } },
        { category: { name: 'Cat2' } },
      ],
    })];
    render(<ScheduledTransactionList transactions={transactions} />);
    expect(screen.getByText('Split (2)')).toBeInTheDocument();
  });

  it('displays dash when transaction has no category', () => {
    const transactions = [createTransaction({ category: null })];
    render(<ScheduledTransactionList transactions={transactions} />);
    const dashes = screen.getAllByText('\u2014');
    expect(dashes.length).toBeGreaterThan(0);
  });

  // --- Frequency display ---
  it('displays frequency label', () => {
    const transactions = [createTransaction({ frequency: 'MONTHLY' })];
    render(<ScheduledTransactionList transactions={transactions} />);
    expect(screen.getByText('Monthly')).toBeInTheDocument();
  });

  it('displays weekly frequency label', () => {
    const transactions = [createTransaction({ frequency: 'WEEKLY' })];
    render(<ScheduledTransactionList transactions={transactions} />);
    expect(screen.getByText('Weekly')).toBeInTheDocument();
  });

  it('displays occurrences remaining count', () => {
    const transactions = [createTransaction({ occurrencesRemaining: 5 })];
    render(<ScheduledTransactionList transactions={transactions} />);
    expect(screen.getByText(/5 left/)).toBeInTheDocument();
  });

  // --- Override count display ---
  it('displays override count badge when overrides exist', () => {
    const transactions = [createTransaction({ overrideCount: 3 })];
    render(<ScheduledTransactionList transactions={transactions} />);
    expect(screen.getByText('3 modified')).toBeInTheDocument();
  });

  it('does not display override badge when count is 0', () => {
    const transactions = [createTransaction({ overrideCount: 0 })];
    render(<ScheduledTransactionList transactions={transactions} />);
    expect(screen.queryByText(/modified/)).not.toBeInTheDocument();
  });

  // --- Payee display ---
  it('shows payee name below transaction name when different from name', () => {
    const transactions = [createTransaction({
      name: 'Monthly Rent',
      payeeName: 'Landlord Corp',
    })];
    render(<ScheduledTransactionList transactions={transactions} />);
    expect(screen.getByText('Monthly Rent')).toBeInTheDocument();
    expect(screen.getByText('Landlord Corp')).toBeInTheDocument();
  });

  it('does not show payee when payee name matches transaction name', () => {
    const transactions = [createTransaction({
      name: 'Netflix',
      payeeName: 'Netflix',
    })];
    render(<ScheduledTransactionList transactions={transactions} />);
    // Netflix should appear once (the name), not twice (name + payee)
    const elements = screen.getAllByText('Netflix');
    expect(elements.length).toBe(1);
  });

  // --- Auto-post display ---
  it('shows On badge when autoPost is true', () => {
    const transactions = [createTransaction({ autoPost: true })];
    render(<ScheduledTransactionList transactions={transactions} />);
    expect(screen.getByText('On')).toBeInTheDocument();
  });

  it('shows dash when autoPost is false', () => {
    const transactions = [createTransaction({ autoPost: false })];
    render(<ScheduledTransactionList transactions={transactions} />);
    // There should be dashes (from autoPost and possibly category)
    const dashes = screen.getAllByText('\u2014');
    expect(dashes.length).toBeGreaterThan(0);
  });

  // --- Due date status badges ---
  it('shows Overdue badge for past due transactions', () => {
    const transactions = [createTransaction({ nextDueDate: pastDate(3) })];
    render(<ScheduledTransactionList transactions={transactions} />);
    // Badge appears in both mobile and desktop layout
    const badges = screen.getAllByText('Overdue');
    expect(badges.length).toBeGreaterThanOrEqual(1);
  });

  it('shows Due Today badge for transactions due today', () => {
    const transactions = [createTransaction({ nextDueDate: todayDate() })];
    render(<ScheduledTransactionList transactions={transactions} />);
    // Badge appears in both mobile and desktop layout
    const badges = screen.getAllByText('Due Today');
    expect(badges.length).toBeGreaterThanOrEqual(1);
  });

  it('shows Due Soon badge for transactions due within 7 days', () => {
    const transactions = [createTransaction({ nextDueDate: futureDate(3) })];
    render(<ScheduledTransactionList transactions={transactions} />);
    // Badge appears in both mobile and desktop layout
    const badges = screen.getAllByText('Due Soon');
    expect(badges.length).toBeGreaterThanOrEqual(1);
  });

  it('does not show due date badge for transactions due far in the future', () => {
    const transactions = [createTransaction({ nextDueDate: futureDate(30) })];
    render(<ScheduledTransactionList transactions={transactions} />);
    expect(screen.queryByText('Overdue')).not.toBeInTheDocument();
    expect(screen.queryByText('Due Today')).not.toBeInTheDocument();
    expect(screen.queryByText('Due Soon')).not.toBeInTheDocument();
  });

  // --- Override date display ---
  it('shows override date with strikethrough when override date differs from next due date', () => {
    const transactions = [createTransaction({
      nextDueDate: '2025-03-01',
      nextOverride: {
        overrideDate: '2025-03-05',
        amount: -15.99,
      },
    })];
    render(<ScheduledTransactionList transactions={transactions} />);
    // Both dates should be shown
    expect(screen.getByText('2025-03-01')).toBeInTheDocument();
    expect(screen.getByText('2025-03-05')).toBeInTheDocument();
  });

  // --- Action buttons ---
  it('shows post button for active transactions', () => {
    const transactions = [createTransaction({ isActive: true })];
    render(<ScheduledTransactionList transactions={transactions} />);
    expect(screen.getByTitle('Post transaction')).toBeInTheDocument();
  });

  it('shows skip button for active recurring transactions', () => {
    const transactions = [createTransaction({ isActive: true, frequency: 'MONTHLY' })];
    render(<ScheduledTransactionList transactions={transactions} />);
    expect(screen.getByTitle('Skip this occurrence')).toBeInTheDocument();
  });

  it('does not show skip button for ONCE frequency transactions', () => {
    const transactions = [createTransaction({ isActive: true, frequency: 'ONCE' })];
    render(<ScheduledTransactionList transactions={transactions} />);
    expect(screen.queryByTitle('Skip this occurrence')).not.toBeInTheDocument();
  });

  it('shows delete button for all transactions', () => {
    const transactions = [createTransaction()];
    render(<ScheduledTransactionList transactions={transactions} />);
    expect(screen.getByTitle('Delete')).toBeInTheDocument();
  });

  it('shows edit schedule button when onEdit is provided', () => {
    const onEdit = vi.fn();
    const transactions = [createTransaction()];
    render(<ScheduledTransactionList transactions={transactions} onEdit={onEdit} />);
    expect(screen.getByTitle('Edit schedule')).toBeInTheDocument();
  });

  it('does not show edit schedule button when onEdit is not provided', () => {
    const transactions = [createTransaction()];
    render(<ScheduledTransactionList transactions={transactions} />);
    expect(screen.queryByTitle('Edit schedule')).not.toBeInTheDocument();
  });

  it('shows edit occurrence button when onEditOccurrence is provided and transaction is active', () => {
    const onEditOccurrence = vi.fn();
    const transactions = [createTransaction({ isActive: true })];
    render(<ScheduledTransactionList transactions={transactions} onEditOccurrence={onEditOccurrence} />);
    expect(screen.getByTitle('Edit occurrence')).toBeInTheDocument();
  });

  it('does not show edit occurrence button for inactive transactions', () => {
    const onEditOccurrence = vi.fn();
    const transactions = [createTransaction({ isActive: false })];
    render(<ScheduledTransactionList transactions={transactions} onEditOccurrence={onEditOccurrence} />);
    expect(screen.queryByTitle('Edit occurrence')).not.toBeInTheDocument();
  });

  it('does not show post and skip buttons for inactive transactions', () => {
    const transactions = [createTransaction({ isActive: false })];
    render(<ScheduledTransactionList transactions={transactions} />);
    expect(screen.queryByTitle('Post transaction')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Skip this occurrence')).not.toBeInTheDocument();
  });

  // --- Edit button click ---
  it('calls onEdit when edit button is clicked', () => {
    const onEdit = vi.fn();
    const transaction = createTransaction();
    render(<ScheduledTransactionList transactions={[transaction]} onEdit={onEdit} />);

    fireEvent.click(screen.getByTitle('Edit schedule'));
    expect(onEdit).toHaveBeenCalledWith(transaction);
  });

  it('calls onEdit when row is clicked', () => {
    const onEdit = vi.fn();
    const transaction = createTransaction();
    render(<ScheduledTransactionList transactions={[transaction]} onEdit={onEdit} />);

    // Click on the transaction name (which is inside the row)
    fireEvent.click(screen.getByText('Netflix'));
    expect(onEdit).toHaveBeenCalledWith(transaction);
  });

  it('calls onEditOccurrence when edit occurrence button is clicked', () => {
    const onEditOccurrence = vi.fn();
    const transaction = createTransaction({ isActive: true });
    render(<ScheduledTransactionList transactions={[transaction]} onEditOccurrence={onEditOccurrence} />);

    fireEvent.click(screen.getByTitle('Edit occurrence'));
    expect(onEditOccurrence).toHaveBeenCalledWith(transaction);
  });

  // --- Delete with confirmation ---
  it('opens confirm dialog when delete button is clicked', () => {
    const transactions = [createTransaction()];
    render(<ScheduledTransactionList transactions={transactions} />);

    fireEvent.click(screen.getByTitle('Delete'));

    // Confirm dialog should appear
    expect(screen.getByText('Delete Scheduled Transaction')).toBeInTheDocument();
    expect(screen.getByText(/Are you sure you want to delete/)).toBeInTheDocument();
  });

  it('calls delete API when confirming deletion', async () => {
    const onRefresh = vi.fn();
    const transaction = createTransaction();
    render(<ScheduledTransactionList transactions={[transaction]} onRefresh={onRefresh} />);

    // Click delete
    fireEvent.click(screen.getByTitle('Delete'));

    // Confirm
    fireEvent.click(screen.getByText('Delete'));

    await waitFor(() => {
      expect(mockDelete).toHaveBeenCalledWith(transaction.id);
    });

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Scheduled transaction deleted');
    });

    await waitFor(() => {
      expect(onRefresh).toHaveBeenCalled();
    });
  });

  it('closes confirm dialog when cancel is clicked', () => {
    const transactions = [createTransaction()];
    render(<ScheduledTransactionList transactions={transactions} />);

    // Click delete to open dialog
    fireEvent.click(screen.getByTitle('Delete'));
    expect(screen.getByText('Delete Scheduled Transaction')).toBeInTheDocument();

    // Click Cancel
    fireEvent.click(screen.getByText('Cancel'));

    // Dialog should be closed
    expect(screen.queryByText('Delete Scheduled Transaction')).not.toBeInTheDocument();
  });

  it('shows error toast when deletion fails', async () => {
    mockDelete.mockRejectedValueOnce(new Error('Delete failed'));
    const transaction = createTransaction();
    render(<ScheduledTransactionList transactions={[transaction]} />);

    fireEvent.click(screen.getByTitle('Delete'));
    fireEvent.click(screen.getByText('Delete'));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to delete');
    });
  });

  // --- Post with confirmation ---
  it('opens confirm dialog when post button is clicked (no onPost prop)', () => {
    const transactions = [createTransaction()];
    render(<ScheduledTransactionList transactions={transactions} />);

    fireEvent.click(screen.getByTitle('Post transaction'));

    expect(screen.getByText('Post Transaction')).toBeInTheDocument();
    expect(screen.getByText(/Post "Netflix"/)).toBeInTheDocument();
  });

  it('calls post API when confirming post', async () => {
    const onRefresh = vi.fn();
    const transaction = createTransaction();
    render(<ScheduledTransactionList transactions={[transaction]} onRefresh={onRefresh} />);

    fireEvent.click(screen.getByTitle('Post transaction'));
    fireEvent.click(screen.getByText('Post'));

    await waitFor(() => {
      expect(mockPost).toHaveBeenCalledWith(transaction.id);
    });

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Transaction posted');
    });
  });

  it('calls onPost instead of confirm dialog when onPost prop is provided', () => {
    const onPost = vi.fn();
    const transaction = createTransaction();
    render(<ScheduledTransactionList transactions={[transaction]} onPost={onPost} />);

    fireEvent.click(screen.getByTitle('Post transaction'));

    // onPost should be called directly, not opening confirm dialog
    expect(onPost).toHaveBeenCalledWith(transaction);
    expect(screen.queryByText('Post Transaction')).not.toBeInTheDocument();
  });

  it('shows error toast when post fails', async () => {
    mockPost.mockRejectedValueOnce(new Error('Post failed'));
    const transaction = createTransaction();
    render(<ScheduledTransactionList transactions={[transaction]} />);

    fireEvent.click(screen.getByTitle('Post transaction'));
    fireEvent.click(screen.getByText('Post'));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to post transaction');
    });
  });

  // --- Skip with confirmation ---
  it('opens confirm dialog when skip button is clicked', () => {
    const transactions = [createTransaction({ frequency: 'MONTHLY' })];
    render(<ScheduledTransactionList transactions={transactions} />);

    fireEvent.click(screen.getByTitle('Skip this occurrence'));

    expect(screen.getByText('Skip Occurrence')).toBeInTheDocument();
    expect(screen.getByText(/Skip this occurrence of "Netflix"/)).toBeInTheDocument();
  });

  it('calls skip API when confirming skip', async () => {
    const onRefresh = vi.fn();
    const transaction = createTransaction({ frequency: 'MONTHLY' });
    render(<ScheduledTransactionList transactions={[transaction]} onRefresh={onRefresh} />);

    fireEvent.click(screen.getByTitle('Skip this occurrence'));
    fireEvent.click(screen.getByText('Skip'));

    await waitFor(() => {
      expect(mockSkip).toHaveBeenCalledWith(transaction.id);
    });

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Occurrence skipped');
    });
  });

  it('shows error toast when skip fails', async () => {
    mockSkip.mockRejectedValueOnce(new Error('Skip failed'));
    const transaction = createTransaction({ frequency: 'MONTHLY' });
    render(<ScheduledTransactionList transactions={[transaction]} />);

    fireEvent.click(screen.getByTitle('Skip this occurrence'));
    fireEvent.click(screen.getByText('Skip'));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to skip occurrence');
    });
  });

  // --- Category with color ---
  it('renders category with custom color style', () => {
    const transactions = [createTransaction({
      category: { name: 'Food', color: '#4CAF50' },
    })];
    render(<ScheduledTransactionList transactions={transactions} />);
    const categorySpan = screen.getByText('Food');
    expect(categorySpan).toBeInTheDocument();
    // The style should include the color
    expect(categorySpan.style.backgroundColor).toBeTruthy();
  });

  it('renders category without custom color', () => {
    const transactions = [createTransaction({
      category: { name: 'Misc', color: null },
    })];
    render(<ScheduledTransactionList transactions={transactions} />);
    expect(screen.getByText('Misc')).toBeInTheDocument();
  });

  // --- Next due date display ---
  it('renders dash when no next due date', () => {
    const transactions = [createTransaction({ nextDueDate: undefined })];
    render(<ScheduledTransactionList transactions={transactions} />);
    // Should show dashes for missing date
    const dashes = screen.getAllByText('\u2014');
    expect(dashes.length).toBeGreaterThan(0);
  });
});
