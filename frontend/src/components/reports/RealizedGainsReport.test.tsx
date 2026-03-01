import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/render';
import { RealizedGainsReport } from './RealizedGainsReport';

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: (n: number, _currency?: string) => `$${n.toFixed(2)}`,
    formatCurrencyCompact: (n: number) => `$${n.toFixed(0)}`,
    formatCurrencyAxis: (n: number) => `$${n}`,
    defaultCurrency: 'CAD',
  }),
}));

vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    convertToDefault: (amount: number, _currency: string) => amount,
    defaultCurrency: 'CAD',
  }),
}));

vi.mock('@/hooks/useDateRange', () => ({
  useDateRange: () => ({
    dateRange: '1y',
    setDateRange: vi.fn(),
    startDate: '',
    setStartDate: vi.fn(),
    endDate: '',
    setEndDate: vi.fn(),
    resolvedRange: { start: '2025-01-01', end: '2026-01-01' },
    isValid: true,
  }),
}));

vi.mock('@/lib/utils', () => ({
  parseLocalDate: (d: string) => new Date(d + 'T00:00:00'),
}));

vi.mock('@/components/ui/DateRangeSelector', () => ({
  DateRangeSelector: () => <div data-testid="date-range-selector" />,
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div data-testid="responsive-container">{children}</div>,
  BarChart: ({ children }: any) => <div data-testid="bar-chart">{children}</div>,
  Bar: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
}));

const mockGetTransactions = vi.fn();
const mockGetInvestmentAccounts = vi.fn();

vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getTransactions: (...args: any[]) => mockGetTransactions(...args),
    getInvestmentAccounts: (...args: any[]) => mockGetInvestmentAccounts(...args),
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

describe('RealizedGainsReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state initially', () => {
    mockGetTransactions.mockReturnValue(new Promise(() => {}));
    mockGetInvestmentAccounts.mockReturnValue(new Promise(() => {}));
    render(<RealizedGainsReport />);
    expect(document.querySelector('.animate-pulse')).toBeTruthy();
  });

  it('renders empty state when no sell transactions', async () => {
    mockGetTransactions.mockResolvedValue({ data: [], pagination: { hasMore: false } });
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<RealizedGainsReport />);
    await waitFor(() => {
      expect(screen.getByText(/No sell transactions found/)).toBeInTheDocument();
    });
  });

  it('renders summary cards with sell transaction data', async () => {
    mockGetTransactions.mockResolvedValue({
      data: [
        {
          id: 'tx-1',
          transactionDate: '2025-06-15',
          action: 'SELL',
          totalAmount: -5000,
          quantity: -50,
          price: 100,
          accountId: 'acc-1',
          security: { symbol: 'AAPL', name: 'Apple Inc.' },
        },
        {
          id: 'tx-2',
          transactionDate: '2025-08-20',
          action: 'SELL',
          totalAmount: -3000,
          quantity: -30,
          price: 100,
          accountId: 'acc-1',
          security: { symbol: 'MSFT', name: 'Microsoft Corp.' },
        },
      ],
      pagination: { hasMore: false },
    });
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'TFSA', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    render(<RealizedGainsReport />);
    await waitFor(() => {
      expect(screen.getByText('Total Proceeds')).toBeInTheDocument();
    });
    expect(screen.getByText('Cost Basis')).toBeInTheDocument();
    expect(screen.getByText('Realized Gain/Loss')).toBeInTheDocument();
    expect(screen.getByText('Securities Sold')).toBeInTheDocument();
  });

  it('renders view type toggle buttons', async () => {
    mockGetTransactions.mockResolvedValue({ data: [], pagination: { hasMore: false } });
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<RealizedGainsReport />);
    await waitFor(() => {
      expect(screen.getByText('Chart')).toBeInTheDocument();
    });
    expect(screen.getByText('Table')).toBeInTheDocument();
  });

  it('renders chart with gain data', async () => {
    mockGetTransactions.mockResolvedValue({
      data: [
        {
          id: 'tx-1',
          transactionDate: '2025-06-15',
          action: 'SELL',
          totalAmount: -5500,
          quantity: -50,
          price: 100,
          accountId: 'acc-1',
          security: { symbol: 'AAPL', name: 'Apple Inc.' },
        },
      ],
      pagination: { hasMore: false },
    });
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<RealizedGainsReport />);
    await waitFor(() => {
      expect(screen.getByText('Realized Gains by Security')).toBeInTheDocument();
    });
    expect(screen.getByTestId('bar-chart')).toBeInTheDocument();
  });

  it('renders sell transactions table', async () => {
    mockGetTransactions.mockResolvedValue({
      data: [
        {
          id: 'tx-1',
          transactionDate: '2025-06-15',
          action: 'SELL',
          totalAmount: -5000,
          quantity: -50,
          price: 100,
          accountId: 'acc-1',
          security: { symbol: 'AAPL', name: 'Apple Inc.' },
        },
      ],
      pagination: { hasMore: false },
    });
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<RealizedGainsReport />);
    await waitFor(() => {
      expect(screen.getByText(/Sell Transactions/)).toBeInTheDocument();
    });
    expect(screen.getByText('AAPL')).toBeInTheDocument();
  });

  it('filters transactions by SELL action', async () => {
    mockGetTransactions.mockResolvedValue({ data: [], pagination: { hasMore: false } });
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<RealizedGainsReport />);
    await waitFor(() => {
      expect(mockGetTransactions).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'SELL' }),
      );
    });
  });
});
