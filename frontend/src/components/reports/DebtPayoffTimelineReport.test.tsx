import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@/test/render';
import { DebtPayoffTimelineReport } from './DebtPayoffTimelineReport';
import { axisTickLabel } from '@/lib/chart-sampling';

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrencyCompact: (n: number) => `$${n.toFixed(0)}`,
      formatCurrency: (n: number) => `$${n.toFixed(2)}`,
      formatCurrencyAxis: (n: number) => `$${n}`,
      defaultCurrency: 'CAD',
    }),
  };
});
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div data-testid="responsive-container">{children}</div>,
  // `data` is serialized onto the node so a test can assert on what the chart
  // was actually handed. Issue #1244 was a figure derived from that array, and
  // a mock that swallows it cannot tell a sampled series from a full one.
  BarChart: ({ children, data }: any) => (
    <div data-testid="bar-chart" data-rows={JSON.stringify(data ?? [])}>{children}</div>
  ),
  AreaChart: ({ children, data }: any) => (
    <div data-testid="area-chart" data-rows={JSON.stringify(data ?? [])}>{children}</div>
  ),
  Bar: () => null,
  Area: () => null,
  XAxis: ({ tickFormatter }: any) => <div data-testid="x-axis">{tickFormatter ? tickFormatter(100) : ''}</div>,
  YAxis: ({ tickFormatter }: any) => <div data-testid="y-axis">{tickFormatter ? tickFormatter(1000) : ''}</div>,
  CartesianGrid: () => null,
  Tooltip: ({ content }: any) => {
    if (typeof content === 'function') {
      return (
        <div data-testid="tooltip">
          {content({ active: true, payload: [{ name: 'Remaining Balance', value: 100, color: '#000', dataKey: 'historicalBalance' }, { name: 'Remaining Balance', value: 100, color: '#000', dataKey: 'historicalBalance' }, { name: 'Other', value: undefined, color: '#000', dataKey: 'projectedBalance' }], label: 'Jan 2024' })}
          {content({ active: false, payload: [], label: '' })}
        </div>
      );
    }
    if (content && content.type) {
      const C = content.type;
      return (
        <div data-testid="tooltip">
          <C active={true} payload={[{ name: 'Remaining Balance', value: 100, color: '#000', dataKey: 'historicalBalance' }, { name: 'Remaining Balance', value: 100, color: '#000', dataKey: 'historicalBalance' }, { name: 'Other', value: undefined, color: '#000', dataKey: 'projectedBalance' }]} label="Jan 2024" />
          <C active={false} payload={[]} label="" />
        </div>
      );
    }
    return null;
  },
  Legend: () => null,
  // `x` is serialized: a ReferenceLine whose value matches no axis category is
  // silently not drawn by recharts, so a mock that discards it cannot see the
  // marker disappear.
  ReferenceLine: ({ x }: any) => <div data-testid="reference-line" data-x={String(x)} />,
}));

const mockGetAllAccounts = vi.fn();
const mockGetAllTransactions = vi.fn();
const mockGetAllPages = vi.fn();

vi.mock('@/lib/accounts', () => ({
  accountsApi: {
    getAll: (...args: any[]) => mockGetAllAccounts(...args),
  },
}));

const mockGetRateChanges = vi.fn();
// Only the API is mocked; supportsRateChanges is the predicate under test here,
// so it stays real rather than being restated in the mock.
vi.mock('@/lib/loan-rate-changes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/loan-rate-changes')>()),
  loanRateChangesApi: {
    getAll: (...args: any[]) => mockGetRateChanges(...args),
  },
}));

vi.mock('@/lib/transactions', () => ({
  transactionsApi: {
    getAll: (...args: any[]) => mockGetAllTransactions(...args),
    getAllPages: (...args: any[]) => mockGetAllPages(...args),
  },
}));

vi.mock('@/lib/pdf-export', () => ({
  exportToPdf: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('DebtPayoffTimelineReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Most cases have no recorded rate history; the ones that do override it.
    mockGetRateChanges.mockResolvedValue([]);
    // Default to a single-page result so the report's pagination loop
    // terminates. Individual tests override data/pagination as needed.
    mockGetAllTransactions.mockResolvedValue({ data: [], pagination: { hasMore: false } });
  });

  it('shows loading state initially', async () => {
    mockGetAllAccounts.mockReturnValue(new Promise(() => {}));
    render(<DebtPayoffTimelineReport />);
    expect(document.querySelector('.animate-pulse')).toBeTruthy();
    // Flush the secondary transactions fetch resolution so its state update is
    // wrapped in act().
    await act(async () => {});
  });

  it('renders empty state when no debt accounts', async () => {
    mockGetAllAccounts.mockResolvedValue([]);
    render(<DebtPayoffTimelineReport />);
    await waitFor(() => {
      expect(screen.getByText(/No debt accounts found/)).toBeInTheDocument();
    });
  });

  it('fetches the loan\'s separately-booked interest expenses (issue #893)', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1',
        name: 'Mortgage',
        accountType: 'MORTGAGE',
        currentBalance: -100000,
        openingBalance: -120000,
        interestRate: 5.0,
        paymentAmount: 800,
        paymentFrequency: 'MONTHLY',
        interestCategoryId: 'cat-int',
        sourceAccountId: 'src-1',
        mortgageType: 'ANNUITY',
        isClosed: false,
      },
    ]);
    mockGetAllPages.mockResolvedValue([
      { id: 'i1', transactionDate: '2024-06-01', amount: -300, categoryId: 'cat-int', isTransfer: false },
    ]);

    render(<DebtPayoffTimelineReport />);

    await waitFor(() =>
      expect(mockGetAllPages).toHaveBeenCalledWith({
        categoryIds: ['cat-int'],
        accountIds: ['src-1'],
      }),
    );
  });

  it('does not ask for a line of credit\'s rate history, which the API rejects', async () => {
    // /accounts/:id/rate-changes answers 400 for a LINE_OF_CREDIT
    // (LoanRateChangesService.verifyLoanAccount), and this report lists LOCs. A
    // rejection here lands in the shared error state and replaces the whole
    // report -- selector included -- and because the selection is persisted it
    // stays broken across reloads. The mocks resolving [] for every account type
    // is why this went unnoticed: a fixture the API cannot produce.
    mockGetRateChanges.mockRejectedValue(new Error('400 not a loan account'));
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loc-1', name: 'LOC', accountType: 'LINE_OF_CREDIT',
        currentBalance: -3000, openingBalance: -5000, interestRate: 8,
        paymentAmount: 200, paymentFrequency: 'MONTHLY',
        mortgageType: 'ANNUITY', isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [{ id: 'tx-1', transactionDate: '2024-01-15', amount: 200, linkedTransaction: null }],
      pagination: { hasMore: false },
    });

    render(<DebtPayoffTimelineReport />);

    await waitFor(() => {
      expect(screen.getByText('Select Account')).toBeInTheDocument();
    });
    expect(mockGetRateChanges).not.toHaveBeenCalled();
    expect(screen.queryByText('Try again')).not.toBeInTheDocument();
  });

  it('loads the loan rate history for the selected account', async () => {
    // The report used to pass [] as the rate history, so its projection ran at
    // the account's possibly stale scalar rate while the loan detail page ran at
    // the recorded one -- the same loan with two payoff dates.
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'Mortgage', accountType: 'MORTGAGE',
        currentBalance: -100000, openingBalance: -100000, interestRate: 5,
        paymentAmount: 500, paymentFrequency: 'MONTHLY',
        mortgageType: 'ANNUITY', isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [{ id: 'tx-1', transactionDate: '2024-01-15', amount: 500, linkedTransaction: null }],
      pagination: { hasMore: false },
    });
    render(<DebtPayoffTimelineReport />);
    await waitFor(() => expect(mockGetRateChanges).toHaveBeenCalledWith('loan-1'));
  });

  it('stays in the loading state until the interest fetch resolves (no zero-interest flicker)', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1',
        name: 'Mortgage',
        accountType: 'MORTGAGE',
        currentBalance: -100000,
        openingBalance: -120000,
        interestRate: 5.0,
        paymentAmount: 800,
        paymentFrequency: 'MONTHLY',
        interestCategoryId: 'cat-int',
        sourceAccountId: 'src-1',
        mortgageType: 'ANNUITY',
        isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [{ id: 'tx-1', transactionDate: '2024-06-01', amount: 800, linkedTransaction: null }],
      pagination: { hasMore: false },
    });
    let resolveInterest!: (value: unknown[]) => void;
    mockGetAllPages.mockReturnValue(
      new Promise((resolve) => {
        resolveInterest = resolve;
      }),
    );

    render(<DebtPayoffTimelineReport />);

    // Accounts and transactions have resolved, but the separate-interest fetch
    // is still in flight. An interest list that has not arrived looks exactly
    // like one that is genuinely empty, so the report must keep the skeleton
    // rather than paint a schedule of zero interest and then snap to the booked
    // figures.
    await act(async () => {});
    await act(async () => {});
    expect(document.querySelector('.animate-pulse')).toBeTruthy();
    expect(screen.queryByText('Current Balance')).not.toBeInTheDocument();

    await act(async () => {
      resolveInterest([]);
    });
    await waitFor(() => {
      expect(screen.getByText('Current Balance')).toBeInTheDocument();
    });
  });

  it('renders controls with account selector when accounts exist', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1',
        name: 'Car Loan',
        accountType: 'LOAN',
        currentBalance: -15000,
        openingBalance: -25000,
        interestRate: 5.5,
        paymentAmount: 500,
        paymentFrequency: 'MONTHLY',
        mortgageType: 'ANNUITY',
        isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({ data: [], pagination: { hasMore: false } });
    render(<DebtPayoffTimelineReport />);
    await waitFor(() => {
      expect(screen.getByText('Select Account')).toBeInTheDocument();
    });
    expect(screen.getByText('Balance Over Time')).toBeInTheDocument();
    expect(screen.getByText('Payment Breakdown')).toBeInTheDocument();
    expect(screen.getByText('Principal vs Interest')).toBeInTheDocument();
  });

  it('renders summary cards when account is selected', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1',
        name: 'Mortgage',
        accountType: 'MORTGAGE',
        currentBalance: -200000,
        openingBalance: -300000,
        interestRate: 4.0,
        paymentAmount: 1500,
        paymentFrequency: 'MONTHLY',
        mortgageType: 'CANADIAN_FIXED',
        isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-06-01', amount: 1000, linkedTransaction: null },
      ],
      pagination: { hasMore: false },
    });
    render(<DebtPayoffTimelineReport />);
    await waitFor(() => {
      expect(screen.getByText('Current Balance')).toBeInTheDocument();
    });
    expect(screen.getByText('Principal Paid')).toBeInTheDocument();
  });

  it('renders account details section', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1',
        name: 'Car Loan',
        accountType: 'LOAN',
        currentBalance: -5000,
        openingBalance: -15000,
        interestRate: 5.0,
        paymentAmount: 300,
        paymentFrequency: 'MONTHLY',
        mortgageType: 'ANNUITY',
        isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-01-15', amount: 300, linkedTransaction: null },
      ],
      pagination: { hasMore: false },
    });
    render(<DebtPayoffTimelineReport />);
    await waitFor(() => {
      expect(screen.getByText('Account Details')).toBeInTheDocument();
    });
    expect(screen.getByText('Account Type')).toBeInTheDocument();
    expect(screen.getByText('Interest Rate')).toBeInTheDocument();
    expect(screen.getByText('5%')).toBeInTheDocument();
    expect(screen.getByText('Payments Made')).toBeInTheDocument();
  });

  it('renders line of credit account type label', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loc-1',
        name: 'LOC',
        accountType: 'LINE_OF_CREDIT',
        currentBalance: -3000,
        openingBalance: -10000,
        interestRate: null,
        paymentAmount: null,
        paymentFrequency: null,
        mortgageType: 'ANNUITY',
        isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-03-01', amount: 500, linkedTransaction: null },
      ],
      pagination: { hasMore: false },
    });
    render(<DebtPayoffTimelineReport />);
    await waitFor(() => {
      expect(screen.getByText('Line of Credit')).toBeInTheDocument();
    });
    expect(screen.getByText('Not set')).toBeInTheDocument();
  });

  it('shows empty payment history message when no transactions', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1',
        name: 'New Loan',
        accountType: 'LOAN',
        currentBalance: -10000,
        openingBalance: -10000,
        interestRate: 5.0,
        paymentAmount: null,
        paymentFrequency: null,
        mortgageType: 'ANNUITY',
        isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({ data: [], pagination: { hasMore: false } });
    render(<DebtPayoffTimelineReport />);
    await waitFor(() => {
      expect(screen.getByText(/No payment history found/)).toBeInTheDocument();
    });
  });

  it('renders view type toggle buttons and can switch views', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1',
        name: 'Test Loan',
        accountType: 'LOAN',
        currentBalance: -5000,
        openingBalance: -10000,
        interestRate: 3.0,
        paymentAmount: 200,
        paymentFrequency: 'MONTHLY',
        mortgageType: 'ANNUITY',
        isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-06-01', amount: 200, linkedTransaction: null },
      ],
      pagination: { hasMore: false },
    });
    render(<DebtPayoffTimelineReport />);
    await waitFor(() => {
      expect(screen.getByText('Balance Over Time')).toBeInTheDocument();
    });
    // Switch to breakdown view
    await act(async () => {
      fireEvent.click(screen.getByText('Payment Breakdown'));
    });
    expect(screen.getByTestId('bar-chart')).toBeInTheDocument();
    // Switch to distribution view
    await act(async () => {
      fireEvent.click(screen.getByText('Principal vs Interest'));
    });
    expect(screen.getByTestId('bar-chart')).toBeInTheDocument();
  });

  it('renders with transaction that has linked splits for interest', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1',
        name: 'Mortgage',
        accountType: 'MORTGAGE',
        currentBalance: -190000,
        openingBalance: -200000,
        interestRate: 4.0,
        paymentAmount: 1500,
        paymentFrequency: 'MONTHLY',
        mortgageType: 'ANNUITY',
        isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [
        {
          id: 'tx-1',
          transactionDate: '2024-01-15',
          amount: 1000,
          linkedTransaction: {
            id: 'parent-1',
            splits: [
              { amount: -1000, transferAccountId: 'loan-1' },
              { amount: -500, transferAccountId: 'interest-cat' },
            ],
          },
        },
      ],
      pagination: { hasMore: false },
    });
    render(<DebtPayoffTimelineReport />);
    await waitFor(() => {
      expect(screen.getByText('Current Balance')).toBeInTheDocument();
    });
  });

  it('filters out non-debt account types', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'savings-1', name: 'Savings', accountType: 'SAVINGS',
        currentBalance: 5000, openingBalance: 5000, interestRate: null,
        paymentAmount: null, paymentFrequency: null,
        mortgageType: 'ANNUITY', isClosed: false,
      },
      {
        id: 'loan-1', name: 'Car Loan', accountType: 'LOAN',
        currentBalance: -5000, openingBalance: -15000, interestRate: 5.0,
        paymentAmount: 300, paymentFrequency: 'MONTHLY',
        mortgageType: 'ANNUITY', isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({ data: [], pagination: { hasMore: false } });
    render(<DebtPayoffTimelineReport />);
    await waitFor(() => {
      expect(screen.getByText('Select Account')).toBeInTheDocument();
    });
    expect(screen.getByText('Car Loan')).toBeInTheDocument();
    expect(screen.queryByText('Savings')).not.toBeInTheDocument();
  });

  it('shows progress percentage in summary card', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'Car Loan', accountType: 'LOAN',
        currentBalance: -7500, openingBalance: -10000, interestRate: 5.0,
        paymentAmount: 300, paymentFrequency: 'MONTHLY',
        mortgageType: 'ANNUITY', isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-01-15', amount: 300, linkedTransaction: null },
      ],
      pagination: { hasMore: false },
    });
    render(<DebtPayoffTimelineReport />);
    await waitFor(() => {
      expect(screen.getByText('Progress')).toBeInTheDocument();
    });
    expect(screen.getByText('25.0%')).toBeInTheDocument();
  });

  it('shows Est. Payoff card when projections exist', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'Car Loan', accountType: 'LOAN',
        currentBalance: -5000, openingBalance: -10000, interestRate: 5.0,
        paymentAmount: 500, paymentFrequency: 'MONTHLY',
        mortgageType: 'ANNUITY', isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-01-15', amount: 500, linkedTransaction: null },
      ],
      pagination: { hasMore: false },
    });
    render(<DebtPayoffTimelineReport />);
    await waitFor(() => {
      expect(screen.getByText('Est. Payoff')).toBeInTheDocument();
    });
  });

  it('shows "Est. Total Interest" label when projections exist', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'Car Loan', accountType: 'LOAN',
        currentBalance: -5000, openingBalance: -10000, interestRate: 5.0,
        paymentAmount: 500, paymentFrequency: 'MONTHLY',
        mortgageType: 'ANNUITY', isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-01-15', amount: 500, linkedTransaction: null },
      ],
      pagination: { hasMore: false },
    });
    render(<DebtPayoffTimelineReport />);
    await waitFor(() => {
      expect(screen.getByText('Est. Total Interest')).toBeInTheDocument();
    });
  });

  it('shows "Interest Paid" label when no projections', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'Car Loan', accountType: 'LOAN',
        currentBalance: -5000, openingBalance: -10000, interestRate: null,
        paymentAmount: null, paymentFrequency: null,
        mortgageType: 'ANNUITY', isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-01-15', amount: 300, linkedTransaction: null },
      ],
      pagination: { hasMore: false },
    });
    render(<DebtPayoffTimelineReport />);
    await waitFor(() => {
      expect(screen.getByText('Interest Paid')).toBeInTheDocument();
    });
  });

  it('shows projection note text when projections exist', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'Car Loan', accountType: 'LOAN',
        currentBalance: -5000, openingBalance: -10000, interestRate: 5.0,
        paymentAmount: 500, paymentFrequency: 'MONTHLY',
        mortgageType: 'ANNUITY', isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-01-15', amount: 500, linkedTransaction: null },
      ],
      pagination: { hasMore: false },
    });
    render(<DebtPayoffTimelineReport />);
    await waitFor(() => {
      expect(screen.getByText(/Dashed line marks today/)).toBeInTheDocument();
    });
  });

  it('renders area chart in default balance view', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'Car Loan', accountType: 'LOAN',
        currentBalance: -5000, openingBalance: -10000, interestRate: 5.0,
        paymentAmount: 500, paymentFrequency: 'MONTHLY',
        mortgageType: 'ANNUITY', isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-01-15', amount: 500, linkedTransaction: null },
      ],
      pagination: { hasMore: false },
    });
    render(<DebtPayoffTimelineReport />);
    await waitFor(() => {
      expect(screen.getByTestId('area-chart')).toBeInTheDocument();
    });
  });

  it('switches to bar chart on breakdown view', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'Car Loan', accountType: 'LOAN',
        currentBalance: -5000, openingBalance: -10000, interestRate: 5.0,
        paymentAmount: 500, paymentFrequency: 'MONTHLY',
        mortgageType: 'ANNUITY', isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-01-15', amount: 500, linkedTransaction: null },
      ],
      pagination: { hasMore: false },
    });
    render(<DebtPayoffTimelineReport />);
    await waitFor(() => {
      expect(screen.getByText('Payment Breakdown')).toBeInTheDocument();
    });
    await act(async () => { fireEvent.click(screen.getByText('Payment Breakdown')); });
    expect(screen.getByTestId('bar-chart')).toBeInTheDocument();
    expect(screen.queryByTestId('area-chart')).not.toBeInTheDocument();
  });

  it('switches to distribution view', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'Car Loan', accountType: 'LOAN',
        currentBalance: -5000, openingBalance: -10000, interestRate: 5.0,
        paymentAmount: 500, paymentFrequency: 'MONTHLY',
        mortgageType: 'ANNUITY', isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-01-15', amount: 500, linkedTransaction: null },
      ],
      pagination: { hasMore: false },
    });
    render(<DebtPayoffTimelineReport />);
    await waitFor(() => {
      expect(screen.getByText('Principal vs Interest')).toBeInTheDocument();
    });
    await act(async () => { fireEvent.click(screen.getByText('Principal vs Interest')); });
    expect(screen.getByTestId('bar-chart')).toBeInTheDocument();
    expect(screen.queryByTestId('area-chart')).not.toBeInTheDocument();
  });

  it('can switch back to balance view after switching away', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'Car Loan', accountType: 'LOAN',
        currentBalance: -5000, openingBalance: -10000, interestRate: 5.0,
        paymentAmount: 500, paymentFrequency: 'MONTHLY',
        mortgageType: 'ANNUITY', isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-01-15', amount: 500, linkedTransaction: null },
      ],
      pagination: { hasMore: false },
    });
    render(<DebtPayoffTimelineReport />);
    await waitFor(() => {
      expect(screen.getByTestId('area-chart')).toBeInTheDocument();
    });
    // Switch to breakdown
    await act(async () => { fireEvent.click(screen.getByText('Payment Breakdown')); });
    expect(screen.getByTestId('bar-chart')).toBeInTheDocument();
    // Switch back to balance
    await act(async () => { fireEvent.click(screen.getByText('Balance Over Time')); });
    expect(screen.getByTestId('area-chart')).toBeInTheDocument();
  });

  it('displays account details with original amount and payments made count', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'Car Loan', accountType: 'LOAN',
        currentBalance: -5000, openingBalance: -10000, interestRate: 3.5,
        paymentAmount: 300, paymentFrequency: 'MONTHLY',
        mortgageType: 'ANNUITY', isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-01-15', amount: 300, linkedTransaction: null },
        { id: 'tx-2', transactionDate: '2024-02-15', amount: 300, linkedTransaction: null },
        { id: 'tx-3', transactionDate: '2024-03-15', amount: 300, linkedTransaction: null },
      ],
      pagination: { hasMore: false },
    });
    render(<DebtPayoffTimelineReport />);
    await waitFor(() => {
      expect(screen.getByText('Account Details')).toBeInTheDocument();
    });
    expect(screen.getByText('Original Amount')).toBeInTheDocument();
    expect(screen.getByText('3.5%')).toBeInTheDocument();
  });

  it('paginates through transactions when there are multiple pages', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'Loan', accountType: 'LOAN',
        currentBalance: -5000, openingBalance: -10000, interestRate: 5.0,
        paymentAmount: 300, paymentFrequency: 'MONTHLY',
        mortgageType: 'ANNUITY', isClosed: false,
      },
    ]);
    mockGetAllTransactions
      .mockResolvedValueOnce({
        data: [{ id: 'tx-1', transactionDate: '2024-01-15', amount: 300, linkedTransaction: null }],
        pagination: { hasMore: true },
      })
      .mockResolvedValueOnce({
        data: [{ id: 'tx-2', transactionDate: '2024-02-15', amount: 300, linkedTransaction: null }],
        pagination: { hasMore: false },
      });
    render(<DebtPayoffTimelineReport />);
    await waitFor(() => {
      expect(mockGetAllTransactions).toHaveBeenCalledTimes(2);
    });
  });

  it('handles accounts with null interest rate gracefully', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loc-1', name: 'LOC', accountType: 'LINE_OF_CREDIT',
        currentBalance: -3000, openingBalance: -5000, interestRate: null,
        paymentAmount: null, paymentFrequency: null,
        mortgageType: 'ANNUITY', isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-01-15', amount: 500, linkedTransaction: null },
      ],
      pagination: { hasMore: false },
    });
    render(<DebtPayoffTimelineReport />);
    await waitFor(() => {
      expect(screen.getByText('Not set')).toBeInTheDocument();
    });
  });

  it('triggers PDF export when clicking export button', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'Car Loan', accountType: 'LOAN',
        currentBalance: -5000, openingBalance: -10000, interestRate: 5.0,
        paymentAmount: 500, paymentFrequency: 'MONTHLY',
        mortgageType: 'ANNUITY', isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-01-15', amount: 500, linkedTransaction: null },
      ],
      pagination: { hasMore: false },
    });
    render(<DebtPayoffTimelineReport />);
    await waitFor(() => {
      expect(screen.getByText('Account Details')).toBeInTheDocument();
    });
    // Click export dropdown then PDF
    const exportBtn = screen.getByRole('button', { name: /export/i });
    await act(async () => {
      fireEvent.click(exportBtn);
    });
    const pdfBtn = screen.queryByText(/PDF/i);
    if (pdfBtn) {
      await act(async () => {
        fireEvent.click(pdfBtn);
      });
    }
  });

  it('exports an interest-only mortgage\'s next installment and its bullet, dated', async () => {
    // docs/specs/mortgage-types.md section 5.6: no constant payment is stored
    // for the method, so the payment column is the next installment with its
    // date, and the bullet travels with it.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-01T12:00:00Z'));
    try {
      mockGetAllAccounts.mockResolvedValue([
        {
          id: 'mortgage-1', name: 'Hypotheek', accountType: 'MORTGAGE',
          currentBalance: -300000, openingBalance: -300000, interestRate: 2,
          paymentAmount: null, paymentFrequency: 'MONTHLY', paymentStartDate: '2026-01-01',
          amortizationMonths: 360, originalPrincipal: 300000,
          mortgageType: 'INTEREST_ONLY', prepaymentMode: null,
          isClosed: false,
        },
      ]);
      render(<DebtPayoffTimelineReport />);
      await waitFor(() => {
        expect(screen.getByText('Account Details')).toBeInTheDocument();
      });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /export/i }));
      });
      await act(async () => {
        fireEvent.click(screen.getByText(/PDF/i));
      });
      const { exportToPdf } = await import('@/lib/pdf-export');
      const call = vi.mocked(exportToPdf).mock.calls.at(-1)![0];
      const paymentCell = call.tableData!.rows[0][4];
      expect(paymentCell).toMatch(/^\$500\S*, due \S*2026; final payment \$300,?500\S*, due \S*2055$/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows a retryable error when loading accounts fails', async () => {
    mockGetAllAccounts.mockRejectedValue(new Error('network'));
    render(<DebtPayoffTimelineReport />);
    await waitFor(() => {
      expect(screen.getByText(/Failed to load report data/i)).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /Try again/i })).toBeInTheDocument();
  });

  it('handles error in loadTransactions gracefully', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'Loan', accountType: 'LOAN',
        currentBalance: -5000, openingBalance: -10000, interestRate: 5.0,
        paymentAmount: 300, paymentFrequency: 'MONTHLY',
        mortgageType: 'ANNUITY', isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockRejectedValue(new Error('boom'));
    render(<DebtPayoffTimelineReport />);
    await waitFor(() => {
      expect(screen.getByText(/Failed to load report data/i)).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /Try again/i })).toBeInTheDocument();
  });

  it('handles WEEKLY payment frequency in projections', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'Loan', accountType: 'LOAN',
        currentBalance: -2000, openingBalance: -5000, interestRate: 6.0,
        paymentAmount: 100, paymentFrequency: 'WEEKLY',
        mortgageType: 'ANNUITY', isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({ data: [], pagination: { hasMore: false } });
    render(<DebtPayoffTimelineReport />);
    await waitFor(() => {
      expect(screen.getByText('Est. Payoff')).toBeInTheDocument();
    });
  });

  it('handles BIWEEKLY frequency', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'Loan', accountType: 'LOAN',
        currentBalance: -3000, openingBalance: -5000, interestRate: 4.5,
        paymentAmount: 200, paymentFrequency: 'BIWEEKLY',
        mortgageType: 'ANNUITY', isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({ data: [], pagination: { hasMore: false } });
    render(<DebtPayoffTimelineReport />);
    await waitFor(() => {
      expect(screen.getByText('Est. Payoff')).toBeInTheDocument();
    });
  });

  it('handles SEMI_MONTHLY frequency', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'Loan', accountType: 'LOAN',
        currentBalance: -3000, openingBalance: -5000, interestRate: 4.5,
        paymentAmount: 200, paymentFrequency: 'SEMI_MONTHLY',
        mortgageType: 'ANNUITY', isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({ data: [], pagination: { hasMore: false } });
    render(<DebtPayoffTimelineReport />);
    await waitFor(() => {
      expect(screen.getByText('Est. Payoff')).toBeInTheDocument();
    });
  });

  it('handles QUARTERLY frequency', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'Loan', accountType: 'LOAN',
        currentBalance: -3000, openingBalance: -5000, interestRate: 4.5,
        paymentAmount: 700, paymentFrequency: 'QUARTERLY',
        mortgageType: 'ANNUITY', isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({ data: [], pagination: { hasMore: false } });
    render(<DebtPayoffTimelineReport />);
    await waitFor(() => {
      expect(screen.getByText('Est. Payoff')).toBeInTheDocument();
    });
  });

  it('handles YEARLY frequency', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'Loan', accountType: 'LOAN',
        currentBalance: -3000, openingBalance: -5000, interestRate: 4.5,
        paymentAmount: 2500, paymentFrequency: 'YEARLY',
        mortgageType: 'ANNUITY', isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({ data: [], pagination: { hasMore: false } });
    render(<DebtPayoffTimelineReport />);
    await waitFor(() => {
      expect(screen.getByText('Est. Payoff')).toBeInTheDocument();
    });
  });

  it('handles ACCELERATED_BIWEEKLY frequency', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'Loan', accountType: 'LOAN',
        currentBalance: -3000, openingBalance: -5000, interestRate: 4.5,
        paymentAmount: 200, paymentFrequency: 'ACCELERATED_BIWEEKLY',
        mortgageType: 'ANNUITY', isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({ data: [], pagination: { hasMore: false } });
    render(<DebtPayoffTimelineReport />);
    await waitFor(() => {
      expect(screen.getByText('Est. Payoff')).toBeInTheDocument();
    });
  });

  it('handles ACCELERATED_WEEKLY frequency and 0 interest rate', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'Loan', accountType: 'LOAN',
        currentBalance: -3000, openingBalance: -5000, interestRate: 0,
        paymentAmount: 100, paymentFrequency: 'ACCELERATED_WEEKLY',
        mortgageType: 'ANNUITY', isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({ data: [], pagination: { hasMore: false } });
    render(<DebtPayoffTimelineReport />);
    await waitFor(() => {
      expect(screen.getByText('Est. Payoff')).toBeInTheDocument();
    });
  });

  it('does not project when payment cannot cover interest', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'Loan', accountType: 'LOAN',
        currentBalance: -100000, openingBalance: -100000, interestRate: 50,
        paymentAmount: 10, paymentFrequency: 'MONTHLY',
        mortgageType: 'ANNUITY', isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({ data: [], pagination: { hasMore: false } });
    render(<DebtPayoffTimelineReport />);
    await waitFor(() => {
      expect(screen.getByText(/No payment history found/)).toBeInTheDocument();
    });
  });

  it('samples large schedules to fit chart', async () => {
    // Many transactions to trigger sampling
    const txs = Array.from({ length: 80 }, (_, i) => {
      const month = ((i % 12) + 1).toString().padStart(2, '0');
      const year = 2020 + Math.floor(i / 12);
      return { id: `tx-${i}`, transactionDate: `${year}-${month}-15`, amount: 100, linkedTransaction: null };
    });
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'Loan', accountType: 'LOAN',
        currentBalance: -2000, openingBalance: -10000, interestRate: 5.0,
        paymentAmount: 100, paymentFrequency: 'MONTHLY',
        mortgageType: 'ANNUITY', isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({ data: txs, pagination: { hasMore: false } });
    render(<DebtPayoffTimelineReport />);
    await waitFor(() => {
      expect(screen.getByText('Account Details')).toBeInTheDocument();
    });
  });

  it('uses calculated original balance when openingBalance is 0', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1', name: 'Loan', accountType: 'LOAN',
        currentBalance: -5000, openingBalance: 0, interestRate: 5.0,
        paymentAmount: 200, paymentFrequency: 'MONTHLY',
        mortgageType: 'ANNUITY', isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({
      data: [
        { id: 'tx-1', transactionDate: '2024-01-15', amount: 200, linkedTransaction: null },
      ],
      pagination: { hasMore: false },
    });
    render(<DebtPayoffTimelineReport />);
    await waitFor(() => {
      expect(screen.getByText('Account Details')).toBeInTheDocument();
    });
  });

  it('includes LINE_OF_CREDIT in the account list', async () => {
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loc-1', name: 'My LOC', accountType: 'LINE_OF_CREDIT',
        currentBalance: -3000, openingBalance: -10000, interestRate: 7.0,
        paymentAmount: 200, paymentFrequency: 'MONTHLY',
        mortgageType: 'ANNUITY', isClosed: false,
      },
      {
        id: 'mortgage-1', name: 'Home Mortgage', accountType: 'MORTGAGE',
        currentBalance: -200000, openingBalance: -300000, interestRate: 4.0,
        paymentAmount: 1500, paymentFrequency: 'MONTHLY',
        mortgageType: 'CANADIAN_FIXED', isClosed: false,
      },
    ]);
    mockGetAllTransactions.mockResolvedValue({ data: [], pagination: { hasMore: false } });
    render(<DebtPayoffTimelineReport />);
    await waitFor(() => {
      expect(screen.getByText('Select Account')).toBeInTheDocument();
    });
    expect(screen.getByText('Home Mortgage')).toBeInTheDocument();
    expect(screen.getByText('My LOC')).toBeInTheDocument();
  });

  it('restores the persisted account selection instead of the first account', async () => {
    window.localStorage.setItem(
      'monize-reports-debt-payoff-timeline-account',
      JSON.stringify('loan-2'),
    );
    mockGetAllAccounts.mockResolvedValue([
      {
        id: 'loan-1',
        name: 'Car Loan',
        accountType: 'LOAN',
        currentBalance: -10000,
        openingBalance: -20000,
        interestRate: 5.0,
        paymentAmount: 400,
        paymentFrequency: 'MONTHLY',
        mortgageType: 'ANNUITY',
        isClosed: false,
      },
      {
        id: 'loan-2',
        name: 'Mortgage',
        accountType: 'MORTGAGE',
        currentBalance: -10000,
        openingBalance: -20000,
        interestRate: 5.0,
        paymentAmount: 400,
        paymentFrequency: 'MONTHLY',
        mortgageType: 'ANNUITY',
        isClosed: false,
      },
    ]);
    render(<DebtPayoffTimelineReport />);
    await waitFor(() => {
      expect(screen.getByRole('combobox')).toHaveValue('loan-2');
    });
  });

  it('falls back to the first account when the persisted one is gone', async () => {
    window.localStorage.setItem(
      'monize-reports-debt-payoff-timeline-account',
      JSON.stringify('deleted-loan'),
    );
    mockGetAllAccounts.mockResolvedValue([{
        id: 'loan-1',
        name: 'Car Loan',
        accountType: 'LOAN',
        currentBalance: -10000,
        openingBalance: -20000,
        interestRate: 5.0,
        paymentAmount: 400,
        paymentFrequency: 'MONTHLY',
        mortgageType: 'ANNUITY',
        isClosed: false,
      }]);
    render(<DebtPayoffTimelineReport />);
    await waitFor(() => {
      expect(screen.getByRole('combobox')).toHaveValue('loan-1');
    });
  });

  // --- Issue #1244: chart reduction must not reach a count or a total --------
  //
  // The report used to build ONE array: payment events, aggregated by month,
  // then sampled down to ~60 points for the axis -- and "Payments Made" counted
  // what survived. Each case below fails on that shape.
  describe('a chart reduction never reaches a figure (issue #1244)', () => {
    /** The number under the "Payments Made" heading in Account Details. */
    const paymentsMade = () =>
      screen.getByText('Payments Made').parentElement?.querySelector('p')?.textContent;

    /** The rows a chart was actually handed. */
    const chartRows = (testId: 'area-chart' | 'bar-chart') =>
      JSON.parse(screen.getByTestId(testId).getAttribute('data-rows') ?? '[]');

    /**
     * Render, and wait for the loan's HISTORY to be adopted -- which is what
     * `expected` proves, since the count is derived from the events.
     *
     * Waiting on the chart mounting is not the same barrier: a loan carrying
     * terms projects from its current balance alone, so the area chart appears
     * on a projection-only schedule one render before the transactions are
     * adopted. The wait is an assertion, so it cannot mask a failure -- a count
     * that never arrives times out.
     */
    const renderAwaitingHistory = async (expected: string) => {
      render(<DebtPayoffTimelineReport />);
      await waitFor(() => expect(paymentsMade()).toBe(expected));
    };

    const monthlyPayments = (count: number, amount = 100) =>
      Array.from({ length: count }, (_, i) => {
        const year = 2000 + Math.floor(i / 12);
        const month = ((i % 12) + 1).toString().padStart(2, '0');
        return {
          id: `tx-${i}`,
          transactionDate: `${year}-${month}-15`,
          amount,
          linkedTransaction: null,
        };
      });

    /** A loan with no terms, so nothing is projected and every row is history. */
    const historyOnlyLoan = (currentBalance: number, openingBalance: number) => [{
      id: 'loan-1',
      name: 'Long Mortgage',
      accountType: 'MORTGAGE',
      currentBalance,
      openingBalance,
      interestRate: null,
      paymentAmount: null,
      paymentFrequency: null,
      mortgageType: 'ANNUITY',
      isClosed: false,
    }];

    it('counts every payment when the chart is sampled', async () => {
      // 300 monthly payments: five times the axis budget, so the balance chart
      // is sampled and the count must not be.
      mockGetAllAccounts.mockResolvedValue(historyOnlyLoan(-2000, -32000));
      mockGetAllTransactions.mockResolvedValue({
        data: monthlyPayments(300),
        pagination: { hasMore: false },
      });

      await renderAwaitingHistory('300');

      // The reduction is still doing its job -- this is not "sampling removed".
      const drawn = chartRows('area-chart');
      expect(drawn.length).toBeLessThanOrEqual(61);
      expect(drawn.length).toBeLessThan(300);
    });

    it('counts two payments in one month as two, though the chart draws one bar', async () => {
      mockGetAllAccounts.mockResolvedValue(historyOnlyLoan(-700, -1000));
      mockGetAllTransactions.mockResolvedValue({
        data: [
          { id: 'tx-1', transactionDate: '2024-01-05', amount: 100, linkedTransaction: null },
          { id: 'tx-2', transactionDate: '2024-01-19', amount: 100, linkedTransaction: null },
          { id: 'tx-3', transactionDate: '2024-01-28', amount: 100, linkedTransaction: null },
        ],
        pagination: { hasMore: false },
      });

      await renderAwaitingHistory('3');

      // One month, one point -- and the month's principal is all three payments.
      const drawn = chartRows('area-chart');
      expect(drawn).toHaveLength(1);
      expect(drawn[0].principalPaid).toBe(300);
    });

    it('counts biweekly payments individually rather than by month', async () => {
      // 26 payments across 2024, two in most months: monthly aggregation would
      // report 12.
      const biweekly = Array.from({ length: 26 }, (_, i) => {
        const date = new Date(Date.UTC(2024, 0, 5 + i * 14));
        return {
          id: `tx-${i}`,
          transactionDate: date.toISOString().slice(0, 10),
          amount: 100,
          linkedTransaction: null,
        };
      });
      mockGetAllAccounts.mockResolvedValue(historyOnlyLoan(-400, -3000));
      mockGetAllTransactions.mockResolvedValue({ data: biweekly, pagination: { hasMore: false } });

      await renderAwaitingHistory('26');

      expect(chartRows('area-chart').length).toBeLessThanOrEqual(12);
    });

    it('draws every month in Payment Distribution, summed rather than dropped', async () => {
      // 120 months at 100 each. Sampling drew every other month and lost half
      // the money; bucketing sums the months into one bar apiece.
      mockGetAllAccounts.mockResolvedValue(historyOnlyLoan(-1000, -13000));
      mockGetAllTransactions.mockResolvedValue({
        data: monthlyPayments(120),
        pagination: { hasMore: false },
      });

      await renderAwaitingHistory('120');
      fireEvent.click(screen.getByText('Principal vs Interest'));

      const bars = chartRows('bar-chart');
      expect(bars.length).toBeGreaterThan(0);
      expect(bars.length).toBeLessThanOrEqual(60);
      // Conservation: no month is missing from the chart.
      expect(bars.reduce((sum: number, bar: { principalPaid: number }) => sum + bar.principalPaid, 0)).toBe(12000);
      expect(bars.reduce((sum: number, bar: { months: number }) => sum + bar.months, 0)).toBe(120);
      // A bucket spanning more than one month says so rather than borrowing the
      // first month's name.
      expect(bars[0].label).toMatch(/ \u2013 /);
    });

    it('leaves a short distribution one bar per month', async () => {
      mockGetAllAccounts.mockResolvedValue(historyOnlyLoan(-1000, -1300));
      mockGetAllTransactions.mockResolvedValue({
        data: monthlyPayments(3),
        pagination: { hasMore: false },
      });

      await renderAwaitingHistory('3');
      fireEvent.click(screen.getByText('Principal vs Interest'));

      const bars = chartRows('bar-chart');
      expect(bars).toHaveLength(3);
      expect(bars.map((bar: { label: string }) => bar.label)).toEqual([
        'Jan 2000',
        'Feb 2000',
        'Mar 2000',
      ]);
    });

    it('marks today on the distribution chart with a key that axis has', async () => {
      // A bucketed bar is labelled as a RANGE and addressed by its own position
      // among the buckets, so the balance chart's key for "Sep 2026" matches no
      // category here and recharts draws nothing -- silently, on exactly the
      // long loans bucketing exists for, under a caption that still says the
      // dashed line marks today.
      mockGetAllAccounts.mockResolvedValue([{
        id: 'loan-1',
        name: 'Long Mortgage',
        accountType: 'MORTGAGE',
        currentBalance: -5000,
        openingBalance: -17000,
        interestRate: 5.0,
        paymentAmount: 200,
        paymentFrequency: 'MONTHLY',
        mortgageType: 'ANNUITY',
        isClosed: false,
      }]);
      mockGetAllTransactions.mockResolvedValue({
        data: monthlyPayments(120),
        pagination: { hasMore: false },
      });

      await renderAwaitingHistory('120');
      fireEvent.click(screen.getByText('Principal vs Interest'));

      const bars: Array<{ label: string; axisKey: string; isProjected: boolean }> =
        chartRows('bar-chart');
      // Long enough to bucket, and carrying both sides of the transition.
      expect(bars.some((bar) => bar.label.includes('\u2013'))).toBe(true);
      expect(bars.some((bar) => bar.isProjected)).toBe(true);

      const markers = screen.getAllByTestId('reference-line');
      expect(markers).toHaveLength(1);
      const markerX = markers[0].getAttribute('data-x');
      // The value has to BE an axis category, or the marker is not drawn.
      expect(bars.map((bar) => bar.axisKey)).toContain(markerX);
      // And it is the transition: the first bucket on the projected side.
      const transition = bars.find((bar) => bar.isProjected);
      expect(transition?.axisKey).toBe(markerX);
      // The identity is unique, and the tick still prints the bucket's span.
      expect(new Set(bars.map((bar) => bar.axisKey)).size).toBe(bars.length);
      expect(axisTickLabel(markerX ?? '')).toBe(transition?.label);
    });

    it('draws the projection marker on the real transition month', async () => {
      // With 300 historical months a stride of 6 would put "today" up to five
      // months off; the sampler keeps the boundary rows whatever the stride.
      mockGetAllAccounts.mockResolvedValue([{
        id: 'loan-1',
        name: 'Long Mortgage',
        accountType: 'MORTGAGE',
        currentBalance: -2000,
        openingBalance: -32000,
        interestRate: 5.0,
        paymentAmount: 500,
        paymentFrequency: 'MONTHLY',
        mortgageType: 'ANNUITY',
        isClosed: false,
      }]);
      mockGetAllTransactions.mockResolvedValue({
        data: monthlyPayments(300),
        pagination: { hasMore: false },
      });

      await renderAwaitingHistory('300');

      const drawn: Array<{ isProjected: boolean }> = chartRows('area-chart');
      const firstProjected = drawn.findIndex((row) => row.isProjected);
      expect(firstProjected).toBeGreaterThan(0);
      // The two rows either side of the transition are adjacent in the drawn
      // series, so the "Today" line and the area join sit on the real boundary.
      expect(drawn[firstProjected - 1].isProjected).toBe(false);
    });
  });

  // --- Issue #1280 audit F-1280-01: provenance survives monthly aggregation --
  //
  // A weekly, biweekly or semi-monthly loan routinely has a real payment and a
  // projected one in the SAME calendar month. Grouping by month alone merges
  // them, and the merged row was labelled historical whenever it held any
  // historical entry -- so forecast principal was drawn as measured history,
  // a projected end-of-month balance was published as the historical balance,
  // and a loan that pays off inside that month lost its projection entirely.
  describe('a month holding both a real and a projected payment (F-1280-01)', () => {
    // The overlap is decided against TODAY, so the clock is pinned. Only `Date`
    // is faked: RTL's `waitFor` cannot drive Vitest's fake timers.
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-08-10T12:00:00Z'));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    /** The number under the "Payments Made" heading in Account Details. */
    const paymentsMade = () =>
      screen.getByText('Payments Made').parentElement?.querySelector('p')?.textContent;

    const chartRows = (testId: 'area-chart' | 'bar-chart') =>
      JSON.parse(screen.getByTestId(testId).getAttribute('data-rows') ?? '[]');

    const renderAwaitingHistory = async (expected: string) => {
      render(<DebtPayoffTimelineReport />);
      await waitFor(() => expect(paymentsMade()).toBe(expected));
    };

    /**
     * A 0% weekly loan so every figure below is exact and independent of
     * rounding: 300 opened, 100 paid on 3 Aug, 200 owing, and two projected
     * 100s on 17 and 24 Aug. All four rows format to "Aug 2026".
     */
    const weeklyLoanPayingOffThisMonth = () => {
      mockGetAllAccounts.mockResolvedValue([{
        id: 'loan-1',
        name: 'Short Weekly Loan',
        accountType: 'LOAN',
        currentBalance: -200,
        openingBalance: -300,
        interestRate: 0,
        paymentAmount: 100,
        paymentFrequency: 'WEEKLY',
        mortgageType: 'ANNUITY',
        isClosed: false,
      }]);
      mockGetAllTransactions.mockResolvedValue({
        data: [
          { id: 'actual-aug-03', transactionDate: '2026-08-03', amount: 100, linkedTransaction: null },
        ],
        pagination: { hasMore: false },
      });
    };

    it('keeps the projected principal out of the historical bar', async () => {
      weeklyLoanPayingOffThisMonth();
      await renderAwaitingHistory('1');
      fireEvent.click(screen.getByText('Principal vs Interest'));

      const bars: Array<{ principalPaid: number; isProjected: boolean }> =
        chartRows('bar-chart');
      const sum = (projected: boolean) =>
        bars
          .filter((bar) => bar.isProjected === projected)
          .reduce((total, bar) => total + bar.principalPaid, 0);

      // 100 was paid; 200 is forecast. Merged, August read 300 of history.
      expect(sum(false)).toBe(100);
      expect(sum(true)).toBe(200);
    });

    it('never publishes a projected balance as the historical one', async () => {
      weeklyLoanPayingOffThisMonth();
      await renderAwaitingHistory('1');

      const rows: Array<{
        historicalBalance?: number;
        projectedBalance?: number;
        balance: number;
        isProjected: boolean;
      }> = chartRows('area-chart');

      // The measured debt is 200. The merged row carried the projection's
      // end-of-month 0 under `historicalBalance`.
      const historical = rows.filter((row) => row.historicalBalance !== undefined);
      expect(historical).not.toHaveLength(0);
      expect(historical[historical.length - 1].historicalBalance).toBe(200);
      expect(rows.some((row) => row.isProjected)).toBe(true);
      expect(rows[rows.length - 1].balance).toBe(0);
    });

    it('keeps a future-dated posted payment in its own run among the projected rows', async () => {
      // A repayment posted ahead of its date is a HISTORICAL event dated after
      // the projection starts, so the two interleave. Grouping by a month key
      // would fold it back into a month it no longer sits beside; grouping
      // contiguous runs over a date-ordered series gives it its own row.
      mockGetAllAccounts.mockResolvedValue([{
        id: 'loan-1',
        name: 'Prepaid Loan',
        accountType: 'LOAN',
        currentBalance: -300,
        openingBalance: -600,
        interestRate: 0,
        paymentAmount: 100,
        paymentFrequency: 'MONTHLY',
        mortgageType: 'ANNUITY',
        isClosed: false,
      }]);
      mockGetAllTransactions.mockResolvedValue({
        data: [
          { id: 'past', transactionDate: '2026-07-15', amount: 100, linkedTransaction: null },
          { id: 'ahead', transactionDate: '2026-10-15', amount: 100, linkedTransaction: null },
        ],
        pagination: { hasMore: false },
      });

      await renderAwaitingHistory('2');

      const rows: Array<{ date: string; label: string; axisKey: string; isProjected: boolean }> =
        chartRows('area-chart');
      // Date order, and one identity per row.
      expect(rows.map((row) => row.date.slice(0, 10))).toEqual(
        [...rows].map((row) => row.date.slice(0, 10)).sort(),
      );
      expect(new Set(rows.map((row) => row.axisKey)).size).toBe(rows.length);
      // October holds a posted payment and projected ones, and they are not one
      // row: the historical run sits between two projected runs.
      const october = rows.filter((row) => row.label === 'Oct 2026');
      expect(october.length).toBeGreaterThan(1);
      expect(october.some((row) => !row.isProjected)).toBe(true);
      expect(october.some((row) => row.isProjected)).toBe(true);
    });

    it('still knows it has a projection when the loan pays off in the transition month', async () => {
      weeklyLoanPayingOffThisMonth();
      await renderAwaitingHistory('1');

      // The Today divider and the Est. Payoff card both come from the
      // projection; merged into a single historical August row, neither drew.
      expect(screen.getByText('Est. Payoff')).toBeInTheDocument();
      const markers = screen.getAllByTestId('reference-line');
      expect(markers).toHaveLength(1);
      const drawn: Array<{ label: string; axisKey: string; isProjected: boolean }> =
        chartRows('area-chart');
      const transition = drawn.find((row) => row.isProjected);
      expect(transition?.axisKey).toBe(markers[0].getAttribute('data-x'));
      // Both August rows are on the axis, under one label and two identities.
      expect(drawn.map((row) => row.label)).toEqual(['Aug 2026', 'Aug 2026']);
      expect(new Set(drawn.map((row) => row.axisKey)).size).toBe(2);
      expect(axisTickLabel(transition?.axisKey ?? '')).toBe('Aug 2026');
    });
  });
});
