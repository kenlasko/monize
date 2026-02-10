import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/render';
import { AccountBalancesReport } from './AccountBalancesReport';

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: (n: number, _currency?: string) => `$${n.toFixed(2)}`,
    formatCurrencyCompact: (n: number) => `$${n.toFixed(0)}`,
    defaultCurrency: 'CAD',
  }),
}));

vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    convertToDefault: (amount: number, _currency: string) => amount,
    defaultCurrency: 'CAD',
  }),
}));

vi.mock('@/lib/chart-colours', () => ({
  CHART_COLOURS: ['#3b82f6', '#ef4444', '#22c55e'],
}));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: any) => <div data-testid="responsive-container">{children}</div>,
  PieChart: ({ children }: any) => <div data-testid="pie-chart">{children}</div>,
  Pie: () => null,
  Cell: () => null,
  Tooltip: () => null,
}));

const mockGetAll = vi.fn();
const mockGetPortfolioSummary = vi.fn();

vi.mock('@/lib/accounts', () => ({
  accountsApi: {
    getAll: (...args: any[]) => mockGetAll(...args),
  },
}));

vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getPortfolioSummary: (...args: any[]) => mockGetPortfolioSummary(...args),
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

describe('AccountBalancesReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state initially', () => {
    mockGetAll.mockReturnValue(new Promise(() => {}));
    mockGetPortfolioSummary.mockReturnValue(new Promise(() => {}));
    render(<AccountBalancesReport />);
    expect(document.querySelector('.animate-pulse')).toBeTruthy();
  });

  it('renders empty state when no accounts', async () => {
    mockGetAll.mockResolvedValue([]);
    mockGetPortfolioSummary.mockResolvedValue(null);
    render(<AccountBalancesReport />);
    await waitFor(() => {
      expect(screen.getByText('No accounts found.')).toBeInTheDocument();
    });
  });

  it('renders summary cards with data', async () => {
    mockGetAll.mockResolvedValue([
      {
        id: 'acc-1',
        name: 'Chequing',
        accountType: 'CHEQUING',
        accountSubType: null,
        currentBalance: 5000,
        currencyCode: 'CAD',
        isClosed: false,
      },
      {
        id: 'acc-2',
        name: 'Visa',
        accountType: 'CREDIT_CARD',
        accountSubType: null,
        currentBalance: -1200,
        currencyCode: 'CAD',
        isClosed: false,
      },
    ]);
    mockGetPortfolioSummary.mockResolvedValue(null);
    render(<AccountBalancesReport />);
    await waitFor(() => {
      expect(screen.getByText('Total Assets')).toBeInTheDocument();
    });
    expect(screen.getByText('Total Liabilities')).toBeInTheDocument();
    expect(screen.getByText('Net Worth')).toBeInTheDocument();
  });

  it('renders filter buttons', async () => {
    mockGetAll.mockResolvedValue([
      {
        id: 'acc-1',
        name: 'Savings',
        accountType: 'SAVINGS',
        accountSubType: null,
        currentBalance: 10000,
        currencyCode: 'CAD',
        isClosed: false,
      },
    ]);
    mockGetPortfolioSummary.mockResolvedValue(null);
    render(<AccountBalancesReport />);
    await waitFor(() => {
      expect(screen.getByText('all')).toBeInTheDocument();
    });
    expect(screen.getByText('assets')).toBeInTheDocument();
    expect(screen.getByText('liabilities')).toBeInTheDocument();
  });
});
