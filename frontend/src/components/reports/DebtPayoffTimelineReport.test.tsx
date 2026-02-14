import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@/test/render';
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
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
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
    mockGetAllTransactions.mockResolvedValue({ data: [] });
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
    mockGetAllTransactions.mockResolvedValue({ data: [] });
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
    });
    render(<DebtPayoffTimelineReport />);
    await waitFor(() => {
      expect(screen.getByText('Balance Over Time')).toBeInTheDocument();
    });
    // Switch to breakdown view
    fireEvent.click(screen.getByText('Payment Breakdown'));
    expect(screen.getByTestId('bar-chart')).toBeInTheDocument();
    // Switch to distribution view
    fireEvent.click(screen.getByText('Principal vs Interest'));
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
    });
    render(<DebtPayoffTimelineReport />);
    await waitFor(() => {
      expect(screen.getByText('Current Balance')).toBeInTheDocument();
    });
  });
});
