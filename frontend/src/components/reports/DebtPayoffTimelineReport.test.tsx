import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/render';
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
});
