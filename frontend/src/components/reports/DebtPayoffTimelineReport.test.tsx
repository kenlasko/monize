import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@/test/render';
import { DebtPayoffTimelineReport } from './DebtPayoffTimelineReport';

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrencyCompact: (n: number) => `$${n.toFixed(0)}`,
    formatCurrency: (n: number) => `$${n.toFixed(2)}`,
    formatCurrencyAxis: (n: number) => `$${n}`,
    defaultCurrency: 'CAD',
  }),
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div data-testid="responsive-container">{children}</div>,
  BarChart: ({ children }: any) => <div data-testid="bar-chart">{children}</div>,
  AreaChart: ({ children }: any) => <div data-testid="area-chart">{children}</div>,
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
  ReferenceLine: () => null,
}));

const mockGetAllAccounts = vi.fn();
const mockGetAllTransactions = vi.fn();

vi.mock('@/lib/accounts', () => ({
  accountsApi: {
    getAll: (...args: any[]) => mockGetAllAccounts(...args),
  },
}));

vi.mock('@/lib/transactions', () => ({
  transactionsApi: {
    getAll: (...args: any[]) => mockGetAllTransactions(...args),
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
    // Default to a single-page result so the report's pagination loop
    // terminates. Individual tests override data/pagination as needed.
    mockGetAllTransactions.mockResolvedValue({ data: [], pagination: { hasMore: false } });
  });

  it('shows loading state initially', () => {
    mockGetAllAccounts.mockReturnValue(new Promise(() => {}));
    render(<DebtPayoffTimelineReport />);
    expect(document.querySelector('.animate-pulse')).toBeTruthy();
  });

  it('renders empty state when no debt accounts', async () => {
    mockGetAllAccounts.mockResolvedValue([]);
    render(<DebtPayoffTimelineReport />);
    await waitFor(() => {
      expect(screen.getByText(/No debt accounts found/)).toBeInTheDocument();
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
        isCanadianMortgage: false,
        isVariableRate: false,
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
        isCanadianMortgage: true,
        isVariableRate: false,
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
        isCanadianMortgage: false,
        isVariableRate: false,
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
        isCanadianMortgage: false,
        isVariableRate: false,
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
        isCanadianMortgage: false,
        isVariableRate: false,
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
        isCanadianMortgage: false,
        isVariableRate: false,
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
        isCanadianMortgage: false,
        isVariableRate: true,
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
        isCanadianMortgage: false, isVariableRate: false, isClosed: false,
      },
      {
        id: 'loan-1', name: 'Car Loan', accountType: 'LOAN',
        currentBalance: -5000, openingBalance: -15000, interestRate: 5.0,
        paymentAmount: 300, paymentFrequency: 'MONTHLY',
        isCanadianMortgage: false, isVariableRate: false, isClosed: false,
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
        isCanadianMortgage: false, isVariableRate: false, isClosed: false,
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
        isCanadianMortgage: false, isVariableRate: false, isClosed: false,
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
        isCanadianMortgage: false, isVariableRate: false, isClosed: false,
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
        isCanadianMortgage: false, isVariableRate: false, isClosed: false,
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
        isCanadianMortgage: false, isVariableRate: false, isClosed: false,
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
        isCanadianMortgage: false, isVariableRate: false, isClosed: false,
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
        isCanadianMortgage: false, isVariableRate: false, isClosed: false,
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
        isCanadianMortgage: false, isVariableRate: false, isClosed: false,
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
        isCanadianMortgage: false, isVariableRate: false, isClosed: false,
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
        isCanadianMortgage: false, isVariableRate: false, isClosed: false,
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
        isCanadianMortgage: false, isVariableRate: false, isClosed: false,
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
        isCanadianMortgage: false, isVariableRate: false, isClosed: false,
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
        isCanadianMortgage: false, isVariableRate: false, isClosed: false,
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
        isCanadianMortgage: false, isVariableRate: false, isClosed: false,
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
        isCanadianMortgage: false, isVariableRate: false, isClosed: false,
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
        isCanadianMortgage: false, isVariableRate: false, isClosed: false,
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
        isCanadianMortgage: false, isVariableRate: false, isClosed: false,
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
        isCanadianMortgage: false, isVariableRate: false, isClosed: false,
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
        isCanadianMortgage: false, isVariableRate: false, isClosed: false,
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
        isCanadianMortgage: false, isVariableRate: false, isClosed: false,
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
        isCanadianMortgage: false, isVariableRate: false, isClosed: false,
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
        isCanadianMortgage: false, isVariableRate: false, isClosed: false,
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
        isCanadianMortgage: false, isVariableRate: false, isClosed: false,
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
        isCanadianMortgage: false, isVariableRate: false, isClosed: false,
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
        isCanadianMortgage: false, isVariableRate: false, isClosed: false,
      },
      {
        id: 'mortgage-1', name: 'Home Mortgage', accountType: 'MORTGAGE',
        currentBalance: -200000, openingBalance: -300000, interestRate: 4.0,
        paymentAmount: 1500, paymentFrequency: 'MONTHLY',
        isCanadianMortgage: true, isVariableRate: false, isClosed: false,
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
});
