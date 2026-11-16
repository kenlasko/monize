import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@/test/render';
import { DuplicateTransactionReport } from './DuplicateTransactionReport';
import { usePreferencesStore } from '@/store/preferencesStore';
import type { UserPreferences } from '@/types/auth';
import type {
  DuplicateGroup,
  DuplicateTransactionItem,
  DuplicateTransactionsResponse,
} from '@/types/built-in-reports';

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrency: (n: number) => `$${n.toFixed(2)}`,
      formatCurrencyCompact: (n: number) => `$${n.toFixed(0)}`,
      defaultCurrency: 'CAD',
    }),
  };
});

const mockRange = vi.hoisted(() => ({ start: '2025-01-01', end: '2025-03-31' }));
vi.mock('@/hooks/useDateRange', () => ({
  useDateRange: () => ({
    dateRange: '3m',
    setDateRange: vi.fn(),
    resolvedRange: mockRange,
    isValid: true,
  }),
}));

vi.mock('@/lib/utils', async (importOriginal) => ({
  // The real module for the rest: `useDateFormat` formats the row dates through
  // its `formatDate`, and ExportDropdown merges classes with its `cn`.
  ...(await importOriginal<typeof import('@/lib/utils')>()),
  parseLocalDate: (d: string) => new Date(d + 'T00:00:00'),
}));

const rangeSelectorProps = vi.hoisted(() => ({ current: null as null | { ranges: readonly string[]; labels?: Record<string, string> } }));
vi.mock('@/components/ui/DateRangeSelector', () => ({
  DateRangeSelector: (props: { ranges: readonly string[]; labels?: Record<string, string> }) => {
    rangeSelectorProps.current = props;
    return <div data-testid="date-range-selector" />;
  },
}));

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

const mockGetDuplicateTransactions = vi.fn();
vi.mock('@/lib/built-in-reports', () => ({
  builtInReportsApi: {
    getDuplicateTransactions: (...args: unknown[]) => mockGetDuplicateTransactions(...args),
  },
}));

const mockGetCategories = vi.fn();
vi.mock('@/lib/categories', () => ({
  categoriesApi: { getAll: () => mockGetCategories() },
}));

const mockBulkDelete = vi.fn();
vi.mock('@/lib/transactions', () => ({
  transactionsApi: { bulkDelete: (...args: unknown[]) => mockBulkDelete(...args) },
}));

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('react-hot-toast', () => ({ default: toastMock }));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

function tx(overrides: Partial<DuplicateTransactionItem> & { id: string }): DuplicateTransactionItem {
  return {
    transactionDate: '2025-02-01',
    amount: -50,
    currencyCode: 'CAD',
    accountId: 'acct-chequing',
    payeeName: 'Store A',
    description: null,
    accountName: 'Chequing',
    categoryId: 'cat-groceries',
    categoryName: 'Food: Groceries',
    isSplit: false,
    status: 'UNRECONCILED',
    ...overrides,
  };
}

function group(overrides: Partial<DuplicateGroup> & { key: string; transactions: DuplicateTransactionItem[] }): DuplicateGroup {
  return {
    confidence: 'high',
    reason: 'Same date, amount, and payee',
    reasonCode: 'same_date_amount_payee',
    windowDays: 1,
    ...overrides,
  };
}

function response(groups: DuplicateGroup[], summary: Partial<DuplicateTransactionsResponse['summary']> = {}): DuplicateTransactionsResponse {
  const count = (level: DuplicateGroup['confidence']) => groups.filter((g) => g.confidence === level).length;
  return {
    groups,
    summary: {
      totalGroups: groups.length,
      veryHighCount: count('very_high'),
      highCount: count('high'),
      mediumCount: count('medium'),
      lowCount: count('low'),
      potentialSavings: 0,
      ...summary,
    },
  };
}

const veryHigh = group({
  key: 'g-vh',
  confidence: 'very_high',
  reason: 'Same account, date, amount, payee, and category',
  reasonCode: 'same_date_amount_payee_category',
  transactions: [tx({ id: 'vh-1' }), tx({ id: 'vh-2', status: 'RECONCILED' }), tx({ id: 'vh-3' })],
});
const high = group({
  key: 'g-h',
  transactions: [
    tx({ id: 'h-1', payeeName: 'Hardware', amount: -20, categoryId: 'cat-tools', categoryName: 'Tools' }),
    tx({ id: 'h-2', payeeName: 'Hardware', amount: -20, categoryId: null, categoryName: null }),
  ],
});

async function renderReport() {
  await act(async () => {
    render(<DuplicateTransactionReport />);
  });
}

describe('DuplicateTransactionReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRange.start = '2025-01-01';
    mockRange.end = '2025-03-31';
    mockGetCategories.mockResolvedValue([]);
    usePreferencesStore.setState({
      preferences: { lockReconciledTransactions: false } as UserPreferences,
    });
  });

  it('shows loading state initially', () => {
    mockGetDuplicateTransactions.mockReturnValue(new Promise(() => {}));
    mockGetCategories.mockReturnValue(new Promise(() => {}));
    render(<DuplicateTransactionReport />);
    expect(document.querySelector('.animate-pulse')).toBeTruthy();
  });

  it('renders clean message when no duplicates found', async () => {
    mockGetDuplicateTransactions.mockResolvedValue(response([]));
    await renderReport();
    expect(screen.getByText(/No potential duplicate transactions found/)).toBeInTheDocument();
    // Nothing to select, so no selection bar.
    expect(screen.queryByText('Select duplicates:')).not.toBeInTheDocument();
  });

  it('renders the summary cards, very high included', async () => {
    mockGetDuplicateTransactions.mockResolvedValue(response([veryHigh, high], { potentialSavings: 150 }));
    await renderReport();
    expect(screen.getByText('Potential Duplicates')).toBeInTheDocument();
    expect(screen.getByText('Very High Confidence')).toBeInTheDocument();
    expect(screen.getByText('High Confidence')).toBeInTheDocument();
    expect(screen.getByText('Medium Confidence')).toBeInTheDocument();
    expect(screen.getByText('Potential Impact')).toBeInTheDocument();
  });

  it('labels each group with its translated confidence and reason', async () => {
    mockGetDuplicateTransactions.mockResolvedValue(
      response([
        veryHigh,
        group({
          key: 'g-m',
          confidence: 'medium',
          reason: 'Same payee and amount within 3 day(s)',
          reasonCode: 'same_payee_amount_within_days',
          windowDays: 3,
          transactions: [tx({ id: 'm-1', payeeName: 'Store B' }), tx({ id: 'm-2', payeeName: 'Store B', transactionDate: '2025-02-03' })],
        }),
        group({
          key: 'g-l',
          confidence: 'low',
          reason: 'Same amount within 1 day(s)',
          reasonCode: 'same_amount_within_days',
          windowDays: 1,
          transactions: [tx({ id: 'l-1', description: 'Refund' }), tx({ id: 'l-2', payeeName: 'Other' })],
        }),
      ]),
    );
    await renderReport();
    expect(screen.getByText('Very high confidence')).toBeInTheDocument();
    expect(screen.getByText('Same account, date, amount, payee, and category')).toBeInTheDocument();
    expect(screen.getByText('Medium confidence')).toBeInTheDocument();
    expect(screen.getByText('Same payee and amount within 3 days')).toBeInTheDocument();
    expect(screen.getByText('Low confidence')).toBeInTheDocument();
    expect(screen.getByText('Same amount within 1 day')).toBeInTheDocument();
    expect(screen.getByText('Refund')).toBeInTheDocument();
    expect(screen.getByText('3 transactions')).toBeInTheDocument();
  });

  it("shows each transaction's category, uncategorized and split included", async () => {
    mockGetCategories.mockResolvedValue([
      { id: 'cat-tools', name: 'Tools', parentId: null, color: '#ff0000', effectiveColor: '#ff0000', icon: null, effectiveIcon: null },
    ]);
    mockGetDuplicateTransactions.mockResolvedValue(
      response([
        high,
        group({
          key: 'g-s',
          transactions: [
            tx({ id: 's-1', payeeName: 'Split Shop', categoryId: null, categoryName: null, isSplit: true }),
            tx({ id: 's-2', payeeName: 'Split Shop', categoryId: null, categoryName: null, isSplit: true }),
          ],
        }),
      ]),
    );
    await renderReport();
    expect(screen.getByText('Tools')).toBeInTheDocument();
    expect(screen.getByText('Uncategorized')).toBeInTheDocument();
    expect(screen.getAllByText('Split')).toHaveLength(2);
    // The pill takes the category's colour from the category list.
    expect(screen.getByText('Tools').closest('span[style]')?.getAttribute('style')).toContain('#ff0000');
  });

  it('still renders the report when the category lookup fails', async () => {
    mockGetCategories.mockRejectedValue(new Error('down'));
    mockGetDuplicateTransactions.mockResolvedValue(response([high]));
    await renderReport();
    expect(screen.getByText('Tools')).toBeInTheDocument();
  });

  it('renders transaction without payeeName as Unknown', async () => {
    mockGetDuplicateTransactions.mockResolvedValue(
      response([group({ key: 'g', transactions: [tx({ id: 'tx-1', payeeName: null, accountName: null })] })]),
    );
    await renderReport();
    expect(screen.getByText('Unknown')).toBeInTheDocument();
    expect(screen.getByText('Unknown account')).toBeInTheDocument();
  });

  it('opens the register on that exact payee, as one quoted term', async () => {
    mockGetDuplicateTransactions.mockResolvedValue(
      response([group({ key: 'g', transactions: [tx({ id: 'tx-1', payeeName: 'Costco Gas' }), tx({ id: 'tx-2', payeeName: 'Costco Gas' })] })]),
    );
    await renderReport();
    fireEvent.click(screen.getAllByText('Costco Gas')[0]);
    expect(mockPush).toHaveBeenCalledWith('/transactions?search=payee%3A%3D%22Costco%20Gas%22');
  });

  it('offers the longer ranges up to All Time', async () => {
    mockGetDuplicateTransactions.mockResolvedValue(response([]));
    await renderReport();
    expect(rangeSelectorProps.current?.ranges).toEqual(['1m', '3m', '6m', '1y', '2y', '5y', '10y', 'all']);
    expect(rangeSelectorProps.current?.labels).toEqual({ all: 'All Time' });
  });

  it('sends no start date for All Time rather than an empty string', async () => {
    mockRange.start = '';
    mockGetDuplicateTransactions.mockResolvedValue(response([]));
    await renderReport();
    expect(mockGetDuplicateTransactions).toHaveBeenCalledWith({
      startDate: undefined,
      endDate: '2025-03-31',
      sensitivity: 'medium',
    });
  });

  it('selects every extra copy at a level, keeping the reconciled one', async () => {
    mockGetDuplicateTransactions.mockResolvedValue(response([veryHigh, high]));
    await renderReport();

    fireEvent.click(screen.getByRole('button', { name: 'Very high confidence (1)' }));

    // vh-1, vh-2 (reconciled, kept), vh-3, then the high group's two.
    const ticked = (screen.getAllByRole('checkbox') as HTMLInputElement[]).map((box) => box.checked);
    expect(ticked).toEqual([true, false, true, false, false]);
    expect(screen.getByText('2 selected')).toBeInTheDocument();
    expect(screen.getByText('Reconciled')).toBeInTheDocument();
  });

  it('ticks one copy of a pair that is reconciled on both sides', async () => {
    const reconciledPair = group({
      key: 'g-m',
      confidence: 'medium',
      reason: 'Same date and amount',
      reasonCode: 'same_date_amount',
      transactions: [tx({ id: 'm-1', status: 'RECONCILED' }), tx({ id: 'm-2', payeeName: 'Store B', status: 'RECONCILED' })],
    });
    mockGetDuplicateTransactions.mockResolvedValue(response([reconciledPair]));
    await renderReport();

    fireEvent.click(screen.getByRole('button', { name: 'Medium confidence (1)' }));

    const ticked = (screen.getAllByRole('checkbox') as HTMLInputElement[]).map((box) => box.checked);
    expect(ticked).toEqual([false, true]);
    expect(screen.getByText('1 selected')).toBeInTheDocument();
  });

  it('leaves reconciled copies unticked while the reconciled lock is on', async () => {
    usePreferencesStore.setState({
      preferences: { lockReconciledTransactions: true } as UserPreferences,
    });
    const lockedPair = group({
      key: 'g-l',
      transactions: [tx({ id: 'l-1', status: 'RECONCILED' }), tx({ id: 'l-2', status: 'RECONCILED' })],
    });
    mockGetDuplicateTransactions.mockResolvedValue(response([lockedPair]));
    await renderReport();

    fireEvent.click(screen.getByRole('button', { name: 'High confidence (1)' }));

    expect(screen.getByText('None selected')).toBeInTheDocument();
  });

  it('lets a mistaken row be unticked and deletes only what is left', async () => {
    mockGetDuplicateTransactions.mockResolvedValue(response([veryHigh, high]));
    mockBulkDelete.mockResolvedValue({ deleted: 1 });
    await renderReport();

    fireEvent.click(screen.getByRole('button', { name: 'Very high confidence (1)' }));
    fireEvent.click(screen.getAllByRole('checkbox', { name: /^Select Store A on / })[2]);
    expect(mockPush).not.toHaveBeenCalled();
    expect(screen.getByText('1 selected')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Delete selected (1)' }));
    const dialog = screen.getByTestId('confirm-dialog-text');
    expect(within(dialog).getByText('1 transaction will be permanently deleted.')).toBeInTheDocument();

    mockGetDuplicateTransactions.mockResolvedValue(
      response([{ ...veryHigh, transactions: veryHigh.transactions.filter((t) => t.id !== 'vh-1') }, high]),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    });

    expect(mockBulkDelete).toHaveBeenCalledWith({ mode: 'ids', transactionIds: ['vh-1'] });
    expect(toastMock.success).toHaveBeenCalledWith('1 duplicate transaction deleted');
    // The report is fetched again, and the selection does not survive it.
    expect(mockGetDuplicateTransactions).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.getByText('None selected')).toBeInTheDocument());
  });

  it('warns when every copy in a group is selected', async () => {
    mockGetDuplicateTransactions.mockResolvedValue(response([high]));
    await renderReport();
    for (const checkbox of screen.getAllByRole('checkbox')) fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole('button', { name: 'Delete selected (2)' }));
    expect(
      within(screen.getByTestId('confirm-dialog-text')).getByText(
        '2 transactions will be permanently deleted. In 1 group every copy is selected, so no original will remain.',
      ),
    ).toBeInTheDocument();
  });

  it('keeps the selection and reports the failure when the delete is refused', async () => {
    mockGetDuplicateTransactions.mockResolvedValue(response([high]));
    mockBulkDelete.mockRejectedValue(new Error('refused'));
    await renderReport();
    fireEvent.click(screen.getAllByRole('checkbox')[1]);
    fireEvent.click(screen.getByRole('button', { name: 'Delete selected (1)' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    });
    expect(toastMock.error).toHaveBeenCalled();
    expect(mockGetDuplicateTransactions).toHaveBeenCalledTimes(1);
    expect(screen.getByText('1 selected')).toBeInTheDocument();
  });

  it('disables delete and clear with nothing selected, and clear empties the selection', async () => {
    mockGetDuplicateTransactions.mockResolvedValue(response([high]));
    await renderReport();
    expect(screen.getByRole('button', { name: 'Delete selected' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Clear selection' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'High confidence (1)' }));
    expect(screen.getByText('1 selected')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(screen.getByText('None selected')).toBeInTheDocument();
  });

  it('only offers selection for levels that have groups', async () => {
    mockGetDuplicateTransactions.mockResolvedValue(response([high]));
    await renderReport();
    expect(screen.getByRole('button', { name: 'High confidence (1)' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Very high confidence/ })).not.toBeInTheDocument();
  });

  it('renders info box about duplicate detection', async () => {
    mockGetDuplicateTransactions.mockResolvedValue(response([]));
    await renderReport();
    expect(screen.getByText('How duplicates are detected:')).toBeInTheDocument();
    expect(screen.getByText('Very high: Same account, date, amount, payee, and category')).toBeInTheDocument();
  });

  it('renders sensitivity selector', async () => {
    mockGetDuplicateTransactions.mockResolvedValue(response([]));
    await renderReport();
    expect(screen.getByText('Sensitivity:')).toBeInTheDocument();
  });

  it('surfaces a retryable error state when the API fails', async () => {
    mockGetDuplicateTransactions.mockRejectedValue(new Error('Network error'));
    await renderReport();
    expect(screen.getByText(/failed to load report data/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  // The toolbar holds the date controls, so it stays mounted while the report
  // reloads and after a failed load: an early return for either state would
  // unmount it, and the focus of whoever is using it.
  it('keeps the toolbar mounted while loading and after a failed load', async () => {
    mockGetCategories.mockReturnValue(new Promise(() => {}));
    let fail!: (error: Error) => void;
    mockGetDuplicateTransactions.mockReturnValue(
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
    );
    render(<DuplicateTransactionReport />);
    const toolbar = screen.getByTestId('date-range-selector');
    expect(document.querySelector('.animate-pulse')).toBeTruthy();

    await act(async () => {
      fail(new Error('boom'));
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Try Again' })).toBeInTheDocument();
    });
    expect(screen.getByTestId('date-range-selector')).toBe(toolbar);
  });
});
