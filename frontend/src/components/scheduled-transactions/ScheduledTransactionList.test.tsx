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

  it('derives investment amount from qty * price + commission (base, no override)', () => {
    const transactions = [createTransaction({
      isInvestment: true,
      investmentAction: 'BUY',
      investmentQuantity: 10,
      investmentPrice: 100,
      investmentCommission: 9.99,
      amount: 0, // base amount column ignored for investments
    })];
    render(<ScheduledTransactionList transactions={transactions} />);
    // 10 * 100 + 9.99 = 1009.99, BUY -> negative
    expect(screen.getByText('-$1009.99')).toBeInTheDocument();
  });

  it('shows base vs override amount for an investment override that changes quantity', () => {
    const transactions = [createTransaction({
      isInvestment: true,
      investmentAction: 'BUY',
      investmentQuantity: 10,
      investmentPrice: 100,
      investmentCommission: 0,
      amount: 0,
      nextOverride: {
        amount: null,
        overrideDate: null,
        investmentQuantity: 5,
        investmentPrice: 100,
        investmentTotalAmount: null,
      },
    })];
    render(<ScheduledTransactionList transactions={transactions} />);
    // Base 10 * 100 = -1000; override 5 * 100 = -500
    expect(screen.getByText('-$1000.00')).toBeInTheDocument();
    expect(screen.getByText('-$500.00')).toBeInTheDocument();
  });

  it('shows base vs override amount for a DIVIDEND override that changes total', () => {
    const transactions = [createTransaction({
      isInvestment: true,
      investmentAction: 'DIVIDEND',
      investmentQuantity: null,
      investmentPrice: null,
      investmentTotalAmount: 50,
      investmentCommission: 0,
      amount: 0,
      nextOverride: {
        amount: null,
        overrideDate: null,
        investmentQuantity: null,
        investmentPrice: null,
        investmentTotalAmount: 125,
      },
    })];
    render(<ScheduledTransactionList transactions={transactions} />);
    expect(screen.getByText('+$50.00')).toBeInTheDocument();
    expect(screen.getByText('+$125.00')).toBeInTheDocument();
  });

  it('does not strike through when the investment override matches the base values', () => {
    const transactions = [createTransaction({
      isInvestment: true,
      investmentAction: 'BUY',
      investmentQuantity: 10,
      investmentPrice: 100,
      investmentCommission: 0,
      amount: 0,
      nextOverride: {
        amount: null,
        overrideDate: null,
        investmentQuantity: 10,
        investmentPrice: 100,
        investmentTotalAmount: null,
      },
    })];
    render(<ScheduledTransactionList transactions={transactions} />);
    expect(screen.getByText('-$1000.00')).toBeInTheDocument();
    // Only one occurrence -- no strikethrough sibling
    expect(screen.queryAllByText('-$1000.00').length).toBe(1);
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
    expect(screen.getByTitle('Post Transaction')).toBeInTheDocument();
  });

  it('shows skip button for active recurring transactions', () => {
    const transactions = [createTransaction({ isActive: true, frequency: 'MONTHLY' })];
    render(<ScheduledTransactionList transactions={transactions} />);
    expect(screen.getByTitle('Skip Occurrence')).toBeInTheDocument();
  });

  it('does not show skip button for ONCE frequency transactions', () => {
    const transactions = [createTransaction({ isActive: true, frequency: 'ONCE' })];
    render(<ScheduledTransactionList transactions={transactions} />);
    expect(screen.queryByTitle('Skip Occurrence')).not.toBeInTheDocument();
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
    expect(screen.getByTitle('Edit Schedule')).toBeInTheDocument();
  });

  it('does not show edit schedule button when onEdit is not provided', () => {
    const transactions = [createTransaction()];
    render(<ScheduledTransactionList transactions={transactions} />);
    expect(screen.queryByTitle('Edit Schedule')).not.toBeInTheDocument();
  });

  it('shows edit occurrence button when onEditOccurrence is provided and transaction is active', () => {
    const onEditOccurrence = vi.fn();
    const transactions = [createTransaction({ isActive: true })];
    render(<ScheduledTransactionList transactions={transactions} onEditOccurrence={onEditOccurrence} />);
    expect(screen.getByTitle('Edit Occurrence')).toBeInTheDocument();
  });

  it('does not show edit occurrence button for inactive transactions', () => {
    const onEditOccurrence = vi.fn();
    const transactions = [createTransaction({ isActive: false })];
    render(<ScheduledTransactionList transactions={transactions} onEditOccurrence={onEditOccurrence} />);
    expect(screen.queryByTitle('Edit Occurrence')).not.toBeInTheDocument();
  });

  it('does not show post and skip buttons for inactive transactions', () => {
    const transactions = [createTransaction({ isActive: false })];
    render(<ScheduledTransactionList transactions={transactions} />);
    expect(screen.queryByTitle('Post Transaction')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Skip Occurrence')).not.toBeInTheDocument();
  });

  // --- Edit button click ---
  it('calls onEdit when edit button is clicked', () => {
    const onEdit = vi.fn();
    const transaction = createTransaction();
    render(<ScheduledTransactionList transactions={[transaction]} onEdit={onEdit} />);

    fireEvent.click(screen.getByTitle('Edit Schedule'));
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

    fireEvent.click(screen.getByTitle('Edit Occurrence'));
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

    fireEvent.click(screen.getByTitle('Post Transaction'));

    expect(screen.getByText('Post Transaction')).toBeInTheDocument();
    expect(screen.getByText(/Post "Netflix"/)).toBeInTheDocument();
  });

  it('calls post API when confirming post', async () => {
    const onRefresh = vi.fn();
    const transaction = createTransaction();
    render(<ScheduledTransactionList transactions={[transaction]} onRefresh={onRefresh} />);

    fireEvent.click(screen.getByTitle('Post Transaction'));
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

    fireEvent.click(screen.getByTitle('Post Transaction'));

    // onPost should be called directly, not opening confirm dialog
    expect(onPost).toHaveBeenCalledWith(transaction);
    expect(screen.queryByText('Post Transaction')).not.toBeInTheDocument();
  });

  it('shows error toast when post fails', async () => {
    mockPost.mockRejectedValueOnce(new Error('Post failed'));
    const transaction = createTransaction();
    render(<ScheduledTransactionList transactions={[transaction]} />);

    fireEvent.click(screen.getByTitle('Post Transaction'));
    fireEvent.click(screen.getByText('Post'));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to post transaction');
    });
  });

  // --- Skip with confirmation ---
  it('opens confirm dialog when skip button is clicked', () => {
    const transactions = [createTransaction({ frequency: 'MONTHLY' })];
    render(<ScheduledTransactionList transactions={transactions} />);

    fireEvent.click(screen.getByTitle('Skip Occurrence'));

    expect(screen.getByText('Skip Occurrence')).toBeInTheDocument();
    expect(screen.getByText(/Skip this occurrence of "Netflix"/)).toBeInTheDocument();
  });

  it('calls skip API when confirming skip', async () => {
    const onRefresh = vi.fn();
    const transaction = createTransaction({ frequency: 'MONTHLY' });
    render(<ScheduledTransactionList transactions={[transaction]} onRefresh={onRefresh} />);

    fireEvent.click(screen.getByTitle('Skip Occurrence'));
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

    fireEvent.click(screen.getByTitle('Skip Occurrence'));
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

  // --- Payee from payee object (not payeeName) ---
  it('shows payee from payee object when payeeName is null', () => {
    const transactions = [createTransaction({
      name: 'Monthly Rent',
      payeeName: null,
      payee: { name: 'Landlord Inc' },
    })];
    render(<ScheduledTransactionList transactions={transactions} />);
    expect(screen.getByText('Landlord Inc')).toBeInTheDocument();
  });

  it('does not show payee when payee object name matches transaction name', () => {
    const transactions = [createTransaction({
      name: 'Netflix',
      payeeName: null,
      payee: { name: 'Netflix' },
    })];
    render(<ScheduledTransactionList transactions={transactions} />);
    const elements = screen.getAllByText('Netflix');
    expect(elements.length).toBe(1);
  });

  // --- formatAmount edge cases ---
  it('renders dash for NaN amount', () => {
    const transactions = [createTransaction({ amount: NaN })];
    render(<ScheduledTransactionList transactions={transactions} />);
    const dashes = screen.getAllByText('\u2014');
    expect(dashes.length).toBeGreaterThan(0);
  });

  // --- getDueDateStatus edge cases ---
  it('does not show due date badge when nextDueDate is null', () => {
    const transactions = [createTransaction({ nextDueDate: null })];
    render(<ScheduledTransactionList transactions={transactions} />);
    expect(screen.queryByText('Overdue')).not.toBeInTheDocument();
    expect(screen.queryByText('Due Today')).not.toBeInTheDocument();
  });

  it('does not show due date badge for invalid date string', () => {
    const transactions = [createTransaction({ nextDueDate: 'not-a-date' })];
    render(<ScheduledTransactionList transactions={transactions} />);
    expect(screen.queryByText('Overdue')).not.toBeInTheDocument();
  });

  // --- Override date same as nextDueDate (no strikethrough) ---
  it('shows only one date when override date equals next due date', () => {
    const transactions = [createTransaction({
      nextDueDate: '2025-04-01',
      nextOverride: {
        overrideDate: '2025-04-01',
        amount: -15.99,
      },
    })];
    render(<ScheduledTransactionList transactions={transactions} />);
    // Date should appear but NOT in strikethrough format (only one date shown)
    const dateElements = screen.getAllByText('2025-04-01');
    // No strikethrough: there should be only one element for that date
    expect(dateElements.length).toBe(1);
  });

  // --- categoryColorMap override ---
  it('uses categoryColorMap color when available', () => {
    const colorMap = new Map<string, string | null>();
    colorMap.set('cat-1', '#00FF00');
    const transactions = [createTransaction({
      category: { id: 'cat-1', name: 'Food', color: '#FF0000' },
    })];
    render(<ScheduledTransactionList transactions={transactions} categoryColorMap={colorMap} />);
    const categoryEl = screen.getByText('Food');
    // Color from map (#00FF00) should be used, not category color (#FF0000)
    expect(categoryEl.style.backgroundColor).toContain('00FF00');
  });

  it('falls back to category color when categoryColorMap has null entry', () => {
    const colorMap = new Map<string, string | null>();
    colorMap.set('cat-1', null);
    const transactions = [createTransaction({
      category: { id: 'cat-1', name: 'Food', color: '#FF0000' },
    })];
    render(<ScheduledTransactionList transactions={transactions} categoryColorMap={colorMap} />);
    const categoryEl = screen.getByText('Food');
    // Falls back to category.color
    expect(categoryEl.style.backgroundColor).toContain('FF0000');
  });

  // --- Long-press context menu ---
  it('opens context menu after long press on a row', async () => {
    const { act } = await import('@/test/render');
    const transaction = createTransaction({ isActive: true, frequency: 'MONTHLY' });
    render(<ScheduledTransactionList transactions={[transaction]} />);

    const row = screen.getByText('Netflix').closest('tr')!;

    // Simulate long press: mousedown and wait 800ms
    fireEvent.mouseDown(row);
    await act(async () => {
      await new Promise((res) => setTimeout(res, 800));
    });

    // Context menu should open with the transaction name
    expect(screen.getAllByText('Netflix').length).toBeGreaterThan(1);
    expect(screen.getByText('Post Transaction')).toBeInTheDocument();
  });

  it('context menu shows Skip Occurrence for recurring transactions', async () => {
    const { act } = await import('@/test/render');
    const transaction = createTransaction({ isActive: true, frequency: 'MONTHLY' });
    render(<ScheduledTransactionList transactions={[transaction]} />);

    const row = screen.getByText('Netflix').closest('tr')!;
    fireEvent.mouseDown(row);
    await act(async () => {
      await new Promise((res) => setTimeout(res, 800));
    });

    expect(screen.getByText('Skip Occurrence')).toBeInTheDocument();
  });

  it('context menu does not show Skip for ONCE frequency', async () => {
    const { act } = await import('@/test/render');
    const transaction = createTransaction({ isActive: true, frequency: 'ONCE' });
    render(<ScheduledTransactionList transactions={[transaction]} />);

    const row = screen.getByText('Netflix').closest('tr')!;
    fireEvent.mouseDown(row);
    await act(async () => {
      await new Promise((res) => setTimeout(res, 800));
    });

    expect(screen.queryByText('Skip Occurrence')).not.toBeInTheDocument();
  });

  it('context menu does not show Post/Skip for inactive transactions', async () => {
    const { act } = await import('@/test/render');
    const transaction = createTransaction({ isActive: false, frequency: 'MONTHLY', name: 'Inactive Sub' });
    render(<ScheduledTransactionList transactions={[transaction]} />);

    const row = screen.getByText('Inactive Sub').closest('tr')!;
    fireEvent.mouseDown(row);
    await act(async () => {
      await new Promise((res) => setTimeout(res, 800));
    });

    expect(screen.queryByText('Post Transaction')).not.toBeInTheDocument();
    expect(screen.queryByText('Skip Occurrence')).not.toBeInTheDocument();
  });

  it('context menu Post calls onPost when provided', async () => {
    const { act } = await import('@/test/render');
    const onPost = vi.fn();
    const transaction = createTransaction({ isActive: true, frequency: 'MONTHLY' });
    render(<ScheduledTransactionList transactions={[transaction]} onPost={onPost} />);

    const row = screen.getByText('Netflix').closest('tr')!;
    fireEvent.mouseDown(row);
    await act(async () => {
      await new Promise((res) => setTimeout(res, 800));
    });

    fireEvent.click(screen.getByText('Post Transaction'));
    expect(onPost).toHaveBeenCalledWith(transaction);
  });

  it('context menu Post opens confirm dialog when no onPost prop', async () => {
    const { act } = await import('@/test/render');
    const transaction = createTransaction({ isActive: true, frequency: 'MONTHLY' });
    render(<ScheduledTransactionList transactions={[transaction]} />);

    const row = screen.getByText('Netflix').closest('tr')!;
    fireEvent.mouseDown(row);
    await act(async () => {
      await new Promise((res) => setTimeout(res, 800));
    });

    fireEvent.click(screen.getByText('Post Transaction'));
    expect(screen.getByText(/Post "Netflix"/)).toBeInTheDocument();
  });

  it('context menu Skip opens confirm dialog', async () => {
    const { act } = await import('@/test/render');
    const transaction = createTransaction({ isActive: true, frequency: 'MONTHLY' });
    render(<ScheduledTransactionList transactions={[transaction]} />);

    const row = screen.getByText('Netflix').closest('tr')!;
    fireEvent.mouseDown(row);
    await act(async () => {
      await new Promise((res) => setTimeout(res, 800));
    });

    // Click the "Skip Occurrence" button inside the context menu (it's inside the Modal)
    const skipButtons = screen.getAllByText('Skip Occurrence');
    fireEvent.click(skipButtons[0]);
    // After clicking, the confirm dialog for "Skip" should appear
    expect(screen.getByText(/Skip this occurrence of "Netflix"/)).toBeInTheDocument();
  });

  it('context menu Delete opens confirm dialog', async () => {
    const { act } = await import('@/test/render');
    const transaction = createTransaction({ isActive: true, frequency: 'MONTHLY' });
    render(<ScheduledTransactionList transactions={[transaction]} />);

    const row = screen.getByText('Netflix').closest('tr')!;
    fireEvent.mouseDown(row);
    await act(async () => {
      await new Promise((res) => setTimeout(res, 800));
    });

    fireEvent.click(screen.getByText('Delete'));
    expect(screen.getByText('Delete Scheduled Transaction')).toBeInTheDocument();
  });

  it('context menu Edit Schedule calls onEdit', async () => {
    const { act } = await import('@/test/render');
    const onEdit = vi.fn();
    const transaction = createTransaction({ isActive: true, frequency: 'MONTHLY' });
    render(<ScheduledTransactionList transactions={[transaction]} onEdit={onEdit} />);

    const row = screen.getByText('Netflix').closest('tr')!;
    fireEvent.mouseDown(row);
    await act(async () => {
      await new Promise((res) => setTimeout(res, 800));
    });

    fireEvent.click(screen.getByText('Edit Schedule'));
    expect(onEdit).toHaveBeenCalledWith(transaction);
  });

  it('context menu Edit Occurrence calls onEditOccurrence', async () => {
    const { act } = await import('@/test/render');
    const onEditOccurrence = vi.fn();
    const transaction = createTransaction({ isActive: true, frequency: 'MONTHLY' });
    render(<ScheduledTransactionList transactions={[transaction]} onEditOccurrence={onEditOccurrence} />);

    const row = screen.getByText('Netflix').closest('tr')!;
    fireEvent.mouseDown(row);
    await act(async () => {
      await new Promise((res) => setTimeout(res, 800));
    });

    fireEvent.click(screen.getByText('Edit Occurrence'));
    expect(onEditOccurrence).toHaveBeenCalledWith(transaction);
  });

  it('does not open context menu when touch moves beyond threshold before long press fires', async () => {
    const { act } = await import('@/test/render');
    const transaction = createTransaction({ isActive: true, frequency: 'MONTHLY' });
    render(<ScheduledTransactionList transactions={[transaction]} />);

    const row = screen.getByText('Netflix').closest('tr')!;

    // Start a touch (records touch position)
    fireEvent.touchStart(row, {
      touches: [{ clientX: 0, clientY: 0 }],
    });

    // Move beyond the 10px threshold to cancel the long press timer
    fireEvent.touchMove(row, {
      touches: [{ clientX: 50, clientY: 50 }],
    });

    await act(async () => {
      await new Promise((res) => setTimeout(res, 800));
    });

    // Context menu should NOT appear since touch moved beyond threshold
    expect(screen.queryByText('Post Transaction')).not.toBeInTheDocument();
  });

  it('mouseUp cancels long press before context menu opens', async () => {
    const { act } = await import('@/test/render');
    const transaction = createTransaction({ isActive: true, frequency: 'MONTHLY' });
    render(<ScheduledTransactionList transactions={[transaction]} />);

    const row = screen.getByText('Netflix').closest('tr')!;
    fireEvent.mouseDown(row);
    fireEvent.mouseUp(row); // cancel before 750ms

    await act(async () => {
      await new Promise((res) => setTimeout(res, 800));
    });

    expect(screen.queryByText('Post Transaction')).not.toBeInTheDocument();
  });

  it('row click is ignored immediately after long press was triggered', async () => {
    const { act } = await import('@/test/render');
    const onEdit = vi.fn();
    const transaction = createTransaction({ isActive: true });
    render(<ScheduledTransactionList transactions={[transaction]} onEdit={onEdit} />);

    const row = screen.getAllByText('Netflix')[0].closest('tr')!;
    fireEvent.mouseDown(row);
    await act(async () => {
      await new Promise((res) => setTimeout(res, 800));
    });

    // While context menu is open, clicking the row would trigger onClick which
    // checks longPressTriggered -- it should be true so onEdit is not called
    fireEvent.click(row);
    expect(onEdit).not.toHaveBeenCalled();
  });

  // --- occurrencesRemaining: null (no badge) ---
  it('does not show occurrences remaining when null', () => {
    const transactions = [createTransaction({ occurrencesRemaining: null })];
    render(<ScheduledTransactionList transactions={transactions} />);
    expect(screen.queryByText(/left/)).not.toBeInTheDocument();
  });

  // --- Split badge with no splits array ---
  it('displays Split (0) when splits array is empty', () => {
    const transactions = [createTransaction({
      isSplit: true,
      splits: [],
    })];
    render(<ScheduledTransactionList transactions={transactions} />);
    expect(screen.getByText('Split (0)')).toBeInTheDocument();
  });

  // --- overrideCount singular vs plural ---
  it('shows singular modified text for overrideCount of 1', () => {
    const transactions = [createTransaction({ overrideCount: 1 })];
    render(<ScheduledTransactionList transactions={transactions} />);
    const badge = screen.getByText('1 modified');
    expect(badge.title).toContain('1 upcoming occurrence modified');
  });

  it('shows plural modified text for overrideCount > 1', () => {
    const transactions = [createTransaction({ overrideCount: 2 })];
    render(<ScheduledTransactionList transactions={transactions} />);
    const badge = screen.getByText('2 modified');
    expect(badge.title).toContain('2 upcoming occurrences modified');
  });
});
