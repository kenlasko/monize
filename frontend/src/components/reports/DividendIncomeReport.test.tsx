import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/render';
import { DividendIncomeReport } from './DividendIncomeReport';

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
    resolvedRange: { start: '2024-01-01', end: '2025-01-01' },
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
  Legend: () => null,
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

describe('DividendIncomeReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state initially', () => {
    mockGetTransactions.mockReturnValue(new Promise(() => {}));
    mockGetInvestmentAccounts.mockReturnValue(new Promise(() => {}));
    render(<DividendIncomeReport />);
    expect(document.querySelector('.animate-pulse')).toBeTruthy();
  });

  it('renders empty state when no income transactions', async () => {
    mockGetTransactions.mockResolvedValue({ data: [] });
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<DividendIncomeReport />);
    await waitFor(() => {
      expect(screen.getByText(/No dividend, interest, or capital gain transactions found/)).toBeInTheDocument();
    });
  });

  it('renders summary cards with data', async () => {
    mockGetTransactions.mockResolvedValue({
      data: [
        {
          id: 'tx-1',
          transactionDate: '2024-06-15',
          action: 'DIVIDEND',
          totalAmount: 100,
          accountId: 'acc-1',
          security: { symbol: 'VFV', name: 'Vanguard S&P 500' },
        },
        {
          id: 'tx-2',
          transactionDate: '2024-07-15',
          action: 'INTEREST',
          totalAmount: 25,
          accountId: 'acc-1',
          security: { symbol: 'CASH', name: 'Cash Interest' },
        },
      ],
    });
    mockGetInvestmentAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'TFSA', currencyCode: 'CAD', accountSubType: 'INVESTMENT_CASH' },
    ]);
    render(<DividendIncomeReport />);
    await waitFor(() => {
      expect(screen.getByText('Dividends')).toBeInTheDocument();
    });
    expect(screen.getByText('Interest')).toBeInTheDocument();
    expect(screen.getByText('Capital Gains')).toBeInTheDocument();
    expect(screen.getByText('Total Income')).toBeInTheDocument();
  });

  it('renders view type buttons', async () => {
    mockGetTransactions.mockResolvedValue({ data: [] });
    mockGetInvestmentAccounts.mockResolvedValue([]);
    render(<DividendIncomeReport />);
    await waitFor(() => {
      expect(screen.getByText('Monthly')).toBeInTheDocument();
    });
    expect(screen.getByText('By Security')).toBeInTheDocument();
  });
});
